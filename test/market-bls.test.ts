/**
 * BLS wages (OEWS) and material price indexes (PPI). Every value here comes from REAL responses
 * captured from api.bls.gov on 2026-11-13 (test/fixtures/bls-*.json). The fake http client replays
 * those series and, like BLS, answers "No Data Available" for anything else. No network.
 */
import fc from 'fast-check';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { getSeries, listSeriesMeta, saveSeries, seriesCounts } from '../src/db/market.js';
import { oewsRefreshAreas, STATES, stateArea, VERIFIED_OEWS_AREAS } from '../src/market/areas.js';
import {
  areaWage, BLS_DISCLAIMER, BLS_V1_URL, BLS_V2_URL, blsRefreshPlan, buildBlsRequest, fetchBls, materialTrends, metroWagesInState,
  normalizeSoc, oewsPeriodLabel, oewsSeriesId, parseBlsResponse, periodKey, periodLabel, PPI_SERIES, refreshBls, seriesTrend, shiftMonths,
} from '../src/market/bls.js';
import type { FetchLike } from '../src/types.js';
import { fx, memoryDb, resetDb } from './helpers.js';

interface RawSeries { seriesID: string; data: Array<Record<string, unknown>> }
interface Capture { request: { seriesid: string[]; startyear?: string; endyear?: string }; response: { status: string; message: string[]; Results: { series: RawSeries[] } } }
const capture = (file: string): Capture => JSON.parse(fx(file));
const OEWS = capture('bls-oews-electricians.json');
const OEWS_PCT = capture('bls-oews-electricians-percentiles.json');
const PPI = capture('bls-ppi-core.json');
const MIXED = capture('bls-mixed-failures.json');
/** What BLS really answers once the day's 25 queries are used up (captured live, 2026-11-13). */
const THRESHOLD = capture('bls-daily-threshold.json');
const THRESHOLD_MESSAGE = 'Request could not be serviced, as the daily threshold for total number of requests allocated to the user with registration key  has been reached.';

const NOW = new Date('2026-11-13T03:00:00Z');
const CAPTURED = new Map<string, RawSeries>([OEWS, OEWS_PCT, PPI, MIXED].flatMap((c) => c.response.Results.series.map((s) => [s.seriesID, s] as const)));
const NOT_FOUND = new Set(['WPU10260306', 'PCU335122335122']);

interface Call { url: string; body: { seriesid: string[]; startyear: string; endyear: string; registrationkey?: string } }

/** Answers each query from the captured series; ids BLS was never asked for get its real "no data" wording. */
function replay(opts: { failOnQuery?: number; refuseOnQuery?: number; thresholdOnQuery?: number } = {}): { http: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const json = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const body = JSON.parse(String(init!.body)) as Call['body'];
    calls.push({ url, body });
    if (opts.failOnQuery === calls.length) throw new Error(`HTTP 500 for ${url}`);
    if (opts.thresholdOnQuery === calls.length) return THRESHOLD.response as T;
    if (opts.refuseOnQuery === calls.length) {
      return { status: 'REQUEST_NOT_PROCESSED', responseTime: 1, message: [`TEST daily threshold reached${body.registrationkey ? ` for key ${body.registrationkey}` : ''}`], Results: {} } as T;
    }
    const message: string[] = [];
    const series = body.seriesid.map((id) => {
      const real = CAPTURED.get(id);
      if (NOT_FOUND.has(id)) message.push(`Series does not exist for Series ${id}`);
      else if (!real || real.data.length === 0) for (let y = Number(body.startyear); y <= Number(body.endyear); y++) message.push(`No Data Available for Series ${id} Year: ${y}`);
      return real ?? { seriesID: id, data: [] };
    });
    return { status: 'REQUEST_SUCCEEDED', responseTime: 1, message, Results: { series } } as T;
  };
  return { http: { json, text: async () => { throw new Error('text() is not used'); } }, calls };
}

describe('OEWS series ids', () => {
  it('builds the ids that returned data live', () => {
    const id = (areaType: 'N' | 'S' | 'M', areaCode: string, datatype: string, soc = '47-2111', industry?: string) => oewsSeriesId({ areaType, areaCode, soc, datatype, industry });
    expect(id('M', '0039900', '03')).toBe('OEUM003990000000047211103'); // Reno, hourly mean
    expect(id('S', '3200000', '08')).toBe('OEUS320000000000047211108'); // Nevada, hourly median
    expect(id('S', '0600000', '07')).toBe('OEUS060000000000047211107'); // California, 25th percentile
    expect(id('N', '0000000', '03')).toBe('OEUN000000000000047211103'); // nation
    expect(id('M', '3200006', '03')).toBe('OEUM320000600000047211103'); // Balance of Nevada nonmetro
    expect(id('N', '0000000', '03', '472111', '238210')).toBe('OEUN000000023821047211103'); // inside NAICS 238210
    expect(id('S', '3200000', '03', '47-2152')).toBe('OEUS320000000000047215203'); // plumbers
    // Every id above is in a request BLS answered with data.
    const asked = new Set([...OEWS.request.seriesid, ...OEWS_PCT.request.seriesid, 'OEUS320000000000047215203']);
    for (const s of ['OEUM003990000000047211103', 'OEUS320000000000047211108', 'OEUS060000000000047211107', 'OEUN000000000000047211103', 'OEUM320000600000047211103', 'OEUN000000023821047211103']) {
      expect(asked.has(s), s).toBe(true);
    }
  });

  it('is always 25 characters and each part can be read back', () => {
    const digits = (n: number) => fc.array(fc.integer({ min: 0, max: 9 }), { minLength: n, maxLength: n }).map((d) => d.join(''));
    fc.assert(fc.property(fc.constantFrom('N', 'S', 'M'), digits(7), digits(6), digits(6), digits(2), (areaType, areaCode, industry, soc, datatype) => {
      const id = oewsSeriesId({ areaType: areaType as 'N' | 'S' | 'M', areaCode, soc, datatype, industry });
      expect(id).toHaveLength(25);
      expect([id.slice(0, 3), id[3], id.slice(4, 11), id.slice(11, 17), id.slice(17, 23), id.slice(23)]).toEqual(['OEU', areaType, areaCode, industry, soc, datatype]);
      expect(oewsSeriesId({ areaType: areaType as 'N' | 'S' | 'M', areaCode, soc: `${soc.slice(0, 2)}-${soc.slice(2)}`, datatype, industry })).toBe(id);
    }));
  });

  it('refuses malformed parts', () => {
    const ok = { areaType: 'S' as const, areaCode: '3200000', soc: '472111', datatype: '03' };
    expect(() => oewsSeriesId({ ...ok, areaCode: '32' })).toThrow(/area code/);
    expect(() => oewsSeriesId({ ...ok, soc: 'electrician' })).toThrow(/SOC/);
    expect(() => oewsSeriesId({ ...ok, datatype: '3' })).toThrow(/data type/);
    expect(() => oewsSeriesId({ ...ok, industry: '23821' })).toThrow(/industry/);
    expect(() => oewsSeriesId({ ...ok, areaType: 'X' as 'S' })).toThrow(/area type/);
    expect(normalizeSoc('47-2111')).toBe('472111');
  });

  it('state area codes are the FIPS code plus five zeros, for 50 states and DC', () => {
    expect(STATES).toHaveLength(51);
    expect(new Set(STATES.map((s) => s.fips)).size).toBe(51);
    expect(stateArea('nv')).toMatchObject({ areaType: 'S', areaCode: '3200000', name: 'Nevada', level: 'state' });
    expect(stateArea('CA')!.areaCode).toBe('0600000');
    expect(stateArea('TX')!.areaCode).toBe('4800000'); // Texas ran live: OEUS4800000…
    expect(stateArea('DC')!.areaCode).toBe('1100000');
    expect(stateArea('ZZ')).toBeNull();
    expect(VERIFIED_OEWS_AREAS.map((a) => a.areaCode)).toEqual(['0039900', '0029820', '0016180', '3200006', '0040900', '0035620']);
    expect(oewsRefreshAreas()).toHaveLength(1 + 51 + 6);
  });
});

describe('parseBlsResponse', () => {
  it('reads values, periods and the preliminary flag', () => {
    const parsed = parseBlsResponse(PPI.response);
    expect(parsed).toMatchObject({ status: 'REQUEST_SUCCEEDED', succeeded: true });
    const copper = parsed.series.find((s) => s.seriesId === 'WPU10260314')!;
    expect(copper.status).toBe('ok');
    expect(copper.observations).toHaveLength(33);
    expect(copper.observations[0]).toEqual({ year: '2026', period: 'M09', periodName: 'September', value: 607.705, raw: '607.705', preliminary: true, footnoteCodes: ['P'] });
    // The four newest months are preliminary; older ones are final.
    expect(copper.observations.filter((o) => o.preliminary).map((o) => o.period)).toEqual(['M09', 'M08', 'M07', 'M06']);
    expect(copper.observations.at(-1)).toMatchObject({ year: '2024', period: 'M01', preliminary: false });

    const nevada = parseBlsResponse(OEWS.response).series.find((s) => s.seriesId === 'OEUS320000000000047211103')!;
    expect(nevada.observations).toEqual([{ year: '2025', period: 'A01', periodName: 'Annual', value: 36.4, raw: '36.40', preliminary: false, footnoteCodes: [] }]);
  });

  it('finds per-series failures in message[] although status says REQUEST_SUCCEEDED', () => {
    const parsed = parseBlsResponse(MIXED.response);
    expect(parsed.status).toBe('REQUEST_SUCCEEDED');
    const by = new Map(parsed.series.map((s) => [s.seriesId, s]));
    expect(by.get('PCU335122335122')).toMatchObject({ status: 'not_found', observations: [], messages: ['Series does not exist for Series PCU335122335122'] });
    expect(by.get('PCU335311335311G')).toMatchObject({
      status: 'no_data', observations: [],
      messages: ['No Data Available for Series PCU335311335311G Year: 2025', 'No Data Available for Series PCU335311335311G Year: 2026'],
    });
    // A "no data for 2026" note does not fail a series that has its 2025 value.
    expect(by.get('OEUS480000000000047211103')).toMatchObject({ status: 'ok', messages: ['No Data Available for Series OEUS480000000000047211103 Year: 2026'] });
    expect(by.get('OEUS480000000000047211103')!.observations[0]).toMatchObject({ year: '2025', period: 'A01', value: 28.5 });
    expect(by.get('WPUSI019011')).toMatchObject({ status: 'ok', messages: [] });
    expect(parsed.series.filter((s) => s.status !== 'ok').map((s) => s.seriesId).sort()).toEqual(['PCU335122335122', 'PCU335311335311G']);

    const ppi = parseBlsResponse(PPI.response);
    expect(ppi.series.find((s) => s.seriesId === 'WPU10260306')).toMatchObject({ status: 'not_found', messages: ['Series does not exist for Series WPU10260306'] });
    // "WPU117" is a prefix of four other ids in this response and must not pick up their messages.
    expect(ppi.series.find((s) => s.seriesId === 'WPU117')).toMatchObject({ status: 'ok', messages: [] });
  });

  it('a series that was asked for and left out of the answer is "no_data", not silently missing', () => {
    const parsed = parseBlsResponse(OEWS.response, [...OEWS.request.seriesid, 'OEUS990000000000047211103']);
    expect(parsed.series).toHaveLength(26);
    expect(parsed.series.at(-1)).toEqual({ seriesId: 'OEUS990000000000047211103', status: 'no_data', observations: [], messages: [], unreadable: 0 });
    expect(parsed.series.filter((s) => s.status === 'ok')).toHaveLength(25);
  });

  it('drops values that are not numbers and counts them; keeps messages that name no series', () => {
    const parsed = parseBlsResponse({
      status: 'REQUEST_SUCCEEDED',
      message: ['TEST notice with no series id', 'TEST note about TESTSERIES1 only', 'TEST note about TESTSERIES10'],
      Results: { series: [
        { seriesID: 'TESTSERIES1', data: [{ year: '2026', period: 'M01', value: '-', footnotes: [{ code: 'X' }] }, { year: '2026', period: 'M02', value: '12.5', footnotes: [{}] }, { year: 2026, period: 'M03', value: '13' }] },
        { seriesID: 'TESTSERIES10', data: [{ year: '2026', period: 'M01', value: '', footnotes: [] }] },
        { data: [] }, 'junk',
      ] },
    });
    expect(parsed.otherMessages).toEqual(['TEST notice with no series id']);
    expect(parsed.series).toEqual([
      { seriesId: 'TESTSERIES1', status: 'ok', unreadable: 2, messages: ['TEST note about TESTSERIES1 only'], observations: [{ year: '2026', period: 'M02', periodName: null, value: 12.5, raw: '12.5', preliminary: false, footnoteCodes: [] }] },
      { seriesId: 'TESTSERIES10', status: 'no_data', unreadable: 1, messages: ['TEST note about TESTSERIES10'], observations: [] },
    ]);
  });

  it('never throws on junk and reports a failed request as not succeeded', () => {
    for (const junk of [null, undefined, 'nope', 42, [], {}]) expect(parseBlsResponse(junk)).toMatchObject({ succeeded: false, series: [] });
    expect(parseBlsResponse({ status: 'REQUEST_NOT_PROCESSED', message: ['TEST threshold'], Results: {} })).toMatchObject({
      status: 'REQUEST_NOT_PROCESSED', succeeded: false, otherMessages: ['TEST threshold'], series: [],
    });
  });
});

describe('fetchBls', () => {
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `TESTSERIES${String(i).padStart(3, '0')}`);

  it('builds the request that ran live: series ids plus an explicit year range, as strings', () => {
    expect(buildBlsRequest(MIXED.request.seriesid, 2025, 2026)).toEqual({ url: BLS_V1_URL, body: MIXED.request });
    expect(buildBlsRequest(['WPU1171'], 2024, 2026, 'TEST-KEY')).toEqual({ url: BLS_V2_URL, body: { seriesid: ['WPU1171'], startyear: '2024', endyear: '2026', registrationkey: 'TEST-KEY' } });
    expect(() => buildBlsRequest(ids(26), 2025, 2026)).toThrow(/1–25/);
    expect(() => buildBlsRequest(ids(51), 2025, 2026, 'TEST-KEY')).toThrow(/1–50/);
    expect(() => buildBlsRequest([], 2025, 2026)).toThrow(/series/);
    expect(() => buildBlsRequest(ids(1), 2026, 2025)).toThrow(/year range/);
    expect(() => buildBlsRequest(ids(1), 2010, 2026)).toThrow(/10 years/);
  });

  it('sends 25 series per query without a key, 50 with one', async () => {
    const v1 = replay();
    const got = await fetchBls(v1.http, [...ids(60), ...ids(3)], { startYear: 2024, endYear: 2026 });
    expect(v1.calls.map((c) => c.body.seriesid.length)).toEqual([25, 25, 10]);
    expect(v1.calls.every((c) => c.url === BLS_V1_URL && c.body.startyear === '2024' && c.body.endyear === '2026' && !('registrationkey' in c.body))).toBe(true);
    expect(got).toMatchObject({ queries: 3, notFetched: [], error: null });
    expect(got.series).toHaveLength(60);

    const v2 = replay();
    await fetchBls(v2.http, ids(60), { startYear: 2024, endYear: 2026, apiKey: 'TEST-KEY' });
    expect(v2.calls.map((c) => c.body.seriesid.length)).toEqual([50, 10]);
    expect(v2.calls.every((c) => c.url === BLS_V2_URL && c.body.registrationkey === 'TEST-KEY')).toBe(true);
  });

  it('stops at the query budget and lists what it did not ask for', async () => {
    const { http, calls } = replay();
    const got = await fetchBls(http, ids(60), { startYear: 2024, endYear: 2026, maxQueries: 1 });
    expect(calls).toHaveLength(1);
    expect(got.queries).toBe(1);
    expect(got.series).toHaveLength(25);
    expect(got.notFetched).toEqual(ids(60).slice(25));
    expect(got.error).toMatch(/query budget \(1\); 35 series/);
  });

  it('stops at the first failed query and never retries', async () => {
    const down = replay({ failOnQuery: 2 });
    const got = await fetchBls(down.http, ids(60), { startYear: 2024, endYear: 2026 });
    expect(down.calls).toHaveLength(2);
    expect(got).toMatchObject({ queries: 2, error: expect.stringMatching(/HTTP 500/) });
    expect(got.series).toHaveLength(25);
    expect(got.notFetched).toEqual(ids(60).slice(25));

    const refused = replay({ refuseOnQuery: 1 });
    const none = await fetchBls(refused.http, ids(60), { startYear: 2024, endYear: 2026 });
    expect(refused.calls).toHaveLength(1);
    expect(none).toMatchObject({ queries: 1, series: [], error: 'BLS answered REQUEST_NOT_PROCESSED: TEST daily threshold reached' });
    expect(none.notFetched).toHaveLength(60);
  });

  it('the daily allowance running out part way (the real answer): keeps what it has, asks nothing more', async () => {
    expect(parseBlsResponse(THRESHOLD.response, THRESHOLD.request.seriesid)).toMatchObject({
      status: 'REQUEST_NOT_PROCESSED', succeeded: false, otherMessages: [THRESHOLD_MESSAGE],
      series: THRESHOLD.request.seriesid.map((seriesId) => ({ seriesId, status: 'no_data', observations: [] })),
    });
    const { http, calls } = replay({ thresholdOnQuery: 3 });
    const got = await fetchBls(http, ids(120), { startYear: 2024, endYear: 2026 });
    expect(calls).toHaveLength(3);
    expect(got.queries).toBe(3);
    expect(got.series).toHaveLength(50);
    expect(got.notFetched).toEqual(ids(120).slice(50));
    expect(got.error).toBe(`BLS answered REQUEST_NOT_PROCESSED: ${THRESHOLD_MESSAGE}`);
  });

  it('never lets the key into an error or a log line', async () => {
    const logs: string[] = [];
    const { http } = replay({ refuseOnQuery: 1 });
    const got = await fetchBls(http, ids(3), { startYear: 2024, endYear: 2026, apiKey: 'TEST-SECRET-KEY', log: (m) => logs.push(m) });
    expect(got.error).toBe('BLS answered REQUEST_NOT_PROCESSED: TEST daily threshold reached for key ***');
    expect(JSON.stringify([got, logs])).not.toContain('TEST-SECRET-KEY');
  });
});

describe('refresh plan', () => {
  it('asks for the 9 price indexes and four wage figures for the nation, every state and the verified metros', () => {
    const plan = blsRefreshPlan();
    expect(plan).toHaveLength(9 + (1 + 51 + 6) * 4);
    expect(new Set(plan.map((p) => p.seriesId)).size).toBe(plan.length);
    expect(plan.slice(0, 9).map((p) => p.seriesId)).toEqual(['WPU10260314', 'WPU11710216', 'WPU117522', 'PCU3353133353133', 'WPU108303', 'WPU1174', 'WPU1171', 'WPUIP2312001', 'PCU23821X23821X']);
    expect(plan.slice(9, 13).map((p) => p.seriesId)).toEqual(['OEUN000000000000047211103', 'OEUN000000000000047211107', 'OEUN000000000000047211108', 'OEUN000000000000047211109']);
    const ids = new Set(plan.map((p) => p.seriesId));
    for (const id of ['OEUS320000000000047211103', 'OEUS060000000000047211109', 'OEUS110000000000047211108', 'OEUM003990000000047211107', 'OEUM320000600000047211103', 'OEUM003562000000047211103']) {
      expect(ids.has(id), id).toBe(true);
    }
    expect(plan.find((p) => p.seriesId === 'OEUS320000000000047211108')!.meta).toEqual({
      seriesId: 'OEUS320000000000047211108', kind: 'oews', title: 'Electricians: hourly median wage', area: 'Nevada', unit: 'USD per hour',
      source: 'BLS Occupational Employment and Wage Statistics (OEWS)', sourceUrl: 'https://www.bls.gov/oes/',
    });
    expect(plan[0]!.meta).toMatchObject({ kind: 'ppi', title: 'Metals and metal products: Copper wire and cable', area: 'United States', unit: 'index', source: 'BLS Producer Price Index (PPI)' });
    // 241 series = 10 queries without a key (the daily allowance is 25), 5 with one.
    expect(Math.ceil(plan.length / 25)).toBe(10);
    expect(Math.ceil(plan.length / 50)).toBe(5);
    expect(PPI_SERIES.every((p) => p.label && p.title)).toBe(true);
  });

  it('puts the states customers work in, and their metro areas, right after the nation', () => {
    const areaOf = (id: string) => id.slice(3, 11); // area type + 7-character area code
    const order = (states: string[]) => [...new Set(blsRefreshPlan(undefined, states).slice(9).map((p) => areaOf(p.seriesId)))];
    expect(order(['nv', 'CA']).slice(0, 9)).toEqual([
      'N0000000', 'S0600000', 'S3200000', // nation, California, Nevada
      'M0039900', 'M0029820', 'M0016180', 'M3200006', 'M0040900', // Reno, Las Vegas, Carson City, Balance of Nevada, Sacramento
      'M0035620', // then the metro left over (New York), then every other state
    ]);
    expect(order(['NV', 'CA'])[9]).toBe('S0100000');
    expect(order([]).slice(0, 8)).toEqual(['N0000000', 'M0039900', 'M0029820', 'M0016180', 'M3200006', 'M0040900', 'M0035620', 'S0100000']);
    // Same series either way: only the order changes. With NV and CA first, one 25-series query holds the indexes, the nation and both states.
    const plan = blsRefreshPlan(undefined, ['NV', 'CA']);
    expect(plan.map((p) => p.seriesId).sort()).toEqual(blsRefreshPlan().map((p) => p.seriesId).sort());
    expect(plan.slice(0, 25).map((p) => p.seriesId)).toEqual(expect.arrayContaining(['WPU10260314', 'OEUN000000000000047211103', 'OEUS320000000000047211103', 'OEUS060000000000047211109']));
  });
});

describe('stored series: refresh, area wages, material trends', () => {
  let db: Db;
  beforeAll(async () => {
    db = await memoryDb();
  });
  afterAll(async () => db.close());
  beforeEach(async () => resetDb(db));

  it('stores what BLS returned, flags preliminary values, and records each series that failed', async () => {
    const { http, calls } = replay();
    const report = await refreshBls(db, http, { now: NOW });
    expect(calls).toHaveLength(10);
    expect(calls.every((c) => c.body.startyear === '2024' && c.body.endyear === '2026')).toBe(true);
    expect(report).toMatchObject({ source: 'bls', startYear: 2024, endYear: 2026, queries: 10, seriesPlanned: 241, skippedFresh: 0, seriesAsked: 241, notFetched: [], error: null });
    // Captured: 9 price indexes, mean + median for 8 areas, 25th + 75th percentile for 6 areas, and the mean alone for Texas and New York.
    expect(report.seriesStored).toBe(9 + 16 + 12 + 2);
    expect(report.observationsStored).toBe(9 * 33 + 16 + 12 + 2);
    expect(report.failed).toHaveLength(241 - 39);
    expect(report.failed.find((f) => f.seriesId === 'OEUS480000000000047211108')).toEqual({
      seriesId: 'OEUS480000000000047211108', status: 'no_data',
      message: 'No Data Available for Series OEUS480000000000047211108 Year: 2024 | No Data Available for Series OEUS480000000000047211108 Year: 2025 | No Data Available for Series OEUS480000000000047211108 Year: 2026',
    });

    const stored = await getSeries(db, ['WPU10260314', 'OEUS320000000000047211103', 'OEUS480000000000047211108', 'TEST-NOT-STORED']);
    expect([...stored.keys()].sort()).toEqual(['OEUS320000000000047211103', 'OEUS480000000000047211108', 'WPU10260314']);
    const copper = stored.get('WPU10260314')!;
    expect(copper.meta).toMatchObject({ kind: 'ppi', status: 'ok', note: null, fetchedAt: NOW.toISOString(), unit: 'index', area: 'United States' });
    expect(copper.observations).toHaveLength(33);
    expect(copper.observations[0]).toEqual({ period: '2024-M01', value: 385.557, preliminary: false });
    expect(copper.observations.at(-1)).toEqual({ period: '2026-M09', value: 607.705, preliminary: true });
    expect(copper.observations.filter((o) => o.preliminary).map((o) => o.period)).toEqual(['2026-M06', '2026-M07', '2026-M08', '2026-M09']);
    expect(stored.get('OEUS320000000000047211103')!.observations).toEqual([{ period: '2025-A01', value: 36.4, preliminary: false }]);
    expect(stored.get('OEUS480000000000047211108')).toMatchObject({ meta: { status: 'no_data', area: 'Texas' }, observations: [] });

    expect(await seriesCounts(db)).toEqual([
      { kind: 'oews', series: 232, withData: 30, observations: 30 },
      { kind: 'ppi', series: 9, withData: 9, observations: 297 },
    ]);
  });

  it('is idempotent, and a revised value replaces the preliminary one', async () => {
    await refreshBls(db, replay().http, { now: NOW });
    const dump = () => db.query('select * from market_series order by series_id, period');
    const before = await dump();
    await refreshBls(db, replay().http, { now: NOW });
    expect(await dump()).toEqual(before);

    // BLS revises: the same month comes back final with another value.
    const meta = blsRefreshPlan()[0]!.meta;
    await saveSeries(db, meta, [{ period: '2026-M09', value: '606.100', preliminary: false }], new Date('2026-12-15T00:00:00Z'));
    const copper = (await getSeries(db, ['WPU10260314'])).get('WPU10260314')!;
    expect(copper.observations).toHaveLength(33);
    expect(copper.observations.at(-1)).toEqual({ period: '2026-M09', value: 606.1, preliminary: false });
    expect(copper.meta.fetchedAt).toBe('2026-12-15T00:00:00.000Z');
  });

  it('a failed refresh keeps the values already stored and says what went wrong', async () => {
    await refreshBls(db, replay().http, { now: NOW });
    const later = new Date('2026-12-01T00:00:00Z');
    const report = await refreshBls(db, replay({ thresholdOnQuery: 1 }).http, { now: later, wageMaxAgeDays: 0 });
    expect(report).toMatchObject({ queries: 1, seriesStored: 0, skippedFresh: 0, error: `BLS answered REQUEST_NOT_PROCESSED: ${THRESHOLD_MESSAGE}` });
    expect(report.notFetched).toHaveLength(241);
    expect((await getSeries(db, ['WPU10260314'])).get('WPU10260314')).toMatchObject({ meta: { status: 'ok', fetchedAt: NOW.toISOString() } });

    // A series BLS stops publishing keeps its old values and gets a note.
    const gone: FetchLike = {
      text: async () => '',
      json: async <T>(_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init!.body)) as { seriesid: string[] };
        return { status: 'REQUEST_SUCCEEDED', message: body.seriesid.map((id) => `Series does not exist for Series ${id}`), Results: { series: body.seriesid.map((id) => ({ seriesID: id, data: [] })) } } as T;
      },
    };
    await refreshBls(db, gone, { now: later, maxQueries: 1, wageMaxAgeDays: 0 });
    const copper = (await getSeries(db, ['WPU10260314'])).get('WPU10260314')!;
    expect(copper.meta).toMatchObject({ status: 'not_found', note: 'Series does not exist for Series WPU10260314', fetchedAt: NOW.toISOString() });
    expect(copper.observations).toHaveLength(33);
    expect((await materialTrends(db))[0]).toMatchObject({ seriesId: 'WPU10260314', latest: { value: 607.705 }, note: 'Last refresh got no new data: Series does not exist for Series WPU10260314' });
  });

  it('a run cut short by the daily allowance is finished by the next one, which asks only for what is missing', async () => {
    // Day one, as it happened live: two queries answered, the third refused.
    const first = replay({ thresholdOnQuery: 3 });
    const day1 = await refreshBls(db, first.http, { now: NOW, priorityStates: ['NV', 'CA'] });
    expect(day1).toMatchObject({ queries: 3, seriesAsked: 241, skippedFresh: 0, error: `BLS answered REQUEST_NOT_PROCESSED: ${THRESHOLD_MESSAGE}` });
    expect(day1.notFetched).toHaveLength(241 - 50);
    // Nevada and California were asked for first, so they are in.
    expect(await areaWage(db, { state: 'NV' }, '47-2111')).toMatchObject({ level: 'state', mean: 36.4 });
    expect(await areaWage(db, { state: 'CA' }, '47-2111')).toMatchObject({ level: 'state', mean: 41.28 });
    expect((await materialTrends(db))[0]!.latest).toMatchObject({ value: 607.705 });
    const stored = day1.seriesStored - 9;

    // Day two: wage series that came back with data are left alone; the indexes and everything else are asked for.
    const second = replay();
    const day2 = await refreshBls(db, second.http, { now: new Date('2026-11-14T03:00:00Z'), priorityStates: ['NV', 'CA'] });
    expect(day2).toMatchObject({ seriesPlanned: 241, skippedFresh: stored, seriesAsked: 241 - stored, notFetched: [], error: null });
    expect(second.calls).toHaveLength(Math.ceil((241 - stored) / 25));
    const asked = second.calls.flatMap((c) => c.body.seriesid);
    expect(asked).toContain('WPU10260314');
    expect(asked).not.toContain('OEUS320000000000047211103');
    expect(asked).toContain('OEUS480000000000047211103');

    // A year on, a new survey is out: everything is asked for again.
    const nextYear = await refreshBls(db, replay().http, { now: new Date('2027-05-20T00:00:00Z') });
    expect(nextYear).toMatchObject({ skippedFresh: 0, seriesAsked: 241, startYear: 2025, endYear: 2027 });
  });

  it('areaWage: metro, then state, then nation, and says which level and survey period it used', async () => {
    expect(await areaWage(db, { state: 'NV' }, '47-2111')).toBeNull();
    await refreshBls(db, replay().http, { now: NOW });

    const nevada = await areaWage(db, { state: 'NV' }, '47-2111');
    expect(nevada).toEqual({
      soc: '472111', occupation: 'Electricians', level: 'state', areaCode: '3200000', areaName: 'Nevada',
      period: '2025-A01', periodLabel: 'May 2025', mean: 36.4, median: 35.37, p25: 23.52, p75: 46.42, unit: 'USD per hour',
      source: 'BLS Occupational Employment and Wage Statistics (OEWS)', sourceUrl: 'https://www.bls.gov/oes/', fetchedAt: NOW.toISOString(),
      tried: [{ level: 'state', areaName: 'Nevada', found: true }],
    });

    const reno = await areaWage(db, { state: 'NV', cbsa: '39900' }, '472111');
    expect(reno).toMatchObject({ level: 'metro', areaName: 'Reno, NV', mean: 35.2, median: 35, p25: 23.63, p75: 41.12, periodLabel: 'May 2025' });
    expect(reno!.tried).toEqual([{ level: 'metro', areaName: 'Reno, NV', found: true }]);

    expect(await areaWage(db, { state: 'CA' }, '47-2111')).toMatchObject({ level: 'state', areaName: 'California', mean: 41.28, median: 36.62, p25: 28.5, p75: 49.52 });
    expect(await areaWage(db, { state: 'CA', cbsa: '40900' }, '47-2111')).toMatchObject({ level: 'metro', areaName: 'Sacramento-Roseville-Folsom, CA', mean: 38.4, median: 35.98, p25: 25.35, p75: 47.18 });

    // A metro we hold nothing for falls back to its state.
    const unknownMetro = await areaWage(db, { state: 'NV', cbsa: '99999' }, '47-2111');
    expect(unknownMetro).toMatchObject({ level: 'state', areaName: 'Nevada', mean: 36.4 });
    expect(unknownMetro!.tried).toEqual([{ level: 'metro', areaName: 'Metro area 99999', found: false }, { level: 'state', areaName: 'Nevada', found: true }]);

    // Only the Texas mean is in the capture: the state level still wins, with null for what we do not hold.
    expect(await areaWage(db, { state: 'TX' }, '47-2111')).toMatchObject({ level: 'state', areaName: 'Texas', mean: 28.5, median: null, p25: null, p75: null, period: '2025-A01' });

    // Nothing for Oregon in the capture: the nation, with only the figures BLS returned for it.
    const oregon = await areaWage(db, { state: 'OR' }, '47-2111');
    expect(oregon).toMatchObject({ level: 'nation', areaName: 'United States', mean: 34.37, median: 30.38, p25: null, p75: null, period: '2025-A01' });
    expect(oregon!.tried).toEqual([{ level: 'state', areaName: 'Oregon', found: false }, { level: 'nation', areaName: 'United States', found: true }]);
    expect(await areaWage(db, {}, '47-2111')).toMatchObject({ level: 'nation', mean: 34.37 });
    expect(await areaWage(db, { state: 'ZZ' }, '47-2111')).toMatchObject({ level: 'nation' });

    // Another occupation was never loaded.
    expect(await areaWage(db, { state: 'NV' }, '47-2152')).toBeNull();
    await expect(areaWage(db, { state: 'NV' }, 'electrician')).rejects.toThrow(/SOC/);

    const metros = await metroWagesInState(db, 'nv', '47-2111');
    expect(metros.map((w) => [w.areaName, w.level, w.mean, w.p25])).toEqual([
      ['Reno, NV', 'metro', 35.2, 23.63],
      ['Las Vegas-Henderson-North Las Vegas, NV', 'metro', 36.16, 23.26],
      ['Carson City, NV', 'metro', 40.86, 27.65],
      ['Balance of Nevada nonmetropolitan area', 'nonmetro', 38.81, null],
    ]);
    expect((await metroWagesInState(db, 'NY', '47-2111')).map((w) => [w.areaName, w.mean, w.median])).toEqual([['New York metro area', 42.63, null]]);
    expect(await metroWagesInState(db, 'OR', '47-2111')).toEqual([]);
  });

  it('materialTrends: latest value, period, preliminary flag and the change over 1, 3 and 12 months', async () => {
    expect(await materialTrends(db)).toEqual([]);
    await refreshBls(db, replay().http, { now: NOW });
    const trends = await materialTrends(db);
    expect(trends.map((t) => t.seriesId)).toEqual(PPI_SERIES.map((p) => p.seriesId));

    expect(trends[0]).toEqual({
      seriesId: 'WPU10260314', label: 'Copper wire and cable', title: 'Metals and metal products: Copper wire and cable',
      latest: { period: '2026-M09', periodLabel: 'Sep 2026', value: 607.705, preliminary: true },
      change1m: { pct: 0.8, from: { period: '2026-M08', periodLabel: 'Aug 2026', value: 602.663, preliminary: true } },
      change3m: { pct: 5.3, from: { period: '2026-M06', periodLabel: 'Jun 2026', value: 577.166, preliminary: true } },
      change12m: { pct: 30.8, from: { period: '2025-M09', periodLabel: 'Sep 2025', value: 464.522, preliminary: false } },
      note: null, unit: 'index', geography: 'national', source: 'BLS Producer Price Index (PPI)', sourceUrl: 'https://www.bls.gov/ppi/', fetchedAt: NOW.toISOString(),
    });
    // The year-over-year changes in the research brief (Sept 2026 vs Sept 2025).
    expect(Object.fromEntries(trends.map((t) => [t.seriesId, [t.latest!.value, t.change12m!.pct]]))).toEqual({
      WPU10260314: [607.705, 30.8], WPU11710216: [221.225, 8.1], WPU117522: [259.181, 12.8], PCU3353133353133: [318.091, 6.2],
      WPU108303: [274.551, 3.6], WPU1174: [434.493, 7.6], WPU1171: [400.441, 4.7], WPUIP2312001: [184.909, 11.2], PCU23821X23821X: [180.711, 5.4],
    });
    expect(trends.every((t) => t.latest!.period === '2026-M09' && t.latest!.preliminary && t.geography === 'national')).toBe(true);
  });

  it('lists a price index we asked for and got nothing, saying so', async () => {
    const meta = blsRefreshPlan()[0]!.meta;
    const none: FetchLike = { text: async () => '', json: async <T>() => ({ status: 'REQUEST_SUCCEEDED', message: [`Series does not exist for Series ${meta.seriesId}`], Results: { series: [{ seriesID: meta.seriesId, data: [] }] } }) as T };
    await refreshBls(db, none, { now: NOW, maxQueries: 1 });
    const trends = await materialTrends(db);
    expect(trends[0]).toMatchObject({ seriesId: 'WPU10260314', latest: null, change12m: null, fetchedAt: null, note: 'No data: Series does not exist for Series WPU10260314' });
    expect((await listSeriesMeta(db, 'ppi')).find((m) => m.seriesId === 'WPU10260314')).toMatchObject({ status: 'not_found' });
  });
});

describe('trend arithmetic', () => {
  const copper = parseBlsResponse(PPI.response).series.find((s) => s.seriesId === 'WPU10260314')!
    .observations.map((o) => ({ period: periodKey(o.year, o.period), value: o.value, preliminary: o.preliminary }));

  it('change = (latest / value N months back − 1) × 100, one decimal', () => {
    const t = seriesTrend(copper)!;
    expect(t.latest.value).toBe(607.705);
    expect(t.change1m!.pct).toBe(Math.round((607.705 / 602.663 - 1) * 1000) / 10);
    expect(t.change12m!.pct).toBe(30.8);
    expect(seriesTrend([...copper].reverse())).toEqual(t);
  });

  it('a missing month gives null, never a guess from its neighbours', () => {
    const without = (period: string) => copper.filter((o) => o.period !== period);
    expect(seriesTrend(without('2025-M09'))).toMatchObject({ change12m: null, change1m: { pct: 0.8 }, change3m: { pct: 5.3 } });
    expect(seriesTrend(without('2026-M06'))).toMatchObject({ change3m: null, change12m: { pct: 30.8 } });
    expect(seriesTrend(without('2026-M08'))!.change1m).toBeNull();
    // Without the newest month, everything is measured from the month before it.
    expect(seriesTrend(without('2026-M09'))).toMatchObject({ latest: { period: '2026-M08', value: 602.663 }, change12m: { from: { period: '2025-M08' } } });
    expect(seriesTrend([])).toBeNull();
    expect(seriesTrend([{ period: '2025-A01', value: 36.4, preliminary: false }])).toBeNull();
  });

  it('ignores annual averages (M13) and cannot divide by zero', () => {
    const t = seriesTrend([
      { period: '2026-M13', value: 999, preliminary: false }, { period: '2026-M02', value: 110, preliminary: true },
      { period: '2026-M01', value: 0, preliminary: false }, { period: '2025-M11', value: 100, preliminary: false },
    ])!;
    expect(t.latest).toEqual({ period: '2026-M02', periodLabel: 'Feb 2026', value: 110, preliminary: true });
    expect(t.change1m).toBeNull();
    expect(t.change3m).toEqual({ pct: 10, from: { period: '2025-M11', periodLabel: 'Nov 2025', value: 100, preliminary: false } });
    expect(t.change12m).toBeNull();
  });

  it('shifts months across year ends, and shifting back returns to the start', () => {
    expect(shiftMonths('2026-M01', -1)).toBe('2025-M12');
    expect(shiftMonths('2026-M09', -12)).toBe('2025-M09');
    expect(shiftMonths('2026-M02', -3)).toBe('2025-M11');
    expect(shiftMonths('2025-M12', 1)).toBe('2026-M01');
    expect(shiftMonths('2025-A01', -1)).toBeNull();
    fc.assert(fc.property(fc.integer({ min: 1990, max: 2090 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: -240, max: 240 }), (year, month, k) => {
      const start = `${year}-M${String(month).padStart(2, '0')}`;
      const moved = shiftMonths(start, k)!;
      expect(moved).toMatch(/^\d{4}-M(0[1-9]|1[0-2])$/);
      expect(shiftMonths(moved, -k)).toBe(start);
      expect(Math.sign(moved.localeCompare(start))).toBe(Math.sign(k));
    }));
  });

  it('labels periods the way a person reads them', () => {
    expect(periodLabel('2026-M09')).toBe('Sep 2026');
    expect(periodLabel('2025-M12')).toBe('Dec 2025');
    expect(periodLabel('2025-A01')).toBe('2025');
    expect(oewsPeriodLabel('2025-A01')).toBe('May 2025');
    expect(periodKey('2026', 'M09')).toBe('2026-M09');
    expect(BLS_DISCLAIMER).toBe('BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov.');
  });
});
