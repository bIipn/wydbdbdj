/**
 * Input and error hardening from the security audit (2026-11-16): the error handler (sec-input-3), NUL bytes refused
 * before SQL (sec-input-3), the per-account limit on profile saves (sec-input-4) and the single-mode ACCESS_CODE
 * (sec-session-3). Everything here is synthetic (TEST- ids, example.com).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../src/auth/index.js';
import { loadConfig } from '../src/context.js';
import type { Db } from '../src/db/db.js';
import { loadProfile } from '../src/profiles.js';
import { PROFILE_SAVE_LIMIT } from '../src/routes/profile.js';
import { ACCESS_CODE_LIMIT, accessCodeWarning, buildApp } from '../src/server.js';
import type { Account } from '../src/types.js';
import { accountsConfig, fakeAuth, memoryDb, NOW, resetDb, seedAccount } from './helpers.js';

const CSRF = { 'x-bidswipe': '1' };
let db: Db;
let clock = NOW.getTime();
const now = () => new Date(clock);
const apps: FastifyInstance[] = [];
beforeAll(async () => { db = await memoryDb(); });
beforeEach(async () => {
  await resetDb(db);
  clock = NOW.getTime();
});
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await db.close();
});
const track = (app: FastifyInstance) => (apps.push(app), app);

describe('errors never carry a database message', () => {
  it('a 5xx answers { error: "internal" } and nothing else; Fastify\'s own 4xx keep their status and code', async () => {
    const { app } = await buildApp({ db }, { config: accountsConfig(), now });
    track(app);
    app.get('/api/TEST-boom', async () => { throw Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021' }); });
    const boom = await app.inject('/api/TEST-boom');
    expect([boom.statusCode, boom.json()]).toEqual([500, { error: 'internal' }]);

    const badJson = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'content-type': 'application/json' }, payload: '{"email":' });
    expect(badJson.statusCode).toBe(400);
    // The shape Fastify always gave (review rs-5): statusCode, code, the reason phrase, the message.
    expect(Object.keys(badJson.json()).sort()).toEqual(['code', 'error', 'message', 'statusCode']);
    expect(badJson.json()).toMatchObject({ statusCode: 400, code: 'FST_ERR_CTP_INVALID_JSON_BODY', error: 'Bad Request' });
    const wrongType = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'content-type': 'text/x-TEST' }, payload: 'x' });
    expect(wrongType.statusCode).toBe(415);
    expect(wrongType.json()).toMatchObject({ statusCode: 415, error: 'Unsupported Media Type' });
    const big = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'content-type': 'application/json' }, payload: JSON.stringify({ x: 'a'.repeat(1_100_000) }) });
    expect(big.statusCode).toBe(413);
  });
});

describe('a NUL byte is refused before any query (it used to answer 500 with the Postgres error)', () => {
  let app: FastifyInstance;
  let me: Account;
  beforeEach(async () => {
    me = await seedAccount(db);
    app = track((await buildApp({ db }, { config: accountsConfig(), auth: fakeAuth(() => me), now })).app);
  });

  it.each([
    ['GET', '/api/jobs/%00', undefined],
    ['POST', '/api/jobs/%00/messages', { text: 'TEST' }],
    ['GET', '/api/jobs/%00/conversation', undefined],
    ['GET', '/api/people/%00', undefined],
    ['GET', '/api/bids/%00', undefined],
    ['POST', '/api/swipe', { bidId: '\u0000', action: 'save' }],
    ['DELETE', '/api/swipe/%00', undefined],
  ] as const)('%s %s → 400', async (method, url, payload) => {
    const res = await app.inject({ method, url, headers: CSRF, ...(payload ? { payload } : {}) });
    expect([res.statusCode, res.json()]).toEqual([400, { error: 'invalid_input', message: 'Text cannot contain a NUL character.' }]);
  });

  it('sign-in and sign-up with a NUL in the e-mail: a 4xx, and no password is hashed for it', async () => {
    const config = accountsConfig();
    const signIn = createAuth(db, config, { now, cost: { ln: 10, r: 8, p: 1 } });
    const spy = vi.spyOn(signIn, 'signUp');
    const open = track((await buildApp({ db }, { config, auth: signIn, now })).app);
    for (const url of ['/api/auth/login', '/api/auth/signup']) {
      const res = await open.inject({ method: 'POST', url, headers: CSRF, payload: { email: 'a\u0000@example.com', password: 'TEST-horse-battery' } });
      expect(res.statusCode, url).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
    // A display name with a NUL is refused as a bad name, not stored.
    const named = await open.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload: { email: 'test.nul@example.com', password: 'TEST-horse-battery', name: 'TEST\u0000' } });
    expect(named.statusCode).toBe(400);
  });
});

describe('profile saves are limited per account (each one re-scores every open bid)', () => {
  it(`${PROFILE_SAVE_LIMIT.limit} saves in 10 minutes, then 429 with a sentence; another account is not affected; the window ends`, async () => {
    let who: Account | null = null;
    const [a, b] = [await seedAccount(db), await seedAccount(db)];
    const app = track((await buildApp({ db }, { config: accountsConfig(), auth: fakeAuth(() => who), now })).app);
    const answers = { businessName: 'TEST Shop (simulated)', trades: ['electrical'], zip: '89410', radiusMi: 50, valueRange: { min: 0, max: 50_000 } };
    const save = (as: Account) => {
      who = as;
      return app.inject({ method: 'PUT', url: '/api/profile', headers: CSRF, payload: answers });
    };
    for (let i = 0; i < PROFILE_SAVE_LIMIT.limit; i++) expect((await save(a)).statusCode, `save ${i + 1}`).toBe(200);
    const refused = await save(a);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toEqual({ error: 'too_many_attempts', message: 'You’ve saved your settings a lot in the last few minutes. Wait a few minutes, then save again.' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect((await save(b)).statusCode).toBe(200);
    clock += PROFILE_SAVE_LIMIT.windowMs;
    expect((await save(a)).statusCode).toBe(200);
  });
});

describe('single mode ACCESS_CODE', () => {
  const pilot = () => loadProfile('lm-electric');
  const feed = (app: FastifyInstance, code: string | undefined, ip = '203.0.113.50') =>
    app.inject({ url: '/api/feed?limit=1', remoteAddress: ip, headers: code === undefined ? {} : { 'x-access-code': code } });

  it(`${ACCESS_CODE_LIMIT.limit} wrong codes per address, then 429 for ANY code from it (the right one too); other addresses unaffected`, async () => {
    const code = 'TEST-access-code-0123456789';
    const app = track((await buildApp({ db, profile: pilot() }, { config: loadConfig({}), accessCode: code, now })).app);
    expect((await feed(app, undefined)).statusCode).toBe(401); // no code at all is not a guess
    expect((await feed(app, code)).statusCode).toBe(200);
    for (let i = 0; i < ACCESS_CODE_LIMIT.limit; i++) expect((await feed(app, `TEST-wrong-${i}`)).statusCode).toBe(401);
    const blocked = await feed(app, code);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'too_many_attempts', message: 'Too many wrong access codes. Wait a few minutes, then try again.' });
    expect((await feed(app, code, '198.51.100.9')).statusCode).toBe(200);
    clock += ACCESS_CODE_LIMIT.windowMs;
    expect((await feed(app, code)).statusCode).toBe(200);
  });

  it('a burst of simultaneous wrong codes is held to the limit: a wrong code is counted before it is answered (review rs-4)', async () => {
    const code = 'TEST-access-code-0123456789';
    const app = track((await buildApp({ db, profile: pilot() }, { config: loadConfig({}), accessCode: code, now })).app);
    const burst = await Promise.all(Array.from({ length: 200 }, (_, i) => feed(app, `TEST-burst-${i}`)));
    expect(burst.filter((r) => r.statusCode === 401)).toHaveLength(ACCESS_CODE_LIMIT.limit);
    expect(burst.filter((r) => r.statusCode === 429)).toHaveLength(200 - ACCESS_CODE_LIMIT.limit);
    expect((await feed(app, code)).statusCode).toBe(429);
  });

  it('a code shorter than 16 characters starts anyway, with one warning line that names its length, never the code', async () => {
    expect(accessCodeWarning(undefined)).toBeNull();
    expect(accessCodeWarning('TEST-access-code-0123456789')).toBeNull();
    const line = accessCodeWarning('TEST-77')!;
    expect(line).toMatch(/^ACCESS_CODE is 7 characters: use 16 or more random characters/);
    expect(line).not.toContain('TEST-77');
    const app = track((await buildApp({ db, profile: pilot() }, { config: loadConfig({}), accessCode: 'TEST-77', now })).app);
    expect((await feed(app, 'TEST-77')).statusCode).toBe(200);
  });
});
