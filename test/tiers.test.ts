/**
 * Tiers: fit · sub work · other (src/score/subwork.ts, src/score/score.ts, the feed's tier filter and counts).
 * The bids are the REAL captured pages where one exists (realBids(), the SAM.gov captures) and synthetic TEST bids
 * (example.com, "(synthetic)") where a rule needs a shape no captured bid has. Companies are simulated (TEST …).
 */
import fc from 'fast-check';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { getFeed, getFeedCounts, getUnnotified, upsertBids, upsertMatches } from '../src/db/repo.js';
import { pickNext } from '../src/feed/next.js';
import { buildProfile } from '../src/profile/build.js';
import { loadProfile } from '../src/profiles.js';
import { decideMatch } from '../src/realtime/alerts.js';
import { createBus, type BusEventOf } from '../src/realtime/bus.js';
import { deckTiers, parseFeedQuery } from '../src/routes/feed.js';
import { mayAnnounce, runScan } from '../src/scan.js';
import { scoreBid, SUB_MAX, SUB_MIN } from '../src/score/score.js';
import { pscLabel, quoteAction, subWorkFor } from '../src/score/subwork.js';
import { buildServer } from '../src/server.js';
import { FLAGS } from '../src/sources/flags.js';
import { BUILDING_PRIME_NAICS, PRIME_TRADE, SUB_WORK, TRADES } from '../src/trades/catalog.js';
import type { Bid, BidDraft, FeedItem, Profile } from '../src/types.js';
import { CAPTURED, memoryDb, NOW, realBids, scanCtx, testBid, testProfile } from './helpers.js';

const pilot = loadProfile('lm-electric');
const company = (trades: string[], over: Partial<Profile> = {}): Profile => ({
  ...buildProfile(`test-${trades.join('-')}`, { businessName: 'TEST Tier Co (simulated)', trades, zip: '89410', radiusMi: 90, valueRange: { min: 10_000, max: 50_000 } }),
  ...over,
});
/** A synthetic federal notice near the pilot (Carson City), due in three weeks of NOW. */
const fed = (over: Partial<BidDraft>): Bid => testBid({ source: 'samgov', ...over });
const reasonTexts = (b: Bid, p: Profile = pilot, now = NOW) => scoreBid(b, p, now).reasons.map((r) => r.text);

describe('each trade has a sub-work rule in the catalog', () => {
  it('every catalog trade is listed; general building is the prime and has none', () => {
    expect(Object.keys(SUB_WORK).sort()).toEqual(TRADES.map((t) => t.id).sort());
    expect(SUB_WORK[PRIME_TRADE]).toEqual({ building: null, civil: [] });
    expect(BUILDING_PRIME_NAICS).toEqual(['236220', '236210']);
  });

  const newBuilding = fed({ title: 'TEST Construct New Fire Station Building (synthetic)', naics: '236220', psc: 'Y1JZ' });
  const renovation = fed({ title: 'TEST Clinic Renovation (synthetic)', naics: '236220', psc: 'Z2DA' });
  it.each(TRADES.map((t) => [t.id] as const))('%s: a new building and a renovation follow its list', (id) => {
    const p = company([id]);
    const spec = SUB_WORK[id]!;
    expect(scoreBid(newBuilding, p, NOW).tier === 'sub', 'new building').toBe(spec.building !== null);
    expect(scoreBid(renovation, p, NOW).tier === 'sub', 'renovation').toBe(spec.building === 'all');
  });
});

describe('sub work: what counts', () => {
  it('a federal building job filed under 236220: sub work, said first, the code named, the bidders to quote', () => {
    const s = scoreBid(renovation(), pilot, NOW);
    expect(s.tier).toBe('sub');
    expect(s.verdict).toBe('maybe');
    expect(s.capped).toBe(true);
    expect(s.reasons.slice(0, 3)).toEqual([
      { kind: 'info', text: 'Sub work: a general contractor bids this building job (“renovat”); electrical is usually subcontracted' },
      { kind: 'info', text: 'Filed as NAICS 236220 — Commercial and Institutional Building Construction' },
      { kind: 'info', text: 'Quote the bidders: check the interested vendors list on SAM.gov' },
    ]);
  });
  function renovation(over: Partial<BidDraft> = {}): Bid {
    return fed({ title: 'TEST Renovate Building 12 Offices (synthetic)', naics: '236220', psc: 'Z2AA', ...over });
  }

  it('a building PSC without a NAICS code names the PSC title (from src/sources/psc.ts)', () => {
    expect(reasonTexts(renovation({ naics: null }))[1]).toBe('Filed as PSC Z2AA — Repair or alteration of office buildings');
    expect(pscLabel('Z2AA')).toBe('PSC Z2AA — Repair or alteration of office buildings');
  });

  it('a "Construction of …" PSC with a building in the title needs no work word; one system or one repair does not count', () => {
    const lpoe = fed({ title: 'TEST Land Port of Entry, Somewhere (synthetic)', naics: '236220', psc: 'Y1AZ' });
    expect(reasonTexts(lpoe)[0]).toBe('Sub work: a general contractor bids this building construction job; electrical is usually subcontracted');
    expect(scoreBid(fed({ title: 'TEST Replace Pneumatic Tube System (synthetic)', naics: '236220', psc: 'Y1DA' }), pilot, NOW).tier).not.toBe('sub');
    expect(scoreBid(fed({ title: 'TEST Lightning Protection System, Area 8 (synthetic)', naics: null, psc: 'Y1JZ' }), pilot, NOW).tier).not.toBe('sub');
  });

  it('a board listing (no code) counts only by whole-building words; the action names the board', () => {
    const dini = realBids().find((b) => /^WNC - Dini Library South Restroom Improvements$/.test(b.title))!;
    expect(scoreBid(dini, pilot, CAPTURED).tier).toBe('sub');
    const quest = testBid({ source: 'questcdn', title: 'TEST Library Renovation (synthetic)', naics: null });
    expect(reasonTexts(quest)).toContain('Quote the bidders: the plan holders list is on the project’s QuestCDN page');
    expect(quoteAction('ngem')).toBe('Quote the bidders: ask the agency who took out plans');
    // "construction" alone on a board says nothing about a building
    expect(scoreBid(testBid({ source: 'ngem', title: 'TEST Construction Services 2026 (synthetic)' }), pilot, NOW).tier).not.toBe('sub');
  });

  it('not sub work: the company\'s own trade or a related one in the title (a fit), another trade\'s job, a teardown', () => {
    expect(scoreBid(renovation({ title: 'TEST Renovate Electrical Room (synthetic)' }), pilot, NOW).tier).toBe('fit');
    expect(scoreBid(renovation({ title: 'TEST Renovation of the Boiler Plant (synthetic)' }), pilot, NOW).reasons[0]!.text).toBe('Related trade: “boiler”');
    for (const title of [
      'TEST Roof Renovation, Building 4 (synthetic)', // roofing, another trade
      'TEST Renovate Flooring in Building 9 (synthetic)', // flooring
      'TEST Modernize Nurse Call, Building 2 (synthetic)', // low voltage's own work
      'TEST Building 7 Demolition and Abatement (synthetic)', // a teardown
      'TEST Parking Garage Renovation (synthetic)', // a structure, not a building
    ]) expect(scoreBid(renovation({ title }), pilot, NOW).tier, title).not.toBe('sub');
  });

  it('not sub work: a specialty or heavy-civil NAICS (that trade is the prime), a program contract, a posted local job', () => {
    expect(scoreBid(renovation({ naics: '238160' }), pilot, NOW).tier).not.toBe('sub'); // a roofer primes it
    expect(scoreBid(renovation({ naics: '237990', psc: 'Y1JZ', title: 'TEST Creek Fishway Construction (synthetic)' }), pilot, NOW).tier).not.toBe('sub');
    expect(scoreBid(renovation({ title: 'TEST IDIQ MACC Building Renovations (synthetic)' }), pilot, NOW).tier).toBe('other');
    const local = testBid({ source: 'local', title: 'TEST Kitchen remodel (synthetic)', category: 'Plumbing' });
    expect(subWorkFor(local, ['electrical'], { fitInTitle: false, otherInTitle: null, supplyOnly: false, program: false })).toBeNull();
  });

  it('not sub work for a company with the general-building trade (it is the prime), alone or with another trade', () => {
    for (const trades of [['general-building'], ['general-building', 'electrical']]) {
      expect(scoreBid(renovation(), company(trades), NOW).tier, trades.join('+')).not.toBe('sub');
    }
  });

  it('not sub work when reach cannot be checked: no map point and no state', () => {
    const abroad = renovation({ location: { label: 'Camp Courtney, Okinawa, Japan' } });
    expect(abroad.location.lat).toBeNull();
    expect(abroad.location.state).toBeNull();
    expect(scoreBid(abroad, pilot, NOW).tier).not.toBe('sub');
  });

  it('civil: a road job is sub work for an electrician only when its own text names electrical scope', () => {
    const road = testBid({ source: 'ngem', title: 'TEST Main Street Widening (synthetic)', description: 'Includes new traffic signals at two intersections.' });
    expect(reasonTexts(road)[0]).toBe('Sub work: a general contractor bids this road job; the notice names electrical scope (“traffic signal”)');
    expect(scoreBid({ ...road, description: 'Asphalt and curb only.' }, pilot, NOW).tier).not.toBe('sub');
    expect(scoreBid(road, company(['plumbing']), NOW).tier).not.toBe('sub'); // plumbing does not sit in roads
  });
});

describe('sub work: the rules that apply to fits apply to it', () => {
  const job = (over: Partial<BidDraft> = {}) => fed({ title: 'TEST Renovate Clinic Building (synthetic)', naics: '236220', psc: 'Z2DA', ...over });

  it('reach, time to bid and the exclude list: a hard no is tier "other" at 0', () => {
    const far = scoreBid(job({ location: { city: 'Las Vegas', state: 'NV' } }), pilot, NOW);
    expect([far.tier, far.score]).toEqual(['other', 0]);
    expect(far.rejected).toMatch(/mi away — outside your 90 mi range/);
    const late = scoreBid(job({ dueAt: '2026-11-01T22:00:00.000Z' }), pilot, NOW);
    expect([late.tier, late.score, late.rejected]).toEqual(['other', 0, 'Bid deadline has passed']);
    const excluded = scoreBid(job({ title: 'TEST Janitorial Services Renovation (synthetic)' }), pilot, NOW);
    expect([excluded.tier, excluded.rejected]).toEqual(['other', 'Not your trade (“janitorial”)']);
  });

  it('score 36–50 from reach, time and size: closer, longer and a size that fits sort first', () => {
    const near = scoreBid(job({ location: { city: 'Minden', state: 'NV' } }), pilot, NOW).score;
    const farther = scoreBid(job({ location: { city: 'Reno', state: 'NV' } }), pilot, NOW).score;
    const rushed = scoreBid(job({ location: { city: 'Minden', state: 'NV' }, dueAt: new Date(NOW.getTime() + 2 * 86_400_000).toISOString() }), pilot, NOW).score;
    const tiny = scoreBid(job({ location: { city: 'Minden', state: 'NV' }, estValue: { min: 5_000, max: 5_000 } }), pilot, NOW);
    expect(near).toBeGreaterThan(farther);
    expect(near).toBeGreaterThan(rushed);
    expect(near).toBeGreaterThan(tiny.score);
    expect(tiny.reasons).toContainEqual({ kind: 'minus', text: 'Whole job est. $5K — your part would be under your usual jobs' });
    const big = scoreBid(job({ estValue: { min: 2_000_000, max: 2_000_000 } }), pilot, NOW);
    expect(big.reasons).toContainEqual({ kind: 'info', text: 'Whole job est. $2M — your part is a share of it' });
    for (const s of [near, farther, rushed, tiny.score, big.score]) expect(s).toBeGreaterThanOrEqual(SUB_MIN);
    expect(Math.max(near, farther, rushed, tiny.score, big.score)).toBeLessThanOrEqual(SUB_MAX);
  });

  it('a set-aside is the prime bidder\'s rule: said, not held against sub work; SAM registration is not asked', () => {
    const vet = scoreBid(job({ setAside: 'SDVOSBC' }), pilot, NOW);
    expect(vet.tier).toBe('sub');
    expect(vet.reasons).toContainEqual({ kind: 'info', text: 'Service-disabled veteran set-aside — it applies to the prime bidder' });
    const q = { statePublicWorks: 'unsure', samRegistered: 'no', bonding: 'unsure', prevailingWage: 'unsure' } as const;
    expect(scoreBid(job(), { ...pilot, qualifications: q }, NOW).reasons.some((r) => /SAM\.gov registration/.test(r.text))).toBe(false);
  });

  it('spend limits are the prime bidder\'s: a big prime is never over the company\'s limit, and "Sub work:" stays first', () => {
    const s = scoreBid(job({ estValue: { min: 900_000, max: 900_000 }, flags: ['Bid bond'] }),
      { ...pilot, limits: { maxJobSize: 100_000, bondingCapacity: 100_000 } }, NOW);
    expect([s.tier, s.overLimit]).toEqual(['sub', false]);
    expect(s.reasons[0]!.text).toMatch(/^Sub work: /);
    expect(s.reasons.some((r) => /job limit|bonding capacity/.test(r.text))).toBe(false);
  });
});

describe('new-building-only trades on a Z1 / Z2 code (work on an existing building)', () => {
  it('47PB5427R0003 Joint Cyber Facility (Z2JZ, 236220: a build-out inside existing Building 810) is no roofer\'s sub work', () => {
    // The real row's title, codes and place (SAM.gov bulk file, 2026-11-14); the companies are TEST (simulated).
    const jcf = fed({
      title: 'Department Of Energy - National Nuclear Security Administration Joint Cyber Facility Construction Solicitation',
      naics: '236220', psc: 'Z2JZ', location: { city: 'Lakewood', state: 'CO', zip: '80225' }, dueAt: '2026-12-07T18:00:00.000Z',
    });
    const near = (trades: string[]) => ({ ...company(trades), base: { lat: 39.7047, lng: -105.0814, label: 'Lakewood, CO' }, states: ['CO'] });
    for (const t of ['roofing', 'landscaping', 'concrete-paving', 'sitework']) expect(scoreBid(jcf, near([t]), NOW).tier, t).not.toBe('sub');
    expect(scoreBid(jcf, near(['electrical']), NOW).tier).toBe('sub'); // 'all' trades still quote it
  });
});

describe('a federal trade PSC and a notice placed at its contracting office', () => {
  it('an equipment PSC (J061) is a weak signal; a facility PSC (Z2MZ, power plants) counts like the trade\'s NAICS', () => {
    const b = fed({ title: 'TEST Feeder Testing Services (synthetic)', naics: '561210', psc: 'J061' });
    const s = scoreBid(b, pilot, NOW);
    expect(s.reasons[0]).toEqual({
      kind: 'plus', text: 'Filed as PSC J061 — Maint/repair/rebuild of equipment- electric wire and power distribution equipment — equipment work, check the scope',
    });
    expect(s.score).toBeLessThan(35); // alone it never reaches the deck; with the scope in the title it does (below)
    const plant = fed({ title: 'TEST Feeder Testing Services (synthetic)', naics: '561210', psc: 'Z2MZ' });
    expect(scoreBid(plant, pilot, NOW).score).toBe(scoreBid({ ...plant, psc: null, naics: '238210' }, pilot, NOW).score);
    expect(scoreBid({ ...b, title: 'TEST Switchgear Testing (synthetic)' }, pilot, NOW).reasons[0]!.text).toBe('Electrical scope: “switchgear” + PSC J061');
    expect(scoreBid(b, company(['plumbing']), NOW).reasons[0]!.text).not.toMatch(/^Filed as PSC/);
  });

  it('the distance is to the contracting office: said, no distance points, never an alert; far away is a no', () => {
    const at = fed({ title: 'TEST Switchgear Replacement (synthetic)', naics: '238210', flags: [FLAGS.placeFromOffice] });
    const s = scoreBid(at, pilot, NOW);
    expect(s.capped).toBe(true);
    expect(s.distanceMi).toBeNull(); // the miles are to the office: never shown as the job's distance, never sorted on
    expect(s.reasons.some((r) => r.kind === 'minus' && /^Work site not named — \d+ mi is to the contracting office, check the notice$/.test(r.text))).toBe(true);
    expect(s.reasons.some((r) => r.text === FLAGS.placeFromOffice)).toBe(false); // said once
    expect(s.score).toBeLessThan(scoreBid({ ...at, flags: [] }, pilot, NOW).score);
    expect(s.score).toBeLessThan(pilot.notify.minScore);
    const far = scoreBid({ ...at, location: { ...at.location, lat: 36.17, lng: -115.14 } }, pilot, NOW);
    expect(far.rejected).toMatch(/^\d+ mi to the contracting office — outside your 90 mi range \(work site not named\)$/);
  });
});

describe('property: sub work is silent, on its own scale, and never for the prime', () => {
  const TITLES = [
    'Renovate Building 5', 'Construct New Office Building', 'Clinic Remodel', 'Restroom Improvements', 'Barracks Replacement',
    'Replace Roof at Building 3', 'Lighting Retrofit', 'Main Street Widening', 'Water Main Replacement', 'HVAC Renovation',
    'Tenant Improvement Suite 200', 'Library Renovation and Addition', 'Janitorial Services', 'IDIQ MACC Renovations',
  ];
  const arb = fc.record({
    title: fc.constantFrom(...TITLES),
    naics: fc.constantFrom(null, '236220', '236210', '238210', '238160', '237310', '561210'),
    psc: fc.constantFrom(null, 'Z2AA', 'Y1JZ', 'Z1DA', 'Y1LB', 'J061', 'Z2NE'),
    source: fc.constantFrom<Bid['source']>('samgov', 'ngem', 'questcdn', 'nevadaepro'),
    days: fc.integer({ min: -3, max: 60 }),
    city: fc.constantFrom('Minden', 'Reno', 'Carson City', 'Las Vegas', 'Elko'),
    est: fc.option(fc.integer({ min: 1_000, max: 5_000_000 })),
    setAside: fc.constantFrom(null, 'SBA', 'SDVOSBC', '8A'),
    description: fc.constantFrom(null, 'New traffic signals and lighting.', 'Paving only.'),
    trades: fc.subarray(TRADES.map((t) => t.id), { minLength: 1, maxLength: 3 }),
    office: fc.boolean(),
  });
  it('tier sub ⇒ 36–50, "maybe", capped, never announced; a general-building company never gets it', () => {
    fc.assert(fc.property(arb, (a) => {
      const bid = testBid({
        source: a.source, title: `TEST ${a.title} (synthetic)`, naics: a.naics, psc: a.psc, setAside: a.setAside, description: a.description,
        location: { city: a.city, state: 'NV' }, dueAt: new Date(NOW.getTime() + a.days * 86_400_000).toISOString(),
        estValue: a.est === null ? null : { min: a.est, max: a.est }, flags: a.office ? [FLAGS.placeFromOffice] : [],
      });
      for (const p of [company(a.trades), pilot]) {
        const s = scoreBid(bid, p, NOW);
        if (s.tier === 'sub') {
          if (s.score < SUB_MIN || s.score > SUB_MAX || s.verdict !== 'maybe' || s.capped !== true || s.rejected) return false;
          if (!s.reasons[0]!.text.startsWith('Sub work: ')) return false;
          if ((p.trades ?? []).includes(PRIME_TRADE)) return false;
          if (mayAnnounce(s, 0)) return false;
        } else if ((s.tier === 'fit') !== (s.score >= 35)) return false;
      }
      return true;
    }), { numRuns: 2000 });
  });
});

describe('the pilot keeps its fits', () => {
  it('on every real board bid: a fit is never sub work; the one sub-work row is the Dini Library restroom', () => {
    const rows = realBids().map((b) => ({ b, s: scoreBid(b, pilot, CAPTURED) }));
    const subs = rows.filter((r) => r.s.tier === 'sub').map((r) => r.b.title);
    expect(subs).toEqual(['WNC - Dini Library South Restroom Improvements']);
    const fits = rows.filter((r) => r.s.tier === 'fit').map((r) => r.s.score).sort((x, y) => y - x);
    expect(fits).toEqual([82, 71, 45, 40, 36, 35]); // the scores before tiers, minus Dini's 44 (now sub work at 47)
  });
});

// ------------------------------------------------------------- the feed --

describe('the feed: tiers, counts and the "Show sub work" switch', () => {
  let db: Db;
  const fit = testBid({ sourceId: 'TEST-tier-fit', title: 'TEST Switchgear Replacement (synthetic)', location: { city: 'Minden', state: 'NV' } });
  const sub = testBid({ sourceId: 'TEST-tier-sub', title: 'TEST Clinic Renovation (synthetic)', naics: '236220', psc: 'Z2DA', location: { city: 'Minden', state: 'NV' } });
  const weakFit = testBid({
    sourceId: 'TEST-tier-weak', title: 'TEST Water Heater Replacement (synthetic)', location: { city: 'Reno', state: 'NV' },
    dueAt: new Date(NOW.getTime() + 3 * 86_400_000).toISOString(),
  });
  const other = testBid({ sourceId: 'TEST-tier-other', title: 'TEST Asphalt Overlay (synthetic)', location: { city: 'Minden', state: 'NV' } });
  const bids = [fit, sub, weakFit, other];
  const profile = testProfile('test-tiers');

  beforeAll(async () => {
    db = await memoryDb();
    await upsertBids(db, bids, NOW);
    await runScan({ db, sources: [], profiles: [profile], ctx: scanCtx() });
    await upsertMatches(db, profile.id, bids.map((b) => ({ bidId: b.id, score: scoreBid(b, profile, NOW) })));
  });
  afterAll(async () => db?.close());

  it('the test bids land in the tiers they are meant to', () => {
    expect(bids.map((b) => scoreBid(b, profile, NOW).tier)).toEqual(['fit', 'sub', 'fit', 'other']);
    // the weak fit scores under the sub card: the order below is by tier first, not by score
    expect(scoreBid(weakFit, profile, NOW).score).toBeLessThan(scoreBid(sub, profile, NOW).score);
  });

  it('fit sort: every fit before any sub card, whatever the scores; tiers filter; counts in one query', async () => {
    const deck = await getFeed(db, profile.id, { now: NOW });
    expect(deck.map((b) => b.id)).toEqual([fit.id, weakFit.id, sub.id]);
    expect((await getFeed(db, profile.id, { now: NOW, tiers: ['sub'] })).map((b) => b.id)).toEqual([sub.id]);
    expect(await getFeedCounts(db, profile.id, { now: NOW })).toEqual({ fit: 2, sub: 1, other: 0 });
    expect(await getFeedCounts(db, profile.id, { now: NOW, minScore: 0 })).toEqual({ fit: 2, sub: 1, other: 1 });
  });

  it('the digest never lists sub work, even at a low digest line; "next bid" never picks it', async () => {
    const digest = await getUnnotified(db, profile.id, 0, NOW);
    expect(digest.map((b) => b.id)).not.toContain(sub.id);
    const subItem = (await getFeed(db, profile.id, { now: NOW, tiers: ['sub'] }))[0]!;
    expect(pickNext([subItem], NOW).item).toBeNull();
  });

  it('a sub-work match never makes an alert, whatever the alert line', () => {
    const s = scoreBid(sub, profile, NOW);
    const low = { ...profile, alerts: { minScore: 0 } };
    const event: BusEventOf<'match'> = { type: 'match', profileId: low.id, bid: sub, score: s, isNewBid: true };
    expect(decideMatch(event, low, 'pro', NOW)).toBeNull();
    expect(decideMatch({ ...event, score: { ...s, capped: undefined } }, low, 'pro', NOW)).toBeNull(); // the tier alone is enough
  });

  it('GET /api/feed: tier=…, counts, and showSubWork=false takes sub work out of the deck (the counts still say how many)', async () => {
    const appOn: FastifyInstance = await buildServer({ db, profile }, { now: () => NOW });
    const appOff: FastifyInstance = await buildServer({ db, profile: { ...profile, showSubWork: false } }, { now: () => NOW });
    try {
      const on = (await appOn.inject('/api/feed')).json() as { items: FeedItem[]; counts: Record<string, number> };
      expect(on.items.map((b) => b.tier)).toEqual(['fit', 'fit', 'sub']);
      expect(on.counts).toEqual({ fit: 2, sub: 1, other: 0 });
      const off = (await appOff.inject('/api/feed')).json() as { items: FeedItem[]; counts: Record<string, number> };
      expect(off.items.map((b) => b.tier)).toEqual(['fit', 'fit']);
      expect(off.counts.sub).toBe(1);
      expect(((await appOff.inject('/api/feed?tier=sub')).json() as { items: FeedItem[] }).items.map((b) => b.id)).toEqual([sub.id]);
      const browse = (await appOff.inject('/api/feed?all=1&minScore=0')).json() as { items: FeedItem[]; counts: Record<string, number> };
      expect(browse.items).toHaveLength(4); // Browse shows every tier
      expect(browse.counts).toEqual({ fit: 2, sub: 1, other: 1 });
      expect((await appOn.inject('/api/feed?tier=TEST-nope')).statusCode).toBe(400);
    } finally {
      await appOn.close();
      await appOff.close();
    }
    expect(deckTiers({ ...profile, showSubWork: false })).toEqual(['fit', 'other']);
    expect(deckTiers(profile)).toBeUndefined();
    expect(parseFeedQuery({ tier: 'all' })).toMatchObject({ ok: true, query: { tiers: ['fit', 'sub', 'other'] } });
  });

  it('the scan report counts each profile\'s candidates by tier, and sub work is never a "new good" bid or a match event', async () => {
    const scanDb = await memoryDb();
    try {
      // SAM.gov was read before: a source's first load announces nothing (src/scan.ts; test/scan-quiet.test.ts).
      await (await import('./scan-helpers.js')).markSourcesKnown(scanDb, ['samgov']);
      const bus = createBus();
      const events: Array<BusEventOf<'match'>> = [];
      bus.on('match', (e) => void events.push(e));
      const low = { ...profile, id: 'test-tiers-low', notify: { minScore: 35 }, alerts: { minScore: 35 } };
      const report = await runScan({ db: scanDb, sources: [{ id: 'samgov', name: 'TEST', homepage: '', fetch: async () => bids }], profiles: [low], ctx: scanCtx(), bus });
      expect(report.profiles[low.id]!.byTier).toEqual({ fit: 2, sub: 1, other: 1 });
      expect(report.profiles[low.id]!.newGood).toBe(2);
      expect(events.map((e) => e.bid.id).sort()).toEqual([fit.id, weakFit.id].sort());
    } finally {
      await scanDb.close();
    }
  });
});

describe('the profile switch', () => {
  it('showSubWork: absent = on; false is stored; the summary always says which', async () => {
    const { validateAnswers, summarize } = await import('../src/profile/build.js');
    const base = { businessName: 'TEST Switch Co (simulated)', trades: ['electrical'], zip: '89410', radiusMi: 90, valueRange: { min: 10_000, max: 50_000 } };
    const off = validateAnswers({ ...base, showSubWork: false });
    if (!off.ok) throw new Error('valid');
    expect(buildProfile('t', off.value).showSubWork).toBe(false);
    expect(summarize(buildProfile('t', off.value)).showSubWork).toBe(false);
    const on = validateAnswers(base);
    if (!on.ok) throw new Error('valid');
    expect(buildProfile('t', on.value)).not.toHaveProperty('showSubWork');
    expect(summarize(buildProfile('t', on.value)).showSubWork).toBe(true);
    expect(validateAnswers({ ...base, showSubWork: 'yes' })).toMatchObject({ ok: false, errors: { showSubWork: expect.any(String) } });
    expect(summarize(pilot).showSubWork).toBe(true); // the pilot's config keeps sub work on
  });
});

/**
 * Sub work never lands on a rental, a study or a civil job named for a building, and never on a road job whose
 * "road" is an address (REAL titles from the live test scan of 2026-11-14; every tier-sub row of four simulated
 * profiles was read). subWorkFor is called directly with the hits the scorer would pass for a title that names
 * no trade (all false).
 */
describe('sub work: real board titles that are not a general contractor\'s building job (2026-11-14)', () => {
  const noHits = { fitInTitle: false, otherInTitle: null, supplyOnly: false, program: false };
  const board = (source: Bid['source'], title: string, description: string | null = null) =>
    ({ source, title, category: null, description, naics: null, psc: null, location: testBid({}).location });
  const all = ['electrical', 'plumbing', 'hvac', 'painting'];

  it.each([
    ['caleprocure', 'IFB 7CA08060 - Portable Restroom and Handwash Station Rental Services'],
    ['opengov', 'Portable Restroom and Handwashing Station Rentals'],
    ['opengov', 'Public Safety Building Space Needs Assessment and Renovations'],
    ['opengov', 'Polk Street Community Center Parking Lot Renovation Project'],
    ['opengov', '26190 - Tennis & Basketball Court Renovation IDQ FY27'],
    ['opengov', 'Soccer Field and Structural Renovations at Silver Lakes North Park'],
    ['opengov', '(RFP) 27-27, Richard Craig Park Athletic Complex Renovation'],
  ] as const)('%s: "%s" is not sub work for any trade', (source, title) => {
    for (const t of all) expect(subWorkFor(board(source, title), [t], noHits), t).toBeNull();
  });

  it('a road word that is an address does not make a road job; a utility title is a utility job', () => {
    expect(subWorkFor(board('opengov', 'Fifth Street Parking Garage Security Project', 'Install electrical conduit'), ['electrical'], noHits)).toBeNull();
    expect(subWorkFor(board('opengov', 'DEP SRF Harbor Road WRF Expansion, Phase 3 - Reclaimed Water Ground Storage Tank', 'SCADA, electrical'), ['electrical'], noHits)?.kind).toBe('utility');
    expect(subWorkFor(board('opengov', 'Silverbell Road Roadway Improvements - El Camino del Cerro to Goret Road', 'street lighting'), ['electrical'], noHits)?.kind).toBe('road');
  });

  it('the honest ones stay: building renovations and remodels a GC bids with the trades inside', () => {
    for (const title of ['County Office Building 1 Renovation and Modernization Work Package 2 (WP2) Project (Project No. P33Z1)',
      'North South Building Food Service and Food Courts Renovations', 'Kenton County Golf Course Clubhouse Renovation and Expansion',
      'CITY OF NORTH MIAMI BEACH PUBLIC LIBRARY RESTROOM REMODEL']) {
      expect(subWorkFor(board('opengov', title), ['plumbing'], noHits)?.kind, title).toBe('building');
    }
  });

  it('a shell (a salt barn) is sub work for an electrician or a painter, not for plumbing or HVAC', () => {
    const barn = { ...board('samgov', 'Y1DA--NRM-CONST | 528A4-27-202 Salt Barn Batavia | FY27 NRM'), naics: '236220', psc: 'Y1DA' };
    expect(subWorkFor(barn, ['electrical'], noHits)?.trades).toEqual(['electrical']);
    expect(subWorkFor(barn, ['painting'], noHits)?.trades).toEqual(['painting']);
    expect(subWorkFor(barn, ['plumbing'], noHits)).toBeNull();
    expect(subWorkFor(barn, ['hvac'], noHits)).toBeNull();
  });

  it('a call for trade packages is bid by the trade contractors themselves: not sub work (COMMBUYS, 2026-11-14)', () => {
    const lynn = { ...board('commbuys', 'TRC1909 RFQ for Fifteen (15) Trade Packages for Renovation/Stabilization of Lynn Courthouse, Lynn MA'),
      location: { city: 'Lynn', county: null, state: 'MA', zip: null, lat: null, lng: null, precision: 'state' as const, label: 'MA' } };
    for (const t of ['electrical', 'hvac', 'painting', 'plumbing']) expect(subWorkFor(lynn, [t], noHits), t).toBeNull();
  });
});
