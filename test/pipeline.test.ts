import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/db.js';
import { getFeed, getSaved, getUnnotified, lastScan, recordSwipe, undoSwipe } from '../src/db/repo.js';
import { buildDigest } from '../src/notify/digest.js';
import { sendDigest } from '../src/notify/send.js';
import { loadProfile } from '../src/profiles.js';
import { runScan } from '../src/scan.js';
import { parseDouglasRfp } from '../src/sources/douglascounty.js';
import { parseNgemPage } from '../src/sources/ngem.js';
import { parseQuestJson, QUEST_BOARDS } from '../src/sources/questcdn.js';
import type { Source, SourceContext } from '../src/types.js';

const fx = (f: string) => readFileSync(resolve(__dirname, 'fixtures', f), 'utf8');
const NOW = new Date('2026-11-11T20:00:00Z');
const profile = loadProfile('lm-electric');

/** Sources that read the captured pages instead of the network. */
const fakeSources: Source[] = [
  { id: 'questcdn', name: 'q', homepage: '', fetch: async () => parseQuestJson(JSON.parse(fx('questcdn-spwd.json')), QUEST_BOARDS[0]!) },
  { id: 'ngem', name: 'n', homepage: '', fetch: async () => parseNgemPage(fx('ngem-page1.html')).bids },
  { id: 'douglascounty', name: 'd', homepage: '', fetch: async () => parseDouglasRfp(fx('douglas-rfp.html')) },
  { id: 'nevadaepro', name: 'broken', homepage: '', fetch: async () => { throw new Error('HTTP 503 for nevadaepro'); } },
  { id: 'samgov', name: 's', homepage: '', disabledReason: () => 'SAM_API_KEY not set', fetch: async () => [] },
];
const ctx: SourceContext = {
  http: { text: async () => '', json: async () => ({}) as never },
  now: NOW,
  env: () => undefined,
  log: () => {},
};

let db: Db;
beforeAll(async () => {
  db = await openDb({ dataDir: 'memory://' });
});
afterAll(async () => db.close());

describe('scan pipeline on PGlite', () => {
  it('stores, scores, and survives a broken source', async () => {
    const report = await runScan({ db, sources: fakeSources, profiles: [profile], ctx });
    expect(report.sources.nevadaepro).toMatchObject({ ok: false, error: 'HTTP 503 for nevadaepro' });
    expect(report.sources.samgov).toMatchObject({ ok: true, skipped: 'SAM_API_KEY not set' });
    expect(report.sources.questcdn).toMatchObject({ ok: true, fetched: 13 });
    expect(report.totalBids).toBe(13 + 9 + 1);
    expect(report.newBids).toBe(23);
    expect((await lastScan(db))?.finishedAt).toBeTruthy();
  });

  it('serves the best fits first and hides poor ones', async () => {
    const feed = await getFeed(db, profile.id, { now: NOW });
    expect(feed[0]!.title).toBe('Replace Cell Doors, Locks, Intercoms & Controls in…');
    expect(feed[0]!.verdict).toBe('great');
    expect(feed.every((b) => b.score >= 35)).toBe(true);
    expect(feed.some((b) => b.title.includes('Janitorial'))).toBe(false);
    expect(feed[0]!.location.label).toBe('Carson City, NV');
    expect(feed[0]!.reasons[0]!.kind).toBe('plus');
  });

  it('is idempotent: a re-scan adds nothing new', async () => {
    const again = await runScan({ db, sources: fakeSources, profiles: [profile], ctx });
    expect(again.newBids).toBe(0);
    expect(again.profiles[profile.id]!.newGood).toBe(0);
  });

  it('swipes move bids out of the deck and into Saved, and undo works', async () => {
    const [top] = await getFeed(db, profile.id, { now: NOW });
    expect(await recordSwipe(db, profile.id, top!.id, 'save')).toBe(true);
    expect((await getFeed(db, profile.id, { now: NOW })).find((b) => b.id === top!.id)).toBeUndefined();
    expect((await getSaved(db, profile.id)).map((b) => b.id)).toEqual([top!.id]);
    expect((await getFeed(db, profile.id, { now: NOW, includeSwiped: true })).find((b) => b.id === top!.id)?.swipe).toBe('save');
    await undoSwipe(db, profile.id, top!.id);
    expect(await getSaved(db, profile.id)).toHaveLength(0);
    expect(await recordSwipe(db, profile.id, 'nope:123', 'save')).toBe(false); // unknown bid
  });

  it('digest picks up good new matches once, and the email is readable', async () => {
    const fresh = await getUnnotified(db, profile.id, profile.notify.minScore, NOW);
    expect(fresh.map((b) => b.score).every((s) => s >= profile.notify.minScore)).toBe(true);
    expect(fresh.length).toBeGreaterThanOrEqual(2);
    const d = buildDigest(profile, fresh, 'https://bids.example.com', NOW);
    expect(d.subject).toMatch(/new bids for L&M Electric/);
    expect(d.html).toContain('L&amp;M Electric');
    expect(d.text).toContain('Due in 7 days');

    const out = mkdtempSync(join(tmpdir(), 'bidswipe-'));
    const res = await sendDigest(db, profile, { to: [], appUrl: 'https://bids.example.com', outDir: out, log: () => {} }, NOW);
    expect(res).toMatchObject({ sent: false, count: fresh.length });
  });
});
