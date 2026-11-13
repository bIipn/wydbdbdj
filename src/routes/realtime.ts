import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';
import { notImplemented } from './shared.js';

/** Live stream, web push subscriptions and the alert inbox. STUB (foundation): every route answers 501. */
export async function register(app: FastifyInstance, _ctx: RouteContext): Promise<void> {
  app.get('/api/stream', async (_req, reply) => notImplemented(reply));
  app.get('/api/push/key', async (_req, reply) => notImplemented(reply));
  app.post('/api/push/subscribe', async (_req, reply) => notImplemented(reply));
  app.delete('/api/push/subscribe', async (_req, reply) => notImplemented(reply));
  app.get('/api/alerts', async (_req, reply) => notImplemented(reply));
  app.post('/api/alerts/read', async (_req, reply) => notImplemented(reply));
}
