// Golden examples of spec section 11 for sections 0 to 3 (exact-value tests).
// Published rows (P-n) carry their source; illustrations (I-n) are made-up inputs, test vectors only.
import { describe, expect, test } from 'vitest';
import {
  allocate,
  annualEmployerTaxes,
  bidRounding,
  bucketPay,
  buildBid,
  caElectricalClass,
  cappedShare,
  chargeSplit,
  classWages,
  compositeRateFlat,
  davisBaconWeekPay,
  divRoundHalfUp,
  durationMultiplierPpm,
  extend,
  futaRatePpm,
  grossUp,
  markupFromCostPrice,
  marginFromCostPrice,
  markupToMargin,
  marginToMarkup,
  mulRate,
  nvPrivateDailyOvertimeApplies,
  overtimePremiumRatio,
  partitionHours,
  prevailingWageCheck,
  priceBasedCharge,
  productiveRatio,
  rEq,
  rAdd,
  rRound,
  rMul,
  rToPpm,
  ratio,
  salesBasisToCostBasis,
  stackMultipliers,
  taskHours,
  workersComp,
  additiveStackShortfall,
  type BidInput,
  type BondTier,
  type Cents,
  type HoursC,
  type LaborClassInput,
  type PayrollTaxTable,
  type Ppm,
  type PriceChargesInput,
  type QtyM,
} from '../src/cost/index.js';

const c = (n: number) => n as Cents;
const p = (n: number) => n as Ppm;
const h = (n: number) => n as HoursC;

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
export const NV2025 = nvTable(2025, 17_610_000, 4_180_000, 0, false);
export const NV2026 = nvTable(2026, 18_450_000, 4_370_000, 0, false); // A-9: Nevada 0 with a warning
export const NV2027 = nvTable(2027, 19_230_000, 4_540_000, null, false); // A-34: rates unchanged, CR entered
export const CA2026: PayrollTaxTable = {
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
export const CLASS_B: BondTier[] = [
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
export function i1Input(): BidInput {
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

describe('11.2 I-1 Nevada job end to end', () => {
  const b = buildBid(i1Input());
  const [jm, ap] = b.labor.classes;
  test('I-1 per-class lines', () => {
    expect(jm!.wages.G).toBe(774_000);
    expect([jm!.SS, jm!.MED, jm!.FUTA, jm!.SUTA, jm!.MBT, jm!.WC, jm!.FR, jm!.L]).toEqual([47_988, 11_223, 361, 11_275, 8_270, 19_350, 67_200, 939_667]);
    expect(ap!.wages.G).toBe(288_000);
    expect([ap!.SS, ap!.MED, ap!.FUTA, ap!.SUTA, ap!.MBT, ap!.WC, ap!.FR, ap!.L]).toEqual([17_856, 4_176, 252, 7_866, 2_808, 7_200, 48_000, 376_158]);
    // effective rates shown in the I-1 table (display): 62,000 / 467 / 14,567 and 62,000 / 875 / 27,313
    const rates = (cc: typeof jm) => cc!.lines.filter((l) => ['SS', 'FUTA', 'SUTA'].some((k) => l.key.endsWith(`.${k}`))).map((l) => l.rate!.value);
    expect(rates(jm)).toEqual([62_000, 467, 14_567]);
    expect(rates(ap)).toEqual([62_000, 875, 27_313]);
  });
  test('I-1 totals', () => {
    const t = b.totals;
    expect(t.G).toBe(1_062_000);
    expect(t.L).toBe(1_315_825);
    expect(t.ST).toBe(26_317);
    expect(b.materials.M).toBe(1_800_320);
    expect(b.materials.lines.map((l) => l.ext)).toEqual([466_200, 210_120, 680_000, 444_000]);
    expect(b.materials.ESC_M).toBe(4_550);
    expect(b.materials.TB).toBe(1_804_870);
    expect(b.materials.TAX).toBe(128_146);
    expect(t.MAT).toBe(1_968_016);
    expect([t.E, t.SUB, t.JOOH]).toEqual([65_000, 320_000, 165_000]);
    expect(t.TJC).toBe(3_860_158);
    expect(t.OH).toBe(579_024);
    expect(t.BE).toBe(4_439_182);
    expect(t.PR).toBe(443_918);
    expect(t.S).toBe(4_883_100);
    expect(t.q).toBe(29_475);
    expect(t.P).toBe(4_912_575);
    // P - q(P) = S, and P - 1 cent fails
    expect(t.P - priceBasedCharge(t.P, i1Input().charges)).toBe(t.S);
    expect(t.P - 1 - priceBasedCharge(c(t.P - 1), i1Input().charges)).toBeLessThan(t.S);
    expect(b.warnings.some((w) => w.includes('FUTA credit reduction'))).toBe(true); // A-9 warning surfaced
  });
  test('I-1 read-outs', () => {
    const t = b.totals;
    const k = markupFromCostPrice(t.TJC, t.P);
    const m = marginFromCostPrice(t.TJC, t.P);
    expect(rToPpm(k)).toBe(272_636);
    expect(rToPpm(m)).toBe(214_229);
    expect(rEq(m, markupToMargin(k))).toBe(true);
    expect(rEq(k, marginToMarkup(m))).toBe(true);
    expect(rToPpm(ratio(t.PR, t.P))).toBe(90_364);
    expect(rToPpm(ratio(t.OH, t.P))).toBe(117_866);
    const additive = mulRate(t.TJC, p(1_250_000));
    expect(additive).toBe(4_825_198);
    expect(t.S - additive).toBe(57_902);
    expect(rRound(additiveStackShortfall(t.TJC, p(150_000), p(100_000)))).toBe(57_902n);
  });
});

// ---------------------------------------------------------------- 11.1 published
describe('11.1 published', () => {
  test('P-1 DoD Figure 16-10 flat-mode composite rate R = B*1.10*(1+ti) + F + T', () => {
    const rows: [number, number, number, number, number][] = [
      [2049, 387_000, 555, 200, 3881], [1849, 387_000, 555, 200, 3576], [1647, 387_000, 443, 300, 3256], [1447, 387_000, 443, 300, 2951],
      [1897, 297_000, 608, 500, 3814], [1480, 297_000, 608, 500, 3220], [1791, 297_000, 508, 300, 3363],
    ];
    for (const [B, ti, F, T, R] of rows) expect(compositeRateFlat(c(B), p(100_000), c(0), p(ti), c(F), c(T))).toBe(R);
  });
  test('P-2 DoD Figure 16-11 overhead 19.50%, profit 7.05%, whole dollars half-up', () => {
    for (const [dc, oh, sub, pr, tot] of [[955_142, 186_253, 1_141_395, 80_468, 1_221_863], [294_636, 57_454, 352_090, 24_822, 376_912]] as const) {
      expect(mulRate(c(dc), p(195_000))).toBe(oh);
      expect(dc + oh).toBe(sub);
      expect(mulRate(c(sub), p(70_500))).toBe(pr);
      expect(sub + pr).toBe(tot);
    }
  });
  test('P-3 DoD Figure 16-12 quantity x unit cost and hours', () => {
    expect([2334, 43, 667].map((u) => extend(52_000 as QtyM, p(0), c(u)))).toEqual([121_368, 2_236, 34_684]);
    expect([52, 52, 46].map((u) => extend(6_390_000 as QtyM, p(0), c(u)))).toEqual([332_280, 332_280, 293_940]);
    expect([1550, 54, 6580].map((u) => extend(80_000 as QtyM, p(0), c(u)))).toEqual([124_000, 4_320, 526_400]);
    expect([964, 32].map((u) => extend(35_000 as QtyM, p(0), c(u)))).toEqual([33_740, 1_120]);
    expect(121_368 + 2_236 + 34_684).toBe(158_288);
    expect(taskHours(52_000 as QtyM, 750_000 as never, p(1_000_000))).toBe(3_900);
    expect(taskHours(6_390_000 as QtyM, 14_000 as never, p(1_000_000))).toBe(8_946);
    expect(taskHours(80_000 as QtyM, 520_000 as never, p(1_000_000))).toBe(4_160);
    expect(taskHours(35_000 as QtyM, 920_000 as never, p(1_000_000))).toBe(3_220);
  });
  test('P-4 DoD Figure 16-2 distributed cost and bid rounding', () => {
    const direct = 109_436 + 150_001 + 408_385 + 24_219;
    expect(direct).toBe(692_041);
    expect(mulRate(c(direct), p(320_000))).toBe(221_453);
    expect(bidRounding(c(91_349_400), c(10_000))).toBe(91_350_000);
  });
  test('P-5 UFS Figure 12-1 bond premium with 20-month surcharge, one rounding', () => {
    const mDur = durationMultiplierPpm(20, 12, 12, p(10_000), p(10_000)); // non-deviating 1%/month over 12 (D-39)
    expect(mDur).toBe(1_080_000);
    const ch = charges(CLASS_B, mDur);
    expect(priceBasedCharge(c(250_000_000), ch)).toBe(3_078_000);
    expect(chargeSplit(c(250_000_000), charges(CLASS_B)).premium).toBe(2_850_000);
    expect(grossUp(c(246_922_000), ch).P).toBe(250_000_000);
  });
  test('P-6 overtime premium percent', () => {
    const pct2 = (h15: number, h20: number, H: number) => Number(rRound(rMul(overtimePremiumRatio(h(h15), h(h20), h(H)), ratio(10_000n)))) / 100;
    expect(pct2(800, 0, 4800)).toBe(8.33);
    expect([pct2(500, 0, 4500), pct2(0, 500, 4500)]).toEqual([5.56, 11.11]);
    expect([pct2(1000, 0, 5000), pct2(0, 1000, 5000)]).toEqual([10, 20]);
    expect([pct2(1500, 0, 5500), pct2(0, 1500, 5500)]).toEqual([13.64, 27.27]);
    expect([pct2(2000, 0, 6000), pct2(0, 2000, 6000)]).toEqual([16.67, 33.33]);
    const six = partitionHours('FLSA', [800, 800, 800, 800, 800, 800, 0]);
    expect(pct2(six.h15, 0, 4800)).toBe(8.33);
    expect(pct2(0, six.h15, 4800)).toBe(16.67);
    expect(76_000 + 32_000 + 8_000 + 76_500).toBe(192_500); // 7.60 + 3.20 + 0.80 + 7.65 = 19.25%
  });
  test('P-7 productivity ratios', () => {
    const pm = (a: number) => Number(rRound(rMul(productiveRatio(a, 430), ratio(1000n)))) / 10;
    expect([pm(338), pm(207), pm(190), pm(140)]).toEqual([78.6, 48.1, 44.2, 32.6]);
  });
  test('P-8 markup 42.86%, margin 30% (cost 0.70, price 1.00)', () => {
    expect(Number(rRound(rMul(markupFromCostPrice(c(70), c(100)), ratio(10_000n))))).toBe(4286);
    expect(rEq(marginFromCostPrice(c(70), c(100)), ratio(3n, 10n))).toBe(true);
  });
  test('P-9 Davis-Bacon examples', () => {
    expect(davisBaconWeekPay(h(4_400), c(2_700), c(1_800), c(2_700))).toBe(203_400);
    expect(davisBaconWeekPay(h(4_400), c(1_200), c(250), c(1_200))).toBe(66_200);
    // $10.00 cash + $4.50 plan against $12.00 + $2.50: the half-time stays on $12.00
    const k = cls({ id: 'db', h10: h(4_000), h15: h(400), wBasic: c(1_000), fPlan: c(450), prevailing: { bhrWd: c(1_200), fbWd: c(250) } });
    const w = classWages('DAVIS_BACON', k);
    expect(w.G).toBe(46_400); // 40 h x $10.00 + 4 h x ($10.00 + 0.5 x $12.00)
    expect(w.G + Number(divRoundHalfUp(4_400 * 450, 100))).toBe(66_200); // + plan $4.50 on every hour
    expect(prevailingWageCheck(k).ok).toBe(true);
    expect(bucketPay('DAVIS_BACON', cls({ id: 'x', wBasic: c(3_400), wCil: c(2_100), prevailing: { bhrWd: c(3_400), fbWd: c(2_100) } })).pay15HalfCents).toBe(14_400);
    const pw = { bhrWd: c(2_700), fbWd: c(1_400) };
    expect(prevailingWageCheck(cls({ id: 'a', wBasic: c(4_100), prevailing: pw })).ok).toBe(true);
    expect(prevailingWageCheck(cls({ id: 'b', wBasic: c(2_700), fPlan: c(1_400), prevailing: pw })).ok).toBe(true);
    expect(prevailingWageCheck(cls({ id: 'c', wBasic: c(3_500), fPlan: c(600), prevailing: pw })).ok).toBe(true);
    expect(prevailingWageCheck(cls({ id: 'd', wBasic: c(2_700), fPlan: c(1_300), prevailing: pw })).ok).toBe(false);
  });
  test('P-10 California and Nevada public-works overtime', () => {
    const ca = bucketPay('CA_PUBLIC', cls({ id: 'ca', wBasic: c(3_200), wCil: c(2_200), prevailing: { bhrWd: c(3_200), fbWd: c(2_200) } }));
    expect(ca.pay15HalfCents / 2).toBe(7_000);
    const nv = bucketPay('NV_PUBLIC', cls({ id: 'nv', wBasic: c(7_000), fPlan: c(500), prevailing: { bhrWd: c(7_000), fbWd: c(500) } }));
    expect(nv.pay15HalfCents / 2).toBe(10_750);
    expect(nv.pay15HalfCents / 2 + 500).toBe(11_250);
  });
  test('P-11 SSA, EDD, IRS', () => {
    expect(mulRate(c(19_230_000), p(62_000))).toBe(1_192_260);
    expect(cappedShare(c(9_000_000), p(62_000), c(9_000_000), c(700_000))).toBe(43_400);
    expect(cappedShare(c(9_000_000), p(1_000), c(9_000_000), c(700_000))).toBe(700);
    expect(futaRatePpm(NV2026, p(3_000)).rate).toBe(9_000);
  });
  test('P-16 / I-3 cumulative premium on the corrected sample schedule', () => {
    const q = (P: number, t = CLASS_B) => priceBasedCharge(c(P), charges(t));
    expect([q(10_000_000), q(100_000_000), q(1_000_000_000), q(5_000_000_000)]).toEqual([250_000, 1_350_000, 8_100_000, 34_100_000]);
    expect([q(500_000_000), q(750_000_000), q(1_000_000_000), q(5_000_000_000)]).toEqual([4_725_000, 6_475_000, 8_100_000, 34_100_000]);
    const qp = (P: number) => q(P, CLASS_B_PRINTED);
    expect([qp(500_000_000), qp(750_000_000), qp(1_000_000_000), qp(5_000_000_000)]).toEqual([4_725_000, 6_600_000, 8_225_000, 34_225_000]);
  });
});

// ---------------------------------------------------------------- 11.3 other illustrations
describe('11.3 illustrations', () => {
  test('I-2 bonded gross-up, S = $180,000.00, 5 months', () => {
    expect(durationMultiplierPpm(5, 12, 12, p(10_000), p(10_000))).toBe(1_000_000);
    const g0 = grossUp(c(18_000_000), charges(CLASS_B));
    expect([g0.P, g0.q]).toEqual([18_375_635, 375_635]);
    const g6 = grossUp(c(18_000_000), charges(CLASS_B, 1_000_000, [6_000]));
    expect([g6.P, g6.q, chargeSplit(g6.P, charges(CLASS_B, 1_000_000, [6_000])).premium]).toEqual([18_488_253, 488_253, 377_324]);
    const g7 = grossUp(c(18_000_000), charges(CLASS_B, 1_000_000, [7_290]));
    expect([g7.P, g7.q, chargeSplit(g7.P, charges(CLASS_B, 1_000_000, [7_290])).premium]).toEqual([18_512_647, 512_647, 377_690]);
  });
  test('I-5 gross-up search window regression: flat 60%, S = 100,000 cents', () => {
    const g = grossUp(c(100_000), charges([{ upperBound: null, ratePpm: p(600_000) }]));
    expect([g.P, g.q]).toEqual([249_999, 149_999]);
  });
  test('I-6 burden, Nevada new employer, $45.00/h, 2,000 h, W = $90,000', () => {
    const t26 = annualEmployerTaxes(NV2026, c(9_000_000), p(29_500));
    expect([t26.ss, t26.med, t26.futa, t26.suta, t26.total]).toEqual([558_000, 130_500, 4_200, 131_100, 823_800]);
    expect(cappedShare(c(9_000_000), p(29_500), c(9_000_000), c(4_370_000))).toBe(128_915); // UI 2.95% x 43,700
    expect(cappedShare(c(9_000_000), p(500), c(9_000_000), c(4_370_000))).toBe(2_185); // CEP
    expect(rToPpm(ratio(t26.total, 9_000_000))).toBe(91_533);
    expect(Number(rRound(ratio(BigInt(t26.total) * 100n, 200_000n)))).toBe(412); // $4.1190/h -> 4.12 cents-rounded
    expect(rRound(ratio(BigInt(t26.total) * 10_000n, 200_000n))).toBe(41_190n); // $4.1190 in 1/100 cent
    expect(annualEmployerTaxes(NV2025, c(9_000_000), p(29_500)).total).toBe(818_100);
    expect(annualEmployerTaxes(NV2027, c(9_000_000), p(29_500), p(0)).total).toBe(828_900);
  });
  test('I-7 burden, California new employer, class 5140', () => {
    const t = annualEmployerTaxes(CA2026, c(9_000_000), p(34_000), p(0));
    expect([t.ss, t.med, t.futa, t.suta]).toEqual([558_000, 130_500, 4_200, 24_500]);
    const wc = workersComp(c(9_000_000), c(0), p(21_090), { xModPpm: p(1_000_000), otherModsPpm: p(1_000_000), excludeOtPremium: true, payrollCap: null }, c(9_000_000));
    expect(wc.premium).toBe(189_810);
    expect(t.total + wc.premium).toBe(907_010);
    expect(rToPpm(ratio(t.total + wc.premium, 9_000_000))).toBe(100_779);
    expect(annualEmployerTaxes(CA2026, c(9_000_000), p(34_000), p(12_000)).futa - t.futa).toBe(8_400);
    expect(caElectricalClass(c(3_999), c(4_000))).toBe('5190');
    expect(caElectricalClass(c(4_000), c(4_000))).toBe('5140');
    // class cliff at the advisory rates, in hundredths of a cent per hour: $39.99 in 5190 costs $1.4912/h, $40.00 in 5140 $0.8436/h
    expect(rRound(ratio(3_999n * 37_290n * 100n, 1_000_000n))).toBe(14_912n);
    expect(rRound(ratio(4_000n * 21_090n * 100n, 1_000_000n))).toBe(8_436n);
  });
  test('I-8 cash in lieu versus plan, $35 + $15 package, Nevada 2026', () => {
    const cash = annualEmployerTaxes(NV2026, c(10_000_000), p(29_500)).total;
    const plan = annualEmployerTaxes(NV2026, c(7_000_000), p(29_500)).total;
    expect([cash, plan, cash - plan]).toEqual([900_300, 670_800, 229_500]);
    expect(mulRate(c(3_000_000), p(76_500))).toBe(229_500);
  });
  test('I-9 overtime: Nevada private 50 h week; California private 13 h day', () => {
    expect(nvPrivateDailyOvertimeApplies(c(4_500), c(1_200), false)).toBe(false);
    const b = partitionHours('NV_PRIVATE', [1000, 1000, 1000, 1000, 1000, 0, 0], { dailyOvertime: false });
    expect(b).toEqual({ h10: 4_000, h15: 1_000, h20: 0 });
    const w = classWages('NV_PRIVATE', cls({ id: 'j', ...b, wBasic: c(4_500) }));
    expect(w.G).toBe(247_500);
    const wc = workersComp(w.G, w.otPremium, p(25_000), { xModPpm: p(1_000_000), otherModsPpm: p(1_000_000), excludeOtPremium: false, payrollCap: null }, c(9_000_000));
    expect(wc.payroll).toBe(247_500);
    const ca = partitionHours('CA_PRIVATE', [1300, 0, 0, 0, 0, 0, 0]);
    expect(ca).toEqual({ h10: 800, h15: 400, h20: 100 });
    expect(classWages('CA_PRIVATE', cls({ id: 'c', ...ca, wBasic: c(4_500) })).G).toBe(72_000);
  });
  test('I-10 flat-mode correction: cash fringe is burdened', () => {
    const corrected = compositeRateFlat(c(4_000), p(0), c(2_000), p(150_000), c(0), c(0));
    const uncorrected = compositeRateFlat(c(4_000), p(0), c(0), p(150_000), c(2_000), c(0));
    expect(corrected - uncorrected).toBe(300);
  });
  test('I-11 overhead base: o_s 10%, m_s 5%', () => {
    const r = salesBasisToCostBasis(p(100_000), p(50_000));
    expect([rToPpm(r.oc), rToPpm(r.pc)]).toEqual([117_647, 52_632]);
    expect(rEq(r.multiplier, ratio(100n, 85n))).toBe(true);
    expect(rEq(rMul(rAdd(ratio(1n), r.oc), rAdd(ratio(1n), r.pc)), ratio(20n, 17n))).toBe(true);
    expect(rEq(stackMultipliers([p(100_000), p(50_000)]), ratio(1_155n, 1_000n))).toBe(true);
  });
  test('I-28 allocation', () => {
    expect(allocate(c(100), [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(c(1), [1, 1])).toEqual([1, 0]);
    expect(allocate(c(5), [0, 3, 0, 3])).toEqual([0, 3, 0, 2]);
  });
  test('I-29 float pitfalls kept as regression examples', () => {
    const parts = allocate(c(42_889_533), [1, 46, 5]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(42_889_533);
    expect(parts).toEqual([824_799, 37_940_741, 4_123_993]);
    const xs = [49_515_425, 14_571_770, 72_207_160];
    expect(xs[0]! + xs[1]! + xs[2]!).toBe(xs[2]! + xs[0]! + xs[1]!);
    expect(divRoundHalfUp(4_161_321_5, 10)).toBe(4_161_322n); // $41,613.215 -> 41,613.22
    expect(divRoundHalfUp(9_055_901_5, 10)).toBe(9_055_902n); // $90,559.015 -> 90,559.02
    expect(mulRate(c(58_725_287_889), p(310_185))).toBe(Number(divRoundHalfUp(58_725_287_889n * 310_185n, 1_000_000n)));
    expect(mulRate(c(58_725_287_889), p(310_185))).toBe(18_215_703_424); // checked with Python integers
    expect([mulRate(c(172_605), p(62_000)), mulRate(c(62_605), p(62_000)), mulRate(c(235_210), p(62_000))]).toEqual([10_702, 3_882, 14_583]);
    expect([mulRate(c(4), p(71_000)), mulRate(c(395_257), p(71_000)), mulRate(c(395_261), p(71_000))]).toEqual([0, 28_063, 28_064]);
  });
});
