import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/context.js';
import type { Db } from '../src/db/db.js';
import { loadProfile } from '../src/profiles.js';
import { buildServer } from '../src/server.js';
import { memoryDb } from './helpers.js';

/**
 * GET /api/cron/*: the daily jobs for a host whose own scheduler calls the app (serverless).
 * The scan and the market refresh are stubbed: what is tested here is who may start them.
 */
const profile = loadProfile('lm-electric');
const SECRET = 'cron-test-secret';
let db: Db;
let on: FastifyInstance; // CRON_SECRET set
let off: FastifyInstance; // no CRON_SECRET
let scans = 0;
let marketCalls = 0;

beforeAll(async () => {
  db = await memoryDb();
  const scan = async () => {
    scans++;
    return { startedAt: 'a', finishedAt: 'b', sources: {}, totalBids: 0, newBids: 0, profiles: {} };
  };
  // Every market request fails: the route must still answer 200 with the failure in the status.
  const down = async (): Promise<never> => {
    marketCalls++;
    throw new Error('TEST: market source is down');
  };
  const marketHttp = { awards: { text: down, json: down }, bls: { text: down, json: down } };
  on = await buildServer({ db, profile }, { config: loadConfig({ CRON_SECRET: SECRET, ACCESS_CODE: 'volts' }), scan, marketHttp });
  off = await buildServer({ db, profile }, { config: loadConfig({}), scan });
});
afterAll(async () => {
  await on.close();
  await off.close();
  await db.close();
});

describe('cron routes', () => {
  it('do not exist without CRON_SECRET', async () => {
    for (const path of ['/api/cron/scan', '/api/cron/market']) {
      const res = await off.inject({ url: path, headers: { authorization: `Bearer ${SECRET}` } });
      expect(res.statusCode).toBe(404);
    }
    expect(scans).toBe(0);
  });

  it('refuse a missing or wrong secret, and never start the job', async () => {
    const tries = [undefined, 'Bearer nope', `Bearer ${SECRET}x`, SECRET, `Basic ${SECRET}`];
    for (const authorization of tries) {
      const res = await on.inject({ url: '/api/cron/scan', headers: authorization ? { authorization } : {} });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'cron_secret_required' });
    }
    expect(scans).toBe(0);
  });

  it('run the scan with the secret, even behind the shared access code', async () => {
    // The host's scheduler sends only the Authorization header: no x-access-code.
    const res = await on.inject({ url: '/api/cron/scan', headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totalBids: 0, newBids: 0 });
    expect(scans).toBe(1);
  });

  it('run the market refresh with the secret; a failed refresh is a 200 with the failure in the status', async () => {
    const refused = await on.inject({ url: '/api/cron/market' });
    expect(refused.statusCode).toBe(401);
    expect(marketCalls).toBe(0);

    const res = await on.inject({ url: '/api/cron/market', headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.statusCode).toBe(200);
    expect(marketCalls).toBeGreaterThan(0);
    const status = res.json();
    expect(status.lastRun).toMatchObject({ trigger: 'schedule', ok: false });
    expect(JSON.stringify(status.lastRun.errors)).toContain('TEST: market source is down');
  });

  it('are GET only: a POST starts nothing', async () => {
    const res = await on.inject({ method: 'POST', url: '/api/cron/scan', headers: { authorization: `Bearer ${SECRET}` } });
    expect([401, 404]).toContain(res.statusCode); // no such route; the access-code hook answers first here
    expect(scans).toBe(1);
  });
});
