import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as cheerio from 'cheerio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildNgemPostback, isNgemErrorPage, NGEM_URL, ngemSource, parseNgemPage, parseNgemPager } from '../src/sources/ngem.js';
import type { BidDraft, FetchLike, SourceContext } from '../src/types.js';
import { createHttp, HttpError } from '../src/util/http.js';

const fx = (f: string) => readFileSync(resolve(__dirname, 'fixtures', f), 'utf8');

/** RAW server HTML (what the scanner really gets), captured 2026-11-13 — not browser-saved pages. */
const p1 = fx('ngem-page1.raw.html');
const p2 = fx('ngem-page2.raw.html');
const p3 = fx('ngem-page3.raw.html');
const errorPage = fx('ngem-error.raw.html');

/** __doPostBack target of the "Go to Page n" link (pages 1–3 are ctl05–ctl07 on the live board). */
const target = (n: number) => `ctl00$mainContent$rgBidList$ctl00$ctl03$ctl01$ctl0${4 + n}`;

const GRID = 'table.rgMasterTable';

/** Change a fixture in memory with cheerio and hand back the HTML. */
function edit(html: string, change: ($: cheerio.CheerioAPI) => void): string {
  const $ = cheerio.load(html);
  change($);
  return $.html();
}

describe('NGEM (raw server HTML)', () => {
  const pages = [p1, p2, p3].map((html) => parseNgemPage(html));
  const all = pages.flatMap((p) => p.bids);
  const byId = (id: string) => all.find((b) => b.sourceId === id)!;

  it('parses every row of all three pages', () => {
    expect(pages.map((p) => p.bids.length)).toEqual([20, 20, 6]);
    expect(pages.map((p) => p.rows)).toEqual([20, 20, 6]);
    expect(pages.every((p) => p.tableFound && !p.errorPage)).toBe(true);
    expect(new Set(all.map((b) => b.sourceId)).size).toBe(46);
    expect(all.every((b) => b.title && b.agency && b.category && b.postedAt && b.dueAt)).toBe(true);
    expect(all[0]!.sourceId).toBe('las-vegas-clark-county-library-district:27-02'); // sorted by close date
    expect(all[45]!.sourceId).toBe('city-of-henderson:rfq-172-20-professional-services');
  });

  it('reads the fields of a row', () => {
    expect(byId('carson-city-nevada:27300240')).toMatchObject({
      source: 'ngem',
      sourceName: 'NGEM (local agencies)',
      title: 'Carson River Trail System Phase IV Riverview Trailhead',
      agency: 'Carson City, Nevada',
      category: 'BID',
      description: 'BID · 27300240',
      location: { state: 'NV' },
      postedAt: '2026-11-03T16:00:00.000Z', // 11/3/2026, no time on the board → 8 AM PST
      dueAt: '2026-12-03T22:00:00.000Z', // 12/3/2026 02:00:00 PM (PT)
      url: NGEM_URL, // rows open by JavaScript, so the card links to the board
      flags: [],
    });
  });

  it('keeps one id across addenda and flags them', () => {
    expect(byId('clark-county-nevada:607998-26')).toMatchObject({
      title: 'Fire Station 71 Bunkerville Emergency Generator Connection',
      description: 'Clark County BID · 607998-26 Addendum 1',
      flags: ['Addendum 1 posted'],
    });
  });

  it('converts Pacific wall-clock times to UTC', () => {
    expect(byId('las-vegas-clark-county-library-district:27-02').dueAt).toBe('2026-11-13T22:00:00.000Z'); // 02:00 PM PST
    expect(byId('clark-county-department-of-aviation:request-for-quote-fy27-0053').dueAt).toBe('2026-11-19T07:59:00.000Z'); // 11/18 11:59 PM PST → next day
    expect(byId('city-of-henderson:rfq-172-20-professional-services').dueAt).toBe('2027-07-01T00:00:00.000Z'); // 6/30/2027 05:00 PM PDT
  });

  it('names the columns from the raw header, not from fixed positions', () => {
    expect(pages.every((p) => p.guessedColumns.length === 0)).toBe(true);

    // Move "Organization" to the front, in both header rows and every data row: nothing may change.
    const moved = edit(p1, ($) => {
      $(`${GRID} thead tr, ${GRID} tbody tr`).each((_, tr) => {
        $(tr).prepend($(tr).children().eq(4));
      });
    });
    expect(moved).not.toBe(p1);
    expect(parseNgemPage(moved).bids).toEqual(pages[0]!.bids);

    // Either clue alone is enough: the sort field in the link's onclick, or the visible label.
    const bySortField = parseNgemPage(edit(moved, ($) => $(`${GRID} thead th a`).text('?')));
    const byLabel = parseNgemPage(edit(moved, ($) => $(`${GRID} thead th a`).removeAttr('onclick')));
    for (const page of [bySortField, byLabel]) {
      expect(page.guessedColumns).toEqual([]);
      expect(page.bids).toEqual(pages[0]!.bids);
    }
  });

  it('falls back to the usual positions when the header names nothing, and reports it', () => {
    const page = parseNgemPage(edit(p1, ($) => $(`${GRID} thead th`).empty()));
    expect(page.guessedColumns).toEqual(['colBidNumber', 'colTitle', 'colTypeTitle', 'colWorkGroupName', 'colOpenDate', 'colCloseDate']);
    expect(page.bids).toEqual(pages[0]!.bids);
  });

  it('reads the pager: current page, totals and the postback target of each page link', () => {
    const targets = { 1: target(1), 2: target(2), 3: target(3) };
    expect(parseNgemPager(p1)).toEqual({ current: 1, totalPages: 3, totalItems: 46, targets });
    expect(parseNgemPager(p2)).toEqual({ current: 2, totalPages: 3, totalItems: 46, targets });
    expect(parseNgemPager(p3)).toEqual({ current: 3, totalPages: 3, totalItems: 46, targets });
    expect(pages.map((p) => p.pager.current)).toEqual([1, 2, 3]);
    // The live pager has no plain-GET links at all — that is why the old paging read 1 page of 3.
    expect(pages.every((p) => p.pageUrls.length === 0)).toBe(true);
  });

  it('builds the postback body from the hidden fields of the form', () => {
    const body = new URLSearchParams(buildNgemPostback(p1, target(2))!);
    expect([...body.keys()]).toEqual([
      'ctl00_ScriptManager_TSM',
      '__VIEWSTATE',
      '__VIEWSTATEGENERATOR',
      '__VIEWSTATEENCRYPTED',
      'ctl00_mainContent_rtb_ClientState',
      'ctl00_mainContent_rgBidList_ctl00_ctl03_ctl01_PageSizeComboBox_ClientState',
      'ctl00_mainContent_rgBidList_rfltMenu_ClientState',
      'ctl00_mainContent_rgBidList_ClientState',
      '__EVENTTARGET',
      '__EVENTARGUMENT',
    ]);
    expect(body.get('__VIEWSTATE')).toBe('TRIMMED'); // about 66 KB on the live page; neutralized in the fixture
    expect(body.get('__VIEWSTATEGENERATOR')).toBe('A4E5206D');
    expect(body.get('__EVENTTARGET')).toBe(target(2));
    expect(body.get('__EVENTARGUMENT')).toBe('');
  });

  it('form-encodes the body', () => {
    const raw = buildNgemPostback(p1.replace('value="TRIMMED"', 'value="a+b/c=="'), target(3))!;
    expect(raw).toContain('__VIEWSTATE=a%2Bb%2Fc%3D%3D&');
    expect(raw).toContain('__EVENTTARGET=ctl00%24mainContent%24rgBidList%24ctl00%24ctl03%24ctl01%24ctl07&__EVENTARGUMENT=');
  });

  it('recognises the error page (it arrives with HTTP 200)', () => {
    expect(isNgemErrorPage(errorPage)).toBe(true);
    expect([p1, p2, p3].some((html) => isNgemErrorPage(html))).toBe(false);
    expect(parseNgemPage(errorPage)).toMatchObject({ errorPage: true, tableFound: false, rows: 0, bids: [] });
    expect(buildNgemPostback('<html><body>no form here</body></html>', target(2))).toBeNull();
  });

  it('still reads a browser-saved page (the 2026-11-11 fixture)', () => {
    const old = parseNgemPage(fx('ngem-page1.html'));
    expect(old.bids).toHaveLength(9);
    expect(old.guessedColumns).toEqual([]); // named by aria-label there
    expect(old.pager).toEqual({ current: 1, totalPages: 3, totalItems: 50, targets: {} });
    expect(old.pageUrls).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ fetch() --

interface Call {
  via: 'plain' | 'session';
  method: string;
  url: string;
  contentType: string | null;
  form: URLSearchParams | null;
}

interface Board {
  /** HTML per page number; a function may throw to play a failed request. */
  pages: Record<number, string | (() => string)>;
  /** false = an http helper without session(), like most test fakes. */
  session?: boolean;
  /** Cookie names the session says it holds (default: both that NGEM needs). */
  cookies?: string[];
}

/** Run ngemSource.fetch() against a fake board. No network: GET → page 1, POST → the page whose pager link was posted. */
async function scan(board: Board): Promise<{ bids: BidDraft[]; calls: Call[]; logs: string[] }> {
  const calls: Call[] = [];
  const logs: string[] = [];
  const client = (via: Call['via']): FetchLike => ({
    async text(url, init = {}) {
      const form = typeof init.body === 'string' ? new URLSearchParams(init.body) : null;
      calls.push({ via, method: init.method ?? 'GET', url, contentType: new Headers(init.headers).get('content-type'), form });
      const page = form ? Number(/ctl(\d+)$/.exec(form.get('__EVENTTARGET') ?? '')?.[1]) - 4 : 1; // ctl05 → page 1
      const answer = board.pages[page];
      if (answer === undefined) throw new Error(`the fake board has no page ${page}`);
      return typeof answer === 'function' ? answer() : answer;
    },
    json: async () => ({}) as never,
  });
  const http = client('plain');
  if (board.session !== false) {
    http.session = () => ({ ...client('session'), cookieNames: () => board.cookies ?? ['ASP.NET_SessionId', '__AntiXsrfToken'] });
  }
  const ctx: SourceContext = { http, now: new Date('2026-11-13T20:00:00Z'), env: () => undefined, log: (m) => logs.push(m) };
  return { bids: await ngemSource.fetch(ctx), calls, logs };
}

const sent = (calls: Call[]) => calls.map((c) => `${c.via} ${c.method}`);

describe('NGEM fetch(): paging by postback', () => {
  it('walks all three pages, each POST built from the page before', async () => {
    // Give pages 1 and 2 their own token (in memory) to see whose form each POST carries.
    const state = (html: string, token: string) => html.replace('value="TRIMMED"', `value="${token}"`);
    const { bids, calls, logs } = await scan({ pages: { 1: state(p1, 'STATE-1'), 2: state(p2, 'STATE-2'), 3: p3 } });

    expect(bids).toHaveLength(46);
    expect(new Set(bids.map((b) => b.sourceId)).size).toBe(46);
    expect(logs).toEqual(['ngem: 46 of 46 listed (pages 3/3)']);

    expect(sent(calls)).toEqual(['session GET', 'session POST', 'session POST']);
    expect(calls.every((c) => c.url === NGEM_URL)).toBe(true);
    expect(calls[1]).toMatchObject({ contentType: 'application/x-www-form-urlencoded' });
    expect(calls[1]!.form!.get('__EVENTTARGET')).toBe(target(2));
    expect(calls[1]!.form!.get('__VIEWSTATE')).toBe('STATE-1');
    expect(calls[2]!.form!.get('__EVENTTARGET')).toBe(target(3));
    expect(calls[2]!.form!.get('__VIEWSTATE')).toBe('STATE-2');
  });

  it('stops when the wrong page comes back, and does not ask again', async () => {
    const { bids, calls, logs } = await scan({ pages: { 1: p1, 2: p1, 3: p3 } });
    expect(bids).toHaveLength(20);
    expect(sent(calls)).toEqual(['session GET', 'session POST']);
    expect(logs).toEqual(['ngem: 20 of 46 listed (pages 1/3) — stopped: asked for page 2, got page 1']);
  });

  it('stops at the error page and keeps the pages it already has', async () => {
    const { bids, calls, logs } = await scan({ pages: { 1: p1, 2: p2, 3: errorPage } });
    expect(bids).toHaveLength(40);
    expect(sent(calls)).toEqual(['session GET', 'session POST', 'session POST']);
    expect(logs).toEqual(['ngem: 40 of 46 listed (pages 2/3) — stopped: error page instead of page 3']);
  });

  it('stops when a page adds no new bids', async () => {
    // Page 1's rows again, but with the pager saying "page 2".
    const repeat = edit(p1, ($) => {
      $(`${GRID} .rgNumPart a`).removeClass('rgCurrentPage').eq(1).addClass('rgCurrentPage');
    });
    expect(parseNgemPager(repeat).current).toBe(2);
    const { bids, calls, logs } = await scan({ pages: { 1: p1, 2: repeat, 3: p3 } });
    expect(bids).toHaveLength(20);
    expect(sent(calls)).toEqual(['session GET', 'session POST']);
    expect(logs).toEqual(['ngem: 20 of 46 listed (pages 1/3) — stopped: page 2 added nothing new']);
  });

  it('stops when a postback fails, without retrying it', async () => {
    const boom = () => {
      throw new HttpError(500, NGEM_URL);
    };
    const { bids, calls, logs } = await scan({ pages: { 1: p1, 2: boom, 3: p3 } });
    expect(bids).toHaveLength(20);
    expect(sent(calls)).toEqual(['session GET', 'session POST']);
    expect(logs).toEqual([`ngem: 20 of 46 listed (pages 1/3) — stopped: page 2 failed (HTTP 500 for ${NGEM_URL})`]);
  });

  it('reads page 1 only when the http helper has no session()', async () => {
    const { bids, calls, logs } = await scan({ pages: { 1: p1, 2: p2, 3: p3 }, session: false });
    expect(bids).toHaveLength(20);
    expect(sent(calls)).toEqual(['plain GET']);
    expect(logs).toEqual(['ngem: 20 of 46 listed (pages 1/3) — stopped: no cookie session']);
  });

  it('never posts without both session cookies', async () => {
    const { bids, calls, logs } = await scan({ pages: { 1: p1, 2: p2, 3: p3 }, cookies: ['ASP.NET_SessionId'] });
    expect(bids).toHaveLength(20);
    expect(sent(calls)).toEqual(['session GET']);
    expect(logs).toEqual(['ngem: 20 of 46 listed (pages 1/3) — stopped: the server set no session cookies']);
  });

  it('never posts when the page has no postback pager (browser-saved shape)', async () => {
    const { bids, calls, logs } = await scan({ pages: { 1: fx('ngem-page1.html') } });
    expect(bids).toHaveLength(9);
    expect(sent(calls)).toEqual(['session GET']);
    expect(logs).toEqual(['ngem: 9 of 50 listed (pages 1/3) — stopped: no postback link for page 2']);
  });

  it('says so when the pager is missing', async () => {
    const { bids, calls, logs } = await scan({ pages: { 1: edit(p1, ($) => $(`${GRID} tfoot`).remove()) } });
    expect(bids).toHaveLength(20);
    expect(sent(calls)).toEqual(['session GET']);
    expect(logs).toEqual(['ngem: 20 of ? listed (pages 1/?) — stopped: pager not found']);
  });

  it('never reads more than 8 pages', async () => {
    // Synthetic pager only (12 pages of page 2's rows, renumbered) — the live board has 3.
    const synthetic = (n: number) =>
      edit(p2, ($) => {
        const links = $(`${GRID} .rgNumPart`).empty();
        for (let i = 1; i <= 12; i++) {
          links.append(`<a title="Go to Page ${i}" href="javascript:__doPostBack('pager$ctl${String(i + 4).padStart(2, '0')}','')">${i}</a>`);
        }
        links.children().eq(n - 1).addClass('rgCurrentPage');
        $(`${GRID} .rgInfoPart`).html('<strong>240</strong> items in <strong>12</strong> pages');
        $(`${GRID} tbody tr`).each((_, tr) => {
          const number = $(tr).children('td').eq(1);
          number.text(`P${n}-${number.text()}`);
        });
      });
    const pages = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, synthetic(i + 1)]));
    const { bids, calls, logs } = await scan({ pages });
    expect(bids).toHaveLength(160);
    expect(sent(calls)).toEqual(['session GET', ...Array<string>(7).fill('session POST')]);
    expect(logs).toEqual(['ngem: 160 of 240 listed (pages 8/12) — stopped: 8-page cap']);
  });
});

describe('NGEM fetch(): a page it cannot read is an error, not "0 bids"', () => {
  const failsWith = async (html: string, message: RegExp) => {
    await expect(scan({ pages: { 1: html } })).rejects.toThrow(message);
  };

  it('throws on the error page', () => failsWith(errorPage, /An error has occurred/));
  it('throws when the grid is missing', () => failsWith('<html><body><h1>Down for maintenance</h1></body></html>', /bid grid not found/));
  it('throws when the grid has no rows', () => failsWith(edit(p1, ($) => $(`${GRID} tbody tr`).remove()), /has no rows/));
  it('throws when rows are there but none can be read', () =>
    failsWith(
      edit(p1, ($) => $(`${GRID} tbody tr`).each((_, tr) => void $(tr).children('td').eq(1).text(''))),
      /20 rows on page 1 but none could be read/,
    ));
  it('throws when no close date can be read', () =>
    failsWith(
      edit(p1, ($) => $(`${GRID} tbody tr`).each((_, tr) => void $(tr).children('td').last().text('TBD'))),
      /no close date could be read/,
    ));
});

// --------------------------------------------------------------- cookie jar --

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
      if (n === 3) return answer(['sid=bye; Max-Age=0', 'not a cookie']);
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

  it('carries NGEM paging end to end: GET sets the cookies, every postback brings them back', async () => {
    // A stand-in for the board: like the real one it answers a postback without the cookies with its error page.
    const byTarget: Record<string, string> = { [target(2)]: p2, [target(3)]: p3 };
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
    const bids = await ngemSource.fetch({ http: quick(), now: new Date('2026-11-13T20:00:00Z'), env: () => undefined, log: (m) => logs.push(m) });
    expect(bids).toHaveLength(46);
    expect(logs).toEqual(['ngem: 46 of 46 listed (pages 3/3)']);
    expect(posts).toEqual([`application/x-www-form-urlencoded | ${target(2)}`, `application/x-www-form-urlencoded | ${target(3)}`]);
  });

  it('shares the per-host pacing with the plain helper', async () => {
    const out = stubFetch(() => answer());
    const http = createHttp({ userAgent: 'BidSwipe-test', perHostDelayMs: 120, retries: 0 });
    await http.text(A);
    await http.session!().text(A);
    expect(out[1]!.at - out[0]!.at).toBeGreaterThanOrEqual(100);
  });
});
