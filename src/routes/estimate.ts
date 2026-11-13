import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';
import { notImplemented } from './shared.js';

/** The cost check: run an estimate, list saved ones. STUB (foundation): every route answers 501. */
export async function register(app: FastifyInstance, _ctx: RouteContext): Promise<void> {
  app.post('/api/estimate', async (_req, reply) => notImplemented(reply));
  app.get('/api/estimates', async (_req, reply) => notImplemented(reply));
}
