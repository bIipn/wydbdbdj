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

/** One session's cookies: origin → name → value. Values stay in here — never logged, never put in an error. */
type CookieJar = Map<string, Map<string, string>>;

const originOf = (url: string) => new URL(url).origin;

/** Keep the name=value of each Set-Cookie header (attributes dropped) under the origin that answered. */
function storeCookies(jar: CookieJar, origin: string, setCookie: string[]): void {
  for (const line of setCookie) {
    const [pair = '', ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, Math.max(eq, 0)).trim();
    // Printable ASCII only, so a stored value can never be refused as a header (and end up quoted in an error).
    if (!name || /[^\x20-\x7e]/.test(pair)) continue;
    const value = pair.slice(eq + 1).trim();
    const cookies = jar.get(origin) ?? new Map<string, string>();
    jar.set(origin, cookies);
    // An empty value or Max-Age=0 is how a server deletes a cookie.
    if (value === '' || attrs.some((a) => /^\s*max-age\s*=\s*(0+|-\d+)\s*$/i.test(a))) cookies.delete(name);
    else cookies.set(name, value);
  }
}

/** The Cookie header for a request, or null when the jar holds nothing for that origin. */
function cookieHeader(jar: CookieJar, url: string): string | null {
  const cookies = jar.get(originOf(url));
  return cookies?.size ? [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') : null;
}

/**
 * fetch() with a timeout, retries on 429/5xx/network errors (GET and HEAD only) and per-host pacing.
 * session() returns the same thing plus a cookie jar; all sessions share the pacing.
 */
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

  /** jar = null for the plain helper, a session's jar otherwise. */
  async function text(jar: CookieJar | null, url: string, init: RequestInit = {}): Promise<string> {
    // Only GET and HEAD are safe to repeat. Anything else (a form postback) gets ONE attempt: after a
    // timeout or a 5xx we cannot know whether the server acted on it, and a replayed form with stale
    // state is one more error on their side.
    const method = (init.method ?? 'GET').toUpperCase();
    const attempts = method === 'GET' || method === 'HEAD' ? retries + 1 : 1;
    let lastErr: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(1000 * 3 ** (attempt - 1)); // 1s, 3s
      await pace(url);
      try {
        const cookie = jar && cookieHeader(jar, url);
        const res = await fetch(url, {
          ...init,
          headers: {
            'User-Agent': opts.userAgent,
            Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
            ...(cookie ? { Cookie: cookie } : {}),
            ...(init.headers ?? {}),
          },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'follow',
        });
        // fetch follows redirects itself, so we only see the last answer: its cookies belong to that host.
        if (jar) storeCookies(jar, originOf(res.url || url), res.headers.getSetCookie());
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

  async function json<T>(jar: CookieJar | null, url: string, init: RequestInit = {}): Promise<T> {
    const body = await text(jar, url, { ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } });
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`Expected JSON from ${redactUrl(url)} but got: ${redactUrl(body.slice(0, 120))}`);
    }
  }

  const client = (jar: CookieJar | null): FetchLike => ({
    text: (url, init) => text(jar, url, init),
    json: <T>(url: string, init?: RequestInit) => json<T>(jar, url, init),
    session: () => client(new Map()),
    ...(jar ? { cookieNames: (url: string) => [...(jar.get(originOf(url))?.keys() ?? [])] } : {}),
  });
  return client(null);
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
