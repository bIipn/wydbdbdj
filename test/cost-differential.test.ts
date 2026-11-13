// Spec 10.0 layer L5 (invariant 20): the engine against an independent, slow, exact reference
// (test/cost-oracle/, written from the spec alone, BigInt fractions, rounding only at the spec's rounding
// points). Inputs come from the seeded synthetic generator (src/cost/synthetic.ts) and from fast-check with a
// pinned seed. Every disagreement is collected with its spec section; the expected count is 0 unless a test
// is marked `test.fails` with the spec section that the engine gets wrong.
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  allocate,
  buildBid,
  divRoundHalfUp,
  durationMultiplierPpm,
  extend,
  grossUp,
  mulHours,
  mulRate,
  priceBasedCharge,
  type BidBreakdown,
  type BidInput,
  type BondTier,
  type Cents,
  type HoursC,
  type Ppm,
  type PriceChargesInput,
  type QtyM,
} from '../src/cost/index.js';
import { bidSecurity, sbaFee, type BidSecurityRule, type SbaFeeTable } from '../src/cost/bonds.js';
import { federalLatePaymentInterest, retainageFinancingCost, retainageSchedule, simpleInterest, type RetainageRule } from '../src/cost/payment.js';
import { cashLedger, closedFormPeak, financingCost, peakFloat, type CashJobInput } from '../src/cost/cash.js';
import {
  escalateForward,
  escalateLine,
  factorTableFromRates,
  indexRatio,
  interpolateFactor,
  normalizeSeries,
  quoteEscalation,
  type IndexSeriesInput,
} from '../src/cost/escalation.js';
import { pWinEmpirical, type LettingRecord } from '../src/cost/winprob.js';
import { selectBid } from '../src/cost/bidding.js';
import { cashJobFor, D38_CLASS_B, RETAINAGE, simCompany, simJob, type CostParts, type SimCompany, type SimJob } from '../src/cost/synthetic.js';
import { allocateOracle, grossUpQ, grossUpScan, mDurPpmQ, oracleBid, qOf, type OracleBid } from './cost-oracle/buildup.js';
import { bidSecurityQ, federalLateQ, retainageFinancingQ, retainageQ, sbaFeeQ, simpleInterestQ } from './cost-oracle/bonds.js';
import { cashOracle, closedFormOracle, financingOracle } from './cost-oracle/cash.js';
import { ePpmQ, escalateForwardQ, escalateLineQ, factorTableQ, interpolateQ, type Obs } from './cost-oracle/escalation.js';
import { bruteForceBid } from './cost-oracle/bidding.js';
import { cmp, q, toNum, roundHalfUp, type Q } from './cost-oracle/rational.js';

const SEED = 20261113; // spec 10.0: pinned seed
const RUNS = 1_000; // spec 10.0: 1,000 runs per property on pull requests
const SYNTH_PAIRS = 3_000; // synthetic company-and-job pairs in the chain differential
const c = (n: number) => n as Cents;
const p = (n: number) => n as Ppm;

interface Disagreement {
  section: string;
  caseId: string;
  field: string;
  engine: unknown;
  oracle: unknown;
}

// ---------------------------------------------------------------- the whole chain (spec 2, 3, 2.13, 5.6)

function engineParts(b: BidBreakdown): CostParts {
  const t = b.totals;
  return { L: t.L, MAT: t.MAT, E: t.E, SUB: t.SUB, other: t.ST + t.JOOH + t.ESC_L + t.CONT, q: 0 };
}
function oracleParts(o: OracleBid): CostParts {
  return { L: o.L, MAT: o.MAT, E: o.E, SUB: o.SUB, other: o.ST + o.JOOH + o.ESC_L + o.CONT, q: 0 };
}

interface ChainCase {
  co: SimCompany;
  job: SimJob;
  input: BidInput;
  financed: boolean;
}

/** Engine and oracle on one generated pair; returns every line that differs. */
function diffChain(cc: ChainCase): { diffs: Disagreement[]; e?: BidBreakdown; o?: OracleBid; refused?: string } {
  const { co, job } = cc;
  const id = job.id;
  const out: Disagreement[] = [];
  let e: BidBreakdown | undefined, o: OracleBid | undefined, eErr: unknown, oErr: unknown;
  // engine
  try {
    let inp = cc.input;
    if (cc.financed) {
      const base = buildBid({ ...inp, financing: { include: false } });
      const parts = engineParts(base);
      inp = {
        ...inp,
        financing: {
          include: true,
          compute: (S0, P0) => financingCost(cashLedger(cashJobFor(job, { ...parts, q: P0 - S0 }, P0)), p(co.creditRatePpm), 365).FIN,
        },
      };
    }
    e = buildBid(inp);
  } catch (err) {
    eErr = err;
  }
  // oracle (its own cash model for FIN)
  let oFin: number | undefined;
  try {
    let opt = {};
    if (cc.financed) {
      const base = oracleBid({ ...cc.input, financing: { include: false } });
      const parts = oracleParts(base);
      opt = {
        finCompute: (S0: number, P0: number) => {
          const led = cashOracle(cashJobFor(job, { ...parts, q: P0 - S0 }, P0));
          oFin = financingOracle(led, 7, co.creditRatePpm, 365).FIN;
          return oFin;
        },
      };
      // FIN differs only through cash-ledger cent allocation (spec 5 states no rounding for it); when it does,
      // the rest of the chain is compared at the engine's FIN, so every other line is still checked exactly.
      o = oracleBid({ ...cc.input, financing: { include: true, compute: () => 0 as Cents } }, opt);
      if (e && o.FIN !== e.totals.FIN) {
        if (Math.abs(o.FIN - e.totals.FIN) > 1) out.push({ section: '5.6', caseId: id, field: 'FIN', engine: e.totals.FIN, oracle: o.FIN });
        else out.push({ section: '5.6 (1-cent cash allocation tolerance)', caseId: id, field: 'FIN~', engine: e.totals.FIN, oracle: o.FIN });
        o = oracleBid({ ...cc.input, financing: { include: true, amount: e.totals.FIN } });
      }
    } else o = oracleBid(cc.input, opt);
  } catch (err) {
    oErr = err;
  }
  if (eErr || oErr) {
    if (!eErr || !oErr) out.push({ section: 'refusal', caseId: id, field: 'throws', engine: String(eErr ?? 'ok'), oracle: String(oErr ?? 'ok') });
    else if (!(eErr instanceof RangeError)) out.push({ section: '0.1', caseId: id, field: 'error type', engine: String(eErr), oracle: String(oErr) });
    return { diffs: out, refused: String(oErr) };
  }
  const E = e!, O = o!;
  const cmpField = (section: string, field: string, ev: number, ov: number) => {
    if (ev !== ov) out.push({ section, caseId: id, field, engine: ev, oracle: ov });
  };
  E.labor.classes.forEach((k, i) => {
    const ok = O.classes[i]!;
    cmpField('2.2', `${k.id}.G`, k.wages.G, ok.G);
    cmpField('2.2', `${k.id}.OTprem`, k.wages.otPremium, ok.OTprem);
    cmpField('2.2', `${k.id}.H`, k.wages.H, ok.H);
    for (const f of ['SS', 'MED', 'FUTA', 'SUTA', 'MBT', 'FLAT', 'WC', 'GLp', 'FR', 'TR', 'OTH', 'L'] as const) cmpField(f === 'L' ? '2.4' : '2.3', `${k.id}.${f}`, k[f], ok[f]);
  });
  E.materials.lines.forEach((l, i) => {
    cmpField('2.6', `mat${i}.ext`, l.ext, O.ext[i]!);
    cmpField('2.6', `mat${i}.esc`, l.esc, O.esc[i]!);
  });
  const m = E.materials;
  cmpField('2.6', 'M', m.M, O.M);
  cmpField('2.6', 'ESC_M', m.ESC_M, O.ESC_M);
  cmpField('2.6', 'TB', m.TB, O.TB);
  cmpField('2.6', 'TAX', m.TAX, O.TAX);
  const t = E.totals;
  for (const f of ['L', 'G', 'H', 'ST', 'MAT', 'E', 'SUB', 'JOOH', 'ESC_L', 'DC0', 'CONT', 'TJC', 'OH', 'BE', 'PR', 'FIN', 'S', 'q', 'premium', 'otherCharges', 'P', 'Pbid', 'roundingDelta'] as const)
    cmpField(['P', 'q', 'premium', 'otherCharges'].includes(f) ? '2.13' : ['Pbid', 'roundingDelta'].includes(f) ? '2.14' : '2.10-2.12', f, t[f], O[f]);
  if (E.bondApplied !== O.bondApplied) out.push({ section: '2.13 auto bond', caseId: id, field: 'bondApplied', engine: E.bondApplied, oracle: O.bondApplied });
  // 2.14: the spec adds the whole rounding difference to profit; the engine splits it between profit and the
  // charges recomputed at P_bid (core specIssue). Both must add up to P_bid - P, and P_bid itself must agree.
  if (t.roundingToProfit + t.roundingToCharges !== O.roundingDelta)
    out.push({ section: '2.14', caseId: id, field: 'roundingToProfit+roundingToCharges', engine: t.roundingToProfit + t.roundingToCharges, oracle: O.roundingDelta });
  if (t.qBid !== O.qAtPbid) out.push({ section: '2.14 (q at P_bid)', caseId: id, field: 'qBid', engine: t.qBid, oracle: O.qAtPbid });
  if (E.items && O.items)
    E.items.items.forEach((it, i) => {
      cmpField('2.15', `item${i}.indirect`, it.indirect, O.items![i]!.indirect);
      cmpField('2.15', `item${i}.price`, it.price, O.items![i]!.price);
    });
  else if (!!E.items !== !!O.items) out.push({ section: '2.15', caseId: id, field: 'items present', engine: !!E.items, oracle: !!O.items });
  return { diffs: out, e: E, o: O };
}

function chainCase(seed: number, idx: number): ChainCase {
  const co = simCompany(seed, idx);
  const job = simJob(seed, co, idx % 3);
  const financed = ((seed ^ idx) & 1) === 1;
  return { co, job, input: job.bid, financed };
}

/** With bid items: direct costs split from the oracle's TJC (they need not sum to TJC; spec 2.15 only needs <= P_bid). */
function withItems(cc: ChainCase, seed: number): ChainCase {
  const o = oracleBid(cc.input);
  const g = new (class {
    s = seed >>> 0;
    n() {
      this.s = (Math.imul(this.s ^ (this.s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
      return this.s;
    }
  })();
  const k = 1 + (g.n() % 4);
  const w = Array.from({ length: k }, () => BigInt(1 + (g.n() % 1000)));
  const dc = allocateOracle(BigInt(o.TJC), w);
  return { ...cc, input: { ...cc.input, bidItems: dc.map((d, i) => ({ id: `item${i + 1}`, directCost: c(Number(d)) })) } };
}

const isHard = (d: Disagreement) => !d.section.includes('tolerance');
const allDiffs: Disagreement[] = [];
const summarize = (ds: readonly Disagreement[]) => {
  const by = new Map<string, number>();
  for (const d of ds) by.set(`${d.section} ${d.field.replace(/^(journeyman|apprentice|foreman|mat\d+|item\d+)\./, '*.')}`, (by.get(`${d.section} ${d.field.replace(/^(journeyman|apprentice|foreman|mat\d+|item\d+)\./, '*.')}`) ?? 0) + 1);
  return [...by.entries()].sort().map(([k, v]) => `${k}: ${v}`);
};

describe('oracle self-check against golden examples (the oracle is not trusted until it reproduces them)', () => {
  test('I-1 end to end (spec 11.2) and I-15 cash float (spec 11.4) and I-18 forward', () => {
    const nv: any = simJob(1, simCompany(1, 0), 0).bid.labor.payrollTables![2026];
    const cls = (o: any) => ({ h10: 0, h15: 0, h20: 0, wBasic: 1, wCil: 0, fPlan: 0, fHealth: 0, travelPerHour: 0, otherPerHour: 0, taxYear: 2026, wcRatePpm: 0, ...o });
    const i1: any = {
      labor: {
        regime: 'NV_PRIVATE', stateOfWork: 'NV', burdenMode: 'statutory',
        classes: [cls({ id: 'j', h10: 16000, h15: 800, wBasic: 4500, fPlan: 400, fHealth: 400, annualTaxableWages: 9000000, wcRatePpm: 25000 }), cls({ id: 'a', h10: 12000, wBasic: 2400, fPlan: 400, fHealth: 400, annualTaxableWages: 4800000, wcRatePpm: 25000 })],
        payrollTables: { 2026: nv }, stateUiRatePpm: 29500, mbt: { mode: 'marginal', quarterlyGrossWages: 12000000, quarterlyHealthDeduction: 1000000 },
        workersComp: { xModPpm: 1e6, otherModsPpm: 1e6, excludeOtPremium: false, payrollCap: 9843360 },
      },
      smallToolsPpm: 20000,
      materials: { lines: [{ id: 'wire', quantity: 2400000, unitPrice: 185, wastePpm: 50000, escalationPpm: 9759 }, { id: 'conduit', quantity: 600000, unitPrice: 340, wastePpm: 30000 }, { id: 'gear', quantity: 1000, unitPrice: 680000, wastePpm: 0 }, { id: 'fixtures', quantity: 24000, unitPrice: 18500, wastePpm: 0 }], freight: 35000, freightTaxable: false, salesTaxPpm: 71000 },
      equipment: [{ id: 'lift', kind: 'lump', amount: 65000 }], subcontracts: [{ id: 't', amount: 320000 }],
      jobOverhead: [{ id: 'permit', kind: 'once', amount: 42000 }, { id: 'sup', kind: 'hours', hours: 1200, rate: 6500 }, { id: 'mob', kind: 'once', amount: 30000 }, { id: 'cl', kind: 'once', amount: 15000 }],
      contingencyPpm: 0, overhead: { method: 'on_cost', rate: { ppm: 150000, base: 'on_cost' } }, profit: { rate: { ppm: 100000, base: 'on_cost' } }, financing: { include: false },
      charges: { tiers: [], mDurPpm: 1e6, fees: [{ label: 'gl', rate: { ppm: 6000, base: 'on_price' } }] },
    };
    const o = oracleBid(i1);
    expect(o.classes.map((k) => [k.G, k.SS, k.MED, k.FUTA, k.SUTA, k.MBT, k.WC, k.FR, k.L])).toEqual([
      [774000, 47988, 11223, 361, 11275, 8270, 19350, 67200, 939667],
      [288000, 17856, 4176, 252, 7866, 2808, 7200, 48000, 376158],
    ]);
    expect([o.L, o.ST, o.M, o.ESC_M, o.TAX, o.MAT, o.TJC, o.OH, o.BE, o.PR, o.S, o.q, o.P]).toEqual([1315825, 26317, 1800320, 4550, 128146, 1968016, 3860158, 579024, 4439182, 443918, 4883100, 29475, 4912575]);
    const i15: any = {
      periodDays: 7, workPeriods: 8, price: 4500000, billingPeriods: 4, ownerLagPeriods: 4, retainageReleasePeriods: 8,
      retainage: { rho1Ppm: 50000, thetaPpm: null, rho2Ppm: 50000, kappaPpm: null, dollarCap: null, halfRelease: false },
      categories: [{ id: 'other', kind: 'pre_start', amount: 200000, weights: [1], lagPeriods: 0 }, { id: 'labor', kind: 'labor', amount: 1600000, weights: [0, 1, 1, 1, 1, 1, 1, 1, 1], lagPeriods: 1 }, { id: 'material', kind: 'material', amount: 1800000, weights: [0, 1, 0, 0, 0, 1, 0, 0, 0], lagPeriods: 4, deposit: { sharePpm: 250000, period: 0 } }],
    };
    const co = cashOracle(i15);
    expect([toNum(co.F), co.tStar, toNum(co.Frf)]).toEqual([2725000, 8, 2525000]);
    const f = financingOracle(co, 7, 90000, 360);
    expect([f.FIN, toNum(f.simple), Math.round(toNum(f.finalCash))]).toEqual([28110, 27868.75, 871890]);
    expect([escalateForwardQ(6306492, 20000, 11), escalateForwardQ(6306492, 50000, 11), escalateForwardQ(6306492, 100000, 11)]).toEqual([6422015, 6594948, 6882261]);
    expect(ePpmQ({ quotedOn: '2026-01-10', purchaseDate: '2026-03-10', rFwdPpm: 60000 }).ePpm).toBe(9759);
    // I-16 closed form (spec 11.3)
    expect(toNum(closedFormOracle(q(3600000), q(4500000), 12, 4, 2, 50000))).toBe(1800000);
    expect(toNum(closedFormOracle(q(3600000), q(3780000), 12, 4, 2, 100000))).toBe(1866000);
    expect(toNum(closedFormOracle(q(3600000), q(4500000), 8, 4, 4, 50000))).toBe(3600000);
    // I-12 Nevada base case retainage
    const base = retainageQ({ rho1Ppm: 50000, thetaPpm: 500000, rho2Ppm: 25000, kappaPpm: null, dollarCap: null, halfRelease: true }, 24000000, Array(6).fill(4000000));
    expect(base.rows.map((r) => r.W)).toEqual([200000, 200000, 200000, 100000, 100000, 100000]);
    expect([base.rows[3]!.Rel, base.held]).toEqual([300000, 600000]);
    // I-2 bonded gross-up, I-5 search window, P-5
    const ch = (tiers: readonly BondTier[], mdur = 1e6, fees: number[] = []): PriceChargesInput => ({ tiers, mDurPpm: p(mdur), fees: fees.map((f) => ({ label: 'f', rate: { ppm: p(f), base: 'on_price' as const } })) });
    expect(Number(grossUpQ(18_000_000n, ch(D38_CLASS_B)))).toBe(18_375_635);
    expect(Number(grossUpQ(18_000_000n, ch(D38_CLASS_B, 1e6, [6000])))).toBe(18_488_253);
    expect(Number(grossUpQ(100_000n, ch([], 1e6, [600_000])))).toBe(249_999);
    expect(Number(qOf(250_000_000n, ch(D38_CLASS_B.map((t) => t), 1_080_000)))).toBe(3_078_000);
  });
});

describe('20: whole-chain differential, engine vs independent exact reference (spec 2, 2.13, 2.14, 2.15, 5.6)', () => {
  test(`20 synthetic generator: ${SYNTH_PAIRS} company-and-job pairs agree to the cent on every line`, () => {
    const diffs: Disagreement[] = [];
    let priced = 0, refused = 0, financed = 0, items = 0;
    for (let i = 0; i < SYNTH_PAIRS; i++) {
      let cc = chainCase(SEED, i);
      if (i % 5 === 0) {
        try {
          cc = withItems(cc, SEED + i);
          items++;
        } catch {
          /* oracle refused the base input: the diff below records the refusal on both sides */
        }
      }
      const r = diffChain(cc);
      if (r.refused) refused++;
      else priced++;
      if (cc.financed) financed++;
      diffs.push(...r.diffs);
    }
    allDiffs.push(...diffs);
    const hard = diffs.filter(isHard);
    if (hard.length) console.log('chain disagreements:', summarize(hard), hard.slice(0, 5));
    console.log(`chain: ${priced} priced, ${refused} refused by both, ${financed} with FIN, ${items} with bid items; FIN within 1-cent tolerance: ${diffs.filter((d) => d.section.includes('tolerance')).length}`);
    expect(priced).toBeGreaterThan(SYNTH_PAIRS * 0.9);
    expect(hard).toEqual([]);
  });

  test('20 fast-check over generator seeds (pinned seed, 1,000 runs)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.integer({ min: 0, max: 9_999 }), (s, i) => {
        const r = diffChain(chainCase(s, i));
        const hard = r.diffs.filter(isHard);
        if (hard.length) throw new Error(JSON.stringify(hard.slice(0, 3)));
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  // Regression, fixed (spec 2.13 last bullet + 4.2, D-36). Case SIM-1551-J03 (seed 20261113, index 1550), a
  // California local job, financed: S without FIN = 24,754.14, its no-bond price 24,935.92 (no payment bond
  // at <= $25,000). FIN = 166.51 lifts S to 24,920.65 and the no-bond price to 25,103.66 > $25,000, so the
  // payment bond is required and P must be grossed up with the bond tiers: 25,752.19 (oracle). The engine keeps
  // used to keep the pre-FIN decision and return 25,103.66 with no bond premium: 648.53 short.
  test('61 2.13 + 4.2: FIN pushes the price over the California bond trigger; the engine applies the bond (SIM-1551-J03)', () => {
    const cc = chainCase(SEED, 1550);
    expect(cc.job.id).toBe('SIM-1551-J03');
    const r = diffChain(cc);
    expect(r.e!.bondApplied).toBe(true);
    expect(r.o!.bondApplied).toBe(true);
    expect(r.e!.totals.P).toBe(r.o!.P);
    expect(r.diffs.filter(isHard)).toEqual([]);
  });

  test('spec 0.2 vs 2.3: the literal capped-tax form (effRate ppm, then mulRate) disagrees with golden I-6, the exact form does not', () => {
    // I-6: W = $90,000, FUTA 0.6% on the first $7,000: golden $42.00. effRate = round(6000*7000/90000) = 467 ppm -> $42.03.
    const literal = mulRate(c(9_000_000), p(Number(divRoundHalfUp(6_000n * 700_000n, 9_000_000n))));
    expect(literal).toBe(4203);
    expect(Number(roundHalfUp(q(9_000_000n * 6_000n * 700_000n, 1_000_000n * 9_000_000n)))).toBe(4200);
    // how often the two readings differ over the synthetic population (reported, not asserted)
    let n = 0, differ = 0;
    for (let i = 0; i < 500; i++) {
      try {
        const o = oracleBid(chainCase(SEED + 1, i).input);
        o.literalCappedTaxes.forEach((lt, k) => {
          n++;
          const ok = o.classes[k]!;
          if (lt.SS !== ok.SS || lt.FUTA !== ok.FUTA || lt.SUTA !== ok.SUTA) differ++;
        });
      } catch {
        /* refused input */
      }
    }
    console.log(`capped-tax readings differ on ${differ} of ${n} synthetic labor classes`);
    expect(n).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- primitives and charges (10.1, 10.2)

const arbTiers = fc
  .array(fc.tuple(fc.integer({ min: 1, max: 5_000_000 }), fc.integer({ min: 0, max: 60_000 })), { minLength: 0, maxLength: 5 })
  .map((xs) => {
    let ub = 0;
    const tiers: BondTier[] = xs.map(([w, r], i) => {
      ub += w;
      return { upperBound: i === xs.length - 1 ? null : c(ub), ratePpm: p(r) };
    });
    return tiers;
  });
const arbCharges = fc
  .record({ tiers: arbTiers, mDur: fc.integer({ min: 1_000_000, max: 1_500_000 }), fees: fc.array(fc.integer({ min: 0, max: 30_000 }), { maxLength: 3 }) })
  .map(({ tiers, mDur, fees }): PriceChargesInput => ({ tiers, mDurPpm: p(mDur), fees: fees.map((f, i) => ({ label: `f${i}`, rate: { ppm: p(f), base: 'on_price' as const } })) }));

describe('10.1 / 10.2 primitives against the oracle', () => {
  test('1, 2 divRoundHalfUp / mulRate / mulHours / extend equal exact BigInt fractions rounded half-up', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.bigInt({ min: 1n, max: 10n ** 9n }), fc.integer({ min: 0, max: 2_000_000_000 }), fc.integer({ min: 0, max: 2_000_000 }), fc.integer({ min: 0, max: 500_000 }), (n, d, x, r, w) => {
        expect(divRoundHalfUp(n, d)).toBe(roundHalfUp(q(n, d)));
        expect(mulRate(c(x), p(r))).toBe(Number(roundHalfUp(q(BigInt(x) * BigInt(r), 1_000_000n))));
        expect(mulHours((x % 10_000_000) as HoursC, c(r))).toBe(Number(roundHalfUp(q(BigInt(x % 10_000_000) * BigInt(r), 100n))));
        expect(extend((x % 100_000_000) as QtyM, p(w), c(r))).toBe(Number(roundHalfUp(q(BigInt(x % 100_000_000) * BigInt(1_000_000 + w) * BigInt(r), 1_000_000_000n))));
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
  test('7, 9 allocate equals the one-cent-at-a-time oracle', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000_000 }), fc.array(fc.integer({ min: 0, max: 100_000_000 }), { minLength: 1, maxLength: 8 }).filter((w) => w.some((x) => x > 0)), (T, w) => {
        expect(allocate(c(T), w).map(Number)).toEqual(allocateOracle(BigInt(T), w.map(BigInt)).map(Number));
      }),
      { seed: SEED, numRuns: RUNS },
    );
    expect(allocate(c(42_889_533), [1, 46, 5]).map(Number)).toEqual(allocateOracle(42_889_533n, [1n, 46n, 5n]).map(Number)); // I-29
  });
  test('19, 20 q(P) and grossUp equal the oracle (bisection) and, for small S, a plain scan with no monotonicity assumed', () => {
    fc.assert(
      fc.property(arbCharges, fc.integer({ min: 0, max: 500_000_000 }), fc.integer({ min: 0, max: 600_000_000 }), (ch, S, P) => {
        expect(priceBasedCharge(c(P), ch)).toBe(Number(qOf(BigInt(P), ch)));
        let oracleP: bigint | null = null;
        try {
          oracleP = grossUpQ(BigInt(S), ch);
        } catch {
          oracleP = null;
        }
        if (oracleP === null) expect(() => grossUp(c(S), ch)).toThrow(RangeError);
        else expect(grossUp(c(S), ch).P).toBe(Number(oracleP));
      }),
      { seed: SEED, numRuns: RUNS },
    );
    fc.assert(
      fc.property(arbCharges, fc.integer({ min: 0, max: 20_000 }), (ch, S) => {
        let ok = true;
        try {
          grossUpQ(BigInt(S), ch);
        } catch {
          ok = false;
        }
        if (ok) expect(grossUp(c(S), ch).P).toBe(Number(grossUpScan(BigInt(S), ch)));
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
  test('18 durationMultiplierPpm equals the 2.13 formula', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 120 }), fc.integer({ min: 0, max: 36 }), fc.integer({ min: 0, max: 36 }), fc.integer({ min: 0, max: 50_000 }), fc.integer({ min: 0, max: 50_000 }), (Mo, a, b2, s1, s2) => {
        const M1 = Math.min(a, b2), M2 = Math.max(a, b2);
        expect(durationMultiplierPpm(Mo, M1, M2, p(s1), p(s2))).toBe(Number(mDurPpmQ(Mo, M1, M2, s1, s2)));
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------- section 4

describe('section 4 against the oracle', () => {
  const SRC = { citation: 'test', url: 'https://www.acquisition.gov/far/28.101-2', effective: 'current' };
  test('59 bid security (D-34 federal 20% capped $3,000,000; D-35 5%; D-36 10%)', () => {
    const rules: BidSecurityRule[] = [
      { id: 'fed', pctPpm: p(200_000), floor: c(0), cap: c(300_000_000), basis: 'bid_price', requiredAbove: c(15_000_000), onlyWithPerformanceBond: true, source: SRC },
      { id: 'spwd', pctPpm: p(50_000), floor: c(0), cap: null, basis: 'base_plus_alternates', requiredAbove: c(10_000_000), onlyWithPerformanceBond: false, source: SRC },
      { id: 'ca', pctPpm: p(100_000), floor: c(0), cap: null, basis: 'amount_bid', requiredAbove: null, onlyWithPerformanceBond: false, source: SRC },
    ];
    fc.assert(
      fc.property(fc.constantFrom(...rules), fc.integer({ min: 0, max: 3_000_000_000 }), fc.boolean(), (rule, Bb, req) => {
        expect(bidSecurity(rule, c(Bb), req)).toBe(bidSecurityQ(Bb, rule.pctPpm, rule.floor, rule.cap, req));
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
  test('22 SBA fee payable (D-37) equals the oracle, rate switch exactly at 2026-11-30', () => {
    const T: SbaFeeTable = { switchDate: '2026-11-30' as never, rateBeforePpm: p(6_000), rateFromPpm: p(7_290), contractLimit: c(900_000_000), federalCertifiedLimit: c(1_400_000_000), source: SRC };
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 900_000_000 }), fc.constantFrom('2026-11-29', '2026-11-30', '2026-12-01', '2025-01-01'), fc.constantFrom('contract' as const, 'bid_bond' as const), (C, d, g) => {
        expect(sbaFee(T, c(C), d as never, { guarantee: g }).feePayable).toBe(sbaFeeQ(C, d, '2026-11-30', 6_000, 7_290, g));
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
  const rules = Object.values(RETAINAGE);
  test('62-66 retainage schedule: equal to the oracle when theta*C is a whole cent; within 1 cent per billing otherwise (spec 4.5 gives theta*C no rounding point)', () => {
    let exactCases = 0, offCases = 0;
    fc.assert(
      fc.property(fc.constantFrom(...rules), fc.array(fc.integer({ min: 1, max: 50_000_000 }), { minLength: 1, maxLength: 12 }), fc.integer({ min: 0, max: 30_000_000 }), (rule, bills, extra) => {
        const C = bills.reduce((a, b) => a + b, 0) + extra;
        const e = retainageSchedule(rule, c(C), bills.map(c));
        const o = retainageQ(rule as never, C, bills);
        const thetaWhole = o.thetaC === null || o.thetaC.d === 1n;
        if (thetaWhole) {
          exactCases++;
          expect(e.rows.map((r) => [r.W, r.Rel, r.R, r.grossWithheld, r.pay])).toEqual(o.rows.map((r) => [r.W, r.Rel, r.R, r.grossWithheld, r.pay]));
        } else {
          offCases++;
          e.rows.forEach((r, i) => expect(Math.abs(r.W - o.rows[i]!.W)).toBeLessThanOrEqual(1));
        }
      }),
      { seed: SEED, numRuns: RUNS },
    );
    expect(exactCases).toBeGreaterThan(0);
    console.log(`retainage: ${exactCases} exact cases, ${offCases} with a half-cent theta*C`);
  });
  test('67, 68 retainage financing (I-14) and late-payment interest (P-12, I-14) equal the oracle', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 5_000_000 }), fc.integer({ min: 0, max: 300 })), { minLength: 1, maxLength: 8 }), fc.integer({ min: 300, max: 700 }), fc.integer({ min: 0, max: 200_000 }), fc.constantFrom(360 as const, 365 as const), (ws, rel, rate, basis) => {
        const withheld = ws.map(([W, tau]) => ({ W: c(W), tauDay: tau }));
        expect(retainageFinancingCost({ withheld, releaseDay: rel, annualRatePpm: p(rate), dayCountBasis: basis }).gross).toBe(retainageFinancingQ(ws.map(([W, tau]) => ({ W, tau })), rel, rate, basis).cents);
      }),
      { seed: SEED, numRuns: RUNS },
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), fc.integer({ min: 0, max: 150_000 }), fc.integer({ min: 0, max: 24 }), fc.integer({ min: 0, max: 30 }), fc.constantFrom(360 as const, 365 as const), (P, r, n, d, basis) => {
        expect(federalLatePaymentInterest(c(P), p(r), n, d).interest).toBe(federalLateQ(P, r, n, d).cents);
        expect(simpleInterest(c(P), p(r), d + n * 30, basis).interest).toBe(simpleInterestQ(P, r, d + n * 30, basis));
      }),
      { seed: SEED, numRuns: RUNS },
    );
    expect(federalLateQ(150_000, 65_000, 0, 10).cents).toBe(271); // P-12
    expect(retainageFinancingQ([{ W: 200_000, tau: 60 }, { W: 200_000, tau: 90 }, { W: 200_000, tau: 120 }], 240, 90_000, 365).cents).toBe(22_192); // I-14
  });
});

// ---------------------------------------------------------------- section 5: cash ledger

const retRules = Object.values(RETAINAGE);
/** Random cash job; `exact` makes every category amount a multiple of its weight sum x 10^6, so no allocation rounding exists. */
const arbCashJob = (exact: boolean) =>
  fc
    .record({
      D: fc.integer({ min: 1, max: 20 }),
      b: fc.integer({ min: 1, max: 6 }),
      lam: fc.integer({ min: 0, max: 6 }),
      lamRextra: fc.integer({ min: 0, max: 6 }),
      cats: fc.array(
        fc.record({
          w: fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 21 }),
          amt: fc.integer({ min: 1, max: exact ? 20 : 5_000_000 }),
          lag: fc.integer({ min: 0, max: 6 }),
          dep: fc.constantFrom(0, 0, 100_000, 250_000, 500_000),
        }),
        { minLength: 1, maxLength: 4 },
      ),
      markupPpm: fc.integer({ min: -100_000, max: 600_000 }),
      ret: fc.constantFrom(...retRules),
    })
    .map(({ D, b, lam, lamRextra, cats, markupPpm, ret }): CashJobInput => {
      const categories = cats.map((k, i) => {
        const w: number[] = k.w.slice(0, D + 1);
        if (!w.some((x) => x > 0)) w[0] = 1; // (every(x === 0) would narrow w to 0[] in TS 7)
        const Ws = w.reduce((a, x) => a + x, 0);
        const amount = exact ? k.amt * Ws * 1_000_000 : k.amt;
        return { id: `k${i}`, kind: 'other' as const, amount: c(amount), weights: w, lagPeriods: k.lag, ...(k.dep ? { deposit: { sharePpm: p(k.dep), period: 0 } } : {}) };
      });
      const C = categories.reduce((a, k) => a + k.amount, 0);
      let price = Math.max(1, Math.round((C * (1_000_000 + markupPpm)) / 1_000_000));
      if (exact) price = Math.max(100, Math.round(price / 100) * 100);
      else price += price % 2; // even: theta*P is a whole cent at theta = 50% (the 4.5 gap is tested on its own)
      return { periodDays: 7, workPeriods: D, price: c(price), categories, billingPeriods: b, ownerLagPeriods: lam, retainage: ret, retainageReleasePeriods: lam + lamRextra };
    });

function cashDiff(job: CashJobInput) {
  let e, o;
  try {
    e = cashLedger(job);
  } catch (err) {
    e = err as Error;
  }
  try {
    o = cashOracle(job);
  } catch (err) {
    o = err as Error;
  }
  return { e, o };
}

describe('section 5 cash ledger against the period-by-period exact loop', () => {
  test('70, 72, 80 exact-allocation jobs: OUT, IN, Nminus, N, F*, F*_rf, t* and FIN agree exactly', () => {
    fc.assert(
      fc.property(arbCashJob(true), fc.integer({ min: 0, max: 200_000 }), fc.constantFrom(360 as const, 365 as const), (job, rate, basis) => {
        const { e, o } = cashDiff(job);
        if (e instanceof Error || o instanceof Error) {
          expect(e instanceof Error).toBe(o instanceof Error);
          return;
        }
        // an exact comparison needs theta*P to be a whole cent (see the retainage test)
        const L = e!, O = o!;
        expect(L.OUT.map(Number)).toEqual(O.OUT.map(toNum).concat(Array(Math.max(0, L.OUT.length - O.OUT.length)).fill(0)).slice(0, L.OUT.length));
        expect(L.H).toBe(O.H);
        expect([...L.IN]).toEqual(O.IN.map(toNum));
        expect([...L.Nminus]).toEqual(O.Nminus.map(toNum));
        expect([...L.N]).toEqual(O.N.map(toNum));
        const pk = peakFloat(L);
        expect([pk.F, pk.tStar, pk.Frf]).toEqual([toNum(O.F), O.tStar, toNum(O.Frf)]);
        expect(financingCost(L, p(rate), basis).FIN).toBe(financingOracle(O, 7, rate, basis).FIN);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
  test('70, 72 general jobs: every balance within the stated allocation tolerance; sums exact', () => {
    let worst = 0;
    fc.assert(
      fc.property(arbCashJob(false), (job) => {
        const { e, o } = cashDiff(job);
        if (e instanceof Error || o instanceof Error) {
          expect(e instanceof Error).toBe(o instanceof Error);
          return;
        }
        const L = e!, O = o!;
        // Tolerance: the engine allocates each category to whole cents per period by largest remainder (a prefix of
        // such an allocation is off by less than n/4 cents for n non-zero weights); a bill value then moves by at
        // most that x P/C_cash + 1/2, and its retainage parts by 1 cent more.
        const ratio = job.price / Math.max(1, L.Ccash);
        const alloc = job.categories.reduce((a, k) => a + k.weights.filter((w) => w > 0).length / 4 + 1, 0);
        const tol = alloc * (1 + ratio) + 2 * Math.ceil(job.workPeriods / job.billingPeriods) + 2;
        for (let t = 0; t <= Math.min(L.H, O.H); t++) {
          const d = Math.abs(L.N[t]! - toNum(O.N[t]!));
          worst = Math.max(worst, d);
          expect(d).toBeLessThanOrEqual(tol);
        }
        expect(L.OUT.reduce((a, x) => a + x, 0)).toBe(L.Ccash);
        expect(L.IN.reduce((a, x) => a + x, 0)).toBe(job.price);
        expect(Math.abs(peakFloat(L).F - toNum(O.F))).toBeLessThanOrEqual(tol);
      }),
      { seed: SEED, numRuns: RUNS },
    );
    console.log(`cash general jobs: worst |N_engine - N_oracle| = ${worst} cents`);
  });
  test('80 closed form 5.5: engine closedFormPeak = oracle closed form = the loop (uniform cost paid when incurred)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 24 }), fc.integer({ min: 1, max: 8 }), fc.integer({ min: 0, max: 8 }), fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: -50_000, max: 500_000 }), fc.integer({ min: 1, max: 50 }), (D, b, lam, r, m, k) => {
        const C = D * 1_000_000 * k;
        const P = Math.round((C * (1_000_000 + m)) / 1_000_000 / 100) * 100;
        const cf = closedFormOracle(q(C), q(P), D, b, lam, r);
        const ef = closedFormPeak(c(C), c(P), D, b, lam, p(r));
        expect(cmp(q(ef.num, ef.den), cf)).toBe(0);
        const job: CashJobInput = {
          periodDays: 7, workPeriods: D, price: c(P), billingPeriods: b, ownerLagPeriods: lam, retainageReleasePeriods: lam + 1,
          retainage: { id: 'flat', rho1Ppm: p(r), thetaPpm: null, rho2Ppm: p(r), kappaPpm: null, dollarCap: null, halfRelease: false } as RetainageRule,
          categories: [{ id: 'u', kind: 'other', amount: c(C), weights: [0, ...Array(D).fill(1)], lagPeriods: 0 }],
        };
        const loop = cashOracle(job);
        // the loop rounds bills to the cent and retainage per part: within 1 cent per bill of the closed form
        expect(Math.abs(toNum(loop.F) - toNum(cf))).toBeLessThanOrEqual(2 * Math.ceil(D / b));
        expect(Math.abs(peakFloat(cashLedger(job)).F - toNum(loop.F))).toBeLessThanOrEqual(0);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
  test('synthetic jobs: engine ledger vs oracle loop on generator cash jobs (peak within tolerance, FIN within 1 cent)', () => {
    let n = 0, worstF = 0, worstFin = 0;
    for (let i = 0; i < 400; i++) {
      const cc = chainCase(SEED + 7, i);
      let o: OracleBid;
      try {
        o = oracleBid(cc.input);
      } catch {
        continue;
      }
      const job = cashJobFor(cc.job, { ...oracleParts(o), q: o.q }, o.P);
      const L = cashLedger(job), O = cashOracle(job);
      worstF = Math.max(worstF, Math.abs(peakFloat(L).F - toNum(O.F)));
      worstFin = Math.max(worstFin, Math.abs(financingCost(L, p(cc.co.creditRatePpm), 365).FIN - financingOracle(O, 7, cc.co.creditRatePpm, 365).FIN));
      n++;
    }
    console.log(`synthetic cash: ${n} jobs, worst |F*| gap ${worstF} cents, worst |FIN| gap ${worstFin} cents`);
    expect(n).toBeGreaterThan(300);
    expect(worstF).toBeLessThanOrEqual(50);
    expect(worstFin).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------- section 6: escalation

const arbSeries = fc
  .record({
    start: fc.integer({ min: 2018 * 12, max: 2024 * 12 }),
    vals: fc.array(fc.integer({ min: 10_000, max: 999_999 }), { minLength: 6, maxLength: 40 }),
    prelim: fc.integer({ min: 0, max: 4 }),
  })
  .map(({ start, vals, prelim }) => {
    const per = (o: number) => `${Math.floor(o / 12)}-${String((o % 12) + 1).padStart(2, '0')}`;
    const obs: Obs[] = vals.map((v, i) => ({ period: per(start + i), value: (v / 1000).toFixed(3), preliminary: i >= vals.length - Math.min(prelim, vals.length - 1) }));
    return { obs, start, end: start + vals.length - 1, per };
  });

describe('section 6 against the oracle', () => {
  test('87, 89 index-ratio escalation of a line (spec 6.1, I-18) equals C * I2/I1 rounded once', () => {
    fc.assert(
      fc.property(arbSeries, fc.nat(), fc.nat(), fc.integer({ min: 0, max: 1_000_000_000 }), (s, a, b, amt) => {
        const input: IndexSeriesInput = {
          id: 'TEST', title: 't', titleVerified: false, source: 'https://api.bls.gov/publicAPI/v2/timeseries/data/', frequency: 'monthly', referenceBase: 'unverified', geography: 'US',
          observations: s.obs.map((o) => ({ seriesId: 'TEST', period: o.period, value: o.value, preliminary: o.preliminary, referenceBase: 'unverified', source: 'test' })),
        };
        const ser = normalizeSeries(input);
        const finals = s.obs.filter((o) => !o.preliminary);
        const f1 = finals[a % finals.length]!, f2 = finals[b % finals.length]!;
        const r = indexRatio(ser, f1.period, f2.period);
        expect(escalateLine('x', c(amt), r).adjusted).toBe(escalateLineQ(amt, f1.value, f2.value));
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
  test('spec 6.2 quote escalation e_i (ppm) equals the oracle, refusals included', () => {
    const disagreements: unknown[] = [];
    fc.assert(
      fc.property(arbSeries, fc.integer({ min: -6, max: 50 }), fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 200_000 }), fc.option(fc.integer({ min: -3, max: 40 })), (s, qOff, horizon, r, hold) => {
        const input: IndexSeriesInput = {
          id: 'TEST', title: 't', titleVerified: false, source: 'test', frequency: 'monthly', referenceBase: 'unverified', geography: 'US',
          observations: s.obs.map((o) => ({ seriesId: 'TEST', period: o.period, value: o.value, preliminary: o.preliminary, referenceBase: 'unverified', source: 'test' })),
        };
        const ser = normalizeSeries(input);
        const qm = s.start + Math.max(0, qOff);
        const quotedOn = `${s.per(qm)}-15`, purchaseDate = `${s.per(qm + horizon)}-${horizon === 0 ? '20' : '10'}`;
        const holdThrough = hold === null ? undefined : `${s.per(qm + hold)}-20`;
        let ev: number | string, ov: number | string;
        try {
          const res = quoteEscalation({ lineId: 'x', quotedOn: quotedOn as never, purchaseDate: purchaseDate as never, ...(holdThrough ? { holdThrough: holdThrough as never } : {}), series: ser, rFwdPpm: r });
          ev = res.ePpm;
        } catch (err) {
          ev = 'refused';
        }
        try {
          ov = ePpmQ({ quotedOn, purchaseDate, ...(holdThrough ? { holdThrough } : {}), obs: s.obs, rFwdPpm: r }).ePpm;
        } catch {
          ov = 'refused';
        }
        if (ev !== ov) disagreements.push({ quotedOn, purchaseDate, holdThrough, r, ev, ov, tLast: s.obs.filter((o) => !o.preliminary).at(-1)?.period });
      }),
      { seed: SEED, numRuns: RUNS },
    );
    if (disagreements.length) console.log('6.2 disagreements', disagreements.length, disagreements.slice(0, 3));
    expect(disagreements).toEqual([]);
  });
  test('spec 6.2 escalateForward rounds C (1 + r)^(m/12) once, exactly (oracle: 12th-power comparison)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000_000 }), fc.integer({ min: 0, max: 500_000 }), fc.integer({ min: 0, max: 48 }), (amt, r, m) => {
        expect(escalateForward(c(amt), r, m)).toBe(escalateForwardQ(amt, r, m));
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
  test('91, 92 factor table compounding and DoD linear interpolation (spec 6.4, D-77, P-13) equal the oracle', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 6 }), fc.nat(), (rates, k) => {
        const t = factorTableFromRates('t', 'https://example.invalid/dod', '2026-03-25', '2025-10', rates);
        const F = factorTableQ(rates);
        const months = k % (12 * rates.length + 1);
        const y = Math.floor(months / 12), mm = months % 12;
        const o = mm === 0 ? F[y]! : interpolateQ(F[y]!, F[y + 1]!, mm);
        const ord = 2025 * 12 + 9 + months;
        const e = interpolateFactor(t, `${Math.floor(ord / 12)}-${String((ord % 12) + 1).padStart(2, '0')}`);
        expect(cmp(q(e.num, e.den), o)).toBe(0);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------- section 7: brute-force optimum

describe('section 7.7 expected-profit optimum against brute force over every cent', () => {
  test('112 empirical step curve: B*, EV(B*), floor and the range ends equal the brute-force answer', () => {
    const mismatches: unknown[] = [];
    fc.assert(
      fc.property(
        fc.record({
          J: fc.integer({ min: 10, max: 22 }),
          A: fc.integer({ min: 50_000, max: 250_000 }),
          ratios: fc.array(fc.tuple(fc.integer({ min: 50_000, max: 250_000 }), fc.integer({ min: 850, max: 1_450 })), { minLength: 22, maxLength: 22 }),
          tjcPermille: fc.integer({ min: 700, max: 1_050 }),
          ohPpm: fc.integer({ min: 0, max: 100_000 }),
          FIN: fc.integer({ min: 0, max: 2_000 }),
          K: fc.integer({ min: 0, max: 20_000 }),
          fee: fc.integer({ min: 0, max: 8_000 }),
          bond: fc.boolean(),
          mMin: fc.integer({ min: 0, max: 50_000 }),
        }),
        (x) => {
          const lettings = x.ratios.slice(0, x.J).map(([a, rr]) => ({ anchor: a, lowestCompeting: Math.round((a * rr) / 1000) }));
          const TJC = Math.round((x.A * x.tjcPermille) / 1000);
          const OH = Math.round((TJC * x.ohPpm) / 1_000_000);
          const charges: PriceChargesInput = { tiers: x.bond ? D38_CLASS_B : [], mDurPpm: p(1_000_000), fees: x.fee ? [{ label: 'gl', rate: { ppm: p(x.fee), base: 'on_price' } }] : [] };
          const recs: LettingRecord[] = lettings.map((l, i) => ({ id: `L${i}`, anchor: c(l.anchor), anchorKind: 'own_cost_estimate', lowestCompeting: c(l.lowestCompeting), provenance: { kind: 'public', source: 'SIM synthetic tabulation' } }));
          const curve = pWinEmpirical({ lettings: recs, referenceClass: 'SIM', requestingTenantId: 'SIM-0001' }, { anchor: c(x.A), rule: { kind: 'sealed_low' }, ourFlags: {} });
          const sel = selectBid({ costs: { TJC: c(TJC), OH: c(OH), FIN: c(x.FIN), K: c(x.K) }, charges, minMarkupPpm: p(x.mMin), curve, delta: 0.05 });
          const bf = bruteForceBid({ lettings, anchor: x.A, TJC, OH, FIN: x.FIN, K: x.K, charges, minMarkupPpm: x.mMin, deltaNum: 1n, deltaDen: 20n });
          const got = sel.status === 'bid' ? { status: 'bid', floor: sel.floor, best: sel.recommended.B, low: sel.low.B, high: sel.high.B } : { status: sel.status, floor: 'floor' in sel ? sel.floor : null };
          const want = bf.status === 'bid' ? { status: 'bid', floor: bf.floor, best: bf.best, low: bf.low, high: bf.high } : { status: 'no_bid', floor: bf.floor };
          if (JSON.stringify(got) !== JSON.stringify(want)) mismatches.push({ got, want, x });
          else if (sel.status === 'bid') expect(Math.abs(sel.recommended.ev - Number(bf.bestEvNum) / bf.J)).toBeLessThan(1e-6);
        },
      ),
      { seed: SEED, numRuns: 60 }, // L5 is slow by design: sampled (spec 10.0)
    );
    if (mismatches.length) console.log('7.7 mismatches', mismatches.length, JSON.stringify(mismatches.slice(0, 2)));
    expect(mismatches).toEqual([]);
  });
});

describe('disagreement report', () => {
  test('summary of everything the chain differential found', () => {
    console.log('disagreements by section/field:', summarize(allDiffs));
    expect(Array.isArray(allDiffs)).toBe(true);
  });
});

export type { Q };
