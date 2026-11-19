/**
 * GET /api/admin/usage (docs/PLAN.md N11): counts only, never an id, e-mail, name or text; every count real, 0 said
 * as 0. Return visits come from table account_days (one row per account per day it made a signed-in request, on its
 * own clock: src/db/usage.ts); the rest from alerts, swipes, profiles and the jobs tables. Everyone here is synthetic (TEST-
 * accounts at example.com, TEST- bids, "(simulated)" jobs), on an injected clock.
 */
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countsAsVisit, type RouteContext } from '../src/context.js';
import type { Db } from '../src/db/db.js';
import { saveProfileForAccount, upsertBids, upsertMatches, upsertProfile } from '../src/db/repo.js';
import { createVisitLog, decisionDays, localDay, returnVisits, windowStart } from '../src/db/usage.js';
import { ALL_ALERT_KINDS, buildProfile, profileIdFor } from '../src/profile/build.js';
import { loadProfile } from '../src/profiles.js';
import { scoreBid } from '../src/score/score.js';
import { buildApp, buildServer } from '../src/server.js';
import type { Account, Bid } from '../src/types.js';
import { accountsConfig, memoryDb, seedAccount, testBid } from './helpers.js';

const ADMIN = 'TEST-admin-token-usage';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Wednesday 2026-11-18, 20:00 UTC (12:00 PST). The 7-day window starts 2026-11-12 00:00 UTC, the 28-day one 2026-10-22. */
const NOW = Date.parse('2026-11-18T20:00:00Z');
const at = (isoDay: string, hhmm = '17:00') => Date.parse(`${isoDay}T${hhmm}:00Z`);

interface World {
  db: Db;
  app: FastifyInstance;
  ctx: RouteContext;
  clock: number;
  byId: Map<string, Account>;
  call(who: Account | null, method: 'GET' | 'POST', url: string, body?: unknown, when?: number): Promise<{ status: number; json: any }>;
}

async function world(): Promise<World> {
  const db = await memoryDb();
  const byId = new Map<string, Account>();
  const w = { db, byId, clock: NOW } as World;
  const built = await buildApp({ db }, {
    config: accountsConfig({ adminToken: ADMIN, appUrl: 'https://bidswipe.example.com' }),
    auth: { authenticate: async (req) => { const as = req.headers['x-test-as']; return typeof as === 'string' ? (byId.get(as) ?? null) : null; } },
    now: () => new Date(w.clock),
  });
  w.app = built.app;
  w.ctx = built.ctx;
  w.call = async (who, method, url, body, when) => {
    if (when !== undefined) w.clock = when;
    if (who) byId.set(who.id, who);
    const res = await w.app.inject({
      method, url, headers: { 'x-bidswipe': '1', ...(who ? { 'x-test-as': who.id } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    return { status: res.statusCode, json: res.body ? res.json() : null };
  };
  return w;
}

async function onboard(db: Db, a: Account, kinds?: Record<string, boolean>, timeZone?: string): Promise<string> {
  const p = buildProfile(profileIdFor(a.id), { businessName: `${a.name}`, trades: ['electrical'], zip: '89410', radiusMi: 90, valueRange: { min: 10_000, max: 50_000 } });
  if (kinds) p.alerts = { ...p.alerts, kinds: { ...p.alerts?.kinds, ...kinds } };
  if (timeZone) p.alerts = { ...p.alerts, timeZone };
  return (await saveProfileForAccount(db, a.id, p)).id;
}

const usage = (w: World, token: string | null = ADMIN) => w.app.inject({ method: 'GET', url: '/api/admin/usage', headers: token ? { 'x-admin-token': token } : {} });

/** Every leaf of the answer is a number or null, except asOf, from and mode: counts only. */
function leaves(v: unknown, path = ''): Array<[string, unknown]> {
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => leaves(x, path ? `${path}.${k}` : k));
  return [[path, v]];
}

// ----------------------------------------------------------------------------------------------- the store --

describe('the visit store: one row per account per day of its own calendar, at most one write per account per day', () => {
  it('a second request the same local day does not ask the database again; a failure never reaches the request', async () => {
    const db = await memoryDb();
    const a = await seedAccount(db);
    const sql: string[] = [];
    const counted: Db = { ...db, query: (q, p) => { sql.push(q); return db.query(q, p); } };
    const logs: string[] = [];
    const visit = createVisitLog(counted, (m) => logs.push(m));
    // No zone = Pacific: 07:00 PST and 17:00 PST on Wed Nov 18 are ONE day, although 17:00 PST is already Nov 19 in UTC.
    await visit(a.id, new Date('2026-11-18T15:00:00Z'));
    await Promise.all([visit(a.id, new Date('2026-11-19T01:00:00Z')), visit(a.id, new Date('2026-11-19T07:59:59Z'))]);
    expect(sql).toHaveLength(1);
    await visit(a.id, new Date('2026-11-19T08:00:01Z')); // 00:00:01 PST: a new Pacific day
    expect(sql).toHaveLength(2);
    // An account that is not there (deleted in the middle of its request): logged without the id, never thrown.
    await expect(visit('TEST-acct-gone', new Date('2026-11-19T16:00:00Z'))).resolves.toBeUndefined();
    expect(logs).toEqual(['usage: a visit day was not stored (23503)']);
    expect(logs.join(' ')).not.toContain('TEST-acct-gone');
    const rows = await db.query<{ day: string }>("select to_char(day, 'YYYY-MM-DD') as day from account_days where account_id = $1 order by day", [a.id]);
    expect(rows.map((r) => r.day)).toEqual(['2026-11-18', '2026-11-19']);
    // The row holds the account and the day, nothing else.
    const cols = await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'account_days' order by column_name");
    expect(cols.map((c) => c.column_name)).toEqual(['account_id', 'day']);
    await db.close();
  });

  it('the day is the account\'s own: its alert clock, else Pacific; an unknown zone reads as Pacific', () => {
    const late = new Date('2026-11-19T04:30:00Z'); // 23:30 in New York on the 18th, 20:30 in Reno, 18:30 in Honolulu
    expect(localDay(late, 'America/New_York')).toBe('2026-11-18');
    expect(localDay(late, null)).toBe('2026-11-18');
    expect(localDay(late, 'Not/AZone')).toBe('2026-11-18');
    expect(localDay(new Date('2026-11-19T05:30:00Z'), 'America/New_York')).toBe('2026-11-19'); // 00:30 there
    expect(localDay(new Date('2026-11-19T05:30:00Z'), undefined)).toBe('2026-11-18');
  });

  it('a morning and an evening visit on the same Pacific day are one day, not two (docs/PLAN.md §4: "most mornings")', async () => {
    const db = await memoryDb();
    const a = await seedAccount(db);
    const visit = createVisitLog(db);
    // Mon Nov 16 and Wed Nov 18, each at 07:00 and 17:00 PST: 2 days (by UTC day it was 4: the 16th, 17th, 18th, 19th).
    for (const t of ['2026-11-16T15:00:00Z', '2026-11-17T01:00:00Z', '2026-11-18T15:00:00Z', '2026-11-19T01:00:00Z']) await visit(a.id, new Date(t));
    const rows = await db.query<{ day: string }>("select to_char(day, 'YYYY-MM-DD') as day from account_days order by day");
    expect(rows.map((r) => r.day)).toEqual(['2026-11-16', '2026-11-18']);
    expect(await returnVisits(db, new Date('2026-11-19T02:00:00Z'), 7)).toEqual({ people: 1, fourPlusAnyWeek: 0, fourPlusEveryWeek: 0 });
    await db.close();
  });

  it('the live stream is not a visit (an open tab reconnects while hidden); every other request is', () => {
    const req = (url: string) => ({ routeOptions: { url } }) as unknown as FastifyRequest;
    expect(countsAsVisit(req('/api/stream'))).toBe(false);
    for (const url of ['/api/me', '/api/feed', '/api/alerts', '/api/bids/:id/calendar']) expect(countsAsVisit(req(url)), url).toBe(true);
  });

  it('windows start at 00:00 UTC on their first day; today is their last', () => {
    expect(windowStart(new Date(NOW), 7).toISOString()).toBe('2026-11-12T00:00:00.000Z');
    expect(windowStart(new Date(NOW), 28).toISOString()).toBe('2026-10-22T00:00:00.000Z');
  });

  it('web/privacy.html says it in one plain sentence, and that deleting the account deletes it', () => {
    const page = readFileSync(new URL('../web/privacy.html', import.meta.url), 'utf8');
    expect(page).toContain('<tr><td>Days you used the app</td><td>The date of each day you used the app while signed in (the date in your alert time zone, Pacific unless you chose another; no time and nothing about what you looked at), so we can count how often people come back.</td></tr>');
    expect(page).toContain('and when you first and last decided on each');
    expect(page).toContain('count in totals how it is used');
    expect(page).toContain('sign-in services and the days you used the app;');
  });
});

// --------------------------------------------------------------------------- visits, alerts and opt-outs --

describe('GET /api/admin/usage: return visits, decision speed, saves per alert, bids opened, opt-outs', () => {
  let w: World;
  let P: Account, Q: Account, R: Account, S: Account;
  let rProfile: string;
  const bids: Bid[] = [];

  beforeAll(async () => {
    w = await world();
    [P, Q, R, S] = [await seedAccount(w.db), await seedAccount(w.db), await seedAccount(w.db), await seedAccount(w.db)];
    await onboard(w.db, P, { match: false, job_message: false });
    await onboard(w.db, Q, { price: false });
    rProfile = await onboard(w.db, R);
    await onboard(w.db, S);
    for (let i = 1; i <= 7; i++) bids.push(testBid({ sourceId: `TEST-usage-${i}`, title: `TEST usage bid ${i} (synthetic)`, dueAt: '2026-12-30T22:00:00.000Z' }));
    await upsertBids(w.db, bids, new Date(at('2026-10-01')));
    await upsertMatches(w.db, rProfile, bids.map((b) => ({ bidId: b.id, score: scoreBid(b, loadProfile('lm-electric'), new Date(NOW)) })));
  });
  afterAll(async () => {
    await w.app.close();
    await w.db.close();
  });

  it('401 without the admin token or with a wrong one', async () => {
    expect((await usage(w, null)).statusCode).toBe(401);
    expect((await usage(w, 'TEST-wrong')).statusCode).toBe(401);
  });

  it('before anything happened: every count is 0, a median or ratio with nothing under it is null', async () => {
    w.clock = NOW;
    const res = await usage(w);
    expect(res.statusCode).toBe(200);
    const none = { people: 0, fourPlusAnyWeek: 0, fourPlusEveryWeek: 0 };
    const zero = (days: number, from: string) => ({
      days, from,
      returnVisits: none,
      decisionDays: { days: none, mornings: none },
      matchAlerts: { sent: 0, decided: 0, medianMinutesToFirstDecision: null, saved: 0, savesPerAlert: null },
      bidsOpened: 0,
      alerts: { sent: 0, read: 0 },
      localJobs: { posted: 0, withBids: 0, awarded: 0, agreed: 0, done: 0 },
    });
    expect(res.json()).toEqual({
      asOf: '2026-11-18T20:00:00.000Z', mode: 'accounts',
      last7: zero(7, '2026-11-12T00:00:00.000Z'), last28: zero(28, '2026-10-22T00:00:00.000Z'),
      alertOptOuts: { profiles: 4, phoneAlertsOff: 0, anyKindOff: 2, byKind: { ...Object.fromEntries(ALL_ALERT_KINDS.map((k) => [k, 0])), match: 1, job_message: 1, price: 1 } },
    });
  });

  it('counts accounts that came back on 4+ different days in a week, from signed-in requests', async () => {
    const days = {
      // every week of the 28 days, 4 days each
      R: ['2026-11-18', '2026-11-17', '2026-11-16', '2026-11-15', '2026-11-11', '2026-11-10', '2026-11-09', '2026-11-08',
        '2026-11-04', '2026-11-03', '2026-11-02', '2026-11-01', '2026-10-28', '2026-10-27', '2026-10-26', '2026-10-25'],
      P: ['2026-11-18', '2026-11-16', '2026-11-14', '2026-11-12'], // 4 days in the last week only
      Q: ['2026-11-18', '2026-11-17', '2026-11-13', '2026-11-03'], // 3 days in the last week, 1 the week before last
      S: ['2026-10-10'], // before both windows
    };
    for (const [name, list] of Object.entries(days)) {
      const who = { P, Q, R, S }[name as 'P' | 'Q' | 'R' | 'S'];
      for (const d of list) {
        expect((await w.call(who, 'GET', '/api/me', undefined, at(d, '15:10'))).status).toBe(200); // 07:10 PST
        await w.call(who, 'GET', '/api/feed', undefined, at(d, '23:45')); // 15:45 PST, the same day again: no second row
      }
    }
    const rows = await w.db.query<{ n: number }>('select count(*)::int as n from account_days');
    expect(rows[0]!.n).toBe(16 + 4 + 4 + 1);
    w.clock = NOW;
    const body = (await usage(w)).json();
    expect(body.last7.returnVisits).toEqual({ people: 3, fourPlusAnyWeek: 2, fourPlusEveryWeek: 2 }); // R, P (Q: 3 days)
    expect(body.last28.returnVisits).toEqual({ people: 3, fourPlusAnyWeek: 2, fourPlusEveryWeek: 1 }); // only R every week
    // A signed-out request writes nothing.
    await w.call(null, 'GET', '/api/me', undefined, NOW);
    expect((await w.db.query<{ n: number }>('select count(*)::int as n from account_days'))[0]!.n).toBe(25);
  });

  it('minutes from a match alert to the first decision, and saves per alert', async () => {
    const alert = (bid: Bid, kind: string, when: number, read = false) => w.db.query(
      `insert into alerts (profile_id, kind, bid_id, dedupe_key, title, body, created_at, read_at)
       values ($1, $2, $3, $4, 'TEST alert (simulated)', 'TEST', $5::timestamptz, $6::timestamptz)`,
      [rProfile, kind, bid.id, `TEST-${kind}-${bid.id}`, new Date(when).toISOString(), read ? new Date(when + HOUR).toISOString() : null],
    );
    const swipe = async (bid: Bid, action: string, when: number) =>
      expect((await w.call(R, 'POST', '/api/swipe', { bidId: bid.id, action }, when)).status).toBe(200);
    const [b1, b2, b3, b4, b5, b6, b7] = bids as [Bid, Bid, Bid, Bid, Bid, Bid, Bid];
    const t = at('2026-11-16', '14:00'); // in the last 7 days
    for (const b of [b1, b2, b3, b4]) await alert(b, 'match', t);
    await swipe(b1, 'save', t + 10 * MIN);
    await swipe(b1, 'pass', t + 500 * MIN); // a later decision: the first one's time stays, and it is no longer saved
    await swipe(b2, 'pass', t + 30 * MIN);
    await swipe(b3, 'bid', t + 50 * MIN); // "Bid on …" first: in Saved, so it counts as saved
    // b4: no decision yet
    const t2 = at('2026-11-09', '14:00'); // in the 28 days only
    await alert(b5, 'match', t2);
    await swipe(b5, 'save', t2 + 70 * MIN);
    await alert(b6, 'match', at('2026-10-01', '14:00')); // before both windows
    await swipe(b6, 'save', at('2026-10-01', '15:00'));
    await swipe(b7, 'save', at('2026-11-15', '09:00')); // decided BEFORE its alert: not a decision on the alert
    await alert(b7, 'match', at('2026-11-15', '12:00'));
    await alert(b1, 'deadline', at('2026-11-17', '15:00'), true); // another kind, read
    w.clock = NOW;
    const body = (await usage(w)).json();
    // last 7: b1 10 min, b2 30, b3 50 (b4 undecided, b7 decided before) → median 30; saved after its alert: b3 of 5
    // (b7 is saved, but it was saved before its alert existed: not a save the alert brought)
    expect(body.last7.matchAlerts).toEqual({ sent: 5, decided: 3, medianMinutesToFirstDecision: 30, saved: 1, savesPerAlert: 0.2 });
    expect(body.last7.alerts).toEqual({ sent: 6, read: 1 });
    expect(body.last7.bidsOpened).toBe(1); // b3's "Bid on …"
    // last 28: plus b5 at 70 min → median of 10, 30, 50, 70 = 40; saved b3, b5 of 6
    expect(body.last28.matchAlerts).toEqual({ sent: 6, decided: 4, medianMinutesToFirstDecision: 40, saved: 2, savesPerAlert: 0.33 });
    expect(body.last28.alerts).toEqual({ sent: 7, read: 1 });
    // R's first decisions, on its Pacific clock: Nov 16 06:10–06:50 PST, Nov 15 01:00 PST (b7), Nov 9 07:10 PST; all mornings
    const one = { people: 1, fourPlusAnyWeek: 0, fourPlusEveryWeek: 0 };
    expect(body.last7.decisionDays).toEqual({ days: one, mornings: one });
    expect(body.last28.decisionDays).toEqual({ days: one, mornings: one });
  });

  it('opt-outs follow the switches as they are now', async () => {
    const q = (await w.db.query<{ prefs: any }>('select prefs from profiles where account_id = $1', [Q.id]))[0]!.prefs;
    const prefs = typeof q === 'string' ? JSON.parse(q) : q;
    prefs.alerts = { ...prefs.alerts, kinds: { ...prefs.alerts?.kinds, price: true, deadline: false, award: false } };
    await saveProfileForAccount(w.db, Q.id, prefs);
    // S turns phone alerts off: the broadest opt-out, counted on its own (no kind switched off).
    const sp = (await w.db.query<{ prefs: any }>('select prefs from profiles where account_id = $1', [S.id]))[0]!.prefs;
    const sPrefs = typeof sp === 'string' ? JSON.parse(sp) : sp;
    await saveProfileForAccount(w.db, S.id, { ...sPrefs, alerts: { ...sPrefs.alerts, push: false } });
    const body = (await usage(w)).json();
    expect(body.alertOptOuts).toEqual({
      profiles: 4, phoneAlertsOff: 1, anyKindOff: 2,
      byKind: { match: 1, deadline: 1, award: 1, price: 0, job_awarded: 0, job_message: 1, job_deadline: 0, job_closed: 0 },
    });
    expect(Object.keys(body.alertOptOuts.byKind)).toEqual([...ALL_ALERT_KINDS]);
  });

  it('counts only: no id, e-mail, name or text anywhere in the answer', async () => {
    const res = await usage(w);
    for (const [path, v] of leaves(res.json())) {
      if (['asOf', 'mode', 'last7.from', 'last28.from'].includes(path)) continue;
      expect(v === null || (typeof v === 'number' && Number.isFinite(v)), `${path} = ${String(v)}`).toBe(true);
    }
    for (const a of [P, Q, R, S]) {
      for (const s of [a.id, a.email, a.name!, profileIdFor(a.id)]) expect(res.body).not.toContain(s);
    }
    for (const b of bids) expect(res.body).not.toContain(b.id);
    expect(res.body).not.toContain('TEST');
  });
});

// ------------------------------------------------------------------------------------- decisions by morning --

describe('decision days and mornings (docs/PLAN.md §4: "decisions on 4+ mornings a week"), on each profile\'s own clock', () => {
  it('a day = a first save, pass or "Bid on …" that day; a morning = one before 12:00; weeks end on the profile\'s today', async () => {
    const db = await memoryDb();
    const [A, B, C] = [await seedAccount(db), await seedAccount(db), await seedAccount(db)];
    const west = await onboard(db, A); // no zone: Pacific
    const east = await onboard(db, B, undefined, 'America/New_York');
    const old = await onboard(db, C);
    const list: Bid[] = [];
    for (let i = 1; i <= 12; i++) list.push(testBid({ sourceId: `TEST-mornings-${i}`, title: `TEST mornings bid ${i} (synthetic)`, dueAt: '2026-12-30T22:00:00.000Z' }));
    await upsertBids(db, list, new Date(at('2026-10-01')));
    let k = 0;
    const decide = (profile: string, iso: string | null) => db.query(
      "insert into swipes (profile_id, bid_id, action, created_at, first_at) values ($1, $2, 'save', now(), $3::timestamptz)",
      [profile, list[k++ % list.length]!.id, iso],
    );
    // West (Pacific): 06:30 PST on Fri 13, Sat 14, Mon 16, Wed 18 = 4 mornings; 17:30 PST Tue 17 (01:30 UTC on the 18th):
    // a day, not a morning, and not the 18th.
    for (const d of ['2026-11-13', '2026-11-14', '2026-11-16', '2026-11-18']) await decide(west, `${d}T14:30:00Z`);
    await decide(west, '2026-11-18T01:30:00Z');
    // East (New York): 11:30 EST on Thu 12, Fri 13, Sat 14 = 3 mornings; 23:30 EST Sun 15 (04:30 UTC on the 16th): a day.
    // 23:30 EST on Wed 11 is 04:30 UTC on the 12th: inside the UTC window, but the 11th on its own clock, so last week.
    for (const d of ['2026-11-12', '2026-11-13', '2026-11-14']) await decide(east, `${d}T16:30:00Z`);
    await decide(east, '2026-11-16T04:30:00Z');
    await decide(east, '2026-11-12T04:30:00Z');
    // Old: a swipe stored before first_at existed, and one outside both windows. Neither counts.
    await decide(old, null);
    await decide(old, '2026-09-01T15:00:00Z');
    const now = new Date(NOW);
    expect(await decisionDays(db, now, 7)).toEqual({
      days: { people: 2, fourPlusAnyWeek: 2, fourPlusEveryWeek: 2 }, // west 5 days, east 4
      mornings: { people: 2, fourPlusAnyWeek: 1, fourPlusEveryWeek: 1 }, // west 4 mornings, east 3
    });
    expect(await decisionDays(db, now, 28)).toEqual({
      days: { people: 2, fourPlusAnyWeek: 2, fourPlusEveryWeek: 0 }, // nobody decided in every one of the 4 weeks
      mornings: { people: 2, fourPlusAnyWeek: 1, fourPlusEveryWeek: 0 },
    });
    await expect(decisionDays(db, now, 10)).rejects.toThrow(/whole weeks/);
    await db.close();
  });
});

// ------------------------------------------------------------------------------------------------ local jobs --

describe('GET /api/admin/usage: local jobs posted in the window, and how far they got', () => {
  let w: World;
  let poster: Account, bidder: Account;

  beforeAll(async () => {
    w = await world();
    poster = await seedAccount(w.db, { name: 'TEST Poster (simulated)' });
    bidder = await seedAccount(w.db, { name: 'TEST Bidder (simulated)' });
    await onboard(w.db, poster);
    await onboard(w.db, bidder);
  });
  afterAll(async () => {
    await w.app.close();
    await w.db.close();
  });

  const JOB = {
    title: 'TEST Hang four porch lights (simulated)', description: 'Four exterior fixtures on an existing circuit. TEST job (simulated).',
    trades: ['electrical'], zip: '89423', budgetMaxCents: 90_000,
  };
  const post = async (when: number, closesInDays: number): Promise<string> => {
    const res = await w.call(poster, 'POST', '/api/jobs', { ...JOB, closesInDays }, when);
    expect(res.status).toBe(201);
    return res.json.job.id as string;
  };
  const bid = async (id: string) => expect((await w.call(bidder, 'POST', `/api/jobs/${id}/bid`, { amountCents: 41_000, agree: true })).status).toBe(200);
  const status = async (id: string, when: number) => (await w.call(poster, 'GET', `/api/jobs/${id}`, undefined, when)).json.job.status as string;

  it('posted · with bids · awarded · agreed · done, for the jobs posted in each window', async () => {
    // 12 days ago: posted, bid on, awarded, agreed by both, marked done.
    const done = await post(NOW - 12 * DAY, 1);
    await bid(done);
    expect(await status(done, NOW - 10 * DAY)).toBe('awarded');
    expect((await w.call(poster, 'POST', `/api/jobs/${done}/confirm`)).status).toBe(200);
    expect((await w.call(bidder, 'POST', `/api/jobs/${done}/confirm`)).status).toBe(200);
    expect((await w.call(poster, 'POST', `/api/jobs/${done}/complete`)).json.job.status).toBe('completed');
    // 40 days ago: outside both windows.
    await post(NOW - 40 * DAY, 1);
    // 2 days ago: bid on and awarded.
    const awarded = await post(NOW - 2 * DAY, 1);
    await bid(awarded);
    expect(await status(awarded, NOW - DAY + HOUR)).toBe('awarded');
    // Yesterday: open, no bid yet; and one an operator took down (not counted).
    await post(NOW - DAY, 30);
    const removed = await post(NOW - DAY + HOUR, 30);
    const off = await w.app.inject({ method: 'POST', url: `/api/admin/jobs/${removed}/remove`, headers: { 'x-admin-token': ADMIN, 'x-bidswipe': '1' } });
    expect(off.statusCode).toBe(200);
    w.clock = NOW;
    const body = (await usage(w)).json();
    expect(body.last7.localJobs).toEqual({ posted: 2, withBids: 1, awarded: 1, agreed: 0, done: 0 });
    expect(body.last28.localJobs).toEqual({ posted: 3, withBids: 2, awarded: 2, agreed: 1, done: 1 });
    expect(body.last28.returnVisits.people).toBe(2); // the poster and the bidder used the app
    for (const s of [poster.id, bidder.id, poster.email, JOB.title, done, awarded, removed]) expect(JSON.stringify(body)).not.toContain(s);
  });
});

// -------------------------------------------------------------------------------------------------- single --

describe('GET /api/admin/usage in single mode (the pilot)', () => {
  it('no accounts there: return visits and local jobs are null (not measured), the rest is counted', async () => {
    const db = await memoryDb();
    await upsertProfile(db, loadProfile('lm-electric')); // as the first scan stores it
    const app = await buildServer({ db, profile: loadProfile('lm-electric') }, { adminToken: ADMIN, now: () => new Date(NOW) });
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/api/admin/usage', headers: { 'x-admin-token': ADMIN } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('single');
    for (const win of [body.last7, body.last28]) {
      expect(win.returnVisits).toBeNull();
      expect(win.localJobs).toBeNull();
      expect(win.matchAlerts).toEqual({ sent: 0, decided: 0, medianMinutesToFirstDecision: null, saved: 0, savesPerAlert: null });
      // The pilot's decisions are counted in single mode too (per profile, not per account).
      expect(win.decisionDays).toEqual({ days: { people: 0, fourPlusAnyWeek: 0, fourPlusEveryWeek: 0 }, mornings: { people: 0, fourPlusAnyWeek: 0, fourPlusEveryWeek: 0 } });
    }
    expect(body.alertOptOuts.profiles).toBe(1);
    expect((await db.query<{ n: number }>('select count(*)::int as n from account_days'))[0]!.n).toBe(0);
    await app.close();
    await db.close();
  });
});
