import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createAuth, isSignInService, type OwnerResult } from '../auth/index.js';
import { clientIp, createRateLimiter } from '../auth/ratelimit.js';
import { sessionCookie } from '../auth/sessions.js';
import type { RouteContext } from '../context.js';
import { env } from '../env.js';
import { loadJobRules } from '../jobs/config.js';
import * as jobs from '../jobs/service.js';
import type { JobsDeps } from '../jobs/service.js';

/** Tries at "delete my account" per account, and per caller address, in one window (then 429): each try checks a password. */
const ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

const REFUSALS: Record<Exclude<OwnerResult, { ok: true }>['error'], { status: number; message: string }> = {
  wrong_password: { status: 401, message: 'That is not your password. Your account was not deleted.' },
  recent_sign_in_required: {
    status: 403,
    message: 'To delete this account, sign out, sign in again, and delete it within 10 minutes. That shows it is you. Your account was not deleted.',
  },
  confirm_mismatch: { status: 400, message: 'Type the email address of this account to confirm. Your account was not deleted.' },
};

const fields = (body: unknown): Record<string, unknown> =>
  body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

/**
 * "Delete my account" (accounts mode; the pilot's single mode has no accounts, so both routes answer 404).
 *
 *   GET    /api/account/deletion   what deleting would end, and how this account confirms it. Changes nothing.
 *   DELETE /api/account            { password } (or { confirm: <email> } for an account with no password)
 *
 * The delete asks for the password again: a phone left unlocked must not be enough. Then ONE statement removes
 * the account and everything tied to it (src/jobs/repo.ts deleteAccount), the people on the other side of its
 * live jobs are told, and the session cookie is dropped. It cannot be undone.
 */
export async function register(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { config, db } = ctx;
  if (config.authMode !== 'accounts') {
    const absent = async (_req: FastifyRequest, reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
    app.get('/api/account/deletion', absent);
    app.delete('/api/account', absent);
    return;
  }

  const signIn = isSignInService(ctx.auth) ? ctx.auth : createAuth(db, config, { now: ctx.now });
  const deps: JobsDeps = { db, bus: ctx.bus, rules: loadJobRules(env), appUrl: config.appUrl, log: ctx.log };
  const limiter = createRateLimiter({ limit: ATTEMPTS, windowMs: WINDOW_MS, now: ctx.now });

  app.get('/api/account/deletion', async (req, reply) => {
    const now = ctx.now().getTime();
    await jobs.settleDue(deps, now);
    const { account } = await ctx.identify(req);
    if (!account) return reply.code(401).send({ error: 'sign_in_required' });
    return {
      // 'password': type it again. 'recent_sign_in': the account has none, so it signs in again and types its email.
      confirmWith: await signIn.ownerCheck(account),
      email: account.email,
      ends: await jobs.deletionPreview(deps, account.id),
    };
  });

  app.delete('/api/account', async (req, reply) => {
    const now = ctx.now().getTime();
    // Whatever closed or ran out before this moment is settled by the rules first, not ended by the deletion.
    await jobs.settleDue(deps, now);
    const { account } = await ctx.identify(req);
    if (!account) return reply.code(401).send({ error: 'sign_in_required' });

    let verdict = limiter.hit(`ip:${clientIp(req)}`);
    if (verdict.ok) verdict = limiter.hit(`account:${account.id}`);
    if (!verdict.ok) {
      return reply.code(429).header('retry-after', verdict.retryAfterSec)
        .send({ error: 'too_many_attempts', message: 'Too many tries. Wait a few minutes, then try again. Your account was not deleted.' });
    }

    const owner = await signIn.confirmOwner(req, account, fields(req.body));
    if (!owner.ok) {
      const { status, message } = REFUSALS[owner.error];
      return reply.code(status).send({ error: owner.error, message });
    }

    await jobs.deleteAccount(deps, account.id, now);
    // The people left on the other side were just told: send their pushes before a serverless host freezes.
    await ctx.realtime?.flush();
    return reply.header('set-cookie', sessionCookie(null, config.cookieSecure)).send({ ok: true });
  });
}
