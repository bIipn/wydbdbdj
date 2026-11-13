import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/db.js';
import { getFeed, getItem, getOpenBids, upsertBids, upsertProfile } from '../src/db/repo.js';
import { loadProfile } from '../src/profiles.js';
import { createBus, type BusEvent, type BusEventOf } from '../src/realtime/bus.js';
import { alertThreshold, runScan, scoreProfile, type ScanReport } from '../src/scan.js';
import { scoreBid } from '../src/score/score.js';
import type { Profile } from '../src/types.js';
import { memoryDb, NOW, questSource, resetDb, scanCtx, testBid, testProfile } from './helpers.js';

// Spend limits are a later module. Until then (and after), this lets a test put chosen bids
// "over the limit" without knowing how the scorer decides it.
const overLimitIds = vi.hoisted(() => new Set<string>());
vi.mock('../src/score/score.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/score/score.js')>();
  return {
    ...actual,
    scoreBid: (...args: Parameters<typeof actual.scoreBid>) => {
      const s = actual.scoreBid(...args);
      return overLimitIds.has(args[0].id) ? { ...s, overLimit: true } : s;
    },
  };
});

const profile = loadProfile('lm-electric');

/** A bus that records everything it carries, in order. */
function recordingBus() {
  const events: BusEvent[] = [];
  const bus = createBus();
  for (const type of ['match', 'scan', 'alert', 'award', 'price'] as const) bus.on(type, (e) => void events.push(e));
  const matches = () => events.filter((e): e is BusEventOf<'match'> => e.type === 'match');
  return { bus, events, matches };
}

/** The rule under test, stated once: which stored bids deserve a 'match' event for this profile. */
async function alertWorthy(p: Profile): Promise<{ ids: string[]; rejected: number; open: number }> {
  const open = await getOpenBids(db, NOW);
  const scores = open.map((bid) => ({ id: bid.id, s: scoreBid(bid, p, NOW) }));
  return {
    ids: scores.filter(({ s }) => s.score >= alertThreshold(p) && !s.rejected && !s.overLimit).map(({ id }) => id).sort(),
    rejected: scores.filter(({ s }) => s.rejected).length,
    open: open.length,
  };
}

let db: Db;
beforeAll(async () => {
  db = await memoryDb();
});
beforeEach(async () => {
  overLimitIds.clear();
  await resetDb(db);
});
afterAll(async () => db.close());

describe('runScan events', () => {
  it('publishes a match for every bid at or above the alert threshold — and only those — then one scan event', async () => {
    const { bus, events, matches } = recordingBus();
    const report = await runScan({ db, sources: [questSource()], profiles: [profile], ctx: scanCtx(), bus });

    const expected = (await alertWorthy(profile)).ids;
    expect(expected.length).toBeGreaterThanOrEqual(2); // the fixture has real good fits…
    expect(expected.length).toBeLessThan(report.totalBids); // …and bids that must NOT alert
    expect(matches().map((m) => m.bid.id).sort()).toEqual(expected);

    for (const m of matches()) {
      expect(m.profileId).toBe(profile.id);
      expect(m.isNewBid).toBe(true);
      expect(m.score.rejected).toBeNull();
      expect(m.score.overLimit).toBe(false);
      expect(m.score.score).toBeGreaterThanOrEqual(alertThreshold(profile));
      expect(m.bid.title).toBeTruthy();
    }
    // Exactly one scan event, last, carrying the report that was returned.
    expect(events.filter((e) => e.type === 'scan')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'scan', report });
    expect(report.profiles[profile.id]!.newGood).toBe(expected.length);
  });

  it('a re-scan publishes the same matches with isNewBid: false (listeners de-duplicate)', async () => {
    const first = recordingBus();
    await runScan({ db, sources: [questSource()], profiles: [profile], ctx: scanCtx(), bus: first.bus });
    const again = recordingBus();
    const report = await runScan({ db, sources: [questSource()], profiles: [profile], ctx: scanCtx(), bus: again.bus });
    expect(report.newBids).toBe(0);
    expect(again.matches().map((m) => m.bid.id).sort()).toEqual(first.matches().map((m) => m.bid.id).sort());
    expect(again.matches().every((m) => m.isNewBid === false)).toBe(true);
  });

  it('uses alerts.minScore when the profile sets one, else notify.minScore', async () => {
    expect(alertThreshold(profile)).toBe(profile.notify.minScore);
    const picky: Profile = testProfile('test-picky', { alerts: { minScore: 90 } });
    const eager: Profile = testProfile('test-eager', { alerts: { minScore: 1 } });
    expect([alertThreshold(picky), alertThreshold(eager)]).toEqual([90, 1]);

    const { bus, matches } = recordingBus();
    await runScan({ db, sources: [questSource()], profiles: [picky, eager], ctx: scanCtx(), bus });
    const got = (id: string) => matches().filter((m) => m.profileId === id).map((m) => m.bid.id).sort();
    expect(got('test-picky')).toEqual((await alertWorthy(picky)).ids);
    expect(got('test-eager')).toEqual((await alertWorthy(eager)).ids);
    expect(got('test-eager').length).toBeGreaterThan(got('test-picky').length);
  });

  it('the threshold is inclusive: a bid scoring exactly the threshold is published, one point under is not', async () => {
    const dry = recordingBus();
    await runScan({ db, sources: [questSource()], profiles: [profile], ctx: scanCtx(), bus: dry.bus });
    const top = dry.matches().sort((a, b) => b.score.score - a.score.score)[0]!;

    const at: Profile = testProfile('test-at', { alerts: { minScore: top.score.score } });
    const above: Profile = testProfile('test-above', { alerts: { minScore: top.score.score + 1 } });
    const { bus, matches } = recordingBus();
    await runScan({ db, sources: [questSource()], profiles: [at, above], ctx: scanCtx(), bus });
    expect(matches().filter((m) => m.profileId === 'test-at').map((m) => m.bid.id)).toContain(top.bid.id);
    expect(matches().filter((m) => m.profileId === 'test-above')).toEqual([]);
  });

  it('never publishes a rejected bid, even with a threshold of 0', async () => {
    const { bus, matches } = recordingBus();
    const anything = testProfile('test-anything', { alerts: { minScore: 0 } });
    const report = await runScan({ db, sources: [questSource()], profiles: [anything], ctx: scanCtx(), bus });
    const { ids, rejected, open } = await alertWorthy(anything);
    expect(open).toBe(report.totalBids);
    expect(rejected).toBeGreaterThan(0); // the fixture has real hard no's (janitorial, out of range…)
    expect(matches()).toHaveLength(report.totalBids - rejected);
    expect(matches().map((m) => m.bid.id).sort()).toEqual(ids);
    expect(matches().every((m) => m.score.rejected === null)).toBe(true);
  });

  it('never publishes an over-limit bid, stores it as over limit, and does not count it as a new good match', async () => {
    const dry = recordingBus();
    await runScan({ db, sources: [questSource()], profiles: [profile], ctx: scanCtx(), bus: dry.bus });
    const best = dry.matches().sort((a, b) => b.score.score - a.score.score)[0]!.bid.id;

    await resetDb(db);
    overLimitIds.add(best);
    const { bus, matches } = recordingBus();
    const report = await runScan({ db, sources: [questSource()], profiles: [profile], ctx: scanCtx(), bus });
    expect(matches().map((m) => m.bid.id)).not.toContain(best);
    expect(matches().map((m) => m.bid.id).sort()).toEqual((await alertWorthy(profile)).ids);
    expect(matches()).toHaveLength(dry.matches().length - 1);
    expect(report.profiles[profile.id]!.newGood).toBe(dry.matches().length - 1);
    expect(await getItem(db, profile.id, best)).toMatchObject({ overLimit: true });
  });

  it('a listener that fails cannot break the scan', async () => {
    const errors: string[] = [];
    const bus = createBus((err) => void errors.push((err as Error).message));
    bus.on('match', () => {
      throw new Error('TEST listener down');
    });
    const report = await runScan({ db, sources: [questSource()], profiles: [profile], ctx: scanCtx(), bus });
    expect(report.totalBids).toBe(13);
    expect(report.profiles[profile.id]!.scored).toBe(13);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(new Set(errors)).toEqual(new Set(['TEST listener down']));
  });

  it('without a bus the report is the same as with one', async () => {
    const strip = (r: ScanReport) => ({ ...r, startedAt: '', finishedAt: '', sources: Object.keys(r.sources) });
    const plain = await runScan({ db, sources: [questSource()], profiles: [profile], ctx: scanCtx() });
    await resetDb(db);
    const withBus = await runScan({ db, sources: [questSource()], profiles: [profile], ctx: scanCtx(), bus: createBus() });
    expect(strip(withBus)).toEqual(strip(plain));
  });
});

describe('runScan profiles', () => {
  it('reads a profile list given as a function after the sources were fetched', async () => {
    const order: string[] = [];
    const source = { ...questSource(), fetch: async () => (order.push('fetch'), questSource().fetch(scanCtx())) };
    const report = await runScan({
      db, sources: [source], ctx: scanCtx(),
      profiles: async () => (order.push('profiles'), [profile]),
    });
    expect(order).toEqual(['fetch', 'profiles']);
    expect(report.profiles[profile.id]!.scored).toBe(13);
  });

  it('scores nothing, and still records the scan, when there are no profiles yet', async () => {
    const { bus, events } = recordingBus();
    const report = await runScan({ db, sources: [questSource()], profiles: async () => [], ctx: scanCtx(), bus });
    expect(report.totalBids).toBe(13);
    expect(report.profiles).toEqual({});
    expect(events.map((e) => e.type)).toEqual(['scan']);
  });

  it('a broken profile is reported and skipped; the others are still scored', async () => {
    const log: string[] = [];
    const broken = { ...testProfile('test-broken'), keywords: undefined } as unknown as Profile;
    const report = await runScan({ db, sources: [questSource()], profiles: [broken, profile], ctx: scanCtx(NOW, (m) => log.push(m)) });
    expect(report.profiles['test-broken']).toMatchObject({ scored: 0, newGood: 0 });
    expect(report.profiles['test-broken']!.error).toBeTruthy();
    expect(report.profiles[profile.id]).toMatchObject({ scored: 13 });
    expect(report.profiles[profile.id]!.error).toBeUndefined();
    expect(log.some((m) => m.startsWith('! profile test-broken failed'))).toBe(true);
  });
});

describe('scoreProfile', () => {
  it('scores every open bid for a profile that was just saved, so its feed is not empty until the next scan', async () => {
    // Yesterday's scan ran for the pilot only; one more bid has since closed.
    await runScan({ db, sources: [questSource()], profiles: [profile], ctx: scanCtx() });
    const closed = testBid({ sourceId: 'TEST-closed', dueAt: '2026-11-10T22:00:00.000Z' });
    await upsertBids(db, [closed], NOW);

    const fresh = testProfile('test-newcomer');
    await upsertProfile(db, fresh);
    expect(await getFeed(db, fresh.id, { minScore: 0, now: NOW })).toHaveLength(0);

    const { bus, events, matches } = recordingBus();
    const open = await getOpenBids(db, NOW);
    const scored = await scoreProfile(db, fresh, NOW, bus);
    expect(scored).toBe(open.length);
    expect(scored).toBe(13);
    expect(await getItem(db, fresh.id, closed.id)).toBeNull(); // closed bids are not scored

    // Same scoring profile as the pilot → the same feed.
    const feedOf = async (id: string) => (await getFeed(db, id, { minScore: 0, limit: 300, now: NOW })).map((b) => [b.id, b.score]);
    expect(await feedOf(fresh.id)).toEqual(await feedOf(profile.id));

    // Events: matches only (no 'scan'), flagged as not-new bids, filtered like a scan's.
    expect(events.every((e) => e.type === 'match')).toBe(true);
    expect(matches().length).toBeGreaterThanOrEqual(2);
    expect(matches().map((m) => m.bid.id).sort()).toEqual((await alertWorthy(fresh)).ids);
    expect(matches().every((m) => m.profileId === fresh.id && m.isNewBid === false)).toBe(true);
  });

  it('works without a bus and returns 0 when nothing is open', async () => {
    const fresh = testProfile('test-empty');
    await upsertProfile(db, fresh);
    expect(await scoreProfile(db, fresh, NOW)).toBe(0);
  });
});
