/**
 * Price statistics and "similar awards" selection. Real numbers come from the captured USAspending
 * pages (Nevada electrical awards, 2026-11-13) and real ZIP points from the product's own lookup (src/geo/zip.ts).
 * Property tests use made-up amounts and TEST ZIP codes: arithmetic only, nothing a user sees.
 */
import fc from 'fast-check';
import { lookupZip } from '../src/geo/zip.js';
import { describe, expect, it } from 'vitest';
import {
  AWARD_LADDER, hasPriceAtAward, isMinimumGuarantee, loadedSpan, MIN_PRICED_AWARDS, normalizeCounty, percentile, priceStats, selectSimilarAwards,
  type AwardLevel, type AwardPoint, type CoverageSpan, type ZipLookup,
} from '../src/market/stats.js';
import { parseAwardSearch, parseTransactionSearch, pricesAtAward } from '../src/market/usaspending.js';
import { fx } from './helpers.js';

const response = (file: string): unknown => JSON.parse(fx(file)).response;
const nevada = parseAwardSearch(response('usaspending-awards-nv-238210.json')).rows;
const clarkPrices = pricesAtAward(parseTransactionSearch(response('usaspending-transactions-clark-238210.json')).rows);

/** The 36 real Nevada awards. Only the 27 in Clark County have a price at award (the transaction capture was Clark only). */
const awards: AwardPoint[] = nevada.map((a) => ({
  priceAtAward: clarkPrices.get(a.generatedInternalId)?.amount ?? null,
  actionDate: a.actionDate, zip: a.zip, county: a.county, state: a.state,
}));

/** The product's own ZIP lookup (src/geo/zip.ts, the `zipcodes` table), as the market routes use it. */
const realZip: ZipLookup = lookupZip;

const amounts = fc.array(fc.integer({ min: 1, max: 5_000_000_00 }).map((cents) => cents / 100), { minLength: 1, maxLength: 60 });

describe('percentile (linear interpolation between closest ranks, type 7)', () => {
  it('reproduces the research brief\'s reference numbers for the 36 Nevada awards', () => {
    const current = nevada.map((a) => a.currentAmount!);
    const s = priceStats(current)!;
    expect(s.count).toBe(36);
    expect(s.min).toBe(3380);
    expect(s.p25).toBeCloseTo(12271.75, 2);
    expect(s.median).toBeCloseTo(38209.62, 2);
    expect(s.p75).toBeCloseTo(82771.61, 2);
    expect(percentile(current, 0.9)).toBeCloseTo(166702.02, 2);
    expect(s.max).toBe(2838934.31);
  });

  it('works on small lists by hand', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(priceStats([])).toBeNull();
    expect(priceStats([7])).toEqual({ count: 1, min: 7, p25: 7, median: 7, p75: 7, max: 7 });
    expect(percentile([10, 20], 0.5)).toBe(15);
    expect(priceStats([4, 1, 3, 2])).toEqual({ count: 4, min: 1, p25: 1.75, median: 2.5, p75: 3.25, max: 4 });
    expect(priceStats([1, 2, 3, 4, 5])).toEqual({ count: 5, min: 1, p25: 2, median: 3, p75: 4, max: 5 });
  });

  it('refuses a percentile outside 0..1 and values that are not finite', () => {
    expect(() => percentile([1, 2], 1.5)).toThrow(/between 0 and 1/);
    expect(() => percentile([1, 2], Number.NaN)).toThrow(/between 0 and 1/);
    expect(() => priceStats([1, Number.NaN])).toThrow(/finite/);
    expect(() => percentile([1, Number.POSITIVE_INFINITY], 0.5)).toThrow(/finite/);
  });

  it('is ordered: min <= p25 <= median <= p75 <= max, and every one lies inside the data', () => {
    fc.assert(fc.property(amounts, (values) => {
      const s = priceStats(values)!;
      expect(s.count).toBe(values.length);
      expect(s.min).toBe(Math.min(...values));
      expect(s.max).toBe(Math.max(...values));
      expect(s.min).toBeLessThanOrEqual(s.p25);
      expect(s.p25).toBeLessThanOrEqual(s.median);
      expect(s.median).toBeLessThanOrEqual(s.p75);
      expect(s.p75).toBeLessThanOrEqual(s.max);
    }));
  });

  it('is monotonic in p', () => {
    fc.assert(fc.property(amounts, fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (values, a, b) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      expect(percentile(values, lo)!).toBeLessThanOrEqual(percentile(values, hi)!);
    }));
  });

  it('does not depend on the order of the values', () => {
    fc.assert(fc.property(amounts.chain((values) => fc.tuple(fc.constant(values), fc.shuffledSubarray(values, { minLength: values.length }))), ([values, shuffled]) => {
      expect(priceStats(shuffled)).toEqual(priceStats(values));
    }));
  });

  it('scales with the values: doubling every amount doubles every statistic', () => {
    fc.assert(fc.property(amounts, fc.constantFrom(2, 4, 0.5, 1024), (values, k) => {
      // Powers of two scale binary floating point exactly, so this holds to the last bit.
      const [s, scaled] = [priceStats(values)!, priceStats(values.map((v) => v * k))!];
      expect(scaled).toEqual({ count: s.count, min: s.min * k, p25: s.p25 * k, median: s.median * k, p75: s.p75 * k, max: s.max * k });
    }));
    fc.assert(fc.property(amounts, fc.double({ min: 0.01, max: 1000, noNaN: true }), (values, k) => {
      const [s, scaled] = [priceStats(values)!, priceStats(values.map((v) => v * k))!];
      for (const key of ['min', 'p25', 'median', 'p75', 'max'] as const) {
        expect(Math.abs(scaled[key] - s[key] * k)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(s[key] * k)));
      }
    }));
  });

  it('the median of an odd-length list is one of its values; of two values, their mean', () => {
    fc.assert(fc.property(amounts.filter((v) => v.length % 2 === 1), (values) => {
      expect(values).toContain(percentile(values, 0.5));
    }));
    fc.assert(fc.property(fc.integer({ min: 0, max: 1e6 }), fc.integer({ min: 0, max: 1e6 }), (a, b) => {
      expect(percentile([a, b], 0.5)).toBe((a + b) / 2);
    }));
  });
});

describe('similar awards: the ladder on real Nevada awards', () => {
  it('uses the ZIP radius when it holds 10 priced awards', () => {
    // 89191 = Nellis AFB. Every Clark County award sits within 50 miles of it.
    const r = selectSimilarAwards(awards, { zip: '89191', radiusMi: 50 }, { lookupZip: realZip });
    expect(r.level).toBe('zip_radius');
    expect(r.enough).toBe(true);
    expect(r.priced).toBe(27);
    expect(r.excludedNoPrice).toBe(0);
    expect(r.amountBasis).toBe('price_at_award');
    expect(r.stats).toMatchObject({ count: 27, min: 3380, median: 53488.85, max: 2838934.31 });
    expect(r.dateRange).toEqual({ from: '2025-03-18', to: '2026-08-21' });
    expect(r.place).toMatchObject({ state: 'NV', hasPoint: true, radiusMi: 50 });
    expect(r.ladder).toEqual([{ level: 'zip_radius', priced: 27, excludedNoPrice: 0 }]);
    // Newest first, and only awards inside the scope.
    expect(r.awards).toHaveLength(27);
    expect(r.awards[0]!.actionDate).toBe('2026-08-21');
    expect(r.awards.every((a) => a.county === 'CLARK')).toBe(true);
  });

  it('walks ZIP radius → county → state and says what each level held', () => {
    // 89502 = Reno. The five Washoe awards have no price at award in this capture.
    const r = selectSimilarAwards(awards, { zip: '89502', radiusMi: 30 }, { lookupZip: realZip });
    expect(r.ladder).toEqual([
      { level: 'zip_radius', priced: 0, excludedNoPrice: 5 },
      { level: 'county', priced: 0, excludedNoPrice: 5 },
      { level: 'state', priced: 27, excludedNoPrice: 9 },
    ]);
    expect(r.level).toBe('state');
    expect(r.place).toMatchObject({ state: 'NV', county: 'washoe' });
    expect(r.priced).toBe(27);
    expect(r.excludedNoPrice).toBe(9);
    expect(r.awards).toHaveLength(36);
    expect(r.stats?.count).toBe(27);
  });

  it('takes the county straight from the caller when it is given (a bid knows its county)', () => {
    const r = selectSimilarAwards(awards, { county: 'Clark County', state: 'nv', radiusMi: 25 }, { lookupZip: realZip });
    expect(r.ladder[0]).toEqual({ level: 'zip_radius', priced: 0, excludedNoPrice: 0, skipped: 'no_location' });
    expect(r.level).toBe('county');
    expect(r.priced).toBe(27);
  });

  it('shows no range under 10 priced awards, and never calls loaded states "the nation"', () => {
    const r = selectSimilarAwards(awards, { zip: '89502', radiusMi: 30 }, { lookupZip: realZip, minCount: 30 });
    expect(r.level).toBe('state');
    expect(r.enough).toBe(false);
    expect(r.stats).toBeNull();
    expect(r.priced).toBe(27);
    expect(r.dateRange).toEqual({ from: '2025-03-18', to: '2026-08-21' });
    expect(r.ladder.at(-1)).toEqual({ level: 'nation', priced: 0, excludedNoPrice: 0, skipped: 'not_loaded' });
  });

  it('uses the nation only when the caller says the whole country is loaded', () => {
    const r = selectSimilarAwards(awards, { zip: '89502', radiusMi: 30 }, { lookupZip: realZip, minCount: 30, nationwide: true });
    expect(r.level).toBe('nation');
    expect(r.ladder.at(-1)).toEqual({ level: 'nation', priced: 27, excludedNoPrice: 9 });
    expect(r.enough).toBe(false);
  });

  it('works out the state and county from awards in the same ZIP when the ZIP table knows nothing', () => {
    const r = selectSimilarAwards(awards, { zip: '89191', radiusMi: 50 }, { lookupZip: () => null });
    expect(r.ladder[0]).toMatchObject({ level: 'zip_radius', skipped: 'no_location' });
    expect(r.place).toMatchObject({ state: 'NV', county: 'clark', hasPoint: false });
    expect(r.level).toBe('county');
    expect(r.priced).toBe(27);
  });

  it('answers level null when the place cannot be resolved at all', () => {
    const r = selectSimilarAwards(awards, { zip: '99999', radiusMi: 50 }, { lookupZip: () => null });
    expect(r).toMatchObject({ level: null, enough: false, priced: 0, stats: null, awards: [], dateRange: null });
    expect(r.ladder.map((s) => s.skipped)).toEqual(['no_location', 'no_state', 'no_state', 'not_loaded']);
  });

  it('treats a missing, zero or negative price at award as "no price"', () => {
    expect(hasPriceAtAward({ priceAtAward: null })).toBe(false);
    expect(hasPriceAtAward({ priceAtAward: 0 })).toBe(false);
    expect(hasPriceAtAward({ priceAtAward: -171261 })).toBe(false);
    expect(hasPriceAtAward({ priceAtAward: 3380 })).toBe(true);
    expect(normalizeCounty('CLARK')).toBe(normalizeCounty('Clark County'));
    expect(normalizeCounty('Carson City')).toBe('carson city');
    expect(normalizeCounty('  ')).toBeNull();
  });
});

describe('similar awards: properties', () => {
  // TEST places on a line: ZIP "000NN" sits NN × 10 miles east of ZIP "00000" (about 0.1855° of longitude at 39° N).
  const testZip: ZipLookup = (zip) => (/^000\d\d$/.test(zip) ? { lat: 39, lng: -119 + Number(zip.slice(3)) * 0.1855, state: Number(zip.slice(3)) < 50 ? 'NV' : 'CA' } : null);
  const point = fc.record({
    priceAtAward: fc.option(fc.integer({ min: -5, max: 900_000 }), { nil: null }),
    actionDate: fc.option(fc.integer({ min: 1, max: 28 }).map((d) => `2026-03-${String(d).padStart(2, '0')}`), { nil: null }),
    zip: fc.option(fc.integer({ min: 0, max: 99 }).map((n) => `000${String(n).padStart(2, '0')}`), { nil: null }),
    county: fc.constantFrom('TEST ONE', 'TEST TWO', null),
    state: fc.constantFrom('NV', 'CA', null),
  });
  const where = fc.record({
    zip: fc.option(fc.integer({ min: 0, max: 99 }).map((n) => `000${String(n).padStart(2, '0')}`), { nil: null }),
    radiusMi: fc.integer({ min: 1, max: 400 }),
    county: fc.constantFrom('test one', null),
    state: fc.constantFrom('NV', null),
  });

  it('a range appears exactly when the floor is met; counts add up; the level is the first that meets the floor', () => {
    fc.assert(fc.property(fc.array(point, { maxLength: 80 }), where, fc.integer({ min: 1, max: 15 }), fc.boolean(), (rows, w, minCount, nationwide) => {
      const r = selectSimilarAwards(rows, w, { lookupZip: testZip, minCount, nationwide });
      expect(r.ladder.map((s) => s.level)).toEqual(AWARD_LADDER.slice(0, r.ladder.length));
      expect(r.enough).toBe(r.priced >= minCount);
      expect(r.stats !== null).toBe(r.enough);
      if (r.stats) expect(r.stats.count).toBe(r.priced);
      expect(r.priced + r.excludedNoPrice).toBe(r.awards.length);
      expect(r.awards.filter(hasPriceAtAward)).toHaveLength(r.priced);

      const tried = r.ladder.filter((s) => !s.skipped);
      const firstEnough = tried.find((s) => s.priced >= minCount);
      const used: AwardLevel | null = (firstEnough ?? tried.at(-1))?.level ?? null;
      expect(r.level).toBe(used);
      // Nothing after the level that met the floor is looked at.
      if (firstEnough) expect(r.ladder.at(-1)!.level).toBe(firstEnough.level);
      if (!nationwide) expect(r.level).not.toBe('nation');
      const dates = r.awards.filter(hasPriceAtAward).flatMap((a) => a.actionDate ?? []).sort();
      expect(r.dateRange).toEqual(dates.length ? { from: dates[0], to: dates.at(-1) } : null);
    }));
  });

  it('the default floor is 10 priced awards', () => {
    expect(MIN_PRICED_AWARDS).toBe(10);
    const nine: AwardPoint[] = Array.from({ length: 9 }, (_, i) => ({ priceAtAward: 1000 + i, actionDate: '2026-01-05', zip: null, county: null, state: 'NV' }));
    const unpriced: AwardPoint = { priceAtAward: null, actionDate: '2026-02-01', zip: null, county: null, state: 'NV' };
    const short = selectSimilarAwards([...nine, unpriced], { state: 'NV', radiusMi: 50 }, { lookupZip: () => null });
    expect(short).toMatchObject({ level: 'state', enough: false, priced: 9, excludedNoPrice: 1, stats: null });
    const ten = selectSimilarAwards([...nine, { ...unpriced, priceAtAward: 5000 }], { state: 'NV', radiusMi: 50 }, { lookupZip: () => null });
    expect(ten).toMatchObject({ level: 'state', enough: true, priced: 10, excludedNoPrice: 0 });
    expect(ten.stats).toMatchObject({ count: 10, min: 1000, max: 5000 });
  });

  it('a ZIP radius only holds awards inside the radius', () => {
    const rows: AwardPoint[] = Array.from({ length: 30 }, (_, i) => ({ priceAtAward: 100 + i, actionDate: null, zip: `000${String(i).padStart(2, '0')}`, county: null, state: 'NV' }));
    // 10-mile steps: a 95-mile radius around "00000" reaches "00009" (90 mi) but not "00010" (100 mi).
    const r = selectSimilarAwards(rows, { zip: '00000', radiusMi: 95 }, { lookupZip: testZip });
    expect(r.level).toBe('zip_radius');
    expect(r.awards.map((a) => a.zip).sort()).toEqual(rows.slice(0, 10).map((a) => a.zip));
    expect(r.dateRange).toBeNull();
  });
});

describe('minimum-guarantee orders are placeholders, not job prices', () => {
  // 33 real California awards signed 2026-06-24 to 2026-06-26 (captured 2026-11-13), with their real Mod 0 amounts.
  // 22 are $1,000 orders described as a minimum guarantee on NASA's WRMACC contracts; 11 are not.
  const rows = parseAwardSearch(response('usaspending-awards-ca-minimum-guarantee.json')).rows;
  const mod0 = pricesAtAward(parseTransactionSearch(response('usaspending-transactions-ca-minimum-guarantee.json')).rows);
  const california: AwardPoint[] = rows.map((a) => ({
    priceAtAward: mod0.get(a.generatedInternalId)?.amount ?? null, description: a.description,
    actionDate: a.actionDate, zip: a.zip, county: a.county, state: a.state,
  }));

  it('spots them by their own wording, in every spelling seen live, and nothing else', () => {
    expect(rows).toHaveLength(33);
    expect(california.every((a) => typeof a.priceAtAward === 'number' && a.priceAtAward > 0)).toBe(true);
    const flagged = rows.filter(isMinimumGuarantee);
    expect(flagged).toHaveLength(22);
    expect([...new Set(flagged.map((a) => a.description))].sort()).toEqual(['WRMACC MIN GUARANTEE SHEMP', 'WRMACC MINIMUM GUARANTEE', 'WRMACC MINIMUM GUARANTEE SHEMP']);
    expect(flagged.every((a) => mod0.get(a.generatedInternalId)!.amount === 1000)).toBe(true);
    // Other descriptions from the same live capture (Nevada and California pages).
    for (const description of [
      'MINIMUM GUARANTEE TASK ORDER', 'OBLIGATE MINIMUM GUARANTEE', 'MULTIPLE AWARD IDIQ CONTRACT FOR CONSTRUCTION SERVICES MIN. GUARANTEE TASK ORDER',
      'SIMPLIFIED ACQUISITION OF BASE ENGINEERING REQUIREMENTS (SABER) MINIMUM GUARANTEE', 'REGION 3 MIN GURANTEE', 'AZ034 REGION 3 MATOC MIN GUARANTEE',
    ]) expect(isMinimumGuarantee({ description }), description).toBe(true);
    for (const description of [
      'WRMACC SHEMP', 'WRMACC NOR CAL SEED PROJECT FOR HVAC REMOVAL AND REPLACEMENT', 'YOSE-HVAC MATOC/IDIQ MINIMUM REQUIREMENT', 'BUILDING AUTOMATION SYSTEM', '', null, undefined,
    ]) expect(isMinimumGuarantee({ description }), String(description)).toBe(false);
  });

  it('leaves them out of the range and counts them with the awards that have no price', () => {
    const r = selectSimilarAwards(california, { state: 'CA', radiusMi: 30 }, { lookupZip: () => null });
    expect(r).toMatchObject({ level: 'state', enough: true, priced: 11, excludedNoPrice: 22 });
    // Four more $1,000 orders say only "WRMACC SHEMP": no wording to go by, so they stay in (and the label says what the amount is).
    expect(r.stats).toEqual({ count: 11, min: 1000, p25: 1000, median: 25265, p75: 207062.43, max: 32709104 });
    expect(r.awards).toHaveLength(33);
    expect(r.awards.filter(hasPriceAtAward)).toHaveLength(11);

    // What the same awards said before: three quarters of the "prices" were the $1,000 placeholder.
    const unfiltered = selectSimilarAwards(california.map((a) => ({ ...a, description: null })), { state: 'CA', radiusMi: 30 }, { lookupZip: () => null });
    expect(unfiltered.stats).toMatchObject({ count: 33, p25: 1000, median: 1000, p75: 1000 });
  });

  it('a row without a description is judged on its amount alone', () => {
    expect(hasPriceAtAward({ priceAtAward: 1000 })).toBe(true);
    expect(hasPriceAtAward({ priceAtAward: 1000, description: 'WRMACC MINIMUM GUARANTEE SHEMP' })).toBe(false);
    expect(hasPriceAtAward({ priceAtAward: 0, description: 'REPLACE AHU 2273' })).toBe(false);
    expect(hasPriceAtAward({ priceAtAward: null, description: 'REPLACE AHU 2273' })).toBe(false);
  });
});

describe('loadedSpan: what a place is loaded for (TEST coverage rows: dates only, nothing a user sees)', () => {
  const row = (scope: string, naics: string, fromDate: string, toDate: string): CoverageSpan => ({ scope, naics, fromDate, toDate });
  const nv = [row('NV', '238210', '2024-11-13', '2026-11-13'), row('NV', '238220', '2025-03-01', '2026-11-10')];

  it('answers the stretch every code is loaded for, and null when one never was', () => {
    expect(loadedSpan(nv, ['238210'], 'NV', '2024-11-13')).toEqual({ from: '2024-11-13', to: '2026-11-13' });
    // Two codes: from the later start to the earlier end.
    expect(loadedSpan(nv, ['238210', '238220'], 'NV', '2024-11-13')).toEqual({ from: '2025-03-01', to: '2026-11-10' });
    expect(loadedSpan(nv, ['238210', '561621'], 'NV', '2024-11-13')).toBeNull();
    expect(loadedSpan(nv, ['238210'], 'AZ', '2024-11-13')).toBeNull();
    expect(loadedSpan(nv, ['238210'], null, '2024-11-13')).toBeNull();
    expect(loadedSpan(nv, [], 'NV', '2024-11-13')).toBeNull();
    expect(loadedSpan([], ['238210'], 'NV', '2024-11-13')).toBeNull();
  });

  it('a pull that ended before the window starts does not count: that period was never pulled', () => {
    const old = [row('NV', '238210', '2024-01-10', '2024-06-10')];
    expect(loadedSpan(old, ['238210'], 'NV', '2026-07-13')).toBeNull();
    expect(loadedSpan(old, ['238210'], 'NV', '2024-06-10')).toEqual({ from: '2024-01-10', to: '2024-06-10' });
    expect(loadedSpan(old, ['238210'], 'NV', '')).toEqual({ from: '2024-01-10', to: '2024-06-10' });
  });

  it('a nationwide pull loads every state; overlapping pulls join, and a hole between two is never covered', () => {
    const us = [row('US', '238210', '2025-11-13', '2026-11-13')];
    expect(loadedSpan(us, ['238210'], 'OR', '2024-11-13')).toEqual({ from: '2025-11-13', to: '2026-11-13' });
    expect(loadedSpan(us, ['238210'], null, '2024-11-13')).toEqual({ from: '2025-11-13', to: '2026-11-13' });
    expect(loadedSpan(us, ['238210'], 'OR', '2024-11-13', 'ALL')).toBeNull();
    // The state's own pull reaches further back and overlaps the nationwide one: one stretch.
    expect(loadedSpan([...us, row('NV', '238210', '2024-11-13', '2026-01-10')], ['238210'], 'NV', '2024-11-13')).toEqual({ from: '2024-11-13', to: '2026-11-13' });
    // The state's own pull ended before the nationwide one began: only the newer stretch counts.
    expect(loadedSpan([...us, row('NV', '238210', '2024-11-13', '2025-06-30')], ['238210'], 'NV', '2024-11-13')).toEqual({ from: '2025-11-13', to: '2026-11-13' });
  });

  it('never claims a day outside a pull of every code', () => {
    const day = fc.integer({ min: 0, max: 371 }).map((n) => `2025-${String(1 + Math.floor(n / 31)).padStart(2, '0')}-${String(1 + (n % 31)).padStart(2, '0')}`);
    const pull = fc.tuple(fc.constantFrom('NV', 'US'), fc.constantFrom('238210', '238220'), day, day)
      .map(([scope, naics, a, b]) => row(scope, naics, a < b ? a : b, a < b ? b : a));
    fc.assert(fc.property(fc.uniqueArray(pull, { maxLength: 4, selector: (p) => `${p.scope}:${p.naics}` }), fc.subarray(['238210', '238220'], { minLength: 1 }), day, (coverage, codes, since) => {
      const span = loadedSpan(coverage, codes, 'NV', since);
      if (!span) return;
      expect(span.from <= span.to).toBe(true);
      expect(span.to >= since).toBe(true);
      for (const code of codes) {
        const pulls = coverage.filter((p) => p.naics === code);
        // Both ends of the answer sit inside a pull of this code, and so does every pull boundary between them.
        for (const edge of [span.from, span.to]) expect(pulls.some((p) => p.fromDate <= edge && edge <= p.toDate)).toBe(true);
        const earliest = pulls.map((p) => p.fromDate).sort()[0]!;
        const latest = pulls.map((p) => p.toDate).sort().at(-1)!;
        expect(span.from >= earliest && span.to <= latest).toBe(true);
      }
    }));
  });
});
