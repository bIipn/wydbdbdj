/**
 * The seams the v1 modules plug into. These tests hold for the foundation stubs AND for the real
 * implementations: they pin signatures and the rules every implementation must keep.
 */
import fc from 'fast-check';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth } from '../src/auth/index.js';
import { createContext } from '../src/context.js';
import type { Db } from '../src/db/db.js';
import { pickNext } from '../src/feed/next.js';
import { lookupCity, lookupZip, statesWithin } from '../src/geo/zip.js';
import { profileIdFor, summarize } from '../src/profile/build.js';
import { loadProfile, validateProfile } from '../src/profiles.js';
import { createBus } from '../src/realtime/bus.js';
import { startRealtime } from '../src/realtime/index.js';
import { getTrade, TRADES } from '../src/trades/catalog.js';
import type { FeedItem } from '../src/types.js';
import { accountsConfig, memoryDb, NOW, testBid, testProfile } from './helpers.js';

let db: Db;
beforeAll(async () => {
  db = await memoryDb();
});
afterAll(async () => db.close());

describe('trade catalog', () => {
  it('has an electrical trade with keywords for every list and the electrical-contractor NAICS code', () => {
    const t = getTrade('electrical')!;
    expect(t.label).toBeTruthy();
    expect(t.blurb).toBeTruthy();
    expect(t.naics.strong).toContain('238210');
    for (const list of ['strong', 'related', 'general', 'otherTrades', 'exclude'] as const) expect(t.keywords[list].length, list).toBeGreaterThan(0);
  });

  it('uses unique lowercase slugs, and getTrade answers null for an unknown id', () => {
    const ids = TRADES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z0-9-]+$/.test(id))).toBe(true);
    expect(getTrade('TEST-no-such-trade')).toBeNull();
  });
});

describe('profile ids and summaries', () => {
  it('profileIdFor is stable and always a valid profile id, whatever the account id looks like', () => {
    expect(profileIdFor('TEST-acct-1')).toBe('acct-test-acct-1');
    expect(profileIdFor('8f2b6c1e-0d4a-4b7e-9c55-2a1f3e4d5b6c')).toBe('acct-8f2b6c1e-0d4a-4b7e-9c55-2a1f3e4d5b6c');
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (accountId) => {
        const id = profileIdFor(accountId);
        expect(id).toMatch(/^[a-z0-9-]+$/);
        expect(profileIdFor(accountId)).toBe(id);
        expect(() => validateProfile(testProfile(id))).not.toThrow();
      }),
    );
    // Lowercase UUIDs (what account ids should be) never collide.
    fc.assert(fc.property(fc.uuid(), fc.uuid(), (a, b) => a === b || profileIdFor(a) !== profileIdFor(b)));
  });

  it('summarize gives the settings form its answers back, without the keyword lists', () => {
    expect(summarize(loadProfile('lm-electric'))).toEqual({
      id: 'lm-electric', businessName: 'L&M Electric', trades: [], zip: null, base: 'Gardnerville, NV', radiusMi: 90,
      valueRange: { min: 10000, max: 50000 }, limits: {}, costs: {}, alerts: { minScore: 55 }, setAsides: ['SBA', 'SBP'],
    });
    const full = testProfile('test-summary', {
      trades: ['electrical'], zip: '89410', limits: { maxJobSize: 75_000, bondingCapacity: null }, costs: { burdenPct: 30 },
      alerts: { minScore: 70, push: true, quietHours: { start: '21:00', end: '06:00' } },
    });
    expect(summarize(full)).toMatchObject({
      trades: ['electrical'], zip: '89410', limits: { maxJobSize: 75_000, bondingCapacity: null }, costs: { burdenPct: 30 },
      alerts: { minScore: 70, push: true, quietHours: { start: '21:00', end: '06:00' } },
    });
    expect(summarize(full)).not.toHaveProperty('keywords');
  });
});

describe('next bid', () => {
  const item = (over: Partial<FeedItem>): FeedItem => ({
    ...testBid(), score: 90, verdict: 'great', reasons: [], distanceMi: 20, swipe: null, firstSeenAt: NOW.toISOString(), overLimit: false, ...over,
  });

  it('answers { item: null, why } when there is nothing to pick from', () => {
    const r = pickNext([], NOW);
    expect(r.item).toBeNull();
    expect(Array.isArray(r.why)).toBe(true);
  });

  it('never picks a bid that is over the spend limit', () => {
    expect(pickNext([item({ overLimit: true }), item({ overLimit: true, score: 100 })], NOW).item).toBeNull();
  });
});

describe('geo, auth and realtime seams', () => {
  it('ZIP and city lookups answer null for places that do not exist; statesWithin answers a list', () => {
    expect(lookupZip('00000')).toBeNull();
    expect(lookupZip('not-a-zip')).toBeNull();
    expect(lookupCity('TEST Nowhereville', 'ZZ')).toBeNull();
    expect(Array.isArray(statesWithin({ lat: 38.9413, lng: -119.7499 }, 90))).toBe(true);
  });

  it('nobody is signed in on a request with no session', async () => {
    const auth = createAuth(db, accountsConfig());
    const app = Fastify();
    app.get('/who', async (req) => ({ account: await auth.authenticate(req) }));
    expect((await app.inject('/who')).json()).toEqual({ account: null });
    await app.close();
  });

  it('startRealtime returns a stop function', () => {
    const config = accountsConfig();
    const stop = startRealtime(createContext({ db, config, bus: createBus(), auth: createAuth(db, config) }));
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });
});
