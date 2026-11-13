// Spec sections 4 (bonds, bid security, retainage, payment timing) and 5 (cash carried, limits):
// invariants 15 (on the premium wrapper), 22 and 59 to 86 as fast-check properties, and the golden
// examples P-12, P-16, I-2 (fee payable), I-3, I-4, I-12 to I-17.
// Test plan 10.0: pinned seed, 1,000 runs per property. Never Math.random, never fc.float for money.
// Jurisdiction tables below are TEST FIXTURES carrying the spec 8.4 / 8.5 values with their sources;
// the engine takes them as parameters.
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import {
  divRoundHalfUp,
  grossUp,
  mulRate,
  priceBasedCharge,
  rCmp,
  rEq,
  rMul,
  rSub,
  ratio,
  rRound,
  type BondTier,
  type Cents,
  type IsoDate,
  type Ppm,
  type PriceChargesInput,
} from '../src/cost/index.js';
import {
  bidSecurity,
  bidSecurityCost,
  bidSecurityRequired,
  bondMonths,
  bondPremium,
  bondRequiredAutoHook,
  bondRequirement,
  premiumTrueUp,
  sbaFee,
  sbaFeeCharge,
  sbaFeeRatePpm,
  walkAwayExposure,
  type BidSecurityRule,
  type BondRequirementTable,
  type SbaFeeTable,
} from '../src/cost/bonds.js';
import {
  californiaRetentionCharge,
  federalLatePaymentInterest,
  liquidatedDamages,
  progressPaymentDay,
  retainageFinancingCost,
  retainageFinancingUniform,
  retainageSchedule,
  simpleInterest,
  type PaymentTimingPreset,
  type RetainageRule,
} from '../src/cost/payment.js';
import {
  accountingView,
  cashLedger,
  closedFormPeak,
  costWeights,
  financingCost,
  inflowLagPeriods,
  outflowLagPeriods,
  peakFloat,
  portfolio,
  stressCases,
  trapezoidS,
  type CashCategory,
  type CashJobInput,
  type CashLedger,
} from '../src/cost/cash.js';
import { floatVerdict, limitsCheck } from '../src/cost/limits.js';
import { lookupNumber } from '../src/cost/defaults.js';

const SEED = 20_261_113;
const RUNS = 1_000;
fc.configureGlobal({ seed: SEED, numRuns: RUNS });

const c = (n: number) => n as Cents;
const p = (n: number) => n as Ppm;
const d = (s: string) => s as IsoDate;

// ---------------------------------------------------------------- fixtures: spec 8.4 bonds (D-32 .. D-38)
const FAR_28_102 = { citation: 'FAR 28.102-1, 28.102-2', url: 'https://www.acquisition.gov/far/28.102-1', effective: 'current FAR' };
const NRS_339 = { citation: 'NRS 339.025', url: 'https://www.leg.state.nv.us/nrs/NRS-339.html', effective: 'current' };
const NRS_408 = { citation: 'NRS 408', url: 'https://www.leg.state.nv.us/nrs/NRS-408.html', effective: 'current' };
const CIV_9550 = { citation: 'Civ. Code 9550; PCC 10167', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=9550.', effective: 'current' };

/** D-32, D-33: federal bonds. */
const FED_BONDS: BondRequirementTable = {
  id: 'federal',
  source: FAR_28_102,
  bands: [
    { above: c(15_000_000), atMost: null, performance: { kind: 'pct', ppm: p(1_000_000), minimum: false }, payment: { kind: 'pct', ppm: p(1_000_000), minimum: false }, label: 'C > $150,000' },
    { above: c(3_500_000), atMost: c(15_000_000), performance: { kind: 'none' }, payment: { kind: 'officer_choice', ppm: p(1_000_000) }, label: '$35,000 < C <= $150,000' },
  ],
};
/** D-35: Nevada NRS 339.025 (not NRS 408 work). */
const NV_BONDS: BondRequirementTable = {
  id: 'nv_339',
  source: NRS_339,
  bands: [{ above: c(10_000_000), atMost: null, performance: { kind: 'pct', ppm: p(500_000), minimum: true }, payment: { kind: 'pct', ppm: p(500_000), minimum: true }, label: 'C > $100,000' }],
};
/** D-35: NDOT bonds equal to the full contract amount on all contracts. */
const NDOT_BONDS: BondRequirementTable = {
  id: 'ndot',
  source: NRS_408,
  bands: [{ above: null, atMost: null, performance: { kind: 'pct', ppm: p(1_000_000), minimum: false }, payment: { kind: 'pct', ppm: p(1_000_000), minimum: false }, label: 'all contracts' }],
};
/** D-36: California local public works: payment bond 100% over $25,000; performance from the bid documents. */
const CA_LOCAL_BONDS: BondRequirementTable = {
  id: 'ca_local',
  source: CIV_9550,
  bands: [{ above: c(2_500_000), atMost: null, performance: { kind: 'from_bid_documents' }, payment: { kind: 'pct', ppm: p(1_000_000), minimum: false }, label: 'expenditure > $25,000' }],
};

/** D-34: federal bid guarantee 20%, cap $3,000,000, only with a performance bond. */
const FED_BID: BidSecurityRule = {
  id: 'federal',
  pctPpm: p(200_000),
  floor: c(0),
  cap: c(300_000_000),
  basis: 'bid_price',
  requiredAbove: null,
  onlyWithPerformanceBond: true,
  source: { citation: 'FAR 28.101-2', url: 'https://www.acquisition.gov/far/28.101-2', effective: 'current FAR' },
};
/** D-35: Nevada State Public Works bid security 5% of base bid + alternates, bids over $100,000. */
const NV_SPWD_BID: BidSecurityRule = {
  id: 'nv_spwd',
  pctPpm: p(50_000),
  floor: c(0),
  cap: null,
  basis: 'base_plus_alternates',
  requiredAbove: c(10_000_000),
  onlyWithPerformanceBond: false,
  source: { citation: 'NAC 341', url: 'https://www.leg.state.nv.us/nac/nac-341.html', effective: 'current' },
};
/** D-36: California 10% of the amount bid. */
const CA_BID: BidSecurityRule = { id: 'ca', pctPpm: p(100_000), floor: c(0), cap: null, basis: 'amount_bid', requiredAbove: null, onlyWithPerformanceBond: false, source: CIV_9550 };

/** D-37: SBA surety bond guarantee fee (corrected). */
const SBA: SbaFeeTable = {
  switchDate: d('2026-11-30'),
  rateBeforePpm: p(6_000),
  rateFromPpm: p(7_290),
  contractLimit: c(900_000_000),
  federalCertifiedLimit: c(1_400_000_000),
  source: { citation: '91 FR (2026-10-30) 2026-22177', url: 'https://www.federalregister.gov/documents/2026/10/30/2026-22177/surety-bond-guarantee-program-fees', effective: 'as dated' },
};

/** D-38 sample Class B schedule (illustrative, A-1): $ per $1,000 as ppm on marginal slices. */
const CLASS_B: BondTier[] = [
  { upperBound: c(10_000_000), ratePpm: p(25_000) },
  { upperBound: c(50_000_000), ratePpm: p(15_000) },
  { upperBound: c(250_000_000), ratePpm: p(10_000) },
  { upperBound: c(500_000_000), ratePpm: p(7_500) },
  { upperBound: c(750_000_000), ratePpm: p(7_000) },
  { upperBound: null, ratePpm: p(6_500) },
];
const charges = (tiers: BondTier[], mDur = 1_000_000, fees: PriceChargesInput['fees'] = []): PriceChargesInput => ({ tiers, mDurPpm: p(mDur), fees });

// ---------------------------------------------------------------- fixtures: spec 8.5 retainage (D-43, D-48 .. D-52)
const R = (id: string, rho1: number, theta: number | null, rho2: number, kappa: number | null = null, cap: number | null = null, half = false): RetainageRule => ({
  id,
  rho1Ppm: p(rho1),
  thetaPpm: theta === null ? null : p(theta),
  rho2Ppm: p(rho2),
  kappaPpm: kappa === null ? null : p(kappa),
  dollarCap: cap === null ? null : c(cap),
  halfRelease: half,
});
const FED_DEFAULT = R('federal', 0, null, 0); // FAR 52.232-5
const FED_STRESS = R('federal_stress', 100_000, null, 100_000, 100_000); // FAR 52.232-5, 32.103
const NV_BEST = R('nv_best', 50_000, 500_000, 0); // NRS 338.515
const NV_BASE = R('nv_base', 50_000, 500_000, 25_000, null, null, true);
const NV_STRESS = R('nv_stress', 50_000, 500_000, 50_000);
const NDOT_RET = R('ndot', 50_000, null, 50_000, 50_000, 5_000_000); // NRS 408: 5%, not more than $50,000
const CA_7201 = R('ca_7201', 50_000, null, 50_000, 50_000); // PCC 7201
const CALTRANS = R('caltrans', 0, null, 0); // PCC 7202
const FLAT5 = R('flat5', 50_000, null, 50_000);

/** D-44, D-48, D-53 payment timing presets (spec 4.6). */
const FED_TIMING: PaymentTimingPreset = { id: 'federal', billingCycle: 'monthly', payLagDays: 14, retainageReleaseLagDays: 30, subPayLagDays: 7, source: { citation: 'FAR 32.904, 52.232-27', url: 'https://www.acquisition.gov/far/32.904', effective: 'current FAR' } };
const NV_TIMING: PaymentTimingPreset = { id: 'nv', billingCycle: 'per_contract', payLagDays: 30, retainageReleaseLagDays: null, subPayLagDays: 10, source: { citation: 'NRS 338.515', url: 'https://www.leg.state.nv.us/nrs/NRS-338.html', effective: 'current' } };

// ---------------------------------------------------------------- helpers
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** I-15 job (spec 11.4). */
function i15(over: Partial<CashJobInput> = {}, cat: Partial<Record<'other' | 'labor' | 'material', Partial<CashCategory>>> = {}): CashJobInput {
  return {
    periodDays: 7,
    workPeriods: 8,
    price: c(4_500_000),
    billingPeriods: 4,
    ownerLagPeriods: 4,
    retainageReleasePeriods: 8,
    retainage: FLAT5,
    categories: [
      { id: 'other', kind: 'pre_start', amount: c(200_000), weights: [1], lagPeriods: 0, ...cat.other },
      { id: 'labor', kind: 'labor', amount: c(1_600_000), weights: [0, 1, 1, 1, 1, 1, 1, 1, 1], lagPeriods: 1, ...cat.labor },
      { id: 'material', kind: 'material', amount: c(1_800_000), weights: [0, 1, 0, 0, 0, 1, 0, 0, 0], lagPeriods: 4, deposit: { sharePpm: p(250_000), period: 0 }, ...cat.material },
    ],
    ...over,
  };
}
const F = (j: CashJobInput) => peakFloat(cashLedger(j)).F;

/** Random job generator (bounded cents; integer weights; lags in periods). */
const arbCategory = (D: number, i: number) =>
  fc
    .record({
      amount: fc.integer({ min: 0, max: 5_000_000 }),
      weights: fc.array(fc.integer({ min: 0, max: 5 }), { minLength: D + 1, maxLength: D + 1 }),
      lag: fc.integer({ min: 0, max: 5 }),
      dep: fc.option(fc.integer({ min: 0, max: 500_000 }), { nil: undefined }),
      kind: fc.constantFrom('labor', 'material', 'equipment', 'subcontract', 'other' as const),
    })
    .map((r): CashCategory => {
      const w = r.weights.some((x) => x > 0) ? r.weights : r.weights.map((x, t) => (t === 1 || (D === 0 && t === 0) ? 1 : x));
      return {
        id: `k${i}`,
        kind: r.kind as CashCategory['kind'],
        amount: c(r.amount),
        weights: w,
        lagPeriods: r.lag,
        ...(r.dep === undefined ? {} : { deposit: { sharePpm: p(r.dep), period: 0 } }),
      };
    });
const arbJob = fc
  .record({
    D: fc.integer({ min: 1, max: 12 }),
    b: fc.integer({ min: 1, max: 6 }),
    lam: fc.integer({ min: 0, max: 6 }),
    extraRel: fc.integer({ min: 0, max: 4 }),
    rho: fc.integer({ min: 0, max: 100_000 }),
    markup: fc.integer({ min: 0, max: 500_000 }),
    nCat: fc.integer({ min: 1, max: 4 }),
  })
  .chain((g) =>
    fc.tuple(fc.constant(g), fc.tuple(...Array.from({ length: g.nCat }, (_, i) => arbCategory(g.D, i)))).map(([g, cats]): CashJobInput => {
      let cs = cats as CashCategory[];
      if (sum(cs.map((k) => k.amount)) === 0) cs = [{ ...cs[0]!, amount: c(100_000) }, ...cs.slice(1)];
      const C = sum(cs.map((k) => k.amount));
      return {
        periodDays: 7,
        workPeriods: g.D,
        price: mulRate(c(C), p(1_000_000 + g.markup)),
        billingPeriods: g.b,
        ownerLagPeriods: g.lam,
        retainageReleasePeriods: g.lam + g.extraRel,
        retainage: R('flat', g.rho, null, g.rho),
        categories: cs,
      };
    }),
  );
const J = (j: CashJobInput) => Math.ceil(j.workPeriods / j.billingPeriods);

// ================================================================ golden examples (spec 11)

describe('11 golden examples, sections 4 and 5', () => {
  test('P-12 5 CFR 1315.17: 1,500 x 0.065/360 x 10 = 2.71', () => {
    expect(simpleInterest(c(150_000), p(65_000), 10, 360).interest).toBe(271);
    expect(federalLatePaymentInterest(c(150_000), p(65_000), 0, 10).interest).toBe(271);
  });
  test('P-16 / I-3 premiums on the corrected D-38 schedule through bondPremium', () => {
    const q = (P: number) => bondPremium(c(P), charges(CLASS_B));
    expect([q(10_000_000), q(100_000_000), q(1_000_000_000), q(5_000_000_000)]).toEqual([250_000, 1_350_000, 8_100_000, 34_100_000]);
    expect([q(500_000_000), q(750_000_000)]).toEqual([4_725_000, 6_475_000]);
  });
  test('I-2 SBA fee payable on the bonded gross-up: $1,109.00 at $6.00, $1,350.00 at $7.29', () => {
    const before = charges(CLASS_B, 1_000_000, [sbaFeeCharge(SBA, d('2026-11-29'))]);
    const after = charges(CLASS_B, 1_000_000, [sbaFeeCharge(SBA, d('2026-11-30'))]);
    const g6 = grossUp(c(18_000_000), before), g7 = grossUp(c(18_000_000), after);
    expect([g6.P, g7.P]).toEqual([18_488_253, 18_512_647]);
    expect(sbaFee(SBA, g6.P, d('2026-11-29'), { guarantee: 'contract' }).feePayable).toBe(110_900);
    expect(sbaFee(SBA, g7.P, d('2026-11-30'), { guarantee: 'contract' }).feePayable).toBe(135_000);
  });
  test('I-4 bid security and SBA fee', () => {
    expect(bidSecurity(FED_BID, c(100_000_000), true)).toBe(20_000_000);
    expect(bidSecurity(FED_BID, c(1_500_000_000), true)).toBe(300_000_000);
    expect(bidSecurity(FED_BID, c(1_499_999_997), true)).toBe(299_999_999);
    expect(sbaFee(SBA, c(40_000_000), d('2026-01-15'), { guarantee: 'contract' }).feePayable).toBe(240_000);
    expect(sbaFee(SBA, c(40_000_000), d('2026-12-01'), { guarantee: 'contract' }).feePayable).toBe(291_600);
  });
  test('I-12 retainage, $240,000 contract, six $40,000 billings', () => {
    const bills = Array.from({ length: 6 }, () => c(4_000_000));
    const best = retainageSchedule(NV_BEST, c(24_000_000), bills);
    expect(best.rows.map((r) => r.W)).toEqual([200_000, 200_000, 200_000, 0, 0, 0]);
    expect(best.heldAtEnd).toBe(600_000);
    const base = retainageSchedule(NV_BASE, c(24_000_000), bills);
    expect(base.rows.map((r) => r.W)).toEqual([200_000, 200_000, 200_000, 100_000, 100_000, 100_000]);
    expect(base.rows.map((r) => r.Rel)).toEqual([0, 0, 0, 300_000, 0, 0]);
    expect(base.heldAtEnd).toBe(600_000);
    expect(retainageSchedule(NV_STRESS, c(24_000_000), bills).totalWithheld).toBe(1_200_000);
    expect(retainageSchedule(CA_7201, c(24_000_000), bills).totalWithheld).toBe(1_200_000);
  });
  test('I-13 billing that crosses 50%: 5% x 22,500 + 2.5% x 1,250 = 1,156.25', () => {
    const s = retainageSchedule(NV_BASE, c(4_500_000), [c(2_375_000)]);
    expect([s.rows[0]!.below, s.rows[0]!.above, s.rows[0]!.W]).toEqual([2_250_000, 125_000, 115_625]);
    expect(mulRate(c(2_375_000), p(25_000))).toBe(59_375); // the whole billing at 2.5% would be 593.75
  });
  test('I-14 retainage financing and late interest', () => {
    const nv = retainageFinancingCost({ withheld: [60, 90, 120].map((tau) => ({ W: c(200_000), tauDay: tau })), releaseDay: 240, annualRatePpm: p(90_000), dayCountBasis: 365 });
    expect(nv.gross).toBe(22_192);
    const ca = retainageFinancingCost({ withheld: [60, 90, 120, 150, 180, 210].map((tau) => ({ W: c(200_000), tauDay: tau })), releaseDay: 270, annualRatePpm: p(90_000), dayCountBasis: 365 });
    expect(ca.gross).toBe(39_945);
    const uni = retainageFinancingUniform({ rhoPpm: p(50_000), C: c(24_000_000), annualRatePpm: p(90_000), T: 6, deltaDays: 30, releaseLagDays: 60, dayCountBasis: 365 });
    expect(rEq(uni, ca.grossExact)).toBe(true);
    expect(federalLatePaymentInterest(c(5_000_000), p(47_500), 0, 20).interest).toBe(13_194);
  });
  test('I-15 cash float, weekly grid (spec 11.4)', () => {
    const L = cashLedger(i15());
    expect(L.K.slice(0, 9)).toEqual([200_000, 1_300_000, 1_500_000, 1_700_000, 1_900_000, 3_000_000, 3_200_000, 3_400_000, 3_600_000]);
    expect(L.payApps.map((a) => [a.t, a.gross, a.withheld, a.net, a.receivedAt])).toEqual([
      [4, 2_375_000, 118_750, 2_256_250, 8],
      [8, 2_125_000, 106_250, 2_018_750, 12],
    ]);
    expect([L.finalReleaseAt, L.finalRelease]).toEqual([16, 225_000]);
    expect(L.OUT.slice(0, 10)).toEqual([650_000, 0, 200_000, 200_000, 200_000, 875_000, 200_000, 200_000, 200_000, 875_000]);
    expect(L.Nminus).toEqual([-650_000, -650_000, -850_000, -1_050_000, -1_250_000, -2_125_000, -2_325_000, -2_525_000, -2_725_000, ...Array(4).fill(-1_343_750), ...Array(4).fill(675_000)]);
    expect(L.N).toEqual([-650_000, -650_000, -850_000, -1_050_000, -1_250_000, -2_125_000, -2_325_000, -2_525_000, -468_750, ...Array(3).fill(-1_343_750), ...Array(4).fill(675_000), 900_000]);
    const pk = peakFloat(L);
    expect([pk.F, pk.tStar, pk.Frf, pk.tStarRf]).toEqual([2_725_000, 8, 2_525_000, 7]);
    expect(Number(rRound(rMul(pk.FOverCost, ratio(10_000n))))).toBe(7_569);
    expect(Number(rRound(rMul(pk.FOverPrice!, ratio(10_000n))))).toBe(6_056);
    expect(pk.compositionAtPeak).toEqual({ labor: 1_400_000, material: 1_125_000, other: 200_000 });
    expect(accountingView(L).slice(0, 9).map((r) => r.billedMinusEarned)).toEqual([-250_000, -1_625_000, -1_875_000, -2_125_000, 0, -1_375_000, -1_625_000, -1_875_000, 0]);
    const w5 = accountingView(L)[5]!;
    expect([w5.GP, w5.billedMinusEarned, w5.AR, w5.RR, w5.AP, w5.N]).toEqual([750_000, -1_375_000, 2_256_250, 118_750, 875_000, -2_125_000]);
    // Financing at 9.00%, 360 basis, weekly grid
    const fin = financingCost(L, p(90_000), 360);
    expect(pk.dollarDays).toBe(15_925_000 * 7); // 159,250 dollar-weeks
    expect(rEq(fin.simpleApprox, ratio(27_868_75n, 100n))).toBe(true); // 278.6875
    expect(fin.FIN).toBe(28_110); // 281.099412
    expect(fin.financedPeak).toBe(2_745_077);
    expect(fin.financedFinalCash).toBe(871_890);
    expect(Number(rRound(rMul(fin.mFin, ratio(10_000n))))).toBe(78);
    // Sensitivities of the peak
    expect(F(i15({ ownerLagPeriods: 8, retainageReleasePeriods: 12 }))).toBe(3_600_000);
    expect(F(i15({ ownerLagPeriods: 2 }))).toBe(2_325_000);
    expect(F(i15({ billingPeriods: 2 }))).toBe(2_325_000);
    expect(F(i15({ retainage: FED_DEFAULT }))).toBe(2_725_000);
    expect(F(i15({ retainage: R('ten', 100_000, null, 100_000) }))).toBe(2_725_000);
    expect(F(i15({ price: c(3_960_000) }))).toBe(2_725_000);
    expect(F(i15({}, { material: { deposit: { sharePpm: p(0), period: 0 } } }))).toBe(2_500_000);
    expect(F(i15({}, { material: { deposit: { sharePpm: p(500_000), period: 0 } } }))).toBe(2_950_000);
    expect(F(i15({}, { material: { lagPeriods: 8 } }))).toBe(2_050_000);
    const st = stressCases(i15(), { extraOwnerLagDays: [], codKinds: ['material'], laborIncreasePpm: p(200_000) });
    expect(st.cases.map((s) => [s.id, s.peak.F, s.peak.finalCash])).toEqual([
      ['supplier_cod', 3_400_000, 900_000],
      ['labor_up', 3_005_000, 580_000],
    ]);
    // Limit check: against 25,000 of cash plus credit, short by 2,250
    const lc = limitsCheck({ price: L.P, peak: pk, limits: { cashForJob: c(1_500_000), unusedCreditLine: c(1_000_000) }, bondRequired: false });
    const pf = lc.checks.find((x) => x.id === 'peak_float')!;
    expect([pf.verdict, pf.outcome, lc.headroom]).toEqual(['stop', 'short by $2,250.00', -225_000]);
  });
  test('I-16 closed-form oracle (uniform cost paid when incurred)', () => {
    const cases: [number, number, number, number, number, number, number][] = [
      [3_600_000, 12, 4, 2, 50_000, 250_000, 1_800_000],
      [3_600_000, 12, 4, 2, 100_000, 50_000, 1_866_000],
      [3_600_000, 8, 4, 4, 50_000, 250_000, 3_600_000],
      [5_000_000, 3, 4, 4, 50_000, 150_000, 5_000_000],
    ];
    for (const [C, D, b, lam, r, m, want] of cases) {
      const P = mulRate(c(C), p(1_000_000 + m));
      expect(rEq(closedFormPeak(c(C), P, D, b, lam, p(r)), ratio(want))).toBe(true);
      const job: CashJobInput = {
        periodDays: 7, workPeriods: D, price: P, billingPeriods: b, ownerLagPeriods: lam, retainageReleasePeriods: lam,
        retainage: R('flat', r, null, r),
        categories: [{ id: 'all', kind: 'other', amount: c(C), weights: [0, ...Array(D).fill(1)], lagPeriods: 0 }],
      };
      expect(F(job)).toBe(want);
    }
  });
  test('I-17 billing cycle is not monotone: b = 4 gives 13,000; b = 5 gives 11,000', () => {
    const job = (b: number): CashJobInput => ({
      periodDays: 7, workPeriods: 8, price: c(1_300_000), billingPeriods: b, ownerLagPeriods: 1, retainageReleasePeriods: 1, retainage: FED_DEFAULT,
      categories: [
        { id: 'material', kind: 'material', amount: c(1_000_000), weights: [0, 0, 0, 0, 0, 1, 0, 0, 0], lagPeriods: 0 },
        { id: 'labor', kind: 'labor', amount: c(300_000), weights: [0, 0, 0, 0, 0, 0, 1, 1, 1], lagPeriods: 0 },
      ],
    });
    expect([F(job(4)), F(job(5)), F(job(8))]).toEqual([1_300_000, 1_100_000, 1_300_000]);
  });
});

// ================================================================ 10.2 #15 and #22 (bond premium, SBA fee)

const arbTiers = fc
  .array(fc.tuple(fc.integer({ min: 1, max: 50_000_000 }), fc.integer({ min: 0, max: 60_000 })), { minLength: 1, maxLength: 6 })
  .map((xs) => {
    let b = 0;
    const tiers: BondTier[] = xs.map(([w, r]) => ((b += w), { upperBound: c(b), ratePpm: p(r) }));
    tiers.push({ upperBound: null, ratePpm: p(xs[xs.length - 1]![1]) });
    return tiers;
  });

describe('10.2 bond premium and SBA fee', () => {
  test('invariant 15: the tier schedule is continuous across every boundary: premium steps 0 or 1 cent', () => {
    fc.assert(
      fc.property(arbTiers, fc.integer({ min: 1_000_000, max: 1_300_000 }), (tiers, m) => {
        const ch = charges(tiers, m);
        for (const t of tiers) {
          if (t.upperBound === null) continue;
          const b = t.upperBound;
          const q = (x: number) => bondPremium(c(x), ch);
          for (const step of [q(b + 1) - q(b), q(b) - q(b - 1)]) expect(step === 0 || step === 1).toBe(true);
        }
      }),
    );
  });
  test('invariant 22: SBA fee non-decreasing in C; 0 for bid bonds; refused above the limit; switch exactly at 2026-11-30; |payable - exact| <= 50 cents', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 900_000_000 }), fc.integer({ min: 0, max: 1_000_000 }), fc.constantFrom('2026-11-29', '2026-11-30', '2025-06-01', '2027-02-01'), (C, dC, day) => {
        const C2 = Math.min(900_000_000, C + dC);
        const a = sbaFee(SBA, c(C), d(day), { guarantee: 'contract' }), b = sbaFee(SBA, c(C2), d(day), { guarantee: 'contract' });
        expect(b.feePayable).toBeGreaterThanOrEqual(a.feePayable);
        expect(sbaFee(SBA, c(C), d(day), { guarantee: 'bid_bond' }).feePayable).toBe(0);
        const diff = rSub(ratio(a.feePayable), a.feeExact);
        expect(rCmp(diff, ratio(50)) <= 0 && rCmp(diff, ratio(-50)) >= 0).toBe(true);
      }),
    );
    expect(sbaFeeRatePpm(SBA, d('2026-11-29'))).toBe(6_000);
    expect(sbaFeeRatePpm(SBA, d('2026-11-30'))).toBe(7_290);
    expect(() => sbaFee(SBA, c(900_000_001), d('2026-11-01'), { guarantee: 'contract' })).toThrow(RangeError);
    expect(sbaFee(SBA, c(900_000_001), d('2026-11-01'), { guarantee: 'contract', federalCertified: true }).feePayable).toBe(5_400_000); // $9,000,000.01 x $6.00 per $1,000 = $54,000
    expect(() => sbaFee(SBA, c(1_400_000_001), d('2026-11-01'), { guarantee: 'contract', federalCertified: true })).toThrow(RangeError);
  });
});

// ================================================================ 10.6 bonds, thresholds, retainage

const arbRule = fc
  .record({
    rho1: fc.integer({ min: 0, max: 200_000 }),
    rho2: fc.integer({ min: 0, max: 200_000 }),
    theta: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: null }),
    kappa: fc.option(fc.integer({ min: 0, max: 200_000 }), { nil: null }),
    cap: fc.option(fc.integer({ min: 0, max: 10_000_000 }), { nil: null }),
    half: fc.boolean(),
  })
  .map((r) => R('gen', r.rho1, r.theta, r.rho2, r.kappa, r.cap, r.half && r.theta !== null));
/** A contract and billings that never exceed it (a random share of C, split by random weights). */
const arbBillings = fc
  .tuple(fc.integer({ min: 1, max: 100_000_000 }), fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 12 }), fc.integer({ min: 0, max: 1_000_000 }))
  .map(([C, ws, frac]) => {
    const billed = Math.floor((C * frac) / 1_000_000);
    const tot = sum(ws) || 1;
    return { C: c(C), bills: ws.map((w) => c(Math.floor((billed * w) / tot))) };
  });

describe('10.6 bonds, thresholds, retainage', () => {
  test('invariant 59: FLOOR <= S_bid <= CAP; non-decreasing; = p*bid between them; federal cap binds from $15,000,000 at 20%', () => {
    const rule: BidSecurityRule = { ...FED_BID, floor: c(500_000) };
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000_000 }), fc.integer({ min: 0, max: 100_000_000 }), (B, dB) => {
        const s = bidSecurity(rule, c(B), true), s2 = bidSecurity(rule, c(B + dB), true);
        expect(s).toBeGreaterThanOrEqual(500_000);
        expect(s).toBeLessThanOrEqual(300_000_000);
        expect(s2).toBeGreaterThanOrEqual(s);
        const raw = mulRate(c(B), p(200_000));
        if (raw >= 500_000 && raw <= 300_000_000) expect(s).toBe(raw);
        if (B >= 1_500_000_000) expect(bidSecurity(FED_BID, c(B), true)).toBe(300_000_000);
        if (B < 1_499_999_998) expect(bidSecurity(FED_BID, c(B), true)).toBeLessThan(300_000_000);
      }),
    );
    expect(bidSecurity(FED_BID, c(1_500_000_000), false)).toBe(0);
  });
  test('invariant 60: federal walk-away exposure is max(0, B_next - B) whatever S_bid; difference never exceeds S_bid', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), fc.integer({ min: 0, max: 1_000_000_000 }), fc.integer({ min: 0, max: 300_000_000 }), (B, Bn, S) => {
        expect(walkAwayExposure('federal', c(S), c(B), c(Bn))).toBe(Math.max(0, Bn - B));
        expect(walkAwayExposure('difference', c(S), c(B), c(Bn))).toBeLessThanOrEqual(S);
        expect(walkAwayExposure('difference', c(S), c(B), c(Bn))).toBe(Math.min(S, Math.max(0, Bn - B)));
        expect(walkAwayExposure('forfeiture', c(S), c(B), c(Bn))).toBe(S);
      }),
    );
  });
  test('invariant 61: legal thresholds jump only where the law puts them (threshold - 1 cent, threshold, + 1 cent)', () => {
    const at = (t: BondRequirementTable, C: number) => bondRequirement(t, c(C)).anyBond;
    expect([at(FED_BONDS, 14_999_999), at(FED_BONDS, 15_000_000), at(FED_BONDS, 15_000_001)]).toEqual(['officer_choice', 'officer_choice', 'yes']);
    expect([at(FED_BONDS, 3_499_999), at(FED_BONDS, 3_500_000), at(FED_BONDS, 3_500_001)]).toEqual(['no', 'no', 'officer_choice']);
    expect([at(NV_BONDS, 9_999_999), at(NV_BONDS, 10_000_000), at(NV_BONDS, 10_000_001)]).toEqual(['no', 'no', 'yes']);
    expect([at(CA_LOCAL_BONDS, 2_499_999), at(CA_LOCAL_BONDS, 2_500_000), at(CA_LOCAL_BONDS, 2_500_001)]).toEqual(['no', 'no', 'yes']);
    expect([at(NDOT_BONDS, 0), at(NDOT_BONDS, 1)]).toEqual(['yes', 'yes']);
    expect(bondRequirement(CA_LOCAL_BONDS, c(2_500_001)).payment.penal).toBe(2_500_001);
    expect(bondRequirement(CA_LOCAL_BONDS, c(2_500_001)).performance.need).toBe('from_bid_documents');
    expect(bondRequirement(NV_BONDS, c(10_000_001)).performance).toEqual({ need: 'required', ppm: 500_000, penal: 5_000_001, statutoryMinimum: true });
    // bid documents override the preset
    const ovr = bondRequirement(NV_BONDS, c(5_000_000), { performancePpm: p(1_000_000) });
    expect([ovr.anyBond, ovr.overriddenByBidDocuments, ovr.performance.penal]).toEqual(['yes', true, 5_000_000]);
    // bid security trigger: Nevada State Public Works, bids in excess of $100,000
    expect([9_999_999, 10_000_000, 10_000_001].map((B) => bidSecurityRequired(NV_SPWD_BID, c(B), false))).toEqual([false, false, true]);
    expect(bidSecurityRequired(FED_BID, c(20_000_000), false)).toBe(false);
    expect(bidSecurityRequired(FED_BID, c(20_000_000), true)).toBe(true);
    expect(bidSecurity(CA_BID, c(4_000_000), true)).toBe(400_000);
    // the 'auto' hook: bond tiers apply only above the threshold (the jump is intentional)
    const hook = bondRequiredAutoHook(FED_BONDS, false);
    expect([hook(c(15_000_000)), hook(c(15_000_001))]).toEqual([false, true]);
    expect(bondRequiredAutoHook(FED_BONDS, true)(c(3_500_001))).toBe(true);
  });
  test('invariant 62: per billing 0 <= W_j <= max(rho1, rho2) * B_j (plus half a cent per part)', () => {
    fc.assert(
      fc.property(arbRule, arbBillings, (rule, { C, bills }) => {
        const s = retainageSchedule(rule, C, bills);
        for (const r of s.rows) {
          expect(r.W).toBeGreaterThanOrEqual(0);
          expect(BigInt(r.W) * 1_000_000n).toBeLessThanOrEqual(BigInt(Math.max(rule.rho1Ppm, rule.rho2Ppm)) * BigInt(r.B) + 1_000_000n);
        }
      }),
    );
  });
  test('invariant 63: net payments + retainage held + retainage released = gross billings at every billing; all released by closeout', () => {
    fc.assert(
      fc.property(arbRule, arbBillings, (rule, { C, bills }) => {
        const s = retainageSchedule(rule, C, bills);
        let paid = 0, rel = 0, billed = 0;
        for (const r of s.rows) {
          paid += r.pay;
          rel += r.Rel;
          billed += r.B;
          expect(paid + r.R + rel).toBe(billed);
          expect(r.R).toBeGreaterThanOrEqual(0);
        }
        expect(s.totalHalfReleased + s.heldAtEnd).toBe(s.totalWithheld);
      }),
    );
  });
  test('invariant 64: without a half release, total withheld = rho1*min(E, theta*C) + rho2*max(0, E - theta*C) within one cent per billing, however the work is split', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        arbBillings,
        (rho1, rho2, theta, { C, bills }) => {
          const rule = R('x', rho1, theta, rho2);
          const s = retainageSchedule(rule, C, bills);
          const E = BigInt(sum(bills));
          const tC = ratio(BigInt(C) * BigInt(theta), 1_000_000n);
          const lo = rCmp(ratio(E), tC) < 0 ? ratio(E) : tC;
          const hi = rSub(ratio(E), lo);
          const exact = ratio(lo.num * BigInt(rho1) * hi.den + hi.num * BigInt(rho2) * lo.den, lo.den * hi.den * 1_000_000n);
          const diff = rSub(ratio(s.totalWithheld), exact);
          const bound = ratio(BigInt(bills.length) * 2n + 1n, 2n);
          expect(rCmp(diff, bound) <= 0 && rCmp(diff, ratio(-bound.num, bound.den)) >= 0).toBe(true);
        },
      ),
    );
  });
  test('invariant 65: gross withheld never exceeds the cap (California 5% of C; NDOT min(5%, $50,000); federal 10%)', () => {
    fc.assert(
      fc.property(fc.constantFrom(CA_7201, NDOT_RET, FED_STRESS), arbBillings, (rule, { C, bills }) => {
        const s = retainageSchedule(rule, C, bills);
        expect(s.totalWithheld).toBeLessThanOrEqual(s.capTotal!);
        for (const r of s.rows) expect(r.grossWithheld).toBeLessThanOrEqual(s.capTotal!);
      }),
    );
    expect(retainageSchedule(NDOT_RET, c(200_000_000), [c(200_000_000)]).totalWithheld).toBe(5_000_000);
    expect(retainageSchedule(CALTRANS, c(200_000_000), [c(200_000_000)]).totalWithheld).toBe(0);
  });
  test('invariant 66: the Nevada half release is half the retainage withheld before 50%, once; held is never negative', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30_000 }), arbBillings, (rho2, { C, bills }) => {
        const s = retainageSchedule(R('nvb', 50_000, 500_000, rho2, null, null, true), C, bills);
        const rel = s.rows.filter((r) => r.Rel > 0);
        expect(rel.length).toBeLessThanOrEqual(1);
        const at = s.rows.findIndex((r) => r.above > 0);
        if (at >= 0) {
          const first = sum(s.rows.slice(0, at + 1).map((r) => mulRate(r.below, p(50_000))));
          expect(s.rows[at]!.Rel).toBe(Number(divRoundHalfUp(first, 2)));
        } else expect(s.totalHalfReleased).toBe(0);
        for (const r of s.rows) expect(r.R).toBeGreaterThanOrEqual(0);
      }),
    );
  });
  test('invariant 67: retainage financing >= 0, linear in i and the rate, non-decreasing in the delay, 0 when either is 0; uniform closed form = discrete sum', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 45 }),
        fc.integer({ min: 0, max: 120 }),
        fc.integer({ min: 100, max: 1_000_000 }),
        fc.constantFrom(360 as const, 365 as const),
        (rho, i, T, delta, Lrel, perBillDollars, basis) => {
          // T equal billings of 100*perBillDollars cents every delta days, paid delta days later, released L after the last receipt.
          const C = c(T * perBillDollars * 100);
          const Wj = mulRate(c(perBillDollars * 100), p(rho));
          const withheld = Array.from({ length: T }, (_, j) => ({ W: Wj, tauDay: (j + 2) * delta }));
          const release = (T + 1) * delta + Lrel;
          const fc1 = retainageFinancingCost({ withheld, releaseDay: release, annualRatePpm: p(i), dayCountBasis: basis });
          expect(fc1.gross).toBeGreaterThanOrEqual(0);
          if (i === 0 || rho === 0) expect(fc1.gross).toBe(0);
          const fc2 = retainageFinancingCost({ withheld, releaseDay: release, annualRatePpm: p(2 * i), dayCountBasis: basis });
          expect(rEq(fc2.grossExact, rMul(fc1.grossExact, ratio(2n)))).toBe(true);
          const later = retainageFinancingCost({ withheld, releaseDay: release + 1, annualRatePpm: p(i), dayCountBasis: basis });
          expect(rCmp(later.grossExact, fc1.grossExact)).toBeGreaterThanOrEqual(0);
          // linear in the retainage rate when the withheld amounts are exact
          if ((perBillDollars * 100 * rho) % 1_000_000 === 0) {
            const W2 = withheld.map((w) => ({ ...w, W: c(w.W * 2) }));
            const fc3 = retainageFinancingCost({ withheld: W2, releaseDay: release, annualRatePpm: p(i), dayCountBasis: basis });
            expect(rEq(fc3.grossExact, rMul(fc1.grossExact, ratio(2n)))).toBe(true);
            const uni = retainageFinancingUniform({ rhoPpm: p(rho), C, annualRatePpm: p(i), T, deltaDays: delta, releaseLagDays: Lrel, dayCountBasis: basis });
            expect(rEq(uni, fc1.grossExact)).toBe(true);
          }
        },
      ),
    );
  });
  test('invariant 68: late-payment interest is 0 at zero days, linear in principal and (simple form) in days', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000 }), fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 6 }), (P, r, days, n) => {
        expect(federalLatePaymentInterest(c(P), p(r), 0, 0).interest).toBe(0);
        expect(simpleInterest(c(P), p(r), 0, 365).interest).toBe(0);
        const a = federalLatePaymentInterest(c(P), p(r), n, days).exact, b = federalLatePaymentInterest(c(2 * P), p(r), n, days).exact;
        expect(rEq(b, rMul(a, ratio(2n)))).toBe(true);
        const s1 = simpleInterest(c(P), p(r), days, 365).exact, s2 = simpleInterest(c(P), p(r), 2 * days, 365).exact;
        expect(rEq(s2, rMul(s1, ratio(2n)))).toBe(true);
        expect(rEq(federalLatePaymentInterest(c(P), p(r), 0, days).exact, simpleInterest(c(P), p(r), days, 360).exact)).toBe(true);
      }),
    );
    expect(californiaRetentionCharge(c(1_000_000), p(20_000), 3)).toBe(60_000);
  });
  test('invariant 69: the premium true-up has the sign of C_final - C_orig', () => {
    fc.assert(
      fc.property(arbTiers, fc.integer({ min: 0, max: 2_000_000_000 }), fc.integer({ min: 0, max: 2_000_000_000 }), (tiers, a, b) => {
        const t = premiumTrueUp(charges(tiers), c(a), c(b));
        if (b > a) expect(t.delta).toBeGreaterThanOrEqual(0);
        if (b < a) expect(t.delta).toBeLessThanOrEqual(0);
        if (b === a) expect(t.delta).toBe(0);
        expect(t.additional - t.refund).toBe(t.delta);
      }),
    );
  });
});

// ================================================================ 10.7 cash float

function exactLedgerCheck(L: CashLedger): void {
  expect(sum(L.OUT)).toBe(L.Ccash);
  expect(sum(L.IN)).toBe(L.P);
  expect(L.N[L.H]).toBe(L.P - L.Ccash);
}

describe('10.7 cash float', () => {
  test('invariant 70: sum OUT = C_cash; sum IN = P; N(H) = P - C_cash', () => {
    fc.assert(fc.property(arbJob, (job) => exactLedgerCheck(cashLedger(job))));
  });
  test('invariant 71: every period N = GP + OU - AR - RR + AP', () => {
    fc.assert(
      fc.property(arbJob, (job) => {
        const L = cashLedger(job);
        for (const r of accountingView(L)) expect(r.GP + r.billedMinusEarned - r.AR - r.RR + r.AP).toBe(r.N);
      }),
    );
  });
  test('invariant 72: 0 <= F*_rf <= F* <= C_cash', () => {
    fc.assert(
      fc.property(arbJob, (job) => {
        const L = cashLedger(job), pk = peakFloat(L);
        expect(pk.Frf).toBeGreaterThanOrEqual(0);
        expect(pk.Frf).toBeLessThanOrEqual(pk.F);
        expect(pk.F).toBeLessThanOrEqual(L.Ccash);
      }),
    );
  });
  test('invariant 73: F* >= all cash paid up to and including the period of the first receipt', () => {
    fc.assert(
      fc.property(arbJob, (job) => {
        const L = cashLedger(job), pk = peakFloat(L);
        expect(pk.F).toBeGreaterThanOrEqual(pk.upFront);
      }),
    );
  });
  test('invariant 74: scaling every dollar input by k scales F* and every balance by k (within the rounding bound)', () => {
    fc.assert(
      fc.property(arbJob, fc.integer({ min: 2, max: 5 }), (job, k) => {
        const scaled: CashJobInput = { ...job, price: c(job.price * k), categories: job.categories.map((x) => ({ ...x, amount: c(x.amount * k) })) };
        const A = cashLedger(job), B = cashLedger(scaled);
        // each rounded quantity (allocation parts, bill values, retainage parts) moves by at most k cents
        const bound = (k + 1) * (2 * job.categories.length * (job.workPeriods + 1) + 3 * J(job) + 3);
        expect(Math.abs(peakFloat(B).F - k * peakFloat(A).F)).toBeLessThanOrEqual(bound);
        A.N.forEach((n, t) => expect(Math.abs(B.N[t]! - k * n)).toBeLessThanOrEqual(bound));
      }),
    );
  });
  test('invariant 75: a longer owner payment lag never lowers F*', () => {
    fc.assert(
      fc.property(arbJob, fc.integer({ min: 1, max: 6 }), (job, x) => {
        expect(F({ ...job, ownerLagPeriods: job.ownerLagPeriods + x, retainageReleasePeriods: job.retainageReleasePeriods + x })).toBeGreaterThanOrEqual(F(job));
      }),
    );
  });
  test('invariant 76: higher retainage never lowers F* (retainage released after the last progress receipt)', () => {
    fc.assert(
      fc.property(arbJob, fc.integer({ min: 0, max: 200_000 }), (job, extra) => {
        const r = job.retainage.rho1Ppm + extra;
        expect(F({ ...job, retainage: R('hi', r, null, r) })).toBeGreaterThanOrEqual(F(job));
      }),
    );
  });
  test('invariant 77: a higher markup at the same cost never raises F* (exact; one cent of retainage rounding per bill)', () => {
    fc.assert(
      fc.property(arbJob, fc.integer({ min: 0, max: 50_000_000 }), (job, dP) => {
        expect(F({ ...job, price: c(job.price + dP) })).toBeLessThanOrEqual(F(job) + J(job));
      }),
    );
    // exact when retainage is zero
    fc.assert(
      fc.property(arbJob, fc.integer({ min: 0, max: 50_000_000 }), (job, dP) => {
        const j0 = { ...job, retainage: FED_DEFAULT };
        expect(F({ ...j0, price: c(job.price + dP) })).toBeLessThanOrEqual(F(j0));
      }),
    );
  });
  test('invariant 78: longer supplier terms or a later payday never raise F*; a larger deposit share never lowers it', () => {
    fc.assert(
      fc.property(arbJob, fc.nat({ max: 3 }), fc.integer({ min: 1, max: 6 }), fc.integer({ min: 0, max: 500_000 }), (job, ki, x, dd) => {
        const k = ki % job.categories.length;
        const cats = (f: (c0: CashCategory) => CashCategory) => job.categories.map((c0, i) => (i === k ? f(c0) : c0));
        expect(F({ ...job, categories: cats((c0) => ({ ...c0, lagPeriods: c0.lagPeriods + x })) })).toBeLessThanOrEqual(F(job));
        const d0 = job.categories[k]!.deposit?.sharePpm ?? 0;
        const more = { ...job, categories: cats((c0) => ({ ...c0, deposit: { sharePpm: p(Math.min(1_000_000, d0 + dd)), period: 0 } })) };
        const less = { ...job, categories: cats((c0) => ({ ...c0, deposit: { sharePpm: p(d0), period: 0 } })) };
        // largest-remainder allocation of the rest can move one cent per period
        expect(F(more)).toBeGreaterThanOrEqual(F(less) - (job.workPeriods + 1));
      }),
    );
  });
  test('invariant 79: coarser nested billing (b -> n*b) never lowers F* (exact without retainage; one cent per bill with it)', () => {
    fc.assert(
      fc.property(arbJob, fc.integer({ min: 2, max: 4 }), (job, n) => {
        const coarse = { ...job, billingPeriods: job.billingPeriods * n };
        expect(F(coarse)).toBeGreaterThanOrEqual(F(job) - J(job));
        const j0 = { ...job, retainage: FED_DEFAULT };
        expect(F({ ...j0, billingPeriods: job.billingPeriods * n })).toBeGreaterThanOrEqual(F(j0));
      }),
    );
  });
  test('invariant 80: uniform cost paid when incurred equals the closed form of spec 5.5 exactly', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1, max: 1_000 }),
        fc.integer({ min: 1, max: 2_000 }),
        (D, b, lam, rPct, cPer, pPer) => {
          const C = c(D * cPer * 100), P = c(D * pPer * 100), r = p(rPct * 10_000);
          const job: CashJobInput = {
            periodDays: 1, workPeriods: D, price: P, billingPeriods: b, ownerLagPeriods: lam, retainageReleasePeriods: lam,
            retainage: R('flat', r, null, r),
            categories: [{ id: 'all', kind: 'other', amount: C, weights: [0, ...Array(D).fill(1)], lagPeriods: 0 }],
          };
          expect(rEq(closedFormPeak(C, P, D, b, lam, r), ratio(F(job)))).toBe(true);
          if ((1_000_000 - r) * P >= 1_000_000 * C) expect(rEq(closedFormPeak(C, P, D, b, lam, r), ratio(BigInt(C) * BigInt(Math.min(D, b + lam)), BigInt(D)))).toBe(true);
        },
      ),
    );
  });
  test('invariant 81: when every payment precedes the first receipt, changing retainage or markup leaves F* unchanged', () => {
    fc.assert(
      fc.property(arbJob, fc.integer({ min: 0, max: 200_000 }), fc.integer({ min: 0, max: 2_000_000 }), (job, rho, m) => {
        const maxLag = Math.max(...job.categories.map((k) => k.lagPeriods));
        const base = { ...job, ownerLagPeriods: job.workPeriods + maxLag, retainageReleasePeriods: job.workPeriods + maxLag + 1 };
        const L = cashLedger(base), pk = peakFloat(L);
        expect(pk.tStar).toBeLessThanOrEqual(pk.firstReceiptPeriod!);
        const alt = { ...base, retainage: R('alt', rho, null, rho), price: mulRate(L.Ccash, p(1_000_000 + m)) };
        expect(F(alt)).toBe(pk.F);
      }),
    );
  });
  test('invariant 82: zero rate reproduces the unfinanced path; interest >= i_per * sum max(0, -N); financed peak >= unfinanced; financed final cash = P - C_cash - FIN', () => {
    fc.assert(
      fc.property(arbJob, fc.integer({ min: 0, max: 300_000 }), fc.constantFrom(360 as const, 365 as const), (job, i, basis) => {
        const L = cashLedger(job), pk = peakFloat(L);
        const z = financingCost(L, p(0), basis);
        expect([z.FIN, z.financedPeak, z.financedFinalCash]).toEqual([0, pk.F, L.P - L.Ccash]);
        const f = financingCost(L, p(i), basis);
        expect(rCmp(f.FINexact, f.simpleApprox)).toBeGreaterThanOrEqual(0);
        expect(f.financedPeak).toBeGreaterThanOrEqual(pk.F);
        expect(rEq(f.financedFinalCashExact, rSub(ratio(L.P - L.Ccash), f.FINexact))).toBe(true);
        expect(f.financedFinalCash).toBe(L.P - L.Ccash - f.FIN);
      }),
    );
  });
  test('invariant 83: pay applications sum to P; billed never exceeds P; billedMinusEarned <= 0 between bills and 0 on bill dates and at the end', () => {
    fc.assert(
      fc.property(arbJob, (job) => {
        const L = cashLedger(job);
        expect(sum(L.payApps.map((a) => a.gross))).toBe(L.P);
        const rows = accountingView(L);
        const billDates = new Set(L.payApps.map((a) => a.t));
        for (const r of rows) {
          expect(r.BL).toBeLessThanOrEqual(L.P);
          if (r.t <= L.D) expect(r.billedMinusEarned).toBeLessThanOrEqual(0);
          if (billDates.has(r.t) || r.t >= L.D) expect(r.billedMinusEarned).toBe(0);
        }
      }),
    );
  });
  test('invariant 84: cost-flow shapes: S(0)=0, S(1)=1, non-decreasing; weights >= 0 sum exactly to scale; one-third trapezoid gives 25% and 75%', () => {
    const third = ratio(1n, 3n);
    expect(rEq(trapezoidS(third, third, third), ratio(1n, 4n))).toBe(true);
    expect(rEq(trapezoidS(ratio(2n, 3n), third, third), ratio(3n, 4n))).toBe(true);
    const tri = costWeights({ kind: 'trapezoid', a: third, d: third }, 3).weights;
    expect(tri).toEqual([0, 250_000, 500_000, 250_000]);
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 0, max: 100 }),
        (D, ai, di, k, x0) => {
          const a = ratio(BigInt(ai), 100n), dd = ratio(BigInt(Math.min(di, 100 - ai)), 100n);
          const shapes = [
            { kind: 'uniform' as const },
            ...(dd.num > 0n ? [{ kind: 'trapezoid' as const, a, d: dd }] : []),
            { kind: 'logistic' as const, k, x0: x0 / 100 },
          ];
          for (const s of shapes) {
            const { weights, cumulative } = costWeights(s, D);
            expect(weights[0]).toBe(0);
            for (const w of weights) expect(w).toBeGreaterThanOrEqual(0);
            expect(sum(weights)).toBe(1_000_000);
            if (cumulative) {
              expect(rEq(cumulative[0]!, ratio(0n))).toBe(true);
              expect(rEq(cumulative[D]!, ratio(1n))).toBe(true);
              for (let t = 1; t <= D; t++) expect(rCmp(cumulative[t]!, cumulative[t - 1]!)).toBeGreaterThanOrEqual(0);
            }
          }
        },
      ),
    );
  });
  test('invariant 85: the portfolio peak of jobs on one calendar is at most the sum of the individual peaks', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(arbJob, fc.integer({ min: 0, max: 20 })), { minLength: 1, maxLength: 4 }), (jobs) => {
        const pf = portfolio(jobs.map(([j, s]) => ({ ledger: cashLedger(j), startPeriod: s })));
        expect(pf.peak).toBeLessThanOrEqual(pf.sumOfPeaks);
      }),
    );
  });
  test('invariant 86: more cash or credit never turns fits into short; headroom is linear in funds', () => {
    const order = { ok: 0, warn: 1, stop: 2 } as const;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000 }), fc.integer({ min: 0, max: 100_000_000 }), fc.integer({ min: 0, max: 50_000_000 }), fc.integer({ min: 0, max: 300_000 }), (Fs, funds, more, beta) => {
        const a = floatVerdict(c(Fs), c(funds), p(beta)), b = floatVerdict(c(Fs), c(funds + more), p(beta));
        expect(order[b.verdict]).toBeLessThanOrEqual(order[a.verdict]);
        expect(b.headroom - a.headroom).toBe(more);
      }),
    );
  });
});

// ================================================================ supporting checks

describe('supporting checks (sections 4 and 5)', () => {
  test('limits: every check carries a verdict and its numbers; rules of thumb are never pass or fail', () => {
    const L = cashLedger(i15());
    const pk = peakFloat(L);
    const st = stressCases(i15(), { codKinds: ['material'] });
    expect(st.assumptions.map((a) => a.id)).toEqual(['A-28']);
    expect(st.cases.map((s) => s.id)).toEqual(['owner_lag_plus_30d', 'owner_lag_plus_60d', 'supplier_cod']);
    const out = limitsCheck({
      price: L.P,
      peak: pk,
      limits: { cashForJob: c(3_000_000), unusedCreditLine: c(0), maxJobSize: c(4_000_000), maxUpFrontCash: c(3_000_000), workingCapital: c(2_000_000), netWorth: c(5_000_000), backlog: c(10_000_000), currentAssets: c(3_000_000), currentLiabilities: c(2_000_000) },
      bondRequired: true,
      stress: st.cases,
    });
    const by = Object.fromEntries(out.checks.map((x) => [x.id, x]));
    expect([by.job_size!.verdict, by.job_size!.outcome]).toEqual(['stop', 'over by $5,000.00']);
    expect([by.up_front_cash!.verdict, by.up_front_cash!.numbers.upFront]).toEqual(['ok', 2_725_000]);
    expect(by.peak_float!.verdict).toBe('ok');
    expect([by.bonding!.verdict, by.bonding!.outcome, by.bonding!.ruleOfThumb]).toEqual(['unknown', 'Unknown: ask your surety agent.', true]);
    expect([by.bonding!.numbers.estimatedSingle, by.bonding!.numbers.estimatedAggregateLow, by.bonding!.numbers.estimatedAggregateHigh]).toEqual([20_000_000, 20_000_000, 40_000_000]);
    expect([by.liquidity_working_capital!.verdict, by.liquidity_current_ratio!.verdict]).toEqual(['info', 'info']);
    for (const x of out.checks) if (x.ruleOfThumb) expect(['info', 'unknown']).toContain(x.verdict);
    expect(out.stress.map((s) => [s.id, s.verdict])).toEqual([
      ['owner_lag_plus_30d', 'stop'],
      ['owner_lag_plus_60d', 'stop'],
      ['supplier_cod', 'stop'],
    ]);
    expect(out.assumptions.map((a) => a.id)).toEqual(['A-27']);
    const letter = limitsCheck({ price: c(50_000_000), peak: pk, limits: { cashForJob: c(0), unusedCreditLine: c(0), suretyLetter: { singleLimit: c(60_000_000), aggregateLimit: c(100_000_000), backlogRemaining: c(70_000_000) } }, bondRequired: true });
    const bond = letter.checks.find((x) => x.id === 'bonding')!;
    expect([bond.verdict, bond.outcome]).toEqual(['stop', 'over letter by $200,000.00']);
    // a buffer makes 'tight' possible
    expect(floatVerdict(c(1_000_000), c(1_050_000), p(100_000)).verdict).toBe('warn');
  });
  test('5.8 / 10.0 boundary: headroom >= 0 is "fits"; one cent less is tight or short', () => {
    // beta = 0: funds = F* fits exactly; F* - 1 is short by $0.01
    expect(floatVerdict(c(100_000), c(100_000), p(0))).toEqual({ verdict: 'ok', outcome: 'fits', need: 100_000, headroom: 0 });
    const short = floatVerdict(c(100_000), c(99_999), p(0));
    expect([short.verdict, short.outcome, short.headroom]).toEqual(['stop', 'short by $0.01', -1]);
    // beta = 10%: need = 110,000 exactly fits; one cent below need but >= F* is tight
    expect(floatVerdict(c(100_000), c(110_000), p(100_000))).toEqual({ verdict: 'ok', outcome: 'fits', need: 110_000, headroom: 0 });
    expect(floatVerdict(c(100_000), c(109_999), p(100_000)).verdict).toBe('warn');
    expect(floatVerdict(c(100_000), c(100_000), p(100_000)).verdict).toBe('warn');
    expect(floatVerdict(c(100_000), c(99_999), p(100_000)).verdict).toBe('stop');
  });
  test('D-46 shipped Prompt Payment rows (spec 8.5) and I-14 federal late interest from the shipped row', () => {
    const d = (s: string) => s as never;
    expect(lookupNumber('interest.promptPayment.rate', 'US', d('2026-01-01'))).toBe(41_250);
    expect(lookupNumber('interest.promptPayment.rate', 'US', d('2026-06-30'))).toBe(41_250);
    expect(lookupNumber('interest.promptPayment.rate', 'US', d('2026-07-01'))).toBe(47_500);
    expect(lookupNumber('interest.promptPayment.rate', 'US', d('2026-12-31'))).toBe(47_500);
    expect(lookupNumber('interest.promptPayment.dayCount', 'US', d('2026-11-13'))).toBe(360);
    const rate = lookupNumber('interest.promptPayment.rate', 'US', d('2026-11-13'));
    expect(federalLatePaymentInterest(c(5_000_000), p(rate), 0, 20).interest).toBe(13_194);
  });
  test('grid conversions: inflow lags rounded up, outflow lags rounded down (net 30 on a weekly grid = 4 periods)', () => {
    expect(outflowLagPeriods(30, 7)).toBe(4);
    expect(inflowLagPeriods(30, 7)).toBe(5);
    expect(inflowLagPeriods(14, 7)).toBe(2);
  });
  test('payment timing presets, liquidated damages, bond months (A-6), cash bid security cost', () => {
    expect(progressPaymentDay(FED_TIMING, 30)).toBe(44);
    expect(progressPaymentDay(NV_TIMING, 30, 60)).toBe(120);
    expect(liquidatedDamages(c(50_000), 130, 120)).toBe(500_000);
    expect(liquidatedDamages(c(50_000), 100, 120)).toBe(0);
    expect(bondMonths(d('2026-01-15'), d('2026-02-15')).months).toBe(1);
    expect(bondMonths(d('2026-01-15'), d('2026-02-16')).months).toBe(2);
    expect(bondMonths(d('2026-01-15'), d('2027-09-01')).months).toBe(20);
    expect(() => bondMonths(d('2026-02-01'), d('2026-01-01'))).toThrow(RangeError);
    const cash = bidSecurityCost({ sBid: c(1_000_000), form: 'cash', annualRatePpm: p(90_000), holdDays: 30, dayCountBasis: 365 });
    expect(cash.cost).toBe(7_397); // 10,000 x 9% x 30/365 = 73.97
    expect(bidSecurityCost({ sBid: c(1_000_000), form: 'bond' }).assumptions.map((a) => a.id)).toEqual(['A-2']);
  });
  test('federal bond premium as a retainage-free early line: billed in pay application 1, part of P', () => {
    const L = cashLedger(i15({ retainage: FLAT5, earlyLine: { amount: c(100_000), billing: 1 } }));
    expect(sum(L.payApps.map((a) => a.gross))).toBe(4_500_000);
    expect(L.payApps[0]!.gross - L.payApps[0]!.withheld).toBe(L.payApps[0]!.net);
    exactLedgerCheck(L);
  });
  test('refusals: release before the last receipt, deposits after the pay date, billing over the contract', () => {
    expect(() => cashLedger(i15({ retainageReleasePeriods: 3 }))).toThrow(RangeError);
    expect(() => cashLedger(i15({}, { material: { deposit: { sharePpm: p(250_000), period: 6 } } }))).toThrow(RangeError);
    expect(() => retainageSchedule(FLAT5, c(100), [c(60), c(41)])).toThrow(RangeError);
    expect(() => costWeights({ kind: 'trapezoid', a: ratio(2n, 3n), d: ratio(1n, 2n) }, 4)).toThrow(RangeError);
    expect(() => premiumTrueUp(charges(CLASS_B), c(-1), c(1))).toThrow(RangeError);
  });
  test('priceBasedCharge stays the single source of q(P): bondPremium agrees with it when there are no fees', () => {
    fc.assert(
      fc.property(arbTiers, fc.integer({ min: 0, max: 2_000_000_000 }), (tiers, P) => {
        expect(bondPremium(c(P), charges(tiers))).toBe(priceBasedCharge(c(P), charges(tiers)));
      }),
    );
  });
});

