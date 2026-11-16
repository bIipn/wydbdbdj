import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createAuth, isSignInService, type SignInError, type SignInResult } from '../auth/index.js';
import { normalizeEmail } from '../auth/input.js';
import { findCode, isLive, parsePromoCodes } from '../auth/promo.js';
import { clientIp, createAttemptLimiter, type LimitRule, type Verdict } from '../auth/ratelimit.js';
import { renewedToken, sessionCookie } from '../auth/sessions.js';
import { OAUTH_PROVIDERS } from '../auth/supabase.js';
import type { RouteContext } from '../context.js';
import { isPlan, setPlan } from '../db/accounts.js';
import { redeemPromo } from '../db/promo.js';
import { env } from '../env.js';
import { effectivePlan, featuresFor } from '../plans.js';
import { requireAdmin } from './shared.js';

const MIN = 60 * 1000;
/**
 * Sign-in and sign-up limits (src/auth/ratelimit.ts, counters in the database). Only FAILED sign-ins are counted:
 * an office or a mobile carrier's shared address is never locked out by people signing in successfully.
 *   pair   e-mail + address: the hard limit on guessing one account from one place;
 *   email  e-mail alone, much looser: guesses spread over many addresses still run out, but it refuses only
 *          addresses that have not signed in to that e-mail before (known), so a stranger cannot lock the owner
 *          out of the places they sign in from;
 *   ip     the address over every e-mail (credential stuffing from one place);
 *   known  remembered on a successful sign-in, 30 days.
 * A successful sign-in clears that e-mail's pair and email counters. Sign-up counts its failures per address,
 * and every sign-up per address under a loose cap (each one creates an account).
 */
export const SIGN_IN_LIMITS = {
  pair: { limit: 10, windowMs: 15 * MIN },
  email: { limit: 100, windowMs: 15 * MIN },
  ip: { limit: 30, windowMs: 15 * MIN },
  known: { limit: 1_000_000, windowMs: 30 * 24 * 60 * MIN },
  signupFailed: { limit: 20, windowMs: 15 * MIN },
  signupAll: { limit: 100, windowMs: 60 * MIN },
} as const;

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
};

/** Wrong promo codes allowed per account, and per caller address, in one window (then 429). Good codes cost nothing. */
export const PROMO_LIMITS = { account: { limit: 5, windowMs: 10 * MIN }, ip: { limit: 5, windowMs: 10 * MIN } } as const;
/** Unknown, expired and used-up codes all get this one answer: it must not tell a guesser which codes exist. */
const INVALID_CODE = { error: 'invalid_code', message: 'That code isn’t valid. Check the spelling and try again.' };
/** The 429 sentence; the sign-in and Settings screens show the same words for code too_many_attempts. */
const TOO_MANY = 'Too many tries. Wait a few minutes, then try again.';
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
    for (const path of ['signup', 'login', 'oauth', 'logout']) app.post(`/api/auth/${path}`, absent);
    app.post('/api/promo/redeem', absent);
    return;
  }

  // Tests of other modules pass a bare AuthService; the real one carries the sign-in operations.
  const signIn = isSignInService(ctx.auth) ? ctx.auth : createAuth(db, config, { now: ctx.now });
  const attempts = createAttemptLimiter(db, ctx.now, ctx.log);
  const rule = (name: keyof typeof SIGN_IN_LIMITS, key: string): LimitRule => ({ key, ...SIGN_IN_LIMITS[name] });
  const tooMany = (reply: FastifyReply, verdict: Verdict) =>
    reply.code(429).header('retry-after', verdict.retryAfterSec).send({ error: 'too_many_attempts', message: TOO_MANY });

  /**
   * May this caller try to sign in to `email` now? Reads the counters (one statement), counts nothing. The e-mail-wide
   * key refuses only addresses that never signed in to that e-mail: the owner's own places keep working.
   */
  const mayTry = async (ip: string, email: string | null): Promise<Verdict> => {
    const rules = [rule('ip', `login:ip:${ip}`)];
    if (!email) return attempts.check(rules);
    const pair = rule('pair', `login:pair:${email}|${ip}`);
    const wide = rule('email', `login:email:${email}`);
    const known = `login:known:${email}|${ip}`;
    const own = await attempts.check([...rules, pair]);
    if (!own.ok) return own;
    const counts = await attempts.peek([wide.key, known]);
    if ((counts.get(wide.key) ?? 0) >= wide.limit && !counts.get(known)) return { ok: false, retryAfterSec: Math.ceil(wide.windowMs / 1000) };
    return own;
  };
  /** After the attempt: a failure is counted; a success clears that e-mail's counters and remembers the address. */
  const settle = async (ip: string, email: string | null, result: SignInResult): Promise<void> => {
    if (result.ok) {
      const who = normalizeEmail(result.account.email) ?? email;
      if (!who) return;
      await attempts.clear([`login:pair:${who}|${ip}`, `login:email:${who}`]);
      await attempts.count([rule('known', `login:known:${who}|${ip}`)]);
      return;
    }
    const rules = [rule('ip', `login:ip:${ip}`)];
    if (email && result.error === 'invalid_credentials') rules.push(rule('pair', `login:pair:${email}|${ip}`), rule('email', `login:email:${email}`));
    await attempts.count(rules);
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
  /** Show the code box? Only with codes set, outside demo mode (everyone has every feature there) and never on iOS. */
  const promoOn = (req: FastifyRequest): boolean => promoCodes.length > 0 && !config.demoMode && !fromIosStore(req);

  app.get('/api/auth/config', async (req) => ({
    mode: config.authMode,
    providers: ['password', ...(config.supabase ? OAUTH_PROVIDERS : [])],
    demo: config.demoMode,
    // promo: true when the client may show the promo-code box. Left out (not `false`) when it may not, so the
    // answer for a server without codes is exactly what it was before codes existed; the client reads absent as off.
    ...(promoOn(req) ? { promo: true } : {}),
    // Both are public by design: the browser needs them to start a Google / Apple / Microsoft sign-in.
    ...(config.supabase ? { supabase: { url: config.supabase.url, anonKey: config.supabase.anonKey } } : {}),
  }));

  app.post('/api/auth/signup', async (req, reply) => {
    const ip = clientIp(req);
    const failed = rule('signupFailed', `signup:failed:${ip}`);
    const all = rule('signupAll', `signup:all:${ip}`);
    const verdict = await attempts.check([failed, all]);
    if (!verdict.ok) return tooMany(reply, verdict);
    const result = await signIn.signUp(fields(req.body));
    await attempts.count(result.ok ? [all] : [all, failed]);
    return answer(req, reply, result, 201);
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = fields(req.body);
    const ip = clientIp(req);
    const email = normalizeEmail(body.email);
    const verdict = await mayTry(ip, email);
    if (!verdict.ok) return tooMany(reply, verdict);
    const result = await signIn.logIn(body);
    await settle(ip, email, result);
    return answer(req, reply, result);
  });

  app.post('/api/auth/oauth', async (req, reply) => {
    const ip = clientIp(req);
    const verdict = await mayTry(ip, null);
    if (!verdict.ok) return tooMany(reply, verdict);
    const result = await signIn.oauth(fields(req.body).accessToken);
    if (!result.ok) await settle(ip, null, result); // a provider-verified sign-in has no password to guess: nothing to clear
    return answer(req, reply, result);
  });

  /**
   * Redeem a promo code: { code } → { plan: 'pro', features } and the account is on Pro from the next request.
   * Signed in only. 5 wrong codes per 10 minutes per account and per address (then 429 for any code). Redeeming a code twice is harmless
   * (200, already: true), and so is redeeming on an account that already has Pro or the pilot plan.
   */
  app.post('/api/promo/redeem', async (req, reply) => {
    if (!promoOn(req)) return reply.code(403).send(NOT_AVAILABLE);
    const { account } = await ctx.identify(req);
    if (!account) return reply.code(401).send({ error: 'sign_in_required' });
    const promoRules = [
      { key: `promo:ip:${clientIp(req)}`, ...PROMO_LIMITS.ip },
      { key: `promo:account:${account.id}`, ...PROMO_LIMITS.account },
    ];
    const verdict = await attempts.check(promoRules);
    if (!verdict.ok) return tooMany(reply, verdict); // even the right code waits: a 200 would say which guess was right

    const code = findCode(promoCodes, fields(req.body).code);
    const now = ctx.now();
    if (!code || !isLive(code, now)) {
      await attempts.count(promoRules);
      return reply.code(400).send(INVALID_CODE);
    }
    const answer = (plan: typeof account.plan, already: boolean) =>
      ({ plan, features: featuresFor(effectivePlan(config, { ...account, plan })), ...(already ? { already: true } : {}) });
    // Pilot (or Pro granted by hand) is already as much as a code gives: never step it down, never count a use.
    if (account.plan !== 'free') return answer(account.plan, true);

    const outcome = await redeemPromo(db, { accountId: account.id, codeKey: code.keyHex, plan: code.plan, maxUses: code.maxUses, now });
    if (outcome === 'used_up') {
      await attempts.count(promoRules);
      return reply.code(400).send(INVALID_CODE);
    }
    ctx.log(`promo: account ${account.id} ${outcome === 'again' ? 'redeemed a code again' : 'redeemed a code'} → ${code.plan}`);
    return answer(code.plan, outcome === 'again');
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await signIn.logOut(req);
    return reply.header('set-cookie', sessionCookie(null, config.cookieSecure)).send({ ok: true });
  });
}
