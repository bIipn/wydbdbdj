import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContext } from '../context.js';

/** Constant-time string compare for codes and tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Gate for /api/admin/* routes. The access-code hook skips that prefix, so EVERY admin route must
 * start with `if (!requireAdmin(ctx, req, reply)) return reply;`. Answers 401 itself.
 */
export function requireAdmin(ctx: RouteContext, req: FastifyRequest, reply: FastifyReply): boolean {
  const token = String(req.headers['x-admin-token'] ?? '');
  if (ctx.config.adminToken && safeEqual(token, ctx.config.adminToken)) return true;
  reply.code(401).send({ error: 'admin_token_required' });
  return false;
}

/** Placeholder answer for a route whose module is not built yet. */
export function notImplemented(reply: FastifyReply): FastifyReply {
  return reply.code(501).send({ error: 'not_implemented' });
}
