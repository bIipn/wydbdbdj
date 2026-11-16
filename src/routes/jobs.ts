import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createRateLimiter, type RateLimiter } from '../auth/ratelimit.js';
import type { RouteContext } from '../context.js';
import { env } from '../env.js';
import { loadJobRules, publicRules } from '../jobs/config.js';
import * as jobs from '../jobs/service.js';
import type { JobsDeps, Refusal, Result } from '../jobs/service.js';
import { listReports, resolveContentReport, waiveFee } from '../jobs/repo.js';
import type { Account } from '../types.js';
import { requireAdmin } from './shared.js';

/** Per account, per window (contract rule 11). Generous for a person, tight for a script. */
const LIMITS = {
  post: { limit: 10, windowMs: 60 * 60_000 },
  bid: { limit: 30, windowMs: 10 * 60_000 },
  message: { limit: 60, windowMs: 10 * 60_000 },
  report: { limit: 10, windowMs: 60 * 60_000 },
  // opening a conversation (Messages): cheap, but still not something a script may hammer
  read: { limit: 300, windowMs: 10 * 60_000 },
} as const;

const STATUS: Record<Refusal['error'], number> = { invalid_input: 400, not_allowed: 403, not_found: 404, closed: 409 };

/**
 * The job marketplace: post a job, bid on it, award, contact window, messages (contract section 4).
 *
 * Accounts mode only: the pilot (single mode) has no accounts, so every route here answers 404 there, like the
 * sign-in routes. Every route first runs settleDue(): there are no timers on the serverless host, so whatever
 * closed or ran out since the last request is settled before anyone sees the job. The settings are read here,
 * while the server is built, so a bad JOB_* value stops the boot with its own sentence (src/jobs/config.ts).
 */
export async function register(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const routes: Array<['get' | 'post' | 'delete', string]> = [
    ['get', '/api/jobs/rules'], ['post', '/api/jobs'], ['get', '/api/jobs/mine'], ['get', '/api/jobs/conversations'], ['get', '/api/jobs/:id'],
    ['get', '/api/jobs/:id/conversation'], ['post', '/api/jobs/:id/read'],
    ['post', '/api/jobs/:id/bid'], ['delete', '/api/jobs/:id/bid'], ['post', '/api/jobs/:id/cancel'], ['post', '/api/jobs/:id/repost'],
    ['post', '/api/jobs/:id/messages'], ['post', '/api/jobs/:id/contacted'], ['post', '/api/jobs/:id/confirm'],
    ['post', '/api/jobs/:id/back-out'], ['post', '/api/jobs/:id/complete'], ['post', '/api/jobs/:id/report'],
    ['get', '/api/admin/jobs/reports'], ['post', '/api/admin/jobs/:id/remove'], ['post', '/api/admin/jobs/fees/:feeId/waive'],
    // reporting what people write (Microsoft Store policy 11.12): a conversation, a person's card; the operators' side
    ['post', '/api/jobs/:id/conversation/report'], ['post', '/api/people/:id/report'],
    ['post', '/api/admin/jobs/messages/:messageId/remove'], ['post', '/api/admin/people/:id/hide'], ['post', '/api/admin/people/:id/unhide'],
    ['post', '/api/admin/reports/:reportId/resolve'],
  ];
  if (ctx.config.authMode !== 'accounts') {
    const absent = async (_req: FastifyRequest, reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
    for (const [method, path] of routes) app[method](path, absent);
    return;
  }

  // A job request can raise alerts (a new job's 'match', an award, a message). Their pushes wait on a short
  // timer to be grouped; on a serverless host the function freezes as soon as the answer is out, so that timer
  // would only fire at the next daily tick. Send them before answering, like the cron routes do.
  app.addHook('onSend', async (req, _reply, payload) => {
    if (ctx.realtime && /^\/api\/(?:admin\/)?jobs(?:[/?]|$)/.test(req.url)) await ctx.realtime.flush();
    return payload;
  });

  const rules = loadJobRules(env);
  const deps: JobsDeps = { db: ctx.db, bus: ctx.bus, rules, appUrl: ctx.config.appUrl, log: ctx.log };
  const limiters: Record<keyof typeof LIMITS, RateLimiter> = {
    post: createRateLimiter({ ...LIMITS.post, now: ctx.now }),
    bid: createRateLimiter({ ...LIMITS.bid, now: ctx.now }),
    message: createRateLimiter({ ...LIMITS.message, now: ctx.now }),
    report: createRateLimiter({ ...LIMITS.report, now: ctx.now }),
    read: createRateLimiter({ ...LIMITS.read, now: ctx.now }),
  };

  /** settleDue, then the signed-in account (or a 401 sent). Every jobs route starts here. */
  const begin = async (req: FastifyRequest, reply: FastifyReply): Promise<{ account: Account; now: number } | null> => {
    const now = ctx.now().getTime();
    await jobs.settleDue(deps, now);
    const { account } = await ctx.identify(req);
    if (!account) {
      reply.code(401).send({ error: 'sign_in_required' });
      return null;
    }
    return { account, now };
  };

  /** Count one try; false once over the limit (429 sent). */
  const allowed = (kind: keyof typeof LIMITS, account: Account, reply: FastifyReply): boolean => {
    const verdict = limiters[kind].hit(account.id);
    if (verdict.ok) return true;
    reply.code(429).header('retry-after', verdict.retryAfterSec).send({ error: 'too_many_attempts' });
    return false;
  };

  /** A service answer → the HTTP answer (refusals carry the contract's error shapes). */
  const answer = <T>(reply: FastifyReply, result: Result<T>, wrap: (v: T) => unknown, status = 200) => {
    if (result.ok) return reply.code(status).send(wrap(result.value));
    return reply.code(STATUS[result.refusal.error]).send(result.refusal);
  };

  type IdReq = FastifyRequest<{ Params: { id: string } }>;

  // The rules are the same for everybody and say nothing private: no sign-in needed to read them.
  app.get('/api/jobs/rules', async () => {
    await jobs.settleDue(deps, ctx.now().getTime());
    return { rules: publicRules(rules) };
  });

  app.post('/api/jobs', async (req, reply) => {
    const me = await begin(req, reply);
    if (!me || !allowed('post', me.account, reply)) return reply;
    return answer(reply, await jobs.postJob(deps, me.account.id, req.body, me.now), (job) => ({ job }), 201);
  });

  app.get('/api/jobs/mine', async (req, reply) => {
    const me = await begin(req, reply);
    if (!me) return reply;
    return jobs.myJobs(deps, me.account.id, me.now);
  });

  // Messages: the conversations this account is in (the poster or the winner of a job, after the award).
  app.get('/api/jobs/conversations', async (req, reply) => {
    const me = await begin(req, reply);
    if (!me) return reply;
    return jobs.conversations(deps, me.account.id, me.now);
  });

  app.get('/api/jobs/:id/conversation', async (req: IdReq, reply) => {
    const me = await begin(req, reply);
    if (!me) return reply;
    return answer(reply, await jobs.conversationFor(deps, me.account.id, req.params.id, me.now), (v) => v);
  });

  app.post('/api/jobs/:id/read', async (req: IdReq, reply) => {
    const me = await begin(req, reply);
    if (!me || !allowed('read', me.account, reply)) return reply;
    return answer(reply, await jobs.readConversation(deps, me.account.id, req.params.id, req.body, me.now), (v) => v);
  });

  app.get('/api/jobs/:id', async (req: IdReq, reply) => {
    const me = await begin(req, reply);
    if (!me) return reply;
    return answer(reply, await jobs.getJobFor(deps, req.params.id, me.account.id, me.now), (v) => v);
  });

  app.post('/api/jobs/:id/bid', async (req: IdReq, reply) => {
    const me = await begin(req, reply);
    if (!me || !allowed('bid', me.account, reply)) return reply;
    return answer(reply, await jobs.placeBid(deps, me.account.id, req.params.id, req.body, me.now), (job) => ({ job }));
  });

  app.delete('/api/jobs/:id/bid', async (req: IdReq, reply) => {
    const me = await begin(req, reply);
    if (!me || !allowed('bid', me.account, reply)) return reply;
    return answer(reply, await jobs.withdrawBid(deps, me.account.id, req.params.id, me.now), (job) => ({ job }));
  });

  app.post('/api/jobs/:id/cancel', async (req: IdReq, reply) => {
    const me = await begin(req, reply);
    if (!me) return reply;
    return answer(reply, await jobs.cancelJob(deps, me.account.id, req.params.id, me.now), (job) => ({ job }));
  });

  app.post('/api/jobs/:id/repost', async (req: IdReq, reply) => {
    const me = await begin(req, reply);
    if (!me || !allowed('post', me.account, reply)) return reply;
    return answer(reply, await jobs.repostJob(deps, me.account.id, req.params.id, req.body, me.now), (job) => ({ job }), 201);
  });

  app.post('/api/jobs/:id/messages', async (req: IdReq, reply) => {
    const me = await begin(req, reply);
    if (!me || !allowed('message', me.account, reply)) return reply;
    return answer(reply, await jobs.sendMessage(deps, me.account.id, req.params.id, req.body, me.now), (message) => ({ message }));
  });

  app.post('/api/jobs/:id/contacted', async (req: IdReq, reply) => {
    const me = await begin(req, reply);
    if (!me) return reply;
    return answer(reply, await jobs.markContacted(deps, me.account.id, req.params.id, me.now), (job) => ({ job }));
  });

  app.post('/api/jobs/:id/confirm', async (req: IdReq, reply) => {
    const me = await begin(req, reply);
    if (!me) return reply;
    return answer(reply, await jobs.confirmAgreement(deps, me.account.id, req.params.id, me.now), (job) => ({ job }));
  });

  app.post('/api/jobs/:id/back-out', async (req: IdReq, reply) => {
    const me = await begin(req, reply);
    if (!me) return reply;
    return answer(reply, await jobs.backOutOfJob(deps, me.account.id, req.params.id, me.now), (job) => ({ job }));
  });

  app.post('/api/jobs/:id/complete', async (req: IdReq, reply) => {
    const me = await begin(req, reply);
    if (!me) return reply;
    return answer(reply, await jobs.completeJob(deps, me.account.id, req.params.id, me.now), (job) => ({ job }));
  });

  app.post('/api/jobs/:id/report', async (req: IdReq, reply) => {
    const me = await begin(req, reply);
    if (!me || !allowed('report', me.account, reply)) return reply;
    return answer(reply, await jobs.reportJob(deps, me.account.id, req.params.id, req.body, me.now), (v) => v);
  });

  // Report a conversation (its poster or its winner) or a card (someone allowed to see it). The same hourly limit
  // as "Report this job", shared with it.
  app.post('/api/jobs/:id/conversation/report', async (req: IdReq, reply) => {
    const me = await begin(req, reply);
    if (!me || !allowed('report', me.account, reply)) return reply;
    return answer(reply, await jobs.reportConversation(deps, me.account.id, req.params.id, req.body, me.now), (v) => v);
  });

  app.post('/api/people/:id/report', async (req: IdReq, reply) => {
    const me = await begin(req, reply);
    if (!me || !allowed('report', me.account, reply)) return reply;
    return answer(reply, await jobs.reportPerson(deps, me.account.id, req.params.id, req.body, me.now), (v) => v);
  });

  // ----------------------------------------------------------- operators --
  // x-admin-token, like every /api/admin route (the access-code hook skips that prefix, so each checks its own).

  app.get('/api/admin/jobs/reports', async (req, reply) => {
    if (!requireAdmin(ctx, req, reply)) return reply;
    await jobs.settleDue(deps, ctx.now().getTime());
    const content = await jobs.contentReports(deps);
    return {
      reports: await listReports(ctx.db),
      conversationReports: content.filter((r) => r.kind === 'conversation'),
      profileReports: content.filter((r) => r.kind === 'profile'),
    };
  });

  const idNumber = (v: string): number | null => (/^\d{1,15}$/.test(v) ? Number(v) : null);

  // Remove one message: the row stays, both sides see "Message removed by BidSwipe"; nothing else about the job moves.
  app.post('/api/admin/jobs/messages/:messageId/remove', async (req: FastifyRequest<{ Params: { messageId: string } }>, reply) => {
    if (!requireAdmin(ctx, req, reply)) return reply;
    const id = idNumber(req.params.messageId);
    return id !== null && (await jobs.removeMessage(deps, id, ctx.now().getTime())) ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  // Hide a person's card (others see the lite card and "Profile hidden by BidSwipe"), or show it again.
  for (const [action, hidden] of [['hide', true], ['unhide', false]] as const) {
    app.post(`/api/admin/people/:id/${action}`, async (req: IdReq, reply) => {
      if (!requireAdmin(ctx, req, reply)) return reply;
      const done = await jobs.setPersonHidden(deps, req.params.id, hidden, ctx.now().getTime());
      return done ? { ok: true, ...done } : reply.code(404).send({ error: 'not_found' });
    });
  }

  // Close a conversation or profile report (it stays in the list, marked resolved).
  app.post('/api/admin/reports/:reportId/resolve', async (req: FastifyRequest<{ Params: { reportId: string } }>, reply) => {
    if (!requireAdmin(ctx, req, reply)) return reply;
    const id = idNumber(req.params.reportId);
    return id !== null && (await resolveContentReport(ctx.db, id, ctx.now().getTime())) ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  app.post('/api/admin/jobs/:id/remove', async (req: IdReq, reply) => {
    if (!requireAdmin(ctx, req, reply)) return reply;
    const now = ctx.now().getTime();
    await jobs.settleDue(deps, now);
    return (await jobs.removeJob(deps, req.params.id, now)) ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  app.post('/api/admin/jobs/fees/:feeId/waive', async (req: FastifyRequest<{ Params: { feeId: string } }>, reply) => {
    if (!requireAdmin(ctx, req, reply)) return reply;
    const now = ctx.now().getTime();
    await jobs.settleDue(deps, now);
    const id = /^\d{1,15}$/.test(req.params.feeId) ? Number(req.params.feeId) : null;
    const fee = id === null ? null : await waiveFee(ctx.db, id, now);
    if (!fee) return reply.code(404).send({ error: 'not_found' });
    ctx.log(`jobs: fee ${fee.id} waived by an operator`);
    return { fee };
  });
}
