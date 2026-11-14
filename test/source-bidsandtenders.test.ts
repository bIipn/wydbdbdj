import { describe, expect, it } from 'vitest';
import { areaCounties } from '../src/geo/california.js';
import { lookupCity } from '../src/geo/zip.js';
import { finalizeBid } from '../src/scan.js';
import {
  BIDSANDTENDERS_AGENCIES, bidsAndTendersSource, boardTime, dateMs, descriptionText, detailUrl, displayWall, parseBidsAndTenders,
  parseListPage, rowToDraft, searchUrl, splitTitle, townInText, type BidsAndTendersRaw,
} from '../src/sources/bidsandtenders.js';
import { sourcesForGroup } from '../src/sources/groups.js';
import { ALL_SOURCES } from '../src/sources/index.js';
import { statewideBoard } from '../src/sources/statewide.js';
import type { FetchLike, SourceContext } from '../src/types.js';
import { zonedToUtc } from '../src/util/time.js';
import { fx } from './helpers.js';

// bids&tenders, Placer County, CA. Fixtures are RAW answers captured 2026-11-14 with the scanner's User-Agent
// (test/fixtures/bidsandtenders.md): the list page trimmed to whole lines with the token values TRIMMED, the real
// empty Open answer, and the real all-statuses answer with whole rows dropped (only rows naming no person, e-mail or
// phone number kept). No network here.

const PLACER = BIDSANDTENDERS_AGENCIES[0]!;
const LIST = fx('bidsandtenders-placer-list.html');
const OPEN = fx('bidsandtenders-placer-open.json');
const ALL = JSON.parse(fx('bidsandtenders-placer-all.json')) as { success: true; data: BidsAndTendersRaw[]; total: number };
const LIST_URL = 'https://placer.bidsandtenders.net/Module/Tenders/en';
const NODE = 'b92921bd-18c6-468d-b08f-848b03b7c2e6';

/** The list page as one run would see it: TEST tokens in place of TRIMMED, a different one in each form. */
const listWith = (detail = 'TEST-token-1', master = 'TEST-master-token') => LIST
  .replace(/(<div id="masterAntiForgery">\r\n\s*<input name="__RequestVerificationToken" type="hidden" value=")TRIMMED/, `$1${master}`)
  .replace(/(<div id="bidDetailAntiForgery">\r\n\s*<input name="__RequestVerificationToken" type="hidden" value=")TRIMMED/, `$1${detail}`);

/** The wall clock an instant shows in New York (US Eastern). */
function easternWall(ms: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: n('year'), mo: n('month'), d: n('day'), h: n('hour'), mi: n('minute'), s: n('second') };
}

const byTitle = <T extends { title: string }>(rows: T[], start: string): T => rows.find((r) => r.title.startsWith(start))!;

describe('the agency table', () => {
  it('one agency today, Placer County, in Pacific time', () => {
    expect(BIDSANDTENDERS_AGENCIES).toEqual([
      expect.objectContaining({ key: 'placer', host: 'placer.bidsandtenders.net', name: 'Placer County', state: 'CA', county: 'Placer', timeZone: 'America/Los_Angeles' }),
    ]);
    // every town the agency names is on the nationwide ZIP table, so it is placed at the table's point (none typed here)
    for (const town of PLACER.towns) expect(lookupCity(town, 'CA'), town).not.toBeNull();
  });

  it('is a source of the west group, and not a statewide board', () => {
    expect(ALL_SOURCES).toContain(bidsAndTendersSource);
    expect(sourcesForGroup('west')!.map((s) => s.id)).toContain('bidsandtenders');
    expect(bidsAndTendersSource).toMatchObject({ id: 'bidsandtenders', homepage: LIST_URL, states: ['CA'], timeZone: 'America/Los_Angeles' });
    expect(statewideBoard('bidsandtenders')).toBeNull();
  });
});

describe('parseListPage (the real list page)', () => {
  it('reads #Home, #NodeId and the token of #bidDetailAntiForgery, not the logout form', () => {
    expect(parseListPage(LIST)).toEqual({ home: '/Module/Tenders/en', nodeId: NODE, token: 'TRIMMED' });
    expect(parseListPage(listWith('TEST-detail', 'TEST-master')).token).toBe('TEST-detail');
  });

  it('throws on a page with no #NodeId or no token (a challenge or sign-in page)', () => {
    expect(() => parseListPage(LIST.replace(/<input type="hidden" id="NodeId"[^>]*>/, ''))).toThrow(/no #NodeId/);
    expect(() => parseListPage(LIST.replace(/<div id="bidDetailAntiForgery">[\s\S]*?<\/div>/, ''))).toThrow(/no __RequestVerificationToken/);
    expect(() => parseListPage('<html><head><title>Just a moment...</title></head><body>TEST challenge</body></html>')).toThrow(/no #NodeId/);
  });

  it('builds the search call the page builds', () => {
    expect(searchUrl(PLACER, parseListPage(LIST), 0)).toBe(
      `${LIST_URL}/Tender/Search/${NODE}?status=Open&limit=100&start=0&dir=ASC&from=&to=&sort=DateClosing%20ASC,Id`,
    );
  });
});

describe('closing times: what /Date(ms)/ means (the real rows)', () => {
  it('every real row: ms is the Pacific wall clock read as US Eastern, never the instant and never the wall clock as UTC', () => {
    for (const r of ALL.data) {
      const ms = dateMs(r.DateClosing)!;
      const shown = boardTime(r.DateClosingDisplay, null, r.TimeZoneLabel, 'America/Los_Angeles').iso!;
      // ms rendered on an Eastern clock shows exactly the time the page shows.
      expect(easternWall(ms), r.Title).toEqual(displayWall(r.DateClosingDisplay));
      // Read as a true instant it would be 3 hours before the real closing (Eastern is 3 hours ahead of Pacific).
      expect(Date.parse(shown) - ms, r.Title).toBe(3 * 3600_000);
      // Read as the wall clock written as UTC it would be 7 hours off (PDT): wrong too.
      expect(Date.parse(shown) - ms).not.toBe(0);
      expect(r.TimeZoneLabel).toBe(' (PDT)');
    }
  });

  it('the parser stores the time the page shows, in Pacific time', () => {
    const p = parseBidsAndTenders(ALL, PLACER);
    expect(byTitle(p.rows, '20692').closesAt).toBe('2026-10-14T23:00:00.000Z'); // "Wed Oct 14, 2026 4:00 PM (PDT)"
    expect(byTitle(p.rows, '20673').closesAt).toBe('2026-08-25T00:00:00.000Z'); // "Mon Aug 24, 2026 5:00 PM (PDT)"
    expect(byTitle(p.rows, '20692').postedAt).toBe('2026-09-29T18:00:00.000Z'); // "Tue Sep 29, 2026 11:00 AM"
    expect(p.rows.every((r) => !r.clockMismatch)).toBe(true);
  });

  it('a PST closing (the real values of the Olympic Valley row, left out of the fixture for its dial-in number)', () => {
    const t = boardTime('Tue Nov 3, 2026 11:00 AM', '/Date(1793721600000)/', ' (PST)', 'America/Los_Angeles');
    expect(t).toEqual({ iso: '2026-11-03T19:00:00.000Z', mismatch: false });
    expect(new Date(1793721600000).toISOString()).toBe('2026-11-03T16:00:00.000Z'); // 11:00 EST, not 11:00 PST
  });

  it('with no display string, /Date(ms)/ is re-read through the Eastern clock; a label for the wrong offset gives no time', () => {
    expect(boardTime('', '/Date(1792008000000)/', ' (PDT)', 'America/Los_Angeles').iso).toBe('2026-10-14T23:00:00.000Z');
    expect(boardTime('Wed Oct 14, 2026 4:00 PM', '/Date(1792008000000)/', ' (PST)', 'America/Los_Angeles').iso).toBeNull();
    // TEST variation: a /Date()/ one hour off the shown time is flagged, the shown time kept.
    expect(boardTime('Wed Oct 14, 2026 4:00 PM', '/Date(1792011600000)/', ' (PDT)', 'America/Los_Angeles'))
      .toEqual({ iso: zonedToUtc(2026, 10, 14, 16, 0, 0, 'America/Los_Angeles').toISOString(), mismatch: true });
  });
});

describe('parseBidsAndTenders', () => {
  it('the real all-statuses answer: 7 rows (of 473), every field read, HTML stripped', () => {
    const p = parseBidsAndTenders(ALL, PLACER);
    expect(p.total).toBe(473);
    expect(p.rows).toHaveLength(7);
    expect(new Set(p.rows.map((r) => r.status))).toEqual(new Set(['Closed']));
    const kb = byTitle(p.rows, '20692');
    expect(kb).toMatchObject({ id: 'e09b4c12-942f-4075-9a29-f4c1e109ed66', status: 'Closed', title: '20692 - Snow Removal Services for Kings Beach Benefit Assessment District' });
    expect(kb.description).toMatch(/^Placer County is seeking bids for snow removal services for the Kings Beach Benefit Assessment District\. /);
    expect(kb.description).toMatch(/subject to Prevailing wages\.$/);
    for (const r of p.rows) {
      expect(r.description, r.title).not.toMatch(/<|&nbsp;|&amp;|Public$/);
      expect(r.description.length, r.title).toBeGreaterThan(100);
    }
  });

  it('the real empty Open answer is no rows, not a failure', () => {
    expect(parseBidsAndTenders(JSON.parse(OPEN), PLACER)).toEqual({ rows: [], total: 0 });
  });

  it('throws on success not true, no data array, a total with no rows, or rows with no Id and Title', () => {
    expect(() => parseBidsAndTenders({ success: false, data: [], total: 0 }, PLACER)).toThrow(/success=false/);
    expect(() => parseBidsAndTenders({ success: true, total: 0 }, PLACER)).toThrow(/no data array/);
    expect(() => parseBidsAndTenders({ success: true, data: [], total: 12 }, PLACER)).toThrow(/total 12 but no rows/);
    expect(() => parseBidsAndTenders({ success: true, data: [{ Name: 'TEST' }], total: 1 }, PLACER)).toThrow(/none with an Id and a Title/);
    expect(() => parseBidsAndTenders('<html>TEST</html>', PLACER)).toThrow();
  });

  it('cuts the bid-opening Teams block off the description (TEST snippet in the real markup shape)', () => {
    const html = '<p>Placer County is soliciting bids for TEST work.&nbsp;</p><p><span><strong>BID Opening</strong></span></p>'
      + '<p><strong>Microsoft Teams meeting</strong></p><p>Join: https://teams.microsoft.com/meet/TEST</p><p>Passcode: TEST</p>';
    expect(descriptionText(html)).toBe('Placer County is soliciting bids for TEST work.');
  });
});

describe('a row as a card', () => {
  const p = parseBidsAndTenders(ALL, PLACER);

  it('number split off the title, the Detail link, the county as the place', () => {
    expect(splitTitle('20693 - Olympic Valley Road Snow Removal')).toEqual({ number: '20693', name: 'Olympic Valley Road Snow Removal' });
    expect(splitTitle('2026-2 - Installation of Asphalt Roadways')).toEqual({ number: '2026-2', name: 'Installation of Asphalt Roadways' });
    const d = rowToDraft(byTitle(p.rows, '20685'), PLACER);
    expect(d).toMatchObject({
      source: 'bidsandtenders', sourceId: 'placer:9ed85400-0ba9-4833-aaa9-83cb61299f19', sourceName: 'Placer County (bids&tenders)',
      title: 'Wastewater, Water & Solid Waste Systems Consulting Services', agency: 'Placer County', solNumber: '20685',
      dueAt: '2026-10-06T00:00:00.000Z', location: { county: 'Placer', state: 'CA' },
      url: 'https://placer.bidsandtenders.net/Module/Tenders/en/Tender/Detail/9ed85400-0ba9-4833-aaa9-83cb61299f19',
    });
    expect(detailUrl(PLACER, 'x')).toBe('https://placer.bidsandtenders.net/Module/Tenders/en/Tender/Detail/x');
  });

  it('a Placer town the gazetteer knows places the card there; otherwise the one-county area, no point', () => {
    const kings = finalizeBid(rowToDraft(byTitle(p.rows, '20692'), PLACER)).location;
    expect(kings).toMatchObject({ city: 'Kings Beach', county: 'Placer', state: 'CA', precision: 'city', label: 'Kings Beach, CA' });
    expect(kings.lat).not.toBeNull();
    for (const start of ['20685', '20684', '20646', '20678', '20673']) {
      const loc = finalizeBid(rowToDraft(byTitle(p.rows, start), PLACER)).location;
      expect(loc, start).toEqual({
        city: null, county: 'Placer', state: 'CA', zip: null, lat: null, lng: null, precision: 'region', label: 'Placer County, CA (site not named)',
      });
      expect(areaCounties(loc)).toEqual(['Placer']);
    }
  });

  it('a Placer town the listing names (not in the gazetteer) places the card there, at the ZIP table\'s point', () => {
    const foresthill = finalizeBid(rowToDraft(byTitle(p.rows, '20676'), PLACER)).location; // "Foresthill Divide …"
    expect(foresthill).toMatchObject({ city: 'Foresthill', state: 'CA', precision: 'city', label: 'Foresthill, CA' });
    expect(foresthill.lat).toBe(lookupCity('Foresthill', 'CA')!.lat);
    // the real Roseville row (2026-2, left out of the fixture for its e-mail addresses): its address line, verbatim
    expect(townInText('Location of Work: Roseville Public Cemetery District, 421 Berry Street, Roseville, CA 95678', PLACER.towns)).toBe('Roseville');
  });

  it('a street named after a town, or two towns, leave the card the county area', () => {
    expect(townInText('TEST sidewalk repair on Lincoln Way', PLACER.towns)).toBeNull();
    expect(townInText('Olympic Valley Road Snow Removal', PLACER.towns)).toBeNull();
    expect(townInText('TEST hauling from Rocklin to Foresthill', PLACER.towns)).toBeNull();
    expect(townInText('TEST paving in Granite Bay; bids at Granite Bay Road', PLACER.towns)).toBe('Granite Bay');
    expect(townInText('TEST nothing named', PLACER.towns)).toBeNull();
  });
});

// ---------------------------------------------------------------------------- fetch() --

interface Call { method: string; url: string; body?: string; headers?: Record<string, string> }

/** A fake session: the GET answers `page`, each POST the next of `posts` (a JSON string, or an Error to throw). */
function board(posts: Array<string | Error>, opts: { page?: string; cookies?: string[]; session?: boolean; deadline?: Date } = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const partial: string[] = [];
  let sessions = 0;
  const text = async (url: string, init?: RequestInit): Promise<string> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: init?.body as string | undefined, headers: init?.headers as Record<string, string> | undefined });
    if (method === 'GET') return opts.page ?? listWith();
    const next = posts.shift();
    if (next === undefined) throw new Error('TEST: no more answers');
    if (next instanceof Error) throw next;
    return next;
  };
  const http: FetchLike = { text, json: async () => { throw new Error('TEST: json not used'); } };
  const cookies = opts.cookies ?? ['Suite.Web.SecurityProvider.Customer_PRD_NET', '__RequestVerificationToken_L01vZHVsZS9UZW5kZXJz0'];
  const withSession: FetchLike = { ...http, session: () => { sessions++; return { ...http, cookieNames: () => cookies }; } };
  const ctx: SourceContext = {
    http: opts.session === false ? http : withSession, now: new Date('2026-11-14T18:30:00Z'), env: () => undefined,
    log: (m) => logs.push(m), partial: (m) => partial.push(m), ...(opts.deadline ? { deadline: opts.deadline } : {}),
  };
  return { ctx, calls, logs, partial, sessions: () => sessions };
}

/** TEST variation of the real answer: its rows marked Open, cut into pages, `total` as given. */
function openPage(rows: BidsAndTendersRaw[], total: number): string {
  return JSON.stringify({ success: true, data: rows.map((r) => ({ ...r, Status: 'Open' })), total });
}

describe('fetch(): one session, GET then POST', () => {
  it('today: one GET, one POST with that page\'s token, 0 of 0 listed', async () => {
    const t = board([OPEN]);
    expect(await bidsAndTendersSource.fetch(t.ctx)).toEqual([]);
    expect(t.sessions()).toBe(1);
    expect(t.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(t.calls[0]!.url).toBe(LIST_URL);
    const post = t.calls[1]!;
    expect(post.url).toBe(`${LIST_URL}/Tender/Search/${NODE}?status=Open&limit=100&start=0&dir=ASC&from=&to=&sort=DateClosing%20ASC,Id`);
    expect(post.body).toBe('keywords=&__RequestVerificationToken=TEST-token-1');
    expect(post.headers).toMatchObject({ 'X-Requested-With': 'XMLHttpRequest', Referer: LIST_URL });
    expect(post.headers!['Content-Type']).toMatch(/^application\/x-www-form-urlencoded/);
    expect(t.logs).toEqual(['bidsandtenders Placer County: 0 of 0 listed (no open bids)']);
  });

  it('pages on while start + rows < total, with the same token; keeps Open trade work only', async () => {
    const rows = ALL.data;
    const t = board([openPage(rows.slice(0, 4), 7), openPage(rows.slice(4), 7)], { page: listWith('TEST-token-2') });
    const out = await bidsAndTendersSource.fetch(t.ctx);
    expect(t.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST']);
    expect(t.calls[2]!.url).toContain('&start=4&');
    expect(t.calls.slice(1).map((c) => c.body)).toEqual(Array(2).fill('keywords=&__RequestVerificationToken=TEST-token-2'));
    // Of the seven, only the Kings Beach snow removal is trade work (its "Benefit Assessment District" pays for it);
    // consulting, CM, psychiatric services, the EIR, the environmental compliance services and the cyber SOC are not.
    expect(out.map((d) => d.solNumber).sort()).toEqual(['20692']);
    expect(t.logs).toEqual([
      'bidsandtenders Placer County: 7 of 7 listed (pages 2), 1 kept, 6 left out as not trade work',
    ]);
  });

  it('keeps status Open only', async () => {
    const rows = ALL.data.map((r, i) => ({ ...r, Status: i < 2 ? 'Open' : i < 4 ? 'Planned' : 'Closed' }));
    const t = board([JSON.stringify({ success: true, data: rows, total: rows.length })]);
    const out = await bidsAndTendersSource.fetch(t.ctx);
    const open = rows.filter((r) => r.Status === 'Open').map((r) => `placer:${r.Id}`);
    expect(out.every((d) => open.includes(d.sourceId))).toBe(true);
    expect(t.logs[0]).toMatch(/^bidsandtenders Placer County: 7 of 7 listed, \d kept, 5 not open/);
  });

  it('never re-sends a POST: a failed first POST fails the source after exactly one', async () => {
    const t = board([new Error('TEST: HTTP 500')]);
    await expect(bidsAndTendersSource.fetch(t.ctx)).rejects.toThrow('TEST: HTTP 500');
    expect(t.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
  });

  it('a failed later POST keeps the pages read and says "— stopped"', async () => {
    const t = board([openPage(ALL.data.slice(0, 4), 7), new Error('TEST: timed out')]);
    const out = await bidsAndTendersSource.fetch(t.ctx);
    expect(t.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST']);
    expect(t.logs[0]).toMatch(/^bidsandtenders Placer County: 4 of 7 listed, \d kept, .* — stopped: rows from 4 failed \(TEST: timed out\)$/);
    expect(t.partial).toEqual(['bidsandtenders Placer County: stopped: rows from 4 failed (TEST: timed out), 4 of 7 read']);
  });

  it('a page answer that is not JSON or not a success fails the source (FAILED, never a quiet 0)', async () => {
    await expect(bidsAndTendersSource.fetch(board(['<html>TEST error page</html>']).ctx)).rejects.toThrow(/not JSON/);
    await expect(bidsAndTendersSource.fetch(board(['{"success":false}']).ctx)).rejects.toThrow(/success=false/);
  });

  it('sends no POST when the list page has no #NodeId, no token, or set no anti-forgery cookie', async () => {
    for (const page of [LIST.replace(/<input type="hidden" id="NodeId"[^>]*>/, ''), LIST.replace(/<div id="bidDetailAntiForgery">[\s\S]*?<\/div>/, '')]) {
      const t = board([OPEN], { page });
      await expect(bidsAndTendersSource.fetch(t.ctx)).rejects.toThrow();
      expect(t.calls.map((c) => c.method)).toEqual(['GET']);
    }
    const t = board([OPEN], { cookies: ['Suite.Web.SecurityProvider.Customer_PRD_NET'] });
    await expect(bidsAndTendersSource.fetch(t.ctx)).rejects.toThrow(/no anti-forgery cookie/);
    expect(t.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('needs a cookie session: without one, no request at all', async () => {
    const t = board([OPEN], { session: false });
    await expect(bidsAndTendersSource.fetch(t.ctx)).rejects.toThrow(/cookie session/);
    expect(t.calls).toEqual([]);
  });

  it('honours the time budget between pages', async () => {
    const t = board([openPage(ALL.data.slice(0, 4), 7), openPage(ALL.data.slice(4), 7)], { deadline: new Date(Date.now() - 1) });
    await bidsAndTendersSource.fetch(t.ctx);
    expect(t.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(t.logs[0]).toBe('bidsandtenders: stopped at the time budget, 4 of 7 read');
    expect(t.logs[1]).toMatch(/^bidsandtenders Placer County: 4 of 7 listed, .* — stopped at the time budget$/);
  });
});
