/**
 * The quiet switch on every way to start a scan (GET /api/cron/scan?quiet=1, POST /api/admin/scan with quiet, the
 * scan runner the server builds), and GET /api/feed's paging (offset, total). Synthetic data only (TEST ids).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type ScanRequest } from '../src/context.js';
import type { Db } from '../src/db/db.js';
import { getFeed } from '../src/db/repo.js';
import { loadProfile } from '../src/profiles.js';
import { runScan, type ScanDeps, type ScanReport } from '../src/scan.js';
import { buildServer, createScanRunner } from '../src/server.js';
import type { BidDraft, FeedItem, Source } from '../src/types.js';
import { CAPTURED, memoryDb, resetDb, scanCtx } from './helpers.js';
import { markSourcesKnown } from './scan-helpers.js';

const fakeReport = (req?: ScanRequest): ScanReport => ({
  ...(req?.group ? { group: req.group } : {}), ...(req?.quiet ? { quiet: true } : {}),
  startedAt: 'a', finishedAt: 'b', sources: {}, totalBids: 0, newBids: 0, profiles: {},
});

let db: Db;
beforeAll(async () => {
  db = await memoryDb();
});
afterAll(async () => db.close());

describe('quiet on the scan routes', () => {
  let app: FastifyInstance;
  const asked: Array<ScanRequest | undefined> = [];
  const SECRET = 'TEST-cron-secret';
  const auth = { authorization: `Bearer ${SECRET}` };
  const admin = { 'x-admin-token': 'TEST-admin', 'x-bidswipe': '1' };
  beforeAll(async () => {
    const scan = async (req?: ScanRequest) => (asked.push(req), fakeReport(req));
    app = await buildServer({ db, profile: loadProfile('lm-electric') }, { config: loadConfig({ CRON_SECRET: SECRET, ADMIN_TOKEN: 'TEST-admin' }), scan });
  });
  afterAll(async () => app.close());
  beforeEach(() => { asked.length = 0; });

  it('GET /api/cron/scan?quiet=1 runs a quiet scan of the group; quiet=0 or none is a normal one; junk is a 400', async () => {
    expect((await app.inject({ url: '/api/cron/scan?group=west&quiet=1', headers: auth })).json()).toMatchObject({ group: 'west', quiet: true });
    expect((await app.inject({ url: '/api/cron/scan?quiet=true', headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/cron/scan?quiet=0', headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/cron/scan?group=east', headers: auth })).statusCode).toBe(200);
    const bad = await app.inject({ url: '/api/cron/scan?quiet=maybe', headers: auth });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ url: '/api/cron/scan?quiet=1' })).statusCode).toBe(401); // the secret is still required
    expect(asked).toEqual([{ group: 'west', quiet: true }, { quiet: true }, {}, { group: 'east' }]);
  });

  it('POST /api/admin/scan takes ?quiet=1 or a JSON body { quiet: true }', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/admin/scan?group=south&quiet=1', headers: admin })).json()).toMatchObject({ quiet: true });
    expect((await app.inject({ method: 'POST', url: '/api/admin/scan', headers: admin, payload: { quiet: true } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/admin/scan', headers: admin, payload: { quiet: 'yes' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/admin/scan', headers: admin })).statusCode).toBe(200);
    expect(asked).toEqual([{ group: 'south', quiet: true }, { quiet: true }, {}]);
  });
});

describe('the scan runner', () => {
  it('passes quiet to runScan and sends no digest for a quiet default-group scan', async () => {
    const seen: Array<Partial<ScanDeps>> = [];
    const scan = async (d: ScanDeps) => (seen.push({ group: d.group, quiet: d.quiet }), fakeReport({ group: d.group, quiet: d.quiet }));
    const deps = { db, profile: null, sourcesFor: () => [], makeCtx: () => scanCtx() };
    const run = createScanRunner(deps, { appUrl: 'https://bids.example.com' }, undefined, scan as typeof runScan);
    await run({ group: 'west', quiet: true });
    await run({});
    expect(seen).toEqual([{ group: 'west', quiet: true }, { group: 'default', quiet: undefined }]);
  });
});

describe('GET /api/feed paging', () => {
  it('offset + limit walk the whole list in a stable order; total counts every match of the filters, tier included', async () => {
    await resetDb(db);
    await markSourcesKnown(db, ['samgov']);
    const profile = loadProfile('lm-electric');
    const drafts: BidDraft[] = Array.from({ length: 23 }, (_, i) => ({
      source: 'samgov', sourceId: `TEST-feedpage-${String(i).padStart(2, '0')}`, sourceName: 'TEST board',
      title: i % 2 ? 'TEST electrical panel upgrade (synthetic)' : 'TEST janitorial service (synthetic)', agency: 'TEST agency',
      description: null, category: null, location: { city: 'Carson City', state: 'NV' }, postedAt: null,
      dueAt: new Date(Date.parse('2026-11-25T22:00:00Z') + (i % 3) * 86_400_000).toISOString(), estValue: null, naics: null,
      setAside: null, url: 'https://example.com/test-bid',
    }));
    const source: Source = { id: 'samgov', name: 'TEST', homepage: '', fetch: async () => drafts };
    await runScan({ db, sources: [source], profiles: [profile], ctx: scanCtx(CAPTURED) });
    const app = await buildServer({ db, profile }, { now: () => CAPTURED });
    try {
      for (const qs of ['all=1&minScore=0', 'all=1&minScore=0&sort=due', 'all=1&minScore=0&tier=other', '']) {
        const full = (await app.inject(`/api/feed?${qs}&limit=300`)).json() as { items: FeedItem[]; total: number };
        expect(full.total, qs).toBe(full.items.length);
        const ids: string[] = [];
        for (let offset = 0; offset < full.total; offset += 5) {
          const page = (await app.inject(`/api/feed?${qs}&limit=5&offset=${offset}`)).json() as { items: FeedItem[]; total: number };
          expect(page.total).toBe(full.total);
          ids.push(...page.items.map((b) => b.id));
        }
        expect(ids, qs).toEqual(full.items.map((b) => b.id));
      }
      const everything = await getFeed(db, profile.id, { minScore: 0, includeSwiped: true, limit: 300, now: CAPTURED });
      expect(((await app.inject('/api/feed?all=1&minScore=0&limit=1')).json() as { total: number }).total).toBe(everything.length);
      expect((await app.inject('/api/feed?offset=-1')).statusCode).toBe(200); // pulled up to 0, like every number
      expect((await app.inject('/api/feed?offset=2.5')).statusCode).toBe(400);
      expect((await app.inject('/api/feed?offset=ten')).statusCode).toBe(400);
      expect(((await app.inject('/api/feed?all=1&minScore=0&offset=999')).json() as { items: unknown[] }).items).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
