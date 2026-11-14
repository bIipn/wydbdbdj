/**
 * SAM.gov's daily bulk file (src/sources/samgov-bulk.ts) on REAL bytes: test/fixtures/samgov-bulk-sample.csv is
 * the header and 82 whole rows cut, byte for byte, from the file of 2026-11-13 (Last-Modified 04:30:18 UTC).
 * Anything made up here is a TEST- row and says so.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finalizeBid } from '../src/scan.js';
import {
  BULK_COLUMNS, CsvSplitter, decodeField, fetchSamBulk, isTradeNaics, LIVE_MIN_ROWS, parseSamBulk, SAM_BULK_URL, SamBulkParser,
  STALE_AFTER_DAYS,
} from '../src/sources/samgov-bulk.js';
import { FLAGS } from '../src/sources/flags.js';
import { parseSamResponse, samgovSource, type SamResponse } from '../src/sources/samgov.js';
import type { BidDraft, FetchLike, SourceContext } from '../src/types.js';
import { createHttp } from '../src/util/http.js';
import { CAPTURED, fx } from './helpers.js';

const RAW = new Uint8Array(readFileSync(new URL('./fixtures/samgov-bulk-sample.csv', import.meta.url)));
const td = new TextDecoder('windows-1252');
const HEADER_END = RAW.indexOf(0x0a) + 1;
const HEADER = td.decode(RAW.subarray(0, HEADER_END));

/** Feed `bytes` to a parser in pieces of the given sizes (cycled), as a slow network would. */
function parseInPieces(bytes: Uint8Array, sizes: number[], now?: Date): BidDraft[] {
  const p = new SamBulkParser(now ? { now } : {});
  for (let at = 0, k = 0; at < bytes.length; k++) {
    const n = sizes[k % sizes.length]!;
    p.push(bytes.subarray(at, at + n));
    at += n;
  }
  return p.finish();
}

/** Every record of the sample as decoded text fields (header first). */
function records(bytes: Uint8Array = RAW): string[][] {
  const s = new CsvSplitter();
  return [...s.push(bytes), ...s.end()].map((r) => r.map(decodeField));
}

const enc = (s: string) => new TextEncoder().encode(s);
const id = (d: BidDraft) => `${d.source}:${d.sourceId}`;

describe('CSV bytes (RFC 4180)', () => {
  it('reads the 82 real rows, every one with the header’s 47 columns', () => {
    const recs = records();
    expect(recs[0]).toHaveLength(47);
    expect(recs[0]!.slice(0, 3)).toEqual(['NoticeId', 'Title', 'Sol#']);
    expect(recs.slice(1)).toHaveLength(82);
    for (const r of recs) expect(r).toHaveLength(47);
  });

  it('gives the same rows however the bytes are chunked (inside quotes, at "" pairs, at line ends)', () => {
    const whole = parseSamBulk(RAW).drafts;
    expect(whole.length).toBeGreaterThan(20);
    for (const sizes of [[1, 2, 3, 5, 8, 13], [977], [65_536], [4096, 7, 333]]) {
      expect(parseInPieces(RAW, sizes)).toEqual(whole);
    }
    // Seeded random piece sizes, 1–600 bytes.
    let s = 7;
    const sizes = Array.from({ length: 997 }, () => ((s = (s * 48271) % 2147483647) % 600) + 1);
    expect(parseInPieces(RAW, sizes)).toEqual(whole);
  });

  it('keeps line breaks inside quoted fields (real rows: the place-of-performance address) and doubled quotes', () => {
    const recs = records();
    const street = recs[0]!.indexOf('PopStreetAddress');
    const multi = recs.slice(1).filter((r) => /\n/.test(r[street]!));
    expect(multi.length).toBeGreaterThanOrEqual(2);
    // TEST rows, made up: a doubled quote, a comma and a CRLF inside quotes, a CRLF line end.
    const made = enc('"a","b"\r\n"TEST ""quoted"", with a comma","line one\r\nline two"\r\n"",x\n');
    const s = new CsvSplitter();
    const out = [...s.push(made), ...s.end()].map((r) => r.map(decodeField));
    expect(out).toEqual([['a', 'b'], ['TEST "quoted", with a comma', 'line one\r\nline two'], ['', 'x']]);
  });

  it('decodes each field on its own: Windows-1252 (’ = 0x92) and the UTF-8 some rows carry (– = E2 80 93)', () => {
    expect(RAW.includes(0x92)).toBe(true);
    const recs = records();
    const desc = recs[0]!.indexOf('Description');
    const title = recs[0]!.indexOf('Title');
    expect(recs.some((r) => r[desc]!.includes('offeror’s proposal'))).toBe(true); // 0x92 in the raw bytes
    const utf8Title = recs.find((r) => r[title]!.includes('(MATOC) – National VA'));
    expect(utf8Title).toBeDefined(); // E2 80 93 read as one en dash, not "â€“"
    for (const r of recs) for (const f of r) expect(f).not.toMatch(/â€|Ã©|Â§/);
    // One real description mixes both in a field: a lone C2 byte (Windows-1252 "Â") and "§" as UTF-8 C2 A7.
    expect(recs.some((r) => r[desc]!.includes('Â B. Â Definitions Federal record as defined in 44 U.S.C. § 3301'))).toBe(true);
  });

  it('decodeField: UTF-8 when the whole field is UTF-8, byte by byte when it is not', () => {
    expect(decodeField(enc('TEST plain'))).toBe('TEST plain');
    expect(decodeField(enc('TEST § – é'))).toBe('TEST § – é');
    expect(decodeField(Uint8Array.from([0x54, 0x92, 0x73, 0x20, 0x96, 0x20, 0xe9]))).toBe('T’s – é'); // all Windows-1252
    expect(decodeField(Uint8Array.from([0x92, 0x20, 0xc2, 0xa7, 0x20, 0xc2]))).toBe('’ § Â'); // mixed
    expect(decodeField(Uint8Array.from([0xe2, 0x80]))).toBe('â€'); // a cut-off sequence is not UTF-8
  });
});

describe('which rows become cards', () => {
  const { drafts, stats } = parseSamBulk(RAW, { now: CAPTURED });
  const ids = new Set(drafts.map(id));

  it('counts what it left out, and why', () => {
    expect(stats).toMatchObject({
      bytes: RAW.length, rows: 82, active: 82, kept: 74, keptByPsc: 0, cards: drafts.length, placedAtOffice: 2, malformed: 0,
      dropped: { inactive: 0, type: 3, naics: 4, country: 2, noPlace: 0, pastDue: 9, noId: 0 },
    });
    // 34 before 2026-11-14; the 3 notices with no place of performance are now placed at their contracting office
    // (2 cards). The third, N6600126Q6298, says Camp Hansen, Okinawa in its text: abroad, never placed at its San Diego office.
    expect(drafts).toHaveLength(36);
  });

  it('award notices, justifications and sources-sought notices do not become cards', () => {
    expect(ids.has('samgov:W50S8C27PA001')).toBe(false); // Award Notice, 152 AW BLDG 56 HVAC Repair (Reno)
    expect(ids.has('samgov:DJA-27-AFIA-PR-0016')).toBe(false); // Justification
    expect(ids.has('samgov:ACQ-IHS-2027-U-0002')).toBe(false); // Sources Sought
  });

  it('only construction and trade NAICS codes: every catalog code and all of sector 23', () => {
    expect(isTradeNaics('238210')).toBe(true);
    expect(isTradeNaics('237120')).toBe(true); // sector 23, not in the catalog
    expect(isTradeNaics('561621')).toBe(true); // security systems: a catalog code outside 23
    expect(isTradeNaics('561730')).toBe(true); // landscaping
    expect(isTradeNaics('541511')).toBe(false);
    expect(ids.has('samgov:36C26127Q0162')).toBe(false); // NAICS 332410, "Boiler Plant Parts - Reno VAMC"
    expect(ids.has('samgov:F3G1EB6257AG01')).toBe(false); // NAICS 541511, mission planning software
  });

  it('only work in the US: a named foreign country is dropped; a blank country with a US state is kept', () => {
    expect(ids.has('samgov:19PK4027Q5002')).toBe(false); // Karachi, PK-SD, PAK
    const sparks = drafts.find((d) => d.sourceId === '127EAX27Q0009'); // no PopCountry on some notices of it
    expect(sparks).toBeUndefined(); // …and past due on the capture day, see below
    const wy = drafts.find((d) => d.sourceId === '140DWF27RL001')!; // Rawlins WY, no ZIP
    expect(wy.location).toMatchObject({ city: 'Rawlins', state: 'WY', zip: null });
    expect(finalizeBid(wy).location).toMatchObject({ state: 'WY', precision: 'city' });
  });

  it('a notice that names no place of performance is placed at its US contracting office, and says so', () => {
    // Noxious weed treatment, every Pop field blank; office: BIA Eastern Oklahoma Region, Muskogee OK 74402.
    const weed = drafts.find((d) => d.sourceId === '140A0827Q0010')!;
    expect(weed.location).toMatchObject({ city: 'Muskogee', state: 'OK', zip: '74402' });
    expect(weed.flags).toContain(FLAGS.placeFromOffice);
    expect(finalizeBid(weed).location).toMatchObject({
      state: 'OK', precision: 'city', label: 'Contracting office: Muskogee, OK (job site not named)',
    });
    // A card with a work site never carries the flag.
    for (const d of drafts) if (d.location?.label || (d.location?.city && !d.flags?.includes(FLAGS.placeFromOffice))) {
      expect(d.flags ?? []).not.toContain(FLAGS.placeFromOffice);
    }
  });

  it('notices already past due at `now` are left out; without `now` they are kept', () => {
    expect(ids.has('samgov:36C26126R0055')).toBe(false); // due 2026-11-02
    expect(parseSamBulk(RAW).drafts.some((d) => d.sourceId === '36C26126R0055')).toBe(true);
  });

  it('an inactive row is dropped (TEST row: the 2026-11-13 file holds only Active = "Yes" rows)', () => {
    const recs = records();
    const cols = recs[0]!;
    const row = cols.map((c) => (c === 'NoticeId' ? 'TEST-inactive' : c === 'Sol#' ? 'TEST-SOL-1' : c === 'Active' ? 'No'
      : c === 'Type' ? 'Solicitation' : c === 'NaicsCode' ? '238210' : c === 'PopState' ? 'NV' : c === 'PopZip' ? '89701' : ''));
    const csv = new Uint8Array([...RAW, ...enc(`${row.map((v) => `"${v}"`).join(',')}\n`)]);
    const r = parseSamBulk(csv);
    expect(r.stats).toMatchObject({ rows: 83, active: 82, dropped: { inactive: 1 } });
    expect(r.drafts.some((d) => d.sourceId === 'TEST-SOL-1')).toBe(false);
    // A file with rows and not one of them active is a changed file, not a quiet day.
    expect(() => parseSamBulk(enc(`${HEADER}${row.map((v) => `"${v}"`).join(',')}\n`))).toThrow(/none active/);
  });

  it('every deadline shape in the file goes through util/time.ts and comes out ISO UTC', () => {
    const all = parseSamBulk(RAW).drafts;
    const due = (sol: string) => all.find((d) => d.sourceId === sol)?.dueAt;
    expect(due('36C26127Q0067')).toBe('2026-11-20T20:00:00.000Z'); // "2026-11-20T12:00:00-08:00"
    expect(due('70ZL1927QELIZ0001')).toBe('2026-12-02T01:00:00.000Z'); // "2026-12-01": date only → 5 PM Pacific
    expect(due('N00167-27-SIMACQ-CD-89-0002')).toBe('2026-10-26T17:00:00.000Z'); // "2026-10-26T10:00:00": no offset → Pacific
    expect(due('36C77627R0003')).toBeNull(); // blank
    expect(stats.deadlineShapes).toEqual({
      'YYYY-MM-DDTDD:DD:DD-DD:DD': 70, blank: 2, 'YYYY-MM-DD': 1, 'YYYY-MM-DDTDD:DD:DD': 1,
    });
  });

  it('keeps several set-aside codes as SAM wrote them', () => {
    const codes = new Set(drafts.map((d) => d.setAside));
    for (const c of ['SBA', 'SDVOSBC', '8A', 'ISBEE']) expect(codes).toContain(c);
  });

  it('notices of one solicitation merge into one card, the newest notice winning', () => {
    // FA890327M1006: five notices of one presolicitation (Nellis AFB) → one card.
    expect(drafts.filter((d) => d.sourceId === 'FA890327M1006')).toHaveLength(1);
    // 36C26127Q0072 and its "_1" amendment are the same card.
    const dental = drafts.filter((d) => d.sourceId === '36C26127Q0072');
    expect(dental).toHaveLength(1);
    expect(dental[0]!.solNumber).toBe('36C26127Q0072_1');
  });
});

/** A synthetic TEST row (these shapes were all seen in the 2026-11-13 file; the values here are made up). */
function testRow(over: Record<string, string>): string {
  const cols = records()[0]!;
  const base: Record<string, string> = {
    Active: 'Yes', Type: 'Solicitation', NaicsCode: '238210', PopState: 'NV', PopZip: '89701', PopCountry: 'USA',
    Title: 'TEST electrical repair (synthetic)', Link: 'https://example.com/test', PostedDate: '2026-11-01 10:00:00',
  };
  return `${cols.map((c) => `"${(over[c] ?? base[c] ?? '').replace(/"/g, '""')}"`).join(',')}\n`;
}
const withRows = (...rows: string[]) => enc(`${HEADER}${rows.join('')}`);

describe('bulk file edge cases (TEST rows)', () => {
  it(`a notice with no deadline posted more than ${STALE_AFTER_DAYS} days ago is stale, not an open bid`, () => {
    const r = parseSamBulk(withRows(
      testRow({ NoticeId: 'TEST-n1', 'Sol#': 'TEST-OLD-1', PostedDate: '2016-03-01 09:00:00', ResponseDeadLine: '' }),
      testRow({ NoticeId: 'TEST-n2', 'Sol#': 'TEST-NEW-1', PostedDate: '2026-10-01 09:00:00', ResponseDeadLine: '' }),
    ), { now: CAPTURED });
    expect(r.drafts.map((d) => d.sourceId)).toEqual(['TEST-NEW-1']);
    expect(r.stats.dropped.stale).toBe(1);
  });

  it('US territories written as their own country (VIR, no state) are US work, not "abroad"', () => {
    const r = parseSamBulk(withRows(
      testRow({ NoticeId: 'TEST-vi', 'Sol#': 'TEST-VI-1', PopCountry: 'VIR', PopState: '', PopZip: '', PopCity: 'Christiansted', ResponseDeadLine: '2026-12-15T14:00:00-04:00' }),
      testRow({ NoticeId: 'TEST-jp', 'Sol#': 'TEST-JP-1', PopCountry: 'JPN', PopState: '', PopZip: '', ResponseDeadLine: '2026-12-15T14:00:00+09:00' }),
    ), { now: CAPTURED });
    expect(r.drafts.map((d) => [d.sourceId, d.location?.state])).toEqual([['TEST-VI-1', 'VI']]);
    expect(r.stats.dropped.country).toBe(1);
  });

  it('a deadline with no time zone takes a sibling notice’s offset for the same time, else is flagged', () => {
    const r = parseSamBulk(withRows(
      // TEST-ZONE-1: the amendment drops the zone; the original said -05:00 (Eastern) for the same wall time.
      testRow({ NoticeId: 'TEST-z1a', 'Sol#': 'TEST-ZONE-1', PostedDate: '2026-11-01 09:00:00', ResponseDeadLine: '2026-12-02T16:00:00-05:00' }),
      testRow({ NoticeId: 'TEST-z1b', 'Sol#': 'TEST-ZONE-1', PostedDate: '2026-11-05 09:00:00', ResponseDeadLine: '2026-12-02T16:00:00' }),
      // TEST-ZONE-2: no sibling says: read as Pacific, and the card says to check.
      testRow({ NoticeId: 'TEST-z2', 'Sol#': 'TEST-ZONE-2', ResponseDeadLine: '2026-12-02T16:00:00' }),
    ), { now: CAPTURED });
    const card = (sol: string) => r.drafts.find((d) => d.sourceId === sol)!;
    expect(card('TEST-ZONE-1').dueAt).toBe('2026-12-02T21:00:00.000Z'); // 16:00 Eastern, not 16:00 Pacific
    expect(card('TEST-ZONE-1').flags ?? []).not.toContain(FLAGS.deadlineZoneUnstated);
    expect(card('TEST-ZONE-2').dueAt).toBe('2026-12-03T00:00:00.000Z'); // 16:00 Pacific
    expect(card('TEST-ZONE-2').flags).toContain(FLAGS.deadlineZoneUnstated);
  });
});

describe('the same notice through the API and through the file is the same card', () => {
  const api = parseSamResponse({
    opportunitiesData: ['samgov-nv.json', 'samgov-ca-238210.json', 'samgov-ca-236220.json']
      .flatMap((f) => (JSON.parse(fx(f)) as SamResponse).opportunitiesData ?? []),
  });
  const bulk = new Map(parseSamBulk(RAW).drafts.map((d) => [d.sourceId, d]));

  it('same id, title, deadline, set-aside, NAICS, flags and link', () => {
    const both = api.filter((a) => bulk.has(a.sourceId));
    expect(both.length).toBeGreaterThanOrEqual(15);
    for (const a of both) {
      const b = bulk.get(a.sourceId)!;
      expect({ id: id(b), title: b.title, dueAt: b.dueAt, setAside: b.setAside, naics: b.naics, flags: b.flags, url: b.url, posted: b.postedAt })
        .toEqual({ id: id(a), title: a.title, dueAt: a.dueAt, setAside: a.setAside, naics: a.naics, flags: a.flags, url: a.url, posted: a.postedAt });
      expect(b.location?.zip ?? null).toBe(a.location?.zip ?? null);
    }
  });

  it('the agency reads the same (department · office)', () => {
    const a = api.find((x) => x.sourceId === '36C26127Q0067')!;
    expect(bulk.get('36C26127Q0067')!.agency).toBe(a.agency);
  });
});

describe('loud failures: the scan report must say FAILED, never a quiet 0', () => {
  it('an HTML page instead of the CSV', () => {
    expect(() => parseSamBulk(enc('<!DOCTYPE html><html><body>Service Unavailable</body></html>'))).toThrow(/HTML page/);
  });

  it('a JSON error body', () => {
    expect(() => parseSamBulk(enc('{"error":"TEST"}'))).toThrow(/JSON body/);
  });

  it('a missing or renamed column', () => {
    const renamed = HEADER.replace('"ResponseDeadLine"', '"ResponseDeadline"');
    expect(() => parseSamBulk(enc(renamed + td.decode(RAW.subarray(HEADER_END))))).toThrow(/"ResponseDeadLine" missing/);
    for (const c of BULK_COLUMNS) expect(HEADER).toContain(`"${c}"`);
  });

  it('a header and no rows', () => {
    expect(() => parseSamBulk(RAW.subarray(0, HEADER_END))).toThrow(/no rows/);
  });

  it('rows that never parse (wrong number of columns)', () => {
    const bad = enc(`${HEADER}${'"TEST","x"\n'.repeat(20)}`);
    expect(() => parseSamBulk(bad)).toThrow(/wrong number of columns/);
  });

  it('a big file with rows but not one open construction notice (the Type or NaicsCode values changed)', () => {
    const cols = records()[0]!;
    const row = (i: number) => cols.map((c) => (c === 'NoticeId' ? `TEST-${i}` : c === 'Active' ? 'Yes' : c === 'Type' ? 'TEST type' : '')).map((v) => `"${v}"`).join(',');
    const big = enc(HEADER + Array.from({ length: 1000 }, (_, i) => `${row(i)}\n`).join(''));
    expect(() => parseSamBulk(big)).toThrow(/not one open construction notice/);
  });

  it('a download cut off inside a quoted field', () => {
    const cut = RAW.subarray(0, RAW.length - 200);
    expect(() => parseSamBulk(cut)).toThrow(/ends inside a quoted field/);
  });
});

// ---------------------------------------------------------------- fetch --

// SAM_BULK_MIN_ROWS 0: the 82-row sample stands in for the 72,318-row daily file.
function streamCtx(chunks: Uint8Array[], env: Record<string, string> = { SAM_BULK_MIN_ROWS: '0' }): { ctx: SourceContext; logs: string[]; asked: string[] } {
  const logs: string[] = [];
  const asked: string[] = [];
  const http: FetchLike & { stream(url: string): Promise<AsyncIterable<Uint8Array>> } = {
    text: async () => { throw new Error('TEST: text() must not be used'); },
    json: async (url: string) => { asked.push(url); return JSON.parse(fx('samgov-nv.json')) as never; },
    stream: async (url: string) => {
      asked.push(url);
      return (async function* () { for (const c of chunks) yield c; })();
    },
  };
  return { ctx: { http, now: CAPTURED, env: (k) => env[k], log: (m) => void logs.push(m) }, logs, asked };
}

describe('samgov source: the bulk file by default, the API only with SAM_SOURCE=api', () => {
  it('runs with no key at all (not "skipped"), streams the file and logs what it left out', async () => {
    const { ctx, logs, asked } = streamCtx([RAW.subarray(0, 1000), RAW.subarray(1000)]);
    expect(samgovSource.disabledReason!(ctx)).toBeNull();
    const drafts = await samgovSource.fetch(ctx);
    expect(asked).toEqual([SAM_BULK_URL]);
    expect(drafts).toEqual(parseSamBulk(RAW, { now: CAPTURED }).drafts);
    expect(logs).toEqual([
      'samgov (bulk file): 36 cards from 74 notices (0 by service code alone), 2 placed at the contracting office (no work site ' +
      'named) — 82 rows, 82 active; left out: 3 not open bids, 4 not construction/trades, 2 abroad, 0 no place given, 9 past due (0.2 MB)',
    ]);
  });

  it('SAM_SOURCE=api without a key is skipped with a reason; with a key it calls the API (3 queries)', async () => {
    expect(samgovSource.disabledReason!(streamCtx([], { SAM_SOURCE: 'api' }).ctx)).toMatch(/SAM_API_KEY not set/);
    const { ctx, asked } = streamCtx([], { SAM_SOURCE: 'API', SAM_API_KEY: 'TEST-key' });
    expect(samgovSource.disabledReason!(ctx)).toBeNull();
    await samgovSource.fetch(ctx);
    expect(asked).toHaveLength(3);
    expect(asked.every((u) => u.startsWith('https://api.sam.gov/opportunities/v2/search?'))).toBe(true);
  });

  it('an error body from the download fails the fetch', async () => {
    const { ctx } = streamCtx([enc('<html><body>TEST error page</body></html>')]);
    await expect(fetchSamBulk(ctx)).rejects.toThrow(/HTML page/);
  });

  it(`a download that ends cleanly but early (fewer than ${LIVE_MIN_ROWS} rows) fails instead of showing part of the country`, async () => {
    const { ctx, logs } = streamCtx([RAW], {}); // no SAM_BULK_MIN_ROWS: the live floor applies
    await expect(fetchSamBulk(ctx)).rejects.toThrow(/only 82 rows .* stopped early/);
    expect(logs).toEqual([]);
  });

  it('a connection that drops mid-body names the source and how far it got, not just "terminated"', async () => {
    const http: FetchLike & { stream(url: string): Promise<AsyncIterable<Uint8Array>> } = {
      text: async () => '', json: async () => ({}) as never,
      stream: async () => (async function* () { yield RAW.subarray(0, 120_000); throw new TypeError('terminated'); })(),
    };
    const ctx: SourceContext = { http, now: CAPTURED, env: () => '0', log: () => {} };
    await expect(fetchSamBulk(ctx)).rejects.toThrow('SAM.gov bulk file: download stopped after 0.1 MB (terminated)');
  });

  it('an http client that cannot stream is refused, not read as text', async () => {
    const ctx: SourceContext = { http: { text: async () => '', json: async () => ({}) as never }, now: CAPTURED, env: () => undefined, log: () => {} };
    await expect(fetchSamBulk(ctx)).rejects.toThrow(/stream/);
  });
});

describe('http.stream(): redirects by hand, the signed URL never in a message', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/file') return void res.writeHead(303, { Location: '/signed/full.csv?X-Amz-Signature=TEST-SECRET-SIG' }).end();
      if (u.pathname === '/gone') return void res.writeHead(303, { Location: '/missing?X-Amz-Signature=TEST-SECRET-SIG' }).end();
      if (u.pathname === '/signed/full.csv') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.write(RAW.subarray(0, 5000));
        setTimeout(() => res.end(RAW.subarray(5000)), 5);
        return;
      }
      if (u.pathname === '/loop') return void res.writeHead(302, { Location: '/loop' }).end();
      res.writeHead(404).end('TEST not found');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const http = () => createHttp({ userAgent: 'BidSwipe-test', perHostDelayMs: 0, retries: 0 });

  it('follows a 303 and streams the body through the parser', async () => {
    const p = new SamBulkParser({ now: CAPTURED });
    let pieces = 0;
    for await (const c of await http().stream(`${base}/file`)) { p.push(c); pieces++; }
    expect(pieces).toBeGreaterThanOrEqual(2);
    expect(p.finish()).toEqual(parseSamBulk(RAW, { now: CAPTURED }).drafts);
  });

  it('an error after the redirect names the hop without its query string', async () => {
    const err = await http().stream(`${base}/gone`).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/HTTP 404/);
    expect((err as Error).message).toContain('/missing?…');
    expect((err as Error).message).not.toContain('TEST-SECRET-SIG');
  });

  it('gives up after 5 redirects', async () => {
    await expect(http().stream(`${base}/loop`)).rejects.toThrow(/Too many redirects/);
  });
});
