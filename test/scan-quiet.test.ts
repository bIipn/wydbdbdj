/**
 * The scan's announcing rules (src/scan.ts) and the shared "is it open" rule (src/db/repo.ts openBidSql):
 *   - a source's FIRST load, and a quiet scan, store and score but announce nothing, now or on any later scan, and
 *     never reach a digest;
 *   - at most MAX_MATCH_ALERTS_PER_SCAN new 'match' alerts per profile per scan, best first; the rest held back;
 *   - a bid with no due date is open only while its board still lists it (seen within UNLISTED_GRACE_DAYS).
 * Every bid here is synthetic (TEST ids, example.com links).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import {
  getFeed, getFeedCounts, getFeedTotal, getOpenBids, getSaved, getUnnotified, lastScan, lastScanAt, recordScan, recordSwipe,
  UNLISTED_GRACE_DAYS, upsertBids, upsertMatches, upsertProfile,
} from '../src/db/repo.js';
import { pickNext } from '../src/feed/next.js';
import { createBus, type BusEventOf } from '../src/realtime/bus.js';
import { alertThreshold, finalizeBid, MAX_MATCH_ALERTS_PER_SCAN, mayAnnounce, runScan, scoreProfile } from '../src/scan.js';
import { scoreBid } from '../src/score/score.js';
import { resolveSlices, withSlice } from '../src/sources/groups.js';
import type { Bid, BidDraft, Source, SourceId } from '../src/types.js';
import { memoryDb, NOW, resetDb, scanCtx, testBid, testProfile } from './helpers.js';
import { cappedIds, markSourcesKnown } from './scan-helpers.js';

const DAY = 86_400_000;
const profile = testProfile('test-quiet-electric');

/** A synthetic draft: an electrical job in Carson City (the pilot's patch), due in three weeks. */
const draft = (source: SourceId, sourceId: string, over: Partial<BidDraft> = {}): BidDraft => ({
  source, sourceId, sourceName: 'TEST board', title: `TEST electrical panel upgrade ${sourceId} (synthetic)`, agency: 'TEST agency',
  description: null, category: null, location: { city: 'Carson City', state: 'NV' }, postedAt: null,
  dueAt: '2026-12-02T22:00:00.000Z', estValue: null, naics: null, setAside: null, url: 'https://example.com/test-bid', ...over,
});
const sourceOf = (id: SourceId, drafts: () => BidDraft[]): Source => ({ id, name: 'TEST board', homepage: '', fetch: async () => drafts() });

function recording() {
  const bus = createBus();
  const matches: Array<BusEventOf<'match'>> = [];
  bus.on('match', (e) => void matches.push(e));
  return { bus, matches, ids: () => matches.map((m) => m.bid.id).sort() };
}

let db: Db;
beforeAll(async () => {
  db = await memoryDb();
});
beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => db.close());

describe("a source's first load is quiet", () => {
  it('stores and scores, announces nothing, marks the report, and never alerts or digests those bids later', async () => {
    const drafts = [draft('bidbuy', 'TEST-1'), draft('bidbuy', 'TEST-2')];
    const worth = drafts.map((d) => scoreBid(finalizeBid(d), profile, NOW));
    expect(worth.every((s) => mayAnnounce(s, alertThreshold(profile)))).toBe(true); // they WOULD alert on a known board

    const log: string[] = [];
    const first = recording();
    const report = await runScan({ db, sources: [sourceOf('bidbuy', () => drafts)], profiles: [profile], ctx: scanCtx(NOW, (m) => log.push(m)), bus: first.bus });
    expect(report.sources.bidbuy).toMatchObject({ ok: true, fetched: 2, firstLoad: true });
    expect(report.newBids).toBe(2);
    expect(report.profiles[profile.id]).toMatchObject({ scored: 2, newGood: 0 });
    expect(first.matches).toEqual([]);
    expect(log).toContain('first load of bidbuy: 2 bid(s) stored quietly (no alerts, no digest)');
    // Stored and scored: the feed has them …
    expect((await getFeed(db, profile.id, { now: NOW })).map((b) => b.id).sort()).toEqual(['bidbuy:TEST-1', 'bidbuy:TEST-2']);
    // … the digest does not.
    expect(await getUnnotified(db, profile.id, 0, NOW)).toEqual([]);

    // The next day the board lists them again plus one genuinely new bid: only the new one is announced.
    drafts.push(draft('bidbuy', 'TEST-3'));
    const next = recording();
    const again = await runScan({ db, sources: [sourceOf('bidbuy', () => drafts)], profiles: [profile], ctx: scanCtx(), bus: next.bus });
    expect(again.sources.bidbuy!.firstLoad).toBeUndefined();
    expect(next.ids()).toEqual(['bidbuy:TEST-3']);
    expect(next.matches[0]!.isNewBid).toBe(true);
    expect((await getUnnotified(db, profile.id, 0, NOW)).map((b) => b.id)).toEqual(['bidbuy:TEST-3']);
  });

  it('a known source stays loud; a profile saved later (onboarding) gets its inbox as before, quiet rows excepted', async () => {
    await markSourcesKnown(db, ['samgov']);
    await runScan({ db, sources: [sourceOf('bidbuy', () => [draft('bidbuy', 'TEST-q')])], profiles: [profile], ctx: scanCtx() });
    const loud = recording();
    const report = await runScan({ db, sources: [sourceOf('samgov', () => [draft('samgov', 'TEST-loud')])], profiles: [profile], ctx: scanCtx(), bus: loud.bus });
    expect(report.sources.samgov!.firstLoad).toBeUndefined();
    expect(loud.ids()).toEqual(['samgov:TEST-loud']);

    // The same profile re-scored after a settings change: the quiet first-load row stays quiet.
    const rescored = recording();
    await scoreProfile(db, profile, NOW, rescored.bus);
    expect(rescored.ids()).toEqual(['samgov:TEST-loud']);
    // A brand-new profile has no rows yet: its onboarding announces what fits (inbox only, no buzz), as before.
    const newcomer = testProfile('test-quiet-newcomer');
    await upsertProfile(db, newcomer);
    const onboard = recording();
    await scoreProfile(db, newcomer, NOW, onboard.bus);
    expect(onboard.ids()).toEqual(['bidbuy:TEST-q', 'samgov:TEST-loud']);
    expect(onboard.matches.every((m) => m.isNewBid === false)).toBe(true);
  });

  it('a sliced source: each slice has its own first load', async () => {
    const opengov: Pick<Source, 'slices'> = { slices: [{ group: 'opengov-1', states: ['NV'] }, { group: 'opengov-2', states: ['CA'] }] };
    const [nv, ca] = resolveSlices(opengov).map((r) => r.slice);
    const sliced = (slice: typeof nv, drafts: BidDraft[]) => withSlice(sourceOf('opengov', () => drafts), slice!);
    const nvDraft = draft('opengov', 'TEST-nv');
    const caDraft = draft('opengov', 'TEST-ca', { location: { city: 'South Lake Tahoe', state: 'CA' } });

    const day1 = await runScan({ db, sources: [sliced(nv, [nvDraft])], profiles: [profile], ctx: scanCtx(), group: 'opengov-1' });
    expect(day1.sources.opengov!.firstLoad).toBe(true);
    // opengov is stored now, but nothing in CA: the CA slice's first run is still a first load.
    const caRun = recording();
    const day1b = await runScan({ db, sources: [sliced(ca, [caDraft])], profiles: [profile], ctx: scanCtx(), group: 'opengov-2', bus: caRun.bus });
    expect(day1b.sources.opengov!.firstLoad).toBe(true);
    expect(caRun.matches).toEqual([]);
    // The NV slice the next day: known, so a new NV bid is announced.
    const day2 = recording();
    const r2 = await runScan({ db, sources: [sliced(nv, [nvDraft, draft('opengov', 'TEST-nv-2')])], profiles: [profile], ctx: scanCtx(), group: 'opengov-1', bus: day2.bus });
    expect(r2.sources.opengov!.firstLoad).toBeUndefined();
    expect(day2.ids()).toEqual(['opengov:TEST-nv-2']);
  });

  it('a source that returned nothing has had no load: its first real one is still quiet', async () => {
    await runScan({ db, sources: [sourceOf('njstart', () => [])], profiles: [profile], ctx: scanCtx() });
    const r = await runScan({ db, sources: [sourceOf('njstart', () => [draft('njstart', 'TEST-nj')])], profiles: [profile], ctx: scanCtx() });
    expect(r.sources.njstart!.firstLoad).toBe(true);
  });
});

describe('a quiet scan', () => {
  it('announces nothing for a known source, reports quiet, and those bids stay silent on later scans', async () => {
    await markSourcesKnown(db, ['samgov']);
    const drafts = [draft('samgov', 'TEST-a'), draft('samgov', 'TEST-b')];
    const hush = recording();
    const log: string[] = [];
    const r = await runScan({ db, sources: [sourceOf('samgov', () => drafts)], profiles: [profile], ctx: scanCtx(NOW, (m) => log.push(m)), bus: hush.bus, quiet: true });
    expect(r.quiet).toBe(true);
    expect(r.sources.samgov!.firstLoad).toBeUndefined();
    expect(hush.matches).toEqual([]);
    expect(log).toContain('quiet scan: 2 bid(s) stored quietly (no alerts, no digest)');
    expect(await getUnnotified(db, profile.id, 0, NOW)).toEqual([]);
    const later = recording();
    await runScan({ db, sources: [sourceOf('samgov', () => drafts)], profiles: [profile], ctx: scanCtx(), bus: later.bus });
    expect(later.matches).toEqual([]);
  });
});

describe('the alert backstop', () => {
  it(`at most ${MAX_MATCH_ALERTS_PER_SCAN} new match alerts per profile per scan, best first; the rest held back for good`, async () => {
    await markSourcesKnown(db, ['samgov']);
    // 15 alert-worthy bids, due on different days so "best first" is decided by real score and deadline.
    const drafts = Array.from({ length: 15 }, (_, i) => draft('samgov', `TEST-cap-${String(i).padStart(2, '0')}`, {
      dueAt: new Date(Date.parse('2026-11-20T22:00:00Z') + i * DAY).toISOString(),
      ...(i % 3 === 0 ? { title: `TEST lighting and electrical panel upgrade ${i} (synthetic)` } : {}),
    }));
    const worthy = drafts.map((d) => finalizeBid(d)).map((bid) => ({ bid, score: scoreBid(bid, profile, NOW) }))
      .filter((x) => mayAnnounce(x.score, alertThreshold(profile)));
    expect(worthy).toHaveLength(15);

    const log: string[] = [];
    const first = recording();
    const r = await runScan({ db, sources: [sourceOf('samgov', () => drafts)], profiles: [profile], ctx: scanCtx(NOW, (m) => log.push(m)), bus: first.bus });
    expect(first.ids()).toEqual(cappedIds(worthy));
    expect(first.matches).toHaveLength(MAX_MATCH_ALERTS_PER_SCAN);
    expect(r.profiles[profile.id]!.heldBack).toBe(5);
    expect(log).toContain('match alerts: 5 held back for 1 profile(s) (at most 10 per profile per scan, best first)');
    // Held back = not alerted, but still stored, still in the deck, still in the pilot's digest.
    expect(await getFeed(db, profile.id, { now: NOW })).toHaveLength(15);
    expect(await getUnnotified(db, profile.id, 0, NOW)).toHaveLength(15);

    // Next scan: the 5 held stay silent; the 10 sent would be repeats once the alert store has them.
    const next = recording();
    const r2 = await runScan({ db, sources: [sourceOf('samgov', () => drafts)], profiles: [profile], ctx: scanCtx(), bus: next.bus });
    expect(r2.profiles[profile.id]!.heldBack).toBeUndefined();
    // No alert store runs in this test, so every sent one is still "not alerted" and counts as new: still the same 10.
    expect(next.ids()).toEqual(cappedIds(worthy));
  });

  it('counts only NEW alerts: bids already alerted are not published again and do not use up the cap', async () => {
    await markSourcesKnown(db, ['samgov']);
    const drafts = Array.from({ length: 12 }, (_, i) => draft('samgov', `TEST-rep-${String(i).padStart(2, '0')}`));
    await upsertProfile(db, profile);
    // Pretend the alert store already told this profile about the first 8.
    for (const d of drafts.slice(0, 8)) {
      await db.query(
        `insert into alerts (profile_id, kind, bid_id, dedupe_key, title, body) values ($1, 'match', $2, $2, 'TEST', 'TEST')`,
        [profile.id, `samgov:${d.sourceId}`],
      );
    }
    const bus = recording();
    const r = await runScan({ db, sources: [sourceOf('samgov', () => drafts)], profiles: [profile], ctx: scanCtx(), bus: bus.bus });
    // The 8 already alerted are repeats: not published again (the store would only drop them). The 4 new ones go out.
    expect(bus.ids()).toEqual(drafts.slice(8).map((d) => `samgov:${d.sourceId}`).sort());
    expect(r.profiles[profile.id]!.heldBack).toBeUndefined();
  });
});

describe('the open rule: a bid with no due date is open only while its board lists it', () => {
  const at = (d: number) => new Date(NOW.getTime() + d * DAY);

  async function seed(): Promise<{ listed: Bid; unlisted: Bid; dated: Bid; job: Bid }> {
    const listed = testBid({ sourceId: 'TEST-nodue-listed', dueAt: null });
    const unlisted = testBid({ sourceId: 'TEST-nodue-unlisted', dueAt: null });
    const dated = testBid({ sourceId: 'TEST-dated', dueAt: at(10).toISOString() });
    // A job posted on BidSwipe 20 days ago (mirrored row, seen once), closing in 4 days: never hidden by this rule.
    const job = testBid({ source: 'local', sourceId: 'TEST-job', sourceName: 'Local job', dueAt: at(4).toISOString() });
    await upsertBids(db, [unlisted, job], at(-20));
    await upsertBids(db, [listed, dated], at(-1));
    await upsertProfile(db, profile);
    await upsertMatches(db, profile.id, [listed, unlisted, dated, job].map((b) => ({ bidId: b.id, score: scoreBid(b, profile, NOW) })));
    return { listed, unlisted, dated, job };
  }

  it(`is one rule (${UNLISTED_GRACE_DAYS} days) for the feed, counts, total, re-score, digest and next pick; Saved keeps it`, async () => {
    const { listed, unlisted, dated, job } = await seed();
    const open = [listed.id, dated.id, job.id].sort();
    expect((await getOpenBids(db, NOW)).map((b) => b.id).sort()).toEqual(open);
    const feed = await getFeed(db, profile.id, { now: NOW, minScore: 0 });
    expect(feed.map((b) => b.id).sort()).toEqual(open);
    expect(await getFeedTotal(db, profile.id, { now: NOW, minScore: 0 })).toBe(3);
    const counts = await getFeedCounts(db, profile.id, { now: NOW, minScore: 0 });
    expect(counts.fit + counts.sub + counts.other).toBe(3);
    expect((await getUnnotified(db, profile.id, 0, NOW)).map((b) => b.id)).not.toContain(unlisted.id);
    expect(pickNext(feed, NOW).item?.id).not.toBe(unlisted.id);

    // Just inside / just past the grace: last seen at(-1), so open until at(-1) + 3 days.
    expect((await getOpenBids(db, at(UNLISTED_GRACE_DAYS - 1.01))).map((b) => b.id)).toContain(listed.id);
    expect((await getOpenBids(db, at(UNLISTED_GRACE_DAYS - 0.99))).map((b) => b.id)).not.toContain(listed.id);
    // The local job is open until its own due date, however long ago it was mirrored.
    expect((await getFeed(db, profile.id, { now: at(3.9), minScore: 0 })).map((b) => b.id)).toContain(job.id);
    expect((await getFeed(db, profile.id, { now: at(4.1), minScore: 0 })).map((b) => b.id)).not.toContain(job.id);

    // A saved bid stays in Saved whatever the rule says.
    expect(await recordSwipe(db, profile.id, unlisted.id, 'save')).toBe(true);
    expect((await getSaved(db, profile.id)).map((b) => b.id)).toContain(unlisted.id);
  });

  it('every upsert writes last_seen_at, and a scan that lists it again brings it back', async () => {
    const { unlisted } = await seed();
    const seen = async () => (await db.query<{ last_seen_at: Date | string }>('select last_seen_at from bids where id = $1', [unlisted.id]))[0]!.last_seen_at;
    expect(new Date(await seen()).toISOString()).toBe(at(-20).toISOString());
    await markSourcesKnown(db, ['samgov']);
    const { id: _id, ...d } = unlisted;
    await runScan({ db, sources: [sourceOf('samgov', () => [{ ...d, location: { city: 'Carson City', state: 'NV' } }])], profiles: [profile], ctx: scanCtx(NOW) });
    expect(new Date(await seen()).toISOString()).toBe(NOW.toISOString());
    expect((await getOpenBids(db, NOW)).map((b) => b.id)).toContain(unlisted.id);
  });

  it("the daily re-score skips an unlisted bid (it is not open any more)", async () => {
    const { unlisted } = await seed();
    const r = await runScan({ db, sources: [], profiles: [profile], ctx: scanCtx(NOW) });
    expect(r.profiles[profile.id]!.scored).toBe(2); // the listed one and the dated one (the job needs an account)
    expect((await getOpenBids(db, NOW)).map((b) => b.id)).not.toContain(unlisted.id);
  });
});

describe('paging: offset, total, a stable order', () => {
  it('pages neither overlap nor skip, and total is the count under every filter and tier', async () => {
    await markSourcesKnown(db, ['samgov']);
    // 57 bids with many ties (three titles, four due days), so a stable order has to come from the id.
    const drafts = Array.from({ length: 57 }, (_, i) => draft('samgov', `TEST-page-${String(i).padStart(3, '0')}`, {
      title: ['TEST electrical panel upgrade (synthetic)', 'TEST roof repair (synthetic)', 'TEST janitorial service (synthetic)'][i % 3]!,
      dueAt: new Date(Date.parse('2026-11-20T22:00:00Z') + (i % 4) * DAY).toISOString(),
      estValue: i % 5 === 0 ? null : { min: 10_000 + i * 100, max: 20_000 + i * 100 },
    }));
    await runScan({ db, sources: [sourceOf('samgov', () => drafts)], profiles: [profile], ctx: scanCtx() });
    const queries = [
      { minScore: 0, includeSwiped: true },
      { minScore: 0, includeSwiped: true, sort: 'due' as const },
      { minScore: 0, includeSwiped: true, sort: 'value' as const, hasValue: true },
      { minScore: 35, sort: 'near' as const },
      { minScore: 0, includeSwiped: true, tiers: ['other' as const] },
      { minScore: 0, includeSwiped: true, tiers: ['fit' as const, 'sub' as const], sort: 'new' as const },
      { minScore: 0, includeSwiped: true, q: 'electrical' },
    ];
    for (const q of queries) {
      const everything = await getFeed(db, profile.id, { ...q, limit: 300, now: NOW });
      const total = await getFeedTotal(db, profile.id, { ...q, now: NOW });
      expect(total, JSON.stringify(q)).toBe(everything.length);
      const paged: string[] = [];
      for (let offset = 0; offset < total + 7; offset += 7) {
        paged.push(...(await getFeed(db, profile.id, { ...q, limit: 7, offset, now: NOW })).map((b) => b.id));
      }
      expect(paged, JSON.stringify(q)).toEqual(everything.map((b) => b.id)); // same order, no overlap, no gap
    }
    expect(await getFeed(db, profile.id, { minScore: 0, offset: 10_000, now: NOW })).toEqual([]);
  });
});

describe('"Last scan" with a scan per group', () => {
  it('moves only for a scan that changed the feeds: stored bids, or the default group (the day\'s re-score)', async () => {
    const t = (m: number) => new Date(NOW.getTime() + m * 60_000);
    await recordScan(db, t(0), { group: 'default', totalBids: 0 });
    const first = await lastScanAt(db);
    expect(first).toBeTruthy();
    await recordScan(db, t(5), { group: 'south', totalBids: 0 }); // every source failed or found nothing
    expect(await lastScanAt(db)).toBe(first);
    await recordScan(db, t(10), { group: 'east', totalBids: 12 });
    const east = await lastScanAt(db);
    expect(east).not.toBe(first);
    expect((await lastScan(db))?.report).toMatchObject({ group: 'east' });
    await recordScan(db, t(15), { totalBids: 0 }); // a full local scan re-scores every open bid
    expect(await lastScanAt(db)).not.toBe(east);
  });
});

describe('a group scan', () => {
  it("keeps every other group's rows: it judges only the bids its own boards returned", async () => {
    await markSourcesKnown(db, ['samgov', 'bidbuy']);
    await runScan({ db, sources: [sourceOf('samgov', () => [draft('samgov', 'TEST-default')])], profiles: [profile], ctx: scanCtx(), group: 'default' });
    await runScan({ db, sources: [sourceOf('bidbuy', () => [draft('bidbuy', 'TEST-east')])], profiles: [profile], ctx: scanCtx(), group: 'east' });
    expect((await getFeed(db, profile.id, { now: NOW })).map((b) => b.id).sort()).toEqual(['bidbuy:TEST-east', 'samgov:TEST-default']);
    // A bid the group's board returns that is no longer a candidate (now far away) does lose its row.
    await runScan({
      db, sources: [sourceOf('bidbuy', () => [draft('bidbuy', 'TEST-east', { location: { city: 'Boston', state: 'MA' } })])],
      profiles: [profile], ctx: scanCtx(), group: 'east',
    });
    expect((await getFeed(db, profile.id, { now: NOW, minScore: 0 })).map((b) => b.id)).toEqual(['samgov:TEST-default']);
  });
});
