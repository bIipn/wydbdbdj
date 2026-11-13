// Identities and conversions (spec section 3), in exact fractions (Ratio). Floats never enter here;
// convert to ppm or cents once, at the edge, with rToPpm / rRound.

import {
  refuse,
  ratio,
  rAdd,
  rSub,
  rMul,
  rDiv,
  rCmp,
  fromPpm,
  assertCents,
  assertPpm,
  assertInt,
  type Cents,
  type Ppm,
  type HoursC,
  type Ratio,
} from './money.js';
import { grossUp } from './buildup.js';
import type { PriceChargesInput } from './types.js';

const ONE = ratio(1n);
const ZERO = ratio(0n);

// ---------------------------------------------------------------- 3.1 markup versus margin

/** markup k = (P - C)/C. C > 0. */
export function markupFromCostPrice(C: Cents, P: Cents): Ratio {
  assertCents(C, 'cost');
  assertCents(P, 'price');
  if (C <= 0) refuse('BAD_DIVISOR', 'cost must be > 0');
  return ratio(BigInt(P) - BigInt(C), BigInt(C));
}
/** margin m = (P - C)/P. P > 0. */
export function marginFromCostPrice(C: Cents, P: Cents): Ratio {
  assertCents(C, 'cost');
  assertCents(P, 'price');
  if (P <= 0) refuse('BAD_DIVISOR', 'price must be > 0');
  return ratio(BigInt(P) - BigInt(C), BigInt(P));
}
/** m = k/(1 + k). Requires k > -1. */
export function markupToMargin(k: Ratio): Ratio {
  const d = rAdd(ONE, k);
  if (rCmp(d, ZERO) <= 0) refuse('OUT_OF_RANGE', 'markup must be > -100%');
  return rDiv(k, d);
}
/** k = m/(1 - m). Requires m < 1. */
export function marginToMarkup(m: Ratio): Ratio {
  const d = rSub(ONE, m);
  if (rCmp(d, ZERO) <= 0) refuse('OUT_OF_RANGE', 'margin must be < 100%');
  return rDiv(m, d);
}
/** P = C*(1 + k), exact. */
export const priceFromMarkup = (C: Cents, k: Ratio): Ratio => rMul(ratio(BigInt(assertCents(C))), rAdd(ONE, k));
/** P = C/(1 - m), exact. */
export function priceFromMargin(C: Cents, m: Ratio): Ratio {
  const d = rSub(ONE, m);
  if (rCmp(d, ZERO) <= 0) refuse('OUT_OF_RANGE', 'margin must be < 100%');
  return rDiv(ratio(BigInt(assertCents(C))), d);
}

// ---------------------------------------------------------------- 3.2 multiplicative stack

/** prod (1 + r_i) for ppm rates; independent of order. */
export function stackMultipliers(rates: readonly Ppm[]): Ratio {
  return rates.reduce<Ratio>((acc, r) => rMul(acc, rAdd(ONE, fromPpm(assertPpm(r)))), ONE);
}
/** Additive stacking under-prices by TJC*o*p (exact). */
export function additiveStackShortfall(TJC: Cents, o: Ppm, p: Ppm): Ratio {
  return rMul(ratio(BigInt(assertCents(TJC))), rMul(fromPpm(assertPpm(o)), fromPpm(assertPpm(p))));
}

// ---------------------------------------------------------------- 3.3 revenue basis to cost basis

/** o_c = o_s/(1 - o_s - m_s), p_c = m_s/(1 - m_s); requires o_s + m_s < 1. */
export function salesBasisToCostBasis(os: Ppm, ms: Ppm): { oc: Ratio; pc: Ratio; multiplier: Ratio } {
  const o = fromPpm(assertPpm(os)), m = fromPpm(assertPpm(ms));
  const d = rSub(rSub(ONE, o), m);
  if (rCmp(d, ZERO) <= 0) refuse('OUT_OF_RANGE', 'o_s + m_s must be below 100%');
  const dm = rSub(ONE, m);
  return { oc: rDiv(o, d), pc: rDiv(m, dm), multiplier: rDiv(ONE, d) };
}
/** Inverse: o_s = o_c/((1+o_c)(1+p_c)), m_s = p_c/(1+p_c). */
export function costBasisToSalesBasis(oc: Ratio, pc: Ratio): { os: Ratio; ms: Ratio } {
  if (rCmp(oc, ZERO) < 0 || rCmp(pc, ZERO) < 0) refuse('NEGATIVE', 'rates must be >= 0');
  const a = rAdd(ONE, oc), b = rAdd(ONE, pc);
  return { os: rDiv(oc, rMul(a, b)), ms: rDiv(pc, b) };
}

// ---------------------------------------------------------------- 3.4 overhead recovery

/** Pricing every job at OH_annual/DC_plan recovers OH_annual * DC_actual / DC_plan (exact). */
export function overheadRecovery(OHannual: Cents, DCplan: Cents, DCactual: Cents): Ratio {
  assertCents(OHannual, 'OH_annual');
  assertCents(DCactual, 'DC_actual');
  if (assertCents(DCplan, 'DC_plan') <= 0) refuse('BAD_DIVISOR', 'DC_plan must be > 0');
  return ratio(BigInt(OHannual) * BigInt(DCactual), BigInt(DCplan));
}
/** oh_per_hour = OH_annual / LH_annual, cents per hour (LH in HoursC). */
export function laborHourOverheadRate(OHannual: Cents, LHannual: HoursC): Ratio {
  assertCents(OHannual, 'OH_annual');
  assertInt(LHannual, 'LH_annual', 1);
  return ratio(BigInt(OHannual) * 100n, BigInt(LHannual));
}
/** Dual rate: r_M = OH/(X*L_a + MS_a), r_L = X*r_M; r_L*L_a + r_M*MS_a = OH exactly. X > 1. */
export function dualOverheadRates(OHannual: Cents, Lannual: Cents, MSannual: Cents, X: Ratio): { rL: Ratio; rM: Ratio } {
  assertCents(OHannual, 'OH_annual');
  assertCents(Lannual, 'L_annual');
  assertCents(MSannual, 'MS_annual');
  if (rCmp(X, ONE) <= 0) refuse('OUT_OF_RANGE', 'X must be > 1');
  const D = rAdd(rMul(X, ratio(BigInt(Lannual))), ratio(BigInt(MSannual)));
  if (rCmp(D, ZERO) <= 0) refuse('BAD_DIVISOR', 'X*L_annual + MS_annual must be > 0');
  const rM = rDiv(ratio(BigInt(OHannual)), D);
  return { rL: rMul(X, rM), rM };
}
/** (contract billings / total billings) * total home-office overhead / days of performance (cents per day). */
export function dailyOfficeOverhead(contractBillings: Cents, totalBillings: Cents, totalOverhead: Cents, daysOfPerformance: number): Ratio {
  assertCents(contractBillings, 'contract billings');
  assertCents(totalOverhead, 'total overhead');
  if (assertCents(totalBillings, 'total billings') <= 0) refuse('BAD_DIVISOR', 'total billings must be > 0');
  assertInt(daysOfPerformance, 'days of performance', 1);
  return ratio(BigInt(contractBillings) * BigInt(totalOverhead), BigInt(totalBillings) * BigInt(daysOfPerformance));
}

// ---------------------------------------------------------------- 3.5 break-even

/** BE_units = FC / (price_u - vc_u); requires price_u > vc_u. */
export function breakEvenUnits(FC: Cents, priceU: Cents, vcU: Cents): Ratio {
  assertCents(FC, 'fixed cost');
  if (assertCents(priceU, 'unit price') <= assertCents(vcU, 'unit variable cost')) refuse('OUT_OF_RANGE', 'unit price must exceed unit variable cost');
  return ratio(BigInt(FC), BigInt(priceU) - BigInt(vcU));
}
/** BE_revenue = OH_annual / (1 - DC_annual/Sales_annual); requires DC_annual < Sales_annual. */
export function breakEvenRevenue(OHannual: Cents, DCannual: Cents, SalesAnnual: Cents): Ratio {
  assertCents(OHannual, 'OH_annual');
  assertCents(DCannual, 'DC_annual');
  assertCents(SalesAnnual, 'Sales_annual');
  if (DCannual >= SalesAnnual) refuse('OUT_OF_RANGE', 'gross margin must be positive (DC_annual < Sales_annual)');
  return ratio(BigInt(OHannual) * BigInt(SalesAnnual), BigInt(SalesAnnual) - BigInt(DCannual));
}
/** Profit at revenue R: R*grossMarginRatio - OH_annual (signed, exact). */
export function profitAtRevenue(revenue: Cents, OHannual: Cents, DCannual: Cents, SalesAnnual: Cents): Ratio {
  assertCents(revenue, 'revenue');
  if (assertCents(SalesAnnual, 'Sales_annual') <= 0) refuse('BAD_DIVISOR', 'Sales_annual must be > 0');
  const gm = ratio(BigInt(SalesAnnual) - BigInt(assertCents(DCannual)), BigInt(SalesAnnual));
  return rSub(rMul(ratio(BigInt(revenue)), gm), ratio(BigInt(assertCents(OHannual))));
}
/** This job's break-even price: section 2.13 applied to BE = TJC + OH with PR = FIN = 0. */
export function breakEvenPrice(BE: Cents, charges: PriceChargesInput): Cents {
  return grossUp(BE, charges).P;
}

// ---------------------------------------------------------------- 3.6 overtime premium percent

/** ot = sum_k(OT_hours_k * (mult_k - 1)) / hours worked = (0.5*h15 + 1.0*h20)/H. */
export function overtimePremiumRatio(h15: HoursC, h20: HoursC, hoursWorked: HoursC): Ratio {
  assertInt(h15, 'h15');
  assertInt(h20, 'h20');
  assertInt(hoursWorked, 'hours worked', 1);
  if (h15 + h20 > hoursWorked) refuse('OUT_OF_RANGE', 'overtime hours exceed hours worked');
  return ratio(BigInt(h15) + 2n * BigInt(h20), 2n * BigInt(hoursWorked));
}

// ---------------------------------------------------------------- 3.7 capped tax

/** T(r, B, W) = r*min(W, B), exact cents. */
export function cappedTaxExact(r: Ppm, B: Cents | null, W: Cents): Ratio {
  assertPpm(r);
  assertCents(W, 'W');
  const base = B === null ? W : Math.min(W, assertCents(B, 'wage base'));
  return rMul(fromPpm(r), ratio(BigInt(base)));
}

// ---------------------------------------------------------------- 3.8, 3.9 rounding bounds

/** |sum_i round(r*x_i) - round(r*sum_i x_i)| <= floor(n/2) cents over n lines (spec 3.8). */
export const perLineRoundingBound = (n: number): number => Math.floor(assertInt(n, 'n') / 2);

/**
 * Spec 3.9: |S - S_exact| <= 0.5 * sum_j gain_j. Pass the gains of every rounding operation (exact).
 * Returns the bound in cents as an exact fraction.
 */
export function chainRoundingBound(gains: readonly Ratio[]): Ratio {
  return rMul(ratio(1n, 2n), gains.reduce<Ratio>((a, g) => rAdd(a, g), ZERO));
}
/** |P - P_exact| <= |S - S_exact| / (1 - k_max) + 1 (spec 3.9); k_max as ppm-scaled 10^12 integer. */
export function grossUpRoundingBound(sBound: Ratio, k12: bigint): Ratio {
  const M12 = 1_000_000_000_000n;
  if (k12 >= M12 || k12 < 0n) refuse('OUT_OF_RANGE', 'k_max must be in [0, 1)');
  return rAdd(rDiv(sBound, ratio(M12 - k12, M12)), ONE);
}

/** Productivity / efficiency ratio as in the DoD example: productive minutes over paid minutes (P-7). */
export function productiveRatio(productiveMinutes: number, paidMinutes: number): Ratio {
  assertInt(productiveMinutes, 'productive minutes');
  assertInt(paidMinutes, 'paid minutes', 1);
  return ratio(BigInt(productiveMinutes), BigInt(paidMinutes));
}
