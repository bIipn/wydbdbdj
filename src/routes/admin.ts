import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';
import { alertCounts, alertOptOuts, decisionDays, returnVisits, windowStart, type UsageWindow } from '../db/usage.js';
import { usageCounts } from '../jobs/repo.js';
import { ALL_ALERT_KINDS } from '../profile/build.js';
import { getGroup, SCAN_GROUPS } from '../sources/groups.js';
import { quietFlag, requireAdmin } from './shared.js';

/**
 * Operator routes (x-admin-token). The other admin routes live with the module they belong to:
 * POST /api/admin/plan in auth.ts, POST /api/admin/market/refresh in market.ts.
 * GET /api/admin/market/watch here: the market watcher's status, errors included.
 * GET /api/admin/usage here: counts only (docs/PLAN.md N11).
 */
export async function register(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  // ?group=<name> scans one scan group (src/sources/groups.ts); none = the default group.
  // ?quiet=1 (or a JSON body { "quiet": true }): store and score, announce nothing (src/scan.ts ScanDeps.quiet).
  app.post<{ Querystring: { group?: string; quiet?: string }; Body: { quiet?: unknown } | undefined }>('/api/admin/scan', async (req, reply) => {
    if (!requireAdmin(ctx, req, reply)) return reply;
    if (!ctx.scan) return reply.code(501).send({ error: 'scan not configured' });
    const asked = typeof req.query.group === 'string' && req.query.group !== '' ? req.query.group : undefined;
    const group = asked === undefined ? undefined : getGroup(asked);
    if (group === null) return reply.code(400).send({ error: 'unknown_group', groups: SCAN_GROUPS.map((g) => g.name) });
    const body = req.body && typeof req.body === 'object' ? (req.body as { quiet?: unknown }).quiet : undefined;
    const quiet = body === true ? true : quietFlag(req.query.quiet);
    if (quiet === null || (body !== undefined && typeof body !== 'boolean')) {
      return reply.code(400).send({ error: 'invalid_query', message: 'quiet must be 1 or 0 (or true / false in the body)' });
    }
    return ctx.scan({ ...(group ? { group: group.name } : {}), ...(quiet ? { quiet: true } : {}) });
  });

  // The price and award watcher: schedule, last run with its errors, next run. Operators only.
  app.get('/api/admin/market/watch', async (req, reply) => {
    if (!requireAdmin(ctx, req, reply)) return reply;
    return ctx.market.status();
  });

  /**
   * How BidSwipe is used (docs/PLAN.md N11, §4 "How we know"): counts only, never an id, e-mail, name or text. The
   * last 7 and 28 days: return visits and the days (and mornings) with a decision, each on the person's own calendar;
   * from 00:00 UTC on the first day to now, minutes from a match alert to the first decision on its bid, saves per
   * alert, bids opened from "Bid on …", alerts read, local jobs; and the alert opt-outs as they are now. Every count is
   * real and 0 is said as 0; null means "nothing to measure": a median or a ratio with nothing under it, and the
   * account-only counts in single mode (no accounts there). src/db/usage.ts says what each number is.
   */
  app.get('/api/admin/usage', async (req, reply) => {
    if (!requireAdmin(ctx, req, reply)) return reply;
    const now = ctx.now();
    const accounts = ctx.config.authMode === 'accounts';
    const window = async (days: number): Promise<UsageWindow> => {
      const from = windowStart(now, days);
      return {
        days,
        from: from.toISOString(),
        returnVisits: accounts ? await returnVisits(ctx.db, now, days) : null,
        decisionDays: await decisionDays(ctx.db, now, days),
        ...(await alertCounts(ctx.db, from, now)),
        localJobs: accounts ? await usageCounts(ctx.db, from.toISOString(), now.toISOString()) : null,
      };
    };
    return {
      asOf: now.toISOString(),
      mode: ctx.config.authMode,
      last7: await window(7),
      last28: await window(28),
      alertOptOuts: await alertOptOuts(ctx.db, ALL_ALERT_KINDS),
    };
  });
}
