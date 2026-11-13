// Public unit-price sanity band (spec 6.9): optional, a FLAG, never a suggested price.
// Free public line-item prices exist only for roadway electrical work in other states; nothing public
// covers building electrical items, and nobody publishes labor-hour units. Rows are dated inputs with
// their source. Statistics are exact fractions; display figures are rounded at the edge.

import { assertCents, assertInt, isoDate, ratio, rAdd, rCmp, rDiv, refuse, rMul, rSub, rToNumber, type Cents, type IsoDate, type QtyM, type Ratio } from './money.js';
import type { AssumptionUsed } from './types.js';
import { periodOfDate, type IndexSeries } from './escalation.js';

/**
 * A-25 (assumption, editable, shown to the user): no flag below n_min = 5 rows; label "thin" below
 * n = 20 (D-85 agency rule of thumb: at least 20 results for a usable average,
 * https://sv08data.dot.ca.gov/searchtips.php, read 2026-11-12).
 */
export const A25_UNIT_PRICE_N_MIN = 5;
export const A25_UNIT_PRICE_THIN_N = 20;

/** One public bid line [P], as a dated row with attribution. */
export interface UnitPriceRow {
  readonly id: string;
  readonly source: string; // URL
  readonly state: string;
  readonly agency: string;
  readonly itemCode: string;
  readonly description: string;
  /** Normalized unit, e.g. 'LF', 'EA'. */
  readonly unit: string;
  /** "Lump sum" decided from the agency's item list (its bidding unit), not from a units column. */
  readonly biddingUnitIsLumpSum: boolean;
  /** The unit price is a lump sum divided by a plan quantity (e.g. Oregon illumination). */
  readonly lumpSumDerived: boolean;
  readonly awarded: boolean;
  readonly quantity: QtyM;
  readonly unitPrice: Cents;
  readonly bidOpenDate: IsoDate;
}

export interface ContractorUnitPrice {
  /** 'sell' = item sell total (direct cost + its share of overhead, profit, bond). 'direct' is refused. */
  readonly basis: 'sell' | 'direct';
  readonly itemSellTotal: Cents;
  /** Cost the bid form pays under a separate item (mobilization, time-related overhead): left out. */
  readonly separatelyPaid?: Cents;
  readonly quantity: QtyM;
  readonly unit: string;
}

/** u_contractor = (item sell total - separately paid) / quantity, cents per unit, exact (spec 6.9). */
export function likeForLikeUnitPrice(c: ContractorUnitPrice): Ratio {
  if (c.basis !== 'sell')
    refuse('DIRECT_COST_COMPARISON', 'a bid unit price includes overhead and profit: compare the loaded sell price, never direct cost');
  const sell = BigInt(assertCents(c.itemSellTotal, 'item sell total'));
  const sep = BigInt(assertCents(c.separatelyPaid ?? 0, 'separately paid'));
  if (sep > sell) refuse('NEGATIVE', 'separately paid cost exceeds the item sell total');
  assertInt(c.quantity, 'quantity');
  if (c.quantity <= 0) refuse('BAD_DIVISOR', 'quantity must be > 0');
  return ratio((sell - sep) * 1000n, BigInt(c.quantity));
}

/** Quantity-weighted mean Pw = sum(q_i p_i) / sum(q_i), exact. */
export function weightedMean(rows: readonly { readonly q: Ratio | bigint; readonly p: Ratio }[]): Ratio {
  if (rows.length === 0) refuse('NO_ROWS', 'weighted mean of no rows');
  let num = ratio(0n);
  let den = ratio(0n);
  for (const r of rows) {
    const q = typeof r.q === 'bigint' ? ratio(r.q) : r.q;
    if (q.num <= 0n) refuse('BAD_DIVISOR', 'quantities must be > 0');
    num = rAdd(num, rMul(q, r.p));
    den = rAdd(den, q);
  }
  return rDiv(num, den);
}

/** Pk on x sorted ascending, 0-indexed: h = (n-1)k; Pk = x[floor h] + (h - floor h)(x[min(floor h + 1, n-1)] - x[floor h]). */
export function percentile(sorted: readonly Ratio[], kPpm: number): Ratio {
  const n = sorted.length;
  if (n === 0) refuse('NO_ROWS', 'percentile of no values');
  assertInt(kPpm, 'percentile', 0, 1_000_000);
  for (let i = 1; i < n; i++) if (rCmp(sorted[i - 1]!, sorted[i]!) > 0) refuse('NOT_SORTED', 'values must be sorted ascending');
  const h = ratio(BigInt(n - 1) * BigInt(kPpm), 1_000_000n);
  const f = Number(h.num / h.den);
  const lo = sorted[f]!;
  const hi = sorted[Math.min(f + 1, n - 1)]!;
  return rAdd(lo, rMul(rSub(h, ratio(BigInt(f))), rSub(hi, lo)));
}

export interface Band {
  readonly n: number;
  readonly min: Ratio;
  readonly max: Ratio;
  readonly p10: Ratio;
  readonly p25: Ratio;
  readonly p50: Ratio;
  readonly p75: Ratio;
  readonly p90: Ratio;
  readonly weightedMean: Ratio;
  readonly mean: Ratio;
  /** Variance s^2 with the stated divisor; null when n - 1 = 0. */
  readonly variance: Ratio | null;
  readonly sdDivisor: 'n' | 'n-1';
  /** Display only. */
  readonly sd: number | null;
  /** s > minimum price: the binding form of the agency rule (D-85); null when undefined. */
  readonly unreliable: boolean | null;
}

function cmpR(a: Ratio, b: Ratio): number {
  return rCmp(a, b);
}

/** Band statistics over (quantity, price) pairs. */
export function bandStats(pairs: readonly { readonly q: QtyM; readonly p: Ratio }[], sdDivisor: 'n' | 'n-1'): Band {
  const n = pairs.length;
  if (n === 0) refuse('NO_ROWS', 'band of no rows');
  if (sdDivisor !== 'n' && sdDivisor !== 'n-1') refuse('BAD_SD_DIVISOR', "state whether s uses 'n' or 'n-1'");
  const xs = pairs.map((x) => x.p).sort(cmpR);
  let sum = ratio(0n);
  for (const x of xs) sum = rAdd(sum, x);
  const mean = rDiv(sum, ratio(BigInt(n)));
  let ss = ratio(0n);
  for (const x of xs) {
    const d = rSub(x, mean);
    ss = rAdd(ss, rMul(d, d));
  }
  const div = sdDivisor === 'n' ? n : n - 1;
  const variance = div > 0 ? rDiv(ss, ratio(BigInt(div))) : null;
  const min = xs[0]!;
  return {
    n,
    min,
    max: xs[n - 1]!,
    p10: percentile(xs, 100_000),
    p25: percentile(xs, 250_000),
    p50: percentile(xs, 500_000),
    p75: percentile(xs, 750_000),
    p90: percentile(xs, 900_000),
    weightedMean: weightedMean(pairs.map((x) => ({ q: BigInt(x.q), p: x.p }))),
    mean,
    variance,
    sdDivisor,
    sd: variance ? Math.sqrt(rToNumber(variance)) : null,
    unreliable: variance ? rCmp(variance, rMul(min, min)) > 0 : null,
  };
}

/** Empirical percentile rank of u: share of sample prices <= u. Never falls when u rises. */
export function percentileRank(sorted: readonly Ratio[], u: Ratio): Ratio {
  if (sorted.length === 0) refuse('NO_ROWS', 'rank in no rows');
  const k = sorted.filter((x) => rCmp(x, u) <= 0).length;
  return ratio(BigInt(k), BigInt(sorted.length));
}

export type ExclusionReason =
  | 'not awarded'
  | 'lump-sum bidding unit'
  | 'quantity-1 lump sum'
  | 'lump-sum derived unit price'
  | 'price <= 0'
  | 'quantity <= 0'
  | 'dated after as-of date'
  | 'quantity outside q_ref/10 .. 10*q_ref';

export interface UnitPriceBandInput {
  readonly contractor: ContractorUnitPrice;
  readonly rows: readonly UnitPriceRow[];
  readonly asOf: IsoDate;
  /** The job's state: any other state's price is labelled out of state, never presented as local. */
  readonly jobState: string;
  readonly sdDivisor: 'n' | 'n-1';
  /** Optional index adjustment P_adj = P_orig * I_to / I_from (the agency's own index, by bid-open period). */
  readonly adjustment?: { readonly series: IndexSeries; readonly toPeriod: string };
  readonly nMin?: number; // default A-25
  readonly thinN?: number; // default A-25
}

export interface UnitPriceBandResult {
  readonly uContractor: Ratio;
  readonly n: number;
  readonly used: readonly string[];
  readonly excluded: readonly { readonly id: string; readonly reason: ExclusionReason }[];
  readonly raw: Band | null;
  readonly adjusted: Band | null;
  /** Side-by-side raw and adjusted prices per row (cents per unit, exact). */
  readonly rowsShown: readonly { readonly id: string; readonly raw: Ratio; readonly adjusted: Ratio | null; readonly indexFlag?: string }[];
  /** Flag on the raw band, confirmed by the adjusted band when there is one; never on adjusted alone. */
  readonly flag: 'below_range' | 'above_range' | null;
  readonly rawFlag: 'below_range' | 'above_range' | null;
  readonly adjustedFlag: 'below_range' | 'above_range' | null;
  readonly noFlagReason: string | null;
  readonly thin: boolean;
  readonly percentileRank: Ratio | null;
  readonly states: readonly string[];
  readonly outOfState: boolean;
  readonly labels: readonly string[];
  readonly assumptions: readonly AssumptionUsed[];
}

const normUnit = (u: string): string => u.trim().toUpperCase();

function flagFor(u: Ratio, b: Band | null): 'below_range' | 'above_range' | null {
  if (!b) return null;
  if (rCmp(u, b.p10) < 0) return 'below_range';
  if (rCmp(u, b.p90) > 0) return 'above_range';
  return null;
}

/** Spec 6.9 end to end: like-for-like price, sample filters, index adjustment, band and flag. */
export function unitPriceBand(x: UnitPriceBandInput): UnitPriceBandResult {
  isoDate(x.asOf);
  const u = likeForLikeUnitPrice(x.contractor);
  const unit = normUnit(x.contractor.unit);
  const qRef = BigInt(x.contractor.quantity);
  const nMin = assertInt(x.nMin ?? A25_UNIT_PRICE_N_MIN, 'n_min', 1);
  const thinN = assertInt(x.thinN ?? A25_UNIT_PRICE_THIN_N, 'thin threshold', 1);
  const assumptions: AssumptionUsed[] = [];
  if (x.nMin === undefined) assumptions.push({ id: 'A-25', text: 'no unit-price flag below n_min rows', value: String(A25_UNIT_PRICE_N_MIN) });
  if (x.thinN === undefined) assumptions.push({ id: 'A-25', text: 'unit-price band labelled thin below n rows', value: String(A25_UNIT_PRICE_THIN_N) });

  const excluded: { id: string; reason: ExclusionReason }[] = [];
  const kept: UnitPriceRow[] = [];
  for (const r of x.rows) {
    isoDate(r.bidOpenDate);
    if (!r.source) refuse('MISSING_SOURCE', `row ${r.id}: every row needs its source`);
    assertInt(r.quantity, `row ${r.id} quantity`, Number.MIN_SAFE_INTEGER);
    assertInt(r.unitPrice, `row ${r.id} price`, Number.MIN_SAFE_INTEGER);
    let reason: ExclusionReason | null = null;
    if (r.bidOpenDate > x.asOf) reason = 'dated after as-of date';
    else if (!r.awarded) reason = 'not awarded';
    else if (r.biddingUnitIsLumpSum) reason = 'lump-sum bidding unit';
    else if (r.quantity === 1000 && normUnit(r.unit) === 'LS') reason = 'quantity-1 lump sum';
    else if (r.lumpSumDerived) reason = 'lump-sum derived unit price';
    else if (r.unitPrice <= 0) reason = 'price <= 0';
    else if (r.quantity <= 0) reason = 'quantity <= 0';
    else if (BigInt(r.quantity) * 10n < qRef || BigInt(r.quantity) > 10n * qRef) reason = 'quantity outside q_ref/10 .. 10*q_ref';
    if (reason) excluded.push({ id: r.id, reason });
    else kept.push(r);
  }
  // Mixed units raise an error (invariant 98): the sample must share the contractor's normalized unit.
  for (const r of kept) if (normUnit(r.unit) !== unit) refuse('MIXED_UNITS', `row ${r.id} is in ${r.unit}, the item is in ${x.contractor.unit}`);

  const labels: string[] = ['a flag, never a suggested price', 'public roadway electrical prices only; not building electrical'];
  const rowsShown: { id: string; raw: Ratio; adjusted: Ratio | null; indexFlag?: string }[] = [];
  let adjustedPairs: { q: QtyM; p: Ratio }[] | null = null;
  if (x.adjustment) {
    const s = x.adjustment.series;
    const to = s.points.find((p) => p.period === x.adjustment!.toPeriod);
    if (!to) refuse('MISSING_INDEX_VALUE', `${s.id} has no value for ${x.adjustment.toPeriod} (I_to); no fallback`);
    adjustedPairs = [];
    for (const r of kept) {
      const per = periodOfDate(r.bidOpenDate, s.frequency);
      const from = s.points.find((p) => p.period === per);
      const raw = ratio(BigInt(r.unitPrice));
      if (!from) {
        // spec 6.9: missing I_from -> factor 1 and a flag
        rowsShown.push({ id: r.id, raw, adjusted: raw, indexFlag: `no ${s.id} value for ${per}: unadjusted (factor 1)` });
        adjustedPairs.push({ q: r.quantity, p: raw });
      } else {
        const adj = rDiv(rMul(raw, to.value), from.value);
        rowsShown.push({ id: r.id, raw, adjusted: adj });
        adjustedPairs.push({ q: r.quantity, p: adj });
      }
    }
    labels.push(`adjusted with ${s.id} to ${x.adjustment.toPeriod}; raw and adjusted shown side by side`);
    if (to.preliminary) labels.push(`${s.id} ${x.adjustment.toPeriod} is preliminary and may be revised`);
  } else {
    for (const r of kept) rowsShown.push({ id: r.id, raw: ratio(BigInt(r.unitPrice)), adjusted: null });
  }

  const n = kept.length;
  const raw = n > 0 ? bandStats(kept.map((r) => ({ q: r.quantity, p: ratio(BigInt(r.unitPrice)) })), x.sdDivisor) : null;
  const adjusted = adjustedPairs && n > 0 ? bandStats(adjustedPairs, x.sdDivisor) : null;
  const rawFlag = flagFor(u, raw);
  const adjustedFlag = flagFor(u, adjusted);
  let noFlagReason: string | null = null;
  if (n < nMin) noFlagReason = `only ${n} usable rows (no flag below ${nMin})`;
  let flag = noFlagReason ? null : rawFlag;
  if (flag && adjusted && adjustedFlag !== flag) {
    flag = null;
    noFlagReason = 'raw and index-adjusted bands disagree';
  }
  const thin = n < thinN;
  if (thin) labels.push(`thin: ${n} rows (fewer than ${thinN})`);
  if (raw?.unreliable) labels.push(`unreliable: standard deviation (divisor ${x.sdDivisor}) exceeds the minimum price`);
  const states = [...new Set(kept.map((r) => r.state))].sort();
  const outOfState = states.some((s) => s.toUpperCase() !== x.jobState.toUpperCase());
  if (outOfState) labels.push(`out-of-state prices (${states.join(', ')}): not ${x.jobState} prices`);
  const sortedRaw = raw ? kept.map((r) => ratio(BigInt(r.unitPrice))).sort(cmpR) : [];
  return {
    uContractor: u,
    n,
    used: kept.map((r) => r.id),
    excluded,
    raw,
    adjusted,
    rowsShown,
    flag,
    rawFlag,
    adjustedFlag,
    noFlagReason,
    thin,
    percentileRank: raw ? percentileRank(sortedRaw, u) : null,
    states,
    outOfState,
    labels,
    assumptions,
  };
}
