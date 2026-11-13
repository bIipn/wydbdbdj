import { describe, expect, it } from 'vitest';
import { locate, milesBetween } from '../src/geo/locate.js';
import { loadProfile } from '../src/profiles.js';
import { finalizeBid } from '../src/scan.js';
import { compileKeywords, scoreBid } from '../src/score/score.js';
import type { BidDraft } from '../src/types.js';

const profile = loadProfile('lm-electric');
const NOW = new Date('2026-11-11T20:00:00Z');

function draft(over: Partial<BidDraft>): BidDraft {
  return {
    source: 'questcdn', sourceId: Math.random().toString(36).slice(2), sourceName: 'Test', title: 'Untitled',
    agency: null, description: null, category: null, location: { state: 'NV' }, postedAt: null,
    dueAt: '2026-12-01T22:00:00.000Z', estValue: null, naics: null, setAside: null, url: 'https://example.gov', ...over,
  };
}
const score = (over: Partial<BidDraft>) => scoreBid(finalizeBid(draft(over)), profile, NOW);

describe('keywords', () => {
  it('matches whole words and prefixes', () => {
    const m = compileKeywords(['led', 'electric*', 'fire alarm*']);
    expect(m.test('LED Conversion Project')).toBe('led');
    expect(m.test('Installed by the county')).toBeNull(); // "led" inside "installed" doesn't count
    expect(m.test('Electrical Improvements')).toBe('electric');
    expect(m.test('Fire  Alarms upgrade')).toBe('fire alarm');
  });
});

describe('geo', () => {
  it('resolves truncated cities, counties, text and agencies', () => {
    expect(locate({ title: 'x', description: null, agency: null, location: { city: 'Carson Cit', state: 'NV' } }).label).toBe('Carson City, NV');
    expect(locate({ title: 'x', description: null, agency: null, location: { county: 'Lyon', state: 'NV' } }).label).toBe('Lyon County, NV');
    expect(locate({ title: 'Pier lighting at Zephyr Cove', description: null, agency: null, location: { state: 'NV' } }).city).toBe('Zephyr Cove');
    expect(locate({ title: 'Gaming Concession', description: null, agency: 'Reno-Tahoe Airport Authority', location: {} }).city).toBe('Reno');
    expect(locate({ title: 'Northern Nevada - HVAC', description: null, agency: null, location: { state: 'NV' } }).precision).toBe('region');
    expect(locate({ title: 'Generator', description: null, agency: 'Dept of Agriculture', location: { state: 'NV' } }).precision).toBe('state');
    // a town in the text beats the county seat
    expect(locate({ title: 'Stateline Pier Lighting', description: null, agency: null, location: { county: 'Douglas', state: 'NV' } }).city).toBe('Stateline');
    expect(locate({ title: 'Sewer Repair', description: null, agency: null, location: { county: 'Douglas', state: 'NV' } }).label).toBe('Douglas County, NV');
  });
  it('measures straight-line miles', () => {
    expect(Math.round(milesBetween(profile.base, { lat: 39.1638, lng: -119.7674 }))).toBe(15); // Gardnerville → Carson City
  });
});

describe('fit score', () => {
  it('ranks close electrical work as great', () => {
    const s = score({ title: 'LED Lighting Retrofit — Minden Library', location: { city: 'Minden', state: 'NV' }, estValue: { min: 30000, max: 30000 } });
    expect(s.verdict).toBe('great');
    expect(s.score).toBeGreaterThanOrEqual(90);
    expect(s.reasons[0]).toEqual({ kind: 'plus', text: 'Electrical scope: “lighting”' });
  });

  it('rejects other industries even when close', () => {
    const s = score({ title: 'Janitorial Services', location: { city: 'Gardnerville', state: 'NV' } });
    expect(s.score).toBe(0);
    expect(s.rejected).toBe('Not your trade (“janitorial”)');
  });

  it('lets a strong electrical title beat an exclude word', () => {
    expect(score({ title: 'EV Charging Stations for Fleet Vehicles', location: { city: 'Carson City', state: 'NV' } }).verdict).toBe('great');
  });

  it('rejects work outside the range and past deadlines', () => {
    expect(score({ title: 'Fire Alarm Upgrade', location: { city: 'North Las Vegas', state: 'NV' } }).rejected).toMatch(/outside your 90 mi range/);
    expect(score({ title: 'Electrical Repairs', location: { city: 'Minden', state: 'NV' }, dueAt: '2026-11-01T22:00:00.000Z' }).rejected).toBe('Bid deadline has passed');
  });

  it("doesn't let distance alone make a non-electrical job look good", () => {
    const road = score({ title: 'Muller Parkway Improvements', location: { city: 'Minden', state: 'NV' } });
    expect(road.verdict).toBe('skip');
    const roof = score({ title: 'Roofing Replacement, State Museum', location: { city: 'Carson City', state: 'NV' } });
    expect(roof.score).toBeLessThan(15);
  });

  it('flags set-asides L&M may not qualify for', () => {
    const s = score({ title: 'Repair Electrical Distribution', naics: '238210', setAside: 'SDVOSBC', location: { city: 'Reno', state: 'NV' } });
    expect(s.reasons.some((r) => r.text.startsWith('Service-disabled veteran set-aside'))).toBe(true);
    const sb = score({ title: 'Repair Electrical Distribution', naics: '238210', setAside: 'SBA', location: { city: 'Reno', state: 'NV' } });
    expect(sb.score).toBeGreaterThan(s.score);
  });

  it('marks tight deadlines and big jobs', () => {
    const s = score({
      title: 'Generator Replacement', location: { city: 'Carson City', state: 'NV' },
      dueAt: '2026-11-14T22:00:00.000Z', estValue: { min: 1_200_000, max: 1_200_000 },
    });
    expect(s.reasons).toEqual(expect.arrayContaining([
      { kind: 'minus', text: 'Only 3 days to bid' },
      { kind: 'minus', text: 'Est. $1.2M — large job; sub to the GC?' },
    ]));
  });
});
