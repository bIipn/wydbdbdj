// Spec 10.0 layer L6 and section 10.10: seeded Monte Carlo of SIMULATED contractors and jobs.
// Runs the simulate:cost runner at a modest size with a pinned seed, plus the generator's own calibration
// checks (anchors within 4 standard errors, spec 10.0).
import { describe, expect, test } from 'vitest';
import { formatSummary, runSimulation } from '../src/cli/simulate-cost.js';
import {
  D59_SIZE_STANDARD,
  D80_NV_MEDIAN,
  D80_NV_WAGE_PCTL,
  D86_AWARD_PCTL,
  Rng,
  logPercentileSample,
  percentileSample,
  simCompany,
  simJob,
  triangular,
  triangularMean,
  triangularVariance,
} from '../src/cost/synthetic.js';

const SEED = 20261113; // spec 10.0 pinned seed
const COMPANIES = 300; // modest size for every pull request (900 jobs, under a second)
const BOND_DEFECT = '61 bond applied iff the no-bond price exceeds the legal trigger';

describe('10.10 simulation', () => {
  const s = runSimulation({ companies: COMPANIES, seed: SEED });

  test('117 every simulated bid satisfies invariants 45 and 46; every applicable check passes', () => {
    console.log(formatSummary(s));
    expect(s.priced).toBe(s.jobs);
    expect(s.jobs).toBe(COMPANIES * 3);
    expect(s.invariantChecks).toBeGreaterThan(25 * s.jobs);
    expect(Object.keys(s.violations).filter((k) => k.startsWith('45') || k.startsWith('46'))).toEqual([]);
    expect(s.violations).toEqual({});
    expect(s.violationTotal).toBe(0);
  });

  // Regression, fixed (spec 2.13 last bullet + 4.2): in the 5,000-company run (seed 20261113) 18 of 15,000 jobs
  // used to violate invariant 61: FIN lifted the no-bond price just over the Nevada $100,000 or California $25,000
  // trigger and the engine kept the bond decision it took before FIN. SIM-0343-J03 is one of them.
  test('61 2.13 + 4.2: SIM-0343 (index 342) gets its bond when FIN lifts the no-bond price over the trigger', () => {
    const one = runSimulation({ companies: 1, firstCompany: 342, seed: SEED });
    expect(one.violations[BOND_DEFECT] ?? 0).toBe(0);
  });

  test('116 the same seed gives byte-identical output; a different seed gives different output', () => {
    const again = runSimulation({ companies: 60, seed: SEED });
    const twice = runSimulation({ companies: 60, seed: SEED });
    const other = runSimulation({ companies: 60, seed: SEED + 1 });
    expect(again.sha256).toBe(twice.sha256);
    expect(formatSummary(again)).toBe(formatSummary(twice));
    expect(other.sha256).not.toBe(again.sha256);
  });

  test('coverage: the generator spans the shapes spec 10.0 asks for', () => {
    expect(Object.keys(s.byState).sort()).toEqual(['CA', 'NV']);
    expect(Object.keys(s.byRegime).sort()).toEqual(['CA_PRIVATE', 'CA_PUBLIC', 'DAVIS_BACON', 'NV_PRIVATE', 'NV_PUBLIC']);
    expect(Object.keys(s.byOwner).length).toBe(8);
    expect(Object.keys(s.byOverheadMethod).sort()).toEqual(['dual', 'on_cost', 'on_labor_cost', 'on_sales', 'per_labor_hour']);
    expect(s.bonded).toBeGreaterThan(0);
    expect(s.bonded).toBeLessThan(s.jobs);
    expect(s.headcount.p5).toBe(2);
    expect(s.headcount.max).toBe(50);
    const jobs = Array.from({ length: COMPANIES }, (_, i) => simCompany(SEED, i)).flatMap((co) => [0, 1, 2].map((j) => simJob(SEED, co, j)));
    expect(jobs.some((j) => j.weeks <= 4)).toBe(true);
    expect(jobs.some((j) => j.weeks > 26)).toBe(true);
    const cos = Array.from({ length: COMPANIES }, (_, i) => simCompany(SEED, i));
    expect(new Set(cos.map((c) => c.limitsProfile))).toEqual(new Set(['tight', 'loose']));
    expect(s.limits['peak_float']!.stop).toBeGreaterThan(0); // tight limits breach
    expect(s.limits['peak_float']!.ok).toBeGreaterThan(0); // loose limits fit
  });

  test('12.1 rule 6: simulated companies are labelled, never real: SIM ids, simulated flag, under the D-59 size standard', () => {
    for (let i = 0; i < 500; i++) {
      const co = simCompany(SEED, i);
      expect(co.id).toMatch(/^SIM-\d{4}$/);
      expect(co.simulated).toBe(true);
      expect(co.annualRevenue).toBeLessThan(D59_SIZE_STANDARD);
      expect(co.headcount).toBeGreaterThanOrEqual(2);
      expect(co.headcount).toBeLessThanOrEqual(50);
    }
    expect(simCompany(SEED, 7)).toEqual(simCompany(SEED, 7)); // pure in (seed, index)
  });
});

describe('118, 119 generator calibration (4 standard errors, spec 10.0)', () => {
  const N = 200_000;
  test('118 D-80 wage sampler reproduces the Nevada median $35.37 and the p25 / p75 points', () => {
    const g = new Rng(SEED);
    const xs = Array.from({ length: N }, () => percentileSample(D80_NV_WAGE_PCTL, g.next()));
    // P(X <= published quantile) = q within 4 binomial standard errors
    for (const [qq, v] of [[0.25, 2352], [0.5, D80_NV_MEDIAN], [0.75, 4642]] as const) {
      const share = xs.filter((x) => x <= v).length / N;
      expect(Math.abs(share - qq)).toBeLessThanOrEqual(4 * Math.sqrt((qq * (1 - qq)) / N));
    }
    // the clamp puts 10% of draws exactly on each end value (spec 10.0: acceptable, labelled)
    const low = xs.filter((x) => x === 2217).length / N;
    expect(Math.abs(low - 0.1)).toBeLessThanOrEqual(4 * Math.sqrt((0.1 * 0.9) / N));
  });
  test('118 D-86 job-size sampler (log-linear) reproduces the published median $38,209.62 and p90 $166,702.02', () => {
    const g = new Rng(SEED + 1);
    const xs = Array.from({ length: N }, () => logPercentileSample(D86_AWARD_PCTL, g.next()));
    for (const [qq, v] of [[0.5, 3_820_962], [0.9, 16_670_202]] as const) {
      const share = xs.filter((x) => x <= v).length / N;
      expect(Math.abs(share - qq)).toBeLessThanOrEqual(4 * Math.sqrt((qq * (1 - qq)) / N));
    }
    expect(xs.every((x) => x >= 338_000 * (1 - 1e-12) && x <= 283_893_431 * (1 + 1e-12))).toBe(true); // inside [min, max] of D-86
  });
  test('119 triangular samples stay in [a, b]; mean within 4 SE; variance within 4 SE of the closed form', () => {
    const g = new Rng(SEED + 2);
    for (const [a, c, b] of [[0, 0.3, 1], [10, 10, 20], [-5, 4, 4], [0.85, 1.08, 1.35]] as const) {
      const xs = Array.from({ length: N }, () => triangular(a, c, b, g.next()));
      expect(xs.every((x) => x >= a && x <= b)).toBe(true);
      const mean = xs.reduce((s, x) => s + x, 0) / N;
      const v = triangularVariance(a, c, b);
      expect(Math.abs(mean - triangularMean(a, c, b))).toBeLessThanOrEqual(4 * Math.sqrt(v / N));
      const sv = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (N - 1);
      // stated tolerance: 4 x sigma^2 sqrt(2/N) (the normal-theory standard error; the triangular has lighter tails)
      expect(Math.abs(sv - v)).toBeLessThanOrEqual(4 * v * Math.sqrt(2 / N));
    }
  });
  test('Rng: same seed, same stream; uniform on [0, 1)', () => {
    const a = new Rng(42), b = new Rng(42);
    const xa = Array.from({ length: 1000 }, () => a.next());
    expect(xa).toEqual(Array.from({ length: 1000 }, () => b.next()));
    expect(xa.every((x) => x >= 0 && x < 1)).toBe(true);
    const g = new Rng(7);
    const m = Array.from({ length: N }, () => g.next()).reduce((s, x) => s + x, 0) / N;
    expect(Math.abs(m - 0.5)).toBeLessThanOrEqual(4 * Math.sqrt(1 / 12 / N));
  });
});
