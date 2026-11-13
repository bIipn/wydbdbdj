// Labor burden as a direct cost (spec 2.3) and the direct labor total (spec 2.4).
// Statutory rates and wage bases are INPUT tables (PayrollTaxTable, typed and dated); nothing
// statutory is hard-coded here. Three modes: 'statutory' (annualized caps), 'ytd' (pay period), 'flat'.

import {
  refuse,
  mulRate,
  mulHours,
  cappedShare,
  effRate,
  ytdTaxableSlice,
  divRound,
  divRoundHalfUp,
  toCents,
  toPpm,
  assertCents,
  assertPpm,
  type Cents,
  type Ppm,
  type HoursC,
  type RoundingMode,
} from './money.js';
import {
  validateLaborClass,
  validatePayrollTable,
  type AssumptionUsed,
  type LaborClassInput,
  type LaborInput,
  type Line,
  type MbtInput,
  type PayrollTaxTable,
  type WorkersCompInput,
} from './types.js';
import { classWages, prevailingWageCheck, type ClassWages } from './labor.js';

/** A-8: annual taxable wages W when not entered = 2,000 h x straight-time cash wage. Assumption, editable. */
export const A8_ANNUAL_HOURS = 200_000 as HoursC; // 2,000.00 h

export function defaultAnnualWages(c: LaborClassInput): Cents {
  return mulHours(A8_ANNUAL_HOURS, (c.wBasic + c.wCil) as Cents);
}

// ---------------------------------------------------------------- tables

export function tableFor(input: LaborInput, year: number): PayrollTaxTable {
  const t = input.payrollTables?.[year];
  if (!t) return refuse('MISSING_TABLE', `no payroll table for ${input.stateOfWork} ${year} (never falls back to another year)`);
  validatePayrollTable(t);
  if (t.year !== year) refuse('BAD_TABLE', `payroll table keyed ${year} says year ${t.year}`);
  if (t.state !== input.stateOfWork) refuse('BAD_TABLE', `payroll table is for ${t.state}, job is in ${input.stateOfWork}`);
  return t;
}

/** FUTA net rate + credit reduction (spec 2.3). A missing reduction must be entered (A-9). */
export function futaRatePpm(t: PayrollTaxTable, entered?: Ppm): { rate: Ppm; warning?: string } {
  const cr = entered ?? t.futa.creditReductionPpm;
  if (cr === null || cr === undefined)
    return refuse('MISSING_INPUT', `FUTA credit reduction for ${t.state} ${t.year} is not published: enter it (A-9)`);
  assertPpm(cr, 'FUTA credit reduction', 0, 60_000);
  const rate = toPpm(BigInt(t.futa.netRatePpm) + BigInt(cr));
  const warning =
    entered === undefined && !t.futa.creditReductionFinal
      ? `FUTA credit reduction ${t.state} ${t.year} is not final; ${cr} ppm used (A-9)`
      : undefined;
  return warning ? { rate, warning } : { rate };
}

/** State UI rate + surcharge (Nevada CEP not owed at the 5.4% rate; California ETT), spec 2.3. */
export function stateUiRatePpm(t: PayrollTaxTable, notice: Ppm | undefined): Ppm {
  if (notice === undefined) return refuse('MISSING_INPUT', `state UI rate for ${t.state} not entered (rate notice or labelled new-employer rate)`);
  const s = t.stateUnemployment;
  assertPpm(notice, 'state UI rate', s.ratePpmMin, s.ratePpmMax);
  const surcharge = s.surchargeExemptAtRatePpm !== null && notice === s.surchargeExemptAtRatePpm ? 0 : s.surchargePpm;
  return toPpm(BigInt(notice) + BigInt(surcharge));
}

/** Effective annual rates (display): te_ss, te_med, te_futa, te_suta for a worker with annual wages W. */
export function effectiveRates(t: PayrollTaxTable, W: Cents, uiRate: Ppm, futaRate: Ppm) {
  return {
    ss: effRate(t.socialSecurity.ratePpm, W, t.socialSecurity.wageBase),
    med: t.medicare.ratePpm,
    futa: effRate(futaRate, W, t.futa.wageBase),
    suta: effRate(uiRate, W, t.stateUnemployment.wageBase),
  };
}

// ---------------------------------------------------------------- Nevada MBT (firm-level, quarterly)

/** MBT_q = mulRate(max(0, GW_q - HC_q - exempt), rate): the tax itself (spec 2.3, D-9). */
export function mbtQuarter(m: MbtInput, t: PayrollTaxTable): Cents {
  if (!t.mbt) return refuse('MISSING_TABLE', `no MBT row in the ${t.state} ${t.year} table`);
  assertCents(m.quarterlyGrossWages, 'GW_q');
  assertCents(m.quarterlyHealthDeduction, 'HC_q');
  const base = BigInt(m.quarterlyGrossWages) - BigInt(m.quarterlyHealthDeduction) - BigInt(t.mbt.quarterlyExemptWages);
  return mulRate(toCents(base > 0n ? base : 0n), t.mbt.ratePpm);
}

/** t_mbt: the rate allocated to job wages, by the costing mode (USUALLY). */
export function mbtRatePpm(m: MbtInput, t: PayrollTaxTable): Ppm {
  if (m.mode === 'none') return 0 as Ppm;
  if (!t.mbt) return refuse('MISSING_TABLE', `no MBT row in the ${t.state} ${t.year} table`);
  if (m.mode === 'marginal') {
    return BigInt(m.quarterlyGrossWages) - BigInt(m.quarterlyHealthDeduction) > BigInt(t.mbt.quarterlyExemptWages)
      ? t.mbt.ratePpm
      : (0 as Ppm);
  }
  if (m.quarterlyGrossWages <= 0) return refuse('BAD_DIVISOR', 'MBT average mode needs GW_q > 0');
  return toPpm(divRoundHalfUp(BigInt(mbtQuarter(m, t)) * 1_000_000n, BigInt(m.quarterlyGrossWages)));
}

// ---------------------------------------------------------------- workers' compensation

/**
 * WC_k = divRoundHalfUp(P_wc * R * XMod * mods * min(W_wc, Cap), 10^18 * W_wc), one rounding (spec 2.3).
 * P_wc = G - (excludeOtPremium ? OTprem : 0). Without a cap the share factor is 1.
 */
export function workersComp(
  G: Cents,
  otPremium: Cents,
  ratePpm: Ppm,
  wc: WorkersCompInput,
  annualWcPayroll: Cents,
  mode: RoundingMode = 'half-up',
): { payroll: Cents; premium: Cents } {
  assertPpm(ratePpm, 'WC rate', 0, 1_000_000);
  assertPpm(wc.xModPpm, 'XMod');
  if (wc.xModPpm <= 0) refuse('OUT_OF_RANGE', 'XMod must be > 0');
  assertPpm(wc.otherModsPpm, 'WC modifiers');
  const payroll = wc.excludeOtPremium ? toCents(BigInt(G) - BigInt(otPremium)) : G;
  const prod = BigInt(payroll) * BigInt(ratePpm) * BigInt(wc.xModPpm) * BigInt(wc.otherModsPpm);
  if (wc.payrollCap === null) return { payroll, premium: toCents(divRound(prod, 10n ** 18n, mode), 'WC') };
  assertCents(wc.payrollCap, 'WC payroll cap');
  assertCents(annualWcPayroll, 'W_wc');
  if (annualWcPayroll <= 0) refuse('BAD_DIVISOR', 'W_wc must be > 0');
  const capped = BigInt(Math.min(annualWcPayroll, wc.payrollCap));
  return { payroll, premium: toCents(divRound(prod * capped, 10n ** 18n * BigInt(annualWcPayroll), mode), 'WC') };
}

// ---------------------------------------------------------------- per class: L_k (spec 2.3, 2.4)

export interface ClassCost {
  readonly id: string;
  readonly wages: ClassWages;
  readonly W: Cents | null; // annual taxable wages used (statutory mode)
  readonly lines: readonly Line[]; // G, SS, MED, FUTA, SUTA, MBT (or flat burden), WC, GLp, FR, TR, OTH
  readonly SS: Cents;
  readonly MED: Cents;
  readonly FUTA: Cents;
  readonly SUTA: Cents;
  readonly MBT: Cents;
  readonly FLAT: Cents;
  readonly WC: Cents;
  readonly GLp: Cents;
  readonly FR: Cents;
  readonly TR: Cents;
  readonly OTH: Cents;
  readonly L: Cents; // L_k
  /** Display only: L_k / H_k in cents per hour, half-up. null when H_k = 0. */
  readonly compositeRate: Cents | null;
}

export interface LaborResult {
  readonly classes: readonly ClassCost[];
  readonly L: Cents; // burdened direct labor
  readonly G: Cents; // cash wages
  readonly H: HoursC; // hours
  readonly assumptions: readonly AssumptionUsed[];
  readonly warnings: readonly string[];
}

/** L_k for one class (spec 2.4): G + SS + MED + FUTA + SUTA + MBT + WC + GLp + FR + TR + OTH. */
export function laborClassCost(input: LaborInput, c: LaborClassInput, ctx: { mbtRate: Ppm | null }): {
  cost: ClassCost;
  assumptions: AssumptionUsed[];
  warnings: string[];
} {
  validateLaborClass(c, input.regime);
  const mode = input.roundingMode ?? 'half-up';
  const assumptions: AssumptionUsed[] = [];
  const warnings: string[] = [];
  if (c.prevailing) {
    const chk = prevailingWageCheck(c);
    if (!chk.ok)
      refuse(
        'PREVAILING_WAGE_SHORTFALL',
        `class ${c.id}: w_basic + w_cil + plan credit is below BHR_wd + FB_wd by about ${chk.shortfallPerHour} cents/h (spec 2.2)`,
      );
  }
  const wages = classWages(input.regime, c, mode);
  const { G, H, otPremium } = wages;
  const k = `labor.${c.id}`;
  const lines: Line[] = [];
  const line = (l: Line): Cents => {
    lines.push(l);
    return l.amount;
  };
  line({
    key: `${k}.G`,
    label: 'Cash wages',
    amount: G,
    formula: '2.2 G_k = mulHours(h10,pay_10) + mulHours(h15,pay_15) + mulHours(h20,pay_20)',
    rounding: 'sum-of-rounded',
  });

  let SS = 0 as Cents, MED = 0 as Cents, FUTA = 0 as Cents, SUTA = 0 as Cents, MBT = 0 as Cents, FLAT = 0 as Cents;
  let W: Cents | null = null;

  if (input.burdenMode === 'flat') {
    if (input.flatBurdenPpm === undefined) refuse('MISSING_INPUT', 'flat burden mode needs flatBurdenPpm');
    assertPpm(input.flatBurdenPpm, 'b_flat', 0, 2_000_000);
    FLAT = line({
      key: `${k}.FLAT`,
      label: 'Payroll taxes, approximation: one flat percentage',
      amount: mulRate(G, input.flatBurdenPpm, mode),
      formula: '2.3 Burden_k = mulRate(G_k, b_flat) (replaces SS, Medicare, FUTA, SUTA, MBT)',
      base: { name: 'G_k', amount: G, unit: 'cents' },
      rate: { value: input.flatBurdenPpm, unit: 'ppm' },
      rounding: 'once-half-up',
    });
  } else {
    const t = tableFor(input, c.taxYear);
    const futa = futaRatePpm(t, input.futaCreditReductionPpm);
    if (futa.warning) warnings.push(futa.warning);
    const ui = stateUiRatePpm(t, input.stateUiRatePpm);
    if (input.burdenMode === 'statutory') {
      if (c.annualTaxableWages === undefined) {
        W = defaultAnnualWages(c);
        assumptions.push({ id: 'A-8', text: `annual taxable wages W for class ${c.id} = 2,000 h x straight-time cash wage`, value: `${W} cents` });
      } else W = c.annualTaxableWages;
      if (W <= 0) refuse('BAD_DIVISOR', `class ${c.id}: W must be > 0`);
      const capLine = (name: string, label: string, rate: Ppm, cap: Cents | null, f: string): Cents =>
        line({
          key: `${k}.${name}`,
          label,
          amount: cappedShare(G, rate, W!, cap, mode),
          formula: f,
          base: { name: 'G_k', amount: G, unit: 'cents' },
          rate: { value: cap === null ? rate : effRate(rate, W!, cap), unit: 'ppm' },
          rounding: 'once-half-up',
        });
      SS = capLine('SS', 'Social Security (employer)', t.socialSecurity.ratePpm, t.socialSecurity.wageBase, '2.3 SS_k = G_k*r_ss*min(W,SSB)/W');
      MED = line({
        key: `${k}.MED`,
        label: 'Medicare (employer)',
        amount: mulRate(G, t.medicare.ratePpm, mode),
        formula: '2.3 MED_k = mulRate(G_k, r_med), no cap',
        base: { name: 'G_k', amount: G, unit: 'cents' },
        rate: { value: t.medicare.ratePpm, unit: 'ppm' },
        rounding: 'once-half-up',
      });
      FUTA = capLine('FUTA', 'FUTA', futa.rate, t.futa.wageBase, '2.3 FUTA_k = G_k*(0.6%+CR)*min(W,7000)/W');
      SUTA = capLine(
        'SUTA',
        `State unemployment + ${t.stateUnemployment.surchargeLabel}`,
        ui,
        t.stateUnemployment.wageBase,
        '2.3 SUTA_k = G_k*(r_ui+surcharge)*min(W,B_state)/W',
      );
    } else {
      // ytd: tax = mulRate(min(Y+pay,cap) - min(Y,cap), rate)
      if (c.ytdWagesBefore === undefined) refuse('MISSING_INPUT', `class ${c.id}: ytd mode needs ytdWagesBefore`);
      const Y = c.ytdWagesBefore;
      const ytdLine = (name: string, label: string, rate: Ppm, cap: Cents | null): Cents => {
        const slice = ytdTaxableSlice(Y, G, cap);
        return line({
          key: `${k}.${name}`,
          label,
          amount: mulRate(slice, rate, mode),
          formula: `2.3 ytd: mulRate(min(Y+G,cap) - min(Y,cap), rate)`,
          base: { name: 'taxable slice', amount: slice, unit: 'cents' },
          rate: { value: rate, unit: 'ppm' },
          rounding: 'once-half-up',
        });
      };
      SS = ytdLine('SS', 'Social Security (employer)', t.socialSecurity.ratePpm, t.socialSecurity.wageBase);
      MED = ytdLine('MED', 'Medicare (employer)', t.medicare.ratePpm, null);
      FUTA = ytdLine('FUTA', 'FUTA', futa.rate, t.futa.wageBase);
      SUTA = ytdLine('SUTA', `State unemployment + ${t.stateUnemployment.surchargeLabel}`, ui, t.stateUnemployment.wageBase);
    }
    if (ctx.mbtRate !== null && ctx.mbtRate > 0) {
      const health = mulHours(H, c.fHealth, mode);
      const base = toCents(BigInt(G) > BigInt(health) ? BigInt(G) - BigInt(health) : 0n);
      MBT = line({
        key: `${k}.MBT`,
        label: 'Nevada Modified Business Tax',
        amount: mulRate(base, ctx.mbtRate, mode),
        formula: '2.3 MBT_k = mulRate(max(0, G_k - mulHours(H_k, f_health)), t_mbt)',
        base: { name: 'G_k - health', amount: base, unit: 'cents' },
        rate: { value: ctx.mbtRate, unit: 'ppm' },
        rounding: 'once-half-up',
      });
    }
  }

  const Wwc = c.wcAnnualPayroll ?? W ?? c.annualTaxableWages ?? defaultAnnualWages(c);
  if (input.workersComp.payrollCap !== null && c.wcAnnualPayroll === undefined)
    warnings.push(`class ${c.id}: workers' comp payroll cap figured on annual wages of ${Wwc} cents, because your annual comp payroll was not given`);
  const wc = workersComp(G, otPremium, c.wcRatePpm, input.workersComp, Wwc, mode);
  const WC = line({
    key: `${k}.WC`,
    label: "Workers' comp",
    amount: wc.premium,
    formula:
      input.workersComp.payrollCap === null
        ? '2.3 WC_k = P_wc*R*XMod*mods / 10^18'
        : '2.3 WC_k = P_wc*R*XMod*mods*min(W_wc,Cap) / (10^18*W_wc)',
    base: { name: 'P_wc', amount: wc.payroll, unit: 'cents' },
    rate: { value: c.wcRatePpm, unit: 'ppm' },
    rounding: 'once-half-up',
  });
  let GLp = 0 as Cents;
  if (input.generalLiabilityPayrollPpm !== undefined) {
    assertPpm(input.generalLiabilityPayrollPpm, 'GL payroll rate', 0, 1_000_000);
    GLp = line({
      key: `${k}.GLp`,
      label: 'General liability (payroll-rated)',
      amount: mulRate(G, input.generalLiabilityPayrollPpm, mode),
      formula: '2.3 GLp_k = mulRate(G_k, R_gl)',
      base: { name: 'G_k', amount: G, unit: 'cents' },
      rate: { value: input.generalLiabilityPayrollPpm, unit: 'ppm' },
      rounding: 'once-half-up',
    });
  }
  const perHour = (name: string, label: string, rate: Cents, f: string): Cents =>
    line({
      key: `${k}.${name}`,
      label,
      amount: mulHours(H, rate, mode),
      formula: f,
      base: { name: 'H_k', amount: H, unit: 'hoursC' },
      rate: { value: rate, unit: 'cents/h' },
      rounding: 'once-half-up',
    });
  const FR = perHour('FR', 'Plan fringe (bona fide plans)', c.fPlan, '2.4 FR_k = mulHours(H_k, f_plan)');
  const TR = perHour('TR', 'Travel / subsistence', c.travelPerHour, '2.4 TR_k = mulHours(H_k, T)');
  const OTH = perHour('OTH', 'Other per-hour costs', c.otherPerHour, '2.4 OTH_k = mulHours(H_k, other_h)');
  const L = toCents(
    [G, SS, MED, FUTA, SUTA, MBT, FLAT, WC, GLp, FR, TR, OTH].reduce((a, b) => a + BigInt(b), 0n),
    `L_${c.id}`,
  );
  const compositeRate = H > 0 ? toCents(divRoundHalfUp(BigInt(L) * 100n, BigInt(H))) : null;
  return {
    cost: { id: c.id, wages, W, lines, SS, MED, FUTA, SUTA, MBT, FLAT, WC, GLp, FR, TR, OTH, L, compositeRate },
    assumptions,
    warnings,
  };
}

/** Direct labor total (spec 2.4): L = sum L_k, G = sum G_k, H = sum H_k. */
export function laborCost(input: LaborInput): LaborResult {
  if (!input.classes.length) refuse('BAD_INPUT', 'no labor classes (enter a zero-hour class for a labor-free bid)');
  const ids = new Set<string>();
  for (const c of input.classes) {
    if (ids.has(c.id)) refuse('BAD_INPUT', `duplicate labor class id ${c.id}`);
    ids.add(c.id);
  }
  let mbtRate: Ppm | null = null;
  if (input.burdenMode !== 'flat' && input.mbt && input.mbt.mode !== 'none') {
    const years = [...new Set(input.classes.map((c) => c.taxYear))];
    const rates = years.map((y) => mbtRatePpm(input.mbt!, tableFor(input, y)));
    if (new Set(rates).size > 1) refuse('BAD_INPUT', 'MBT rate differs across tax years: split the job by year');
    mbtRate = rates[0] ?? null;
  }
  const out: ClassCost[] = [];
  const assumptions: AssumptionUsed[] = [];
  const warnings: string[] = [];
  for (const c of input.classes) {
    const r = laborClassCost(input, c, { mbtRate });
    out.push(r.cost);
    assumptions.push(...r.assumptions);
    warnings.push(...r.warnings);
  }
  const sum = (f: (x: ClassCost) => number): bigint => out.reduce((a, x) => a + BigInt(f(x)), 0n);
  return {
    classes: out,
    L: toCents(sum((x) => x.L), 'L'),
    G: toCents(sum((x) => x.wages.G), 'G'),
    H: toCents(sum((x) => x.wages.H), 'H') as number as HoursC,
    assumptions,
    warnings: [...new Set(warnings)],
  };
}

// ---------------------------------------------------------------- handbook closed form (flat mode)

/**
 * Composite hourly rate, handbook form with the verifier's correction (spec 2.3):
 * R = (B*(1+ot) + F_taxable)*(1+ti) + F_plan + T, carried exactly and rounded once at the end.
 * B, F_taxable, F_plan, T in cents/h; ot and ti in ppm.
 */
export function compositeRateFlat(B: Cents, otPpm: Ppm, fTaxable: Cents, tiPpm: Ppm, fPlan: Cents, T: Cents): Cents {
  for (const [v, n] of [[B, 'B'], [fTaxable, 'F_taxable'], [fPlan, 'F_plan'], [T, 'T']] as const) assertCents(v, n);
  assertPpm(otPpm, 'ot');
  assertPpm(tiPpm, 'ti');
  const M = 1_000_000n;
  const num = (BigInt(B) * (M + BigInt(otPpm)) + BigInt(fTaxable) * M) * (M + BigInt(tiPpm)) + (BigInt(fPlan) + BigInt(T)) * M * M;
  return toCents(divRoundHalfUp(num, M * M), 'composite rate');
}

/**
 * Annual employer taxes for one worker with annual wages W (statutory mode applied to a full year:
 * G = W). Used by the burden read-outs (I-6, I-7, I-8). Each component rounded once.
 */
export function annualEmployerTaxes(t: PayrollTaxTable, W: Cents, uiNotice: Ppm, futaCr?: Ppm) {
  validatePayrollTable(t);
  assertCents(W, 'W');
  if (W <= 0) refuse('BAD_DIVISOR', 'W must be > 0');
  const futa = futaRatePpm(t, futaCr);
  const ui = stateUiRatePpm(t, uiNotice);
  const ss = cappedShare(W, t.socialSecurity.ratePpm, W, t.socialSecurity.wageBase);
  const med = mulRate(W, t.medicare.ratePpm);
  const futaAmt = cappedShare(W, futa.rate, W, t.futa.wageBase);
  const suta = cappedShare(W, ui, W, t.stateUnemployment.wageBase);
  const total = toCents(BigInt(ss) + BigInt(med) + BigInt(futaAmt) + BigInt(suta));
  return { ss, med, futa: futaAmt, suta, total };
}
