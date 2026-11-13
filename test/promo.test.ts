/**
 * Promo codes (src/auth/promo.ts, POST /api/promo/redeem). Every code here is made up ("A&Btest",
 * "TEST-PROMO", …): the real code lives only in the host's PROMO_CODES and must never be in the repo.
 * Accounts are simulated (example.com, "TEST … (simulated)").
 */
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../src/auth/index.js';
import type { ScryptCost } from '../src/auth/password.js';
import { codeKey, findCode, normalizeCode, parsePromoCodes } from '../src/auth/promo.js';
import type { AppConfig } from '../src/context.js';
import type { Db } from '../src/db/db.js';
import { promoUses } from '../src/db/promo.js';
import { featuresFor } from '../src/plans.js';
import { buildApp } from '../src/server.js';
import { loadProfile } from '../src/profiles.js';
import { accountsConfig, memoryDb, NOW, resetDb } from './helpers.js';

const CHEAP: ScryptCost = { ln: 10, r: 8, p: 1 };
const PASSWORD = 'TEST-horse-battery-staple';
const MIN = 60 * 1000;

let db: Db;
let clock = NOW.getTime();
const now = () => new Date(clock);
const apps: FastifyInstance[] = [];
let seq = 0;

beforeAll(async () => { db = await memoryDb(); });
beforeEach(async () => {
  await resetDb(db);
  clock = NOW.getTime();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
afterAll(async () => { await db.close(); });

/** An accounts-mode server with these PROMO_CODES (read once at start-up), and its log lines. */
async function server(promo: string | undefined, over: Partial<AppConfig> = {}) {
  if (promo === undefined) vi.stubEnv('PROMO_CODES', '');
  else vi.stubEnv('PROMO_CODES', promo);
  const config = accountsConfig(over);
  const logs: string[] = [];
  const { app } = await buildApp({ db }, { config, now, auth: createAuth(db, config, { now, cost: CHEAP }) });
  apps.push(app);
  // ctx.log goes to app.log.info: catch what the routes log from here on (redeems).
  vi.spyOn(app.log, 'info').mockImplementation(((msg: unknown) => { logs.push(String(msg)); }) as typeof app.log.info);
  return { app, logs };
}

const cookieOf = (res: LightMyRequestResponse) => String(res.headers['set-cookie'] ?? '').split(';')[0]!;

async function signUp(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/signup', headers: { 'x-bidswipe': '1' },
    payload: { email: `test.promo${++seq}@example.com`, password: PASSWORD, name: 'TEST Promo Owner (simulated)' },
  });
  expect(res.statusCode).toBe(201);
  return cookieOf(res);
}

const redeem = (app: FastifyInstance, cookie: string, code: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/promo/redeem', headers: { 'x-bidswipe': '1', cookie, ...headers }, payload: { code } });
const planOf = async (app: FastifyInstance, cookie: string) => (await app.inject({ url: '/api/me', headers: { cookie } })).json().account.plan;

// --------------------------------------------------------------- parsing --

describe('PROMO_CODES parsing', () => {
  it('reads CODE:pro with optional maxUses and expiry, and keeps no plain code', () => {
    const codes = parsePromoCodes('A&Btest:pro, TEST-PROMO:pro:100:2027-01-01 ,TEST-LATE:PRO::2027-02-01T08:00:00Z,');
    expect(codes.map((c) => [c.plan, c.maxUses, c.expiresAt?.toISOString() ?? null])).toEqual([
      ['pro', null, null],
      ['pro', 100, '2027-01-01T00:00:00.000Z'],
      ['pro', null, '2027-02-01T08:00:00.000Z'],
    ]);
    expect(codes[0]!.keyHex).toBe(codeKey('a&btest').toString('hex'));
    expect(JSON.stringify(codes)).not.toMatch(/a&btest/i);
  });

  it('skips a bad entry with one log line that never shows the code, and never throws', () => {
    const logs: string[] = [];
    const codes = parsePromoCodes(
      ['TEST-SECRETA:pilot', 'TEST-SECRETB', ':pro', 'TEST-SECRETC:pro:0', 'TEST-SECRETD:pro:ten', 'TEST-SECRETE:pro:5:next tuesday',
        'TEST-SECRETF:pro:5:2027-01-01:x', 'A&Btest:pro', 'a&btest:pro', `${'X'.repeat(65)}:pro`].join(','),
      (m) => logs.push(m),
    );
    expect(codes).toHaveLength(1);
    expect(logs).toHaveLength(10);
    expect(logs[0]).toBe('PROMO_CODES: entry 1 skipped (plan must be "pro")');
    expect(logs[7]).toBe('PROMO_CODES: entry 8 has no use limit and no expiry'); // kept, but said
    expect(logs[8]).toMatch(/^PROMO_CODES: entry 9 skipped \(the same code is listed twice/);
    for (const line of logs) expect(line).not.toMatch(/SECRET|a&btest/i);
    expect(parsePromoCodes(undefined)).toEqual([]);
    expect(parsePromoCodes('  ')).toEqual([]);
  });

  it('says (by position, never the code) when a kept code has no use limit and no expiry', () => {
    const logs: string[] = [];
    parsePromoCodes('TEST-SECRETA:pro,TEST-SECRETB:pro:25,TEST-SECRETC:pro::2027-03-01,TEST-SECRETD:pro:25:2027-03-01', (m) => logs.push(m));
    expect(logs).toEqual(['PROMO_CODES: entry 1 has no use limit and no expiry']);
  });

  it('matches trimmed, NFKC-normalized and case-insensitive spellings, and nothing else', () => {
    const codes = parsePromoCodes('A&Btest:pro,TEST-PROMO:pro');
    for (const typed of ['A&Btest', 'a&btest', '  A&BTEST ', 'Ａ＆Ｂｔｅｓｔ' /* full-width, as a phone keyboard may type it */]) {
      expect(findCode(codes, typed), typed).toBe(codes[0]);
    }
    expect(normalizeCode(' Ａ＆Ｂtest ')).toBe('a&btest');
    for (const typed of ['A&B test', 'AB&test', 'A&Btest1', '', '   ', 'x'.repeat(65), 42, null, undefined, ['A&Btest']]) {
      expect(findCode(codes, typed), String(typed)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------- routes --

describe('POST /api/promo/redeem', () => {
  it('turns a free account into Pro: features flip and the cost check stops answering 402', async () => {
    const { app, logs } = await server('A&Btest:pro');
    const cookie = await signUp(app);
    const me0 = (await app.inject({ url: '/api/me', headers: { cookie } })).json();
    expect(me0.account.plan).toBe('free');
    expect(me0.features).toEqual(featuresFor('free'));

    // A profile, so the cost check route gets as far as its plan gate.
    const put = await app.inject({
      method: 'PUT', url: '/api/profile', headers: { 'x-bidswipe': '1', cookie },
      payload: { businessName: 'TEST Promo Electric (simulated)', trades: ['electrical'], zip: '89410', radiusMi: 90, valueRange: { min: 10_000, max: 50_000 } },
    });
    expect(put.statusCode).toBe(200);
    const estimate = () => app.inject({ method: 'POST', url: '/api/estimate', headers: { 'x-bidswipe': '1', cookie }, payload: {} });
    expect((await estimate()).statusCode).toBe(402);
    expect((await app.inject({ url: '/api/estimates', headers: { cookie } })).statusCode).toBe(402);

    const res = await redeem(app, cookie, ' a&BTEST ');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plan: 'pro', features: featuresFor('pro') });

    const me1 = (await app.inject({ url: '/api/me', headers: { cookie } })).json();
    expect(me1.account.plan).toBe('pro');
    expect(me1.features.estimator).toBe(true);
    expect((await estimate()).statusCode).not.toBe(402);
    expect((await app.inject({ url: '/api/estimates', headers: { cookie } })).statusCode).toBe(200);

    // Only the code's hash is stored, and the log names the account, not the code.
    const rows = await db.query<{ code_key: string; plan: string }>('select code_key, plan from promo_redemptions');
    expect(rows).toEqual([{ code_key: codeKey('A&Btest').toString('hex'), plan: 'pro' }]);
    expect(logs.some((l) => l.startsWith('promo: account '))).toBe(true);
    expect(logs.join('\n')).not.toMatch(/a&btest/i);
  });

  it('a wrong code gets one plain sentence and changes nothing', async () => {
    const { app } = await server('A&Btest:pro');
    const cookie = await signUp(app);
    for (const code of ['A&Btest2', '', 7]) {
      const res = await redeem(app, cookie, code);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_code', message: 'That code isn’t valid. Check the spelling and try again.' });
    }
    expect(await planOf(app, cookie)).toBe('free');
  });

  it('redeeming twice is harmless: 200 already, one use counted', async () => {
    const { app } = await server('TEST-PROMO:pro:1');
    const cookie = await signUp(app);
    expect((await redeem(app, cookie, 'TEST-PROMO')).json()).toEqual({ plan: 'pro', features: featuresFor('pro') });
    const again = await redeem(app, cookie, 'test-promo');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ plan: 'pro', features: featuresFor('pro'), already: true });
    expect(await promoUses(db, codeKey('TEST-PROMO').toString('hex'))).toBe(1);
  });

  it('maxUses counts different accounts; the next one gets the same answer as a wrong code', async () => {
    const { app } = await server('TEST-PROMO:pro:2');
    const [a, b, c] = [await signUp(app), await signUp(app), await signUp(app)];
    expect((await redeem(app, a, 'TEST-PROMO')).statusCode).toBe(200);
    expect((await redeem(app, a, 'TEST-PROMO')).statusCode).toBe(200); // same account again: not a second use
    expect((await redeem(app, b, 'TEST-PROMO')).statusCode).toBe(200);
    const third = await redeem(app, c, 'TEST-PROMO');
    expect(third.statusCode).toBe(400);
    expect(third.json().error).toBe('invalid_code');
    expect(await planOf(app, c)).toBe('free');
    expect(await promoUses(db, codeKey('TEST-PROMO').toString('hex'))).toBe(2);
  });

  it('an expired code is refused like a wrong one, from the expiry instant on', async () => {
    const { app } = await server('TEST-PROMO:pro::2026-11-12T00:00:00Z');
    const [a, b] = [await signUp(app), await signUp(app)];
    clock = Date.parse('2026-11-11T23:59:59Z');
    expect((await redeem(app, a, 'TEST-PROMO')).statusCode).toBe(200);
    clock = Date.parse('2026-11-12T00:00:00Z');
    const late = await redeem(app, b, 'TEST-PROMO');
    expect(late.statusCode).toBe(400);
    expect(late.json().error).toBe('invalid_code');
  });

  it('allows 5 tries per 10 minutes per account, then 429 with retry-after', async () => {
    const { app } = await server('A&Btest:pro');
    const cookie = await signUp(app);
    for (let i = 0; i < 5; i++) expect((await redeem(app, cookie, `TEST-WRONG-${i}`)).statusCode).toBe(400);
    const sixth = await redeem(app, cookie, 'A&Btest'); // even the right code waits
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error).toBe('too_many_attempts');
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
    clock += 10 * MIN;
    expect((await redeem(app, cookie, 'A&Btest')).statusCode).toBe(200);
  });

  it('also limits per address: a new account from the same address does not get 5 more', async () => {
    const { app } = await server('A&Btest:pro');
    const a = await signUp(app);
    for (let i = 0; i < 5; i++) await redeem(app, a, `TEST-WRONG-${i}`);
    const b = await signUp(app);
    expect((await redeem(app, b, 'A&Btest')).statusCode).toBe(429);
  });

  it('a plan that is already Pro or pilot is never stepped down and uses nothing', async () => {
    const { app } = await server('TEST-PROMO:pro:1');
    const cookie = await signUp(app);
    await db.query("update accounts set plan = 'pilot'");
    const res = await redeem(app, cookie, 'TEST-PROMO');
    expect(res.json()).toMatchObject({ plan: 'pilot', already: true });
    expect(await planOf(app, cookie)).toBe('pilot');
    expect(await promoUses(db, codeKey('TEST-PROMO').toString('hex'))).toBe(0);
  });

  it('needs a signed-in account and the CSRF header', async () => {
    const { app } = await server('A&Btest:pro');
    expect((await app.inject({ method: 'POST', url: '/api/promo/redeem', headers: { 'x-bidswipe': '1' }, payload: { code: 'A&Btest' } })).statusCode).toBe(401);
    const cookie = await signUp(app);
    const forged = await app.inject({ method: 'POST', url: '/api/promo/redeem', headers: { cookie }, payload: { code: 'A&Btest' } });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error).toBe('csrf');
    expect(await planOf(app, cookie)).toBe('free');
  });
});

// ------------------------------------------------- where the box may show --

describe('promo availability (App Store guideline 3.1.1)', () => {
  const config = (app: FastifyInstance, headers: Record<string, string> = {}) => app.inject({ url: '/api/auth/config', headers });

  it('web and Microsoft Store builds see promo: true; the iOS build sees no promo and its redeem gets 403', async () => {
    const { app } = await server('A&Btest:pro');
    expect((await config(app)).json().promo).toBe(true);
    expect((await config(app, { 'x-bidswipe-store': 'microsoft' })).json().promo).toBe(true);
    expect((await config(app, { 'x-bidswipe-store': 'ios' })).json()).not.toHaveProperty('promo');
    const cookie = await signUp(app);
    const ios = await redeem(app, cookie, 'A&Btest', { 'x-bidswipe-store': 'ios' });
    expect(ios.statusCode).toBe(403);
    expect(ios.json().error).toBe('not_available');
    expect(await planOf(app, cookie)).toBe('free');
  });

  it('is off with no codes configured, and in demo mode', async () => {
    const none = await server(undefined);
    expect((await config(none.app)).json()).not.toHaveProperty('promo');
    const cookie = await signUp(none.app);
    expect((await redeem(none.app, cookie, 'A&Btest')).statusCode).toBe(403);

    const demo = await server('A&Btest:pro', { demoMode: true });
    expect((await config(demo.app)).json()).not.toHaveProperty('promo');
  });

  it('single mode (the pilot) has no promo route: 404', async () => {
    vi.stubEnv('PROMO_CODES', 'A&Btest:pro');
    const { app } = await buildApp({ db, profile: loadProfile('lm-electric') }, { now });
    apps.push(app);
    const res = await app.inject({ method: 'POST', url: '/api/promo/redeem', headers: { 'x-bidswipe': '1' }, payload: { code: 'A&Btest' } });
    expect(res.statusCode).toBe(404);
  });
});
