import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createAuth, isSignInService, RESET_TTL_MS, type SignInError, type SignInResult } from '../auth/index.js';
import { normalizeEmail } from '../auth/input.js';
import { findCode, isLive, parsePromoCodes } from '../auth/promo.js';
import { clientIp, createRateLimiter } from '../auth/ratelimit.js';
import { renewedToken, sessionCookie } from '../auth/sessions.js';
import { OAUTH_PROVIDERS } from '../auth/supabase.js';
import type { RouteContext } from '../context.js';
import { isPlan, setPlan } from '../db/accounts.js';
import { redeemPromo } from '../db/promo.js';
import { env } from '../env.js';
import { resetEmail } from '../notify/email.js';
import { effectivePlan, featuresFor } from '../plans.js';
import { requireAdmin } from './shared.js';

/** Sign-up and sign-in attempts allowed per caller address, and per email, in one window. */
const ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Status and wording for each refusal. A wrong password and an unknown email get the same answer, and
 * a sign-up for a taken address is not told "that email is registered" — only that it did not work.
 */
const REFUSALS: Record<SignInError, { status: number; message: string }> = {
  invalid_email: { status: 400, message: 'Enter a valid email address.' },
  invalid_password: { status: 400, message: 'Use a password of 8 to 128 characters.' },
  invalid_name: { status: 400, message: 'Use a name of 80 characters or fewer.' },
  signup_failed: { status: 409, message: 'Could not create that account. If you already have one, sign in instead.' },
  invalid_credentials: { status: 401, message: 'Email or password is incorrect.' },
  oauth_not_configured: { status: 404, message: 'That sign-in method is not set up here.' },
  invalid_token: { status: 401, message: 'That sign-in did not go through. Try again.' },
  oauth_unavailable: { status: 503, message: 'The sign-in service is not answering. Try again in a minute.' },
  provider_not_supported: { status: 403, message: 'That sign-in method is not supported here.' },
  email_not_verified: { status: 403, message: 'Your sign-in provider has not verified your email address. Verify it there, then try again.' },
  reset_link_invalid: { status: 400, message: 'That reset link is no longer valid. Links work once, for an hour. Ask for a new one.' },
};

/** "Forgot password" requests allowed per caller address, and per email, in one window (then 429). */
const FORGOT_PER_ADDRESS = 5;
const FORGOT_PER_EMAIL = 3;
const FORGOT_WINDOW_MS = 60 * 60 * 1000;
/**
 * The one answer to every accepted "forgot password" request, whether or not the address has an account: the
 * sentence is true either way, and the screen cannot be used to find out who has an account.
 */
const RESET_REQUESTED = {
  ok: true,
  message: 'If an account with a password uses that address, we emailed it a link to choose a new one. The link works once, for an hour.',
};
/** Email is not set up on this server: say exactly that. Never an "if an account exists…" that no email follows. */
const RESET_UNAVAILABLE = { error: 'reset_unavailable', message: 'Password reset by email is not available yet. No email was sent.' };

/** Promo-code tries allowed per account, and per caller address, in one window (then 429). */
const PROMO_ATTEMPTS = 5;
const PROMO_WINDOW_MS = 10 * 60 * 1000;
/** Unknown, expired and used-up codes all get this one answer: it must not tell a guesser which codes exist. */
const INVALID_CODE = { error: 'invalid_code', message: 'That code isn’t valid. Check the spelling and try again.' };
const NOT_AVAILABLE = { error: 'not_available', message: 'Promo codes aren’t available in this version of the app.' };

/**
 * The iOS App Store build marks every request with this header. Apple guideline 3.1.1: that build must not
 * unlock features with our own codes, so it never sees the code box and a redeem from it is refused.
 */
const fromIosStore = (req: FastifyRequest): boolean => String(req.headers['x-bidswipe-store'] ?? '').trim().toLowerCase() === 'ios';

const fields = (body: unknown): Record<string, unknown> =>
  body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

/** Sign up / sign in / sign out (accounts mode only), and the operator's plan switch. */
export async function register(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { config, db } = ctx;

  // Grant free / pro / pilot by hand. There is no billing: this is how a plan changes.
  app.post('/api/admin/plan', async (req, reply) => {
    if (!requireAdmin(ctx, req, reply)) return reply;
    const body = fields(req.body);
    const email = normalizeEmail(body.email);
    if (!email) return reply.code(400).send({ error: 'invalid_email' });
    if (!isPlan(body.plan)) return reply.code(400).send({ error: 'invalid_plan', message: 'plan must be free, pro or pilot' });
    const account = await setPlan(db, email, body.plan);
    return account ? { account } : reply.code(404).send({ error: 'account_not_found' });
  });

  if (config.authMode !== 'accounts') {
    // The pilot (single mode) has no accounts, so it has no sign-in API.
    const absent = async (_req: FastifyRequest, reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
    app.get('/api/auth/config', absent);
    for (const path of ['signup', 'login', 'oauth', 'logout', 'forgot', 'reset']) app.post(`/api/auth/${path}`, absent);
    app.post('/api/promo/redeem', absent);
    return;
  }

  // Tests of other modules pass a bare AuthService; the real one carries the sign-in operations.
  const signIn = isSignInService(ctx.auth) ? ctx.auth : createAuth(db, config, { now: ctx.now });
  const limiter = createRateLimiter({ limit: ATTEMPTS, windowMs: WINDOW_MS, now: ctx.now });

  /** Count one attempt for the caller's address and, when there is one, the email. Answers 429 itself. */
  const allowed = (req: FastifyRequest, reply: FastifyReply, email?: string | null): boolean => {
    let verdict = limiter.hit(`ip:${clientIp(req)}`);
    if (verdict.ok && email) verdict = limiter.hit(`email:${email}`);
    if (verdict.ok) return true;
    reply.code(429).header('retry-after', verdict.retryAfterSec).send({ error: 'too_many_attempts' });
    return false;
  };

  const answer = async (req: FastifyRequest, reply: FastifyReply, result: SignInResult, status = 200) => {
    if (!result.ok) {
      if (result.detail) ctx.log(`sign-in refused: ${result.error} (${result.detail})`);
      const { status: code, message } = REFUSALS[result.error];
      return reply.code(code).send({ error: result.error, message });
    }
    await signIn.logOut(req); // a browser holds one session: the one it came with, if any, ends here
    return reply.code(status).header('set-cookie', sessionCookie(result.token, config.cookieSecure)).send({ account: result.account });
  };

  // A session in use slides forward 30 days; the browser's copy of the cookie has to slide with it.
  app.addHook('onSend', async (req, reply) => {
    const token = renewedToken(req);
    if (token && !reply.hasHeader('set-cookie')) reply.header('set-cookie', sessionCookie(token, config.cookieSecure));
  });

  // PROMO_CODES is read once, at start-up, from the host's environment (never from the repo). A bad entry is
  // logged and skipped; the codes themselves never reach the log or the database (only their sha256 does).
  const promoCodes = parsePromoCodes(env('PROMO_CODES'), ctx.log);
  const promoLimiter = createRateLimiter({ limit: PROMO_ATTEMPTS, windowMs: PROMO_WINDOW_MS, now: ctx.now });
  /** Show the code box? Only with codes set, outside demo mode (everyone has every feature there) and never on iOS. */
  const promoOn = (req: FastifyRequest): boolean => promoCodes.length > 0 && !config.demoMode && !fromIosStore(req);

  app.get('/api/auth/config', async (req) => ({
    mode: config.authMode,
    providers: ['password', ...(config.supabase ? OAUTH_PROVIDERS : [])],
    demo: config.demoMode,
    // promo: true when the client may show the promo-code box. Left out (not `false`) when it may not, so the
    // answer for a server without codes is exactly what it was before codes existed; the client reads absent as off.
    ...(promoOn(req) ? { promo: true } : {}),
    // passwordReset: true when this server can email a reset link (RESEND_API_KEY and a sender are set). Left out
    // when it cannot: the sign-in screen then says reset by email is not available yet, and offers no form.
    ...(ctx.mailer ? { passwordReset: true } : {}),
    // Both are public by design: the browser needs them to start a Google / Apple / Microsoft sign-in.
    ...(config.supabase ? { supabase: { url: config.supabase.url, anonKey: config.supabase.anonKey } } : {}),
  }));

  app.post('/api/auth/signup', async (req, reply) => {
    const body = fields(req.body);
    if (!allowed(req, reply, normalizeEmail(body.email))) return reply;
    return answer(req, reply, await signIn.signUp(body), 201);
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = fields(req.body);
    if (!allowed(req, reply, normalizeEmail(body.email))) return reply;
    return answer(req, reply, await signIn.logIn(body));
  });

  app.post('/api/auth/oauth', async (req, reply) => {
    if (!allowed(req, reply)) return reply;
    return answer(req, reply, await signIn.oauth(fields(req.body).accessToken));
  });

  const forgotLimiter = createRateLimiter({ limit: FORGOT_PER_ADDRESS, windowMs: FORGOT_WINDOW_MS, now: ctx.now });
  const forgotEmailLimiter = createRateLimiter({ limit: FORGOT_PER_EMAIL, windowMs: FORGOT_WINDOW_MS, now: ctx.now });

  /**
   * "Forgot password": { email } → the same 200 for every address, and an email with a one-hour, single-use link
   * when the address has an account with a password. Without a mailer nothing can be sent, so nothing is
   * promised: 503 reset_unavailable. Only a hash of the link's token is stored; the token is never logged.
   * A new link does not cancel an earlier one (using any of them cancels the rest), so somebody else asking for
   * this address cannot kill the link its owner is about to open.
   * (Two things can tell a real account from an unknown address here: the request takes as long as the email
   * service does, and a refused send answers 502. Sign-up already tells a taken address from a free one, and
   * "never say we emailed it when we did not" comes first; the limits above cap the probing.)
   */
  app.post('/api/auth/forgot', async (req, reply) => {
    if (!ctx.mailer) return reply.code(503).send(RESET_UNAVAILABLE);
    const email = normalizeEmail(fields(req.body).email);
    let verdict = forgotLimiter.hit(`ip:${clientIp(req)}`);
    if (verdict.ok && email) verdict = forgotEmailLimiter.hit(`email:${email}`);
    if (!verdict.ok) {
      return reply.code(429).header('retry-after', verdict.retryAfterSec)
        .send({ error: 'too_many_attempts', message: 'Too many reset requests. Wait an hour, then try again.' });
    }
    if (!email) return reply.code(400).send({ error: 'invalid_email', message: REFUSALS.invalid_email.message });

    const link = await signIn.startReset(email);
    if (link) {
      try {
        await ctx.mailer.send(resetEmail({ to: link.email, appUrl: config.appUrl, token: link.token, minutes: RESET_TTL_MS / 60_000 }));
        ctx.log('password reset: a link was emailed');
      } catch (err) {
        // The delivery service refused or did not answer. Saying "we emailed it" now would be a lie.
        ctx.log(`password reset: the email was not sent (${err instanceof Error ? err.message : 'unknown error'})`);
        return reply.code(502).send({ error: 'email_failed', message: 'We could not send the email just now. Nothing was sent. Try again in a few minutes.' });
      }
    }
    return RESET_REQUESTED;
  });

  /**
   * Choose a new password with the link's token: { token, password } → signed in, like a login. The link is
   * used up with every other link of the account, every other session ends (open live streams included), and so
   * do its phone-alert subscriptions (a device registers again the next time the app is opened signed in).
   */
  app.post('/api/auth/reset', async (req, reply) => {
    if (!allowed(req, reply)) return reply;
    const result = await signIn.finishReset(fields(req.body));
    if (result.ok) {
      ctx.log(`password reset: account ${result.account.id} chose a new password`);
      // Every earlier session is gone from the database; a live stream opened with one of them must end too.
      await ctx.bus.emit({ type: 'signed_out', accountId: result.account.id });
    }
    return answer(req, reply, result);
  });

  /**
   * Redeem a promo code: { code } → { plan: 'pro', features } and the account is on Pro from the next request.
   * Signed in only. 5 tries per 10 minutes per account and per address. Redeeming a code twice is harmless
   * (200, already: true), and so is redeeming on an account that already has Pro or the pilot plan.
   */
  app.post('/api/promo/redeem', async (req, reply) => {
    if (!promoOn(req)) return reply.code(403).send(NOT_AVAILABLE);
    const { account } = await ctx.identify(req);
    if (!account) return reply.code(401).send({ error: 'sign_in_required' });
    let verdict = promoLimiter.hit(`ip:${clientIp(req)}`);
    if (verdict.ok) verdict = promoLimiter.hit(`account:${account.id}`);
    if (!verdict.ok) {
      return reply.code(429).header('retry-after', verdict.retryAfterSec)
        .send({ error: 'too_many_attempts', message: 'Too many tries. Wait a few minutes, then try again.' });
    }

    const code = findCode(promoCodes, fields(req.body).code);
    const now = ctx.now();
    if (!code || !isLive(code, now)) return reply.code(400).send(INVALID_CODE);
    const answer = (plan: typeof account.plan, already: boolean) =>
      ({ plan, features: featuresFor(effectivePlan(config, { ...account, plan })), ...(already ? { already: true } : {}) });
    // Pilot (or Pro granted by hand) is already as much as a code gives: never step it down, never count a use.
    if (account.plan !== 'free') return answer(account.plan, true);

    const outcome = await redeemPromo(db, { accountId: account.id, codeKey: code.keyHex, plan: code.plan, maxUses: code.maxUses, now });
    if (outcome === 'used_up') return reply.code(400).send(INVALID_CODE);
    ctx.log(`promo: account ${account.id} ${outcome === 'again' ? 'redeemed a code again' : 'redeemed a code'} → ${code.plan}`);
    return answer(code.plan, outcome === 'again');
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await signIn.logOut(req);
    return reply.header('set-cookie', sessionCookie(null, config.cookieSecure)).send({ ok: true });
  });
}
