// Cost build-up, takeoff to bid price (spec 2.5 to 2.15): small tools, equipment, subcontracts,
// job overhead, labor escalation, contingency, total job cost, home-office overhead (five methods),
// break-even, profit, financing, the price-based charges as an exact fixed point, optional bid
// rounding, and distribution of indirects to bid items. Every line names formula, base and rounding.

import {
  refuse,
  mulRate,
  mulHours,
  extend,
  allocate,
  divRoundHalfUp,
  divCeil,
  toCents,
  toPpm,
  assertCents,
  assertPpm,
  assertInt,
  type Cents,
  type Ppm,
  type HoursC,
} from './money.js';
import {
  requireBase,
  type AssumptionUsed,
  type BidInput,
  type BidItem,
  type BondTier,
  type EquipmentLine,
  type JobOverheadItem,
  type Line,
  type OverheadInput,
  type PriceChargesInput,
  type SubcontractQuote,
} from './types.js';
import { laborCost, type LaborResult } from './burden.js';
import { materialLines, type MaterialsResult } from './materials.js';

const M6 = 1_000_000n;
const M12 = 1_000_000_000_000n;
const sumB = (xs: readonly number[]): bigint => xs.reduce((a, b) => a + BigInt(b), 0n);

/** A-18 small tools default 2% of burdened direct labor (D-66 value, our reading of the base). */
export const A18_SMALL_TOOLS_PPM = 20_000 as Ppm;
/** A-19 contingency default 0. */
export const A19_CONTINGENCY_PPM = 0 as Ppm;

// ---------------------------------------------------------------- spec 2.7, 2.8, 2.9

export function equipmentCost(lines: readonly EquipmentLine[]): { E: Cents; lines: Line[] } {
  const out: Line[] = lines.map((l) =>
    l.kind === 'hourly'
      ? {
          key: `equipment.${l.id}`,
          label: `Equipment ${l.id}`,
          amount: mulHours(l.hours, l.rate),
          formula: '2.7 mulHours(hours, rate)',
          base: { name: 'hours', amount: l.hours, unit: 'hoursC' },
          rate: { value: l.rate, unit: 'cents/h' },
          rounding: 'once-half-up',
        }
      : l.kind === 'lump'
        ? { key: `equipment.${l.id}`, label: `Equipment ${l.id}`, amount: assertCents(l.amount), formula: '2.7 rental lump sum incl. fuel', rounding: 'exact' }
        : refuse('BAD_INPUT', `unknown equipment line kind`),
  );
  return { E: toCents(sumB(out.map((l) => l.amount)), 'E'), lines: out };
}

export function subcontractCost(quotes: readonly SubcontractQuote[]): { SUB: Cents; lines: Line[] } {
  const out: Line[] = quotes.map((q) => ({
    key: `sub.${q.id}`,
    label: `Subcontract ${q.id}`,
    amount: assertCents(q.amount, `sub ${q.id}`),
    formula: "2.8 the sub's full quote (its own overhead, profit and bond included)",
    rounding: 'exact',
  }));
  return { SUB: toCents(sumB(out.map((l) => l.amount)), 'SUB'), lines: out };
}

export function jobOverheadCost(items: readonly JobOverheadItem[]): { JOOH: Cents; lines: Line[] } {
  const out: Line[] = items.map((it): Line => {
    switch (it.kind) {
      case 'monthly':
        return {
          key: `jooh.${it.id}`,
          label: `Job overhead ${it.id}`,
          amount: extend(it.months, 0 as Ppm, it.monthlyCost),
          formula: '2.9 extend(months, 0, monthlyCost)',
          base: { name: 'months', amount: it.months, unit: 'qtyM' },
          rate: { value: it.monthlyCost, unit: 'cents/unit' },
          rounding: 'once-half-up',
        };
      case 'hours':
        return {
          key: `jooh.${it.id}`,
          label: `Job overhead ${it.id}`,
          amount: mulHours(it.hours, it.rate),
          formula: '2.9 mulHours(hours, rate)',
          base: { name: 'hours', amount: it.hours, unit: 'hoursC' },
          rate: { value: it.rate, unit: 'cents/h' },
          rounding: 'once-half-up',
        };
      case 'once':
        return { key: `jooh.${it.id}`, label: `Job overhead ${it.id}`, amount: assertCents(it.amount), formula: '2.9 one-time item', rounding: 'exact' };
      default:
        return refuse('BAD_INPUT', 'unknown job overhead item kind');
    }
  });
  return { JOOH: toCents(sumB(out.map((l) => l.amount)), 'JOOH'), lines: out };
}

// ---------------------------------------------------------------- spec 2.11 home-office overhead

export interface OverheadResult {
  readonly OH: Cents;
  /** Set only by method 'on_sales', where profit comes out of S0 (spec 2.11). */
  readonly PR?: Cents;
  readonly S0?: Cents;
  readonly lines: readonly Line[];
}

/** OH by the five methods (spec 2.11). No default rate exists (A-7): every method needs entered figures. */
export function homeOfficeOverhead(o: OverheadInput, TJC: Cents, L: Cents, G: Cents, H: HoursC): OverheadResult {
  assertCents(TJC, 'TJC');
  assertCents(L, 'L');
  if (L > TJC) refuse('BAD_INPUT', 'L exceeds TJC');
  const ohLine = (amount: Cents, formula: string, baseName: string, baseAmt: number, rate?: number, unit: 'cents' | 'hoursC' = 'cents'): Line => ({
    key: 'OH',
    label: 'Home-office overhead',
    amount,
    formula,
    base: { name: baseName, amount: baseAmt, unit },
    ...(rate !== undefined ? { rate: { value: rate, unit: unit === 'hoursC' ? ('cents/h' as const) : ('ppm' as const) } } : {}),
    rounding: 'once-half-up',
  });
  switch (o.method) {
    case 'on_cost': {
      if ('rate' in o) {
        const r = requireBase(o.rate, ['on_cost'], 'overhead o_c');
        const OH = mulRate(TJC, r.ppm);
        return { OH, lines: [ohLine(OH, '2.11 OH = mulRate(TJC, o_c)', 'TJC', TJC, r.ppm)] };
      }
      const a = o.annual;
      assertCents(a.overhead, 'OH_annual');
      assertCents(a.directCost, 'DC_annual');
      if (a.directCost <= 0) refuse('BAD_DIVISOR', 'DC_annual must be > 0');
      const OH = toCents(divRoundHalfUp(BigInt(TJC) * BigInt(a.overhead), BigInt(a.directCost)));
      return { OH, lines: [ohLine(OH, '2.11 OH = TJC * OH_annual / DC_annual (rate kept exact, one rounding)', 'TJC', TJC)] };
    }
    case 'on_sales': {
      const os = requireBase(o.rate, ['on_sales'], 'overhead o_s');
      const ms = requireBase(o.profit, ['on_sales'], 'profit m_s');
      const denom = M6 - BigInt(os.ppm) - BigInt(ms.ppm);
      if (denom <= 0n) refuse('OUT_OF_RANGE', 'o_s + m_s must be below 100% (spec 2.11)');
      const S0 = toCents(divRoundHalfUp(BigInt(TJC) * M6, denom), 'S0');
      const OH = mulRate(S0, os.ppm);
      const pr = BigInt(S0) - BigInt(TJC) - BigInt(OH);
      if (pr < 0n) refuse('NEGATIVE', 'on_sales profit came out negative'); // cannot happen for m_s >= 0 (spec 2.11)
      const PR = toCents(pr);
      return {
        OH,
        PR,
        S0,
        lines: [
          { key: 'S0', label: 'Sales before charges (revenue basis)', amount: S0, formula: '2.11 S0 = divRoundHalfUp(TJC*10^6, 10^6 - o_s - m_s)', base: { name: 'TJC', amount: TJC, unit: 'cents' }, rounding: 'once-half-up' },
          ohLine(OH, '2.11 OH = mulRate(S0, o_s)', 'S0', S0, os.ppm),
        ],
      };
    }
    case 'per_labor_hour': {
      if ('centsPerHour' in o) {
        const OH = mulHours(H, assertCents(o.centsPerHour, 'oh_per_hour'));
        return { OH, lines: [ohLine(OH, '2.11 OH = mulHours(H, oh_per_hour)', 'H', H, o.centsPerHour, 'hoursC')] };
      }
      const a = o.annual;
      assertCents(a.overhead, 'OH_annual');
      assertInt(a.laborHours, 'LH_annual', 1);
      const OH = toCents(divRoundHalfUp(BigInt(H) * BigInt(a.overhead), BigInt(a.laborHours)));
      return { OH, lines: [ohLine(OH, '2.11 OH = H * OH_annual / LH_annual', 'H', H, undefined, 'hoursC')] };
    }
    case 'on_labor_cost': {
      const base = o.measure === 'L' ? L : o.measure === 'G' ? G : refuse('BAD_INPUT', "labor measure must be 'L' or 'G'");
      if ('rate' in o) {
        const r = requireBase(o.rate, ['on_labor_cost'], 'overhead oh_on_labor');
        const OH = mulRate(base, r.ppm);
        return { OH, lines: [ohLine(OH, `2.11 OH = mulRate(${o.measure}, oh_on_labor)`, o.measure, base, r.ppm)] };
      }
      const a = o.annual;
      assertCents(a.overhead, 'OH_annual');
      assertCents(a.directLabor, 'DL_annual');
      if (a.directLabor <= 0) refuse('BAD_DIVISOR', 'DL_annual must be > 0');
      const OH = toCents(divRoundHalfUp(BigInt(base) * BigInt(a.overhead), BigInt(a.directLabor)));
      return { OH, lines: [ohLine(OH, `2.11 OH = ${o.measure} * OH_annual / DL_annual (same labor measure)`, o.measure, base)] };
    }
    case 'dual': {
      const nonLabor = toCents(BigInt(TJC) - BigInt(L));
      if ('rateL' in o) {
        const rL = requireBase(o.rateL, ['on_labor_cost'], 'dual r_L');
        const rM = requireBase(o.rateM, ['on_cost'], 'dual r_M');
        if (rL.ppm <= rM.ppm) refuse('OUT_OF_RANGE', 'dual rate needs r_L > r_M (X > 1)');
        const a = mulRate(L, rL.ppm), b = mulRate(nonLabor, rM.ppm);
        return {
          OH: toCents(BigInt(a) + BigInt(b)),
          lines: [
            { ...ohLine(a, '2.11 OH_L = mulRate(L, r_L)', 'L', L, rL.ppm), key: 'OH.L' },
            { ...ohLine(b, '2.11 OH_M = mulRate(TJC - L, r_M)', 'TJC - L', nonLabor, rM.ppm), key: 'OH.M' },
          ],
        };
      }
      const a = o.annual;
      assertCents(a.overhead, 'OH_annual');
      assertCents(a.labor, 'L_annual');
      assertCents(a.nonLabor, 'MS_annual');
      assertPpm(o.weightXPpm, 'dual weight X');
      if (o.weightXPpm <= 1_000_000) refuse('OUT_OF_RANGE', 'dual weight X must be > 1 (A-38)');
      // r_M = OH/(X*L_a + MS_a), r_L = X*r_M, kept exact: D = X*L_a + 10^6*MS_a (X in ppm).
      const D = BigInt(o.weightXPpm) * BigInt(a.labor) + M6 * BigInt(a.nonLabor);
      if (D <= 0n) refuse('BAD_DIVISOR', 'dual: X*L_annual + MS_annual must be > 0');
      const ohL = toCents(divRoundHalfUp(BigInt(L) * BigInt(o.weightXPpm) * BigInt(a.overhead), D));
      const ohM = toCents(divRoundHalfUp(BigInt(nonLabor) * M6 * BigInt(a.overhead), D));
      return {
        OH: toCents(BigInt(ohL) + BigInt(ohM)),
        lines: [
          { ...ohLine(ohL, '2.11 OH_L = L * X*OH_a/(X*L_a + MS_a)', 'L', L), key: 'OH.L' },
          { ...ohLine(ohM, '2.11 OH_M = (TJC - L) * OH_a/(X*L_a + MS_a)', 'TJC - L', nonLabor), key: 'OH.M' },
        ],
      };
    }
    default:
      return refuse('BAD_INPUT', `unknown overhead method ${String((o as { method?: unknown }).method)}`);
  }
}

// ---------------------------------------------------------------- spec 2.13 price-based charges

/** Validate a marginal tier schedule: increasing bounds, only the last open (null = infinity). */
export function validateTiers(tiers: readonly BondTier[]): void {
  let prev = 0;
  tiers.forEach((t, i) => {
    assertPpm(t.ratePpm, `tier ${i} rate`, 0, 1_000_000);
    const last = i === tiers.length - 1;
    if (t.upperBound === null) {
      if (!last) refuse('BAD_TIERS', 'only the last tier may be open-ended');
    } else {
      assertCents(t.upperBound, `tier ${i} bound`);
      if (t.upperBound <= prev) refuse('BAD_TIERS', 'tier bounds must increase');
      if (last) refuse('BAD_TIERS', 'the last tier must be open-ended (upperBound null)');
      prev = t.upperBound;
    }
  });
}

/** tier(P) = sum_k r_k * max(0, min(P, b_k) - b_{k-1}), unrounded, in cents * ppm (spec 2.13). */
export function tierMicro(P: Cents, tiers: readonly BondTier[]): bigint {
  assertCents(P, 'price');
  let total = 0n, lower = 0n;
  const p = BigInt(P);
  for (const t of tiers) {
    const upper = t.upperBound === null ? null : BigInt(t.upperBound);
    const hi = upper === null || p < upper ? p : upper;
    if (hi > lower) total += (hi - lower) * BigInt(t.ratePpm);
    if (upper === null || p <= upper) break;
    lower = upper;
  }
  return total;
}

/** Sum of the fees proportional to price, f (ppm). Every fee must carry an on_price / per_1000_receipts tag. */
export function feePpm(c: PriceChargesInput): Ppm {
  let f = 0n;
  for (const fee of c.fees) f += BigInt(requireBase(fee.rate, ['on_price', 'per_1000_receipts'], `fee ${fee.label}`).ppm);
  return toPpm(f, 'fees');
}

/** Marginal charge rate k_max = m_dur*r_max + f, scaled by 10^12. */
export function marginalChargeRate12(c: PriceChargesInput, tiers: readonly BondTier[] = c.tiers): bigint {
  assertPpm(c.mDurPpm, 'm_dur');
  if (c.mDurPpm < 1_000_000) refuse('OUT_OF_RANGE', 'm_dur must be >= 1.00');
  const rmax = tiers.reduce((m, t) => (t.ratePpm > m ? t.ratePpm : m), 0);
  return BigInt(rmax) * BigInt(c.mDurPpm) + BigInt(feePpm(c)) * M6;
}

/** q(P) = divRoundHalfUp(m_dur * tier(P) + f * P * 10^6, 10^12): everything in ONE rounding (spec 2.13). */
export function priceBasedCharge(P: Cents, c: PriceChargesInput, tiers: readonly BondTier[] = c.tiers): Cents {
  validateTiers(tiers);
  assertPpm(c.mDurPpm, 'm_dur');
  const num = tierMicro(P, tiers) * BigInt(c.mDurPpm) + BigInt(feePpm(c)) * BigInt(P) * M6;
  return toCents(divRoundHalfUp(num, M12), 'q(P)');
}

/** Reported split (spec 2.13): premium = round(m_dur*tier(P)); otherCharges = q(P) - premium. */
export function chargeSplit(P: Cents, c: PriceChargesInput, tiers: readonly BondTier[] = c.tiers): { q: Cents; premium: Cents; otherCharges: Cents } {
  const q = priceBasedCharge(P, c, tiers);
  const premium = toCents(divRoundHalfUp(tierMicro(P, tiers) * BigInt(c.mDurPpm), M12), 'premium');
  return { q, premium, otherCharges: toCents(BigInt(q) - BigInt(premium), 'other charges') };
}

/**
 * The smallest integer P with P - q(P) >= S (spec 2.13). Existence: if k_max = m_dur*r_max + f < 1,
 * P - q(P) rises by 0 or 1 cent per cent of P, so it takes every value >= 0 and P - q(P) = S exactly.
 * Window: hi = floor((S+1)/(1 - k_max)) + 2. Throws if k_max >= 1 or the result is not exact.
 */
export function grossUp(S: Cents, c: PriceChargesInput, tiers: readonly BondTier[] = c.tiers): { P: Cents; q: Cents; windowHi: Cents; k12: bigint } {
  assertCents(S, 'S');
  validateTiers(tiers);
  const k12 = marginalChargeRate12(c, tiers);
  if (k12 >= M12) refuse('NO_FIXED_POINT', 'marginal charge rate m_dur*r_max + f must be below 100%');
  const hi0 = ((BigInt(S) + 1n) * M12) / (M12 - k12) + 2n;
  const windowHi = toCents(hi0, 'gross-up window');
  let lo = BigInt(S), hi = hi0;
  const ok = (x: bigint): boolean => x - BigInt(priceBasedCharge(toCents(x), c, tiers)) >= BigInt(S);
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (ok(mid)) hi = mid;
    else lo = mid + 1n;
  }
  const P = toCents(lo, 'P');
  const q = priceBasedCharge(P, c, tiers);
  if (BigInt(P) - BigInt(q) !== BigInt(S)) refuse('NO_FIXED_POINT', `gross-up did not reach P - q(P) = S (P=${P}, q=${q}, S=${S})`);
  return { P, q, windowHi, k12 };
}

/**
 * m_dur = 10^6 + s1*max(0, min(Mo, M2) - M1) + s2*max(0, Mo - M2), ppm (spec 2.13, D-39).
 * Mo = whole months, part months rounded up by the caller (A-6). Requires M2 >= M1.
 */
export function durationMultiplierPpm(Mo: number, M1: number, M2: number, s1Ppm: Ppm, s2Ppm: Ppm): Ppm {
  assertInt(Mo, 'Mo months');
  assertInt(M1, 'M1');
  assertInt(M2, 'M2');
  if (M2 < M1) refuse('OUT_OF_RANGE', 'duration surcharge needs M2 >= M1');
  assertPpm(s1Ppm, 's1');
  assertPpm(s2Ppm, 's2');
  const a = Math.max(0, Math.min(Mo, M2) - M1), b = Math.max(0, Mo - M2);
  return toPpm(M6 + BigInt(s1Ppm) * BigInt(a) + BigInt(s2Ppm) * BigInt(b), 'm_dur');
}

// ---------------------------------------------------------------- spec 2.14, 2.15

/** P_bid = ceil(P / unit) * unit, upward only (spec 2.14). */
export function bidRounding(P: Cents, unit: Cents): Cents {
  assertCents(P, 'P');
  assertInt(unit, 'bid rounding unit', 1);
  return toCents(divCeil(BigInt(P), BigInt(unit)) * BigInt(unit), 'P_bid');
}

export interface ItemPrice {
  readonly id: string;
  readonly directCost: Cents;
  readonly indirect: Cents;
  readonly price: Cents;
}

/** indirect_item = allocate(P_bid - sum DC_item, DC_item); items sum to P_bid exactly (spec 2.15). */
export function distributeIndirects(Pbid: Cents, items: readonly BidItem[]): { indirectTotal: Cents; items: ItemPrice[] } {
  assertCents(Pbid, 'P_bid');
  if (!items.length) refuse('NO_WEIGHTS', 'no bid items');
  const dc = items.map((i) => assertCents(i.directCost, `item ${i.id} direct cost`));
  const indirectTotal = toCents(BigInt(Pbid) - sumB(dc), 'indirect total (item direct costs exceed the bid price)');
  const parts = allocate(indirectTotal, dc);
  return {
    indirectTotal,
    items: items.map((it, i) => ({
      id: it.id,
      directCost: dc[i]!,
      indirect: parts[i]!,
      price: toCents(BigInt(dc[i]!) + BigInt(parts[i]!)),
    })),
  };
}

// ---------------------------------------------------------------- the whole build-up

export interface BidTotals {
  readonly L: Cents; // 2.4 burdened direct labor
  readonly G: Cents; // cash wages
  readonly H: HoursC; // labor hours
  readonly ST: Cents; // 2.5
  readonly MAT: Cents; // 2.6
  readonly E: Cents; // 2.7
  readonly SUB: Cents; // 2.8
  readonly JOOH: Cents; // 2.9
  readonly ESC_L: Cents; // 2.10
  readonly DC0: Cents;
  readonly CONT: Cents;
  readonly TJC: Cents;
  readonly OH: Cents; // 2.11
  readonly BE: Cents;
  readonly PR: Cents; // 2.12 profit before bid rounding
  readonly FIN: Cents;
  readonly S: Cents; // price before price-based charges
  readonly q: Cents; // 2.13 charges at P
  readonly premium: Cents;
  readonly otherCharges: Cents;
  readonly P: Cents; // P - q(P) = S
  readonly Pbid: Cents; // 2.14 (= P without rounding)
  /** Charges recomputed at P_bid (they are priced on the contract price actually bid). */
  readonly qBid: Cents;
  /** P_bid - P, split into the profit increase and the extra charges at P_bid. */
  readonly roundingDelta: Cents;
  readonly roundingToProfit: Cents;
  readonly roundingToCharges: Cents;
  /** Profit line as bid: PR + roundingToProfit. */
  readonly profitAsBid: Cents;
}

export interface BidBreakdown {
  readonly totals: BidTotals;
  readonly lines: readonly Line[]; // every line in build-up order
  readonly labor: LaborResult;
  readonly materials: MaterialsResult;
  readonly bondApplied: boolean;
  readonly fixedPoint: { readonly k12: bigint; readonly windowHi: Cents };
  readonly items?: { readonly indirectTotal: Cents; readonly items: readonly ItemPrice[] };
  readonly assumptions: readonly AssumptionUsed[];
  readonly warnings: readonly string[];
}

/** Full build-up from takeoff to bid price (spec 2). Pure: same input, same output. */
export function buildBid(input: BidInput): BidBreakdown {
  const lines: Line[] = [];
  const assumptions: AssumptionUsed[] = [];
  const warnings: string[] = [];
  const total = (key: string, label: string, amount: Cents, formula: string, rounding: Line['rounding'] = 'sum-of-rounded'): Cents => {
    lines.push({ key, label, amount, formula, rounding });
    return amount;
  };

  // 2.2-2.4 labor
  const labor = laborCost(input.labor);
  assumptions.push(...labor.assumptions);
  warnings.push(...labor.warnings);
  for (const c of labor.classes) lines.push(...c.lines, { key: `labor.${c.id}.L`, label: `Burdened labor ${c.id}`, amount: c.L, formula: '2.4 L_k = G+SS+MED+FUTA+SUTA+MBT+WC+GLp+FR+TR+OTH', rounding: 'sum-of-rounded' });
  if (input.startDate && input.endDate && input.startDate.slice(0, 4) !== input.endDate.slice(0, 4)) {
    const years = new Set(input.labor.classes.map((c) => c.taxYear));
    if (years.size === 1) warnings.push('job spans a year end but all wages use one tax year: split hours by year (spec 2.3)');
  }
  const L = total('L', 'Burdened direct labor', labor.L, '2.4 L = sum L_k');

  // 2.5 small tools
  let st = input.smallToolsPpm;
  if (st === undefined) {
    st = A18_SMALL_TOOLS_PPM;
    assumptions.push({ id: 'A-18', text: 'small tools 2% of burdened direct labor L (D-66; base is our reading)', value: '20,000 ppm on L' });
  }
  assertPpm(st, 'small tools st', 0, 200_000);
  const ST = mulRate(L, st);
  lines.push({ key: 'ST', label: 'Small tools and consumables', amount: ST, formula: '2.5 ST = mulRate(L, st)', base: { name: 'L', amount: L, unit: 'cents' }, rate: { value: st, unit: 'ppm' }, rounding: 'once-half-up', ...(input.smallToolsPpm === undefined ? { assumption: 'A-18' } : {}) });

  // 2.6 materials
  const materials = materialLines(input.materials);
  assumptions.push(...materials.assumptions);
  lines.push(...materials.breakdown);
  const MAT = total('MAT', 'Materials', materials.MAT, '2.6 MAT = M + ESC_M + TAX + FRT');

  // 2.7-2.9
  const eq = equipmentCost(input.equipment);
  lines.push(...eq.lines);
  const E = total('E', 'Equipment', eq.E, '2.7 E = sum lines');
  const sub = subcontractCost(input.subcontracts);
  lines.push(...sub.lines);
  const SUB = total('SUB', 'Subcontracts', sub.SUB, '2.8 SUB = sum quotes');
  const jo = jobOverheadCost(input.jobOverhead);
  lines.push(...jo.lines);
  const JOOH = total('JOOH', 'Job (field) overhead', jo.JOOH, '2.9 JOOH = sum items');

  // 2.10 labor escalation, contingency, TJC
  const eL = input.laborEscalationPpm ?? (0 as Ppm);
  assertPpm(eL, 'labor escalation e_L');
  const Gns = toCents(sumB(labor.classes.filter((_, i) => !input.labor.classes[i]!.wageScheduled).map((c) => c.wages.G)));
  const ESC_L = mulRate(Gns, eL);
  if (eL > 0) lines.push({ key: 'ESC_L', label: 'Labor escalation', amount: ESC_L, formula: '2.10 ESC_L = mulRate(G_notScheduled, e_L)', base: { name: 'G_notScheduled', amount: Gns, unit: 'cents' }, rate: { value: eL, unit: 'ppm' }, rounding: 'once-half-up' });
  const DC0 = total('DC0', 'Direct cost before contingency', toCents(sumB([L, ST, MAT, E, SUB, JOOH, ESC_L]), 'DC0'), '2.10 DC0 = L + ST + MAT + E + SUB + JOOH + ESC_L');
  let c = input.contingencyPpm;
  if (c === undefined) {
    c = A19_CONTINGENCY_PPM;
    assumptions.push({ id: 'A-19', text: 'contingency 0 (a bid from finished plans carries no design contingency)', value: '0 ppm' });
  }
  assertPpm(c, 'contingency c', 0, 500_000);
  const CONT = mulRate(DC0, c);
  lines.push({ key: 'CONT', label: 'Contingency', amount: CONT, formula: '2.10 CONT = mulRate(DC0, c)', base: { name: 'DC0', amount: DC0, unit: 'cents' }, rate: { value: c, unit: 'ppm' }, rounding: 'once-half-up', ...(input.contingencyPpm === undefined ? { assumption: 'A-19' } : {}) });
  const TJC = total('TJC', 'Total job cost', toCents(BigInt(DC0) + BigInt(CONT), 'TJC'), '2.10 TJC = DC0 + CONT');

  // 2.11 overhead, break-even
  const oh = homeOfficeOverhead(input.overhead, TJC, L, labor.G, labor.H);
  lines.push(...oh.lines);
  const OH = oh.OH;
  if (oh.lines.length > 1 && input.overhead.method === 'dual') total('OH', 'Home-office overhead', OH, '2.11 OH = OH_L + OH_M');
  const BE = total('BE', 'Break-even before price-based charges', toCents(BigInt(TJC) + BigInt(OH), 'BE'), '2.11 BE = TJC + OH');

  // 2.12 profit
  let PR: Cents;
  if (input.overhead.method === 'on_sales') {
    if (!('fromOverheadOnSales' in input.profit)) refuse('BAD_INPUT', "method 'on_sales' sets profit through m_s: pass profit { fromOverheadOnSales: true }");
    PR = oh.PR!;
    lines.push({ key: 'PR', label: 'Profit', amount: PR, formula: '2.11 PR = S0 - TJC - OH (on_sales)', rounding: 'exact' });
  } else {
    if (!('rate' in input.profit)) refuse('BAD_INPUT', 'profit p_c on cost + overhead is required (no default, A-7)');
    const p = requireBase(input.profit.rate, ['on_cost'], 'profit p_c');
    assertPpm(p.ppm, 'profit p_c', 0, 1_000_000);
    PR = mulRate(BE, p.ppm);
    lines.push({ key: 'PR', label: 'Profit', amount: PR, formula: '2.12 PR = mulRate(BE, p_c), BE = TJC + OH', base: { name: 'BE', amount: BE, unit: 'cents' }, rate: { value: p.ppm, unit: 'ppm' }, rounding: 'once-half-up' });
  }
  const SnoFin = toCents(BigInt(BE) + BigInt(PR), 'S without FIN');

  // charges: decide whether the bond tiers apply (spec 2.13 'auto')
  const ch = input.charges;
  validateTiers(ch.tiers);
  let tiers = ch.tiers;
  let bondApplied = ch.tiers.length > 0;
  if (ch.bondRequiredAuto) {
    const pNoBond = grossUp(SnoFin, ch, []).P;
    bondApplied = ch.bondRequiredAuto(pNoBond);
    if (!bondApplied) tiers = [];
  }

  // 2.12 financing (one pass at the price without FIN, A-20)
  let FIN = 0 as Cents;
  const fin = input.financing;
  if (fin.include) {
    FIN = 'amount' in fin ? assertCents(fin.amount, 'FIN') : assertCents(fin.compute(SnoFin, grossUp(SnoFin, ch, tiers).P), 'FIN');
    lines.push({ key: 'FIN', label: 'Financing (approximation: one pass)', amount: FIN, formula: '2.12 FIN from 5.6 at the price without FIN', rounding: 'exact', assumption: 'A-20' });
    assumptions.push({ id: 'A-20', text: 'financing cost placed after profit, computed in one pass', value: `${FIN} cents` });
  }
  const S = total('S', 'Price before price-based charges', toCents(BigInt(SnoFin) + BigInt(FIN), 'S'), '2.12 S = BE + PR + FIN');

  // 2.13 fixed point
  const gu = grossUp(S, ch, tiers);
  const split = chargeSplit(gu.P, ch, tiers);
  lines.push({ key: 'q', label: 'Price-based charges (bond, fees)', amount: split.q, formula: '2.13 q(P) = round(m_dur*tier(P) + f*P*10^6, 10^12); P - q(P) = S', base: { name: 'P', amount: gu.P, unit: 'cents' }, rounding: 'fixed-point' });
  const P = total('P', 'Bid price', gu.P, '2.13 smallest P with P - q(P) >= S (exact: P - q(P) = S)', 'fixed-point');

  // 2.14 optional rounding; charges recomputed at P_bid (see spec issues)
  let Pbid = P, qBid = split.q;
  if (input.bidRoundingUnit !== undefined) {
    Pbid = bidRounding(P, input.bidRoundingUnit);
    qBid = priceBasedCharge(Pbid, ch, tiers);
  }
  const roundingDelta = toCents(BigInt(Pbid) - BigInt(P));
  const roundingToCharges = toCents(BigInt(qBid) - BigInt(split.q), 'extra charges at P_bid');
  const roundingToProfit = toCents(BigInt(roundingDelta) - BigInt(roundingToCharges), 'bid rounding to profit');
  if (input.bidRoundingUnit !== undefined) {
    lines.push({ key: 'roundingToProfit', label: 'Bid rounding added to profit', amount: roundingToProfit, formula: '2.14 (P_bid - q(P_bid)) - S', rounding: 'ceil-to-unit' });
    if (roundingToCharges > 0) lines.push({ key: 'roundingToCharges', label: 'Extra price-based charges at the rounded price', amount: roundingToCharges, formula: '2.14 q(P_bid) - q(P)', rounding: 'fixed-point' });
    total('Pbid', 'Bid price, rounded', Pbid, '2.14 P_bid = ceil(P/unit)*unit', 'ceil-to-unit');
  }
  const profitAsBid = toCents(BigInt(PR) + BigInt(roundingToProfit));

  // 2.15 items
  const items = input.bidItems && input.bidItems.length ? distributeIndirects(Pbid, input.bidItems) : undefined;

  return {
    totals: {
      L, G: labor.G, H: labor.H, ST, MAT, E, SUB, JOOH, ESC_L, DC0, CONT, TJC, OH, BE, PR, FIN, S,
      q: split.q, premium: split.premium, otherCharges: split.otherCharges, P, Pbid, qBid,
      roundingDelta, roundingToProfit, roundingToCharges, profitAsBid,
    },
    lines,
    labor,
    materials,
    bondApplied,
    fixedPoint: { k12: gu.k12, windowHi: gu.windowHi },
    ...(items ? { items } : {}),
    assumptions: dedupe(assumptions),
    warnings: [...new Set(warnings)],
  };
}

function dedupe(a: AssumptionUsed[]): AssumptionUsed[] {
  const seen = new Set<string>();
  return a.filter((x) => {
    const k = `${x.id}|${x.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
