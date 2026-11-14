import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeBid } from '../src/scan.js';
import {
  CALEPROCURE_GRID_URL, CALEPROCURE_REFERER, caleprocureSource, checkCaleprocurePage, parseCaleprocureEnd, parseCaleprocurePage,
} from '../src/sources/caleprocure.js';
import { FLAGS } from '../src/sources/flags.js';
import type { FetchLike, SourceContext } from '../src/types.js';
import { createHttp } from '../src/util/http.js';
import { CAPTURED, fx } from './helpers.js';

// The real grid captured 2026-11-14 05:59 UTC, trimmed to 68 whole rows (test/fixtures/caleprocure-grid.md).
const RAW = fx('caleprocure-grid.html');
// The trimmed file still announces all 376 events of the capture; a page that holds every row it announces:
const WHOLE = RAW.replace('1-376 of 376', '1-68 of 68');

describe('parseCaleprocurePage (real grid)', () => {
  const page = parseCaleprocurePage(RAW);

  it('reads every row by its element ids, and the board counter', () => {
    expect(page.rows).toBe(68);
    expect(page.bids).toHaveLength(68);
    expect(page.total).toBe(376);
    expect(page.signIn).toBe(false);
  });

  it('one event, fully checked: DGS electrical work at Napa State Hospital', () => {
    const b = page.bids.find((x) => x.solNumber === '0000040420')!;
    expect(b).toMatchObject({
      source: 'caleprocure',
      sourceId: '7760-0000040420',
      sourceName: 'Cal eProcure (State of California)',
      title: 'CONTRACT NUMBER: 26-334792; AUGMENTATION OF ELECTRICAL SERVICE CAPACITY, DEPARTMENT OF STATE HOSPITALS, ' +
        'NAPA STATE HOSPITAL, NAPA, NAPA COUNTY, CALIFORNIA, PROJECT NUMBER: 14109',
      agency: 'Department of General Services',
      description: 'Department of General Services (department 7760) · Event 0000040420 · RFx',
      category: 'State solicitation',
      location: { state: 'CA' },
      dueAt: '2026-11-18T22:00:00.000Z', // "11/18/2026&nbsp; 2:00PM PST"
      url: 'https://caleprocure.ca.gov/event/7760/0000040420',
      flags: [],
    });
  });

  it('keeps the board text whole: HTML entities decoded, &nbsp; gone, the board\'s own "¿" left as it is', () => {
    expect(page.bids[0]!.title).toBe('UCLA Center for Health Sciences Fire Sprinkler Retrofit | School of Medicine,(5th & 6th floor) No. 906032');
    expect(page.bids.find((b) => b.solNumber === '0000039767')!.title).toBe('Homeless Data Integration System - Maintenance and Operations (HDIS - M&O)');
    expect(page.bids.find((b) => b.solNumber === '10221501')!.title).toBe('Dam Safety Engineering Services ¿ Southern California');
  });

  it('end times use the zone the board writes (PST and PDT)', () => {
    expect(page.bids[0]!.dueAt).toBe('2026-11-16T18:00:00.000Z'); // 11/16/2026 10:00AM PST
    expect(page.bids.find((b) => b.solNumber === '0000040916')!.dueAt).toBe('2026-11-18T07:59:00.000Z'); // 11:59PM PST
    expect(page.bids.find((b) => b.solNumber === '0000040483')!.dueAt).toBe('2027-04-03T00:00:00.000Z'); // 04/02/2027 5:00PM PDT
    expect(parseCaleprocureEnd('10/07/2026  1:00PM PDT')).toBe('2026-10-07T20:00:00.000Z');
    // The zone name is trusted even when Los Angeles would say otherwise that day.
    expect(parseCaleprocureEnd('07/01/2026 12:00PM PST')).toBe('2026-07-01T20:00:00.000Z');
    // No zone written (never seen): the board's wall clock, Pacific.
    expect(parseCaleprocureEnd('12/01/2026 9:00AM')).toBe('2026-12-01T17:00:00.000Z');
    expect(parseCaleprocureEnd('')).toBeNull();
  });

  it('event ids are not all numbers (Caltrans "10-1H0204"): the department + id pair is the key, the link uses both', () => {
    const b = page.bids.find((x) => x.solNumber === '10-1H0204')!;
    expect(b.sourceId).toBe('2660-10-1H0204');
    expect(b.url).toBe('https://caleprocure.ca.gov/event/2660/10-1H0204');
    expect(new Set(page.bids.map((x) => x.sourceId)).size).toBe(68);
  });

  it('RFI format: the "info only" flag only when the name also says it asks for information', () => {
    const ucla = page.bids[0]!; // format RFI, but a fire sprinkler retrofit with a project number
    expect(ucla.flags).toEqual([]);
    expect(ucla.category).toBe('State solicitation');
    expect(ucla.description).toContain('RFx RFI');
    for (const id of ['0000040916', '0000040924']) {
      const b = page.bids.find((x) => x.solNumber === id)!;
      expect(b.flags).toEqual([FLAGS.rfi]);
      expect(b.category).toBe('State request for information');
    }
  });

  it('place: by the title, department and event id (src/geo/caleprocure-place.ts), never a bare word', () => {
    // "Sacramento Okinawa FMS-22": the word Sacramento with nothing to back it is not a place.
    const okinawa = finalizeBid(page.bids.find((b) => b.solNumber === '0000040809')!);
    expect(okinawa.location).toMatchObject({ city: null, state: 'CA', lat: null, lng: null, precision: 'state' });
    // "…, NAPA STATE HOSPITAL, NAPA, NAPA COUNTY, CALIFORNIA": the town, backed by its county.
    const napa = finalizeBid(page.bids.find((b) => b.solNumber === '0000040420')!);
    expect(napa.location).toMatchObject({ city: 'Napa', county: 'Napa', state: 'CA', precision: 'city', label: 'Napa, CA' });
    // A Caltrans construction ad: the district in its event id, an area with no point.
    const d10 = finalizeBid(page.bids.find((b) => b.solNumber === '10-1H0204')!);
    expect(d10.location).toMatchObject({ precision: 'region', lat: null, lng: null, label: 'Caltrans District 10: Alpine, Amador, Calaveras + 5 more counties' });
  });
});

describe('checkCaleprocurePage: loud, never a quiet 0', () => {
  it('passes the real grid that holds all its rows', () => {
    expect(() => checkCaleprocurePage(parseCaleprocurePage(WHOLE))).not.toThrow();
  });
  it('fails when the board announces more events than the page holds', () => {
    expect(() => checkCaleprocurePage(parseCaleprocurePage(RAW))).toThrow(/announces 376 events but the page holds 68 rows/);
  });
  it('fails on a page with no event rows', () => {
    const empty = WHOLE.replace(/AUC_ID_COL\$/g, 'XX_COL$');
    expect(() => checkCaleprocurePage(parseCaleprocurePage(empty))).toThrow(/no event rows/);
  });
  it('fails on rows it cannot read', () => {
    const broken = WHOLE.replace(/RESP_INQA1_WK_ZZ_AUC_NAME\$/g, 'RENAMED$');
    expect(() => checkCaleprocurePage(parseCaleprocurePage(broken))).toThrow(/68 event rows but none could be read/);
  });
  it('fails on the PeopleSoft sign-in page (TEST markup, synthetic)', () => {
    const signIn = '<html><head><title>Oracle PeopleSoft Sign-in</title></head><body><form name="login"><input name="userid"><input type="password" name="pwd"></form></body></html>';
    expect(() => checkCaleprocurePage(parseCaleprocurePage(signIn))).toThrow(/sign-in page/);
  });
});

describe('caleprocureSource.fetch', () => {
  function ctxFor(html: string) {
    const calls: Array<{ url: string; init?: RequestInit; session: boolean }> = [];
    const logs: string[] = [];
    const make = (session: boolean): FetchLike => ({
      text: async (url, init) => {
        calls.push({ url, init, session });
        return html;
      },
      json: async () => ({}) as never,
      session: () => make(true),
    });
    const ctx: SourceContext = { http: make(false), now: CAPTURED, env: () => undefined, log: (m) => logs.push(m) };
    return { ctx, calls, logs };
  }

  it('one GET through a cookie session with the Referer; leaves out non-trade events and says how many', async () => {
    const { ctx, calls, logs } = ctxFor(WHOLE);
    const bids = await caleprocureSource.fetch(ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: CALEPROCURE_GRID_URL, session: true });
    expect((calls[0]!.init?.headers as Record<string, string>).Referer).toBe(CALEPROCURE_REFERER);
    const titles = bids.map((b) => b.title);
    expect(titles).toContain('IFB 9CA07882 - Underground Electrical Power Infrastructure Installation');
    expect(titles).toContain('Curb ramp, CRCP, JPCP, HMA, electrical, erosion control, and planting.');
    expect(titles).not.toContain('C5613445-D American Sign Language (ASL) In-Person Interpreting (IPI) Services');
    expect(titles).not.toContain('79050750-Telesign Service Platform');
    expect(titles).not.toContain('Dam Safety Engineering Services ¿ Southern California');
    expect(logs).toEqual([`caleprocure: 68 events read (board lists 68), ${bids.length} kept, ${68 - bids.length} left out as not trade work`]);
  });

  it('throws (FAILED in the report) on a page that is not the grid', async () => {
    await expect(caleprocureSource.fetch(ctxFor('<html><body>Request Rejected</body></html>').ctx)).rejects.toThrow(/no event rows/);
  });
});

// The live board (checked 2026-11-14): the grid URL answers 302 + Set-Cookie (its PeopleSoft session), and the same URL
// plus "&" without that cookie is the sign-in page. A session therefore follows redirects by hand, cookies included
// (src/util/http.ts). Global fetch is stubbed: no network; TEST cookie values.
describe('createHttp().session() follows a redirect with the cookies it set', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('302 + Set-Cookie, then the target with that cookie; the plain helper still lets fetch follow', async () => {
    const sent: Array<{ url: string; cookie: string | null; referer: string | null; redirect?: string; method: string }> = [];
    let n = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const h = new Headers(init.headers);
      sent.push({ url, cookie: h.get('cookie'), referer: h.get('referer'), redirect: init.redirect, method: init.method ?? 'GET' });
      if (++n === 1) {
        const headers = new Headers({ Location: `${CALEPROCURE_GRID_URL}&` });
        headers.append('Set-Cookie', 'TEST-PSJSESSIONID=test-1; path=/; HttpOnly');
        return new Response('<html>302 Moved Temporarily</html>', { status: 302, headers });
      }
      return new Response(WHOLE, { status: 200 });
    });
    const http = createHttp({ userAgent: 'BidSwipe-test', perHostDelayMs: 0, retries: 0 });
    const bids = await caleprocureSource.fetch({ http, now: CAPTURED, env: () => undefined, log: () => {} });
    expect(bids.length).toBeGreaterThan(0);
    expect(sent).toEqual([
      { url: CALEPROCURE_GRID_URL, cookie: null, referer: CALEPROCURE_REFERER, redirect: 'manual', method: 'GET' },
      { url: `${CALEPROCURE_GRID_URL}&`, cookie: 'TEST-PSJSESSIONID=test-1', referer: CALEPROCURE_REFERER, redirect: 'manual', method: 'GET' },
    ]);

    sent.length = 0;
    await http.text('https://a.example/list');
    expect(sent[0]!.redirect).toBe('follow');
  });

  it('a 303 after a POST goes on as a GET; a loop stops after five hops', async () => {
    const sent: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit = {}) => {
      sent.push({ method: init.method ?? 'GET', body: init.body });
      return sent.length === 1
        ? new Response('', { status: 303, headers: { Location: '/done' } })
        : new Response('ok', { status: 200 });
    });
    const session = createHttp({ userAgent: 'BidSwipe-test', perHostDelayMs: 0, retries: 0 }).session!();
    expect(await session.text('https://a.example/form', { method: 'POST', body: 'x=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).toBe('ok');
    expect(sent).toEqual([{ method: 'POST', body: 'x=1' }, { method: 'GET', body: undefined }]);

    vi.stubGlobal('fetch', async () => new Response('', { status: 302, headers: { Location: '/again' } }));
    await expect(session.text('https://a.example/loop')).rejects.toThrow(/Too many redirects/);
  });
});
