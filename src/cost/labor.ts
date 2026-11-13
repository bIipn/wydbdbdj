// Labor hours, overtime buckets and cash wages (spec 2.1, 2.2).
// Pay rates can end in half a cent (1.5 x an odd cent amount), so they are carried as exact
// "half-cents per hour" integers and rounded ONCE at each wage-bucket extension (spec 0.3).

import {
  refuse,
  allocate,
  divRound,
  toCents,
  assertCents,
  assertInt,
  assertHours,
  type Cents,
  type HoursC,
  type QtyM,
  type MicroHours,
  type Ppm,
  type RoundingMode,
} from './money.js';
import { validateTask, type LaborClassInput, type LaborTask, type OtRegime } from './types.js';

// ---------------------------------------------------------------- spec 2.1 hours from takeoff

/** A-31: productivity factor 1.00 when the contractor gives none (labelled by the caller). */
export const A31_DEFAULT_PRODUCTIVITY_PPM = 1_000_000 as Ppm;

/** H_task = divRoundHalfUp(Q * u * pf, 10^13): QtyM * MicroHours * Ppm -> HoursC (spec 2.1). */
export function taskHours(q: QtyM, u: MicroHours, pf: Ppm = A31_DEFAULT_PRODUCTIVITY_PPM): HoursC {
  assertInt(q, 'quantity');
  assertInt(u, 'labor unit', 1);
  assertInt(pf, 'productivity factor', 500_000, 5_000_000);
  return toCents(divRound(BigInt(q) * BigInt(u) * BigInt(pf), 10_000_000_000_000n), 'task hours') as number as HoursC;
}

/**
 * H_class = sum over tasks of H_task * n_class / n_crew (spec 2.1). The spec gives no rounding point
 * for the crew split; we split each task's hours by largest remainder so the classes add up to the
 * task's hours exactly (no hour created or lost).
 */
export function classHoursFromTasks(tasks: readonly LaborTask[]): Record<string, HoursC> {
  const out: Record<string, number> = {};
  for (const t of tasks) {
    validateTask(t);
    const H = taskHours(t.quantity, t.laborUnit, t.productivityPpm ?? A31_DEFAULT_PRODUCTIVITY_PPM);
    const ids = Object.keys(t.crew);
    const parts = allocate(H as number as Cents, ids.map((id) => t.crew[id]!));
    ids.forEach((id, i) => {
      out[id] = (out[id] ?? 0) + parts[i]!;
    });
  }
  for (const id of Object.keys(out)) assertHours(out[id]!, `class ${id} hours`);
  return out as Record<string, HoursC>;
}

// ---------------------------------------------------------------- spec 2.2 partition helper

export interface Buckets {
  readonly h10: HoursC;
  readonly h15: HoursC;
  readonly h20: HoursC;
}

export interface PartitionOptions {
  /** NV_PRIVATE only: daily overtime applies (see nvPrivateDailyOvertimeApplies). */
  readonly dailyOvertime?: boolean;
  /** An agreed 4x10 schedule (Nevada): daily threshold 10 h instead of 8. */
  readonly fourTens?: boolean;
}

const H8 = 800, H10 = 1000, H12 = 1200, H40 = 4000;

/**
 * Nevada private work: daily overtime only if the regular rate is below 1.5 x the minimum wage,
 * and not on an agreed 4x10 schedule (D-24, D-28). The minimum wage is an input from the dated table.
 */
export function nvPrivateDailyOvertimeApplies(regularRate: Cents, minimumWage: Cents, agreedFourTens: boolean): boolean {
  assertCents(regularRate, 'regular rate');
  assertCents(minimumWage, 'minimum wage');
  return !agreedFourTens && 2 * regularRate < 3 * minimumWage;
}

/**
 * partitionHours(regime, hoursByDay[7]) -> {h10, h15, h20} for one fixed workweek (day 0 = first day of
 * the employer's workweek). Buckets always sum to hours worked; no hour is counted twice (invariant 33).
 * Weekly overtime converts the straight hours past 40, so daily and weekly overtime never pyramid.
 */
export function partitionHours(regime: OtRegime, hoursByDay: readonly number[], opts: PartitionOptions = {}): Buckets {
  if (hoursByDay.length !== 7) refuse('BAD_INPUT', 'hoursByDay must have 7 entries');
  const d = hoursByDay.map((h, i) => assertHours(h, `day ${i} hours`, 2400) as number);
  let h10 = 0, h15 = 0, h20 = 0;
  const weeklyOnly = (): void => {
    const T = d.reduce((a, b) => a + b, 0);
    h15 = Math.max(0, T - H40);
    h10 = T - h15;
  };
  const dailyAndWeekly = (threshold: number): void => {
    let straight = 0;
    for (const h of d) {
      straight += Math.min(h, threshold);
      h15 += Math.max(0, h - threshold);
    }
    const weeklyOt = Math.max(0, straight - H40);
    h10 = straight - weeklyOt;
    h15 += weeklyOt;
  };
  switch (regime) {
    case 'FLSA':
    case 'DAVIS_BACON':
      weeklyOnly();
      break;
    case 'NV_PRIVATE':
      if (opts.dailyOvertime) dailyAndWeekly(opts.fourTens ? H10 : H8);
      else weeklyOnly();
      break;
    case 'NV_PUBLIC':
      dailyAndWeekly(opts.fourTens ? H10 : H8);
      break;
    case 'CA_PUBLIC':
      dailyAndWeekly(H8);
      break;
    case 'CA_PRIVATE': {
      // D-22: 1.5x over 8/day, over 40/week, first 8 h of the 7th consecutive workday; 2x over 12/day and over 8 on that day.
      const seventh = d.every((h) => h > 0);
      let straight = 0;
      d.forEach((h, i) => {
        if (seventh && i === 6) {
          h15 += Math.min(h, H8);
          h20 += Math.max(0, h - H8);
        } else {
          straight += Math.min(h, H8);
          h15 += Math.min(Math.max(0, h - H8), H12 - H8);
          h20 += Math.max(0, h - H12);
        }
      });
      const weeklyOt = Math.max(0, straight - H40);
      h10 = straight - weeklyOt;
      h15 += weeklyOt;
      break;
    }
    default:
      refuse('BAD_INPUT', `unknown overtime regime ${String(regime)}`);
  }
  return { h10: h10 as HoursC, h15: h15 as HoursC, h20: h20 as HoursC };
}

// ---------------------------------------------------------------- spec 2.2 pay per bucket

/** Hourly pay per bucket in exact half-cents (2 x cents). pay20 is null where the regime has no 2x rule. */
export interface BucketPay {
  readonly pay10HalfCents: number;
  readonly pay15HalfCents: number;
  readonly pay20HalfCents: number | null;
  /** Davis-Bacon basic rate actually used for the half-time premium (cents/h), else null. */
  readonly basicRate: Cents | null;
  /** Governing-law label (Davis-Bacon: CWHSSA vs FLSA by contract size; same arithmetic). */
  readonly note?: string;
}

/**
 * Cash paid for one hour in each bucket (spec 2.2 table). Minimums only: the determination's footnotes
 * override (pass class.pay20 for double time outside California private work).
 */
export function bucketPay(regime: OtRegime, c: LaborClassInput): BucketPay {
  const wTax = c.wBasic + c.wCil;
  const two = (x: number): number => 2 * x;
  const p20Override = c.pay20 !== undefined ? two(c.pay20) : null;
  const pw = c.prevailing;
  switch (regime) {
    case 'FLSA':
    case 'NV_PRIVATE':
      return { pay10HalfCents: two(wTax), pay15HalfCents: 3 * wTax, pay20HalfCents: p20Override, basicRate: null };
    case 'CA_PRIVATE':
      return { pay10HalfCents: two(wTax), pay15HalfCents: 3 * wTax, pay20HalfCents: p20Override ?? 4 * wTax, basicRate: null };
    case 'NV_PUBLIC': {
      // 1.5 x (w_basic + w_cil + f_plan) - f_plan: the multiplier is on base plus fringe (D-25).
      const pay15x2 = 3 * (wTax + c.fPlan) - two(c.fPlan);
      return { pay10HalfCents: two(wTax), pay15HalfCents: pay15x2, pay20HalfCents: p20Override, basicRate: null };
    }
    case 'CA_PUBLIC': {
      if (!pw) return refuse('MISSING_INPUT', `class ${c.id}: CA_PUBLIC needs BHR_wd`);
      const basic = Math.max(pw.bhrWd, c.wBasic);
      return { pay10HalfCents: two(wTax), pay15HalfCents: 3 * basic + two(c.wCil), pay20HalfCents: p20Override, basicRate: null };
    }
    case 'DAVIS_BACON': {
      if (!pw) return refuse('MISSING_INPUT', `class ${c.id}: DAVIS_BACON needs BHR_wd`);
      const basic = pw.cashInLieuCountsAsBasic ? wTax : Math.max(pw.bhrWd, c.wBasic);
      return {
        pay10HalfCents: two(wTax),
        pay15HalfCents: two(wTax) + basic,
        pay20HalfCents: p20Override,
        basicRate: basic as Cents,
      };
    }
    default:
      return refuse('BAD_INPUT', `unknown overtime regime ${String(regime)}`);
  }
}

/** Governing overtime law on a Davis-Bacon job (D-27): CWHSSA only above the contract line. Same dollars. */
export function davisBaconOvertimeLaw(contractAmount: Cents, cwhssaThreshold: Cents): 'CWHSSA' | 'FLSA' {
  assertCents(contractAmount, 'contract amount');
  assertCents(cwhssaThreshold, 'CWHSSA threshold');
  return contractAmount > cwhssaThreshold ? 'CWHSSA' : 'FLSA';
}

const ext2 = (h: number, halfCents: number, mode: RoundingMode): Cents =>
  toCents(divRound(BigInt(h) * BigInt(halfCents), 200n, mode), 'wage bucket');

export interface ClassWages {
  readonly pay: BucketPay;
  readonly wage10: Cents; // mulHours(h10, pay_10), rounded once
  readonly wage15: Cents;
  readonly wage20: Cents;
  readonly G: Cents; // cash wages
  readonly otPremium: Cents; // OTprem_k
  readonly H: HoursC; // h10 + h15 + h20
}

/** G_k, OTprem_k, H_k (spec 2.2). Each bucket extension rounded once, half-up. */
export function classWages(regime: OtRegime, c: LaborClassInput, mode: RoundingMode = 'half-up'): ClassWages {
  const pay = bucketPay(regime, c);
  if (c.h20 > 0 && pay.pay20HalfCents === null)
    refuse('MISSING_INPUT', `class ${c.id}: ${regime} has no statutory 2x rate; enter pay20 from the determination`);
  const p20 = pay.pay20HalfCents ?? 0;
  if (pay.pay15HalfCents < pay.pay10HalfCents || p20 < (c.h20 > 0 ? pay.pay10HalfCents : 0))
    refuse('OUT_OF_RANGE', `class ${c.id}: an overtime rate is below the straight rate`);
  const wage10 = ext2(c.h10, pay.pay10HalfCents, mode);
  const wage15 = ext2(c.h15, pay.pay15HalfCents, mode);
  const wage20 = ext2(c.h20, p20, mode);
  const G = toCents(BigInt(wage10) + BigInt(wage15) + BigInt(wage20), 'G');
  const prem15 = ext2(c.h15, pay.pay15HalfCents - pay.pay10HalfCents, mode);
  const prem20 = c.h20 > 0 ? ext2(c.h20, p20 - pay.pay10HalfCents, mode) : (0 as Cents);
  const otPremium = toCents(BigInt(prem15) + BigInt(prem20), 'OT premium');
  const H = assertHours(c.h10 + c.h15 + c.h20, `class ${c.id} H`);
  return { pay, wage10, wage15, wage20, G, otPremium, H };
}

// ---------------------------------------------------------------- spec 2.2 prevailing-wage compliance

export interface PrevailingWageResult {
  readonly ok: boolean;
  /** Plan credit per hour as an exact fraction of cents. */
  readonly planCreditNum: bigint;
  readonly planCreditDen: bigint;
  /** Shortfall per hour in cents, rounded up so a shortfall never shows as 0. 0 when ok. */
  readonly shortfallPerHour: Cents;
  readonly required: Cents; // BHR_wd + FB_wd
}

/**
 * w_basic + w_cil + planCredit >= BHR_wd + FB_wd, on every hour including overtime hours (MUST, law).
 * planCredit (annualized) = annual plan cost / all hours worked that year; plans with annualize = false
 * credit their hourly rate. Without a plan list the credit is f_plan. Payroll taxes and workers' comp
 * are never creditable. Compared in exact fractions.
 */
export function prevailingWageCheck(c: LaborClassInput): PrevailingWageResult {
  const pw = c.prevailing;
  if (!pw) return refuse('MISSING_INPUT', `class ${c.id}: no wage determination to check against`);
  let num = 0n, den = 1n;
  const add = (n: bigint, d: bigint): void => {
    num = num * d + n * den;
    den = den * d;
  };
  if (pw.plans && pw.plans.length) {
    for (const p of pw.plans) {
      if (p.annualize) add(BigInt(p.annualCost ?? 0) * 100n, BigInt(p.annualHours ?? 1)); // HoursC -> x100
      else add(BigInt(p.ratePerHour), 1n);
    }
  } else add(BigInt(c.fPlan), 1n);
  const required = pw.bhrWd + pw.fbWd;
  const paid = (BigInt(c.wBasic) + BigInt(c.wCil)) * den + num; // over den
  const need = BigInt(required) * den;
  const ok = paid >= need;
  const short = ok ? 0n : (need - paid + den - 1n) / den;
  return { ok, planCreditNum: num, planCreditDen: den, shortfallPerHour: toCents(short), required: required as Cents };
}

/** California electrical dual-wage class (D-14): regular hourly wage >= threshold -> 5140, else 5190. */
export function caElectricalClass(regularHourlyWage: Cents, threshold: Cents): '5140' | '5190' {
  assertCents(regularHourlyWage, 'regular hourly wage');
  assertCents(threshold, 'class threshold');
  return regularHourlyWage >= threshold ? '5140' : '5190';
}

/** Davis-Bacon week, spec invariant 35: H*(BHR+FB) + 0.5*basicRate*max(0, H-40), in cents (HoursC in). */
export function davisBaconWeekPay(H: HoursC, bhr: Cents, fb: Cents, basicRate: Cents): Cents {
  assertHours(H);
  const base = BigInt(H) * BigInt(bhr + fb) * 2n;
  const prem = BigInt(Math.max(0, H - H40)) * BigInt(basicRate);
  return toCents(divRound(base + prem, 200n), 'week pay');
}
