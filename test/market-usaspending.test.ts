/**
 * Federal award prices. Every response here is a REAL page captured from api.usaspending.gov on
 * 2026-11-13 (test/fixtures/usaspending-*.json, each with its URL and capture time). The fake http
 * client replays those pages; nothing touches the network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { awardCounts, awardsMissingDetail, awardsNeedingPriceLookup, awardsWithoutPrice, getAward, getAwardCoverage, listAwards, saveAwardDetail, setPricesAtAward, upsertAwards } from '../src/db/market.js';
import {
  AWARD_FIELDS, awardDetailUrl, awardFilters, awardKey, awardWindow, buildAwardCount, buildAwardSearch, buildAwardTransactions, buildTransactionSearch,
  fetchAwards, fetchPriceAtAward, fetchTransactions, fillAwardDetails, parseAwardCount, parseAwardDetail, parseAwardSearch, parseAwardTransactions,
  parseTransactionSearch, pricesAtAward, refreshAwards, toAmount, TRANSACTION_FIELDS, type AwardQuery,
} from '../src/market/usaspending.js';
import type { FetchLike } from '../src/types.js';
import { fx, memoryDb, resetDb } from './helpers.js';

const fixture = (file: string): { request: Record<string, unknown>; response: Record<string, unknown> } => JSON.parse(fx(file));
const AWARDS = fixture('usaspending-awards-nv-238210.json');
const TRANSACTIONS = fixture('usaspending-transactions-clark-238210.json');
const DETAIL = fixture('usaspending-award-detail.json');
const COUNT = fixture('usaspending-award-count-nv-238210.json');
const HISTORY = fixture('usaspending-award-transactions.json');
const PAGE_1_OF_3 = fixture('usaspending-awards-nv-page1-of-3.json');
/** The FAA delivery order whose Mod 0 row the transaction search did not return (live, 2026-11-13). */
const FAA_ORDER = 'CONT_AWD_6973GH26F00119_6920_6973GH25D00041_6920';

const NOW = new Date('2026-11-13T03:00:00Z');
const NEVADA: AwardQuery = { naics: ['238210'], place: { state: 'NV' }, startDate: '2024-11-13', endDate: '2026-11-13' };

interface Call { url: string; body: Record<string, unknown> | null }

/** Replays the captured pages by endpoint. `pageSize` cuts the real award rows into pages to exercise paging. */
function replay(opts: { pageSize?: number; failTransactions?: boolean; failAll?: boolean } = {}): { http: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const json = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });
    if (opts.failAll) throw new Error('HTTP 500 for ' + url);
    if (url.endsWith('/spending_by_award_count/')) return COUNT.response as T;
    if (url.endsWith('/spending_by_award/')) {
      const rows = AWARDS.response.results as unknown[];
      const size = opts.pageSize ?? 100;
      const page = Number(body!.page);
      const slice = rows.slice((page - 1) * size, page * size);
      return { ...AWARDS.response, results: slice, page_metadata: { page, hasNext: page * size < rows.length } } as T;
    }
    if (url.endsWith('/spending_by_transaction/')) {
      if (opts.failTransactions) throw new Error('HTTP 503 for ' + url);
      return TRANSACTIONS.response as T;
    }
    if (url.endsWith('/api/v2/transactions/')) {
      // One award's own history: the captured one for the FAA order, an empty history for any other.
      return (body!.award_id === FAA_ORDER ? HISTORY.response : { page_metadata: { page: 1, next: null, previous: null, hasNext: false, hasPrevious: false }, results: [] }) as T;
    }
    if (url.includes('/api/v2/awards/')) return DETAIL.response as T;
    throw new Error(`unexpected request ${url}`);
  };
  return { http: { json, text: async () => { throw new Error('text() is not used'); } }, calls };
}

describe('request builders', () => {
  it('awards search: the filters and fields that ran live, always new_awards_only', () => {
    const { url, body } = buildAwardSearch(NEVADA);
    expect(url).toBe('https://api.usaspending.gov/api/v2/search/spending_by_award/');
    expect(body.filters).toEqual(AWARDS.request.filters);
    expect(body.fields).toEqual(AWARDS.request.fields);
    expect(body).toMatchObject({ subawards: false, limit: 100, page: 1, sort: 'Base Obligation Date', order: 'desc' });
    expect(JSON.stringify(body.filters)).toContain('"date_type":"new_awards_only"');
    expect(AWARD_FIELDS).toContain('generated_internal_id');
  });

  it('transaction search: exactly the request that ran live for Clark County', () => {
    const q: AwardQuery = { ...NEVADA, place: { state: 'NV', county: '003' } };
    expect(buildTransactionSearch(q)).toEqual({ url: 'https://api.usaspending.gov/api/v2/search/spending_by_transaction/', body: TRANSACTIONS.request });
    expect(TRANSACTION_FIELDS).toEqual(TRANSACTIONS.request.fields);
  });

  it('count: exactly the request that ran live', () => {
    expect(buildAwardCount(NEVADA)).toEqual({ url: 'https://api.usaspending.gov/api/v2/search/spending_by_award_count/', body: COUNT.request });
  });

  it('place of performance by state, county, ZIP or the whole country; several NAICS codes; paging', () => {
    const place = (p: AwardQuery['place']) => awardFilters({ ...NEVADA, place: p });
    expect(place({ state: 'nv' }).place_of_performance_locations).toEqual([{ country: 'USA', state: 'NV' }]);
    expect(place({ state: 'NV', county: '003' }).place_of_performance_locations).toEqual([{ country: 'USA', state: 'NV', county: '003' }]);
    expect(place({ zip: '89191' }).place_of_performance_locations).toEqual([{ country: 'USA', zip: '89191' }]);
    const domestic = place({ scope: 'domestic' });
    expect(domestic.place_of_performance_scope).toBe('domestic');
    expect(domestic).not.toHaveProperty('place_of_performance_locations');
    expect(awardFilters({ ...NEVADA, naics: ['238210', '238220'] }).naics_codes).toEqual({ require: ['238210', '238220'] });
    expect(buildAwardSearch(NEVADA, 3).body).toMatchObject({ page: 3, limit: 100 });
    expect(buildTransactionSearch(NEVADA, 2, 50).body).toMatchObject({ page: 2, limit: 50 });
    expect(awardDetailUrl('CONT_AWD_36C26126P1177_3600_-NONE-_-NONE-')).toBe('https://api.usaspending.gov/api/v2/awards/CONT_AWD_36C26126P1177_3600_-NONE-_-NONE-/');
    expect(awardDetailUrl('a/b c')).toBe('https://api.usaspending.gov/api/v2/awards/a%2Fb%20c/');
  });

  it('refuses requests the API would reject or that would mean something else', () => {
    const bad = (over: Partial<AwardQuery>) => () => awardFilters({ ...NEVADA, ...over });
    expect(bad({ naics: [] })).toThrow(/NAICS/);
    expect(bad({ naics: ['electrical'] })).toThrow(/NAICS/);
    expect(bad({ place: { state: 'Nevada' } })).toThrow(/state/i);
    expect(bad({ place: { state: 'NV', county: '3' } })).toThrow(/County/);
    expect(bad({ place: { zip: '8919' } })).toThrow(/ZIP/);
    expect(bad({ startDate: '11/13/2024' })).toThrow(/YYYY-MM-DD/);
    expect(bad({ startDate: '2026-12-01' })).toThrow(/after/);
    expect(bad({ startDate: '2007-09-30' })).toThrow(/2007-10-01/);
    expect(() => buildAwardSearch(NEVADA, 1, 101)).toThrow(/limit/);
    expect(() => buildAwardSearch(NEVADA, 0)).toThrow(/page/);
    expect(() => buildAwardSearch(NEVADA, 501)).toThrow(/50000/);
  });

  it('the search window is whole calendar dates counted back in months', () => {
    expect(awardWindow(NOW, 24)).toEqual({ startDate: '2024-11-13', endDate: '2026-11-13' });
    expect(awardWindow(new Date('2026-03-31T12:00:00Z'), 1)).toEqual({ startDate: '2026-02-28', endDate: '2026-03-31' });
    expect(awardWindow(new Date('2024-03-31T12:00:00Z'), 1).startDate).toBe('2024-02-29');
    expect(awardWindow(new Date('2026-01-15T00:00:00Z'), 4).startDate).toBe('2025-09-15');
    expect(awardWindow(new Date('2026-01-15T00:00:00Z'), 12).startDate).toBe('2025-01-15');
    expect(awardWindow(NOW, 400).startDate).toBe('2007-10-01');
    expect(() => awardWindow(NOW, 0)).toThrow(/months/);
    expect(() => awardWindow(NOW, 1.5)).toThrow(/months/);
  });
});

describe('parsers on the captured pages', () => {
  it('awards: 36 Nevada awards, dates kept as strings, the current amount labelled as such', () => {
    const page = parseAwardSearch(AWARDS.response);
    expect(page).toMatchObject({ page: 1, hasNext: false, dropped: 0 });
    expect(page.rows).toHaveLength(36);
    expect(page.rows[0]).toEqual({
      generatedInternalId: 'CONT_AWD_36C26126P0882_3600_-NONE-_-NONE-', awardId: '36C26126P0882',
      recipient: 'MAYHEW TECHNOLOGY SOLUTIONS, LLC', agency: 'Department of Veterans Affairs', subAgency: 'Department of Veterans Affairs',
      naics: '238210', naicsDescription: 'ELECTRICAL CONTRACTORS AND OTHER WIRING INSTALLATION CONTRACTORS',
      psc: 'N059', pscDescription: 'INSTALLATION OF EQUIPMENT- ELECTRICAL AND ELECTRONIC EQUIPMENT COMPONENTS',
      description: 'DISTRIBUTIVE ANTENNA SYSTEM (DAS) PROJECT', awardType: 'PURCHASE ORDER',
      city: 'LAS VEGAS', county: 'CLARK', countyFips: '003', state: 'NV', zip: '89115',
      actionDate: '2026-07-01', currentAmount: 2838934.31, lastModified: '2026-07-13 15:21:37',
    });
    expect(page.rows.every((a) => /^\d{4}-\d{2}-\d{2}$/.test(a.actionDate!) && /^\d{5}$/.test(a.zip!) && a.state === 'NV')).toBe(true);
    expect(new Set(page.rows.map((a) => a.generatedInternalId)).size).toBe(36);
    const byCounty: Record<string, number> = {};
    for (const a of page.rows) byCounty[a.county!] = (byCounty[a.county!] ?? 0) + 1;
    expect(byCounty).toEqual({ CLARK: 27, WASHOE: 5, MINERAL: 1, NYE: 1, LANDER: 1, ELKO: 1 });
    expect(parseAwardCount(COUNT.response)).toBe(36);
  });

  it('transactions: 38 rows for 27 awards; the Mod 0 row is the price at award', () => {
    const page = parseTransactionSearch(TRANSACTIONS.response);
    expect(page.rows).toHaveLength(38);
    expect(page.hasNext).toBe(false);
    const prices = pricesAtAward(page.rows);
    expect(prices.size).toBe(27);
    // Signed at $175,761.00, cut by $171,261.00 six months later: the award search now shows $4,500.00.
    expect(prices.get('CONT_AWD_140P8125C0010_1443_-NONE-_-NONE-')).toEqual({ amount: 175761, actionDate: '2025-09-16' });
    expect(page.rows.find((t) => t.awardId === '140P8125C0010' && t.mod === 'P00001')).toMatchObject({ amount: -171261, actionType: 'F', actionDate: '2026-03-04' });
    const current = parseAwardSearch(AWARDS.response).rows.find((a) => a.awardId === '140P8125C0010')!;
    expect(current.currentAmount).toBe(4500);
    // A later increase does not change the price at award either.
    expect(prices.get('CONT_AWD_FA486125C0021_9700_-NONE-_-NONE-')!.amount).toBe(373508);
    expect(parseAwardSearch(AWARDS.response).rows.find((a) => a.awardId === 'FA486125C0021')!.currentAmount).toBe(389208);
  });

  it('the price at award ignores modifications, zero-dollar mods and unreadable amounts', () => {
    const row = (mod: string | null, amount: number | null, actionDate = '2026-01-10') =>
      ({ generatedInternalId: 'TEST-AWARD', awardId: 'TEST', mod, actionDate, actionType: null, amount });
    expect(pricesAtAward([row('P00001', 500), row('P00002', 0)]).size).toBe(0);
    expect(pricesAtAward([row('0', null)]).size).toBe(0);
    expect(pricesAtAward([row('P00001', -40), row('0', 1200)]).get('TEST-AWARD')).toEqual({ amount: 1200, actionDate: '2026-01-10' });
    // Two Mod 0 rows should not happen; if they do, the earliest is the award.
    expect(pricesAtAward([row('0', 900, '2026-02-01'), row('0', 700, '2026-01-05')]).get('TEST-AWARD')!.amount).toBe(700);
  });

  it('amounts arrive as JSON numbers today and as strings in the API contract: both parse', () => {
    expect(toAmount(3380)).toBe(3380);
    expect(toAmount('3380.00')).toBe(3380);
    expect(toAmount('-171261.5')).toBe(-171261.5);
    for (const junk of ['', 'abc', '1,200', null, undefined, Number.NaN, {}, '12abc']) expect(toAmount(junk)).toBeNull();
    const asStrings = { ...TRANSACTIONS.response, results: (TRANSACTIONS.response.results as Array<Record<string, unknown>>).map((r) => ({ ...r, 'Transaction Amount': String(r['Transaction Amount']) })) };
    expect(pricesAtAward(parseTransactionSearch(asStrings).rows)).toEqual(pricesAtAward(parseTransactionSearch(TRANSACTIONS.response).rows));
  });

  it('a real first page of three says there is more', () => {
    const page = parseAwardSearch(PAGE_1_OF_3.response);
    expect(page).toMatchObject({ page: 1, hasNext: true, dropped: 0 });
    expect(page.rows.map((a) => [a.awardId, a.actionDate, a.naics])).toEqual([
      ['47PD5527F0001', '2026-10-07', '236220'], ['19AQMS26P0365', '2026-09-30', '238220'], ['15F06726F0001958', '2026-09-30', '236220'],
    ]);
    // Three NAICS codes in one request, as sent live.
    expect(buildAwardSearch({ ...NEVADA, naics: ['238210', '238220', '236220'] })).toEqual({ url: 'https://api.usaspending.gov/api/v2/search/spending_by_award/', body: PAGE_1_OF_3.request });
  });

  it('one award\'s own history gives the price at award the search missed', () => {
    expect(buildAwardTransactions(FAA_ORDER)).toEqual({ url: 'https://api.usaspending.gov/api/v2/transactions/', body: HISTORY.request });
    const rows = parseAwardTransactions(HISTORY.response, FAA_ORDER);
    expect(rows).toEqual([
      { generatedInternalId: FAA_ORDER, awardId: null, mod: '0', actionDate: '2025-12-08', actionType: null, amount: 81994.29 },
      { generatedInternalId: FAA_ORDER, awardId: null, mod: 'P00001', actionDate: '2025-12-22', actionType: 'M', amount: 0 },
      { generatedInternalId: FAA_ORDER, awardId: null, mod: 'P00002', actionDate: '2026-06-04', actionType: 'D', amount: -3008.14 },
    ]);
    expect(pricesAtAward(rows).get(FAA_ORDER)).toEqual({ amount: 81994.29, actionDate: '2025-12-08' });
    // Signed at $81,994.29, cut by $3,008.14: exactly the current amount in the award search.
    const current = parseAwardSearch(AWARDS.response).rows.find((a) => a.generatedInternalId === FAA_ORDER)!.currentAmount!;
    expect(rows.reduce((sum, t) => sum + t.amount!, 0)).toBeCloseTo(current, 2);
    expect(current).toBe(78986.15);
    expect(() => buildAwardTransactions(' ')).toThrow(/award id/);
    expect(() => parseAwardTransactions({}, FAA_ORDER)).toThrow(/results/);
  });

  it('award detail: solicitation id and number of offers', () => {
    expect(parseAwardDetail(DETAIL.response)).toEqual({
      generatedInternalId: 'CONT_AWD_36C26126P1177_3600_-NONE-_-NONE-', awardId: '36C26126P1177', solicitationId: '36C26126R0050',
      offersReceived: 2, dateSigned: '2026-09-09', setAside: 'SERVICE DISABLED VETERAN OWNED SMALL BUSINESS SET-ASIDE',
      pricingType: 'FIRM FIXED PRICE', totalObligation: 55165,
    });
    expect(parseAwardDetail({ latest_transaction_contract_data: { solicitation_identifier: null, number_of_offers_received: null } }))
      .toMatchObject({ solicitationId: null, offersReceived: null, dateSigned: null });
  });

  it('survives junk: a response without results fails loudly, rows without a key are counted and dropped', () => {
    expect(() => parseAwardSearch({ detail: 'Invalid request' })).toThrow(/results/);
    expect(() => parseTransactionSearch(null)).toThrow(/results/);
    const page = parseAwardSearch({ results: [{ 'Award ID': 'X' }, null, 'junk', { generated_internal_id: 'TEST-ONLY-ID' }], page_metadata: {} });
    expect(page.dropped).toBe(3);
    expect(page.hasNext).toBe(false);
    expect(page.rows).toEqual([expect.objectContaining({ generatedInternalId: 'TEST-ONLY-ID', awardId: null, currentAmount: null, actionDate: null, zip: null, state: null })]);
    expect(parseAwardCount({ results: {} })).toBeNull();
  });
});

describe('fetcher: paging', () => {
  it('walks every page, one request each, and stops at the last', async () => {
    const { http, calls } = replay({ pageSize: 10 });
    const got = await fetchAwards(http, NEVADA);
    expect(got).toMatchObject({ pages: 4, truncated: false });
    expect(got.rows).toHaveLength(36);
    expect(calls.map((c) => c.body!.page)).toEqual([1, 2, 3, 4]);
    expect(calls.every((c) => JSON.stringify(c.body!.filters).includes('new_awards_only'))).toBe(true);
  });

  it('stops at maxPages and says the result is cut short', async () => {
    const { http, calls } = replay({ pageSize: 10 });
    const got = await fetchAwards(http, NEVADA, { maxPages: 2 });
    expect(got).toMatchObject({ pages: 2, truncated: true });
    expect(got.rows).toHaveLength(20);
    expect(calls).toHaveLength(2);
  });

  it('keeps one row per award when pages overlap', async () => {
    const rows = AWARDS.response.results as unknown[];
    const pages = [rows.slice(0, 20), rows.slice(15, 36)];
    const http: FetchLike = {
      text: async () => '',
      json: async <T>(_url: string, init?: RequestInit) => {
        const page = Number(JSON.parse(String(init!.body)).page);
        return { results: pages[page - 1], page_metadata: { page, hasNext: page < pages.length } } as T;
      },
    };
    expect((await fetchAwards(http, NEVADA)).rows).toHaveLength(36);
    expect((await fetchTransactions(replay().http, NEVADA)).rows).toHaveLength(38);
  });
});

describe('ingest', () => {
  let db: Db;
  beforeAll(async () => {
    db = await memoryDb();
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await resetDb(db);
    await db.exec('truncate table award_coverage');
  });

  const dump = () => db.query('select * from awards order by id');
  const opts = { naics: ['238210'], states: ['NV'], months: 24, now: NOW };

  it('stores every award with both amounts, kept apart', async () => {
    const { http, calls } = replay();
    const report = await refreshAwards(db, http, opts);
    expect(report).toMatchObject({
      source: 'usaspending', startDate: '2024-11-13', endDate: '2026-11-13', naics: ['238210'], requests: 3,
      totals: { fetched: 36, inserted: 36, updated: 0, withPriceAtAward: 27, withoutPriceAtAward: 9 },
    });
    expect(report.scopes).toEqual([{
      scope: 'NV', ok: true, expected: 36, fetched: 36, awardPages: 1, transactionRows: 38, transactionPages: 1,
      withPriceAtAward: 27, withoutPriceAtAward: 9, priceLookups: { asked: 0, filled: 0 }, inserted: 36, updated: 0, truncated: false,
    }]);
    expect(calls.map((c) => c.url.split('/').at(-2))).toEqual(['spending_by_award_count', 'spending_by_award', 'spending_by_transaction']);
    expect(calls[1]!.body!.filters).toEqual(AWARDS.request.filters);

    const cut = await getAward(db, awardKey('CONT_AWD_140P8125C0010_1443_-NONE-_-NONE-'));
    expect(cut).toMatchObject({
      id: 'usaspending:CONT_AWD_140P8125C0010_1443_-NONE-_-NONE-', source: 'usaspending', generatedInternalId: 'CONT_AWD_140P8125C0010_1443_-NONE-_-NONE-',
      awardId: '140P8125C0010', state: 'NV', county: 'CLARK', countyFips: '003', naics: '238210', actionDate: '2025-09-16',
      priceAtAward: 175761, currentAmount: 4500, amount: 175761, solNumber: null, offersReceived: null, detailFetchedAt: null,
      fetchedAt: NOW.toISOString(),
    });
    expect(cut!.agency).toBe('Department of the Interior');
    expect(cut!.subAgency).toBe('National Park Service');

    // The transaction capture covers Clark County only, so awards elsewhere have no price at award.
    const reno = (await listAwards(db, { naics: ['238210'], since: '2024-11-13' })).filter((a) => a.county === 'WASHOE');
    expect(reno).toHaveLength(5);
    expect(reno.every((a) => a.priceAtAward === null && a.amount === null && a.currentAmount !== null)).toBe(true);

    expect(await awardCounts(db)).toEqual([{ state: 'NV', naics: '238210', awards: 36, priced: 27, oldest: '2024-11-14', newest: '2026-09-23' }]);
    expect(await getAwardCoverage(db)).toEqual([{ scope: 'NV', naics: '238210', fromDate: '2024-11-13', toDate: '2026-11-13', refreshedAt: NOW.toISOString() }]);
  });

  it('is idempotent: running twice stores the same rows', async () => {
    const first = await refreshAwards(db, replay().http, opts);
    const before = await dump();
    const second = await refreshAwards(db, replay().http, opts);
    expect(before).toHaveLength(36);
    expect(await dump()).toEqual(before);
    expect(first.totals).toMatchObject({ inserted: 36, updated: 0 });
    expect(second.totals).toMatchObject({ fetched: 36, inserted: 0, updated: 36, withPriceAtAward: 27 });
    expect(await getAwardCoverage(db)).toHaveLength(1);
  });

  it('filters by NAICS, date and state, newest first', async () => {
    await refreshAwards(db, replay().http, opts);
    const all = await listAwards(db, { naics: ['238210'], since: '2024-11-13' });
    expect(all).toHaveLength(36);
    expect(all.map((a) => a.actionDate)).toEqual([...all.map((a) => a.actionDate)].sort().reverse());
    expect(await listAwards(db, { naics: ['238220'], since: '2024-11-13' })).toEqual([]);
    expect(await listAwards(db, { naics: ['238210'], since: '2026-01-01' })).toHaveLength(all.filter((a) => a.actionDate! >= '2026-01-01').length);
    expect(await listAwards(db, { naics: ['238210'], since: '2024-11-13', until: '2025-12-31' })).toHaveLength(all.filter((a) => a.actionDate! <= '2025-12-31').length);
    expect(await listAwards(db, { naics: ['238210', '238220'], since: '2024-11-13', states: ['CA'] })).toEqual([]);
    expect(await listAwards(db, { naics: ['238210'], since: '2024-11-13', states: ['NV', 'CA'] })).toHaveLength(36);
  });

  it('a later pull never wipes a price at award or the detail fields', async () => {
    await refreshAwards(db, replay().http, opts);
    const id = 'CONT_AWD_140P8125C0010_1443_-NONE-_-NONE-';
    await saveAwardDetail(db, id, parseAwardDetail(DETAIL.response), NOW);

    const later = new Date('2026-11-14T03:00:00Z');
    const report = await refreshAwards(db, replay({ failTransactions: true }).http, { ...opts, now: later });
    expect(report.scopes[0]).toMatchObject({ ok: false, fetched: 36, updated: 36, withPriceAtAward: 0 });
    expect(report.scopes[0]!.error).toMatch(/503/);
    expect(await getAward(db, awardKey(id))).toMatchObject({
      priceAtAward: 175761, amount: 175761, currentAmount: 4500, solNumber: '36C26126R0050', offersReceived: 2,
      dateSigned: '2026-09-09', detailFetchedAt: NOW.toISOString(), fetchedAt: later.toISOString(),
    });
  });

  it('one failed state does not stop the next, and an incomplete pull is not recorded as covered', async () => {
    let n = 0;
    const good = replay().http;
    const flaky: FetchLike = {
      text: good.text,
      json: (url, init) => (++n <= 1 ? Promise.reject(new Error('HTTP 500 for https://api.usaspending.gov/…')) : good.json(url, init)),
    };
    const report = await refreshAwards(db, flaky, { ...opts, states: ['CA', 'NV'] });
    expect(report.scopes.map((s) => [s.scope, s.ok])).toEqual([['CA', false], ['NV', true]]);
    expect(report.scopes[0]!.error).toMatch(/500/);
    expect(report.totals.fetched).toBe(36);
    expect((await getAwardCoverage(db)).map((c) => c.scope)).toEqual(['NV']);

    await db.exec('truncate table award_coverage');
    const cut = await refreshAwards(db, replay({ pageSize: 10 }).http, { ...opts, maxPages: 2 });
    expect(cut.scopes[0]).toMatchObject({ ok: false, truncated: true, fetched: 20 });
    expect(await getAwardCoverage(db)).toEqual([]);
  });

  it('refuses unknown states before sending anything', async () => {
    const { http, calls } = replay();
    await expect(refreshAwards(db, http, { ...opts, states: ['NV', 'Nevada'] })).rejects.toThrow(/Unknown state/);
    expect(calls).toHaveLength(0);
  });

  it('"US" pulls every domestic place of performance and records nationwide coverage', async () => {
    const { http, calls } = replay();
    const report = await refreshAwards(db, http, { ...opts, states: ['us'] });
    expect(report.scopes[0]).toMatchObject({ scope: 'US', ok: true });
    expect(calls[1]!.body!.filters).toMatchObject({ place_of_performance_scope: 'domestic' });
    expect((await getAwardCoverage(db))[0]).toMatchObject({ scope: 'US', naics: '238210' });
  });

  it('fills award details lazily: newest first, once per award', async () => {
    await upsertAwards(db, parseAwardSearch(AWARDS.response).rows, NOW);
    const newest = (await listAwards(db, { naics: ['238210'], since: '2024-11-13' })).map((a) => a.generatedInternalId);
    expect(await awardsMissingDetail(db, 3)).toEqual(newest.slice(0, 3));
    const { http, calls } = replay();
    expect(await fillAwardDetails(db, http, 2, NOW)).toEqual({ asked: 2, filled: 2, failed: 0 });
    expect(calls.map((c) => c.url)).toEqual(newest.slice(0, 2).map(awardDetailUrl));
    expect(await awardsMissingDetail(db, 3)).toEqual(newest.slice(2, 5));
    expect(await awardsMissingDetail(db, 100)).toHaveLength(34);
    expect(await fillAwardDetails(db, replay({ failAll: true }).http, 2, NOW)).toEqual({ asked: 2, filled: 0, failed: 2 });
    expect(await awardsMissingDetail(db, 100)).toHaveLength(34);

    const withDetails = await refreshAwards(db, replay().http, { ...opts, details: 5 });
    expect(withDetails.details).toEqual({ asked: 5, filled: 5, failed: 0 });
    expect(withDetails.requests).toBe(3 + 5);
  });

  it('looks up, one by one, the price of awards the transaction search gave no Mod 0 row for', async () => {
    const first = replay();
    const report = await refreshAwards(db, first.http, { ...opts, priceLookups: 25 });
    // 9 awards outside Clark County have no Mod 0 row in the capture; the FAA order's own history has one.
    expect(report.scopes[0]).toMatchObject({ ok: true, withPriceAtAward: 28, withoutPriceAtAward: 8, priceLookups: { asked: 9, filled: 1 } });
    expect(report.requests).toBe(3 + 9);
    expect(first.calls.slice(3).every((c) => c.url.endsWith('/api/v2/transactions/'))).toBe(true);
    expect(await getAward(db, awardKey(FAA_ORDER))).toMatchObject({ priceAtAward: 81994.29, amount: 81994.29, currentAmount: 78986.15, actionDate: '2025-12-08' });
    expect(await awardsWithoutPrice(db, [FAA_ORDER, 'TEST-NOT-STORED'])).toEqual([]);

    // Next run: each award's history is read once, so nothing is asked for again.
    const second = replay();
    const again = await refreshAwards(db, second.http, { ...opts, priceLookups: 25 });
    expect(again.scopes[0]).toMatchObject({ withPriceAtAward: 28, withoutPriceAtAward: 8, priceLookups: { asked: 0, filled: 0 } });
    expect(second.calls).toHaveLength(3);
    expect(await fetchPriceAtAward(replay().http, FAA_ORDER)).toEqual({ amount: 81994.29, actionDate: '2025-12-08' });
    expect(await fetchPriceAtAward(replay().http, 'TEST-NO-HISTORY')).toBeNull();
  });

  it('caps the one-by-one lookups per run, and tries again later when a lookup fails', async () => {
    const capped = await refreshAwards(db, replay().http, { ...opts, priceLookups: 4 });
    expect(capped.scopes[0]!.priceLookups.asked).toBe(4);
    expect(await awardsNeedingPriceLookup(db, parseAwardSearch(AWARDS.response).rows.map((a) => a.generatedInternalId), 100)).toHaveLength(9 - 4);

    // The history endpoint is down: nothing is marked as checked, so the same awards are tried next time.
    const good = replay().http;
    const historyDown: FetchLike = {
      text: good.text,
      json: (url, init) => (url.endsWith('/api/v2/transactions/') ? Promise.reject(new Error('HTTP 502 for ' + url)) : good.json(url, init)),
    };
    const failed = await refreshAwards(db, historyDown, { ...opts, priceLookups: 25 });
    expect(failed.scopes[0]).toMatchObject({ ok: true, priceLookups: { asked: 5, filled: 0 } });
    const retry = await refreshAwards(db, replay().http, { ...opts, priceLookups: 25 });
    expect(retry.scopes[0]!.priceLookups.asked).toBe(5);
    expect((await refreshAwards(db, replay().http, { ...opts, priceLookups: 25 })).scopes[0]!.priceLookups.asked).toBe(0);
  });

  it('setting prices only touches stored awards', async () => {
    await upsertAwards(db, parseAwardSearch(AWARDS.response).rows.slice(0, 2), NOW);
    const prices = new Map([['CONT_AWD_36C26126P0882_3600_-NONE-_-NONE-', { amount: 2838934.31, actionDate: '2026-07-01' }], ['TEST-NOT-STORED', { amount: 5, actionDate: null }]]);
    expect(await setPricesAtAward(db, prices)).toBe(1);
    expect((await getAward(db, awardKey('CONT_AWD_36C26126P0882_3600_-NONE-_-NONE-')))!.priceAtAward).toBe(2838934.31);
    expect(await upsertAwards(db, [], NOW)).toEqual({ inserted: 0, updated: 0 });
  });
});
