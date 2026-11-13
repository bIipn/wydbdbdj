// Cash carried (spec section 5): a dated ledger of cash out and cash in on a grid of periods,
// peak float in both orderings, the closed-form oracle, financing cost, the accounting view,
// cost-flow shapes, stress cases and the portfolio view.
//
// Money is integer cents. Positions (N, Nminus) are signed integers of cents. Interest is computed
// in exact rationals and rounded to the cent once (spec 5.6). Lags are in periods: on a coarser grid
// convert inflow lags with ceil(days/Delta) and outflow lags with floor(days/Delta) (spec 5.1).

import {
  allocate,
  assertCents,
  assertInt,
  assertPpm,
  divRoundHalfUp,
  mulRate,
  ratio,
  refuse,
  rRound,
  toCents,
  type Cents,
  type Ppm,
  type Ratio,
} from './money.js';
import type { AssumptionUsed } from './types.js';
import { retainageSchedule, A28_OWNER_LAG_STRESS_DAYS, A28_STRESS, type RetainageRule, type RetainageSchedule } from './payment.js';

const M6 = 1_000_000n;

function safeSigned(n: bigint, what: string): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) refuse('UNSAFE_INTEGER', `${what} outside the safe-integer range`);
  return Number(n);
}

// ---------------------------------------------------------------- spec 5.1 grid

/** Inflow lag in days -> periods, rounded up (spec 5.1). */
export function inflowLagPeriods(days: number, deltaDays: number): number {
  assertInt(days, 'inflow lag days');
  assertInt(deltaDays, 'Delta', 1);
  return Math.ceil(days / deltaDays);
}
/** Outflow lag in days -> periods, rounded down (spec 5.1: rounding an outflow lag up understates the float). */
export function outflowLagPeriods(days: number, deltaDays: number): number {
  assertInt(days, 'outflow lag days');
  assertInt(deltaDays, 'Delta', 1);
  return Math.floor(days / deltaDays);
}

/** A-26: cash-timing conventions. */
export const A26_CASH_TIMING: AssumptionUsed = {
  id: 'A-26',
  text: 'Cash-timing conventions: supplier terms net 30 with no deposit unless entered; pay-first ordering within a period; outflow lags rounded down, inflow lags rounded up',
  value: 'as stated',
};

// ---------------------------------------------------------------- spec 5.9 cost-flow shapes

export type CostShape =
  | { readonly kind: 'uniform' }
  /** Ramp-up share a, ramp-down share d (exact fractions), a, d > 0, a + d <= 1. */
  | { readonly kind: 'trapezoid'; readonly a: Ratio; readonly d: Ratio }
  /** Dated events: integer weights by work period 1..D (e.g. deliveries). */
  | { readonly kind: 'events'; readonly events: readonly { readonly period: number; readonly weight: number }[] }
  /** Normalised logistic with user-entered k and x0. The only float in the module: it shapes weights, never money. */
  | { readonly kind: 'logistic'; readonly k: number; readonly x0: number };

/** Exact S(x) of the trapezoid (spec 5.9), x a fraction in [0, 1]. */
export function trapezoidS(x: Ratio, a: Ratio, d: Ratio): Ratio {
  const cmp = (p: Ratio, q: Ratio) => p.num * q.den - q.num * p.den; // sign of p - q
  if (a.num <= 0n || d.num <= 0n) refuse('OUT_OF_RANGE', 'trapezoid needs a, d > 0');
  const ad = ratio(a.num * d.den + d.num * a.den, a.den * d.den);
  if (cmp(ad, ratio(1n)) > 0n) refuse('OUT_OF_RANGE', 'trapezoid needs a + d <= 1');
  if (x.num < 0n || cmp(x, ratio(1n)) > 0n) refuse('OUT_OF_RANGE', 'x must lie in [0, 1]');
  // h = 2/(2 - a - d)
  const h = ratio(2n * ad.den, 2n * ad.den - ad.num);
  const oneMinusD = ratio(d.den - d.num, d.den);
  if (cmp(x, a) < 0n) {
    // h*x^2/(2a)
    return ratio(h.num * x.num * x.num * a.den, h.den * x.den * x.den * 2n * a.num);
  }
  if (cmp(x, oneMinusD) <= 0n) {
    // h*(x - a/2)
    const xm = ratio(x.num * 2n * a.den - a.num * x.den, x.den * 2n * a.den);
    return ratio(h.num * xm.num, h.den * xm.den);
  }
  // 1 - h*(1-x)^2/(2d)
  const omx = ratio(x.den - x.num, x.den);
  const t = ratio(h.num * omx.num * omx.num * d.den, h.den * omx.den * omx.den * 2n * d.num);
  return ratio(t.den - t.num, t.den);
}

/**
 * w(t) = S(t/D) - S((t-1)/D) for t = 1..D as integer weights summing exactly to `scale` (spec 5.9).
 * Index 0 (pre-start) is 0. Weights come from cumulative rounding of S to `scale`, so they are
 * non-negative, sum exactly to scale, and the last cumulative value is exact (see specIssues).
 */
export function costWeights(shape: CostShape, D: number, scale = 1_000_000): { weights: number[]; cumulative: Ratio[] | null } {
  assertInt(D, 'D', 1);
  assertInt(scale, 'scale', 1);
  const S = BigInt(scale);
  const w = new Array<number>(D + 1).fill(0);
  if (shape.kind === 'events') {
    for (const e of shape.events) {
      assertInt(e.period, 'event period', 1, D);
      assertInt(e.weight, 'event weight');
      w[e.period]! += e.weight;
    }
    if (w.every((x) => x === 0)) refuse('ZERO_WEIGHTS', 'no event carries weight');
    return { weights: w, cumulative: null };
  }
  let cumul: Ratio[] | null = null;
  let crs: bigint[];
  if (shape.kind === 'uniform' || shape.kind === 'trapezoid') {
    cumul = [];
    for (let t = 0; t <= D; t++) {
      const x = ratio(BigInt(t), BigInt(D));
      cumul.push(shape.kind === 'uniform' ? x : trapezoidS(x, shape.a, shape.d));
    }
    crs = cumul.map((s) => rRound(ratio(s.num * S, s.den)));
  } else {
    if (!Number.isFinite(shape.k) || !Number.isFinite(shape.x0) || shape.k <= 0) refuse('OUT_OF_RANGE', 'logistic needs finite k > 0 and x0');
    const L = (x: number) => 1 / (1 + Math.exp(-shape.k * (x - shape.x0)));
    const l0 = L(0), l1 = L(1);
    if (!(l1 > l0)) refuse('OUT_OF_RANGE', 'logistic is flat on [0, 1]');
    crs = [];
    let prev = 0n;
    for (let t = 0; t <= D; t++) {
      let v = t === D ? S : BigInt(Math.round(((L(t / D) - l0) / (l1 - l0)) * scale));
      if (v < prev) v = prev; // keep the cumulative non-decreasing
      if (v > S) v = S;
      crs.push(v);
      prev = v;
    }
  }
  for (let t = 1; t <= D; t++) w[t] = Number(crs[t]! - crs[t - 1]!);
  return { weights: w, cumulative: cumul };
}

// ---------------------------------------------------------------- spec 5.2 to 5.4 the ledger

export type CostKind = 'labor' | 'labor_burden' | 'material' | 'equipment' | 'subcontract' | 'job_overhead' | 'pre_start' | 'other';

/** One cost category k (spec 5.2). */
export interface CashCategory {
  readonly id: string;
  readonly kind: CostKind;
  /** C_k: total cash cost of the category, cents. */
  readonly amount: Cents;
  /** w_k(t) as integer weights indexed by period t = 0..D (incurred or delivered). Allocation is largest remainder. */
  readonly weights: readonly number[];
  /** l_k: periods from incurrence to payment (outflow lag, already floor(days/Delta)). */
  readonly lagPeriods: number;
  /** d_k paid at dep_k, not later than the first normal pay date. */
  readonly deposit?: { readonly sharePpm: Ppm; readonly period: number };
}

/** The job as the cash model sees it. */
export interface CashJobInput {
  /** Delta: days per period (1 in production; 7 for a weekly display grid). */
  readonly periodDays: number;
  /** D: work periods 1..D; period 0 is pre-start. */
  readonly workPeriods: number;
  /** P: contract price. */
  readonly price: Cents;
  readonly categories: readonly CashCategory[];
  /** b: billing cycle in periods. */
  readonly billingPeriods: number;
  /** lam: owner payment lag in periods (inflow, ceil(days/Delta)). */
  readonly ownerLagPeriods: number;
  readonly retainage: RetainageRule;
  /** lam_R: retainage still held is received at D + lam_R; must satisfy D + lam_R >= t_J + lam. */
  readonly retainageReleasePeriods: number;
  /**
   * Federal bond premium (spec 5.3): a retainage-free line of the price billed in pay application `billing`
   * (the first after proof of payment). Part of P, never revenue on top of it.
   */
  readonly earlyLine?: { readonly amount: Cents; readonly billing: number };
}

export interface PayApp {
  readonly j: number;
  readonly t: number; // t_j
  readonly gross: Cents; // A_j
  readonly withheld: Cents; // W_j
  readonly halfRelease: Cents; // Rel_j
  readonly net: Cents; // A_j - W_j
  readonly receivedAt: number; // t_j + lam
}

export interface CashLedger {
  readonly input: CashJobInput;
  readonly H: number;
  readonly D: number;
  readonly Ccash: Cents;
  readonly P: Cents;
  /** c(t): cost incurred in period t, t = 0..H (0 after D). */
  readonly incurred: readonly number[];
  /** K(t) cumulative cost incurred. */
  readonly K: readonly number[];
  readonly OUT: readonly number[];
  readonly IN: readonly number[];
  readonly outByCategory: Readonly<Record<string, readonly number[]>>;
  readonly Nminus: readonly number[];
  readonly N: readonly number[];
  readonly payApps: readonly PayApp[];
  readonly retainage: RetainageSchedule;
  readonly finalReleaseAt: number;
  readonly finalRelease: Cents;
  /** E(t) billed-schedule value at each bill date (cumulative). */
  readonly billedToDate: readonly number[];
  readonly assumptions: readonly AssumptionUsed[];
}

function validateJob(j: CashJobInput): void {
  assertInt(j.periodDays, 'Delta', 1);
  assertInt(j.workPeriods, 'D', 1);
  assertCents(j.price, 'P');
  assertInt(j.billingPeriods, 'b', 1);
  assertInt(j.ownerLagPeriods, 'lam');
  assertInt(j.retainageReleasePeriods, 'lam_R');
  if (j.categories.length === 0) refuse('BAD_INPUT', 'no cost categories');
  const ids = new Set<string>();
  for (const k of j.categories) {
    if (ids.has(k.id)) refuse('BAD_INPUT', `duplicate category id ${k.id}`);
    ids.add(k.id);
    assertCents(k.amount, `C_${k.id}`);
    assertInt(k.lagPeriods, `l_${k.id}`);
    if (k.weights.length === 0 || k.weights.length > j.workPeriods + 1) refuse('BAD_INPUT', `weights of ${k.id} must cover periods 0..D at most`);
    if (k.deposit) {
      assertPpm(k.deposit.sharePpm, `d_${k.id}`, 0, 1_000_000);
      assertInt(k.deposit.period, `dep_${k.id}`);
      const first = k.weights.findIndex((x) => x > 0);
      if (first >= 0 && k.deposit.period > first + k.lagPeriods) refuse('BAD_INPUT', `deposit of ${k.id} is later than its first normal pay date`);
    }
  }
  if (j.earlyLine) {
    assertCents(j.earlyLine.amount, 'early line');
    if (j.earlyLine.amount > j.price) refuse('BAD_INPUT', 'early line exceeds the price');
    assertInt(j.earlyLine.billing, 'early line billing', 1);
  }
}

/**
 * Build the dated ledger (spec 5.2 to 5.4):
 *   OUT(t) = sum_k [ d_k*C_k*1{t = dep_k} + (1 - d_k)*C_k*w_k(t - l_k) ]
 *   E(t) = P*K(t)/C_cash (cost-proportional schedule of values, A-22), rounded half-up at each bill date
 *   t_j = min(j*b, D), A_j = E(t_j) - E(t_{j-1}); W_j, Rel_j from spec 4.5; net received at t_j + lam
 *   retainage still held received at D + lam_R
 *   Nminus(t) = N(t-1) - OUT(t);  N(t) = Nminus(t) + IN(t)   (pay first within a period)
 */
export function cashLedger(job: CashJobInput): CashLedger {
  validateJob(job);
  const D = job.workPeriods;
  const P = BigInt(job.price);
  // Incurrence and payment per category.
  const incurredByCat: bigint[][] = [];
  const paidEvents: { k: number; t: number; amt: bigint }[] = [];
  let Ccash = 0n;
  job.categories.forEach((k, ki) => {
    const w = [...k.weights];
    while (w.length < D + 1) w.push(0);
    const inc = allocate(k.amount, w).map(BigInt);
    incurredByCat.push(inc);
    Ccash += BigInt(k.amount);
    const dep = k.deposit ? BigInt(mulRate(k.amount, k.deposit.sharePpm)) : 0n;
    if (k.deposit && dep > 0n) paidEvents.push({ k: ki, t: k.deposit.period, amt: dep });
    const rest = BigInt(k.amount) - dep;
    if (rest > 0n) allocate(toCents(rest), w).forEach((a, t) => a > 0 && paidEvents.push({ k: ki, t: t + k.lagPeriods, amt: BigInt(a) }));
  });
  if (Ccash === 0n) refuse('BAD_INPUT', 'total cash cost C_cash is zero');
  const K: bigint[] = [];
  let run = 0n;
  for (let t = 0; t <= D; t++) {
    for (const inc of incurredByCat) run += inc[t]!;
    K.push(run);
  }
  // Pay applications.
  const J = Math.ceil(D / job.billingPeriods);
  const tj = [0];
  for (let j = 1; j <= J; j++) tj.push(Math.min(j * job.billingPeriods, D));
  const early = job.earlyLine ? BigInt(job.earlyLine.amount) : 0n;
  if (job.earlyLine && job.earlyLine.billing > J) refuse('BAD_INPUT', 'early line billing is after the last pay application');
  const Ebase = tj.map((t, j) => (j === 0 ? 0n : divRoundHalfUp((P - early) * K[t]!, Ccash)));
  const baseA = tj.slice(1).map((_, i) => toCents(Ebase[i + 1]! - Ebase[i]!, 'pay application'));
  const ret = retainageSchedule(job.retainage, job.price, baseA);
  const payApps: PayApp[] = ret.rows.map((r, i) => {
    const j = i + 1;
    const extra = job.earlyLine && job.earlyLine.billing === j ? early : 0n;
    return {
      j,
      t: tj[j]!,
      gross: toCents(BigInt(r.B) + extra),
      withheld: r.W,
      halfRelease: r.Rel,
      net: toCents(BigInt(r.B) - BigInt(r.W) + extra),
      receivedAt: tj[j]! + job.ownerLagPeriods,
    };
  });
  const lastReceipt = tj[J]! + job.ownerLagPeriods;
  const finalReleaseAt = D + job.retainageReleasePeriods;
  if (finalReleaseAt < lastReceipt) refuse('BAD_INPUT', 'retainage release must not come before the last progress receipt (D + lam_R >= t_J + lam)');
  const lastOut = paidEvents.reduce((m, e) => Math.max(m, e.t), 0);
  const H = Math.max(lastOut, finalReleaseAt, D);
  const OUT = new Array<bigint>(H + 1).fill(0n);
  const IN = new Array<bigint>(H + 1).fill(0n);
  const byCat: bigint[][] = job.categories.map(() => new Array<bigint>(H + 1).fill(0n));
  for (const e of paidEvents) {
    OUT[e.t]! += e.amt;
    byCat[e.k]![e.t]! += e.amt;
  }
  for (const a of payApps) IN[a.receivedAt]! += BigInt(a.net) + BigInt(a.halfRelease);
  IN[finalReleaseAt]! += BigInt(ret.heldAtEnd);
  const Nminus: number[] = [], N: number[] = [];
  let n = 0n;
  for (let t = 0; t <= H; t++) {
    const nm = n - OUT[t]!;
    n = nm + IN[t]!;
    Nminus.push(safeSigned(nm, 'Nminus'));
    N.push(safeSigned(n, 'N'));
  }
  const incurred = new Array<number>(H + 1).fill(0);
  const Kfull: number[] = [];
  for (let t = 0; t <= H; t++) {
    if (t <= D) incurred[t] = Number(K[t]! - (t === 0 ? 0n : K[t - 1]!));
    Kfull.push(Number(K[Math.min(t, D)]!));
  }
  const outByCategory: Record<string, number[]> = {};
  job.categories.forEach((k, i) => (outByCategory[k.id] = byCat[i]!.map((x) => Number(x))));
  return {
    input: job,
    H,
    D,
    Ccash: toCents(Ccash, 'C_cash'),
    P: job.price,
    incurred,
    K: Kfull,
    OUT: OUT.map((x) => Number(x)),
    IN: IN.map((x) => Number(x)),
    outByCategory,
    Nminus,
    N,
    payApps,
    retainage: ret,
    finalReleaseAt,
    finalRelease: ret.heldAtEnd,
    billedToDate: Ebase.map((e, j) => Number(e + (job.earlyLine && j >= job.earlyLine.billing ? early : 0n))),
    assumptions: [A26_CASH_TIMING, ...ret.assumptions],
  };
}

// ---------------------------------------------------------------- spec 5.4 peak float and read-outs

export interface PeakFloat {
  /** F* = max(0, -min_t Nminus(t)): own money (cash plus credit) the job needs at its worst point (pay first). */
  readonly F: Cents;
  readonly tStar: number;
  /** F*_rf = max(0, -min_t N(t)) <= F* (receipts first). */
  readonly Frf: Cents;
  readonly tStarRf: number;
  /** Cumulative cash paid by category up to and including t*. */
  readonly compositionAtPeak: Readonly<Record<string, number>>;
  /** Days from period 0 to the first period with cash in; null if no cash ever comes in. */
  readonly daysToFirstCashIn: number | null;
  readonly firstReceiptPeriod: number | null;
  /** Days with N(t) < 0. */
  readonly daysCashNegative: number;
  /** Q = sum_t max(0, -N(t)) * Delta, cent-days. */
  readonly dollarDays: number;
  readonly FOverCost: Ratio;
  readonly FOverPrice: Ratio | null;
  /** N(H) = P - C_cash. */
  readonly finalCash: number;
  /** Cash paid up to and including the first period with IN > 0 (spec 5.8 upFront). */
  readonly upFront: Cents;
  /** OUT(0). */
  readonly preStart: Cents;
}

function argmin(xs: readonly number[]): number {
  let b = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i]! < xs[b]!) b = i;
  return b;
}

export function peakFloat(L: CashLedger): PeakFloat {
  const tStar = argmin(L.Nminus), tRf = argmin(L.N);
  const F = Math.max(0, -L.Nminus[tStar]!), Frf = Math.max(0, -L.N[tRf]!);
  const comp: Record<string, number> = {};
  for (const [id, xs] of Object.entries(L.outByCategory)) comp[id] = xs.slice(0, tStar + 1).reduce((a, b) => a + b, 0);
  const first = L.IN.findIndex((x) => x > 0);
  const delta = L.input.periodDays;
  let neg = 0, q = 0n;
  for (const n of L.N) if (n < 0) {
    neg += 1;
    q += BigInt(-n);
  }
  const upTo = first < 0 ? L.H : first;
  return {
    F: F as Cents,
    tStar,
    Frf: Frf as Cents,
    tStarRf: tRf,
    compositionAtPeak: comp,
    daysToFirstCashIn: first < 0 ? null : first * delta,
    firstReceiptPeriod: first < 0 ? null : first,
    daysCashNegative: neg * delta,
    dollarDays: safeSigned(q * BigInt(delta), 'dollar-days'),
    FOverCost: ratio(F, L.Ccash),
    FOverPrice: L.P > 0 ? ratio(F, L.P) : null,
    finalCash: L.N[L.H]!,
    upFront: L.OUT.slice(0, upTo + 1).reduce((a, b) => a + b, 0) as Cents,
    preStart: L.OUT[0]! as Cents,
  };
}

// ---------------------------------------------------------------- spec 5.5 closed form (test oracle)

/**
 * Uniform cost paid when incurred (l = 0, d = 0, w = 1/D), cost C, markup m = P/C - 1, flat retainage r,
 * owner lag lam periods, g = (1 - r)(1 + m):
 *   F* = (C/D) * max_{1<=j<=J} [ min(t_j + lam, D) - g * t_{j-1} ]      (exact fraction, cents)
 * g >= 1 reduces to C * min(1, (b + lam)/D).
 */
export function closedFormPeak(C: Cents, P: Cents, D: number, b: number, lam: number, rPpm: Ppm): Ratio {
  assertCents(C, 'C');
  assertCents(P, 'P');
  assertInt(D, 'D', 1);
  assertInt(b, 'b', 1);
  assertInt(lam, 'lam');
  assertPpm(rPpm, 'r', 0, 1_000_000);
  if (C === 0) refuse('BAD_INPUT', 'C must be positive');
  const J = Math.ceil(D / b);
  // g = (1 - r) * P / C = (10^6 - r) * P / (10^6 * C)
  const gNum = (M6 - BigInt(rPpm)) * BigInt(P), gDen = M6 * BigInt(C);
  let best: Ratio | null = null;
  for (let j = 1; j <= J; j++) {
    const t = Math.min(j * b, D), tPrev = Math.min((j - 1) * b, D);
    // value = min(t + lam, D) - g*tPrev  as gDen-denominated fraction
    const v = ratio(BigInt(Math.min(t + lam, D)) * gDen - gNum * BigInt(tPrev), gDen);
    if (best === null || v.num * best.den > best.num * v.den) best = v;
  }
  const r = ratio(BigInt(C) * best!.num, BigInt(D) * best!.den);
  return r.num < 0n ? ratio(0n) : r;
}

// ---------------------------------------------------------------- spec 5.6 financing cost

export interface FinancingResult {
  /** FIN = sum_t I(t), rounded to the cent once. */
  readonly FIN: Cents;
  readonly FINexact: Ratio;
  /** i_per * sum_t max(0, -N(t)) (exact) and rounded. */
  readonly simpleApprox: Ratio;
  readonly simpleApproxCents: Cents;
  /** Financed peak draw: max_t -(Nf(t-1) - OUT(t) - I(t)), rounded half-up once. */
  readonly financedPeak: Cents;
  /** Nf(H) = P - C_cash - FIN (exact in fractions; reported with the rounded FIN). */
  readonly financedFinalCash: number;
  readonly financedFinalCashExact: Ratio;
  /** m_fin = FIN / C_cash (one pass; the fixed point is slightly lower, A-20). */
  readonly mFin: Ratio;
  /** I(t) per period, rounded half-up for display only (FIN is rounded once from the exact sum). */
  readonly interestByPeriodDisplay: readonly Cents[];
}

/**
 * i_per = i_annual * Delta / basis; I(t) = i_per * max(0, -Nf(t-1)); Nf(t) = Nf(t-1) + IN(t) - OUT(t) - I(t)
 * (spec 5.6). Interest on the opening balance, paid in cash each period. Exact rationals on a common
 * denominator (basis * 10^6)^t; FIN rounded once.
 */
export function financingCost(L: CashLedger, annualRatePpm: Ppm, dayCountBasis: 360 | 365): FinancingResult {
  assertPpm(annualRatePpm, 'i', 0, 1_000_000);
  if (dayCountBasis !== 360 && dayCountBasis !== 365) refuse('OUT_OF_RANGE', 'day-count basis must be 360 or 365');
  const Dn = BigInt(dayCountBasis) * M6; // i_per = iNum / Dn
  const iNum = BigInt(annualRatePpm) * BigInt(L.input.periodDays);
  // Nf(t) = X / Dn^t ; F (interest total) = Fn / Dn^t ; worst draw tracked as a fraction
  let X = 0n, Fn = 0n, scale = 1n;
  let worstNum = 0n, worstDen = 1n; // unreduced: avoids gcd on very long denominators
  const perPeriod: Cents[] = [];
  for (let t = 0; t <= L.H; t++) {
    const newScale = scale * Dn;
    const I = t === 0 || X >= 0n ? 0n : iNum * -X; // over newScale
    perPeriod.push(toCents(divRoundHalfUp(I, newScale), 'I(t)'));
    const Xm = X * Dn - BigInt(L.OUT[t]!) * newScale - I; // Nf(t-1) - OUT(t) - I(t)
    if (-Xm * worstDen > worstNum * newScale) {
      worstNum = -Xm;
      worstDen = newScale;
    }
    X = Xm + BigInt(L.IN[t]!) * newScale;
    Fn = Fn * Dn + I;
    scale = newScale;
  }
  const FIN = toCents(divRoundHalfUp(Fn, scale), 'FIN');
  let q = 0n;
  for (const n of L.N) if (n < 0) q += BigInt(-n);
  const simple = ratio(iNum * q, Dn);
  return {
    FIN,
    FINexact: ratio(Fn, scale),
    simpleApprox: simple,
    simpleApproxCents: toCents(rRound(simple), 'simple interest'),
    financedPeak: toCents(divRoundHalfUp(worstNum, worstDen), 'financed peak'),
    financedFinalCash: L.P - L.Ccash - FIN,
    financedFinalCashExact: ratio(X, scale),
    mFin: ratio(FIN, L.Ccash),
    interestByPeriodDisplay: perPeriod,
  };
}

/** The financing line for the build-up (spec 2.12, A-20): FIN for a ledger built at the price without FIN. */
export const A20_FINANCING: AssumptionUsed = { id: 'A-20', text: 'Financing cost placed after profit, computed in one pass', value: 'included, own line' };
export const A29_DAY_COUNT: AssumptionUsed = { id: 'A-29', text: 'Day-count basis for financing (set by the loan agreement)', value: '365' };

// ---------------------------------------------------------------- spec 5.7 accounting view

export interface AccountingRow {
  readonly t: number;
  readonly K: number;
  /** ER(t) = p(t)*P = P*K(t)/C_est, rounded half-up to the cent (the same rounding as the bill amounts). */
  readonly ER: number;
  readonly BL: number;
  /** OU(t) = BL(t) - ER(t): > 0 overbilled, < 0 underbilled. */
  readonly billedMinusEarned: number;
  readonly AR: number;
  readonly RR: number;
  readonly AP: number;
  readonly GP: number;
  readonly N: number;
}

/**
 * p(t) = K(t)/C_est, ER = p*P, BL = sum_{t_j<=t} A_j, AR = sum_{t_j<=t<t_j+lam}(A_j - W_j),
 * RR = retainage held (withheld at bill dates, less releases received), AP = K - sum OUT, GP = ER - K.
 * Identity every period: N = GP + OU - AR - RR + AP (spec 5.7, invariant 71).
 */
export function accountingView(L: CashLedger, Cest: Cents = L.Ccash): AccountingRow[] {
  assertCents(Cest, 'C_est');
  if (Cest === 0) refuse('BAD_INPUT', 'C_est must be positive');
  const rows: AccountingRow[] = [];
  let cumOut = 0;
  for (let t = 0; t <= L.H; t++) {
    cumOut += L.OUT[t]!;
    const K = L.K[t]!;
    const ER = Number(divRoundHalfUp(BigInt(L.P) * BigInt(K), BigInt(Cest)));
    let BL = 0, AR = 0, RR = 0;
    for (const a of L.payApps) {
      if (a.t <= t) {
        BL += a.gross;
        RR += a.withheld;
        if (t < a.receivedAt) AR += a.net;
        else RR -= a.halfRelease;
      }
    }
    if (t >= L.finalReleaseAt) RR -= L.finalRelease;
    rows.push({ t, K, ER, BL, billedMinusEarned: BL - ER, AR, RR, AP: K - cumOut, GP: ER - K, N: L.N[t]! });
  }
  return rows;
}

// ---------------------------------------------------------------- spec 5.8 stress cases

export interface StressConfig {
  /** Owner lag stress in days (A-28: +30 and +60 when omitted). Converted with ceil(days/Delta); release moves with it. */
  readonly extraOwnerLagDays?: readonly number[];
  /** Supplier cash on delivery: these kinds are paid with lag 0 (deposits kept). Omit to skip. */
  readonly codKinds?: readonly CostKind[];
  /** Labor +x at fixed price (labor and labor_burden scaled); the percentage is the caller's input. */
  readonly laborIncreasePpm?: Ppm;
  /** Optional unpaid change order: extra cost incurred and paid in `period`, price unchanged. */
  readonly unpaidChangeOrder?: { readonly amount: Cents; readonly period: number };
}

export interface StressCase {
  readonly id: string;
  readonly label: string;
  readonly ledger: CashLedger;
  readonly peak: PeakFloat;
}

/** Stress cases (spec 5.8): owner lag +30 / +60 days (A-28), supplier COD, labor up at fixed price, unpaid change order. */
export function stressCases(job: CashJobInput, cfg: StressConfig = {}): { cases: StressCase[]; assumptions: AssumptionUsed[] } {
  const out: StressCase[] = [];
  const assumptions: AssumptionUsed[] = [];
  const lagDays = cfg.extraOwnerLagDays ?? A28_OWNER_LAG_STRESS_DAYS;
  if (cfg.extraOwnerLagDays === undefined) assumptions.push(A28_STRESS);
  const mk = (id: string, label: string, j: CashJobInput) => {
    const ledger = cashLedger(j);
    out.push({ id, label, ledger, peak: peakFloat(ledger) });
  };
  for (const d of lagDays) {
    const extra = inflowLagPeriods(d, job.periodDays);
    mk(`owner_lag_plus_${d}d`, `Owner pays ${d} days later than the base case`, {
      ...job,
      ownerLagPeriods: job.ownerLagPeriods + extra,
      retainageReleasePeriods: job.retainageReleasePeriods + extra,
    });
  }
  if (cfg.codKinds && cfg.codKinds.length) {
    const kinds = new Set(cfg.codKinds);
    mk('supplier_cod', 'Suppliers want cash on delivery', {
      ...job,
      categories: job.categories.map((k) => (kinds.has(k.kind) ? { ...k, lagPeriods: 0 } : k)),
    });
  }
  if (cfg.laborIncreasePpm !== undefined) {
    const inc = assertPpm(cfg.laborIncreasePpm, 'labor increase', 0, 10_000_000);
    mk('labor_up', `Labor costs ${inc / 10_000}% more at the same price`, {
      ...job,
      categories: job.categories.map((k) =>
        k.kind === 'labor' || k.kind === 'labor_burden' ? { ...k, amount: mulRate(k.amount, (1_000_000 + inc) as Ppm) } : k,
      ),
    });
  }
  if (cfg.unpaidChangeOrder) {
    const co = cfg.unpaidChangeOrder;
    assertCents(co.amount, 'change order');
    assertInt(co.period, 'change order period', 0, job.workPeriods);
    const w = new Array<number>(job.workPeriods + 1).fill(0);
    w[co.period] = 1;
    mk('unpaid_change_order', 'A change order you pay for but are not paid for', {
      ...job,
      categories: [...job.categories, { id: '__unpaid_change_order', kind: 'other', amount: co.amount, weights: w, lagPeriods: 0 }],
    });
  }
  return { cases: out, assumptions };
}

// ---------------------------------------------------------------- spec 5.8 portfolio

/**
 * Sum the Nminus series of all active jobs on one calendar (offset = start period of each job).
 * Before a job starts it contributes 0; after its last period it contributes its final N(H).
 * Invariant 85: the portfolio peak is at most the sum of the individual peaks.
 */
export function portfolio(jobs: readonly { readonly ledger: CashLedger; readonly startPeriod: number }[]): {
  Nminus: number[];
  peak: Cents;
  tStar: number;
  sumOfPeaks: Cents;
} {
  if (jobs.length === 0) refuse('BAD_INPUT', 'portfolio needs at least one job');
  const delta = jobs[0]!.ledger.input.periodDays;
  let end = 0;
  for (const j of jobs) {
    assertInt(j.startPeriod, 'start period');
    if (j.ledger.input.periodDays !== delta) refuse('BAD_INPUT', 'all jobs must use the same period length');
    end = Math.max(end, j.startPeriod + j.ledger.H);
  }
  const total = new Array<bigint>(end + 1).fill(0n);
  for (const j of jobs) {
    for (let t = j.startPeriod; t <= end; t++) {
      const u = t - j.startPeriod;
      total[t]! += BigInt(u <= j.ledger.H ? j.ledger.Nminus[u]! : j.ledger.N[j.ledger.H]!);
    }
  }
  const Nm = total.map((x) => safeSigned(x, 'portfolio Nminus'));
  const tStar = argmin(Nm);
  const sum = jobs.reduce((a, j) => a + peakFloat(j.ledger).F, 0);
  return { Nminus: Nm, peak: Math.max(0, -Nm[tStar]!) as Cents, tStar, sumOfPeaks: sum as Cents };
}
