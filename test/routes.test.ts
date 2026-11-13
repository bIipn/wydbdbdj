import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { saveProfileForAccount, upsertMatch } from '../src/db/repo.js';
import { profileIdFor } from '../src/profile/build.js';
import { loadProfile } from '../src/profiles.js';
import { createBus } from '../src/realtime/bus.js';
import { runScan, scoreProfile } from '../src/scan.js';
import { scoreBid } from '../src/score/score.js';
import { buildApp, buildServer } from '../src/server.js';
import type { Account, FeedItem } from '../src/types.js';
import { accountsConfig, fakeAuth, memoryDb, NOW, questSource, scanCtx, seedAccount, testProfile } from './helpers.js';

const profile = loadProfile('lm-electric');
const now = () => NOW;

/** The v1 contract's route table (section 4). */
const ROUTES: Array<[method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string]> = [
  ['GET', '/api/auth/config'], ['POST', '/api/auth/signup'], ['POST', '/api/auth/login'], ['POST', '/api/auth/oauth'], ['POST', '/api/auth/logout'],
  ['GET', '/api/health'], ['GET', '/api/me'], ['GET', '/api/trades'], ['GET', '/api/geo/zip/:zip'], ['PUT', '/api/profile'],
  ['GET', '/api/feed'], ['GET', '/api/saved'], ['GET', '/api/bids/:id'], ['POST', '/api/swipe'], ['DELETE', '/api/swipe/:id'], ['GET', '/api/next'],
  ['GET', '/api/market/area'], ['GET', '/api/market/awards'], ['POST', '/api/estimate'], ['GET', '/api/estimates'],
  ['GET', '/api/stream'], ['GET', '/api/push/key'], ['POST', '/api/push/subscribe'], ['DELETE', '/api/push/subscribe'],
  ['GET', '/api/alerts'], ['POST', '/api/alerts/read'],
  ['POST', '/api/admin/scan'], ['POST', '/api/admin/plan'], ['POST', '/api/admin/market/refresh'],
];
const ADMIN_ROUTES = ROUTES.filter(([, url]) => url.startsWith('/api/admin/'));

let db: Db;
const apps: FastifyInstance[] = [];
const track = (app: FastifyInstance) => (apps.push(app), app);

beforeAll(async () => {
  db = await memoryDb();
  await runScan({ db, sources: [questSource()], profiles: [profile], ctx: scanCtx() });
});
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await db.close();
});

describe('single mode (the pilot) through the route plugins', () => {
  let app: FastifyInstance;
  let locked: FastifyInstance;
  beforeAll(async () => {
    app = track(await buildServer({ db, profile }, { now }));
    locked = track(await buildServer({ db, profile }, { accessCode: 'TEST-volts', adminToken: 'TEST-admin', now }));
  });

  it('registers every route in the contract', () => {
    for (const [method, url] of ROUTES) expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
  });

  it('GET /api/me answers exactly what v0 answered', async () => {
    expect((await app.inject('/api/me')).json()).toEqual({
      id: 'lm-electric', name: 'L&M Electric', base: 'Gardnerville, NV', maxDistanceMi: 90,
      valueRange: { min: 10000, max: 50000 }, notifyMinScore: 55,
    });
  });

  it('GET /api/health keeps its shape', async () => {
    const body = (await app.inject('/api/health')).json();
    expect(Object.keys(body).sort()).toEqual(['db', 'lastScan', 'ok', 'profile']);
    expect(body).toMatchObject({ ok: true, db: 'pglite', profile: 'lm-electric' });
    expect(Date.parse(body.lastScan)).not.toBeNaN();
  });

  it('feed items carry overLimit and solNumber', async () => {
    const items = (await app.inject('/api/feed?all=1&minScore=0&limit=300')).json().items as FeedItem[];
    expect(items).toHaveLength(13);
    expect(items.every((b) => b.overLimit === false && 'solNumber' in b)).toBe(true);
  });

  it('GET /api/next answers { item, why } and never an over-limit bid', async () => {
    const body = (await app.inject('/api/next')).json() as { item: FeedItem | null; why: string[] };
    expect(Object.keys(body).sort()).toEqual(['item', 'why']);
    expect(Array.isArray(body.why)).toBe(true);
    expect(body.item?.overLimit ?? false).toBe(false);
  });

  it('the swipe deck hides over-limit bids; Browse (all=1) keeps them, tagged', async () => {
    const p = testProfile('test-routes-limits');
    const limited = track(await buildServer({ db, profile: p }, { now }));
    await runScan({ db, sources: [questSource()], profiles: [p], ctx: scanCtx() });
    const ids = async (url: string) => ((await limited.inject(url)).json().items as FeedItem[]).map((b) => b.id);
    const deck = await ids('/api/feed?minScore=0');
    const over = (await limited.inject(`/api/bids/${encodeURIComponent(deck[0]!)}`)).json() as FeedItem;
    await upsertMatch(db, p.id, over.id, { ...scoreBid(over, p, NOW), overLimit: true });

    expect(await ids('/api/feed?minScore=0')).toEqual(deck.filter((id) => id !== over.id));
    const browse = (await limited.inject('/api/feed?all=1&minScore=0')).json().items as FeedItem[];
    expect(browse.find((b) => b.id === over.id)).toMatchObject({ overLimit: true });
    expect(browse).toHaveLength(deck.length);
  });

  it('GET /api/trades lists the catalog with NAICS codes', async () => {
    const { trades } = (await app.inject('/api/trades')).json() as { trades: Array<{ id: string; label: string; blurb: string; naics: string[] }> };
    const electrical = trades.find((t) => t.id === 'electrical')!;
    expect(electrical.label).toBeTruthy();
    expect(electrical.blurb).toBeTruthy();
    expect(electrical.naics).toContain('238210');
  });

  it('GET /api/geo/zip/:zip answers 404 zip_not_found for a ZIP that does not exist', async () => {
    const res = await app.inject('/api/geo/zip/00000');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'zip_not_found' });
  });

  it('a route whose module is not built yet answers 501 { error: "not_implemented" }', async () => {
    // Stays true as modules land: a built route simply stops answering 501.
    // /api/stream is left out (once built it never ends); admin routes are covered below.
    const skip = new Set(['/api/stream', ...ADMIN_ROUTES.map(([, url]) => url)]);
    for (const [method, url] of ROUTES.filter(([, u]) => !skip.has(u))) {
      const res = await app.inject({ method, url: url.replace(':zip', '00000').replace(':id', 'samgov:TEST-missing') });
      if (res.statusCode === 501) expect(res.json(), `${method} ${url}`).toEqual({ error: 'not_implemented' });
    }
  });

  it('every admin route needs the admin token, with or without the access code', async () => {
    for (const [method, url] of ADMIN_ROUTES) {
      for (const headers of [{}, { 'x-access-code': 'TEST-volts' }, { 'x-admin-token': 'wrong' }]) {
        const res = await locked.inject({ method, url, headers });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
        expect(res.json()).toEqual({ error: 'admin_token_required' });
      }
      // No admin token configured at all → nobody gets in.
      expect((await app.inject({ method, url, headers: { 'x-admin-token': '' } })).statusCode, url).toBe(401);
    }
  });

  it('the admin scan runs with the token and says so when no scan is wired', async () => {
    const res = await locked.inject({ method: 'POST', url: '/api/admin/scan', headers: { 'x-admin-token': 'TEST-admin' } });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: 'scan not configured' });
  });

  it('the access code gates the new API routes too, but not health or the app shell', async () => {
    for (const url of ['/api/me', '/api/next', '/api/trades', '/api/auth/config', '/api/alerts', '/api/market/area', '/api/estimates']) {
      const res = await locked.inject(url);
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toEqual({ error: 'access_code_required' });
    }
    expect((await locked.inject({ url: '/api/me', headers: { 'x-access-code': 'TEST-volts' } })).statusCode).toBe(200);
    expect((await locked.inject('/api/health')).statusCode).toBe(200);
    expect((await locked.inject('/')).statusCode).toBe(200);
  });

  it('needs a profile to start', async () => {
    await expect(buildServer({ db })).rejects.toThrow(/needs a profile/);
  });
});

describe('accounts mode', () => {
  let app: FastifyInstance;
  let who: Account | null = null;
  const config = accountsConfig();
  const bus = createBus();

  beforeAll(async () => {
    // No config profile at all: profiles come from the database.
    const built = await buildApp({ db }, { config, bus, auth: fakeAuth(() => who), now });
    app = track(built.app);
    expect(built.ctx.bus).toBe(bus);
    expect(built.ctx.config.authMode).toBe('accounts');
  });

  it('signed out: profile routes answer 401 sign_in_required', async () => {
    who = null;
    for (const url of ['/api/me', '/api/feed', '/api/saved', '/api/next', '/api/bids/x']) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(401);
      expect(res.json(), url).toEqual({ error: 'sign_in_required' });
    }
    const swipe = await app.inject({ method: 'POST', url: '/api/swipe', payload: { bidId: 'x', action: 'save' } });
    expect(swipe.statusCode).toBe(401);
  });

  it('health does not name a profile', async () => {
    expect((await app.inject('/api/health')).json()).toMatchObject({ ok: true, db: 'pglite', profile: null });
  });

  it('signed in, not onboarded: /api/me says so and the feed answers 409 onboarding_required', async () => {
    who = await seedAccount(db);
    const me = (await app.inject('/api/me')).json();
    expect(me).toEqual({
      account: who, profile: null, needsOnboarding: true,
      features: { instantPush: false, awardHistory: false, costSettings: false, awardWatch: false, priceAlerts: false, estimator: true },
    });
    for (const url of ['/api/feed', '/api/saved', '/api/next']) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(409);
      expect(res.json(), url).toEqual({ error: 'onboarding_required' });
    }
  });

  it('onboarded: /api/me carries the summary plus the legacy fields, and the feed is that account\'s own', async () => {
    const alice = await seedAccount(db, { plan: 'pro' });
    const bob = await seedAccount(db);
    const aliceProfile = await saveProfileForAccount(db, alice.id, testProfile(profileIdFor(alice.id), { trades: ['electrical'], zip: '89410' }));
    const bobProfile = await saveProfileForAccount(db, bob.id, testProfile(profileIdFor(bob.id)));
    expect(await scoreProfile(db, aliceProfile, NOW, bus)).toBe(13);
    expect(await scoreProfile(db, bobProfile, NOW, bus)).toBe(13);

    who = alice;
    const me = (await app.inject('/api/me')).json();
    expect(me).toMatchObject({
      account: { id: alice.id, email: alice.email, plan: 'pro' },
      needsOnboarding: false,
      features: { instantPush: true, awardHistory: true, costSettings: true, awardWatch: true, priceAlerts: true },
      profile: {
        id: aliceProfile.id, businessName: aliceProfile.name, trades: ['electrical'], zip: '89410', base: 'Gardnerville, NV',
        radiusMi: 90, valueRange: { min: 10000, max: 50000 }, limits: {}, costs: {}, alerts: { minScore: 55 }, setAsides: ['SBA', 'SBP'],
      },
      // legacy top-level fields the v0 client reads
      id: aliceProfile.id, name: aliceProfile.name, base: 'Gardnerville, NV', maxDistanceMi: 90, notifyMinScore: 55,
    });

    const feed = (await app.inject('/api/feed?minScore=0')).json().items as FeedItem[];
    expect(feed).toHaveLength(13);
    const saved = await app.inject({ method: 'POST', url: '/api/swipe', payload: { bidId: feed[0]!.id, action: 'save' } });
    expect(saved.json()).toEqual({ ok: true });
    expect(((await app.inject('/api/saved')).json().items as FeedItem[]).map((b) => b.id)).toEqual([feed[0]!.id]);

    // Another account sees none of it.
    who = bob;
    expect((await app.inject('/api/saved')).json().items).toEqual([]);
    expect((await app.inject('/api/me')).json()).toMatchObject({ account: { id: bob.id, plan: 'free' }, id: bobProfile.id });
    expect(((await app.inject('/api/feed?minScore=0')).json().items as FeedItem[])).toHaveLength(13);
  });

  it('/api/me never echoes more of the account than its public fields', async () => {
    const real = await seedAccount(db);
    who = { ...real, passwordHash: 'TEST-not-for-clients', sessionToken: 'TEST-not-for-clients' } as Account;
    const res = await app.inject('/api/me');
    expect(res.json().account).toEqual(real);
    expect(res.body).not.toContain('TEST-not-for-clients');
  });

  it('demo mode gives every account the pilot features', async () => {
    const demo = track(await buildServer({ db }, { config: accountsConfig({ demoMode: true }), auth: fakeAuth(() => who), now }));
    who = await seedAccount(db);
    expect((await demo.inject('/api/me')).json().features).toMatchObject({ instantPush: true, awardHistory: true, priceAlerts: true });
  });

  it('the access code still gates the whole API', async () => {
    const gated = track(await buildServer({ db }, { config: accountsConfig({ accessCode: 'TEST-volts' }), auth: fakeAuth(() => who), now }));
    expect((await gated.inject('/api/me')).json()).toEqual({ error: 'access_code_required' });
    expect((await gated.inject({ url: '/api/me', headers: { 'x-access-code': 'TEST-volts' } })).statusCode).toBe(200);
  });
});
