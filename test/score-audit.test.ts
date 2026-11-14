/**
 * The scoring audit of the first complete live scan (2026-11-13, 107 open bids for L&M Electric).
 * One block per rule adopted from it, each built from the real bids the audit named:
 *  - state and county boards: the real pages in test/fixtures (realBids(), scored at CAPTURED);
 *  - SAM.gov: the fields of the real notices from the live API responses of that scan, copied below
 *    (notice ids, titles, codes and places as SAM.gov published them), scored at the scan's own clock.
 * Anything changed from the real record to isolate one rule is named "variant" in the test.
 * Property tests check that a gate never raises a score.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '../src/profile/build.js';
import { loadProfile } from '../src/profiles.js';
import { finalizeBid } from '../src/scan.js';
import { decideMatch } from '../src/realtime/alerts.js';
import { CAPPED_FLOOR, programTerm, scoreBid, titleAmount } from '../src/score/score.js';
import { mergeTrades } from '../src/trades/catalog.js';
import type { Bid, BidDraft, BidLocation, Profile } from '../src/types.js';
import { CAPTURED, realBids } from './helpers.js';

const pilot = loadProfile('lm-electric');
const SCAN = new Date('2026-11-13T04:02:14.145Z'); // when the live scan ran
const real = realBids();
const board = (title: RegExp): Bid => {
  const b = real.find((x) => title.test(x.title));
  if (!b) throw new Error(`no real bid matches ${title}`);
  return b;
};
const texts = (b: Bid, p: Profile = pilot, now = CAPTURED) => scoreBid(b, p, now).reasons.map((r) => r.text);

const NO_PLACE: BidLocation = { city: null, county: null, state: null, zip: null, lat: null, lng: null, precision: 'unknown', label: null };

/** A SAM.gov notice from the 2026-11-13 API responses, as the federal parser hands it on. */
function sam(d: Omit<BidDraft, 'source' | 'sourceName' | 'agency' | 'description' | 'postedAt' | 'estValue' | 'url'> & { agency?: string }): Bid {
  return finalizeBid({
    source: 'samgov', sourceName: 'SAM.gov (federal)', agency: d.agency ?? null, description: null, postedAt: null, estValue: null,
    url: `https://sam.gov/opp/${d.sourceId}/view`, ...d,
  });
}
const placed = (b: Bid, location: BidLocation): Bid => ({ ...b, location });

// The real notices (sam-2.json and sam-3.json of the 2026-11-13 scan).
const J061 = sam({
  sourceId: '0219242e57b54ac1bf223aaa8c9edc6c', title: 'J061--Triennial Circuit Breaker and Feeder Testing', category: 'Solicitation',
  location: { city: 'Reno', state: 'NV', zip: '89502' }, dueAt: '2026-11-20T20:00:00.000Z', naics: '238210', setAside: 'SDVOSBC', flags: [],
});
const JOC_8A = placed(sam({
  sourceId: '9e36b34d0e1d48d494fcd19d70cdcbcf', category: 'Solicitation', dueAt: '2026-12-09T18:00:00.000Z', naics: '238210',
  title: 'IDIQ JOC 8(a) SMALL BUSINESS SET-ASIDE UNDER NAICS 238210 FOR ELECTRICAL CONTRACTORS AND OTHER WIRING INSTALLATION CONTRACTORS AT VARIOUS GOVERNMENT FACILITIES LOCATED WITHIN THE MCAGCC 29 PALMS AOR',
  setAside: '8A', // SAM's code field is empty; the title says 8(a)
  flags: ['Program contract'],
}), { ...NO_PLACE, zip: '92278', label: 'MARINE CORPS AIR GROUND COMBAT CENTER TWENTYNINE PALMS, CALIFORNIA 92278' });
const JOC_SB = placed(sam({
  sourceId: 'c2d76e017c6246ff97d33d5dcc0a3453', category: 'Solicitation', dueAt: '2026-11-19T22:00:00.000Z', naics: '238210', setAside: 'SBA',
  title: 'IDIQ JOC TOTAL SMALL-BUSINESS SET-ASIDE FOR ELECTRICAL AND OTHER WIRING INSTALLATION PROJECTS AT VARIOUS GOVERNMENT FACILITIES LOCATED WITHIN THE MARINE CORPS LOGISTICS BASE BARSTOW, MARINE CO',
  flags: ['Program contract'],
}), {
  ...NO_PLACE,
  label: 'VARIOUS GOVERNMENT FACILITIES LOCATED WITHIN THE MARINE CORPS LOGISTICS BASE BARSTOW, MARINE CORPS AIR-GROUND COMBAT CENTER 29 PALMS, MARINE CORPS MOUNTAIN WARFARE TRAINING CENTERBRIDGEPORT, AND NAVAL AIR WEAPONS STATION CHINA LAKE, CALIFORNIA AREA OF RESPONSIBILITY (AOR) AND OTHER LOCATIONS AS APPROVED',
});
const MATOC = sam({
  sourceId: 'a1860dddf22441c1801a6085cab1412e', title: '$465M SPK SMALL BUSINESS MATOC FOR DBB/DB CONSTRUCTION', category: 'Solicitation',
  location: { state: 'CA', zip: '95814', label: 'USACE Sacramento District 1325 J Street Sacramento, CA 95814' },
  dueAt: '2026-12-02T18:00:00.000Z', naics: '236220', setAside: 'SBA', flags: ['Program contract'],
});
const OTA = sam({
  sourceId: '05be123fb71c4956bbe8e75a27210ab7', category: 'Solicitation', dueAt: '2026-12-10T22:00:00.000Z', naics: '236220', setAside: null,
  title: 'MCI West Barracks Industrialized Construction Projects for Barracks via Other Transaction Authority (10 USC 2808a)',
  location: { state: 'CA', zip: '92132', label: '750 Pacific Highway, San Diego, CA 92132' },
  flags: [], // the title alone must be enough
});
const PARKING = placed(sam({
  sourceId: 'ebf23d8ba096416d9f5bca7efe0819ee', title: 'Z2DA--654-24-004 | Remediate Old Parking Garage', category: 'Solicitation',
  dueAt: '2026-11-20T23:00:00.000Z', naics: '236220', setAside: null, flags: [],
}), NO_PLACE); // this notice's place of performance is blank
const MOFFETT = placed(sam({
  sourceId: 'e323b5748db4496680bee238d37b6fdd', title: 'Solicitation:  Construct Combat Rescue Helicopter Flight Simulator Facility at Moffett ANGB',
  category: 'Solicitation', dueAt: '2026-11-27T20:00:00.000Z', naics: '236220', setAside: 'SBA', flags: [],
}), { ...NO_PLACE, state: 'CA', precision: 'state', label: 'Moffett ANGB, Santa Clara County, California' }); // variant: as if the ZIP did not resolve

describe('eligibility is a gate: a certification set-aside is a hard no', () => {
  it('J061 breaker testing (VA Reno, SDVOSB) was 58 "good" and alerted; now 0 with the plain reason', () => {
    const s = scoreBid(J061, pilot, SCAN);
    expect(s.score).toBe(0);
    expect(s.verdict).toBe('skip');
    expect(s.rejected).toBe('Reserved for service-disabled veteran-owned firms');
  });

  it('the same notice is penalty-free for a profile that holds the program, or when it is small-business only (variants)', () => {
    const vet = { ...pilot, setAsidesEligible: [...pilot.setAsidesEligible, 'SDVOSBC'] };
    const asVet = scoreBid(J061, vet, SCAN);
    const asSmall = scoreBid({ ...J061, setAside: 'SBA' }, pilot, SCAN);
    const open = scoreBid({ ...J061, setAside: null }, pilot, SCAN);
    expect(asVet.score).toBe(open.score);
    expect(asSmall.score).toBe(open.score);
    expect(open.score).toBeGreaterThanOrEqual(55);
    for (const s of [asVet, asSmall]) expect(s.reasons.some((r) => /set-aside|Reserved/.test(r.text))).toBe(false);
  });

  it('the 8(a)-only JOC (75 "great" before) names the 8(a) reservation even when another gate leads', () => {
    const s = scoreBid(JOC_8A, pilot, SCAN);
    expect(s.score).toBe(0);
    expect(s.reasons).toContainEqual({ kind: 'minus', text: 'Reserved for 8(a) firms' });
  });

  it('a code that is not a certification program keeps the old "check you qualify" penalty (variant: local-area set-aside)', () => {
    const s = scoreBid({ ...J061, setAside: 'LAS' }, pilot, SCAN);
    const open = scoreBid({ ...J061, setAside: null }, pilot, SCAN);
    expect(s.rejected).toBeNull();
    expect(s.score).toBe(open.score - 15);
    expect(s.reasons).toContainEqual({ kind: 'minus', text: 'Local-area set-aside — check you qualify' });
  });
});

describe('a program contract is not a single job', () => {
  it('the small-business JOC (70 "good", alerted) is a hard no despite "electric" and NAICS 238210', () => {
    const s = scoreBid(JOC_SB, pilot, SCAN);
    expect(s.score).toBe(0);
    expect(s.rejected).toBe('Program contract (“IDIQ”) — not a single job');
    expect(s.reasons).toContainEqual({ kind: 'plus', text: 'Electrical scope: “electric” + NAICS 238210' }); // the fit is still shown
  });

  it('the $465M MATOC names the dollar figure its own title states', () => {
    expect(scoreBid(MATOC, pilot, SCAN).rejected).toBe('Program contract (“MATOC”, $465M) — not a single job');
    expect(titleAmount(MATOC.title)).toBe(465_000_000);
  });

  it('a title alone is enough: the Other Transaction Authority barracks notice carries no flag', () => {
    expect(scoreBid(OTA, pilot, SCAN).rejected).toBe('Program contract (“Other Transaction Authority”) — not a single job');
  });

  it('local annual or on-call work is not a program contract (real NGEM title)', () => {
    expect(programTerm({ title: 'ANNUAL REQUIREMENTS CONTRACT FOR PREVENTATIVE MAINTENANCE, REPAIR AND REPLACEMENT OF SECTIONAL OVERHEAD, ROLLI', flags: [] })).toBeNull();
    for (const b of real) expect(programTerm(b), b.title).toBeNull(); // none of the 85 state and county bids
  });
});

describe('a presolicitation or RFI is not biddable yet', () => {
  // Variant of J061: small-business code and the "Presolicitation" flag (73 "good" without the flag).
  const presol = { ...J061, setAside: 'SBA', flags: ['Presolicitation'] };

  it('never alerts, gets no days-to-bid credit, and says so', () => {
    const s = scoreBid(presol, pilot, SCAN);
    expect(s.score).toBeLessThan(pilot.notify.minScore);
    expect(s.reasons).toContainEqual({ kind: 'minus', text: 'Presolicitation — not open for bids yet' });
    expect(s.reasons.some((r) => /days? to bid|Due within/.test(r.text))).toBe(false);
    expect(s.reasons.some((r) => r.kind === 'info' && r.text === 'Presolicitation')).toBe(false); // said once, as the minus
  });

  it('the real Mather Loop Road presolicitation (SDVOSB) is a no for its set-aside and says it is not open yet', () => {
    const mather = sam({
      sourceId: '319573e715c74310b898bd157ccc1377', title: 'Z1DA--FY27 NRM - Correct Mather Loop Road and Install Speed Bumps', category: 'Presolicitation',
      location: { city: 'Mather', state: 'CA', zip: '95655' }, dueAt: '2026-12-16T20:00:00.000Z', naics: '236220', setAside: 'SDVOSBC', flags: ['Presolicitation'],
    });
    const s = scoreBid(mather, pilot, SCAN);
    expect(s.score).toBe(0);
    expect(s.reasons).toContainEqual({ kind: 'minus', text: 'Presolicitation — not open for bids yet' });
    expect(s.reasons.some((r) => /days to bid/.test(r.text))).toBe(false); // the old card said "33 days to bid"
  });

  it('an NGEM RFI takes the same path (variant: the top real QuestCDN card with the RFI flag)', () => {
    const cell = board(/^Replace Cell Doors, Locks, Intercoms/);
    expect(scoreBid(cell, pilot, CAPTURED).score).toBeGreaterThanOrEqual(75);
    const rfi = scoreBid({ ...cell, flags: [...cell.flags, 'RFI — info only, not a bid'] }, pilot, CAPTURED);
    expect(rfi.score).toBe(54);
    expect(rfi.reasons).toContainEqual({ kind: 'minus', text: 'RFI — info only, not a bid' });
  });

  it('a profile alerting at 35: held at the "maybe" floor (it stays in the deck), and still never alerts', () => {
    // Was "kept at 34": under the deck's 35 line, so the bid vanished from the swipe deck for these companies.
    const low = { ...pilot, alerts: { minScore: 35 } };
    const s = scoreBid(presol, low, SCAN);
    expect(s.score).toBeLessThanOrEqual(CAPPED_FLOOR);
    expect(s.capped).toBe(true);
    expect(decideMatch({ type: 'match', profileId: low.id, bid: presol, score: s, isNewBid: true }, low, 'pro', SCAN)).toBeNull();
  });
});

describe('a place we cannot measure earns no distance points and never alerts', () => {
  it('several bases listed: the JOC would have been capped even without the program rule (variant: no program flag)', () => {
    const notProgram = { ...JOC_SB, title: 'ELECTRICAL AND OTHER WIRING INSTALLATION PROJECTS AT VARIOUS GOVERNMENT FACILITIES', flags: [] };
    const s = scoreBid(notProgram, pilot, SCAN);
    expect(s.score).toBeLessThan(pilot.notify.minScore);
    expect(s.reasons).toContainEqual({ kind: 'minus', text: 'Several work sites listed — check which are in reach' });
    expect(s.reasons.some((r) => r.text.startsWith('Work location not listed'))).toBe(false); // SAM did list them
  });

  it('a named place that did not resolve says so, and gets 0 distance points', () => {
    const s = scoreBid(MOFFETT, pilot, SCAN);
    expect(s.reasons).toContainEqual({ kind: 'minus', text: 'Location could not be placed (“Moffett ANGB, Santa Clara County, California”) — check the distance' });
    const home = scoreBid({ ...MOFFETT, location: { ...MOFFETT.location, label: null, state: 'NV' } }, pilot, SCAN); // variant: a NV board listing
    // A new building filed under 236220 is sub work for an electrician; on its own 36–50 scale the 8 neutral
    // distance points are worth round(14 × 8 / 55) = 2.
    expect(s.tier).toBe('sub');
    expect(home.tier).toBe('sub');
    expect(s.score).toBeLessThan(home.score);
    const asFit = { ...MOFFETT, naics: '238990' }; // variant: a related code, so it is scored as a fit (the old rule)
    const fitHome = scoreBid({ ...asFit, location: { ...MOFFETT.location, label: null, state: 'NV' } }, pilot, SCAN);
    expect(scoreBid(asFit, pilot, SCAN).score).toBe(fitHome.score - Math.round(8 * 0.75)); // related-NAICS factor 0.75 × 8
  });

  it('a blank federal place: "Remediate Old Parking Garage" says the location is not listed and cannot alert', () => {
    const s = scoreBid(PARKING, pilot, SCAN);
    expect(s.reasons).toContainEqual({ kind: 'info', text: "Work location not listed — can't confirm it's within 90 mi" });
    const strong = scoreBid({ ...PARKING, title: 'Replace Electrical Switchgear', naics: '238210' }, pilot, SCAN); // variant
    // No point and no state: it could be anywhere, abroad included, so even a strong title is held under the deck line.
    expect([strong.score, strong.tier, strong.capped]).toEqual([34, 'other', true]);
  });

  it('a home-state board listing with no site keeps its neutral points (real NevadaEPro "Water Well Repair")', () => {
    const well = board(/^Water Well Repair$/);
    expect(well.location.state).toBe('NV');
    expect(well.location.lat).toBeNull();
    expect(scoreBid(well, pilot, CAPTURED).score).toBe(36);
    expect(texts(well)).toContain('Work location not listed — check the bid');
  });
});

describe('trade: what the title says the job is', () => {
  it('"Generator" on the state purchasing board (60, alerted) names no work: a likely purchase, below the alert line', () => {
    const gen = board(/^Generator$/);
    const s = scoreBid(gen, pilot, CAPTURED);
    expect(s.score).toBe(40);
    expect(s.verdict).toBe('maybe');
    expect(s.reasons).toContainEqual({ kind: 'minus', text: 'No work named in the title — may be a purchase, not a job' });
    expect(s.reasons.some((r) => r.text === 'May be supply-only')).toBe(false); // the minus says it
  });

  it('a title that names work keeps the small supply-board penalty (real "Water Well Repair", "OTAG Water Heater Replacement")', () => {
    for (const t of [/^Water Well Repair$/, /^OTAG Water Heater Replacement$/]) {
      const b = board(t);
      const s = scoreBid(b, pilot, CAPTURED);
      expect(scoreBid({ ...b, flags: [] }, pilot, CAPTURED).score - s.score, String(t)).toBe(5);
    }
  });

  it('an install job on the supply board still alerts (variant: the real Bunkerville title, flagged and placed in Carson City)', () => {
    const conn = board(/^Fire Station 71 Bunkerville Emergency Generator Connection$/);
    const v = { ...conn, flags: ['May be supply-only'], location: board(/^Replace Cell Doors/).location };
    expect(scoreBid(v, pilot, CAPTURED).score).toBeGreaterThanOrEqual(pilot.notify.minScore);
  });

  it('HVAC maintenance agreements (45 and 36 "maybe") are another trade\'s service contracts', () => {
    for (const t of [/^Northern Nevada - HVAC Maintenance Services$/, /^HVAC Maintenance Service$/]) {
      const s = scoreBid(board(t), pilot, CAPTURED);
      expect(s.score, String(t)).toBe(0);
      expect(s.rejected).toBe('Not your trade (“maintenance service”)');
    }
    // An electrical service contract is not touched: a strong title beats the exclude list.
    expect(scoreBid({ ...board(/^HVAC Maintenance Service$/), title: 'Electrical Maintenance Services' }, pilot, CAPTURED).rejected).toBeNull();
  });

  it('"circuit breaker" and one-word "streetlight" are electrical without help from NAICS or "LED" (variants of real titles)', () => {
    expect(texts({ ...J061, naics: null, setAside: 'SBA' }, pilot, SCAN)).toContain('Electrical scope: “circuit breaker”');
    const street = board(/Streetlight LED Upgrades/);
    const noLed = { ...street, title: 'Federal Project Number: CM-0003-(372) Streetlight Upgrades Phase 6', location: board(/^Replace Cell Doors/).location };
    expect(texts(noLed)).toContain('Electrical scope: “streetlight”');
    expect(scoreBid(noLed, pilot, CAPTURED).verdict).toBe('great');
  });

  it('elevator modernizations (53, two points under the alert line) are an elevator contractor\'s job', () => {
    for (const t of [/^Elevator Modernization, Building 17/, /^Elevator Modernization \(Bryan Building\)/]) {
      const s = scoreBid(board(t), pilot, CAPTURED);
      expect(s.verdict, String(t)).toBe('skip');
      expect(s.reasons).toContainEqual({ kind: 'minus', text: 'Mostly another trade (“elevator”)' });
    }
    // A sprinkler job that is also a fire alarm job keeps its electrical scope.
    expect(texts(board(/^Fire Sprinkler System Installation and Fire Alarm/))[0]).toBe('Electrical scope: “fire alarm”');
  });

  it('building work is sub work: the Dini Library restroom (25 skip, then 44 "maybe" fit) says so first', () => {
    const dini = board(/^WNC - Dini Library South Restroom Improvements$/);
    const s = scoreBid(dini, pilot, CAPTURED);
    expect(s.verdict).toBe('maybe');
    expect(s.tier).toBe('sub');
    expect(s.capped).toBe(true);
    expect(s.reasons[0]).toEqual({ kind: 'info', text: 'Sub work: a general contractor bids this building job (“restroom”); electrical is usually subcontracted' });
    expect(s.reasons[1]).toEqual({ kind: 'info', text: 'Quote the bidders: ask the agency who took out plans' }); // NGEM: no plan holders list we know of
    const marsh = scoreBid(board(/^Marsh Avenue Main Replacement$/), pilot, CAPTURED);
    expect(marsh.verdict).toBe('skip'); // a water main is not building work
    expect(marsh.tier).toBe('other');
  });

  it('building work can never alert: at most 50, whatever the distance, size and time', () => {
    const dini = board(/^WNC - Dini Library South Restroom Improvements$/);
    fc.assert(fc.property(fc.integer({ min: 1, max: 60 }), fc.option(fc.integer({ min: 1_000, max: 2_000_000 })), (days, est) => {
      const b = { ...dini, location: board(/^Replace Cell Doors/).location, dueAt: new Date(CAPTURED.getTime() + days * 86_400_000).toISOString(), estValue: est === null ? null : { min: est, max: est } };
      const s = scoreBid(b, pilot, CAPTURED);
      return s.score <= 50 && s.tier === 'sub' && s.capped === true;
    }));
  });

  it('the pilot\'s exclude list is the catalog\'s: no per-bid words, and nothing that names a kind of building', () => {
    expect(pilot.keywords.exclude).toEqual(mergeTrades(['electrical']).keywords.exclude);
    for (const w of ['audit*', 'medical', 'vehicle*', 'food', 'director', 'customer portal']) expect(pilot.keywords.exclude).not.toContain(w);
    // The raw CBP notice "...VEHICLE MAINTENANCE FACILITY..." (27c575bd, NAICS 236220) is building work, not "Not your trade".
    const cbp = sam({
      sourceId: '27c575bd41154587a87dfbdbc12d5345', category: 'Presolicitation', location: { state: 'CA', zip: '91917' }, dueAt: '2026-11-30T21:00:00.000Z',
      title: 'CUSTOMS AND BORDER PROTECTION BROWN FIELD BORDER PATROL STATION VEHICLE MAINTENANCE FACILITY SAN DIEGO COUNTY, CA', naics: '236220', setAside: null, flags: [],
    }); // variant: due date moved past the scan so the trade check is what decides
    expect(scoreBid(cbp, pilot, SCAN).rejected ?? '').not.toMatch(/^Not your trade/);
  });
});

describe('job size: only what the notice says', () => {
  it('no real bid states an estimate, and every open card says the size is not stated', () => {
    for (const b of real) {
      expect(b.estValue, b.title).toBeNull();
      const s = scoreBid(b, pilot, CAPTURED);
      if (!programTerm(b) && titleAmount(b.title) === null) expect(s.reasons, b.title).toContainEqual({ kind: 'info', text: 'Job size not stated' });
    }
  });
});

describe('gates only ever lower a score', () => {
  const gate = fc.constantFrom<(b: Bid) => Bid>(
    (b) => ({ ...b, setAside: 'SDVOSBC' }),
    (b) => ({ ...b, setAside: '8A' }),
    (b) => ({ ...b, flags: [...b.flags, 'Program contract'] }),
    (b) => ({ ...b, flags: [...b.flags, 'Presolicitation'] }),
    (b) => ({ ...b, flags: [...b.flags, 'RFI — info only, not a bid'] }),
    (b) => ({ ...b, flags: [...b.flags, 'May be supply-only'] }),
  );
  it('on every real board bid and the real SAM notices', () => {
    const bids = [...real, J061, JOC_8A, JOC_SB, MATOC, OTA, PARKING, MOFFETT];
    fc.assert(fc.property(fc.constantFrom(...bids), gate, (b, g) => {
      const now = b.source === 'samgov' ? SCAN : CAPTURED;
      return scoreBid(g(b), pilot, now).score <= scoreBid(b, pilot, now).score;
    }), { numRuns: 400 });
  });

  it('a place we cannot measure never scores above a home-state board listing with no site', () => {
    const bids = [...real, J061, JOC_SB, MATOC, OTA, PARKING, MOFFETT];
    const unplaced = fc.constantFrom<BidLocation>(
      NO_PLACE,
      { ...NO_PLACE, state: 'CA', precision: 'state', label: 'CA (location not listed)' },
      { ...NO_PLACE, label: 'Various locations', precision: 'unknown' },
      { ...NO_PLACE, state: 'NV', zip: '89999', precision: 'state', label: 'Somewhere, NV 89999' },
    );
    fc.assert(fc.property(fc.constantFrom(...bids), unplaced, (b, loc) => {
      const now = b.source === 'samgov' ? SCAN : CAPTURED;
      const home = scoreBid({ ...b, location: { ...NO_PLACE, state: 'NV', precision: 'state', label: 'Nevada (location not listed)' } }, pilot, now);
      const s = scoreBid({ ...b, location: loc }, pilot, now);
      return s.score <= home.score && s.score < pilot.notify.minScore;
    }), { numRuns: 400 });
  });
});

describe('an equipment PSC alone is never a fit: radar and targeting-pod repair are not electrical work (real 2026-11-14 notices)', () => {
  // The real rows (SAM.gov bulk file, 2026-11-14): title, NAICS, PSC and place as SAM wrote them. The electricians are
  // TEST companies (simulated) based in the job's own city, the best case for distance.
  const fedCard = (sol: string, title: string, naics: string, city: string, state: string, due: string): Bid => finalizeBid({
    source: 'samgov', sourceId: sol, sourceName: 'SAM.gov (federal)', title, agency: null, description: `Solicitation · Sol. ${sol}`,
    category: 'Solicitation', location: { city, state, zip: null, label: null }, postedAt: null, dueAt: due, estValue: null,
    naics, psc: 'J059', setAside: null, url: 'https://sam.gov/opp/test/view', flags: [], solNumber: sol,
  });
  const electrician = (zip: string): Profile => buildProfile(`test-elec-${zip}`, {
    businessName: 'TEST Electric (simulated)', trades: ['electrical'], zip, radiusMi: 90, valueRange: { min: 10_000, max: 50_000 },
  });
  const at = new Date('2026-11-14T08:00:00Z');

  it('70Z08526RRJ001B00 "TRS-3D /AN/SPS-75 Radar repairs" (J059, 811210, Baltimore) stays under 35', () => {
    const s = scoreBid(fedCard('70Z08526RRJ001B00', 'TRS-3D /AN/SPS-75 Radar repairs/ overhaul services', '811210', 'Baltimore', 'MD', '2026-12-01T17:00:00.000Z'), electrician('21201'), at);
    expect(s.score).toBeLessThan(CAPPED_FLOOR);
    expect(s.tier).toBe('other');
  });

  it('FA8540-26-R-0001 "Sniper … Targeting Pod" (J059, 334511, Orlando) stays under 35', () => {
    const s = scoreBid(fedCard('FA8540-26-R-0001', 'Sniper Comprehensive Advanced Targeting Pod (CATP2) Support and Sustainment Option Years 6 & 7', '334511', 'Orlando', 'FL', '2026-11-20T21:00:00.000Z'), electrician('32801'), at);
    expect(s.score).toBeLessThan(CAPPED_FLOOR);
    expect(s.tier).toBe('other');
  });
});
