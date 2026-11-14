/**
 * The price and award watcher (src/market/watch.ts rules, src/market/watcher.ts runner, GET /api/market/watch).
 *
 * "Before" is always the REAL captured BLS and USAspending responses (test/fixtures, 2026-11-13).
 * "After" adds one plainly synthetic thing (test/market-watch-replay.ts): an October 2026 value worked
 * out from the real September figure and a chosen percent, or an award with TEST- ids and a
 * "(simulated)" winner. Accounts, profiles and the saved bid are simulated too (TEST- ids, example.com).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext, loadConfig, type AppConfig, type RouteContext } from '../src/context.js';
import { listAlerts, saveSubscription } from '../src/db/alerts.js';
import type { Db } from '../src/db/db.js';
import type { StoredObservation } from '../src/db/market.js';
import { recordSwipe, saveProfileForAccount, upsertBids, upsertMatch } from '../src/db/repo.js';
import { lookupZip, milesBetween } from '../src/geo/zip.js';
import type { FederalAward } from '../src/market/usaspending.js';
import {
  awardMatches, comparisonPeriods, DEFAULT_PRICE_WATCH_THRESHOLD_PCT, nearbyAwards, pctChange, priceMoves, priceWatchThreshold,
  seriesChange, solKey, watchedSeries, type SeriesSnapshot,
} from '../src/market/watch.js';
import { profileIdFor } from '../src/profile/build.js';
import { createBus, type Bus, type BusEvent } from '../src/realtime/bus.js';
import { createRealtime, type Realtime } from '../src/realtime/index.js';
import type { PushSender } from '../src/realtime/push.js';
import { register as marketRoutes } from '../src/routes/market.js';
import type { Account, Alert, Profile, ScoreResult } from '../src/types.js';
import { accountsConfig, fakeAuth, memoryDb, NOW, seedAccount, testBid, testProfile } from './helpers.js';
import {
  awardsReplay, blsReplay, COPPER, REAL_BLS, realLatest, replay, syntheticAward, syntheticNext,
} from './market-watch-replay.js';

const CONDUIT = 'WPU11710216';
const SWITCHGEAR = 'WPU117522';
const LIGHTING = 'WPU108303';

/** The REAL captured series as the database stores them (period "2026-M09", preliminary from footnote P). */
function realSnapshot(ids: readonly string[] = [...REAL_BLS.keys()]): Map<string, StoredObservation[]> {
  return new Map(ids.map((id) => [id, REAL_BLS.get(id)!.data
    .filter((o) => o.period !== 'M13')
    .map((o) => ({
      period: `${o.year}-${o.period}`, value: Number(o.value),
      preliminary: (o.footnotes as Array<{ code?: string }>).some((f) => f?.code === 'P'),
    }))]));
}

/** The real snapshot plus a SYNTHETIC October 2026 value for one series. */
function withNext(base: SeriesSnapshot, seriesId: string, value: number, preliminary = true): Map<string, StoredObservation[]> {
  const out = new Map([...base].map(([k, v]) => [k, [...v]]));
  out.get(seriesId)!.push({ period: '2026-M10', value, preliminary });
  return out;
}

// ---------------------------------------------------------------- rules --

describe('watch rules (pure)', () => {
  it('compares a month with the month before and the same month a year earlier; annual figures with the year before', () => {
    expect(comparisonPeriods('2026-M10')).toEqual({ previous: '2026-M09', yearAgo: '2025-M10' });
    expect(comparisonPeriods('2026-M01')).toEqual({ previous: '2025-M12', yearAgo: '2025-M01' });
    expect(comparisonPeriods('2025-A01')).toEqual({ previous: '2024-A01', yearAgo: '2024-A01' });
    expect(comparisonPeriods('2025-M13')).toEqual({ previous: null, yearAgo: null });
    expect(pctChange(100, 102)).toBe(2);
    expect(pctChange(0, 5)).toBeNull();
    expect(pctChange(undefined, 5)).toBeNull();
  });

  it('the threshold is one product setting with an environment override; nonsense falls back to the default', () => {
    expect(DEFAULT_PRICE_WATCH_THRESHOLD_PCT).toBe(2);
    expect(priceWatchThreshold(() => undefined)).toBe(2);
    expect(priceWatchThreshold((n) => (n === 'PRICE_WATCH_THRESHOLD_PCT' ? '1.5' : undefined))).toBe(1.5);
    for (const bad of ['0', '-3', 'abc', '', '1000']) expect(priceWatchThreshold(() => bad)).toBe(2);
  });

  it('the first load of a series is silent: history is not news', () => {
    expect(priceMoves(new Map(), realSnapshot(), 2)).toEqual([]);
  });

  it('re-loading the same periods, or a revision of an older period, is silent', () => {
    const real = realSnapshot();
    expect(priceMoves(real, realSnapshot(), 2)).toEqual([]);
    // SYNTHETIC revision of August 2026 by +10%: the latest period (September) did not change.
    const revised = new Map([...real].map(([k, v]) => [k, v.map((o) => (k === COPPER && o.period === '2026-M08' ? { ...o, value: o.value * 1.1 } : o))]));
    expect(priceMoves(real, revised, 2)).toEqual([]);
  });

  it('threshold edge: a new period 2.0% up alerts, 1.9% up does not, 2.0% down does', () => {
    const real = realSnapshot();
    const sep = realLatest(COPPER); // REAL: 607.705, Sep 2026, preliminary
    expect(sep).toEqual({ period: '2026-M09', value: 607.705 });
    const at = (pct: number) => priceMoves(real, withNext(real, COPPER, Number(syntheticNext(COPPER, pct))), 2);

    const up2 = at(2);
    expect(up2).toHaveLength(1);
    expect(up2[0]).toMatchObject({
      seriesId: COPPER, period: '2026-M10', previousPeriod: '2026-M09', changePct: 2, preliminary: true, alert: true, yearAgoPeriod: '2025-M10',
    });
    // Against the REAL October 2025 figure in the capture.
    const oct2025 = Number(REAL_BLS.get(COPPER)!.data.find((o) => o.year === '2025' && o.period === 'M10')!.value);
    expect(up2[0]!.yearChangePct).toBe(pctChange(oct2025, Number(syntheticNext(COPPER, 2))));

    expect(at(1.9)[0]).toMatchObject({ changePct: 1.9, alert: false });
    expect(at(-2)[0]).toMatchObject({ changePct: -2, alert: true });
    // A different setting changes only who is alerted, not the reported move.
    expect(priceMoves(real, withNext(real, COPPER, Number(syntheticNext(COPPER, 1.9))), 1.5)[0]).toMatchObject({ changePct: 1.9, alert: true });
  });

  it('says when the newest figure is not preliminary', () => {
    const real = realSnapshot();
    expect(priceMoves(real, withNext(real, COPPER, Number(syntheticNext(COPPER, 3)), false), 2)[0]!.preliminary).toBe(false);
    expect(seriesChange(COPPER, real.get(COPPER)!)).toMatchObject({ period: '2026-M09', preliminary: true, previousPeriod: '2026-M08' });
  });

  it('a profile watches every price index and the median wage of its trade in its home state', () => {
    const pilotLike = testProfile('test-watch-rules');
    const stored = [...REAL_BLS.keys()].map((seriesId) => ({ seriesId, kind: seriesId.startsWith('OE') ? 'oews' : 'ppi' }));
    const watched = watchedSeries(pilotLike, stored).map((s) => s.seriesId);
    expect(watched).toContain(COPPER);
    // Nevada electricians, hourly median (data type 08); not the mean, the percentiles or other areas.
    expect(watched.filter((id) => id.startsWith('OE'))).toEqual(stored.some((s) => s.seriesId === 'OEUS320000000000047211108') ? ['OEUS320000000000047211108'] : []);
    expect(watched.every((id) => !id.startsWith('OE') || id === 'OEUS320000000000047211108')).toBe(true);
  });

  it('solicitation numbers match whatever the punctuation; too-short ones never match', () => {
    expect(solKey('w912qr-24-r-0012')).toBe('W912QR24R0012');
    expect(solKey('W912QR24R0012_1')).toBe('W912QR24R0012');
    expect(solKey(' 36C26126R0050 ')).toBe('36C26126R0050');
    expect(solKey('24-1')).toBeNull();
    expect(solKey(null)).toBeNull();
  });

  const fed = (over: Partial<FederalAward>): FederalAward => ({
    id: 'usaspending:TEST-A', source: 'usaspending', generatedInternalId: 'TEST-A', awardId: 'TEST-A', solNumber: null, recipient: 'TEST Co (simulated)',
    amount: 50_000, priceAtAward: 50_000, currentAmount: 50_000, actionDate: '2026-11-09', naics: '238210', psc: null, agency: 'TEST agency',
    subAgency: null, naicsDescription: null, pscDescription: null, awardType: null, description: 'TEST (synthetic)', city: 'CARSON CITY',
    county: 'CARSON CITY', countyFips: null, state: 'NV', zip: '89701', lat: null, lng: null, url: null, fetchedAt: NOW.toISOString(),
    lastModified: null, offersReceived: null, dateSigned: null, detailFetchedAt: null, ...over,
  });

  it('an award meets a saved bid by solicitation number: when it is new, or its number only became known now', () => {
    const saved = [{ profileId: 'p1', bidId: 'samgov:TEST-1', solNumber: 'TEST-SOL-0001' }];
    const a = fed({ solNumber: 'test-sol-0001' });
    expect(awardMatches(new Map(), [a], saved)).toEqual([{ profileId: 'p1', bidId: 'samgov:TEST-1', award: a }]);
    expect(awardMatches(new Map([[a.id, null]]), [a], saved)).toHaveLength(1);
    expect(awardMatches(new Map([[a.id, 'TEST-SOL-0001']]), [a], saved)).toEqual([]);
    expect(awardMatches(new Map(), [fed({ solNumber: 'TEST-SOL-9999' })], saved)).toEqual([]);
  });

  it('a similar award nearby: main NAICS, a usable amount, inside the radius, in a state loaded before', () => {
    const profile = testProfile('test-nearby'); // Gardnerville, NV, 90 mi, NAICS 238210
    const geo = { pointOf: (z: string) => lookupZip(z), milesBetween };
    const near = fed({});
    expect(nearbyAwards(profile, new Map(), [near], new Set(['NV|238210']), geo)).toEqual([{ award: near, miles: 14 }]);
    expect(nearbyAwards(profile, new Map(), [near], new Set(['CA|238210']), geo)).toEqual([]); // NV's first load
    expect(nearbyAwards(profile, new Map([[near.id, null]]), [near], new Set(['NV|238210']), geo)).toEqual([]); // not new
    expect(nearbyAwards(profile, new Map(), [fed({ zip: '89191' })], new Set(['NV|238210']), geo)).toEqual([]); // Las Vegas: too far
    expect(nearbyAwards(profile, new Map(), [fed({ naics: '236220' })], new Set(['NV|238210']), geo)).toEqual([]);
    expect(nearbyAwards(profile, new Map(), [fed({ priceAtAward: null, amount: null })], new Set(['NV|238210']), geo)).toEqual([]);
    expect(nearbyAwards(profile, new Map(), [fed({ description: 'MINIMUM GUARANTEE TASK ORDER' })], new Set(['NV|238210']), geo)).toEqual([]);
  });

  it('a NAICS code loaded for the first time in an already-loaded state is history, not news', () => {
    const profile = testProfile('test-nearby-plumbing', { naics: { strong: ['238220'], related: [] } });
    const geo = { pointOf: (z: string) => lookupZip(z), milesBetween };
    const plumbing = fed({ naics: '238220' }); // a SYNTHETIC 238220 award in Carson City
    // NV was loaded before, but only for 238210: the first 238220 load must not send months-old awards.
    expect(nearbyAwards(profile, new Map(), [plumbing], new Set(['NV|238210']), geo)).toEqual([]);
    expect(nearbyAwards(profile, new Map(), [plumbing], new Set(['NV|238210', 'NV|238220']), geo)).toEqual([{ award: plumbing, miles: 14 }]);
    expect(nearbyAwards(profile, new Map(), [plumbing], new Set(['US|238220']), geo)).toEqual([{ award: plumbing, miles: 14 }]);
  });
});

// ------------------------------------------------------------ end to end --

let db: Db;
let clock = NOW;
const apps: FastifyInstance[] = [];
const engines: Realtime[] = [];

const fit = (): ScoreResult => ({ score: 80, verdict: 'great', distanceMi: 14, rejected: null, overLimit: false, tier: 'fit', reasons: [] });

interface Setup {
  pro: Account; proProfile: Profile;
  free: Account; freeProfile: Profile;
  quiet: Account; quietProfile: Profile;
  other: Account; otherProfile: Profile;
  bidId: string;
}

/** Simulated businesses: three Pro (one sleeping), one free. The Pro, quiet and free ones saved the same synthetic bid. */
async function seed(): Promise<Setup> {
  const make = async (plan: 'pro' | 'free', over: Partial<Profile> = {}) => {
    const account = await seedAccount(db, { plan });
    const profile = await saveProfileForAccount(db, account.id, testProfile(profileIdFor(account.id), { trades: ['electrical'], zip: '89410', ...over }));
    return { account, profile };
  };
  const pro = await make('pro');
  const free = await make('free');
  // Asleep 11:00–13:00 Pacific; NOW is 12:00 Pacific.
  const quiet = await make('pro', { alerts: { quietHours: { start: '11:00', end: '13:00' }, timeZone: 'America/Los_Angeles' } });
  const other = await make('pro');
  const bid = testBid({ solNumber: 'TEST-SOL-0001', title: 'TEST lighting retrofit, Carson City (synthetic)' });
  await upsertBids(db, [bid]);
  for (const p of [pro.profile, free.profile, quiet.profile]) {
    await upsertMatch(db, p.id, bid.id, fit());
    expect(await recordSwipe(db, p.id, bid.id, 'save')).toBe(true);
  }
  for (const a of [pro.account, quiet.account]) {
    await saveSubscription(db, a.id, { endpoint: `https://push.example.com/TEST-${a.id}`, keys: { p256dh: 'TEST', auth: 'TEST' } }, NOW);
  }
  return {
    pro: pro.account, proProfile: pro.profile, free: free.account, freeProfile: free.profile,
    quiet: quiet.account, quietProfile: quiet.profile, other: other.account, otherProfile: other.profile, bidId: bid.id,
  };
}

function engine(config: AppConfig = accountsConfig()) {
  const events: BusEvent[] = [];
  const pushed: string[] = [];
  const bus: Bus = createBus();
  bus.on('price', (e) => void events.push(e));
  bus.on('award', (e) => void events.push(e));
  const sender: PushSender = async (target) => {
    pushed.push(target.endpoint);
    return { ok: true };
  };
  const logs: string[] = [];
  const ctx: RouteContext = createContext({ db, config, bus, auth: fakeAuth(null), now: () => clock, log: (m) => void logs.push(m), env: () => undefined });
  const rt = createRealtime(ctx, { sender, tickMs: 0, coalesceMs: 0 });
  engines.push(rt);
  return { ctx, rt, events, pushed, logs };
}

const kinds = (alerts: Alert[], kind: string) => alerts.filter((a) => a.kind === kind);

describe('the watcher: real refresh path → bus → alert rules → inbox', () => {
  let s: Setup;

  beforeAll(async () => {
    db = await memoryDb();
    s = await seed();
  });
  afterAll(async () => {
    for (const rt of engines.splice(0)) rt.stop();
    await Promise.all(apps.map((a) => a.close()));
    await db.close();
  });
  beforeEach(() => {
    clock = NOW;
  });

  it('first load: everything is stored, nothing is announced', async () => {
    const { ctx, rt, events } = engine();
    const report = await ctx.market.refresh({ states: ['NV'], naics: ['238210'], months: 24 }, { http: replay(awardsReplay(), blsReplay()) });
    await rt.flush();
    expect(report).toMatchObject({ ok: true, errors: [], trigger: 'admin', watch: { priceMoves: [], priceEvents: 0, awardEvents: 0, nearbyEvents: 0, error: null } });
    expect(report.awards!.totals.inserted).toBe(36);
    expect(report.bls!.seriesStored).toBeGreaterThan(9);
    expect(events).toEqual([]);
    for (const p of [s.proProfile, s.freeProfile, s.quietProfile, s.otherProfile]) expect(await listAlerts(db, p.id)).toEqual([]);
  });

  it('a new period: 1.9% is reported but silent, 2.0% alerts every Pro profile and never the free one', async () => {
    const { ctx, rt, events, pushed } = engine();
    // SYNTHETIC October 2026 values: copper +1.9%, conduit +2.0% over their REAL September figures.
    const bls = blsReplay({ next: { [COPPER]: syntheticNext(COPPER, 1.9), [CONDUIT]: syntheticNext(CONDUIT, 2) } });
    const report = await ctx.market.refresh({ awards: false }, { http: replay(awardsReplay(), bls) });
    await rt.flush();
    expect(report.ok).toBe(true);
    expect(report.watch.priceMoves.map((m) => [m.seriesId, m.changePct, m.alert])).toEqual([[COPPER, 1.9, false], [CONDUIT, 2, true]]);
    expect(events).toEqual([{
      type: 'price', seriesId: CONDUIT, changePct: 2, period: '2026-M10', previousPeriod: '2026-M09',
      yearChangePct: report.watch.priceMoves.find((m) => m.seriesId === CONDUIT)!.yearChangePct, preliminary: true,
    }]);

    const [alert] = kinds(await listAlerts(db, s.proProfile.id), 'price');
    expect(alert).toMatchObject({
      kind: 'price', bidId: null, dedupeKey: `${CONDUIT}:2026-M10`,
      title: 'Conduit and conduit fittings up 2%',
      data: { seriesId: CONDUIT, changePct: 2, period: '2026-M10', previousPeriod: '2026-M09', preliminary: true, source: 'BLS Producer Price Index (PPI)', sourceUrl: 'https://www.bls.gov/ppi/' },
    });
    expect(alert!.body).toMatch(/^Oct 2026 \(preliminary\) vs Sep 2026 · 12 months: [+−]\d+(\.\d)?% · source: BLS Producer Price Index \(PPI\)\. Re-check open quotes\.$/);
    expect(kinds(await listAlerts(db, s.otherProfile.id), 'price')).toHaveLength(1);
    expect(kinds(await listAlerts(db, s.freeProfile.id), 'price')).toEqual([]);
    expect(pushed).toEqual([`https://push.example.com/TEST-${s.pro.id}`]);
  });

  it('quiet hours hold the push but keep the inbox entry; it goes out after they end', async () => {
    const [held] = kinds(await listAlerts(db, s.quietProfile.id), 'price');
    expect(held).toMatchObject({ dedupeKey: `${CONDUIT}:2026-M10`, pushedAt: null, readAt: null });
    const { rt, pushed } = engine();
    clock = new Date('2026-11-11T21:30:00Z'); // 13:30 Pacific: quiet hours are over
    await rt.tick();
    await rt.flush();
    expect(pushed).toEqual([`https://push.example.com/TEST-${s.quiet.id}`]);
    expect(kinds(await listAlerts(db, s.quietProfile.id), 'price')[0]!.pushedAt).not.toBeNull();
  });

  it('a second refresh of the same data announces nothing and stores no duplicate', async () => {
    const { ctx, rt, events } = engine();
    const before = (await listAlerts(db, s.proProfile.id)).length;
    const bls = blsReplay({ next: { [COPPER]: syntheticNext(COPPER, 1.9), [CONDUIT]: syntheticNext(CONDUIT, 2) } });
    const report = await ctx.market.refresh({ awards: false }, { http: replay(awardsReplay(), bls) });
    await rt.flush();
    expect(report.watch).toMatchObject({ priceMoves: [], priceEvents: 0 });
    expect(events).toEqual([]);
    expect((await listAlerts(db, s.proProfile.id)).length).toBe(before);
  });

  it('a new award with the saved bid\'s solicitation number: who won, for how much, from where — Pro only', async () => {
    const { ctx, rt, events } = engine();
    const award = syntheticAward(); // TEST-AWARD-0001, solicitation TEST-SOL-0001, Carson City NV
    const report = await ctx.market.refresh({ states: ['NV'], naics: ['238210'], months: 24, bls: false, details: 1 }, { http: replay(awardsReplay({ extra: [award] }), blsReplay()) });
    await rt.flush();
    expect(report).toMatchObject({ ok: true, awards: { details: { asked: 1, filled: 1, failed: 0 } }, watch: { awardEvents: 3, priceEvents: 0 } });
    // The three profiles that saved the bid get a settled-bid event; the fourth Pro profile gets a "nearby" one.
    expect(events.filter((e) => e.type === 'award' && e.bidId === s.bidId).map((e) => (e as { profileId: string }).profileId).sort())
      .toEqual([s.proProfile.id, s.freeProfile.id, s.quietProfile.id].sort());

    const [won] = kinds(await listAlerts(db, s.proProfile.id), 'award');
    expect(won).toMatchObject({
      kind: 'award', bidId: s.bidId, dedupeKey: `usaspending:CONT_AWD_TEST-AWARD-0001_TEST_-NONE-_-NONE-:bid:${s.bidId}`,
      title: 'Award posted: TEST lighting retrofit, Carson City (synthetic)',
      body: 'Awarded to TEST ELECTRIC LLC (SIMULATED) for $41,250 on 2026-11-09 · source: USAspending.gov',
      data: {
        bidId: s.bidId, recipient: 'TEST ELECTRIC LLC (SIMULATED)', amount: 41_250, actionDate: '2026-11-09', source: 'USAspending.gov',
        url: 'https://www.usaspending.gov/award/CONT_AWD_TEST-AWARD-0001_TEST_-NONE-_-NONE-',
      },
    });
    expect(kinds(await listAlerts(db, s.freeProfile.id), 'award')).toEqual([]);
    // One notice per award and profile: the saved-bid one, not a second "nearby" one.
    expect(kinds(await listAlerts(db, s.proProfile.id), 'award')).toHaveLength(1);

    const [nearby] = kinds(await listAlerts(db, s.otherProfile.id), 'award');
    expect(nearby).toMatchObject({
      bidId: null, title: 'Similar job awarded · 14 mi away (Carson City, NV)',
      body: 'TEST LIGHTING RETROFIT (SYNTHETIC) — Awarded to TEST ELECTRIC LLC (SIMULATED) for $41,250 on 2026-11-09 · source: USAspending.gov',
      data: { nearby: { miles: 14, naics: '238210' } },
    });

    // Refreshed again: nothing new.
    const again = await ctx.market.refresh({ states: ['NV'], naics: ['238210'], months: 24, bls: false, details: 1 }, { http: replay(awardsReplay({ extra: [award] }), blsReplay()) });
    expect(again.watch).toMatchObject({ awardEvents: 0, nearbyEvents: 0 });
  });

  it('an award first told as "similar job nearby" still reaches the inbox as "Award posted" once its solicitation number is known', async () => {
    // A second synthetic saved bid, saved only by the profile that so far got "nearby" notices.
    const bid2 = testBid({ sourceId: 'TEST-SAVED-2', solNumber: 'TEST-SOL-0002', title: 'TEST panel upgrade, Carson City (synthetic)' });
    await upsertBids(db, [bid2]);
    await upsertMatch(db, s.otherProfile.id, bid2.id, fit());
    expect(await recordSwipe(db, s.otherProfile.id, bid2.id, 'save')).toBe(true);
    const award2 = syntheticAward({
      generatedInternalId: 'CONT_AWD_TEST-AWARD-0002_TEST_-NONE-_-NONE-', piid: 'TEST-AWARD-0002', solicitation: 'TEST-SOL-0002',
      description: 'TEST PANEL UPGRADE (SYNTHETIC)', actionDate: '2026-11-10',
    });
    const extra = [syntheticAward(), award2];
    const { ctx, rt } = engine();
    // No detail lookups: the award arrives without its solicitation number, so it can only be "nearby".
    const first = await ctx.market.refresh({ states: ['NV'], naics: ['238210'], months: 24, bls: false, details: 0 }, { http: replay(awardsReplay({ extra }), blsReplay()) });
    await rt.flush();
    expect(first.watch).toMatchObject({ awardEvents: 0 });
    expect(first.watch.nearbyEvents).toBeGreaterThan(0);
    const award2Id = 'usaspending:CONT_AWD_TEST-AWARD-0002_TEST_-NONE-_-NONE-';
    expect(kinds(await listAlerts(db, s.otherProfile.id), 'award').filter((a) => a.data.awardId === award2Id).map((a) => a.title))
      .toEqual(['Similar job awarded · 14 mi away (Carson City, NV)']);

    // A later refresh fills in the number: the saved-bid notice must be stored too, not swallowed as a duplicate.
    const second = await ctx.market.refresh({ states: ['NV'], naics: ['238210'], months: 24, bls: false, details: 2 }, { http: replay(awardsReplay({ extra }), blsReplay()) });
    await rt.flush();
    expect(second.watch).toMatchObject({ awardEvents: 1 });
    const titles = kinds(await listAlerts(db, s.otherProfile.id), 'award').filter((a) => a.data.awardId === award2Id).map((a) => a.title).sort();
    expect(titles).toEqual(['Award posted: TEST panel upgrade, Carson City (synthetic)', 'Similar job awarded · 14 mi away (Carson City, NV)']);
  });

  it('a failed refresh is isolated: the awards outage is reported, prices still alert, the status says so', async () => {
    const { ctx, rt, events } = engine();
    // SYNTHETIC October value for switchgear (+3.0%) while every USAspending request fails.
    const report = await ctx.market.refresh(
      { states: ['NV'], naics: ['238210'], months: 4 },
      { http: replay(awardsReplay({ fail: true }), blsReplay({ next: { [SWITCHGEAR]: syntheticNext(SWITCHGEAR, 3) } })) },
    );
    await rt.flush();
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/awards NV: .*TEST outage/);
    expect(events.map((e) => e.type === 'price' && e.seriesId)).toEqual([SWITCHGEAR]);
    expect(kinds(await listAlerts(db, s.proProfile.id), 'price').map((a) => a.dedupeKey)).toContain(`${SWITCHGEAR}:2026-M10`);
    expect((await ctx.market.status()).lastRun).toMatchObject({ ok: false, trigger: 'admin', priceEvents: 1 });

    // A refresh that throws outright still resolves, and the next one runs.
    const broken = createContext({
      db, config: accountsConfig(), bus: createBus(), auth: fakeAuth(null), now: () => clock, env: () => undefined,
      marketRefresh: async () => { throw new Error('TEST database gone'); },
    });
    const failed = await broken.market.refresh({ states: ['NV'] });
    expect(failed).toMatchObject({ ok: false, errors: ['refresh: TEST database gone'], watch: { priceEvents: 0 } });
    expect((await broken.market.status()).lastRun).toMatchObject({ ok: false, errors: ['refresh: TEST database gone'] });
    expect((await broken.market.refresh({ states: ['NV'] })).ok).toBe(false); // not stuck "running"
  });

  it('the daily refresh runs on its own Pacific-time timer: a failure is logged and recorded, and the next day is armed', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-12T11:00:00Z') }); // 03:00 Pacific
    try {
      const logs: string[] = [];
      let calls = 0;
      const ctx = createContext({
        db, config: { ...accountsConfig(), marketRefreshAt: '03:40' }, bus: createBus(), auth: fakeAuth(null), now: () => new Date(Date.now()),
        log: (m) => void logs.push(m), env: () => undefined,
        marketRefresh: async () => { calls++; throw new Error('TEST outage at USAspending and BLS'); },
      });
      const stop = ctx.market.start();
      expect(logs).toContain('[scheduler] next market refresh 2026-11-12T11:40:00.000Z (03:40 Pacific)');
      await vi.advanceTimersByTimeAsync(41 * 60_000);
      expect(calls).toBe(1);
      expect(logs.some((l) => l.startsWith('market watch (schedule): FAILED: refresh: TEST outage'))).toBe(true);
      expect(await ctx.market.status()).toMatchObject({
        enabled: true, running: false, nextRefreshAt: '2026-11-13T11:40:00.000Z', lastRun: { trigger: 'schedule', ok: false },
      });
      expect(logs).toContain('[scheduler] next market refresh 2026-11-13T11:40:00.000Z (03:40 Pacific)');
      // The daily refresh pulls every state a profile works in (here: the simulated profiles' NV and CA).
      expect(await ctx.market.defaultStates()).toEqual(['NV', 'CA']);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('MARKET_REFRESH_AT is checked when the server boots, not at 3 a.m.', () => {
    expect(loadConfig({ MARKET_REFRESH_AT: '03:40' }).marketRefreshAt).toBe('03:40');
    expect(loadConfig({}).marketRefreshAt).toBeUndefined();
    expect(() => loadConfig({ MARKET_REFRESH_AT: '25:00' })).toThrow('MARKET_REFRESH_AT must look like 06:15, got "25:00"');
    expect(() => loadConfig({ MARKET_REFRESH_AT: 'daily' })).toThrow(/MARKET_REFRESH_AT/);
  });

  // -------------------------------------------------------- the route --

  async function app(account: Account | null, config: AppConfig = accountsConfig()): Promise<FastifyInstance> {
    const a = Fastify();
    const ctx = createContext({ db, config, bus: createBus(), auth: fakeAuth(account), now: () => clock, env: () => undefined });
    await marketRoutes(a, ctx, { env: () => undefined });
    apps.push(a);
    return a;
  }

  it('GET /api/market/watch: what is watched, last and next check, every figure with its source', async () => {
    const res = await (await app(s.pro, { ...accountsConfig(), marketRefreshAt: '03:40' })).inject('/api/market/watch');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      locked: false, enabled: true, prices: true, awards: true,
      nextRefreshAt: '2026-11-12T11:40:00.000Z', // 03:40 Pacific the next morning
      awardsWatched: 1, savedBids: 1, nearby: { radiusMi: 90, naics: ['238210'] },
    });
    expect(typeof body.lastRefreshAt).toBe('string');
    const conduit = body.series.find((x: { id: string }) => x.id === CONDUIT);
    expect(conduit).toMatchObject({
      title: 'Conduit and conduit fittings', period: '2026-M10', periodLabel: 'Oct 2026', previousPeriod: 'Sep 2026',
      changePct: 2, preliminary: true, source: 'BLS Producer Price Index (PPI)', sourceUrl: 'https://www.bls.gov/ppi/',
    });
    // A series still at its REAL latest period reports the real change from August to September.
    const lighting = body.series.find((x: { id: string }) => x.id === LIGHTING);
    expect(lighting).toMatchObject({ period: '2026-M09', changePct: pctChange(269.383, 274.551) });
    expect(body.series.length).toBeGreaterThanOrEqual(9);
    expect(JSON.stringify(body)).not.toMatch(/threshold/i);
  });

  it('GET /api/market/watch: off without a schedule; the free plan gets the locked shape; signed out is 401', async () => {
    const off = (await (await app(s.pro)).inject('/api/market/watch')).json();
    expect(off).toMatchObject({ locked: false, enabled: false, nextRefreshAt: null });
    const free = await (await app(s.free)).inject('/api/market/watch');
    expect(free.json()).toEqual({ locked: true, enabled: false, lastRefreshAt: null, nextRefreshAt: null, series: [], awardsWatched: 0 });
    expect((await (await app(null)).inject('/api/market/watch')).statusCode).toBe(401);
  });
});

afterEach(() => {
  clock = NOW;
});
