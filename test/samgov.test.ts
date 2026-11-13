/**
 * SAM.gov on REAL notices: the three API responses captured 2026-11-13 (test/fixtures/samgov-*.json, trimmed,
 * see their _comment). Parser shapes, the flags the scorer acts on, set-asides named only in a title,
 * one card per solicitation, and what a scan does with them over several days.
 * Anything made up says so (TEST, "(synthetic)").
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { getBid, getFeed, getOpenBids } from '../src/db/repo.js';
import { loadProfile } from '../src/profiles.js';
import { createBus, type BusEventOf } from '../src/realtime/bus.js';
import { finalizeBid, runScan } from '../src/scan.js';
import { scoreBid } from '../src/score/score.js';
import { inheritFromStored, mergeDrafts, samKey } from '../src/sources/dedupe.js';
import {
  isProgramContract, isPresolicitation, parseSamPlace, parseSamResponse, SAM_FLAGS, setAsideFromText,
  type SamOpportunity, type SamResponse,
} from '../src/sources/samgov.js';
import type { BidDraft, Profile, Source } from '../src/types.js';
import { fx, memoryDb, realBids, resetDb, scanCtx } from './helpers.js';

const FILES = ['samgov-nv.json', 'samgov-ca-238210.json', 'samgov-ca-236220.json'];
const responses = FILES.map((f) => JSON.parse(fx(f)) as SamResponse);
const ALL: SamOpportunity[] = responses.flatMap((r) => r.opportunitiesData ?? []);

/** One real notice by the start of its notice id. */
function notice(prefix: string): SamOpportunity {
  const hits = ALL.filter((o) => o.noticeId.startsWith(prefix));
  if (hits.length !== 1) throw new Error(`${hits.length} notices start with ${prefix}`);
  return hits[0]!;
}
/** One real notice through the parser on its own (no siblings to merge with). */
const one = (prefix: string): BidDraft => parseSamResponse({ opportunitiesData: [notice(prefix)] })[0]!;
const byKey = (bids: BidDraft[], key: string) => bids.find((b) => b.sourceId === key)!;

describe('SAM.gov place of performance — every shape in the real responses', () => {
  it('city / state / zip objects', () => {
    expect(one('0219242e').location).toEqual({ city: 'Reno', state: 'NV', zip: '89502', label: null });
  });

  it('street address + ZIP, no city or state objects: the state comes from the address', () => {
    // "MARINE CORPS AIR GROUND COMBAT CENTER TWENTYNINE PALMS, CALIFORNIA 92278"
    expect(one('9e36b34d').location).toEqual({
      city: null, state: 'CA', zip: '92278', label: 'MARINE CORPS AIR GROUND COMBAT CENTER TWENTYNINE PALMS, CALIFORNIA 92278',
    });
    // "USACE Sacramento District 1325 J Street Sacramento, CA 95814": a code before the ZIP counts too
    expect(one('a1860ddd').location).toMatchObject({ city: null, state: 'CA', zip: '95814' });
    // "Yuma Proving Ground (YPG) in Yuma, Arizona" with zip "" (past due, still a real shape)
    expect(one('b008a033').location).toMatchObject({ city: null, state: 'AZ', zip: null });
  });

  it('a city of "0" is no city', () => {
    expect(one('e323b574').location).toMatchObject({ city: null, state: 'CA', zip: '94035' });
    expect(one('def2d199').location).toMatchObject({ city: null, state: 'CA', zip: '95652' });
  });

  it('a state given by name only, full or as the code', () => {
    expect(notice('eb5f5f38').placeOfPerformance?.state).toEqual({ name: 'Hawaii' });
    expect(one('eb5f5f38').location).toMatchObject({ city: 'Honolulu', state: 'HI', zip: '96819' });
    expect(notice('319573e7').placeOfPerformance?.state).toEqual({ name: 'CA' });
    expect(one('319573e7').location).toMatchObject({ city: 'Mather', state: 'CA', zip: '95655' });
  });

  it('blank: empty objects, or empty strings', () => {
    const empty = { city: null, state: null, zip: null, label: null };
    expect(notice('06025073').placeOfPerformance).toEqual({ city: {}, state: {}, country: {} });
    expect(one('06025073').location).toEqual(empty);
    expect(notice('1ed4c9c9').placeOfPerformance).toEqual({ streetAddress: '', zip: '' });
    expect(one('1ed4c9c9').location).toEqual(empty);
  });

  it('several sites: says so instead of picking one, and keeps the state only when there is one', () => {
    // Barstow, 29 Palms, Bridgeport and China Lake, "CALIFORNIA AREA OF RESPONSIBILITY (AOR) AND OTHER LOCATIONS"
    expect(one('c2d76e01').location).toEqual({ city: null, state: 'CA', zip: null, label: 'Several sites in CA — see the bid' });
    // "Northern and Central California and Nevada"
    expect(one('562387fb').location).toEqual({ city: null, state: null, zip: null, label: 'Several sites in CA, NV — see the bid' });
    expect(parseSamPlace(notice('562387fb').placeOfPerformance).multiSite).toBe(true);
    expect(parseSamPlace(notice('9e36b34d').placeOfPerformance).multiSite).toBe(false); // one base, one ZIP
  });

  it('never reads "Sierra Nevada" or "VA" (Veterans Affairs) as a state', () => {
    // Remediate Old Parking Garage's presolicitation: "VA Sierra Nevada Health Care System …", city Reno, state NV
    expect(one('2c8dcb32').location).toMatchObject({ city: 'Reno', state: 'NV' });
    const synthetic = parseSamPlace({ streetAddress: 'TEST VA Sierra Nevada Health Care System (synthetic)' });
    expect(synthetic).toMatchObject({ state: null, multiSite: false });
  });

  it('does not fall back to the contracting office: the VA office in Mather buys for Reno and Honolulu', () => {
    expect(notice('ebf23d8b')).toHaveProperty('officeAddress');
    expect(one('ebf23d8b').location).toEqual({ city: null, state: null, zip: null, label: null });
  });
});

describe('SAM.gov flags the scorer acts on', () => {
  const flagged = (flag: string) => ALL.filter((o) => (parseSamResponse({ opportunitiesData: [o] })[0]!.flags ?? []).includes(flag))
    .map((o) => o.noticeId.slice(0, 8)).sort();

  it('uses exactly the agreed strings', () => {
    expect(SAM_FLAGS).toEqual({ presolicitation: 'Presolicitation', programContract: 'Program contract' });
  });

  it('"Presolicitation": SAM\'s own type, or a title that says it is the advance notice', () => {
    expect(flagged('Presolicitation')).toEqual(['2c8dcb32', '319573e7', 'b008a033', 'cd18dd20', 'eb5f5f38', 'f3a59bd0']);
    // b008a033 is typed "Solicitation" but titled "PRESOLICITATION NOTICE (SYNOPSIS): …"
    expect(notice('b008a033').type).toBe('Solicitation');
    // Typed Solicitation with baseType "Sources Sought": the notice became a solicitation, so no flag.
    expect(notice('3d44351e')).toMatchObject({ type: 'Solicitation', baseType: 'Sources Sought' });
    // "Solicitation: Construct Combat Rescue Helicopter …" is not "Presolicitation"
    expect(isPresolicitation(notice('e323b574'))).toBe(false);
  });

  it('"Program contract": IDIQ / JOC / MATOC / MACC / OTA vehicles, and no single job', () => {
    expect(flagged('Program contract')).toEqual(['05be123f', '562387fb', '9e36b34d', 'a1860ddd', 'c2d76e01', 'cd18dd20', 'f3a59bd0']);
    // "via Other Transaction Authority", "$465M … MATOC", "General Construction Job Order Contract (JOC)"
    expect(isProgramContract(notice('05be123f').title)).toBe(true);
    // Every other real title — the other 25 SAM notices and all the Nevada boards' bids — is a single job.
    const singles = [...ALL.filter((o) => !flagged('Program contract').includes(o.noticeId.slice(0, 8))).map((o) => o.title!),
      ...realBids().map((b) => b.title)];
    expect(singles.length).toBeGreaterThan(100);
    expect(singles.filter((t) => isProgramContract(t))).toEqual([]);
    // Local annual-requirements contracts are not on the list (a small shop may want those).
    expect(realBids().some((b) => /^ANNUAL REQUIREMENTS CONTRACT/.test(b.title))).toBe(true);
  });

  it('keeps the solicitation number and the notice type on the bid', () => {
    expect(one('9e36b34d')).toMatchObject({ solNumber: 'N6247327R0014', category: 'Solicitation' });
    expect(one('319573e7')).toMatchObject({ solNumber: '36C26127Q0112', category: 'Presolicitation' });
  });
});

describe('SAM.gov set-aside named only in the title', () => {
  it('fills an empty code from the title: the 8(a) JOC', () => {
    expect(notice('9e36b34d').typeOfSetAside).toBeNull();
    expect(one('9e36b34d').setAside).toBe('8A');
  });

  it('never overrides a code SAM gave, and only one real notice changes', () => {
    expect(one('c2d76e01').setAside).toBe('SBA'); // "TOTAL SMALL-BUSINESS SET-ASIDE", code SBA
    const changed = ALL.filter((o) => (o.typeOfSetAside ?? null) !== one(o.noticeId.slice(0, 8)).setAside && ALL.filter((x) => x.solicitationNumber === o.solicitationNumber).length === 1);
    expect(changed.map((o) => o.noticeId.slice(0, 8))).toEqual(['9e36b34d']);
  });

  it('reads the programs SAM uses, and nothing else', () => {
    expect(setAsideFromText(notice('80e66104').title)).toBeNull(); // Fire Alarm … DDJC, Tracy, CA
    expect(setAsideFromText('R-12, R-17, and PS-8A Rehabilitation')).toBeNull(); // real NGEM title: a part number
    expect(realBids().filter((b) => setAsideFromText(b.title))).toEqual([]);
    expect(setAsideFromText('TEST SDVOSB Replace Emergency Generator (synthetic)')).toBe('SDVOSBC');
    expect(setAsideFromText('TEST HUBZone set-aside: lighting retrofit (synthetic)')).toBe('HZC');
    expect(setAsideFromText('TEST Women-Owned Small Business set-aside, panel upgrade (synthetic)')).toBe('WOSB');
    expect(setAsideFromText('TEST Total Small Business Set-Aside, switchgear (synthetic)')).toBe('SBA');
    expect(setAsideFromText('TEST Unrestricted, HUBZone price evaluation preference applies (synthetic)')).toBeNull();
  });
});

describe('one card per solicitation', () => {
  it('keys a card on the stable part of the solicitation number (real numbers)', () => {
    expect(samKey('36C26127Q0072_1', 'x')).toBe('36C26127Q0072');
    expect(samKey('36C26127Q00260001', 'x')).toBe('36C26127Q0026');
    expect(samKey('36C26127Q0026', 'x')).toBe('36C26127Q0026');
    expect(samKey('N6247324R2610', 'x')).toBe('N6247324R2610');
    expect(samKey('PANNGB27P0000042127', 'x')).toBe('PANNGB27P0000042127'); // not the 13-character form: left alone
    expect(samKey(null, '06025073949')).toBe('06025073949');
    expect(samKey('  ', 'abc')).toBe('abc');
  });

  const building = parseSamResponse(responses[2]!); // the CA 236220 response

  it('three notices of "Replace Dental Vacuum Piping" (one numbered _1) are one card, the newest', () => {
    expect(['f6bc57b0', 'b494949b', '1fec7c17'].map((p) => notice(p).solicitationNumber)).toEqual(['36C26127Q0072_1', '36C26127Q0072', '36C26127Q0072']);
    expect(building.filter((b) => b.title === 'Z1DZ--Replace Dental Vacuum Piping')).toHaveLength(1);
    expect(byKey(building, '36C26127Q0072').url).toContain(notice('f6bc57b0').noticeId); // posted 11-10, the others 10-19
  });

  it('the live solicitation inherits the place and set-aside only its presolicitation carried', () => {
    // Remediate Old Parking Garage: ebf23d8b (Solicitation, 11-12) is blank; 2c8dcb32 (10-07) says Reno VA, SDVOSB.
    const garage = byKey(building, '36C26126Q1297');
    expect(garage.url).toContain(notice('ebf23d8b').noticeId);
    expect(garage).toMatchObject({ category: 'Solicitation', setAside: 'SDVOSBC', location: { city: 'Reno', state: 'NV', zip: '89502' } });
    expect(garage.flags).not.toContain('Presolicitation'); // that described the older notice
    // ACC MOD 2 Renovation: a8e68b42 (Solicitation) + eb5f5f38 (Presolicitation, Honolulu)
    expect(byKey(building, '36C26126Q1295')).toMatchObject({ category: 'Solicitation', setAside: 'SDVOSBC', location: { city: 'Honolulu', state: 'HI' } });
  });

  it('two different JOCs with near-identical titles stay two cards', () => {
    const electrical = parseSamResponse(responses[1]!);
    expect(electrical.filter((b) => b.title.startsWith('IDIQ JOC')).map((b) => b.sourceId)).toEqual(['N6247324R2610', 'N6247327R0014']);
  });

  it('merges across queries the same way (runScan merges every source\'s drafts)', () => {
    const fromTwoQueries = [...parseSamResponse({ opportunitiesData: [notice('b494949b')] }), ...parseSamResponse({ opportunitiesData: [notice('f6bc57b0')] })];
    const merged = mergeDrafts(fromTwoQueries);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.url).toContain(notice('f6bc57b0').noticeId);
  });

  it('carries over a place from the stored card only when that card read it from the listing', () => {
    const stored = finalizeBid(one('2c8dcb32')); // Reno, precision city
    const blank = one('ebf23d8b');
    expect(stored.id).toBe(`samgov:${blank.sourceId}`);
    expect(inheritFromStored(blank, stored)).toMatchObject({ setAside: 'SDVOSBC', location: { city: 'Reno', state: 'NV', zip: '89502' } });
    // A stored guess (here: the state alone) is not carried over; coordinates never are.
    const guessed = { ...stored, location: { ...stored.location, city: null, zip: null, precision: 'state' as const } };
    expect(inheritFromStored(blank, guessed).location).toEqual(blank.location);
    expect(inheritFromStored(blank, stored).location).not.toHaveProperty('lat');
  });
});

describe('scans over several days (real notices, in-memory database)', () => {
  let db: Db;
  beforeAll(async () => {
    db = await memoryDb();
  });
  afterAll(async () => db.close());
  beforeEach(async () => resetDb(db));

  // The pilot, made eligible for the VA's SDVOSB set-aside and alerted from 1 point up, so the real Reno
  // breaker-testing job is an alert whatever the set-aside rules are (simulated settings, not L&M's).
  const pilot = loadProfile('lm-electric');
  const profile: Profile = { ...pilot, setAsidesEligible: [...pilot.setAsidesEligible, 'SDVOSBC'], alerts: { minScore: 1 } };
  const samSource = (drafts: BidDraft[]): Source => ({ id: 'samgov', name: 'SAM.gov (TEST replay)', homepage: '', fetch: async () => drafts });
  const BREAKERS = 'samgov:36C26127Q0067'; // J061--Triennial Circuit Breaker and Feeder Testing, Reno, due 2026-11-20 12:00 PT

  async function scan(at: string, drafts: BidDraft[]) {
    const bus = createBus();
    const matches: Array<BusEventOf<'match'>> = [];
    bus.on('match', (e) => void matches.push(e));
    const report = await runScan({ db, sources: [samSource(drafts)], profiles: [profile], ctx: scanCtx(new Date(at)), bus });
    return { report, matches };
  }
  const reasonsOf = async (id: string, at: string) =>
    (await getFeed(db, profile.id, { now: new Date(at), minScore: 0 })).find((b) => b.id === id)?.reasons;

  it('re-scores a stored bid the board no longer returns, and does not announce it again', async () => {
    const first = await scan('2026-11-09T14:15:00Z', [one('0219242e')]);
    expect(first.matches.map((m) => [m.bid.id, m.isNewBid])).toEqual([[BREAKERS, true]]);
    const stored = (await getBid(db, BREAKERS))!;
    expect(await reasonsOf(BREAKERS, '2026-11-09T14:15:00Z')).toEqual(scoreBid(stored, profile, new Date('2026-11-09T14:15:00Z')).reasons);

    // Ten days later SAM's 3-day window no longer holds it. The card must not still say "11 days to bid".
    const later = await scan('2026-11-19T14:15:00Z', []);
    expect(later.report.totalBids).toBe(0);
    expect(later.report.profiles[profile.id]!.scored).toBe(1);
    expect(later.matches).toEqual([]); // stored quietly, never re-announced
    const now = scoreBid(stored, profile, new Date('2026-11-19T14:15:00Z')).reasons;
    expect(await reasonsOf(BREAKERS, '2026-11-19T14:15:00Z')).toEqual(now);
    expect(now).not.toEqual(scoreBid(stored, profile, new Date('2026-11-09T14:15:00Z')).reasons);

    // Once it has closed it is neither re-scored nor served.
    const closed = await scan('2026-11-21T14:15:00Z', []);
    expect(closed.report.profiles[profile.id]!.scored).toBe(0);
    expect(await reasonsOf(BREAKERS, '2026-11-21T14:15:00Z')).toBeUndefined();
  });

  it('a bid fetched again is still announced as before (not new any more)', async () => {
    await scan('2026-11-09T14:15:00Z', [one('0219242e')]);
    const again = await scan('2026-11-10T14:15:00Z', [one('0219242e')]);
    expect(again.matches.map((m) => [m.bid.id, m.isNewBid])).toEqual([[BREAKERS, false]]);
    expect(again.report.newBids).toBe(0);
  });

  it('a solicitation seen in two scans is one card that keeps what the earlier notice said', async () => {
    // Oct 8: the presolicitation (Reno VA, SDVOSB). Nov 13: the solicitation, with a blank place and no set-aside.
    await scan('2026-10-08T14:15:00Z', [one('2c8dcb32')]);
    const second = await scan('2026-11-13T14:15:00Z', [one('ebf23d8b')]);
    expect(second.report.newBids).toBe(0); // the same card, not a new one
    const open = await getOpenBids(db, new Date('2026-11-13T14:15:00Z'));
    expect(open.map((b) => b.id)).toEqual(['samgov:36C26126Q1297']);
    expect(open[0]).toMatchObject({
      title: 'Z2DA--654-24-004 | Remediate Old Parking Garage', category: 'Solicitation', setAside: 'SDVOSBC',
      location: { city: 'Reno', state: 'NV', precision: 'city' }, dueAt: '2026-11-20T23:00:00.000Z',
    });
    expect(open[0]!.url).toContain(notice('ebf23d8b').noticeId);
    expect(open[0]!.flags).not.toContain('Presolicitation');
  });

  it('the same solicitation from two queries in one scan is one card', async () => {
    const { report } = await scan('2026-11-13T14:15:00Z', [one('b494949b'), one('1fec7c17'), one('f6bc57b0')]);
    expect(report.sources.samgov).toMatchObject({ fetched: 3 });
    expect(report.totalBids).toBe(1);
    expect((await getOpenBids(db, new Date('2026-11-13T14:15:00Z'))).map((b) => b.id)).toEqual(['samgov:36C26127Q0072']);
  });
});
