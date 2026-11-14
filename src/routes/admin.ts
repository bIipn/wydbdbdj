import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';
import { getGroup, SCAN_GROUPS } from '../sources/groups.js';
import { requireAdmin } from './shared.js';

/**
 * Operator routes (x-admin-token). The other admin routes live with the module they belong to:
 * POST /api/admin/plan in auth.ts, POST /api/admin/market/refresh in market.ts.
 * GET /api/admin/market/watch here: the market watcher's status, errors included.
 */
export async function register(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  // ?group=<name> scans one scan group (src/sources/groups.ts); none = the default group.
  app.post<{ Querystring: { group?: string } }>('/api/admin/scan', async (req, reply) => {
    if (!requireAdmin(ctx, req, reply)) return reply;
    if (!ctx.scan) return reply.code(501).send({ error: 'scan not configured' });
    const asked = typeof req.query.group === 'string' && req.query.group !== '' ? req.query.group : undefined;
    const group = asked === undefined ? undefined : getGroup(asked);
    if (group === null) return reply.code(400).send({ error: 'unknown_group', groups: SCAN_GROUPS.map((g) => g.name) });
    return ctx.scan(group ? { group: group.name } : {});
  });

  // The price and award watcher: schedule, last run with its errors, next run. Operators only.
  app.get('/api/admin/market/watch', async (req, reply) => {
    if (!requireAdmin(ctx, req, reply)) return reply;
    return ctx.market.status();
  });
}
