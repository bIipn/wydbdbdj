import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import {
  getBid, getFeed, getItem, getOpenBids, getProfile, getProfileByAccount, getSaved, getUnnotified, listProfiles,
  recordSwipe, saveProfileForAccount, upsertBids, upsertMatch, upsertProfile,
} from '../src/db/repo.js';
import { scoreBid } from '../src/score/score.js';
import { memoryDb, NOW, seedAccount, testBid, testProfile } from './helpers.js';

let db: Db;
beforeAll(async () => {
  db = await memoryDb();
});
afterAll(async () => db.close());

describe('bids (v1 columns)', () => {
  const open = testBid({ sourceId: 'TEST-open', solNumber: 'TEST-SOL-42' });
  const noDeadline = testBid({ sourceId: 'TEST-no-deadline', dueAt: null });
  const closed = testBid({ sourceId: 'TEST-closed', dueAt: '2026-11-10T22:00:00.000Z' });

  it('getOpenBids returns what is still open at `now`, with the solicitation number', async () => {
    await upsertBids(db, [open, noDeadline, closed], NOW);
    const bids = await getOpenBids(db, NOW);
    expect(bids.map((b) => b.id).sort()).toEqual([noDeadline.id, open.id].sort());
    const stored = bids.find((b) => b.id === open.id)!;
    expect(stored).toEqual({ ...open, solNumber: 'TEST-SOL-42', psc: null }); // a plain Bid, round-tripped
    expect(bids.find((b) => b.id === noDeadline.id)!.solNumber).toBeNull();
    // A year later everything has closed. The bid with no deadline too: it is open only while its board still lists
    // it (seen within UNLISTED_GRACE_DAYS, repo.ts openBidSql), and no scan has seen it since NOW.
    const later = new Date('2027-11-11T00:00:00Z');
    expect((await getOpenBids(db, later)).map((b) => b.id)).toEqual([]);
    // A scan that still sees it there keeps it open.
    await upsertBids(db, [noDeadline], new Date(later.getTime() - 86_400_000));
    expect((await getOpenBids(db, later)).map((b) => b.id)).toEqual([noDeadline.id]);
    await upsertBids(db, [noDeadline], NOW); // back as it was, for the tests below
  });

  it('getBid finds one bid, open or not', async () => {
    expect((await getBid(db, closed.id))?.title).toBe(closed.title);
    expect(await getBid(db, 'samgov:TEST-missing')).toBeNull();
  });

  it('matches remember overLimit; the deck and the digest leave those bids out, Browse keeps them tagged', async () => {
    const profile = testProfile('test-repo-limits');
    await upsertProfile(db, profile);
    const s = scoreBid(open, profile, NOW);
    expect(s.score).toBeGreaterThanOrEqual(profile.notify.minScore);
    await upsertMatch(db, profile.id, open.id, { ...s, overLimit: true });
    await upsertMatch(db, profile.id, noDeadline.id, scoreBid(noDeadline, profile, NOW));

    const item = await getItem(db, profile.id, open.id);
    expect(item).toMatchObject({ overLimit: true, solNumber: 'TEST-SOL-42', score: s.score });
    expect((await getItem(db, profile.id, noDeadline.id))!.overLimit).toBe(false);

    const ids = async (q: Parameters<typeof getFeed>[2]) => (await getFeed(db, profile.id, { now: NOW, minScore: 0, ...q })).map((b) => b.id);
    expect(await ids({})).toContain(open.id); // default is unchanged: nothing hidden
    expect(await ids({ hideOverLimit: true })).toEqual([noDeadline.id]);
    expect(await ids({ includeSwiped: true })).toContain(open.id);
    expect((await getUnnotified(db, profile.id, 0, NOW)).map((b) => b.id)).toEqual([noDeadline.id]);

    // Back under the limit on the next score → visible again.
    await upsertMatch(db, profile.id, open.id, s);
    expect(await ids({ hideOverLimit: true })).toContain(open.id);
  });
});

describe('profiles owned by accounts', () => {
  it('stores one profile per account and gives it back by account or id', async () => {
    const a = await seedAccount(db);
    expect(await getProfileByAccount(db, a.id)).toBeNull();
    const p = testProfile('test-repo-a', { trades: ['electrical'], zip: '89410', limits: { maxJobSize: 75_000 } });
    expect(await saveProfileForAccount(db, a.id, p)).toEqual(p);
    expect(await getProfileByAccount(db, a.id)).toEqual(p);
    expect(await getProfile(db, 'test-repo-a')).toEqual(p);
    expect(await getProfile(db, 'test-repo-missing')).toBeNull();
  });

  it('a later save replaces the settings but keeps the id, so saved bids survive', async () => {
    const a = await seedAccount(db);
    const first = await saveProfileForAccount(db, a.id, testProfile('test-repo-keep'));
    const bid = testBid({ sourceId: 'TEST-keep' });
    await upsertBids(db, [bid], NOW);
    await upsertMatch(db, first.id, bid.id, scoreBid(bid, first, NOW));
    await recordSwipe(db, first.id, bid.id, 'save');

    const second = await saveProfileForAccount(db, a.id, testProfile('test-repo-some-other-id', { maxDistanceMi: 40 }));
    expect(second.id).toBe('test-repo-keep');
    expect(second.maxDistanceMi).toBe(40);
    expect(await getProfileByAccount(db, a.id)).toEqual(second);
    expect(await getProfile(db, 'test-repo-some-other-id')).toBeNull();
    expect((await getSaved(db, 'test-repo-keep')).map((b) => b.id)).toEqual([bid.id]);
  });

  it('refuses an id that belongs to another account or to a config profile', async () => {
    const [a, b] = [await seedAccount(db), await seedAccount(db)];
    await saveProfileForAccount(db, a.id, testProfile('test-repo-taken'));
    await expect(saveProfileForAccount(db, b.id, testProfile('test-repo-taken'))).rejects.toThrow(/already taken/);
    await upsertProfile(db, testProfile('test-repo-config'));
    await expect(saveProfileForAccount(db, b.id, testProfile('test-repo-config'))).rejects.toThrow(/already taken/);
    expect(await getProfileByAccount(db, b.id)).toBeNull();
  });

  it('the scan\'s upsertProfile refreshes config profiles but never overwrites an account\'s profile', async () => {
    const a = await seedAccount(db);
    const mine = await saveProfileForAccount(db, a.id, testProfile('test-repo-mine', { maxDistanceMi: 40 }));
    await upsertProfile(db, { ...mine, maxDistanceMi: 90 }); // a scan holding a copy read before the user saved
    expect((await getProfileByAccount(db, a.id))!.maxDistanceMi).toBe(40);

    await upsertProfile(db, testProfile('test-repo-config', { maxDistanceMi: 10 }));
    expect((await getProfile(db, 'test-repo-config'))!.maxDistanceMi).toBe(10);
  });

  it('listProfiles returns every stored profile, config and account-owned', async () => {
    const ids = (await listProfiles(db)).map((p) => p.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual(expect.arrayContaining(['test-repo-a', 'test-repo-keep', 'test-repo-taken', 'test-repo-config', 'test-repo-mine']));
    expect(ids).not.toContain('test-repo-some-other-id');
  });
});
