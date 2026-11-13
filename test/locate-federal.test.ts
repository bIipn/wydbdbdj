/**
 * Where the work is, on REAL listings: the SAM.gov notices captured 2026-11-13 (test/fixtures/samgov-*.json)
 * and the Nevada boards' bids in test/fixtures (realBids()). Distances are from the pilot's base, Gardnerville NV.
 * Anything made up says so (TEST, "(synthetic)").
 */
import { describe, expect, it } from 'vitest';
import { locate, milesBetween } from '../src/geo/locate.js';
import { loadProfile } from '../src/profiles.js';
import { finalizeBid } from '../src/scan.js';
import { scoreBid } from '../src/score/score.js';
import { parseSamResponse, type SamOpportunity, type SamResponse } from '../src/sources/samgov.js';
import type { Bid, BidLocation } from '../src/types.js';
import { CAPTURED, fx, realBids } from './helpers.js';

const pilot = loadProfile('lm-electric');
const ALL: SamOpportunity[] = ['samgov-nv.json', 'samgov-ca-238210.json', 'samgov-ca-236220.json']
  .flatMap((f) => (JSON.parse(fx(f)) as SamResponse).opportunitiesData ?? []);
/** One real notice, parsed on its own and located. */
function fed(prefix: string): Bid {
  const o = ALL.find((n) => n.noticeId.startsWith(prefix));
  if (!o) throw new Error(`no notice ${prefix}`);
  return finalizeBid(parseSamResponse({ opportunitiesData: [o] })[0]!);
}
const miles = (loc: BidLocation) => Math.round(milesBetween(pilot.base, { lat: loc.lat!, lng: loc.lng! }));
const board = (title: RegExp): Bid => {
  const hits = realBids().filter((b) => title.test(b.title));
  if (hits.length !== 1) throw new Error(`${hits.length} real bids match ${title}`);
  return hits[0]!;
};

describe('federal places: the ZIP first, then city + state, through the nationwide table', () => {
  it('a ZIP with no city or state: the 8(a) JOC is at Twentynine Palms, 384 mi away', () => {
    const loc = fed('9e36b34d').location;
    expect(loc).toMatchObject({ city: 'Twentynine Palms', state: 'CA', zip: '92278', precision: 'city', label: 'Twentynine Palms, CA' });
    expect(miles(loc)).toBe(384);
  });

  it('a city of "0" with a ZIP: Moffett Field (94035)', () => {
    const loc = fed('e323b574').location;
    expect(loc).toMatchObject({ state: 'CA', zip: '94035', precision: 'city' });
    expect(loc.city).not.toBe('0');
    expect(miles(loc)).toBeGreaterThan(150);
  });

  it('a state given by name: Honolulu is out of the pilot\'s states', () => {
    const bid = fed('eb5f5f38');
    expect(bid.location).toMatchObject({ city: 'Honolulu', state: 'HI', precision: 'city' });
    expect(scoreBid(bid, pilot, CAPTURED).rejected).toBeTruthy();
  });

  it('a city + state with no ZIP: Lone Pine, CA', () => {
    const loc = fed('705abfc6').location;
    expect(loc).toMatchObject({ city: 'Lone Pine', state: 'CA', zip: null, precision: 'city', label: 'Lone Pine, CA' });
    expect(miles(loc)).toBeGreaterThan(180);
  });

  it('the same project by ZIP (95814) and by city (Sacramento) lands on the same point', () => {
    const byZip = fed('a1860ddd').location; // "$465M SPK SMALL BUSINESS MATOC …", ZIP only
    const byCity = fed('f3a59bd0').location; // its presolicitation, city only
    expect(milesBetween({ lat: byZip.lat!, lng: byZip.lng! }, { lat: byCity.lat!, lng: byCity.lng! })).toBeLessThan(3);
    expect(miles(byZip)).toBe(97);
  });

  it('a gazetteer town keeps its hand-checked centre: the Reno VA breaker job is 41 mi, as before', () => {
    const loc = fed('0219242e').location;
    expect(loc).toEqual({ city: 'Reno', county: 'Washoe', state: 'NV', zip: '89502', lat: 39.5296, lng: -119.8138, precision: 'city', label: 'Reno, NV' });
    expect(miles(loc)).toBe(41);
  });

  it('no federal notice with a place keeps "location not listed"', () => {
    for (const o of ALL) {
      const bid = fed(o.noticeId.slice(0, 8));
      if (bid.location.zip || bid.location.city) expect(bid.location.lat, o.noticeId).not.toBeNull();
    }
  });
});

describe('a place the listing named but we cannot put on the map stays unplaced', () => {
  it('several sites: no point, no guess from the bases in the text, the card says so', () => {
    const bid = fed('c2d76e01'); // Barstow, 29 Palms, Bridgeport and China Lake
    expect(bid.location).toMatchObject({ lat: null, lng: null, state: 'CA', precision: 'state', label: 'Several sites in CA — see the bid' });
    expect(fed('562387fb').location).toMatchObject({ lat: null, state: null, precision: 'unknown', label: 'Several sites in CA, NV — see the bid' });
  });

  it('an address we cannot place is repeated, never swapped for a town found in the title', () => {
    const loc = locate({
      title: 'TEST Reno switchgear replacement (synthetic)', description: null, agency: null,
      location: { state: 'NV', label: 'TEST Building 99, Hawthorne Army Depot (synthetic)' },
    });
    expect(loc).toMatchObject({ lat: null, city: null, precision: 'state', label: 'TEST Building 99, Hawthorne Army Depot (synthetic)' });
    // A ZIP the table does not know stops the guessing too (00000 is no ZIP).
    expect(locate({ title: 'TEST Reno lighting (synthetic)', description: null, agency: null, location: { zip: '00000' } }))
      .toMatchObject({ lat: null, precision: 'unknown' });
  });

  it('a notice with no place at all is still read for a gazetteer town, as the Nevada boards are', () => {
    const loc = locate({ title: 'TEST Carson City lighting (synthetic)', description: null, agency: null, location: {} });
    expect(loc).toMatchObject({ city: 'Carson City', precision: 'city' });
  });
});

describe('the Nevada boards: agencies that were wrong or unknown (real bids)', () => {
  it('University Medical Center is in Las Vegas, so the surveillance job is out of range', () => {
    const umc = board(/^UMC's Video Surveillance/);
    expect(umc.location).toMatchObject({ city: 'Las Vegas', precision: 'agency' });
    expect(scoreBid(umc, pilot, CAPTURED).rejected).toMatch(/outside your 90 mi range/);
  });

  it('a WNC job from BCN Purchasing is on the Carson City campus; UNR jobs stay in Reno', () => {
    expect(board(/^WNC - Dini Library/).location).toMatchObject({ city: 'Carson City', precision: 'agency' });
    expect(board(/^UNR - Install Replacement Heat Exchanger/).location).toMatchObject({ city: 'Reno', precision: 'agency' });
  });

  it('the Adjutant General\'s OTAG and DEM jobs are in Carson City; its "Northern Nevada" contract is not forced there', () => {
    expect(board(/^OTAG Water Heater/).location).toMatchObject({ city: 'Carson City', precision: 'agency' });
    expect(board(/^DEM - Door Hardware/).location).toMatchObject({ city: 'Carson City', precision: 'agency' });
    const north = board(/^Northern Nevada - HVAC Maintenance/);
    expect(north.agency).toBe('Adjutant General');
    expect(north.location.city).toBeNull();
  });

  it('"Northern Nevada" is a region, labelled approximate, with no made-up point', () => {
    const north = board(/^Northern Nevada - HVAC Maintenance/);
    expect(north.location).toMatchObject({ city: null, state: 'NV', lat: null, lng: null, precision: 'region' });
    expect(north.location.label).toMatch(/^Northern Nevada \(approx\.\)/);
    const s = scoreBid(north, pilot, CAPTURED);
    expect(s.distanceMi).toBeNull();
    expect(s.reasons.some((r) => /mi from/.test(r.text))).toBe(false);
  });

  it('"Southern Nevada" keeps its point: every site there is far, so the reject is right', () => {
    const homes = board(/^COMPLETE REHABILITATION FOR 3 SCATTERED SITE HOMES/);
    expect(homes.location).toMatchObject({ precision: 'region', city: null });
    expect(scoreBid(homes, pilot, CAPTURED).rejected).toMatch(/outside your 90 mi range/);
  });
});
