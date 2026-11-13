// Time adjustment (spec section 6.1 to 6.5 and 6.8): index-ratio escalation, the forward factor
// behind e_i (spec 2.6), midpoint and cost-loaded variants, the published-factor table, the series
// registry with its fail-closed rules and the staleness warning, and price-adjustment clauses.
//
// Index values are inputs, each with series id, period, preliminary flag, reference base and source.
// They are parsed from their published decimal text into exact fractions, so a ratio of two index
// values is exact; money is rounded to the cent once per escalated line (spec 0.3). The only place a
// float appears is in display-only context figures (r_eq, the even-spending midpoint check), each
// marked as such. No clock, no I/O, no randomness.

import {
  assertCents,
  assertInt,
  divRound,
  isoDate,
  ratio,
  rCmp,
  rDiv,
  refuse,
  rMul,
  rSub,
  rAdd,
  rToNumber,
  toCents,
  type Cents,
  type IsoDate,
  type QtyM,
  type Ratio,
  type RoundingMode,
} from './money.js';
import type { AssumptionUsed } from './types.js';

// ---------------------------------------------------------------- exact helpers

const ONE: Ratio = ratio(1n);
const ZERO: Ratio = ratio(0n);
const B_PPM = 1_000_000n;

function gcdN(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Exact non-negative decimal text ('564.877', '1.021') to a fraction. Refuses junk and signs. */
export function parseDecimal(s: string, what = 'value'): Ratio {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(typeof s === 'string' ? s.trim() : '');
  if (!m) refuse('BAD_INDEX_VALUE', `${what}: expected a non-negative decimal, got ${JSON.stringify(s)}`);
  const frac = m[2] ?? '';
  return ratio(BigInt(m[1]! + frac), 10n ** BigInt(frac.length));
}

/** Ratio from a signed ppm integer: 21_000 -> 0.021. */
export function ratioFromPpm(r: number, what = 'rate'): Ratio {
  if (!Number.isSafeInteger(r)) refuse('NOT_SAFE_INTEGER', `${what} must be a safe integer ppm, got ${String(r)}`);
  return ratio(BigInt(r), B_PPM);
}

function rAbs(a: Ratio): Ratio {
  return a.num < 0n ? ratio(-a.num, a.den) : a;
}

/** Round a non-negative exact amount (cents as a fraction) to whole cents, once (spec 0.3). */
export function roundRatioCents(a: Ratio, mode: RoundingMode = 'half-up', what = 'amount'): Cents {
  if (a.num < 0n) refuse('NEGATIVE', `${what} is negative`);
  return toCents(divRound(a.num, a.den, mode), what);
}

/**
 * Round half-up the positive number y whose k-th power is X/Y (X >= 0, Y > 0), exactly.
 * floor(2y) is the largest n with n^k * Y <= 2^k * X; round(y) = floor((floor(2y) + 1) / 2).
 * This rounds the true (generally irrational) value of a fractional power once, with no float.
 */
function roundKthRoot(X: bigint, Y: bigint, k: number): bigint {
  if (Y <= 0n || X < 0n) refuse('BAD_DIVISOR', 'root of a non-positive fraction');
  const K = BigInt(k);
  const T = (2n ** K) * X;
  const fits = (n: bigint): boolean => n ** K * Y <= T;
  if (!fits(1n)) return 0n; // floor(2y) = 0 -> round(y) = 0
  let lo = 1n;
  let hi = 2n;
  while (fits(hi)) {
    lo = hi;
    hi *= 2n;
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return (lo + 1n) / 2n;
}

/**
 * round_half_up(C * base * g^(m/12)) exactly, for C >= 0, base > 0, g > 0, whole months m >= 0.
 * The one rounding of a forward-escalated amount (spec 6.2, 0.3).
 */
export function roundScaledMonthlyPower(C: bigint, base: Ratio, g: Ratio, months: number): bigint {
  assertInt(months, 'months', 0, 1200);
  if (C < 0n) refuse('NEGATIVE', 'amount must be >= 0');
  if (base.num <= 0n || g.num <= 0n) refuse('INDEX_NOT_POSITIVE', 'factor must be > 0');
  if (C === 0n) return 0n;
  const d = gcdN(months, 12);
  const p = BigInt(months / d);
  const k = 12 / d;
  const K = BigInt(k);
  const X = C ** K * base.num ** K * g.num ** p;
  const Y = base.den ** K * g.den ** p;
  return roundKthRoot(X, Y, k);
}

// ---------------------------------------------------------------- periods and dates

export type Frequency = 'monthly' | 'quarterly' | 'annual';

const PERIOD_RE: Record<Frequency, RegExp> = {
  monthly: /^(\d{4})-(0[1-9]|1[0-2])$/,
  quarterly: /^(\d{4})-Q([1-4])$/,
  annual: /^(\d{4})$/,
};

/** Integer ordinal of a period for its frequency (months, quarters or years since year 0). */
export function periodOrdinal(period: string, f: Frequency): number {
  const m = PERIOD_RE[f].exec(period);
  if (!m) refuse('BAD_PERIOD', `period ${JSON.stringify(period)} is not ${f}`);
  const y = Number(m[1]);
  if (f === 'monthly') return y * 12 + Number(m[2]) - 1;
  if (f === 'quarterly') return y * 4 + Number(m[2]) - 1;
  return y;
}

/** The period a calendar date falls in (bid-open quarter, quote month...). */
export function periodOfDate(d: IsoDate, f: Frequency): string {
  isoDate(d);
  const y = d.slice(0, 4);
  const mo = Number(d.slice(5, 7));
  if (f === 'monthly') return d.slice(0, 7);
  if (f === 'quarterly') return `${y}-Q${Math.floor((mo - 1) / 3) + 1}`;
  return y;
}

/** 'YYYY-MM' of a date. */
export const monthOf = (d: IsoDate): string => periodOfDate(d, 'monthly');

/** Whole calendar months from month a to month b ('YYYY-MM'); may be negative. */
export function monthsBetween(a: string, b: string): number {
  return periodOrdinal(b, 'monthly') - periodOrdinal(a, 'monthly');
}

function monthFromOrdinal(o: number): string {
  const y = Math.floor(o / 12);
  const m = o - y * 12 + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

/** Days since 1970-01-01 (proleptic Gregorian), pure integer arithmetic. */
export function dayNumber(d: IsoDate): number {
  isoDate(d);
  let y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of dayNumber. */
export function fromDayNumber(z0: number): IsoDate {
  assertInt(z0, 'day number', -100_000_000, 100_000_000);
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return isoDate(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
}

// ---------------------------------------------------------------- series registry (spec 6.5, 1.10)

/** One published index value [P]. Every field is required: a value with no provenance is refused. */
export interface IndexObservation {
  readonly seriesId: string;
  readonly period: string; // 'YYYY-MM' | 'YYYY-Qn' | 'YYYY', matching the series frequency
  readonly value: string; // as published, e.g. '564.877' (BLS prints three decimals)
  readonly preliminary: boolean; // PPI: the newest four months are preliminary (spec 6.5 rule 2)
  readonly referenceBase: string; // e.g. '1982=100', '2020=100'
  readonly source: string; // URL of the pull
  readonly pulledOn?: IsoDate;
}

export interface IndexSeriesInput {
  readonly id: string; // e.g. 'WPU10260314'
  readonly title: string;
  /** false: the title and base were not verified against the publisher (A-35). */
  readonly titleVerified: boolean;
  readonly source: string;
  readonly frequency: Frequency;
  readonly referenceBase: string;
  /** 'national' for a national index (the only kind that combines with a place factor, spec 6 and 6.7). */
  readonly geography: string;
  readonly observations: readonly IndexObservation[];
}

export interface IndexPoint {
  readonly period: string;
  readonly ordinal: number;
  readonly raw: string;
  readonly value: Ratio;
  readonly preliminary: boolean;
  readonly source: string;
}

/** A validated series: one id, one base, one value per period, all values > 0. */
export interface IndexSeries {
  readonly id: string;
  readonly title: string;
  readonly titleVerified: boolean;
  readonly source: string;
  readonly frequency: Frequency;
  readonly referenceBase: string;
  readonly geography: string;
  /** Sorted by period. */
  readonly points: readonly IndexPoint[];
  /** Warnings that travel with every figure derived from this series (A-35 title note...). */
  readonly notes: readonly string[];
}

/**
 * Validate a registry entry (spec 6.5 rule 3): values from two series or two bases, a duplicate
 * period with a different value, an index <= 0 or a final value newer than a preliminary one are
 * errors. Nothing ever falls back to 1.0.
 */
export function normalizeSeries(s: IndexSeriesInput): IndexSeries {
  if (!s.id) refuse('MISSING_SERIES', 'series id is required');
  if (!(s.frequency in PERIOD_RE)) refuse('BAD_FREQUENCY', `unknown frequency ${String(s.frequency)}`);
  const byPeriod = new Map<string, IndexPoint>();
  for (const o of s.observations) {
    if (o.seriesId !== s.id) refuse('SERIES_MISMATCH', `observation ${o.period} belongs to ${o.seriesId}, not ${s.id}`);
    if (o.referenceBase !== s.referenceBase)
      refuse('BASE_MISMATCH', `${s.id} ${o.period}: reference base ${o.referenceBase} differs from ${s.referenceBase}`);
    if (!o.source) refuse('MISSING_SOURCE', `${s.id} ${o.period}: every index value needs its source`);
    if (typeof o.preliminary !== 'boolean') refuse('MISSING_PRELIMINARY_FLAG', `${s.id} ${o.period}: preliminary flag is required`);
    const v = parseDecimal(o.value, `${s.id} ${o.period}`);
    if (v.num <= 0n) refuse('INDEX_NOT_POSITIVE', `${s.id} ${o.period}: index must be > 0, got ${o.value}`);
    const ord = periodOrdinal(o.period, s.frequency);
    const prev = byPeriod.get(o.period);
    if (prev) {
      if (rCmp(prev.value, v) !== 0 || prev.preliminary !== o.preliminary)
        refuse('DUPLICATE_PERIOD', `${s.id} ${o.period} appears twice with different values`);
      continue;
    }
    byPeriod.set(o.period, { period: o.period, ordinal: ord, raw: o.value, value: v, preliminary: o.preliminary, source: o.source });
  }
  const points = [...byPeriod.values()].sort((a, b) => a.ordinal - b.ordinal);
  let seenPrelim = false;
  for (const p of points) {
    if (p.preliminary) seenPrelim = true;
    else if (seenPrelim) refuse('PRELIMINARY_ORDER', `${s.id} ${p.period} is final but an earlier period is preliminary`);
  }
  const notes = s.titleVerified ? [] : [`A-35: title and reference base of ${s.id} not verified against the publisher`];
  return { id: s.id, title: s.title, titleVerified: s.titleVerified, source: s.source, frequency: s.frequency, referenceBase: s.referenceBase, geography: s.geography, points, notes };
}

/** The value for one period. Missing -> error; preliminary -> error unless allowed (spec 6.5 rules 2, 3). */
export function indexPoint(series: IndexSeries, period: string, opts: { allowPreliminary?: boolean } = {}): IndexPoint {
  periodOrdinal(period, series.frequency);
  const p = series.points.find((x) => x.period === period);
  if (!p) refuse('MISSING_INDEX_VALUE', `${series.id} has no value for ${period}; no fallback to 1.0`);
  if (p.preliminary && !opts.allowPreliminary)
    refuse('PRELIMINARY_VALUE', `${series.id} ${period} is preliminary; stored factors use the latest final period`);
  return p;
}

/** Latest final (not preliminary) period, t_last (spec 6.2). */
export function latestFinal(series: IndexSeries): IndexPoint {
  let last: IndexPoint | undefined;
  for (const p of series.points) if (!p.preliminary) last = p;
  if (!last) refuse('NO_FINAL_VALUE', `${series.id} has no final value`);
  return last;
}

/** I(t2)/I(t1) of ONE series, with both raw values kept for the line's provenance (spec 6.1). */
export interface IndexRatio {
  readonly seriesId: string;
  readonly referenceBase: string;
  readonly geography: string;
  readonly fromPeriod: string;
  readonly toPeriod: string;
  readonly fromRaw: string;
  readonly toRaw: string;
  readonly ratio: Ratio;
  readonly preliminary: boolean;
  readonly notes: readonly string[];
}

/** Spec 6.1: C(t2) = C(t1) * I(t2)/I(t1), both values from one named series on one base. */
export function indexRatio(series: IndexSeries, fromPeriod: string, toPeriod: string, opts: { allowPreliminary?: boolean } = {}): IndexRatio {
  const a = indexPoint(series, fromPeriod, opts);
  const b = indexPoint(series, toPeriod, opts);
  const notes = [...series.notes];
  if (a.preliminary || b.preliminary) notes.push(`${series.id}: uses a preliminary value; it will be revised`);
  return {
    seriesId: series.id,
    referenceBase: series.referenceBase,
    geography: series.geography,
    fromPeriod,
    toPeriod,
    fromRaw: a.raw,
    toRaw: b.raw,
    ratio: rDiv(b.value, a.value),
    preliminary: a.preliminary || b.preliminary,
    notes,
  };
}

/** Refuse to combine figures from two series or two bases (spec 6.5 rule 3). */
export function assertSameSeries(a: { seriesId: string; referenceBase: string }, b: { seriesId: string; referenceBase: string }): void {
  if (a.seriesId !== b.seriesId) refuse('SERIES_MISMATCH', `cannot combine ${a.seriesId} with ${b.seriesId}`);
  if (a.referenceBase !== b.referenceBase) refuse('BASE_MISMATCH', `cannot combine bases ${a.referenceBase} and ${b.referenceBase}`);
}

/** Chain: I(tn)/I(t0) = product of consecutive relatives (multiply, never add percentages; spec 6.1). */
export function chainIndexRatios(rs: readonly IndexRatio[]): IndexRatio {
  if (rs.length === 0) refuse('EMPTY_CHAIN', 'nothing to chain');
  let acc = rs[0]!;
  for (let i = 1; i < rs.length; i++) {
    const r = rs[i]!;
    assertSameSeries(acc, r);
    if (r.fromPeriod !== acc.toPeriod) refuse('CHAIN_GAP', `chain breaks between ${acc.toPeriod} and ${r.fromPeriod}`);
    acc = { ...acc, toPeriod: r.toPeriod, toRaw: r.toRaw, ratio: rMul(acc.ratio, r.ratio), preliminary: acc.preliminary || r.preliminary, notes: [...new Set([...acc.notes, ...r.notes])] };
  }
  return acc;
}

/** Rebase I'(t) = k * I(t), k > 0 (spec 6.1). Ratios are unchanged exactly (invariant 88). */
export function rebaseSeries(series: IndexSeries, k: Ratio, newBase: string): IndexSeries {
  if (k.num <= 0n) refuse('INDEX_NOT_POSITIVE', 'rebase factor must be > 0');
  return {
    ...series,
    referenceBase: newBase,
    points: series.points.map((p) => ({ ...p, value: rMul(p.value, k), raw: `${p.raw} x ${k.num}/${k.den}` })),
  };
}

/** pct = (I(t2)/I(t1) - 1) * 100, exact; never a difference in index points (spec 6.1). Signed. */
export function percentChange(f: Ratio): Ratio {
  return rMul(rSub(f, ONE), ratio(100n));
}

/** r_eq = (I2/I1)^(12/m) - 1: trailing annualized rate, CONTEXT ONLY (float, spec 6.2). */
export function equivalentAnnualRate(f: Ratio, months: number): number {
  assertInt(months, 'months', 1);
  if (f.num <= 0n) refuse('INDEX_NOT_POSITIVE', 'ratio must be > 0');
  return Math.pow(rToNumber(f), 12 / months) - 1;
}

/** One escalated amount: round(c * factor) once (spec 6.1, 0.3). factor >= 0. */
export function escalateCents(c: Cents, factor: Ratio, mode: RoundingMode = 'half-up'): Cents {
  assertCents(c);
  if (factor.num < 0n) refuse('NEGATIVE', 'factor must be >= 0');
  return toCents(divRound(BigInt(c) * factor.num, factor.den, mode), 'escalated amount');
}

export interface EscalatedLine {
  readonly id: string;
  readonly base: Cents;
  readonly adjusted: Cents;
  readonly factor: Ratio;
  /** series id and both raw values, stored with every escalated line (spec 6.1). */
  readonly provenance: IndexRatio | null;
}

/** A line escalated by its own series (spec 6.5 rule 1: each material class uses its own series). */
export function escalateLine(id: string, amount: Cents, r: IndexRatio, mode: RoundingMode = 'half-up'): EscalatedLine {
  return { id, base: assertCents(amount), adjusted: escalateCents(amount, r.ratio, mode), factor: r.ratio, provenance: r };
}

/**
 * Composite factor = dollar-weighted mean of the line factors, sum(c_i f_i) / sum(c_i), exact
 * (invariant 90). Also the cost-loaded factor of spec 6.3, F = sum s_k F(t_k) with s_k = c_k / sum c.
 */
export function compositeFactor(lines: readonly { readonly amount: Cents; readonly factor: Ratio }[]): Ratio {
  if (lines.length === 0) refuse('NO_LINES', 'composite factor needs at least one line');
  let num: Ratio = ZERO;
  let tot = 0n;
  for (const l of lines) {
    assertCents(l.amount);
    if (l.factor.num < 0n) refuse('NEGATIVE', 'factor must be >= 0');
    num = rAdd(num, rMul(ratio(BigInt(l.amount)), l.factor));
    tot += BigInt(l.amount);
  }
  if (tot === 0n) refuse('ZERO_WEIGHTS', 'all line amounts are zero');
  return rDiv(num, ratio(tot));
}

/** Cost-loaded factor with shares given directly (spec 6.3): shares must sum to exactly 1. */
export function costLoadedFactor(parts: readonly { readonly share: Ratio; readonly factor: Ratio }[]): Ratio {
  if (parts.length === 0) refuse('NO_LINES', 'cost-loaded factor needs at least one activity');
  let s: Ratio = ZERO;
  let F: Ratio = ZERO;
  for (const p of parts) {
    if (p.share.num < 0n || p.factor.num < 0n) refuse('NEGATIVE', 'shares and factors must be >= 0');
    s = rAdd(s, p.share);
    F = rAdd(F, rMul(p.share, p.factor));
  }
  if (rCmp(s, ONE) !== 0) refuse('SHARES_NOT_ONE', `shares sum to ${s.num}/${s.den}, not 1`);
  return F;
}

// ---------------------------------------------------------------- published factor table (spec 6.4)

/** A factor table with yearly anchors (DoD: 1 October), F(base) = 1. Reference only (D-77). */
export interface FactorTable {
  readonly id: string;
  readonly source: string;
  readonly effective: string;
  /** Anchors 'YYYY-MM', exactly 12 months apart, increasing. */
  readonly anchors: readonly { readonly month: string; readonly factor: Ratio }[];
}

function validateTable(t: FactorTable): void {
  if (t.anchors.length < 2) refuse('BAD_TABLE', `${t.id}: needs at least two anchors`);
  for (let i = 0; i < t.anchors.length; i++) {
    const a = t.anchors[i]!;
    if (a.factor.num <= 0n) refuse('INDEX_NOT_POSITIVE', `${t.id} ${a.month}: factor must be > 0`);
    if (i > 0 && monthsBetween(t.anchors[i - 1]!.month, a.month) !== 12) refuse('BAD_TABLE', `${t.id}: anchors must be 12 months apart`);
  }
}

/** F(Y) = product_{y = base+1..Y} (1 + r_y), F(base) = 1: compounded, never a sum of rates (spec 6.4). */
export function factorTableFromRates(id: string, source: string, effective: string, baseMonth: string, ratesPpm: readonly number[]): FactorTable {
  periodOrdinal(baseMonth, 'monthly');
  const anchors: { month: string; factor: Ratio }[] = [{ month: baseMonth, factor: ONE }];
  let F = ONE;
  const o = periodOrdinal(baseMonth, 'monthly');
  ratesPpm.forEach((r, i) => {
    assertInt(r, `rate ${i}`, -999_999);
    F = rMul(F, rAdd(ONE, ratioFromPpm(r)));
    anchors.push({ month: monthFromOrdinal(o + 12 * (i + 1)), factor: F });
  });
  const t = { id, source, effective, anchors };
  validateTable(t);
  return t;
}

/** A table from published factor text (e.g. '1.04142'). */
export function factorTableFromPublished(id: string, source: string, effective: string, anchors: readonly { readonly month: string; readonly value: string }[]): FactorTable {
  const t = { id, source, effective, anchors: anchors.map((a) => ({ month: a.month, factor: parseDecimal(a.value, `${id} ${a.month}`) })) };
  validateTable(t);
  return t;
}

function bracket(t: FactorTable, month: string): { k: number; m: number } {
  validateTable(t);
  const off = monthsBetween(t.anchors[0]!.month, month);
  const last = 12 * (t.anchors.length - 1);
  if (off < 0 || off > last) refuse('OUTSIDE_TABLE', `${month} is outside ${t.id} (${t.anchors[0]!.month} to ${t.anchors[t.anchors.length - 1]!.month})`);
  const k = Math.min(Math.floor(off / 12), t.anchors.length - 2);
  return { k, m: off - 12 * k };
}

/** DoD linear interpolation between anchors: F(d) = F(Y_k) + (m_k/12) * (F(Y_k+1) - F(Y_k)) (spec 6.4). */
export function interpolateFactor(t: FactorTable, month: string): Ratio {
  const { k, m } = bracket(t, month);
  const a = t.anchors[k]!.factor;
  const b = t.anchors[k + 1]!.factor;
  return rAdd(a, rMul(ratio(m, 12), rSub(b, a)));
}

/** Geometric interpolation F(Y_k) * (F(Y_k+1)/F(Y_k))^(m/12): CONTEXT ONLY (float); lower than linear by <= F r^2/8. */
export function interpolateFactorGeometric(t: FactorTable, month: string): number {
  const { k, m } = bracket(t, month);
  const a = rToNumber(t.anchors[k]!.factor);
  const b = rToNumber(t.anchors[k + 1]!.factor);
  return a * Math.pow(b / a, m / 12);
}

/** Forward part from a table: F(T)/F(t_last), both interpolated; never anchored at the table base (spec 6.2). */
export function tableForwardFactor(t: FactorTable, fromMonth: string, toMonth: string): Ratio {
  return rDiv(interpolateFactor(t, toMonth), interpolateFactor(t, fromMonth));
}

// ---------------------------------------------------------------- forward factor (spec 6.2)

/** 1 + r as an exact fraction from signed ppm; r > -100%. r_fwd has NO default (A-21). */
function onePlus(rPpm: number, what: string): Ratio {
  assertInt(rPpm, what, -999_999, 10_000_000);
  return ratio(B_PPM + BigInt(rPpm), B_PPM);
}

/** Exact round(c * (1 + r)^(m/12)) once: forward escalation of an amount (spec 6.2; I-18 figures). */
export function escalateForward(c: Cents, rFwdPpm: number, months: number): Cents {
  assertCents(c);
  return toCents(roundScaledMonthlyPower(BigInt(c), ONE, onePlus(rFwdPpm, 'r_fwd'), months), 'forward-escalated amount');
}

/**
 * Signed ppm of (factor - 1), factor = base * (1 + r)^(m/12), rounded half-up once on factor*10^6
 * (spec 6.2 "e_i = round((factor - 1) * 1_000_000)"). Computed exactly, not in float64.
 */
export function forwardFactorPpm(rFwdPpm: number, months: number, base: Ratio = ONE): number {
  const y = roundScaledMonthlyPower(B_PPM, base, onePlus(rFwdPpm, 'r_fwd'), months);
  return Number(y - B_PPM);
}

/** Signed ppm of (f - 1) for a rational factor, rounded half-up on f*10^6. */
export function ratioToSignedPpm(f: Ratio): number {
  if (f.num < 0n) refuse('NEGATIVE', 'factor must be >= 0');
  const y = divRound(f.num * B_PPM, f.den);
  const e = y - B_PPM;
  if (e > BigInt(Number.MAX_SAFE_INTEGER)) refuse('UNSAFE_INTEGER', 'factor too large');
  return Number(e);
}

export interface QuoteEscalationInput {
  readonly lineId: string;
  readonly quotedOn: IsoDate;
  readonly purchaseDate: IsoDate;
  /** A firm price hold through this date: factor exactly 1 when it covers the purchase date. */
  readonly holdThrough?: IsoDate;
  /** The quote is already priced for the purchase date: never escalated again (spec 2.6, 6.7). */
  readonly forwardPriced?: boolean;
  /** The line's own class series (spec 6.5 rule 1). Omitted -> no historical part (hist = 1). */
  readonly series?: IndexSeries;
  /** r_fwd, the user's annual rate in signed ppm. No default (A-21). */
  readonly rFwdPpm?: number;
  /** Alternative to r_fwd: a published factor table; the forward part is F(T)/F(start). */
  readonly forwardTable?: FactorTable;
  /** Staleness threshold on abs(I(t_last)/I(quote) - 1), ppm. A-25 names it but gives no value. */
  readonly stalenessThresholdPpm?: number;
}

export interface QuoteEscalation {
  readonly lineId: string;
  readonly kind: 'price-hold' | 'forward-priced' | 'escalated';
  /** Exact factor when it is rational (hold, index-only, or table); null when it has an irrational forward part. */
  readonly exactFactor: Ratio | null;
  /** e_i, signed ppm, rounded once. Negative when the index fell (see ePpmForMaterialLine). */
  readonly ePpm: number;
  readonly hist: IndexRatio | null;
  readonly tLast: string | null;
  readonly start: string; // month the forward part starts from
  readonly forwardMonths: number;
  readonly forwardBasis: 'none' | 'rate' | 'table';
  readonly rFwdPpm: number | null;
  /** abs(I(t_last)/I(quote) - 1) in exact form; null when there is no historical part. */
  readonly staleness: Ratio | null;
  /** true -> tell the user to re-quote (spec 6.5 rule 5); null when undecidable (no series or no threshold). */
  readonly stale: boolean | null;
  readonly warnings: readonly string[];
  readonly assumptions: readonly AssumptionUsed[];
}

/**
 * Spec 6.2. factor = hist * F_fwd(months(start -> purchaseDate)), with hist the series' own movement
 * from the quote month to its latest FINAL month and the forward part starting where the index stops.
 */
export function quoteEscalation(q: QuoteEscalationInput): QuoteEscalation {
  isoDate(q.quotedOn);
  isoDate(q.purchaseDate);
  const qm = monthOf(q.quotedOn);
  const pm = monthOf(q.purchaseDate);
  const base = { lineId: q.lineId, hist: null, tLast: null, start: qm, forwardMonths: 0, forwardBasis: 'none' as const, rFwdPpm: null, staleness: null, stale: null, assumptions: [] };
  if (q.holdThrough !== undefined && isoDate(q.holdThrough) >= q.purchaseDate) {
    return { ...base, kind: 'price-hold', exactFactor: ONE, ePpm: 0, warnings: [] };
  }
  if (q.forwardPriced) return { ...base, kind: 'forward-priced', exactFactor: ONE, ePpm: 0, warnings: [] };
  if (q.purchaseDate < q.quotedOn) refuse('PURCHASE_BEFORE_QUOTE', `${q.lineId}: purchase date ${q.purchaseDate} is before the quote ${q.quotedOn}`);
  if (q.rFwdPpm !== undefined && q.forwardTable !== undefined) refuse('AMBIGUOUS_FORWARD', `${q.lineId}: give r_fwd or a factor table, not both`);

  const warnings: string[] = [];
  let hist: IndexRatio | null = null;
  let tLast: string | null = null;
  let start = qm;
  let staleness: Ratio | null = null;
  let stale: boolean | null = null;
  if (q.series) {
    const s = q.series;
    if (s.frequency !== 'monthly') refuse('SERIES_NOT_MONTHLY', `${s.id}: forward escalation needs a monthly series`);
    warnings.push(...s.notes);
    tLast = latestFinal(s).period;
    // Historical part ends at the earlier of t_last and the purchase month (see specIssues 6.2).
    const histEnd = monthsBetween(tLast, pm) < 0 ? pm : tLast;
    if (monthsBetween(qm, histEnd) > 0) {
      hist = indexRatio(s, qm, histEnd);
      start = histEnd;
    }
    if (monthsBetween(qm, tLast) > 0) {
      const st = indexRatio(s, qm, tLast);
      staleness = rAbs(rSub(st.ratio, ONE));
      if (q.stalenessThresholdPpm === undefined) {
        warnings.push('A-25: no staleness threshold set; cannot say whether this quote is stale');
      } else {
        assertInt(q.stalenessThresholdPpm, 'staleness threshold', 0);
        stale = rCmp(staleness, ratioFromPpm(q.stalenessThresholdPpm)) > 0;
        if (stale) warnings.push(`${q.lineId}: ${s.id} moved more than the staleness threshold since the quote; re-quote`);
      }
    }
  }
  const m = monthsBetween(start, pm);
  const h = hist ? hist.ratio : ONE;
  let ePpm: number;
  let exactFactor: Ratio | null;
  let forwardBasis: 'none' | 'rate' | 'table' = 'none';
  const assumptions: AssumptionUsed[] = [];
  if (m === 0) {
    exactFactor = h;
    ePpm = ratioToSignedPpm(h);
  } else if (q.forwardTable) {
    const f = rMul(h, tableForwardFactor(q.forwardTable, start, pm));
    exactFactor = f;
    ePpm = ratioToSignedPpm(f);
    forwardBasis = 'table';
    warnings.push(`forward part from ${q.forwardTable.id}: budget guidance, not a forecast (spec 6.2)`);
  } else if (q.rFwdPpm !== undefined) {
    ePpm = forwardFactorPpm(q.rFwdPpm, m, h);
    exactFactor = null;
    forwardBasis = 'rate';
    assumptions.push({ id: 'A-21', text: 'forward escalation rate entered by the user', value: `${q.rFwdPpm} ppm a year` });
  } else {
    return refuse('MISSING_FORWARD_RATE', `${q.lineId}: ${m} forward months need r_fwd or a factor table; there is no default (A-21)`);
  }
  if (ePpm < 0) warnings.push(`${q.lineId}: the factor is below 1 (prices fell); the quote may be high`);
  return { lineId: q.lineId, kind: 'escalated', exactFactor, ePpm, hist, tLast, start, forwardMonths: m, forwardBasis, rFwdPpm: q.rFwdPpm ?? null, staleness, stale, warnings, assumptions };
}

/**
 * e_i for the materials module, which refuses a negative escalation (core spec issue 2.6 / 6.2).
 * A fall is refused unless the caller opts in to 'zero-with-warning', which returns 0 and a
 * visible label (spec 12.1 rule 13: no silent substitution).
 */
export function ePpmForMaterialLine(e: QuoteEscalation, onDecrease: 'refuse' | 'zero-with-warning' = 'refuse'): { ePpm: number; warning?: string } {
  if (e.ePpm >= 0) return { ePpm: e.ePpm };
  if (onDecrease === 'refuse') refuse('NEGATIVE_ESCALATION', `${e.lineId}: the index fell (${e.ePpm} ppm); an escalation line cannot be negative`);
  return { ePpm: 0, warning: `${e.lineId}: index fell ${-e.ePpm} ppm; escalation set to 0 (the quote is kept as is and may be high)` };
}

// ---------------------------------------------------------------- midpoint (spec 6.3)

/** T_mid = T_start + (T_end - T_start)/2, on whole days, rounded down to the earlier day (spec 6.3). */
export function midpointDate(start: IsoDate, end: IsoDate): IsoDate {
  const a = dayNumber(start);
  const b = dayNumber(end);
  if (b < a) refuse('BAD_DATES', `end ${end} is before start ${start}`);
  return fromDayNumber(a + Math.floor((b - a) / 2));
}

/**
 * Even spending at annual rate r over D years, CONTEXT ONLY (float): exact average factor
 * ((1+r)^D - 1)/(D ln(1+r)) against the midpoint factor (1+r)^(D/2); their ratio is
 * sinh(gD/2)/(gD/2) ~ 1 + (gD)^2/24 with g = ln(1+r) (spec 6.3).
 */
export function evenSpendingFactors(rPpm: number, years: number): { average: number; midpoint: number; ratio: number; approx: number } {
  assertInt(rPpm, 'r', -999_999);
  if (!Number.isFinite(years) || years < 0) refuse('BAD_DURATION', 'duration must be >= 0 years');
  const g = Math.log1p(rPpm / 1e6);
  const x = (g * years) / 2;
  const midpoint = Math.exp(x);
  const ratioV = x === 0 ? 1 : Math.sinh(x) / x;
  return { average: midpoint * ratioV, midpoint, ratio: ratioV, approx: 1 + (g * years) ** 2 / 24 };
}

// ---------------------------------------------------------------- price-adjustment clauses (spec 6.8)

/** A signed money change, as a direction and a non-negative magnitude in cents. */
export interface SignedCents {
  readonly direction: 'increase' | 'decrease' | 'none';
  readonly amount: Cents;
}

function signed(exact: Ratio, mode: RoundingMode): SignedCents {
  const a = roundRatioCents(rAbs(exact), mode, 'adjustment');
  if (a === 0) return { direction: 'none', amount: a };
  return { direction: exact.num > 0n ? 'increase' : 'decrease', amount: a };
}

export interface IndexClauseInput {
  /** P_base: the contract's base price for the indexed material or quantity. */
  readonly basePrice: Cents;
  /** phi, the indexed share of that price, 0..1_000_000 ppm. From the contract. */
  readonly indexedSharePpm: number;
  /** I_cur / I_base from one series (indexRatio). */
  readonly index: IndexRatio;
  /** No adjustment while abs(change) < trigger. From the contract (D-82 guidance 3% to 10%). */
  readonly triggerPpm: number;
  /** Ceiling on the increase, ppm of the base; null = none. From the contract. */
  readonly capPpm: number | null;
  /** Limit on the decrease, ppm of the base; null = none. From the contract. */
  readonly floorPpm: number | null;
  /** Whether the whole change or only the part beyond the trigger is paid. From the contract. */
  readonly pays: 'whole-change' | 'beyond-trigger';
}

export interface IndexClauseResult extends SignedCents {
  readonly change: Ratio; // I_cur/I_base - 1, signed
  readonly paidChange: Ratio; // after trigger and clamp, signed
  readonly exact: Ratio; // P_base * phi * paidChange, signed, unrounded
  readonly triggered: boolean;
}

/**
 * FHWA-style index clause (spec 6.8): adj = abs(change) < trigger ? 0 :
 * P_base * phi * clamp(change or change beyond trigger, -floor, +cap). Rounded once to the cent.
 * Never use this for FAR 52.216-4 (see far52216_4Adjustment).
 */
export function indexClauseAdjustment(c: IndexClauseInput, mode: RoundingMode = 'half-up'): IndexClauseResult {
  assertCents(c.basePrice, 'base price');
  assertInt(c.indexedSharePpm, 'indexed share', 0, 1_000_000);
  assertInt(c.triggerPpm, 'trigger', 0);
  if (c.capPpm !== null) assertInt(c.capPpm, 'cap', 0);
  if (c.floorPpm !== null) assertInt(c.floorPpm, 'floor', 0);
  const change = rSub(c.index.ratio, ONE);
  const mag = rAbs(change);
  const trig = ratioFromPpm(c.triggerPpm);
  if (rCmp(mag, trig) < 0) return { direction: 'none', amount: 0 as Cents, change, paidChange: ZERO, exact: ZERO, triggered: false };
  let x = c.pays === 'whole-change' ? change : (change.num >= 0n ? rSub(mag, trig) : rSub(trig, mag));
  if (c.capPpm !== null && rCmp(x, ratioFromPpm(c.capPpm)) > 0) x = ratioFromPpm(c.capPpm);
  if (c.floorPpm !== null && rCmp(x, ratioFromPpm(-c.floorPpm)) < 0) x = ratioFromPpm(-c.floorPpm);
  const exact = rMul(rMul(ratio(BigInt(c.basePrice)), ratioFromPpm(c.indexedSharePpm)), x);
  return { ...signed(exact, mode), change, paidChange: x, exact, triggered: true };
}

/**
 * D-82 (law, FAR 52.216-4 "Economic Price Adjustment — Labor and Material"): no adjustment unless the
 * net change is at least 3% of the then-current total contract price; aggregate increases limited
 * to 10% of the original unit price (the contracting officer may raise it); no limit on decreases.
 * Source: https://raw.githubusercontent.com/GSA/GSA-Acquisition-FAR/master/dita/52.216-4.dita (as dated, [R]).
 */
export const D82_FAR_52_216_4_THRESHOLD_PPM = 30_000;
export const D82_FAR_52_216_4_INCREASE_CAP_PPM = 100_000;

export interface EpaScheduleItem {
  readonly id: string;
  readonly kind: 'labor-rate' | 'material-unit-price';
  /** Unit price or labor rate listed in the contract schedule. */
  readonly originalUnit: Cents;
  /** The actual current rate or unit price (not an index). */
  readonly actualUnit: Cents;
  /** Units the change applies to (remaining quantity), thousandths. */
  readonly units: QtyM;
  /** Increase per unit already granted under the clause, counted against the aggregate cap. */
  readonly priorUnitIncrease?: Cents;
}

export interface EpaResult extends SignedCents {
  readonly net: Ratio; // signed, before the threshold test
  readonly thresholdMet: boolean;
  readonly items: readonly { readonly id: string; readonly unitChange: Ratio; readonly capped: boolean }[];
  readonly note: string;
}

/**
 * FAR 52.216-4 (spec 6.8): actual changes in the scheduled labor rates and material unit prices,
 * never I_cur/I_base. Direct unit changes only: indirect cost and profit are excluded by construction.
 */
export function far52216_4Adjustment(
  items: readonly EpaScheduleItem[],
  currentTotalContractPrice: Cents,
  opts: { thresholdPpm?: number; increaseCapPpm?: number; mode?: RoundingMode } = {},
): EpaResult {
  assertCents(currentTotalContractPrice, 'current total contract price');
  const thr = assertInt(opts.thresholdPpm ?? D82_FAR_52_216_4_THRESHOLD_PPM, 'threshold', 0);
  const cap = assertInt(opts.increaseCapPpm ?? D82_FAR_52_216_4_INCREASE_CAP_PPM, 'increase cap', 0);
  let net: Ratio = ZERO;
  const out: { id: string; unitChange: Ratio; capped: boolean }[] = [];
  for (const it of items) {
    assertCents(it.originalUnit, `${it.id} original`);
    assertCents(it.actualUnit, `${it.id} actual`);
    assertInt(it.units, `${it.id} units`);
    const prior = assertCents(it.priorUnitIncrease ?? 0, `${it.id} prior increase`);
    let d: Ratio = ratio(BigInt(it.actualUnit) - BigInt(it.originalUnit));
    let capped = false;
    if (d.num > 0n) {
      // room = cap * original - prior, never below 0
      let room = rSub(rMul(ratio(BigInt(it.originalUnit)), ratioFromPpm(cap)), ratio(BigInt(prior)));
      if (room.num < 0n) room = ZERO;
      if (rCmp(d, room) > 0) {
        d = room;
        capped = true;
      }
    }
    out.push({ id: it.id, unitChange: d, capped });
    net = rAdd(net, rMul(d, ratio(BigInt(it.units), 1000n)));
  }
  const limit = rMul(ratio(BigInt(currentTotalContractPrice)), ratioFromPpm(thr));
  const thresholdMet = rCmp(rAbs(net), limit) >= 0 && net.num !== 0n;
  const note = 'FAR 52.216-4: actual scheduled rates and prices only; indirect cost and profit excluded; not an index clause';
  if (!thresholdMet) return { direction: 'none', amount: 0 as Cents, net, thresholdMet, items: out, note };
  return { ...signed(net, opts.mode ?? 'half-up'), net, thresholdMet, items: out, note };
}
