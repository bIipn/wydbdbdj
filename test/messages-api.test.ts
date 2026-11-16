import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RouteContext } from '../src/context.js';
import type { Db } from '../src/db/db.js';
import { saveProfileForAccount } from '../src/db/repo.js';
import { buildProfile, profileIdFor } from '../src/profile/build.js';
import { loadProfile } from '../src/profiles.js';
import { createRealtime, type Realtime } from '../src/realtime/index.js';
import { buildApp, buildServer } from '../src/server.js';
import type { Account } from '../src/types.js';
import { accountsConfig, memoryDb, seedAccount } from './helpers.js';

/**
 * The Messages tab through the real server (accounts mode) with an injected clock: GET /api/jobs/conversations,
 * GET /api/jobs/:id/conversation, POST /api/jobs/:id/read. Every person and job here is synthetic (TEST- accounts
 * at example.com, a 555 phone, a "(simulated)" street).
 */

const DAY = 86_400_000;
const START = Date.parse('2026-11-14T18:00:00Z');
const ADMIN = 'TEST-admin-token';
const ADDRESS = '9 TEST Street (simulated)';
const PHONE = '775-555-0199';

let db: Db;
let app: FastifyInstance;
let ctx: RouteContext;
let rt: Realtime;
let clock = START;
const byId = new Map<string, Account>();

let poster: Account;
let winner: Account;
let loser: Account;
let stranger: Account;

async function onboard(a: Account, trades: string[]): Promise<void> {
  await saveProfileForAccount(db, a.id, buildProfile(profileIdFor(a.id), {
    businessName: a.name ?? 'TEST (simulated)', trades, zip: '89410', radiusMi: 90, valueRange: { min: 10_000, max: 50_000 },
  }));
}

beforeAll(async () => {
  db = await memoryDb();
  poster = await seedAccount(db, { name: 'TEST Msg Poster (simulated)' });
  winner = await seedAccount(db, { name: 'TEST Msg Winner (simulated)' });
  loser = await seedAccount(db, { name: 'TEST Msg Loser (simulated)' });
  stranger = await seedAccount(db, { name: 'TEST Msg Stranger (simulated)' });
  for (const a of [poster, winner, loser]) await onboard(a, ['electrical']);
  await onboard(stranger, ['roofing']);
  const built = await buildApp({ db }, {
    config: accountsConfig({ adminToken: ADMIN, appUrl: 'https://bidswipe.example.com' }),
    auth: { authenticate: async (req) => { const as = req.headers['x-test-as']; return typeof as === 'string' ? (byId.get(as) ?? null) : null; } },
    now: () => new Date(clock),
  });
  app = built.app;
  ctx = built.ctx;
  rt = createRealtime(ctx, { sender: null, tickMs: 0 });
});
afterAll(async () => {
  rt.stop();
  await app.close();
  await db.close();
});

async function call(who: Account | null, method: 'GET' | 'POST', url: string, body?: unknown) {
  if (who) byId.set(who.id, who);
  const res = await app.inject({
    method, url, headers: { 'x-bidswipe': '1', 'x-test-as': who?.id ?? '', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return { status: res.statusCode, json: res.body ? res.json() : null, text: res.body };
}

interface Conv {
  jobId: string; title: string; role: string; canWrite: boolean; messageCount: number; unread: boolean;
  last: null | { preview: string; at: string; mine: boolean }; other: { id: string; name: string }; activityAt: string;
}
async function list(who: Account): Promise<{ conversations: Conv[]; unread: number; text: string }> {
  const res = await call(who, 'GET', '/api/jobs/conversations');
  expect(res.status).toBe(200);
  return { ...res.json, text: res.text };
}
const one = async (who: Account, id: string) => (await list(who)).conversations.find((c) => c.jobId === id);
const send = (who: Account, id: string, body: string) => call(who, 'POST', `/api/jobs/${id}/messages`, { body });
const unreadMsgAlerts = async (a: Account, id: string) =>
  (await db.query<{ dedupe_key: string }>(
    "select dedupe_key from alerts where profile_id = $1 and kind = 'job_message' and read_at is null and dedupe_key like $2",
    [profileIdFor(a.id), `${id}:%`],
  )).length;

/** Post a job, two sealed bids (the winner's lower), close it. Returns the job id. */
async function awardedJob(title: string): Promise<string> {
  const res = await call(poster, 'POST', '/api/jobs', {
    title, description: 'Replace a broken outlet cover and test the circuit. TEST job (simulated).',
    trades: ['electrical'], zip: '89423', address: ADDRESS, phone: PHONE, budgetMaxCents: 100_000, closesInDays: 1,
  });
  expect(res.status).toBe(201);
  const id = res.json.job.id as string;
  expect((await call(winner, 'POST', `/api/jobs/${id}/bid`, { amountCents: 30_001, agree: true })).status).toBe(200);
  expect((await call(loser, 'POST', `/api/jobs/${id}/bid`, { amountCents: 40_003, agree: true })).status).toBe(200);
  return id;
}
const closeIt = async () => { clock += DAY + 1; await rt.tick(); };

describe('single mode', () => {
  it('answers 404 to every Messages route, like the other jobs routes', async () => {
    const single = await buildServer({ db, profile: loadProfile('lm-electric') }, {});
    for (const [method, url] of [['GET', '/api/jobs/conversations'], ['GET', '/api/jobs/x/conversation'], ['POST', '/api/jobs/x/read']] as const) {
      const res = await single.inject({ method, url, headers: { 'x-bidswipe': '1' } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
    await single.close();
  });

  it('signed out: 401; a read without the CSRF header: 403', async () => {
    expect((await call(null, 'GET', '/api/jobs/conversations')).status).toBe(401);
    byId.set(poster.id, poster);
    const res = await app.inject({ method: 'POST', url: '/api/jobs/x/read', headers: { 'x-test-as': poster.id, cookie: 'bidswipe_session=TEST' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('the conversation list', () => {
  let id: string;

  it('before the award: nobody has a conversation', async () => {
    clock = START;
    id = await awardedJob('Fix a dead outlet (TEST)');
    for (const a of [poster, winner, loser, stranger]) expect((await one(a, id))).toBeUndefined();
    expect((await call(poster, 'GET', `/api/jobs/${id}/conversation`)).status).toBe(403);
  });

  it('after the award, zero messages: the poster and the winner see it ("no messages yet"); the loser and a stranger do not', async () => {
    await closeIt();
    const p = await one(poster, id);
    const w = await one(winner, id);
    expect(p).toMatchObject({ role: 'poster', canWrite: true, messageCount: 0, last: null, unread: false, other: { id: winner.id, name: 'TEST Msg Winner (simulated)' } });
    expect(w).toMatchObject({ role: 'winner', canWrite: true, messageCount: 0, last: null, unread: false, other: { id: poster.id, name: 'TEST Msg Poster (simulated)' } });
    expect(await one(loser, id)).toBeUndefined();
    expect(await one(stranger, id)).toBeUndefined();
    expect((await call(loser, 'GET', `/api/jobs/${id}/conversation`))).toMatchObject({ status: 403, json: { error: 'not_allowed' } });
    expect((await call(stranger, 'POST', `/api/jobs/${id}/read`)).status).toBe(403);
  });

  it('never carries an email, a phone or a street address, for either side', async () => {
    for (const a of [poster, winner]) {
      const { text } = await list(a);
      expect(text).not.toMatch(/@example\.com/);
      expect(text).not.toContain('555-0199');
      expect(text).not.toContain(ADDRESS);
      expect(text).not.toMatch(/"(email|phone|address)"/);
      const conv = await call(a, 'GET', `/api/jobs/${id}/conversation`);
      expect(conv.status).toBe(200);
      expect(conv.text).not.toMatch(/@example\.com/);
      expect(conv.text).not.toContain(ADDRESS);
    }
  });

  it('one message: unread for the other side only, with its preview, time and whose it is; the bell has it too', async () => {
    clock += 60_000;
    expect((await send(winner, id, 'Hi, I can come by Thursday morning to look at it.')).status).toBe(200);
    const p = await one(poster, id);
    expect(p).toMatchObject({ unread: true, messageCount: 1, last: { preview: 'Hi, I can come by Thursday morning to look at it.', mine: false } });
    expect(p!.last!.at).toBe(new Date(clock).toISOString());
    expect(p!.activityAt).toBe(new Date(clock).toISOString());
    expect((await list(poster)).unread).toBe(1);
    const w = await one(winner, id);
    expect(w).toMatchObject({ unread: false, last: { mine: true } });
    expect((await list(winner)).unread).toBe(0);
    expect(await unreadMsgAlerts(poster, id)).toBe(1);
  });

  it('opening it marks it read for the poster, retires the bell alert, and survives a reload', async () => {
    const conv = await call(poster, 'GET', `/api/jobs/${id}/conversation`);
    expect(conv.json.messages).toHaveLength(1);
    expect(conv.json.conversation.unread).toBe(true); // reading the thread alone changes nothing
    const lastId = conv.json.messages[0].id as number;
    const read = await call(poster, 'POST', `/api/jobs/${id}/read`, { upTo: lastId });
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ readUpTo: lastId, alertsRetired: 1 });
    expect(typeof read.json.alertsUnread).toBe('number');
    expect(await unreadMsgAlerts(poster, id)).toBe(0);
    expect(await one(poster, id)).toMatchObject({ unread: false });
    expect((await list(poster)).unread).toBe(0);
    // opening it again: nothing more to retire, the mark never moves back
    // and the answer is the stored mark, not the cut-off asked for
    expect((await call(poster, 'POST', `/api/jobs/${id}/read`, { upTo: 0 })).json).toMatchObject({ readUpTo: lastId, alertsRetired: 0 });
    expect(await one(poster, id)).toMatchObject({ unread: false });
  });

  it('several messages both ways: each side is unread only for what the other wrote after it last opened', async () => {
    clock += 60_000;
    await send(poster, id, 'Thursday works. Gate code is at the door.');
    clock += 60_000;
    await send(poster, id, 'Text me when you are close.');
    expect(await one(winner, id)).toMatchObject({ unread: true, messageCount: 3, last: { preview: 'Text me when you are close.', mine: false } });
    expect(await one(poster, id)).toMatchObject({ unread: false, last: { mine: true } });
    expect(await unreadMsgAlerts(winner, id)).toBe(2);

    // the winner's screen showed only the first of the two (the second arrived after it was drawn)
    const msgs = (await call(winner, 'GET', `/api/jobs/${id}/conversation`)).json.messages as Array<{ id: number }>;
    const read = await call(winner, 'POST', `/api/jobs/${id}/read`, { upTo: msgs[1]!.id });
    expect(read.json).toMatchObject({ readUpTo: msgs[1]!.id, alertsRetired: 1 });
    expect(await one(winner, id)).toMatchObject({ unread: true });
    expect(await unreadMsgAlerts(winner, id)).toBe(1);
    // no upTo: everything stored
    expect((await call(winner, 'POST', `/api/jobs/${id}/read`)).json).toMatchObject({ readUpTo: msgs[2]!.id, alertsRetired: 1 });
    expect(await one(winner, id)).toMatchObject({ unread: false });
    expect(await unreadMsgAlerts(winner, id)).toBe(0);
    // the poster's own messages never make their side unread
    expect(await one(poster, id)).toMatchObject({ unread: false });
  });

  it('a bad upTo is refused with a sentence', async () => {
    const res = await call(winner, 'POST', `/api/jobs/${id}/read`, { upTo: 'all' });
    expect(res.status).toBe(400);
    expect(res.json.fields[0]).toMatchObject({ path: 'upTo' });
  });

  it('a body that is not an object is refused, never read as "everything"', async () => {
    clock += 60_000;
    await send(poster, id, 'TEST one more (simulated)');
    expect(await one(winner, id)).toMatchObject({ unread: true });
    const arr = await call(winner, 'POST', `/api/jobs/${id}/read`, [1, 2]);
    expect(arr.status).toBe(400);
    expect(arr.json.fields[0]).toMatchObject({ path: 'upTo' });
    const text = await app.inject({
      method: 'POST', url: `/api/jobs/${id}/read`, payload: 'hello',
      headers: { 'x-bidswipe': '1', 'x-test-as': winner.id, 'content-type': 'text/plain' },
    });
    expect(text.statusCode).toBe(400);
    expect(await one(winner, id)).toMatchObject({ unread: true });
    await call(winner, 'POST', `/api/jobs/${id}/read`);
    expect(await one(winner, id)).toMatchObject({ unread: false });
  });

  it('a long message: the preview is cut at 200 characters', async () => {
    clock += 60_000;
    const long = `TEST ${'x'.repeat(400)}`;
    expect((await send(winner, id, long)).status).toBe(200);
    const p = await one(poster, id);
    expect([...p!.last!.preview]).toHaveLength(200);
    expect(long.startsWith(p!.last!.preview)).toBe(true);
  });

  it('newest activity first across conversations', async () => {
    const id2 = await awardedJob('Swap a light switch (TEST)');
    await closeIt();
    const order = (await list(poster)).conversations.map((c) => c.jobId);
    expect(order.indexOf(id2)).toBeLessThan(order.indexOf(id));
    clock += 60_000;
    await send(winner, id, 'One more thing (TEST).');
    const again = (await list(poster)).conversations.map((c) => c.jobId);
    expect(again.indexOf(id)).toBeLessThan(again.indexOf(id2));
  });

  it('a job that ended: still readable, no longer writable; a job ended in silence is not listed', async () => {
    // both confirm → agreed (still writable), then done → readable only
    expect((await call(poster, 'POST', `/api/jobs/${id}/confirm`)).status).toBe(200);
    expect((await call(winner, 'POST', `/api/jobs/${id}/confirm`)).status).toBe(200);
    expect(await one(poster, id)).toMatchObject({ canWrite: true });
    const done = await call(poster, 'POST', `/api/jobs/${id}/complete`);
    expect(done.status).toBe(200);
    const p = await one(poster, id);
    expect(p).toMatchObject({ canWrite: false, status: 'completed' });
    expect((await call(poster, 'GET', `/api/jobs/${id}/conversation`)).json.messages.length).toBeGreaterThan(0);
    expect((await send(poster, id, 'Thanks (TEST).')).status).toBe(409);

    // awarded, nobody wrote, the window ran out: nothing to read, not listed
    const silent = await awardedJob('Silent job (TEST)');
    await closeIt();
    expect(await one(poster, silent)).toMatchObject({ canWrite: true, messageCount: 0 });
    clock += 8 * DAY;
    await rt.tick();
    expect(await one(poster, silent)).toBeUndefined();
    expect(await one(winner, silent)).toBeUndefined();
  });

  it('a removed job leaves both lists and its conversation answers 404', async () => {
    const gone = await awardedJob('Removed job (TEST)');
    await closeIt();
    clock += 60_000;
    await send(winner, gone, 'Hello (TEST).');
    expect(await one(poster, gone)).toBeDefined();
    const res = await app.inject({ method: 'POST', url: `/api/admin/jobs/${gone}/remove`, headers: { 'x-admin-token': ADMIN } });
    expect(res.statusCode).toBe(200);
    expect(await one(poster, gone)).toBeUndefined();
    expect(await one(winner, gone)).toBeUndefined();
    expect((await call(poster, 'GET', `/api/jobs/${gone}/conversation`)).status).toBe(404);
    expect((await call(winner, 'POST', `/api/jobs/${gone}/read`)).status).toBe(404);
  });
});
