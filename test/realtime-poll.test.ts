/**
 * REALTIME_MODE=poll: the stream is off and the app polls the inbox instead (serverless hosts).
 * Everything here is synthetic (TEST- ids, example.com).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthService } from '../src/auth/index.js';
import { createContext } from '../src/context.js';
import { insertAlert } from '../src/db/alerts.js';
import type { Db } from '../src/db/db.js';
import { recordScan, saveProfileForAccount } from '../src/db/repo.js';
import { profileIdFor } from '../src/profile/build.js';
import { createBus } from '../src/realtime/bus.js';
import { POLL_MS, pollInterval, realtimeMode, register as realtimeRoutes } from '../src/routes/realtime.js';
import type { Account } from '../src/types.js';
import { accountsConfig, memoryDb, NOW, seedAccount, testProfile } from './helpers.js';

const headerAuth = (accounts: Map<string, Account>): AuthService => ({
  authenticate: async (req) => accounts.get(String(req.headers['x-test-account'])) ?? null,
});

describe('realtimeMode(): which variable values turn the stream off', () => {
  it.each<[string | undefined, 'stream' | 'poll']>([
    [undefined, 'stream'], ['', 'stream'], ['stream', 'stream'], ['sse', 'stream'], ['poll', 'poll'], ['POLL', 'poll'],
  ])('REALTIME_MODE=%j → %s', (value, mode) => expect(realtimeMode(value)).toBe(mode));

  it('unset on Vercel (VERCEL=1) polls, since a stream there would hear nothing; a set value still wins', () => {
    expect(realtimeMode('', true)).toBe('poll');
    expect(realtimeMode('stream', true)).toBe('stream');
    expect(realtimeMode('poll', false)).toBe('poll');
    expect(realtimeMode('', false)).toBe('stream');
  });
});

describe('pollInterval(): REALTIME_POLL_MS', () => {
  it.each<[string | undefined, number]>([
    [undefined, 60_000], ['', 60_000], ['abc', 60_000], ['5000', 60_000], ['14999', 60_000], ['15000', 15_000], ['120000', 120_000], ['-20000', 60_000],
  ])('REALTIME_POLL_MS=%j → %i ms', (value, ms) => expect(pollInterval(value)).toBe(ms));
});

describe('GET /api/stream with REALTIME_MODE=poll', () => {
  const accounts = new Map<string, Account>();
  let db: Db;
  let app: FastifyInstance;
  let stream: FastifyInstance;
  let alice: Account;
  let profileId: string;

  beforeAll(async () => {
    db = await memoryDb();
    alice = await seedAccount(db, { plan: 'pro' });
    accounts.set(alice.id, alice);
    profileId = (await saveProfileForAccount(db, alice.id, testProfile(profileIdFor(alice.id)))).id;
    const ctx = createContext({ db, config: accountsConfig(), bus: createBus(), auth: headerAuth(accounts), now: () => NOW });
    app = Fastify();
    await realtimeRoutes(app, ctx, { mode: 'poll' });
    stream = Fastify();
    await realtimeRoutes(stream, ctx, { mode: 'stream' });
  });
  afterAll(async () => {
    await app.close();
    await stream.close();
    await db.close();
  });

  it('answers 404 stream_off with the poll interval, signed in or not, and never opens a stream', async () => {
    for (const headers of [{}, { 'x-test-account': alice.id }]) {
      const res = await app.inject({ method: 'GET', url: '/api/stream', headers });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.json()).toEqual({ error: 'stream_off', pollMs: POLL_MS });
    }
    expect(POLL_MS).toBe(60_000);
    expect((await app.inject({ method: 'HEAD', url: '/api/stream' })).statusCode).toBe(404);
  });

  it('takes the interval from the options', async () => {
    const quick = Fastify();
    await realtimeRoutes(quick, createContext({ db, config: accountsConfig(), bus: createBus(), auth: headerAuth(accounts), now: () => NOW }), { mode: 'poll', pollMs: 1500 });
    expect((await quick.inject({ method: 'GET', url: '/api/stream' })).json()).toEqual({ error: 'stream_off', pollMs: 1500 });
    await quick.close();
  });

  it('stream mode is unchanged: signed out is still 401 sign_in_required', async () => {
    const res = await stream.inject({ method: 'GET', url: '/api/stream' });
    expect([res.statusCode, res.json()]).toEqual([401, { error: 'sign_in_required' }]);
  });

  it('the inbox still works, so a poll sees a new alert on its next request', async () => {
    const as = { 'x-test-account': alice.id };
    const before = (await app.inject({ method: 'GET', url: '/api/alerts?limit=50', headers: as })).json();
    expect(before).toEqual({ items: [], unread: 0, lastScan: null });

    const stored = await insertAlert(db, profileId, {
      kind: 'match', bidId: 'samgov:TEST-poll', dedupeKey: 'samgov:TEST-poll', title: 'TEST alert (synthetic)', body: 'TEST body',
      data: { bidId: 'samgov:TEST-poll', score: 80, url: 'https://example.com/test-bid' },
    }, { push: false, now: NOW });
    expect(stored).not.toBeNull();

    const after = (await app.inject({ method: 'GET', url: '/api/alerts?limit=50', headers: as })).json();
    expect(after.unread).toBe(1);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]).toMatchObject({ id: stored!.id, kind: 'match', bidId: 'samgov:TEST-poll' });
    // Another business's poll does not see it.
    expect((await app.inject({ method: 'GET', url: '/api/alerts', headers: {} })).statusCode).toBe(401);
  });

  it('says when the last scan finished, so a polling app reloads its feed after a scan with no alert', async () => {
    const as = { 'x-test-account': alice.id };
    await recordScan(db, NOW, { test: 'TEST scan report (synthetic)' });
    const res = (await app.inject({ method: 'GET', url: '/api/alerts?limit=1', headers: as })).json();
    expect(typeof res.lastScan).toBe('string');
    expect(Number.isFinite(Date.parse(res.lastScan))).toBe(true);
  });

  it('push and the inbox routes are registered in both modes', () => {
    for (const a of [app, stream]) {
      expect(a.hasRoute({ method: 'GET', url: '/api/alerts' })).toBe(true);
      expect(a.hasRoute({ method: 'POST', url: '/api/alerts/read' })).toBe(true);
      expect(a.hasRoute({ method: 'GET', url: '/api/push/key' })).toBe(true);
      expect(a.hasRoute({ method: 'POST', url: '/api/push/subscribe' })).toBe(true);
    }
  });
});
