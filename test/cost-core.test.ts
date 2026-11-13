// Spec section 10 invariants for sections 0 to 3, as fast-check properties.
// Test plan 10.0: pinned seed, 1,000 runs per property on pull requests (the differential test,
// invariant 20, samples a few hundred cases: it is slow by design). Never Math.random, never fc.float for money.
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import {
  allocate,
  annualEmployerTaxes,
  bidRounding,
  buildBid,
  caElectricalClass,
  cappedShare,
  cappedTaxExact,
  classWages,
  compositeRateFlat,
  costBasisToSalesBasis,
  davisBaconOvertimeLaw,
  davisBaconWeekPay,
  distributeIndirects,
  divRound,
  divRoundHalfUp,
  dualOverheadRates,
  durationMultiplierPpm,
  effRate,
  extend,
  grossUp,
  homeOfficeOverhead,
  laborCost,
  laborHourOverheadRate,
  marginToMarkup,
  markupToMargin,
  materialLines,
  mbtQuarter,
  mulHours,
  mulRate,
  nevadaSalesTaxProcedure,
  nvPrivateDailyOvertimeApplies,
  overheadRecovery,
  overtimePremiumRatio,
  partitionHours,
  priceBasedCharge,
  priceFromMargin,
  priceFromMarkup,
  profitAtRevenue,
  breakEvenRevenue,
  prevailingWageCheck,
  rAdd,
  rCmp,
  rEq,
  rMul,
  rSub,
  ratio,
  fromPpm,
  salesBasisToCostBasis,
  stackMultipliers,
  tierMicro,
  workersComp,
  ytdTaxableSlice,
  CostEngineError,
  type BidInput,
  type BondTier,
  type Cents,
  type HoursC,
  type LaborClassInput,
  type Line,
  type OtRegime,
  type PayrollTaxTable,
  type Ppm,
  type PriceChargesInput,
  type QtyM,
  type Ratio,
} from '../src/cost/index.js';

const SEED = 20_261_113;
const RUNS = 1_000;
fc.configureGlobal({ seed: SEED, numRuns: RUNS });

const c = (n: number) => n as Cents;
const p = (n: number) => n as Ppm;
const h = (n: number) => n as HoursC;
const M6 = 1_000_000n;
const M12 = 1_000_000_000_000n;

// bounded generators (10.0: the unbounded default stops near $21.47 million)
const arbCents = (max = 100_000_000_000) => fc.integer({ min: 0, max }).map(c);
const arbPpm = (max = 1_000_000) => fc.integer({ min: 0, max }).map(p);
const R = (n: bigint | number, d: bigint | number = 1n): Ratio => ratio(BigInt(n), BigInt(d));
const absR = (a: Ratio): Ratio => (a.num < 0n ? ratio(-a.num, a.den) : a);
const le = (a: Ratio, b: Ratio) => rCmp(a, b) <= 0;

// Fixtures duplicated from cost-golden-core.test.ts (importing a test file would re-run its tests here).
// ---------------------------------------------------------------- dated public tables (spec 8.1), test fixtures
const IRS_751 = 'https://www.irs.gov/taxtopics/tc751';
const IRS_759 = 'https://www.irs.gov/taxtopics/tc759';
const NV_UI = 'https://detr.nv.gov/Page/UI_Tax';
const NV_MBT = 'https://tax.nv.gov/tax-types/modified-business-tax/';
const CA_EDD = 'https://edd.ca.gov/en/payroll_taxes/rates_and_withholding/';
function nvTable(year: number, ssBase: number, uiBase: number, cr: number | null, final: boolean): PayrollTaxTable {
  return {
    year,
    state: 'NV',
    sources: [IRS_751, IRS_759, NV_UI, NV_MBT, 'https://www.ssa.gov/oact/cola/cbb.html'],
    effective: `calendar year ${year}`,
    socialSecurity: { ratePpm: p(62_000), wageBase: c(ssBase) }, // D-1, D-2
    medicare: { ratePpm: p(14_500) }, // D-3
    futa: { netRatePpm: p(6_000), wageBase: c(700_000), creditReductionPpm: cr === null ? null : p(cr), creditReductionFinal: final }, // D-4, D-5, A-9
    stateUnemployment: {
      wageBase: c(uiBase), // D-6
      ratePpmMin: p(2_500),
      ratePpmMax: p(54_000), // D-7
      surchargePpm: p(500), // D-8 CEP
      surchargeLabel: 'Career Enhancement Program',
      surchargeExemptAtRatePpm: p(54_000),
    },
    mbt: { ratePpm: p(11_700), quarterlyExemptWages: c(5_000_000) }, // D-9
  };
}
const NV2025 = nvTable(2025, 17_610_000, 4_180_000, 0, false);
const NV2026 = nvTable(2026, 18_450_000, 4_370_000, 0, false); // A-9: Nevada 0 with a warning
const NV2027 = nvTable(2027, 19_230_000, 4_540_000, null, false); // A-34: rates unchanged, CR entered
const CA2026: PayrollTaxTable = {
  year: 2026,
  state: 'CA',
  sources: [IRS_751, IRS_759, CA_EDD],
  effective: 'calendar year 2026',
  socialSecurity: { ratePpm: p(62_000), wageBase: c(18_450_000) },
  medicare: { ratePpm: p(14_500) },
  futa: { netRatePpm: p(6_000), wageBase: c(700_000), creditReductionPpm: null, creditReductionFinal: false }, // A-9: must be entered
  stateUnemployment: {
    wageBase: c(700_000), // D-10
    ratePpmMin: p(15_000),
    ratePpmMax: p(62_000),
    surchargePpm: p(1_000), // D-11 ETT
    surchargeLabel: 'ETT',
    surchargeExemptAtRatePpm: null,
  },
};

// D-38 sample Class B schedule (illustrative, A-1), corrected fifth tier.
const CLASS_B: BondTier[] = [
  { upperBound: c(10_000_000), ratePpm: p(25_000) },
  { upperBound: c(50_000_000), ratePpm: p(15_000) },
  { upperBound: c(250_000_000), ratePpm: p(10_000) },
  { upperBound: c(500_000_000), ratePpm: p(7_500) },
  { upperBound: c(750_000_000), ratePpm: p(7_000) },
  { upperBound: null, ratePpm: p(6_500) },
];
const CLASS_B_PRINTED = CLASS_B.map((t, i) => (i === 4 ? { ...t, ratePpm: p(7_500) } : t));
const charges = (tiers: BondTier[], mDur = 1_000_000, fees: number[] = []): PriceChargesInput => ({
  tiers,
  mDurPpm: p(mDur),
  fees: fees.map((f, i) => ({ label: `fee${i}`, rate: { ppm: p(f), base: 'on_price' as const } })),
});

const cls = (o: Partial<LaborClassInput> & { id: string }): LaborClassInput => ({
  h10: h(0), h15: h(0), h20: h(0), wBasic: c(1), wCil: c(0), fPlan: c(0), fHealth: c(0), travelPerHour: c(0), otherPerHour: c(0),
  taxYear: 2026, wcRatePpm: p(0), ...o,
});

// ---------------------------------------------------------------- I-1: one Nevada job, end to end
function i1Input(): BidInput {
  return {
    labor: {
      regime: 'NV_PRIVATE',
      stateOfWork: 'NV',
      burdenMode: 'statutory',
      classes: [
        cls({ id: 'journeyman', h10: h(16_000), h15: h(800), wBasic: c(4_500), fPlan: c(400), fHealth: c(400), annualTaxableWages: c(9_000_000), wcRatePpm: p(25_000) }),
        cls({ id: 'apprentice', h10: h(12_000), wBasic: c(2_400), fPlan: c(400), fHealth: c(400), annualTaxableWages: c(4_800_000), wcRatePpm: p(25_000) }),
      ],
      payrollTables: { 2026: NV2026 },
      stateUiRatePpm: p(29_500), // D-7 new-employer rate (labelled)
      mbt: { mode: 'marginal', quarterlyGrossWages: c(12_000_000), quarterlyHealthDeduction: c(1_000_000) }, // firm over the threshold
      workersComp: { xModPpm: p(1_000_000), otherModsPpm: p(1_000_000), excludeOtPremium: false, payrollCap: c(9_843_360) }, // D-12, D-13
    },
    smallToolsPpm: p(20_000),
    materials: {
      lines: [
        { id: 'wire', quantity: 2_400_000 as QtyM, unitPrice: c(185), wastePpm: p(50_000), escalationPpm: p(9_759) },
        { id: 'conduit', quantity: 600_000 as QtyM, unitPrice: c(340), wastePpm: p(30_000) },
        { id: 'gear', quantity: 1_000 as QtyM, unitPrice: c(680_000), wastePpm: p(0) },
        { id: 'fixtures', quantity: 24_000 as QtyM, unitPrice: c(18_500), wastePpm: p(0) },
      ],
      freight: c(35_000),
      freightTaxable: false,
      salesTaxPpm: p(71_000),
    },
    equipment: [{ id: 'lift', kind: 'lump', amount: c(65_000) }],
    subcontracts: [{ id: 'trenching', amount: c(320_000) }],
    jobOverhead: [
      { id: 'permit', kind: 'once', amount: c(42_000) },
      { id: 'supervision', kind: 'hours', hours: h(1_200), rate: c(6_500) },
      { id: 'mobilization', kind: 'once', amount: c(30_000) },
      { id: 'cleanup', kind: 'once', amount: c(15_000) },
    ],
    contingencyPpm: p(0),
    overhead: { method: 'on_cost', rate: { ppm: p(150_000), base: 'on_cost' } },
    profit: { rate: { ppm: p(100_000), base: 'on_cost' } },
    financing: { include: false },
    charges: charges([], 1_000_000, [6_000]), // GL $6.00 per $1,000 of receipts
  };
}

function expectRefusal(fn: () => unknown): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(RangeError);
}


// ================================================================ 10.1 money primitives
describe('10.1 money primitives', () => {
  test('invariant 1: divRoundHalfUp is nearest with ties up and equals the exact-fraction rounding', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1n << 90n }), fc.bigInt({ min: 1n, max: 1n << 70n }), (n, d) => {
        const q = divRoundHalfUp(n, d);
        const e = 2n * (q * d - n);
        expect(e <= d && -e <= d).toBe(true);
        if (2n * (n % d) === d) expect(q * d > n).toBe(true);
        expect(q).toBe((2n * n + d) / (2n * d)); // floor(n/d + 1/2), independent form
      }),
    );
  });
  test('invariant 1 (half-even is available as a named mode, D-63)', () => {
    expect(divRound(98_450n, 100n, 'half-even')).toBe(984n);
    expect(divRound(98_550n, 100n, 'half-even')).toBe(986n);
  });
  test('invariant 2: mulRate(x, 100%) = x', () => {
    fc.assert(fc.property(arbCents(), (x) => {
      expect(mulRate(x, p(1_000_000))).toBe(x);
    }));
  });
  test('invariant 3: mulRate monotone in the amount and 0 <= mulRate(a, r) <= a for r <= 100%', () => {
    fc.assert(
      fc.property(arbCents(), arbCents(), arbPpm(), (a0, b0, r) => {
        const [a, b] = a0 <= b0 ? [a0, b0] : [b0, a0];
        expect(mulRate(a, r)).toBeLessThanOrEqual(mulRate(b, r));
        expect(mulRate(a, r)).toBeGreaterThanOrEqual(0);
        expect(mulRate(a, r)).toBeLessThanOrEqual(a);
      }),
    );
  });
  test('invariant 4: |mulRate(a+b) - mulRate(a) - mulRate(b)| <= 1 cent', () => {
    fc.assert(fc.property(arbCents(), arbCents(), arbPpm(), (a, b, r) => {
      expect(Math.abs(mulRate(c(a + b), r) - mulRate(a, r) - mulRate(b, r))).toBeLessThanOrEqual(1);
    }));
  });
  test('invariant 5: the Nevada truncate-then-round procedure equals mulRate', () => {
    fc.assert(fc.property(arbCents(), arbPpm(150_000), (x, s) => {
      expect(nevadaSalesTaxProcedure(x, s)).toBe(mulRate(x, s));
    }));
  });
  test('invariant 6: per-line versus total rounding differs by at most floor(n/2)', () => {
    fc.assert(
      fc.property(fc.array(arbCents(1_000_000_000), { minLength: 1, maxLength: 40 }), arbPpm(), (xs, r) => {
        const perLine = xs.reduce((a, x) => a + mulRate(x, r), 0);
        const whole = mulRate(c(xs.reduce((a, x) => a + x, 0)), r);
        expect(Math.abs(perLine - whole)).toBeLessThanOrEqual(Math.floor(xs.length / 2));
      }),
    );
  });
  const arbWeights = fc.array(fc.integer({ min: 0, max: 100_000_000_000 }), { minLength: 1, maxLength: 12 }).filter((w) => w.some((x) => x > 0));
  test('invariant 7: allocate parts sum to T exactly', () => {
    fc.assert(fc.property(arbCents(), arbWeights, (T, w) => {
      expect(allocate(T, w).reduce((a, b) => a + b, 0)).toBe(T);
    }));
  });
  test('invariant 8: each part within 1 cent of its exact share; zero weight gets zero; none negative', () => {
    fc.assert(
      fc.property(arbCents(), arbWeights, (T, w) => {
        const W = w.reduce((a, b) => a + BigInt(b), 0n);
        allocate(T, w).forEach((part, i) => {
          const diff = absR(rSub(R(part), R(BigInt(T) * BigInt(w[i]!), W)));
          expect(rCmp(diff, R(1)) < 0).toBe(true);
          if (w[i] === 0) expect(part).toBe(0);
          expect(part).toBeGreaterThanOrEqual(0);
        });
      }),
    );
  });
  test('invariant 9: largest remainder, ties to the lowest index, equals a one-cent-at-a-time oracle', () => {
    fc.assert(
      fc.property(arbCents(1_000_000), fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 8 }).filter((w) => w.some((x) => x > 0)), (T, w) => {
        // oracle: start from floors, then hand out one cent at a time to the not-yet-topped line with the largest remainder
        const W = BigInt(w.reduce((a, b) => a + b, 0));
        const share = w.map((x) => R(BigInt(T) * BigInt(x), W));
        const out = share.map((s) => s.num / s.den);
        const topped = w.map(() => false);
        let left = BigInt(T) - out.reduce((a, b) => a + b, 0n);
        while (left > 0n) {
          let best = -1;
          for (let i = 0; i < w.length; i++) {
            if (topped[i]) continue;
            const ri = rSub(share[i]!, R(share[i]!.num / share[i]!.den));
            if (best < 0 || rCmp(ri, rSub(share[best]!, R(share[best]!.num / share[best]!.den))) > 0) best = i;
          }
          out[best] = out[best]! + 1n;
          topped[best] = true;
          left -= 1n;
        }
        expect(allocate(T, w)).toEqual(out.map(Number));
      }),
    );
  });
  test('invariant 10: refusals throw RangeError; nothing returns NaN, infinity or a fraction', () => {
    expectRefusal(() => mulRate(c(-1), p(1)));
    expectRefusal(() => mulRate(c(1.5), p(1)));
    expectRefusal(() => mulRate(c(Number.NaN), p(1)));
    expectRefusal(() => divRoundHalfUp(1n, 0n));
    expectRefusal(() => divRoundHalfUp(1n, -3n));
    expectRefusal(() => allocate(c(10), [0, 0]));
    expectRefusal(() => allocate(c(10), [1, -1]));
    expectRefusal(() => mulRate(c(Number.MAX_SAFE_INTEGER), p(2_000_000))); // result outside the safe range
    expectRefusal(() => extend(1 as QtyM, p(-1), c(1)));
    // a rate without a base tag
    const bad = { ...i1Input(), overhead: { method: 'on_cost', rate: { ppm: p(150_000) } } } as unknown as BidInput;
    expectRefusal(() => buildBid(bad));
    const wrongTag = { ...i1Input(), overhead: { method: 'on_cost', rate: { ppm: p(150_000), base: 'on_sales' } } } as unknown as BidInput;
    expectRefusal(() => buildBid(wrongTag));
    fc.assert(
      fc.property(arbCents(), arbPpm(), fc.integer({ min: 0, max: 10_000_000 }).map(h), (x, r, hh) => {
        for (const v of [mulRate(x, r), mulHours(hh, c(x % 1_000_000)), effRate(r, c(x + 1), c(700_000))]) expect(Number.isSafeInteger(v) && v >= 0).toBe(true);
      }),
    );
    expect(new CostEngineError('X', 'y')).toBeInstanceOf(RangeError);
  });
  test('invariant 11: allocate works for any safe-integer total, e.g. $1,000,000.00 over $950,000.00 and $50,000.00', () => {
    expect(allocate(c(100_000_000), [95_000_000, 5_000_000])).toEqual([95_000_000, 5_000_000]);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }).map(c), fc.array(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), { minLength: 1, maxLength: 5 }), (T, w) => {
        expect(allocate(T, w).reduce((a, b) => a + BigInt(b), 0n)).toBe(BigInt(T));
      }),
    );
  });
});

// ================================================================ bid generator (shared by 10.1 #12, 10.4, 10.5)
const arbTiers: fc.Arbitrary<BondTier[]> = fc
  .tuple(fc.uniqueArray(fc.integer({ min: 1, max: 2_000_000_000 }), { maxLength: 4 }), fc.array(fc.integer({ min: 0, max: 40_000 }), { minLength: 5, maxLength: 5 }), fc.boolean())
  .map(([bounds, rates, on]) => {
    if (!on) return [];
    const b = [...bounds].sort((x, y) => x - y);
    return [...b.map((u, i) => ({ upperBound: c(u), ratePpm: p(rates[i]!) })), { upperBound: null, ratePpm: p(rates[b.length]!) }];
  });

interface BidKnobs {
  flat: boolean;
  tiers: BondTier[];
}
function arbBid(opts: { tiers?: boolean; flat?: boolean; statutory?: boolean } = {}): fc.Arbitrary<BidInput & { _knobs: BidKnobs }> {
  const arbClass = (id: string) =>
    fc.record({
      h10: fc.integer({ min: 0, max: 500_000 }),
      h15: fc.integer({ min: 0, max: 50_000 }),
      wBasic: fc.integer({ min: 1_200, max: 12_000 }),
      wCil: fc.integer({ min: 0, max: 3_000 }),
      fPlan: fc.integer({ min: 0, max: 3_000 }),
      travel: fc.integer({ min: 0, max: 1_000 }),
      W: fc.integer({ min: 100_000, max: 40_000_000 }),
      wc: fc.integer({ min: 0, max: 200_000 }),
    }).map((r) =>
      cls({ id, h10: h(r.h10), h15: h(r.h15), wBasic: c(r.wBasic), wCil: c(r.wCil), fPlan: c(r.fPlan), fHealth: c(Math.floor(r.fPlan / 2)), travelPerHour: c(r.travel), annualTaxableWages: c(r.W), wcRatePpm: p(r.wc) }),
    );
  const arbMat = (id: string) =>
    fc.record({ q: fc.integer({ min: 0, max: 50_000_000 }), unit: fc.integer({ min: 0, max: 500_000 }), waste: fc.integer({ min: 0, max: 500_000 }), taxable: fc.boolean(), esc: fc.integer({ min: 0, max: 200_000 }) }).map((m) => ({
      id, quantity: m.q as QtyM, unitPrice: c(m.unit), wastePpm: p(m.waste), taxable: m.taxable, escalationPpm: p(m.esc),
    }));
  return fc
    .record({
      classes: fc.tuple(arbClass('k0'), arbClass('k1')),
      flat: opts.flat !== undefined ? fc.constant(opts.flat) : opts.statutory ? fc.constant(false) : fc.boolean(),
      bFlat: arbPpm(600_000),
      ui: fc.integer({ min: 2_500, max: 54_000 }),
      mats: fc.tuple(arbMat('m0'), arbMat('m1'), arbMat('m2')),
      freight: arbCents(1_000_000),
      s: arbPpm(150_000),
      equip: arbCents(5_000_000),
      eqHours: fc.integer({ min: 0, max: 100_000 }),
      eqRate: arbCents(50_000),
      sub: arbCents(50_000_000),
      jooh: arbCents(5_000_000),
      supH: fc.integer({ min: 0, max: 50_000 }),
      st: arbPpm(200_000),
      cont: arbPpm(500_000),
      oh: arbPpm(400_000),
      pr: arbPpm(300_000),
      fee: arbPpm(30_000),
      tiers: opts.tiers === false ? fc.constant([] as BondTier[]) : arbTiers,
      mDur: fc.integer({ min: 1_000_000, max: 1_300_000 }),
    })
    .map((g) => ({
      labor: {
        regime: 'FLSA' as OtRegime,
        stateOfWork: 'NV',
        burdenMode: g.flat ? ('flat' as const) : ('statutory' as const),
        classes: g.classes,
        payrollTables: { 2026: NV2026 },
        stateUiRatePpm: p(g.ui),
        flatBurdenPpm: g.bFlat,
        workersComp: { xModPpm: p(1_000_000), otherModsPpm: p(1_000_000), excludeOtPremium: false, payrollCap: null },
      },
      smallToolsPpm: g.st,
      materials: { lines: g.mats, freight: g.freight, freightTaxable: false, salesTaxPpm: g.s },
      equipment: [
        { id: 'e0', kind: 'lump' as const, amount: g.equip },
        { id: 'e1', kind: 'hourly' as const, hours: h(g.eqHours), rate: g.eqRate },
      ],
      subcontracts: [{ id: 's0', amount: g.sub }],
      jobOverhead: [
        { id: 'j0', kind: 'once' as const, amount: g.jooh },
        { id: 'j1', kind: 'hours' as const, hours: h(g.supH), rate: c(6_500) },
      ],
      contingencyPpm: g.cont,
      overhead: { method: 'on_cost' as const, rate: { ppm: g.oh, base: 'on_cost' as const } },
      profit: { rate: { ppm: g.pr, base: 'on_cost' as const } },
      financing: { include: false as const },
      charges: { tiers: g.tiers, mDurPpm: p(g.mDur), fees: [{ label: 'GL receipts', rate: { ppm: g.fee, base: 'on_price' as const } }] },
      _knobs: { flat: g.flat, tiers: g.tiers },
    }));
}

/** Spec 3.9 tolerance, as a valid upper bound: 0.5 * (number of roundings) * (largest downstream gain). */
function sBound(input: BidInput, lines: readonly Line[]): Ratio {
  const roundings = lines.filter((l) => l.rounding === 'once-half-up').length + 3 * input.labor.classes.length;
  const one = R(1);
  const rates = input.labor.classes.reduce((m, k) => (k.wcRatePpm > m ? k.wcRatePpm : m), 0);
  const burden = input.labor.burdenMode === 'flat' ? input.labor.flatBurdenPpm! : 62_000 + 14_500 + 6_000 + 54_500 + 11_700;
  const g = [burden + rates, input.smallToolsPpm ?? 20_000, input.materials.salesTaxPpm, input.contingencyPpm ?? 0, (input.overhead as { rate: { ppm: number } }).rate.ppm, (input.profit as { rate: { ppm: number } }).rate.ppm].reduce<Ratio>(
    (a, r) => rMul(a, rAdd(one, fromPpm(r))),
    one,
  );
  return rMul(R(roundings, 2), g);
}
function pBound(input: BidInput, lines: readonly Line[], k12: bigint): Ratio {
  return rAdd(rMul(sBound(input, lines), R(M12, M12 - k12)), R(1));
}

describe('10.1 #12 every total equals the sum of its lines', () => {
  test('invariant 12: reported totals = sums of reported lines; every figure a non-negative safe integer', () => {
    fc.assert(
      fc.property(arbBid(), (input) => {
        const b = buildBid(input);
        const t = b.totals;
        for (const k of b.labor.classes) {
          const parts = k.lines.filter((l) => !l.key.endsWith('.G')).reduce((a, l) => a + l.amount, 0) + k.wages.G;
          expect(parts).toBe(k.L);
          expect(k.wages.wage10 + k.wages.wage15 + k.wages.wage20).toBe(k.wages.G);
        }
        expect(b.labor.classes.reduce((a, k) => a + k.L, 0)).toBe(t.L);
        expect(b.materials.lines.reduce((a, l) => a + l.ext, 0)).toBe(b.materials.M);
        expect(b.lines.filter((l) => /^equipment\./.test(l.key)).reduce((a, l) => a + l.amount, 0)).toBe(t.E);
        expect(b.lines.filter((l) => /^jooh\./.test(l.key)).reduce((a, l) => a + l.amount, 0)).toBe(t.JOOH);
        for (const v of Object.values(t)) if (typeof v === 'number') expect(Number.isSafeInteger(v) && v >= 0).toBe(true);
        for (const l of b.lines) expect(Number.isSafeInteger(l.amount) && l.amount >= 0).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});

// ================================================================ 10.2 tiers and price-based charges
const arbCharges = (maxK = 0.95): fc.Arbitrary<PriceChargesInput> =>
  fc.tuple(arbTiers, fc.integer({ min: 1_000_000, max: 1_500_000 }), arbPpm(100_000)).filter(([t, m, f]) => {
    const rmax = t.reduce((a, x) => Math.max(a, x.ratePpm), 0);
    return (rmax * m) / 1e12 + f / 1e6 < maxK;
  }).map(([tiers, m, f]) => ({ tiers, mDurPpm: p(m), fees: [{ label: 'f', rate: { ppm: f, base: 'on_price' as const } }] }));
const kOf = (ch: PriceChargesInput, pick: 'max' | 'min'): Ratio => {
  const rs = ch.tiers.map((t) => t.ratePpm as number);
  const r = rs.length ? (pick === 'max' ? Math.max(...rs) : Math.min(...rs)) : 0;
  return R(BigInt(r) * BigInt(ch.mDurPpm) + BigInt(ch.fees[0]!.rate.ppm) * M6, M12);
};
describe('10.2 tiers and price-based charges', () => {
  test('invariant 13: q(0) = 0 and 0 <= q(x+d) - q(x) <= ceil(k_max*d) + 1', () => {
    fc.assert(
      fc.property(arbCharges(), arbCents(3_000_000_000), arbCents(500_000_000), (ch, x, d) => {
        expect(priceBasedCharge(c(0), ch)).toBe(0);
        const dq = priceBasedCharge(c(x + d), ch) - priceBasedCharge(x, ch);
        const k = kOf(ch, 'max');
        expect(dq).toBeGreaterThanOrEqual(0);
        const kd = rMul(k, R(d));
        expect(BigInt(dq) <= (kd.num + kd.den - 1n) / kd.den + 1n).toBe(true);
      }),
    );
  });
  test('invariant 14: k_min*x - 1 <= q(x) <= k_max*x + 1', () => {
    fc.assert(
      fc.property(arbCharges(), arbCents(5_000_000_000), (ch, x) => {
        const q = R(priceBasedCharge(x, ch));
        expect(le(rSub(rMul(kOf(ch, 'min'), R(x)), R(1)), q)).toBe(true);
        expect(le(q, rAdd(rMul(kOf(ch, 'max'), R(x)), R(1)))).toBe(true);
      }),
    );
  });
  test('invariant 15: no jump at a breakpoint: q(b+1)-q(b) and q(b)-q(b-1) are 0 or 1', () => {
    fc.assert(
      fc.property(arbCharges(0.999).filter((ch) => ch.tiers.length > 1), (ch) => {
        for (const t of ch.tiers) {
          if (t.upperBound === null || t.upperBound < 1) continue;
          const b = t.upperBound;
          const up = priceBasedCharge(c(b + 1), ch) - priceBasedCharge(c(b), ch);
          const dn = priceBasedCharge(c(b), ch) - priceBasedCharge(c(b - 1), ch);
          expect([0, 1]).toContain(up);
          expect([0, 1]).toContain(dn);
        }
      }),
    );
  });
  test('invariant 16: splitting a tier into two with the same rate changes nothing', () => {
    fc.assert(
      fc.property(arbCharges().filter((ch) => ch.tiers.length > 0), fc.integer({ min: 0, max: 100 }), arbCents(3_000_000_000), (ch, pos, x) => {
        const t = ch.tiers;
        const i = pos % t.length;
        const lower = i === 0 ? 0 : (t[i - 1]!.upperBound as number);
        const upper = t[i]!.upperBound ?? lower + 10_000_000;
        if (upper - lower < 2) return;
        const mid = lower + Math.floor((upper - lower) / 2);
        const split = [...t.slice(0, i), { upperBound: c(mid), ratePpm: t[i]!.ratePpm }, ...t.slice(i)];
        expect(priceBasedCharge(x, { ...ch, tiers: split })).toBe(priceBasedCharge(x, ch));
      }),
    );
  });
  test('invariant 17: non-increasing tier rates: average rate non-increasing, between last and first rate, sub-additive', () => {
    fc.assert(
      fc.property(arbTiers.filter((t) => t.length > 0).map((t) => {
        const rs = t.map((x) => x.ratePpm as number).sort((a, b) => b - a);
        return t.map((x, i) => ({ ...x, ratePpm: p(rs[i]!) }));
      }), fc.integer({ min: 1, max: 3_000_000_000 }), fc.integer({ min: 1, max: 3_000_000_000 }), (t, a, b) => {
        const [x, y] = a <= b ? [a, b] : [b, a];
        const avg = (v: number) => R(tierMicro(c(v), t), BigInt(v));
        expect(le(avg(y), avg(x))).toBe(true);
        expect(le(R(t[t.length - 1]!.ratePpm), avg(x)) && le(avg(x), R(t[0]!.ratePpm))).toBe(true);
        expect(tierMicro(c(x + y), t) <= tierMicro(c(x), t) + tierMicro(c(y), t)).toBe(true);
      }),
    );
  });
  test('invariant 18: m_dur >= 1, non-decreasing in months, exactly 1 for months <= M1', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 36 }), fc.integer({ min: 0, max: 24 }), arbPpm(20_000), arbPpm(20_000), (Mo, M1, dM, s1, s2) => {
        const M2 = M1 + dM;
        const m = durationMultiplierPpm(Mo, M1, M2, s1, s2);
        expect(m).toBeGreaterThanOrEqual(1_000_000);
        expect(durationMultiplierPpm(Mo + 1, M1, M2, s1, s2)).toBeGreaterThanOrEqual(m);
        if (Mo <= M1) expect(m).toBe(1_000_000);
      }),
    );
    expectRefusal(() => durationMultiplierPpm(5, 12, 6, p(1), p(1)));
  });
  test('invariant 19: gross-up P - q(P) = S exactly, P-1 fails, P >= S, strictly increasing in S; throws when k_max >= 1', () => {
    fc.assert(
      fc.property(arbCharges(), arbCents(3_000_000_000), (ch, S) => {
        const { P, q } = grossUp(S, ch);
        expect(P - q).toBe(S);
        expect(P === S || P - 1 - priceBasedCharge(c(P - 1), ch) < S).toBe(true);
        expect(P).toBeGreaterThanOrEqual(S);
        expect(grossUp(c(S + 1), ch).P).toBeGreaterThan(P);
        // fixed-point correctness: recomputing the charge on the returned price reproduces it
        expect(priceBasedCharge(P, ch)).toBe(q);
      }),
    );
    expectRefusal(() => grossUp(c(1000), { tiers: [], mDurPpm: p(1_000_000), fees: [{ label: 'x', rate: { ppm: p(1_000_000), base: 'on_price' } }] }));
    expectRefusal(() => grossUp(c(1000), { tiers: [{ upperBound: null, ratePpm: p(800_000) }], mDurPpm: p(1_300_000), fees: [] }));
  });
  test('invariant 21: one flat rate: P = S/(1-b) within the 3.9 bound, and S*(1+b) <= S/(1-b)', () => {
    fc.assert(
      fc.property(arbCents(3_000_000_000), arbPpm(500_000), (S, b) => {
        const exact = R(BigInt(S) * M6, M6 - BigInt(b));
        const owner = rMul(R(S), rAdd(R(1), fromPpm(b)));
        expect(le(owner, exact)).toBe(true);
        const { P } = grossUp(S, { tiers: [], mDurPpm: p(1_000_000), fees: [{ label: 'b', rate: { ppm: b, base: 'on_price' } }] });
        expect(le(absR(rSub(R(P), exact)), R(1))).toBe(true);
      }),
    );
  });
});

// ================================================================ invariant 20: differential vs a slow exact reference
// Written independently: its own fraction type and rounding, no engine function used inside.
type F = [bigint, bigint];
const fr = (n: bigint, d = 1n): F => [n, d];
const fAdd = (a: F, b: F): F => [a[0] * b[1] + b[0] * a[1], a[1] * b[1]];
const fMul = (a: F, b: F): F => [a[0] * b[0], a[1] * b[1]];
const rnd = (a: F): bigint => {
  // half-up for a >= 0: floor(a + 1/2)
  const n = 2n * a[0] + a[1], d = 2n * a[1];
  return n / d;
};
function refBid(input: BidInput): { DC: bigint; S: bigint; P: bigint } {
  const pp = (x: number): F => fr(BigInt(x), 1_000_000n);
  let L = 0n;
  for (const k of input.labor.classes) {
    const w = BigInt(k.wBasic + k.wCil);
    const g10 = rnd(fMul(fr(BigInt(k.h10), 100n), fr(w))), g15 = rnd(fMul(fr(BigInt(k.h15), 100n), fr(3n * w, 2n)));
    const G = g10 + g15;
    const H = fr(BigInt(k.h10 + k.h15), 100n);
    let tax = 0n;
    if (input.labor.burdenMode === 'flat') tax = rnd(fMul(fr(G), pp(input.labor.flatBurdenPpm!)));
    else {
      const W = BigInt(k.annualTaxableWages!);
      const cap = (rate: F, base: bigint) => rnd(fMul(fMul(fr(G), rate), fr(W < base ? W : base, W)));
      tax = cap(pp(62_000), 18_450_000n) + rnd(fMul(fr(G), pp(14_500))) + cap(pp(6_000), 700_000n) + cap(pp(input.labor.stateUiRatePpm! + (input.labor.stateUiRatePpm === 54_000 ? 0 : 500)), 4_370_000n);
    }
    const wc = rnd(fMul(fr(G), pp(k.wcRatePpm)));
    L += G + tax + wc + rnd(fMul(H, fr(BigInt(k.fPlan)))) + rnd(fMul(H, fr(BigInt(k.travelPerHour)))) + rnd(fMul(H, fr(BigInt(k.otherPerHour))));
  }
  const ST = rnd(fMul(fr(L), pp(input.smallToolsPpm!)));
  let M = 0n, TB = 0n;
  for (const m of input.materials.lines) {
    const ext = rnd(fMul(fMul(fr(BigInt(m.quantity), 1000n), fAdd(fr(1n), pp(m.wastePpm))), fr(BigInt(m.unitPrice))));
    const esc = rnd(fMul(fr(ext), pp(m.escalationPpm ?? 0)));
    M += ext + esc;
    if (m.taxable !== false) TB += ext + esc;
  }
  const MAT = M + rnd(fMul(fr(TB), pp(input.materials.salesTaxPpm))) + BigInt(input.materials.freight);
  let E = 0n;
  for (const e of input.equipment) E += e.kind === 'lump' ? BigInt(e.amount) : rnd(fMul(fr(BigInt(e.hours), 100n), fr(BigInt(e.rate))));
  let J = 0n;
  for (const j of input.jobOverhead) J += j.kind === 'once' ? BigInt(j.amount) : j.kind === 'hours' ? rnd(fMul(fr(BigInt(j.hours), 100n), fr(BigInt(j.rate)))) : 0n;
  const SUB = input.subcontracts.reduce((a, s) => a + BigInt(s.amount), 0n);
  const DC0 = L + ST + MAT + E + SUB + J;
  const TJC = DC0 + rnd(fMul(fr(DC0), pp(input.contingencyPpm!)));
  const OH = rnd(fMul(fr(TJC), pp((input.overhead as { rate: { ppm: number } }).rate.ppm)));
  const BE = TJC + OH;
  const S = BE + rnd(fMul(fr(BE), pp((input.profit as { rate: { ppm: number } }).rate.ppm)));
  // q(P) as exact fractions; least fixed point of P = S + q(P) by iteration from below
  const ch = input.charges;
  const q = (P: bigint): bigint => {
    let prem: F = fr(0n), lo = 0n;
    for (const t of ch.tiers) {
      const hi = t.upperBound === null ? P : P < BigInt(t.upperBound) ? P : BigInt(t.upperBound);
      if (hi > lo) prem = fAdd(prem, fMul(fr(hi - lo), pp(t.ratePpm)));
      if (t.upperBound === null || P <= BigInt(t.upperBound)) break;
      lo = BigInt(t.upperBound);
    }
    const fee = ch.fees.reduce<F>((a, f) => fAdd(a, pp(f.rate.ppm)), fr(0n));
    return rnd(fAdd(fMul(prem, pp(ch.mDurPpm)), fMul(fee, fr(P))));
  };
  let P = S;
  for (;;) {
    const next = S + q(P);
    if (next === P) break;
    P = next;
  }
  return { DC: DC0, S, P };
}
describe('10.2 #20 differential', () => {
  test('invariant 20: DC0, S and P equal the independent slow exact reference', () => {
    fc.assert(
      fc.property(
        arbBid().filter((i) => {
          const rmax = i.charges.tiers.reduce((a, t) => Math.max(a, t.ratePpm), 0);
          return (rmax * i.charges.mDurPpm) / 1e12 + i.charges.fees[0]!.rate.ppm / 1e6 < 0.5;
        }),
        (input) => {
          const b = buildBid(input);
          const ref = refBid(input);
          expect([BigInt(b.totals.DC0), BigInt(b.totals.S), BigInt(b.totals.P)]).toEqual([ref.DC, ref.S, ref.P]);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ================================================================ 10.3 labor and burden
const year = (y: number) => ({ 2025: NV2025, 2026: NV2026, 2027: NV2027 })[y as 2025 | 2026 | 2027]!;
describe('10.3 labor and burden', () => {
  test('invariant 23: capped tax T = r*W below the base, r*B above; non-decreasing; never above r*B; 0 or 1 cent across the cap', () => {
    fc.assert(
      fc.property(arbPpm(100_000), arbCents(30_000_000), arbCents(50_000_000), (r, B, W) => {
        const T = (w: number) => (w === 0 ? 0 : cappedShare(c(w), r, c(w), B));
        const exact = cappedTaxExact(r, B, W);
        if (W <= B) expect(rEq(exact, rMul(fromPpm(r), R(W)))).toBe(true);
        else expect(rEq(exact, rMul(fromPpm(r), R(B)))).toBe(true);
        expect(T(W + 1)).toBeGreaterThanOrEqual(T(W));
        expect(T(W)).toBeLessThanOrEqual(mulRate(B, r));
        if (B > 0) expect([0, 1]).toContain(T(B + 1) - T(B));
      }),
    );
  });
  test('invariant 24: per-period ytd slices sum to min(total wages, cap) exactly', () => {
    fc.assert(
      fc.property(fc.array(arbCents(1_000_000), { maxLength: 60 }), arbCents(20_000_000), (pays, cap) => {
        let Y = 0, sum = 0;
        for (const pay of pays) {
          sum += ytdTaxableSlice(c(Y), pay, cap);
          Y += pay;
        }
        expect(sum).toBe(Math.min(Y, cap));
      }),
    );
  });
  test('invariant 25: effRate <= rate, equals rate for W <= cap, non-increasing in W', () => {
    fc.assert(
      fc.property(arbPpm(), fc.integer({ min: 1, max: 50_000_000 }), arbCents(50_000_000), (r, W, cap) => {
        const e = effRate(r, c(W), cap);
        expect(e).toBeLessThanOrEqual(r);
        if (W <= cap) expect(e).toBe(r);
        expect(effRate(r, c(W + 1), cap)).toBeLessThanOrEqual(e);
      }),
    );
  });
  test('invariant 26: SS + Medicare exactly 7.65% below the base; marginal rate exactly 1.45% above it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2025, max: 2027 }), arbCents(40_000_000), arbCents(1_000_000), (y, W, d) => {
        const t = year(y);
        const both = (w: number) => rAdd(cappedTaxExact(t.socialSecurity.ratePpm, t.socialSecurity.wageBase, c(w)), cappedTaxExact(t.medicare.ratePpm, null, c(w)));
        if (W <= t.socialSecurity.wageBase) expect(rEq(both(W), rMul(R(76_500, M6), R(W)))).toBe(true);
        if (W >= t.socialSecurity.wageBase) expect(rEq(rSub(both(W + d), both(W)), rMul(R(14_500, M6), R(d)))).toBe(true);
      }),
    );
  });
  test('invariant 27: Additional Medicare and California SDI never change employer cost', () => {
    // The table type has no field for either (employee-only, D-3, D-11); above $200,000 the employer marginal stays 1.45%.
    fc.assert(
      fc.property(fc.integer({ min: 20_000_000, max: 90_000_000 }), arbCents(1_000_000), (W, d) => {
        const a = annualEmployerTaxes(CA2026, c(W), p(34_000), p(0)), b = annualEmployerTaxes(CA2026, c(W + d), p(34_000), p(0));
        expect(b.total - a.total - (b.med - a.med)).toBe(0);
        expect(Math.abs(b.med - a.med - mulRate(d, p(14_500)))).toBeLessThanOrEqual(1);
      }),
    );
    expect(Object.keys(CA2026)).not.toContain('sdi');
  });
  test('invariant 28: FUTA per employee in [0, $42.00] with no credit reduction; = (0.6% + CR)*$7,000 once W >= $7,000', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50_000_000 }), arbPpm(60_000), (W, cr) => {
        const f0 = annualEmployerTaxes(NV2026, c(W), p(29_500), p(0)).futa;
        expect(f0 >= 0 && f0 <= 4_200).toBe(true);
        if (W >= 700_000) expect(annualEmployerTaxes(NV2026, c(W), p(29_500), cr).futa).toBe(mulRate(c(700_000), p(6_000 + cr)));
      }),
    );
  });
  test('invariant 29: NV 2026 new employer UI + CEP <= $1,311.00; CEP is 0 exactly at 5.4%; CA UI <= $434, ETT <= $7', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50_000_000 }), fc.integer({ min: 15_000, max: 62_000 }), (W, caRate) => {
        expect(annualEmployerTaxes(NV2026, c(W), p(29_500)).suta).toBeLessThanOrEqual(131_100);
        const ca = annualEmployerTaxes({ ...CA2026, stateUnemployment: { ...CA2026.stateUnemployment, surchargePpm: p(0) } }, c(W), p(caRate), p(0)).suta;
        expect(ca).toBeLessThanOrEqual(43_400);
        expect(cappedShare(c(W), p(1_000), c(W), c(700_000))).toBeLessThanOrEqual(700);
        const at54 = annualEmployerTaxes(NV2026, c(W), p(54_000)).suta;
        expect(at54).toBe(cappedShare(c(W), p(54_000), c(W), c(4_370_000)));
      }),
    );
  });
  test('invariant 30: MBT >= 0; 0 at or below $50,000 net wages; +1.17 cents per extra dollar; a larger health deduction never raises it', () => {
    fc.assert(
      fc.property(arbCents(100_000_000), arbCents(20_000_000), arbCents(5_000_000), (GW, HC, more) => {
        const m = (g: number, hc: number) => mbtQuarter({ mode: 'marginal', quarterlyGrossWages: c(g), quarterlyHealthDeduction: c(hc) }, NV2026);
        expect(m(GW, HC)).toBeGreaterThanOrEqual(0);
        if (GW - HC <= 5_000_000) expect(m(GW, HC)).toBe(0);
        if (GW - HC >= 5_000_000) expect(m(GW + 10_000, HC) - m(GW, HC)).toBe(117); // $100 more -> $1.17
        expect(m(GW, HC + more)).toBeLessThanOrEqual(m(GW, HC));
      }),
    );
  });
  test('invariant 31: L_k >= G + FR + TR + OTH, equal iff every rate is zero; flat closed form R(0,0) = B + F + T and homogeneous in B', () => {
    fc.assert(
      fc.property(arbBid(), fc.boolean(), (input, zero) => {
        const lab = zero
          ? { ...input.labor, burdenMode: 'flat' as const, flatBurdenPpm: p(0), classes: input.labor.classes.map((k) => ({ ...k, wcRatePpm: p(0) })) }
          : input.labor;
        for (const k of laborCost(lab).classes) {
          const floor = k.wages.G + k.FR + k.TR + k.OTH;
          expect(k.L).toBeGreaterThanOrEqual(floor);
          if (zero) expect(k.L).toBe(floor);
        }
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(arbCents(100_000), arbCents(10_000), arbCents(10_000), fc.integer({ min: 1, max: 20 }), arbPpm(500_000), arbPpm(500_000), (B, F, T, k, ot, ti) => {
        expect(compositeRateFlat(B, p(0), c(0), p(0), F, T)).toBe(B + F + T);
        const r1 = compositeRateFlat(B, ot, c(0), ti, c(0), c(0));
        const rk = compositeRateFlat(c(B * k), ot, c(0), ti, c(0), c(0));
        expect(Math.abs(rk - k * r1)).toBeLessThanOrEqual((k + 1) / 2);
      }),
    );
  });
  test('invariant 32: overtime premium percent 0 without overtime, in [0, max multiplier - 1]; 8 h at 1.5x in 48 h = 4/48', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 0, max: 10_000 }), (a, b, cc) => {
        const H = a + b + cc;
        const r = overtimePremiumRatio(h(b), h(cc), h(H));
        expect(rCmp(r, R(0)) >= 0 && rCmp(r, R(1)) <= 0).toBe(true);
        expect(rEq(overtimePremiumRatio(h(0), h(0), h(H)), R(0))).toBe(true);
      }),
    );
    expect(rEq(overtimePremiumRatio(h(800), h(0), h(4_800)), R(4, 48))).toBe(true);
  });
  const arbWeek = fc.array(fc.integer({ min: 0, max: 2_400 }), { minLength: 7, maxLength: 7 });
  test('invariant 33: buckets partition the hours worked; California 2x only past 12 h/day or 8 h on the 7th day', () => {
    fc.assert(
      fc.property(fc.constantFrom<OtRegime>('FLSA', 'NV_PRIVATE', 'NV_PUBLIC', 'CA_PRIVATE', 'CA_PUBLIC', 'DAVIS_BACON'), arbWeek, fc.boolean(), fc.boolean(), (reg, days, daily, tens) => {
        const b = partitionHours(reg, days, { dailyOvertime: daily, fourTens: tens });
        expect(b.h10 + b.h15 + b.h20).toBe(days.reduce((a, x) => a + x, 0));
        expect(b.h10 >= 0 && b.h15 >= 0 && b.h20 >= 0).toBe(true);
        expect(b.h10).toBeLessThanOrEqual(4_000);
        if (reg !== 'CA_PRIVATE') expect(b.h20).toBe(0);
        else if (b.h20 > 0) expect(days.some((x) => x > 1_200) || (days.every((x) => x > 0) && days[6]! > 800)).toBe(true);
      }),
    );
  });
  test('invariant 34: Nevada private: no daily overtime for anyone paid at least $18.00; weekly overtime still applies', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1_800, max: 20_000 }), arbWeek, fc.boolean(), (rate, days, tens) => {
        const daily = nvPrivateDailyOvertimeApplies(c(rate), c(1_200), tens); // D-28: $12.00 minimum wage
        expect(daily).toBe(false);
        const b = partitionHours('NV_PRIVATE', days, { dailyOvertime: daily });
        const T = days.reduce((a, x) => a + x, 0);
        expect(b.h15).toBe(Math.max(0, T - 4_000));
      }),
    );
    expect(nvPrivateDailyOvertimeApplies(c(1_799), c(1_200), false)).toBe(true);
  });
  test('invariant 35: Davis-Bacon week pay = H*(BHR+FB) + 0.5*basic*max(0, H-40); premium 0 at <= 40 h; continuous; contract line changes label only', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 80 }), fc.integer({ min: 1_000, max: 10_000 }), fc.integer({ min: 0, max: 5_000 }), (hours, bhr, fb) => {
        const H = hours * 100;
        const k = cls({ id: 'db', h10: h(Math.min(H, 4_000)), h15: h(Math.max(0, H - 4_000)), wBasic: c(bhr), fPlan: c(fb), prevailing: { bhrWd: c(bhr), fbWd: c(fb) } });
        const w = classWages('DAVIS_BACON', k);
        const engine = w.G + mulHours(h(H), c(fb));
        const formula = davisBaconWeekPay(h(H), c(bhr), c(fb), c(bhr));
        expect(Math.abs(engine - formula)).toBeLessThanOrEqual(1);
        if (H <= 4_000) expect(w.otPremium).toBe(0);
        expect(davisBaconWeekPay(h(4_000), c(bhr), c(fb), c(bhr))).toBe(4_000 / 100 * (bhr + fb));
        expect(davisBaconOvertimeLaw(c(10_000_000), c(10_000_000))).toBe('FLSA');
        expect(davisBaconOvertimeLaw(c(10_000_001), c(10_000_000))).toBe('CWHSSA');
      }),
    );
  });
  test('invariant 36: prevailing-wage compliance holds on every hour, or the build-up refuses', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1_000, max: 8_000 }), fc.integer({ min: 0, max: 3_000 }), fc.integer({ min: 1_000, max: 8_000 }), fc.integer({ min: 0, max: 3_000 }), (wb, fp, bhr, fb) => {
        const k = cls({ id: 'pw', h10: h(4_000), h15: h(800), wBasic: c(wb), fPlan: c(fp), prevailing: { bhrWd: c(bhr), fbWd: c(fb) } });
        const input = i1Input();
        const bid: BidInput = { ...input, labor: { ...input.labor, regime: 'NV_PUBLIC', classes: [k] } };
        const chk = prevailingWageCheck(k);
        if (chk.ok) {
          const b = buildBid(bid);
          const pay = b.labor.classes[0]!.wages.pay;
          expect(pay.pay10HalfCents / 2 + fp).toBeGreaterThanOrEqual(bhr + fb);
          expect(pay.pay15HalfCents / 2 + fp).toBeGreaterThanOrEqual(bhr + fb);
        } else {
          let code = '';
          try {
            buildBid(bid);
          } catch (e) {
            code = (e as CostEngineError).code;
          }
          expect(code).toBe('PREVAILING_WAGE_SHORTFALL');
        }
      }),
    );
  });
  test('invariant 37: moving cash in lieu to a bona fide plan never raises employer cost; below the SS base it saves 7.65% of the dollars moved', () => {
    fc.assert(
      fc.property(fc.integer({ min: 700_000, max: 18_000_000 }), fc.integer({ min: 0, max: 10_000_000 }), (W, moved0) => {
        const moved = Math.min(moved0, W - 4_370_000 > 0 ? W - 4_370_000 : 0);
        const a = annualEmployerTaxes(NV2026, c(W), p(29_500)).total;
        const b = annualEmployerTaxes(NV2026, c(W - moved), p(29_500)).total;
        expect(b).toBeLessThanOrEqual(a);
        if (W - moved >= 4_370_000) expect(Math.abs(a - b - mulRate(c(moved), p(76_500)))).toBeLessThanOrEqual(2);
      }),
    );
  });
  test("invariant 38: workers' comp payroll <= gross; exclusion = gross - OT premium; Nevada = gross, capped; linear in payroll and XMod", () => {
    fc.assert(
      fc.property(arbCents(10_000_000), arbCents(3_000_000), arbPpm(200_000), fc.integer({ min: 500_000, max: 2_000_000 }), fc.integer({ min: 1, max: 9 }), fc.integer({ min: 1, max: 20_000_000 }), (G, ot0, r, x, k, Wwc) => {
        const ot = c(Math.min(ot0, G));
        const pol = { xModPpm: p(x), otherModsPpm: p(1_000_000), excludeOtPremium: true, payrollCap: null };
        const ex = workersComp(G, ot, r, pol, c(Wwc));
        expect(ex.payroll).toBe(G - ot);
        const nv = workersComp(G, ot, r, { ...pol, excludeOtPremium: false, payrollCap: c(9_843_360) }, c(Wwc));
        expect(nv.payroll).toBe(G);
        expect(nv.premium).toBeLessThanOrEqual(workersComp(G, ot, r, { ...pol, excludeOtPremium: false }, c(Wwc)).premium);
        const lin = workersComp(c(G * k), c(0), r, { ...pol, excludeOtPremium: false }, c(Wwc)).premium;
        const one = workersComp(G, c(0), r, { ...pol, excludeOtPremium: false }, c(Wwc)).premium;
        expect(Math.abs(lin - k * one)).toBeLessThanOrEqual((k + 1) / 2);
        const x2 = workersComp(G, c(0), r, { ...pol, xModPpm: p(x * 2), excludeOtPremium: false }, c(Wwc)).premium;
        expect(Math.abs(x2 - 2 * one)).toBeLessThanOrEqual(1.5);
      }),
    );
  });
  test('invariant 39: California class is a step at the threshold in force', () => {
    fc.assert(fc.property(arbCents(20_000), arbCents(20_000), (w, t) => {
      expect(caElectricalClass(w, t)).toBe(w >= t ? '5140' : '5190');
    }));
  });
  test('invariant 40: table years are monotone (fixtures from D-2, D-6)', () => {
    expect(NV2025.socialSecurity.wageBase <= NV2026.socialSecurity.wageBase && NV2026.socialSecurity.wageBase <= NV2027.socialSecurity.wageBase).toBe(true);
    expect(NV2025.stateUnemployment.wageBase <= NV2026.stateUnemployment.wageBase && NV2026.stateUnemployment.wageBase <= NV2027.stateUnemployment.wageBase).toBe(true);
    expect([NV2025, NV2026, NV2027].map((t) => t.socialSecurity.wageBase)).toEqual([17_610_000, 18_450_000, 19_230_000]);
  });
});

// ================================================================ 10.4 direct cost and whole-bid structure
describe('10.4 direct cost and whole bid', () => {
  test('invariant 41: waste and the sales tax rate change material cost, never labor hours or labor cost', () => {
    fc.assert(
      fc.property(arbBid(), arbPpm(500_000), arbPpm(150_000), (input, waste, s) => {
        const a = buildBid(input);
        const b = buildBid({ ...input, materials: { ...input.materials, salesTaxPpm: s, lines: input.materials.lines.map((l) => ({ ...l, wastePpm: waste })) } });
        expect([b.totals.H, b.totals.L]).toEqual([a.totals.H, a.totals.L]);
      }),
      { numRuns: 300 },
    );
  });
  test('invariant 42: MAT >= M; a non-taxable line adds its extension to MAT and nothing to the taxable base; TAX = 0 at s = 0', () => {
    fc.assert(
      fc.property(arbBid(), (input) => {
        const m = materialLines(input.materials);
        expect(m.MAT).toBeGreaterThanOrEqual(m.M);
        const extra = { id: 'nt', quantity: 1_000 as QtyM, unitPrice: c(12_345), wastePpm: p(0), taxable: false };
        const m2 = materialLines({ ...input.materials, lines: [...input.materials.lines, extra] });
        expect(m2.TB).toBe(m.TB);
        expect(m2.MAT - m.MAT).toBe(12_345);
        expect(materialLines({ ...input.materials, salesTaxPpm: p(0) }).TAX).toBe(0);
      }),
    );
  });
  test('invariant 43: a price hold through the purchase date gives esc = 0 exactly; scheduled labor gives ESC_L = 0', () => {
    fc.assert(
      fc.property(arbBid(), arbPpm(200_000), (input, eL) => {
        const held = input.materials.lines.map((l) => ({ ...l, holdThrough: '2027-03-01' as never, purchaseDate: '2027-02-15' as never }));
        expect(materialLines({ ...input.materials, lines: held }).ESC_M).toBe(0);
        const b = buildBid({ ...input, laborEscalationPpm: eL, labor: { ...input.labor, classes: input.labor.classes.map((k) => ({ ...k, wageScheduled: true })) } });
        expect(b.totals.ESC_L).toBe(0);
      }),
      { numRuns: 300 },
    );
  });
  test('invariant 44: adding d of subcontract raises S by d(1+c)(1+o)(1+p) within (1+o)(1+p) + (1+p) + 1 cents', () => {
    fc.assert(
      fc.property(arbBid({ tiers: false }), arbCents(100_000_000), (input, d) => {
        const a = buildBid(input).totals.S;
        const b = buildBid({ ...input, subcontracts: [...input.subcontracts, { id: 'extra', amount: d }] }).totals.S;
        const o = fromPpm((input.overhead as { rate: { ppm: number } }).rate.ppm), pr = fromPpm((input.profit as { rate: { ppm: number } }).rate.ppm), cc = fromPpm(input.contingencyPpm!);
        const one = R(1);
        const gain = rMul(rMul(rAdd(one, cc), rAdd(one, o)), rAdd(one, pr));
        const tol = rAdd(rAdd(rMul(rAdd(one, o), rAdd(one, pr)), rAdd(one, pr)), one);
        expect(le(absR(rSub(R(b - a), rMul(R(d), gain))), tol)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
  test('invariant 45: conservation TJC = L+ST+MAT+E+SUB+JOOH+ESC_L+CONT; S = TJC+OH+PR+FIN; P = S + q(P)', () => {
    fc.assert(
      fc.property(arbBid(), arbPpm(100_000), (input, eL) => {
        const t = buildBid({ ...input, laborEscalationPpm: eL }).totals;
        expect(t.TJC).toBe(t.L + t.ST + t.MAT + t.E + t.SUB + t.JOOH + t.ESC_L + t.CONT);
        expect(t.S).toBe(t.TJC + t.OH + t.PR + t.FIN);
        expect(t.P).toBe(t.S + t.q);
        expect(t.q).toBe(priceBasedCharge(t.P, input.charges));
        expect(t.premium + t.otherCharges).toBe(t.q);
      }),
    );
  });
  test('invariant 46: raising one input never lowers P; P >= S >= BE >= TJC', () => {
    const bumps: ((i: BidInput, d: number) => BidInput)[] = [
      (i, d) => ({ ...i, labor: { ...i.labor, classes: i.labor.classes.map((k, j) => (j === 0 ? { ...k, h10: h(k.h10 + d) } : k)) } }),
      (i, d) => ({ ...i, labor: { ...i.labor, classes: i.labor.classes.map((k, j) => (j === 1 ? { ...k, wBasic: c(k.wBasic + d) } : k)) } }),
      (i, d) => ({ ...i, labor: { ...i.labor, classes: i.labor.classes.map((k) => ({ ...k, wcRatePpm: p(Math.min(1_000_000, k.wcRatePpm + d)) })) } }),
      (i, d) => ({ ...i, labor: { ...i.labor, flatBurdenPpm: p(Math.min(2_000_000, i.labor.flatBurdenPpm! + d)), stateUiRatePpm: p(Math.min(53_999, i.labor.stateUiRatePpm! + (d % 100))) } }), // 5.4% drops CEP: a legal step, see spec issues
      (i, d) => ({ ...i, materials: { ...i.materials, lines: i.materials.lines.map((l, j) => (j === 0 ? { ...l, quantity: (l.quantity + d) as QtyM } : l)) } }),
      (i, d) => ({ ...i, materials: { ...i.materials, lines: i.materials.lines.map((l, j) => (j === 1 ? { ...l, unitPrice: c(l.unitPrice + d) } : l)) } }),
      (i, d) => ({ ...i, materials: { ...i.materials, lines: i.materials.lines.map((l) => ({ ...l, wastePpm: p(Math.min(500_000, l.wastePpm + d)) })) } }),
      (i, d) => ({ ...i, materials: { ...i.materials, salesTaxPpm: p(Math.min(150_000, i.materials.salesTaxPpm + d)) } }),
      (i, d) => ({ ...i, overhead: { method: 'on_cost', rate: { ppm: p((i.overhead as { rate: { ppm: number } }).rate.ppm + d), base: 'on_cost' } } }),
      (i, d) => ({ ...i, profit: { rate: { ppm: p(Math.min(1_000_000, (i.profit as { rate: { ppm: number } }).rate.ppm + d)), base: 'on_cost' } } }),
      (i, d) => ({ ...i, charges: { ...i.charges, tiers: i.charges.tiers.map((t, j) => (j === 0 ? { ...t, ratePpm: p(t.ratePpm + (d % 1000)) } : t)) } }),
    ];
    fc.assert(
      fc.property(arbBid(), fc.integer({ min: 0, max: bumps.length - 1 }), fc.integer({ min: 0, max: 100_000 }), (input, which, d) => {
        const a = buildBid(input).totals;
        expect(a.P >= a.S && a.S >= a.BE && a.BE >= a.TJC).toBe(true);
        const b = buildBid(bumps[which]!(input, d)).totals;
        expect(b.P).toBeGreaterThanOrEqual(a.P);
      }),
    );
  });
  test('invariant 47: permuting lines changes nothing; a zero line changes nothing; splitting a line moves S at most the 3.9 bound', () => {
    fc.assert(
      fc.property(arbBid(), fc.integer({ min: 1, max: 999 }), (input, cut) => {
        const a = buildBid(input);
        const rev = buildBid({
          ...input,
          labor: { ...input.labor, classes: [...input.labor.classes].reverse() },
          materials: { ...input.materials, lines: [...input.materials.lines].reverse() },
          equipment: [...input.equipment].reverse(),
          jobOverhead: [...input.jobOverhead].reverse(),
        });
        expect(rev.totals.P).toBe(a.totals.P);
        const zero = buildBid({
          ...input,
          labor: { ...input.labor, classes: [...input.labor.classes, cls({ id: 'zero', annualTaxableWages: c(1_000_000) })] },
          materials: { ...input.materials, lines: [...input.materials.lines, { id: 'z', quantity: 0 as QtyM, unitPrice: c(999), wastePpm: p(0) }] },
        });
        expect(zero.totals.P).toBe(a.totals.P);
        // split material line 0 into two lines with the same rates
        const l0 = input.materials.lines[0]!;
        const q1 = Math.floor((l0.quantity * cut) / 1000);
        const split = { ...input, materials: { ...input.materials, lines: [{ ...l0, quantity: q1 as QtyM }, { ...l0, id: 'm0b', quantity: (l0.quantity - q1) as QtyM }, ...input.materials.lines.slice(1)] } };
        const b = buildBid(split);
        const tol = rAdd(sBound(input, a.lines), sBound(split, b.lines));
        expect(le(absR(R(b.totals.S - a.totals.S)), tol)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

// ================================================================ 10.5 markup, overhead, distribution
const arbRatio = (max = 10n) => fc.tuple(fc.bigInt({ min: 0n, max: 1_000_000n * max }), fc.bigInt({ min: 1n, max: 1_000_000n })).map(([n, d]) => ratio(n, d));
describe('10.5 markup, overhead, distribution', () => {
  test('invariant 48: markup -> margin -> markup is the identity in fractions; margin < 1; margin <= markup', () => {
    fc.assert(
      fc.property(arbRatio(), (k) => {
        const m = markupToMargin(k);
        expect(rEq(marginToMarkup(m), k)).toBe(true);
        expect(rCmp(m, R(1)) < 0).toBe(true);
        expect(le(m, k)).toBe(true);
      }),
    );
  });
  test('invariant 49: P*(1-m) = C and C*(1+k) = P', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), fc.integer({ min: 0, max: 1_000_000_000 }), (C, extra) => {
        const P = C + extra;
        const k = rDivSafe(R(P - C), R(C));
        const m = rDivSafe(R(P - C), R(P));
        expect(rEq(priceFromMarkup(c(C), k), R(P))).toBe(true);
        expect(rEq(priceFromMargin(c(C), m), R(P))).toBe(true);
        expect(rEq(rMul(R(P), rSub(R(1), m)), R(C))).toBe(true);
      }),
    );
  });
  test('invariant 50: the overhead-profit product is order independent and (1+o)(1+p) >= 1+o+p', () => {
    fc.assert(
      fc.property(arbPpm(), arbPpm(), arbPpm(), (o, pr, x) => {
        expect(rEq(stackMultipliers([o, pr, x]), stackMultipliers([x, pr, o]))).toBe(true);
        expect(le(rAdd(rAdd(R(1), fromPpm(o)), fromPpm(pr)), stackMultipliers([o, pr]))).toBe(true);
      }),
    );
  });
  test('invariant 51: |PR - p_c(TJC+OH)| <= 0.5 cent and |OH - o_c*TJC| <= 0.5 cent', () => {
    fc.assert(
      fc.property(arbBid(), (input) => {
        const t = buildBid(input).totals;
        const o = fromPpm((input.overhead as { rate: { ppm: number } }).rate.ppm), pr = fromPpm((input.profit as { rate: { ppm: number } }).rate.ppm);
        expect(le(absR(rSub(R(t.OH), rMul(o, R(t.TJC)))), R(1, 2))).toBe(true);
        expect(le(absR(rSub(R(t.PR), rMul(pr, R(t.TJC + t.OH)))), R(1, 2))).toBe(true);
      }),
    );
  });
  test('invariant 52: TJC/(1-o_s-m_s) = TJC*(1+o_c)*(1+p_c) in exact fractions (and the inverse conversion)', () => {
    fc.assert(
      fc.property(arbCents(), arbPpm(600_000), arbPpm(390_000), (TJC, os, ms) => {
        const { oc, pc, multiplier } = salesBasisToCostBasis(os, ms);
        expect(rEq(rMul(R(TJC), multiplier), rMul(R(TJC), rMul(rAdd(R(1), oc), rAdd(R(1), pc))))).toBe(true);
        const back = costBasisToSalesBasis(oc, pc);
        expect(rEq(back.os, fromPpm(os)) && rEq(back.ms, fromPpm(ms))).toBe(true);
      }),
    );
    expectRefusal(() => salesBasisToCostBasis(p(600_000), p(400_000)));
  });
  test('invariant 53: on_sales method: TJC + OH + PR = S0 exactly and |OH - o_s*S0| <= 0.5 cent', () => {
    fc.assert(
      fc.property(arbCents(), arbPpm(600_000), arbPpm(390_000), (TJC, os, ms) => {
        const r = homeOfficeOverhead({ method: 'on_sales', rate: { ppm: os, base: 'on_sales' }, profit: { ppm: ms, base: 'on_sales' } }, TJC, c(0), c(0), h(0));
        expect(TJC + r.OH + r.PR!).toBe(r.S0);
        expect(le(absR(rSub(R(r.OH), rMul(fromPpm(os), R(r.S0!)))), R(1, 2))).toBe(true);
      }),
    );
  });
  test('invariant 54: overhead recovery; labor-hour allocations sum to OH_annual; dual rate recovers OH_annual exactly', () => {
    fc.assert(
      fc.property(arbCents(), fc.integer({ min: 1, max: 1_000_000_000 }), arbCents(), fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 10 }).filter((x) => x.some((y) => y > 0)), arbCents(), arbCents(), fc.integer({ min: 1_000_001, max: 5_000_000 }), (OH, DCplan, DCact, hoursList, La, MSa, X) => {
        expect(rEq(overheadRecovery(OH, c(DCplan), c(DCplan)), R(OH))).toBe(true);
        expect(rEq(overheadRecovery(OH, c(DCplan), DCact), R(BigInt(OH) * BigInt(DCact), BigInt(DCplan)))).toBe(true);
        const LH = hoursList.reduce((a, b) => a + b, 0);
        const rate = laborHourOverheadRate(OH, h(LH));
        const sum = hoursList.reduce<Ratio>((a, hh) => rAdd(a, rMul(rate, R(hh, 100))), R(0));
        expect(rEq(sum, R(OH))).toBe(true);
        if (La + MSa > 0) {
          const { rL, rM } = dualOverheadRates(OH, La, MSa, R(X, M6));
          expect(rEq(rAdd(rMul(rL, R(La)), rMul(rM, R(MSa))), R(OH))).toBe(true);
        }
      }),
    );
  });
  test('invariant 55: profit as a function of revenue is zero at BE_revenue, negative below, positive above', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), fc.integer({ min: 0, max: 1_000_000_000 }), fc.integer({ min: 1, max: 1_000_000_000 }), (OH, DC, gap) => {
        const Sales = DC + gap;
        const be = breakEvenRevenue(c(OH), c(DC), c(Sales));
        const gm = R(BigInt(gap), BigInt(Sales));
        expect(rEq(rSub(rMul(be, gm), R(OH)), R(0))).toBe(true);
        const below = be.num / be.den - 1n, above = be.num / be.den + 1n;
        if (above > BigInt(Number.MAX_SAFE_INTEGER)) return;
        if (below >= 0n) expect(rCmp(profitAtRevenue(c(Number(below)), c(OH), c(DC), c(Sales)), R(0)) < 0).toBe(true);
        expect(rCmp(profitAtRevenue(c(Number(above)), c(OH), c(DC), c(Sales)), R(0)) > 0).toBe(true);
      }),
    );
  });
  test('invariant 56: no tiers, caps or thresholds: |price(k*x) - k*price(x)| <= (k+1)*bound', () => {
    const scale = (i: BidInput, k: number): BidInput => ({
      ...i,
      labor: { ...i.labor, classes: i.labor.classes.map((cl) => ({ ...cl, wBasic: c(cl.wBasic * k), wCil: c(cl.wCil * k), fPlan: c(cl.fPlan * k), fHealth: c(cl.fHealth * k), travelPerHour: c(cl.travelPerHour * k), otherPerHour: c(cl.otherPerHour * k) })) },
      materials: { ...i.materials, freight: c(i.materials.freight * k), lines: i.materials.lines.map((l) => ({ ...l, unitPrice: c(l.unitPrice * k) })) },
      equipment: i.equipment.map((e) => (e.kind === 'lump' ? { ...e, amount: c(e.amount * k) } : { ...e, rate: c(e.rate * k) })),
      subcontracts: i.subcontracts.map((s) => ({ ...s, amount: c(s.amount * k) })),
      jobOverhead: i.jobOverhead.map((j) => (j.kind === 'once' ? { ...j, amount: c(j.amount * k) } : j.kind === 'hours' ? { ...j, rate: c(j.rate * k) } : j)),
    });
    fc.assert(
      fc.property(arbBid({ tiers: false, flat: true }), fc.integer({ min: 2, max: 9 }), (input, k) => {
        const a = buildBid(input), b = buildBid(scale(input, k));
        const bound = pBound(input, a.lines, a.fixedPoint.k12);
        const diff = absR(R(b.totals.P - k * a.totals.P));
        expect(le(diff, rMul(R(k + 1), bound))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
  test('invariant 57: item indirects sum to the indirect total and item prices sum to P_bid exactly', () => {
    fc.assert(
      fc.property(arbBid(), fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 6 }).filter((w) => w.some((x) => x > 0)), fc.integer({ min: 1, max: 1_000_000 }), (input, w, unit) => {
        const b = buildBid({ ...input, bidRoundingUnit: c(unit) });
        const dc = allocate(b.totals.TJC, w).map((x, i) => ({ id: `i${i}`, directCost: x }));
        const r = distributeIndirects(b.totals.Pbid, dc);
        expect(r.items.reduce((a, x) => a + x.indirect, 0)).toBe(r.indirectTotal);
        expect(r.items.reduce((a, x) => a + x.price, 0)).toBe(b.totals.Pbid);
      }),
      { numRuns: 300 },
    );
  });
  test('invariant 58: 0 <= P_bid - P < unit, and the difference goes to the profit line (plus the charges priced at P_bid)', () => {
    fc.assert(
      fc.property(arbBid(), fc.integer({ min: 1, max: 10_000_000 }), (input, unit) => {
        const t = buildBid({ ...input, bidRoundingUnit: c(unit) }).totals;
        expect(t.Pbid - t.P >= 0 && t.Pbid - t.P < unit).toBe(true);
        expect(t.Pbid % unit).toBe(0);
        expect(t.roundingToProfit + t.roundingToCharges).toBe(t.Pbid - t.P);
        expect(t.roundingToProfit).toBeGreaterThanOrEqual(0);
        expect(t.profitAsBid).toBe(t.PR + t.roundingToProfit);
        expect(t.Pbid).toBe(t.S + t.roundingToProfit + t.qBid);
        expect(t.qBid).toBe(priceBasedCharge(t.Pbid, input.charges));
        expect(bidRounding(t.P, c(1))).toBe(t.P);
      }),
    );
  });
});

function rDivSafe(a: Ratio, b: Ratio): Ratio {
  return ratio(a.num * b.den, a.den * b.num);
}

// spec 2.1 hours: waste never changes hours, split of task hours conserves the hour
describe('2.1 hours (supporting checks)', () => {
  test('task hours by crew split sum to the task hours exactly', async () => {
    const { classHoursFromTasks, taskHours } = await import('../src/cost/index.js');
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 1, max: 5_000_000 }), fc.integer({ min: 500_000, max: 5_000_000 }), fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 4 }).filter((x) => x.some((y) => y > 0)), (q, u, pf, crew) => {
        const t = { id: 't', quantity: q as QtyM, laborUnit: u as never, productivityPpm: p(pf), crew: Object.fromEntries(crew.map((n, i) => [`k${i}`, n])) };
        const out = classHoursFromTasks([t]);
        expect(Object.values(out).reduce((a, b) => a + b, 0)).toBe(taskHours(q as QtyM, u as never, p(pf)));
      }),
    );
  });
});

// Supporting checks for paths the numbered invariants do not reach.
describe('supporting checks (sections 2.3, 2.11 to 2.15)', () => {
  test('spec issue: Nevada CEP is not owed at exactly 5.4%, so UI + CEP is not monotone in the UI rate', () => {
    const below = annualEmployerTaxes(NV2026, c(9_000_000), p(53_900)).suta;
    const at = annualEmployerTaxes(NV2026, c(9_000_000), p(54_000)).suta;
    expect(below).toBeGreaterThan(at); // 5.39% + 0.05% = 5.44% > 5.40%
  });
  test('refusals: CA FUTA credit reduction must be entered; no fallback to another table year; 2x hours need pay20', () => {
    const base = i1Input();
    expectRefusal(() => buildBid({ ...base, labor: { ...base.labor, stateOfWork: 'CA', payrollTables: { 2026: CA2026 }, stateUiRatePpm: p(34_000), mbt: undefined } }));
    expectRefusal(() => buildBid({ ...base, labor: { ...base.labor, classes: base.labor.classes.map((k) => ({ ...k, taxYear: 2027 })) } }));
    expectRefusal(() => buildBid({ ...base, labor: { ...base.labor, classes: base.labor.classes.map((k) => ({ ...k, h20: h(100) })) } }));
    expectRefusal(() => buildBid({ ...base, labor: { ...base.labor, stateUiRatePpm: p(60_000) } })); // outside the NV guard
  });
  test('ytd mode: a worker already over every cap pays Medicare only', () => {
    const base = i1Input();
    const b = buildBid({ ...base, labor: { ...base.labor, burdenMode: 'ytd', mbt: undefined, classes: base.labor.classes.map((k) => ({ ...k, ytdWagesBefore: c(20_000_000) })) } });
    for (const k of b.labor.classes) {
      expect([k.SS, k.FUTA, k.SUTA]).toEqual([0, 0, 0]);
      expect(k.MED).toBe(mulRate(k.wages.G, p(14_500)));
    }
  });
  test('MBT average mode allocates MBT_q / GW_q', () => {
    const base = i1Input();
    const b = buildBid({ ...base, labor: { ...base.labor, mbt: { mode: 'average', quarterlyGrossWages: c(12_000_000), quarterlyHealthDeduction: c(1_000_000) } } });
    // MBT_q = 1.17% x (120,000 - 10,000 - 50,000) = 702.00; t = 702/120,000 = 5,850 ppm
    expect(b.labor.classes[0]!.lines.find((l) => l.key.endsWith('.MBT'))!.rate!.value).toBe(5_850);
    const small = buildBid({ ...base, labor: { ...base.labor, mbt: { mode: 'marginal', quarterlyGrossWages: c(4_000_000), quarterlyHealthDeduction: c(0) } } });
    expect(small.labor.classes.every((k) => k.MBT === 0)).toBe(true); // a small shop owes zero
  });
  test('overhead methods per_labor_hour, on_labor_cost and dual through the build-up; the five methods all conserve', () => {
    const base = i1Input();
    const t1 = buildBid({ ...base, overhead: { method: 'per_labor_hour', centsPerHour: c(1_000) } }).totals;
    expect(t1.OH).toBe(mulHours(t1.H, c(1_000)));
    const t2 = buildBid({ ...base, overhead: { method: 'on_labor_cost', measure: 'G', rate: { ppm: p(200_000), base: 'on_labor_cost' } } }).totals;
    expect(t2.OH).toBe(mulRate(t2.G, p(200_000)));
    const t3 = buildBid({ ...base, overhead: { method: 'dual', rateL: { ppm: p(300_000), base: 'on_labor_cost' }, rateM: { ppm: p(100_000), base: 'on_cost' } } }).totals;
    expect(t3.OH).toBe(mulRate(t3.L, p(300_000)) + mulRate(c(t3.TJC - t3.L), p(100_000)));
    const t4 = buildBid({ ...base, overhead: { method: 'on_sales', rate: { ppm: p(100_000), base: 'on_sales' }, profit: { ppm: p(50_000), base: 'on_sales' } }, profit: { fromOverheadOnSales: true } }).totals;
    expect(t4.TJC + t4.OH + t4.PR).toBe(t4.S);
    const t5 = buildBid({ ...base, overhead: { method: 'dual', annual: { overhead: c(10_000_000), labor: c(30_000_000), nonLabor: c(50_000_000) }, weightXPpm: p(2_000_000) } }).totals;
    expect(t5.S).toBe(t5.TJC + t5.OH + t5.PR);
    expectRefusal(() => buildBid({ ...base, overhead: { method: 'on_sales', rate: { ppm: p(100_000), base: 'on_sales' }, profit: { ppm: p(50_000), base: 'on_sales' } } }));
  });
  test('financing line is computed once at the price without FIN and shown as an approximation', () => {
    const base = i1Input();
    let seen: [number, number] = [0, 0];
    const b = buildBid({ ...base, financing: { include: true, compute: (s, pp) => ((seen = [s, pp]), c(12_345)) } });
    expect(seen[0]).toBe(4_883_100);
    expect(seen[1]).toBe(4_912_575);
    expect(b.totals.FIN).toBe(12_345);
    expect(b.totals.S).toBe(4_883_100 + 12_345);
    expect(b.assumptions.some((a) => a.id === 'A-20')).toBe(true);
  });
  test("bond 'auto': tiers apply only when the price without bond crosses the caller's threshold", () => {
    const base = i1Input();
    const tiers = CLASS_B;
    const noBond = buildBid({ ...base, charges: { ...base.charges, tiers, bondRequiredAuto: (pp) => pp > 10_000_000 } });
    expect(noBond.bondApplied).toBe(false);
    expect(noBond.totals.P).toBe(4_912_575);
    const bond = buildBid({ ...base, charges: { ...base.charges, tiers, bondRequiredAuto: (pp) => pp > 1_000_000 } });
    expect(bond.bondApplied).toBe(true);
    expect(bond.totals.premium).toBeGreaterThan(0);
  });
  test('bid items through the build-up; assumptions are surfaced when defaults are used', () => {
    const base = i1Input();
    const { smallToolsPpm: _st, contingencyPpm: _c, ...rest } = base;
    const b = buildBid({ ...rest, bidRoundingUnit: c(10_000), bidItems: [{ id: 'base', directCost: c(3_000_000) }, { id: 'alt', directCost: c(860_158) }] });
    expect(b.items!.items.reduce((a, x) => a + x.price, 0)).toBe(b.totals.Pbid);
    expect(b.totals.Pbid).toBe(4_920_000);
    expect(b.assumptions.map((a) => a.id).sort()).toEqual(['A-18', 'A-19']);
  });
});
