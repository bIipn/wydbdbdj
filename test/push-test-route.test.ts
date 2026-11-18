/**
 * POST /api/push/test ("Send a test alert", the bell): the gate, the per-account limit, and that it reaches the
 * caller's own devices only, through the real web-push sender.
 *
 * The push service is a MOCK inside this process (the approach of the iPhone audit's mock push service): node:https's
 * request() is wrapped so a request for push.example.com (the tests' synthetic push host) never leaves the machine;
 * the mock records it, decrypts the payload with the fake device's private key (RFC 8291 aes128gcm) and answers the
 * status the test set for that device. Everything else is the real path: the route, sendTestPush, web-push's request
 * building and encryption, recordPushResult. Every name is synthetic (TEST-, example.com).
 */
import { createDecipheriv, createECDH, hkdfSync, randomBytes, type ECDH } from 'node:crypto';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateVAPIDKeys } from 'web-push';
import type { AuthService } from '../src/auth/index.js';
import { listAlerts, listSubscriptions, saveSubscription, type StoredSubscription } from '../src/db/alerts.js';
import type { Db } from '../src/db/db.js';
import { saveProfileForAccount } from '../src/db/repo.js';
import { profileIdFor } from '../src/profile/build.js';
import { PUSH_SERVICE_HOSTS, TEST_PUSH_TITLE } from '../src/realtime/push.js';
import { PUSH_TEST_LIMIT } from '../src/routes/realtime.js';
import { buildApp } from '../src/server.js';
import type { Account, AlertSettings, Plan } from '../src/types.js';
import { accountsConfig, memoryDb, NOW, resetDb, seedAccount, testProfile } from './helpers.js';

const HOST = 'push.example.com';
const TEST_PUSH_HOSTS = [...PUSH_SERVICE_HOSTS, HOST];
const testVapid = { ...generateVAPIDKeys(), subject: 'mailto:test@example.com' };

// ------------------------------------------------------------ mock push service --

interface Seen { path: string; headers: Record<string, unknown>; payload: Record<string, unknown> | null }
const mock = { seen: [] as Seen[], status: new Map<string, number>(), keys: new Map<string, { ecdh: ECDH; auth: Buffer }>() };

/** RFC 8291 / 8188 aes128gcm, one record: what a browser does with the push it receives. */
function decrypt(body: Buffer, ecdh: ECDH, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLen = body[20]!;
  const serverKey = body.subarray(21, 21 + idLen);
  const cipher = body.subarray(21 + idLen);
  const secret = ecdh.computeSecret(serverKey);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverKey]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString('utf8'); // strip the padding delimiter (0x02) and zeros
}

const realRequest = https.request;
function mockRequest(this: unknown, ...args: unknown[]) {
  const [opts, cb] = args as [{ hostname?: string; path?: string; headers?: Record<string, unknown> }, (res: EventEmitter) => void];
  if (opts?.hostname !== HOST) throw new Error(`test: a push request left for ${String(opts?.hostname)}`);
  const req = new EventEmitter() as EventEmitter & { write(c: Buffer | string): void; end(): void; destroy(e?: Error): void; setTimeout(): void };
  const chunks: Buffer[] = [];
  req.write = (c) => { chunks.push(Buffer.from(c)); };
  req.setTimeout = () => {};
  req.destroy = (e) => { if (e) req.emit('error', e); };
  req.end = () => setImmediate(() => {
    const path = String(opts.path);
    const keys = mock.keys.get(path);
    const body = Buffer.concat(chunks);
    mock.seen.push({ path, headers: { ...opts.headers }, payload: keys ? JSON.parse(decrypt(body, keys.ecdh, keys.auth)) as Record<string, unknown> : null });
    const res = Object.assign(new EventEmitter(), { statusCode: mock.status.get(path) ?? 201, headers: {} });
    cb(res);
    if (res.statusCode !== 201) res.emit('data', Buffer.from(JSON.stringify({ reason: 'TEST-mock' })));
    res.emit('end');
  });
  return req;
}

/** A browser subscription on the mock host whose private key the mock keeps, so it can read what was sent. */
function device(name: string): StoredSubscription {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const path = `/send/TEST-device-${name}`;
  mock.keys.set(path, { ecdh, auth });
  return { endpoint: `https://${HOST}${path}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}

// --------------------------------------------------------------------- app --

let db: Db;
let app: FastifyInstance;
let noKeys: FastifyInstance;
const accounts = new Map<string, Account>();
const auth: AuthService = { authenticate: async (req) => accounts.get(String(req.headers['x-test-account'])) ?? null };

async function member(name: string, opts: { plan?: Plan; alerts?: AlertSettings; devices?: number } = {}) {
  const account = await seedAccount(db, { plan: opts.plan ?? 'pro' });
  accounts.set(account.id, account);
  const profile = await saveProfileForAccount(db, account.id, testProfile(profileIdFor(account.id), opts.alerts ? { alerts: opts.alerts } : {}));
  const devices: StoredSubscription[] = [];
  for (let i = 0; i < (opts.devices ?? 1); i++) {
    devices.push(device(`${name}-${i}`));
    await saveSubscription(db, account.id, devices[i]!, NOW);
  }
  return { account, profile, devices };
}

const test = (who: { account: Account } | null, headers: Record<string, string> = {}) => app.inject({
  method: 'POST', url: '/api/push/test', headers: { ...(who ? { 'x-test-account': who.account.id } : {}), ...headers },
});

beforeAll(async () => {
  db = await memoryDb();
  (https as { request: unknown }).request = mockRequest;
  app = (await buildApp({ db }, { config: accountsConfig({ vapid: testVapid, pushHosts: TEST_PUSH_HOSTS }), auth, now: () => NOW })).app;
  noKeys = (await buildApp({ db }, { config: accountsConfig(), auth, now: () => NOW })).app;
});
afterAll(async () => {
  (https as { request: unknown }).request = realRequest;
  await app.close();
  await noKeys.close();
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  accounts.clear();
  mock.seen.length = 0;
  mock.status.clear();
});

describe('POST /api/push/test', () => {
  it('reaches the caller’s own devices only, through the real sender, and answers counts (never an endpoint)', async () => {
    const alice = await member('alice', { devices: 2 });
    const bob = await member('bob', { devices: 1 });

    const res = await test(alice);
    expect([res.statusCode, res.json()]).toEqual([200, { ok: true, tried: 2, accepted: 2 }]);
    expect(res.body).not.toContain(HOST);

    expect(mock.seen.map((s) => s.path).sort()).toEqual(alice.devices.map((d) => new URL(d.endpoint).pathname).sort());
    expect(mock.seen.map((s) => s.path)).not.toContain(new URL(bob.devices[0]!.endpoint).pathname);
    for (const seen of mock.seen) {
      // What the phone's service worker gets: the real payload shape, with the test title.
      expect(seen.payload).toMatchObject({ title: TEST_PUSH_TITLE, kind: 'summary', bidId: null, alertIds: [], url: 'http://localhost:8787/' });
      expect(String(seen.headers.Authorization)).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
      expect(seen.headers).toMatchObject({ TTL: 900, Urgency: 'high', 'Content-Encoding': 'aes128gcm' });
    }
    // A test is not news: nothing enters anyone's inbox.
    expect(await listAlerts(db, alice.profile.id)).toEqual([]);
    expect(await listAlerts(db, bob.profile.id)).toEqual([]);
  });

  it('keeps the device books like a real alert: a 410 removes that device, a 403 counts as not accepted', async () => {
    const alice = await member('books', { devices: 3 });
    const [gone, refused] = alice.devices.map((d) => new URL(d.endpoint).pathname);
    mock.status.set(gone!, 410);
    mock.status.set(refused!, 403);

    expect((await test(alice)).json()).toEqual({ ok: true, tried: 3, accepted: 1 });
    expect((await listSubscriptions(db, alice.account.id)).map((d) => d.endpoint)).not.toContain(alice.devices[0]!.endpoint);
    // The refused device is skipped from now on, as it is for a real alert, until it subscribes again.
    mock.seen.length = 0;
    expect((await test(alice)).json()).toEqual({ ok: true, tried: 1, accepted: 1 });
    expect(mock.seen.map((s) => s.path)).toEqual([new URL(alice.devices[2]!.endpoint).pathname]);
  });

  it('is gated like a local job\'s phone alert, which every plan gets: the alerts switch and quiet hours, no plan gate', async () => {
    const free = await member('free', { plan: 'free' });
    const off = await member('off', { alerts: { push: false } });
    const quiet = await member('quiet', { alerts: { quietHours: { start: '00:00', end: '23:59' }, timeZone: 'America/Los_Angeles' } });
    const freeQuiet = await member('free-quiet', { plan: 'free', alerts: { quietHours: { start: '00:00', end: '23:59' }, timeZone: 'America/Los_Angeles' } });

    // Free: local jobs buzz on every plan (docs/PLAN.md N2), so a Free phone can be tested like a Pro one.
    const a = await test(free);
    expect([a.statusCode, a.json()]).toEqual([200, { ok: true, tried: 1, accepted: 1 }]);
    expect(mock.seen.map((s) => s.path)).toEqual([new URL(free.devices[0]!.endpoint).pathname]);
    mock.seen.length = 0;
    expect((await test(freeQuiet)).json().error).toBe('quiet_hours');
    const b = await test(off);
    expect([b.statusCode, b.json().error]).toEqual([409, 'push_off']);
    const c = await test(quiet);
    expect([c.statusCode, c.json().error]).toEqual([409, 'quiet_hours']);
    expect(c.json().message).toMatch(/quiet hours/);
    expect(mock.seen).toEqual([]);

    const signedOut = await test(null);
    expect([signedOut.statusCode, signedOut.json()]).toEqual([401, { error: 'sign_in_required' }]);
    const newcomer = await seedAccount(db, { plan: 'pro' }); // signed up, not onboarded: no profile, no alerts
    accounts.set(newcomer.id, newcomer);
    expect((await test({ account: newcomer })).statusCode).toBe(409);

    const unset = await noKeys.inject({ method: 'POST', url: '/api/push/test', headers: { 'x-test-account': free.account.id } });
    expect([unset.statusCode, unset.json()]).toEqual([404, { error: 'push_not_configured' }]);
  });

  it('needs the x-bidswipe header from a browser (the CSRF guard), like every state-changing route', async () => {
    const alice = await member('csrf');
    const forged = await test(alice, { cookie: 'bidswipe_session=TEST-cookie' });
    expect([forged.statusCode, forged.json()]).toEqual([403, { error: 'csrf' }]);
    expect((await test(alice, { cookie: 'bidswipe_session=TEST-cookie', 'x-bidswipe': '1' })).statusCode).toBe(200);
  });

  it('allows 3 tests per account per 10 minutes, then 429 with a sentence; another account is not affected', async () => {
    expect(PUSH_TEST_LIMIT).toEqual({ limit: 3, windowMs: 600_000 });
    const alice = await member('limit');
    const bob = await member('other');
    for (let i = 0; i < 3; i++) expect((await test(alice)).statusCode).toBe(200);
    const fourth = await test(alice);
    expect([fourth.statusCode, fourth.json()]).toEqual([429, {
      error: 'too_many_attempts', message: 'You can send 3 test alerts every 10 minutes. Wait a few minutes, then try again.',
    }]);
    expect(Number(fourth.headers['retry-after'])).toBeGreaterThan(0);
    expect(mock.seen).toHaveLength(3); // the refused one sent nothing
    expect((await test(bob)).statusCode).toBe(200);
  });

  it('a refused test (quiet hours) does not use up the allowance', async () => {
    const quiet = await member('quiet-limit', { alerts: { quietHours: { start: '00:00', end: '23:59' }, timeZone: 'America/Los_Angeles' } });
    for (let i = 0; i < 5; i++) expect((await test(quiet)).statusCode).toBe(409);
    const rows = await db.query<{ n: number }>('select count(*)::int as n from auth_attempts where key like $1', ['push:test:%']);
    expect(rows[0]!.n).toBe(0);
  });
});
