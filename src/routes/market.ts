import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';
import { notImplemented, requireAdmin } from './shared.js';

/** Area wages + material prices, award history, and the operator's data refresh. STUB (foundation): every route answers 501. */
export async function register(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get('/api/market/area', async (_req, reply) => notImplemented(reply));
  app.get('/api/market/awards', async (_req, reply) => notImplemented(reply));

  app.post('/api/admin/market/refresh', async (req, reply) => {
    if (!requireAdmin(ctx, req, reply)) return reply;
    return notImplemented(reply);
  });
}
