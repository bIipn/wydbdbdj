/**
 * Price statistics for "what similar jobs were awarded for". Pure: no database, no clock, no network.
 *
 * Three rules the product depends on:
 *  - The number is always the "price at award": the dollars obligated by the award's FIRST action
 *    (Mod 0). It is not the contract's full value: option years and later funding are not in it.
 *    Awards without one are left out of the statistics and counted, never filled in from the current amount.
 *  - Orders that only fund a contract's minimum guarantee are placeholders, not jobs: left out and counted too.
 *  - A range is shown only from MIN_PRICED_AWARDS priced awards up, and the answer always says which
 *    geography level it used, how many awards, and their date range.
 */
import { milesBetween } from '../geo/locate.js';

// ------------------------------------------------------------ percentiles --

/**
 * Percentile by linear interpolation between closest ranks: Hyndman & Fan type 7, the default in
 * Excel PERCENTILE.INC, NumPy and R.
 *
 *   sort ascending as x[0..n-1];  h = (n - 1) * p;  result = x[floor(h)] + (h - floor(h)) * (x[floor(h) + 1] - x[floor(h)])
 *
 * So p = 0 is the minimum, p = 1 the maximum, p = 0.5 the usual median (the mean of the two middle
 * values when n is even), and one value is every percentile of itself. Returns null for an empty list.
 * Throws when p is outside 0..1 or a value is not a finite number.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (!(p >= 0 && p <= 1)) throw new RangeError(`percentile p must be between 0 and 1, got ${p}`);
  if (values.length === 0) return null;
  return percentileSorted(sortedFinite(values), p);
}

function sortedFinite(values: readonly number[]): number[] {
  for (const v of values) if (!Number.isFinite(v)) throw new RangeError(`percentile needs finite numbers, got ${v}`);
  return [...values].sort((a, b) => a - b);
}

function percentileSorted(sorted: readonly number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const i = Math.floor(h);
  const lo = sorted[i]!;
  const hi = sorted[Math.min(i + 1, sorted.length - 1)]!;
  // Clamp: rounding in the interpolation must never push the result outside its two neighbours.
  return Math.min(hi, Math.max(lo, lo + (h - i) * (hi - lo)));
}

export interface PriceStats {
  count: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
}

/** min, quartiles and max of a list (see `percentile` for the method). null for an empty list. */
export function priceStats(values: readonly number[]): PriceStats | null {
  if (values.length === 0) return null;
  const s = sortedFinite(values);
  return {
    count: s.length,
    min: s[0]!,
    p25: percentileSorted(s, 0.25),
    median: percentileSorted(s, 0.5),
    p75: percentileSorted(s, 0.75),
    max: s[s.length - 1]!,
  };
}

// ---------------------------------------------------------------- coverage --

/** One complete pull we hold: a place ("NV", or the nationwide scope) and NAICS code, for one unbroken stretch of dates. */
export interface CoverageSpan {
  scope: string;
  naics: string;
  /** YYYY-MM-DD, inclusive. */
  fromDate: string;
  toDate: string;
}

/**
 * The stretch of dates for which EVERY one of `codes` is loaded for a state, among pulls that reach
 * `since` or later. Pulls of the state itself and of the whole country (`nationwideScope`) count;
 * pass `state: null` to ask about the nationwide pulls alone.
 *
 * null = at least one code has no such pull, or the codes share no date: the caller must answer
 * "not loaded", which is a different thing from "zero awards".
 *
 * Two pulls for one code are joined only when their dates overlap. Otherwise the later one is used,
 * so a hole between pulls is never reported as covered.
 */
export function loadedSpan(
  coverage: readonly CoverageSpan[], codes: readonly string[], state: string | null, since: string, nationwideScope = 'US',
): { from: string; to: string } | null {
  let from = '';
  let to = '9999-12-31';
  for (const code of codes) {
    const pulls = coverage
      .filter((c) => c.naics === code && (c.scope === nationwideScope || (state !== null && c.scope === state)) && c.toDate >= since)
      .sort((a, b) => a.fromDate.localeCompare(b.fromDate));
    const span = pulls.reduce<{ from: string; to: string } | null>(
      (s, p) => (s && p.fromDate <= s.to ? { from: s.from, to: p.toDate > s.to ? p.toDate : s.to } : { from: p.fromDate, to: p.toDate }),
      null,
    );
    if (!span) return null;
    if (span.from > from) from = span.from;
    if (span.to < to) to = span.to;
  }
  return codes.length > 0 && from <= to ? { from, to } : null;
}

// --------------------------------------------------------- similar awards --

/** A range is shown only when at least this many awards have a price at award. */
export const MIN_PRICED_AWARDS = 10;

export type AwardLevel = 'zip_radius' | 'county' | 'state' | 'nation';
export const AWARD_LADDER: readonly AwardLevel[] = ['zip_radius', 'county', 'state', 'nation'];

/** The slice of an award the selection reads. Rows are expected to be pre-filtered by NAICS and date window. */
export interface AwardPoint {
  /** Dollars obligated by the first action (Mod 0). null = unknown. */
  priceAtAward: number | null;
  /** The award's own description, when the caller has it: read only to spot minimum-guarantee orders. */
  description?: string | null;
  /** Signed / base obligation date, YYYY-MM-DD. */
  actionDate: string | null;
  zip: string | null;
  county: string | null;
  state: string | null;
}

/** What `lookupZip` must give back. A county is optional: the ZIP table may not carry one. */
export interface ZipPoint {
  lat: number;
  lng: number;
  state?: string | null;
  county?: string | null;
}
export type ZipLookup = (zip: string) => ZipPoint | null;

/** Where the job is. Give what is known; the ladder skips levels it cannot place. */
export interface SimilarWhere {
  zip?: string | null;
  /** A known point (a bid's own location). Wins over the ZIP's point. */
  center?: { lat: number; lng: number } | null;
  radiusMi: number;
  county?: string | null;
  state?: string | null;
}

export interface SimilarOptions {
  lookupZip: ZipLookup;
  /** Default MIN_PRICED_AWARDS. */
  minCount?: number;
  /**
   * True only when the awards passed in cover the whole country. When false the "nation" level is
   * never used: a handful of loaded states must not be labelled as the nation.
   */
  nationwide?: boolean;
}

export type SkipReason = 'no_location' | 'no_county' | 'no_state' | 'not_loaded';

export interface LadderStep {
  level: AwardLevel;
  /** Awards in this scope with a usable price at award. */
  priced: number;
  /** Awards in this scope left out: no usable price at award, or a minimum-guarantee order. */
  excludedNoPrice: number;
  /** Set when the level could not be tried at all. */
  skipped?: SkipReason;
}

export interface SimilarAwards<T extends AwardPoint> {
  /** The level the answer is based on. null = no level could be tried. */
  level: AwardLevel | null;
  /** True when `priced` reached the floor, i.e. `stats` is present. */
  enough: boolean;
  minCount: number;
  /** N: awards with a usable price at award in the chosen scope. */
  priced: number;
  /** Awards in the chosen scope left out of the statistics: no price at award, or a minimum-guarantee order. */
  excludedNoPrice: number;
  /** Which amount the statistics use. Always the price at award. */
  amountBasis: 'price_at_award';
  /** Oldest and newest award date among the priced awards (YYYY-MM-DD). */
  dateRange: { from: string; to: string } | null;
  stats: PriceStats | null;
  /** Every award in the chosen scope, priced or not, newest first. */
  awards: T[];
  /** Each level in ladder order with what it held, so the caller can explain the choice. */
  ladder: LadderStep[];
  /** What the selection resolved the place to. */
  place: { state: string | null; county: string | null; radiusMi: number; hasPoint: boolean };
}

// Wordings seen in the live capture of 2026-11-13: "MINIMUM GUARANTEE TASK ORDER", "WRMACC MIN GUARANTEE SHEMP",
// "MIN. GUARANTEE TASK ORDER", "MINIMUM ORDER GUARANTEE", "GUARANTEED MINIMUM FOR ...", and the typo "MIN GURANTEE".
const MINIMUM_GUARANTEE = /\b(?:min(?:imum|\.)?\s+(?:order\s+)?gua?rantee|guaranteed\s+minimum)/i;

/**
 * An order whose description says it funds a contract's minimum guarantee: a placeholder of a few
 * hundred or thousand dollars on an indefinite-delivery contract, not the price of a job. Only the
 * wording is read. A dollar floor would also throw out real small jobs, so placeholders that do
 * not say what they are stay in.
 */
export function isMinimumGuarantee(a: Pick<AwardPoint, 'description'>): boolean {
  return typeof a.description === 'string' && MINIMUM_GUARANTEE.test(a.description);
}

/** A price at award we can use in statistics: a finite amount above zero, on an award that is not a minimum-guarantee order. */
export function hasPriceAtAward(a: Pick<AwardPoint, 'priceAtAward' | 'description'>): boolean {
  return typeof a.priceAtAward === 'number' && Number.isFinite(a.priceAtAward) && a.priceAtAward > 0 && !isMinimumGuarantee(a);
}

/** "CLARK", "Clark County" and "clark" are the same county. */
export function normalizeCounty(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.toLowerCase().replace(/\b(county|parish|borough)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return n || null;
}

const upper = (s: string | null | undefined): string | null => (s && s.trim() ? s.trim().toUpperCase() : null);

/** The most common value, ties broken by the smaller value so the answer does not depend on row order. */
function majority(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  for (const [v, n] of counts) {
    if (best === null || n > counts.get(best)! || (n === counts.get(best)! && v < best)) best = v;
  }
  return best;
}

/**
 * Pick the awards "like this job" by walking the ladder ZIP radius → county → state → nation and
 * stopping at the first level with at least `minCount` priced awards.
 *
 * When no level reaches the floor the answer is the widest level that could be tried, with
 * `enough: false` and `stats: null`: the caller shows the count and says there is not enough to
 * show a range.
 *
 * How the place is resolved:
 *  - point: `where.center`, else `lookupZip(where.zip)`. Awards are placed by `lookupZip(award.zip)`.
 *  - state: `where.state`, else the ZIP table's state, else the state of awards in that same ZIP.
 *  - county: `where.county`, else the ZIP table's county, else the county of awards in that same ZIP.
 */
export function selectSimilarAwards<T extends AwardPoint>(awards: readonly T[], where: SimilarWhere, opts: SimilarOptions): SimilarAwards<T> {
  const minCount = opts.minCount ?? MIN_PRICED_AWARDS;
  const zip = where.zip && /^\d{5}$/.test(where.zip) ? where.zip : null;
  const zipPoint = zip ? opts.lookupZip(zip) : null;
  const center = where.center ?? (zipPoint ? { lat: zipPoint.lat, lng: zipPoint.lng } : null);

  const sameZip = zip ? awards.filter((a) => a.zip === zip) : [];
  const state = upper(where.state) ?? upper(zipPoint?.state) ?? majority(sameZip.flatMap((a) => upper(a.state) ?? []));
  const county = normalizeCounty(where.county) ?? normalizeCounty(zipPoint?.county)
    ?? majority(sameZip.filter((a) => upper(a.state) === state).flatMap((a) => normalizeCounty(a.county) ?? []));

  const points = new Map<string, ZipPoint | null>();
  const pointOf = (z: string | null): ZipPoint | null => {
    if (!z) return null;
    if (!points.has(z)) points.set(z, opts.lookupZip(z));
    return points.get(z) ?? null;
  };

  const scopes: Record<AwardLevel, { skipped?: SkipReason; rows: () => T[] }> = {
    zip_radius: {
      skipped: center ? undefined : 'no_location',
      rows: () => awards.filter((a) => {
        const p = pointOf(a.zip);
        return p !== null && milesBetween(center!, p) <= where.radiusMi;
      }),
    },
    county: {
      skipped: !state ? 'no_state' : !county ? 'no_county' : undefined,
      rows: () => awards.filter((a) => upper(a.state) === state && normalizeCounty(a.county) === county),
    },
    state: {
      skipped: state ? undefined : 'no_state',
      rows: () => awards.filter((a) => upper(a.state) === state),
    },
    nation: {
      skipped: opts.nationwide ? undefined : 'not_loaded',
      rows: () => [...awards],
    },
  };

  const ladder: LadderStep[] = [];
  let chosen: { level: AwardLevel; rows: T[]; priced: T[] } | null = null;
  for (const level of AWARD_LADDER) {
    const scope = scopes[level];
    if (scope.skipped) {
      ladder.push({ level, priced: 0, excludedNoPrice: 0, skipped: scope.skipped });
      continue;
    }
    const rows = scope.rows();
    const priced = rows.filter(hasPriceAtAward);
    ladder.push({ level, priced: priced.length, excludedNoPrice: rows.length - priced.length });
    // Keep the last level tried: if none reaches the floor, the answer is the widest one.
    chosen = { level, rows, priced };
    if (priced.length >= minCount) break;
  }

  const place = { state, county, radiusMi: where.radiusMi, hasPoint: center !== null };
  if (!chosen) {
    return { level: null, enough: false, minCount, priced: 0, excludedNoPrice: 0, amountBasis: 'price_at_award', dateRange: null, stats: null, awards: [], ladder, place };
  }

  const enough = chosen.priced.length >= minCount;
  const dates = chosen.priced.flatMap((a) => a.actionDate ?? []).sort();
  const newestFirst = [...chosen.rows].sort((a, b) => (b.actionDate ?? '').localeCompare(a.actionDate ?? ''));
  return {
    level: chosen.level,
    enough,
    minCount,
    priced: chosen.priced.length,
    excludedNoPrice: chosen.rows.length - chosen.priced.length,
    amountBasis: 'price_at_award',
    dateRange: dates.length ? { from: dates[0]!, to: dates[dates.length - 1]! } : null,
    stats: enough ? priceStats(chosen.priced.map((a) => a.priceAtAward!)) : null,
    awards: newestFirst,
    ladder,
    place,
  };
}
