import type { FastifyRequest } from 'fastify';

/** Small in-memory attempt counter (one process, which is how the app runs). Fixed window per key. */
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

const isLoopback = (ip: string): boolean => ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.');

/**
 * The caller's address for rate limiting. Behind a reverse proxy on the same machine (the pilot runs
 * behind Caddy) every connection comes from loopback, and the proxy puts the real caller last in
 * X-Forwarded-For. The header is believed only then: a direct caller could write anything into it.
 */
export function clientIp(req: FastifyRequest): string {
  if (!isLoopback(req.ip)) return req.ip;
  const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return hops.at(-1) ?? req.ip;
}
