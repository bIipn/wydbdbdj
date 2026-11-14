/**
 * "Forgot password": the reset link (single use, one hour, only its hash stored), the screen's one answer for
 * every address, the rate limits, and what happens when the server cannot send email at all.
 * Everything is synthetic: example.com addresses, "(simulated)" names, TEST- passwords, and a mailer that
 * collects the emails in an array instead of sending them. Nothing here touches the network.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth, RESET_TTL_MS } from '../src/auth/index.js';
import * as passwords from '../src/auth/password.js';
import type { ScryptCost } from '../src/auth/password.js';
import type { AppConfig } from '../src/context.js';
import { createAccount } from '../src/db/accounts.js';
import type { Db } from '../src/db/db.js';
import { EmailError, mailerFromEnv, resendMailer, resetEmail, type Email, type Mailer } from '../src/notify/email.js';
import { loadProfile } from '../src/profiles.js';
import { buildApp, buildServer } from '../src/server.js';
import { accountsConfig, memoryDb, NOW, resetDb } from './helpers.js';

// Pass-through spies: the real hashing runs, and a test can count how many hashes a request cost.
vi.mock('../src/auth/password.js', async (original) => {
  const real = await original<typeof import('../src/auth/password.js')>();
  return { ...real, hashPassword: vi.fn(real.hashPassword), verifyPassword: vi.fn(real.verifyPassword) };
});

const CHEAP: ScryptCost = { ln: 10, r: 8, p: 1 };
const EMAIL = 'test.forgot@example.com';
const OLD = 'TEST-old-password-1';
const NEW = 'TEST-new-password-2';
const APP_URL = 'https://bidswipe.example.com';
const MIN = 60_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

let db: Db;
let clock = NOW.getTime();
const now = () => new Date(clock);
const apps: FastifyInstance[] = [];
let outbox: Email[] = [];
let logs: string[] = [];
let mailDown = false;
const mailer: Mailer = {
  async send(email) {
    if (mailDown) throw new EmailError(500);
    outbox.push(email);
  },
};

beforeAll(async () => { db = await memoryDb(); });
beforeEach(async () => {
  await resetDb(db);
  clock = NOW.getTime();
  outbox = [];
  logs = [];
  mailDown = false;
  vi.clearAllMocks();
});
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });
afterAll(async () => { await db.close(); });

/** An accounts-mode server. `withMail: false` = no RESEND_API_KEY on the host: email is off. */
async function server(withMail = true, over: Partial<AppConfig> = {}): Promise<FastifyInstance> {
  const config = accountsConfig({ appUrl: APP_URL, ...over });
  const { app, ctx } = await buildApp({ db }, { config, now, auth: createAuth(db, config, { now, cost: CHEAP }), mailer: withMail ? mailer : null });
  const log = ctx.log;
  ctx.log = (m) => { logs.push(m); log(m); };
  apps.push(app);
  return app;
}

const post = (app: FastifyInstance, url: string, payload: object, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers: { 'x-bidswipe': '1', ...headers }, payload });
const forgot = (app: FastifyInstance, email: unknown, ip = '203.0.113.9') => post(app, '/api/auth/forgot', { email }, { 'x-forwarded-for': ip });
const reset = (app: FastifyInstance, token: unknown, password: unknown) => post(app, '/api/auth/reset', { token, password });
const login = (app: FastifyInstance, password: string, email = EMAIL) => post(app, '/api/auth/login', { email, password });

async function signUp(app: FastifyInstance, email = EMAIL, password = OLD): Promise<string> {
  const res = await post(app, '/api/auth/signup', { email, password, name: 'TEST Forgetful (simulated)' });
  expect(res.statusCode).toBe(201);
  return String(res.headers['set-cookie']).split(';')[0]!;
}
/** The token in the newest reset email's link. */
function tokenIn(email: Email | undefined): string {
  const m = /#reset=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(email?.text ?? '');
  expect(m, 'the email has a reset link').not.toBeNull();
  return m![1]!;
}
const resets = () => db.query<{ token_hash: string; account_id: string; created_at: Date; expires_at: Date; used_at: Date | null }>('select * from password_resets order by created_at');
const storedHash = async (email = EMAIL) => (await db.query<{ password_hash: string | null }>('select password_hash from accounts where email = $1', [email]))[0]?.password_hash;

// ------------------------------------------------------------------------------------------------------------

describe('when the server cannot send email (no RESEND_API_KEY)', () => {
  it('says plainly that reset by email is not available, sends nothing and stores nothing', async () => {
    const app = await server(false);
    await signUp(app);
    expect((await app.inject({ url: '/api/auth/config' })).json()).not.toHaveProperty('passwordReset');

    const res = await forgot(app, EMAIL);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'reset_unavailable', message: 'Password reset by email is not available yet. No email was sent.' });
    expect(res.body).not.toMatch(/we emailed|check your email|if an account/i); // never the "it is on its way" answer
    expect(outbox).toEqual([]);
    expect(await resets()).toEqual([]);
    // The same for an address nobody has: the answer is about the server, not about the address.
    expect((await forgot(app, 'test.nobody@example.com')).json()).toEqual(res.json());
  });

  it('GET /api/auth/config says so, so the screen can offer the form only when a link can really be sent', async () => {
    expect((await (await server(true)).inject({ url: '/api/auth/config' })).json()).toMatchObject({ passwordReset: true });
    expect((await (await server(false)).inject({ url: '/api/auth/config' })).json()).toEqual({ mode: 'accounts', providers: ['password'], demo: false });
  });

  it('mailerFromEnv: off without a key or without a sender; DIGEST_FROM is the fallback sender', () => {
    const env = (vars: Record<string, string>) => (name: string) => vars[name];
    expect(mailerFromEnv(env({}))).toBeNull();
    expect(mailerFromEnv(env({ RESEND_API_KEY: 'TEST-key' }))).toBeNull();
    expect(mailerFromEnv(env({ EMAIL_FROM: 'BidSwipe <test@example.com>' }))).toBeNull();
    expect(mailerFromEnv(env({ RESEND_API_KEY: 'TEST-key', EMAIL_FROM: 'BidSwipe <test@example.com>' }))).not.toBeNull();
    expect(mailerFromEnv(env({ RESEND_API_KEY: 'TEST-key', DIGEST_FROM: 'BidSwipe <test@example.com>' }))).not.toBeNull();
  });
});

describe('asking for a reset link', () => {
  it('emails a one-hour link to an account with a password, and stores only the hash of its token', async () => {
    const app = await server();
    await signUp(app);
    const res = await forgot(app, `  ${EMAIL.toUpperCase()} `);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true, message: 'If an account with a password uses that address, we emailed it a link to choose a new one. The link works once, for an hour.',
    });

    expect(outbox).toHaveLength(1);
    const mail = outbox[0]!;
    expect(mail.to).toBe(EMAIL);
    expect(mail.subject).toBe('Reset your BidSwipe password');
    const token = tokenIn(mail);
    // The link carries the token in the fragment (never sent to a server), in the text and in the HTML button.
    expect(mail.text).toContain(`${APP_URL}/#reset=${token}`);
    expect(mail.html).toContain(`href="${APP_URL}/#reset=${token}"`);
    expect(mail.text).toMatch(/works once, for 60 minutes/);
    expect(mail.text).toMatch(/ignore this email\. Your password stays as it is\./);

    const rows = await resets();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(sha256(token));
    expect(new Date(rows[0]!.expires_at).getTime()).toBe(clock + RESET_TTL_MS);
    expect(RESET_TTL_MS).toBe(60 * MIN);
    expect(rows[0]!.used_at).toBeNull();
    // The token is in that one email and nowhere else: not in the database, the answer or the log.
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(res.body).not.toContain(token);
    expect(logs.join('\n')).not.toContain(token);
    expect(logs.join('\n')).not.toContain(EMAIL);
    // Asking is not using: the password still works.
    expect((await login(app, OLD)).statusCode).toBe(200);
  });

  it('answers an unknown address, and an account with no password, exactly like a real one, and emails neither', async () => {
    const app = await server();
    await signUp(app);
    await createAccount(db, { id: 'TEST-provider-only', email: 'test.provider@example.com', name: 'TEST Provider (simulated)', passwordHash: null }, now(), { provider: 'google', subject: 'TEST-sub' });
    const real = await forgot(app, EMAIL, '203.0.113.1');
    const unknown = await forgot(app, 'test.nobody@example.com', '203.0.113.2');
    const providerOnly = await forgot(app, 'test.provider@example.com', '203.0.113.3');
    for (const res of [unknown, providerOnly]) {
      expect(res.statusCode).toBe(real.statusCode);
      expect(res.body).toBe(real.body);
    }
    expect(outbox.map((m) => m.to)).toEqual([EMAIL]);
    expect(await resets()).toHaveLength(1);
    // The provider-only account still has no password, and no link that could give it one.
    expect(await storedHash('test.provider@example.com')).toBeNull();
  });

  it('refuses what is not an email address, and the request without the x-bidswipe header', async () => {
    const app = await server();
    for (const bad of ['not-an-email', '', null, 42, { a: 1 }]) {
      const res = await forgot(app, bad, '203.0.113.50');
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_email', message: 'Enter a valid email address.' });
    }
    const forged = await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: EMAIL } });
    expect(forged.statusCode).toBe(403);
    expect(forged.json()).toEqual({ error: 'csrf' });
    expect((await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: 'x', password: NEW } })).statusCode).toBe(403);
    expect(outbox).toEqual([]);
  });

  it('a newer link replaces the older one: only the newest works', async () => {
    const app = await server();
    await signUp(app);
    await forgot(app, EMAIL);
    clock += 5 * MIN;
    await forgot(app, EMAIL);
    const [first, second] = outbox.map(tokenIn);
    expect(first).not.toBe(second);
    expect((await resets()).map((r) => r.token_hash)).toEqual([sha256(second!)]);
    expect((await reset(app, first, NEW)).statusCode).toBe(400);
    expect((await login(app, OLD)).statusCode).toBe(200);
    expect((await reset(app, second, NEW)).statusCode).toBe(200);
  });

  it('when the delivery service refuses the email, it says nothing was sent instead of "we emailed it"', async () => {
    const app = await server();
    await signUp(app);
    mailDown = true;
    const res = await forgot(app, EMAIL);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'email_failed', message: 'We could not send the email just now. Nothing was sent. Try again in a few minutes.' });
    expect(outbox).toEqual([]);
    expect(logs.join('\n')).toMatch(/password reset: the email was not sent \(the email service answered 500\)/);
    // The next try, with the service back, works.
    mailDown = false;
    expect((await forgot(app, EMAIL)).statusCode).toBe(200);
    expect((await reset(app, tokenIn(outbox[0]), NEW)).statusCode).toBe(200);
  });
});

describe('rate limits on asking', () => {
  it('3 requests an hour per email address, then 429 and no email, until the hour is over', async () => {
    const app = await server();
    await signUp(app);
    for (let i = 0; i < 3; i++) expect((await forgot(app, EMAIL, `203.0.113.${10 + i}`)).statusCode).toBe(200);
    const blocked = await forgot(app, EMAIL, '203.0.113.20');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'too_many_attempts', message: 'Too many reset requests. Wait an hour, then try again.' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(outbox).toHaveLength(3);
    // An address nobody has is limited the same way: the limit says nothing about who has an account.
    for (let i = 0; i < 3; i++) expect((await forgot(app, 'test.nobody@example.com', `203.0.113.${30 + i}`)).statusCode).toBe(200);
    expect((await forgot(app, 'test.nobody@example.com', '203.0.113.40')).statusCode).toBe(429);

    clock += 60 * MIN;
    expect((await forgot(app, EMAIL, '203.0.113.20')).statusCode).toBe(200);
    expect(outbox).toHaveLength(4);
  });

  it('5 requests an hour per caller, whatever addresses they try', async () => {
    const app = await server();
    for (let i = 0; i < 5; i++) expect((await forgot(app, `test.spray.${i}@example.com`, '203.0.113.77')).statusCode).toBe(200);
    expect((await forgot(app, 'test.spray.5@example.com', '203.0.113.77')).statusCode).toBe(429);
    expect((await forgot(app, 'not-an-email', '203.0.113.77')).statusCode).toBe(429); // junk counts too
    expect((await forgot(app, 'test.spray.5@example.com', '203.0.113.78')).statusCode).toBe(200); // someone else is not locked out
  });
});

describe('choosing the new password', () => {
  it('sets it, signs this browser in, and signs every other device out', async () => {
    const app = await server(true, { cookieSecure: true }); // an https host
    const laptop = await signUp(app);
    const phone = String((await login(app, OLD)).headers['set-cookie']).split(';')[0]!;
    const accountId = (await db.query<{ id: string }>('select id from accounts where email = $1', [EMAIL]))[0]!.id;
    await db.query("insert into push_subscriptions (endpoint, account_id, keys) values ('https://push.example.com/TEST-device', $1, '{}'::jsonb)", [accountId]);
    await forgot(app, EMAIL);
    const token = tokenIn(outbox[0]);
    const before = await storedHash();

    clock += 59 * MIN + 59_000; // one second before the hour is up
    const res = await reset(app, token, NEW);
    expect(res.statusCode).toBe(200);
    expect(res.json().account).toMatchObject({ id: accountId, email: EMAIL });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^bs_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
    expect((await app.inject({ url: '/api/me', headers: { cookie: cookie.split(';')[0]! } })).statusCode).toBe(200);

    // The new password is stored as a new scrypt hash; the old password is dead.
    const after = await storedHash();
    expect(after).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$/);
    expect(after).not.toBe(before);
    expect((await login(app, OLD)).statusCode).toBe(401);
    expect((await login(app, NEW)).statusCode).toBe(200);
    // Whoever was signed in with the old password is signed out, and their devices get no more alerts.
    for (const old of [laptop, phone]) expect((await app.inject({ url: '/api/me', headers: { cookie: old } })).statusCode).toBe(401);
    expect(await db.query('select 1 from push_subscriptions where account_id = $1', [accountId])).toHaveLength(0);
    // Nothing secret in the answer or the log.
    for (const secret of [token, NEW, OLD, after!]) {
      expect(res.body).not.toContain(secret);
      expect(logs.join('\n')).not.toContain(secret);
    }
    expect((await resets())[0]!.used_at).not.toBeNull();
  });

  it('works once: the same link a second time changes nothing', async () => {
    const app = await server();
    await signUp(app);
    await forgot(app, EMAIL);
    const token = tokenIn(outbox[0]);
    expect((await reset(app, token, NEW)).statusCode).toBe(200);
    const hash = await storedHash();

    const again = await reset(app, token, 'TEST-a-third-password');
    expect(again.statusCode).toBe(400);
    expect(again.json()).toEqual({ error: 'reset_link_invalid', message: 'That reset link is no longer valid. Links work once, for an hour. Ask for a new one.' });
    expect(again.headers['set-cookie']).toBeUndefined();
    expect(await storedHash()).toBe(hash);
    expect((await login(app, NEW)).statusCode).toBe(200);
  });

  it('two requests with the same link at once: exactly one wins', async () => {
    const app = await server();
    await signUp(app);
    await forgot(app, EMAIL);
    const token = tokenIn(outbox[0]);
    const [a, b] = await Promise.all([reset(app, token, 'TEST-racer-one-pw'), reset(app, token, 'TEST-racer-two-pw')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    const winner = a.statusCode === 200 ? 'TEST-racer-one-pw' : 'TEST-racer-two-pw';
    const loser = a.statusCode === 200 ? 'TEST-racer-two-pw' : 'TEST-racer-one-pw';
    expect((await login(app, winner)).statusCode).toBe(200);
    expect((await login(app, loser)).statusCode).toBe(401);
  });

  it('expires after exactly one hour, and the password stays as it was', async () => {
    const app = await server();
    await signUp(app);
    await forgot(app, EMAIL);
    const token = tokenIn(outbox[0]);
    clock += RESET_TTL_MS;
    const res = await reset(app, token, NEW);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('reset_link_invalid');
    expect((await login(app, OLD)).statusCode).toBe(200);
    expect((await login(app, NEW)).statusCode).toBe(401);
    // The next request for a link sweeps the dead one out.
    await forgot(app, 'test.nobody@example.com');
    await signUp(app, 'test.other@example.com');
    await forgot(app, 'test.other@example.com', '203.0.113.60');
    expect((await resets()).map((r) => r.token_hash)).not.toContain(sha256(token));
  });

  it('a made-up, mangled or missing token gets the same answer as a used one, and costs no password hash', async () => {
    const app = await server();
    await signUp(app);
    await forgot(app, EMAIL);
    const token = tokenIn(outbox[0]);
    vi.mocked(passwords.hashPassword).mockClear();
    const used = { error: 'reset_link_invalid', message: 'That reset link is no longer valid. Links work once, for an hour. Ask for a new one.' };
    for (const bad of ['A'.repeat(43), `${token.slice(0, 42)}${token.endsWith('A') ? 'B' : 'A'}`, token.slice(0, 20), `${token}x`, '', null, undefined, 12345, ['x']]) {
      const res = await reset(app, bad, NEW);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json()).toEqual(used);
    }
    expect(passwords.hashPassword).not.toHaveBeenCalled();
    // None of that used the real link up. (A new 15-minute window: those nine tries counted against this caller.)
    clock += 16 * MIN;
    expect((await reset(app, token, NEW)).statusCode).toBe(200);
    expect(passwords.hashPassword).toHaveBeenCalledTimes(1);
  });

  it('a new password that is too short or too long is refused first, and the link is still good afterwards', async () => {
    const app = await server();
    await signUp(app);
    await forgot(app, EMAIL);
    const token = tokenIn(outbox[0]);
    for (const bad of ['short77', 'x'.repeat(129), '', null, 12345678]) {
      const res = await reset(app, token, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_password', message: 'Use a password of 8 to 128 characters.' });
    }
    expect((await login(app, OLD)).statusCode).toBe(200);
    expect((await reset(app, token, NEW)).statusCode).toBe(200);
  });

  it('tries are limited per caller like sign-in tries: the 11th in 15 minutes is a 429', async () => {
    const app = await server();
    for (let i = 0; i < 10; i++) expect((await reset(app, 'B'.repeat(43), NEW)).statusCode).toBe(400);
    expect((await reset(app, 'B'.repeat(43), NEW)).statusCode).toBe(429);
  });
});

describe('where there is nothing to reset', () => {
  it('single mode (the pilot) has no accounts: both routes answer 404', async () => {
    const single = await buildServer({ db, profile: loadProfile('lm-electric') }, { mailer });
    apps.push(single);
    for (const url of ['/api/auth/forgot', '/api/auth/reset']) {
      const res = await single.inject({ method: 'POST', url, headers: { 'x-bidswipe': '1' }, payload: { email: EMAIL } });
      expect(res.statusCode, url).toBe(404);
    }
    expect(outbox).toEqual([]);
  });
});

describe('the email itself, and the sender', () => {
  it('resetEmail: the token appears only in the link, in the fragment', () => {
    const token = 'T'.repeat(43);
    const mail = resetEmail({ to: EMAIL, appUrl: APP_URL, token, minutes: 60 });
    expect(mail.to).toBe(EMAIL);
    for (const body of [mail.text, mail.html]) {
      expect(body.split(token)).toHaveLength(2); // once
      expect(body).toContain(`${APP_URL}/#reset=${token}`);
      expect(body).not.toContain(`?reset=`);
    }
    expect(mail.subject).not.toContain(token);
  });

  it('resendMailer: posts the email with the key in the header, and a refusal is an error that names only the status', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let status = 200;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify(status === 200 ? { id: 'TEST-email-id' } : { message: 'The TEST-key-123 API key is invalid' }), { status });
    }) as typeof fetch;
    const m = resendMailer({ apiKey: 'TEST-key-123', from: 'BidSwipe <test@example.com>', fetch: fakeFetch });
    const mail = resetEmail({ to: EMAIL, appUrl: APP_URL, token: 'T'.repeat(43), minutes: 60 });

    await m.send(mail);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer TEST-key-123');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ from: 'BidSwipe <test@example.com>', to: [EMAIL], subject: mail.subject, html: mail.html, text: mail.text });

    status = 403;
    const err = await m.send(mail).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailError);
    expect((err as EmailError).message).toBe('the email service answered 403');
    expect(String(err)).not.toContain('TEST-key-123');
    expect(String(err)).not.toContain(EMAIL);
  });
});
