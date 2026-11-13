// Retainage, payment timing, late-payment interest, retainage financing, liquidated damages
// (spec 4.5 to 4.9). Every statutory percentage, lag and cap is a dated input (RetainageRule,
// PaymentTimingPreset); the defaults module ships the spec 8.5 values. Bid documents override presets.
// Pure functions; money in integer cents; BigInt intermediates; one half-up rounding per stated point.

import {
  assertCents,
  assertInt,
  assertPpm,
  divRoundHalfUp,
  mulRate,
  ratio,
  refuse,
  toCents,
  type Cents,
  type Ppm,
  type Ratio,
} from './money.js';
import type { AssumptionUsed } from './types.js';
import type { LegalSource } from './bonds.js';

const M6 = 1_000_000n;

// ---------------------------------------------------------------- spec 4.5 retainage

/** One retainage preset or bid-document rule (spec 4.5 table). */
export interface RetainageRule {
  readonly id: string;
  /** rho1: rate on billings up to theta*C. */
  readonly rho1Ppm: Ppm;
  /** theta: switch point as a share of C. null = no switch (rho1 applies throughout). */
  readonly thetaPpm: Ppm | null;
  /** rho2: rate on billings above theta*C. */
  readonly rho2Ppm: Ppm;
  /** kappa: cap on gross withheld as a share of C. null = none. */
  readonly kappaPpm: Ppm | null;
  /** Dollar cap on gross withheld. null = none. capTotal = min(kappa*C, dollarCap). */
  readonly dollarCap: Cents | null;
  /** Nevada base case: before withholding above theta, pay 50% of the retainage withheld so far. */
  readonly halfRelease: boolean;
  readonly source?: LegalSource;
}

export interface RetainageRow {
  readonly j: number; // 1-based billing number
  readonly B: Cents; // gross approved progress billing
  readonly Ebefore: Cents; // cumulative billed before this billing
  readonly below: Cents;
  readonly above: Cents;
  readonly W: Cents; // withheld from this billing (after the cap)
  readonly Rel: Cents; // half release paid with this billing
  readonly R: Cents; // retainage held after this billing
  readonly grossWithheld: Cents; // cumulative gross withheld (a release never reopens room under a cap)
  readonly otherDeductions: Cents;
  readonly pay: Cents; // Pay_j = B_j - W_j - otherDeductions_j
}

export interface RetainageSchedule {
  readonly rows: readonly RetainageRow[];
  readonly thetaC: Cents | null;
  readonly capTotal: Cents | null;
  readonly totalWithheld: Cents;
  readonly totalHalfReleased: Cents;
  /** Retainage still held after the last billing: released at closeout. */
  readonly heldAtEnd: Cents;
  readonly assumptions: readonly AssumptionUsed[];
}

/** A-22: a billing that crosses the switch point is split pro rata; the half release comes with the first payment after it. */
export const A22_CROSSING_SPLIT: AssumptionUsed = {
  id: 'A-22',
  text: 'Cost-proportional schedule of values; a billing that crosses the 50% point is split pro rata; the Nevada half release arrives with the first payment after 50%',
  value: 'as stated',
};

export function validateRetainageRule(r: RetainageRule): void {
  assertPpm(r.rho1Ppm, 'rho1', 0, 1_000_000);
  assertPpm(r.rho2Ppm, 'rho2', 0, 1_000_000);
  if (r.thetaPpm !== null) assertPpm(r.thetaPpm, 'theta', 0, 1_000_000);
  if (r.kappaPpm !== null) assertPpm(r.kappaPpm, 'kappa', 0, 1_000_000);
  if (r.dollarCap !== null) assertCents(r.dollarCap, 'retainage dollar cap');
  if (r.halfRelease && r.thetaPpm === null) refuse('BAD_TABLE', 'a half release needs a switch point theta');
}

/**
 * Retainage per gross billing B_j on contract price C (spec 4.5):
 *   below_j = max(0, min(B_j, theta*C - E_{j-1})), above_j = B_j - below_j
 *   W_j = mulRate(below_j, rho1) + mulRate(above_j, rho2), capped by capTotal - grossWithheld_{j-1}
 *   Rel_j = half of the retainage from the first part, once, at the first billing with above_j > 0 and rho2 > 0
 *   R_j = R_{j-1} + W_j - Rel_j;   Pay_j = B_j - W_j - otherDeductions_j
 * theta*C is rounded half-up to the cent once (spec gives no rounding point; see specIssues).
 */
export function retainageSchedule(
  rule: RetainageRule,
  C: Cents,
  billings: readonly Cents[],
  otherDeductions?: readonly Cents[],
): RetainageSchedule {
  validateRetainageRule(rule);
  assertCents(C, 'contract price C');
  if (otherDeductions && otherDeductions.length !== billings.length) refuse('BAD_INPUT', 'otherDeductions must match billings');
  const thetaC = rule.thetaPpm === null ? null : mulRate(C, rule.thetaPpm);
  const caps: number[] = [];
  if (rule.kappaPpm !== null) caps.push(mulRate(C, rule.kappaPpm));
  if (rule.dollarCap !== null) caps.push(rule.dollarCap);
  const capTotal = caps.length ? (Math.min(...caps) as Cents) : null;

  const rows: RetainageRow[] = [];
  let E = 0n, R = 0n, gross = 0n, firstPart = 0n, released = false, totalRel = 0n;
  billings.forEach((b, i) => {
    const B = BigInt(assertCents(b, `billing ${i + 1}`));
    if (E + B > BigInt(C)) refuse('BILLED_OVER_CONTRACT', `cumulative billings exceed the contract price at billing ${i + 1}`);
    const below = thetaC === null ? B : (() => {
      const room = BigInt(thetaC) - E;
      return room <= 0n ? 0n : room < B ? room : B;
    })();
    const above = B - below;
    const wBelow = BigInt(mulRate(toCents(below), rule.rho1Ppm));
    let W = wBelow + BigInt(mulRate(toCents(above), rule.rho2Ppm));
    if (capTotal !== null) {
      const room = BigInt(capTotal) - gross;
      W = W < (room > 0n ? room : 0n) ? W : room > 0n ? room : 0n;
    }
    // Retainage on the first part (before the switch point), as actually withheld.
    firstPart += W < wBelow ? W : wBelow;
    let Rel = 0n;
    if (rule.halfRelease && !released && above > 0n && rule.rho2Ppm > 0) {
      Rel = divRoundHalfUp(firstPart, 2n);
      released = true;
    }
    gross += W;
    R = R + W - Rel;
    totalRel += Rel;
    const other = BigInt(otherDeductions ? assertCents(otherDeductions[i]!, `other deductions ${i + 1}`) : 0);
    const pay = B - W - other;
    if (pay < 0n) refuse('NEGATIVE', `payment ${i + 1} would be negative`);
    rows.push({
      j: i + 1,
      B: toCents(B),
      Ebefore: toCents(E),
      below: toCents(below),
      above: toCents(above),
      W: toCents(W),
      Rel: toCents(Rel),
      R: toCents(R, 'retainage held'),
      grossWithheld: toCents(gross),
      otherDeductions: toCents(other),
      pay: toCents(pay),
    });
    E += B;
  });
  return {
    rows,
    thetaC,
    capTotal,
    totalWithheld: toCents(gross),
    totalHalfReleased: toCents(totalRel),
    heldAtEnd: toCents(R),
    assumptions: thetaC !== null ? [A22_CROSSING_SPLIT] : [],
  };
}

// ---------------------------------------------------------------- spec 4.6 payment timing presets

/** A payment timing preset (spec 4.6). Deadlines are maximums for a proper, undisputed request. */
export interface PaymentTimingPreset {
  readonly id: string;
  /** Billing cycle: 'monthly' (federal default, D-44), 'per_contract', or a day count from the bid documents. */
  readonly billingCycle: 'monthly' | 'per_contract' | number;
  /** L_pay: progress payment due this many days after the request. */
  readonly payLagDays: number;
  /** L_rel: retainage released this many days after completion / approval; null = per contract (must be entered). */
  readonly retainageReleaseLagDays: number | null;
  /** L_sub: pay subcontractors within this many days of receipt. */
  readonly subPayLagDays: number;
  readonly source: LegalSource;
}

/** A-28: owner-payment stress cases, shown next to every base case. */
export const A28_OWNER_LAG_STRESS_DAYS: readonly number[] = [30, 60];
export const A28_STRESS: AssumptionUsed = {
  id: 'A-28',
  text: 'Owner-payment stress cases (legal deadlines are maximums; real waits run longer)',
  value: '+30 and +60 days',
};

/** Due day of a progress payment: billDay + L_pay (+ a stress delay). Never planning on interest (spec 12.1 #11). */
export function progressPaymentDay(preset: PaymentTimingPreset, billDay: number, stressDays = 0): number {
  assertInt(preset.payLagDays, 'L_pay');
  assertInt(billDay, 'bill day');
  assertInt(stressDays, 'stress days');
  return billDay + preset.payLagDays + stressDays;
}

// ---------------------------------------------------------------- spec 4.7 late-payment interest (an upside)

/**
 * Federal Prompt Payment interest (spec 4.7):  I = P*(1 + r/12)^n * (1 + r/360*d) - P, rounded once.
 * n whole months, d remaining days. With n = 0 this is the simple form P*r*d/360 (up to 30 days late).
 * r = the Treasury rate in effect the day after the due date (locked): an input.
 */
export function federalLatePaymentInterest(P: Cents, ratePpm: Ppm, wholeMonths: number, days: number): { interest: Cents; exact: Ratio } {
  assertCents(P, 'principal');
  assertPpm(ratePpm, 'Treasury rate', 0, 1_000_000);
  assertInt(wholeMonths, 'whole months');
  assertInt(days, 'remaining days');
  if (wholeMonths === 0 && days > 30) refuse('OUT_OF_RANGE', 'more than 30 days late: split into whole months and remaining days');
  const r = BigInt(ratePpm);
  const den = (12n * M6) ** BigInt(wholeMonths) * 360n * M6;
  const num = BigInt(P) * (12n * M6 + r) ** BigInt(wholeMonths) * (360n * M6 + r * BigInt(days)) - BigInt(P) * den;
  return { interest: toCents(divRoundHalfUp(num, den), 'late interest'), exact: ratio(num, den) };
}

/** Simple interest P * rate * days / basis, rounded once (California progress payment: 10% a year, basis A-30). */
export function simpleInterest(P: Cents, annualRatePpm: Ppm, days: number, dayCountBasis: 360 | 365): { interest: Cents; exact: Ratio } {
  assertCents(P, 'principal');
  assertPpm(annualRatePpm, 'annual rate', 0, 1_000_000);
  assertInt(days, 'days');
  if (dayCountBasis !== 360 && dayCountBasis !== 365) refuse('OUT_OF_RANGE', 'day-count basis must be 360 or 365');
  const num = BigInt(P) * BigInt(annualRatePpm) * BigInt(days), den = M6 * BigInt(dayCountBasis);
  return { interest: toCents(divRoundHalfUp(num, den), 'interest'), exact: ratio(num, den) };
}

/** A-30: California late interest on a 365-day basis; federal 14-day period extendable by contract; Nevada release per contract. */
export const A30_TIMING: AssumptionUsed = {
  id: 'A-30',
  text: 'Timing details not read: California late interest on a 365-day basis; Nevada retainage release per contract; federal 14-day period can be lengthened by contract',
  value: 'as stated',
};

/** California retention late charge = monthlyRate * P * monthsLate (spec 4.7; 2% per month in D-53), rounded once. */
export function californiaRetentionCharge(P: Cents, monthlyRatePpm: Ppm, monthsLate: number): Cents {
  assertCents(P, 'principal');
  assertPpm(monthlyRatePpm, 'monthly rate', 0, 1_000_000);
  assertInt(monthsLate, 'months late');
  return toCents(divRoundHalfUp(BigInt(P) * BigInt(monthlyRatePpm) * BigInt(monthsLate), M6), 'retention charge');
}

// ---------------------------------------------------------------- spec 4.8 financing cost of retainage

/**
 * simple: FC = sum_j W_j * i * (t_release - tau_j) / basis  -  interest the owner pays on retainage.
 * tau_j = day the withheld money would otherwise have arrived. Rounded once (the gross), credit subtracted.
 */
export function retainageFinancingCost(args: {
  readonly withheld: readonly { readonly W: Cents; readonly tauDay: number }[];
  readonly releaseDay: number;
  readonly annualRatePpm: Ppm;
  readonly dayCountBasis: 360 | 365;
  /** Interest the owner pays on retainage (Nevada pays quarterly at a bank rate): an inflow, entered when known. */
  readonly ownerInterestCredit?: Cents;
}): { gross: Cents; grossExact: Ratio; credit: Cents; net: number } {
  assertPpm(args.annualRatePpm, 'i', 0, 1_000_000);
  assertInt(args.releaseDay, 'release day');
  if (args.dayCountBasis !== 360 && args.dayCountBasis !== 365) refuse('OUT_OF_RANGE', 'day-count basis must be 360 or 365');
  let dollarDays = 0n;
  args.withheld.forEach((w, j) => {
    assertCents(w.W, `W_${j + 1}`);
    assertInt(w.tauDay, `tau_${j + 1}`);
    if (w.tauDay > args.releaseDay) refuse('BAD_INPUT', `retainage ${j + 1} would be released before it was withheld`);
    dollarDays += BigInt(w.W) * BigInt(args.releaseDay - w.tauDay);
  });
  const num = dollarDays * BigInt(args.annualRatePpm), den = M6 * BigInt(args.dayCountBasis);
  const gross = toCents(divRoundHalfUp(num, den), 'retainage financing');
  const credit = args.ownerInterestCredit === undefined ? (0 as Cents) : assertCents(args.ownerInterestCredit, 'owner interest');
  return { gross, grossExact: ratio(num, den), credit, net: gross - credit };
}

/**
 * Uniform case (spec 4.8): FC = rho * C * i * ((T - 1) * Delta/2 + L) / basis, exact.
 * T equal billings every Delta days; release L days after the last progress receipt.
 */
export function retainageFinancingUniform(args: {
  readonly rhoPpm: Ppm;
  readonly C: Cents;
  readonly annualRatePpm: Ppm;
  readonly T: number;
  readonly deltaDays: number;
  readonly releaseLagDays: number;
  readonly dayCountBasis: 360 | 365;
}): Ratio {
  assertPpm(args.rhoPpm, 'rho', 0, 1_000_000);
  assertCents(args.C, 'C');
  assertPpm(args.annualRatePpm, 'i', 0, 1_000_000);
  assertInt(args.T, 'T', 1);
  assertInt(args.deltaDays, 'Delta');
  assertInt(args.releaseLagDays, 'L');
  // (T-1)*Delta/2 + L = ((T-1)*Delta + 2L)/2
  const num = BigInt(args.rhoPpm) * BigInt(args.C) * BigInt(args.annualRatePpm) * (BigInt(args.T - 1) * BigInt(args.deltaDays) + 2n * BigInt(args.releaseLagDays));
  return ratio(num, M6 * M6 * 2n * BigInt(args.dayCountBasis));
}

// ---------------------------------------------------------------- spec 4.9 liquidated damages

/** LD = lambda * max(0, D_actual - D_allowed). lambda from the contract; no statutory default anywhere. */
export function liquidatedDamages(perDay: Cents, actualDays: number, allowedDays: number): Cents {
  assertCents(perDay, 'liquidated damages per day');
  assertInt(actualDays, 'actual days');
  assertInt(allowedDays, 'allowed days');
  return toCents(BigInt(perDay) * BigInt(Math.max(0, actualDays - allowedDays)), 'liquidated damages');
}
