// Win probability for the price agent (spec section 7.1 to 7.5, 7.8, 7.10).
//
// Statistics here may use float64 (spec 0.1 rule 3); money never does. Every comparison between
// our bid and a competitor's bid is exact (BigInt cross-multiplication), so a step curve jumps at an
// exact cent. Pure: no clock, no randomness, no I/O. Every data-driven output carries its sample size
// J, the model and its uncertainty band, and is refused (with a reason) below the minimum J (A-25).

import {
  refuse,
  ratio,
  rMul,
  rToNumber,
  assertCents,
  assertInt,
  type Cents,
  type Ratio,
} from './money.js';

// ---------------------------------------------------------------- section 9 assumptions used here

/**
 * A-25 (assumption, editable, shown to the user as one): display thresholds. "Not enough data" below
 * J = 10; no 10% tail below J = 29. The 29 (and 59) are the tail minimums of spec 7.5 at alpha = 0.05,
 * so alpha = 0.05 is part of this assumption; tailMinimumJ(0.10, A25_ALPHA) reproduces 29.
 */
export const A25_MIN_J = 10;
export const A25_ALPHA = 0.05;
export const A25_TEXT = 'display thresholds: "not enough data" below J = 10; no 10% tail below J = 29 (alpha 0.05)';

// ---------------------------------------------------------------- section 8 defaults used here

/**
 * D-71 (law [X], Nevada, current): NRS 338.147 / 338.1389 bidder preference applies when the estimated
 * cost exceeds $250,000; NRS 338.13844 deems a qualifying veteran-owned local business's bid 5% lower on
 * State public works up to $250,000. Source: https://www.leg.state.nv.us/nrs/NRS-338.html
 */
export const D71_NV_PREFERENCE_THRESHOLD = 25_000_000 as Cents; // $250,000.00, effective: current NRS
/** D-71: 5% preference expressed exactly: preferred wins if B_pref <= 1.05 * B_low_nonpreferred. */
const D71_PREF_NUM = 105n, D71_PREF_DEN = 100n;
/** D-71: veteran bid "deemed to be 5 percent lower": evaluated = 0.95 * bid. */
const D71_VET_NUM = 95n, D71_VET_DEN = 100n;
/**
 * D-72 (law [X], US federal, current): FAR 19.1307 HUBZone price evaluation preference, a factor of
 * 10 percent added to offers other than non-waiving HUBZone small businesses and otherwise-successful
 * small businesses. Source: https://www.ecfr.gov/current/title-48/section-19.1307
 */
const D72_HUBZONE_NUM = 110n, D72_HUBZONE_DEN = 100n;
/**
 * D-70 (law [X], Nevada, 2025 NRS): NRS 338.13862 small public works: estimated cost over $25,000 up
 * to $100,000, at least three licensed contractors solicited; $25,000 or less, at least one.
 * Source: https://law.justia.com/codes/nevada/chapter-338/statute-338-13862/
 */
export const D70_SMALL_WORKS_ONE = 2_500_000 as Cents; // $25,000.00
export const D70_SMALL_WORKS_THREE = 10_000_000 as Cents; // $100,000.00
/**
 * D-76 (mathematics; recomputed by the verifier): kernel bandwidth h = 0.9 * min(s, IQR/1.34) * n^(-1/5).
 * Source: https://www.itl.nist.gov/div898/software/dataplot/refman1/auxillar/kernplot.htm
 */
const D76_BW_FACTOR = 0.9, D76_BW_IQR = 1.34, D76_BW_POWER = -1 / 5;

// ---------------------------------------------------------------- normal distribution (mathematics)

const LN_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);

/** Upper tail Q(x) = 1 - Phi(x) for x >= 5: Laplace's continued fraction for the Mills ratio,
 *  Q(x) = phi(x) / (x + 1/(x + 2/(x + 3/(x + ...)))), evaluated backward at a fixed depth of 80.
 *  Relative accuracy near 1e-16 there, so tail values are monotone where the series is not. */
function upperTailCf(x: number): number {
  let r = 0;
  for (let k = 80; k >= 1; k--) r = k / (x + r);
  return Math.exp(-0.5 * x * x - LN_SQRT_2PI) / (x + r);
}

/**
 * Standard normal CDF Phi(x), float64 (mathematics). |x| < 5: Marsaglia's Taylor series
 * (J. Stat. Softw. 11(4), 2004), Phi(x) = 1/2 + phi(x) * sum_{n>=0} x^(2n+1)/(1*3*...*(2n+1)).
 * |x| >= 5: the continued fraction above (the series loses relative accuracy in the tails, which
 * made the computed curve wobble). |x| >= 38: exactly 0 or 1.
 */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) refuse('BAD_INPUT', 'normalCdf of NaN');
  if (x <= -38) return 0;
  if (x >= 38) return 1;
  if (x <= -5) return upperTailCf(-x);
  if (x >= 5) return 1 - upperTailCf(x);
  let s = x, t = 0, b = x, i = 1;
  const q = x * x;
  while (s !== t) {
    t = s;
    i += 2;
    b *= q / i;
    s = t + b;
  }
  const v = 0.5 + s * Math.exp(-0.5 * q - LN_SQRT_2PI);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Inverse standard normal CDF by bisection on normalCdf (pure, deterministic). 0 < u < 1. */
export function normalQuantile(u: number): number {
  if (!(u > 0 && u < 1)) refuse('OUT_OF_RANGE', `normalQuantile needs 0 < u < 1, got ${u}`);
  let lo = -38, hi = 38;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < u) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Two-sided z for confidence 1 - alpha: z = Phi^-1(1 - alpha/2). alpha = 0.05 gives 1.95996 (spec 7.5 "1.96"). */
export function zForAlpha(alpha: number): number {
  checkAlpha(alpha);
  return normalQuantile(1 - alpha / 2);
}

function checkAlpha(alpha: number): void {
  if (!(alpha > 0 && alpha < 1)) refuse('OUT_OF_RANGE', `alpha must be in (0, 1), got ${alpha}`);
}
function checkProb(p: number, what: string): void {
  if (!(p >= 0 && p <= 1)) refuse('OUT_OF_RANGE', `${what} must be a probability in [0, 1], got ${p}`);
}
function checkJ(J: number, what = 'J'): void {
  assertInt(J, what, 1);
}

// ---------------------------------------------------------------- 7.5 uncertainty

export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

/**
 * Wilson score interval for a proportion p = k/J (spec 7.5). centre = (p + z^2/(2J))/(1 + z^2/J),
 * half = z*sqrt(p(1-p)/J + z^2/(4J^2))/(1 + z^2/J). `p` may also be a smoothed estimate in [0, 1].
 */
export function wilsonInterval(p: number, J: number, alpha = A25_ALPHA): Interval {
  checkProb(p, 'p');
  checkJ(J);
  const z = zForAlpha(alpha);
  const z2 = z * z;
  const den = 1 + z2 / J;
  const centre = (p + z2 / (2 * J)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / J + z2 / (4 * J * J))) / den;
  let lo = Math.max(0, centre - half), hi = Math.min(1, centre + half);
  // p = 0 and p = 1 are exact ends of the score interval (float noise would otherwise leave ~1e-17).
  if (p === 0) lo = 0;
  if (p === 1) hi = 1;
  if (lo > p) lo = p;
  if (hi < p) hi = p;
  return { lo, hi };
}

/** Wilson interval for k wins in J tries (spec 7.5). */
export function wilson(k: number, J: number, alpha = A25_ALPHA): Interval {
  checkJ(J);
  assertInt(k, 'k', 0, J);
  return wilsonInterval(k / J, J, alpha);
}

/** DKW half-width for the whole curve: eps = sqrt(ln(2/alpha)/(2J)) (spec 7.5). */
export function dkwEpsilon(J: number, alpha = A25_ALPHA): number {
  checkJ(J);
  checkAlpha(alpha);
  return Math.sqrt(Math.log(2 / alpha) / (2 * J));
}

/** DKW band around a curve value, clipped to [0, 1] (invariant 109). */
export function dkwBand(p: number, J: number, alpha = A25_ALPHA): Interval & { eps: number } {
  checkProb(p, 'p');
  const eps = dkwEpsilon(J, alpha);
  return { lo: Math.max(0, p - eps), hi: Math.min(1, p + eps), eps };
}

/**
 * A statement at win probability w needs J >= ln(alpha)/ln(1 - min(w, 1-w)) (spec 7.5).
 * Returns the smallest such integer J. 0 < w < 1 (a claim of exactly 0 or 1 never has enough data;
 * use zeroWinsUpperBound).
 */
export function tailMinimumJ(w: number, alpha = A25_ALPHA): number {
  if (!(w > 0 && w < 1)) refuse('OUT_OF_RANGE', `tail level must be in (0, 1), got ${w}`);
  checkAlpha(alpha);
  const t = Math.min(w, 1 - w);
  return Math.ceil(Math.log(alpha) / Math.log(1 - t));
}

/** Zero wins in J tries: (1 - alpha) upper bound 1 - alpha^(1/J), about 3/J at alpha 0.05 (spec 7.5). */
export function zeroWinsUpperBound(J: number, alpha = A25_ALPHA): number {
  checkJ(J);
  checkAlpha(alpha);
  return 1 - Math.pow(alpha, 1 / J);
}

// ---------------------------------------------------------------- 7.1 award rule (law, before any probability)

/** Bidder status flags, as established for the letting (contractor records / bid documents). */
export interface BidderFlags {
  /** NRS 338.147: responsive, responsible, valid certificate of eligibility, affidavit filed within 2 h of opening. */
  readonly nvPreferenceEligible?: boolean;
  /** NRS 338.13844: local business owned and operated by a veteran with a service-connected disability. */
  readonly nvQualifyingVeteranLocal?: boolean;
  /** Small business (13 CFR 121; D-59 size standard for NAICS 238210). */
  readonly smallBusiness?: boolean;
  /** HUBZone small business that has not waived the evaluation preference. */
  readonly hubzoneNotWaived?: boolean;
}

export type AwardRule =
  | { readonly kind: 'sealed_low' }
  /** NRS 338.147 / 338.1389: applies when the estimated cost exceeds $250,000 (D-71). */
  | { readonly kind: 'nv_bidder_preference'; readonly estimatedCost: Cents }
  /** NRS 338.13844: State owner, estimated cost up to $250,000 (D-71). */
  | { readonly kind: 'nv_veteran_deemed_lower'; readonly estimatedCost: Cents; readonly ownerIsState: boolean }
  /** FAR 19.1307: full and open competition where price is a factor (D-72). */
  | { readonly kind: 'federal_hubzone'; readonly fullAndOpen: boolean; readonly priceIsFactor: boolean };

export interface EvaluatedPrice {
  /** Price used for the award comparison, exact. */
  readonly evaluated: Ratio;
  /** Factor applied to the submitted price (1 when no preference applies). */
  readonly factor: Ratio;
  /** Legal citation of the factor applied, or null. */
  readonly applied: string | null;
  /** Wins ties against a bidder of lower tie priority (NRS 338.147: "not more than 5 percent higher"). */
  readonly tiePriority: number;
}

/** Whether the rule is in force for this letting at all (thresholds, owner, competition type). */
export function ruleInForce(rule: AwardRule): boolean {
  switch (rule.kind) {
    case 'sealed_low':
      return false;
    case 'nv_bidder_preference':
      return assertCents(rule.estimatedCost, 'estimated cost') > D71_NV_PREFERENCE_THRESHOLD;
    case 'nv_veteran_deemed_lower':
      return rule.ownerIsState && assertCents(rule.estimatedCost, 'estimated cost') <= D71_NV_PREFERENCE_THRESHOLD;
    case 'federal_hubzone':
      return rule.fullAndOpen && rule.priceIsFactor;
    default:
      return refuse('BAD_INPUT', `unknown award rule ${String((rule as { kind?: unknown }).kind)}`);
  }
}

/** The factor the rule applies to one bidder's price (spec 7.1). */
export function preferenceFactor(rule: AwardRule, flags: BidderFlags = {}): { factor: Ratio; applied: string | null; tiePriority: number } {
  const one = { factor: ratio(1n), applied: null, tiePriority: 0 };
  if (!ruleInForce(rule)) return one;
  switch (rule.kind) {
    case 'nv_bidder_preference':
      // Preferred wins iff B_pref <= 1.05 * B_np  <=>  B_pref / 1.05 <= B_np, ties to the preferred.
      return flags.nvPreferenceEligible
        ? { factor: ratio(D71_PREF_DEN, D71_PREF_NUM), applied: 'NRS 338.147 (5% bidder preference)', tiePriority: 1 }
        : one;
    case 'nv_veteran_deemed_lower':
      return flags.nvQualifyingVeteranLocal
        ? { factor: ratio(D71_VET_NUM, D71_VET_DEN), applied: 'NRS 338.13844 (deemed 5% lower)', tiePriority: 0 }
        : one;
    case 'federal_hubzone':
      // A small business's own factor is always 1.00 (spec 7.1): either it is a non-waiving HUBZone
      // offer, or it only matters when otherwise successful; and the preference does not apply when the
      // initial low offeror is a small business. Pairwise, only a non-small offer is ever raised.
      return flags.smallBusiness || flags.hubzoneNotWaived
        ? one
        : { factor: ratio(D72_HUBZONE_NUM, D72_HUBZONE_DEN), applied: 'FAR 19.1307 (10% added)', tiePriority: 0 };
    default:
      return one;
  }
}

/** evaluatedPrice(rule, flags) applied to a submitted price (spec 7.1, appendix). */
export function evaluatedPrice(rule: AwardRule, flags: BidderFlags, price: Cents): EvaluatedPrice {
  assertCents(price, 'price');
  const f = preferenceFactor(rule, flags);
  return { evaluated: rMul(ratio(BigInt(price)), f.factor), ...f };
}

/**
 * Win test for one pair (spec 7.1): our bid beats the competitor if its evaluated price is lower, or
 * equal with a higher tie priority. Equal evaluated prices otherwise count as a loss (conservative).
 */
export function beats(rule: AwardRule, ours: { price: Cents; flags: BidderFlags }, theirs: { price: Cents; flags: BidderFlags }): boolean {
  const a = evaluatedPrice(rule, ours.flags, ours.price), b = evaluatedPrice(rule, theirs.flags, theirs.price);
  const l = a.evaluated.num * b.evaluated.den, r = b.evaluated.num * a.evaluated.den;
  return l < r || (l === r && a.tiePriority > b.tiePriority);
}

/**
 * Smallest bid B (cents) at which we no longer beat a competitor whose price, scaled to this job, is
 * compNum/compDen cents. Exact: we win iff B*fu < comp*fc (or equal with tie priority to us).
 */
function lossThreshold(compNum: bigint, compDen: bigint, fu: Ratio, fc: Ratio, tieToUs: boolean): bigint {
  // B * fu.num/fu.den  vs  compNum/compDen * fc.num/fc.den   ->   B * X  vs  Y
  const X = fu.num * compDen * fc.den;
  const Y = compNum * fc.num * fu.den;
  // lose iff B*X > Y (tie to us) or B*X >= Y
  return tieToUs ? Y / X + 1n : (Y + X - 1n) / X;
}

// ---------------------------------------------------------------- 7.2 how many competitors

/** NRS 338.13862 small works (D-70): minimum number of licensed contractors the agency must solicit. */
export function nvSmallWorksSolicitation(estimatedCost: Cents): { advertised: boolean; minimumSolicited: number | null; note: string } {
  assertCents(estimatedCost, 'estimated cost');
  if (estimatedCost <= D70_SMALL_WORKS_ONE)
    return { advertised: false, minimumSolicited: 1, note: 'NRS 338.13862: $25,000 or less, quotes from at least one licensed contractor; may have no public tabulation' };
  if (estimatedCost <= D70_SMALL_WORKS_THREE)
    return { advertised: false, minimumSolicited: 3, note: 'NRS 338.13862: over $25,000 up to $100,000, quotes from at least three licensed contractors; the count is whoever the agency asked' };
  return { advertised: true, minimumSolicited: null, note: 'above $100,000 Nevada advertises: estimate g(k) from comparable lettings' };
}

/** Federal awards: competitors = number_of_offers_received - 1; missing stays missing (spec 7.2). */
export function federalCompetitors(offersReceived: number | null | undefined): number | null {
  if (offersReceived === null || offersReceived === undefined) return null;
  assertInt(offersReceived, 'offers received', 1);
  return offersReceived - 1;
}

export interface CompetitorDistribution {
  readonly status: 'ok';
  readonly J: number;
  readonly referenceClass: string;
  /** g(k): share of past comparable lettings with exactly k competitors, exact and as a float. */
  readonly g: readonly { readonly k: number; readonly share: Ratio; readonly p: number }[];
}
export interface NotEnoughData {
  readonly status: 'not_enough_data';
  readonly model: string;
  readonly J: number;
  readonly minJ: number;
  readonly referenceClass: string;
  readonly reason: string;
}

/** g(k) from the competitor counts of past comparable lettings (spec 7.2); refused below A-25's J. */
export function competitorCountDistribution(counts: readonly number[], referenceClass: string, minJ = A25_MIN_J): CompetitorDistribution | NotEnoughData {
  checkRef(referenceClass);
  counts.forEach((k, i) => assertInt(k, `competitor count ${i}`, 0));
  const J = counts.length;
  if (J < minJ) return notEnough('g(k)', J, minJ, referenceClass);
  const tally = new Map<number, number>();
  for (const k of counts) tally.set(k, (tally.get(k) ?? 0) + 1);
  const g = [...tally.entries()].sort((a, b) => a[0] - b[0]).map(([k, c]) => ({ k, share: ratio(c, J), p: c / J }));
  return { status: 'ok', J, referenceClass, g };
}

function notEnough(model: string, J: number, minJ: number, referenceClass: string): NotEnoughData {
  return { status: 'not_enough_data', model, J, minJ, referenceClass, reason: `not enough data: J = ${J} comparable lettings, at least ${minJ} needed (A-25)` };
}
function checkRef(referenceClass: string): void {
  if (typeof referenceClass !== 'string' || referenceClass.trim() === '') refuse('BAD_INPUT', 'reference class is required (spec 7.10 rule 1)');
}

// ---------------------------------------------------------------- 7.3 data form and the tenant guard

/** Where a history row came from. Private rows belong to one tenant (spec 7.10 rule 5, 12.1 rule 15). */
export type Provenance = { readonly kind: 'public'; readonly source: string } | { readonly kind: 'private'; readonly tenantId: string };

/** One past comparable letting: x_j = Lc_j / A_j (spec 7.3). */
export interface LettingRecord {
  readonly id: string;
  /** A_j: the owner's (engineer's) estimate when published, else our own cost estimate at bid time. */
  readonly anchor: Cents;
  readonly anchorKind: 'owner_estimate' | 'own_cost_estimate';
  /** Lc_j: lowest competing evaluated bid (our own bid excluded). */
  readonly lowestCompeting: Cents;
  /** Preference status of that competitor (spec 7.1). */
  readonly competitorFlags?: BidderFlags;
  readonly provenance: Provenance;
}

export interface HistoryInput {
  readonly lettings: readonly LettingRecord[];
  /** Same agency class, trade, size band, bidder-count band (spec 7.3). Shown with every estimate. */
  readonly referenceClass: string;
  /** The tenant being advised; another tenant's private rows are refused. */
  readonly requestingTenantId: string;
}

/** This job, as the curve sees it. */
export interface JobForCurve {
  /** A: the anchor for this job, same kind as the history's anchors. */
  readonly anchor: Cents;
  readonly rule: AwardRule;
  readonly ourFlags: BidderFlags;
}

function guardTenant(p: Provenance, requesting: string, what: string): void {
  if (typeof requesting !== 'string' || requesting === '') refuse('BAD_INPUT', 'requesting tenant id is required');
  if (p.kind === 'private' && p.tenantId !== requesting)
    refuse('FOREIGN_PRIVATE_DATA', `${what} is another customer's private record; it must never advise this customer (spec 7.10 rule 5)`);
  if (p.kind !== 'private' && p.kind !== 'public') refuse('BAD_INPUT', `${what} has no provenance`);
}

function checkLettings(h: HistoryInput): void {
  checkRef(h.referenceClass);
  const kinds = new Set<string>();
  h.lettings.forEach((l, i) => {
    guardTenant(l.provenance, h.requestingTenantId, `letting ${l.id ?? i}`);
    assertInt(l.anchor, `letting ${l.id} anchor`, 1);
    assertInt(l.lowestCompeting, `letting ${l.id} lowest competing bid`, 1);
    kinds.add(l.anchorKind);
  });
  if (kinds.size > 1) refuse('MIXED_ANCHORS', 'history mixes owner estimates and own cost estimates as anchors (spec 7.3): use one kind');
}

// ---------------------------------------------------------------- curves

export type WinModel = 'empirical' | 'kernel' | 'friedman' | 'gates';

/** One win-probability read-out: always with model, sample size and band (spec 7.5, 7.10). */
export interface WinEstimate {
  readonly model: WinModel;
  readonly provenance: 'data' | 'assumed';
  /** Point value in [0, 1]. */
  readonly p: number;
  /** Band: Wilson on k/J (empirical), Wilson at the smoothed value (kernel), Wilson plug-in per rival (Friedman, Gates). Assumed curves: lo = hi = p. */
  readonly lo: number;
  readonly hi: number;
  readonly band: 'wilson' | 'wilson-at-smoothed' | 'wilson-plugin' | 'none (assumed curve)';
  /** DKW band for the whole curve, when the curve is an empirical distribution function. */
  readonly dkw: (Interval & { eps: number }) | null;
  /** Sample size: lettings (empirical, kernel), or the smallest rival sample (Friedman, Gates); null for assumed curves. */
  readonly J: number | null;
  /** Wins counted (empirical only). */
  readonly k: number | null;
  readonly referenceClass: string;
}

export interface WinCurve {
  readonly model: WinModel;
  readonly shape: 'step' | 'smooth';
  readonly provenance: 'data' | 'assumed';
  readonly J: number | null;
  readonly referenceClass: string;
  /** Stated assumptions of the model (spec 7.4). */
  readonly assumptions: readonly string[];
  /** Step curves: every bid B (cents) with p(B) < p(B - 1), ascending. Smooth curves: empty. */
  readonly jumps: readonly Cents[];
  /** Smallest B from which p(B) is 0 (step curves: often the last jump), or a bound beyond which p is below float resolution; null if unbounded. */
  readonly supportHi: Cents | null;
  p(B: Cents): number;
  estimate(B: Cents): WinEstimate;
}

export type CurveResult = { readonly status: 'ok'; readonly curve: WinCurve } | NotEnoughData;

function sortedUnique(xs: bigint[]): Cents[] {
  const s = [...new Set(xs.filter((x) => x > 0n && x <= BigInt(Number.MAX_SAFE_INTEGER)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s.map((x) => Number(x) as Cents);
}

/**
 * (a) Empirical: P_win(B) = count{ j : x_j > B/A } / J (spec 7.4a), after evaluatedPrice() on our bid
 * and every competitor (7.1). Exact comparisons; jumps at exact cents. Needs no independence assumption.
 */
export function pWinEmpirical(history: HistoryInput, job: JobForCurve, minJ = A25_MIN_J, alpha = A25_ALPHA): CurveResult {
  checkLettings(history);
  assertInt(job.anchor, 'job anchor', 1);
  const J = history.lettings.length;
  if (J < minJ) return notEnough('empirical', J, minJ, history.referenceClass);
  const fu = preferenceFactor(job.rule, job.ourFlags);
  // Loss threshold per letting: competitor at this job's scale is Lc_j * A / A_j cents.
  const thresholds = history.lettings.map((l) => {
    const fc = preferenceFactor(job.rule, l.competitorFlags ?? {});
    return lossThreshold(BigInt(l.lowestCompeting) * BigInt(job.anchor), BigInt(l.anchor), fu.factor, fc.factor, fu.tiePriority > fc.tiePriority);
  });
  const wins = (B: Cents): number => {
    assertCents(B, 'bid');
    const b = BigInt(B);
    let k = 0;
    for (const t of thresholds) if (b < t) k++;
    return k;
  };
  const jumps = sortedUnique(thresholds);
  const last = thresholds.reduce((m, t) => (t > m ? t : m), 0n);
  const curve: WinCurve = {
    model: 'empirical',
    shape: 'step',
    provenance: 'data',
    J,
    referenceClass: history.referenceClass,
    assumptions: ['past comparable lettings are exchangeable with this one (same reference class)', 'ties on evaluated price count as a loss unless the law gives the tie to us'],
    jumps,
    supportHi: last > 0n && last <= BigInt(Number.MAX_SAFE_INTEGER) ? (Number(last) as Cents) : null,
    p: (B) => wins(B) / J,
    estimate: (B) => {
      const k = wins(B);
      const w = wilson(k, J, alpha);
      return { model: 'empirical', provenance: 'data', p: k / J, lo: w.lo, hi: w.hi, band: 'wilson', dkw: dkwBand(k / J, J, alpha), J, k, referenceClass: history.referenceClass };
    },
  };
  return { status: 'ok', curve };
}

/** Sample quantile, linear interpolation between order statistics (type 7). Sorted input. */
function quantileSorted(xs: readonly number[], u: number): number {
  const pos = (xs.length - 1) * u;
  const i = Math.floor(pos), f = pos - i;
  const a = xs[i] as number, b = xs[Math.min(i + 1, xs.length - 1)] as number;
  return a + f * (b - a);
}

/** Kernel bandwidth on logs: h = 0.9 * min(s_y, IQR_y/1.34) * J^(-1/5) (spec 7.4b, D-76). */
export function kernelBandwidth(y: readonly number[]): { h: number; s: number; iqr: number; note?: string } {
  const J = y.length;
  if (J < 2) refuse('DEGENERATE_SAMPLE', 'bandwidth needs at least two values');
  for (const v of y) if (!Number.isFinite(v)) refuse('BAD_INPUT', 'non-finite value in sample');
  const mean = y.reduce((a, b) => a + b, 0) / J;
  const s = Math.sqrt(y.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (J - 1));
  const sorted = [...y].sort((a, b) => a - b);
  const iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25);
  if (!(s > 0)) refuse('DEGENERATE_SAMPLE', 'all ratios are equal: smoothing is undefined, use the empirical curve');
  let spread = Math.min(s, iqr / D76_BW_IQR);
  let note: string | undefined;
  if (!(spread > 0)) {
    // IQR = 0 with s > 0 would give h = 0 (no smoothing at all); fall back to s and say so.
    spread = s;
    note = 'IQR is 0: bandwidth uses the standard deviation alone';
  }
  const h = D76_BW_FACTOR * spread * Math.pow(J, D76_BW_POWER);
  return note === undefined ? { h, s, iqr } : { h, s, iqr, note };
}

/**
 * (b) Smoothed on logs (spec 7.4b): y_j = ln x_j; P_win(B) = 1 - (1/J) sum_j Phi((ln(B/A) - y_j)/h).
 * Smoothing does not reduce uncertainty and oversmooths a distribution function: show the raw step
 * curve too. The band is Wilson evaluated at the smoothed value, with the DKW band of the raw curve.
 */
export function pWinKernel(history: HistoryInput, job: JobForCurve, minJ = A25_MIN_J, alpha = A25_ALPHA): CurveResult {
  checkLettings(history);
  assertInt(job.anchor, 'job anchor', 1);
  const J = history.lettings.length;
  if (J < minJ) return notEnough('kernel', J, minJ, history.referenceClass);
  const fu = preferenceFactor(job.rule, job.ourFlags);
  const lnFu = Math.log(rToNumber(fu.factor));
  const y = history.lettings.map((l) => {
    const fc = preferenceFactor(job.rule, l.competitorFlags ?? {});
    return Math.log(l.lowestCompeting / l.anchor) + Math.log(rToNumber(fc.factor));
  });
  const bw = kernelBandwidth(y);
  const lnA = Math.log(job.anchor);
  const p = (B: Cents): number => {
    assertCents(B, 'bid');
    if (B === 0) return 1;
    const t = Math.log(B) - lnA + lnFu;
    let sum = 0;
    for (const yj of y) sum += normalCdf((t - yj) / bw.h);
    const v = 1 - sum / J;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };
  const ymax = Math.max(...y);
  const hiF = job.anchor * Math.exp(ymax + 9 * bw.h - lnFu);
  const supportHi = Number.isFinite(hiF) && hiF < Number.MAX_SAFE_INTEGER ? (Math.ceil(hiF) as Cents) : null;
  const assumptions = ['Gaussian kernel on log ratios, bandwidth 0.9 min(s, IQR/1.34) J^(-1/5) (a density default; oversmooths a distribution function)', 'show the raw step curve too'];
  if (bw.note) assumptions.push(bw.note);
  const curve: WinCurve = {
    model: 'kernel',
    shape: 'smooth',
    provenance: 'data',
    J,
    referenceClass: history.referenceClass,
    assumptions,
    jumps: [],
    supportHi,
    p,
    estimate: (B) => {
      const v = p(B);
      const w = wilsonInterval(v, J, alpha);
      return { model: 'kernel', provenance: 'data', p: v, lo: w.lo, hi: w.hi, band: 'wilson-at-smoothed', dkw: dkwBand(v, J, alpha), J, k: null, referenceClass: history.referenceClass };
    },
  };
  return { status: 'ok', curve };
}

// ---------------------------------------------------------------- 7.4 (c) Friedman and (d) Gates

function checkPs(ps: readonly number[]): void {
  ps.forEach((p, i) => checkProb(p, `p_${i}`));
}

/** Friedman: P_win = product_i p_i (spec 7.4c). No competitors gives 1. */
export function friedman(ps: readonly number[]): number {
  checkPs(ps);
  let v = 1;
  for (const p of ps) v *= p;
  return v;
}

/** Gates: P_win = 1/(1 + sum_i (1 - p_i)/p_i); any p_i = 0 returns 0 (spec 7.4d). */
export function gates(ps: readonly number[]): number {
  checkPs(ps);
  let s = 0;
  for (const p of ps) {
    if (p === 0) return 0;
    s += (1 - p) / p;
  }
  return 1 / (1 + s);
}

/** n typical rivals: Friedman p^n (spec 7.4c). */
export function friedmanTypical(p: number, n: number): number {
  checkProb(p, 'p');
  assertInt(n, 'n');
  return Math.pow(p, n);
}
/** n typical rivals: Gates 1/(1 + n(1-p)/p). */
export function gatesTypical(p: number, n: number): number {
  checkProb(p, 'p');
  assertInt(n, 'n');
  if (n === 0) return 1;
  if (p === 0) return 0;
  return 1 / (1 + (n * (1 - p)) / p);
}

/** A competitor-count distribution g(k), shares summing to 1 (k = 0 term included). */
export type CountDistribution = readonly { readonly k: number; readonly p: number }[];

function checkG(g: CountDistribution): void {
  if (g.length === 0) refuse('BAD_INPUT', 'g(k) is empty');
  let s = 0;
  for (const { k, p } of g) {
    assertInt(k, 'k');
    checkProb(p, 'g(k)');
    s += p;
  }
  if (Math.abs(s - 1) > 1e-9) refuse('OUT_OF_RANGE', `g(k) must sum to 1, got ${s}`);
}

/** Unknown n: Friedman sum_k g(k) p^k, k = 0 included (spec 7.4c). */
export function friedmanMixture(p: number, g: CountDistribution): number {
  checkG(g);
  let v = 0;
  for (const { k, p: w } of g) v += w * friedmanTypical(p, k);
  return Math.min(1, Math.max(0, v));
}
/** Unknown n under Gates: sum_k g(k) * Gates_k(p) (law of total probability; the spec states the mixture for Friedman only). */
export function gatesMixture(p: number, g: CountDistribution): number {
  checkG(g);
  let v = 0;
  for (const { k, p: w } of g) v += w * gatesTypical(p, k);
  return Math.min(1, Math.max(0, v));
}

/** One rival's bid on a past job, against OUR cost estimate C_j then (spec 7.4d). */
export interface RivalBid {
  readonly jobId: string;
  readonly rivalBid: Cents;
  readonly ourEstimate: Cents;
  readonly rivalFlags?: BidderFlags;
  readonly provenance: Provenance;
}
export interface RivalHistory {
  readonly rivalId: string;
  readonly bids: readonly RivalBid[];
}

export type Rivals =
  /** Named rivals, each with its own record: product form over i. */
  | { readonly kind: 'named'; readonly rivals: readonly RivalHistory[] }
  /** n typical rivals, p(m) pooled over all rival bids. */
  | { readonly kind: 'typical'; readonly pooled: readonly RivalBid[]; readonly n: number }
  /** Unknown n: g(k) with p(m) pooled. */
  | { readonly kind: 'mixture'; readonly pooled: readonly RivalBid[]; readonly g: CountDistribution };

export interface RivalCurveInput {
  readonly rivals: Rivals;
  readonly referenceClass: string;
  readonly requestingTenantId: string;
  /** C: our cost estimate for this job (markup m on it: B = C(1 + m)). */
  readonly ourEstimate: Cents;
  readonly rule: AwardRule;
  readonly ourFlags: BidderFlags;
}

/** p_i(B) machinery: count{ bid_ij/C_j > B/C } / count (exact). */
function rivalSampler(bids: readonly RivalBid[], inp: RivalCurveInput, fu: { factor: Ratio; tiePriority: number }) {
  const thresholds = bids.map((b) => {
    guardTenant(b.provenance, inp.requestingTenantId, `rival bid on ${b.jobId}`);
    assertInt(b.rivalBid, 'rival bid', 1);
    assertInt(b.ourEstimate, 'our estimate then', 1);
    const fc = preferenceFactor(inp.rule, b.rivalFlags ?? {});
    return lossThreshold(BigInt(b.rivalBid) * BigInt(inp.ourEstimate), BigInt(b.ourEstimate), fu.factor, fc.factor, fu.tiePriority > fc.tiePriority);
  });
  const count = (B: Cents): number => {
    const x = BigInt(B);
    let k = 0;
    for (const t of thresholds) if (x < t) k++;
    return k;
  };
  return { thresholds, n: bids.length, count };
}

/**
 * Friedman or Gates from rival records (spec 7.4c, 7.4d). Every rival sample must reach A-25's J.
 * Band: each p_i's Wilson interval plugged into the (increasing) model; this is a plug-in band, and
 * Friedman and Gates are two model outputs, never confidence limits for each other.
 */
export function pWinRivals(model: 'friedman' | 'gates', inp: RivalCurveInput, minJ = A25_MIN_J, alpha = A25_ALPHA): CurveResult {
  checkRef(inp.referenceClass);
  assertInt(inp.ourEstimate, 'our estimate', 1);
  const fu = preferenceFactor(inp.rule, inp.ourFlags);
  const r = inp.rivals;
  const samplers = r.kind === 'named' ? r.rivals.map((x) => rivalSampler(x.bids, inp, fu)) : [rivalSampler(r.pooled, inp, fu)];
  const Jmin = samplers.reduce((m, s) => Math.min(m, s.n), Number.POSITIVE_INFINITY);
  if (r.kind === 'typical') assertInt(r.n, 'n');
  if (r.kind === 'mixture') checkG(r.g);
  const noRivals = r.kind === 'named' && r.rivals.length === 0;
  if (!noRivals && Jmin < minJ)
    return notEnough(model, Jmin === Number.POSITIVE_INFINITY ? 0 : Jmin, minJ, inp.referenceClass);
  const combine = (ps: number[]): number => {
    if (r.kind === 'named') return model === 'friedman' ? friedman(ps) : gates(ps);
    const p = ps[0] as number;
    if (r.kind === 'typical') return model === 'friedman' ? friedmanTypical(p, r.n) : gatesTypical(p, r.n);
    return model === 'friedman' ? friedmanMixture(p, r.g) : gatesMixture(p, r.g);
  };
  const at = (B: Cents): { p: number; lo: number; hi: number } => {
    assertCents(B, 'bid');
    const mids: number[] = [], los: number[] = [], his: number[] = [];
    for (const s of samplers) {
      const k = s.count(B);
      const w = wilson(k, s.n, alpha);
      mids.push(k / s.n);
      los.push(w.lo);
      his.push(w.hi);
    }
    const p = combine(mids);
    return { p, lo: Math.min(p, combine(los)), hi: Math.max(p, combine(his)) };
  };
  const all = samplers.flatMap((s) => s.thresholds);
  const jumps = sortedUnique(all);
  // Beyond every threshold each p_i is 0: product and Gates give 0; a mixture keeps g(0).
  const last = all.reduce((m, t) => (t > m ? t : m), 0n);
  const zeroBeyond = r.kind !== 'mixture' || !r.g.some((x) => x.k === 0 && x.p > 0);
  const J = noRivals ? null : Jmin;
  const assumptions =
    model === 'friedman'
      ? ['Friedman: rival ratios independent at a fixed bid; every ratio shares our own estimating error, so it runs pessimistic', 'formula as reported in a 1977 review (originals not read)']
      : ['Gates: exact only for proportional-hazards bid distributions', 'formula as reported in a 1977 review (originals not read)'];
  if (r.kind === 'mixture' && model === 'gates') assumptions.push('Gates mixed over g(k) by total probability (the spec states the mixture for Friedman only)');
  const curve: WinCurve = {
    model,
    shape: 'step',
    provenance: 'data',
    J,
    referenceClass: inp.referenceClass,
    assumptions,
    jumps,
    supportHi: zeroBeyond && last > 0n && last <= BigInt(Number.MAX_SAFE_INTEGER) ? (Number(last) as Cents) : null,
    p: (B) => at(B).p,
    estimate: (B) => {
      const v = at(B);
      return { model, provenance: 'data', p: v.p, lo: v.lo, hi: v.hi, band: 'wilson-plugin', dkw: null, J, k: null, referenceClass: inp.referenceClass };
    },
  };
  return { status: 'ok', curve };
}

/** An assumed rival curve p(m), m = markup on our estimate C (test cases and what-if views; never data). */
export type AssumedRivalP =
  /** p(m) = min(1, exp(-lambda*m)) (spec 7.7 exact test case). */
  | { readonly kind: 'exponential'; readonly lambda: number }
  /** Rival ratio bid/C ~ Normal(mean, sd): p(m) = 1 - Phi((1 + m - mean)/sd) (I-23). */
  | { readonly kind: 'normalRatio'; readonly mean: number; readonly sd: number };

export function assumedP(a: AssumedRivalP, m: number): number {
  if (a.kind === 'exponential') {
    if (!(a.lambda > 0 && Number.isFinite(a.lambda))) refuse('OUT_OF_RANGE', 'lambda must be > 0');
    return m <= 0 ? 1 : Math.exp(-a.lambda * m);
  }
  if (!(a.sd > 0 && Number.isFinite(a.sd) && Number.isFinite(a.mean))) refuse('OUT_OF_RANGE', 'sd must be > 0');
  return 1 - normalCdf((1 + m - a.mean) / a.sd);
}

/**
 * Friedman or Gates on an ASSUMED p(m) (spec 7.7 test cases). Labelled 'assumed': the presentation
 * layer never shows it as an estimate (no sample size behind it).
 */
export function assumedRivalCurve(
  model: 'friedman' | 'gates',
  a: AssumedRivalP,
  rivals: { readonly n: number } | { readonly g: CountDistribution },
  ourEstimate: Cents,
  label: string,
): CurveResult {
  checkRef(label);
  assertInt(ourEstimate, 'our estimate', 1);
  assumedP(a, 0);
  if ('n' in rivals) assertInt(rivals.n, 'n');
  else checkG(rivals.g);
  const C = ourEstimate;
  const p = (B: Cents): number => {
    assertCents(B, 'bid');
    const pi = assumedP(a, B / C - 1);
    if ('n' in rivals) return model === 'friedman' ? friedmanTypical(pi, rivals.n) : gatesTypical(pi, rivals.n);
    return model === 'friedman' ? friedmanMixture(pi, rivals.g) : gatesMixture(pi, rivals.g);
  };
  const hiF = a.kind === 'normalRatio' ? C * (a.mean + 9 * a.sd) : Number.POSITIVE_INFINITY;
  const curve: WinCurve = {
    model,
    shape: 'smooth',
    provenance: 'assumed',
    J: null,
    referenceClass: label,
    assumptions: [`assumed rival curve ${a.kind === 'exponential' ? `p(m) = exp(-${a.lambda} m)` : `ratio ~ Normal(${a.mean}, ${a.sd})`}: an illustration, not data`],
    jumps: [],
    supportHi: Number.isFinite(hiF) && hiF > 0 && hiF < Number.MAX_SAFE_INTEGER ? (Math.ceil(hiF) as Cents) : null,
    p,
    estimate: (B) => {
      const v = p(B);
      return { model, provenance: 'assumed', p: v, lo: v, hi: v, band: 'none (assumed curve)', dkw: null, J: null, k: null, referenceClass: label };
    },
  };
  return { status: 'ok', curve };
}

// ---------------------------------------------------------------- 7.8 calibration

export interface BrierResult {
  readonly N: number;
  readonly BS: number;
  readonly pbar: number;
  /** Reference pbar*(1 - pbar), in-sample only. */
  readonly reference: number;
  /** 1 - BS/BS_ref; null when the observed win rate is 0 or 1 (undefined). */
  readonly skill: number | null;
}

/** Brier score BS = (1/N) sum (f_i - o_i)^2 (spec 7.8). */
export function brier(forecasts: readonly number[], outcomes: readonly (0 | 1)[]): BrierResult {
  if (forecasts.length !== outcomes.length) refuse('BAD_INPUT', 'forecasts and outcomes differ in length');
  const N = forecasts.length;
  if (N === 0) refuse('BAD_INPUT', 'no forecasts');
  let s = 0, wins = 0;
  for (let i = 0; i < N; i++) {
    const f = forecasts[i] as number, o = outcomes[i];
    checkProb(f, `forecast ${i}`);
    if (o !== 0 && o !== 1) refuse('BAD_INPUT', `outcome ${i} must be 0 or 1`);
    s += (f - o) * (f - o);
    wins += o;
  }
  const pbar = wins / N;
  const reference = pbar * (1 - pbar);
  return { N, BS: s / N, pbar, reference, skill: wins === 0 || wins === N ? null : 1 - s / N / reference };
}

/**
 * Thin-data shrinkage toward the symmetric value 1/(n+1) (spec 7.8, a design choice):
 * (k + a/(n+1)) / (J + a). The prior strength `a` (pseudo-lettings) is an input: the spec names no value.
 */
export function shrinkTowardSymmetric(k: number, J: number, n: number, a: number): number {
  assertInt(J, 'J');
  assertInt(k, 'k', 0, J);
  assertInt(n, 'n');
  if (!(a >= 0 && Number.isFinite(a))) refuse('OUT_OF_RANGE', 'prior strength must be >= 0');
  if (J + a === 0) refuse('BAD_DIVISOR', 'no data and no prior');
  return (k + a / (n + 1)) / (J + a);
}

// ---------------------------------------------------------------- 7.10 presentation rules

export type WinDisplay =
  | { readonly kind: 'not_enough_data'; readonly J: number; readonly minJ: number; readonly referenceClass: string; readonly text: string }
  | { readonly kind: 'assumed'; readonly model: WinModel; readonly referenceClass: string; readonly text: string }
  | {
      readonly kind: 'estimate';
      readonly model: WinModel;
      readonly J: number;
      readonly referenceClass: string;
      /** Whole percents (no decimals): band floor, point (null when a tail claim is not supported), band ceiling. */
      readonly lowPct: number;
      readonly midPct: number | null;
      readonly highPct: number;
      readonly text: string;
      readonly notes: readonly string[];
    };

const MODEL_NAMES: Record<WinModel, string> = {
  empirical: 'past lettings (raw count)',
  kernel: 'past lettings (smoothed)',
  friedman: 'Friedman model (independent rivals)',
  gates: 'Gates model',
};

/**
 * Spec 7.10: always show J and the reference class; a range (Wilson), no decimals; "not enough data"
 * below J = 10; no tail claim below its minimum J (7.5; 10% tail needs 29). Assumed curves are never
 * shown as an estimate.
 */
export function presentWinProbability(e: WinEstimate | NotEnoughData, minJ = A25_MIN_J, alpha = A25_ALPHA): WinDisplay {
  if ('status' in e) return { kind: 'not_enough_data', J: e.J, minJ: e.minJ, referenceClass: e.referenceClass, text: `Not enough data: ${e.J} comparable lettings (${e.referenceClass}); at least ${e.minJ} needed.` };
  if (e.provenance === 'assumed' || e.J === null)
    return { kind: 'assumed', model: e.model, referenceClass: e.referenceClass, text: `Illustration on an assumed curve (${e.referenceClass}), not an estimate from data.` };
  if (e.J < minJ) return { kind: 'not_enough_data', J: e.J, minJ, referenceClass: e.referenceClass, text: `Not enough data: ${e.J} comparable lettings (${e.referenceClass}); at least ${minJ} needed.` };
  const notes: string[] = [];
  const lowPct = Math.floor(e.lo * 100 + 1e-9);
  const highPct = Math.ceil(e.hi * 100 - 1e-9);
  let midPct: number | null = Math.round(e.p * 100);
  if (e.p === 0 || e.p === 1) {
    if (e.k === 0) notes.push(`0 wins in ${e.J}: 95% upper bound ${Math.ceil(zeroWinsUpperBound(e.J, alpha) * 100)}%`);
  } else if (e.J < tailMinimumJ(e.p, alpha)) {
    midPct = null;
    notes.push(`a ${Math.round(Math.min(e.p, 1 - e.p) * 100)}% tail needs at least ${tailMinimumJ(e.p, alpha)} lettings; only the range is shown`);
  }
  if (e.model === 'friedman' || e.model === 'gates') notes.push('a model output, not a confidence limit; with correlated bids the truth can sit above both Friedman and Gates');
  if (e.model === 'kernel') notes.push('smoothing does not reduce uncertainty; compare with the raw step curve');
  const mid = midPct === null ? '' : `about ${midPct}%, `;
  const text = `Win chance ${mid}range ${lowPct}% to ${highPct}% (${MODEL_NAMES[e.model]}, ${e.J} comparable lettings: ${e.referenceClass}).`;
  return { kind: 'estimate', model: e.model, J: e.J, referenceClass: e.referenceClass, lowPct, midPct, highPct, text, notes };
}

/** Friedman and Gates side by side as two model outputs, never as low and high limits (spec 7.4, 12.1 rule 2). */
export function presentModelPair(friedmanEst: WinEstimate | NotEnoughData, gatesEst: WinEstimate | NotEnoughData): { friedman: WinDisplay; gates: WinDisplay; note: string } {
  return {
    friedman: presentWinProbability(friedmanEst),
    gates: presentWinProbability(gatesEst),
    note: 'Two models, not a confidence range: under positively correlated bids the true chance lies between the product of the p_i and the smallest p_i, and can exceed both.',
  };
}
