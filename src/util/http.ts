import type { FetchLike } from '../types.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    url: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} for ${redactUrl(url)}`);
    this.url = redactUrl(url);
  }
  public readonly url: string;
}

/** Query params that carry credentials (SAM.gov puts its key in the URL). */
const SECRET_PARAMS = /([?&](?:api_key|apikey|key|token|access_token)=)[^&#\s"']+/gi;

/** Hide credentials in a URL (or any text containing one) before it reaches logs, errors or the DB. */
export function redactUrl(text: string): string {
  return text.replace(SECRET_PARAMS, '$1***');
}

/** Copy of any error with credentials stripped from its message. */
function scrub(err: unknown, url: string): Error {
  if (err instanceof HttpError) return err;
  const msg = err instanceof Error ? err.message : `Request failed: ${url}`;
  return new Error(redactUrl(msg));
}

export interface HttpOptions {
  userAgent: string;
  timeoutMs?: number;
  retries?: number;
  /** Minimum gap between two requests to the same host — be polite to small agency servers. */
  perHostDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch() with a timeout, retries on 429/5xx/network errors, and per-host pacing. */
export function createHttp(opts: HttpOptions): FetchLike {
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const retries = opts.retries ?? 2;
  const gap = opts.perHostDelayMs ?? 900;
  const lastHit = new Map<string, number>();

  async function pace(url: string) {
    const host = new URL(url).host;
    const wait = (lastHit.get(host) ?? 0) + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
  }

  async function text(url: string, init: RequestInit = {}): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(1000 * 3 ** (attempt - 1)); // 1s, 3s
      await pace(url);
      try {
        const res = await fetch(url, {
          ...init,
          headers: {
            'User-Agent': opts.userAgent,
            Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
            ...(init.headers ?? {}),
          },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'follow',
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new HttpError(res.status, url);
          continue;
        }
        if (!res.ok) throw new HttpError(res.status, url);
        return await res.text();
      } catch (err) {
        if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
        lastErr = err;
      }
    }
    throw scrub(lastErr, url);
  }

  async function json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const body = await text(url, { ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } });
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`Expected JSON from ${redactUrl(url)} but got: ${redactUrl(body.slice(0, 120))}`);
    }
  }

  return { text, json };
}

/** Make a relative href absolute against the page it came from. */
export function absolutize(href: string | undefined | null, base: string): string | null {
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
