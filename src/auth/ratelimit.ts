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

/**
 * Attempt counters kept in the DATABASE (table auth_attempts), so every serverless instance and every restart sees
 * the same counts: the in-memory map started empty on each Vercel instance (audit sec-session-2).
 *
 * A route reads the counters before the attempt (`check`: nothing is counted) and counts only what it decides to
 * count afterwards (`count`), usually failures only: a successful sign-in never uses up an office's allowance.
 * Each call is ONE statement. If the database call fails, one line is logged and the attempt goes through: a
 * broken limiter must never lock everybody out.
 */
export interface AttemptLimiter {
  /** Has any rule used up its allowance (count >= limit)? Counts nothing: ask it before an attempt. */
  check(rules: readonly LimitRule[]): Promise<Verdict>;
  /** Live counts of these keys (missing or expired = 0). */
  peek(keys: readonly string[]): Promise<Map<string, number>>;
  /** Count one attempt on every rule; the verdict says whether any of them is now over its limit. */
  count(rules: readonly LimitRule[]): Promise<Verdict>;
  /** Forget these keys (a successful sign-in clears that e-mail's counters). */
  clear(keys: readonly string[]): Promise<void>;
}

const OK: Verdict = { ok: true, retryAfterSec: 1 };
/** Expired rows are deleted lazily by the counting statement, at most this many at a time. */
const SWEEP = 50;

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
      if (!rules.length) return OK;
      const at = now();
      try {
        // One statement: sweep a few expired rows (never one being counted here), then count every rule. A key
        // whose window is over starts again at 1 with a new window.
        const rows = await db.query<{ key: string; count: number; expires_at: Date | string }>(
          `with gone as (
             delete from auth_attempts where key in (
               select key from auth_attempts where expires_at <= $3 and key <> all($1::text[]) limit ${SWEEP})
           )
           insert into auth_attempts as a (key, count, expires_at)
           select k, 1, e from unnest($1::text[], $2::timestamptz[]) as t(k, e)
           on conflict (key) do update set
             count = case when a.expires_at <= $3 then 1 else a.count + 1 end,
             expires_at = case when a.expires_at <= $3 then excluded.expires_at else a.expires_at end
           returning key, count, expires_at`,
          [rules.map((r) => r.key), rules.map((r) => new Date(at.getTime() + r.windowMs).toISOString()), at.toISOString()],
        );
        return verdict(rules, rows, at.getTime(), false);
      } catch (err) {
        failed('count', err);
        return OK;
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
  };
}

// ----------------------------------------------------------------- the address --

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
  }
  if (!isLoopback(req.ip)) return req.ip;
  const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return hops.at(-1) ?? req.ip;
}
