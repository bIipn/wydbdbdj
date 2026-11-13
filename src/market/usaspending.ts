/**
 * Federal award prices from the USAspending API v2 (https://api.usaspending.gov, no key).
 *
 * Request bodies are the ones that ran live on 2026-11-13 (research brief 2.1). What live data taught us:
 *  - ALWAYS send date_type "new_awards_only". Without it a 2024–2026 window returned an award signed in 2023.
 *  - "Award Amount" is the net obligated to date, NOT the price the job was awarded at. Real case:
 *    140P8125C0010 was signed at $175,761.00 and now reads $4,500.00. The price at award is the
 *    Mod "0" row of the transaction search. We keep both, as two separate labelled fields.
 *  - Dates come as "YYYY-MM-DD" strings and stay strings. Never new Date() on them.
 *
 *  - The transaction SEARCH filters every transaction on its own NAICS and place of performance, so
 *    it can return an award's later modification and not its Mod 0 row (seen live: 2 of 2,344 awards).
 *    Those few are looked up one by one in the award's own transaction history.
 *
 * Federal contracts only, the winner's amount only, about 5 days behind (Defense about 90 days).
 */
import type { Db } from '../db/db.js';
import {
  awardsMissingDetail, awardsNeedingPriceLookup, awardsWithoutPrice, markPriceChecked, recordAwardCoverage, saveAwardDetail,
  setPricesAtAward, upsertAwards,
} from '../db/market.js';
import type { Award, FetchLike } from '../types.js';
import { isStateCode } from './areas.js';

export const USASPENDING_BASE = 'https://api.usaspending.gov';
export const USASPENDING_SOURCE = 'usaspending';
/** Search periods cannot start before this date (message in every live response). */
export const EARLIEST_START_DATE = '2007-10-01';
/** Page size limit of the search endpoints. */
export const MAX_PAGE_SIZE = 100;
/** page × limit may not pass this (Elasticsearch result window). */
export const MAX_RESULT_WINDOW = 50_000;

/** The four "contracts" award types: BPA call, purchase order, delivery order, definitive contract. */
const CONTRACT_AWARD_TYPES = ['A', 'B', 'C', 'D'] as const;

export const AWARD_FIELDS = [
  'Award ID', 'Recipient Name', 'Recipient UEI', 'recipient_id', 'Award Amount', 'Total Outlays', 'Description',
  'Contract Award Type', 'Start Date', 'End Date', 'Base Obligation Date', 'Last Modified Date', 'Awarding Agency',
  'Awarding Sub Agency', 'Funding Agency', 'Funding Sub Agency', 'NAICS', 'PSC', 'Place of Performance City Code',
  'Place of Performance State Code', 'Place of Performance Zip5', 'Primary Place of Performance',
  'Recipient Location', 'generated_internal_id',
] as const;

export const TRANSACTION_FIELDS = [
  'Award ID', 'Mod', 'Action Date', 'Action Type', 'Transaction Amount', 'Transaction Description', 'Recipient Name',
  'Recipient UEI', 'Awarding Agency', 'Awarding Sub Agency', 'Award Type', 'NAICS', 'PSC',
  'Primary Place of Performance', 'Recipient Location', 'internal_id', 'generated_internal_id',
] as const;

// ------------------------------------------------------------------ types --

/** Where the work is performed. County = 3-digit FIPS and needs its state. `domestic` = anywhere in the US. */
export type AwardPlace =
  | { state: string; county?: string }
  | { zip: string }
  | { scope: 'domestic' };

export interface AwardQuery {
  /** NAICS codes, e.g. ["238210"]. */
  naics: string[];
  place: AwardPlace;
  /** YYYY-MM-DD, inclusive. Awards SIGNED in this window (new_awards_only). */
  startDate: string;
  endDate: string;
}

export interface ApiRequest {
  url: string;
  body: Record<string, unknown>;
}

/** One award as the awards search returns it. No price at award yet: that comes from the transactions. */
export interface AwardRow {
  /** USAspending's own key, e.g. "CONT_AWD_36C26126P0882_3600_-NONE-_-NONE-". */
  generatedInternalId: string;
  /** The contract number (PIID). */
  awardId: string | null;
  recipient: string | null;
  agency: string | null;
  subAgency: string | null;
  naics: string | null;
  naicsDescription: string | null;
  psc: string | null;
  pscDescription: string | null;
  description: string | null;
  /** "PURCHASE ORDER" | "DELIVERY ORDER" | "DEFINITIVE CONTRACT" | … */
  awardType: string | null;
  city: string | null;
  county: string | null;
  /** 3-digit county code within the state. */
  countyFips: string | null;
  state: string | null;
  zip: string | null;
  /** "Base Obligation Date": when the award was signed / first obligated. YYYY-MM-DD. */
  actionDate: string | null;
  /** "Award Amount": net dollars obligated to date across all modifications. NOT the price at award. */
  currentAmount: number | null;
  /** "YYYY-MM-DD HH:MM:SS" with no time zone, kept verbatim. */
  lastModified: string | null;
}

/** One row of the transaction search: the base award (Mod "0") or a later modification. */
export interface TransactionRow {
  generatedInternalId: string;
  awardId: string | null;
  mod: string | null;
  actionDate: string | null;
  actionType: string | null;
  amount: number | null;
}

export interface PriceAtAward {
  amount: number;
  /** Action date of the Mod 0 row. */
  actionDate: string | null;
}

/** Filled lazily from the award detail endpoint, one request per award. */
export interface AwardDetail {
  generatedInternalId: string | null;
  awardId: string | null;
  /** The solicitation this award came from. Can be null (e.g. some delivery orders). */
  solicitationId: string | null;
  /** How many offers the agency received: the only competition signal in this source. */
  offersReceived: number | null;
  dateSigned: string | null;
  setAside: string | null;
  pricingType: string | null;
  /** = "Award Amount" of the search (net obligated to date). */
  totalObligation: number | null;
}

/**
 * A stored federal award (table `awards`). Extends the app-wide Award:
 *  - `id` is "usaspending:<generatedInternalId>"
 *  - `amount` mirrors `priceAtAward` (the price a contractor would compare a bid with), never the current amount
 */
export interface FederalAward extends Award {
  generatedInternalId: string;
  subAgency: string | null;
  naicsDescription: string | null;
  pscDescription: string | null;
  awardType: string | null;
  countyFips: string | null;
  /** CURRENT amount: net obligated to date. Moves with every modification. */
  currentAmount: number | null;
  /** PRICE AT AWARD: the Mod 0 transaction amount. null = not known (left out of price statistics). */
  priceAtAward: number | null;
  lastModified: string | null;
  /** From the detail endpoint; null until fetched or when the source has none. */
  offersReceived: number | null;
  dateSigned: string | null;
  detailFetchedAt: string | null;
}

export const awardKey = (generatedInternalId: string): string => `${USASPENDING_SOURCE}:${generatedInternalId}`;

// -------------------------------------------------------- request builders --

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function placeFilter(place: AwardPlace): Record<string, unknown> {
  if ('scope' in place) return { place_of_performance_scope: 'domestic' };
  if ('zip' in place) {
    if (!/^\d{5}$/.test(place.zip)) throw new Error(`ZIP must be 5 digits, got "${place.zip}"`);
    return { place_of_performance_locations: [{ country: 'USA', zip: place.zip }] };
  }
  const state = place.state.toUpperCase();
  if (!isStateCode(state)) throw new Error(`Unknown state "${place.state}"`);
  if (place.county === undefined) return { place_of_performance_locations: [{ country: 'USA', state }] };
  if (!/^\d{3}$/.test(place.county)) throw new Error(`County must be a 3-digit FIPS code, got "${place.county}"`);
  return { place_of_performance_locations: [{ country: 'USA', state, county: place.county }] };
}

/** The `filters` object shared by the awards search, the count and the transaction search. */
export function awardFilters(q: AwardQuery): Record<string, unknown> {
  if (q.naics.length === 0) throw new Error('At least one NAICS code is required');
  for (const code of q.naics) if (!/^\d{2,6}$/.test(code)) throw new Error(`NAICS code must be 2–6 digits, got "${code}"`);
  for (const d of [q.startDate, q.endDate]) if (!ISO_DATE.test(d)) throw new Error(`Dates must be YYYY-MM-DD, got "${d}"`);
  if (q.startDate > q.endDate) throw new Error(`startDate ${q.startDate} is after endDate ${q.endDate}`);
  if (q.startDate < EARLIEST_START_DATE) throw new Error(`startDate cannot be before ${EARLIEST_START_DATE}`);
  return {
    award_type_codes: [...CONTRACT_AWARD_TYPES],
    naics_codes: { require: [...q.naics] },
    ...placeFilter(q.place),
    time_period: [{ start_date: q.startDate, end_date: q.endDate, date_type: 'new_awards_only' }],
  };
}

function checkPage(page: number, limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new Error(`limit must be 1–${MAX_PAGE_SIZE}, got ${limit}`);
  if (!Number.isInteger(page) || page < 1) throw new Error(`page must be 1 or more, got ${page}`);
  if (page * limit > MAX_RESULT_WINDOW) throw new Error(`page × limit cannot pass ${MAX_RESULT_WINDOW}`);
}

/** One page of awards, newest first. */
export function buildAwardSearch(q: AwardQuery, page = 1, limit = MAX_PAGE_SIZE): ApiRequest {
  checkPage(page, limit);
  return {
    url: `${USASPENDING_BASE}/api/v2/search/spending_by_award/`,
    body: { subawards: false, limit, page, sort: 'Base Obligation Date', order: 'desc', filters: awardFilters(q), fields: [...AWARD_FIELDS] },
  };
}

/** One page of transactions (base awards and their modifications), newest first. */
export function buildTransactionSearch(q: AwardQuery, page = 1, limit = MAX_PAGE_SIZE): ApiRequest {
  checkPage(page, limit);
  return {
    url: `${USASPENDING_BASE}/api/v2/search/spending_by_transaction/`,
    body: { limit, page, sort: 'Action Date', order: 'desc', filters: awardFilters(q), fields: [...TRANSACTION_FIELDS] },
  };
}

/** How many awards match: a cheap check that paging fetched everything. */
export function buildAwardCount(q: AwardQuery): ApiRequest {
  return { url: `${USASPENDING_BASE}/api/v2/search/spending_by_award_count/`, body: { filters: awardFilters(q) } };
}

export function awardDetailUrl(generatedInternalId: string): string {
  return `${USASPENDING_BASE}/api/v2/awards/${encodeURIComponent(generatedInternalId)}/`;
}

/** One award's own transaction history, oldest first: the base award (Mod 0) is on the first page. Ran live 2026-11-13. */
export function buildAwardTransactions(generatedInternalId: string): ApiRequest {
  if (!generatedInternalId.trim()) throw new Error('An award id is required');
  return {
    url: `${USASPENDING_BASE}/api/v2/transactions/`,
    body: { award_id: generatedInternalId, limit: 50, page: 1, sort: 'action_date', order: 'asc' },
  };
}

/**
 * The search window for "the last N months": from the same day N months back (clamped to the
 * month's length and to the API's earliest date) through today, both as UTC calendar dates.
 */
export function awardWindow(now: Date, months: number): { startDate: string; endDate: string } {
  if (!Number.isInteger(months) || months < 1) throw new Error(`months must be a whole number of 1 or more, got ${months}`);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const d = now.getUTCDate();
  const back = y * 12 + (m - 1) - months;
  const [sy, sm] = [Math.floor(back / 12), (back % 12) + 1];
  const lastDay = new Date(Date.UTC(sy, sm, 0)).getUTCDate();
  const start = ymd(sy, sm, Math.min(d, lastDay));
  return { startDate: start < EARLIEST_START_DATE ? EARLIEST_START_DATE : start, endDate: ymd(y, m, d) };
}

const ymd = (y: number, m: number, d: number): string => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// ---------------------------------------------------------------- parsers --

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const isoDate = (v: unknown): string | null => (typeof v === 'string' && ISO_DATE.test(v) ? v : null);

/** A JSON number, or a numeric string (the contract doc says amounts are strings; live they are numbers). */
export function toAmount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !/^-?\d+(\.\d+)?$/.test(v.trim())) return null;
  return Number(v.trim());
}

export interface Page<T> {
  rows: T[];
  page: number | null;
  hasNext: boolean;
  /** Rows dropped because they carried no generated_internal_id. */
  dropped: number;
}

function pageOf(json: unknown): { results: unknown[]; page: number | null; hasNext: boolean } {
  const top = rec(json);
  if (!Array.isArray(top.results)) throw new Error('USAspending: response has no "results" list');
  const meta = rec(top.page_metadata);
  return { results: top.results, page: typeof meta.page === 'number' ? meta.page : null, hasNext: meta.hasNext === true };
}

/** A response of POST /api/v2/search/spending_by_award/ → typed awards. */
export function parseAwardSearch(json: unknown): Page<AwardRow> {
  const { results, page, hasNext } = pageOf(json);
  const rows: AwardRow[] = [];
  for (const raw of results) {
    const r = rec(raw);
    const id = str(r.generated_internal_id);
    if (!id) continue;
    const place = rec(r['Primary Place of Performance']);
    const [naics, psc] = [rec(r.NAICS), rec(r.PSC)];
    const zip = str(place.zip5) ?? str(r['Place of Performance Zip5']);
    const county = str(place.county_code);
    rows.push({
      generatedInternalId: id,
      awardId: str(r['Award ID']),
      recipient: str(r['Recipient Name']),
      agency: str(r['Awarding Agency']),
      subAgency: str(r['Awarding Sub Agency']),
      naics: str(naics.code),
      naicsDescription: str(naics.description),
      psc: str(psc.code),
      pscDescription: str(psc.description),
      description: str(r.Description),
      awardType: str(r['Contract Award Type']),
      city: str(place.city_name),
      county: str(place.county_name),
      countyFips: county && /^\d{3}$/.test(county) ? county : null,
      // zip5 and state_code only: zip4 is 9 digits in some rows and 4 in others, state_name casing varies.
      state: (str(place.state_code) ?? str(r['Place of Performance State Code']))?.toUpperCase() ?? null,
      zip: zip && /^\d{5}$/.test(zip) ? zip : null,
      actionDate: isoDate(r['Base Obligation Date']),
      currentAmount: toAmount(r['Award Amount']),
      lastModified: str(r['Last Modified Date']),
    });
  }
  return { rows, page, hasNext, dropped: results.length - rows.length };
}

/** A response of POST /api/v2/search/spending_by_transaction/ → typed transactions. */
export function parseTransactionSearch(json: unknown): Page<TransactionRow> {
  const { results, page, hasNext } = pageOf(json);
  const rows: TransactionRow[] = [];
  for (const raw of results) {
    const r = rec(raw);
    const id = str(r.generated_internal_id);
    if (!id) continue;
    const mod = r.Mod;
    rows.push({
      generatedInternalId: id,
      awardId: str(r['Award ID']),
      mod: typeof mod === 'number' ? String(mod) : str(mod),
      actionDate: isoDate(r['Action Date']),
      actionType: str(r['Action Type']),
      amount: toAmount(r['Transaction Amount']),
    });
  }
  return { rows, page, hasNext, dropped: results.length - rows.length };
}

/**
 * The price each award was signed at: its Mod "0" transaction amount, keyed by generated_internal_id.
 * Later modifications are ignored. If an award somehow has two Mod 0 rows, the earliest one wins.
 */
export function pricesAtAward(transactions: readonly TransactionRow[]): Map<string, PriceAtAward> {
  const out = new Map<string, PriceAtAward>();
  for (const t of transactions) {
    if (t.mod !== '0' || t.amount === null) continue;
    const seen = out.get(t.generatedInternalId);
    if (seen && (seen.actionDate ?? '') <= (t.actionDate ?? '')) continue;
    out.set(t.generatedInternalId, { amount: t.amount, actionDate: t.actionDate });
  }
  return out;
}

/**
 * A response of POST /api/v2/transactions/ (one award's history) → the same typed rows as the search.
 * Field names differ here: modification_number, action_date, federal_action_obligation.
 */
export function parseAwardTransactions(json: unknown, generatedInternalId: string): TransactionRow[] {
  const { results } = pageOf(json);
  return results.map((raw) => {
    const r = rec(raw);
    const mod = r.modification_number;
    return {
      generatedInternalId,
      awardId: null,
      mod: typeof mod === 'number' ? String(mod) : str(mod),
      actionDate: isoDate(r.action_date),
      actionType: str(r.action_type),
      amount: toAmount(r.federal_action_obligation),
    };
  });
}

/** A response of POST /api/v2/search/spending_by_award_count/ → the number of contract awards. */
export function parseAwardCount(json: unknown): number | null {
  const n = rec(rec(json).results).contracts;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
}

/** A response of GET /api/v2/awards/{generated_internal_id}/ → the fields we keep. */
export function parseAwardDetail(json: unknown): AwardDetail {
  const top = rec(json);
  const tx = rec(top.latest_transaction_contract_data);
  const offers = toAmount(tx.number_of_offers_received);
  return {
    generatedInternalId: str(top.generated_unique_award_id),
    awardId: str(top.piid),
    solicitationId: str(tx.solicitation_identifier),
    offersReceived: offers !== null && Number.isInteger(offers) && offers >= 0 ? offers : null,
    dateSigned: isoDate(top.date_signed),
    setAside: str(tx.type_set_aside_description),
    pricingType: str(tx.type_of_contract_pricing_description),
    totalObligation: toAmount(top.total_obligation),
  };
}

// ---------------------------------------------------------------- fetcher --

const postJson = (http: FetchLike, req: ApiRequest): Promise<unknown> =>
  http.json(req.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });

export interface FetchOptions {
  /** Safety stop. Default: as many pages as the API's result window allows. */
  maxPages?: number;
  log?: (msg: string) => void;
}

export interface Fetched<T> {
  rows: T[];
  pages: number;
  /** True when we stopped at maxPages with more pages left. */
  truncated: boolean;
}

/**
 * Walk the pages of a search one request at a time (the http client paces them). Stops at the last
 * page, at an empty page, or at maxPages. Never retries by itself.
 */
async function fetchPages<T>(
  http: FetchLike,
  build: (page: number) => ApiRequest,
  parse: (json: unknown) => Page<T>,
  opts: FetchOptions,
): Promise<Fetched<T>> {
  const maxPages = Math.min(opts.maxPages ?? Infinity, MAX_RESULT_WINDOW / MAX_PAGE_SIZE);
  const rows: T[] = [];
  let pages = 0;
  for (let page = 1; page <= maxPages; page++) {
    const parsed = parse(await postJson(http, build(page)));
    pages = page;
    rows.push(...parsed.rows);
    if (!parsed.hasNext || parsed.rows.length === 0) return { rows, pages, truncated: false };
  }
  return { rows, pages, truncated: true };
}

/** Every award matching the query, one row per award (pages can overlap when rows tie on the sort date). */
export async function fetchAwards(http: FetchLike, q: AwardQuery, opts: FetchOptions = {}): Promise<Fetched<AwardRow>> {
  const got = await fetchPages(http, (page) => buildAwardSearch(q, page), parseAwardSearch, opts);
  const byId = new Map(got.rows.map((r) => [r.generatedInternalId, r]));
  return { ...got, rows: [...byId.values()] };
}

/** Every transaction of the awards matching the query (needed for the Mod 0 price at award). */
export function fetchTransactions(http: FetchLike, q: AwardQuery, opts: FetchOptions = {}): Promise<Fetched<TransactionRow>> {
  return fetchPages(http, (page) => buildTransactionSearch(q, page), parseTransactionSearch, opts);
}

export async function fetchAwardCount(http: FetchLike, q: AwardQuery): Promise<number | null> {
  return parseAwardCount(await postJson(http, buildAwardCount(q)));
}

/** The price one award was signed at, from its own transaction history. null = it has no Mod 0 row there either. */
export async function fetchPriceAtAward(http: FetchLike, generatedInternalId: string): Promise<PriceAtAward | null> {
  const rows = parseAwardTransactions(await postJson(http, buildAwardTransactions(generatedInternalId)), generatedInternalId);
  return pricesAtAward(rows).get(generatedInternalId) ?? null;
}

export async function fetchAwardDetail(http: FetchLike, generatedInternalId: string): Promise<AwardDetail> {
  return parseAwardDetail(await http.json(awardDetailUrl(generatedInternalId)));
}

// ----------------------------------------------------------------- ingest --

/** "US" = every domestic place of performance; anything else must be a 2-letter state code. */
export const NATIONWIDE = 'US';

export interface RefreshAwardsOptions {
  naics: string[];
  /** 2-letter state codes and/or "US" (nationwide). */
  states: string[];
  /** How far back to pull awards signed, in months. */
  months: number;
  now?: Date;
  /** Look up solicitation id + offers received for up to this many of the newest awards that lack them. Default 0. */
  details?: number;
  /**
   * Per state: for up to this many awards the transaction search gave no Mod 0 row for, look the
   * price up in the award's own history (one request each, once per award ever). Default 0.
   */
  priceLookups?: number;
  maxPages?: number;
  log?: (msg: string) => void;
}

export interface AwardsScopeReport {
  /** State code or "US". */
  scope: string;
  ok: boolean;
  error?: string;
  /** What the count endpoint said. null = the count call failed or was unreadable. */
  expected: number | null;
  fetched: number;
  awardPages: number;
  transactionRows: number;
  transactionPages: number;
  withPriceAtAward: number;
  withoutPriceAtAward: number;
  /** Awards whose price at award came from their own transaction history, of those looked up one by one. */
  priceLookups: { asked: number; filled: number };
  inserted: number;
  updated: number;
  /** A paging safety stop was hit: the scope is incomplete and is not recorded as covered. */
  truncated: boolean;
}

export interface AwardsRefreshReport {
  source: typeof USASPENDING_SOURCE;
  startDate: string;
  endDate: string;
  naics: string[];
  scopes: AwardsScopeReport[];
  totals: { fetched: number; inserted: number; updated: number; withPriceAtAward: number; withoutPriceAtAward: number };
  details: { asked: number; filled: number; failed: number };
  /** HTTP requests sent to api.usaspending.gov. */
  requests: number;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Pull awards signed in the last `months` for each state (place of performance) and store them.
 * Upserts on generated_internal_id, so running it again changes nothing but fresh values.
 * One failed state never stops the others. Requests go out one at a time.
 */
export async function refreshAwards(db: Db, http: FetchLike, opts: RefreshAwardsOptions): Promise<AwardsRefreshReport> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const { startDate, endDate } = awardWindow(now, opts.months);
  const naics = [...new Set(opts.naics)];
  const scopes = [...new Set(opts.states.map((s) => s.trim().toUpperCase()))];
  for (const s of scopes) if (s !== NATIONWIDE && !isStateCode(s)) throw new Error(`Unknown state "${s}" (use 2-letter codes, or ${NATIONWIDE} for nationwide)`);

  let requests = 0;
  const counted: FetchLike = {
    text: (url, init) => (requests++, http.text(url, init)),
    json: (url, init) => (requests++, http.json(url, init)),
  };

  const report: AwardsRefreshReport = {
    source: USASPENDING_SOURCE, startDate, endDate, naics, scopes: [],
    totals: { fetched: 0, inserted: 0, updated: 0, withPriceAtAward: 0, withoutPriceAtAward: 0 },
    details: { asked: 0, filled: 0, failed: 0 },
    requests: 0,
  };

  for (const scope of scopes) {
    const q: AwardQuery = { naics, place: scope === NATIONWIDE ? { scope: 'domestic' } : { state: scope }, startDate, endDate };
    const r: AwardsScopeReport = {
      scope, ok: false, expected: null, fetched: 0, awardPages: 0, transactionRows: 0, transactionPages: 0,
      withPriceAtAward: 0, withoutPriceAtAward: 0, priceLookups: { asked: 0, filled: 0 }, inserted: 0, updated: 0, truncated: false,
    };
    report.scopes.push(r);
    try {
      r.expected = await fetchAwardCount(counted, q);
      const awards = await fetchAwards(counted, q, opts);
      r.fetched = awards.rows.length;
      r.awardPages = awards.pages;
      r.truncated = awards.truncated;
      log(`${scope}: ${r.fetched} awards in ${r.awardPages} page(s)${r.expected === null ? '' : ` (count endpoint says ${r.expected})`}`);

      // Store the awards first: if the transaction pass fails they are still there, just without a new price.
      const stored = await upsertAwards(db, awards.rows, now);
      r.inserted = stored.inserted;
      r.updated = stored.updated;

      const tx = await fetchTransactions(counted, q, opts);
      r.transactionRows = tx.rows.length;
      r.transactionPages = tx.pages;
      r.truncated ||= tx.truncated;
      const prices = pricesAtAward(tx.rows);
      await setPricesAtAward(db, prices);
      log(`${scope}: ${r.transactionRows} transactions in ${r.transactionPages} page(s); Mod 0 row for ${awards.rows.filter((a) => prices.has(a.generatedInternalId)).length} of ${r.fetched}`);

      // The search missed the Mod 0 row for a few: read those awards' own history, once each.
      const fetchedIds = awards.rows.map((a) => a.generatedInternalId);
      for (const id of await awardsNeedingPriceLookup(db, fetchedIds, opts.priceLookups ?? 0)) {
        r.priceLookups.asked++;
        try {
          const price = await fetchPriceAtAward(counted, id);
          await markPriceChecked(db, id, now);
          if (!price) continue;
          await setPricesAtAward(db, new Map([[id, price]]));
          r.priceLookups.filled++;
        } catch (err) {
          // Not marked as checked: the next refresh tries this award again.
          log(`${scope}: price lookup for ${id} failed — ${message(err)}`);
        }
      }
      r.withoutPriceAtAward = (await awardsWithoutPrice(db, fetchedIds)).length;
      r.withPriceAtAward = r.fetched - r.withoutPriceAtAward;
      if (r.priceLookups.asked) log(`${scope}: looked up ${r.priceLookups.asked} award(s) one by one, found the price at award for ${r.priceLookups.filled}`);

      if (!r.truncated) await recordAwardCoverage(db, scope, naics, startDate, endDate, now);
      r.ok = !r.truncated;
      if (r.truncated) r.error = 'stopped at the page limit: this scope is incomplete';
    } catch (err) {
      r.error = message(err);
      log(`${scope}: FAILED — ${r.error}`);
    }
    for (const k of ['fetched', 'inserted', 'updated', 'withPriceAtAward', 'withoutPriceAtAward'] as const) report.totals[k] += r[k];
  }

  if (opts.details && opts.details > 0) report.details = await fillAwardDetails(db, counted, opts.details, now, log);
  report.requests = requests;
  return report;
}

/**
 * Lazy fill: fetch the detail record (solicitation id, offers received) for up to `limit` of the
 * newest awards that have never been looked up. One request per award; a failure is counted and skipped.
 */
export async function fillAwardDetails(
  db: Db, http: FetchLike, limit: number, now: Date = new Date(), log: (msg: string) => void = () => {},
): Promise<{ asked: number; filled: number; failed: number }> {
  const ids = await awardsMissingDetail(db, limit);
  let filled = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await saveAwardDetail(db, id, await fetchAwardDetail(http, id), now);
      filled++;
    } catch (err) {
      failed++;
      log(`detail ${id}: FAILED — ${message(err)}`);
    }
  }
  return { asked: ids.length, filled, failed };
}
