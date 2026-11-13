import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';
import { getFeed, getItem, getSaved, lastScan, recordSwipe, undoSwipe } from '../db/repo.js';
import { pickNext } from '../feed/next.js';
import type { SwipeAction } from '../types.js';

const ACTIONS: SwipeAction[] = ['save', 'pass', 'bid'];

/** The feed: swipe deck, browse list, saved, one bid, swipes, and the "next bid" pick. */
export async function register(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { db, now } = ctx;

  app.get<{ Querystring: { minScore?: string; limit?: string; all?: string } }>('/api/feed', async (req, reply) => {
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    const minScore = Math.max(0, Math.min(100, Number(req.query.minScore ?? 35) || 0));
    const limit = Math.max(1, Math.min(300, Number(req.query.limit ?? 100) || 100));
    const all = req.query.all === '1';
    // The deck never shows over-limit bids; Browse (all=1) keeps them, tagged by item.overLimit.
    const items = await getFeed(db, id.profile.id, { minScore, limit, includeSwiped: all, hideOverLimit: !all, now: now() });
    return { items, lastScan: (await lastScan(db))?.finishedAt ?? null };
  });

  app.get('/api/saved', async (req, reply) => {
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    return { items: await getSaved(db, id.profile.id) };
  });

  app.get<{ Params: { id: string } }>('/api/bids/:id', async (req, reply) => {
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    const item = await getItem(db, id.profile.id, req.params.id);
    return item ?? reply.code(404).send({ error: 'not_found' });
  });

  app.post<{ Body: { bidId?: string; action?: string } }>('/api/swipe', async (req, reply) => {
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    const { bidId, action } = req.body ?? {};
    if (!bidId || !ACTIONS.includes(action as SwipeAction)) {
      return reply.code(400).send({ error: 'bidId and action (save | pass | bid) are required' });
    }
    const ok = await recordSwipe(db, id.profile.id, bidId, action as SwipeAction);
    return ok ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  app.delete<{ Params: { id: string } }>('/api/swipe/:id', async (req, reply) => {
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    await undoSwipe(db, id.profile.id, req.params.id);
    return { ok: true };
  });

  app.get('/api/next', async (req, reply) => {
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    const open = await getFeed(db, id.profile.id, { limit: 300, hideOverLimit: true, now: now() });
    return pickNext(open, now());
  });
}
