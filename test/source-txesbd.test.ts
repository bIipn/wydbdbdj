import { describe, expect, it } from 'vitest';
import { finalizeBid } from '../src/scan.js';
import {
  agencyPlace, checkTxesbdAnswer, parseTxesbd, splitNigp, TXESBD_REFERER, TXESBD_ROBOTS, TXESBD_URL, txAgencyName, txesbdBody,
  txesbdSource, type TxesbdAnswer, type TxesbdLine,
} from '../src/sources/txesbd.js';
import type { FetchLike, SourceContext } from '../src/types.js';
import { CAPTURED, fx } from './helpers.js';

// The real first page of the "Posted" list, 2026-11-14 05:59 UTC, trimmed to 13 whole lines (test/fixtures/txesbd.md).
const PAGE: TxesbdAnswer = JSON.parse(fx('txesbd-page1.json'));

describe('parseTxesbd (real ESBD page)', () => {
  const parsed = parseTxesbd(PAGE);
  const by = (id: string) => parsed.bids.find((b) => b.sourceId === id)!;

  it('reads every line and leaves out what is not trade work (by title and NIGP codes)', () => {
    expect(PAGE.totalRecordsFound).toBe(501);
    expect(parsed.read).toBe(13);
    expect(parsed.notTrade).toBe(3);
    expect(parsed.bids.map((b) => b.sourceId)).not.toEqual(expect.arrayContaining(['HHS0018130'])); // linen laundry
    expect(parsed.bids.some((b) => b.sourceId === '302-27-256842')).toBe(false); // workstations
    expect(parsed.bids.some((b) => b.sourceId === 'IFB2027-B03')).toBe(false); // dumpsters
  });

  it('one line, fully checked: the TxDOT salt shed (NIGP 90925, an addendum, an outside bidding site)', () => {
    expect(by('241859-26-02')).toMatchObject({
      source: 'txesbd',
      sourceId: '241859-26-02',
      sourceName: 'Texas ESBD (State Business Daily)',
      title: 'Sierra Blanca Maintenance Facility Fabric Salt Shed, El Paso District',
      agency: 'Texas Department of Transportation',
      description: 'Texas Department of Transportation · Solicitation 241859-26-02 · Addendum Posted · ' +
        'NIGP 90925-Building Construction, Prefabricated (All Types) · Responses through the agency\'s site: txdot.bonfirehub.com',
      category: 'Building Construction, Prefabricated (All Types)',
      location: { state: 'TX' },
      postedAt: '2026-10-15T05:00:00.000Z', // 10/15/2026, start of the day, CDT
      dueAt: '2026-12-02T18:00:00.000Z', // 12/2/2026 12:00 PM CST
      url: 'https://www.txsmartbuy.gov/esbddetails/view/241859-26-02',
      solNumber: '241859-26-02',
    });
  });

  it('times are Central wall clock (CDT and CST), a date alone is the end of the day', () => {
    expect(by('CSP754MitteHVACRenovation-2026').dueAt).toBe('2026-11-20T21:00:00.000Z'); // 11/20/2026 3:00 PM CST
    expect(by('743-2026-RFQ-1540').dueAt).toBe('2026-12-15T20:30:00.000Z'); // 2:30 PM CST
    const line = PAGE.lines.find((l) => l.solicitationId === '241859-26-02')!;
    const noTime = parseTxesbd({ ...PAGE, lines: [{ ...line, responseTime: '' }] }).bids[0]!;
    expect(noTime.dueAt).toBe('2026-12-03T05:59:00.000Z'); // 12/2/2026 23:59 CST
    const late = parseTxesbd({ ...PAGE, lines: [{ ...line, responseTime: '10:30 PM' }] }).bids[0]!;
    expect(late.dueAt).toBe('2026-12-03T04:30:00.000Z');
  });

  it('places local governments by their own name, only through the ZIP table; state agencies stay TX', () => {
    expect(finalizeBid(by('743-2026-RFQ-1540')).location).toMatchObject({ city: 'San Antonio', state: 'TX', precision: 'city' });
    // "University of Houston": a university's name is not where it is ("University of Dallas" is in Irving): TX only
    expect(finalizeBid(by('RFPCSP-730-UofH-3160')).location).toMatchObject({ city: null, state: 'TX', precision: 'state' });
    expect(finalizeBid(by('241859-26-02')).location).toMatchObject({ city: null, state: 'TX', precision: 'state', lat: null });
    expect(agencyPlace('City of Austin', 'TX')).toEqual({ city: 'Austin', state: 'TX' });
    // a district or college name is not a place (Alamo Colleges are in San Antonio, London ISD near Corpus Christi)
    expect(agencyPlace('Abilene ISD', 'TX')).toEqual({ state: 'TX' });
    expect(agencyPlace('Alamo Community College District', 'TX')).toEqual({ state: 'TX' });
    expect(agencyPlace('LONDON ISD', 'TX')).toEqual({ state: 'TX' });
    expect(agencyPlace('Hays County', 'TX')).toEqual({ county: 'Hays', state: 'TX', label: 'Hays County, TX' });
    expect(agencyPlace('Concho Valley Council Of Governments', 'TX')).toEqual({ state: 'TX' });
    expect(agencyPlace('Fort Bend ISD', 'TX')).toEqual({ state: 'TX' }); // no such town: no guess
    expect(agencyPlace('University Of Texas System', 'TX')).toEqual({ state: 'TX' });
  });

  it('agency names lose the ESBD number; NIGP codes are split and lose their "*"', () => {
    expect(txAgencyName('Health & Human Services Commission - 529')).toBe('Health & Human Services Commission');
    expect(txAgencyName('Hays County - C1050')).toBe('Hays County');
    expect(txAgencyName('Camino Real Community Services- R0070')).toBe('Camino Real Community Services');
    expect(txAgencyName('Office Of The Attorney General')).toBe('Office Of The Attorney General');
    expect(splitNigp('20448-*Keyboards;\n20496-*Workstations: Sparc, Risc, Etc.')).toEqual(['20448-Keyboards', '20496-Workstations: Sparc, Risc, Etc.']);
    expect(splitNigp('90925-Building Construction, Prefabricated (All Types)')).toEqual(['90925-Building Construction, Prefabricated (All Types)']);
    expect(splitNigp('')).toEqual([]);
  });

  it('throws on an answer that is not the one we know', () => {
    expect(() => checkTxesbdAnswer([])).toThrow(/not the/);
    expect(() => checkTxesbdAnswer({ error: 'x' })).toThrow(/not the/);
    expect(checkTxesbdAnswer(PAGE).lines).toHaveLength(13);
  });
});

// ------------------------------------------------------------------- fetch() --

/** A fake ESBD: answers each (status, page) from a table of REAL lines, re-paged; records every request. */
function fakeEsbd(pages: Record<string, TxesbdLine[][]>, per: number, total: Record<string, number>, raw?: string) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const http: FetchLike = {
    async text(url, init) {
      calls.push({ url, init });
      if (raw) return raw;
      const body = JSON.parse(String(init?.body)) as { page: number; status: string };
      const lines = pages[body.status]?.[body.page - 1] ?? [];
      return JSON.stringify({ agencies: [], lines, page: body.page, recordsPerPage: per, totalRecordsFound: total[body.status] ?? 0 });
    },
    async json() { throw new Error('not used'); },
  };
  const logs: string[] = [];
  const ctx: SourceContext = { http, now: CAPTURED, env: () => undefined, log: (m) => logs.push(m) };
  return { ctx, calls, logs };
}

describe('txesbdSource', () => {
  const L = PAGE.lines;

  it('is switched off: robots.txt disallows every automated client', () => {
    expect(txesbdSource.disabledReason?.({} as SourceContext)).toBe(TXESBD_ROBOTS);
    expect(TXESBD_ROBOTS).toMatch(/Disallow: \//);
  });

  it('posts the body the ESBD page sends, pages status 1 to the end, then status 6 until nothing is new', async () => {
    const s1 = [L.slice(0, 5), L.slice(5, 10), L.slice(10)];
    const s6 = [L.filter((l) => l.status === '6').slice(0, 5), L.filter((l) => l.status === '6').slice(5)];
    const { ctx, calls, logs } = fakeEsbd({ '1': s1, '6': s6 }, 5, { '1': 13, '6': 9 });
    const bids = await txesbdSource.fetch(ctx);
    expect(calls.map((c) => JSON.parse(String(c.init!.body)))).toEqual([
      { lines: [], page: 1, urlRoot: 'esbd', status: '1' },
      { lines: [], page: 2, urlRoot: 'esbd', status: '1' },
      { lines: [], page: 3, urlRoot: 'esbd', status: '1' },
      { lines: [], page: 1, urlRoot: 'esbd', status: '6' }, // all seen already: stop
    ]);
    expect(calls[0]!.url).toBe(TXESBD_URL);
    expect(calls[0]!.init).toMatchObject({ method: 'POST', headers: { Referer: TXESBD_REFERER, 'Content-Type': 'application/json; charset=UTF-8' } });
    expect(txesbdBody(2, '6')).toBe('{"lines":[],"page":2,"urlRoot":"esbd","status":"6"}');
    expect(bids).toHaveLength(10);
    expect(new Set(bids.map((b) => b.sourceId)).size).toBe(10);
    expect(logs.at(-1)).toBe('txesbd: 13 solicitations read in 4 requests, 10 kept, 3 left out as not trade work');
  });

  it('reads status 6 lines that status 1 did not list', async () => {
    const extra = { ...L[0]!, solicitationId: 'TEST-ONLY-6', title: 'TEST- Roof replacement (synthetic)', status: '6' };
    const { ctx } = fakeEsbd({ '1': [L.slice(0, 3)], '6': [[extra]] }, 24, { '1': 3, '6': 1 });
    const bids = await txesbdSource.fetch(ctx);
    expect(bids.map((b) => b.sourceId)).toContain('TEST-ONLY-6');
  });

  it('stops at the time budget between pages, loudly', async () => {
    const { ctx, calls, logs } = fakeEsbd({ '1': [L.slice(0, 5), L.slice(5, 10)] }, 5, { '1': 501 });
    let why = '';
    const bids = await txesbdSource.fetch({ ...ctx, deadline: new Date(Date.now() - 1), partial: (w) => { why = w; } });
    expect(calls).toHaveLength(1);
    expect(bids.length).toBeGreaterThan(0);
    expect(why).toBe('txesbd: stopped at the time budget, 5 of 501 read');
    expect(logs).toContain(why);
  });

  it('FAILS on HTML, on an empty list that announces lines, and on lines with no ids', async () => {
    await expect(txesbdSource.fetch(fakeEsbd({}, 24, {}, '<!DOCTYPE html><html>challenge</html>').ctx)).rejects.toThrow(/HTML page/);
    await expect(txesbdSource.fetch(fakeEsbd({ '1': [[]] }, 24, { '1': 501 }).ctx)).rejects.toThrow(/announces 501 lines but lists none/);
    const bare = L.map((l) => ({ ...l, solicitationId: null }));
    await expect(txesbdSource.fetch(fakeEsbd({ '1': [bare] }, 24, { '1': 13 }).ctx)).rejects.toThrow(/none has a solicitation id/);
  });
});
