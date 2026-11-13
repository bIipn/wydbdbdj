// Bid price selection, "the price agent" (spec section 7.6, 7.7, 7.9, 7.10).
//
// Money stays integer: the floor, q(B) and profit if won are exact cents (core primitives). The win
// probability and the expected value EV are float64 statistics (spec 0.1 rule 3); EV is rounded to
// cents only for display. The optimum over a step curve is found by the exact candidate search of 7.7
// (EV rises between jumps, so the maximum is at the floor or one cent below a jump); smooth curves use
// a bounded numeric search. The output is a curve, a range and the sample size, never "the right bid".

import {
  refuse,
  mulRate,
  ratio,
  rCmp,
  rDiv,
  rSub,
  assertCents,
  assertInt,
  assertPpm,
  toCents,
  type Cents,
  type Ppm,
  type Ratio,
} from './money.js';
import type { AssumptionUsed, PriceChargesInput } from './types.js';
import { grossUp, priceBasedCharge, validateTiers } from './buildup.js';
import { normalCdf, A25_MIN_J, A25_ALPHA, A25_TEXT, type CurveResult, type WinCurve, type WinEstimate, type NotEnoughData } from './winprob.js';

// ---------------------------------------------------------------- section 9 assumptions used here

/** A-23 (assumption, editable): winner's-curse share kappa = 0 (off) until the contractor sets sigma from their own estimate-versus-actual history. */
export const A23_KAPPA = 0;
/** A-24 (assumption, editable): near-optimal tolerance delta = 0.05. A product setting, not sourced. */
export const A24_DELTA = 0.05;

// ---------------------------------------------------------------- 7.6 winner's curse

/**
 * e_N = expected maximum of N standard normals (spec 7.6; D-76 lists 0.5642 ... 1.5388).
 * Computed, not tabled: e_N = int_0^inf (1 - Phi(x)^N) dx - int_0^inf Phi(-x)^N dx (Simpson, h = 0.002
 * on [0, 12]; the tail beyond 12 is below 1e-30 for any N a bid can have). e_1 = 0 exactly.
 */
export function expectedMaxNormal(N: number): number {
  assertInt(N, 'N', 1, 100_000);
  if (N === 1) return 0;
  const f = (x: number): number => {
    const Q = normalCdf(-x);
    return -Math.expm1(N * Math.log1p(-Q)) - Math.pow(Q, N);
  };
  const steps = 6000, a = 0, b = 12, h = (b - a) / steps;
  let s = f(a) + f(b);
  for (let i = 1; i < steps; i++) s += (i % 2 === 1 ? 4 : 2) * f(a + i * h);
  return (s * h) / 3;
}

export interface WinnersCurse {
  readonly kappa: number;
  readonly sigma: number;
  /** N = total bidders including us. */
  readonly N: number;
  readonly eN: number;
  /** C_adj / C = 1/(1 - kappa*sigma*e_N). */
  readonly factor: number;
  /** The linear form 1 + kappa*sigma*e_N, shown for comparison only (it understates). */
  readonly linearFactor: number;
  readonly fromAssumption: boolean;
}

/**
 * C_adj = C / (1 - kappa*sigma*e_N), requires kappa*sigma*e_N < 1 (spec 7.6). sigma = the contractor's
 * estimating error; kappa in [0, 1] = common-value share (A-23 default 0 = off); N = bidders including us.
 */
export function winnersCurse(kappa: number, sigma: number, N: number): WinnersCurse {
  if (!(kappa >= 0 && kappa <= 1)) refuse('OUT_OF_RANGE', `kappa must be in [0, 1], got ${kappa}`);
  if (!(sigma >= 0 && Number.isFinite(sigma))) refuse('OUT_OF_RANGE', `sigma must be >= 0, got ${sigma}`);
  const eN = expectedMaxNormal(N);
  const x = kappa * sigma * eN;
  if (!(x < 1)) refuse('OUT_OF_RANGE', `kappa*sigma*e_N = ${x} must be below 1`);
  return { kappa, sigma, N, eN, factor: x === 0 ? 1 : 1 / (1 - x), linearFactor: 1 + x, fromAssumption: false };
}

/** TJC_adj = TJC * C_adj/C, converted to cents once (half-up), never below TJC (invariant 108). */
export function adjustedCost(TJC: Cents, curse: WinnersCurse): Cents {
  assertCents(TJC, 'TJC');
  if (curse.factor === 1) return TJC;
  const v = TJC * curse.factor;
  if (!Number.isFinite(v) || v > Number.MAX_SAFE_INTEGER) refuse('UNSAFE_INTEGER', 'adjusted cost too large');
  return Math.max(TJC, Math.floor(v + 0.5)) as Cents;
}

// ---------------------------------------------------------------- 7.7 game-theory benchmark (not a pricing rule)

/** Symmetric private costs uniform on [0, 1], n total bidders: b(c) = (1 + (n-1)c)/n; markup (1-c)/n; E[lowest bid] = 2/(n+1). Exact. */
export function uniformBenchmark(c: Ratio, n: number): { bid: Ratio; markup: Ratio; expectedLowestBid: Ratio } {
  assertInt(n, 'n', 1);
  if (rCmp(c, ratio(0n)) < 0 || rCmp(c, ratio(1n)) > 0) refuse('OUT_OF_RANGE', 'c must be in [0, 1]');
  const N = BigInt(n);
  return {
    bid: ratio(c.den + (N - 1n) * c.num, N * c.den),
    markup: ratio(c.den - c.num, N * c.den),
    expectedLowestBid: ratio(2n, N + 1n),
  };
}

// ---------------------------------------------------------------- 7.9 owner-side adequacy warning

/**
 * D-74 (guidance [R], US federal-aid highway, 2004 text dropped in 2021): FHWA legacy table, low bid at
 * most 100 / 105 / 110 / 115 / 120 % of the engineer's estimate for k = 1..5 bids within 20% of the low
 * bid. Source: https://www.fhwa.dot.gov/programadmin/contracts/cacc.pdf
 */
const D74_LIMIT_PCT: readonly number[] = [100, 105, 110, 115, 120];

/** Adequacy threshold (percent of the estimate) for k competitive bids; defined only for k = 1..5 (invariant 114). */
export function adequacyThresholdPct(k: number): number {
  assertInt(k, 'k', 1, 5);
  return D74_LIMIT_PCT[k - 1] as number;
}

/** r = L/E and pct = (L - E)/E * 100, exact (invariant 115). */
export function lowBidVsEstimate(L: Cents, E: Cents): { r: Ratio; pct: Ratio } {
  assertCents(L, 'low bid');
  assertInt(E, 'estimate', 1);
  return { r: ratio(L, E), pct: ratio((BigInt(L) - BigInt(E)) * 100n, BigInt(E)) };
}

export interface AdequacyResult {
  /** Bids within 20% of the low bid, counting the low bid. */
  readonly k: number;
  readonly r: Ratio;
  readonly limitPct: number | null;
  readonly verdict: 'adequate' | 'not_adequate' | 'excellent';
  readonly warning: string | null;
}

/** Spec 7.9: legacy owner-side guidance, a warning only (highway-type lettings). */
export function adequacyCheck(bids: readonly Cents[], estimate: Cents): AdequacyResult {
  if (bids.length === 0) refuse('BAD_INPUT', 'no bids');
  bids.forEach((b, i) => assertInt(b, `bid ${i}`, 1));
  const L = bids.reduce((m, b) => (b < m ? b : m), bids[0] as Cents);
  // within 20% of the low bid: b <= 1.2 L  <=>  5b <= 6L (exact)
  const k = bids.filter((b) => 5n * BigInt(b) <= 6n * BigInt(L)).length;
  const { r } = lowBidVsEstimate(L, estimate);
  if (k >= 6) return { k, r, limitPct: null, verdict: 'excellent', warning: null };
  const limitPct = adequacyThresholdPct(k);
  const ok = rCmp(r, ratio(limitPct, 100)) <= 0;
  return {
    k,
    r,
    limitPct,
    verdict: ok ? 'adequate' : 'not_adequate',
    warning: ok ? null : `low bid is above ${limitPct}% of the estimate with ${k} competitive bid(s): on highway-type lettings the owner may reject or re-advertise (FHWA 2004 guidance, legacy)`,
  };
}

// ---------------------------------------------------------------- 7.7 expected profit, optimum and range

export interface BidCosts {
  /** TJC from the cost engine (buildBid totals). */
  readonly TJC: Cents;
  readonly OH: Cents;
  readonly FIN: Cents;
  /** K = sunk bid cost; affects bid / no-bid only. */
  readonly K: Cents;
}

export interface PriceCap {
  readonly cap: Cents;
  readonly reason: string;
}

export interface BidSelectionInput {
  readonly costs: BidCosts;
  readonly charges: PriceChargesInput;
  /** m_min on BE (contractor's minimum markup), ppm. */
  readonly minMarkupPpm: Ppm;
  /** 'full' (spec formula) or 'contribution' (drops OH, a business choice). Default 'full'. */
  readonly view?: 'full' | 'contribution';
  /** Omitted -> kappa = 0 (A-23): no adjustment, labelled. */
  readonly curse?: WinnersCurse;
  /** True when P_win and margins are calibrated on realized job costs: then C_adj must not be applied (double counting, 7.6). */
  readonly calibratedOnRealizedCosts?: boolean;
  /** Near-optimal tolerance delta in [0, 1). Omitted -> 0.05 (A-24), labelled. */
  readonly delta?: number;
  readonly curve: CurveResult;
  /**
   * Section 5.8 limits, evaluated at every candidate price. `caps` are upper limits (job size, bonding
   * letter, aggregate less backlog) and bound the search exactly; `check` is any other veto, applied to
   * every candidate and range end (a non-cap veto cannot be searched exactly).
   */
  readonly limits?: { readonly caps?: readonly PriceCap[]; readonly check?: (B: Cents) => { ok: boolean; reason: string } };
  /** Upper end of the search when the curve has no finite support (smooth assumed curves, a g(0) > 0 mixture). */
  readonly searchHi?: Cents;
}

export interface PricePoint {
  readonly B: Cents;
  /** Markup on TJC, exact, and as a float for display. */
  readonly markupExact: Ratio;
  readonly markup: number;
  readonly q: Cents;
  /** Signed cents: B - q(B) - (TJC_adj + OH + FIN). */
  readonly profitIfWon: number;
  readonly win: WinEstimate;
  /** EV(B) = profitIfWon * P_win - K, float cents; evCents rounded for display. */
  readonly ev: number;
  readonly evCents: number;
  readonly veto: string | null;
}

interface Base {
  readonly floor: Cents;
  readonly TJCadj: Cents;
  readonly model: string;
  readonly J: number | null;
  readonly referenceClass: string;
  readonly assumptions: readonly AssumptionUsed[];
  readonly modelAssumptions: readonly string[];
  readonly warnings: readonly string[];
}

export type BidSelection =
  | (Base & {
      readonly status: 'bid';
      readonly method: 'exact-candidates' | 'bounded-search';
      readonly delta: number;
      readonly recommended: PricePoint;
      readonly low: PricePoint;
      readonly high: PricePoint;
      /** The near-optimal set { B >= floor : EV(B) >= (1 - delta) EV(B*) } as disjoint cent intervals. */
      readonly intervals: readonly { readonly lo: Cents; readonly hi: Cents }[];
      readonly contiguous: boolean;
      /** Per price in the range: markup, win probability low/mid/high, profit if won, EV (7.7). */
      readonly rows: readonly PricePoint[];
      readonly candidatesEvaluated: number;
    })
  | (Base & { readonly status: 'no_bid'; readonly reason: string; readonly best: PricePoint | null })
  | { readonly status: 'not_enough_data'; readonly reason: string; readonly data: NotEnoughData };

/** q(B) with the auto-bond rule: tiers apply iff bondRequiredAuto(B) (contract amount B), else as given. */
export function chargeAt(B: Cents, c: PriceChargesInput): Cents {
  const tiers = c.bondRequiredAuto ? (c.bondRequiredAuto(B) ? c.tiers : []) : c.tiers;
  return priceBasedCharge(B, c, tiers);
}

/** floor = grossUp(BE*(1 + m_min) + FIN), BE = TJC + OH, with the 2.13 auto-bond rule (spec 7.7). */
export function bidFloor(costs: BidCosts, charges: PriceChargesInput, minMarkupPpm: Ppm): Cents {
  checkCosts(costs);
  assertPpm(minMarkupPpm, 'm_min');
  validateTiers(charges.tiers);
  const BE = BigInt(costs.TJC) + BigInt(costs.OH);
  const S = toCents(BE + BigInt(mulRate(toCents(BE, 'BE'), minMarkupPpm)) + BigInt(costs.FIN), 'floor S');
  if (charges.bondRequiredAuto) {
    const pNoBond = grossUp(S, charges, []).P;
    return charges.bondRequiredAuto(pNoBond) ? grossUp(S, charges, charges.tiers).P : pNoBond;
  }
  return grossUp(S, charges, charges.tiers).P;
}

function checkCosts(c: BidCosts): void {
  assertInt(c.TJC, 'TJC', 1);
  assertCents(c.OH, 'OH');
  assertCents(c.FIN, 'FIN');
  assertCents(c.K, 'K');
}

export interface Evaluator {
  readonly floor: Cents;
  readonly TJCadj: Cents;
  readonly curve: WinCurve;
  q(B: Cents): Cents;
  profitIfWon(B: Cents): number;
  ev(B: Cents): number;
  point(B: Cents): PricePoint;
}

/** The EV machinery of 7.7 for one input; exported so a UI can draw the whole curve. */
export function makeEvaluator(input: BidSelectionInput, curve: WinCurve): Evaluator {
  const { costs, charges } = input;
  const floor = bidFloor(costs, charges, input.minMarkupPpm);
  if (input.curse && input.curse.factor !== 1 && input.calibratedOnRealizedCosts)
    refuse('DOUBLE_COUNTING', "winner's-curse adjustment must not be applied when P_win and margins are calibrated on realized job costs (7.6)");
  const TJCadj = input.curse ? adjustedCost(costs.TJC, input.curse) : costs.TJC;
  const view = input.view ?? 'full';
  if (view !== 'full' && view !== 'contribution') refuse('BAD_INPUT', `unknown view ${String(view)}`);
  const cost = BigInt(TJCadj) + (view === 'full' ? BigInt(costs.OH) : 0n) + BigInt(costs.FIN);
  const q = (B: Cents): Cents => chargeAt(assertCents(B, 'bid'), charges);
  const profitIfWon = (B: Cents): number => {
    const v = BigInt(B) - BigInt(q(B)) - cost;
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) refuse('UNSAFE_INTEGER', 'profit out of range');
    return Number(v);
  };
  const ev = (B: Cents): number => profitIfWon(B) * curve.p(B) - costs.K;
  const point = (B: Cents): PricePoint => {
    const pr = profitIfWon(B);
    const win = curve.estimate(B);
    const e = pr * win.p - costs.K;
    const markupExact = ratio(BigInt(B) - BigInt(costs.TJC), BigInt(costs.TJC));
    const chk = input.limits?.check?.(B);
    return { B, markupExact, markup: B / costs.TJC - 1, q: q(B), profitIfWon: pr, win, ev: e, evCents: Math.round(e), veto: chk && !chk.ok ? chk.reason : null };
  };
  return { floor, TJCadj, curve, q, profitIfWon, ev, point };
}

/** Smallest x in [a, b] with pred(x) true, for pred false...true on [a, b]; null if pred(b) is false. */
function firstTrue(a: number, b: number, pred: (x: number) => boolean): number | null {
  if (!pred(b)) return null;
  let lo = a, hi = b;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (pred(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
/** Largest x in [a, b] with pred(x) true, for pred true...false on [a, b]; null if pred(a) is false. */
function lastTrue(a: number, b: number, pred: (x: number) => boolean): number | null {
  if (!pred(a)) return null;
  let lo = a, hi = b;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (pred(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Exhaustive below this window (cents); above it a deterministic grid-and-zoom search (7.7 "bounded numeric search"). */
export const SMOOTH_EXHAUSTIVE_WINDOW = 4096;
const GRID = 256;

function argmaxSmooth(a: number, b: number, f: (x: number) => number): { x: number; v: number; evals: number } {
  let evals = 0;
  const scan = (lo: number, hi: number): { x: number; v: number } => {
    let bx = lo, bv = -Infinity;
    for (let x = lo; x <= hi; x++) {
      const v = f(x);
      evals++;
      if (v > bv) {
        bv = v;
        bx = x;
      }
    }
    return { x: bx, v: bv };
  };
  let lo = a, hi = b;
  while (hi - lo > SMOOTH_EXHAUSTIVE_WINDOW) {
    const span = BigInt(hi - lo);
    const xs: number[] = [];
    for (let i = 0; i <= GRID; i++) xs.push(lo + Number((span * BigInt(i)) / BigInt(GRID)));
    let bi = 0, bv = -Infinity;
    xs.forEach((x, i) => {
      const v = f(x);
      evals++;
      if (v > bv) {
        bv = v;
        bi = i;
      }
    });
    const nlo = xs[Math.max(0, bi - 1)] as number, nhi = xs[Math.min(GRID, bi + 1)] as number;
    if (nlo === lo && nhi === hi) break;
    lo = nlo;
    hi = nhi;
  }
  const r = scan(lo, hi);
  return { ...r, evals };
}

/**
 * Spec 7.7: B* = argmax EV(B) over B >= floor; range = { B >= floor : EV(B) >= (1 - delta) EV(B*) },
 * or NO BID when EV(B*) <= 0. Section 5.8 limits are evaluated at every candidate and can veto it.
 */
export function selectBid(input: BidSelectionInput): BidSelection {
  if (input.curve.status !== 'ok') return { status: 'not_enough_data', reason: input.curve.reason, data: input.curve };
  const curve = input.curve.curve;
  const delta = input.delta ?? A24_DELTA;
  if (!(delta >= 0 && delta < 1)) refuse('OUT_OF_RANGE', `delta must be in [0, 1), got ${delta}`);
  const E = makeEvaluator(input, curve);
  const { floor } = E;

  const assumptions: AssumptionUsed[] = [{ id: 'A-25', text: A25_TEXT, value: `J >= ${A25_MIN_J}, alpha ${A25_ALPHA}` }];
  if (input.delta === undefined) assumptions.push({ id: 'A-24', text: 'near-optimal tolerance delta (product setting)', value: String(A24_DELTA) });
  if (!input.curse) assumptions.push({ id: 'A-23', text: "winner's-curse share kappa off until sigma is set from estimate-versus-actual history", value: `kappa = ${A23_KAPPA}` });
  const warnings: string[] = [
    'expected-profit maximisation is risk-neutral: it ignores ruin, backlog, bonding and cash; the limits check can veto any price',
    'a range and a curve, not "the right bid": no price is sure to win',
  ];
  if (curve.provenance === 'assumed') warnings.push('the win curve is an assumed illustration, not data');
  if (curve.model === 'kernel') warnings.push('smoothed curve: show the raw step curve beside it');
  if (curve.model === 'friedman' || curve.model === 'gates') warnings.push('Friedman and Gates are two model outputs, never confidence limits');
  const base: Base = {
    floor,
    TJCadj: E.TJCadj,
    model: curve.model,
    J: curve.J,
    referenceClass: curve.referenceClass,
    assumptions,
    modelAssumptions: curve.assumptions,
    warnings,
  };

  // Upper limits (5.8) bound the search exactly.
  const caps = input.limits?.caps ?? [];
  caps.forEach((c) => assertCents(c.cap, 'cap'));
  const tightest = caps.reduce<PriceCap | null>((m, c) => (m === null || c.cap < m.cap ? c : m), null);
  if (input.searchHi !== undefined) assertCents(input.searchHi, 'searchHi');
  if (tightest && floor > tightest.cap)
    return { ...base, status: 'no_bid', reason: `the floor ${floor} is above a limit: ${tightest.reason} (${tightest.cap})`, best: null };
  const capHi = tightest ? tightest.cap : null;
  const ok = (B: number): boolean => !input.limits?.check || input.limits.check(B as Cents).ok;

  // Bound of the search.
  let U: number | null = capHi;
  if (input.searchHi !== undefined) U = U === null ? input.searchHi : Math.min(U, input.searchHi);
  const supportHi = curve.supportHi;
  if (U === null && supportHi !== null) U = Math.max(supportHi, floor);
  if (U === null) refuse('NO_SEARCH_BOUND', 'the win curve stays above 0 at every price: give searchHi or a price cap');
  if (U < floor) U = floor;
  const Uf = U;

  // Bond threshold: the smallest B > floor at which the auto rule adds the bond (assumed monotone).
  const breaks = new Set<number>();
  const auto = input.charges.bondRequiredAuto;
  if (auto && !auto(floor) && Uf > floor && auto(Uf as Cents)) {
    const t = firstTrue(floor + 1, Uf, (x) => auto(x as Cents));
    if (t !== null) breaks.add(t);
  }

  const T = (evStar: number): number => (1 - delta) * evStar;
  let best: { B: number; v: number } | null = null;
  const consider = (B: number, v: number): void => {
    if (!ok(B)) return;
    if (best === null || v > best.v || (v === best.v && B < best.B)) best = { B, v };
  };
  let evals = 0;
  let intervals: { lo: number; hi: number }[] = [];
  let method: 'exact-candidates' | 'bounded-search';

  if (curve.shape === 'step') {
    method = 'exact-candidates';
    for (const j of curve.jumps) if (j > floor && j <= Uf) breaks.add(j);
    const bs = [...breaks].sort((a, b) => a - b);
    const segs: { lo: number; hi: number }[] = [];
    let start: number = floor;
    for (const b of bs) {
      segs.push({ lo: start, hi: b - 1 });
      start = b;
    }
    segs.push({ lo: start, hi: Uf });
    // Beyond the support with p > 0 and no bound would be unbounded: refused above (NO_SEARCH_BOUND).
    consider(floor, E.ev(floor as Cents));
    evals++;
    for (const s of segs) {
      consider(s.hi, E.ev(s.hi as Cents));
      evals++;
    }
    // Ties: the lowest price with the best EV. EV is non-decreasing inside a segment, so walk the
    // winning right end down to the first cent of its segment that reaches the same EV.
    if (best !== null) {
      const b = best as { B: number; v: number };
      const seg = segs.find((s) => s.lo <= b.B && b.B <= s.hi);
      if (seg) {
        const x = firstTrue(seg.lo, b.B, (y) => E.ev(y as Cents) >= b.v);
        if (x !== null && x < b.B && ok(x)) best = { B: x, v: E.ev(x as Cents) };
      }
    }
    if (best !== null && (best as { v: number }).v > 0) {
      const t = T((best as { v: number }).v);
      for (const s of segs) {
        if (curve.p(s.lo as Cents) === 0) continue;
        // EV is non-decreasing inside a segment (P_win constant, B - q(B) non-decreasing).
        const x = firstTrue(s.lo, s.hi, (b) => E.ev(b as Cents) >= t);
        if (x !== null) intervals.push({ lo: x, hi: s.hi });
      }
    }
  } else {
    method = 'bounded-search';
    const bs = [...breaks].sort((a, b) => a - b);
    const pieces: { lo: number; hi: number }[] = [];
    let start: number = floor;
    for (const b of bs) {
      pieces.push({ lo: start, hi: b - 1 });
      start = b;
    }
    pieces.push({ lo: start, hi: Uf });
    for (const pc of pieces) {
      const r = argmaxSmooth(pc.lo, pc.hi, (x) => (ok(x) ? E.ev(x as Cents) : -Infinity));
      evals += r.evals;
      if (r.v > -Infinity) consider(r.x, r.v);
    }
    if (best !== null && (best as { v: number }).v > 0) {
      const bB = (best as { B: number }).B, t = T((best as { v: number }).v);
      // Unimodal reading: EV rises to B* and falls after it (stated in the method label).
      const lo = firstTrue(floor, bB, (b) => E.ev(b as Cents) >= t) ?? bB;
      const hi = lastTrue(bB, Uf, (b) => E.ev(b as Cents) >= t) ?? bB;
      intervals.push({ lo, hi });
      warnings.push('smooth curve: optimum by bounded numeric search; the range assumes EV rises to B* and falls after it');
    }
  }

  if (best === null) return { ...base, status: 'no_bid', reason: 'every candidate price was vetoed by the limits check', best: null };
  const b0 = best as { B: number; v: number };
  const bestPoint = E.point(b0.B as Cents);
  if (!(b0.v > 0)) return { ...base, status: 'no_bid', reason: `NO BID: expected value at the best price is ${Math.round(b0.v)} cents (not positive)`, best: bestPoint };

  // Merge touching intervals.
  intervals.sort((a, b) => a.lo - b.lo);
  const merged: { lo: number; hi: number }[] = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv.lo <= last.hi + 1) last.hi = Math.max(last.hi, iv.hi);
    else merged.push({ ...iv });
  }
  intervals = merged;
  const first = intervals[0] as { lo: number; hi: number }, lastIv = intervals[intervals.length - 1] as { lo: number; hi: number };
  const low = E.point(first.lo as Cents), high = E.point(lastIv.hi as Cents);
  if (low.veto) warnings.push(`low end vetoed by limits: ${low.veto}`);
  if (high.veto) warnings.push(`high end vetoed by limits: ${high.veto}`);
  if (intervals.length > 1) warnings.push('the near-optimal prices are not one block: prices between the blocks fall short of the tolerance');

  const rowsB = new Set<number>([floor, first.lo, b0.B, lastIv.hi]);
  for (const iv of intervals) {
    rowsB.add(iv.lo);
    rowsB.add(iv.hi);
  }
  const rows = [...rowsB].sort((a, b) => a - b).map((B) => E.point(B as Cents));
  return {
    ...base,
    status: 'bid',
    method,
    delta,
    recommended: bestPoint,
    low,
    high,
    intervals: intervals.map((iv) => ({ lo: iv.lo as Cents, hi: iv.hi as Cents })),
    contiguous: intervals.length === 1,
    rows,
    candidatesEvaluated: evals,
  };
}

/** Rows of the expected-profit curve at given prices (7.7 "per price ... report"). */
export function expectedProfitCurve(input: BidSelectionInput, prices: readonly Cents[]): PricePoint[] {
  if (input.curve.status !== 'ok') refuse('NOT_ENOUGH_DATA', input.curve.reason);
  const E = makeEvaluator(input, input.curve.curve);
  return prices.map((B) => E.point(B));
}

/** Exact markup m on cost C for a bid B: m = B/C - 1 (display helper). */
export function markupOf(B: Cents, C: Cents): Ratio {
  assertCents(B, 'bid');
  assertInt(C, 'cost', 1);
  return rSub(rDiv(ratio(B), ratio(C)), ratio(1n));
}
