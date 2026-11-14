/**
 * "Delete my account" through the real server (accounts mode): the real sign-up and session cookies, the real
 * password check, the real jobs routes, and an injected clock. Every person, job and amount is synthetic
 * (example.com addresses, "(simulated)" names, TEST jobs). The amounts are odd on purpose, so a figure that
 * turns up where it should not is easy to see.
 *
 * What it proves:
 *   - the delete asks for the password again, is rate-limited, and removes everything tied to the account;
 *   - the feed rows that mirror the account's jobs ('local:<jobId>') go too, with their matches, swipes and alerts;
 *   - the fee ledger keeps every row (payer gone, poster gone) and its total stays true;
 *   - a live job (awarded / agreed) has a defined ending for the one who stays, who owes nothing.
 */
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth, RECENT_SIGN_IN_MS } from '../src/auth/index.js';
import type { ScryptCost } from '../src/auth/password.js';
import { openSession } from '../src/auth/sessions.js';
import type { RouteContext } from '../src/context.js';
import { createAccount } from '../src/db/accounts.js';
import type { Db } from '../src/db/db.js';
import { saveProfileForAccount, upsertBids, upsertMatch } from '../src/db/repo.js';
import { SCHEMA_SQL } from '../src/db/schema.js';
import { loadJobRules } from '../src/jobs/config.js';
import { deleteAccount as deleteAccountRows, ledgerTotals, type LedgerTotals } from '../src/jobs/repo.js';
import { deleteAccount, type JobsDeps } from '../src/jobs/service.js';
import { buildProfile, profileIdFor } from '../src/profile/build.js';
import { loadProfile } from '../src/profiles.js';
import { createRealtime, type Realtime } from '../src/realtime/index.js';
import { buildApp, buildServer } from '../src/server.js';
import type { Account } from '../src/types.js';
import { accountsConfig, memoryDb, testBid } from './helpers.js';

const CHEAP: ScryptCost = { ln: 10, r: 8, p: 1 };
const DAY = 86_400_000;
const MIN = 60_000;
const ADMIN = 'TEST-admin-token';
const PASSWORD = 'TEST-correct-horse-battery';
const APP_URL = 'https://bidswipe.example.com';

let db: Db;
let app: FastifyInstance;
let ctx: RouteContext;
let rt: Realtime;
let clock = Date.parse('2026-11-14T18:00:00Z');
const now = () => new Date(clock);

interface Person { account: Account; cookie: string; email: string; ip: string }
let seq = 0;

beforeAll(async () => {
  db = await memoryDb();
  const config = accountsConfig({ adminToken: ADMIN, appUrl: APP_URL });
  const built = await buildApp({ db }, { config, now, auth: createAuth(db, config, { now, cost: CHEAP }) });
  app = built.app;
  ctx = built.ctx;
  rt = createRealtime(ctx, { sender: null, tickMs: 0 });
});
afterAll(async () => {
  rt.stop();
  await app.close();
  await db.close();
});

type Method = 'GET' | 'POST' | 'DELETE' | 'PUT';

/** One request as `who` (their session cookie, their own caller address), the way the web client sends it. */
async function call(who: Person | null, method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method, url,
    headers: {
      'x-bidswipe': '1',
      ...(who ? { cookie: who.cookie, 'x-forwarded-for': who.ip } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return { status: res.statusCode, json: res.body ? res.json() : null, text: res.body, setCookie: String(res.headers['set-cookie'] ?? '') };
}

/** Sign up for real (POST /api/auth/signup), then give the account a business profile near Gardnerville, NV. */
async function join(label: string, trades: string[] = ['electrical']): Promise<Person> {
  const n = ++seq;
  const email = `test.delete.${n}@example.com`;
  const ip = `203.0.113.${n}`; // TEST-NET-3: each person has their own address, so one test's tries never count against another's
  const res = await app.inject({
    method: 'POST', url: '/api/auth/signup', headers: { 'x-bidswipe': '1', 'x-forwarded-for': ip },
    payload: { email, password: PASSWORD, name: `TEST ${label} ${n} (simulated)` },
  });
  expect(res.statusCode).toBe(201);
  const account = res.json().account as Account;
  await saveProfileForAccount(db, account.id, buildProfile(profileIdFor(account.id), {
    businessName: account.name!, trades, zip: '89410', radiusMi: 90, valueRange: { min: 10_000, max: 50_000 },
  }));
  return { account, email, ip, cookie: String(res.headers['set-cookie']).split(';')[0]! };
}

const JOB = {
  title: 'TEST add two outlets (simulated)',
  description: 'Two new outlets on the back wall of the spare room. TEST job (simulated), not a real one.',
  trades: ['electrical'], zip: '89423', address: '1 TEST Lane (simulated)', phone: '775-555-0142', closesInDays: 3,
};

async function post(who: Person, over: Record<string, unknown> = {}): Promise<string> {
  const res = await call(who, 'POST', '/api/jobs', { ...JOB, ...over });
  expect(res.status, res.text).toBe(201);
  return res.json.job.id as string;
}
async function bid(who: Person, jobId: string, amountCents: number): Promise<void> {
  const res = await call(who, 'POST', `/api/jobs/${jobId}/bid`, { amountCents, agree: true });
  expect(res.status, res.text).toBe(200);
}
/** Move the clock past a job's closing time and let the cron tick settle it (award, or no bids). */
async function close(days = 3): Promise<void> {
  clock += days * DAY + MIN;
  await rt.tick();
}
async function agree(poster: Person, winner: Person, jobId: string): Promise<void> {
  expect((await call(winner, 'POST', `/api/jobs/${jobId}/confirm`)).status).toBe(200);
  const res = await call(poster, 'POST', `/api/jobs/${jobId}/confirm`);
  expect(res.json.job.status).toBe('agreed');
}

/** DELETE /api/account as `who`. */
const del = (who: Person, body: unknown = { password: PASSWORD }) => call(who, 'DELETE', '/api/account', body);

const rows = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(sql, params);
const n = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).length;
/** The ledger rows of the given jobs (the database is shared by every test in this file). */
const fees = (jobIds: string[]) => rows<{
  job_id: string; kind: string; payer_id: string | null; payer_ref: string | null; payer_name: string | null; payer_deleted_at: unknown;
  amount_cents: string | number; poster_share_cents: string | number; status: string;
}>('select * from job_fees where job_id = any($1) order by id', [jobIds]);
/** What the ledger gained since `base`: each test reads its own part of the one ledger. */
async function ledgerSince(base: LedgerTotals): Promise<LedgerTotals> {
  const t = await ledgerTotals(db);
  return {
    rows: t.rows - base.rows, payerGone: t.payerGone - base.payerGone, recordedCents: t.recordedCents - base.recordedCents,
    waivedCents: t.waivedCents - base.waivedCents, posterShareCents: t.posterShareCents - base.posterShareCents, platformCents: t.platformCents - base.platformCents,
  };
}
const alertsOf = (p: Person) =>
  rows<{ kind: string; title: string; body: string; bid_id: string | null; data: { jobId?: string; outcome?: string } }>(
    'select kind, title, body, bid_id, data from alerts where profile_id = $1 order by id', [profileIdFor(p.account.id)]);
const deps = (): JobsDeps => ({ db, bus: ctx.bus, rules: loadJobRules(() => undefined), appUrl: APP_URL });

// ------------------------------------------------------------------------------------------------------------

describe('who may delete, and how it is confirmed', () => {
  it('single mode has no accounts: both routes answer 404', async () => {
    const single = await buildServer({ db, profile: loadProfile('lm-electric') }, {});
    for (const [method, url] of [['GET', '/api/account/deletion'], ['DELETE', '/api/account']] as const) {
      const res = await single.inject({ method, url, headers: { 'x-bidswipe': '1' } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    await single.close();
  });

  it('signed out: 401. With the cookie but without the x-bidswipe header: 403 csrf, and nothing is deleted', async () => {
    const p = await join('Guarded');
    expect(await call(null, 'DELETE', '/api/account', { password: PASSWORD })).toMatchObject({ status: 401, json: { error: 'sign_in_required' } });
    expect(await call(null, 'GET', '/api/account/deletion')).toMatchObject({ status: 401, json: { error: 'sign_in_required' } });
    const forged = await app.inject({ method: 'DELETE', url: '/api/account', headers: { cookie: p.cookie }, payload: { password: PASSWORD } });
    expect(forged.statusCode).toBe(403);
    expect(forged.json()).toEqual({ error: 'csrf' });
    expect(await n('select 1 from accounts where id = $1', [p.account.id])).toBe(1);
  });

  it('asks for the password again: a wrong or missing one deletes nothing, the right one deletes the account', async () => {
    const p = await join('Owner');
    const preview = await call(p, 'GET', '/api/account/deletion');
    expect(preview.json).toEqual({
      confirmWith: 'password', email: p.email,
      ends: { jobsPosted: 0, openPosted: 0, bidsOnOpenPosted: 0, livePosted: [], liveWon: [], activeBids: 0, feeLines: 0, feeCents: 0 },
    });

    for (const body of [{ password: 'TEST-not-my-password' }, {}, { password: '' }, { password: 12345678 }, { confirm: p.email }]) {
      const res = await del(p, body);
      expect(res, JSON.stringify(body)).toMatchObject({ status: 401, json: { error: 'wrong_password' } });
      expect(res.json.message).toMatch(/not deleted/);
      expect(res.setCookie).not.toMatch(/Max-Age=0/);
    }
    expect((await call(p, 'GET', '/api/me')).status).toBe(200);

    clock += 16 * MIN; // five tries were used up: a new window
    const done = await del(p);
    expect(done).toMatchObject({ status: 200, json: { ok: true } });
    expect(done.setCookie).toMatch(/^bs_session=; .*Max-Age=0/); // the browser drops its cookie
    expect(await n('select 1 from accounts where id = $1 or email = $2', [p.account.id, p.email])).toBe(0);

    // The old cookie is nobody now, the old sign-in is nobody's, and a second delete finds nothing to delete.
    expect((await call(p, 'GET', '/api/me')).status).toBe(401);
    expect((await del(p)).status).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-bidswipe': '1', 'x-forwarded-for': p.ip }, payload: { email: p.email, password: PASSWORD } });
    expect(login.statusCode).toBe(401);
    expect(await deleteAccount(deps(), p.account.id, clock)).toBe(false);

    // The address is free again, and the new account starts empty.
    const again = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: { 'x-bidswipe': '1', 'x-forwarded-for': p.ip }, payload: { email: p.email, password: PASSWORD } });
    expect(again.statusCode).toBe(201);
    expect(again.json().account.id).not.toBe(p.account.id);
    const me = await app.inject({ url: '/api/me', headers: { cookie: String(again.headers['set-cookie']).split(';')[0]! } });
    expect(me.json()).toMatchObject({ needsOnboarding: true, profile: null });
  });

  it('five tries in 15 minutes, then 429 even with the right password: it cannot be used to guess a password', async () => {
    const p = await join('Guessed');
    for (let i = 0; i < 5; i++) expect((await del(p, { password: `TEST-guess-${i}` })).status).toBe(401);
    const blocked = await del(p);
    expect(blocked).toMatchObject({ status: 429, json: { error: 'too_many_attempts' } });
    expect(blocked.json.message).toMatch(/not deleted/);
    expect(await n('select 1 from accounts where id = $1', [p.account.id])).toBe(1);
    clock += 15 * MIN;
    expect((await del(p)).status).toBe(200);
  });

  it('an account with no password confirms with a sign-in from the last 10 minutes and its own email', async () => {
    const id = `TEST-provider-${++seq}`;
    const email = `test.provider.${seq}@example.com`;
    const account = (await createAccount(db, { id, email, name: 'TEST Provider (simulated)', passwordHash: null }, now(), { provider: 'google', subject: `TEST-sub-${seq}` }))!;
    const p: Person = { account, email, ip: `203.0.113.${seq}`, cookie: `bs_session=${await openSession(db, id, now())}` };

    expect((await call(p, 'GET', '/api/account/deletion')).json).toMatchObject({ confirmWith: 'recent_sign_in', email });
    // Fresh session, but the email is not typed (a password proves nothing here: the account has none).
    expect(await del(p, { password: PASSWORD })).toMatchObject({ status: 400, json: { error: 'confirm_mismatch' } });
    expect(await del(p, { confirm: 'test.someone.else@example.com' })).toMatchObject({ status: 400, json: { error: 'confirm_mismatch' } });

    // The session gets old: the same request is refused until they sign in again.
    clock += RECENT_SIGN_IN_MS + 1000;
    const stale = await del(p, { confirm: email });
    expect(stale).toMatchObject({ status: 403, json: { error: 'recent_sign_in_required' } });
    expect(stale.json.message).toMatch(/sign in again/);
    expect(await n('select 1 from accounts where id = $1', [id])).toBe(1);

    clock += 16 * MIN;
    p.cookie = `bs_session=${await openSession(db, id, now())}`; // signed in again
    expect((await del(p, { confirm: `  ${email.toUpperCase()} ` })).status).toBe(200);
    expect(await n('select 1 from accounts where id = $1', [id])).toBe(0);
    expect(await n('select 1 from identities where account_id = $1', [id])).toBe(0);
  });
});

describe('everything tied to the account goes', () => {
  it('profile, scores, swipes, alerts, cost checks, sessions, devices, work profile, promo and reset rows: all gone; a neighbour keeps theirs', async () => {
    const p = await join('Leaver');
    const keep = await join('Neighbour');
    const pid = profileIdFor(p.account.id);
    const kid = profileIdFor(keep.account.id);

    // A public bid both of them scored, swiped and were alerted about. TEST- id, example.com link.
    const pub = testBid({ title: 'TEST public bid for the delete test (synthetic)' });
    await upsertBids(db, [pub]);
    for (const profile of [pid, kid]) {
      await upsertMatch(db, profile, pub.id, { score: 80, verdict: 'great', reasons: [], distanceMi: 12, overLimit: false, rejected: null });
      await rows("insert into swipes (profile_id, bid_id, action) values ($1, $2, 'save')", [profile, pub.id]);
      await rows("insert into alerts (profile_id, kind, bid_id, dedupe_key, title, body) values ($1, 'match', $2, 'TEST-k', 'TEST alert', 'TEST')", [profile, pub.id]);
      await rows("insert into estimates (profile_id, bid_id, inputs, result) values ($1, $2, '{}'::jsonb, '{}'::jsonb)", [profile, pub.id]);
    }
    for (const a of [p, keep]) {
      await rows("insert into push_subscriptions (endpoint, account_id, keys) values ($1, $2, '{}'::jsonb)", [`https://push.example.com/TEST-${a.account.id}`, a.account.id]);
      await rows("insert into promo_redemptions (account_id, code_key, plan) values ($1, 'TEST-code-key', 'pro')", [a.account.id]);
      await rows("insert into password_resets (token_hash, account_id, created_at, expires_at) values ($1, $2, now(), now() + interval '1 hour')", [`TEST-hash-${a.account.id}`, a.account.id]);
      expect((await call(a, 'PUT', '/api/work-profile', { headline: 'TEST headline (simulated)' })).status).toBe(200);
    }
    // A second device signed in to the leaver's account.
    const phone = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-bidswipe': '1', 'x-forwarded-for': p.ip }, payload: { email: p.email, password: PASSWORD } });
    const phoneCookie = String(phone.headers['set-cookie']).split(';')[0]!;
    expect(await n('select 1 from sessions where account_id = $1', [p.account.id])).toBe(2);

    expect((await del(p)).status).toBe(200);

    const owned: Array<[string, string, string]> = [
      ['profiles', 'account_id', p.account.id], ['sessions', 'account_id', p.account.id], ['push_subscriptions', 'account_id', p.account.id],
      ['promo_redemptions', 'account_id', p.account.id], ['password_resets', 'account_id', p.account.id], ['work_profiles', 'account_id', p.account.id],
      ['matches', 'profile_id', pid], ['swipes', 'profile_id', pid], ['alerts', 'profile_id', pid], ['estimates', 'profile_id', pid],
    ];
    for (const [table, col, id] of owned) expect(await n(`select 1 from ${table} where ${col} = $1`, [id]), table).toBe(0);
    // Both devices are signed out.
    expect((await app.inject({ url: '/api/me', headers: { cookie: phoneCookie } })).statusCode).toBe(401);

    // The neighbour lost nothing, and the public bid is still a bid.
    for (const [table, col] of [['matches', 'profile_id'], ['swipes', 'profile_id'], ['alerts', 'profile_id'], ['estimates', 'profile_id']] as const) {
      expect(await n(`select 1 from ${table} where ${col} = $1`, [kid]), table).toBe(1);
    }
    for (const table of ['push_subscriptions', 'promo_redemptions', 'password_resets', 'work_profiles', 'sessions', 'profiles']) {
      expect(await n(`select 1 from ${table} where account_id = $1`, [keep.account.id]), table).toBe(1);
    }
    expect(await n('select 1 from bids where id = $1', [pub.id])).toBe(1);
    expect((await call(keep, 'GET', '/api/me')).status).toBe(200);
  });
});

describe("the feed rows that mirror the account's jobs (local:<jobId>)", () => {
  it('go with the account, with their scores, swipes and alerts, for everybody; sealed bidders are left one line', async () => {
    const poster = await join('Poster', ['plumbing']);
    const sparky = await join('Sparky');
    const stranger = await join('Stranger', ['roofing']);

    const open = await post(poster, { title: 'TEST open job that goes with its poster (simulated)' });
    const old = await post(poster, { title: 'TEST job nobody bid on (simulated)', closesInDays: 1 });
    clock += DAY + MIN;
    await rt.tick(); // `old` closes with no bids: unfilled, its mirror row stays in `bids` (closed)
    await bid(sparky, open, 41_300);
    expect((await call(sparky, 'POST', '/api/swipe', { bidId: `local:${open}`, action: 'save' })).status).toBe(200);

    // What is there before: two mirror rows, the electrician's score, swipe and "new job" alert for the open one.
    const mirrors = [`local:${open}`, `local:${old}`];
    const sid = profileIdFor(sparky.account.id);
    expect(await n('select 1 from bids where id = any($1)', [mirrors])).toBe(2);
    expect(await n('select 1 from matches where profile_id = $1 and bid_id = $2', [sid, mirrors[0]])).toBe(1);
    expect(await n('select 1 from swipes where profile_id = $1 and bid_id = $2', [sid, mirrors[0]])).toBe(1);
    expect((await alertsOf(sparky)).filter((a) => a.bid_id === mirrors[0])).toHaveLength(1);
    expect((await call(sparky, 'GET', '/api/feed?all=1&sources=local&limit=200')).json.items.map((i: { id: string }) => i.id)).toContain(mirrors[0]);
    // A public bid the electrician saved: it must survive.
    const pub = testBid({ title: 'TEST public bid that stays (synthetic)' });
    await upsertBids(db, [pub]);
    await upsertMatch(db, sid, pub.id, { score: 70, verdict: 'good', reasons: [], distanceMi: 9, overLimit: false, rejected: null });
    await rows("insert into swipes (profile_id, bid_id, action) values ($1, $2, 'save')", [sid, pub.id]);

    expect((await call(poster, 'GET', '/api/account/deletion')).json.ends).toMatchObject({ jobsPosted: 2, openPosted: 1, bidsOnOpenPosted: 1, livePosted: [], activeBids: 0 });
    expect((await del(poster)).status).toBe(200);

    // Not one row keyed by a mirror id is left, in any table that carries a bid id.
    expect(await n('select 1 from bids where id = any($1)', [mirrors])).toBe(0);
    for (const table of ['matches', 'swipes', 'alerts']) expect(await n(`select 1 from ${table} where bid_id = any($1)`, [mirrors]), table).toBe(0);
    expect(await n("select 1 from bids where source = 'local' and source_id = any($1)", [[open, old]])).toBe(0);
    expect(await n('select 1 from jobs where id = any($1)', [[open, old]])).toBe(0);
    expect(await n('select 1 from job_bids where job_id = any($1)', [[open, old]])).toBe(0);
    // The feed, Saved and the bid sheet no longer know them; the public bid is untouched.
    expect((await call(sparky, 'GET', '/api/feed?all=1&sources=local&limit=200')).json.items.map((i: { id: string }) => i.id)).not.toContain(mirrors[0]);
    expect((await call(sparky, 'GET', `/api/bids/${encodeURIComponent(mirrors[0]!)}`)).status).toBe(404);
    const saved = (await call(sparky, 'GET', '/api/saved')).json.items.map((i: { id: string }) => i.id);
    expect(saved).toEqual([pub.id]);

    // The electrician's sealed bid did not just vanish: one line says what happened, to them only.
    const gone = await call(sparky, 'GET', `/api/jobs/${open}`);
    expect(gone.status).toBe(410);
    expect(gone.json).toMatchObject({
      error: 'gone', gone: { id: open, title: 'TEST open job that goes with its poster (simulated)', role: 'bidder', was: 'open', amountCents: 41_300, feeWaivedCents: null },
    });
    expect(gone.json.message).toMatch(/deleted their BidSwipe account before bidding closed.*sealed bid is closed/);
    expect((await call(sparky, 'GET', '/api/jobs/mine')).json).toMatchObject({ posted: [], bidding: [], ended: [{ id: open, role: 'bidder' }] });
    expect((await alertsOf(sparky)).at(-1)).toMatchObject({ kind: 'job_closed', title: expect.stringMatching(/^Taken down: TEST open job/), data: { jobId: open, outcome: 'poster_left' } });
    // Nobody else gets that line: for a stranger, and for the job nobody bid on, the job simply is not there.
    expect((await call(stranger, 'GET', `/api/jobs/${open}`)).status).toBe(404);
    expect((await call(sparky, 'GET', `/api/jobs/${old}`)).status).toBe(404);
    // An action on the vanished job is a plain 404, never a crash.
    expect((await call(sparky, 'POST', `/api/jobs/${open}/bid`, { amountCents: 40_000, agree: true })).status).toBe(404);
  });
});

describe('the fee ledger after a deletion', () => {
  it('the PAYER deletes their account: every fee row stays, with who it was, and the total does not move', async () => {
    const base = await ledgerTotals(db);
    const poster = await join('Poster', ['plumbing']);
    const payer = await join('Payer');

    // 1. A no-show: the payer wins and never makes contact. 5% of $377.00 = $18.85, of which 2% ($7.54) is the poster's.
    const noShow = await post(poster, { title: 'TEST job with a no-show (simulated)' });
    await bid(payer, noShow, 37_700);
    await close();
    clock += 7 * DAY + MIN;
    await rt.tick();
    // 2. An agreed job: 1% of $291.00 = $2.91 service fee.
    const agreed = await post(poster, { title: 'TEST job agreed, then the winner leaves (simulated)' });
    await bid(payer, agreed, 29_100);
    await close();
    await agree(poster, payer, agreed);

    const before = await ledgerSince(base);
    expect(before).toEqual({ rows: 2, payerGone: 0, recordedCents: 1_885 + 291, waivedCents: 0, posterShareCents: 754, platformCents: 1_885 + 291 - 754 });
    const wholeBefore = await ledgerTotals(db);
    expect((await call(payer, 'GET', '/api/account/deletion')).json.ends).toMatchObject({
      liveWon: [{ title: 'TEST job agreed, then the winner leaves (simulated)', status: 'agreed', awardCents: 29_100 }], feeLines: 2, feeCents: 2_176,
    });

    expect((await del(payer)).status).toBe(200);

    // The ledger: same rows, same money, and each row still says who owed it. Never the email.
    const after = await ledgerTotals(db);
    expect(after).toEqual({ ...wholeBefore, payerGone: wholeBefore.payerGone + 2 });
    expect(await ledgerSince(base)).toEqual({ ...before, payerGone: 2 });
    const kept = await fees([noShow, agreed]);
    expect(kept.map((f) => [f.job_id, f.kind, Number(f.amount_cents), f.status])).toEqual([[noShow, 'no_show', 1_885, 'recorded'], [agreed, 'service', 291, 'recorded']]);
    for (const f of kept) {
      expect(f.payer_id).toBeNull();
      expect(f.payer_ref).toBe(payer.account.id);
      expect(f.payer_name).toBe(payer.account.name);
      expect(f.payer_deleted_at).not.toBeNull();
    }
    expect(JSON.stringify(kept)).not.toContain(payer.email);
    // The operator's ledger shows the same thing.
    const admin = await app.inject({ url: '/api/admin/jobs/fees', headers: { 'x-admin-token': ADMIN } });
    expect(admin.json().totals).toEqual(after);
    const mine = admin.json().fees.filter((f: { jobId: string }) => f.jobId === noShow || f.jobId === agreed);
    expect(mine.map((f: { payerId: string | null; payerName: string | null; payerRef: string }) => [f.payerId, f.payerName, f.payerRef]))
      .toEqual([[null, payer.account.name, payer.account.id], [null, payer.account.name, payer.account.id]]);
    expect(admin.body).not.toContain(payer.email);

    // The poster still sees both fees on their jobs, as recorded and not theirs.
    const noShowView = (await call(poster, 'GET', `/api/jobs/${noShow}`)).json.job;
    expect(noShowView).toMatchObject({ status: 'unfilled', outcome: 'bidder_no_show', fees: [{ kind: 'no_show', amountCents: 1_885, posterShareCents: 754, status: 'recorded', owedByMe: false }] });

    // The agreed job had a defined ending for the poster: it is over, they owe nothing, they can post it again.
    const agreedView = (await call(poster, 'GET', `/api/jobs/${agreed}`)).json;
    expect(agreedView.job).toMatchObject({
      status: 'unfilled', outcome: 'bidder_left', my: { role: 'poster' },
      award: { amountCents: 29_100, winner: null }, fees: [{ kind: 'service', amountCents: 291, status: 'recorded', owedByMe: false }],
    });
    expect(agreedView.messages).toEqual([]);
    const told = (await alertsOf(poster)).at(-1)!;
    expect(told).toMatchObject({ kind: 'job_closed', title: expect.stringMatching(/^The winner left BidSwipe: TEST job agreed/), data: { jobId: agreed, outcome: 'bidder_left' } });
    expect(told.body).toMatch(/Nothing is owed\. You can post it again/);
    expect((await call(poster, 'POST', `/api/jobs/${agreed}/repost`, { closesInDays: 3 })).status).toBe(201);

    // Settling again changes nothing: no second fee, no other ending. (20 days: the poster's session lives 30.)
    clock += 20 * DAY;
    await rt.tick();
    expect(await ledgerTotals(db)).toEqual(after);
    expect((await call(poster, 'GET', `/api/jobs/${agreed}`)).json.job).toMatchObject({ status: 'unfilled', outcome: 'bidder_left' });
  });

  it('the winner deletes their account while the job is AWARDED: it goes back to the poster and no fee is recorded', async () => {
    const poster = await join('Poster', ['plumbing']);
    const winner = await join('Winner');
    const loser = await join('Loser');
    const job = await post(poster, { title: 'TEST job handed back by a deletion (simulated)' });
    await bid(winner, job, 33_300);
    await bid(loser, job, 44_400);
    await close();
    expect((await call(winner, 'POST', `/api/jobs/${job}/messages`, { body: 'TEST hello from the winner' })).status).toBe(200);
    expect((await call(poster, 'POST', `/api/jobs/${job}/messages`, { body: 'TEST hello from the poster' })).status).toBe(200);
    const ledger = await ledgerTotals(db);

    expect((await del(winner)).status).toBe(200);

    const view = (await call(poster, 'GET', `/api/jobs/${job}`)).json;
    expect(view.job).toMatchObject({ status: 'unfilled', outcome: 'bidder_left', fees: [], award: { amountCents: 33_300, winner: null } });
    expect(view.job.tab.map((r: { amountCents: number }) => r.amountCents)).toEqual([44_400]); // the winner's bid went with them
    expect(view.messages).toEqual([]); // the thread is closed; the winner's messages are deleted
    expect(await n('select 1 from job_messages where job_id = $1 and sender_id = $2', [job, winner.account.id])).toBe(0);
    expect(await ledgerTotals(db)).toEqual(ledger);
    // The poster's private details are theirs alone again, and the losing bidder sees how it ended.
    expect((await call(loser, 'GET', `/api/jobs/${job}`)).json.job).toMatchObject({ status: 'unfilled', outcome: 'bidder_left', private: null, fees: [] });

    // The contact deadline passes: the rules must not turn this into a no-show with a fee after the fact.
    clock += 8 * DAY;
    await rt.tick();
    expect((await call(poster, 'GET', `/api/jobs/${job}`)).json.job).toMatchObject({ status: 'unfilled', outcome: 'bidder_left', fees: [] });
    expect(await ledgerTotals(db)).toEqual(ledger);
  });

  it('the POSTER deletes their account: their jobs go, the fee rows stay, and the ones who stayed owe nothing', async () => {
    const base = await ledgerTotals(db);
    const poster = await join('Poster', ['plumbing']);
    const past = await join('Past winner');
    const agreedWith = await join('Agreed winner');
    const awardedTo = await join('Awarded winner');

    // History: a completed job (service fee, 1% of $415.00 = $4.15) and a no-show (5% of $263.00 = $13.15, $5.26 the poster's).
    const done = await post(poster, { title: 'TEST job done long ago (simulated)' });
    const missed = await post(poster, { title: 'TEST job with an old no-show (simulated)' });
    await bid(past, done, 41_500);
    await bid(past, missed, 26_300);
    await close();
    await agree(poster, past, done);
    expect((await call(poster, 'POST', `/api/jobs/${done}/complete`)).json.job.status).toBe('completed');
    clock += 7 * DAY + MIN;
    await rt.tick();
    // Live: an agreed job (service fee already recorded for its winner: 1% of $529.00 = $5.29) and an awarded one.
    const agreed = await post(poster, { title: 'TEST job agreed, then the poster leaves (simulated)' });
    const awarded = await post(poster, { title: 'TEST job awarded, then the poster leaves (simulated)' });
    await bid(agreedWith, agreed, 52_900);
    await bid(awardedTo, awarded, 31_700);
    await close();
    await agree(poster, agreedWith, agreed);

    const before = await ledgerSince(base);
    expect(before).toMatchObject({ rows: 3, recordedCents: 415 + 1_315 + 529, waivedCents: 0 });
    const preview = (await call(poster, 'GET', '/api/account/deletion')).json.ends;
    expect(preview).toMatchObject({ jobsPosted: 4, openPosted: 0, feeLines: 0 });
    expect(preview.livePosted.map((j: { status: string }) => j.status).sort()).toEqual(['agreed', 'awarded']);

    expect((await del(poster)).status).toBe(200);

    // The jobs are gone with everything on them...
    const ids = [done, missed, agreed, awarded];
    for (const table of ['job_bids', 'job_messages', 'job_reports']) expect(await n(`select 1 from ${table} where job_id = any($1)`, [ids]), table).toBe(0);
    expect(await n('select 1 from jobs where id = any($1)', [ids])).toBe(0);
    expect(await n('select 1 from bids where id = any($1)', [ids.map((id) => `local:${id}`)])).toBe(0);
    // ...and the ledger kept all three rows. Old fees stand; the fee of the job that was live is waived, not erased.
    const after = await ledgerSince(base);
    expect(after).toMatchObject({ rows: 3, payerGone: 0, recordedCents: 415 + 1_315, waivedCents: 529, posterShareCents: 526 });
    expect(after.recordedCents + after.waivedCents).toBe(before.recordedCents + before.waivedCents);
    const whole = await ledgerTotals(db);
    expect((await fees(ids)).map((f) => [f.job_id, f.kind, f.payer_id, f.status])).toEqual([
      [done, 'service', past.account.id, 'recorded'], [missed, 'no_show', past.account.id, 'recorded'], [agreed, 'service', agreedWith.account.id, 'waived'],
    ]);

    // The winner of the agreed job: one clear line, and the fee that was recorded for them is waived.
    const a = await call(agreedWith, 'GET', `/api/jobs/${agreed}`);
    expect(a.status).toBe(410);
    expect(a.json.gone).toMatchObject({ role: 'winner', was: 'agreed', amountCents: 52_900, feeWaivedCents: 529, title: 'TEST job agreed, then the poster leaves (simulated)' });
    expect(a.json.message).toMatch(/deleted their BidSwipe account, so the job ended here\. You owe nothing\. The service fee of \$5\.29 .* was waived\./);
    // The winner of the awarded job: the same line, and no fee, now or at the deadline that will never come.
    const w = await call(awardedTo, 'GET', `/api/jobs/${awarded}`);
    expect(w.status).toBe(410);
    expect(w.json.gone).toMatchObject({ role: 'winner', was: 'awarded', amountCents: 31_700, feeWaivedCents: null });
    expect(w.json.message).toMatch(/You owe nothing\.$/);
    for (const [who, job] of [[agreedWith, agreed], [awardedTo, awarded]] as const) {
      expect((await call(who, 'GET', '/api/jobs/mine')).json).toMatchObject({ bidding: [], ended: [{ id: job, role: 'winner' }] });
      expect((await alertsOf(who)).at(-1)).toMatchObject({ kind: 'job_closed', body: expect.stringMatching(/deleted their BidSwipe account.*Nothing is owed/), data: { jobId: job, outcome: 'poster_left' } });
      // Nothing can be done to a job that is gone.
      expect((await call(who, 'POST', `/api/jobs/${job}/messages`, { body: 'TEST anyone there?' })).status).toBe(404);
      expect((await call(who, 'POST', `/api/jobs/${job}/back-out`)).status).toBe(404);
    }
    // The line is theirs alone.
    expect((await call(past, 'GET', `/api/jobs/${agreed}`)).status).toBe(404);

    clock += 30 * DAY;
    await rt.tick();
    expect(await ledgerTotals(db)).toEqual(whole);
    expect(await n('select 1 from job_fees where payer_id = $1', [awardedTo.account.id])).toBe(0);
  });

  it('a sealed bidder deletes their account while the job is open: their bid is simply gone and the next lowest wins', async () => {
    const poster = await join('Poster', ['plumbing']);
    const leaver = await join('Low bidder');
    const stays = await join('Next bidder');
    const job = await post(poster, { title: 'TEST job where the low bidder leaves (simulated)' });
    await bid(leaver, job, 21_100);
    await bid(stays, job, 23_300);
    expect((await call(leaver, 'GET', '/api/account/deletion')).json.ends).toMatchObject({ activeBids: 1, jobsPosted: 0, liveWon: [] });
    expect((await del(leaver)).status).toBe(200);
    expect((await call(poster, 'GET', `/api/jobs/${job}`)).json.job).toMatchObject({ status: 'open', bidCount: 1 });
    await close();
    expect((await call(stays, 'GET', `/api/jobs/${job}`)).json.job).toMatchObject({ status: 'awarded', award: { amountCents: 23_300, isMe: true } });
  });
});

describe('the words on screen (web/js/job-words.js)', () => {
  // web/js is plain JavaScript with no type declarations; a computed path keeps tsc from asking for them.
  const modulePath = '../web/js/job-words.js';

  it('say why the job ended, and that the one who stayed owes nothing', async () => {
    const words = await import(modulePath);
    // The poster's job after its winner deleted their account.
    const job = {
      status: 'unfilled', outcome: 'bidder_left', closesAt: '2026-11-12T20:00:00Z', bidCount: 1,
      my: { role: 'poster', bid: null }, award: { amountCents: 20_500, contactDeadline: '2026-11-19T20:00:00Z' },
    };
    expect(words.endedWords(job)).toBe('The winner deleted their account');
    expect(words.stage(job, { now: Date.parse('2026-11-14T00:00:00Z') })).toEqual({
      group: 'needs', status: 'The winner deleted their account', next: 'You owe nothing. You can post it again with one tap.',
    });
    expect(words.stage(job, { now: Date.parse('2026-11-14T00:00:00Z'), reposted: true }).next).toBe('Posted again.');
    // The line left for someone whose job's poster deleted their account.
    expect(words.GONE_TITLE).toBe('The poster deleted their account');
    expect(words.goneWords({ role: 'winner', feeWaivedCents: null })).toBe('The job ended here. You owe nothing.');
    expect(words.goneWords({ role: 'winner', feeWaivedCents: 529 })).toBe('The job ended here. You owe nothing: the service fee of $5.29 that was recorded for you was waived.');
    expect(words.goneWords({ role: 'bidder', feeWaivedCents: null })).toBe('The job was taken down before bidding closed. Your sealed bid is closed.');
  });
});

describe('the one statement', () => {
  it('changes nothing for an id that is not an account, and nothing the second time', async () => {
    const before = await ledgerTotals(db);
    const counts = async () => Promise.all(['accounts', 'jobs', 'bids', 'job_tombstones', 'alerts'].map((t) => n(`select 1 from ${t}`)));
    const was = await counts();
    const nothing = { deleted: false, wonEnded: [], leftBehind: [], jobsRemoved: 0, mirrorsRemoved: 0, feesKept: 0, feesWaived: 0 };
    expect(await deleteAccountRows(db, 'TEST-no-such-account', clock)).toEqual(nothing);
    expect(await counts()).toEqual(was);
    expect(await ledgerTotals(db)).toEqual(before);
  });
});

describe('a database from before account deletion existed', () => {
  it('is upgraded in place: fee rows stop cascading, keep their payer, and the new ending is allowed', async () => {
    const pg = new PGlite('memory://');
    try {
      await pg.exec(SCHEMA_SQL);
      // Put job_fees and jobs back the way the 2026-11-14 schema made them: both foreign keys cascade, the payer
      // is NOT NULL, there is no snapshot of who it was, and 'bidder_left' is not an ending.
      await pg.exec(`
        drop table job_tombstones;
        alter table job_fees drop constraint job_fees_payer_id_fkey;
        alter table job_fees add constraint job_fees_payer_id_fkey foreign key (payer_id) references accounts(id) on delete cascade;
        alter table job_fees add constraint job_fees_job_id_fkey foreign key (job_id) references jobs(id) on delete cascade;
        alter table job_fees alter column payer_id set not null;
        alter table job_fees drop column payer_ref, drop column payer_name, drop column payer_deleted_at;
        alter table jobs drop constraint jobs_outcome_check;
        alter table jobs add constraint jobs_outcome_check check (outcome is null or outcome in
          ('no_bids', 'bidder_no_show', 'bidder_backed_out', 'poster_no_show', 'no_agreement', 'poster_cancelled'));
        insert into accounts (id, email, name) values ('TEST-old-poster', 'test.old.poster@example.com', 'TEST Old Poster (simulated)'),
                                                      ('TEST-old-payer', 'test.old.payer@example.com', 'TEST Old Payer (simulated)');
        insert into jobs (id, poster_id, title, description, zip, city, state, posted_at, closes_at, status, outcome, winner_id, award_cents)
          values ('TEST-old-job', 'TEST-old-poster', 'TEST old job (simulated)', 'TEST', '89423', 'Minden', 'NV', now(), now(), 'unfilled', 'bidder_no_show', 'TEST-old-payer', 30000);
        insert into job_fees (job_id, kind, payer_id, basis_cents, rate_ppm, amount_cents, poster_share_ppm, poster_share_cents, platform_cents, created_at)
          values ('TEST-old-job', 'no_show', 'TEST-old-payer', 30000, 50000, 1500, 20000, 600, 900, now());
      `);
      await pg.exec(SCHEMA_SQL);
      await pg.exec(SCHEMA_SQL); // and it is safe to run at every start

      // The row from before knows its payer by reference now.
      expect((await pg.query('select payer_id, payer_ref from job_fees')).rows).toEqual([{ payer_id: 'TEST-old-payer', payer_ref: 'TEST-old-payer' }]);
      const fks = await pg.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'job_fees'::regclass and contype = 'f'");
      expect(fks.rows.map((r) => r.def)).toEqual(['FOREIGN KEY (payer_id) REFERENCES accounts(id) ON DELETE SET NULL']);

      // The payer goes, then the poster (and the job): the fee row outlives both.
      const old: Db = { kind: 'pglite', query: async (sql, params = []) => (await pg.query(sql, params as never[])).rows as never, exec: async (sql) => void (await pg.exec(sql)), close: async () => {} };
      expect((await deleteAccountRows(old, 'TEST-old-payer', Date.now())).feesKept).toBe(1);
      expect((await deleteAccountRows(old, 'TEST-old-poster', Date.now())).jobsRemoved).toBe(1);
      expect((await pg.query('select 1 from jobs')).rows).toHaveLength(0);
      expect((await pg.query('select job_id, payer_id, payer_ref, payer_name, amount_cents::int as amount, status from job_fees')).rows).toEqual([
        { job_id: 'TEST-old-job', payer_id: null, payer_ref: 'TEST-old-payer', payer_name: 'TEST Old Payer (simulated)', amount: 1500, status: 'recorded' },
      ]);
      // The new ending is storable.
      await pg.exec(`
        insert into accounts (id, email) values ('TEST-new-poster', 'test.new.poster@example.com');
        insert into jobs (id, poster_id, title, description, zip, city, state, posted_at, closes_at, status, outcome)
          values ('TEST-new-job', 'TEST-new-poster', 'TEST', 'TEST', '89423', 'Minden', 'NV', now(), now(), 'unfilled', 'bidder_left');
      `);
    } finally {
      await pg.close();
    }
  });
});
