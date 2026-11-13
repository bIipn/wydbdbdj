// The estimate orchestrator end to end: golden examples I-1 and I-2 through the contractor-friendly
// request, invariants 12, 45, 46 (monotone in profit, overhead and hours), 70 and 86 on generated jobs,
// complete sources and assumptions lists, "needed" reporting (never a guessed number), field-level
// refusals, bid facts, financing, and the bid range gate (A-25).
// Test plan 10.0: pinned seed, 1,000 runs per property (each run is a whole estimate: build-up, daily cash
// ledger, stress cases and the limits check).
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { estimate, EstimateInputError, fromQuickForm, type EstimateRequest, type EstimateResult, type LaborClassRequest } from '../src/cost/estimate.js';
import { ASSUMPTIONS } from '../src/cost/assumptions.js';

fc.configureGlobal({ seed: 20_261_113, numRuns: 1_000 });
const E2E_RUNS = 1_000;

/** Spec 11.2 I-1 (made-up inputs, test vector only) as the contractor would type it. */
function i1(): EstimateRequest {
  return {
    job: { ownerType: 'nv_local', prevailingWage: 'none', bidDate: '2026-11-20', startDate: '2026-12-01', endDate: '2026-12-31', estimatedCost: '60000' },
    labor: {
      classes: [
        { label: 'Journeyman', hours: '160', overtimeHours: '8', wage: '45.00', planFringe: '4.00', healthPlan: '4.00', annualWages: '90000', workersCompPer100: '2.50' },
        { label: 'Apprentice', hours: '120', wage: '24.00', planFringe: '4.00', healthPlan: '4.00', annualWages: '48000', workersCompPer100: '2.50' },
      ],
      mbt: { mode: 'marginal', quarterlyGrossWages: '120000', quarterlyHealthDeduction: '10000' },
      workersComp: { experienceMod: '1.00', policyEffectiveDate: '2026-10-15' },
    },
    materials: {
      lines: [
        { label: 'Wire', quantity: '2400', unitPrice: '1.85', wastePercent: '5', quotedOn: '2026-10-05', purchaseDate: '2026-12-05' },
        { label: 'Conduit', quantity: '600', unitPrice: '3.40', wastePercent: '3' },
        { label: 'Gear package', quantity: 1, unitPrice: '6800' },
        { label: 'Fixtures', quantity: 24, unitPrice: '185' },
      ],
      freight: '350', freightTaxable: false, salesTaxPercent: '7.1', forwardRatePercent: '6',
    },
    equipment: [{ label: 'Lift rental', amount: '650' }],
    subcontracts: [{ label: 'Trenching', amount: '3200' }],
    jobOverhead: [{ label: 'Permit', amount: '420' }, { label: 'Supervision', hours: '12', rate: '65' }, { label: 'Mobilization', amount: '300' }, { label: 'Cleanup', amount: '150' }],
    markups: { smallToolsPercent: '2', contingencyPercent: '0', overhead: { method: 'on_cost', percent: '15' }, profitPercent: '10' },
    insurance: { generalLiability: { basis: 'receipts', per1000: '6.00' } },
    financing: { include: false },
    payment: { billingCycleDays: 30, retainageReleaseDays: 60 },
    limits: { cashForJob: '15000', unusedCreditLine: '10000' },
  };
}
type Mutable<T> = T extends string | number | boolean ? T : { -readonly [K in keyof T]: Mutable<T[K]> };
const clone = (r: EstimateRequest): Mutable<EstimateRequest> => structuredClone(r) as Mutable<EstimateRequest>;
const line = (r: EstimateResult, key: string) => r.breakdown.find((l) => l.key === key)?.amount;
const ids = (r: EstimateResult) => r.assumptions.map((a) => a.id);
const rows = (r: EstimateResult) => [...new Set(r.sources.map((s) => s.id))];

describe('11.2 I-1 through the estimate request', () => {
  const r = estimate(i1());
  test('I-1: bid price 49,125.75 and every line of the illustration', () => {
    expect(r.status).toBe('complete');
    expect(r.needed).toEqual([]);
    expect(r.total).toBe(4_912_575);
    const t = r.totals!;
    expect([t.L, t.G, t.ST, t.MAT, t.E, t.SUB, t.JOOH, t.TJC, t.OH, t.BE, t.PR, t.S, t.q, t.P]).toEqual([
      1_315_825, 1_062_000, 26_317, 1_968_016, 65_000, 320_000, 165_000, 3_860_158, 579_024, 4_439_182, 443_918, 4_883_100, 29_475, 4_912_575,
    ]);
    expect(line(r, 'labor.c1.L')).toBe(939_667);
    expect(line(r, 'labor.c2.L')).toBe(376_158);
    expect(r.breakdown.find((l) => l.key === 'labor.c1.L')!.label).toContain('Journeyman');
    expect(r.totals!.premium).toBe(0); // 49,125.75 does not exceed $100,000: no Nevada statutory bond (D-35)
    expect(r.job.bondApplied).toBe(false);
    expect(r.job.regime).toBe('NV_PRIVATE');
  });
  test('I-1: the wire escalation comes from spec 6.2 (1.06^(2/12) -> 9,759 ppm -> 45.50)', () => {
    const esc = r.breakdown.filter((l) => l.key.includes('esc')).map((l) => l.amount);
    expect(esc).toContain(4_550);
  });
  test('I-1: sources name every dated default used, with its date and URL', () => {
    for (const id of ['D-1', 'D-2', 'D-3', 'D-4', 'D-6', 'D-7', 'D-8', 'D-9', 'D-12', 'D-13', 'D-35', 'D-48', 'D-70'])
      expect(rows(r), id).toContain(id);
    expect(rows(r)).not.toContain('D-38'); // no bond applied: the sample schedule is not a source
    for (const s of r.sources) {
      expect(s.urls[0]).toMatch(/^https:\/\//);
      expect(s.effective).not.toBe('');
    }
    const ui = r.sources.find((s) => s.key === 'ui.newEmployerRate')!;
    expect([ui.id, ui.value, ui.from, ui.to]).toEqual(['D-7', 29_500, '2026-01-01', '2026-12-31']);
    expect(r.warnings.some((w) => /new-employer rate 2.95%/.test(w))).toBe(true);
  });
  test('I-1: assumptions are the registry rows actually used, each labelled an assumption', () => {
    expect(ids(r)).toEqual(['A-9', 'A-16', 'A-21', 'A-22', 'A-26', 'A-27', 'A-28', 'A-37']);
    expect(r.assumptions.every((a) => a.label === 'assumption' && ASSUMPTIONS.some((x) => x.id === a.id && x.text === a.text))).toBe(true);
  });
  test('I-1: cash carried and the limits verdict against $25,000 of cash plus credit', () => {
    expect(r.cash.status).toBe('computed');
    if (r.cash.status !== 'computed' || r.limits.status !== 'checked') throw new Error('unreachable');
    expect(r.cash.cashCost).toBe(r.totals!.TJC + r.totals!.qBid); // 5.2: C_cash = TJC + q(P)
    expect(r.cash.finalCash).toBe(r.total! - r.cash.cashCost); // invariant 70: N(H) = P - C_cash
    const pf = r.limits.checks.find((c) => c.id === 'peak_float')!;
    expect(pf.verdict).toBe(r.cash.peakFloat <= 2_500_000 ? 'ok' : 'stop');
    expect(r.limits.stress.map((s) => s.id)).toEqual(['owner_lag_plus_30d', 'owner_lag_plus_60d', 'supplier_cod']);
    expect(r.checks.some((c) => c.level === 'stop' && /Cash to carry the job: short by/.test(c.text))).toBe(true);
  });
  test('I-1: the bid range is not shown without your own lettings, and says why', () => {
    expect(r.bidRange).toEqual({ status: 'not_shown', reason: expect.stringMatching(/at least 10 comparable lettings, A-25/) });
  });
  test('I-1: pure: the same request gives the same result', () => {
    expect(estimate(i1())).toEqual(r);
  });
});

describe('11.3 I-2 bonded gross-up through the estimate request', () => {
  /** S = $180,000.00 exactly: a subcontract-only federal job with 0% overhead and profit, 5 months, sample schedule. */
  const i2 = (sba?: string): EstimateRequest => ({
    job: { ownerType: 'federal', state: 'NV', prevailingWage: 'none', startDate: '2026-12-01', endDate: '2027-04-30' },
    subcontracts: [{ label: 'Electrical sub', amount: '180000' }],
    markups: { overhead: { method: 'on_cost', percent: '0' }, profitPercent: '0' },
    insurance: { generalLiability: { basis: 'none' } },
    bond: { required: 'yes', ...(sba ? { sba: { approvalDate: sba } } : {}) },
    financing: { include: false },
  });
  test('I-2: no SBA fee: P = 183,756.35, premium 3,756.35; the sample schedule is labelled A-1', () => {
    const r = estimate(i2());
    expect([r.totals!.S, r.total, r.price!.premium]).toEqual([18_000_000, 18_375_635, 375_635]);
    expect(ids(r)).toContain('A-1');
    expect(ids(r)).toContain('A-2');
    expect(rows(r)).toContain('D-38');
    expect(rows(r)).toContain('D-39');
    expect(r.status).toBe('complete'); // limits missing only blocks the limits check
    expect(r.needed.every((n) => n.for === 'limits')).toBe(true);
  });
  test('I-2: SBA fee at $6.00 per $1,000: P = 184,882.53, premium part 3,773.24, fee payable 1,109.00', () => {
    const r = estimate(i2('2026-11-20'));
    expect([r.total, r.price!.charges, r.price!.premium]).toEqual([18_488_253, 488_253, 377_324]);
    expect(r.warnings.some((w) => w.includes('SBA guarantee fee payable $1,109.00'))).toBe(true);
    expect(rows(r)).toContain('D-37');
  });
  test('I-2: SBA fee at $7.29: P = 185,126.47, premium part 3,776.90, fee payable 1,350.00', () => {
    const r = estimate(i2('2026-11-30'));
    expect([r.total, r.price!.charges, r.price!.premium]).toEqual([18_512_647, 512_647, 377_690]);
    expect(r.warnings.some((w) => w.includes('$1,350.00'))).toBe(true);
  });
});

describe('needed inputs are reported, never guessed', () => {
  test('an empty request lists what the price needs and returns no numbers', () => {
    const r = estimate({});
    expect(r.status).toBe('incomplete');
    expect(r.total).toBeNull();
    expect(r.price).toBeNull();
    expect(r.breakdown).toEqual([]);
    const f = r.needed.map((n) => n.field);
    for (const k of ['job.ownerType', 'job.state', 'job.startDate', 'job.endDate', 'markups.overhead', 'insurance.generalLiability', 'financing.annualRatePercent', 'limits.cashForJob'])
      expect(f, k).toContain(k);
    expect(r.checks.every((c) => c.level === 'warn' && c.text.startsWith('Needed'))).toBe(true);
  });

  const required: [string, (q: Mutable<EstimateRequest>) => void][] = [
    ['labor.classes[0].workersCompPer100', (q) => void delete (q.labor!.classes![0] as Mutable<LaborClassRequest>).workersCompPer100],
    ['labor.classes[1].wage', (q) => void delete (q.labor!.classes![1] as Mutable<LaborClassRequest>).wage],
    ['labor.workersComp.experienceMod', (q) => void delete q.labor!.workersComp!.experienceMod],
    ['labor.workersComp.policyEffectiveDate', (q) => void delete q.labor!.workersComp!.policyEffectiveDate],
    ['labor.mbt', (q) => void delete q.labor!.mbt],
    ['materials.salesTaxPercent', (q) => void delete q.materials!.salesTaxPercent],
    ['materials.forwardRatePercent', (q) => void delete q.materials!.forwardRatePercent],
    ['markups.overhead', (q) => void delete q.markups!.overhead],
    ['markups.profitPercent', (q) => void delete q.markups!.profitPercent],
    ['insurance.generalLiability', (q) => void delete q.insurance!.generalLiability],
    ['job.prevailingWage', (q) => void delete q.job!.prevailingWage],
    ['job.startDate', (q) => void delete q.job!.startDate],
    ['job.ownerType', (q) => void delete q.job!.ownerType],
  ];
  test('removing any one required input gives "incomplete" with that field named and no price', () => {
    fc.assert(
      fc.property(fc.constantFrom(...required), ([field, del]) => {
        const q = clone(i1());
        del(q);
        const r = estimate(q);
        expect(r.status).toBe('incomplete');
        expect(r.total).toBeNull();
        expect(r.needed.map((n) => n.field)).toContain(field);
      }),
      { numRuns: required.length * 3 },
    );
  });

  test('cash-only needs keep the price but skip the cash model; limit needs skip only the limits check', () => {
    const q = clone(i1());
    delete q.payment;
    const r = estimate(q);
    expect(r.status).toBe('complete');
    expect(r.total).toBe(4_912_575);
    expect(r.needed).toEqual([{ field: 'payment.billingCycleDays', why: expect.any(String), for: 'cash' }, { field: 'payment.retainageReleaseDays', why: expect.stringMatching(/A-30/), for: 'cash' }]);
    expect(r.cash.status).toBe('not_computed');
    const q2 = clone(i1());
    delete q2.limits;
    const r2 = estimate(q2);
    expect([r2.status, r2.cash.status, r2.limits.status]).toEqual(['complete', 'computed', 'not_checked']);
  });

  test('California 2026: the FUTA credit reduction must be entered (A-9); Nevada 2027 under A-34 needs it too', () => {
    const ca = clone(i1());
    ca.job!.ownerType = 'ca_local';
    delete ca.labor!.mbt;
    expect(estimate(ca).needed.map((n) => n.field)).toContain('labor.futaCreditReductionPercent');
    ca.labor!.futaCreditReductionPercent = '0';
    const r = estimate(ca);
    expect(r.status).toBe('complete');
    expect(ids(r)).toContain('A-12'); // overtime premium excluded from WC payroll outside Nevada
    const nv27 = clone(i1());
    Object.assign(nv27.job!, { startDate: '2027-01-04', endDate: '2027-02-05' });
    const r27 = estimate(nv27);
    expect(r27.needed.map((n) => n.field)).toContain('labor.futaCreditReductionPercent');
    nv27.labor!.futaCreditReductionPercent = '0';
    const ok27 = estimate(nv27);
    expect(ok27.status).toBe('complete');
    expect(ids(ok27)).toContain('A-34');
    expect(ids(ok27)).not.toContain('A-10'); // a policy from 2026-10-15 uses D-12; A-10 is only for 2027 policies
  });

  test('federal $35,000 to $150,000: the officer-choice band is asked, never decided for you', () => {
    const q: EstimateRequest = {
      job: { ownerType: 'federal', state: 'NV', prevailingWage: 'none', startDate: '2026-12-01', endDate: '2027-01-31' },
      subcontracts: [{ label: 'Sub', amount: '60000' }],
      markups: { overhead: { method: 'on_cost', percent: '10' }, profitPercent: '10' },
      insurance: { generalLiability: { basis: 'none' } },
      financing: { include: false },
    };
    const r = estimate(q);
    expect(r.status).toBe('incomplete');
    expect(r.needed.map((n) => n.field)).toContain('bond.officerChoiceMeansBond');
    const yes = estimate({ ...q, bond: { officerChoiceMeansBond: true } });
    const no = estimate({ ...q, bond: { officerChoiceMeansBond: false } });
    expect([yes.job.bondApplied, no.job.bondApplied]).toEqual([true, false]);
    expect(yes.total!).toBeGreaterThan(no.total!);
  });

  test('prevailing-wage work needs the determination for every class; a short wage is a stop', () => {
    const q = clone(i1());
    q.job!.prevailingWage = 'nv_338';
    expect(estimate(q).needed.map((n) => n.field)).toEqual(expect.arrayContaining(['labor.classes[0].prevailing', 'labor.classes[1].prevailing']));
    q.labor!.classes![0] = { ...q.labor!.classes![0]!, prevailing: { basic: '50.00', fringe: '10.00' } };
    q.labor!.classes![1] = { label: 'Apprentice', hours: '120', prevailing: { basic: '30.00', fringe: '8.00', fringePaidAs: 'plan' }, workersCompPer100: '2.50' };
    // 45 + 4 < 50 + 10: a failed check is an error, not a warning (spec 2.2) -> a field-level refusal
    try {
      estimate(q);
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(EstimateInputError);
      expect((e as EstimateInputError).fields).toEqual([{ path: 'labor.classes[0].wage', message: expect.stringMatching(/\$11\.00\/h short of the prevailing rate \$60\.00\/h/) }]);
    }
    q.labor!.classes![0] = { ...q.labor!.classes![0]!, wage: '50.00', planFringe: '10.00', healthPlan: '4.00' };
    const r = estimate(q);
    expect(r.status).toBe('complete');
    expect(r.job.regime).toBe('NV_PUBLIC');
    expect(r.checks.find((c) => c.text.startsWith('Journeyman'))!.level).toBe('ok');
    expect(r.checks.find((c) => c.text.startsWith('Apprentice'))!.level).toBe('ok'); // pays the determination exactly
  });
});

describe('field-level refusals (RangeError), never a silently wrong number', () => {
  const bad = (mut: (q: Mutable<EstimateRequest>) => void): string[] => {
    const q = clone(i1());
    mut(q);
    try {
      estimate(q);
    } catch (e) {
      expect(e).toBeInstanceOf(EstimateInputError);
      expect(e).toBeInstanceOf(RangeError);
      return (e as EstimateInputError).fields.map((f) => f.path);
    }
    throw new Error('expected a refusal');
  };
  test('too many decimals, negatives, bad dates, unknown fields, impossible combinations', () => {
    expect(bad((q) => void ((q.labor!.classes![0] as Mutable<LaborClassRequest>).wage = '45.555'))).toEqual(['labor.classes[0].wage']);
    expect(bad((q) => void ((q.labor!.classes![0] as Mutable<LaborClassRequest>).hours = '-3'))).toEqual(['labor.classes[0].hours']);
    expect(bad((q) => void (q.job!.endDate = '2026-11-31'))).toEqual(['job.endDate']);
    expect(bad((q) => void (q.job!.endDate = '2026-11-01'))).toEqual(['job.endDate']);
    expect(bad((q) => void ((q as Record<string, unknown>).discount = 5))).toEqual(['discount']);
    expect(bad((q) => void (q.job!.state = 'CA'))).toEqual(['job.state']);
    expect(bad((q) => void (q.materials!.salesTaxPercent = 'seven'))).toEqual(['materials.salesTaxPercent']);
    expect(bad((q) => void (q.labor!.workersComp!.excludeOtPremium = true))).toEqual(['labor.workersComp.excludeOtPremium']); // D-13
    expect(bad((q) => void (q.markups!.overhead = { method: 'on_sales', percent: '60', profitPercent: '40' }))).toEqual(expect.arrayContaining(['markups.overhead']));
    expect(bad((q) => void (q.labor!.stateUiRatePercent = '9'))).toEqual(['labor.stateUiRatePercent']); // NV schedule tops at 5.4%
  });
  test('numbers and decimal strings parse to the same integers; JSON floats are read from their shortest text', () => {
    const q = clone(i1());
    (q.labor!.classes![0] as Mutable<LaborClassRequest>).wage = 45;
    q.materials!.salesTaxPercent = 7.1;
    q.equipment = [{ label: 'Lift rental', amount: '$650' }];
    expect(estimate(q).total).toBe(4_912_575);
  });
});

describe('bid facts from a stored bid', () => {
  const bid = { id: 'samgov:TEST-1', estValue: { min: 60_000, max: 60_000 }, flags: ['Prevailing wage', 'Bid bond'], dueDate: '2026-11-20', state: 'NV', locationLabel: 'Carson City, NV' };
  test('the estimate, flags, due date and location are used where the request is silent, and said so', () => {
    const q = clone(i1());
    delete q.job!.estimatedCost;
    delete q.job!.prevailingWage;
    delete q.job!.bidDate;
    const r = estimate(q, { bid });
    expect(r.bidFacts).toEqual(expect.arrayContaining([
      { fact: 'estimate', value: '$60000', used: true, how: expect.stringMatching(/owner's estimate/) },
      { fact: 'flag', value: 'Prevailing wage', used: true, how: 'prevailing wage: nv_338' },
      { fact: 'due date', value: '2026-11-20', used: true, how: 'bid date' },
      { fact: 'flag', value: 'Bid bond', used: false, how: expect.stringMatching(/A-2/) },
    ]));
    expect(r.job.prevailingWage).toBe('nv_338');
    expect(r.needed.map((n) => n.field)).toContain('labor.classes[0].prevailing'); // the flag drives a real requirement
  });
  test('a range estimate is not turned into one number', () => {
    const r = estimate(i1(), { bid: { ...bid, flags: [], estValue: { min: 50_000, max: 90_000 } } });
    expect(r.bidFacts.find((f) => f.fact === 'estimate')).toMatchObject({ used: false, value: '$50000 to $90000' });
  });
});

describe('financing line (spec 2.12, 5.6) and the bid range (spec 7)', () => {
  test('with a credit-line rate the FIN line is priced from the cash model, one pass (A-20), 365 basis (A-29)', () => {
    const q = clone(i1());
    q.financing = { annualRatePercent: '9' };
    const r = estimate(q);
    const t = r.totals!;
    expect(t.FIN).toBeGreaterThan(0);
    expect(t.S).toBe(t.BE + t.PR + t.FIN);
    expect(t.P).toBe(t.S + t.q);
    expect(line(r, 'FIN')).toBe(t.FIN);
    expect(ids(r)).toEqual(expect.arrayContaining(['A-20', 'A-29']));
    expect(r.financing).toMatchObject({ included: true, FIN: t.FIN, annualRatePpm: 90_000, dayCount: 365 });
    const r360 = estimate({ ...q, financing: { annualRatePercent: '9', dayCount: 360 } });
    expect(r360.totals!.FIN).toBeGreaterThanOrEqual(t.FIN); // a 360 basis charges more per day
  });

  const lettings = (n: number) => Array.from({ length: n }, (_, i) => ({ anchor: '60000', lowestCompeting: String(54_000 + 1_000 * i) }));
  test('a range needs at least 10 of your own lettings (A-25) and the floor inputs', () => {
    const q = clone(i1());
    q.award = { referenceClass: 'NV local electrical under $100k (TEST, simulated)', lettings: lettings(12), minMarkupPercent: '0', bidPrepCost: '300' };
    const r = estimate(q);
    expect(r.bidRange.status === 'shown' || r.bidRange.status === 'no_bid').toBe(true);
    if (r.bidRange.status === 'shown') {
      const b = r.bidRange;
      expect(b.low.price <= b.recommended.price && b.recommended.price <= b.high.price).toBe(true);
      expect(b.low.price).toBeGreaterThanOrEqual(b.floor);
      expect(b.J).toBe(12);
      expect(b.note).toMatch(/never a promise/);
    }
    expect(JSON.parse(JSON.stringify(r))).toEqual(r); // JSON-safe: no bigint, no undefined-only fields lost
    const few = estimate({ ...q, award: { ...q.award, lettings: lettings(5) } });
    expect(few.bidRange.status).toBe('not_shown');
    const noFloor = estimate({ ...q, award: { referenceClass: 'x', lettings: lettings(12) } });
    expect(noFloor.needed.filter((n) => n.for === 'range').map((n) => n.field)).toEqual(['award.minMarkupPercent', 'award.bidPrepCost']);
    expect(noFloor.status).toBe('complete');
  });
});

describe('the contract quick form', () => {
  test('maps to a request, labels the flat burden, and asks for what it lacks', () => {
    const { request, notes } = fromQuickForm({ laborHours: 40, laborRate: '45', materials: 1200, burdenPct: 30, overheadPct: 15, profitPct: 10, bondPct: 1.5, upfrontWeeks: 4 });
    expect(notes.join(' ')).toMatch(/approximation/);
    expect(notes.join(' ')).toMatch(/upfrontWeeks is not used/);
    expect(request.bond!.tiers![0]!.ratePer1000).toBe('15');
    const r = estimate(request);
    expect(r.status).toBe('incomplete');
    expect(r.needed.map((n) => n.field)).toEqual(expect.arrayContaining(['job.ownerType', 'job.startDate', 'labor.classes[0].workersCompPer100', 'materials.salesTaxPercent']));
  });
});

// ---------------------------------------------------------------- generated jobs (invariants 12, 45, 46, 70, 86)

/** Generated fields are integers (cents, hundredths); the request is built from their exact text. */
const fmt2 = (n: number) => `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
const fmt3 = (n: number) => `${Math.floor(n / 1000)}.${String(n % 1000).padStart(3, '0')}`;
const classArb = fc.record({
  label: fc.constantFrom('Journeyman', 'Apprentice', 'Foreman'),
  hours: fc.integer({ min: 0, max: 40_000 }),
  overtimeHours: fc.integer({ min: 0, max: 1_000 }),
  wage: fc.integer({ min: 1_800, max: 9_000 }),
  planFringe: fc.integer({ min: 0, max: 1_500 }),
  workersCompPer100: fc.integer({ min: 0, max: 1_200 }),
});
const jobArb = fc.record({
  state: fc.constantFrom('NV', 'CA'),
  startDay: fc.integer({ min: 1, max: 20 }),
  lengthDays: fc.integer({ min: 0, max: 40 }),
  classes: fc.array(classArb, { minLength: 0, maxLength: 3 }),
  materials: fc.array(fc.record({ label: fc.constantFrom('Wire', 'Conduit', 'Panel'), quantity: fc.integer({ min: 0, max: 5_000 }), unitPrice: fc.integer({ min: 1, max: 500_000 }), waste: fc.integer({ min: 0, max: 1_000 }), taxable: fc.boolean() }), { maxLength: 4 }),
  sub: fc.integer({ min: 0, max: 5_000_000 }),
  jooh: fc.integer({ min: 0, max: 300_000 }),
  overhead: fc.integer({ min: 0, max: 2_500 }), // hundredths of a percent
  profit: fc.integer({ min: 0, max: 2_000 }),
  gl: fc.option(fc.integer({ min: 0, max: 12_000 }), { nil: undefined }), // thousandths of a dollar per $1,000
  bond: fc.constantFrom('auto', 'yes', 'no'),
  cash: fc.integer({ min: 0, max: 10_000_000 }),
  credit: fc.integer({ min: 0, max: 5_000_000 }),
});
type Job = typeof jobArb extends fc.Arbitrary<infer T> ? T : never;
function request(j: Job): EstimateRequest {
  const start = `2026-12-${String(j.startDay).padStart(2, '0')}`;
  const endN = j.startDay + j.lengthDays;
  const end = endN <= 31 ? `2026-12-${String(endN).padStart(2, '0')}` : `2027-01-${String(endN - 31).padStart(2, '0')}`;
  return {
    job: { ownerType: j.state === 'NV' ? 'nv_local' : 'ca_local', prevailingWage: 'none', startDate: start, endDate: end },
    labor: {
      classes: j.classes.map((c) => ({ label: c.label, hours: fmt2(c.hours), overtimeHours: fmt2(c.overtimeHours), wage: fmt2(c.wage), planFringe: fmt2(c.planFringe), workersCompPer100: fmt2(c.workersCompPer100) })),
      ...(j.state === 'NV' ? { mbt: { mode: 'marginal' as const, quarterlyGrossWages: '120000', quarterlyHealthDeduction: '0' } } : { futaCreditReductionPercent: '0' }),
      workersComp: { experienceMod: '1.00', policyEffectiveDate: '2026-10-15' },
    },
    materials: { lines: j.materials.map((m) => ({ label: m.label, quantity: String(m.quantity), unitPrice: fmt2(m.unitPrice), wastePercent: fmt2(m.waste), taxable: m.taxable })), salesTaxPercent: '7.1' },
    ...(j.sub ? { subcontracts: [{ label: 'Sub', amount: fmt2(j.sub) }] } : {}),
    ...(j.jooh ? { jobOverhead: [{ label: 'Permit', amount: fmt2(j.jooh) }] } : {}),
    markups: { overhead: { method: 'on_cost', percent: fmt2(j.overhead) }, profitPercent: fmt2(j.profit) },
    insurance: { generalLiability: j.gl !== undefined ? { basis: 'receipts', per1000: fmt3(j.gl) } : { basis: 'none' } },
    bond: { required: j.bond as 'auto' | 'yes' | 'no' },
    payment: { billingCycleDays: 30, retainageReleaseDays: 45 },
    financing: { include: false },
    limits: { cashForJob: fmt2(j.cash), unusedCreditLine: fmt2(j.credit) },
  };
}
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe('generated jobs', () => {
  test('12 and 45: every total is the sum of its lines; S = TJC + OH + PR + FIN; P = S + q(P); all figures non-negative safe integers', () => {
    fc.assert(
      fc.property(jobArb, (j) => {
        const r = estimate(request(j));
        expect(r.status).toBe('complete');
        const t = r.totals!;
        for (const v of Object.values(t)) expect(Number.isSafeInteger(v) && v >= 0).toBe(true);
        expect(t.TJC).toBe(t.L + t.ST + t.MAT + t.E + t.SUB + t.JOOH + t.ESC_L + t.CONT);
        expect(t.BE).toBe(t.TJC + t.OH);
        expect(t.S).toBe(t.TJC + t.OH + t.PR + t.FIN);
        expect(t.P).toBe(t.S + t.q);
        expect(t.q).toBe(t.premium + t.otherCharges);
        expect(t.P >= t.S && t.S >= t.BE && t.BE >= t.TJC).toBe(true); // invariant 46, second clause
        const classL = r.breakdown.filter((l) => /^labor\.c\d+\.L$/.test(l.key)).map((l) => l.amount);
        expect(sum(classL)).toBe(t.L);
        for (const k of ['L', 'ST', 'MAT', 'E', 'SUB', 'JOOH', 'TJC', 'BE', 'PR', 'S', 'P'] as const) expect(line(r, k), k).toBe(t[k]);
        // assumptions and sources lists are complete and real
        for (const l of r.breakdown) if (l.assumption) expect(ids(r), l.key).toContain(l.assumption);
        for (const a of r.assumptions) expect(ASSUMPTIONS.some((x) => x.id === a.id)).toBe(true);
        if (j.classes.length) for (const id of ['D-1', 'D-2', 'D-3', 'D-4', j.state === 'NV' ? 'D-6' : 'D-10']) expect(rows(r), id).toContain(id);
        if (r.job.bondApplied) expect(rows(r)).toContain('D-38');
        if (r.job.bondApplied) expect(ids(r)).toContain('A-1');
        // invariant 70 through the estimate: N(H) = P - C_cash, C_cash = TJC + q(P_bid)
        if (r.cash.status === 'computed') {
          expect(r.cash.cashCost).toBe(t.TJC + t.qBid);
          expect(r.cash.finalCash).toBe(t.Pbid - r.cash.cashCost);
          expect(r.cash.peakFloat).toBeLessThanOrEqual(r.cash.cashCost); // invariant 72
        }
      }),
      { numRuns: E2E_RUNS },
    );
  });

  test('46: raising profit, overhead or any class hours never lowers the price (bond decision held fixed)', () => {
    fc.assert(
      fc.property(jobArb, fc.integer({ min: 1, max: 500 }), fc.constantFrom('profit', 'overhead', 'hours'), (j, bump, what) => {
        fc.pre(j.bond !== 'auto'); // a legal threshold is an intentional jump (invariant 61)
        const base = estimate(request(j)).total!;
        const k = { ...j };
        if (what === 'profit') k.profit = j.profit + bump;
        else if (what === 'overhead') k.overhead = j.overhead + bump;
        else k.classes = j.classes.map((c) => ({ ...c, hours: c.hours + bump }));
        expect(estimate(request(k)).total!).toBeGreaterThanOrEqual(base);
      }),
      { numRuns: E2E_RUNS },
    );
  });

  test('86: more cash or credit never turns "fits" into "short"; headroom moves one for one with funds', () => {
    fc.assert(
      fc.property(jobArb, fc.integer({ min: 0, max: 5_000_000 }), (j, more) => {
        const a = estimate(request(j));
        const k = { ...j, cash: j.cash + more };
        const b = estimate(request(k));
        fc.pre(a.limits.status === 'checked'); // a job with no cost has nothing to carry
        if (a.limits.status !== 'checked' || b.limits.status !== 'checked') throw new Error('limits not checked');
        const va = a.limits.checks.find((c) => c.id === 'peak_float')!.verdict, vb = b.limits.checks.find((c) => c.id === 'peak_float')!.verdict;
        const rank = { ok: 0, warn: 1, stop: 2 } as Record<string, number>;
        expect(rank[vb]!).toBeLessThanOrEqual(rank[va]!);
        expect(b.limits.headroom - a.limits.headroom).toBe(more);
      }),
      { numRuns: E2E_RUNS },
    );
  });
});

// Spec 7.7 ("the limits check of section 5.8 is evaluated at every candidate price and can veto it") and 5.8.
describe('5.8 / 7.7 the bid range respects the limits', () => {
  const vetoBase = (o: { cash: string; backlog: string }): EstimateRequest => ({
    job: { ownerType: 'nv_local', prevailingWage: 'none', bidDate: '2026-11-20', startDate: '2026-12-01', endDate: '2026-12-31', estimatedCost: '60000' },
    labor: {
      classes: [{ label: 'J', hours: '160', wage: '45.00', annualWages: '90000', workersCompPer100: '2.50' }],
      mbt: { mode: 'marginal', quarterlyGrossWages: '120000', quarterlyHealthDeduction: '10000' },
      workersComp: { experienceMod: '1.00', policyEffectiveDate: '2026-10-15' },
    },
    materials: { lines: [{ label: 'Gear', quantity: 1, unitPrice: '6800' }], salesTaxPercent: '7.1' },
    markups: { overhead: { method: 'on_cost', percent: '15' }, profitPercent: '10' },
    insurance: { generalLiability: { basis: 'none' } },
    bond: { required: 'yes', tiers: [{ upTo: null, ratePer1000: '15' }] },
    financing: { include: false },
    payment: { billingCycleDays: 30, retainageReleaseDays: 60 },
    limits: { cashForJob: o.cash, unusedCreditLine: '0', suretyLetter: { singleLimit: '500000', aggregateLimit: '1000000', backlogRemaining: o.backlog } },
    award: {
      anchor: '25000', minMarkupPercent: '5', bidPrepCost: '200', referenceClass: 'test class',
      lettings: Array.from({ length: 12 }, (_, i) => ({ anchor: '25000', lowestCompeting: String(24000 + i * 500) })),
    },
  } as unknown as EstimateRequest);
  const verdict = (r: EstimateResult, id: string) => (r.limits.status === 'checked' ? r.limits.checks.find((c) => c.id === id)?.verdict : undefined);

  test('7.7 reviewer probe: a job short on cash and over the surety aggregate gets no recommended price', () => {
    const r = estimate(vetoBase({ cash: '1000', backlog: '990000' }));
    expect(verdict(r, 'peak_float')).toBe('stop');
    expect(verdict(r, 'bonding')).toBe('stop');
    expect(r.bidRange.status).toBe('no_bid');
  });
  test('5.8 every shown price satisfies backlogRemaining + B <= aggregateLimit (room 30,000.00)', () => {
    const r = estimate(vetoBase({ cash: '1000000', backlog: '970000' }));
    expect(verdict(r, 'peak_float')).not.toBe('stop');
    if (r.bidRange.status !== 'shown') throw new Error(`expected a shown range, got ${JSON.stringify(r.bidRange)}`);
    for (const B of [r.bidRange.low.price, r.bidRange.high.price, r.bidRange.recommended.price]) expect(97_000_000 + B).toBeLessThanOrEqual(100_000_000);
  });
  test('5.8 no aggregate room left: no bid, with the reason', () => {
    const r = estimate(vetoBase({ cash: '1000000', backlog: '1000000' }));
    expect(r.bidRange.status).toBe('no_bid');
    if (r.bidRange.status === 'no_bid') expect(r.bidRange.reason).toMatch(/aggregate/);
  });
  test('5.8 cash veto alone: enough bonding room but too little cash gives no bid with the cash reason', () => {
    const r = estimate(vetoBase({ cash: '1000', backlog: '0' }));
    expect(verdict(r, 'peak_float')).toBe('stop');
    expect(r.bidRange.status).toBe('no_bid');
    if (r.bidRange.status === 'no_bid') expect(r.bidRange.reason).toMatch(/cash/);
  });
});
