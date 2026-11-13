import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext, loadConfig, type AppConfig, type RouteContext } from '../src/context.js';
import type { Db } from '../src/db/db.js';
import { saveProfileForAccount } from '../src/db/repo.js';
import { effectivePlan, featuresFor } from '../src/plans.js';
import { loadProfile } from '../src/profiles.js';
import { createBus } from '../src/realtime/bus.js';
import type { Account } from '../src/types.js';
import { accountsConfig, fakeAuth, memoryDb, seedAccount, testProfile } from './helpers.js';

describe('loadConfig', () => {
  it('defaults to today\'s behaviour: single mode, nothing optional configured', () => {
    expect(loadConfig({})).toEqual({
      authMode: 'single', demoMode: false, accessCode: undefined, adminToken: undefined,
      appUrl: 'http://localhost:8787', cookieSecure: false, supabase: undefined, vapid: undefined,
    });
  });

  it('reads accounts mode, demo mode, codes and the public URL', () => {
    const c = loadConfig({ AUTH_MODE: 'accounts', DEMO_MODE: '1', ACCESS_CODE: 'TEST-code', ADMIN_TOKEN: 'TEST-admin', APP_URL: 'https://bids.example.com/' });
    expect(c).toMatchObject({
      authMode: 'accounts', demoMode: true, accessCode: 'TEST-code', adminToken: 'TEST-admin',
      appUrl: 'https://bids.example.com', cookieSecure: true,
    });
    expect(loadConfig({ DEMO_MODE: 'true' }).demoMode).toBe(true);
    expect(loadConfig({ DEMO_MODE: '0' }).demoMode).toBe(false);
    expect(loadConfig({ PORT: '9000' }).appUrl).toBe('http://localhost:9000');
  });

  it('accepts an env() getter and treats blank values as unset', () => {
    const vars: Record<string, string> = { AUTH_MODE: '  ', ACCESS_CODE: '', APP_URL: ' https://bids.example.com ' };
    const c = loadConfig((name) => vars[name]);
    expect(c).toMatchObject({ authMode: 'single', accessCode: undefined, appUrl: 'https://bids.example.com' });
  });

  it('fails loudly on a mistyped AUTH_MODE instead of quietly running as single', () => {
    expect(() => loadConfig({ AUTH_MODE: 'account' })).toThrow(/AUTH_MODE must be "single" or "accounts"/);
  });

  it('turns Supabase and web push on only when fully configured', () => {
    expect(loadConfig({ SUPABASE_URL: 'https://test.example.com' }).supabase).toBeUndefined();
    expect(loadConfig({ SUPABASE_URL: 'https://test.example.com/', SUPABASE_ANON_KEY: 'TEST-anon' }).supabase)
      .toEqual({ url: 'https://test.example.com', anonKey: 'TEST-anon' });
    expect(loadConfig({ VAPID_PUBLIC_KEY: 'TEST-pub' }).vapid).toBeUndefined();
    expect(loadConfig({ VAPID_PUBLIC_KEY: 'TEST-pub', VAPID_PRIVATE_KEY: 'TEST-priv', VAPID_SUBJECT: 'mailto:ops@example.com' }).vapid)
      .toEqual({ publicKey: 'TEST-pub', privateKey: 'TEST-priv', subject: 'mailto:ops@example.com' });
    // No subject given: fall back to the contact email, then the app URL.
    expect(loadConfig({ VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b', CONTACT_EMAIL: 'ops@example.com' }).vapid?.subject).toBe('mailto:ops@example.com');
    expect(loadConfig({ VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b', APP_URL: 'https://bids.example.com' }).vapid?.subject).toBe('https://bids.example.com');
  });
});

describe('plans', () => {
  const account = (plan: Account['plan']): Account => ({ id: 'TEST-a', email: 'test@example.com', name: null, plan, createdAt: '2026-11-11T00:00:00.000Z' });
  const accounts = { authMode: 'accounts', demoMode: false } as const;

  it('single mode and demo mode count as pilot; otherwise the account decides', () => {
    expect(effectivePlan({ authMode: 'single', demoMode: false }, null)).toBe('pilot');
    expect(effectivePlan({ authMode: 'accounts', demoMode: true }, account('free'))).toBe('pilot');
    expect(effectivePlan(accounts, account('free'))).toBe('free');
    expect(effectivePlan(accounts, account('pro'))).toBe('pro');
    expect(effectivePlan(accounts, account('pilot'))).toBe('pilot');
    expect(effectivePlan(accounts, null)).toBe('free');
  });

  it('free gets only the basic estimator; pro and pilot get everything', () => {
    expect(featuresFor('free')).toEqual({
      instantPush: false, awardHistory: false, costSettings: false, awardWatch: false, priceAlerts: false, estimator: true,
    });
    for (const plan of ['pro', 'pilot'] as const) {
      expect(Object.values(featuresFor(plan)).every((on) => on === true), plan).toBe(true);
    }
    featuresFor('free').instantPush = true; // callers get a copy
    expect(featuresFor('free').instantPush).toBe(false);
  });
});

describe('request context', () => {
  let db: Db;
  let who: Account | null = null;
  let authCalls = 0;
  const auth = { authenticate: async () => (authCalls++, who) };
  const apps: FastifyInstance[] = [];

  /** A one-route app that reports what requireProfile() resolved. */
  async function probe(ctx: RouteContext): Promise<FastifyInstance> {
    const app = Fastify();
    app.get('/who', async (req, reply) => {
      const id = await ctx.requireProfile(req, reply);
      if (!id) return reply;
      return { account: id.account?.id ?? null, profile: id.profile.id, plan: id.plan };
    });
    app.get('/identify', async (req) => {
      const id = await ctx.identify(req);
      return { account: id.account?.id ?? null, profile: id.profile?.id ?? null, plan: id.plan };
    });
    apps.push(app);
    return app;
  }
  const ctxFor = (config: AppConfig, profile = loadProfile('lm-electric')) => createContext({ db, config, bus: createBus(), auth, profile });

  beforeAll(async () => {
    db = await memoryDb();
  });
  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    await db.close();
  });

  it('single mode: everyone is the config profile on the pilot plan, and auth is never consulted', async () => {
    const app = await probe(ctxFor(loadConfig({})));
    authCalls = 0;
    expect((await app.inject('/identify')).json()).toEqual({ account: null, profile: 'lm-electric', plan: 'pilot' });
    const res = await app.inject('/who');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ account: null, profile: 'lm-electric', plan: 'pilot' });
    expect(authCalls).toBe(0);
  });

  it('single mode without a profile is a startup error', () => {
    expect(() => createContext({ db, config: loadConfig({}), bus: createBus(), auth })).toThrow(/needs a profile/);
  });

  it('accounts mode, signed out: identify is empty and requireProfile answers 401 sign_in_required', async () => {
    who = null;
    const app = await probe(ctxFor(accountsConfig()));
    expect((await app.inject('/identify')).json()).toEqual({ account: null, profile: null, plan: 'free' });
    const res = await app.inject('/who');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'sign_in_required' });
  });

  it('accounts mode, signed in but not onboarded: 409 onboarding_required', async () => {
    who = await seedAccount(db);
    const app = await probe(ctxFor(accountsConfig()));
    expect((await app.inject('/identify')).json()).toEqual({ account: who.id, profile: null, plan: 'free' });
    const res = await app.inject('/who');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'onboarding_required' });
  });

  it('accounts mode, onboarded: the account\'s own stored profile and plan — never the config profile', async () => {
    who = await seedAccount(db, { plan: 'pro' });
    await saveProfileForAccount(db, who.id, testProfile('test-ctx-pro'));
    const app = await probe(ctxFor(accountsConfig()));
    expect((await app.inject('/who')).json()).toEqual({ account: who.id, profile: 'test-ctx-pro', plan: 'pro' });

    const other = await seedAccount(db);
    await saveProfileForAccount(db, other.id, testProfile('test-ctx-free'));
    who = other;
    expect((await app.inject('/who')).json()).toEqual({ account: other.id, profile: 'test-ctx-free', plan: 'free' });
  });

  it('demo mode treats every account as pilot', async () => {
    who = await seedAccount(db);
    await saveProfileForAccount(db, who.id, testProfile('test-ctx-demo'));
    const app = await probe(ctxFor(accountsConfig({ demoMode: true })));
    expect((await app.inject('/who')).json()).toEqual({ account: who.id, profile: 'test-ctx-demo', plan: 'pilot' });
  });

  it('fills in the clock and a silent log when none are given', () => {
    const ctx = ctxFor(loadConfig({}));
    expect(ctx.now()).toBeInstanceOf(Date);
    expect(() => ctx.log('TEST')).not.toThrow();
    expect(ctx.scan).toBeUndefined();
    expect(fakeAuth(null)).toHaveProperty('authenticate');
  });
});
