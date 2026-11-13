import { describe, expect, it } from 'vitest';
import { douglasCountySource } from '../src/sources/douglascounty.js';
import { nevadaEproSource } from '../src/sources/nevadaepro.js';
import { NGEM_URL, ngemSource, parseNgemPager } from '../src/sources/ngem.js';
import type { BidDraft, FetchLike, SourceContext } from '../src/types.js';
import { HttpError } from '../src/util/http.js';
import { browserSavedNgem, CAPTURED, edit, fakeCtx, fx, NGEM_GRID, ngemTarget } from './helpers.js';

// What a source's fetch() does with the page it gets: the log line, the loud failures, NGEM's paging.
// No network: every "board" here answers from test/fixtures (raw server HTML captured 2026-11-13).
// A page that can't be read must end up FAILED in the scan report, never as a quiet "0 bids".

describe('Douglas County fetch()', () => {
  const raw = fx('douglas-rfp.html');
  const ids = (bids: BidDraft[]) => bids.map((b) => b.sourceId);

  it('uses ctx.now and logs "N open of M rows"', async () => {
    const { ctx, logs } = fakeCtx(raw);
    expect(ids(await douglasCountySource.fetch(ctx))).toEqual(['library_strategic_plan']);
    expect(logs).toEqual(['douglascounty: 1 open of 9 rows']);
  });

  it('0 open is a normal answer when the rows are there (deadline day)', async () => {
    const { ctx, logs } = fakeCtx(raw, new Date('2026-11-20T18:00:00Z'));
    expect(await douglasCountySource.fetch(ctx)).toEqual([]);
    expect(logs).toEqual(['douglascounty: 0 open of 9 rows']);
  });

  it('logs every row where the ad overrules the county', async () => {
    const { ctx, logs } = fakeCtx(raw, new Date('2026-07-25T19:00:00Z'));
    expect(ids(await douglasCountySource.fetch(ctx))).toEqual([
      'library_strategic_plan',
      'r_f_p___waterloo_lampe_park_rd_realignment_project',
      'jobs_peak_w_t_p_p_l_c_replacement_project',
    ]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/^douglascounty: jobs_peak_w_t_p_p_l_c_replacement_project: open, the ad says/);
    expect(logs[1]).toBe('douglascounty: 3 open of 9 rows');
  });

  it('throws when the table is missing', async () => {
    const { ctx } = fakeCtx(raw.replace('<table id="rfp-table" class="open-bid">', '<table>'));
    await expect(douglasCountySource.fetch(ctx)).rejects.toThrow('bid table (#rfp-table) not found');
  });

  it('throws when the table has no rows', async () => {
    const { ctx } = fakeCtx(raw.replaceAll('<tr class="rfp-item">', '<tr>'));
    await expect(douglasCountySource.fetch(ctx)).rejects.toThrow('bid table has no rfp-item rows');
  });

  it('throws when the rows are there but none can be read', async () => {
    const { ctx } = fakeCtx(raw.replaceAll('href="/rfp-bids/', 'href="/moved/'));
    await expect(douglasCountySource.fetch(ctx)).rejects.toThrow('9 rows listed but none could be read');
  });

  it('counts rows it had to skip', async () => {
    const { ctx, logs } = fakeCtx(raw.replace('href="/rfp-bids/closed-bids/electrical_service_upgrade"', 'href="#"'));
    expect(await douglasCountySource.fetch(ctx)).toHaveLength(1);
    expect(logs).toEqual(['douglascounty: 1 open of 9 rows (1 unreadable)']);
  });
});

describe('NevadaEPro fetch()', () => {
  const raw = fx('nevadaepro-open-bids.html');

  it('logs how many of the announced bids were listed', async () => {
    const { ctx, logs } = fakeCtx(raw);
    expect(await nevadaEproSource.fetch(ctx)).toHaveLength(25);
    expect(logs).toEqual(['nevadaepro: 25 of 29 listed (first page only)']);
  });

  it('throws when the results table is missing', async () => {
    const { ctx } = fakeCtx('<html><body><h1>An error has occurred</h1></body></html>');
    await expect(nevadaEproSource.fetch(ctx)).rejects.toThrow('results table not found');
  });

  it('throws when there are rows but none can be read', async () => {
    // Same real rows, but the header (the only place the raw HTML names its columns) is gone.
    const { ctx } = fakeCtx(edit(raw, ($) => $('thead').remove()));
    await expect(nevadaEproSource.fetch(ctx)).rejects.toThrow('25 rows listed but none could be read');
  });

  it('throws when the board announces bids but the table is empty', async () => {
    const { ctx } = fakeCtx(edit(raw, ($) => $('tbody tr').remove()));
    await expect(nevadaEproSource.fetch(ctx)).rejects.toThrow('board announces 29 open bids but the table has no rows');
  });

  it('accepts an empty board', async () => {
    // PrimeFaces' stock "no rows" markup, not captured from the board (it has never been empty).
    const empty = edit(raw, ($) => {
      $('tbody').html('<tr class="ui-widget-content ui-datatable-empty-message"><td colspan="11">No records found.</td></tr>');
      $('.ui-paginator-current, script').remove();
    });
    const { ctx, logs } = fakeCtx(empty);
    expect(await nevadaEproSource.fetch(ctx)).toEqual([]);
    expect(logs).toEqual(['nevadaepro: 0 listed (total not announced)']);
  });
});

// ------------------------------------------------------------------- NGEM --

const [p1, p2, p3] = [fx('ngem-page1.html'), fx('ngem-page2.html'), fx('ngem-page3.html')];
const errorPage = fx('ngem-error.html');

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

/** Run ngemSource.fetch() against a fake board: GET → page 1, POST → the page whose pager link was posted. */
async function scanNgem(board: Board): Promise<{ bids: BidDraft[]; calls: Call[]; logs: string[] }> {
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
  const ctx: SourceContext = { http, now: CAPTURED, env: () => undefined, log: (m) => logs.push(m) };
  return { bids: await ngemSource.fetch(ctx), calls, logs };
}

const sent = (calls: Call[]) => calls.map((c) => `${c.via} ${c.method}`);

describe('NGEM fetch(): paging by postback', () => {
  it('walks all three pages, each POST built from the page before', async () => {
    // Give pages 1 and 2 their own token (in memory) to see whose form each POST carries, and page 2
    // its own name for the page-3 link (still ctl07 to the fake board) to see whose pager is followed.
    const state = (html: string, token: string) => html.replace('value="TRIMMED"', `value="${token}"`);
    const moved = ngemTarget(3).replace('ctl01', 'ctl02');
    const page2 = state(p2, 'STATE-2').replace(ngemTarget(3), () => moved);
    expect(parseNgemPager(page2).targets[3]).toBe(moved);
    const { bids, calls, logs } = await scanNgem({ pages: { 1: state(p1, 'STATE-1'), 2: page2, 3: p3 } });

    expect(bids).toHaveLength(46);
    expect(new Set(bids.map((b) => b.sourceId)).size).toBe(46);
    expect(logs).toEqual(['ngem: 46 of 46 listed (pages 3/3)']);

    expect(sent(calls)).toEqual(['session GET', 'session POST', 'session POST']);
    expect(calls.every((c) => c.url === NGEM_URL)).toBe(true);
    expect(calls[1]).toMatchObject({ contentType: 'application/x-www-form-urlencoded' });
    expect(calls[1]!.form!.get('__EVENTTARGET')).toBe(ngemTarget(2));
    expect(calls[1]!.form!.get('__VIEWSTATE')).toBe('STATE-1');
    expect(calls[2]!.form!.get('__EVENTTARGET')).toBe(moved); // page 2's link, not the one page 1 listed
    expect(calls[2]!.form!.get('__VIEWSTATE')).toBe('STATE-2');
  });

  it('stops when the wrong page comes back, and does not ask again', async () => {
    const { bids, calls, logs } = await scanNgem({ pages: { 1: p1, 2: p1, 3: p3 } });
    expect(bids).toHaveLength(20);
    expect(sent(calls)).toEqual(['session GET', 'session POST']);
    expect(logs).toEqual(['ngem: 20 of 46 listed (pages 1/3) — stopped: asked for page 2, got page 1']);
  });

  it('stops at the error page and keeps the pages it already has', async () => {
    const { bids, calls, logs } = await scanNgem({ pages: { 1: p1, 2: p2, 3: errorPage } });
    expect(bids).toHaveLength(40);
    expect(sent(calls)).toEqual(['session GET', 'session POST', 'session POST']);
    expect(logs).toEqual(['ngem: 40 of 46 listed (pages 2/3) — stopped: error page instead of page 3']);
  });

  it('stops when a page adds no new bids', async () => {
    // Page 1's rows again, but with the pager saying "page 2".
    const repeat = edit(p1, ($) => {
      $(`${NGEM_GRID} .rgNumPart a`).removeClass('rgCurrentPage').eq(1).addClass('rgCurrentPage');
    });
    expect(parseNgemPager(repeat).current).toBe(2);
    const { bids, calls, logs } = await scanNgem({ pages: { 1: p1, 2: repeat, 3: p3 } });
    expect(bids).toHaveLength(20);
    expect(sent(calls)).toEqual(['session GET', 'session POST']);
    expect(logs).toEqual(['ngem: 20 of 46 listed (pages 1/3) — stopped: page 2 added nothing new']);
  });

  it('stops when a postback fails, without retrying it', async () => {
    const boom = () => {
      throw new HttpError(500, NGEM_URL);
    };
    const { bids, calls, logs } = await scanNgem({ pages: { 1: p1, 2: boom, 3: p3 } });
    expect(bids).toHaveLength(20);
    expect(sent(calls)).toEqual(['session GET', 'session POST']);
    expect(logs).toEqual([`ngem: 20 of 46 listed (pages 1/3) — stopped: page 2 failed (HTTP 500 for ${NGEM_URL})`]);
  });

  it('reads page 1 only when the http helper has no session()', async () => {
    const { bids, calls, logs } = await scanNgem({ pages: { 1: p1, 2: p2, 3: p3 }, session: false });
    expect(bids).toHaveLength(20);
    expect(sent(calls)).toEqual(['plain GET']);
    expect(logs).toEqual(['ngem: 20 of 46 listed (pages 1/3) — stopped: no cookie session']);
  });

  it.each([[['ASP.NET_SessionId']], [['__AntiXsrfToken']], [[]]])('never posts without both session cookies (holding %j)', async (cookies) => {
    const { bids, calls, logs } = await scanNgem({ pages: { 1: p1, 2: p2, 3: p3 }, cookies });
    expect(bids).toHaveLength(20);
    expect(sent(calls)).toEqual(['session GET']);
    expect(logs).toEqual(['ngem: 20 of 46 listed (pages 1/3) — stopped: session cookies missing']);
  });

  it('never posts when the page has no postback pager (browser-saved shape)', async () => {
    const { bids, calls, logs } = await scanNgem({ pages: { 1: browserSavedNgem(p1), 2: p2, 3: p3 } });
    expect(bids).toHaveLength(20);
    expect(sent(calls)).toEqual(['session GET']);
    expect(logs).toEqual(['ngem: 20 of 46 listed (pages 1/3) — stopped: no postback link for page 2']);
  });

  it('says which columns it had to read by position', async () => {
    const { bids, logs } = await scanNgem({ pages: { 1: edit(p1, ($) => $(`${NGEM_GRID} thead th`).empty()), 2: p2, 3: p3 } });
    expect(bids).toHaveLength(46);
    expect(logs).toEqual([
      'ngem: header does not name colBidNumber, colTitle, colTypeTitle, colWorkGroupName, colOpenDate, colCloseDate — read by position',
      'ngem: 46 of 46 listed (pages 3/3)',
    ]);
  });

  it('says so when the pager is missing', async () => {
    const { bids, calls, logs } = await scanNgem({ pages: { 1: edit(p1, ($) => $(`${NGEM_GRID} tfoot`).remove()) } });
    expect(bids).toHaveLength(20);
    expect(sent(calls)).toEqual(['session GET']);
    expect(logs).toEqual(['ngem: 20 of ? listed (pages 1/?) — stopped: pager not found']);
  });

  it('never reads more than 8 pages', async () => {
    // Synthetic pager only (12 pages of page 2's rows, renumbered, in memory): the live board has 3.
    const synthetic = (n: number) =>
      edit(p2, ($) => {
        const links = $(`${NGEM_GRID} .rgNumPart`).empty();
        for (let i = 1; i <= 12; i++) {
          links.append(`<a title="Go to Page ${i}" href="javascript:__doPostBack('pager$ctl${String(i + 4).padStart(2, '0')}','')">${i}</a>`);
        }
        links.children().eq(n - 1).addClass('rgCurrentPage');
        $(`${NGEM_GRID} .rgInfoPart`).html('<strong>240</strong> items in <strong>12</strong> pages');
        $(`${NGEM_GRID} tbody tr`).each((_, tr) => {
          const number = $(tr).children('td').eq(1);
          number.text(`P${n}-${number.text()}`);
        });
      });
    const pages = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, synthetic(i + 1)]));
    const { bids, calls, logs } = await scanNgem({ pages });
    expect(bids).toHaveLength(160);
    expect(sent(calls)).toEqual(['session GET', ...Array<string>(7).fill('session POST')]);
    expect(logs).toEqual(['ngem: 160 of 240 listed (pages 8/12) — stopped: 8-page cap']);
  });
});

describe('NGEM fetch(): a first page it cannot read is an error, not "0 bids"', () => {
  const failsWith = async (html: string, message: RegExp) => {
    await expect(scanNgem({ pages: { 1: html } })).rejects.toThrow(message);
  };

  it('throws on the error page', () => failsWith(errorPage, /An error has occurred/));
  it('throws when the grid is missing', () => failsWith('<html><body><h1>Down for maintenance</h1></body></html>', /bid grid not found/));
  it('throws when the grid has no rows', () => failsWith(edit(p1, ($) => $(`${NGEM_GRID} tbody tr`).remove()), /bid grid has no rows/));
  it('throws when rows are there but none can be read', () =>
    failsWith(
      edit(p1, ($) => $(`${NGEM_GRID} tbody tr`).each((_, tr) => void $(tr).children('td').eq(1).text(''))),
      /20 rows listed on page 1 but none could be read/,
    ));
  it('throws when no close date can be read', () =>
    failsWith(
      edit(p1, ($) => $(`${NGEM_GRID} tbody tr`).each((_, tr) => void $(tr).children('td').last().text('TBD'))),
      /no close date could be read/,
    ));
});
