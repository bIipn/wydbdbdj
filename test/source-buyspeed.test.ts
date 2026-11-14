import { describe, expect, it } from 'vitest';
import {
  BUYSPEED_BOARDS, BUYSPEED_MAX_PAGES, bidBuySource, buySpeedBoard, buySpeedNotice, buySpeedPageBody, commbuysSource, dropMojibake,
  keepBuySpeedTradeWork, njstartSource, openBidsUrl, oregonBuysSource, parseBuySpeedPage, parseBuySpeedPartial, placeOfOrg,
} from '../src/sources/buyspeed.js';
import { finalizeBid } from '../src/scan.js';
import type { BidDraft, FetchLike, Source, SourceContext } from '../src/types.js';
import { HttpError } from '../src/util/http.js';
import { CAPTURED, fx } from './helpers.js';

// The four Periscope BuySpeed boards added on 2026-11-14 (NevadaEPro, the first, keeps its tests in
// sources.test.ts and fetch.test.ts). Fixtures are RAW server responses with the scanner's User-Agent, trimmed to
// the results form and a few whole rows (test/fixtures/buyspeed.md); oregonbuys-page2.xml is the board's real
// answer to the page-2 POST. No network here.

const OREGON = buySpeedBoard('oregonbuys');
const COMMBUYS = buySpeedBoard('commbuys');
const BIDBUY = buySpeedBoard('bidbuy');
const NJSTART = buySpeedBoard('njstart');

const page = (id: string) => fx(`${id}-open-bids.html`);
const PAGE2 = fx('oregonbuys-page2.xml');
const byId = (bids: BidDraft[], id: string): BidDraft => bids.find((b) => b.sourceId === id)!;

describe('the board table', () => {
  it('every board is built; only NevadaEPro keeps every row', () => {
    expect(BUYSPEED_BOARDS.map((b) => [b.id, b.state, b.timeZone, b.ready, b.tradeOnly])).toEqual([
      ['nevadaepro', 'NV', 'America/Los_Angeles', true, false],
      ['oregonbuys', 'OR', 'America/Los_Angeles', true, true],
      ['commbuys', 'MA', 'America/New_York', true, true],
      ['bidbuy', 'IL', 'America/Chicago', true, true],
      ['njstart', 'NJ', 'America/New_York', true, true],
    ]);
  });
});

describe('parseBuySpeedPage on each board (raw first pages, 2026-11-14)', () => {
  it('OregonBuys: 10 kept rows of a 174-bid board, Pacific times', () => {
    const p = parseBuySpeedPage(page('oregonbuys'), OREGON);
    expect(p).toMatchObject({ tableFound: true, rows: 10, total: 174 });
    expect(p.bids).toHaveLength(10);
    expect(byId(p.bids, 'S-C01010-00018407')).toEqual({
      source: 'oregonbuys',
      sourceId: 'S-C01010-00018407',
      sourceName: 'OregonBuys (State of Oregon)',
      title: 'RFQ 2026-85 Mill Park Playground Improvements',
      agency: 'Clackamas County',
      description: 'Buyer: Tralee Whitley · Bid S-C01010-00018407',
      category: 'Public purchase',
      location: { county: 'Clackamas', state: 'OR', label: 'Clackamas County, OR' },
      postedAt: null,
      dueAt: '2026-12-16T22:00:00.000Z', // 12/16/2026 2:00 PM PST
      estValue: null,
      naics: null,
      setAside: null,
      url: 'https://oregonbuys.gov/bso/external/bidDetail.sda?docId=S-C01010-00018407&external=true&parentUrl=close',
      flags: ['May be supply-only'],
    });
    // "12/11/2026 12:00 AM" on the board's clock is 08:00 UTC.
    expect(byId(p.bids, 'S-10700-00018405').dueAt).toBe('2026-12-11T08:00:00.000Z');
  });

  it('COMMBUYS: Eastern times, towns from "Town of …" and town housing authorities', () => {
    const p = parseBuySpeedPage(page('commbuys'), COMMBUYS);
    expect(p).toMatchObject({ rows: 10, total: 890 });
    const culvert = byId(p.bids, 'BD-27-1664-HWY02-HWY02-135383');
    expect(culvert).toMatchObject({
      title: 'Sleepy Hollow Culvert Replacement',
      agency: 'Town of Richmond',
      location: { city: 'Richmond', state: 'MA' },
      dueAt: '2026-12-17T18:00:00.000Z', // 12/17/2026 1:00 PM EST
    });
    expect(byId(p.bids, 'BD-17-1921-MMQHA-MMQHA-135380').location).toEqual({ city: 'Quincy', state: 'MA' });
    expect(byId(p.bids, 'BD-24-1895-HGE00-HGE01-135406').location).toEqual({ city: 'Holyoke', state: 'MA' }); // Holyoke Gas & Electric
    // A state body names no town.
    expect(byId(p.bids, 'BD-27-1044-EPS11-1044O-135411').location).toEqual({ state: 'MA' });
  });

  it('COMMBUYS: the board\'s own double-encoded quotes (bytes already lost) are dropped', () => {
    const p = parseBuySpeedPage(page('commbuys'), COMMBUYS);
    expect(page('commbuys')).toContain('on call Ã?Â¢Ã?Â?Ã?Â?backupÃ?Â¢Ã?Â?Ã?Â? electrical');
    expect(byId(p.bids, 'BD-17-1860-PURCH-CENTR-135359').title).toBe('on call backup electrical contracting services');
  });

  it('BidBuy: Central times ("12:00 AM" is 06:00 UTC in December), state agencies stay at the state', () => {
    const p = parseBuySpeedPage(page('bidbuy'), BIDBUY);
    expect(p).toMatchObject({ rows: 8, total: 149 });
    expect(byId(p.bids, '27-557THA-ENGCO-B-54856')).toMatchObject({
      agency: 'THA - Toll Highway Authority',
      dueAt: '2026-12-18T06:00:00.000Z',
      location: { state: 'IL' },
    });
    expect(byId(p.bids, '27-444DHS-PROCU-B-54827').dueAt).toBe('2026-12-01T20:00:00.000Z'); // 2:00 PM CST
  });

  it('NJSTART: its "Contract #" column changes nothing; one page of 19', () => {
    expect(page('njstart')).toContain('aria-label="Contract #"');
    const p = parseBuySpeedPage(page('njstart'), NJSTART);
    expect(p).toMatchObject({ rows: 19, total: 19 });
    expect(p.bids).toHaveLength(19);
    expect(byId(p.bids, '26DPP01264')).toMatchObject({
      title: 'T1434 - Operation & Maintenance of Wastewater and Potable Water Treatment Plants - NLDC',
      agency: 'Division of Purchase and Property',
      dueAt: '2026-12-11T19:00:00.000Z', // 12/11/2026 2:00 PM EST
      location: { state: 'NJ' },
    });
  });

  it('reads the results form a page-2 POST needs', () => {
    const p = parseBuySpeedPage(page('oregonbuys'), OREGON);
    expect(p.form).toEqual({
      action: 'https://oregonbuys.gov/bso/view/search/external/advancedSearchBid.xhtml',
      fields: [['bidSearchResultsForm', 'bidSearchResultsForm'], ['_csrf', 'TRIMMED'], ['openBids', 'true'], ['javax.faces.ViewState', 'TRIMMED']],
      tableId: 'bidSearchResultsForm:bidResultId',
      pageSize: 25, // from the widget config, not from the 10 rows the fixture keeps
    });
    expect(p.headers.filter(Boolean)).toEqual([
      'Bid Solicitation #', 'Organization Name', 'Blanket #', 'Buyer', 'Description', 'Bid Opening Date', 'Awarded Vendor(s)', 'Status', 'Alternate Id',
    ]);
  });
});

describe('placeOfOrg', () => {
  it('a city only when the ZIP table knows it in the board\'s state', () => {
    expect(placeOfOrg('City of Salem', 'OR')).toEqual({ city: 'Salem', state: 'OR' });
    expect(placeOfOrg('City of Detroit', 'OR')).toEqual({ city: 'Detroit', state: 'OR' }); // Detroit, Oregon
    expect(placeOfOrg('New Bedford Housing Authority', 'MA')).toEqual({ city: 'New Bedford', state: 'MA' });
    expect(placeOfOrg('Town of Nowhereville', 'MA')).toEqual({ state: 'MA' });
  });

  it('a county by name; Nevada and California counties are left to locate()', () => {
    expect(placeOfOrg('Marion County', 'OR')).toEqual({ county: 'Marion', state: 'OR', label: 'Marion County, OR' });
    expect(placeOfOrg('Douglas County', 'NV')).toEqual({ county: 'Douglas', state: 'NV' });
    expect(finalizeBid({ ...parseBuySpeedPage(page('oregonbuys'), OREGON).bids[0]! }).location).toMatchObject({
      county: 'Washington', state: 'OR', lat: null, precision: 'state', label: 'Washington County, OR',
    });
  });

  it('anything else: the state', () => {
    for (const org of ['Department of Corrections', 'Clackamas River Water', 'Salem Area Mass Transit District-Cherriots', 'Division of Purchase and Property', null]) {
      expect(placeOfOrg(org, 'OR'), String(org)).toEqual({ state: 'OR' });
    }
  });

  it('locate() puts a named town on the map', () => {
    const salem = byId(parseBuySpeedPage(page('oregonbuys'), OREGON).bids, 'S-KS0043-00018411');
    expect(finalizeBid(salem).location).toMatchObject({ city: 'Salem', state: 'OR', precision: 'city', label: 'Salem, OR' });
  });
});

describe('what is left out', () => {
  it('notices that are not a bid, by the board\'s own words', () => {
    expect(buySpeedNotice('SOLE SOURCE NOTICE - BOARD Application Support Services')).toBe('sole source');
    expect(buySpeedNotice('Notice of Intent to Award a Sole-Source Contract')).toBe('notice of intent to award');
    expect(buySpeedNotice('NOT A BID/ OREGON FORWARD Suitability Determination Notice Cornerstone, Janitorial Services')).toBe('not a bid');
    expect(buySpeedNotice('MassDOT Notice of Intent to Accept a Best Value Offer for Aurigo Masterworks')).toBe('notice of intent to accept');
    expect(buySpeedNotice('CHANGE ORDER NOTICE: Black Hawk SHS Museum Window Dormer Repairs & Replacements')).toBe('change order notice');
    expect(buySpeedNotice('Emergency Final Cost-3500 and 7500 maintenance')).toBe('emergency final cost');
    expect(buySpeedNotice('Emergency Extension Notice: 27IT123029 IBM Extension')).toBe('emergency extension notice');
    expect(buySpeedNotice('Exempt Notice - DHS Exempt Procurement Report - October 2026')).toBe('exempt notice');
    // Real bids stay, "LEGAL AD ONLY" included (the documents are elsewhere, the bid is real).
    expect(buySpeedNotice('LEGAL AD ONLY FY27 ON CALL SERVICE PROVIDER FOR COMMERCIAL KITCHEN EQUIPMENT MAINTENANCE AND REPAIR')).toBeNull();
    expect(buySpeedNotice('RFQ 2026-85 Mill Park Playground Improvements')).toBeNull();
  });

  it('OregonBuys: 4 kept of 10 (4 notices, 2 not trade work)', () => {
    const { kept, notices, notTrade } = keepBuySpeedTradeWork(parseBuySpeedPage(page('oregonbuys'), OREGON).bids);
    expect(kept.map((b) => b.title)).toEqual([
      'RFQ 2026-85 Mill Park Playground Improvements',
      'CRW RFQ for Purpose of Establishing Multiple On Call Flagging and Traffic Control Service Contracts',
      'Invitation to Bid - Westport Road Improvement Project',
      'ITB - Marion County Courthouse Parking Structure Refurbishment',
    ]);
    expect({ notices, notTrade }).toEqual({ notices: 4, notTrade: 2 }); // printing services; water-system engineering
  });

  it('BidBuy: the change-order and exempt notices go even when they name trade work', () => {
    const { kept, notices } = keepBuySpeedTradeWork(parseBuySpeedPage(page('bidbuy'), BIDBUY).bids);
    expect(kept.map((b) => b.sourceId)).toEqual(['27-557THA-ENGCO-B-54858', '27-557THA-ENGCO-B-54856', '27-444DHS-PROCU-B-54827']);
    expect(notices).toBe(4);
  });

  it('dropMojibake leaves ordinary text alone', () => {
    expect(dropMojibake('Ashburnham Municipal Light — 2027 Tree Work: Line Clearing')).toBe('Ashburnham Municipal Light — 2027 Tree Work: Line Clearing');
  });
});

describe('page 2+: the PrimeFaces partial POST', () => {
  const p1 = parseBuySpeedPage(page('oregonbuys'), OREGON);
  const TABLE = 'bidSearchResultsForm:bidResultId';

  it('builds the paginator\'s request from the first page\'s form', () => {
    const body = new URLSearchParams(buySpeedPageBody(p1.form!, 'VS-1', 50));
    expect([...body]).toEqual([
      ['bidSearchResultsForm', 'bidSearchResultsForm'], ['_csrf', 'TRIMMED'], ['openBids', 'true'], ['javax.faces.ViewState', 'VS-1'],
      ['javax.faces.partial.ajax', 'true'], ['javax.faces.source', TABLE], ['javax.faces.partial.execute', TABLE],
      ['javax.faces.partial.render', TABLE], [TABLE, TABLE], [`${TABLE}_pagination`, 'true'], [`${TABLE}_first`, '50'],
      [`${TABLE}_rows`, '25'], [`${TABLE}_skipChildren`, 'true'], [`${TABLE}_encodeFeature`, 'true'],
    ]);
  });

  it('reads the real answer: rows from 25, labelled by page 1\'s header', () => {
    const p2 = parseBuySpeedPartial(PAGE2, OREGON, p1.headers, TABLE);
    expect(p2).toMatchObject({ rows: 7, first: 25, total: 174, viewState: 'TRIMMED', error: null });
    expect(byId(p2.bids, 'S-73000-00018356')).toMatchObject({
      title: 'ODOT Bldg. A HVAC Controls Replacement',
      agency: 'Department of Transportation',
      dueAt: '2026-11-18T19:00:00.000Z', // 11/18/2026 11:00 AM PST
      url: 'https://oregonbuys.gov/bso/external/bidDetail.sda?docId=S-73000-00018356&external=true&parentUrl=close',
      location: { state: 'OR' },
    });
    expect(byId(p2.bids, 'S-KE0010-00018349').location).toEqual({ city: 'Eugene', state: 'OR' });
  });

  it('anything else is an error, never zero bids', () => {
    const read = (xml: string) => parseBuySpeedPartial(xml, OREGON, p1.headers, TABLE).error;
    expect(read(page('oregonbuys'))).toMatch(/not a partial-response/);
    expect(read('<?xml version="1.0"?><partial-response><redirect url="/bso/login.xhtml"></redirect></partial-response>')).toMatch(/redirected/);
    expect(read('<?xml version="1.0"?><partial-response><error><error-name>javax.faces.application.ViewExpiredException</error-name></error></partial-response>'))
      .toBe('the board answered with an error (javax.faces.application.ViewExpiredException)');
    expect(read(PAGE2.replace('update id="bidSearchResultsForm:bidResultId"', 'update id="something:else"'))).toBe('no table rows in the answer');
    // Without page 1's header the bare cells cannot be named.
    expect(parseBuySpeedPartial(PAGE2, OREGON, [], TABLE)).toMatchObject({ rows: 7, bids: [] });
  });
});

// --------------------------------------------------------------------------------------------- fetch() --

interface Call { method: string; url: string; headers: Record<string, string>; body: URLSearchParams | null }

/**
 * A board behind a cookie session: GET → `first`, each POST → the next answer in `posts` (a string, or an Error
 * to throw). `cookies` = the names the session holds after the GET.
 */
function board(first: string, posts: Array<string | Error>, cookies = ['AWSALB', 'JSESSIONID', 'XSRF-TOKEN'], session = true) {
  const calls: Call[] = [];
  const answers = [...posts];
  const http: FetchLike = {
    async text(url, init) {
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body ? new URLSearchParams(String(init.body)) : null });
      if (method === 'GET') return first;
      const next = answers.shift();
      if (next === undefined) throw new Error('unexpected POST');
      if (next instanceof Error) throw next;
      return next;
    },
    json: async () => ({}) as never,
  };
  const withSession: FetchLike = { ...http, session: () => ({ ...http, cookieNames: () => cookies }) };
  const logs: string[] = [];
  const partial: string[] = [];
  const ctx: SourceContext = {
    http: session ? withSession : http, now: CAPTURED, env: () => undefined, log: (m) => logs.push(m), partial: (m) => partial.push(m),
  };
  return { ctx, calls, logs, partial };
}

/** The real page 1 with its paginator and widget config saying `total` (the fixture is the 174-bid board). */
const announcing = (html: string, total: number) => html.replace(/1-25 of 174/g, `1-25 of ${total}`).replace(/rowCount:174/g, `rowCount:${total}`);
/** The real page-2 answer saying `total` and handing out ViewState `vs`. */
const answer2 = (total: number, vs = 'TRIMMED') =>
  PAGE2.replace('{&#34;totalRecords&#34;:174}', `{&#34;totalRecords&#34;:${total}}`).replace('<![CDATA[TRIMMED]]>', `<![CDATA[${vs}]]>`);
/** SYNTHETIC page 3, made from the real page-2 answer: rows renumbered from 50 and bid numbers suffixed "-P3". */
const answer3 = (total: number) =>
  answer2(total, 'TEST-VS-3').replace(/data-ri="(\d+)"/g, (_, n: string) => `data-ri="${Number(n) + 25}"`).replace(/(S-[A-Z0-9]+-\d{8})/g, '$1-P3');

describe('fetch(): paging through a session', () => {
  it('reads every page, chains the ViewState, then leaves out what is not trade work', async () => {
    const t = board(announcing(page('oregonbuys'), 60), [answer2(60, 'TEST-VS-2'), answer3(60)]);
    const bids = await oregonBuysSource.fetch(t.ctx);

    expect(t.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST']);
    expect(t.calls[0]!.url).toBe(openBidsUrl(OREGON));
    const [, p2, p3] = t.calls;
    expect(p2!.url).toBe('https://oregonbuys.gov/bso/view/search/external/advancedSearchBid.xhtml');
    expect(p2!.headers).toMatchObject({ 'Faces-Request': 'partial/ajax', 'X-Requested-With': 'XMLHttpRequest' });
    expect(p2!.body!.get('bidSearchResultsForm:bidResultId_first')).toBe('25');
    expect(p2!.body!.get('javax.faces.ViewState')).toBe('TRIMMED'); // page 1's
    expect(p3!.body!.get('bidSearchResultsForm:bidResultId_first')).toBe('50');
    expect(p3!.body!.get('javax.faces.ViewState')).toBe('TEST-VS-2'); // the one page 2 handed out

    // 10 + 7 + 7 read. Left out: page 1's printing and water-system engineering, each answer's Medford canal
    // engineering services, each answer's "Vegetables Frozen, Assorted", each answer's "SUD Housing Rental
    // Assistance LOI" (a rental programme, relevance.ts), and page 1's four notices.
    expect(t.logs).toEqual(['oregonbuys: 24 of 60 listed (pages 3/3), 12 kept (8 not trade work, 4 notices that are not a bid)']);
    expect(bids).toHaveLength(12);
    expect(bids.map((b) => b.sourceId)).toContain('S-73000-00018356');
    expect(t.partial).toEqual([]);
  });

  it('a POST that fails is never sent again: page 1 is kept and the stop is said', async () => {
    const t = board(page('oregonbuys'), [new HttpError(503, 'https://oregonbuys.gov/bso/view/search/external/advancedSearchBid.xhtml')]);
    const bids = await oregonBuysSource.fetch(t.ctx);
    expect(t.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(bids).toHaveLength(4);
    expect(t.logs).toEqual([
      'oregonbuys: 10 of 174 listed (pages 1/7), 4 kept (2 not trade work, 4 notices that are not a bid)' +
        ' — stopped: rows from 25 failed (HTTP 503 for https://oregonbuys.gov/bso/view/search/external/advancedSearchBid.xhtml)',
    ]);
    expect(t.partial).toEqual(['oregonbuys: stopped: rows from 25 failed (HTTP 503 for https://oregonbuys.gov/bso/view/search/external/advancedSearchBid.xhtml), 10 of 174 read']);
  });

  it('stops at an HTML page, a session the board let go, or rows from the wrong offset', async () => {
    const cases: Array<[string, string]> = [
      ['<!DOCTYPE html><html><body>Access denied</body></html>', 'answer is not a partial-response (HTML page instead?), rows from 25'],
      ['<?xml version="1.0"?><partial-response><redirect url="/bso/"></redirect></partial-response>', 'the board redirected the page request (session expired?), rows from 25'],
      [PAGE2.replace(/data-ri="(\d+)"/g, (_, n: string) => `data-ri="${Number(n) - 25}"`), 'asked for rows from 25, got rows from 0'],
    ];
    for (const [xml, why] of cases) {
      const t = board(page('oregonbuys'), [xml]);
      expect(await oregonBuysSource.fetch(t.ctx)).toHaveLength(4);
      expect(t.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
      expect(t.logs[0]).toMatch(new RegExp(`— stopped: ${why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    }
  });

  it('an answer that only repeats rows already read stops the paging', async () => {
    const again = answer2(174).replace(/data-ri="(\d+)"/g, (_, n: string) => `data-ri="${Number(n) + 25}"`); // same bids, next offset
    const t = board(page('oregonbuys'), [answer2(174), again]);
    await oregonBuysSource.fetch(t.ctx);
    expect(t.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST']);
    expect(t.logs[0]).toMatch(/— stopped: rows from 50 added nothing new$/);
  });

  it('never POSTs without the session cookie of the first GET', async () => {
    const t = board(page('oregonbuys'), [], ['AWSALB']);
    expect(await oregonBuysSource.fetch(t.ctx)).toHaveLength(4);
    expect(t.calls.map((c) => c.method)).toEqual(['GET']);
    expect(t.logs[0]).toMatch(/— stopped: session cookie missing$/);
  });

  it('stops at the time budget between pages, never before the first', async () => {
    const t = board(page('oregonbuys'), [answer2(174)]);
    t.ctx.deadline = new Date(Date.now() - 1);
    expect(await oregonBuysSource.fetch(t.ctx)).toHaveLength(4);
    expect(t.calls.map((c) => c.method)).toEqual(['GET']);
    expect(t.logs).toEqual([
      'oregonbuys: stopped at the time budget, 10 of 174 read',
      'oregonbuys: 10 of 174 listed (pages 1/7), 4 kept (2 not trade work, 4 notices that are not a bid) — stopped at the time budget',
    ]);
    expect(t.partial).toEqual(['oregonbuys: stopped at the time budget, 10 of 174 read']);
  });

  it(`asks for at most ${BUYSPEED_MAX_PAGES} pages`, async () => {
    // COMMBUYS announced 890 (36 pages) on 2026-11-14; a board announcing 10,000 is read to the cap and says so.
    const many = Array.from({ length: BUYSPEED_MAX_PAGES }, (_, i) =>
      answer2(10_000).replace(/data-ri="(\d+)"/g, (_, n: string) => `data-ri="${Number(n) + 25 * i}"`).replace(/(S-[A-Z0-9]+-\d{8})/g, `$1-SIM${i}`));
    const t = board(announcing(page('oregonbuys'), 10_000), many);
    await oregonBuysSource.fetch(t.ctx);
    expect(t.calls.filter((c) => c.method === 'POST')).toHaveLength(BUYSPEED_MAX_PAGES - 1);
    expect(t.logs[0]).toMatch(new RegExp(`\\(pages ${BUYSPEED_MAX_PAGES}/400\\).* — stopped: ${BUYSPEED_MAX_PAGES}-page cap$`));
  });

  it('one page that holds every bid needs no POST (NJSTART, 19 of 19)', async () => {
    const t = board(page('njstart'), []);
    const bids = await njstartSource.fetch(t.ctx);
    expect(t.calls.map((c) => c.method)).toEqual(['GET']);
    // Kept: "T1434 - Operation & Maintenance of Wastewater and Potable Water Treatment Plants". Plant operators, re-entry
    // programming and a system administrator stay unclear and a state purchasing list drops those (relevance.ts).
    expect(t.logs).toEqual(['njstart: 19 of 19 listed, 1 kept (18 not trade work, 0 notices that are not a bid)']);
    expect(bids.map((b) => b.sourceId)).toEqual(['26DPP01264']);
  });

  it('without a cookie session (a plain fetch): the first page only, as before', async () => {
    const t = board(page('commbuys'), [], [], false);
    expect(await commbuysSource.fetch(t.ctx)).toHaveLength(6);
    expect(t.calls.map((c) => c.method)).toEqual(['GET']);
    expect(t.logs).toEqual(['commbuys: 10 of 890 listed (first page only), 6 kept (3 not trade work, 1 notices that are not a bid)']);
  });
});

describe('fetch(): loud failures', () => {
  const sources: Array<[Source, string]> = [[oregonBuysSource, 'oregonbuys'], [commbuysSource, 'commbuys'], [bidBuySource, 'bidbuy'], [njstartSource, 'njstart']];

  it('a challenge or error page instead of the list is FAILED, not 0 bids', async () => {
    for (const [s] of sources) {
      const t = board('<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>', []);
      await expect(s.fetch(t.ctx)).rejects.toThrow('results table not found');
    }
  });

  it('rows that cannot be read are FAILED', async () => {
    for (const [s, id] of sources) {
      const t = board(page(id).replace(/<thead[\s\S]*?<\/thead>/, ''), []);
      await expect(s.fetch(t.ctx), id).rejects.toThrow(/rows listed but none could be read/);
    }
  });
});
