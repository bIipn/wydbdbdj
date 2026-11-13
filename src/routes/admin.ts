import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';
import { requireAdmin } from './shared.js';

/**
 * Operator routes (x-admin-token). The other admin routes live with the module they belong to:
 * POST /api/admin/plan in auth.ts, POST /api/admin/market/refresh in market.ts.
 */
export async function register(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.post('/api/admin/scan', async (req, reply) => {
    if (!requireAdmin(ctx, req, reply)) return reply;
    if (!ctx.scan) return reply.code(501).send({ error: 'scan not configured' });
    return ctx.scan();
  });
}
