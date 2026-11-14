import { describe, expect, it } from 'vitest';
import { finalizeBid } from '../src/scan.js';
import {
  checkFlmfmpAnswer, FLMFMP_PAGE_SIZE, FLMFMP_URL, flmfmpBody, flmfmpSource, isFlmfmpSolicitation, parseFlmfmp, type FlmfmpRow,
} from '../src/sources/flmfmp.js';
import type { FetchLike, SourceContext } from '../src/types.js';
import { CAPTURED, fx } from './helpers.js';

// Real pages of open ads, 2026-11-14 (05:59 and 06:41 UTC), trimmed to whole ads (test/fixtures/flmfmp.md).
const P1: FlmfmpRow[] = JSON.parse(fx('flmfmp-bids-page1.json'));
const P2: FlmfmpRow[] = JSON.parse(fx('flmfmp-bids-page2.json'));

describe('parseFlmfmp (real MFMP pages)', () => {
  const one = parseFlmfmp(P1);
  const two = parseFlmfmp(P2);
  const by = (id: number) => [...one.bids, ...two.bids].find((b) => b.sourceId === String(id))!;

  it('keeps solicitation types only and counts the rest by type', () => {
    expect(one.read).toBe(17);
    expect(one.notSolicitation).toEqual({ 'Agency Decision': 2, 'Grant Opportunities': 1, 'Informational Notice': 1, 'Request for Information': 1 });
    expect(two.read).toBe(7);
    expect(two.notSolicitation).toEqual({ 'Single Source': 3 });
    // An award notice for a trade job is still not a bid: "St Pete Campus Fire Alarm Replacement" (Agency Decision).
    expect(by(17465)).toBeUndefined();
  });

  it('then leaves out what is not trade work', () => {
    expect(one.notTrade).toBe(2); // Citrus CHD Janitorial Services; Continuing A/E Services
    expect(by(17277)).toBeUndefined();
    expect(two.notTrade).toBe(2); // two A/E qualifications
    expect(by(17256)!.title).toMatch(/Construction Management Services/); // a qualifications ad that is construction
    expect(one.bids).toHaveLength(10);
    expect(two.bids).toHaveLength(2);
  });

  it('one ad, fully checked: electrical maintenance and repair (FDC)', () => {
    expect(by(16428)).toMatchObject({
      source: 'flmfmp',
      sourceId: '16428',
      sourceName: 'MyFloridaMarketPlace (State of Florida)',
      title: 'Electrical Maintenenace and Repair Services',
      category: 'Invitation to Bid',
      location: { state: 'FL' },
      dueAt: '2027-04-30T18:00:00.000Z',
      url: 'https://vendor.myfloridamarketplace.com/search/bids/detail/16428',
      solNumber: 'ITB-26-088',
    });
    expect(by(16428).description).toMatch(/^.+ · Invitation to Bid · No\. ITB-26-088 · /);
  });

  it('close times are the API\'s own instants (Eastern 5 PM, 11 PM, 11:59 PM; the Central panhandle needs nothing)', () => {
    expect(by(14026).dueAt).toBe('2026-12-31T22:00:00.000Z'); // 5:00 PM EST
    expect(by(17147).dueAt).toBe('2026-12-02T04:00:00.000Z'); // 11:00 PM EST on Dec 1
    expect(by(16853).dueAt).toBe('2027-01-30T04:59:00.000Z');
    expect(by(17297)).toMatchObject({ title: '224003 Chipley REVAMP', dueAt: '2026-12-17T20:00:00.000Z', solNumber: null });
    expect(by(14026).postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('places a town from its own name, nothing else', () => {
    expect(finalizeBid(by(17339)).location).toMatchObject({ city: 'Orange Park', state: 'FL', precision: 'city' });
    // A county named in the title is not a place for us: "…for Miami-Dade County Health Dept" stays FL.
    expect(finalizeBid(by(17125)).location).toMatchObject({ city: null, state: 'FL', precision: 'state' });
  });

  it('type rules for names never seen', () => {
    expect(isFlmfmpSolicitation('Invitation to Bid')).toBe(true);
    expect(isFlmfmpSolicitation('Request for Quotes')).toBe(true);
    expect(isFlmfmpSolicitation('Single Source')).toBe(false);
    expect(isFlmfmpSolicitation('Public Meeting Notice')).toBe(false);
    expect(isFlmfmpSolicitation('Request for Information')).toBe(false);
  });

  it('throws on an answer that is not the list we know', () => {
    expect(() => checkFlmfmpAnswer({ content: [] }, 1)).toThrow(/not the JSON array/);
    expect(() => checkFlmfmpAnswer([{ id: 1, name: 'x' }], 1)).toThrow(/none with an advertisementId/);
    expect(checkFlmfmpAnswer(P1, 1)).toHaveLength(17);
  });
});

// ------------------------------------------------------------------- fetch() --

function fakeMfmp(pages: unknown[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const http: FetchLike = {
    async text() { throw new Error('not used'); },
    async json<T>(url: string, init?: RequestInit) {
      calls.push({ url, init });
      const page = (JSON.parse(String(init?.body)) as { page: number }).page;
      const p = pages[page - 1] ?? [];
      if (p instanceof Error) throw p;
      return p as T;
    },
  };
  const logs: string[] = [];
  const ctx: SourceContext = { http, now: CAPTURED, env: () => undefined, log: (m) => logs.push(m) };
  return { ctx, calls, logs };
}

/** A full page of REAL ads (the 17 of page 1, repeated with TEST- ids to reach the page size). */
const FULL: FlmfmpRow[] = Array.from({ length: FLMFMP_PAGE_SIZE }, (_, i) =>
  i < P1.length ? P1[i]! : { ...P1[i % P1.length]!, advertisementId: 900000 + i, title: `${P1[i % P1.length]!.title} (TEST- copy)` });

describe('flmfmpSource', () => {
  it('asks for JSON with the board\'s body and pages until a short page', async () => {
    const { ctx, calls, logs } = fakeMfmp([FULL, P2]);
    const bids = await flmfmpSource.fetch(ctx);
    expect(calls.map((c) => c.init!.body)).toEqual([flmfmpBody(1), flmfmpBody(2)]);
    expect(flmfmpBody(1)).toBe('{"status":["OPEN"],"page":1,"pageSize":100}');
    expect(calls[0]!.url).toBe(FLMFMP_URL);
    expect(calls[0]!.init).toMatchObject({ method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' } });
    expect(bids.length).toBeGreaterThan(0);
    expect(logs.at(-1)).toMatch(/^flmfmp: 107 open ads read in 2 pages, \d+ kept, \d+ left out by type \(.*Single Source.*\), \d+ left out as not trade work$/);
  });

  it('FAILS on HTML (http.json throws), a non-array, or an empty first page', async () => {
    await expect(flmfmpSource.fetch(fakeMfmp([new Error('Expected JSON from … but got: <!DOCTYPE html>')]).ctx)).rejects.toThrow(/Expected JSON/);
    await expect(flmfmpSource.fetch(fakeMfmp([{ error: 'x' }]).ctx)).rejects.toThrow(/not the JSON array/);
    await expect(flmfmpSource.fetch(fakeMfmp([[]]).ctx)).rejects.toThrow(/first page lists no open ads/);
  });

  it('stops at the time budget between pages, loudly', async () => {
    const { ctx, calls } = fakeMfmp([FULL, P2]);
    let why = '';
    await flmfmpSource.fetch({ ...ctx, deadline: new Date(Date.now() - 1), partial: (w) => { why = w; } });
    expect(calls).toHaveLength(1);
    expect(why).toBe('flmfmp: stopped at the time budget, 100 of ? ads read');
  });
});
