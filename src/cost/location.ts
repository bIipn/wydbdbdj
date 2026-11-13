// Place adjustment (spec 6.6) and the combined time-and-place formula with its double-count guards
// (spec 6.7). On a takeoff-based public bid, place comes from local inputs (the county's wage
// determination, local quotes, local tax), not from a factor: every factor here is for moving a
// HISTORICAL cost or for a labelled context number, and the engine refuses the other uses.
// Wage figures and area cost factors are inputs with their measure, period, edition and source.

import { assertCents, divRound, ratio, rAdd, rCmp, rDiv, refuse, rMul, toCents, type Cents, type IsoDate, type Ratio, type RoundingMode } from './money.js';
import type { AssumptionUsed } from './types.js';
import { parseDecimal, type IndexRatio } from './escalation.js';

const ONE: Ratio = ratio(1n);

function applyFactor(c: Cents, f: Ratio, mode: RoundingMode): Cents {
  assertCents(c);
  if (f.num < 0n) refuse('NEGATIVE', 'factor must be >= 0');
  return toCents(divRound(BigInt(c) * f.num, f.den, mode), 'place-adjusted amount');
}

// ---------------------------------------------------------------- wage ratio (spec 6.6)

/** One published wage figure for one area [P] (e.g. BLS OEWS mean hourly wage, D-80). */
export interface WageFigure {
  readonly areaId: string;
  readonly areaName: string;
  /** The wage measure, e.g. 'OEWS 47-2111 mean hourly, straight time, no benefits'. */
  readonly measure: string;
  /** Survey period, e.g. '2025-05'. */
  readonly period: string;
  readonly hourly: Cents;
  readonly source: string;
  /** Small-area or nonmetropolitan estimate: flagged low confidence (A-32). */
  readonly smallArea?: boolean;
}

export interface PlaceFactor {
  readonly method: 'wage-ratio' | 'composite' | 'acf';
  /** What the factor may multiply. */
  readonly appliesTo: 'labor' | 'whole-job-historical' | 'context-only';
  readonly factor: Ratio;
  readonly from: string;
  readonly to: string;
  /** Edition (ACF) or measure+period (wage ratio): two factors combine only within one. */
  readonly edition: string;
  readonly lowConfidence: boolean;
  readonly labels: readonly string[];
  readonly assumptions: readonly AssumptionUsed[];
}

/**
 * Labor_B = Labor_A * W_B / W_A: same wage measure, same period, two areas; labor dollars only,
 * hours unchanged, productivity separate (spec 6.6). On public works the wage determination is
 * the rate, so the bid itself never needs this.
 */
export function wageRatio(a: WageFigure, b: WageFigure): PlaceFactor {
  if (a.measure !== b.measure) refuse('WAGE_MEASURE_MISMATCH', `wage measures differ: ${a.measure} vs ${b.measure}`);
  if (a.period !== b.period) refuse('WAGE_PERIOD_MISMATCH', `wage periods differ: ${a.period} vs ${b.period}`);
  if (!a.source || !b.source) refuse('MISSING_SOURCE', 'every wage figure needs its source');
  assertCents(a.hourly, `${a.areaId} wage`);
  assertCents(b.hourly, `${b.areaId} wage`);
  if (a.hourly <= 0 || b.hourly <= 0) refuse('INDEX_NOT_POSITIVE', 'wage figures must be > 0');
  const low = Boolean(a.smallArea || b.smallArea);
  const labels = ['labor dollars only; hours and productivity unchanged'];
  const assumptions: AssumptionUsed[] = [];
  if (low) {
    labels.push('low confidence: small-area wage estimate (adjacent areas differ by 16.1% in the survey)');
    assumptions.push({ id: 'A-32', text: 'small-area wage ratios flagged low confidence', value: 'flagged' });
  }
  return {
    method: 'wage-ratio',
    appliesTo: 'labor',
    factor: ratio(BigInt(b.hourly), BigInt(a.hourly)),
    from: a.areaId,
    to: b.areaId,
    edition: `${a.measure} @ ${a.period}`,
    lowConfidence: low,
    labels,
    assumptions,
  };
}

/** Cost split into buckets, so a factor can be applied only where it is allowed. */
export interface CostBuckets {
  readonly labor: Cents;
  readonly material: Cents;
  readonly equipment: Cents;
  readonly other: Cents;
}

/** Apply a wage-ratio factor: labor dollars change, nothing else does (invariant 97). */
export function applyWageRatio(b: CostBuckets, f: PlaceFactor, mode: RoundingMode = 'half-up'): CostBuckets {
  if (f.method !== 'wage-ratio') refuse('WRONG_FACTOR', 'applyWageRatio takes a wage-ratio factor only');
  return { labor: applyFactor(b.labor, f.factor, mode), material: assertCents(b.material), equipment: assertCents(b.equipment), other: assertCents(b.other) };
}

// ---------------------------------------------------------------- share-weighted composite (spec 6.6)

export interface CompositeInput {
  /** Origin estimate split; the shares s_L, s_M, s_O are its dollar shares (they sum to 1 exactly). */
  readonly origin: { readonly labor: Cents; readonly material: Cents; readonly other: Cents };
  /** W_B/W_A, from wageRatio (same measure, same period). */
  readonly labor: PlaceFactor;
  /** m_B/m_A and o_B/o_A. Omitted -> 1, labelled (spec 6.6 "relatives default to 1"; 12.1 rule 13). */
  readonly materialRelative?: Ratio;
  readonly otherRelative?: Ratio;
}

/** LF = s_L*(W_B/W_A) + s_M*(m_B/m_A) + s_O*(o_B/o_A), exact. Whole-job historical cost only. */
export function compositeLocationFactor(c: CompositeInput): PlaceFactor {
  if (c.labor.method !== 'wage-ratio') refuse('WRONG_FACTOR', 'the labor relative must come from wageRatio');
  const L = BigInt(assertCents(c.origin.labor));
  const M = BigInt(assertCents(c.origin.material));
  const O = BigInt(assertCents(c.origin.other));
  const T = L + M + O;
  if (T === 0n) refuse('ZERO_WEIGHTS', 'origin estimate is zero');
  const labels = [...c.labor.labels.filter((l) => !l.startsWith('labor dollars only'))];
  const mR = c.materialRelative ?? ONE;
  const oR = c.otherRelative ?? ONE;
  if (mR.num <= 0n || oR.num <= 0n) refuse('INDEX_NOT_POSITIVE', 'relatives must be > 0');
  if (c.materialRelative === undefined) labels.push('material relative not entered: 1.00 used (labelled default, spec 6.6)');
  if (c.otherRelative === undefined) labels.push('other relative not entered: 1.00 used (labelled default, spec 6.6)');
  const f = rDiv(rAdd(rAdd(rMul(ratio(L), c.labor.factor), rMul(ratio(M), mR)), rMul(ratio(O), oR)), ratio(T));
  return { method: 'composite', appliesTo: 'whole-job-historical', factor: f, from: c.labor.from, to: c.labor.to, edition: c.labor.edition, lowConfidence: c.labor.lowConfidence, labels, assumptions: c.labor.assumptions };
}

/** Shares given as exact fractions instead of an origin split (they must sum to exactly 1). */
export function compositeFromShares(shares: readonly { readonly share: Ratio; readonly relative: Ratio }[]): Ratio {
  let s = ratio(0n);
  let f = ratio(0n);
  for (const x of shares) {
    if (x.share.num < 0n || x.relative.num <= 0n) refuse('NEGATIVE', 'shares must be >= 0 and relatives > 0');
    s = rAdd(s, x.share);
    f = rAdd(f, rMul(x.share, x.relative));
  }
  if (rCmp(s, ONE) !== 0) refuse('SHARES_NOT_ONE', 'shares must sum to exactly 1');
  return f;
}

// ---------------------------------------------------------------- DoD Area Cost Factors (spec 6.6, D-78)

export interface AcfRow {
  readonly siteCode?: string;
  readonly site: string;
  readonly state: string;
  readonly county?: string;
  readonly city?: string;
  /** Published factor text, national average = 1.00. */
  readonly value: string;
}

/** One edition of one ACF table (MILCON or Sustainment). Re-download and diff before use (12.2). */
export interface AcfTable {
  readonly edition: string; // e.g. 'UFS 3-701-01 2026'
  readonly kind: 'MILCON' | 'Sustainment';
  readonly source: string;
  readonly savedOn?: IsoDate;
  readonly rows: readonly AcfRow[];
}

export type AcfKey =
  | { readonly siteCode: string }
  | { readonly site: string }
  | { readonly state: string; readonly county: string; readonly city?: string }
  | { readonly zip: string };

/**
 * A-32 (assumption, editable, shown to the user): nearest listed ACF site for a county with no row.
 * Mapping is ours, not the publisher's. Douglas County, Nevada has no row -> Carson City.
 */
export const A32_NEAREST_ACF_SITE: Readonly<Record<string, string>> = { 'NV|Douglas': 'Carson City and Reno' };

const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase();

/** Find one ACF row. ZIP is refused (not unique: 195 of 6,873 ZIPs carry two factor pairs). */
export function acfLookup(t: AcfTable, key: AcfKey, opts: { useNearestSiteAssumption?: boolean } = {}): { row: AcfRow; assumptions: AssumptionUsed[] } {
  if ('zip' in key) refuse('ZIP_NOT_UNIQUE', 'key the ACF table on site code or county plus city, not ZIP');
  let hits: AcfRow[];
  if ('siteCode' in key) hits = t.rows.filter((r) => r.siteCode !== undefined && norm(r.siteCode) === norm(key.siteCode));
  else if ('site' in key) hits = t.rows.filter((r) => norm(r.site) === norm(key.site));
  else hits = t.rows.filter((r) => norm(r.state) === norm(key.state) && norm(r.county) === norm(key.county) && (key.city === undefined || norm(r.city) === norm(key.city)));
  if (hits.length > 1) refuse('AMBIGUOUS_ACF_ROW', `${hits.length} rows match; give a site code`);
  if (hits.length === 1) return { row: hits[0]!, assumptions: [] };
  if ('county' in key && opts.useNearestSiteAssumption) {
    const site = A32_NEAREST_ACF_SITE[`${key.state.toUpperCase()}|${key.county}`];
    const r = site ? t.rows.find((x) => norm(x.site) === norm(site)) : undefined;
    if (r) return { row: r, assumptions: [{ id: 'A-32', text: `no ACF row for ${key.county} County, ${key.state}; nearest listed site used`, value: r.site }] };
  }
  return refuse('NO_ACF_ROW', `no ACF row for ${JSON.stringify(key)}; no fallback to 1.0`);
}

/**
 * C_B = C_A * ACF_B / ACF_A within one edition (spec 6.6). A labelled context number ONLY: "Do not use
 * the MILCON ACFs to modify detailed quantity take-offs, unit price book (UPB) line items, commercial
 * cost data, or user-generated unit costs." [R]
 */
export function acfFactor(tA: AcfTable, rowA: AcfRow, tB: AcfTable, rowB: AcfRow): PlaceFactor {
  if (tA.edition !== tB.edition || tA.kind !== tB.kind) refuse('EDITION_MISMATCH', `ACF factors from two editions (${tA.edition} ${tA.kind} / ${tB.edition} ${tB.kind})`);
  if (!tA.rows.includes(rowA) || !tB.rows.includes(rowB)) refuse('EDITION_MISMATCH', 'row does not belong to the table given');
  const a = parseDecimal(rowA.value, rowA.site);
  const b = parseDecimal(rowB.value, rowB.site);
  if (a.num <= 0n || b.num <= 0n) refuse('INDEX_NOT_POSITIVE', 'ACF must be > 0');
  return {
    method: 'acf',
    appliesTo: 'context-only',
    factor: rDiv(b, a),
    from: rowA.site,
    to: rowB.site,
    edition: `${tA.edition} ${tA.kind}`,
    lowConfidence: false,
    labels: ['context only: never a multiplier on a takeoff, unit-price line or user unit cost (DoD ACF limit)'],
    assumptions: [],
  };
}

/** Same-method, same-edition place factor chaining: f(A,C) = f(A,B) * f(B,C) (invariant 87). */
export function chainPlaceFactors(a: PlaceFactor, b: PlaceFactor): PlaceFactor {
  if (a.method !== b.method || a.edition !== b.edition) refuse('EDITION_MISMATCH', 'cannot chain place factors from two methods or editions');
  if (a.to !== b.from) refuse('CHAIN_GAP', `chain breaks between ${a.to} and ${b.from}`);
  return { ...a, to: b.to, factor: rMul(a.factor, b.factor), lowConfidence: a.lowConfidence || b.lowConfidence, labels: [...new Set([...a.labels, ...b.labels])], assumptions: [...a.assumptions, ...b.assumptions] };
}

// ---------------------------------------------------------------- combined formula (spec 6.7)

export interface CombinedInput {
  readonly id: string;
  readonly amount: Cents; // C(A, t1)
  /** 'takeoff' = this bid's own quantities and quotes; 'historical' = an old cost being moved; 'parametric' = whole-project check. */
  readonly basis: 'takeoff' | 'historical' | 'parametric';
  readonly bucket: 'labor' | 'material' | 'equipment' | 'other' | 'whole';
  /** Firm price hold through the purchase date: time factor exactly 1. */
  readonly firmHoldThroughPurchase?: boolean;
  /** Labor at a known scheduled wage rate: time factor exactly 1. */
  readonly scheduledLabor?: boolean;
  /** A forward-priced quote: not escalated again. */
  readonly forwardPriced?: boolean;
  /** Inputs that are already local (local quote, local wage determination): no location factor. */
  readonly alreadyLocal?: boolean;
  /** LF_B / LF_A. */
  readonly place?: PlaceFactor;
  /** I_nat(t_last) / I_nat(t1): must be a national index when combined with a place factor. */
  readonly time?: IndexRatio;
  /** F(T) / F(t_last), starting where the index stops (spec 6.2). */
  readonly forward?: Ratio;
}

export interface CombinedResult {
  readonly id: string;
  readonly amount: Cents;
  readonly placeFactor: Ratio;
  readonly timeFactor: Ratio; // index part x forward part
  readonly factor: Ratio;
  readonly contextOnly: boolean;
  readonly notes: readonly string[];
}

/**
 * C(B, T) = C(A, t1) * [LF_B/LF_A] * [I_nat(t_last)/I_nat(t1)] * [F(T)/F(t_last)], rounded once (spec 6.7).
 * Guards: hold / scheduled labor / forward-priced -> time factor exactly 1; no location factor on
 * local inputs or on a takeoff; ACF only for a parametric whole-project check; wage ratio on labor
 * dollars only; a place factor combines only with a national time index.
 */
export function combinedAdjustment(x: CombinedInput, mode: RoundingMode = 'half-up'): CombinedResult {
  assertCents(x.amount);
  const notes: string[] = [];
  let pf = ONE;
  let contextOnly = false;
  if (x.place) {
    if (x.alreadyLocal) refuse('LOCATION_ON_LOCAL_INPUT', `${x.id}: a location factor is never applied to inputs that are already local`);
    if (x.basis === 'takeoff') refuse('LOCATION_ON_TAKEOFF', `${x.id}: a takeoff-based bid takes place from local inputs, not a factor`);
    if (x.place.method === 'acf' && (x.basis !== 'parametric' || x.bucket !== 'whole'))
      refuse('ACF_CONTEXT_ONLY', `${x.id}: ACFs are for whole-project parametric checks only`);
    if (x.place.method === 'wage-ratio' && x.bucket !== 'labor') refuse('WAGE_RATIO_LABOR_ONLY', `${x.id}: a wage ratio moves labor dollars only`);
    if (x.place.method === 'composite' && x.bucket !== 'whole') refuse('COMPOSITE_WHOLE_JOB_ONLY', `${x.id}: a composite factor applies to a whole-job historical cost`);
    pf = x.place.factor;
    contextOnly = x.place.appliesTo === 'context-only';
    notes.push(...x.place.labels);
    if (x.time && x.time.geography !== 'national') refuse('TIME_INDEX_NOT_NATIONAL', `${x.id}: time and place multiply cleanly only with a national time index`);
  }
  let tf = ONE;
  const frozen = x.firmHoldThroughPurchase ? 'firm price hold' : x.scheduledLabor ? 'labor at a known scheduled rate' : x.forwardPriced ? 'forward-priced quote' : null;
  if (frozen) {
    if (x.time || x.forward) notes.push(`${x.id}: ${frozen}: time factor exactly 1 (escalation inputs ignored)`);
  } else {
    if (x.time) {
      tf = rMul(tf, x.time.ratio);
      notes.push(...x.time.notes);
    }
    if (x.forward) {
      if (x.forward.num <= 0n) refuse('INDEX_NOT_POSITIVE', 'forward factor must be > 0');
      tf = rMul(tf, x.forward);
    }
  }
  const f = rMul(pf, tf);
  return { id: x.id, amount: applyFactor(x.amount, f, mode), placeFactor: pf, timeFactor: tf, factor: f, contextOnly, notes };
}
