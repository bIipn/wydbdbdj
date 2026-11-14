/**
 * Accounts, sign-up, sign-in, sessions, CSRF and the Supabase (Google / Apple / Microsoft) path.
 * Everything here is synthetic: example.com addresses, TEST- ids, "(simulated)" names, and a key
 * pair generated in this file standing in for a Supabase project's signing key.
 */
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth, type AuthOptions, type SignInService } from '../src/auth/index.js';
import { cleanName, normalizeEmail } from '../src/auth/input.js';
import {
  DEFAULT_COST, hashPassword, isAcceptablePassword, needsRehash, verifyPassword, type ScryptCost,
} from '../src/auth/password.js';
import { createRateLimiter } from '../src/auth/ratelimit.js';
import { verifySupabaseToken } from '../src/auth/supabase.js';
import { createContext, type AppConfig } from '../src/context.js';
import type { Db } from '../src/db/db.js';
import { loadProfile } from '../src/profiles.js';
import { createBus } from '../src/realtime/bus.js';
import { register as authRoutes } from '../src/routes/auth.js';
import { buildApp, buildServer } from '../src/server.js';
import type { Account } from '../src/types.js';
import { accountsConfig, memoryDb, NOW, resetDb } from './helpers.js';

// The real scrypt, with a counter around it: how many hashes are being computed at this moment.
const scryptLoad = vi.hoisted(() => ({ running: 0, peak: 0 }));
vi.mock('node:crypto', async (original) => {
  const real = await original<typeof import('node:crypto')>();
  const scrypt = ((password, salt, keylen, options, callback) => {
    real.scrypt(password, salt, keylen, options, (err, key) => {
      scryptLoad.running--;
      callback(err, key);
    });
    scryptLoad.peak = Math.max(scryptLoad.peak, ++scryptLoad.running); // only once the real call was accepted
  }) as typeof real.scrypt;
  return { ...real, scrypt };
});

// Pass-through spies: the real functions run, and the tests can count how many hashes a request cost.
vi.mock('../src/auth/password.js', async (original) => {
  const real = await original<typeof import('../src/auth/password.js')>();
  return { ...real, hashPassword: vi.fn(real.hashPassword), verifyPassword: vi.fn(real.verifyPassword) };
});

/** ~3 ms a hash. The real cost (DEFAULT_COST) is exercised once, in "passwords". */
const CHEAP: ScryptCost = { ln: 10, r: 8, p: 1 };
const PASSWORD = 'TEST-horse-battery-staple';
const EMAIL = 'test.owner@example.com';
const DAY = 24 * 60 * 60 * 1000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

let db: Db;
let clock = NOW.getTime();
const now = () => new Date(clock);
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  db = await memoryDb();
});
beforeEach(async () => {
  await resetDb(db);
  clock = NOW.getTime();
  vi.clearAllMocks();
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
afterAll(async () => {
  await db.close();
});

/** An accounts-mode server on the shared database, with the test clock and the cheap hash cost. */
async function server(over: Partial<AppConfig> = {}, authOpts: AuthOptions = {}): Promise<{ app: FastifyInstance; auth: SignInService }> {
  const config = accountsConfig(over);
  const auth = createAuth(db, config, { now, cost: CHEAP, ...authOpts });
  const { app } = await buildApp({ db }, { config, now, auth });
  apps.push(app);
  return { app, auth };
}

type Headers = Record<string, string>;
/** A state-changing request the way the web client sends it: with `x-bidswipe: 1`. */
const send = (app: FastifyInstance, method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, headers: Headers = {}) =>
  app.inject({ method, url, headers: { 'x-bidswipe': '1', ...headers }, ...(payload ? { payload } : {}) });
const post = (app: FastifyInstance, url: string, payload?: object, headers: Headers = {}) => send(app, 'POST', url, payload, headers);

const setCookie = (res: LightMyRequestResponse): string => String(res.headers['set-cookie'] ?? '');
/** "bs_session=<token>" from a response, ready to send back as a Cookie header. */
const cookieOf = (res: LightMyRequestResponse): string => setCookie(res).split(';')[0]!;
const tokenOf = (res: LightMyRequestResponse): string => cookieOf(res).slice('bs_session='.length);

async function signUp(app: FastifyInstance, email = EMAIL, password = PASSWORD) {
  const res = await post(app, '/api/auth/signup', { email, password, name: 'TEST Owner (simulated)' });
  expect(res.statusCode).toBe(201);
  return { cookie: cookieOf(res), token: tokenOf(res), account: res.json().account as Account };
}
const me = (app: FastifyInstance, cookie: string) => app.inject({ url: '/api/me', headers: { cookie } });
const storedHash = async (email = EMAIL) =>
  (await db.query<{ password_hash: string | null }>('select password_hash from accounts where email = $1', [email]))[0]?.password_hash;
const count = async (table: 'accounts' | 'sessions' | 'identities') => Number((await db.query<{ n: string }>(`select count(*) as n from ${table}`))[0]!.n);

// ------------------------------------------------------------ passwords --

describe('passwords', () => {
  it('hashes at the OWASP scrypt minimum or above, with the cost and a fresh salt in the string', async () => {
    expect(DEFAULT_COST.ln).toBeGreaterThanOrEqual(17);
    expect(DEFAULT_COST.r).toBeGreaterThanOrEqual(8);
    expect(DEFAULT_COST.p).toBeGreaterThanOrEqual(1);

    const hash = await hashPassword(PASSWORD);
    const [, scheme, cost, salt, key] = hash.split('$');
    expect([scheme, cost]).toEqual(['scrypt', `ln=${DEFAULT_COST.ln},r=${DEFAULT_COST.r},p=${DEFAULT_COST.p}`]);
    expect(Buffer.from(salt!, 'base64')).toHaveLength(16);
    expect(Buffer.from(key!, 'base64')).toHaveLength(32);
    expect(hash).not.toContain(PASSWORD);

    expect(await verifyPassword(PASSWORD, hash)).toBe(true); // wrong passwords are tried below, at a cost that takes milliseconds
    expect(needsRehash(hash)).toBe(false);
  });

  it('salts every hash, and verifies with the cost stored in the hash, not the current one', async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD, CHEAP), hashPassword(PASSWORD, CHEAP)]);
    expect(a).not.toBe(b);
    expect(a.startsWith('$scrypt$ln=10,r=8,p=1$')).toBe(true);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD, b)).toBe(true);
    expect(await verifyPassword('TEST-something-else', a)).toBe(false);
    // An older, cheaper hash still verifies and is flagged for an upgrade.
    expect(needsRehash(a)).toBe(true);
    expect(needsRehash(a, CHEAP)).toBe(false);
    expect(needsRehash(a, { ln: 10, r: 8, p: 2 })).toBe(true);
  });

  it('a stored value that is not one of our hashes matches nothing and is never run', async () => {
    const good = await hashPassword(PASSWORD, CHEAP);
    const [, , , salt, key] = good.split('$');
    for (const bad of ['', 'plaintext', good.slice(1), good.replace('scrypt', 'bcrypt'), `$scrypt$ln=40,r=8,p=1$${salt}$${key}`, `$scrypt$ln=10,r=0,p=1$${salt}$${key}`]) {
      expect(await verifyPassword(PASSWORD, bad), bad.slice(0, 24)).toBe(false);
      expect(needsRehash(bad, CHEAP)).toBe(true);
    }
  });

  it('never computes more than two hashes at once, however many sign-ins arrive together', async () => {
    scryptLoad.peak = 0;
    const burst = Array.from({ length: 5 }, () => hashPassword(PASSWORD, CHEAP));
    await burst[0]; // its place has gone to a queued one, so latecomers still have to queue
    const late = Array.from({ length: 5 }, () => hashPassword(PASSWORD, CHEAP));
    expect(new Set(await Promise.all([...burst, ...late])).size).toBe(10);
    expect(scryptLoad.peak).toBe(2);
    expect(scryptLoad.running).toBe(0);
  });

  it('accepts 8 to 128 characters and has no composition rules', () => {
    expect(isAcceptablePassword('a'.repeat(7))).toBe(false);
    expect(isAcceptablePassword('a'.repeat(8))).toBe(true); // all one letter is allowed
    expect(isAcceptablePassword('12345678')).toBe(true);
    expect(isAcceptablePassword('eight ch')).toBe(true); // spaces count and are kept
    expect(isAcceptablePassword('a'.repeat(128))).toBe(true);
    expect(isAcceptablePassword('a'.repeat(129))).toBe(false);
    // Characters, not UTF-16 units: an emoji is one.
    expect(isAcceptablePassword('🔌'.repeat(8))).toBe(true);
    expect(isAcceptablePassword('🔌'.repeat(128))).toBe(true);
    expect(isAcceptablePassword('🔌'.repeat(129))).toBe(false);
    for (const notText of [undefined, null, 12345678, ['12345678'], { length: 9 }]) expect(isAcceptablePassword(notText)).toBe(false);
  });

  it('treats the same password typed two ways (composed or decomposed accents) as one', async () => {
    const hash = await hashPassword('TEST-café-pass', CHEAP);
    expect(await verifyPassword('TEST-café-pass', hash)).toBe(true);
  });
});

describe('sign-up form input', () => {
  it('lower-cases and trims emails, and rejects what is not one', () => {
    expect(normalizeEmail('  Test.Owner@Example.COM ')).toBe('test.owner@example.com');
    for (const bad of ['', 'test', 'test@', '@example.com', 'test@example', 'te st@example.com', 'a@b@example.com', 'test@example..com', `${'a'.repeat(250)}@example.com`, 42, null, undefined, { email: 'x' }]) {
      expect(normalizeEmail(bad), String(bad).slice(0, 20)).toBeNull();
    }
  });

  it('tidies a display name, allows none, refuses non-text and essays', () => {
    expect(cleanName('  TEST   Owner (simulated) ')).toBe('TEST Owner (simulated)');
    expect(cleanName(undefined)).toBeNull();
    expect(cleanName('   ')).toBeNull();
    expect(cleanName(42)).toBeUndefined();
    expect(cleanName('x'.repeat(81))).toBeUndefined();
  });
});

// ------------------------------------------------------ sign up / sign in --

describe('sign up, sign in, sign out', () => {
  it('runs the whole cycle: sign up, be recognised, sign out, sign in again', async () => {
    const { app } = await server();
    const res = await post(app, '/api/auth/signup', { email: '  Test.Owner@Example.com ', password: PASSWORD, name: ' TEST Owner (simulated) ' });
    expect(res.statusCode).toBe(201);
    const { account } = res.json() as { account: Account };
    expect(account).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), email: EMAIL, name: 'TEST Owner (simulated)', plan: 'free', createdAt: NOW.toISOString() });
    expect(Object.keys(res.json())).toEqual(['account']);

    const cookie = cookieOf(res);
    const mine = await me(app, cookie);
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ account, profile: null, needsOnboarding: true });

    const out = await post(app, '/api/auth/logout', undefined, { cookie });
    expect(out.json()).toEqual({ ok: true });
    expect(setCookie(out)).toBe('bs_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    expect(await count('sessions')).toBe(0);
    expect((await me(app, cookie)).statusCode).toBe(401); // the old cookie is dead, not just forgotten

    clock += 3 * DAY;
    const back = await post(app, '/api/auth/login', { email: 'TEST.OWNER@example.com', password: PASSWORD });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toEqual({ account });
    expect(tokenOf(back)).not.toBe(tokenOf(res));
    expect((await me(app, cookieOf(back))).json().account).toEqual(account);
    const [row] = await db.query<{ created_at: Date; last_login_at: Date }>('select created_at, last_login_at from accounts');
    expect(new Date(row!.created_at).getTime()).toBe(NOW.getTime());
    expect(new Date(row!.last_login_at).getTime()).toBe(NOW.getTime() + 3 * DAY);
  });

  it('sets the session cookie HttpOnly, SameSite=Lax, Path=/, 30 days — and Secure on https', async () => {
    const { app } = await server();
    const { token } = await signUp(app);
    const again = await post(app, '/api/auth/login', { email: EMAIL, password: PASSWORD });
    expect(setCookie(again)).toBe(`bs_session=${tokenOf(again)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes = 256 bits

    const https = (await server({ cookieSecure: true })).app;
    const secure = await post(https, '/api/auth/login', { email: EMAIL, password: PASSWORD });
    expect(setCookie(secure)).toBe(`bs_session=${tokenOf(secure)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`);
    expect(setCookie(await post(https, '/api/auth/logout'))).toBe('bs_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
  });

  it('stores only a SHA-256 of the session token and a scrypt hash of the password', async () => {
    const { app } = await server();
    const { token, account } = await signUp(app);
    const sessions = await db.query<{ token_hash: string; account_id: string; expires_at: Date }>('select * from sessions');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ token_hash: sha256(token), account_id: account.id });
    expect(new Date(sessions[0]!.expires_at).getTime()).toBe(NOW.getTime() + 30 * DAY);
    expect(JSON.stringify(sessions)).not.toContain(token);

    const hash = (await storedHash())!;
    expect(hash.startsWith('$scrypt$ln=10,r=8,p=1$')).toBe(true);
    expect(hash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
  });

  it('answers a wrong password and an unknown email identically, each after exactly one hash check', async () => {
    const { app } = await server();
    await signUp(app);
    await post(app, '/api/auth/login', { email: 'test.warmup@example.com', password: PASSWORD }); // makes the decoy hash
    vi.clearAllMocks();

    const wrong = await post(app, '/api/auth/login', { email: EMAIL, password: 'TEST-not-the-password' });
    expect(vi.mocked(verifyPassword)).toHaveBeenCalledTimes(1);
    const unknown = await post(app, '/api/auth/login', { email: 'test.nobody@example.com', password: PASSWORD });
    expect(vi.mocked(verifyPassword)).toHaveBeenCalledTimes(2);

    for (const res of [wrong, unknown]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_credentials', message: 'Email or password is incorrect.' });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(wrong.body).toBe(unknown.body);
    expect(await count('sessions')).toBe(1); // only the sign-up's
  });

  it('a hashing failure is one failed request, not a broken sign-in page', async () => {
    const { app } = await server();
    vi.mocked(hashPassword).mockRejectedValueOnce(new Error('TEST out of memory')); // the decoy hash fails to build
    const first = await post(app, '/api/auth/login', { email: 'test.nobody@example.com', password: PASSWORD });
    expect(first.statusCode).toBe(500);
    expect(first.body).not.toContain(PASSWORD);
    const next = await post(app, '/api/auth/login', { email: 'test.nobody@example.com', password: PASSWORD });
    expect(next.statusCode).toBe(401);
  });

  it('refuses a second sign-up for an email without touching the account, at the cost of one hash like any sign-up', async () => {
    const { app } = await server();
    const first = await signUp(app);
    expect(vi.mocked(hashPassword)).toHaveBeenCalledTimes(1);
    const before = await storedHash();

    const dup = await post(app, '/api/auth/signup', { email: ' TEST.owner@EXAMPLE.com', password: 'TEST-attacker-password', name: 'TEST Intruder (simulated)' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: 'signup_failed', message: 'Could not create that account. If you already have one, sign in instead.' });
    expect(dup.headers['set-cookie']).toBeUndefined();
    expect(vi.mocked(hashPassword)).toHaveBeenCalledTimes(2);

    expect(await count('accounts')).toBe(1);
    expect(await storedHash()).toBe(before);
    expect((await me(app, first.cookie)).json().account.name).toBe('TEST Owner (simulated)');
    expect((await post(app, '/api/auth/login', { email: EMAIL, password: 'TEST-attacker-password' })).statusCode).toBe(401);
    expect((await post(app, '/api/auth/login', { email: EMAIL, password: PASSWORD })).statusCode).toBe(200);
  });

  it('validates sign-up input before doing any work', async () => {
    const { app } = await server();
    const cases: Array<[object | undefined, string]> = [
      [undefined, 'invalid_email'],
      [{ email: 'not-an-email', password: PASSWORD }, 'invalid_email'],
      [{ email: EMAIL }, 'invalid_password'],
      [{ email: EMAIL, password: 'short' }, 'invalid_password'],
      [{ email: EMAIL, password: 'x'.repeat(129) }, 'invalid_password'],
      [{ email: EMAIL, password: 12345678 }, 'invalid_password'],
      [{ email: EMAIL, password: PASSWORD, name: 'n'.repeat(81) }, 'invalid_name'],
    ];
    for (const [payload, error] of cases) {
      const res = await post(app, '/api/auth/signup', payload, { 'x-forwarded-for': `198.51.100.${cases.length}` });
      expect(res.statusCode, error).toBe(400);
      expect(res.json().error).toBe(error);
    }
    expect(vi.mocked(hashPassword)).not.toHaveBeenCalled();
    expect(await count('accounts')).toBe(0);
  });

  it('turns malformed sign-in input away as invalid credentials, without a hash', async () => {
    const { app } = await server();
    await signUp(app);
    vi.clearAllMocks();
    for (const payload of [undefined, {}, { email: EMAIL }, { email: EMAIL, password: '' }, { email: EMAIL, password: 'x'.repeat(129) }, { email: 'nope', password: PASSWORD }, { email: [EMAIL], password: [PASSWORD] }]) {
      const res = await post(app, '/api/auth/login', payload);
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('invalid_credentials');
    }
    expect(vi.mocked(verifyPassword)).not.toHaveBeenCalled();
  });

  it('re-hashes a password at login when the cost has been raised since it was stored', async () => {
    const { app } = await server();
    await signUp(app);
    const stronger = (await server({}, { cost: { ln: 11, r: 8, p: 1 } })).app;
    expect((await post(stronger, '/api/auth/login', { email: EMAIL, password: 'TEST-not-the-password' })).statusCode).toBe(401);
    expect((await storedHash())!.startsWith('$scrypt$ln=10,')).toBe(true); // a failed login upgrades nothing

    expect((await post(stronger, '/api/auth/login', { email: EMAIL, password: PASSWORD })).statusCode).toBe(200);
    const upgraded = (await storedHash())!;
    expect(upgraded.startsWith('$scrypt$ln=11,r=8,p=1$')).toBe(true);
    expect(await verifyPassword(PASSWORD, upgraded)).toBe(true);
  });

  it('signing in again on the same browser replaces its session instead of piling them up', async () => {
    const { app } = await server();
    const first = await signUp(app);
    const second = await post(app, '/api/auth/login', { email: EMAIL, password: PASSWORD }, { cookie: first.cookie });
    expect(second.statusCode).toBe(200);
    expect(await count('sessions')).toBe(1);
    expect((await me(app, first.cookie)).statusCode).toBe(401);
    expect((await me(app, cookieOf(second))).statusCode).toBe(200);
  });

  it('GET /api/auth/config says how to sign in; the Supabase details appear only when configured', async () => {
    const { app } = await server();
    expect((await app.inject('/api/auth/config')).json()).toEqual({ mode: 'accounts', providers: ['password'], demo: false });

    const withOauth = (await server({ demoMode: true, supabase: { url: PROJECT, anonKey: 'TEST-anon-key' } })).app;
    expect((await withOauth.inject('/api/auth/config')).json()).toEqual({
      mode: 'accounts', providers: ['password', 'google', 'apple', 'azure'], demo: true, supabase: { url: PROJECT, anonKey: 'TEST-anon-key' },
    });
  });

  it('single mode has no sign-in API: all seven routes answer 404, and nothing asks for the CSRF header', async () => {
    const single = await buildServer({ db, profile: loadProfile('lm-electric') }, { now });
    apps.push(single);
    expect((await single.inject('/api/auth/config')).statusCode).toBe(404);
    for (const path of ['signup', 'login', 'oauth', 'logout', 'forgot', 'reset']) {
      const res = await single.inject({ method: 'POST', url: `/api/auth/${path}`, payload: { email: EMAIL, password: PASSWORD, accessToken: 'x' } });
      expect(res.statusCode, path).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    // A stray cookie and no x-bidswipe: the pilot's requests go through exactly as before.
    const swipe = await single.inject({ method: 'POST', url: '/api/swipe', headers: { cookie: 'bs_session=whatever' }, payload: { bidId: 'samgov:TEST-missing', action: 'save' } });
    expect(swipe.statusCode).not.toBe(403);
    expect(await count('accounts')).toBe(0);
  });
});

// -------------------------------------------------------------- sessions --

describe('sessions', () => {
  const expiry = async () => new Date((await db.query<{ expires_at: Date }>('select expires_at from sessions'))[0]!.expires_at).getTime();

  it('expire 30 days after their last use', async () => {
    const { app } = await server();
    const { cookie } = await signUp(app);
    clock += 30 * DAY - 1000;
    expect((await me(app, cookie)).statusCode).toBe(200); // one second to spare — and this use renews it
    clock += 30 * DAY - 1000;
    expect((await me(app, cookie)).statusCode).toBe(200);
    clock += 30 * DAY + 1000;
    const late = await me(app, cookie);
    expect(late.statusCode).toBe(401);
    expect(late.json()).toEqual({ error: 'sign_in_required' });
  });

  it('an unused session dies on day 30 exactly', async () => {
    const { app, auth } = await server();
    const { cookie } = await signUp(app);
    clock += 30 * DAY;
    expect((await me(app, cookie)).statusCode).toBe(401);
    expect(await auth.authenticate({ headers: { cookie } } as never)).toBeNull();
  });

  it('slide forward on use, at most once a day, and the cookie is renewed with them', async () => {
    const { app } = await server();
    const { cookie, token } = await signUp(app);
    const issued = await expiry();

    clock += DAY / 2; // same day: no write, no new cookie
    const sameDay = await me(app, cookie);
    expect(sameDay.statusCode).toBe(200);
    expect(sameDay.headers['set-cookie']).toBeUndefined();
    expect(await expiry()).toBe(issued);

    clock += 2 * DAY; // a later day: 30 more days from now, in the table and in the browser
    const later = await me(app, cookie);
    expect(await expiry()).toBe(clock + 30 * DAY);
    expect(setCookie(later)).toBe(`bs_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  });

  it('expired rows are swept out the next time anyone signs in', async () => {
    const { app } = await server();
    await signUp(app);
    await signUp(app, 'test.second@example.com');
    expect(await count('sessions')).toBe(2);
    clock += 31 * DAY;
    await post(app, '/api/auth/login', { email: EMAIL, password: PASSWORD });
    expect(await count('sessions')).toBe(1);
  });

  it('a cookie that is not a live session is simply signed out — never an error', async () => {
    const { app, auth } = await server();
    const { cookie, account } = await signUp(app);
    const strays = ['', 'bs_session=', 'bs_session=short', `bs_session=${'A'.repeat(43)}`, `bs_session=${'x'.repeat(5000)}`, 'bs_session', 'other=1; =; ;;', "bs_session=' or 1=1 --"];
    for (const stray of strays) {
      const res = await app.inject({ url: '/api/me', headers: { cookie: stray } });
      expect(res.statusCode, stray.slice(0, 30)).toBe(401);
    }
    // Ours is found among other cookies, and the account comes back with its public fields only.
    const found = await auth.authenticate({ headers: { cookie: `theme=dark; ${cookie}; other=1` } } as never);
    expect(found).toEqual(account);
    expect(Object.keys(found!).sort()).toEqual(['createdAt', 'email', 'id', 'name', 'plan']);
    expect(await auth.authenticate({ headers: {} } as never)).toBeNull();
  });

  it('deleting an account ends its sessions', async () => {
    const { app } = await server();
    const { cookie, account } = await signUp(app);
    await db.query('delete from accounts where id = $1', [account.id]);
    expect(await count('sessions')).toBe(0);
    expect((await me(app, cookie)).statusCode).toBe(401);
  });
});

// ------------------------------------------------------------ rate limit --

describe('rate limit', () => {
  const login = (app: FastifyInstance, email: string, password: string, ip?: string) =>
    post(app, '/api/auth/login', { email, password }, ip ? { 'x-forwarded-for': ip } : {});

  it('allows 10 attempts per caller in 15 minutes, then 429 until the window ends — right password or not', async () => {
    const { app } = await server();
    await signUp(app, EMAIL, PASSWORD); // attempt 1 from this address
    for (let i = 0; i < 9; i++) expect((await login(app, `test.guess${i}@example.com`, 'TEST-wrong-guess')).statusCode).toBe(401);
    vi.clearAllMocks();

    const blocked = await login(app, EMAIL, PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'too_many_attempts' });
    expect(blocked.headers['retry-after']).toBe('900');
    expect(blocked.headers['set-cookie']).toBeUndefined();
    expect((await post(app, '/api/auth/signup', { email: 'test.new@example.com', password: PASSWORD })).statusCode).toBe(429);
    expect(vi.mocked(verifyPassword)).not.toHaveBeenCalled(); // a blocked attempt costs us nothing
    expect(vi.mocked(hashPassword)).not.toHaveBeenCalled();

    // Somebody else, somewhere else, is not affected.
    expect((await login(app, 'test.other@example.com', PASSWORD, '198.51.100.7')).statusCode).toBe(401);

    clock += 15 * 60 * 1000 - 1000;
    expect((await login(app, EMAIL, PASSWORD)).statusCode).toBe(429);
    clock += 1000;
    expect((await login(app, EMAIL, PASSWORD)).statusCode).toBe(200);
  });

  it('also counts per email, so guesses spread over many addresses still run out', async () => {
    const { app } = await server();
    await signUp(app, EMAIL, PASSWORD);
    for (let i = 0; i < 9; i++) expect((await login(app, EMAIL, `TEST-guess-number-${i}`, `198.51.100.${i + 1}`)).statusCode).toBe(401);
    const eleventh = await login(app, ' Test.Owner@EXAMPLE.com', PASSWORD, '198.51.100.99');
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.json()).toEqual({ error: 'too_many_attempts' });
    // That caller's own allowance is intact for another email.
    expect((await login(app, 'test.other@example.com', PASSWORD, '198.51.100.99')).statusCode).toBe(401);
  });

  it('believes X-Forwarded-For only from a proxy on this machine', async () => {
    const { app } = await server();
    const direct = (i: number) => app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.9',
      headers: { 'x-bidswipe': '1', 'x-forwarded-for': `198.51.100.${i}` }, payload: { email: `test.spoof${i}@example.com`, password: PASSWORD },
    });
    for (let i = 0; i < 10; i++) expect((await direct(i)).statusCode).toBe(401);
    expect((await direct(10)).statusCode).toBe(429); // a made-up header did not buy a fresh allowance
    // Through the local proxy the last hop is the caller; earlier hops are whatever the caller claimed.
    const viaProxy = (i: number, hops: string) =>
      post(app, '/api/auth/login', { email: `test.proxied${i}@example.com`, password: PASSWORD }, { 'x-forwarded-for': hops });
    for (let i = 0; i < 10; i++) expect((await viaProxy(i, `10.0.0.${i}, 192.0.2.44`)).statusCode).toBe(401);
    expect((await viaProxy(10, '10.9.9.9, 192.0.2.44')).statusCode).toBe(429);
    expect((await viaProxy(11, '192.0.2.44, 192.0.2.45')).statusCode).toBe(401); // a different last hop is a different caller
  });

  it('the limiter forgets finished windows and never tracks more keys than it is told to', () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => new Date(t), maxKeys: 3 });
    expect(limiter.hit('a')).toEqual({ ok: true, retryAfterSec: 1 });
    expect(limiter.hit('a').ok).toBe(true);
    expect(limiter.hit('a').ok).toBe(false);
    t = 400;
    expect(limiter.hit('a')).toEqual({ ok: false, retryAfterSec: 1 });
    limiter.hit('b');
    limiter.hit('c');
    limiter.hit('d'); // full: the oldest key ("a") makes room
    expect(limiter.hit('a').ok).toBe(true);
    t = 2000; // every window is over
    for (const key of ['b', 'c', 'd']) expect(limiter.hit(key)).toEqual({ ok: true, retryAfterSec: 1 });
  });
});

// ------------------------------------------------------------------ CSRF --

describe('CSRF guard (accounts mode)', () => {
  it('sign-in routes need x-bidswipe: 1 even with no cookie', async () => {
    const { app } = await server();
    for (const path of ['signup', 'login', 'oauth', 'logout']) {
      for (const headers of [{}, { 'x-bidswipe': '0' }, { 'x-bidswipe': 'true' }] as Headers[]) {
        const res = await app.inject({ method: 'POST', url: `/api/auth/${path}`, headers, payload: { email: EMAIL, password: PASSWORD } });
        expect(res.statusCode, path).toBe(403);
        expect(res.json()).toEqual({ error: 'csrf' });
      }
    }
    expect(await count('accounts')).toBe(0);
    expect(vi.mocked(hashPassword)).not.toHaveBeenCalled();
  });

  it('a request riding on the session cookie is refused without the header, whatever the method', async () => {
    const { app } = await server();
    const { cookie } = await signUp(app);
    const requests: Array<['POST' | 'PUT' | 'DELETE', string]> = [
      ['POST', '/api/swipe'], ['PUT', '/api/profile'], ['DELETE', '/api/swipe/samgov:TEST-1'], ['POST', '/api/alerts/read'],
      ['DELETE', '/api/push/subscribe'], ['POST', '/api/estimate'], ['POST', '/api/auth/logout'], ['POST', '/%61pi/swipe'],
    ];
    for (const [method, url] of requests) {
      const forged = await app.inject({ method, url, headers: { cookie } });
      expect(forged.statusCode, `${method} ${url}`).toBe(403);
      expect(forged.json()).toEqual({ error: 'csrf' });
      const ours = await send(app, method, url, undefined, { cookie });
      expect(ours.json().error, `${method} ${url}`).not.toBe('csrf');
    }
    expect(await count('sessions')).toBe(0); // only our own logout got through
  });

  it('an Origin header must name this host or APP_URL', async () => {
    const { app } = await server({ appUrl: 'https://bids.example.com' });
    const { cookie } = await signUp(app);
    // The request arrives for Host 127.0.0.1:8787 (say, straight to the port); APP_URL is the public name.
    const swipe = (origin: string) =>
      post(app, '/api/swipe', { bidId: 'samgov:TEST-1', action: 'save' }, { cookie, origin, host: '127.0.0.1:8787' });
    for (const foreign of ['https://evil.example', 'https://bids.example.com.evil.example', 'http://127.0.0.1:9999', 'http://localhost:8787', 'null', 'bids.example.com', '']) {
      const res = await swipe(foreign);
      expect(res.statusCode, foreign).toBe(403);
      expect(res.json()).toEqual({ error: 'csrf' });
    }
    for (const own of ['https://bids.example.com', 'http://127.0.0.1:8787']) {
      expect((await swipe(own)).json().error, own).not.toBe('csrf');
    }
    const login = await post(app, '/api/auth/login', { email: EMAIL, password: PASSWORD }, { origin: 'https://evil.example' });
    expect(login.statusCode).toBe(403);
  });

  it('leaves reads, the admin API and cookie-less anonymous requests alone', async () => {
    const { app } = await server({ adminToken: 'TEST-admin' });
    const { cookie } = await signUp(app);
    expect((await app.inject({ url: '/api/me', headers: { cookie, origin: 'https://evil.example' } })).statusCode).toBe(200);
    // Admin: token-only, so no CSRF header — the token is still required.
    const admin = (headers: Headers) => app.inject({ method: 'POST', url: '/api/admin/plan', headers: { cookie, ...headers }, payload: { email: EMAIL, plan: 'pro' } });
    expect((await admin({})).json()).toEqual({ error: 'admin_token_required' });
    expect((await admin({ 'x-admin-token': 'TEST-admin' })).statusCode).toBe(200);
    // No cookie = nobody's session to abuse: the handler answers for itself.
    const anonymous = await app.inject({ method: 'POST', url: '/api/swipe', payload: { bidId: 'samgov:TEST-1', action: 'save' } });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual({ error: 'sign_in_required' });
  });
});

// ---------------------------------------------------------- admin: plans --

describe('POST /api/admin/plan', () => {
  it('grants a plan by email behind the admin token, and the account sees it at once', async () => {
    const { app } = await server({ adminToken: 'TEST-admin' });
    const { cookie, account } = await signUp(app);
    const grant = (payload: object | undefined, token = 'TEST-admin') =>
      app.inject({ method: 'POST', url: '/api/admin/plan', headers: { 'x-admin-token': token }, ...(payload ? { payload } : {}) });

    for (const token of ['', 'wrong', 'TEST-admi', 'TEST-admin2']) {
      const res = await grant({ email: EMAIL, plan: 'pro' }, token);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'admin_token_required' });
    }
    expect((await me(app, cookie)).json().features.instantPush).toBe(false);

    const pro = await grant({ email: '  Test.Owner@EXAMPLE.com', plan: 'pro' });
    expect(pro.statusCode).toBe(200);
    expect(pro.json()).toEqual({ account: { ...account, plan: 'pro' } });
    expect((await me(app, cookie)).json()).toMatchObject({ account: { plan: 'pro' }, features: { instantPush: true, awardHistory: true } });

    expect((await grant({ email: EMAIL, plan: 'pilot' })).json().account.plan).toBe('pilot');
    expect((await grant({ email: EMAIL, plan: 'free' })).json().account.plan).toBe('free');
    expect((await me(app, cookie)).json().features.instantPush).toBe(false);

    expect((await grant({ email: 'test.nobody@example.com', plan: 'pro' })).json()).toEqual({ error: 'account_not_found' });
    expect((await grant({ email: EMAIL, plan: 'enterprise' })).json().error).toBe('invalid_plan');
    expect((await grant({ email: EMAIL })).statusCode).toBe(400);
    expect((await grant({ plan: 'pro' })).json()).toEqual({ error: 'invalid_email' });
    expect((await grant(undefined)).statusCode).toBe(400);
  });

  it('never lets anyone in when no admin token is configured', async () => {
    const { app } = await server();
    const res = await app.inject({ method: 'POST', url: '/api/admin/plan', headers: { 'x-admin-token': '' }, payload: { email: EMAIL, plan: 'pro' } });
    expect(res.statusCode).toBe(401);
  });
});

// ------------------------------------------- Google / Apple / Microsoft --

/** Stands in for a Supabase project. Not a real one. */
const PROJECT = 'https://test-project.example.com';
const OAUTH_EMAIL = 'test.olivia@example.com';
const SUPABASE = { supabase: { url: PROJECT, anonKey: 'TEST-anon-key' } };

describe('sign in with a Supabase token', () => {
  let signingKey: CryptoKey;
  let strangerKey: CryptoKey;
  let keys: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256');
    signingKey = pair.privateKey;
    strangerKey = (await generateKeyPair('ES256')).privateKey;
    keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'TEST-key-1', alg: 'ES256', use: 'sig' }] });
  });

  interface TokenOptions {
    key?: CryptoKey | Uint8Array; alg?: string; issuer?: string; audience?: string; subject?: string;
    /** Seconds from now; null leaves the claim out. */
    expiresInSec?: number | null;
  }

  /** An access token shaped like Supabase's (JWT claims reference), for a Google sign-in unless overridden. */
  function accessToken(claims: Record<string, unknown> = {}, o: TokenOptions = {}): Promise<string> {
    const email = (claims.email as string | undefined) ?? OAUTH_EMAIL;
    const jwt = new SignJWT({
      email, phone: '', role: 'authenticated', aal: 'aal1', session_id: 'TEST-session', is_anonymous: false,
      sub: o.subject ?? 'TEST-supabase-user-1',
      app_metadata: { provider: 'google', providers: ['google'] },
      user_metadata: { email, email_verified: true, full_name: 'TEST Olivia (simulated)' },
      amr: [{ method: 'oauth', timestamp: Math.floor(clock / 1000) }],
      ...claims,
    })
      .setProtectedHeader({ alg: o.alg ?? 'ES256', kid: 'TEST-key-1', typ: 'JWT' })
      .setIssuer(o.issuer ?? `${PROJECT}/auth/v1`)
      .setAudience(o.audience ?? 'authenticated')
      .setIssuedAt(Math.floor(clock / 1000));
    if (o.expiresInSec !== null) jwt.setExpirationTime(Math.floor(clock / 1000) + (o.expiresInSec ?? 3600));
    return jwt.sign(o.key ?? signingKey);
  }

  const oauthServer = async () => (await server(SUPABASE, { supabaseKeys: keys })).app;
  const oauth = (app: FastifyInstance, token: unknown, headers: Headers = {}) => post(app, '/api/auth/oauth', { accessToken: token }, headers);
  const identities = () => db.query<{ provider: string; subject: string; account_id: string }>('select * from identities order by provider');

  it('a valid token for a new verified email opens an account, stores the identity and signs in', async () => {
    const app = await oauthServer();
    const res = await oauth(app, await accessToken());
    expect(res.statusCode).toBe(200);
    const { account } = res.json() as { account: Account };
    expect(account).toMatchObject({ email: OAUTH_EMAIL, name: 'TEST Olivia (simulated)', plan: 'free' });
    expect(setCookie(res)).toMatch(/^bs_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    expect((await me(app, cookieOf(res))).json().account).toEqual(account);
    expect(await identities()).toEqual([{ provider: 'google', subject: 'TEST-supabase-user-1', account_id: account.id }]);
    expect(await storedHash(OAUTH_EMAIL)).toBeNull(); // no password: the password form cannot open this account
    expect((await post(app, '/api/auth/login', { email: OAUTH_EMAIL, password: PASSWORD })).statusCode).toBe(401);
    vi.mocked(verifyPassword).mockResolvedValueOnce(true); // not even if the decoy check were somehow to pass
    expect((await post(app, '/api/auth/login', { email: OAUTH_EMAIL, password: PASSWORD })).statusCode).toBe(401);
    expect((await post(app, '/api/auth/signup', { email: OAUTH_EMAIL, password: PASSWORD })).statusCode).toBe(409);

    // Coming back: same account, found by the identity — even if the email in the token has changed since.
    clock += 2 * DAY;
    const again = await oauth(app, await accessToken({ email: 'TEST.Renamed@example.com', user_metadata: { email_verified: false } }));
    expect(again.statusCode).toBe(200);
    expect(again.json().account).toEqual(account);
    expect(await count('accounts')).toBe(1);
    expect(await identities()).toHaveLength(1);
    const [row] = await db.query<{ last_login_at: Date }>('select last_login_at from accounts');
    expect(new Date(row!.last_login_at).getTime()).toBe(NOW.getTime() + 2 * DAY);
  });

  it('refuses an expired token, a wrong audience, a wrong issuer, a stranger\'s signature and a shared-secret token', async () => {
    const app = await oauthServer();
    const bad: Array<[string, Promise<string> | string]> = [
      ['expired', accessToken({}, { expiresInSec: -1 })],
      ['audience', accessToken({}, { audience: 'anon' })],
      ['issuer', accessToken({}, { issuer: 'https://other-project.example.com/auth/v1' })],
      ['issuer without /auth/v1', accessToken({}, { issuer: PROJECT })],
      ['signed by another key', accessToken({}, { key: strangerKey })],
      ['never expires', accessToken({}, { expiresInSec: null })],
      ['no subject', accessToken({ sub: undefined })],
      ['empty subject', accessToken({ sub: '' })],
      // The classic downgrade: HS256 "signed" with something public (the anon key).
      ['HS256', accessToken({}, { alg: 'HS256', key: new TextEncoder().encode('TEST-anon-key'.padEnd(32, '.')) })],
      ['not a JWT', 'TEST-not-a-token'],
      ['empty', ''],
    ];
    for (const [i, [what, token]] of bad.entries()) {
      const res = await oauth(app, await token, { 'x-forwarded-for': `198.51.100.${100 + i}` });
      expect(res.statusCode, what).toBe(401);
      expect(res.json(), what).toEqual({ error: 'invalid_token', message: 'That sign-in did not go through. Try again.' });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    // A token is good until its last second, and dead from the next.
    const lastSecond = await accessToken({}, { expiresInSec: 60 });
    clock += 59_000;
    expect((await oauth(app, lastSecond, { 'x-forwarded-for': '198.51.100.21' })).statusCode).toBe(200);
    clock += 1000;
    expect((await oauth(app, lastSecond, { 'x-forwarded-for': '198.51.100.21' })).statusCode).toBe(401);
    for (const missing of [undefined, 42, { jwt: 'x' }, 'x'.repeat(9000)]) expect((await oauth(app, missing, { 'x-forwarded-for': '198.51.100.22' })).statusCode).toBe(401);
    expect(await count('accounts')).toBe(1);
  });

  it('counts token attempts against the caller like any other sign-in', async () => {
    const app = await oauthServer();
    const expired = await accessToken({}, { expiresInSec: -1 });
    for (let i = 0; i < 10; i++) expect((await oauth(app, expired)).statusCode).toBe(401);
    const blocked = await oauth(app, await accessToken());
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'too_many_attempts' });
    expect(await count('accounts')).toBe(0);
  });

  it('an unverified email gets nothing: no new account, and no way into an existing one', async () => {
    const app = await oauthServer();
    const owner = await signUp(app, OAUTH_EMAIL, PASSWORD);
    const unverified: Array<Record<string, unknown>> = [
      { user_metadata: { email_verified: false } },
      { user_metadata: {} },
      { user_metadata: { email_verified: 'true' } }, // only a real boolean counts
      { email_verified: false }, // a project-added top-level claim wins over user_metadata
      { is_anonymous: true },
      { email: '' },
    ];
    for (const [i, claims] of unverified.entries()) {
      for (const email of [OAUTH_EMAIL, 'test.newcomer@example.com']) {
        const res = await oauth(app, await accessToken({ email, ...claims }), { 'x-forwarded-for': `198.51.100.${30 + i}` });
        expect(res.statusCode, JSON.stringify(claims)).toBe(403);
        expect(res.json().error).toBe('email_not_verified');
        expect(res.headers['set-cookie']).toBeUndefined();
      }
    }
    // The existing account is exactly as it was.
    expect(await count('accounts')).toBe(1);
    expect(await identities()).toEqual([]);
    expect((await me(app, owner.cookie)).statusCode).toBe(200);
    expect((await post(app, '/api/auth/login', { email: OAUTH_EMAIL, password: PASSWORD })).statusCode).toBe(200);
  });

  it('a verified email links to the account that has it — and takes it over from the unproven password', async () => {
    const app = await oauthServer();
    // Someone opened a password account for this address first. Nobody ever proved they own it.
    const squatter = await signUp(app, OAUTH_EMAIL, 'TEST-squatter-password');
    await db.query(`insert into push_subscriptions (endpoint, account_id, keys) values ('https://push.example.com/TEST-1', $1, '{}')`, [squatter.account.id]);

    const res = await oauth(app, await accessToken({ email: 'Test.Olivia@Example.com' }), { 'x-forwarded-for': '198.51.100.40' });
    expect(res.statusCode).toBe(200);
    expect(res.json().account).toMatchObject({ id: squatter.account.id, email: OAUTH_EMAIL });
    expect(await count('accounts')).toBe(1);
    expect(await identities()).toEqual([{ provider: 'google', subject: 'TEST-supabase-user-1', account_id: squatter.account.id }]);

    // Whoever held the password is out: no password, no session, no push subscription.
    expect(await storedHash(OAUTH_EMAIL)).toBeNull();
    expect((await me(app, squatter.cookie)).statusCode).toBe(401);
    expect((await post(app, '/api/auth/login', { email: OAUTH_EMAIL, password: 'TEST-squatter-password' })).statusCode).toBe(401);
    expect(await db.query('select 1 from push_subscriptions')).toEqual([]);
    expect((await me(app, cookieOf(res))).statusCode).toBe(200);

    // A second provider identity with the same verified email joins the same account and signs nobody out.
    const second = await oauth(app, await accessToken({ app_metadata: { provider: 'azure' } }, { subject: 'TEST-supabase-user-2' }), { 'x-forwarded-for': '198.51.100.41' });
    expect(second.json().account.id).toBe(squatter.account.id);
    expect((await identities()).map((i) => i.provider)).toEqual(['azure', 'google']);
    expect((await me(app, cookieOf(res))).statusCode).toBe(200);
  });

  it('only takes tokens from the sign-in methods the app offers', async () => {
    const app = await oauthServer();
    for (const app_metadata of [{ provider: 'email' }, { provider: 'phone' }, { provider: 'github' }, { provider: 42 }, {}, undefined]) {
      const res = await oauth(app, await accessToken({ app_metadata }));
      expect(res.statusCode, JSON.stringify(app_metadata)).toBe(403);
      expect(res.json().error).toBe('provider_not_supported');
    }
    for (const provider of ['apple', 'azure']) {
      const res = await oauth(app, await accessToken({ email: `test.${provider}@example.com`, app_metadata: { provider } }, { subject: `TEST-${provider}` }));
      expect(res.statusCode, provider).toBe(200);
    }
    expect((await identities()).map((i) => i.provider)).toEqual(['apple', 'azure']);
  });

  it('answers 404 when Supabase is not configured and 503 when its keys cannot be fetched — never a guess', async () => {
    const off = (await server()).app;
    const res = await oauth(off, await accessToken());
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('oauth_not_configured');

    const down = (await server(SUPABASE, { supabaseKeys: async () => { throw new TypeError('fetch failed'); } })).app;
    const unavailable = await oauth(down, await accessToken());
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error).toBe('oauth_unavailable');
    expect(await count('accounts')).toBe(0);
  });

  it('logs why a token was refused — the reason code, never the token — and logs nothing about passwords', async () => {
    const config = accountsConfig(SUPABASE);
    const lines: string[] = [];
    const app = Fastify();
    apps.push(app);
    const auth = createAuth(db, config, { now, cost: CHEAP, supabaseKeys: keys });
    await authRoutes(app, createContext({ db, config, bus: createBus(), auth, now, log: (line) => lines.push(line) }));

    const expired = await accessToken({}, { expiresInSec: -1 });
    expect((await app.inject({ method: 'POST', url: '/api/auth/oauth', payload: { accessToken: expired } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/oauth', payload: { accessToken: await accessToken({}, { audience: 'anon' }) } })).statusCode).toBe(401);
    expect(lines).toEqual(['sign-in refused: invalid_token (ERR_JWT_EXPIRED)', 'sign-in refused: invalid_token (ERR_JWT_CLAIM_VALIDATION_FAILED)']);

    await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: EMAIL, password: PASSWORD } });
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: 'TEST-wrong-password' } });
    expect(lines).toHaveLength(2);
  });

  it('verifySupabaseToken reads the identity and reports refusals by jose error code only', async () => {
    const check = (token: string) => verifySupabaseToken(token, { projectUrl: PROJECT, keys, now: now() });
    expect(await check(await accessToken({ email: ' Test.Olivia@EXAMPLE.com ' }))).toEqual({
      ok: true,
      identity: { provider: 'google', subject: 'TEST-supabase-user-1', email: OAUTH_EMAIL, emailVerified: true, name: 'TEST Olivia (simulated)' },
    });
    expect(await check(await accessToken({ email_verified: true, user_metadata: {} }))).toMatchObject({ identity: { emailVerified: true, name: null } });
    expect(await check(await accessToken({}, { expiresInSec: -5 }))).toEqual({ ok: false, reason: 'invalid', code: 'ERR_JWT_EXPIRED' });
    expect(await check(await accessToken({}, { audience: 'anon' }))).toEqual({ ok: false, reason: 'invalid', code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
    expect(await check(await accessToken({}, { key: strangerKey }))).toEqual({ ok: false, reason: 'invalid', code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' });
    expect(await check(await accessToken({}, { alg: 'HS256', key: new Uint8Array(32) }))).toEqual({ ok: false, reason: 'invalid', code: 'ERR_JOSE_ALG_NOT_ALLOWED' });
  });
});

// ------------------------------------------------------ nothing leaks out --

describe('secrets stay inside', () => {
  it('no response body carries a password, a hash, a session token or an access token', async () => {
    const pair = await generateKeyPair('ES256');
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'TEST-key-2', alg: 'ES256' }] });
    const jwt = await new SignJWT({ email: OAUTH_EMAIL, is_anonymous: false, app_metadata: { provider: 'google' }, user_metadata: { email_verified: true } })
      .setProtectedHeader({ alg: 'ES256', kid: 'TEST-key-2' }).setIssuer(`${PROJECT}/auth/v1`).setAudience('authenticated')
      .setSubject('TEST-supabase-user-9').setExpirationTime(Math.floor(clock / 1000) + 600).sign(pair.privateKey);
    const { app } = await server({ ...SUPABASE, adminToken: 'TEST-admin' }, { supabaseKeys: keys });

    const bodies: string[] = [];
    const keep = async (res: Promise<LightMyRequestResponse>) => {
      const r = await res;
      bodies.push(r.body);
      return r;
    };
    const up = await keep(post(app, '/api/auth/signup', { email: EMAIL, password: PASSWORD, name: 'TEST Owner (simulated)' }));
    const cookie = cookieOf(up);
    await keep(post(app, '/api/auth/signup', { email: EMAIL, password: 'TEST-second-password' }));
    await keep(post(app, '/api/auth/login', { email: EMAIL, password: 'TEST-wrong-password' }));
    const inAgain = await keep(post(app, '/api/auth/login', { email: EMAIL, password: PASSWORD }));
    await keep(me(app, cookieOf(inAgain)));
    await keep(app.inject('/api/auth/config'));
    const viaOauth = await keep(post(app, '/api/auth/oauth', { accessToken: jwt }));
    await keep(post(app, '/api/auth/oauth', { accessToken: `${jwt}x` }));
    await keep(app.inject({ method: 'POST', url: '/api/admin/plan', headers: { 'x-admin-token': 'TEST-admin' }, payload: { email: EMAIL, plan: 'pro' } }));
    await keep(app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: PASSWORD } })); // csrf
    await keep(post(app, '/api/auth/logout', undefined, { cookie: cookieOf(inAgain) }));

    const hashes = (await db.query<{ password_hash: string | null }>('select password_hash from accounts')).map((r) => r.password_hash).filter(Boolean) as string[];
    const sessions = (await db.query<{ token_hash: string }>('select token_hash from sessions')).map((r) => r.token_hash);
    const secrets = [
      PASSWORD, 'TEST-second-password', 'TEST-wrong-password', 'TEST-admin', jwt, cookie.slice(11), tokenOf(inAgain), tokenOf(viaOauth),
      ...hashes, ...hashes.map((h) => h.split('$')[4]!), ...sessions, sha256(tokenOf(inAgain)), '$scrypt$', 'password_hash', 'token_hash',
    ];
    expect(hashes.length).toBeGreaterThan(0);
    expect(sessions.length).toBeGreaterThan(0);
    const all = bodies.join('\n');
    for (const secret of secrets) expect(all.includes(secret), `leaked: ${secret.slice(0, 12)}…`).toBe(false);
    expect(bodies).toHaveLength(11);
  });

  it('a failing database is a 500 that repeats nothing the caller sent', async () => {
    const config = accountsConfig();
    const broken: Db = { kind: 'pglite', query: async () => { throw new Error('TEST database is down'); }, exec: async () => {}, close: async () => {} };
    const { app } = await buildApp({ db: broken }, { config, now, auth: createAuth(broken, config, { now, cost: CHEAP }) });
    apps.push(app);
    for (const path of ['signup', 'login']) {
      const res = await post(app, `/api/auth/${path}`, { email: EMAIL, password: PASSWORD });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain(PASSWORD);
      expect(res.body).not.toContain('scrypt');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const stale = await app.inject({ url: '/api/me', headers: { cookie: `bs_session=${'A'.repeat(43)}` } });
    expect(stale.statusCode).toBe(500);
    expect(stale.body).not.toContain('A'.repeat(43));
    // A cookie that is not even shaped like a token is turned away before the database is asked.
    expect((await app.inject({ url: '/api/me', headers: { cookie: 'bs_session=TEST-not-a-token' } })).statusCode).toBe(401);
  });

  it('an error thrown by the hashing code does not include the password, and does not jam the queue', async () => {
    // N = 1 is a cost Node refuses to run.
    const err = await hashPassword(PASSWORD, { ln: 0, r: 8, p: 1 }).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(`${String(err)} ${err!.stack}`).not.toContain(PASSWORD);
    // The failure gave its place in the queue back: hashing carries on.
    const hashes = await Promise.all(Array.from({ length: 6 }, () => hashPassword(PASSWORD, CHEAP)));
    expect(new Set(hashes).size).toBe(6);
    expect(await verifyPassword(PASSWORD, hashes[5]!)).toBe(true);
  });
});
