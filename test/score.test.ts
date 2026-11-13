import { describe, expect, it } from 'vitest';
import { locate, milesBetween } from '../src/geo/locate.js';
import { loadProfile } from '../src/profiles.js';
import { decideMatch } from '../src/realtime/alerts.js';
import { finalizeBid } from '../src/scan.js';
import { BELOW_ALERT_CAP, CAPPED_FLOOR, compileKeywords, paperworkNeeds, scoreBid } from '../src/score/score.js';
import { parseSamResponse, type SamResponse } from '../src/sources/samgov.js';
import type { BidDraft, Profile, Qualifications, ScoreResult } from '../src/types.js';
import { CAPTURED, fx, realBids } from './helpers.js';

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

  // Changed after the 2026-11-13 scoring audit: this used to be a 15-point "check you qualify" penalty, which
  // let a veteran-only VA job alert as "good" (58). A certification set-aside is a hard no, said plainly.
  it('rejects set-asides for programs L&M is not certified in, and keeps eligible ones penalty-free', () => {
    const s = score({ title: 'Repair Electrical Distribution', naics: '238210', setAside: 'SDVOSBC', location: { city: 'Reno', state: 'NV' } });
    expect(s.score).toBe(0);
    expect(s.rejected).toBe('Reserved for service-disabled veteran-owned firms');
    const sb = score({ title: 'Repair Electrical Distribution', naics: '238210', setAside: 'SBA', location: { city: 'Reno', state: 'NV' } });
    const open = score({ title: 'Repair Electrical Distribution', naics: '238210', setAside: null, location: { city: 'Reno', state: 'NV' } });
    expect(sb.score).toBe(open.score);
    expect(sb.reasons.some((r) => /set-aside|Reserved/.test(r.text))).toBe(false);
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

  it('ranks a job known to be over the range below one of unknown size', () => {
    const at = (estValue: BidDraft['estValue']) => score({ title: 'Electrical Repairs', location: { city: 'Carson City', state: 'NV' }, estValue }).score;
    const unknown = at(null);
    expect(at({ min: 30_000, max: 30_000 })).toBeGreaterThan(unknown);
    expect(at({ min: 120_000, max: 120_000 })).toBeLessThan(unknown); // up to 3× the top of the range
    expect(at({ min: 1_200_000, max: 1_200_000 })).toBeLessThan(at({ min: 120_000, max: 120_000 }));
  });

  it('says when the job size is not stated', () => {
    expect(score({ title: 'Electrical Repairs', location: { city: 'Carson City', state: 'NV' } }).reasons).toContainEqual({ kind: 'info', text: 'Job size not stated' });
  });
});

describe('score range', () => {
  it('a bid held below the alert line never scores below 0 and is never announced, even when the alert lines are at 0', () => {
    const base = loadProfile('lm-electric');
    const anything = { ...base, notify: { ...base.notify, minScore: 0 }, alerts: { ...base.alerts, minScore: 0 } };
    // No town, ZIP, state or agency: nobody can tell where the job is, so its score is held below the alert line.
    const nowhere = finalizeBid({
      source: 'samgov', sourceId: 'TEST-score-floor', sourceName: 'TEST source', title: 'TEST electrical panel upgrade (synthetic)',
      agency: null, description: null, category: null, location: {}, postedAt: null, dueAt: '2026-12-02T22:00:00.000Z',
      estValue: null, naics: null, setAside: null, url: 'https://example.com/test-bid',
    });
    const r = scoreBid(nowhere, anything, new Date('2026-11-11T20:00:00Z'));
    expect(r.reasons).toContainEqual({ kind: 'info', text: `Work location not listed — can't confirm it's within ${base.maxDistanceMi} mi` });
    // The cap never goes under CAPPED_FLOOR (it was -1, then 0, with the alert lines at 0); the bid keeps its
    // own fit when that is lower, and is marked capped so no alert goes out at these zero alert lines.
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(CAPPED_FLOOR);
    expect(r.capped).toBe(true);
    const event = { type: 'match' as const, profileId: anything.id, bid: nowhere, score: r, isNewBid: true };
    expect(decideMatch(event, anything, 'pro', new Date('2026-11-11T20:00:00Z'))).toBeNull();
  });
});

// ------------------------------------------------------------- paperwork --
// "Your paperwork" answers (Profile.qualifications). Real bids where a flagged one exists: the 13 NV State Public
// Works bids (flags "SPWD bidder qualification" + "Prevailing wage likely") and the real SAM.gov notices. No real
// bid in the fixtures carries a bond flag, so the bond cases use a synthetic TEST- bid on example.com.
describe('paperwork answers adapt the score, and never hide a bid', () => {
  const real = realBids();
  const cells = real.find((b) => b.title.startsWith('Replace Cell Doors, Locks, Intercoms'))!;
  const samBids = (['samgov-nv.json', 'samgov-ca-238210.json', 'samgov-ca-236220.json'] as const)
    .flatMap((f) => (JSON.parse(fx(f)) as SamResponse).opportunitiesData ?? []);
  const federal = parseSamResponse({ opportunitiesData: samBids }).map(finalizeBid);
  const unsureAll: Qualifications = { statePublicWorks: 'unsure', samRegistered: 'unsure', bonding: 'unsure', prevailingWage: 'unsure' };
  const withQ = (q: Partial<Qualifications>, base: Profile = profile): Profile => ({ ...base, qualifications: { ...unsureAll, ...q } });
  const texts = (r: ScoreResult) => r.reasons.map((x) => `${x.kind}:${x.text}`);
  const bondBid = finalizeBid(draft({
    sourceId: 'TEST-bond-1', title: 'TEST Electrical Panel Replacement (synthetic)', url: 'https://example.com/test-bond',
    location: { city: 'Minden', state: 'NV' }, estValue: { min: 30_000, max: 30_000 },
  }));
  bondBid.flags = ['Bid bond', 'Performance/payment bond'];
  const pwBid = finalizeBid(draft({
    sourceId: 'TEST-pw-1', title: 'TEST Lighting Retrofit (synthetic)', url: 'https://example.com/test-pw',
    location: { city: 'Minden', state: 'NV' }, estValue: { min: 30_000, max: 30_000 },
  }));
  pwBid.flags = ['Prevailing wage', 'Certified payroll'];

  it('knows what each real bid needs from its flags and source', () => {
    expect(paperworkNeeds(cells, profile).map((n) => n.key)).toEqual(['statePublicWorks', 'prevailingWage']);
    expect(paperworkNeeds(federal[0]!, profile).map((n) => n.key)).toEqual(['samRegistered']);
  });

  it('no answers at all (the pilot): exactly the reasons and scores of today, on every real bid', () => {
    for (const b of [...real, ...federal]) {
      const today = scoreBid(b, profile, CAPTURED);
      expect(scoreBid(b, { ...profile }, CAPTURED)).toEqual(today);
      expect(texts(today).some((t) => /check yours|you have it|you said/.test(t))).toBe(false);
    }
  });

  it('SPWD (real NV Public Works bid): yes says so, unsure is neutral, no keeps it visible below the alert line', () => {
    const today = scoreBid(cells, profile, CAPTURED);
    expect(today.score).toBe(82);
    const yes = scoreBid(cells, withQ({ statePublicWorks: 'yes' }), CAPTURED);
    const unsure = scoreBid(cells, withQ({}), CAPTURED);
    const no = scoreBid(cells, withQ({ statePublicWorks: 'no' }), CAPTURED);
    expect(yes.score).toBe(82);
    expect(texts(yes)).toContain('plus:SPWD qualification: you have it');
    expect(texts(yes)).not.toContain('info:SPWD bidder qualification');
    expect(unsure.score).toBe(82);
    expect(texts(unsure)).toContain('info:Needs SPWD bidder qualification — check yours');
    expect(no.score).toBe(BELOW_ALERT_CAP);
    expect(no.verdict).toBe('maybe');
    expect(no.rejected).toBeNull();
    expect(texts(no)).toContain('minus:Needs SPWD bidder qualification — you said you don’t have it yet');
  });

  it('SPWD: a company outside Nevada answered about its own state, so an SPWD bid only gets the neutral line', () => {
    const ca = { ...profile, base: { label: 'South Lake Tahoe, CA', lat: 38.93, lng: -119.98 }, states: ['CA', 'NV'] };
    const r = scoreBid(cells, withQ({ statePublicWorks: 'no' }, ca), CAPTURED);
    expect(texts(r)).toContain('info:Needs SPWD bidder qualification — check yours');
    expect(r.score).toBe(scoreBid(cells, ca, CAPTURED).score);
  });

  it('prevailing wage (real SPWD board flag "Prevailing wage likely"): yes / unsure / no', () => {
    const yes = scoreBid(cells, withQ({ statePublicWorks: 'yes', prevailingWage: 'yes' }), CAPTURED);
    const unsure = scoreBid(cells, withQ({ statePublicWorks: 'yes' }), CAPTURED);
    const no = scoreBid(cells, withQ({ statePublicWorks: 'yes', prevailingWage: 'no' }), CAPTURED);
    expect(texts(yes)).toContain('plus:Prevailing wage likely: you take these jobs');
    expect(texts(unsure)).toContain('info:Prevailing wage likely — check you can run certified payroll');
    expect(texts(no)).toContain('minus:Prevailing wage likely — you said you don’t take prevailing-wage jobs');
    expect([yes.score, unsure.score, no.score]).toEqual([82, 82, BELOW_ALERT_CAP]);
    // the notice's own words ("Prevailing wage", "Certified payroll") are covered by the same answer
    const pwNo = scoreBid(pwBid, withQ({ prevailingWage: 'no' }), NOW);
    expect(texts(pwNo)).toContain('minus:Prevailing wage, Certified payroll — you said you don’t take prevailing-wage jobs');
    expect(pwNo.score).toBe(BELOW_ALERT_CAP);
    expect(scoreBid(pwBid, withQ({ prevailingWage: 'yes' }), NOW).score).toBe(scoreBid(pwBid, profile, NOW).score);
  });

  it('SAM.gov registration (real federal notices): yes / unsure / no', () => {
    const SCAN = new Date('2026-11-13T04:02:14Z'); // the live scan's clock, minutes after the SAM capture
    for (const b of federal) {
      const today = scoreBid(b, profile, SCAN);
      const yes = scoreBid(b, withQ({ samRegistered: 'yes' }), SCAN);
      const unsure = scoreBid(b, withQ({}), SCAN);
      const no = scoreBid(b, withQ({ samRegistered: 'no' }), SCAN);
      expect(yes.score, b.title).toBe(today.score);
      expect(unsure.score, b.title).toBe(today.score);
      expect(no.score, b.title).toBe(Math.min(today.score, BELOW_ALERT_CAP));
      expect(texts(yes)).toContain('plus:SAM.gov registration: you have it');
      expect(texts(unsure)).toContain('info:Federal bid — needs SAM.gov registration, check yours');
      expect(texts(no)).toContain('minus:Federal bid — needs SAM.gov registration; you said you’re not registered yet');
    }
    // None of the real notices is a good fit for the pilot, so the cap is shown on a synthetic federal bid.
    const fed = score({ source: 'samgov', sourceId: 'TEST-sam-1', title: 'TEST Electrical Distribution Repair (synthetic)', naics: '238210', url: 'https://example.com/test-sam', location: { city: 'Minden', state: 'NV' } });
    expect(fed.score).toBeGreaterThan(BELOW_ALERT_CAP);
    const fedBid = finalizeBid(draft({ source: 'samgov', sourceId: 'TEST-sam-1', title: 'TEST Electrical Distribution Repair (synthetic)', naics: '238210', url: 'https://example.com/test-sam', location: { city: 'Minden', state: 'NV' } }));
    expect(scoreBid(fedBid, withQ({ samRegistered: 'yes' }), NOW).score).toBe(fed.score);
    expect(scoreBid(fedBid, withQ({ samRegistered: 'unsure' }), NOW).score).toBe(fed.score);
    expect(scoreBid(fedBid, withQ({ samRegistered: 'no' }), NOW).score).toBe(BELOW_ALERT_CAP);
    // a board that is not federal never asks about SAM
    expect(texts(scoreBid(cells, withQ({ samRegistered: 'no' }), CAPTURED)).some((t) => /SAM\.gov/.test(t))).toBe(false);
  });

  it('bonds (synthetic TEST bid: no real fixture bid carries a bond flag): yes / unsure / no', () => {
    const today = scoreBid(bondBid, profile, NOW);
    expect(texts(today)).toEqual(expect.arrayContaining(['info:Bid bond', 'info:Performance/payment bond']));
    const yes = scoreBid(bondBid, withQ({ bonding: 'yes' }), NOW);
    const unsure = scoreBid(bondBid, withQ({}), NOW);
    const no = scoreBid(bondBid, withQ({ bonding: 'no' }), NOW);
    expect(yes.score).toBe(today.score);
    expect(today.score).toBeGreaterThan(BELOW_ALERT_CAP);
    expect(texts(yes)).toContain('plus:Bid bond, Performance/payment bond: you can get bonds');
    expect(texts(yes)).not.toContain('info:Bid bond');
    expect(unsure.score).toBe(today.score);
    expect(texts(unsure)).toContain('info:Bid bond, Performance/payment bond — check you can get bonded');
    expect(no.score).toBe(BELOW_ALERT_CAP);
    expect(texts(no)).toContain('minus:Bid bond, Performance/payment bond — you said you can’t get bonds yet');
  });

  it('"no" never raises a score, never rejects, and keeps the bid under a lower alert line too', () => {
    const low = { ...profile, alerts: { ...profile.alerts, minScore: 40 } };
    const r = scoreBid(cells, withQ({ statePublicWorks: 'no' }, low), CAPTURED);
    expect(r.score).toBe(39);
    expect(r.rejected).toBeNull();
    const allNo = withQ({ statePublicWorks: 'no', samRegistered: 'no', bonding: 'no', prevailingWage: 'no' });
    for (const b of [...real, ...federal]) {
      const today = scoreBid(b, profile, CAPTURED);
      const r2 = scoreBid(b, allNo, CAPTURED);
      expect(r2.score, b.title).toBeLessThanOrEqual(today.score);
      expect(r2.rejected, b.title).toBe(today.rejected);
    }
  });

  it('alert line 35 ("Anything worth a look") + "no": the bid stays in the deck as a maybe, and is never announced', () => {
    // Before the floor, the cap was min(54, alert line - 1) = 34: "skip", and the deck (min 35) dropped it.
    const anything = { ...profile, alerts: { ...profile.alerts, minScore: 35 } };
    const r = scoreBid(cells, withQ({ statePublicWorks: 'no' }, anything), CAPTURED);
    expect(r.score).toBe(CAPPED_FLOOR);
    expect(r.verdict).toBe('maybe');
    expect(r.capped).toBe(true);
    expect(r.rejected).toBeNull();
    const event = { type: 'match' as const, profileId: anything.id, bid: cells, score: r, isNewBid: true };
    expect(decideMatch(event, anything, 'pro', CAPTURED)).toBeNull();
    // the same bid with the paperwork: not capped, alerts as before
    const yes = scoreBid(cells, withQ({ statePublicWorks: 'yes' }, anything), CAPTURED);
    expect(yes.capped).toBeUndefined();
    expect(decideMatch({ ...event, score: yes }, anything, 'pro', CAPTURED)).not.toBeNull();
  });
});
