import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';
import { getFeed, getItem, getSaved, lastScan, recordSwipe, undoSwipe, type FeedQuery, type FeedSort } from '../db/repo.js';
import { pickNext } from '../feed/next.js';
import { ALL_SOURCES } from '../sources/index.js';
import type { SourceId, SwipeAction, Verdict } from '../types.js';

const ACTIONS: SwipeAction[] = ['save', 'pass', 'bid'];

// ------------------------------------------------------- query parsing --

const SORTS: readonly FeedSort[] = ['fit', 'due', 'near', 'new', 'value'];
const VERDICTS: readonly Verdict[] = ['great', 'good', 'maybe', 'skip'];
/** The boards, plus 'local': jobs posted on BidSwipe itself, mirrored into the feed (src/jobs/service.ts). */
const SOURCE_IDS: readonly SourceId[] = [...ALL_SOURCES.map((s) => s.id), 'local'];
const MAX_SEARCH_CHARS = 200;
const MAX_DOLLARS = 1e12;

/** A query the client got wrong. The message goes back to it in a 400. */
class BadQuery extends Error {}

type RawQuery = Record<string, unknown>;

/** One value for a parameter. Absent or blank means "not given"; the same parameter twice is refused. */
function text(raw: RawQuery, name: string): string | undefined {
  const v = raw[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new BadQuery(`${name} was given more than once`);
  return v.trim() || undefined;
}

/** A plain number. Out of range is pulled into [min, max]; anything that is not a number is refused. */
function number(raw: RawQuery, name: string, min: number, max: number): number | undefined {
  const s = text(raw, name);
  if (s === undefined) return undefined;
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(s)) throw new BadQuery(`${name} must be a number`);
  return Math.min(max, Math.max(min, Number(s)));
}

function flag(raw: RawQuery, name: string): boolean | undefined {
  const s = text(raw, name)?.toLowerCase();
  if (s === undefined) return undefined;
  if (s === '1' || s === 'true') return true;
  if (s === '0' || s === 'false') return false;
  throw new BadQuery(`${name} must be 1 or 0`);
}

const notOneOf = (name: string, given: string, allowed: readonly string[]) =>
  new BadQuery(`${name}: "${given.slice(0, 40)}" is not one of ${allowed.join(', ')}`);

function oneOf<T extends string>(raw: RawQuery, name: string, allowed: readonly T[]): T | undefined {
  const s = text(raw, name)?.toLowerCase();
  if (s !== undefined && !allowed.includes(s as T)) throw notOneOf(name, s, allowed);
  return s as T | undefined;
}

/** A comma list ("great,good"), or the parameter repeated. */
function listOf<T extends string>(raw: RawQuery, name: string, allowed: readonly T[]): T[] | undefined {
  const v = raw[name];
  const given = (Array.isArray(v) ? v : [v])
    .flatMap((s) => (typeof s === 'string' ? s.split(',') : []))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = given.find((w) => !allowed.includes(w as T));
  if (bad !== undefined) throw notOneOf(name, bad, allowed);
  return given.length ? ([...new Set(given)] as T[]) : undefined;
}

export type FeedQueryResult = { ok: true; query: FeedQuery } | { ok: false; message: string };

/**
 * GET /api/feed's query string → a FeedQuery, every parameter checked.
 *   minScore 0–100 (35) · limit 1–300 (100) · all=1 Browse: swiped bids too, over-limit ones kept and tagged
 *   q · minValue / maxValue · hasValue=1 · maxDistance (mi) · dueWithinDays · source · verdict
 *   sort fit | due | near | new | value · overLimit exclude | only
 * Without all=1 this is the swipe deck, which never holds an over-limit bid.
 * Both read the company's stored scores, and the scan stores scores only for its candidates
 * (src/score/candidates.ts): a bid certainly out of reach is in neither, by design.
 */
export function parseFeedQuery(raw: RawQuery): FeedQueryResult {
  try {
    const all = flag(raw, 'all') ?? false;
    const q = text(raw, 'q')?.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || undefined; // Postgres text cannot hold NUL
    if (q && q.length > MAX_SEARCH_CHARS) throw new BadQuery(`q is too long (${MAX_SEARCH_CHARS} characters at most)`);
    const minValue = number(raw, 'minValue', 0, MAX_DOLLARS);
    const maxValue = number(raw, 'maxValue', 0, MAX_DOLLARS);
    if (minValue !== undefined && maxValue !== undefined && minValue > maxValue) throw new BadQuery('minValue is more than maxValue');
    const limit = number(raw, 'limit', 0, 300);
    const query: FeedQuery = {
      minScore: Math.ceil(number(raw, 'minScore', 0, 100) ?? 35), // scores are whole numbers
      limit: limit ? Math.max(1, Math.floor(limit)) : 100, // 0 has always meant "the default"
      includeSwiped: all,
      overLimit: oneOf(raw, 'overLimit', ['exclude', 'only'] as const) ?? (all ? 'include' : 'exclude'),
      q, minValue, maxValue,
      hasValue: flag(raw, 'hasValue'),
      maxDistance: number(raw, 'maxDistance', 0, 10_000),
      dueWithinDays: number(raw, 'dueWithinDays', 0, 3650),
      sources: listOf(raw, 'source', SOURCE_IDS),
      verdicts: listOf(raw, 'verdict', VERDICTS),
      sort: oneOf(raw, 'sort', SORTS),
    };
    return { ok: true, query };
  } catch (err) {
    if (err instanceof BadQuery) return { ok: false, message: err.message };
    throw err;
  }
}

// --------------------------------------------------------------- routes --

/** The feed: swipe deck, browse list, saved, one bid, swipes, and the "next bid" pick. */
export async function register(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { db, now } = ctx;

  app.get<{ Querystring: RawQuery }>('/api/feed', async (req, reply) => {
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    const parsed = parseFeedQuery(req.query);
    if (!parsed.ok) return reply.code(400).send({ error: 'invalid_query', message: parsed.message });
    const items = await getFeed(db, id.profile.id, { ...parsed.query, now: now() });
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

  // The one bid to look at next: the deck's bids (open, unswiped, under the limits), ranked by pickNext.
  app.get('/api/next', async (req, reply) => {
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    const at = now();
    const deck = await getFeed(db, id.profile.id, { limit: 300, hideOverLimit: true, now: at });
    return pickNext(deck, at);
  });
}
