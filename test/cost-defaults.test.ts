// Spec section 8 (defaults) and section 9 (assumptions) as shipped data: integrity against the spec
// (row count + checksum of names, and a row-by-row comparison when the spec file is present), fail-closed
// lookups, invariants 22, 26, 28, 29, 40 and 61 on the shipped tables, and the golden examples that
// test the shipped values: P-5, P-11, P-16, I-3, I-4 (SBA fee), I-6, I-12.
// Test plan 10.0: pinned seed, 1,000 runs per property.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { annualEmployerTaxes, durationMultiplierPpm, grossUp, mulRate, priceBasedCharge, type Cents, type IsoDate, type Ppm, type PriceChargesInput } from '../src/cost/index.js';
import { bondRequirement, sbaFee, sbaFeeRatePpm } from '../src/cost/bonds.js';
import { retainageSchedule } from '../src/cost/payment.js';
import {
  DEFAULT_ROWS,
  DEFAULT_ROW_COUNT,
  bondRequirementTable,
  createSourceLog,
  defaultRow,
  defaultsCanonical,
  lookupDefault,
  lookupNumber,
  newEmployerUiRate,
  nvWcPayrollCap,
  OWNER_TYPES,
  paymentTiming,
  payrollTable,
  retainageRule,
  sampleBondTiers,
  sbaFeeTable,
  surchargePreset,
} from '../src/cost/defaults.js';
import { ASSUMPTIONS, ASSUMPTION_COUNT, assumption, assumptionsCanonical, assumptionsReport, useAssumption } from '../src/cost/assumptions.js';

fc.configureGlobal({ seed: 20_261_113, numRuns: 1_000 });
const c = (n: number) => n as Cents;
const p = (n: number) => n as Ppm;
const d = (s: string) => s as IsoDate;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** sha256 of `${id}|${name}` per spec 8 row and `${id}|${assumption}` per spec 9 row, computed from cost-model.md v1. */
const SPEC8_CHECKSUM = 'ca6bfc6392d9a73f485c6338f36f544cc82462da4d7729b90869bc572a1e4775';
const SPEC9_CHECKSUM = 'c47fc36c714bbc710eddacd3cb495930e7754e0e8728a52c00f2014b81ab446f';
/** The spec lives beside this worktree during the build; the comparison runs when it is there. */
const SPEC = fileURLToPath(new URL('../../research/cost-model.md', import.meta.url));

function specTables(md: string) {
  const lines = md.split('\n');
  const s8 = lines.findIndex((l) => l.startsWith('## 8.')), s9 = lines.findIndex((l) => l.startsWith('## 9.')), s10 = lines.findIndex((l) => l.startsWith('## 10.'));
  const cells = (l: string) => l.split('|').slice(1, -1).map((x) => x.trim());
  const rows = lines.slice(s8, s9).filter((l) => /^\| D-\d+ /.test(l)).map(cells);
  const as = lines.slice(s9, s10).filter((l) => /^\| A-\d+ /.test(l)).map(cells);
  return { rows, as };
}

describe('spec 8 defaults table: integrity', () => {
  test('row count and checksum of names match the spec', () => {
    expect(DEFAULT_ROWS).toHaveLength(DEFAULT_ROW_COUNT);
    expect(DEFAULT_ROW_COUNT).toBe(87);
    expect(sha(defaultsCanonical())).toBe(SPEC8_CHECKSUM);
    const ids = DEFAULT_ROWS.map((r) => Number(r.id.slice(2))).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 87 }, (_, i) => i + 1)); // D-1 .. D-87, each once
  });

  test('every row is dated, sourced, kinded and carries at least one engine value', () => {
    for (const r of DEFAULT_ROWS) {
      expect(r.values.length, r.id).toBeGreaterThan(0);
      expect(r.sources.length, r.id).toBeGreaterThan(0);
      for (const u of r.sources) expect(u, r.id).toMatch(/^https:\/\//);
      expect(['law', 'published_rate', 'study', 'rule_of_thumb', 'guidance', 'fact']).toContain(r.kind);
      expect(r.effectiveText, r.id).not.toBe('');
      for (const v of r.values) {
        if (typeof v.value === 'number' && v.unit !== 'factor') expect(Number.isSafeInteger(v.value), `${r.id} ${v.key}`).toBe(true);
        if (v.from && v.to) expect(v.from <= v.to, `${r.id} ${v.key}`).toBe(true);
      }
    }
  });

  test('context rows are exactly the *context* / *reference* rows and are refused in the money path', () => {
    const ctx = DEFAULT_ROWS.filter((r) => r.context).map((r) => r.id);
    expect(ctx).toEqual(['D-15', 'D-16', 'D-41', 'D-56', 'D-57', 'D-58', 'D-60', 'D-65', 'D-67', 'D-68', 'D-69', 'D-75', 'D-77', 'D-78', 'D-81', 'D-86', 'D-87']);
    expect(() => lookupDefault('wc.advisoryPurePremium.5190', 'CA', d('2026-11-13'))).toThrow(/CONTEXT_ONLY/);
    expect(lookupDefault('wc.advisoryPurePremium.5190', 'CA', d('2026-11-13'), { allowContext: true }).value.value).toBe(37_290);
    expect(() => lookupDefault('rate.bankPrime', 'US', d('2026-10-09'))).toThrow(/CONTEXT_ONLY/);
  });

  test.skipIf(!existsSync(SPEC))('row by row against the spec file: id, name, value text, effective text, sources', () => {
    const { rows, as } = specTables(readFileSync(SPEC, 'utf8'));
    expect(rows).toHaveLength(DEFAULT_ROWS.length);
    rows.forEach((c, i) => {
      const r = DEFAULT_ROWS[i]!;
      expect([r.id, r.name, r.valueText, r.unitText, r.jurisdictionText, r.effectiveText, r.kindText, r.evidence]).toEqual(c.slice(0, 8));
      expect(r.sources).toEqual(c[8]!.split(' ; ').map((s) => s.trim()));
    });
    expect(as).toHaveLength(ASSUMPTIONS.length);
    as.forEach((c, i) => expect([ASSUMPTIONS[i]!.id, ASSUMPTIONS[i]!.text, ASSUMPTIONS[i]!.engineDefault, ASSUMPTIONS[i]!.why]).toEqual(c));
  });
});

describe('spec 9 assumptions registry', () => {
  test('row count and checksum match the spec; A-1 .. A-40 each once', () => {
    expect(ASSUMPTIONS).toHaveLength(ASSUMPTION_COUNT);
    expect(sha(assumptionsCanonical())).toBe(SPEC9_CHECKSUM);
    expect(ASSUMPTIONS.map((a) => a.id)).toEqual(Array.from({ length: 40 }, (_, i) => `A-${i + 1}`));
  });
  test('every row is editable except the two the engine never uses; rows without a default carry null', () => {
    expect(ASSUMPTIONS.filter((a) => !a.editable).map((a) => a.id)).toEqual(['A-5', 'A-33']);
    for (const id of ['A-7', 'A-11', 'A-13', 'A-14', 'A-21']) expect(assumption(id).value, id).toBeNull();
    expect(assumption('A-18').value).toBe(20_000);
    expect(assumption('A-8').value).toBe(200_000);
  });
  test('a result lists exactly the assumptions it used, deduplicated and sorted; unknown ids are refused', () => {
    const rep = assumptionsReport([useAssumption('A-26'), useAssumption('A-9', 'x'), useAssumption('A-9', 'x'), useAssumption('A-9', 'y')]);
    expect(rep.map((a) => a.id)).toEqual(['A-9', 'A-26']);
    expect(rep[0]!.usedAs.map((u) => u.value)).toEqual(['x', 'y']);
    expect(rep.every((a) => a.label === 'assumption')).toBe(true);
    expect(() => assumptionsReport([{ id: 'A-99', text: 'made up', value: '1' }])).toThrow(RangeError);
    expect(() => assumption('A-0')).toThrow(/UNKNOWN_ASSUMPTION/);
  });
});

describe('lookups fail closed', () => {
  test('a date no row covers, an unknown key or jurisdiction is refused, never guessed', () => {
    expect(lookupNumber('ss.wageBase', 'US', d('2026-06-30'))).toBe(18_450_000);
    expect(() => lookupNumber('ss.wageBase', 'US', d('2028-01-01'))).toThrow(/NO_DEFAULT_FOR_DATE/);
    expect(() => lookupNumber('ss.wageBase', 'TX', d('2026-06-30'))).toThrow(/NO_DEFAULT/);
    expect(() => lookupNumber('no.such.key', 'US', d('2026-06-30'))).toThrow(/NO_DEFAULT/);
    expect(() => lookupDefault('ss.wageBase', 'US', d('2026-02-30'))).toThrow(RangeError);
    expect(() => payrollTable('CA', 2027)).toThrow(/NO_DEFAULT_FOR_DATE/); // A-34: California 2027 not loaded
    expect(() => payrollTable('NV', 2025)).toThrow(/NO_DEFAULT_FOR_DATE/); // D-1 is dated 2026-2027
    expect(() => bondRequirementTable('private')).toThrow(/NO_DEFAULT/);
    expect(() => bondRequirementTable('federal_aided_local')).toThrow(/simplified acquisition threshold/);
    expect(() => retainageRule('private', 'base')).toThrow(/NO_DEFAULT/);
    expect(() => paymentTiming('ndot')).toThrow(/NO_DEFAULT/);
  });

  test('D-12 Nevada workers comp cap by policy date; A-10 from 2027-01-01', () => {
    expect(nvWcPayrollCap(d('2026-09-30')).cap).toBe(3_600_000);
    expect(nvWcPayrollCap(d('2026-10-01')).cap).toBe(9_843_360);
    const y27 = nvWcPayrollCap(d('2027-03-01'));
    expect(y27.cap).toBe(9_843_360);
    expect(y27.assumptions.map((a) => a.id)).toEqual(['A-10']);
    expect(y27.warning).toMatch(/check the new cap/);
  });

  test('D-37 SBA rate switch date by approval date; the source log records each row used once, with URL', () => {
    const log = createSourceLog();
    const t = sbaFeeTable(log);
    expect(t.switchDate).toBe('2026-11-30');
    const used = log.list();
    expect(used.every((s) => s.id === 'D-37' && s.urls[0]!.startsWith('https://www.federalregister.gov/'))).toBe(true);
    expect(used.map((s) => s.key)).toEqual(['sba.contractLimit', 'sba.federalCertifiedLimit', 'sba.feeRate', 'sba.feeRate']);
  });

  test('new-employer unemployment rates (D-7, D-10); Nevada 2027 under A-34', () => {
    expect(newEmployerUiRate('NV', 2026).ratePpm).toBe(29_500);
    expect(newEmployerUiRate('CA', 2026).ratePpm).toBe(34_000);
    const nv27 = newEmployerUiRate('NV', 2027);
    expect([nv27.ratePpm, nv27.assumptions[0]!.id]).toEqual([29_500, 'A-34']);
  });

  test('every owner type resolves to a bond table or a stated refusal (never a silent default)', () => {
    for (const o of OWNER_TYPES) {
      let ok = false;
      try { bondRequirementTable(o); ok = true; } catch (e) { expect(e).toBeInstanceOf(RangeError); }
      expect(ok, o).toBe(!['private', 'federal_aided_local'].includes(o));
    }
  });
});

describe('invariants on the shipped tables', () => {
  const NV26 = payrollTable('NV', 2026).table;
  const NV27 = payrollTable('NV', 2027).table;
  const CA26 = payrollTable('CA', 2026).table;

  test('40: table years are monotone (SS base 176,100 <= 184,500 <= 192,300; NV UI base 41,800 <= 43,700 <= 45,400)', () => {
    const ss = [2025, 2026, 2027].map((y) => lookupNumber('ss.wageBase', 'US', d(`${y}-06-30`)));
    const ui = [2025, 2026, 2027].map((y) => lookupNumber('ui.wageBase', 'NV', d(`${y}-06-30`)));
    expect(ss).toEqual([17_610_000, 18_450_000, 19_230_000]);
    expect(ui).toEqual([4_180_000, 4_370_000, 4_540_000]);
  });

  test('26: SS + Medicare is exactly 7.65% of wages up to the base; above it the marginal rate is exactly 1.45%', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40_000_000 }), (W) => {
        const t = annualEmployerTaxes(NV26, c(W), p(29_500));
        const base = NV26.socialSecurity.wageBase;
        if (W <= base) expect(t.ss + t.med - mulRate(c(W), p(62_000)) - mulRate(c(W), p(14_500))).toBe(0);
        else {
          const t2 = annualEmployerTaxes(NV26, c(W + 100_000), p(29_500));
          expect(t2.ss).toBe(t.ss);
          expect(t2.med - t.med).toBe(1_450);
        }
      }),
    );
  });

  test('28: FUTA per employee lies in [0, $42.00] with no credit reduction and equals 0.6% x $7,000 from $7,000', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40_000_000 }), (W) => {
        const f = annualEmployerTaxes(NV26, c(W), p(29_500)).futa;
        expect(f >= 0 && f <= 4_200).toBe(true);
        if (W >= 700_000) expect(f).toBe(4_200);
      }),
    );
  });

  test('29: Nevada UI + CEP for a 2026 new employer never exceeds $1,311.00; CEP is 0 exactly at 5.4%; CA UI <= $434, ETT <= $7', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40_000_000 }), (W) => {
        const nv = annualEmployerTaxes(NV26, c(W), p(29_500)).suta;
        expect(nv).toBeLessThanOrEqual(131_100);
        const at54 = annualEmployerTaxes(NV26, c(W), p(54_000)).suta;
        expect(nv).toBe(mulRate(c(Math.min(W, 4_370_000)), p(30_000))); // 2.95% + CEP 0.05%
        expect(at54).toBe(mulRate(c(Math.min(W, 4_370_000)), p(54_000))); // CEP not added at 5.4%
        const ca = annualEmployerTaxes(CA26, c(W), p(62_000), p(0)).suta; // UI at the top rate + ETT
        expect(ca).toBeLessThanOrEqual(43_400 + 700);
      }),
    );
    expect(annualEmployerTaxes(NV26, c(9_000_000), p(54_000)).suta).toBe(mulRate(c(4_370_000), p(54_000))); // exactly no CEP
  });

  test('61: legal thresholds from the shipped bond tables jump exactly where the law puts them', () => {
    const at = (o: Parameters<typeof bondRequirementTable>[0], C: number) => bondRequirement(bondRequirementTable(o), c(C)).anyBond;
    expect([at('federal', 15_000_000), at('federal', 15_000_001)]).toEqual(['officer_choice', 'yes']);
    expect([at('federal', 3_500_000), at('federal', 3_500_001)]).toEqual(['no', 'officer_choice']);
    expect([at('nv_local', 9_999_999), at('nv_local', 10_000_000), at('nv_local', 10_000_001)]).toEqual(['no', 'no', 'yes']);
    expect([at('ca_local', 2_500_000), at('ca_local', 2_500_001)]).toEqual(['no', 'yes']);
    expect(at('ndot', 1)).toBe('yes');
  });

  test('22: SBA fee from the shipped table: switch exactly at 2026-11-30, non-decreasing, 0 on bid bonds, |payable - exact| <= 50 cents', () => {
    const t = sbaFeeTable();
    expect([sbaFeeRatePpm(t, d('2026-11-29')), sbaFeeRatePpm(t, d('2026-11-30'))]).toEqual([6_000, 7_290]);
    expect(sbaFee(t, c(40_000_000), d('2026-11-01'), { guarantee: 'bid_bond' }).feePayable).toBe(0);
    expect(() => sbaFee(t, c(900_000_001), d('2026-11-01'), { guarantee: 'contract' })).toThrow(RangeError);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 899_999_999 }), fc.boolean(), (C, late) => {
        const date = d(late ? '2026-12-01' : '2026-11-01');
        const a = sbaFee(t, c(C), date, { guarantee: 'contract' }), b = sbaFee(t, c(C + 1), date, { guarantee: 'contract' });
        expect(b.feePayable).toBeGreaterThanOrEqual(a.feePayable);
        const exact2 = 2n * a.feeExact.num; // compare |payable - exact| <= 50 in exact fractions
        expect(BigInt(Math.abs(Number(2n * BigInt(a.feePayable) * a.feeExact.den - exact2)))).toBeLessThanOrEqual(100n * a.feeExact.den);
      }),
    );
  });
});

describe('golden examples that test the shipped values', () => {
  test('P-11: 6.2% x 192,300 = 11,922.60; California UI max 7,000 x 6.2% = 434, ETT 7; a 0.3% credit reduction gives 0.9% FUTA', () => {
    const ss27 = lookupNumber('ss.wageBase', 'US', d('2027-06-30'));
    expect(mulRate(c(ss27), p(lookupNumber('ss.employerRate', 'US', d('2027-06-30'))))).toBe(1_192_260);
    const ca = lookupNumber('ui.wageBase', 'CA', d('2026-06-30'));
    expect(mulRate(c(ca), p(lookupNumber('ui.rateMax', 'CA', d('2026-06-30'))))).toBe(lookupNumber('ui.maxPerEmployee', 'CA', d('2026-06-30')));
    expect(mulRate(c(ca), p(lookupNumber('ui.surcharge', 'CA', d('2026-06-30'))))).toBe(700);
    expect(lookupNumber('futa.netRate', 'US', d('2026-06-30')) + lookupNumber('futa.creditReductionStepPerYear', 'US', d('2025-06-30'))).toBe(9_000);
  });

  test('I-6: Nevada 2026 new employer, $45.00/h x 2,000 h, W = $90,000 -> 8,238.00; 2027 wage bases with unchanged rates (A-34) -> 8,289.00', () => {
    const W = c(9_000_000);
    const t26 = annualEmployerTaxes(payrollTable('NV', 2026).table, W, newEmployerUiRate('NV', 2026).ratePpm);
    expect([t26.ss, t26.med, t26.futa, t26.suta, t26.total]).toEqual([558_000, 130_500, 4_200, 131_100, 823_800]);
    const n27 = payrollTable('NV', 2027);
    expect(n27.assumptions.map((a) => a.id)).toEqual(['A-34']);
    expect(n27.table.futa.creditReductionPpm).toBeNull(); // must be entered for 2027
    const t27 = annualEmployerTaxes(n27.table, W, newEmployerUiRate('NV', 2027).ratePpm, p(0));
    expect(t27.total).toBe(828_900);
  });

  test('P-16 and I-3: the D-38 sample (corrected fifth tier) reproduces the reported premiums', () => {
    const { tiers, assumption: a } = sampleBondTiers('non_deviating');
    expect(a.id).toBe('A-1');
    const q = (P: number) => priceBasedCharge(c(P), { tiers, mDurPpm: p(1_000_000), fees: [] });
    expect([10_000_000, 100_000_000, 1_000_000_000, 5_000_000_000].map(q)).toEqual([250_000, 1_350_000, 8_100_000, 34_100_000]); // P-16
    expect([500_000_000, 750_000_000, 1_000_000_000, 5_000_000_000].map(q)).toEqual([4_725_000, 6_475_000, 8_100_000, 34_100_000]); // I-3
  });

  test('P-5: $2,500,000 including bond, 20 months, D-39 non-deviating: q = 30,780.00; grossUp(2,469,220.00) = 2,500,000.00', () => {
    const sp = surchargePreset('non_deviating');
    const mDur = durationMultiplierPpm(20, sp.M1, sp.M2, sp.s1, sp.s2);
    expect(mDur).toBe(1_080_000);
    const ch: PriceChargesInput = { tiers: sampleBondTiers('non_deviating').tiers, mDurPpm: mDur, fees: [] };
    expect(priceBasedCharge(c(250_000_000), ch)).toBe(3_078_000);
    expect(grossUp(c(246_922_000), ch).P).toBe(250_000_000);
    const dev = surchargePreset('deviating');
    expect([dev.M1, dev.M2, dev.s1, dev.s2]).toEqual([12, 24, 5_000, 10_000]);
    expect(surchargePreset('table_24').M1).toBe(24);
  });

  test('I-4: SBA fee on $400,000 from the shipped table: 2,400 at $6.00, 2,916 at $7.29', () => {
    const t = sbaFeeTable();
    expect(sbaFee(t, c(40_000_000), d('2026-11-29'), { guarantee: 'contract' }).feePayable).toBe(240_000);
    expect(sbaFee(t, c(40_000_000), d('2026-11-30'), { guarantee: 'contract' }).feePayable).toBe(291_600);
  });

  test('I-12: retainage presets from the shipped tables, $240,000 contract, six $40,000 billings', () => {
    const b = Array.from({ length: 6 }, () => c(4_000_000));
    const run = (o: Parameters<typeof retainageRule>[0], k: Parameters<typeof retainageRule>[1]) => retainageSchedule(retainageRule(o, k), c(24_000_000), b);
    const best = run('nv_local', 'best'), base = run('nv_local', 'base'), stress = run('nv_local', 'stress'), ca = run('ca_local', 'base');
    expect(best.rows.map((r) => r.W)).toEqual([200_000, 200_000, 200_000, 0, 0, 0]);
    expect(best.heldAtEnd).toBe(600_000);
    expect(base.rows.map((r) => r.W)).toEqual([200_000, 200_000, 200_000, 100_000, 100_000, 100_000]);
    expect(base.totalHalfReleased).toBe(300_000);
    expect(base.heldAtEnd).toBe(600_000);
    expect(stress.totalWithheld).toBe(1_200_000);
    expect(ca.totalWithheld).toBe(1_200_000);
    expect(run('federal', 'base').totalWithheld).toBe(0); // D-43 satisfactory progress
    expect(run('caltrans', 'base').totalWithheld).toBe(0); // PCC 7202
  });

  test('D-44, D-48, D-53 payment timing presets carry their legal maximums and sources', () => {
    expect(paymentTiming('federal')).toMatchObject({ billingCycle: 'monthly', payLagDays: 14, retainageReleaseLagDays: 30, subPayLagDays: 7 });
    expect(paymentTiming('nv_local')).toMatchObject({ payLagDays: 30, retainageReleaseLagDays: null, subPayLagDays: 10 });
    expect(paymentTiming('ca_local')).toMatchObject({ payLagDays: 30, retainageReleaseLagDays: 60, subPayLagDays: 7 });
    expect(paymentTiming('federal').source.url).toBe(defaultRow('D-44').sources[0]);
  });
});
