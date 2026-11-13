import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';
import { notImplemented, requireAdmin } from './shared.js';

/** Sign up / sign in / sign out, and the operator's plan switch. STUB (foundation): every route answers 501. */
export async function register(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get('/api/auth/config', async (_req, reply) => notImplemented(reply));
  app.post('/api/auth/signup', async (_req, reply) => notImplemented(reply));
  app.post('/api/auth/login', async (_req, reply) => notImplemented(reply));
  app.post('/api/auth/oauth', async (_req, reply) => notImplemented(reply));
  app.post('/api/auth/logout', async (_req, reply) => notImplemented(reply));

  app.post('/api/admin/plan', async (req, reply) => {
    if (!requireAdmin(ctx, req, reply)) return reply;
    return notImplemented(reply);
  });
}
