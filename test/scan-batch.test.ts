/**
 * The scan at scale: only candidates are scored and stored (src/score/candidates.ts), bids and matches are
 * written in multi-row statements, and the scan's old promises still hold. Bids here are synthetic (TEST- ids,
 * example.com links) unless they come from questSource(), the real NV State Public Works capture.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { BID_BATCH, getFeed, getItem, getOpenBids, getUnnotified, markNotified, MATCH_BATCH, recordSwipe, upsertBids, upsertMatches, upsertProfile } from '../src/db/repo.js';
import { createBus, type BusEventOf } from '../src/realtime/bus.js';
import { alertThreshold, runScan, scoreProfile } from '../src/scan.js';
import { isCandidate } from '../src/score/candidates.js';
import { scoreBid } from '../src/score/score.js';
import type { Bid, BidDraft, Source } from '../src/types.js';
import { memoryDb, NOW, questSource, resetDb, scanCtx, testBid, testProfile } from './helpers.js';

let db: Db;
beforeAll(async () => { db = await memoryDb(); });
beforeEach(async () => { await resetDb(db); });
afterAll(async () => db.close());

const count = async (sql: string, params: unknown[] = []) => (await db.query<{ n: number }>(sql, params))[0]!.n;
const matchCount = (profileId?: string) =>
  profileId ? count('select count(*)::int as n from matches where profile_id = $1', [profileId]) : count('select count(*)::int as n from matches');

/** A source that hands back these drafts (bids → drafts again, so runScan finalizes them as usual). */
const sourceOf = (bids: Bid[], id: Source['id'] = 'samgov'): Source => ({
  id, name: 'TEST', homepage: '',
  fetch: async () => bids.map(({ id: _id, ...b }): BidDraft => ({ ...b, location: { city: b.location.city, state: b.location.state, zip: b.location.zip, label: b.location.label } })),
});

/** Synthetic bids spread over real towns: near the pilot (Carson City), far in its states, far out of them. */
function spread(n: number): Bid[] {
  const towns = [
    { city: 'Carson City', state: 'NV', zip: '89701' }, // 15 mi: a candidate
    { city: 'Spring Creek', state: 'NV', zip: '89815' }, // 253 mi, in NV: a candidate (own state)
    { city: 'Boise', state: 'ID', zip: '83702' }, // 373 mi, Idaho: not
    { city: 'Dallas', state: 'TX', zip: '75201' }, // not
  ];
  return Array.from({ length: n }, (_, i) => testBid({ sourceId: `TEST-batch-${String(i).padStart(4, '0')}`, location: towns[i % 4]! }));
}

describe('candidates only', () => {
  it('stores a score only for candidates, and says how many it left out', async () => {
    const profile = testProfile('test-cands');
    const bids = spread(8);
    const report = await runScan({ db, sources: [sourceOf(bids)], profiles: [profile], ctx: scanCtx() });
    expect(report.profiles[profile.id]).toMatchObject({ scored: 4, outOfReach: 4 });
    expect(await count('select count(*)::int as n from bids')).toBe(8); // every bid is stored once…
    expect(await matchCount(profile.id)).toBe(4); // …but scored only where it can matter
    for (const b of bids) expect((await getItem(db, profile.id, b.id)) !== null).toBe(isCandidate(profile, b));
    // Browse (all=1, minScore 0) holds exactly the candidates.
    const browse = await getFeed(db, profile.id, { includeSwiped: true, minScore: 0, limit: 300, now: NOW });
    expect(browse.map((b) => b.id).sort()).toEqual(bids.filter((b) => isCandidate(profile, b)).map((b) => b.id).sort());
  });

  it('scoreProfile (onboarding, settings) keeps its signature, scores candidates only, and takes back what moved out of reach', async () => {
    const bids = spread(8);
    await upsertBids(db, bids, NOW);
    const at = testProfile('test-onboard');
    await upsertProfile(db, at);
    expect(await scoreProfile(db, at, NOW)).toBe(4);
    expect(await matchCount(at.id)).toBe(4);
    // The company saves one far in-state bid, then moves to Boise with a 50 mi radius and only Idaho.
    const elko = bids[1]!;
    expect(await recordSwipe(db, at.id, elko.id, 'save')).toBe(true);
    const moved = { ...at, base: { label: 'Boise, ID', lat: 43.6135, lng: -116.2035 }, states: ['ID'], maxDistanceMi: 50 };
    expect(await scoreProfile(db, moved, NOW)).toBe(2); // the two Boise bids
    const left = (await db.query<{ bid_id: string }>('select bid_id from matches where profile_id = $1 order by bid_id', [at.id])).map((r) => r.bid_id);
    expect(left).toEqual([elko.id, bids[2]!.id, bids[6]!.id].sort()); // Boise ×2, and the saved one is kept
  });

  it('a bid the digest already emailed survives a move out of reach, so moving back never emails it again', async () => {
    const bids = spread(8);
    await upsertBids(db, bids, NOW);
    const at = testProfile('test-emailed');
    await upsertProfile(db, at);
    await scoreProfile(db, at, NOW);
    const carson = bids[0]!; // 15 mi away
    await markNotified(db, at.id, [carson.id]);
    const moved = { ...at, base: { label: 'Boise, ID', lat: 43.6135, lng: -116.2035 }, states: ['ID'], maxDistanceMi: 50 };
    await scoreProfile(db, moved, NOW);
    expect(await getItem(db, at.id, carson.id)).not.toBeNull(); // the emailed link still opens the bid
    await scoreProfile(db, at, NOW); // back home
    expect((await getUnnotified(db, at.id, 0, NOW)).map((b) => b.id)).not.toContain(carson.id);
  });
});

describe('multi-row writes', () => {
  it(`stores ${BID_BATCH * 2 + 17} bids and their matches in batches, each row exactly as scored`, async () => {
    const profile = testProfile('test-batch');
    const bids = Array.from({ length: BID_BATCH * 2 + 17 }, (_, i) =>
      testBid({ sourceId: `TEST-many-${i}`, title: `TEST electrical job ${i} (synthetic)`, flags: i % 3 ? [] : ['Bid bond', 'TEST flag'] }));
    const report = await runScan({ db, sources: [sourceOf(bids)], profiles: [profile], ctx: scanCtx() });
    expect(report).toMatchObject({ totalBids: bids.length, newBids: bids.length });
    expect(await count('select count(*)::int as n from bids')).toBe(bids.length);
    expect(await matchCount(profile.id)).toBe(bids.length);
    for (const b of [bids[0]!, bids[BID_BATCH]!, bids.at(-1)!]) {
      const item = (await getItem(db, profile.id, b.id))!;
      const s = scoreBid(b, profile, NOW);
      expect({ score: item.score, verdict: item.verdict, reasons: item.reasons, distanceMi: item.distanceMi, overLimit: item.overLimit, flags: item.flags })
        .toEqual({ score: s.score, verdict: s.verdict, reasons: s.reasons, distanceMi: s.distanceMi, overLimit: s.overLimit, flags: b.flags });
    }
  });

  it(`upsertMatches writes more than ${MATCH_BATCH} rows, updates in place, and keeps the last of a repeated id`, async () => {
    const profile = testProfile('test-upsert');
    await upsertProfile(db, profile);
    const bids = Array.from({ length: MATCH_BATCH + 3 }, (_, i) => testBid({ sourceId: `TEST-m-${i}` }));
    await upsertBids(db, bids, NOW);
    const s = scoreBid(bids[0]!, profile, NOW);
    await upsertMatches(db, profile.id, bids.map((b) => ({ bidId: b.id, score: s })));
    expect(await matchCount(profile.id)).toBe(bids.length);
    const changed = { ...s, score: 12, verdict: 'skip' as const, distanceMi: null, reasons: [{ kind: 'info' as const, text: 'TEST “quoted”, $1 \\ ok' }] };
    await upsertMatches(db, profile.id, [{ bidId: bids[5]!.id, score: s }, { bidId: bids[5]!.id, score: changed }]);
    expect(await matchCount(profile.id)).toBe(bids.length);
    expect(await getItem(db, profile.id, bids[5]!.id)).toMatchObject({ score: 12, verdict: 'skip', distanceMi: null, reasons: changed.reasons });
  });

  it('upsertBids reports only brand-new ids, also across batches', async () => {
    const bids = Array.from({ length: BID_BATCH + 5 }, (_, i) => testBid({ sourceId: `TEST-u-${i}` }));
    expect((await upsertBids(db, bids.slice(0, 10), NOW)).size).toBe(10);
    const fresh = await upsertBids(db, bids, NOW);
    expect(fresh.size).toBe(BID_BATCH - 5);
    expect([...fresh].sort()).toEqual(bids.slice(10).map((b) => b.id).sort());
  });
});

describe('the scan keeps its promises', () => {
  const profile = testProfile('test-promises');

  it('an identical repeat scan creates nothing: no new bids, no new rows, the same scores', async () => {
    const sources = [questSource(), sourceOf(spread(8))];
    const first = await runScan({ db, sources, profiles: [profile], ctx: scanCtx() });
    const rows = await matchCount();
    const before = await db.query('select profile_id, bid_id, score, verdict, reasons, distance_mi, over_limit from matches order by 1, 2');
    const again = await runScan({ db, sources, profiles: [profile], ctx: scanCtx() });
    expect(first.newBids).toBe(21);
    expect(again.newBids).toBe(0);
    expect(await matchCount()).toBe(rows);
    expect(await db.query('select profile_id, bid_id, score, verdict, reasons, distance_mi, over_limit from matches order by 1, 2')).toEqual(before);
  });

  it('a broken source never stops the scan', async () => {
    const broken: Source = { id: 'ngem', name: 'TEST broken', homepage: '', fetch: async () => { throw new Error('TEST board down'); } };
    const report = await runScan({ db, sources: [broken, questSource()], profiles: [profile], ctx: scanCtx() });
    expect(report.sources.ngem).toMatchObject({ ok: false, error: 'TEST board down' });
    expect(report.sources.questcdn).toMatchObject({ ok: true, fetched: 13 });
    expect(report.profiles[profile.id]!.scored).toBe(13);
  });

  it('every scan re-scores every still-open candidate, fetched or not', async () => {
    const stale = spread(4);
    await runScan({ db, sources: [sourceOf(stale)], profiles: [profile], ctx: scanCtx() });
    const later = new Date(NOW.getTime() + 5 * 86_400_000);
    // The second scan fetches nothing of those four; the two candidates are re-scored at the new clock.
    const report = await runScan({ db, sources: [questSource()], profiles: [profile], ctx: scanCtx(later) });
    const open = await getOpenBids(db, later);
    const candidates = open.filter((b) => isCandidate(profile, b));
    expect(report.profiles[profile.id]!.scored).toBe(candidates.length);
    expect(report.profiles[profile.id]!.outOfReach).toBe(open.length - candidates.length);
    const near = (await getItem(db, profile.id, stale[0]!.id))!;
    expect(near.score).toBe(scoreBid(stale[0]!, profile, later).score);
    expect(near.reasons).toEqual(scoreBid(stale[0]!, profile, later).reasons);
  });

  it("only bids fetched in this scan raise 'match' alerts, and the scan yields to the event loop after each one", async () => {
    const alertable = (b: Bid) => {
      const s = scoreBid(b, profile, NOW);
      return isCandidate(profile, b) && s.score >= alertThreshold(profile) && !s.rejected && !s.overLimit;
    };
    const old = spread(4).filter(alertable);
    expect(old.length).toBeGreaterThan(0);
    await runScan({ db, sources: [sourceOf(old)], profiles: [profile], ctx: scanCtx() });

    const bus = createBus();
    const seen: BusEventOf<'match'>[] = [];
    let pendingTicks = 0; // setImmediate callbacks scheduled by a listener and not yet run
    let ranBeforeNext = true;
    bus.on('match', (e) => {
      if (pendingTicks > 0) ranBeforeNext = false; // the previous alert's tick never got to run
      seen.push(e);
      pendingTicks++;
      setImmediate(() => { pendingTicks--; });
    });
    await runScan({ db, sources: [questSource()], profiles: [profile], ctx: scanCtx(), bus });
    const fetchedIds = new Set((await questSource().fetch(scanCtx())).map((d) => `${d.source}:${d.sourceId}`));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const e of seen) expect(fetchedIds.has(e.bid.id)).toBe(true); // none of `old`
    expect(ranBeforeNext).toBe(true);
    // Each alert's row was stored before its event went out.
    for (const e of seen) expect(await getItem(db, profile.id, e.bid.id)).not.toBeNull();
  });
});
