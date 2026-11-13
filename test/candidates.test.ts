/**
 * The candidate filter (src/score/candidates.ts) may only leave out bids the scorer would call a hard no.
 * Proof on REAL bids: every captured board page, the SAM.gov API captures and the bulk-file sample (all its rows,
 * past due or not), scored with the real scorer for the pilot and the 16 simulated companies, at the capture
 * time and at a clock before every deadline (so "past due" cannot hide a wrongly dropped bid).
 * Companies other than the pilot are simulated; their ZIPs are real.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '../src/profile/build.js';
import { loadProfile } from '../src/profiles.js';
import { finalizeBid } from '../src/scan.js';
import { CANDIDATE_MIN_EXTRA_MI, CANDIDATE_MIN_MI, CANDIDATE_RADIUS_MULTIPLE, candidateLimitMi, isCandidate } from '../src/score/candidates.js';
import { scoreBid } from '../src/score/score.js';
import { PERSONAS } from '../src/sim/personas.js';
import { scaleAnswers } from '../src/sim/run.js';
import { mergeDrafts } from '../src/sources/dedupe.js';
import { fixtureReaders } from '../src/sources/fixtures.js';
import { parseSamBulk } from '../src/sources/samgov-bulk.js';
import type { Bid, Profile } from '../src/types.js';
import { CAPTURED, testBid, testProfile } from './helpers.js';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;
const BULK = new Uint8Array(readFileSync(new URL('./fixtures/samgov-bulk-sample.csv', import.meta.url)));

/** Every real captured bid, one card per id, located the way the scan locates them. */
const BIDS: Bid[] = mergeDrafts([
  ...fixtureReaders(FIXTURES, { samgov: true }).flatMap((r) => r.read()),
  ...parseSamBulk(BULK).drafts, // no `now`: past-due notices too, for more places
]).map(finalizeBid);

const COMPANIES: Profile[] = [loadProfile('lm-electric'), ...PERSONAS.map((p) => buildProfile(`cand-${p.key}`, p.answers))];
const CLOCKS = [CAPTURED, new Date('2026-01-01T00:00:00Z')];

describe('isCandidate never drops a bid worth a look (real bids, real scorer)', () => {
  it(`${COMPANIES.length} companies × every captured bid: anything dropped scores 0, a hard no`, () => {
    expect(BIDS.length).toBeGreaterThan(120);
    let dropped = 0;
    let keptWorthALook = 0;
    const leaks: string[] = [];
    for (const now of CLOCKS) {
      for (const p of COMPANIES) {
        for (const b of BIDS) {
          const s = scoreBid(b, p, now);
          if (isCandidate(p, b)) {
            if (s.verdict !== 'skip') keptWorthALook++;
            continue;
          }
          dropped++;
          if (s.verdict !== 'skip' || s.score !== 0 || !s.rejected) leaks.push(`${p.id} ${b.id} ${s.verdict} ${s.score}`);
        }
      }
    }
    expect(leaks).toEqual([]);
    // The test proves something only if the filter both drops bids and keeps good ones.
    expect(dropped).toBeGreaterThan(400); // 562 on the 2026-11-13 captures (281 per clock)
    expect(keptWorthALook).toBeGreaterThan(50);
  });

  it('the same holds for 300 simulated companies anywhere in the US (seeded ZIPs, radii 25–300 mi)', () => {
    const zipcodes = createRequire(import.meta.url)('zipcodes') as { codes: Record<string, { zip: string; country: string; state: string }> };
    const zips = Object.values(zipcodes.codes).filter((z) => z.country === 'US' && !['AA', 'AE', 'AP'].includes(z.state)).map((z) => z.zip).sort();
    let seed = 99;
    const next = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const profiles: Profile[] = [];
    for (const a of scaleAnswers(4242, 400)) {
      if (profiles.length === 300) break;
      try {
        profiles.push(buildProfile(`cand-us-${profiles.length + 1}`, { ...a, zip: zips[Math.floor(next() * zips.length)]! }));
      } catch {
        // a ZIP the builder cannot place: skip it
      }
    }
    expect(profiles).toHaveLength(300);
    const leaks: string[] = [];
    let dropped = 0;
    for (const p of profiles) for (const b of BIDS) {
      if (isCandidate(p, b)) continue;
      dropped++;
      const s = scoreBid(b, p, CLOCKS[1]);
      if (s.verdict !== 'skip' || s.score !== 0) leaks.push(`${p.id} ${b.id} ${s.verdict} ${s.score}`);
    }
    expect(leaks).toEqual([]);
    expect(dropped).toBeGreaterThan(10_000);
  });
});

describe('the rule, case by case', () => {
  const p = testProfile('test-cand'); // the pilot: Gardnerville NV, 90 mi, states NV + CA

  it('a placed bid is kept out to 2× the radius, never less than radius + 100 mi, and never less than 150 mi', () => {
    expect(CANDIDATE_RADIUS_MULTIPLE).toBe(2);
    expect(CANDIDATE_MIN_EXTRA_MI).toBe(100);
    expect(CANDIDATE_MIN_MI).toBe(150); // Browse's widest distance chip (web/js/filters.js DISTANCES)
    expect(candidateLimitMi({ maxDistanceMi: 90 })).toBe(190);
    expect(candidateLimitMi({ maxDistanceMi: 25 })).toBe(150); // was 125: "Within 150 mi" missed out-of-state bids
    expect(candidateLimitMi({ maxDistanceMi: 10 })).toBe(150);
    const chips = /export const DISTANCES = \[([\d,\s]+)\]/.exec(readFileSync(new URL('../web/js/filters.js', import.meta.url), 'utf8'))![1]!;
    expect(Math.max(...chips.split(',').map(Number))).toBe(CANDIDATE_MIN_MI);
    expect(candidateLimitMi({ maxDistanceMi: 300 })).toBe(600);
  });

  it('far out of state: dropped; the same distance in one of their states: kept (Browse shows "253 mi away")', () => {
    const boise = testBid({ location: { city: 'Boise', state: 'ID', zip: '83702' } }); // 373 mi, Idaho
    const elko = testBid({ location: { city: 'Spring Creek', state: 'NV', zip: '89815' } }); // 253 mi, Nevada
    expect(isCandidate(p, boise)).toBe(false);
    expect(isCandidate(p, elko)).toBe(true);
    expect(scoreBid(elko, p, CAPTURED).rejected).toMatch(/outside your 90 mi range/);
  });

  it('out of state: kept inside the margin, dropped past it', () => {
    const lakeview = testBid({ location: { city: 'Lakeview', state: 'OR', zip: '97630' } }); // 227 mi, Oregon
    expect(isCandidate(p, lakeview)).toBe(false); // 90 mi radius → 190 mi
    expect(isCandidate({ ...p, maxDistanceMi: 120 }, lakeview)).toBe(true); // 120 mi radius → 240 mi
    expect(scoreBid(lakeview, { ...p, maxDistanceMi: 120 }, CAPTURED).rejected).toMatch(/227 mi away/);
  });

  it('unplaced: kept in one of their states or with no state; dropped in another state', () => {
    const at = (state: string | null) => testBid({ location: { state, label: state ? `${state} (location not listed)` : null } });
    expect(isCandidate(p, at('NV'))).toBe(true);
    expect(isCandidate(p, at(null))).toBe(true);
    expect(isCandidate(p, at('TX'))).toBe(false);
    expect(scoreBid(at('TX'), p, CAPTURED).rejected).toBe('Out of your states (TX)');
  });
});
