import { afterEach, describe, expect, it, vi } from 'vitest';
import { NGEM_URL, ngemSource } from '../src/sources/ngem.js';
import { createHttp, HttpError } from '../src/util/http.js';
import { CAPTURED, fx, ngemTarget } from './helpers.js';

// createHttp().session(): the in-memory cookie jar that NGEM's postback paging needs.
// Global fetch is stubbed in every test, so nothing here touches the network.

describe('createHttp().session(): cookie jar', () => {
  afterEach(() => vi.unstubAllGlobals());

  interface Sent {
    url: string;
    method: string;
    cookie: string | null;
    userAgent: string | null;
    at: number;
  }

  /** Replace global fetch: record what would go out, answer with reply(n) for the n-th request. */
  function stubFetch(reply: (n: number) => Response | Promise<Response>): Sent[] {
    const out: Sent[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      out.push({ url, method: init.method ?? 'GET', cookie: headers.get('cookie'), userAgent: headers.get('user-agent'), at: Date.now() });
      return reply(out.length);
    });
    return out;
  }

  const answer = (setCookie: string[] = [], status = 200, body = 'ok'): Response => {
    const headers = new Headers();
    for (const c of setCookie) headers.append('Set-Cookie', c);
    return new Response(body, { status, headers });
  };

  const A = 'https://a.example/list';
  const quick = (retries = 0) => createHttp({ userAgent: 'BidSwipe-test', perHostDelayMs: 0, retries });

  it('remembers Set-Cookie (name=value only) and replays it to the same host', async () => {
    const out = stubFetch((n) =>
      n === 1 ? answer(['ASP.NET_SessionId=abc123; path=/; HttpOnly; SameSite=Lax', '__AntiXsrfToken=tok456; path=/; HttpOnly']) : answer(),
    );
    const session = quick().session!();
    await session.text(A);
    await session.text('https://a.example/other', { method: 'POST', body: 'x=1' });

    expect(out.map((s) => s.cookie)).toEqual([null, 'ASP.NET_SessionId=abc123; __AntiXsrfToken=tok456']);
    expect(session.cookieNames!(A)).toEqual(['ASP.NET_SessionId', '__AntiXsrfToken']); // names only
    expect(out.every((s) => s.userAgent === 'BidSwipe-test')).toBe(true);
  });

  it('never sends a cookie to another host, scheme or port', async () => {
    const out = stubFetch((n) => (n === 1 ? answer(['sid=1; Domain=example; Path=/']) : answer()));
    const session = quick().session!();
    await session.text(A);
    for (const url of ['https://b.example/list', 'https://sub.a.example/list', 'http://a.example/list', 'https://a.example:8443/list']) {
      await session.text(url);
      expect(session.cookieNames!(url)).toEqual([]);
    }
    await session.text(A);
    expect(out.map((s) => s.cookie)).toEqual([null, null, null, null, null, 'sid=1']);
  });

  it('files cookies under the host that finally answered a redirect', async () => {
    const out = stubFetch((n) => {
      if (n > 1) return answer();
      // fetch followed a redirect: the cookie was set by the host it ended on.
      return Object.defineProperty(answer(['sid=1']), 'url', { value: 'https://login.example/landing' });
    });
    const session = quick().session!();
    await session.text(A);
    await session.text(A);
    await session.text('https://login.example/next');
    expect(out.map((s) => s.cookie)).toEqual([null, null, 'sid=1']);
  });

  it('keeps sessions apart and the plain helper stateless', async () => {
    const out = stubFetch((n) => (n === 1 ? answer(['sid=1']) : answer()));
    const http = quick();
    const first = http.session!();
    const second = http.session!();
    await first.text(A);
    await second.text(A);
    await http.text(A);
    await first.text(A);
    expect(out.map((s) => s.cookie)).toEqual([null, null, null, 'sid=1']);
    expect(http.cookieNames).toBeUndefined();
  });

  it('updates and drops cookies the way the server says', async () => {
    const out = stubFetch((n) => {
      if (n === 1) return answer(['sid=one; Path=/', 'tmp=x']);
      if (n === 2) return answer(['sid=two; Path=/', 'tmp=; expires=Thu, 01 Jan 1970 00:00:00 GMT']);
      if (n === 3) return answer(['sid=bye; Max-Age=0', 'not a cookie', 'odd=café']);
      return answer();
    });
    const session = quick().session!();
    for (let i = 0; i < 4; i++) await session.text(A);
    expect(out.map((s) => s.cookie)).toEqual([null, 'sid=one; tmp=x', 'sid=two', null]);
  });

  it('gives a POST one attempt, while a GET is retried', async () => {
    const out = stubFetch(() => answer([], 503));
    const session = quick(1).session!();
    await expect(session.text(A, { method: 'POST', body: 'a=1' })).rejects.toBeInstanceOf(HttpError);
    expect(out.map((s) => s.method)).toEqual(['POST']);

    await expect(session.text(A)).rejects.toMatchObject({ status: 503 });
    expect(out.map((s) => s.method)).toEqual(['POST', 'GET', 'GET']); // first try + 1 retry (waits 1 s)
  });

  it('does not retry a POST that died on the network either', async () => {
    const out = stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    await expect(quick(2).session!().text(A, { method: 'POST', body: 'a=1' })).rejects.toThrow('fetch failed');
    expect(out).toHaveLength(1);
  });

  it('keeps cookie values and URL secrets out of errors', async () => {
    stubFetch((n) => {
      if (n === 1) return answer(['sid=SECRET-COOKIE; Path=/']);
      if (n === 2) return answer([], 500);
      if (n === 3) return answer([], 404);
      return Promise.reject(new TypeError('fetch failed'));
    });
    const session = quick().session!();
    await session.text(A);
    const errors: unknown[] = [
      await session.text(A, { method: 'POST', body: 'x=1' }).catch((e: unknown) => e),
      await session.text(`${A}?api_key=SECRET-KEY`).catch((e: unknown) => e),
      await session.text(A, { method: 'POST', body: 'x=1' }).catch((e: unknown) => e),
    ];
    expect(errors.map((e) => (e as Error).message)).toEqual([
      'HTTP 500 for https://a.example/list',
      'HTTP 404 for https://a.example/list?api_key=***',
      'fetch failed',
    ]);
    for (const e of errors) expect(`${String(e)} ${JSON.stringify(e)}`).not.toMatch(/SECRET/);
    expect(session.cookieNames!(A)).toEqual(['sid']);
  });

  it('shares the per-host pacing with the plain helper', async () => {
    const out = stubFetch(() => answer());
    const http = createHttp({ userAgent: 'BidSwipe-test', perHostDelayMs: 120, retries: 0 });
    await http.text(A);
    await http.session!().text(A);
    expect(out[1]!.at - out[0]!.at).toBeGreaterThanOrEqual(100);
  });

  it('carries NGEM paging end to end: GET sets the cookies, every postback brings them back', async () => {
    // A stand-in for the board: like the real one it answers a postback without the cookies with its error page.
    const [p1, p2, p3, errorPage] = [fx('ngem-page1.html'), fx('ngem-page2.html'), fx('ngem-page3.html'), fx('ngem-error.html')];
    const byTarget: Record<string, string> = { [ngemTarget(2)]: p2, [ngemTarget(3)]: p3 };
    const posts: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      expect(url).toBe(NGEM_URL);
      if ((init.method ?? 'GET') === 'GET') return answer(['ASP.NET_SessionId=s1; path=/; HttpOnly; SameSite=Lax', '__AntiXsrfToken=x1; path=/; HttpOnly'], 200, p1);
      const headers = new Headers(init.headers);
      const form = new URLSearchParams(String(init.body));
      posts.push(`${headers.get('content-type')} | ${form.get('__EVENTTARGET')}`);
      const allowed = headers.get('cookie') === 'ASP.NET_SessionId=s1; __AntiXsrfToken=x1' && form.get('__VIEWSTATE') === 'TRIMMED';
      return answer([], 200, allowed ? byTarget[form.get('__EVENTTARGET') ?? ''] : errorPage);
    });
    const logs: string[] = [];
    const bids = await ngemSource.fetch({ http: quick(), now: CAPTURED, env: () => undefined, log: (m) => logs.push(m) });
    expect(bids).toHaveLength(46);
    expect(logs).toEqual(['ngem: 46 of 46 listed (pages 3/3)']);
    expect(posts).toEqual([`application/x-www-form-urlencoded | ${ngemTarget(2)}`, `application/x-www-form-urlencoded | ${ngemTarget(3)}`]);
  });
});
