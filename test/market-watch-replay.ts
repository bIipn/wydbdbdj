/**
 * Replays for the price and award watcher. The "before" state is always the REAL captured responses in
 * test/fixtures (USAspending 2026-11-13, BLS 2026-11-13). The "after" state adds ONE plainly synthetic
 * item on top of them, never edits a real one:
 *   - a next period (2026-M10) for one real price index, with a value worked out from the real
 *     September figure and a chosen percent (it is not a BLS number: the tests say so), or
 *   - one award with TEST- ids, a "(simulated)" recipient and a TEST- solicitation number.
 * Nothing here talks to the network.
 */
import type { MarketHttp } from '../src/market/refresh.js';
import type { FetchLike } from '../src/types.js';
import { fx } from './helpers.js';

const capture = (file: string) => JSON.parse(fx(file)) as { response: Record<string, unknown> };

type RawObs = { year: string; period: string; periodName?: string; latest?: string; value: string; footnotes: unknown[] };
type RawSeries = { seriesID: string; data: RawObs[] };

/** Every REAL BLS series in the captures, by id (data newest first, as BLS sends it). */
export const REAL_BLS: ReadonlyMap<string, RawSeries> = new Map(
  ['bls-oews-electricians.json', 'bls-oews-electricians-percentiles.json', 'bls-ppi-core.json']
    .flatMap((f) => (capture(f).response.Results as { series: RawSeries[] }).series.map((s) => [s.seriesID, s] as const)),
);

/** The real copper wire and cable index (BLS PPI WPU10260314); latest in the capture: Sep 2026, 607.705 (preliminary). */
export const COPPER = 'WPU10260314';
export const realLatest = (seriesId: string): { period: string; value: number } => {
  const o = REAL_BLS.get(seriesId)!.data[0]!;
  return { period: `${o.year}-${o.period}`, value: Number(o.value) };
};

/** SYNTHETIC: a value `pct` percent above (or below) the real latest figure, to 3 decimals like BLS publishes. */
export const syntheticNext = (seriesId: string, pct: number): string => (realLatest(seriesId).value * (1 + pct / 100)).toFixed(3);

export interface BlsReplayOptions {
  /** SYNTHETIC next period for some series: series id → value (October 2026, marked preliminary like BLS does). */
  next?: Record<string, string>;
  /** SYNTHETIC revision of an existing period: series id → { period "M08", value }. */
  revise?: Record<string, { period: string; value: string }>;
}

/** Replays the captured BLS series (plus any synthetic additions); a series not captured gets BLS's own "no data" wording. */
export function blsReplay(opts: BlsReplayOptions = {}): FetchLike & { calls: number } {
  const http = {
    calls: 0,
    text: async () => '',
    json: async <T>(_url: string, init?: RequestInit) => {
      http.calls++;
      const body = JSON.parse(String(init!.body)) as { seriesid: string[]; endyear: string };
      const series = body.seriesid.map((id) => {
        const real = REAL_BLS.get(id);
        if (!real) return { seriesID: id, data: [] };
        let data = real.data.map((o) => ({ ...o }));
        const revision = opts.revise?.[id];
        if (revision) data = data.map((o) => (o.year === '2026' && o.period === revision.period ? { ...o, value: revision.value } : o));
        const next = opts.next?.[id];
        if (next) {
          data = [{
            year: '2026', period: 'M10', periodName: 'October', latest: 'true', value: next,
            footnotes: [{ code: 'P', text: 'Preliminary. (SYNTHETIC test value, not published by BLS)' }],
          }, ...data.map(({ latest: _l, ...o }) => o)];
        }
        return { seriesID: id, data };
      });
      const message = body.seriesid.filter((id) => !REAL_BLS.has(id)).map((id) => `No Data Available for Series ${id} Year: ${body.endyear}`);
      return { status: 'REQUEST_SUCCEEDED', message, Results: { series } } as T;
    },
  };
  return http;
}

const AWARDS = capture('usaspending-awards-nv-238210.json').response;
const TRANSACTIONS = capture('usaspending-transactions-clark-238210.json').response;
const COUNT = capture('usaspending-award-count-nv-238210.json').response;

/** A SYNTHETIC award (TEST- ids, "(simulated)" winner) for the "after" state. */
export interface SyntheticAward {
  generatedInternalId: string;
  piid: string;
  solicitation: string;
  recipient: string;
  amount: number;
  actionDate: string;
  zip: string;
  city: string;
  countyCode: string;
  countyName: string;
  description: string;
}

export function syntheticAward(over: Partial<SyntheticAward> = {}): SyntheticAward {
  return {
    generatedInternalId: 'CONT_AWD_TEST-AWARD-0001_TEST_-NONE-_-NONE-',
    piid: 'TEST-AWARD-0001',
    solicitation: 'TEST-SOL-0001',
    recipient: 'TEST ELECTRIC LLC (SIMULATED)',
    amount: 41_250,
    actionDate: '2026-11-09',
    zip: '89701',
    city: 'CARSON CITY',
    countyCode: '510',
    countyName: 'CARSON CITY',
    description: 'TEST LIGHTING RETROFIT (SYNTHETIC)',
    ...over,
  };
}

function awardRow(a: SyntheticAward): Record<string, unknown> {
  return {
    internal_id: 0, 'Award ID': a.piid, 'Recipient Name': a.recipient, 'Award Amount': a.amount, 'Total Outlays': null,
    Description: a.description, 'Contract Award Type': 'PURCHASE ORDER', 'Start Date': a.actionDate, 'End Date': null,
    'Base Obligation Date': a.actionDate, 'Last Modified Date': `${a.actionDate} 12:00:00`,
    'Awarding Agency': 'TEST Agency (simulated)', 'Awarding Sub Agency': 'TEST Agency (simulated)',
    NAICS: { code: '238210', description: 'ELECTRICAL CONTRACTORS AND OTHER WIRING INSTALLATION CONTRACTORS' },
    PSC: { code: 'TEST', description: 'TEST (synthetic)' },
    'Place of Performance State Code': 'NV', 'Place of Performance Zip5': a.zip,
    'Primary Place of Performance': {
      location_country_code: 'USA', state_code: 'NV', state_name: 'Nevada', city_name: a.city,
      county_code: a.countyCode, county_name: a.countyName, zip5: a.zip,
    },
    generated_internal_id: a.generatedInternalId,
  };
}

function transactionRow(a: SyntheticAward): Record<string, unknown> {
  return {
    'Award ID': a.piid, Mod: '0', 'Action Date': a.actionDate, 'Action Type': null, 'Transaction Amount': a.amount,
    'Transaction Description': a.description, 'Recipient Name': a.recipient, generated_internal_id: a.generatedInternalId,
  };
}

/**
 * Replays the captured USAspending pages for Nevada, NAICS 238210, plus `extra` synthetic awards.
 * The detail endpoint answers only for a synthetic award (its TEST- solicitation number); for a real
 * one it fails, which the refresh counts and skips. `fail` = every request throws (an outage).
 */
export function awardsReplay(opts: { extra?: SyntheticAward[]; fail?: boolean } = {}): FetchLike & { calls: string[] } {
  const extra = opts.extra ?? [];
  const calls: string[] = [];
  const page = <T>(base: Record<string, unknown>, rows: unknown[]): T =>
    ({ ...base, results: [...(base.results as unknown[]), ...rows] }) as T;
  return {
    calls,
    text: async () => '',
    json: async <T>(url: string) => {
      calls.push(url);
      if (opts.fail) throw new Error('HTTP 503 Service Unavailable (TEST outage)');
      if (url.endsWith('/spending_by_award_count/')) {
        const results = COUNT.results as Record<string, number>;
        return { ...COUNT, results: { ...results, contracts: results.contracts! + extra.length } } as T;
      }
      if (url.endsWith('/spending_by_award/')) return page<T>(AWARDS, extra.map(awardRow));
      if (url.endsWith('/spending_by_transaction/')) return page<T>(TRANSACTIONS, extra.map(transactionRow));
      if (url.endsWith('/api/v2/transactions/')) return { page_metadata: { page: 1, hasNext: false }, results: [] } as T;
      const detail = /\/api\/v2\/awards\/([^/]+)\/$/.exec(url);
      if (detail) {
        const a = extra.find((x) => x.generatedInternalId === decodeURIComponent(detail[1]!));
        if (!a) throw new Error('not in this replay');
        return {
          generated_unique_award_id: a.generatedInternalId, piid: a.piid, date_signed: a.actionDate, total_obligation: a.amount,
          latest_transaction_contract_data: { solicitation_identifier: a.solicitation, number_of_offers_received: '3' },
        } as T;
      }
      throw new Error(`unexpected request ${url}`);
    },
  };
}

export const replay = (awards: FetchLike, bls: FetchLike): MarketHttp => ({ awards, bls });
