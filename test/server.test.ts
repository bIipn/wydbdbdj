import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type Db } from '../src/db/db.js';
import { loadProfile } from '../src/profiles.js';
import { runScan } from '../src/scan.js';
import { buildServer } from '../src/server.js';
import { parseQuestJson, QUEST_BOARDS } from '../src/sources/questcdn.js';
import type { FeedItem } from '../src/types.js';

const profile = loadProfile('lm-electric');
let db: Db;
let app: FastifyInstance;
let locked: FastifyInstance;

beforeAll(async () => {
  db = await openDb({ dataDir: 'memory://' });
  const json = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/questcdn-spwd.json'), 'utf8'));
  // "now" before the deadlines so the feed is populated no matter when the test runs.
  const now = new Date('2026-11-11T20:00:00Z');
  await runScan({
    db, profiles: [profile],
    sources: [{ id: 'questcdn', name: 'q', homepage: '', fetch: async () => parseQuestJson(json, QUEST_BOARDS[0]!) }],
    ctx: { http: { text: async () => '', json: async () => ({}) as never }, now, env: () => undefined, log: () => {} },
  });
  app = await buildServer({ db, profile }, { now: () => now });
  locked = await buildServer({ db, profile }, { accessCode: 'volts', adminToken: 'secret', scan: async () => ({ ok: true }) as never, now: () => now });
});
afterAll(async () => {
  await app.close();
  await locked.close();
  await db.close();
});

describe('API', () => {
  it('health + profile', async () => {
    expect((await app.inject('/api/health')).json()).toMatchObject({ ok: true, db: 'pglite', profile: 'lm-electric' });
    expect((await app.inject('/api/me')).json()).toMatchObject({ name: 'L&M Electric', base: 'Gardnerville, NV' });
  });

  it('feed → swipe → saved → undo', async () => {
    const all = (await app.inject('/api/feed?all=1&minScore=0')).json().items as FeedItem[];
    expect(all.length).toBe(13);
    const best = all[0]!;
    const res = await app.inject({ method: 'POST', url: '/api/swipe', payload: { bidId: best.id, action: 'save' } });
    expect(res.json()).toEqual({ ok: true });
    expect(((await app.inject('/api/saved')).json().items as FeedItem[])[0]!.id).toBe(best.id);
    // Browsers may send DELETE with no body; make sure that path works.
    expect((await app.inject({ method: 'DELETE', url: `/api/swipe/${encodeURIComponent(best.id)}` })).statusCode).toBe(200);
    expect((await app.inject('/api/saved')).json().items).toHaveLength(0);
  });

  it('validates swipe input', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/swipe', payload: { bidId: 'x', action: 'like' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/swipe', payload: { bidId: 'nope', action: 'save' } })).statusCode).toBe(404);
  });

  it('serves the app shell', async () => {
    const res = await app.inject('/');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('BidSwipe');
  });
});

describe('access control', () => {
  it('requires the access code for data but not for health or the app shell', async () => {
    expect((await locked.inject('/api/feed')).statusCode).toBe(401);
    expect((await locked.inject({ url: '/api/feed', headers: { 'x-access-code': 'volts' } })).statusCode).toBe(200);
    expect((await locked.inject('/api/health')).statusCode).toBe(200);
    expect((await locked.inject('/')).statusCode).toBe(200);
  });
  it('protects the admin scan with its own token', async () => {
    expect((await locked.inject({ method: 'POST', url: '/api/admin/scan' })).statusCode).toBe(401);
    expect((await locked.inject({ method: 'POST', url: '/api/admin/scan', headers: { 'x-admin-token': 'secret' } })).json()).toEqual({ ok: true });
  });
});
