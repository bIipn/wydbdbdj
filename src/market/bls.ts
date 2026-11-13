/**
 * Wages by area (OEWS) and material price indexes (PPI) from the BLS Public Data API.
 *
 * What live calls on 2026-11-13 taught us (research brief 2.2):
 *  - `status` stays "REQUEST_SUCCEEDED" when individual series fail. Failures only show up in
 *    `message[]` ("Series does not exist for Series X", "No Data Available for Series X Year: YYYY"),
 *    so every message is read and pinned to its series.
 *  - `value` is a string, `data` is newest first, OEWS comes back as year 2025 / period A01, and
 *    preliminary PPI rows carry footnote code "P".
 *  - Without a key: 25 queries a day, 25 series a query. With BLS_API_KEY (v2): 500 a day, 50 a query.
 *
 * BLS is never called from a request path: a refresh stores the values, routes read the database.
 * PPI values are national INDEXES, not dollar prices. An OEWS wage is neither a prevailing wage nor a loaded rate.
 */
import type { Db } from '../db/db.js';
import {
  getSeries, listSeriesMeta, markSeriesFailed, saveSeries,
  type Observation, type SeriesMeta, type StoredObservation, type StoredSeries,
} from '../db/market.js';
import type { FetchLike } from '../types.js';
import { NATION_AREA, VERIFIED_OEWS_AREAS, metroAreaCode, oewsRefreshAreas, stateArea, type OewsArea } from './areas.js';

export const BLS_V1_URL = 'https://api.bls.gov/publicAPI/v1/timeseries/data/';
export const BLS_V2_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
/** Series per query and queries per day, without and with a registration key. */
export const BLS_LIMITS = { v1: { seriesPerQuery: 25, queriesPerDay: 25, years: 10 }, v2: { seriesPerQuery: 50, queriesPerDay: 500, years: 20 } } as const;

/** BLS asks every app that shows its data to carry this line, with the date the data was retrieved. */
export const BLS_DISCLAIMER = 'BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov.';

export const OEWS_SOURCE = 'BLS Occupational Employment and Wage Statistics (OEWS)';
export const OEWS_SOURCE_URL = 'https://www.bls.gov/oes/';
export const PPI_SOURCE = 'BLS Producer Price Index (PPI)';
export const PPI_SOURCE_URL = 'https://www.bls.gov/ppi/';

// ------------------------------------------------------------ what we ask --

export interface PpiSeriesDef {
  seriesId: string;
  /** Short name for a card. */
  label: string;
  /** The BLS title. */
  title: string;
}

/** The nine material and price indexes an electrical contractor watches. Every id returned data live. */
export const PPI_SERIES: readonly PpiSeriesDef[] = [
  { seriesId: 'WPU10260314', label: 'Copper wire and cable', title: 'Metals and metal products: Copper wire and cable' },
  { seriesId: 'WPU11710216', label: 'Conduit and conduit fittings', title: 'Machinery and equipment: Noncurrent-carrying electrical conduit and conduit fittings, including plastic conduit and fittings' },
  { seriesId: 'WPU117522', label: 'Switchgear and switchboard apparatus', title: 'Machinery and equipment: Switchgear and switchboard apparatus' },
  { seriesId: 'PCU3353133353133', label: 'Low-voltage panelboards', title: 'Switchgear and switchboard apparatus manufacturing: Low voltage panelboards and distribution boards, 1000 volts or less' },
  { seriesId: 'WPU108303', label: 'Commercial and industrial lighting fixtures', title: 'Commercial, institutional and industrial electric lighting fixtures' },
  { seriesId: 'WPU1174', label: 'Transformers and power regulators', title: 'Machinery and equipment: Transformers and power regulators' },
  { seriesId: 'WPU1171', label: 'Wiring devices', title: 'Machinery and equipment: Wiring devices' },
  { seriesId: 'WPUIP2312001', label: 'Inputs to nonresidential construction, goods', title: 'Net inputs to nonresidential construction, goods' },
  { seriesId: 'PCU23821X23821X', label: 'Electrical contractors, nonresidential work (what subs charge)', title: 'Electrical contractors, nonresidential building work' },
];

/** OEWS data type codes for the hourly wage figures we keep. */
export const OEWS_MEASURES = { mean: '03', p25: '07', median: '08', p75: '09' } as const;
export type OewsMeasure = keyof typeof OEWS_MEASURES;
const MEASURE_LABEL: Record<OewsMeasure, string> = { mean: 'mean', median: 'median', p25: '25th percentile', p75: '75th percentile' };

/** Occupations (SOC code without the dash) whose series returned data live. */
export const OCCUPATIONS: Readonly<Record<string, string>> = { '472111': 'Electricians' };
export const ELECTRICIANS = '472111';
/** Trade id (src/trades/catalog.ts) → the occupation whose wage we show for it. */
export const TRADE_SOC: Readonly<Record<string, string>> = { electrical: ELECTRICIANS };

/** "47-2111" or "472111" → "472111". Throws on anything else. */
export function normalizeSoc(soc: string): string {
  const digits = soc.replace(/-/g, '');
  if (!/^\d{6}$/.test(digits)) throw new Error(`SOC code must be 6 digits like 47-2111, got "${soc}"`);
  return digits;
}

export interface OewsSeriesSpec {
  /** N national, S state, M metropolitan or nonmetropolitan area. */
  areaType: 'N' | 'S' | 'M';
  /** 7 characters: "0000000" nation, state FIPS + "00000", "00" + CBSA for a metro. */
  areaCode: string;
  /** SOC occupation code, with or without the dash. */
  soc: string;
  /** 2-digit data type, e.g. "03" hourly mean, "08" hourly median. */
  datatype: string;
  /** 6 digits. "000000" = all industries, all ownerships (the default). */
  industry?: string;
}

/**
 * OEWS series id, 25 characters: "OE" + "U" (not seasonally adjusted) + area type + area (7) +
 * industry (6) + occupation (6) + data type (2). Reno electricians, hourly mean:
 * OE U M 0039900 000000 472111 03 → "OEUM003990000000047211103".
 */
export function oewsSeriesId(spec: OewsSeriesSpec): string {
  const industry = spec.industry ?? '000000';
  if (!['N', 'S', 'M'].includes(spec.areaType)) throw new Error(`OEWS area type must be N, S or M, got "${spec.areaType}"`);
  if (!/^\d{7}$/.test(spec.areaCode)) throw new Error(`OEWS area code must be 7 digits, got "${spec.areaCode}"`);
  if (!/^\d{6}$/.test(industry)) throw new Error(`OEWS industry code must be 6 digits, got "${industry}"`);
  if (!/^\d{2}$/.test(spec.datatype)) throw new Error(`OEWS data type must be 2 digits, got "${spec.datatype}"`);
  return `OEU${spec.areaType}${spec.areaCode}${industry}${normalizeSoc(spec.soc)}${spec.datatype}`;
}

const wageSeriesId = (area: Pick<OewsArea, 'areaType' | 'areaCode'>, soc: string, measure: OewsMeasure): string =>
  oewsSeriesId({ areaType: area.areaType, areaCode: area.areaCode, soc, datatype: OEWS_MEASURES[measure] });

const occupationName = (soc: string): string => OCCUPATIONS[soc] ?? `SOC ${soc.slice(0, 2)}-${soc.slice(2)}`;

// ----------------------------------------------------------------- parser --

export interface BlsObservation {
  year: string;
  /** BLS period code: "M01".."M12" monthly, "M13" annual average, "A01" annual. */
  period: string;
  periodName: string | null;
  value: number;
  /** The value exactly as published, e.g. "36.40". */
  raw: string;
  /** Footnote code "P": preliminary, will be revised. */
  preliminary: boolean;
  footnoteCodes: string[];
}

/** ok = has observations. not_found = BLS says the series does not exist. no_data = exists (or unknown) but nothing came back. */
export type BlsSeriesStatus = 'ok' | 'not_found' | 'no_data';

export interface BlsSeries {
  seriesId: string;
  status: BlsSeriesStatus;
  /** Newest first, as BLS sends them. */
  observations: BlsObservation[];
  /** The messages BLS attached to this series. */
  messages: string[];
  /** Rows dropped because the value was not a number (BLS prints "-" for a withheld estimate). */
  unreadable: number;
}

export interface BlsParsed {
  /** The top-level status string, e.g. "REQUEST_SUCCEEDED". It does NOT say whether each series worked. */
  status: string;
  succeeded: boolean;
  /** Every message, verbatim. */
  messages: string[];
  /** Messages that name no series we know (quota notices and the like). */
  otherMessages: string[];
  series: BlsSeries[];
}

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

const NOT_FOUND = /^Series does not exist for Series (\S+)/i;
const NO_DATA = /^No Data Available for Series (\S+)/i;

/**
 * A response of the BLS timeseries API → one result per series, with its failures.
 * Pass the ids that were asked for: one BLS left out of the response comes back as "no_data"
 * instead of going missing silently.
 */
export function parseBlsResponse(json: unknown, requested: readonly string[] = []): BlsParsed {
  const top = rec(json);
  const status = typeof top.status === 'string' ? top.status : 'UNKNOWN';
  const messages = Array.isArray(top.message) ? top.message.filter((m): m is string => typeof m === 'string') : [];
  const rawSeries = rec(top.Results).series;

  const byId = new Map<string, BlsSeries>();
  const blank = (seriesId: string): BlsSeries => ({ seriesId, status: 'no_data', observations: [], messages: [], unreadable: 0 });
  for (const raw of Array.isArray(rawSeries) ? rawSeries : []) {
    const s = rec(raw);
    if (typeof s.seriesID !== 'string') continue;
    const out = byId.get(s.seriesID) ?? blank(s.seriesID);
    for (const rawRow of Array.isArray(s.data) ? s.data : []) {
      const row = rec(rawRow);
      const value = typeof row.value === 'string' ? row.value.trim() : '';
      if (typeof row.year !== 'string' || typeof row.period !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) {
        out.unreadable++;
        continue;
      }
      const footnoteCodes = (Array.isArray(row.footnotes) ? row.footnotes : []).flatMap((f) => {
        const code = rec(f).code;
        return typeof code === 'string' && code ? [code] : [];
      });
      out.observations.push({
        year: row.year, period: row.period, periodName: typeof row.periodName === 'string' ? row.periodName : null,
        value: Number(value), raw: value, preliminary: footnoteCodes.includes('P'), footnoteCodes,
      });
    }
    byId.set(s.seriesID, out);
  }
  for (const id of requested) if (!byId.has(id)) byId.set(id, blank(id));

  const missing = new Set<string>();
  const otherMessages: string[] = [];
  for (const msg of messages) {
    // Whole-word match: "WPU117" must not claim a message about "WPU1171".
    const words = new Set(msg.split(/[^A-Za-z0-9]+/));
    const named = NOT_FOUND.exec(msg)?.[1] ?? NO_DATA.exec(msg)?.[1] ?? [...byId.keys()].find((id) => words.has(id));
    const series = named ? byId.get(named) : undefined;
    if (!series) {
      otherMessages.push(msg);
      continue;
    }
    series.messages.push(msg);
    if (NOT_FOUND.test(msg)) missing.add(series.seriesId);
  }
  for (const s of byId.values()) s.status = s.observations.length > 0 ? 'ok' : missing.has(s.seriesId) ? 'not_found' : 'no_data';

  return { status, succeeded: status === 'REQUEST_SUCCEEDED', messages, otherMessages, series: [...byId.values()] };
}

// ---------------------------------------------------------------- fetcher --

export interface BlsRequest {
  url: string;
  body: Record<string, unknown>;
}

/** One query: up to 25 series (50 with a key), always with an explicit year range. */
export function buildBlsRequest(seriesIds: readonly string[], startYear: number, endYear: number, apiKey?: string): BlsRequest {
  const limits = apiKey ? BLS_LIMITS.v2 : BLS_LIMITS.v1;
  if (seriesIds.length === 0 || seriesIds.length > limits.seriesPerQuery) throw new Error(`A BLS query takes 1–${limits.seriesPerQuery} series, got ${seriesIds.length}`);
  if (!Number.isInteger(startYear) || !Number.isInteger(endYear) || startYear > endYear) throw new Error(`Bad BLS year range ${startYear}–${endYear}`);
  if (endYear - startYear + 1 > limits.years) throw new Error(`A BLS query spans at most ${limits.years} years`);
  const body: Record<string, unknown> = { seriesid: [...seriesIds], startyear: String(startYear), endyear: String(endYear) };
  if (apiKey) body.registrationkey = apiKey;
  return { url: apiKey ? BLS_V2_URL : BLS_V1_URL, body };
}

export interface FetchBlsOptions {
  startYear: number;
  endYear: number;
  /** BLS_API_KEY. With it: v2 endpoint, 50 series a query. Never logged. */
  apiKey?: string;
  /** Hard stop on the number of queries this call may send. Series past it are returned in `notFetched`. */
  maxQueries?: number;
  log?: (msg: string) => void;
}

export interface BlsFetchResult {
  series: BlsSeries[];
  /** Queries actually sent. */
  queries: number;
  /** Series never asked for: over the query budget, or after a failed query. */
  notFetched: string[];
  /** Why the run stopped early, if it did. */
  error: string | null;
  /** Messages that named no series. */
  otherMessages: string[];
}

/**
 * Fetch series in chunks, one query at a time. A failed query (HTTP error, or a status other than
 * REQUEST_SUCCEEDED such as a spent daily quota) stops the run at once: the daily allowance is
 * small, so nothing is retried here.
 */
export async function fetchBls(http: FetchLike, seriesIds: readonly string[], opts: FetchBlsOptions): Promise<BlsFetchResult> {
  const ids = [...new Set(seriesIds)];
  const size = (opts.apiKey ? BLS_LIMITS.v2 : BLS_LIMITS.v1).seriesPerQuery;
  const maxQueries = opts.maxQueries ?? Infinity;
  const hide = (text: string): string => (opts.apiKey ? text.split(opts.apiKey).join('***') : text);
  const out: BlsFetchResult = { series: [], queries: 0, notFetched: [], error: null, otherMessages: [] };

  for (let i = 0; i < ids.length; i += size) {
    const chunk = ids.slice(i, i + size);
    if (out.error !== null || out.queries >= maxQueries) {
      out.notFetched.push(...chunk);
      continue;
    }
    const req = buildBlsRequest(chunk, opts.startYear, opts.endYear, opts.apiKey);
    out.queries++;
    try {
      const json = await http.json(req.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
      const parsed = parseBlsResponse(json, chunk);
      if (!parsed.succeeded) {
        out.error = hide(`BLS answered ${parsed.status}: ${parsed.messages.join(' | ') || 'no message'}`);
        out.notFetched.push(...chunk);
        continue;
      }
      for (const s of parsed.series) out.series.push({ ...s, messages: s.messages.map(hide) });
      out.otherMessages.push(...parsed.otherMessages.map(hide));
      opts.log?.(`BLS query ${out.queries}: ${parsed.series.filter((s) => s.status === 'ok').length} of ${chunk.length} series returned data`);
    } catch (err) {
      out.error = hide(err instanceof Error ? err.message : String(err));
      out.notFetched.push(...chunk);
    }
  }
  if (out.queries >= maxQueries && out.notFetched.length > 0 && out.error === null) {
    out.error = `stopped at the query budget (${maxQueries}); ${out.notFetched.length} series not asked for`;
  }
  return out;
}

// ---------------------------------------------------------------- refresh --

export interface PlannedSeries {
  seriesId: string;
  meta: SeriesMeta;
}

/**
 * Every series a refresh asks for, most important first, because the daily allowance can run out
 * part way (it did on the first live run): the 9 PPI series, then for each occupation the nation,
 * the states named in `priorityStates` (the ones customers work in) and their metro areas, then
 * the other verified metro areas, then every other state and DC. Hourly mean, median, 25th and
 * 75th percentile for each area.
 */
export function blsRefreshPlan(socs: readonly string[] = [ELECTRICIANS], priorityStates: readonly string[] = []): PlannedSeries[] {
  const plan: PlannedSeries[] = PPI_SERIES.map((p) => ({
    seriesId: p.seriesId,
    meta: { seriesId: p.seriesId, kind: 'ppi', title: p.title, area: 'United States', unit: 'index', source: PPI_SOURCE, sourceUrl: PPI_SOURCE_URL },
  }));
  const first = priorityStates.map((s) => s.toUpperCase());
  // nation 0 · a priority state 1 · a metro in a priority state 2 · any other metro 3 · any other state 4
  const rank = (a: OewsArea): number => {
    if (a.level === 'nation') return 0;
    const wanted = a.state !== null && first.includes(a.state);
    if (a.level === 'state') return wanted ? 1 : 4;
    return wanted ? 2 : 3;
  };
  const areas = oewsRefreshAreas().map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map(({ a }) => a);
  for (const rawSoc of socs) {
    const soc = normalizeSoc(rawSoc);
    for (const area of areas) {
      for (const measure of Object.keys(OEWS_MEASURES) as OewsMeasure[]) {
        const seriesId = wageSeriesId(area, soc, measure);
        plan.push({
          seriesId,
          meta: {
            seriesId, kind: 'oews', title: `${occupationName(soc)}: hourly ${MEASURE_LABEL[measure]} wage`, area: area.name,
            unit: 'USD per hour', source: OEWS_SOURCE, sourceUrl: OEWS_SOURCE_URL,
          },
        });
      }
    }
  }
  return plan;
}

export interface RefreshBlsOptions {
  now?: Date;
  apiKey?: string;
  /** Hard stop on queries for this run (the no-key allowance is 25 a day in total). */
  maxQueries?: number;
  /** Occupations to pull wages for. Default: electricians. */
  socs?: string[];
  /** States to ask for first (2-letter codes), so a short allowance still covers where customers work. */
  priorityStates?: string[];
  /**
   * Wage series stored with data less than this many days ago are not asked for again: the survey
   * comes out once a year, and this is what lets a run that hit the daily limit finish the next day.
   * Default 30. Price indexes are monthly and are always asked for.
   */
  wageMaxAgeDays?: number;
  log?: (msg: string) => void;
}

export interface BlsRefreshReport {
  source: 'bls';
  startYear: number;
  endYear: number;
  /** Queries sent to api.bls.gov. */
  queries: number;
  /** Series in the plan. */
  seriesPlanned: number;
  /** Wage series left alone because their stored data is recent (see wageMaxAgeDays). */
  skippedFresh: number;
  /** Series this run needed from BLS (planned minus skipped). */
  seriesAsked: number;
  seriesStored: number;
  observationsStored: number;
  /** Series BLS answered for without data, with its own words. */
  failed: Array<{ seriesId: string; status: BlsSeriesStatus; message: string }>;
  /** Series never asked for (query budget, or the run stopped on an error). */
  notFetched: string[];
  error: string | null;
  otherMessages: string[];
}

/** "2026-M09": the stored period key. Sorts in time order within a series. */
export const periodKey = (year: string, period: string): string => `${year}-${period}`;

/**
 * Pull the PPI indexes and the OEWS wages and store them. Looks back two calendar years so a
 * 12-month change can always be worked out. Running it again overwrites values in place
 * (that is how a preliminary value becomes its revision).
 */
export async function refreshBls(db: Db, http: FetchLike, opts: RefreshBlsOptions = {}): Promise<BlsRefreshReport> {
  const now = opts.now ?? new Date();
  const endYear = now.getUTCFullYear();
  const startYear = endYear - 2;
  const plan = blsRefreshPlan(opts.socs, opts.priorityStates);
  const metaOf = new Map(plan.map((p) => [p.seriesId, p.meta]));

  const freshAfter = now.getTime() - (opts.wageMaxAgeDays ?? 30) * 86_400_000;
  const fresh = new Set((await listSeriesMeta(db, 'oews'))
    .filter((m) => m.status === 'ok' && Date.parse(m.fetchedAt) > freshAfter)
    .map((m) => m.seriesId));
  const wanted = plan.filter((p) => !fresh.has(p.seriesId));

  const got = await fetchBls(http, wanted.map((p) => p.seriesId), { startYear, endYear, apiKey: opts.apiKey, maxQueries: opts.maxQueries, log: opts.log });
  const report: BlsRefreshReport = {
    source: 'bls', startYear, endYear, queries: got.queries, seriesPlanned: plan.length, skippedFresh: plan.length - wanted.length,
    seriesAsked: wanted.length, seriesStored: 0, observationsStored: 0,
    failed: [], notFetched: got.notFetched, error: got.error, otherMessages: got.otherMessages,
  };

  for (const s of got.series) {
    const meta = metaOf.get(s.seriesId);
    if (!meta) continue;
    // M13 is an annual average, not a month: it has no place in a monthly trend.
    const observations: Observation[] = s.observations
      .filter((o) => o.period !== 'M13')
      .map((o) => ({ period: periodKey(o.year, o.period), value: o.raw, preliminary: o.preliminary }));
    if (s.status !== 'ok' || observations.length === 0) {
      const text = s.messages.join(' | ') || (s.unreadable > 0 ? `${s.unreadable} value(s) withheld by BLS` : 'BLS returned no observations');
      await markSeriesFailed(db, meta, s.status === 'ok' ? 'no_data' : s.status, text, now);
      report.failed.push({ seriesId: s.seriesId, status: s.status === 'ok' ? 'no_data' : s.status, message: text });
      continue;
    }
    await saveSeries(db, meta, observations, now);
    report.seriesStored++;
    report.observationsStored += observations.length;
  }
  return report;
}

// ------------------------------------------------------------ area wages --

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-M09" → "Sep 2026". Annual keys ("2025-A01") → "2025". */
export function periodLabel(period: string): string {
  const m = /^(\d{4})-M(\d{2})$/.exec(period);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  return period.slice(0, 4);
}

/** The OEWS survey is dated May of its year: "2025-A01" → "May 2025". */
export function oewsPeriodLabel(period: string): string {
  return `May ${period.slice(0, 4)}`;
}

export type WageLevel = 'metro' | 'nonmetro' | 'state' | 'nation';

export interface AreaWage {
  soc: string;
  occupation: string;
  /** The geography level this figure is for. */
  level: WageLevel;
  areaCode: string;
  areaName: string;
  /** Stored period key, e.g. "2025-A01". */
  period: string;
  /** e.g. "May 2025" (the survey's reference month). */
  periodLabel: string;
  /** Hourly, in dollars. null = BLS published no such figure for this area. */
  mean: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  unit: 'USD per hour';
  source: string;
  sourceUrl: string;
  /** When we retrieved it from BLS (ISO). */
  fetchedAt: string;
}

export interface AreaWageResult extends AreaWage {
  /** Levels tried in order (metro → state → nation) and whether each had data. */
  tried: Array<{ level: WageLevel; areaName: string; found: boolean }>;
}

function wageFrom(area: OewsArea, soc: string, stored: Map<string, StoredSeries>): AreaWage | null {
  const series = (Object.keys(OEWS_MEASURES) as OewsMeasure[]).map((measure) => ({ measure, s: stored.get(wageSeriesId(area, soc, measure)) }));
  const period = series.flatMap(({ s }) => s?.observations.map((o) => o.period) ?? []).sort().at(-1);
  if (!period) return null;
  const at = (measure: OewsMeasure): number | null =>
    series.find((x) => x.measure === measure)?.s?.observations.find((o) => o.period === period)?.value ?? null;
  const holder = series.find(({ s }) => s?.observations.some((o) => o.period === period))!.s!;
  return {
    soc, occupation: occupationName(soc), level: area.level, areaCode: area.areaCode, areaName: holder.meta.area ?? area.name,
    period, periodLabel: oewsPeriodLabel(period), mean: at('mean'), median: at('median'), p25: at('p25'), p75: at('p75'),
    unit: 'USD per hour', source: holder.meta.source, sourceUrl: holder.meta.sourceUrl ?? OEWS_SOURCE_URL, fetchedAt: holder.meta.fetchedAt,
  };
}

/** The stored wage for one exact area, or null when we hold nothing for it. */
export async function wageForArea(db: Db, area: OewsArea, soc: string): Promise<AreaWage | null> {
  const code = normalizeSoc(soc);
  const ids = (Object.keys(OEWS_MEASURES) as OewsMeasure[]).map((m) => wageSeriesId(area, code, m));
  return wageFrom(area, code, await getSeries(db, ids));
}

export interface WageWhere {
  /** 2-letter state code. */
  state?: string | null;
  /** 5-digit CBSA code of the metro area, when known. */
  cbsa?: string | null;
}

/**
 * The published hourly wage for an occupation in an area, from stored OEWS data. Ladder:
 * metro (when a CBSA is given) → state → nation; the first level with data wins and the answer
 * names the level it used and the survey period. null = nothing stored at any level.
 */
export async function areaWage(db: Db, where: WageWhere, soc: string): Promise<AreaWageResult | null> {
  const code = normalizeSoc(soc);
  const candidates: OewsArea[] = [];
  if (where.cbsa && /^\d{5}$/.test(where.cbsa)) {
    const areaCode = metroAreaCode(where.cbsa);
    candidates.push(VERIFIED_OEWS_AREAS.find((a) => a.areaCode === areaCode)
      ?? { level: 'metro', areaType: 'M', areaCode, name: `Metro area ${where.cbsa}`, state: where.state ?? null, cbsa: where.cbsa });
  }
  const state = where.state ? stateArea(where.state) : null;
  if (state) candidates.push(state);
  candidates.push(NATION_AREA);

  const tried: AreaWageResult['tried'] = [];
  for (const area of candidates) {
    const wage = await wageForArea(db, area, code);
    tried.push({ level: area.level, areaName: wage?.areaName ?? area.name, found: wage !== null });
    if (wage) return { ...wage, tried };
  }
  return null;
}

/** Wages stored for the verified metro and nonmetro areas listed under a state (no ZIP is mapped to them). */
export async function metroWagesInState(db: Db, state: string, soc: string): Promise<AreaWage[]> {
  const out: AreaWage[] = [];
  for (const area of VERIFIED_OEWS_AREAS.filter((a) => a.state === state.toUpperCase())) {
    const wage = await wageForArea(db, area, soc);
    if (wage) out.push(wage);
  }
  return out;
}

// -------------------------------------------------------- material trends --

export interface TrendPoint {
  period: string;
  periodLabel: string;
  value: number;
  preliminary: boolean;
}

export interface TrendChange {
  /** Percent change from `from` to the latest value, one decimal. */
  pct: number;
  from: TrendPoint;
}

export interface SeriesTrend {
  latest: TrendPoint;
  /** null = the month that far back is not in the data (never interpolated). */
  change1m: TrendChange | null;
  change3m: TrendChange | null;
  change12m: TrendChange | null;
}

/** "2026-M01" minus 3 months → "2025-M10". */
export function shiftMonths(period: string, months: number): string | null {
  const m = /^(\d{4})-M(\d{2})$/.exec(period);
  if (!m) return null;
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + months;
  return `${Math.floor(index / 12)}-M${String((index % 12) + 1).padStart(2, '0')}`;
}

/**
 * Latest monthly value and its change over 1, 3 and 12 months. Pure.
 * change = (latest / value N months earlier − 1) × 100, rounded to one decimal, using the exact
 * month N back; if that month is missing the change is null.
 */
export function seriesTrend(observations: readonly StoredObservation[]): SeriesTrend | null {
  const monthly = new Map(observations.filter((o) => /^\d{4}-M(0[1-9]|1[0-2])$/.test(o.period)).map((o) => [o.period, o]));
  const latestPeriod = [...monthly.keys()].sort().at(-1);
  if (!latestPeriod) return null;
  const point = (o: StoredObservation): TrendPoint => ({ period: o.period, periodLabel: periodLabel(o.period), value: o.value, preliminary: o.preliminary });
  const latest = monthly.get(latestPeriod)!;
  const change = (monthsBack: number): TrendChange | null => {
    const from = monthly.get(shiftMonths(latestPeriod, -monthsBack) ?? '');
    if (!from || from.value === 0) return null;
    return { pct: Math.round((latest.value / from.value - 1) * 1000) / 10, from: point(from) };
  };
  return { latest: point(latest), change1m: change(1), change3m: change(3), change12m: change(12) };
}

export interface MaterialTrend {
  seriesId: string;
  label: string;
  title: string;
  /** null = no data stored for this series; `note` says why. */
  latest: TrendPoint | null;
  change1m: TrendChange | null;
  change3m: TrendChange | null;
  change12m: TrendChange | null;
  note: string | null;
  unit: 'index';
  /** PPI has no state or metro detail. */
  geography: 'national';
  source: string;
  sourceUrl: string;
  fetchedAt: string | null;
}

/**
 * For each stored price index: the latest value, its period, whether it is preliminary, and the
 * change over 1, 3 and 12 months. A series we asked for and got nothing is listed with latest: null.
 */
export async function materialTrends(db: Db): Promise<MaterialTrend[]> {
  const metas = await listSeriesMeta(db, 'ppi');
  const stored = await getSeries(db, metas.map((m) => m.seriesId));
  const order = new Map(PPI_SERIES.map((p, i) => [p.seriesId, i]));
  const rank = (id: string): number => order.get(id) ?? PPI_SERIES.length;
  return metas
    .sort((a, b) => rank(a.seriesId) - rank(b.seriesId) || a.seriesId.localeCompare(b.seriesId))
    .map((meta) => {
      const trend = seriesTrend(stored.get(meta.seriesId)?.observations ?? []);
      const def = PPI_SERIES.find((p) => p.seriesId === meta.seriesId);
      return {
        seriesId: meta.seriesId, label: def?.label ?? meta.title, title: meta.title,
        latest: trend?.latest ?? null, change1m: trend?.change1m ?? null, change3m: trend?.change3m ?? null, change12m: trend?.change12m ?? null,
        note: trend ? (meta.status === 'ok' ? null : `Last refresh got no new data: ${meta.note ?? meta.status}`) : `No data: ${meta.note ?? meta.status}`,
        unit: 'index' as const, geography: 'national' as const, source: meta.source, sourceUrl: meta.sourceUrl ?? PPI_SOURCE_URL,
        fetchedAt: trend ? meta.fetchedAt : null,
      };
    });
}
