// Time and place (spec section 6) and the public unit-price sanity band (spec 6.9):
// invariants 87 to 98 of spec 10.8 as fast-check properties (pinned seed, 1,000 runs, test plan 10.0)
// and the section 11 golden examples that belong to this part, as exact-value tests.
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { mulRate, ratio, rCmp, rDiv, rMul, rAdd, rSub, rToNumber, rToPpm, type Cents, type IsoDate, type Ppm, type QtyM, type Ratio } from '../src/cost/money.js';
import {
  assertSameSeries,
  chainIndexRatios,
  compositeFactor,
  costLoadedFactor,
  dayNumber,
  ePpmForMaterialLine,
  equivalentAnnualRate,
  escalateCents,
  escalateForward,
  escalateLine,
  evenSpendingFactors,
  factorTableFromPublished,
  factorTableFromRates,
  far52216_4Adjustment,
  forwardFactorPpm,
  fromDayNumber,
  indexClauseAdjustment,
  indexPoint,
  indexRatio,
  interpolateFactor,
  interpolateFactorGeometric,
  latestFinal,
  midpointDate,
  normalizeSeries,
  parseDecimal,
  percentChange,
  quoteEscalation,
  ratioFromPpm,
  rebaseSeries,
  roundRatioCents,
  type IndexObservation,
  type IndexSeries,
  type IndexSeriesInput,
} from '../src/cost/escalation.js';
import {
  acfFactor,
  acfLookup,
  applyWageRatio,
  chainPlaceFactors,
  combinedAdjustment,
  compositeFromShares,
  compositeLocationFactor,
  wageRatio,
  type AcfTable,
  type WageFigure,
} from '../src/cost/location.js';
import { bandStats, likeForLikeUnitPrice, percentile, percentileRank, unitPriceBand, weightedMean, type UnitPriceRow } from '../src/cost/unitprice.js';

const SEED = 20_261_113;
const RUNS = 1_000;
fc.configureGlobal({ seed: SEED, numRuns: RUNS });

const c = (n: number) => n as Cents;
const q = (n: number) => n as QtyM;
const d = (s: string) => s as IsoDate;
const R = (a: number | bigint, b: number | bigint = 1) => ratio(a, b);
const toPpmDisplay = (r: Ratio) => Number(rToPpm(r)); // half-up to 6 decimals, display check
const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RangeError);
    expect((e as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected refusal ${code}`);
};

// ---------------------------------------------------------------- fixtures (spec 8.7, each with source)

const BLS = 'https://api.bls.gov/publicAPI/v2/timeseries/data/'; // D-79, pulled 2026-11-13, [R] (API)
function blsSeries(id: string, obs: readonly [string, string, boolean][], geography = 'national'): IndexSeries {
  // A-35: titles and reference bases of these series are not verified; the base label is a placeholder.
  return normalizeSeries({
    id,
    title: `${id} (title unverified)`,
    titleVerified: false,
    source: BLS,
    frequency: 'monthly',
    referenceBase: 'unverified',
    geography,
    observations: obs.map(([period, value, preliminary]) => ({ seriesId: id, period, value, preliminary, referenceBase: 'unverified', source: BLS, pulledOn: d('2026-11-13') })),
  });
}
// D-79 values, May 2025 and May 2026 final; Sep 2026 preliminary for wire.
const WIRE = blsSeries('WPU10260314', [
  ['2025-05', '459.176', false],
  ['2026-05', '564.877', false],
  ['2026-09', '607.705', true],
]);
const CONDUIT = blsSeries('WPU11710216', [['2025-05', '204.296', false], ['2026-05', '207.695', false]]);
const GEAR = blsSeries('WPU1175', [['2025-05', '374.197', false], ['2026-05', '413.241', false]]);
const FIXTURES = blsSeries('WPU1083', [['2025-05', '235.199', false], ['2026-05', '243.385', false]]);

// D-77: DoD escalation table, guidance dated 2026-03-25 (reference; budget guidance, not a forecast).
const UFS_TABLES = 'https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ufs_3_701_01_2026_Data_Tables.xlsx';
const D77 = factorTableFromPublished('D-77', UFS_TABLES, '2026-03-25', [
  { month: '2025-10', value: '1' },
  { month: '2026-10', value: '1.021' },
  { month: '2027-10', value: '1.04142' },
  { month: '2028-10', value: '1.0622484' },
  { month: '2029-10', value: '1.083493368' },
  { month: '2030-10', value: '1.10516323536' },
  { month: '2031-10', value: '1.1272665000672' },
]);

// D-78: DoD Area Cost Factors, 2026 edition, MILCON column (context only).
const ACF_2026: AcfTable = {
  edition: 'UFS 3-701-01 2026',
  kind: 'MILCON',
  source: UFS_TABLES,
  rows: [
    { site: 'NAS Fallon', state: 'NV', county: 'Churchill', value: '1.20' },
    { site: 'Carson City and Reno', state: 'NV', county: 'Carson City', city: 'Carson City', value: '1.17' },
    { site: 'Sacramento', state: 'CA', county: 'Sacramento', value: '1.18' },
    { site: 'San Francisco', state: 'CA', county: 'San Francisco', value: '1.32' },
  ],
};

// D-80: BLS OEWS electricians (47-2111), mean hourly, May 2025.
const OEWS = 'OEWS 47-2111 mean hourly, straight time, no benefits';
const wage = (areaId: string, hourly: number, smallArea = false): WageFigure => ({ areaId, areaName: areaId, measure: OEWS, period: '2025-05', hourly: c(hourly), source: BLS, smallArea });
const US = wage('US', 3437);
const BAL_NV = wage('Balance of Nevada nonmetropolitan', 3881, true);

// D-84: Caltrans cost index, 2020 = 100, read 2026-11-12.
const CALTRANS_URL = 'https://sv08data.dot.ca.gov/indexes.php';
const CALTRANS = normalizeSeries({
  id: 'CALTRANS-CCI',
  title: 'Caltrans construction cost index',
  titleVerified: true,
  source: CALTRANS_URL,
  frequency: 'quarterly',
  referenceBase: '2020=100',
  geography: 'CA',
  observations: (
    [
      ['2024-Q1', '190.72'], ['2024-Q2', '168.45'], ['2024-Q3', '197.13'], ['2024-Q4', '141.33'],
      ['2025-Q1', '210.72'], ['2025-Q2', '204.25'], ['2025-Q3', '166.63'], ['2025-Q4', '149.76'],
      ['2026-Q1', '126.75'], ['2026-Q2', '146.53'],
    ] as const
  ).map(([period, value]) => ({ seriesId: 'CALTRANS-CCI', period, value, preliminary: false, referenceBase: '2020=100', source: CALTRANS_URL })),
});

// ---------------------------------------------------------------- generators

// Index values 10.000 to 999.999 (factors between 0.01 and 100): realistic, and keeps every result a safe integer.
const idx = fc.integer({ min: 10_000, max: 999_999 }).map((v) => `${Math.floor(v / 1000)}.${String(v % 1000).padStart(3, '0')}`);
function genericSeries(id: string, values: readonly string[], opts: Partial<IndexSeriesInput> = {}): IndexSeries {
  const base = opts.referenceBase ?? 'B';
  return normalizeSeries({
    id,
    title: id,
    titleVerified: true,
    source: 'test',
    frequency: 'monthly',
    referenceBase: base,
    geography: 'national',
    observations: values.map((value, i): IndexObservation => ({ seriesId: id, period: `2020-${String(i + 1).padStart(2, '0')}`, value, preliminary: false, referenceBase: base, source: 'test' })),
    ...opts,
  });
}
const per = (i: number) => `2020-${String(i + 1).padStart(2, '0')}`;
const cents = fc.integer({ min: 0, max: 2_000_000_000 });
const posRatio = fc.tuple(fc.integer({ min: 1, max: 5_000_000 }), fc.integer({ min: 500_000, max: 5_000_000 })).map(([a, b]) => R(a, b));

// ================================================================ golden examples (spec 11)

describe('golden: time and place (spec 11)', () => {
  test('I-1 wire escalation: 1.06^(2/12) -> 9,759 ppm, 45.50 on 4,662.00', () => {
    const e = quoteEscalation({ lineId: 'wire', quotedOn: d('2026-09-10'), purchaseDate: d('2026-11-10'), rFwdPpm: 60_000 });
    expect(e.kind).toBe('escalated');
    expect(e.forwardMonths).toBe(2);
    expect(e.ePpm).toBe(9_759);
    expect(mulRate(c(466_200), e.ePpm as Ppm)).toBe(4_550);
    expect(e.assumptions.map((a) => a.id)).toContain('A-21');
  });

  test('I-18 index escalation May 2025 to May 2026, line by line, total and composite', () => {
    const lines = [
      escalateLine('wire', c(1_840_000), indexRatio(WIRE, '2025-05', '2026-05')),
      escalateLine('conduit', c(620_000), indexRatio(CONDUIT, '2025-05', '2026-05')),
      escalateLine('gear', c(2_200_000), indexRatio(GEAR, '2025-05', '2026-05')),
      escalateLine('fixtures', c(950_000), indexRatio(FIXTURES, '2025-05', '2026-05')),
    ];
    expect(lines.map((l) => l.adjusted)).toEqual([2_263_563, 630_315, 2_429_550, 983_064]);
    const total = lines.reduce((s, l) => s + l.adjusted, 0);
    expect(lines.reduce((s, l) => s + l.base, 0)).toBe(5_610_000);
    expect(total).toBe(6_306_492);
    expect(toPpmDisplay(R(total, 5_610_000))).toBe(1_124_152);
    expect(toPpmDisplay(compositeFactor(lines.map((l) => ({ amount: l.base, factor: l.factor }))))).toBe(1_124_152);
    expect(lines[0]!.provenance).toMatchObject({ seriesId: 'WPU10260314', fromRaw: '459.176', toRaw: '564.877' });
    // Forward 11 months on the total (exact single rounding of 63,064.92 x (1 + r)^(11/12)).
    expect([20_000, 50_000, 100_000].map((r) => escalateForward(c(total), r, 11))).toEqual([6_422_015, 6_594_948, 6_882_261]);
  });

  test('I-18 table interpolation for April 2027: 1.021 + 0.5 x (1.04142 - 1.021) = 1.03121; geometric 1.031159', () => {
    expect(interpolateFactor(D77, '2027-04')).toEqual(parseDecimal('1.03121'));
    expect(interpolateFactorGeometric(D77, '2027-04')).toBeCloseTo(1.031159, 6);
  });

  test('P-13 compounding 2.1% then 2.0% x 5 reproduces the published DoD factors exactly', () => {
    const t = factorTableFromRates('D-77', UFS_TABLES, '2026-03-25', '2025-10', [21_000, 20_000, 20_000, 20_000, 20_000, 20_000]);
    expect(t.anchors.map((a) => a.factor)).toEqual(D77.anchors.map((a) => a.factor));
  });

  test('P-13 interpolation (1.1284 - 1.1062)/12 x 6 = 0.0111 -> 1.1173; ratios 1880/1869 and 186.35/179.05', () => {
    const t = factorTableFromPublished('P-13', UFS_TABLES, 'as printed', [
      { month: '2024-10', value: '1.1062' },
      { month: '2025-10', value: '1.1284' },
    ]);
    expect(interpolateFactor(t, '2025-04')).toEqual(parseDecimal('1.1173'));
    expect(toPpmDisplay(rDiv(parseDecimal('1880'), parseDecimal('1869')))).toBe(1_005_886);
    expect(toPpmDisplay(rDiv(parseDecimal('186.35'), parseDecimal('179.05')))).toBe(1_040_771);
    expect(toPpmDisplay(percentChange(rDiv(parseDecimal('186.35'), parseDecimal('179.05'))))).toBe(4_077_073); // 4.077073 %
    // 503 x 0.995 x 0.92 x 1.1173 x 1.00 x 1.05 x 1.05 x 1.0455 = 592.9954 (printed 593.00)
    const prod = ['0.995', '0.92', '1.1173', '1.00', '1.05', '1.05', '1.0455'].reduce((a, s) => rMul(a, parseDecimal(s)), R(503));
    expect(Number(roundRatioCents(rMul(prod, R(10_000))))).toBe(5_929_954);
    expect(48_750 * 593).toBe(28_908_750);
  });

  test('P-15 Caltrans adjustment P x 146.53 / I_from to the cent', () => {
    const cases: [number, string, number][] = [
      [72_500, '2024-Q2', 63_066],
      [48_000, '2026-Q1', 55_491],
      [8_000, '2024-Q2', 6_959],
      [40_000_000, '2024-Q2', 34_794_895],
      [7_600_000, '2024-Q3', 5_649_206],
      [70_000_000, '2024-Q4', 72_575_532],
      [54_100_000, '2025-Q2', 38_811_618],
    ];
    for (const [p, from, want] of cases) expect(escalateCents(c(p), indexRatio(CALTRANS, from, '2026-Q2').ratio)).toBe(want);
  });

  test('P-15 WSDOT quantity-weighted 33.04, first two 73.65, simple mean 48.45; lump-sum derived row excluded', () => {
    const qs = [278, 1_060, 17_841];
    const ps = [3_035, 8_500, 3_000];
    const pairs = qs.map((x, i) => ({ q: q(x * 1000), p: R(ps[i]!) }));
    const b = bandStats(pairs, 'n-1');
    expect(roundRatioCents(b.weightedMean)).toBe(3_304);
    expect(roundRatioCents(weightedMean(pairs.slice(0, 2).map((x) => ({ q: BigInt(x.q), p: x.p }))))).toBe(7_365);
    expect(roundRatioCents(b.mean)).toBe(4_845);
    expect(rToNumber(R(32_000, 420))).toBe(76.19047619047619);
    const rows: UnitPriceRow[] = [
      ...qs.map((x, i) => row(`wa${i}`, x * 1000, ps[i]!, { state: 'WA' })),
      row('or-ls', 420_000, 7_619, { state: 'OR', lumpSumDerived: true }),
    ];
    const res = unitPriceBand({ contractor: { basis: 'sell', itemSellTotal: c(3_304 * 2_000), quantity: q(2_000_000), unit: 'LF' }, rows, asOf: d('2026-11-13'), jobState: 'NV', sdDivisor: 'n-1' });
    expect(res.excluded).toEqual([{ id: 'or-ls', reason: 'lump-sum derived unit price' }]);
    expect(roundRatioCents(res.raw!.weightedMean)).toBe(3_304);
    expect(res.flag).toBeNull();
    expect(res.noFlagReason).toMatch(/only 3 usable rows/);
    expect(res.thin).toBe(true);
    expect(res.outOfState).toBe(true);
  });

  test('I-19 wage ratio 38.81/34.37 = 1.129182; 45% labor share composite 1.058132; parametric 45,840.64', () => {
    const wr = wageRatio(US, BAL_NV);
    expect(toPpmDisplay(wr.factor)).toBe(1_129_182);
    expect(wr.lowConfidence).toBe(true);
    const comp = compositeLocationFactor({ origin: { labor: c(45), material: c(55), other: c(0) }, labor: wr });
    expect(toPpmDisplay(comp.factor)).toBe(1_058_132);
    expect(comp.labels.join(' ')).toMatch(/material relative not entered/);
    // 42,000 x (1.20/1.18) x 1.040771 x 1.03121: ACF context number (same edition), national DoD index, table forward
    const fallon = acfLookup(ACF_2026, { site: 'NAS Fallon' }).row;
    const sac = acfLookup(ACF_2026, { site: 'Sacramento' }).row;
    const spi = normalizeSeries({
      id: 'DOD-SPI', title: 'DoD Selling Price Index', titleVerified: true, source: UFS_TABLES, frequency: 'monthly', referenceBase: '2007-10=100', geography: 'national',
      observations: [['2024-10', '179.05'], ['2025-10', '186.35']].map(([period, value]) => ({ seriesId: 'DOD-SPI', period: period!, value: value!, preliminary: false, referenceBase: '2007-10=100', source: UFS_TABLES })),
    });
    const out = combinedAdjustment({
      id: 'parametric', amount: c(4_200_000), basis: 'parametric', bucket: 'whole',
      place: acfFactor(ACF_2026, sac, ACF_2026, fallon),
      time: indexRatio(spi, '2024-10', '2025-10'),
      forward: rDiv(interpolateFactor(D77, '2027-04'), interpolateFactor(D77, '2025-10')),
    });
    expect(out.amount).toBe(4_584_064);
    expect(out.contextOnly).toBe(true);
  });

  test('I-20 midpoint approximation r = 5%, D = 1.25 y: exact average 1.031123, midpoint 1.030964', () => {
    const f = evenSpendingFactors(50_000, 1.25);
    expect(f.average).toBeCloseTo(1.031123, 6);
    expect(f.midpoint).toBeCloseTo(1.030964, 6);
    expect(f.ratio).toBeCloseTo(f.approx, 6);
  });
});

// ================================================================ behaviour of spec 6.2, 6.5, 6.7, 6.8

describe('spec 6.2 forward escalation of a dated quote', () => {
  test('price hold through the purchase date: factor exactly 1, e = 0 (6.2, invariant 43 hook)', () => {
    const e = quoteEscalation({ lineId: 'x', quotedOn: d('2025-05-01'), purchaseDate: d('2027-01-01'), holdThrough: d('2027-01-01'), series: WIRE });
    expect(e).toMatchObject({ kind: 'price-hold', ePpm: 0 });
    expect(e.exactFactor).toEqual(R(1));
  });
  test('forward-priced quote is not escalated again (6.7)', () => {
    expect(quoteEscalation({ lineId: 'x', quotedOn: d('2025-05-01'), purchaseDate: d('2027-01-01'), forwardPriced: true, rFwdPpm: 50_000 }).ePpm).toBe(0);
  });
  test('historical part to the latest FINAL month, forward part starts there (not at the quote)', () => {
    const e = quoteEscalation({ lineId: 'wire', quotedOn: d('2025-05-20'), purchaseDate: d('2026-12-01'), series: WIRE, rFwdPpm: 0, stalenessThresholdPpm: 100_000 });
    expect(e.tLast).toBe('2026-05'); // Sep 2026 is preliminary
    expect(e.start).toBe('2026-05');
    expect(e.forwardMonths).toBe(7);
    expect(e.ePpm).toBe(Number(rToPpm(R(564_877, 459_176))) - 1_000_000);
    expect(e.stale).toBe(true);
    expect(e.warnings.join(' ')).toMatch(/re-quote/);
    expect(e.warnings.join(' ')).toMatch(/A-35/);
    const f = quoteEscalation({ lineId: 'wire', quotedOn: d('2025-05-20'), purchaseDate: d('2026-12-01'), series: WIRE, rFwdPpm: 60_000 });
    expect(f.ePpm).toBe(forwardFactorPpm(60_000, 7, R(564_877, 459_176)));
    expect(f.stale).toBeNull();
    expect(f.warnings.join(' ')).toMatch(/no staleness threshold/);
  });
  test('forward part from a factor table is F(T)/F(start), not anchored at the table base', () => {
    const e = quoteEscalation({ lineId: 'x', quotedOn: d('2026-10-03'), purchaseDate: d('2027-04-03'), forwardTable: D77 });
    expect(e.exactFactor).toEqual(rDiv(parseDecimal('1.03121'), parseDecimal('1.021')));
  });
  test('missing r_fwd with forward months refuses: no default (A-21)', () => {
    expectCode(() => quoteEscalation({ lineId: 'x', quotedOn: d('2026-01-01'), purchaseDate: d('2026-03-01') }), 'MISSING_FORWARD_RATE');
  });
  test('quote month missing from the series refuses; never falls back to 1.0 (rule 3)', () => {
    expectCode(() => quoteEscalation({ lineId: 'x', quotedOn: d('2025-08-01'), purchaseDate: d('2026-06-01'), series: WIRE, rFwdPpm: 0 }), 'MISSING_INDEX_VALUE');
  });
  test('purchase before the quote refuses; a fall is refused for a material line unless labelled', () => {
    expectCode(() => quoteEscalation({ lineId: 'x', quotedOn: d('2026-03-01'), purchaseDate: d('2026-01-01'), rFwdPpm: 0 }), 'PURCHASE_BEFORE_QUOTE');
    const fall = quoteEscalation({ lineId: 'x', quotedOn: d('2026-01-01'), purchaseDate: d('2027-01-01'), rFwdPpm: -50_000 });
    expect(fall.ePpm).toBe(-50_000);
    expectCode(() => ePpmForMaterialLine(fall), 'NEGATIVE_ESCALATION');
    expect(ePpmForMaterialLine(fall, 'zero-with-warning')).toMatchObject({ ePpm: 0, warning: expect.stringMatching(/index fell/) });
  });
  test('6.2 e_i is (1 + r)^(m/12) rounded half-up once, exactly (bracketed in BigInt, agrees with float64 within 1 ppm)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -500_000, max: 500_000 }), fc.integer({ min: 0, max: 120 }), (r, m) => {
        const e = forwardFactorPpm(r, m);
        const y = BigInt(1_000_000 + e);
        // (y - 1/2)^12 <= 10^(6*12) (1+r)^m < (y + 1/2)^12, i.e. half-up rounding of the true value
        const a = BigInt(1_000_000 + r) ** BigInt(m) * 2n ** 12n * 10n ** 72n;
        const b = 10n ** BigInt(6 * m);
        expect((2n * y - 1n) ** 12n * b <= a).toBe(true);
        expect(a < (2n * y + 1n) ** 12n * b).toBe(true);
        expect(Math.abs(e - (Math.pow(1 + r / 1e6, m / 12) - 1) * 1e6)).toBeLessThanOrEqual(0.5 + 1e-6);
      }),
    );
  });

  test('purchase month before t_last: the index covers the whole span, no forward months', () => {
    const e = quoteEscalation({ lineId: 'x', quotedOn: d('2025-05-01'), purchaseDate: d('2025-05-28'), series: WIRE });
    expect(e.forwardMonths).toBe(0);
    expect(e.ePpm).toBe(0);
  });
});

describe('spec 6.8 price-adjustment clauses', () => {
  test('FAR 52.216-4: below 3% of contract price no adjustment; increases capped at 10% of the original unit price', () => {
    const items = [{ id: 'wire', kind: 'material-unit-price' as const, originalUnit: c(100), actualUnit: c(150), units: q(1_000_000) }];
    const big = far52216_4Adjustment(items, c(100_000)); // 3% = 3,000 cents
    expect(big.items[0]!.capped).toBe(true);
    expect(big).toMatchObject({ direction: 'increase', amount: 10_000, thresholdMet: true }); // 10 cents x 1,000 units
    expect(far52216_4Adjustment(items, c(1_000_000_000)).direction).toBe('none');
    const down = far52216_4Adjustment([{ ...items[0]!, actualUnit: c(40) }], c(100_000));
    expect(down).toMatchObject({ direction: 'decrease', amount: 60_000 }); // no limit on decreases
  });
});

// ================================================================ invariants (spec 10.8)

describe('invariants 87 to 98 (spec 10.8)', () => {
  test('87: factor(t,t) = 1, factor(t1,t2) x factor(t2,t1) = 1, factor(t1,t3) = factor(t1,t2) x factor(t2,t3); same for places', () => {
    fc.assert(
      fc.property(idx, idx, idx, fc.integer({ min: 1, max: 99_999 }), fc.integer({ min: 1, max: 99_999 }), fc.integer({ min: 1, max: 99_999 }), (a, b, x, wa, wb, wc) => {
        const s = genericSeries('S', [a, b, x]);
        expect(indexRatio(s, per(0), per(0)).ratio).toEqual(R(1));
        expect(rMul(indexRatio(s, per(0), per(1)).ratio, indexRatio(s, per(1), per(0)).ratio)).toEqual(R(1));
        expect(chainIndexRatios([indexRatio(s, per(0), per(1)), indexRatio(s, per(1), per(2))]).ratio).toEqual(indexRatio(s, per(0), per(2)).ratio);
        const A = wage('A', wa), B = wage('B', wb), C = wage('C', wc);
        expect(wageRatio(A, A).factor).toEqual(R(1));
        expect(rMul(wageRatio(A, B).factor, wageRatio(B, A).factor)).toEqual(R(1));
        expect(chainPlaceFactors(wageRatio(A, B), wageRatio(B, C)).factor).toEqual(wageRatio(A, C).factor);
      }),
    );
    const r = (s: string) => acfLookup(ACF_2026, { site: s }).row;
    const fs = acfFactor(ACF_2026, r('Sacramento'), ACF_2026, r('NAS Fallon'));
    const fr = acfFactor(ACF_2026, r('NAS Fallon'), ACF_2026, r('San Francisco'));
    expect(chainPlaceFactors(fs, fr).factor).toEqual(acfFactor(ACF_2026, r('Sacramento'), ACF_2026, r('San Francisco')).factor);
    expect(acfFactor(ACF_2026, r('Sacramento'), ACF_2026, r('Sacramento')).factor).toEqual(R(1));
  });

  test('88: multiplying every index value by k > 0 leaves every factor unchanged', () => {
    fc.assert(
      fc.property(fc.array(idx, { minLength: 2, maxLength: 8 }), posRatio, fc.nat(), fc.nat(), (vals, k, i0, j0) => {
        const s = genericSeries('S', vals);
        const s2 = rebaseSeries(s, k, 'B2');
        const i = i0 % vals.length, j = j0 % vals.length;
        expect(indexRatio(s2, per(i), per(j)).ratio).toEqual(indexRatio(s, per(i), per(j)).ratio);
      }),
    );
  });

  test('89: adjust is linear in exact fractions; rounded within bounds; I2 >= I1 and c >= 0 never lowers c', () => {
    fc.assert(
      fc.property(cents, cents, fc.integer({ min: 1, max: 1000 }), idx, idx, (a, b, k, i1, i2) => {
        const f = indexRatio(genericSeries('S', [i1, i2]), per(0), per(1)).ratio;
        expect(rMul(R(k * a), f)).toEqual(rMul(R(k), rMul(R(a), f)));
        expect(rMul(R(a + b), f)).toEqual(rAdd(rMul(R(a), f), rMul(R(b), f)));
        expect(Math.abs(escalateCents(c(a + b), f) - escalateCents(c(a), f) - escalateCents(c(b), f))).toBeLessThanOrEqual(1);
        if (k * a <= 2_000_000_000) expect(Math.abs(escalateCents(c(k * a), f) - k * escalateCents(c(a), f))).toBeLessThanOrEqual((k + 1) / 2);
        if (rCmp(f, R(1)) >= 0) expect(escalateCents(c(a), f)).toBeGreaterThanOrEqual(a);
      }),
    );
  });

  test('90: composite = dollar-weighted mean of line factors, between min and max; one final rounding of the total', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 1, max: 1_000_000_000 }), posRatio), { minLength: 1, maxLength: 8 }), (ls) => {
        const lines = ls.map(([a, f]) => ({ amount: c(a), factor: f }));
        const F = compositeFactor(lines);
        const fs = lines.map((l) => l.factor).sort(rCmp);
        expect(rCmp(F, fs[0]!)).toBeGreaterThanOrEqual(0);
        expect(rCmp(F, fs[fs.length - 1]!)).toBeLessThanOrEqual(0);
        const base = lines.reduce((s, l) => s + l.amount, 0);
        const exactSum = lines.reduce((s, l) => rAdd(s, rMul(R(l.amount), l.factor)), R(0));
        expect(roundRatioCents(rMul(F, R(base)))).toBe(roundRatioCents(exactSum));
        // cost-loaded form (spec 6.3) agrees
        expect(costLoadedFactor(lines.map((l) => ({ share: R(l.amount, base), factor: l.factor })))).toEqual(F);
      }),
    );
  });

  test('91: chained relatives = endpoint ratio; (1 + r_eq)^(m/12) reproduces I2/I1; F(Y) = F(Y-1)(1 + r_Y), never a sum', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 200_000, max: 999_999 }).map((v) => `${Math.floor(v / 1000)}.${String(v % 1000).padStart(3, '0')}`), { minLength: 2, maxLength: 12 }), fc.array(fc.integer({ min: 0, max: 200_000 }), { minLength: 2, maxLength: 8 }), (vals, rates) => {
        const s = genericSeries('S', vals);
        const n = vals.length - 1;
        const rel = Array.from({ length: n }, (_, k) => indexRatio(s, per(k), per(k + 1)));
        const end = indexRatio(s, per(0), per(n));
        expect(chainIndexRatios(rel).ratio).toEqual(end.ratio);
        const req = equivalentAnnualRate(end.ratio, n);
        expect(Math.abs(Math.pow(1 + req, n / 12) / rToNumber(end.ratio) - 1)).toBeLessThan(1e-6); // float context figure
        const t = factorTableFromRates('T', 'test', 'test', '2020-10', rates);
        for (let y = 1; y < t.anchors.length; y++) expect(t.anchors[y]!.factor).toEqual(rMul(t.anchors[y - 1]!.factor, rAdd(R(1), ratioFromPpm(rates[y - 1]!))));
        const sumRates = rates.reduce((x, r) => rAdd(x, ratioFromPpm(r)), R(1));
        expect(rCmp(t.anchors[t.anchors.length - 1]!.factor, sumRates)).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  test('92: interpolated factor lies between its anchors and equals them there; linear - geometric in [0, F r^2/8]', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 500_000 }), { minLength: 1, maxLength: 5 }), fc.nat(), (rates, mm) => {
        const t = factorTableFromRates('T', 'test', 'test', '2020-10', rates);
        const total = 12 * rates.length;
        const m = mm % (total + 1);
        const month = `${2020 + Math.floor((9 + m) / 12)}-${String(((9 + m) % 12) + 1).padStart(2, '0')}`;
        const k = Math.min(Math.floor(m / 12), rates.length - 1);
        const a = t.anchors[k]!.factor, b = t.anchors[k + 1]!.factor;
        const F = interpolateFactor(t, month);
        expect(rCmp(F, a)).toBeGreaterThanOrEqual(0);
        expect(rCmp(F, b)).toBeLessThanOrEqual(0);
        if (m % 12 === 0) expect(F).toEqual(t.anchors[m / 12]!.factor);
        const gap = rToNumber(F) - interpolateFactorGeometric(t, month);
        const r = rates[k]! / 1e6;
        expect(gap).toBeGreaterThanOrEqual(-1e-12);
        expect(gap).toBeLessThanOrEqual((rToNumber(a) * r * r) / 8 + 1e-12);
      }),
    );
  });

  test('93: T_start <= T_mid <= T_end; zero duration gives T_mid = T_start', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40_000 }), fc.integer({ min: 0, max: 5_000 }), (s, len) => {
        const a = fromDayNumber(s), b = fromDayNumber(s + len);
        expect(dayNumber(a)).toBe(s);
        const m = midpointDate(a, b);
        expect(m >= a && m <= b).toBe(true);
        expect(midpointDate(a, a)).toBe(a);
      }),
    );
    expect(midpointDate(d('2026-03-01'), d('2027-06-01'))).toBe('2026-10-15'); // 457 days, 228 after the start
  });

  test('94: place and time multipliers commute', () => {
    fc.assert(
      fc.property(cents, fc.integer({ min: 1_000, max: 99_999 }), fc.integer({ min: 1_000, max: 99_999 }), idx, idx, posRatio, (a, wa, wb, i1, i2, fwd) => {
        const place = wageRatio(wage('A', wa), wage('B', wb));
        const time = indexRatio(genericSeries('N', [i1, i2]), per(0), per(1));
        const out = combinedAdjustment({ id: 'x', amount: c(a), basis: 'historical', bucket: 'labor', place, time, forward: fwd });
        const placeThenTime = rMul(rMul(rMul(R(a), place.factor), time.ratio), fwd);
        const timeThenPlace = rMul(rMul(rMul(R(a), fwd), time.ratio), place.factor);
        expect(placeThenTime).toEqual(timeThenPlace);
        expect(out.amount).toBe(roundRatioCents(placeThenTime));
      }),
    );
  });

  test('95: index clause: below trigger -> 0; increase never above the cap; share 0 -> none; share 1, no cap, no trigger -> plain ratio', () => {
    fc.assert(
      fc.property(cents, idx, idx, fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 200_000 }), fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 1_000_000 }), fc.boolean(), (P, i1, i2, phi, trig, cap, floor, whole) => {
        const index = indexRatio(genericSeries('S', [i1, i2]), per(0), per(1));
        const base = { basePrice: c(P), index, triggerPpm: trig, pays: whole ? ('whole-change' as const) : ('beyond-trigger' as const) };
        const r = indexClauseAdjustment({ ...base, indexedSharePpm: phi, capPpm: cap, floorPpm: floor });
        const change = rSub(index.ratio, R(1));
        const absChange = change.num < 0n ? rMul(change, R(-1)) : change;
        if (rCmp(absChange, ratioFromPpm(trig)) < 0) expect(r.amount).toBe(0);
        if (r.direction === 'increase') expect(r.amount).toBeLessThanOrEqual(Number(roundRatioCents(rMul(rMul(R(P), ratioFromPpm(phi)), ratioFromPpm(cap)))));
        if (r.direction === 'decrease') expect(r.amount).toBeLessThanOrEqual(Number(roundRatioCents(rMul(rMul(R(P), ratioFromPpm(phi)), ratioFromPpm(floor)))));
        expect(indexClauseAdjustment({ ...base, indexedSharePpm: 0, capPpm: cap, floorPpm: floor }).amount).toBe(0);
        const plain = indexClauseAdjustment({ ...base, triggerPpm: 0, pays: 'whole-change', indexedSharePpm: 1_000_000, capPpm: null, floorPpm: null });
        expect(plain.exact).toEqual(rSub(rMul(R(P), index.ratio), R(P)));
      }),
    );
  });

  test('96: a missing value, an index <= 0, two series, two bases, two editions or a preliminary stored factor raise; never 1.0', () => {
    expectCode(() => indexRatio(WIRE, '2025-06', '2026-05'), 'MISSING_INDEX_VALUE');
    expectCode(() => genericSeries('S', ['0.000', '1.000']), 'INDEX_NOT_POSITIVE');
    expectCode(() => genericSeries('S', ['-1', '1.000']), 'BAD_INDEX_VALUE');
    expectCode(() => normalizeSeries({ ...seriesInput('S'), observations: [obs('S', '2020-01', '1'), obs('T', '2020-02', '1')] }), 'SERIES_MISMATCH');
    expectCode(() => normalizeSeries({ ...seriesInput('S'), observations: [obs('S', '2020-01', '1'), { ...obs('S', '2020-02', '1'), referenceBase: 'other' }] }), 'BASE_MISMATCH');
    expectCode(() => normalizeSeries({ ...seriesInput('S'), observations: [obs('S', '2020-01', '1'), obs('S', '2020-01', '2')] }), 'DUPLICATE_PERIOD');
    expectCode(() => assertSameSeries(indexRatio(WIRE, '2025-05', '2026-05'), indexRatio(CONDUIT, '2025-05', '2026-05')), 'SERIES_MISMATCH');
    expectCode(() => chainIndexRatios([indexRatio(WIRE, '2025-05', '2026-05'), indexRatio(CONDUIT, '2025-05', '2026-05')]), 'SERIES_MISMATCH');
    expectCode(() => indexRatio(WIRE, '2026-05', '2026-09'), 'PRELIMINARY_VALUE');
    expect(indexRatio(WIRE, '2026-05', '2026-09', { allowPreliminary: true }).preliminary).toBe(true);
    expect(latestFinal(WIRE).period).toBe('2026-05');
    expect(indexPoint(WIRE, '2025-05').raw).toBe('459.176');
    const other: AcfTable = { ...ACF_2026, edition: 'UFS 3-701-01 2025' };
    expectCode(() => acfFactor(ACF_2026, ACF_2026.rows[0]!, other, other.rows[1]!), 'EDITION_MISMATCH');
    expectCode(() => acfLookup(ACF_2026, { zip: '89410' }), 'ZIP_NOT_UNIQUE');
    expectCode(() => acfLookup(ACF_2026, { state: 'NV', county: 'Douglas' }), 'NO_ACF_ROW');
    expect(acfLookup(ACF_2026, { state: 'NV', county: 'Douglas' }, { useNearestSiteAssumption: true })).toMatchObject({ row: { site: 'Carson City and Reno' }, assumptions: [{ id: 'A-32' }] });
    expectCode(() => wageRatio(US, { ...BAL_NV, period: '2024-05' }), 'WAGE_PERIOD_MISMATCH');
    expectCode(() => wageRatio(US, { ...BAL_NV, measure: 'median' }), 'WAGE_MEASURE_MISMATCH');
    fc.assert(
      fc.property(fc.array(idx, { minLength: 1, maxLength: 6 }), fc.integer({ min: 6, max: 11 }), (vals, missing) => {
        const s = genericSeries('S', vals);
        expectCode(() => indexRatio(s, per(0), per(missing)), 'MISSING_INDEX_VALUE');
      }),
    );
  });

  test('96 (6.7 guards): no place factor on local inputs or a takeoff; ACF only parametric; national time index only', () => {
    const wr = wageRatio(US, BAL_NV);
    const nat = indexRatio(WIRE, '2025-05', '2026-05');
    expectCode(() => combinedAdjustment({ id: 'x', amount: c(100), basis: 'historical', bucket: 'labor', alreadyLocal: true, place: wr }), 'LOCATION_ON_LOCAL_INPUT');
    expectCode(() => combinedAdjustment({ id: 'x', amount: c(100), basis: 'takeoff', bucket: 'labor', place: wr }), 'LOCATION_ON_TAKEOFF');
    const r = (s: string) => acfLookup(ACF_2026, { site: s }).row;
    expectCode(() => combinedAdjustment({ id: 'x', amount: c(100), basis: 'historical', bucket: 'whole', place: acfFactor(ACF_2026, r('Sacramento'), ACF_2026, r('NAS Fallon')) }), 'ACF_CONTEXT_ONLY');
    const caTime = indexRatio(CALTRANS, '2024-Q1', '2024-Q2');
    expectCode(() => combinedAdjustment({ id: 'x', amount: c(100), basis: 'historical', bucket: 'labor', place: wr, time: caTime }), 'TIME_INDEX_NOT_NATIONAL');
    const held = combinedAdjustment({ id: 'x', amount: c(100_000), basis: 'takeoff', bucket: 'material', firmHoldThroughPurchase: true, time: nat, forward: R(11, 10) });
    expect(held.amount).toBe(100_000);
    expect(held.timeFactor).toEqual(R(1));
    expect(combinedAdjustment({ id: 'x', amount: c(100_000), basis: 'takeoff', bucket: 'labor', scheduledLabor: true, time: nat }).amount).toBe(100_000);
  });

  test('97: a wage-ratio factor changes labor dollars only', () => {
    fc.assert(
      fc.property(cents, cents, cents, cents, fc.integer({ min: 1, max: 99_999 }), fc.integer({ min: 1, max: 99_999 }), (L, M, E, O, wa, wb) => {
        const f = wageRatio(wage('A', wa), wage('B', wb));
        const out = applyWageRatio({ labor: c(L), material: c(M), equipment: c(E), other: c(O) }, f);
        expect([out.material, out.equipment, out.other]).toEqual([M, E, O]);
        expect(out.labor).toBe(roundRatioCents(rMul(R(L), f.factor)));
      }),
    );
    expectCode(() => combinedAdjustment({ id: 'x', amount: c(100), basis: 'historical', bucket: 'material', place: wageRatio(US, BAL_NV) }), 'WAGE_RATIO_LABOR_ONLY');
    expect(compositeFromShares([{ share: R(45, 100), relative: wageRatio(US, BAL_NV).factor }, { share: R(55, 100), relative: R(1) }])).toEqual(
      compositeLocationFactor({ origin: { labor: c(45), material: c(55), other: c(0) }, labor: wageRatio(US, BAL_NV) }).factor,
    );
  });

  test('98: unit-price band order, weighted mean, scaling, exclusions, mixed units, as-of date, monotone rank', () => {
    const rowGen = fc.record({
      qty: fc.integer({ min: 100_000, max: 10_000_000 }),
      price: fc.integer({ min: 1, max: 5_000_000 }),
    });
    fc.assert(
      fc.property(fc.array(rowGen, { minLength: 1, maxLength: 30 }), fc.integer({ min: 2, max: 50 }), fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 0, max: 1_000_000 }), (rs, k, u1, du) => {
        const pairs = rs.map((r) => ({ q: q(r.qty), p: R(r.price) }));
        const b = bandStats(pairs, 'n');
        const order = [b.min, b.p10, b.p25, b.p50, b.p75, b.p90, b.max];
        for (let i = 1; i < order.length; i++) expect(rCmp(order[i - 1]!, order[i]!)).toBeLessThanOrEqual(0);
        expect(rCmp(b.weightedMean, b.min)).toBeGreaterThanOrEqual(0);
        expect(rCmp(b.weightedMean, b.max)).toBeLessThanOrEqual(0);
        // sum q_i (p_i - Pw) = 0
        const s = pairs.reduce((acc, x) => rAdd(acc, rMul(R(x.q), rSub(x.p, b.weightedMean))), R(0));
        expect(s).toEqual(R(0));
        // equal quantities -> simple mean; scaling quantities or reordering rows -> unchanged
        expect(bandStats(pairs.map((x) => ({ q: q(7), p: x.p })), 'n').weightedMean).toEqual(b.mean);
        expect(bandStats(pairs.map((x) => ({ q: q(x.q * k), p: x.p })), 'n').weightedMean).toEqual(b.weightedMean);
        expect(bandStats([...pairs].reverse(), 'n')).toEqual(b);
        // scaling all prices by k scales the band by k
        const bk = bandStats(pairs.map((x) => ({ q: x.q, p: rMul(x.p, R(k)) })), 'n');
        expect([bk.p10, bk.p50, bk.p90, bk.weightedMean]).toEqual([b.p10, b.p50, b.p90, b.weightedMean].map((x) => rMul(x, R(k))));
        // contractor's percentile rank never falls when their price rises
        const sorted = pairs.map((x) => x.p).sort(rCmp);
        expect(rCmp(percentileRank(sorted, R(u1 + du)), percentileRank(sorted, R(u1)))).toBeGreaterThanOrEqual(0);
      }),
    );
    // excluded rows never enter; mixed units raise; no row dated after the as-of date is used
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 0, maxLength: 12 }), fc.integer({ min: 1, max: 1_000_000 }), (prices, junk) => {
        const good = prices.map((p, i) => row(`g${i}`, 1_000_000, p));
        const bad = [
          row('ls', 1_000_000, junk, { biddingUnitIsLumpSum: true }),
          row('ls1', 1_000, junk, { unit: 'LS' }),
          row('derived', 1_000_000, junk, { lumpSumDerived: true }),
          row('zero', 1_000_000, 0),
          row('neg', 1_000_000, -junk),
          row('q0', 0, junk),
          row('late', 1_000_000, junk, { bidOpenDate: d('2026-11-14') }),
          row('lost', 1_000_000, junk, { awarded: false }),
          row('tiny', 99_999, junk),
          row('huge', 10_000_001, junk),
        ];
        const res = unitPriceBand({ contractor: { basis: 'sell', itemSellTotal: c(500_000_000), quantity: q(1_000_000), unit: 'lf' }, rows: [...bad, ...good], asOf: d('2026-11-13'), jobState: 'NV', sdDivisor: 'n-1' });
        expect(res.used).toEqual(good.map((g) => g.id));
        expect(res.excluded.map((e) => e.id).sort()).toEqual(bad.map((b) => b.id).sort());
        if (good.length > 0) expect(res.raw!.n).toBe(good.length);
      }),
    );
    expectCode(() => unitPriceBand({ contractor: { basis: 'sell', itemSellTotal: c(100), quantity: q(1_000), unit: 'LF' }, rows: [row('ea', 1_000, 100, { unit: 'EA' })], asOf: d('2026-11-13'), jobState: 'NV', sdDivisor: 'n' }), 'MIXED_UNITS');
    expectCode(() => likeForLikeUnitPrice({ basis: 'direct', itemSellTotal: c(100), quantity: q(1_000), unit: 'LF' }), 'DIRECT_COST_COMPARISON');
  });

  test('98 (flag rules): below P10 / above P90 flags with n >= n_min; adjusted band alone never flags; thin below 20; unreliable rule', () => {
    const prices = [1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900];
    const rows = prices.map((p, i) => row(`r${i}`, 1_000_000, p, { bidOpenDate: d('2024-05-01') }));
    const run = (unitCents: number, adj = false) =>
      unitPriceBand({
        contractor: { basis: 'sell', itemSellTotal: c(unitCents * 1000), quantity: q(1_000_000), unit: 'LF' },
        rows, asOf: d('2026-11-13'), jobState: 'NV', sdDivisor: 'n-1',
        ...(adj ? { adjustment: { series: CALTRANS, toPeriod: '2026-Q2' } } : {}),
      });
    expect(run(900).flag).toBe('below_range');
    expect(run(2000).flag).toBe('above_range');
    expect(run(1500).flag).toBeNull();
    expect(run(1500).thin).toBe(true);
    // P10 = 1000 + 0.9 x 100 = 1090 exactly
    expect(run(1500).raw!.p10).toEqual(R(1090));
    // index adjustment lowers every price (146.53 / 168.45); a raw-only flag that the adjusted band contradicts is withdrawn
    const a = run(1050, true);
    expect(a.rawFlag).toBe('below_range');
    expect(a.adjustedFlag).toBeNull();
    expect(a.flag).toBeNull();
    // adjusted alone would flag 2000 * 146.53/168.45 band... a price above the adjusted P90 but inside the raw band: no flag
    const b = run(1800, true);
    expect(b.adjustedFlag).toBe('above_range');
    expect(b.rawFlag).toBeNull();
    expect(b.flag).toBeNull();
    // missing I_from: factor 1 and a flag on that row
    const old = unitPriceBand({ contractor: { basis: 'sell', itemSellTotal: c(1_000_000), quantity: q(1_000_000), unit: 'LF' }, rows: [row('old', 1_000_000, 1000, { bidOpenDate: d('2019-01-01') })], asOf: d('2026-11-13'), jobState: 'CA', sdDivisor: 'n', adjustment: { series: CALTRANS, toPeriod: '2026-Q2' } });
    expect(old.rowsShown[0]!.adjusted).toEqual(R(1000));
    expect(old.rowsShown[0]!.indexFlag).toMatch(/unadjusted/);
    // unreliable: s > minimum price (binding form), with the divisor stated
    const spread = bandStats([1, 1000].map((p) => ({ q: q(1000), p: R(p) })), 'n');
    expect(spread.unreliable).toBe(true);
    expect(spread.sdDivisor).toBe('n');
    expect(percentile([R(1)], 900_000)).toEqual(R(1));
  });
});

// ---------------------------------------------------------------- helpers

function row(id: string, quantity: number, unitPrice: number, o: Partial<UnitPriceRow> = {}): UnitPriceRow {
  return {
    id, source: 'https://wsdot.wa.gov/biz/contaa/uba/', state: 'WA', agency: 'test', itemCode: '1', description: 'conduit pipe 2 in.',
    unit: 'LF', biddingUnitIsLumpSum: false, lumpSumDerived: false, awarded: true, quantity: q(quantity), unitPrice: c(unitPrice), bidOpenDate: d('2025-06-01'), ...o,
  };
}
function seriesInput(id: string): IndexSeriesInput {
  return { id, title: id, titleVerified: true, source: 'test', frequency: 'monthly', referenceBase: 'B', geography: 'national', observations: [] };
}
function obs(seriesId: string, period: string, value: string): IndexObservation {
  return { seriesId, period, value, preliminary: false, referenceBase: 'B', source: 'test' };
}
