import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { normalizeEmail } from '../auth/input.js';
import { PASSWORD_MAX, passwordLength, verifyPassword } from '../auth/password.js';
import { createAttemptLimiter } from '../auth/ratelimit.js';
import { sessionCookie, sessionKey } from '../auth/sessions.js';
import type { RouteContext } from '../context.js';
import { deleteAccount, findCredentials } from '../db/accounts.js';
import { env } from '../env.js';
import { loadJobRules } from '../jobs/config.js';
import { settleDue, type JobsDeps } from '../jobs/service.js';

/**
 * Wrong passwords (or e-mails) per SESSION in one window before "Delete account" answers 429 for any answer from that
 * session, the right one too. Counted FIRST (src/auth/ratelimit.ts): a stolen session cannot guess the password, not
 * even with a burst of simultaneous tries. A right answer gives its count back. Per session, not per account: a stolen
 * cookie that sends 5 wrong guesses every window would otherwise keep the owner's right password at 429 for good
 * (review del-4). A thief cannot open more sessions without the password, so this allows no more guesses than one
 * account-wide count did.
 */
export const DELETE_ACCOUNT_LIMIT = { limit: 5, windowMs: 15 * 60_000 } as const;

/** The words of each refusal. The client shows them as they are (web/js/views/settings.js). */
export const DELETE_WORDS = {
  passwordRequired: 'Type your password to delete your account.',
  emailRequired: 'Your account has no password: you sign in with Google, Apple or Microsoft. Type your email address to delete your account.',
  wrongPassword: 'That password isn’t right.',
  wrongEmail: 'That isn’t this account’s email address.',
  inProgress: 'You’re in a job that isn’t finished. Your account can be deleted once it is done, cancelled or has ended.',
} as const;

const fields = (body: unknown): Record<string, unknown> =>
  body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

const minutes = (sec: number): string => {
  const m = Math.max(1, Math.ceil(sec / 60));
  return `${m} minute${m === 1 ? '' : 's'}`;
};

/**
 * POST /api/account/delete {password} (or {email} for an account that signs in with a provider and has no password):
 * the signed-in account deletes itself and everything tied to it, at once (src/db/accounts.ts deleteAccount).
 * POST, not DELETE: some clients drop a DELETE's body. Accounts mode only: single mode has no accounts (404).
 *
 *   401 sign_in_required   no session
 *   400 password_required / email_required   nothing to check (the client then shows the field it names)
 *   429 too_many_attempts  5 wrong answers in 15 minutes (counted before the check), with the time left
 *   401 wrong_password / wrong_email
 *   409 job_in_progress    { message, jobs: [{ id, title }] } while it is in a job that is not finished
 *   200 { ok: true }       and the session cookie is cleared (the session itself went with the account)
 */
export async function register(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  if (ctx.config.authMode !== 'accounts') {
    app.post('/api/account/delete', async (_req: FastifyRequest, reply: FastifyReply) => reply.code(404).send({ error: 'not_found' }));
    return;
  }
  const { db, config } = ctx;
  const attempts = createAttemptLimiter(db, ctx.now, ctx.log);
  // Read while the server is built, like the jobs routes: a bad JOB_* setting stops the boot with its own sentence.
  const deps: JobsDeps = { db, bus: ctx.bus, rules: loadJobRules(env), appUrl: config.appUrl, log: ctx.log };

  app.post('/api/account/delete', async (req, reply) => {
    const { account } = await ctx.identify(req);
    if (!account) return reply.code(401).send({ error: 'sign_in_required' });
    const found = await findCredentials(db, account.email);
    if (!found || found.account.id !== account.id) return reply.code(401).send({ error: 'sign_in_required' });

    // What proves it is the owner: the password, or for an account without one, its e-mail address typed out.
    const body = fields(req.body);
    const stored = found.passwordHash;
    const answer = stored !== null ? body.password : body.email;
    // A password is taken as typed (eight spaces is a password); an e-mail address is trimmed like at sign-in.
    if (typeof answer !== 'string' || (stored !== null ? answer === '' : answer.trim() === '')) {
      return reply.code(400).send(stored !== null
        ? { error: 'password_required', message: DELETE_WORDS.passwordRequired }
        : { error: 'email_required', message: DELETE_WORDS.emailRequired });
    }

    // 'account:delete:<account id>:<session>' (deleteAccount removes every one of the account's keys by that prefix).
    const rule = { key: `account:delete:${account.id}:${sessionKey(req) ?? 'no-session'}`, ...DELETE_ACCOUNT_LIMIT };
    const verdict = await attempts.count([rule]); // counted before the slow check (review rs-1)
    if (!verdict.ok) {
      return reply.code(429).header('retry-after', verdict.retryAfterSec)
        .send({ error: 'too_many_attempts', message: `Too many wrong tries. Wait ${minutes(verdict.retryAfterSec)}, then try again.` });
    }
    // The same check sign-in makes (src/auth/password.ts); nothing stored is longer than the maximum, so that is no hash.
    const right = stored !== null
      ? passwordLength(answer) <= PASSWORD_MAX && await verifyPassword(answer, stored)
      : normalizeEmail(answer) === normalizeEmail(found.account.email);
    if (!right) {
      return reply.code(401).send(stored !== null
        ? { error: 'wrong_password', message: DELETE_WORDS.wrongPassword }
        : { error: 'wrong_email', message: DELETE_WORDS.wrongEmail });
    }
    await attempts.release([rule.key]);

    // A job whose closing time or contact window just ran out is settled first, so it is not taken for one in progress.
    const now = ctx.now().getTime();
    await settleDue(deps, now);
    const result = await deleteAccount(db, account.id, new Date(now));
    await ctx.realtime?.flush(); // alerts the settlement raised leave before a serverless function freezes
    if (result.blocking.length) {
      return reply.code(409).send({ error: 'job_in_progress', message: DELETE_WORDS.inProgress, jobs: result.blocking });
    }
    if (!result.deleted) return reply.code(401).send({ error: 'sign_in_required' }); // it was deleted a moment ago
    ctx.log(`account: ${account.id} deleted itself and everything tied to it`);
    return reply.header('set-cookie', sessionCookie(null, config.cookieSecure)).send({ ok: true });
  });
}
