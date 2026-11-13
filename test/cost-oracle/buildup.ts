// Independent reference for spec sections 2 and 3: takeoff -> bid price.
// Written from the spec text alone (no code shared with src/cost; only the engine's input TYPES are reused so
// both sides read the same data). Plain BigInt rationals; a value is rounded half-up to the cent only at the
// rounding points of spec 0.3, each exactly once.
import type { BidInput, LaborClassInput, PayrollTaxTable, PriceChargesInput, BondTier } from '../../src/cost/index.js';
import { add, cmp, div, floor, ceil, mul, ppmQ, q, roundHalfUp, sub, ZERO, ONE, type Q, safe } from './rational.js';

const MILLION = 1_000_000n;
const n = (x: bigint) => safe(x);
const B = (x: number) => BigInt(x);
/** Round a non-negative exact amount to the cent, half up (spec 0.2). */
const r = (x: Q, what = 'amount'): bigint => {
  if (x.n < 0n) throw new RangeError(`oracle: negative ${what}`);
  return roundHalfUp(x);
};
/** spec 0.2 mulRate(c, r) = round(c * r / 10^6). */
const mulRate = (c: bigint, ppm: number | bigint) => r(q(c * BigInt(ppm), MILLION));
/** spec 0.2 mulHours(h, rate) = round(h * rate / 100), rate may be an exact fraction (1.5x of odd cents). */
const mulHours = (h: bigint, rate: Q) => r(mul(q(h, 100n), rate));
/** spec 0.2 extend(q, waste, unit). */
const extend = (qty: bigint, waste: number, unit: bigint) => r(q(qty * (MILLION + B(waste)) * unit, 1_000_000_000n));

export interface OracleClass {
  id: string;
  pay10: Q;
  pay15: Q;
  pay20: Q;
  G: number;
  OTprem: number;
  H: number;
  W: number;
  SS: number;
  MED: number;
  FUTA: number;
  SUTA: number;
  MBT: number;
  FLAT: number;
  WC: number;
  GLp: number;
  FR: number;
  TR: number;
  OTH: number;
  L: number;
}

export interface OracleBid {
  classes: OracleClass[];
  L: number; G: number; H: number; ST: number;
  ext: number[]; esc: number[]; M: number; ESC_M: number; FRT: number; TB: number; TAX: number; MAT: number;
  E: number; SUB: number; JOOH: number; ESC_L: number; DC0: number; CONT: number; TJC: number;
  OH: number; BE: number; PR: number; FIN: number; S: number;
  SnoFin: number; PnoFin: number;
  q: number; premium: number; otherCharges: number; P: number; bondApplied: boolean;
  Pbid: number; roundingDelta: number; profitAsBidSpec: number; qAtPbid: number;
  items?: { id: string; directCost: number; indirect: number; price: number }[];
  /** spec-literal capped-tax variant (effRate ppm, then mulRate): kept to measure spec 0.2 vs I-6. */
  literalCappedTaxes: { SS: number; FUTA: number; SUTA: number }[];
}

// ---------------------------------------------------------------- spec 2.2 pay per bucket

export function bucketPayQ(regime: string, c: LaborClassInput): { pay10: Q; pay15: Q; pay20: Q | null } {
  const wtax = q(B(c.wBasic) + B(c.wCil));
  const half = q(3, 2);
  const pv = c.prevailing;
  let pay15: Q;
  let pay20: Q | null = c.pay20 !== undefined ? q(B(c.pay20)) : null;
  switch (regime) {
    case 'FLSA':
    case 'NV_PRIVATE':
      pay15 = mul(half, wtax);
      break;
    case 'CA_PRIVATE':
      pay15 = mul(half, wtax);
      pay20 = mul(q(2), wtax);
      break;
    case 'NV_PUBLIC': // 1.5 * (w_basic + w_cil + f_plan) - f_plan
      pay15 = sub(mul(half, q(B(c.wBasic) + B(c.wCil) + B(c.fPlan))), q(B(c.fPlan)));
      break;
    case 'CA_PUBLIC': { // 1.5 * max(BHR_wd, w_basic) + w_cil
      if (!pv) throw new RangeError('oracle: CA_PUBLIC needs a wage determination');
      pay15 = add(mul(half, q(B(Math.max(pv.bhrWd, c.wBasic)))), q(B(c.wCil)));
      break;
    }
    case 'DAVIS_BACON': { // w_tax + 0.5 * basicRate
      if (!pv) throw new RangeError('oracle: DAVIS_BACON needs a wage determination');
      const basic = pv.cashInLieuCountsAsBasic ? wtax : q(B(Math.max(pv.bhrWd, c.wBasic)));
      pay15 = add(wtax, mul(q(1, 2), basic));
      break;
    }
    default:
      throw new RangeError(`oracle: unknown regime ${regime}`);
  }
  return { pay10: wtax, pay15, pay20 };
}

/** spec 2.2 prevailing-wage check: w_basic + w_cil + planCredit >= BHR_wd + FB_wd, else an error. */
export function prevailingOk(c: LaborClassInput): boolean {
  const pv = c.prevailing;
  if (!pv) return true;
  let credit: Q = q(B(c.fPlan));
  if (pv.plans && pv.plans.length) {
    credit = ZERO;
    for (const p of pv.plans) {
      // annualized: annual cost (cents) / annual hours (HoursC / 100)
      credit = add(credit, p.annualize ? q(B(p.annualCost!) * 100n, B(p.annualHours!)) : q(B(p.ratePerHour)));
    }
  }
  return cmp(add(q(B(c.wBasic) + B(c.wCil)), credit), q(B(pv.bhrWd) + B(pv.fbWd))) >= 0;
}

// ---------------------------------------------------------------- spec 2.3 capped taxes

/** Exact capped tax, ONE rounding: G * rate * min(W, cap) / W (spec 3.7 T/W, applied to the job's wages). */
function cappedExact(G: bigint, ratePpm: bigint, W: bigint, cap: bigint | null): bigint {
  const base = cap === null || W <= cap ? W : cap;
  return r(q(G * ratePpm * base, MILLION * W));
}
/** Spec 0.2 literal: effRate rounded to whole ppm, then mulRate. */
function cappedLiteral(G: bigint, ratePpm: bigint, W: bigint, cap: bigint | null): bigint {
  const eff = cap === null || W <= cap ? ratePpm : roundHalfUp(q(ratePpm * cap, W));
  return mulRate(G, eff);
}

// ---------------------------------------------------------------- spec 2.13 price-based charges

export function tierMicro(P: bigint, tiers: readonly BondTier[]): bigint {
  let s = 0n, lo = 0n;
  for (const t of tiers) {
    const hi = t.upperBound === null ? null : B(t.upperBound);
    const top = hi === null || P < hi ? P : hi;
    if (top > lo) s += B(t.ratePpm) * (top - lo);
    if (hi === null) break;
    lo = hi;
  }
  return s; // cents * ppm
}
function feeSum(c: PriceChargesInput): bigint {
  return c.fees.reduce((a, f) => a + B(f.rate.ppm), 0n);
}
/** q(P) = round((m_dur * tier(P) + f * P * 10^6) / 10^12), one rounding (spec 2.13). */
export function qOf(P: bigint, c: PriceChargesInput, tiers: readonly BondTier[] = c.tiers): bigint {
  return r(q(B(c.mDurPpm) * tierMicro(P, tiers) + feeSum(c) * P * MILLION, 10n ** 12n));
}
export function premiumOf(P: bigint, c: PriceChargesInput, tiers: readonly BondTier[] = c.tiers): bigint {
  return r(q(B(c.mDurPpm) * tierMicro(P, tiers), 10n ** 12n));
}
/** k_max = m_dur * max r_k + f, as an exact fraction. */
export function kMax(c: PriceChargesInput, tiers: readonly BondTier[] = c.tiers): Q {
  const rmax = tiers.reduce((m, t) => (B(t.ratePpm) > m ? B(t.ratePpm) : m), 0n);
  return q(B(c.mDurPpm) * rmax + feeSum(c) * MILLION, 10n ** 12n);
}
/** P = the smallest integer with P - q(P) >= S (spec 2.13). Refuses when k_max >= 1. */
export function grossUpQ(S: bigint, c: PriceChargesInput, tiers: readonly BondTier[] = c.tiers): bigint {
  const k = kMax(c, tiers);
  if (cmp(k, ONE) >= 0) throw new RangeError('oracle: k_max >= 1, no gross-up');
  // Existence (spec 2.13 proof): P - q(P) is non-decreasing with steps of 0 or 1 when k_max < 1, so the
  // smallest solution lies in [S, ceil((S+1)/(1-k)) + 2]. Plain bisection on the definition.
  let lo = S, hi = ceil(div(q(S + 1n), sub(ONE, k)))+ 2n;
  const ok = (P: bigint) => P - qOf(P, c, tiers) >= S;
  if (!ok(hi)) throw new RangeError('oracle: search window too small');
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (ok(mid)) hi = mid;
    else lo = mid + 1n;
  }
  if (lo - qOf(lo, c, tiers) !== S) throw new RangeError('oracle: no exact solution P - q(P) = S');
  if (lo > 0n && ok(lo - 1n)) throw new RangeError('oracle: not the smallest solution');
  return lo;
}
/** Plain scan (for small S only): every candidate from S upward, no monotonicity assumed. */
export function grossUpScan(S: bigint, c: PriceChargesInput): bigint {
  for (let P = S; ; P++) if (P - qOf(P, c) >= S) return P;
}
/** spec 2.13 m_dur. */
export function mDurPpmQ(Mo: number, M1: number, M2: number, s1: number, s2: number): bigint {
  if (M2 < M1) throw new RangeError('oracle: M2 < M1');
  return MILLION + B(s1) * B(Math.max(0, Math.min(Mo, M2) - M1)) + B(s2) * B(Math.max(0, Mo - M2));
}

// ---------------------------------------------------------------- spec 2.15 allocation, one cent at a time

export function allocateOracle(T: bigint, w: readonly bigint[]): bigint[] {
  const W = w.reduce((a, b) => a + b, 0n);
  if (W <= 0n || T < 0n || w.some((x) => x < 0n)) throw new RangeError('oracle: bad allocation');
  const exact = w.map((wi) => q(T * wi, W));
  const out = exact.map((e) => floor(e));
  let left = T - out.reduce((a, b) => a + b, 0n);
  while (left > 0n) {
    // hand one cent to the line furthest below its exact share; ties to the lowest index
    let best = -1;
    let bestGap: Q = q(-1);
    for (let i = 0; i < w.length; i++) {
      const gap = sub(exact[i]!, q(out[i]!));
      if (cmp(gap, bestGap) > 0) [best, bestGap] = [i, gap];
    }
    out[best]! += 1n;
    left--;
  }
  return out;
}

// ---------------------------------------------------------------- the build-up

export interface OracleOptions {
  /** FIN computed at the price without FIN (spec 2.12); receives S_noFin and P_noFin. */
  finCompute?: (SnoFin: number, PnoFin: number) => number;
}

export function oracleBid(inp: BidInput, opt: OracleOptions = {}): OracleBid {
  const lab = inp.labor;
  const classes: OracleClass[] = [];
  const literal: { SS: number; FUTA: number; SUTA: number }[] = [];
  // MBT firm-level rate (spec 2.3)
  let tMbt = 0n;
  const mbt = lab.mbt;
  if (mbt && mbt.mode !== 'none' && lab.burdenMode !== 'flat') {
    const net = B(mbt.quarterlyGrossWages) - B(mbt.quarterlyHealthDeduction);
    if (mbt.mode === 'marginal') tMbt = net > 5_000_000n ? 11_700n : 0n; // D-9: 1.17% above $50,000 a quarter
    else {
      const MBTq = mulRate(net - 5_000_000n > 0n ? net - 5_000_000n : 0n, 11_700);
      if (mbt.quarterlyGrossWages <= 0) throw new RangeError('oracle: GW_q must be > 0 for average mode');
      tMbt = r(q(MBTq * MILLION, B(mbt.quarterlyGrossWages)));
    }
  }
  for (const c of lab.classes) {
    if (!prevailingOk(c)) throw new RangeError(`oracle: prevailing-wage check fails for ${c.id}`);
    const { pay10, pay15, pay20 } = bucketPayQ(lab.regime, c);
    if (c.h20 > 0 && pay20 === null) throw new RangeError('oracle: h20 > 0 needs pay20');
    const p20 = pay20 ?? ZERO;
    const h10 = B(c.h10), h15 = B(c.h15), h20 = B(c.h20);
    const G = mulHours(h10, pay10) + mulHours(h15, pay15) + mulHours(h20, p20);
    const OTprem = mulHours(h15, sub(pay15, pay10)) + (h20 > 0n ? mulHours(h20, sub(p20, pay10)) : 0n);
    const H = h10 + h15 + h20;
    const W = c.annualTaxableWages !== undefined ? B(c.annualTaxableWages) : 2000n * (B(c.wBasic) + B(c.wCil)); // A-8
    let SS = 0n, MED = 0n, FUTA = 0n, SUTA = 0n, MBT = 0n, FLAT = 0n;
    if (lab.burdenMode === 'flat') {
      FLAT = mulRate(G, lab.flatBurdenPpm ?? 0);
      literal.push({ SS: 0, FUTA: 0, SUTA: 0 });
    } else if (lab.burdenMode === 'statutory') {
      const t: PayrollTaxTable | undefined = lab.payrollTables?.[c.taxYear];
      if (!t) throw new RangeError('oracle: no payroll table for the year');
      const ss = B(t.socialSecurity.ratePpm), ssCap = B(t.socialSecurity.wageBase);
      const cr = t.futa.creditReductionPpm ?? lab.futaCreditReductionPpm;
      if (cr === undefined || cr === null) throw new RangeError('oracle: FUTA credit reduction must be entered');
      const futa = B(t.futa.netRatePpm) + B(cr), futaCap = B(t.futa.wageBase);
      const ui = lab.stateUiRatePpm;
      if (ui === undefined) throw new RangeError('oracle: UI rate missing');
      const su = t.stateUnemployment;
      const sur = su.surchargeExemptAtRatePpm !== null && ui === su.surchargeExemptAtRatePpm ? 0n : B(su.surchargePpm);
      const suta = B(ui) + sur, sutaCap = B(su.wageBase);
      SS = cappedExact(G, ss, W, ssCap);
      MED = mulRate(G, t.medicare.ratePpm);
      FUTA = cappedExact(G, futa, W, futaCap);
      SUTA = cappedExact(G, suta, W, sutaCap);
      literal.push({
        SS: n(cappedLiteral(G, ss, W, ssCap)),
        FUTA: n(cappedLiteral(G, futa, W, futaCap)),
        SUTA: n(cappedLiteral(G, suta, W, sutaCap)),
      });
      if (t.mbt) {
        const base = G - mulHours(H, q(B(c.fHealth)));
        MBT = mulRate(base > 0n ? base : 0n, tMbt);
      }
    } else throw new RangeError('oracle: ytd mode not modelled');
    // workers' comp (spec 2.3)
    const wc = lab.workersComp;
    const Pwc = G - (wc.excludeOtPremium ? OTprem : 0n);
    const Wwc = c.wcAnnualPayroll !== undefined ? B(c.wcAnnualPayroll) : W;
    const capWc = wc.payrollCap === null ? Wwc : Wwc < B(wc.payrollCap) ? Wwc : B(wc.payrollCap);
    const WC = r(q(Pwc * B(c.wcRatePpm) * B(wc.xModPpm) * B(wc.otherModsPpm) * capWc, 10n ** 18n * Wwc));
    const GLp = lab.generalLiabilityPayrollPpm !== undefined ? mulRate(G, lab.generalLiabilityPayrollPpm) : 0n;
    const FR = mulHours(H, q(B(c.fPlan)));
    const TR = mulHours(H, q(B(c.travelPerHour)));
    const OTH = mulHours(H, q(B(c.otherPerHour)));
    const L = G + SS + MED + FUTA + SUTA + MBT + FLAT + WC + GLp + FR + TR + OTH;
    classes.push({
      id: c.id, pay10, pay15, pay20: p20, G: n(G), OTprem: n(OTprem), H: n(H), W: n(W),
      SS: n(SS), MED: n(MED), FUTA: n(FUTA), SUTA: n(SUTA), MBT: n(MBT), FLAT: n(FLAT), WC: n(WC), GLp: n(GLp),
      FR: n(FR), TR: n(TR), OTH: n(OTH), L: n(L),
    });
  }
  const Lt = classes.reduce((a, c) => a + B(c.L), 0n);
  const Gt = classes.reduce((a, c) => a + B(c.G), 0n);
  const Ht = classes.reduce((a, c) => a + B(c.H), 0n);
  const ST = mulRate(Lt, inp.smallToolsPpm ?? 20_000); // A-18 / D-66 2% when omitted
  // materials (spec 2.6)
  const mat = inp.materials;
  const ext: bigint[] = [], esc: bigint[] = [];
  let TB = 0n, TAXline = 0n;
  mat.lines.forEach((l, i) => {
    const e = extend(B(l.quantity), l.wastePpm, B(l.unitPrice));
    const ePpm = mat.escalation ? mat.escalation(l, i) : (l.escalationPpm ?? 0);
    if (ePpm < 0) throw new RangeError('oracle: negative escalation is negative money');
    const s = mulRate(e, ePpm);
    ext.push(e);
    esc.push(s);
    if (l.taxable !== false) {
      TB += e + s;
      TAXline += mulRate(e + s, mat.salesTaxPpm);
    }
  });
  const FRT = B(mat.freight);
  if (mat.freightTaxable) {
    TB += FRT;
    TAXline += mulRate(FRT, mat.salesTaxPpm);
  }
  const TAX = (mat.taxBasis ?? 'total') === 'total' ? mulRate(TB, mat.salesTaxPpm) : TAXline;
  const M = ext.reduce((a, b) => a + b, 0n), ESC_M = esc.reduce((a, b) => a + b, 0n);
  const MAT = M + ESC_M + TAX + FRT;
  // equipment, subs, job overhead (2.7 - 2.9)
  const E = inp.equipment.reduce((a, l) => a + (l.kind === 'hourly' ? mulHours(B(l.hours), q(B(l.rate))) : B(l.amount)), 0n);
  const SUB = inp.subcontracts.reduce((a, s) => a + B(s.amount), 0n);
  const JOOH = inp.jobOverhead.reduce(
    (a, j) => a + (j.kind === 'monthly' ? extend(B(j.months), 0, B(j.monthlyCost)) : j.kind === 'hours' ? mulHours(B(j.hours), q(B(j.rate))) : B(j.amount)),
    0n,
  );
  // 2.10
  const Gns = lab.classes.reduce((a, c, i) => a + (c.wageScheduled ? 0n : B(classes[i]!.G)), 0n);
  const ESC_L = mulRate(Gns, inp.laborEscalationPpm ?? 0);
  const DC0 = Lt + ST + MAT + E + SUB + JOOH + ESC_L;
  const CONT = mulRate(DC0, inp.contingencyPpm ?? 0);
  const TJC = DC0 + CONT;
  // 2.11 home-office overhead
  const o = inp.overhead;
  let OH: bigint;
  let PRfromSales: bigint | null = null;
  switch (o.method) {
    case 'on_cost':
      OH = 'rate' in o ? mulRate(TJC, o.rate.ppm) : r(q(TJC * B(o.annual.overhead), B(o.annual.directCost)));
      break;
    case 'on_sales': {
      const os = B(o.rate.ppm), ms = B(o.profit.ppm);
      if (os + ms >= MILLION) throw new RangeError('oracle: o_s + m_s >= 1');
      const S0 = r(q(TJC * MILLION, MILLION - os - ms));
      OH = mulRate(S0, os);
      PRfromSales = S0 - TJC - OH;
      break;
    }
    case 'per_labor_hour':
      OH = 'centsPerHour' in o ? mulHours(Ht, q(B(o.centsPerHour))) : r(q(Ht * B(o.annual.overhead), B(o.annual.laborHours)));
      break;
    case 'on_labor_cost': {
      const base = o.measure === 'L' ? Lt : Gt;
      OH = 'rate' in o ? mulRate(base, o.rate.ppm) : r(q(base * B(o.annual.overhead), B(o.annual.directLabor)));
      break;
    }
    case 'dual': {
      if ('rateL' in o) OH = mulRate(Lt, o.rateL.ppm) + mulRate(TJC - Lt, o.rateM.ppm);
      else {
        const X = q(B(o.weightXPpm), MILLION);
        const rM = div(q(B(o.annual.overhead)), add(mul(X, q(B(o.annual.labor))), q(B(o.annual.nonLabor))));
        const rL = mul(X, rM);
        OH = r(mul(q(Lt), rL)) + r(mul(q(TJC - Lt), rM));
      }
      break;
    }
  }
  const BE = TJC + OH;
  const PR = PRfromSales ?? ('rate' in inp.profit ? mulRate(BE, inp.profit.rate.ppm) : (() => { throw new RangeError('oracle: profit'); })());
  // 2.12 / 2.13
  const ch = inp.charges;
  const price = (S: bigint): { P: bigint; tiers: readonly BondTier[]; bond: boolean } => {
    if (ch.bondRequiredAuto && ch.tiers.length) {
      const Pno = grossUpQ(S, ch, []);
      // spec 4.2 + 2.14: the trigger is tested on the contract price as bid (the no-bond price, rounded up to the unit)
      const u = inp.bidRoundingUnit !== undefined ? B(inp.bidRoundingUnit) : 1n;
      if (!ch.bondRequiredAuto(n(((Pno + u - 1n) / u) * u) as never)) return { P: Pno, tiers: [], bond: false };
      return { P: grossUpQ(S, ch, ch.tiers), tiers: ch.tiers, bond: true };
    }
    return { P: grossUpQ(S, ch, ch.tiers), tiers: ch.tiers, bond: ch.tiers.length > 0 };
  };
  const SnoFin = BE + PR;
  const noFin = price(SnoFin);
  let FIN = 0n;
  const fin = inp.financing;
  if (fin.include) {
    if ('amount' in fin) FIN = B(fin.amount);
    else if (opt.finCompute) FIN = B(opt.finCompute(n(SnoFin), n(noFin.P)));
    else FIN = B(fin.compute(n(SnoFin) as never, n(noFin.P) as never));
  }
  const S = SnoFin + FIN;
  const pr = FIN === 0n ? noFin : price(S);
  const P = pr.P;
  const qP = qOf(P, ch, pr.tiers);
  const prem = premiumOf(P, ch, pr.tiers);
  // 2.14
  const unit = inp.bidRoundingUnit !== undefined ? B(inp.bidRoundingUnit) : 1n;
  const Pbid = ((P + unit - 1n) / unit) * unit;
  const qAtPbid = qOf(Pbid, ch, pr.tiers);
  const out: OracleBid = {
    classes, L: n(Lt), G: n(Gt), H: n(Ht), ST: n(ST),
    ext: ext.map(n), esc: esc.map(n), M: n(M), ESC_M: n(ESC_M), FRT: n(FRT), TB: n(TB), TAX: n(TAX), MAT: n(MAT),
    E: n(E), SUB: n(SUB), JOOH: n(JOOH), ESC_L: n(ESC_L), DC0: n(DC0), CONT: n(CONT), TJC: n(TJC),
    OH: n(OH), BE: n(BE), PR: n(PR), FIN: n(FIN), S: n(S), SnoFin: n(SnoFin), PnoFin: n(noFin.P),
    q: n(qP), premium: n(prem), otherCharges: n(qP - prem), P: n(P), bondApplied: pr.bond,
    Pbid: n(Pbid), roundingDelta: n(Pbid - P), profitAsBidSpec: n(PR + Pbid - P), qAtPbid: n(qAtPbid),
    literalCappedTaxes: literal,
  };
  // 2.15
  if (inp.bidItems && inp.bidItems.length) {
    const dc = inp.bidItems.map((i) => B(i.directCost));
    const T = Pbid - dc.reduce((a, b) => a + b, 0n);
    const ind = allocateOracle(T, dc);
    out.items = inp.bidItems.map((it, i) => ({ id: it.id, directCost: it.directCost, indirect: n(ind[i]!), price: n(dc[i]! + ind[i]!) }));
  }
  return out;
}

/** Spec 3.9 tolerance for |S - S_exact| when every line is rounded: 0.5 cent x sum of downstream gains. */
export function chainBoundCents(roundings: readonly Q[]): Q {
  return roundings.reduce((a, g) => add(a, mul(q(1, 2), g)), ZERO);
}
export { ppmQ };
