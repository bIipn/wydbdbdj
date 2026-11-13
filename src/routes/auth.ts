import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createAuth, isSignInService, type SignInError, type SignInResult } from '../auth/index.js';
import { normalizeEmail } from '../auth/input.js';
import { clientIp, createRateLimiter } from '../auth/ratelimit.js';
import { renewedToken, sessionCookie } from '../auth/sessions.js';
import { OAUTH_PROVIDERS } from '../auth/supabase.js';
import type { RouteContext } from '../context.js';
import { isPlan, setPlan } from '../db/accounts.js';
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
};

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

  app.get('/api/auth/config', async () => ({
    mode: config.authMode,
    providers: ['password', ...(config.supabase ? OAUTH_PROVIDERS : [])],
    demo: config.demoMode,
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

  app.post('/api/auth/logout', async (req, reply) => {
    await signIn.logOut(req);
    return reply.header('set-cookie', sessionCookie(null, config.cookieSecure)).send({ ok: true });
  });
}
