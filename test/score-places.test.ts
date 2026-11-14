import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildProfile, validateAnswers } from '../src/profile/build.js';
import { loadProfile } from '../src/profiles.js';
import { finalizeBid, mayAnnounce } from '../src/scan.js';
import { areaCounties, nearestSeatMiles } from '../src/geo/california.js';
import { isCandidate } from '../src/score/candidates.js';
import { AREA_REACH_EXTRA_MI, BELOW_ALERT_CAP, CAPPED_FLOOR, scoreBid } from '../src/score/score.js';
import { STATEWIDE_BOARDS, statewideSiteReason } from '../src/sources/statewide.js';
import type { Bid, BidLocation, LocationPrecision, Profile, SourceId } from '../src/types.js';

// SIMULATED companies (labelled TEST): an electrician at River Pines, CA (95675, Amador County), the owner's own ZIP.
const NOW = new Date('2026-11-14T08:30:00Z');
function company(name: string, zip: string, radiusMi: number, states: string[]): Profile {
  const v = validateAnswers({ businessName: name, trades: ['electrical'], zip, radiusMi, valueRange: { min: 0, max: 1_000_000 } });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return { ...buildProfile(name.toLowerCase().replace(/\W+/g, '-'), v.value), states };
}
const ca60 = company('TEST CA Electric 60 (simulated)', '95675', 60, ['CA']);
const pilot = loadProfile('lm-electric'); // Gardnerville, NV; states NV + CA

// Real Cal eProcure rows of 2026-11-14 (titles verbatim, test/fixtures/caleprocure-grid.html).
const cal = (sourceId: string, title: string, agency = 'Department of Transportation'): Bid => finalizeBid({
  source: 'caleprocure', sourceId, sourceName: 'Cal eProcure (State of California)', title, agency, description: null,
  category: 'State solicitation', location: { state: 'CA' }, postedAt: null, dueAt: '2026-12-10T22:00:00.000Z',
  estValue: null, naics: null, setAside: null, url: `https://caleprocure.ca.gov/event/${sourceId.replace('-', '/')}`,
  solNumber: sourceId.slice(sourceId.indexOf('-') + 1),
});

const D10 = cal('2660-10-1H0204', 'Curb ramp, CRCP, JPCP, HMA, electrical, erosion control, and planting.');
const D3 = cal('2660-03-1N7504', 'Construct sound wall, drainage, and electrical.');
const D5 = cal('2660-05-1R5704', 'Install lighting, striping, and signage upgrades.');
const SHASTA = cal('2660-02A2557', 'Gate Operator Replacement Services in Shasta County');
const ALARM = cal('5225-0000040654', 'C5613538-D - Fire Alarm System Installation Services', 'Dept of Corrections & Rehab');
const TMS3 = cal('2660-56A0916', 'IFB 56A0916 Maintenance and Repair of the Transportation Management Systems (TMS) Elements and ' +
  'Communications Infrastructure in Butte, Colusa, El Dorado, Glenn, Nevada, Placer, Sacramento, Sierra, Sutter, Yolo, and Yuba Counties.');

describe('an area (several counties, a Caltrans district): no point, no miles', () => {
  it('District 10 for a company in Amador County: a capped maybe that names the area, never announced', () => {
    expect(D10.location).toMatchObject({ precision: 'region', lat: null });
    const r = scoreBid(D10, ca60, NOW);
    expect(r.distanceMi).toBeNull();
    expect(r.rejected).toBeNull();
    expect(r.capped).toBe(true);
    expect(r.score).toBeLessThanOrEqual(BELOW_ALERT_CAP);
    expect(r.reasons.map((x) => x.text)).toContain(
      'Site not named — somewhere in Caltrans District 10: Alpine, Amador, Calaveras + 5 more counties; open the listing to see where',
    );
    expect(r.reasons.some((x) => /\d+ mi\b/.test(x.text))).toBe(false); // no distance is shown for an area
    expect(mayAnnounce(r, 35)).toBe(false);
    expect(isCandidate(ca60, D10)).toBe(true);
  });

  it('District 3 (Placerville, the El Dorado seat, is ~25 mi from 95675) and the TMS program in reach', () => {
    for (const b of [D3, TMS3]) {
      const r = scoreBid(b, ca60, NOW);
      expect(r.rejected, b.title).toBeNull();
      expect(r.capped, b.title).toBe(true);
      expect(r.distanceMi).toBeNull();
    }
  });

  it('District 5 (Monterey … Santa Cruz) is out of reach: a hard no that says what was measured (to the seat)', () => {
    const r = scoreBid(D5, ca60, NOW);
    expect(r.score).toBe(0);
    expect(r.rejected).toMatch(
      /^The nearest county seat named is \d+ mi away — outside your 60 mi range \(site not named: Caltrans District 5: Monterey, San Benito, San Luis Obispo \+ 2 more counties\)$/,
    );
    expect(r.distanceMi).toBeNull();
  });

  it(`reach = the nearest county seat within radius + ${AREA_REACH_EXTRA_MI} mi`, () => {
    const near = nearestSeatMiles(ca60.base, areaCounties(D5.location)!);
    expect(near).toBeGreaterThan(85);
    const at = Math.ceil(near) - AREA_REACH_EXTRA_MI;
    expect(scoreBid(D5, { ...ca60, maxDistanceMi: at }, NOW).rejected).toBeNull();
    expect(scoreBid(D5, { ...ca60, maxDistanceMi: at - 1 }, NOW).rejected).toMatch(/^The nearest county seat named is/);
  });

  it('District 12 (Orange County alone) is an area too: no point, no miles, never an uncapped fit', () => {
    const D12 = cal('2660-12-0K7204', 'Const bridge, RW, pavement, drainage, and electrical systems.');
    expect(D12.location).toMatchObject({ precision: 'region', county: 'Orange', lat: null, label: 'Caltrans District 12: Orange County' });
    const irvine = company('TEST Irvine Electric (simulated)', '92618', 30, ['CA']);
    const r = scoreBid(D12, irvine, NOW);
    expect(r.distanceMi).toBeNull();
    expect(r.capped).toBe(true);
    expect(r.score).toBeLessThanOrEqual(BELOW_ALERT_CAP);
    expect(r.reasons.map((x) => x.text)).toContain('Site not named — somewhere in Caltrans District 12: Orange County; open the listing to see where');
  });
});

describe('one county and no town: an area of one county (the seat is not the job)', () => {
  it('Shasta County: no point stored, no miles, a no that names the seat for 95675 at 60 mi, a capped maybe at 200 mi', () => {
    expect(SHASTA.location).toMatchObject({ precision: 'region', county: 'Shasta', lat: null, label: 'Shasta County, CA (site not named)' });
    const r = scoreBid(SHASTA, ca60, NOW);
    expect(r.rejected).toMatch(/^Shasta County's seat is \d+ mi away — outside your 60 mi range \(site not named: Shasta County\)$/);
    const wide = scoreBid(SHASTA, { ...ca60, maxDistanceMi: 200 }, NOW);
    expect(wide.distanceMi).toBeNull();
    expect(wide.capped).toBe(true);
    expect(wide.reasons.map((x) => x.text)).toContain('Site not named — somewhere in Shasta County; open the listing to see where');
  });

  it('an older row placed at a California county seat (precision county, no town) shows no miles either', () => {
    const seat = { ...SHASTA, location: { ...SHASTA.location, precision: 'county' as const, lat: 40.5865, lng: -122.3917 } };
    const r = scoreBid(seat, { ...ca60, maxDistanceMi: 200 }, NOW);
    expect(r.distanceMi).toBeNull();
    expect(r.capped).toBe(true);
  });

  it('LA County rows from RAMP (a county, no town) become an area of Los Angeles County', () => {
    const ramp = finalizeBid({
      source: 'laramp', sourceId: 'TEST-HS', sourceName: 'LA RAMP', title: 'Guardrail Services (TEST)', agency: 'Los Angeles County',
      description: null, category: null, location: { county: 'Los Angeles', state: 'CA' }, postedAt: null, dueAt: '2026-12-10T22:00:00.000Z',
      estValue: null, naics: null, setAside: null, url: 'https://example.gov',
    });
    expect(ramp.location).toMatchObject({ precision: 'region', county: 'Los Angeles', lat: null, label: 'Los Angeles County, CA (site not named)' });
    const lancaster = company('TEST Lancaster Electric (simulated)', '93534', 40, ['CA']);
    expect(scoreBid(ramp, lancaster, NOW).distanceMi).toBeNull();
  });
});

describe('a SAM.gov notice that names only the state (real row 127EAW27Q0002, SAM.gov 2026-11-14)', () => {
  const FRENCHMAN: Bid = {
    id: 'samgov:127EAW27Q0002', source: 'samgov', sourceId: '127EAW27Q0002', sourceName: 'SAM.gov (federal)',
    title: 'Forest Service - Solar Batteries Frenchman Work Center', agency: 'Agriculture, Department of · Usda-fs, CSA Southwest 6',
    description: 'Combined Synopsis/Solicitation · Small Business Set Aside - Total · Sol. 127EAW27Q0002', category: 'Combined Synopsis/Solicitation',
    location: { city: null, county: null, state: 'CA', zip: null, lat: null, lng: null, precision: 'state', label: 'CA (location not listed)' },
    postedAt: '2026-11-13T16:00:00.000Z', dueAt: '2026-11-20T19:00:00.000Z', estValue: null, naics: '238210', setAside: 'SBA',
    url: 'https://sam.gov/workspace/contract/opp/947d8224bedf440ead306123e27b7be5/view', flags: [], solNumber: '127EAW27Q0002', psc: 'N061',
  };
  it('a California company: capped (never an alert), no distance, a reason that says only the state is known', () => {
    const r = scoreBid(FRENCHMAN, { ...ca60, setAsidesEligible: ['SBA'] }, NOW);
    expect(r.capped).toBe(true);
    expect(r.distanceMi).toBeNull();
    expect(r.score).toBeLessThanOrEqual(BELOW_ALERT_CAP);
    expect(mayAnnounce(r, 35)).toBe(false);
    expect(r.reasons.map((x) => x.text)).toContain('Work site not named on the notice — only the state is known (CA); open it to see where');
  });
});

describe('a statewide board card with no site', () => {
  it('in its own state: a capped maybe with the "could be anywhere" reason, no miles', () => {
    expect(ALARM.location).toMatchObject({ precision: 'state', lat: null });
    const r = scoreBid(ALARM, ca60, NOW);
    expect(r.capped).toBe(true);
    expect(r.score).toBeLessThanOrEqual(BELOW_ALERT_CAP);
    expect(r.score).toBeGreaterThanOrEqual(CAPPED_FLOOR); // fire alarm installation, electrical: still worth a look
    expect(r.distanceMi).toBeNull();
    expect(r.reasons.map((x) => x.text)).toContain(statewideSiteReason('California'));
    expect(mayAnnounce(r, 35)).toBe(false);
  });

  it('for a company based in another state (the pilot, Nevada): held at 34, tier other (Browse only)', () => {
    const r = scoreBid(ALARM, pilot, NOW);
    expect(r.score).toBeLessThanOrEqual(CAPPED_FLOOR - 1);
    expect(r.tier).toBe('other');
    expect(r.capped).toBe(true);
    expect(r.rejected).toBeNull();
  });

  it('a statewide board card that names only a county it could not place is held at 34 for a company based in another state', () => {
    const or = finalizeBid({
      source: 'oregonbuys', sourceId: 'TEST-OR', sourceName: 'OregonBuys', title: 'Woodburn Health Remodel (TEST)', agency: null,
      description: null, category: null, location: { state: 'OR', county: 'Marion', label: 'Marion County, OR' }, postedAt: null,
      dueAt: '2026-12-10T22:00:00.000Z', estValue: null, naics: null, setAside: null, url: 'https://example.gov',
    });
    expect(or.location.lat).toBeNull();
    const boise = { ...company('TEST Boise Electric (simulated)', '83702', 100, ['ID', 'OR']), trades: ['electrical', 'general-building'] };
    const r = scoreBid(or, boise, NOW);
    expect(r.score).toBeLessThanOrEqual(CAPPED_FLOOR - 1);
    expect(r.tier).toBe('other');
  });

  it('a Nevada board card with no site keeps its rule for the pilot (no "could be anywhere")', () => {
    const nv = finalizeBid({
      source: 'nevadaepro', sourceId: 'TEST-1', sourceName: 'NevadaEPro', title: 'Electrical Panel Replacement (TEST)', agency: null,
      description: null, category: null, location: { state: 'NV' }, postedAt: null, dueAt: '2026-12-10T22:00:00.000Z',
      estValue: null, naics: null, setAside: null, url: 'https://example.gov',
    });
    const r = scoreBid(nv, pilot, NOW);
    expect(r.capped).toBeUndefined();
    expect(r.reasons.map((x) => x.text)).toContain('Work location not listed — check the bid');
  });

  it('the table never holds a Nevada board', () => {
    for (const id of ['nevadaepro', 'ngem', 'questcdn', 'douglascounty', 'samgov', 'local']) {
      expect(STATEWIDE_BOARDS[id as SourceId], id).toBeUndefined();
    }
  });
});

describe('properties (fast-check)', () => {
  const SOURCES: SourceId[] = ['caleprocure', 'oregonbuys', 'commbuys', 'nevadaepro', 'ngem', 'samgov', 'opengov', 'laramp', 'sfbids', 'usac470'];
  const PRECISIONS: LocationPrecision[] = ['exact', 'city', 'county', 'region', 'agency', 'state', 'unknown'];
  const TITLES = [
    'Electrical Panel Replacement', 'Fire Alarm System Installation Services', 'Construct sound wall, drainage, and electrical.',
    'Roof Replacement', 'Janitorial Services', 'Plastic Trash Bags', 'LED Lighting Retrofit', 'Generator Maintenance',
  ];
  const location = fc.record({
    point: fc.boolean(),
    lat: fc.double({ min: 32.6, max: 41.9, noNaN: true }),
    lng: fc.double({ min: -124.3, max: -114.2, noNaN: true }),
    precision: fc.constantFrom(...PRECISIONS),
    state: fc.constantFrom('CA', 'NV', 'OR', 'MA', null),
    county: fc.constantFrom(null, 'Shasta', 'Humboldt, Shasta', 'Alpine, Amador, Calaveras', 'Clark', 'Los Angeles'),
    label: fc.constantFrom(null, 'CA (location not listed)', 'Somewhere (TEST)', 'Humboldt and Shasta counties, CA'),
  }).map((l): BidLocation => ({
    city: null, zip: null, county: l.county, state: l.state, precision: l.precision, label: l.label,
    lat: l.point ? l.lat : null, lng: l.point ? l.lng : null,
  }));
  const bid = fc.record({ source: fc.constantFrom(...SOURCES), title: fc.constantFrom(...TITLES), location, days: fc.integer({ min: 1, max: 60 }) })
    .map(({ source, title, location, days }): Bid => ({
      id: `${source}:TEST`, source, sourceId: 'TEST', sourceName: 'TEST', title, agency: null, description: null, category: null,
      location, postedAt: null, dueAt: new Date(NOW.getTime() + days * 86_400_000).toISOString(), estValue: null, naics: null,
      setAside: null, url: 'https://example.gov', flags: [],
    }));
  const profile = fc.record({ radius: fc.integer({ min: 10, max: 300 }), who: fc.constantFrom('ca', 'pilot') })
    .map(({ radius, who }) => ({ ...(who === 'ca' ? ca60 : pilot), maxDistanceMi: radius }));

  it('a result for a bid with no point never carries a distance', () => {
    fc.assert(fc.property(bid, profile, (b, p) => {
      if (b.location.lat != null) return;
      expect(scoreBid(b, p, NOW).distanceMi).toBeNull();
    }), { numRuns: 2000, seed: 20261114 });
  });

  it('a statewide board card with no place never scores above the cap, and never may be announced', () => {
    fc.assert(fc.property(bid, profile, (b, p) => {
      if (b.location.lat != null || !STATEWIDE_BOARDS[b.source]) return;
      const r = scoreBid(b, p, NOW);
      expect(r.score).toBeLessThanOrEqual(BELOW_ALERT_CAP);
      expect(mayAnnounce(r, 0) && r.score > 0).toBe(false);
    }), { numRuns: 2000, seed: 20261114 });
  });
});
