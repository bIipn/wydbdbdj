import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/db.js';

/** Small in-memory attempt counter (one process). Fixed window per key. The jobs routes use it as a speed bump. */
export interface RateLimiter {
  /** Count one attempt for `key`. `ok` is false once the key is over its limit, until the window ends. */
  hit(key: string): { ok: boolean; retryAfterSec: number };
}

export interface RateLimitOptions {
  /** Attempts allowed per window. */
  limit: number;
  windowMs: number;
  now: () => Date;
  /** Cap on tracked keys, so a flood of made-up emails cannot grow the map without end. */
  maxKeys?: number;
}

export function createRateLimiter({ limit, windowMs, now, maxKeys = 10_000 }: RateLimitOptions): RateLimiter {
  const seen = new Map<string, { count: number; resetAt: number }>();

  const makeRoom = (at: number) => {
    for (const [key, entry] of seen) if (entry.resetAt <= at) seen.delete(key);
    // Still full of live windows: drop the oldest (a Map iterates in insertion order).
    for (const key of seen.keys()) {
      if (seen.size < maxKeys) break;
      seen.delete(key);
    }
  };

  return {
    hit(key) {
      const at = now().getTime();
      let entry = seen.get(key);
      if (!entry || entry.resetAt <= at) {
        if (!entry && seen.size >= maxKeys) makeRoom(at);
        entry = { count: 0, resetAt: at + windowMs };
        seen.set(key, entry);
      }
      entry.count++;
      return { ok: entry.count <= limit, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - at) / 1000)) };
    },
  };
}

// ------------------------------------------------------------- shared counters --

/** One counter: its key, how many it allows, and its fixed window. */
export interface LimitRule {
  key: string;
  limit: number;
  windowMs: number;
}

export interface Verdict {
  ok: boolean;
  /** Seconds until the fullest blocked key's window ends (1 when ok). */
  retryAfterSec: number;
}

/** What one counting statement saw for one key: its count after this attempt, and when its window ends. */
export interface Counted {
  count: number;
  expiresAt: number;
}

/**
 * Attempt counters kept in the DATABASE (table auth_attempts), so every serverless instance and every restart sees
 * the same counts: the in-memory map started empty on each Vercel instance (audit sec-session-2).
 *
 * COUNT FIRST. A route that limits something slow (a password hash, a code check) counts the attempt BEFORE it
 * does the slow part (`count`: one atomic upsert that returns the new counts) and refuses when a count is over its
 * limit; when the attempt turns out to be one that should not count (a right password, a right code), it gives
 * the count back (`release`). Reading first and counting afterwards let a burst of simultaneous requests all pass
 * the read before any was counted: 300 parallel wrong passwords got 300 x 401 against a limit of 10 (review rs-1).
 * Each call is ONE statement. If the database call fails, one line is logged and the attempt goes through: a
 * broken limiter must never lock everybody out.
 */
export interface AttemptLimiter {
  /** Has any rule used up its allowance (count >= limit)? Counts nothing: only for a request that will not be counted. */
  check(rules: readonly LimitRule[]): Promise<Verdict>;
  /** Live counts of these keys (missing or expired = 0). */
  peek(keys: readonly string[]): Promise<Map<string, number>>;
  /** Count one attempt on every rule, atomically; the verdict says whether any of them is now over its limit, and
   *  `counted` holds each key's new count and window end (empty when the database call failed). */
  count(rules: readonly LimitRule[]): Promise<Verdict & { counted: Map<string, Counted> }>;
  /** Give back one counted attempt on each key (a provisional count for an attempt that turned out right). */
  release(keys: readonly string[]): Promise<void>;
  /** Forget these keys (a successful sign-in clears that e-mail's counters). */
  clear(keys: readonly string[]): Promise<void>;
  /** Delete expired rows, at most `max` (the count call does a few each time; the cron tick does more). */
  sweep(max?: number): Promise<number>;
}

const OK: Verdict = { ok: true, retryAfterSec: 1 };
/** Expired rows deleted after each count call, at most this many at a time. */
const SWEEP = 50;

/** Seconds until the latest window end among these keys (at least 1). */
export function secondsLeft(counted: Map<string, Counted>, keys: readonly string[], at: number): number {
  let worst = 0;
  for (const k of keys) worst = Math.max(worst, (counted.get(k)?.expiresAt ?? at) - at);
  return Math.max(1, Math.ceil(worst / 1000));
}

export function createAttemptLimiter(db: Db, now: () => Date, log: (msg: string) => void): AttemptLimiter {
  const failed = (what: string, err: unknown): void => {
    log(`rate limit: the ${what} failed (${err instanceof Error ? err.message : String(err)}); the attempt goes through`);
  };
  /** before: true = asked before an attempt (the allowance is used up at `limit`), false = after counting one (over at limit + 1). */
  const verdict = (rules: readonly LimitRule[], rows: { key: string; count: number; expires_at: Date | string }[], at: number, before: boolean): Verdict => {
    let worst = 0;
    for (const r of rows) {
      const rule = rules.find((x) => x.key === r.key);
      if (!rule || Number(r.count) < rule.limit + (before ? 0 : 1)) continue;
      worst = Math.max(worst, new Date(r.expires_at).getTime() - at);
    }
    return worst > 0 ? { ok: false, retryAfterSec: Math.max(1, Math.ceil(worst / 1000)) } : OK;
  };

  const live = async (keys: readonly string[], at: Date) =>
    db.query<{ key: string; count: number; expires_at: Date | string }>(
      'select key, count, expires_at from auth_attempts where key = any($1::text[]) and expires_at > $2',
      [[...keys], at.toISOString()],
    );

  const sweep = async (max = SWEEP): Promise<number> => {
    try {
      // Its own statement, skipping rows another statement holds: it never waits, so it can never deadlock with a
      // counting statement (those lock only their own keys, in key order).
      const gone = await db.query<{ key: string }>(
        `delete from auth_attempts where key in (
           select key from auth_attempts where expires_at <= $1 limit ${Math.max(1, Math.floor(max))} for update skip locked)
         returning key`,
        [now().toISOString()],
      );
      return gone.length;
    } catch (err) {
      log(`rate limit: the sweep of expired counters failed (${err instanceof Error ? err.message : String(err)})`);
      return 0;
    }
  };

  return {
    async check(rules) {
      if (!rules.length) return OK;
      const at = now();
      try {
        return verdict(rules, await live(rules.map((r) => r.key), at), at.getTime(), true);
      } catch (err) {
        failed('check', err);
        return OK;
      }
    },
    async peek(keys) {
      const counts = new Map<string, number>();
      if (!keys.length) return counts;
      try {
        for (const r of await live(keys, now())) counts.set(r.key, Number(r.count));
      } catch (err) {
        failed('check', err);
      }
      return counts;
    },
    async count(rules) {
      const counted = new Map<string, Counted>();
      if (!rules.length) return { ...OK, counted };
      const at = now();
      // Key order: two statements that count the same keys lock them in the same order (no deadlock).
      const sorted = [...rules].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      try {
        // One statement: count every rule. A key whose window is over starts again at 1 with a new window.
        const rows = await db.query<{ key: string; count: number; expires_at: Date | string }>(
          `insert into auth_attempts as a (key, count, expires_at)
           select k, 1, e from unnest($1::text[], $2::timestamptz[]) with ordinality as t(k, e, n) order by n
           on conflict (key) do update set
             count = case when a.expires_at <= $3 then 1 else a.count + 1 end,
             expires_at = case when a.expires_at <= $3 then excluded.expires_at else a.expires_at end
           returning key, count, expires_at`,
          [sorted.map((r) => r.key), sorted.map((r) => new Date(at.getTime() + r.windowMs).toISOString()), at.toISOString()],
        );
        for (const r of rows) counted.set(r.key, { count: Number(r.count), expiresAt: new Date(r.expires_at).getTime() });
        await sweep();
        return { ...verdict(rules, rows, at.getTime(), false), counted };
      } catch (err) {
        failed('count', err);
        return { ...OK, counted };
      }
    },
    async release(keys) {
      if (!keys.length) return;
      try {
        // One statement, two disjoint parts: a key at 1 goes away, a key above 1 goes down by one.
        await db.query(
          `with gone as (delete from auth_attempts where key = any($1::text[]) and count <= 1 returning key)
           update auth_attempts set count = count - 1 where key = any($1::text[]) and count > 1`,
          [[...keys]],
        );
      } catch (err) {
        failed('release', err);
      }
    },
    async clear(keys) {
      if (!keys.length) return;
      try {
        await db.query('delete from auth_attempts where key = any($1::text[])', [[...keys]]);
      } catch (err) {
        failed('reset', err);
      }
    },
    sweep,
  };
}

// ----------------------------------------------------------------- the address --

let warnedNoEdge = false;
const isLoopback = (ip: string): boolean => ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.');
const firstHop = (v: unknown): string | undefined =>
  String(Array.isArray(v) ? v[0] : v ?? '').split(',').map((s) => s.trim()).find(Boolean);

/**
 * The caller's address for rate limiting.
 *
 * - On Vercel (VERCEL is set) the platform's edge writes `x-real-ip` / `x-vercel-forwarded-for` itself and
 *   overwrites whatever the caller sent, so those are believed there. Nowhere else: off Vercel a caller can write
 *   them, and believing them would let anyone pick a fresh address per request.
 * - Behind a reverse proxy on the same machine (the pilot runs behind Caddy) every connection comes from loopback,
 *   and the proxy puts the real caller LAST in X-Forwarded-For; earlier hops are whatever the caller claimed.
 * - Otherwise the socket address (or Fastify's trustProxy answer, TRUST_PROXY).
 */
export function clientIp(req: FastifyRequest, onVercel = Boolean(process.env.VERCEL)): string {
  if (onVercel) {
    const edge = firstHop(req.headers['x-real-ip']) ?? firstHop(req.headers['x-vercel-forwarded-for']);
    if (edge) return edge;
    // Not expected on Vercel. Said once: every caller would then share one address bucket.
    if (!warnedNoEdge) {
      warnedNoEdge = true;
      console.warn(`[rate limit] on Vercel but no x-real-ip / x-vercel-forwarded-for header: limits fall back to the socket address (${req.ip})`);
    }
  }
  if (!isLoopback(req.ip)) return req.ip;
  const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return hops.at(-1) ?? req.ip;
}
