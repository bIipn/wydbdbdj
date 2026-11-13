// Spec section 7 (bid price selection): invariants 99 to 115 of section 10.9 as fast-check properties,
// golden examples I-21 to I-25 and P-17 of section 11 as exact-value tests, and the L5 differential
// test of the exact candidate search against brute force on small cases.
// Test plan 10.0: pinned seed, 1,000 runs per cheap property; whole-selection properties run 200 to
// 300 cases (each one runs the full optimiser). Never Math.random, never fc.float for money.
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import {
  A25_ALPHA,
  A25_MIN_J,
  assumedRivalCurve,
  beats,
  brier,
  competitorCountDistribution,
  dkwBand,
  dkwEpsilon,
  evaluatedPrice,
  federalCompetitors,
  friedman,
  friedmanMixture,
  friedmanTypical,
  gates,
  gatesTypical,
  normalCdf,
  nvSmallWorksSolicitation,
  preferenceFactor,
  presentModelPair,
  presentWinProbability,
  pWinEmpirical,
  pWinKernel,
  pWinRivals,
  ruleInForce,
  shrinkTowardSymmetric,
  tailMinimumJ,
  wilson,
  zeroWinsUpperBound,
  zForAlpha,
  type AwardRule,
  type BidderFlags,
  type CurveResult,
  type HistoryInput,
  type JobForCurve,
  type LettingRecord,
  type RivalBid,
  type WinCurve,
} from '../src/cost/winprob.js';
import {
  A24_DELTA,
  adequacyCheck,
  adequacyThresholdPct,
  adjustedCost,
  bidFloor,
  expectedMaxNormal,
  expectedProfitCurve,
  lowBidVsEstimate,
  makeEvaluator,
  selectBid,
  uniformBenchmark,
  winnersCurse,
  type BidSelectionInput,
} from '../src/cost/bidding.js';
import { ratio, rAdd, rCmp, rDiv, rEq, rMul, rSub, type Cents, type Ppm, type PriceChargesInput } from '../src/cost/index.js';

const SEED = 20_261_113;
const RUNS = 1_000;
const HEAVY = 250;
fc.configureGlobal({ seed: SEED, numRuns: RUNS });

const c = (n: number) => n as Cents;
const pp = (n: number) => n as Ppm;
const PUB = { kind: 'public', source: 'bid tabulation (test fixture, illustration)' } as const;
const SEALED: AwardRule = { kind: 'sealed_low' };
const job = (anchor: number, rule: AwardRule = SEALED, ourFlags: BidderFlags = {}): JobForCurve => ({ anchor: c(anchor), rule, ourFlags });
const letting = (anchor: number, low: number, i = 0, competitorFlags?: BidderFlags): LettingRecord => ({
  id: `L${i}`,
  anchor: c(anchor),
  anchorKind: 'owner_estimate',
  lowestCompeting: c(low),
  provenance: PUB,
  ...(competitorFlags ? { competitorFlags } : {}),
});
const history = (rows: LettingRecord[], ref = 'NV electrical, local agency, $10K-$50K, 2-4 bidders (illustration)'): HistoryInput => ({ lettings: rows, referenceClass: ref, requestingTenantId: 'tenant-a' });
const noCharges: PriceChargesInput = { tiers: [], mDurPpm: pp(1_000_000), fees: [] };
const feeCharges = (f: number): PriceChargesInput => ({ tiers: [], mDurPpm: pp(1_000_000), fees: f ? [{ label: 'receipts-rated GL', rate: { ppm: pp(f), base: 'on_price' } }] : [] });
const ok = (r: CurveResult): WinCurve => {
  if (r.status !== 'ok') throw new Error(`expected a curve, got ${r.reason}`);
  return r.curve;
};

// ---------------------------------------------------------------- generators

const arbLettings = (minJ = 10, maxJ = 30) =>
  fc.array(fc.record({ anchor: fc.integer({ min: 1_000, max: 5_000_000 }), r: fc.integer({ min: 600, max: 1_600 }) }), { minLength: minJ, maxLength: maxJ }).map((rs) =>
    rs.map((x, i) => letting(x.anchor, Math.max(1, Math.floor((x.anchor * x.r) / 1000)), i)),
  );
const arbRivalBids = (minN = 10, maxN = 25) =>
  fc.array(fc.record({ est: fc.integer({ min: 1_000, max: 5_000_000 }), r: fc.integer({ min: 800, max: 1_500 }) }), { minLength: minN, maxLength: maxN }).map((rs) =>
    rs.map((x, i): RivalBid => ({ jobId: `J${i}`, ourEstimate: c(x.est), rivalBid: c(Math.max(1, Math.floor((x.est * x.r) / 1000))), provenance: PUB })),
  );
const arbP = fc.double({ min: 0, max: 1, noNaN: true });
const arbPpos = fc.double({ min: 0.001, max: 1, noNaN: true });

// ================================================================ golden examples (section 11)

describe('golden examples, section 11.3 (bid selection)', () => {
  test('I-21 Friedman and Gates for (p, n)', () => {
    const rows: [number, number, number, number][] = [
      [0.5, 2, 0.25, 0.3333],
      [0.5, 3, 0.125, 0.25],
      [0.7, 3, 0.343, 0.4375],
      [0.9, 3, 0.729, 0.75],
      [0.9, 5, 0.5905, 0.6429],
      [0.7, 8, 0.0576, 0.2258],
    ];
    for (const [p, n, f, g] of rows) {
      const ps = Array.from({ length: n }, () => p);
      expect(friedman(ps).toFixed(4)).toBe(f.toFixed(4));
      expect(gates(ps).toFixed(4)).toBe(g.toFixed(4));
      expect(friedmanTypical(p, n)).toBeCloseTo(friedman(ps), 14);
      expect(gatesTypical(p, n)).toBeCloseTo(gates(ps), 14);
    }
  });

  const C = 100_000_000; // $1,000,000.00 our cost; no price-based charges, OH, FIN or K
  const costs = { TJC: c(C), OH: c(0), FIN: c(0), K: c(0) };
  test('I-22 optimal markup, exact: p(m) = exp(-12m) under Friedman', () => {
    const expected: [number, string, string][] = [
      [1, '8.333', '3.066'],
      [2, '4.167', '1.533'],
      [4, '2.083', '0.766'],
    ];
    for (const [n, mStar, evPct] of expected) {
      const curve = assumedRivalCurve('friedman', { kind: 'exponential', lambda: 12 }, { n }, c(C), 'I-22 illustration');
      const r = selectBid({ costs, charges: noCharges, minMarkupPpm: pp(0), curve, searchHi: c(2 * C) });
      expect(r.status).toBe('bid');
      if (r.status !== 'bid') continue;
      expect((r.recommended.markup * 100).toFixed(3)).toBe(mStar);
      expect((r.recommended.win.p * 100).toFixed(2)).toBe('36.79');
      expect(((r.recommended.ev / C) * 100).toFixed(3)).toBe(evPct);
    }
    // With d = 0.03 (C_adj/C = 1.03, from a winner's-curse setting), n = 2: m* = 7.1667%.
    const d = 0.03;
    const curse = winnersCurse(1, d / (1 + d) / expectedMaxNormal(2), 2);
    expect(curse.factor).toBeCloseTo(1.03, 12);
    const curve = assumedRivalCurve('friedman', { kind: 'exponential', lambda: 12 }, { n: 2 }, c(C), 'I-22 illustration');
    const r = selectBid({ costs, charges: noCharges, minMarkupPpm: pp(0), curve, searchHi: c(2 * C), curse });
    expect(r.status === 'bid' && (r.recommended.markup * 100).toFixed(4)).toBe('7.1667');
  });

  test('I-23 optimal markup on a constructed curve: rival ratio Normal(1.10, 0.07)', () => {
    const ns = [1, 2, 3, 4, 5, 8];
    const want = { friedman: ['9.40', '6.69', '5.40', '4.60', '4.04', '3.03'], gates: ['9.40', '7.86', '7.08', '6.58', '6.23', '5.61'] };
    for (const model of ['friedman', 'gates'] as const) {
      const got = ns.map((n) => {
        const curve = assumedRivalCurve(model, { kind: 'normalRatio', mean: 1.1, sd: 0.07 }, { n }, c(C), 'I-23 illustration');
        const r = selectBid({ costs, charges: noCharges, minMarkupPpm: pp(0), curve });
        return r.status === 'bid' ? (r.recommended.markup * 100).toFixed(2) : 'no bid';
      });
      expect(got).toEqual(want[model]);
    }
  });

  test("I-24 winner's curse: sigma 8%, N 5 -> 1.1026 (linear 1.0930); sigma 15%, N 8 -> 1.2715 (linear 1.2135)", () => {
    const a = winnersCurse(1, 0.08, 5);
    expect(a.factor.toFixed(4)).toBe('1.1026');
    expect(a.linearFactor.toFixed(4)).toBe('1.0930');
    const b = winnersCurse(1, 0.15, 8);
    expect(b.factor.toFixed(4)).toBe('1.2715');
    expect(b.linearFactor.toFixed(4)).toBe('1.2135');
  });

  test('D-76 expected maximum of N standard normals (recomputed, not tabled)', () => {
    // Source: D-76, https://www.itl.nist.gov/div898/software/dataplot/refman1/auxillar/kernplot.htm (verifier-recomputed values)
    const table: [number, string][] = [
      [2, '0.5642'],
      [3, '0.8463'],
      [4, '1.0294'],
      [5, '1.1630'],
      [6, '1.2672'],
      [7, '1.3522'],
      [8, '1.4236'],
      [10, '1.5388'],
    ];
    for (const [N, v] of table) expect(expectedMaxNormal(N).toFixed(4)).toBe(v);
  });

  test('I-25 Wilson 95%: 3/10 10.8-60.3%; 6/20 14.5-51.9%; 25/100 17.5-34.3%; 0/10 0-27.8%; DKW J=30 0.248, J=100 0.136', () => {
    const rows: [number, number, string, string][] = [
      [3, 10, '10.8', '60.3'],
      [6, 20, '14.5', '51.9'],
      [25, 100, '17.5', '34.3'],
      [0, 10, '0.0', '27.8'],
    ];
    for (const [k, J, lo, hi] of rows) {
      const w = wilson(k, J);
      expect((w.lo * 100).toFixed(1)).toBe(lo);
      expect((w.hi * 100).toFixed(1)).toBe(hi);
    }
    expect(dkwEpsilon(30).toFixed(3)).toBe('0.248');
    expect(dkwEpsilon(100).toFixed(3)).toBe('0.136');
  });

  test('7.5 printed values: DKW J=10 0.43, 30 0.25, 100 0.14, 185 0.10, 738 0.05; tails 10% 29, 5% 59, 25% 11; zero wins about 3/J', () => {
    expect([10, 30, 100, 185, 738].map((J) => dkwEpsilon(J).toFixed(2))).toEqual(['0.43', '0.25', '0.14', '0.10', '0.05']);
    expect(tailMinimumJ(0.1)).toBe(29);
    expect(tailMinimumJ(0.05)).toBe(59);
    expect(tailMinimumJ(0.25)).toBe(11);
    for (const J of [30, 100, 300]) expect(Math.abs(zeroWinsUpperBound(J) * J - 3)).toBeLessThan(0.2); // "about 3/J": -ln(0.05) = 2.996
    expect(zForAlpha(A25_ALPHA).toFixed(2)).toBe('1.96');
  });

  test('P-17 FHWA legacy adequacy: 3 bids at 108% adequate (110%); 2 at 108% not (105%); 5 at 121% not (120%)', () => {
    // Source: D-74, https://www.fhwa.dot.gov/programadmin/contracts/cacc.pdf
    const E = c(100_000_00);
    const three = adequacyCheck([c(108_000_00), c(110_000_00), c(120_000_00), c(140_000_00)], E);
    expect([three.k, three.limitPct, three.verdict]).toEqual([3, 110, 'adequate']);
    const two = adequacyCheck([c(108_000_00), c(125_000_00), c(150_000_00)], E);
    expect([two.k, two.limitPct, two.verdict]).toEqual([2, 105, 'not_adequate']);
    expect(two.warning).toMatch(/re-advertise/);
    const five = adequacyCheck([c(121_000_00), c(122_000_00), c(130_000_00), c(140_000_00), c(145_200_00)], E);
    expect([five.k, five.limitPct, five.verdict]).toEqual([5, 120, 'not_adequate']);
    const six = adequacyCheck([1, 2, 3, 4, 5, 6].map((i) => c(100_000_00 + i)), E);
    expect([six.k, six.limitPct, six.verdict]).toEqual([6, null, 'excellent']);
  });

  test('NV preference worked figure (G-BID script): preferred bidder at 1.05 x 300,000 = 315,000.00 is the best bid', () => {
    const rule: AwardRule = { kind: 'nv_bidder_preference', estimatedCost: c(300_000_00) };
    const pref = { nvPreferenceEligible: true };
    expect(beats(rule, { price: c(315_000_00), flags: pref }, { price: c(300_000_00), flags: {} })).toBe(true);
    expect(beats(rule, { price: c(315_000_01), flags: pref }, { price: c(300_000_00), flags: {} })).toBe(false);
    expect(beats(rule, { price: c(300_000_00), flags: {} }, { price: c(315_000_00), flags: pref })).toBe(false);
    expect(beats(rule, { price: c(299_999_99), flags: {} }, { price: c(315_000_00), flags: pref })).toBe(true);
  });
});

// ================================================================ 10.9 invariants

describe('10.9 bid selection invariants', () => {
  test('99 P_win in [0, 1] and non-increasing in B: empirical, kernel, Friedman, Gates (named, typical, mixture), assumed', () => {
    fc.assert(
      fc.property(
        arbLettings(),
        arbRivalBids(),
        arbRivalBids(),
        fc.integer({ min: 1_000, max: 5_000_000 }),
        fc.integer({ min: 1, max: 12_000_000 }),
        fc.integer({ min: 0, max: 500_000 }),
        fc.integer({ min: 0, max: 4 }),
        (rows, r1, r2, A, B, dB, n) => {
          const H = history(rows);
          const curves: WinCurve[] = [ok(pWinEmpirical(H, job(A))), ok(pWinKernel(H, job(A)))];
          for (const model of ['friedman', 'gates'] as const) {
            const base = { referenceClass: 'rivals (illustration)', requestingTenantId: 'tenant-a', ourEstimate: c(A), rule: SEALED, ourFlags: {} };
            curves.push(ok(pWinRivals(model, { ...base, rivals: { kind: 'named', rivals: [{ rivalId: 'r1', bids: r1 }, { rivalId: 'r2', bids: r2 }] } })));
            curves.push(ok(pWinRivals(model, { ...base, rivals: { kind: 'typical', pooled: [...r1, ...r2], n } })));
            curves.push(ok(pWinRivals(model, { ...base, rivals: { kind: 'mixture', pooled: r1, g: [{ k: 0, p: 0.1 }, { k: 2, p: 0.6 }, { k: 3, p: 0.3 }] } })));
            curves.push(ok(assumedRivalCurve(model, { kind: 'normalRatio', mean: 1.1, sd: 0.07 }, { n: n + 1 }, c(A), 'assumed')));
            curves.push(ok(assumedRivalCurve(model, { kind: 'exponential', lambda: 9 }, { n }, c(A), 'assumed')));
          }
          for (const cv of curves) {
            const a = cv.p(c(B)), b = cv.p(c(B + dB));
            expect(a).toBeGreaterThanOrEqual(0);
            expect(a).toBeLessThanOrEqual(1);
            expect(b).toBeLessThanOrEqual(a);
            const e = cv.estimate(c(B));
            expect(e.lo).toBeLessThanOrEqual(e.p);
            expect(e.p).toBeLessThanOrEqual(e.hi);
            expect(e.lo).toBeGreaterThanOrEqual(0);
            expect(e.hi).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: HEAVY },
    );
  });

  test('100 no competitors gives 1; one competitor gives p_1 in both forms', () => {
    expect(friedman([])).toBe(1);
    expect(gates([])).toBe(1);
    expect(friedmanTypical(0.3, 0)).toBe(1);
    expect(gatesTypical(0.3, 0)).toBe(1);
    fc.assert(
      fc.property(arbP, (p) => {
        expect(friedman([p])).toBe(p);
        expect(gates([p])).toBeCloseTo(p, 12);
      }),
    );
  });

  test('101 Friedman <= Gates, equality iff at most one p_i < 1; Gates identity; p = 0.5; symmetry; adding rivals; p_i = 0', () => {
    fc.assert(
      fc.property(fc.array(arbPpos, { minLength: 0, maxLength: 8 }), fc.double({ min: 0.001, max: 0.999, noNaN: true }), (ps, extra) => {
        const F = friedman(ps), G = gates(ps);
        expect(F).toBeLessThanOrEqual(G + 1e-12);
        const below = ps.filter((x) => x < 1).length;
        if (below <= 1) expect(G).toBeCloseTo(F, 12);
        else if (ps.filter((x) => x < 0.999).length >= 2) expect(G - F).toBeGreaterThan(0);
        const s = ps.reduce((a, x) => a + (1 - x) / x, 0);
        expect((1 - G) / G).toBeCloseTo(s, 6);
        const rev = [...ps].reverse();
        expect(friedman(rev)).toBeCloseTo(F, 14);
        expect(gates(rev)).toBeCloseTo(G, 14);
        expect(friedman([...ps, extra])).toBeLessThan(F);
        expect(gates([...ps, extra])).toBeLessThan(G);
        expect(friedman([...ps, 1])).toBe(F);
        expect(gates([...ps, 1])).toBe(G);
        expect(friedman([...ps, 0])).toBe(0);
        expect(gates([...ps, 0])).toBe(0);
      }),
    );
    for (let n = 1; n <= 12; n++) {
      const half = Array.from({ length: n }, () => 0.5);
      expect(gates(half)).toBeCloseTo(1 / (n + 1), 14);
      expect(friedman(half)).toBe(2 ** -n);
    }
  });

  test('102 the empirical estimate takes values in {0, 1/J, ..., 1} and is a non-increasing step function', () => {
    fc.assert(
      fc.property(arbLettings(), fc.integer({ min: 1_000, max: 5_000_000 }), fc.array(fc.integer({ min: 0, max: 10_000_000 }), { minLength: 2, maxLength: 12 }), (rows, A, Bs) => {
        const cv = ok(pWinEmpirical(history(rows), job(A)));
        const J = rows.length;
        const sorted = [...Bs].sort((a, b) => a - b);
        let prev = 1;
        for (const B of sorted) {
          const v = cv.p(c(B));
          expect(Number.isInteger(Math.round(v * J)) && Math.abs(v * J - Math.round(v * J)) < 1e-9).toBe(true);
          expect(v).toBeLessThanOrEqual(prev);
          prev = v;
          expect(cv.estimate(c(B)).k).toBe(Math.round(v * J));
        }
        // p changes exactly at the listed jumps
        for (const j of cv.jumps) expect(cv.p(c(j))).toBeLessThan(cv.p(c(j - 1)));
      }),
      { numRuns: HEAVY },
    );
  });

  const arbCosts = fc.record({
    TJC: fc.integer({ min: 100_000, max: 5_000_000 }),
    OH: fc.integer({ min: 0, max: 500_000 }),
    FIN: fc.integer({ min: 0, max: 100_000 }),
    K: fc.integer({ min: 0, max: 50_000 }),
    fee: fc.integer({ min: 0, max: 30_000 }),
    mMin: fc.integer({ min: 0, max: 100_000 }),
  });
  const selection = (rows: LettingRecord[], A: number, g: { TJC: number; OH: number; FIN: number; K: number; fee: number; mMin: number }, extra: Partial<BidSelectionInput> = {}): BidSelectionInput => ({
    costs: { TJC: c(g.TJC), OH: c(g.OH), FIN: c(g.FIN), K: c(g.K) },
    charges: feeCharges(g.fee),
    minMarkupPpm: pp(g.mMin),
    curve: pWinEmpirical(history(rows), job(A)),
    ...extra,
  });

  test('103 EV <= profitIfWon when profit >= 0; EV = -K where profitIfWon = 0; EV < 0 below cost whenever P_win > 0', () => {
    fc.assert(
      fc.property(arbLettings(), fc.integer({ min: 100_000, max: 5_000_000 }), arbCosts, fc.integer({ min: 0, max: 12_000_000 }), (rows, A, g, B) => {
        const inp = selection(rows, A, g);
        const E = makeEvaluator(inp, ok(inp.curve));
        const pr = E.profitIfWon(c(B)), ev = E.ev(c(B)), p = E.curve.p(c(B));
        if (pr >= 0) expect(ev).toBeLessThanOrEqual(pr);
        if (pr === 0) expect(ev).toBe(-g.K);
        if (pr < 0 && p > 0) expect(ev).toBeLessThan(0);
      }),
    );
    // the profit = 0 point exists: B = grossUp(cost) with no charges
    const rows = Array.from({ length: 10 }, (_, i) => letting(1_000_000, 1_000_000 + i * 10_000, i));
    const inp = selection(rows, 1_000_000, { TJC: 500_000, OH: 100_000, FIN: 0, K: 7_000, fee: 0, mMin: 0 });
    const E = makeEvaluator(inp, ok(inp.curve));
    expect(E.profitIfWon(c(600_000))).toBe(0);
    expect(E.ev(c(600_000))).toBe(-7_000);
  });

  test('104 the maximum expected profit is non-increasing in the number of competitors (Friedman and Gates)', () => {
    fc.assert(
      fc.property(arbRivalBids(10, 20), arbCosts, fc.integer({ min: 0, max: 5 }), (pooled, g, n) => {
        for (const model of ['friedman', 'gates'] as const) {
          const best = (k: number): number => {
            const curve = pWinRivals(model, { rivals: { kind: 'typical', pooled, n: k }, referenceClass: 'rivals', requestingTenantId: 'tenant-a', ourEstimate: c(g.TJC), rule: SEALED, ourFlags: {} });
            const r = selectBid({ costs: { TJC: c(g.TJC), OH: c(g.OH), FIN: c(g.FIN), K: c(g.K) }, charges: feeCharges(g.fee), minMarkupPpm: pp(g.mMin), curve, searchHi: c(4 * g.TJC + 4 * g.OH + 1_000_000) });
            if (r.status === 'bid') return r.recommended.ev;
            if (r.status === 'no_bid' && r.best) return r.best.ev;
            throw new Error('unexpected');
          };
          expect(best(n + 1)).toBeLessThanOrEqual(best(n) + 1e-6);
        }
      }),
      { numRuns: HEAVY },
    );
  });

  test('105 p(m) = exp(-lambda m) under Friedman: m* = d + 1/(n lambda), P_win(m*) = exp(-1); m* halves when n doubles', () => {
    const C = 100_000_000;
    fc.assert(
      fc.property(fc.integer({ min: 5, max: 60 }), fc.integer({ min: 1, max: 6 }), (lambda, n) => {
        const run = (k: number) => {
          const curve = assumedRivalCurve('friedman', { kind: 'exponential', lambda }, { n: k }, c(C), 'exp');
          const r = selectBid({ costs: { TJC: c(C), OH: c(0), FIN: c(0), K: c(0) }, charges: noCharges, minMarkupPpm: pp(0), curve, searchHi: c(2 * C) });
          if (r.status !== 'bid') throw new Error('no bid');
          return r.recommended;
        };
        const a = run(n), b = run(2 * n);
        expect(Math.abs(a.markup - 1 / (n * lambda))).toBeLessThan(2e-6);
        expect(a.win.p).toBeCloseTo(Math.exp(-1), 5);
        expect(Math.abs(b.markup - a.markup / 2)).toBeLessThan(2e-6);
      }),
      { numRuns: 200 },
    );
  });

  test('106 scaling every dollar input by k: m* and P_win unchanged, EV x k (smooth); k EV* <= EV*_k <= k EV* + (k - 1) (step)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 20 }), fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1_000_000, max: 20_000_000 }), (k, n, C) => {
        const run = (s: number) => {
          const curve = assumedRivalCurve('gates', { kind: 'normalRatio', mean: 1.1, sd: 0.07 }, { n }, c(s * C), 'scale');
          const r = selectBid({ costs: { TJC: c(s * C), OH: c(0), FIN: c(0), K: c(s * 1_000) }, charges: noCharges, minMarkupPpm: pp(0), curve });
          if (r.status !== 'bid') throw new Error('no bid');
          return r.recommended;
        };
        const a = run(1), b = run(k);
        expect(Math.abs(a.markup - b.markup)).toBeLessThan(2 / C);
        expect(Math.abs(a.win.p - b.win.p)).toBeLessThan(1e-4);
        expect(Math.abs(b.ev / (k * a.ev) - 1)).toBeLessThan(1e-6);
      }),
      { numRuns: 200 },
    );
    fc.assert(
      fc.property(arbLettings(10, 20), fc.integer({ min: 100_000, max: 2_000_000 }), fc.integer({ min: 2, max: 9 }), fc.integer({ min: 0, max: 20_000 }), (rows, A, k, K) => {
        const run = (s: number) => {
          const scaled = rows.map((l, i) => letting(l.anchor * s, l.lowestCompeting * s, i));
          const r = selectBid({ costs: { TJC: c(A * s), OH: c(0), FIN: c(0), K: c(K * s) }, charges: noCharges, minMarkupPpm: pp(0), curve: pWinEmpirical(history(scaled), job(A * s)) });
          return r.status === 'bid' ? r.recommended.ev : r.status === 'no_bid' && r.best ? r.best.ev : -K * s;
        };
        const e1 = run(1), ek = run(k);
        expect(ek).toBeGreaterThanOrEqual(k * e1 - 1e-6 * Math.abs(k * e1) - 1e-6);
        expect(ek).toBeLessThanOrEqual(k * e1 + (k - 1) + 1e-6 * Math.abs(k * e1) + 1e-6);
      }),
      { numRuns: HEAVY },
    );
    // the award rules are ratios too
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000 }), fc.integer({ min: 1, max: 10_000_000 }), fc.integer({ min: 2, max: 1000 }), (a, b, k) => {
        const rule: AwardRule = { kind: 'federal_hubzone', fullAndOpen: true, priceIsFactor: true };
        const us = { smallBusiness: true }, them = {};
        expect(beats(rule, { price: c(a * k), flags: us }, { price: c(b * k), flags: them })).toBe(beats(rule, { price: c(a), flags: us }, { price: c(b), flags: them }));
      }),
    );
  });

  test('107 uniform benchmark: b(c) >= c, b(1) = 1, markup (1-c)/n strictly decreasing in n, E[lowest bid] = 2/(n+1) (Monte Carlo within 4 SE)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 1, max: 30 }), (cm, n) => {
        const cc = ratio(cm, 1000);
        const u = uniformBenchmark(cc, n), u2 = uniformBenchmark(cc, n + 1);
        expect(rCmp(u.bid, cc)).toBeGreaterThanOrEqual(0);
        expect(rEq(u.markup, rSub(u.bid, cc))).toBe(true);
        if (cm < 1000) expect(rCmp(u2.markup, u.markup)).toBeLessThan(0);
        expect(rEq(u.expectedLowestBid, ratio(2, n + 1))).toBe(true);
      }),
    );
    expect(rEq(uniformBenchmark(ratio(1), 5).bid, ratio(1))).toBe(true);
    for (const n of [2, 3, 5, 8]) {
      const trials = 4_000;
      // uniform [0, 1) by integers (fc.double is uniform over bit patterns, not over values)
      const U = 2 ** 31;
      const draws = fc.sample(fc.noBias(fc.array(fc.integer({ min: 0, max: U - 1 }), { minLength: n, maxLength: n })), { seed: SEED + n, numRuns: trials });
      const lows = draws.map((cs) => {
        const m = Math.min(...cs) / U;
        return (1 + (n - 1) * m) / n;
      });
      const mean = lows.reduce((a, b) => a + b, 0) / trials;
      const sd = Math.sqrt(lows.reduce((a, b) => a + (b - mean) ** 2, 0) / (trials - 1));
      expect(Math.abs(mean - 2 / (n + 1))).toBeLessThan((4 * sd) / Math.sqrt(trials));
    }
  });

  test("108 e_1 = 0, e_2 = 1/sqrt(pi), e_3 = 3/(2 sqrt(pi)), e_N increasing; C_adj >= C (equal when sigma or kappa is 0); throws when kappa sigma e_N >= 1", () => {
    expect(expectedMaxNormal(1)).toBe(0);
    expect(expectedMaxNormal(2)).toBeCloseTo(1 / Math.sqrt(Math.PI), 10);
    expect(expectedMaxNormal(3)).toBeCloseTo(3 / (2 * Math.sqrt(Math.PI)), 10);
    let prev = -1;
    for (let N = 1; N <= 40; N++) {
      const e = expectedMaxNormal(N);
      expect(e).toBeGreaterThan(prev);
      prev = e;
    }
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 0.3, noNaN: true }), fc.integer({ min: 1, max: 10 }), fc.integer({ min: 1, max: 1_000_000_000 }), (kappa, sigma, N, C) => {
        const w = winnersCurse(kappa, sigma, N);
        expect(adjustedCost(c(C), w)).toBeGreaterThanOrEqual(C);
        expect(w.factor).toBeGreaterThanOrEqual(1);
        expect(adjustedCost(c(C), winnersCurse(0, sigma, N))).toBe(C);
        expect(adjustedCost(c(C), winnersCurse(kappa, 0, N))).toBe(C);
      }),
      { numRuns: 200 },
    );
    expect(() => winnersCurse(1, 1 / expectedMaxNormal(5), 5)).toThrow(RangeError);
    expect(() => winnersCurse(1, 2, 8)).toThrow(RangeError);
    expect(() => winnersCurse(1.1, 0.1, 3)).toThrow(RangeError);
  });

  test('109 Wilson: 0 <= lower <= k/J <= upper <= 1; k = 0 upper z^2/(J + z^2); width shrinks with J at fixed k/J. DKW decreasing in J, band clipped', () => {
    const z = zForAlpha(A25_ALPHA);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2000 }), fc.integer({ min: 0, max: 2000 }), (J, kk) => {
        const k = kk % (J + 1);
        const w = wilson(k, J);
        expect(0).toBeLessThanOrEqual(w.lo);
        expect(w.lo).toBeLessThanOrEqual(k / J);
        expect(k / J).toBeLessThanOrEqual(w.hi);
        expect(w.hi).toBeLessThanOrEqual(1);
        if (k === 0) expect(w.hi).toBeCloseTo((z * z) / (J + z * z), 12);
        const w2 = wilson(2 * k, 2 * J);
        expect(w2.hi - w2.lo).toBeLessThan(w.hi - w.lo);
        expect(dkwEpsilon(J + 1)).toBeLessThan(dkwEpsilon(J));
        const band = dkwBand(k / J, J);
        expect(band.lo).toBeGreaterThanOrEqual(0);
        expect(band.hi).toBeLessThanOrEqual(1);
      }),
    );
  });

  test('110 tail-sample rule ceil(ln 0.05 / ln(1 - q)) = 59, 29, 14, 11, 5 for q = 0.05, 0.10, 0.20, 0.25, 0.50', () => {
    expect([0.05, 0.1, 0.2, 0.25, 0.5].map((q) => tailMinimumJ(q))).toEqual([59, 29, 14, 11, 5]);
    expect(tailMinimumJ(0.9)).toBe(29); // min(w, 1 - w)
    expect(() => tailMinimumJ(0)).toThrow(RangeError);
  });

  test('111 preference rules: scale invariant, plain lowest price without preferences, a small business keeps factor 1.00', () => {
    const rules: AwardRule[] = [
      SEALED,
      { kind: 'nv_bidder_preference', estimatedCost: c(30_000_000) },
      { kind: 'nv_veteran_deemed_lower', estimatedCost: c(10_000_000), ownerIsState: true },
      { kind: 'federal_hubzone', fullAndOpen: true, priceIsFactor: true },
    ];
    const arbFlags = fc.record({ nvPreferenceEligible: fc.boolean(), nvQualifyingVeteranLocal: fc.boolean(), smallBusiness: fc.boolean(), hubzoneNotWaived: fc.boolean() });
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000_000 }), fc.integer({ min: 1, max: 100_000_000 }), fc.integer({ min: 2, max: 50 }), arbFlags, arbFlags, (a, b, k, f1, f2) => {
        for (const rule of rules) {
          expect(beats(rule, { price: c(a * k), flags: f1 }, { price: c(b * k), flags: f2 })).toBe(beats(rule, { price: c(a), flags: f1 }, { price: c(b), flags: f2 }));
          if (rule.kind !== 'federal_hubzone') expect(beats(rule, { price: c(a), flags: {} }, { price: c(b), flags: {} })).toBe(a < b);
          expect(rEq(preferenceFactor(rule, { smallBusiness: true, hubzoneNotWaived: f1.hubzoneNotWaived }).factor, ratio(1)) || rule.kind !== 'federal_hubzone').toBe(true);
        }
        // HUBZone without any large business: plain lowest price
        const hz = rules[3] as AwardRule;
        expect(beats(hz, { price: c(a), flags: { smallBusiness: true } }, { price: c(b), flags: { smallBusiness: true } })).toBe(a < b);
      }),
    );
    // thresholds at threshold - 1 cent, the threshold, threshold + 1 cent (D-71: $250,000)
    expect(ruleInForce({ kind: 'nv_bidder_preference', estimatedCost: c(24_999_999) })).toBe(false);
    expect(ruleInForce({ kind: 'nv_bidder_preference', estimatedCost: c(25_000_000) })).toBe(false);
    expect(ruleInForce({ kind: 'nv_bidder_preference', estimatedCost: c(25_000_001) })).toBe(true);
    expect(ruleInForce({ kind: 'nv_veteran_deemed_lower', estimatedCost: c(25_000_000), ownerIsState: true })).toBe(true);
    expect(ruleInForce({ kind: 'nv_veteran_deemed_lower', estimatedCost: c(25_000_001), ownerIsState: true })).toBe(false);
    expect(ruleInForce({ kind: 'nv_veteran_deemed_lower', estimatedCost: c(10_000_000), ownerIsState: false })).toBe(false);
    expect(ruleInForce({ kind: 'federal_hubzone', fullAndOpen: false, priceIsFactor: true })).toBe(false);
    // veteran bid deemed 5% lower; HUBZone adds 10% to a large business
    const vet: AwardRule = { kind: 'nv_veteran_deemed_lower', estimatedCost: c(10_000_000), ownerIsState: true };
    expect(rEq(evaluatedPrice(vet, { nvQualifyingVeteranLocal: true }, c(100_000)).evaluated, ratio(95_000))).toBe(true);
    const hz: AwardRule = { kind: 'federal_hubzone', fullAndOpen: true, priceIsFactor: true };
    expect(rEq(evaluatedPrice(hz, {}, c(100_000)).evaluated, ratio(110_000))).toBe(true);
    expect(beats(hz, { price: c(109_999), flags: { smallBusiness: true } }, { price: c(100_000), flags: {} })).toBe(true);
    expect(beats(hz, { price: c(110_000), flags: { smallBusiness: true } }, { price: c(100_000), flags: {} })).toBe(false);
  });

  test('111 (curves) evaluatedPrice is applied to our bid and every competitor before any probability', () => {
    const rule: AwardRule = { kind: 'nv_bidder_preference', estimatedCost: c(40_000_000) };
    const rows = Array.from({ length: 10 }, (_, i) => letting(1_000_000, 1_000_000, i));
    const plain = ok(pWinEmpirical(history(rows), job(1_000_000, rule, {})));
    const pref = ok(pWinEmpirical(history(rows), job(1_000_000, rule, { nvPreferenceEligible: true })));
    expect(plain.p(c(999_999))).toBe(1);
    expect(plain.p(c(1_000_000))).toBe(0);
    expect(pref.p(c(1_050_000))).toBe(1); // B_pref <= 1.05 B_np wins, tie to the preferred
    expect(pref.p(c(1_050_001))).toBe(0);
  });

  const arbSelection = fc.record({ rows: arbLettings(10, 25), A: fc.integer({ min: 100_000, max: 3_000_000 }), g: arbCosts });

  test('112 range contains B*, never below the floor, widens with delta, NO BID when EV(B*) <= 0; low <= recommended <= high', () => {
    fc.assert(
      fc.property(arbSelection, fc.double({ min: 0, max: 0.5, noNaN: true }), fc.double({ min: 0, max: 0.4, noNaN: true }), ({ rows, A, g }, d1, dd) => {
        const r1 = selectBid(selection(rows, A, g, { delta: d1 }));
        const r2 = selectBid(selection(rows, A, g, { delta: d1 + dd }));
        if (r1.status === 'no_bid') {
          expect(r2.status).toBe('no_bid');
          if (r1.best) expect(r1.best.ev).toBeLessThanOrEqual(0);
          return;
        }
        expect(r1.status).toBe('bid');
        if (r1.status !== 'bid' || r2.status !== 'bid') throw new Error('unexpected');
        expect(r1.recommended.ev).toBeGreaterThan(0);
        expect(r1.low.B).toBeLessThanOrEqual(r1.recommended.B);
        expect(r1.recommended.B).toBeLessThanOrEqual(r1.high.B);
        expect(r1.low.B).toBeGreaterThanOrEqual(r1.floor);
        expect(r1.intervals.some((iv) => iv.lo <= r1.recommended.B && r1.recommended.B <= iv.hi)).toBe(true);
        // every interval of the tighter tolerance sits inside one of the looser one
        for (const iv of r1.intervals) expect(r2.intervals.some((jv) => jv.lo <= iv.lo && iv.hi <= jv.hi)).toBe(true);
        expect(r2.recommended.B).toBe(r1.recommended.B);
        for (const row of r1.rows) expect(row.B).toBeGreaterThanOrEqual(r1.floor);
      }),
      { numRuns: HEAVY },
    );
    // a curve that only wins below cost: NO BID
    const rows = Array.from({ length: 12 }, (_, i) => letting(1_000_000, 900_000 + i, i));
    const r = selectBid(selection(rows, 1_000_000, { TJC: 1_000_000, OH: 0, FIN: 0, K: 5_000, fee: 0, mMin: 0 }));
    expect(r.status).toBe('no_bid');
  });

  test('113 Brier score in [0, 1]; constant base-rate forecast scores pbar(1 - pbar); a perfect forecast scores 0', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(arbP, fc.boolean()), { minLength: 1, maxLength: 60 }), (xs) => {
        const f = xs.map((x) => x[0]), o = xs.map((x) => (x[1] ? 1 : 0) as 0 | 1);
        const b = brier(f, o);
        expect(b.BS).toBeGreaterThanOrEqual(0);
        expect(b.BS).toBeLessThanOrEqual(1);
        const base = brier(o.map(() => b.pbar), o);
        expect(base.BS).toBeCloseTo(b.pbar * (1 - b.pbar), 12);
        expect(brier(o.map((v) => v), o).BS).toBe(0);
        const allSame = o.every((v) => v === o[0]);
        expect(b.skill === null).toBe(allSame);
      }),
    );
  });

  test('114 adequacy thresholds non-decreasing in the number of competitive bids and defined only for 1 to 5', () => {
    const t = [1, 2, 3, 4, 5].map(adequacyThresholdPct);
    for (let i = 1; i < t.length; i++) expect(t[i] as number).toBeGreaterThanOrEqual(t[i - 1] as number);
    expect(() => adequacyThresholdPct(0)).toThrow(RangeError);
    expect(() => adequacyThresholdPct(6)).toThrow(RangeError);
  });

  test('115 r = L/E and pct = (L - E)/E * 100 satisfy r = 1 + pct/100 and r > 0', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), fc.integer({ min: 1, max: 1_000_000_000 }), (L, E) => {
        const { r, pct } = lowBidVsEstimate(c(L), c(E));
        expect(rEq(r, rAdd(ratio(1), rDiv(pct, ratio(100))))).toBe(true);
        expect(rCmp(r, ratio(0))).toBeGreaterThan(0);
      }),
    );
    // P-14 style figure: low bid 629,137.87 against estimate 451,862.80 is +39.23%
    const { pct } = lowBidVsEstimate(c(62_913_787), c(45_186_280));
    expect((Number(pct.num) / Number(pct.den)).toFixed(2)).toBe('39.23');
    expect(rEq(rMul(ratio(1), ratio(1)), ratio(1))).toBe(true);
  });
});

// ================================================================ L5 differential test (brute force, no shared code)

describe('L5 differential: exact candidate search = brute force on small cases', () => {
  // Independent reference: win count by BigInt cross-multiplication, q = half-up(f * B / 10^6), floor by
  // linear scan, EV at every cent, near-optimal set at every cent.
  const refQ = (B: number, f: number) => Number((2n * BigInt(f) * BigInt(B) + 1_000_000n) / 2_000_000n);
  test('step curve (empirical): B*, EV(B*) and the whole near-optimal set match brute force exactly', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ a: fc.integer({ min: 200, max: 900 }), r: fc.integer({ min: 700, max: 1_600 }) }), { minLength: 10, maxLength: 16 }),
        fc.integer({ min: 200, max: 900 }),
        fc.record({ TJC: fc.integer({ min: 100, max: 600 }), OH: fc.integer({ min: 0, max: 100 }), FIN: fc.integer({ min: 0, max: 30 }), K: fc.integer({ min: 0, max: 40 }), fee: fc.integer({ min: 0, max: 60_000 }), mMin: fc.integer({ min: 0, max: 80_000 }) }),
        fc.double({ min: 0, max: 0.3, noNaN: true }),
        (raw, A, g, delta) => {
          const rows = raw.map((x, i) => letting(x.a, Math.max(1, Math.floor((x.a * x.r) / 1000)), i));
          const inp: BidSelectionInput = { costs: { TJC: c(g.TJC), OH: c(g.OH), FIN: c(g.FIN), K: c(g.K) }, charges: feeCharges(g.fee), minMarkupPpm: pp(g.mMin), curve: pWinEmpirical(history(rows), job(A)), delta };
          const r = selectBid(inp);
          // reference
          const BE = g.TJC + g.OH;
          const S = BE + Number((2n * BigInt(BE) * BigInt(g.mMin) + 1_000_000n) / 2_000_000n) + g.FIN;
          let floor = S;
          while (floor - refQ(floor, g.fee) < S) floor++;
          const J = rows.length;
          const wins = (B: number) => rows.filter((l) => BigInt(l.lowestCompeting) * BigInt(A) > BigInt(B) * BigInt(l.anchor)).length;
          const top = Math.max(...rows.map((l) => Math.ceil((l.lowestCompeting * A) / l.anchor))) + 2;
          const ev = (B: number) => (B - refQ(B, g.fee) - (g.TJC + g.OH + g.FIN)) * (wins(B) / J) - g.K;
          let bB = floor, bV = -Infinity;
          for (let B = floor; B <= Math.max(floor, top); B++) {
            const v = ev(B);
            if (v > bV) {
              bV = v;
              bB = B;
            }
          }
          if (!(bV > 0)) {
            expect(r.status).toBe('no_bid');
            return;
          }
          expect(r.status).toBe('bid');
          if (r.status !== 'bid') return;
          expect(r.floor).toBe(floor);
          expect(r.recommended.B).toBe(bB);
          expect(r.recommended.ev).toBe(bV);
          const T = (1 - delta) * bV;
          const set: number[] = [];
          for (let B = floor; B <= Math.max(floor, top); B++) if (ev(B) >= T) set.push(B);
          const fromEngine: number[] = [];
          for (const iv of r.intervals) for (let B = iv.lo; B <= iv.hi; B++) fromEngine.push(B);
          expect(fromEngine).toEqual(set);
        },
      ),
      { numRuns: 300 },
    );
  });

  test('smooth curve (kernel): bounded search equals an exhaustive scan when the window is small', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 850, max: 1_250 }), { minLength: 10, maxLength: 20 }), fc.integer({ min: 400, max: 1_000 }), fc.integer({ min: 0, max: 30 }), (rs, A, K) => {
        const rows = rs.map((r, i) => letting(1_000, r, i));
        const curve = pWinKernel(history(rows), job(A));
        const cv = ok(curve);
        const TJC = Math.floor(A * 0.85);
        const r = selectBid({ costs: { TJC: c(TJC), OH: c(0), FIN: c(0), K: c(K) }, charges: noCharges, minMarkupPpm: pp(0), curve });
        const hi = cv.supportHi as number;
        let bB = TJC, bV = -Infinity;
        for (let B = TJC; B <= hi; B++) {
          const v = (B - TJC) * cv.p(c(B)) - K;
          if (v > bV) {
            bV = v;
            bB = B;
          }
        }
        if (hi - TJC > 4096) return; // only small windows are exhaustive by design
        if (!(bV > 0)) {
          expect(r.status).toBe('no_bid');
          return;
        }
        expect(r.status === 'bid' && r.recommended.B).toBe(bB);
      }),
      { numRuns: 200 },
    );
  });
});

// ================================================================ refusals, presentation, data rules

describe('7.10 presentation and refusals', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => letting(1_000_000, 950_000 + i * 20_000, i));

  test('below J = 10: every model refuses with a reason (A-25), and selectBid passes the refusal on', () => {
    const H = history(rows(9));
    for (const r of [pWinEmpirical(H, job(1_000_000)), pWinKernel(H, job(1_000_000))]) {
      expect(r.status).toBe('not_enough_data');
      if (r.status === 'not_enough_data') {
        expect(r.J).toBe(9);
        expect(r.minJ).toBe(A25_MIN_J);
        expect(r.reason).toMatch(/not enough data/);
        expect(presentWinProbability(r).kind).toBe('not_enough_data');
      }
    }
    const rival = pWinRivals('gates', {
      rivals: { kind: 'named', rivals: [{ rivalId: 'a', bids: rows(9).map((l, i) => ({ jobId: `${i}`, rivalBid: l.lowestCompeting, ourEstimate: l.anchor, provenance: PUB })) }] },
      referenceClass: 'rivals',
      requestingTenantId: 'tenant-a',
      ourEstimate: c(1_000_000),
      rule: SEALED,
      ourFlags: {},
    });
    expect(rival.status).toBe('not_enough_data');
    const sel = selectBid({ costs: { TJC: c(900_000), OH: c(0), FIN: c(0), K: c(0) }, charges: noCharges, minMarkupPpm: pp(0), curve: pWinEmpirical(H, job(1_000_000)) });
    expect(sel.status).toBe('not_enough_data');
    expect(() => expectedProfitCurve({ costs: { TJC: c(900_000), OH: c(0), FIN: c(0), K: c(0) }, charges: noCharges, minMarkupPpm: pp(0), curve: pWinEmpirical(H, job(1_000_000)) }, [c(1)])).toThrow(RangeError);
  });

  test('estimates carry J, reference class, model and a Wilson range in whole percents; tails need their J (10% needs 29)', () => {
    const cv = ok(pWinEmpirical(history(rows(10)), job(1_000_000)));
    const e = cv.estimate(c(1_090_000)); // wins against 4 of 10? count exact below
    expect(e.J).toBe(10);
    expect(e.model).toBe('empirical');
    expect(e.referenceClass).toMatch(/NV electrical/);
    const d = presentWinProbability(e);
    expect(d.kind).toBe('estimate');
    if (d.kind === 'estimate') {
      expect(Number.isInteger(d.lowPct) && Number.isInteger(d.highPct)).toBe(true);
      expect(d.text).toMatch(/10 comparable lettings/);
    }
    // 1 win of 10 is a 10% tail: no point estimate below J = 29
    const tail = presentWinProbability(cv.estimate(c(1_120_000)));
    expect(cv.p(c(1_120_000))).toBe(0.1);
    expect(tail.kind === 'estimate' && tail.midPct).toBe(null);
    const zero = presentWinProbability(cv.estimate(c(5_000_000)));
    expect(zero.kind === 'estimate' && zero.notes.join(' ')).toMatch(/0 wins in 10/);
    // assumed curves are never shown as an estimate
    const as = ok(assumedRivalCurve('friedman', { kind: 'exponential', lambda: 10 }, { n: 2 }, c(1_000_000), 'what-if'));
    expect(presentWinProbability(as.estimate(c(1_050_000))).kind).toBe('assumed');
    const pair = presentModelPair(as.estimate(c(1_050_000)), as.estimate(c(1_050_000)));
    expect(pair.note).toMatch(/not a confidence range/);
  });

  test('7.10 rule 5: another customer\'s private records are refused; own private records are allowed', () => {
    const mine: LettingRecord = { ...letting(1_000_000, 1_050_000, 1), provenance: { kind: 'private', tenantId: 'tenant-a' } };
    const theirs: LettingRecord = { ...letting(1_000_000, 1_050_000, 2), provenance: { kind: 'private', tenantId: 'tenant-b' } };
    expect(pWinEmpirical(history([...rows(10), mine]), job(1_000_000)).status).toBe('ok');
    expect(() => pWinEmpirical(history([...rows(10), theirs]), job(1_000_000))).toThrow(/FOREIGN_PRIVATE_DATA/);
    expect(() => pWinEmpirical(history([...rows(9), { ...letting(1, 1), anchorKind: 'own_cost_estimate' }]), job(1_000_000))).toThrow(/MIXED_ANCHORS/);
  });

  test('7.2 competitor counts: NRS 338.13862 bands at the thresholds; federal offers minus 1; g(k) refused below J = 10', () => {
    expect(nvSmallWorksSolicitation(c(2_499_999)).minimumSolicited).toBe(1);
    expect(nvSmallWorksSolicitation(c(2_500_000)).minimumSolicited).toBe(1);
    expect(nvSmallWorksSolicitation(c(2_500_001)).minimumSolicited).toBe(3);
    expect(nvSmallWorksSolicitation(c(10_000_000)).minimumSolicited).toBe(3);
    expect(nvSmallWorksSolicitation(c(10_000_001)).advertised).toBe(true);
    expect(federalCompetitors(4)).toBe(3);
    expect(federalCompetitors(null)).toBe(null);
    expect(competitorCountDistribution([1, 2, 3], 'ref').status).toBe('not_enough_data');
    const g = competitorCountDistribution([0, 2, 2, 3, 3, 3, 4, 2, 3, 3], 'ref');
    expect(g.status).toBe('ok');
    if (g.status === 'ok') {
      expect(g.g.reduce((a, x) => a + x.p, 0)).toBeCloseTo(1, 12);
      // k = 0 term included: g(0) = 0.1 wins outright
      expect(friedmanMixture(0, g.g)).toBeCloseTo(0.1, 12);
    }
  });

  test('calibration shrinkage toward 1/(n+1) is a stated design choice with an explicit prior strength', () => {
    expect(shrinkTowardSymmetric(0, 0, 3, 4)).toBe(0.25);
    expect(shrinkTowardSymmetric(3, 10, 3, 0)).toBe(0.3);
    expect(shrinkTowardSymmetric(3, 10, 3, 10)).toBeCloseTo((3 + 2.5) / 20, 12);
  });

  test('selection: floor never undercut, limits caps veto, unbounded curves need a bound, labelled assumptions', () => {
    const H = history(rows(12));
    const base: BidSelectionInput = { costs: { TJC: c(800_000), OH: c(100_000), FIN: c(5_000), K: c(2_000) }, charges: feeCharges(10_000), minMarkupPpm: pp(20_000), curve: pWinEmpirical(H, job(1_000_000)) };
    const r = selectBid(base);
    expect(r.status).toBe('bid');
    if (r.status === 'bid') {
      expect(r.floor).toBe(bidFloor(base.costs, base.charges, base.minMarkupPpm));
      expect(r.assumptions.map((a) => a.id).sort()).toEqual(['A-23', 'A-24', 'A-25']);
      expect(r.delta).toBe(A24_DELTA);
      expect(r.J).toBe(12);
      for (const row of r.rows) expect(row.win.J).toBe(12);
      // a cap below the recommended price moves the recommendation under it
      const capped = selectBid({ ...base, limits: { caps: [{ cap: c(r.recommended.B - 1), reason: 'surety letter single-job limit' }] } });
      expect(capped.status === 'bid' ? capped.recommended.B : 0).toBeLessThan(r.recommended.B);
      const blocked = selectBid({ ...base, limits: { caps: [{ cap: c(r.floor - 1), reason: 'job size rule' }] } });
      expect(blocked.status).toBe('no_bid');
      const vetoAll = selectBid({ ...base, limits: { check: () => ({ ok: false, reason: 'peak float short' }) } });
      expect(vetoAll.status).toBe('no_bid');
    }
    const mix = pWinRivals('friedman', {
      rivals: { kind: 'mixture', pooled: rows(10).map((l, i) => ({ jobId: `${i}`, rivalBid: l.lowestCompeting, ourEstimate: l.anchor, provenance: PUB })), g: [{ k: 0, p: 0.2 }, { k: 2, p: 0.8 }] },
      referenceClass: 'rivals',
      requestingTenantId: 'tenant-a',
      ourEstimate: c(1_000_000),
      rule: SEALED,
      ourFlags: {},
    });
    expect(() => selectBid({ ...base, curve: mix })).toThrow(/NO_SEARCH_BOUND/);
    expect(selectBid({ ...base, curve: mix, searchHi: c(3_000_000) }).status).toBe('bid');
    // winner's curse must not double count on calibrated data
    expect(() => selectBid({ ...base, curse: winnersCurse(1, 0.08, 5), calibratedOnRealizedCosts: true })).toThrow(/DOUBLE_COUNTING/);
  });

  test('normalCdf is monotone on a dense grid and matches known values', () => {
    let prev = 0;
    for (let i = -40_000; i <= 40_000; i++) {
      const v = normalCdf(i / 4_000);
      expect(v >= prev).toBe(true);
      prev = v;
    }
    expect(normalCdf(0)).toBe(0.5);
    expect(normalCdf(-5)).toBeCloseTo(2.866515718791939e-7, 20);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 14);
  });
});

// ================================================================ section 11 golden examples named by id

describe('11 golden examples (bidding)', () => {
  const dec = (r: { num: bigint; den: bigint }, d: number) => (Number(r.num) / Number(r.den)).toFixed(d);
  test('I-26 Nevada preference: non-preferred low 300,000; preferred 314,000 wins (limit 315,000), 316,000 does not', () => {
    const rule: AwardRule = { kind: 'nv_bidder_preference', estimatedCost: c(300_000_00) };
    const pref = { nvPreferenceEligible: true };
    expect(beats(rule, { price: c(314_000_00), flags: pref }, { price: c(300_000_00), flags: {} })).toBe(true);
    expect(beats(rule, { price: c(315_000_00), flags: pref }, { price: c(300_000_00), flags: {} })).toBe(true);
    expect(beats(rule, { price: c(316_000_00), flags: pref }, { price: c(300_000_00), flags: {} })).toBe(false);
  });
  test('I-27 uniform benchmark: E[lowest] 0.6667, 0.5000, 0.3333, 0.2222 for n = 2, 3, 5, 8; cost 0.40 bids 0.70, 0.60, 0.52', () => {
    expect([2, 3, 5, 8].map((n) => dec(uniformBenchmark(ratio(0n), n).expectedLowestBid, 4))).toEqual(['0.6667', '0.5000', '0.3333', '0.2222']);
    expect([2, 3, 5].map((n) => uniformBenchmark(ratio(2n, 5n), n).bid)).toEqual([ratio(7n, 10n), ratio(3n, 5n), ratio(13n, 25n)].map((r) => expect.objectContaining({ num: r.num, den: r.den })));
  });
  test('P-14 low bid against estimate: 1,578,986.55 vs 1,919,815.94 is -340,829.39 = -17.75%; 629,137.87 vs 451,862.80 is +39.23%', () => {
    const a = lowBidVsEstimate(c(157_898_655), c(191_981_594));
    expect(157_898_655 - 191_981_594).toBe(-34_082_939);
    expect(dec(a.pct, 2)).toBe('-17.75');
    expect(dec(lowBidVsEstimate(c(62_913_787), c(45_186_280)).pct, 2)).toBe('39.23');
  });
});
