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
 * Reporting what people write besides a job (Microsoft Store policy 11.12), through the real server in accounts mode
 * with an injected clock: report a conversation (POST /api/jobs/:id/conversation/report), report a card
 * (POST /api/people/:id/report), and the operators' side (the report list, remove a message, hide / unhide a card,
 * resolve a report). Every person and job here is synthetic (TEST- accounts at example.com, "(simulated)").
 */

const DAY = 86_400_000;
const START = Date.parse('2026-11-14T18:00:00Z');
const ADMIN = 'TEST-admin-token';
const THANKS = 'Thanks. Your report was sent to BidSwipe.';
const HEADLINE = 'TEST-HEADLINE-qz7 licensed sparky (simulated)';
const ABOUT = 'TEST-ABOUT-qz7 twenty years of small jobs (simulated)';
const SECRET = 'TEST-SECRET-qz7 pay me in gift cards (simulated)';
const NOTE = 'TEST-NOTE-qz7 they were rude (simulated)';

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
let jobId: string;

async function onboard(a: Account, trades: string[]): Promise<void> {
  await saveProfileForAccount(db, a.id, buildProfile(profileIdFor(a.id), {
    businessName: a.name ?? 'TEST (simulated)', trades, zip: '89410', radiusMi: 90, valueRange: { min: 10_000, max: 50_000 },
  }));
}

beforeAll(async () => {
  db = await memoryDb();
  poster = await seedAccount(db, { name: 'TEST Rep Poster (simulated)' });
  winner = await seedAccount(db, { name: 'TEST Rep Winner (simulated)' });
  loser = await seedAccount(db, { name: 'TEST Rep Loser (simulated)' });
  stranger = await seedAccount(db, { name: 'TEST Rep Stranger (simulated)' });
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

  // The winner's card has words of their own; one job, awarded to the winner over the loser.
  byId.set(winner.id, winner);
  expect((await call(winner, 'PUT', '/api/work-profile', { headline: HEADLINE, about: ABOUT })).status).toBe(200);
  const res = await call(poster, 'POST', '/api/jobs', {
    title: 'Swap a light fixture (TEST)', description: 'Take down an old ceiling fixture and put up a new one. TEST job (simulated).',
    trades: ['electrical'], zip: '89423', address: '9 TEST Street (simulated)', phone: '775-555-0199', budgetMaxCents: 100_000, closesInDays: 1,
  });
  expect(res.status).toBe(201);
  jobId = res.json.job.id;
  expect((await call(winner, 'POST', `/api/jobs/${jobId}/bid`, { amountCents: 30_001, agree: true })).status).toBe(200);
  expect((await call(loser, 'POST', `/api/jobs/${jobId}/bid`, { amountCents: 40_003, agree: true })).status).toBe(200);
  clock += DAY + 1;
  await rt.tick();
  clock += 60_000;
  expect((await call(winner, 'POST', `/api/jobs/${jobId}/messages`, { body: SECRET })).status).toBe(200);
  await rt.flush();
});
afterAll(async () => {
  rt.stop();
  await app.close();
  await db.close();
});

async function call(who: Account | null, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, headers: Record<string, string> = {}) {
  if (who) byId.set(who.id, who);
  const res = await app.inject({
    method, url, headers: { 'x-bidswipe': '1', 'x-test-as': who?.id ?? '', ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return { status: res.statusCode, json: res.body ? res.json() : null, text: res.body };
}
const admin = (method: 'GET' | 'POST', url: string) => call(null, method, url, undefined, { 'x-admin-token': ADMIN });
const reportConvo = (who: Account, id: string, body: unknown) => call(who, 'POST', `/api/jobs/${id}/conversation/report`, body);
const reportCard = (who: Account, id: string, body: unknown) => call(who, 'POST', `/api/people/${id}/report`, body);

/** Everything a user can be answered that could carry a card or a message: the people route, the job, Messages, the bell. */
async function everyAnswer(who: Account, other: Account | null): Promise<string> {
  const urls = ['/api/jobs/conversations', `/api/jobs/${jobId}`, `/api/jobs/${jobId}/conversation`, '/api/alerts', '/api/jobs/mine', '/api/work-profile'];
  if (other) urls.push(`/api/people/${other.id}`);
  const out: string[] = [];
  for (const u of urls) out.push((await call(who, 'GET', u)).text);
  return out.join('\n');
}

/** The job row's state that a report or an operator action must never move. */
const jobState = async () => (await db.query(
  `select status, outcome, bidder_messaged_at, poster_messaged_at, poster_tapped_at, bidder_confirmed_at, poster_confirmed_at,
          poster_read_msg_id, winner_read_msg_id, contact_deadline, removed_at,
          (select count(*) from job_fees f where f.job_id = jobs.id) as fees,
          (select count(*) from job_messages m where m.job_id = jobs.id) as messages
     from jobs where id = $1`, [jobId]))[0];
const alertCount = async (a: Account) => Number((await db.query<{ n: string }>('select count(*) as n from alerts where profile_id = $1', [profileIdFor(a.id)]))[0]!.n);

describe('single mode', () => {
  it('answers 404 to every new route, like the other jobs routes', async () => {
    const single = await buildServer({ db, profile: loadProfile('lm-electric') }, {});
    for (const url of ['/api/jobs/x/conversation/report', '/api/people/x/report', '/api/admin/jobs/messages/1/remove', '/api/admin/people/x/hide',
      '/api/admin/people/x/unhide', '/api/admin/reports/1/resolve']) {
      const res = await single.inject({ method: 'POST', url, headers: { 'x-bidswipe': '1', 'x-admin-token': ADMIN } });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
    await single.close();
  });

  it('signed out: 401; without the CSRF header: 403', async () => {
    expect((await call(null, 'POST', `/api/jobs/${jobId}/conversation/report`, { reason: 'spam' })).status).toBe(401);
    expect((await call(null, 'POST', `/api/people/${winner.id}/report`, { reason: 'spam' })).status).toBe(401);
    const res = await app.inject({
      method: 'POST', url: `/api/people/${winner.id}/report`, headers: { 'x-test-as': poster.id, 'content-type': 'application/json', cookie: 'bidswipe_session=TEST' },
      payload: JSON.stringify({ reason: 'spam' }),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('report a conversation', () => {
  it('someone outside the thread gets exactly the answer the thread routes give them; a gone job is 404', async () => {
    for (const who of [loser, stranger]) {
      const thread = await call(who, 'GET', `/api/jobs/${jobId}/conversation`);
      const rep = await reportConvo(who, jobId, { reason: 'spam' });
      expect(rep.status).toBe(403);
      expect(rep.json).toEqual(thread.json);
    }
    expect((await reportConvo(poster, 'TEST-no-such-job', { reason: 'spam' })).status).toBe(404);
    expect(await db.query('select 1 from content_reports')).toHaveLength(0);
  });

  it('a reason from the list; an optional note of at most 500 characters', async () => {
    expect((await reportConvo(winner, jobId, {})).json).toMatchObject({ error: 'invalid_input', fields: [{ path: 'reason' }] });
    expect((await reportConvo(winner, jobId, { reason: 'misleading' })).status).toBe(400); // a profile reason, not a message one
    expect((await reportConvo(winner, jobId, { reason: 'spam', note: 'x'.repeat(501) })).json).toMatchObject({ fields: [{ path: 'note' }] });
    expect((await reportConvo(winner, jobId, { reason: 'spam', note: 7 })).status).toBe(400);
  });

  it('either side may report; it points at the job, the reporter and the other side; a second one is a kind "already"', async () => {
    const before = await jobState();
    const alertsBefore = [await alertCount(poster), await alertCount(winner)];
    const w = await reportConvo(winner, jobId, { reason: 'off_platform', note: NOTE });
    expect(w).toMatchObject({ status: 200, json: { ok: true, already: false, message: THANKS } });
    expect((await reportConvo(winner, jobId, { reason: 'abusive' })).json).toEqual({ ok: true, already: true, message: 'You already reported this. It was sent to BidSwipe.' });
    expect((await reportConvo(poster, jobId, { reason: 'abusive' })).json).toMatchObject({ ok: true, already: false });
    const rows = await db.query<{ kind: string; job_id: string; reporter_id: string; subject_id: string; reason: string; note: string | null }>(
      'select kind, job_id, reporter_id, subject_id, reason, note from content_reports order by id');
    expect(rows).toEqual([
      { kind: 'conversation', job_id: jobId, reporter_id: winner.id, subject_id: poster.id, reason: 'off_platform', note: NOTE },
      { kind: 'conversation', job_id: jobId, reporter_id: poster.id, subject_id: winner.id, reason: 'abusive', note: null },
    ]);
    // reporting is not contact, and tells nobody anything
    expect(await jobState()).toEqual(before);
    expect([await alertCount(poster), await alertCount(winner)]).toEqual(alertsBefore);
  });

  it('nothing in a report reaches either side: no reason, no note, no word of it', async () => {
    for (const [who, other] of [[poster, winner], [winner, poster]] as const) {
      const all = await everyAnswer(who, other);
      expect(all).not.toContain(NOTE);
      expect(all).not.toContain('off_platform');
      expect(all).not.toMatch(/report/i);
    }
  });
});

describe('report a card', () => {
  it('only someone allowed to see the card: anyone else gets the people route\'s own 404; never one\'s own', async () => {
    for (const [who, target] of [[stranger, winner], [stranger, poster], [winner, loser], [poster, poster], [poster, { id: 'TEST-nobody' }]] as const) {
      const card = await call(who, 'GET', `/api/people/${target.id}`);
      const rep = await reportCard(who, target.id, { reason: 'spam' });
      expect(card.status, `${who.name} → ${target.id}`).toBe(404);
      expect(rep.status).toBe(404);
      expect(rep.json).toEqual(card.json);
    }
    expect(await db.query(`select 1 from content_reports where kind = 'profile'`)).toHaveLength(0);
  });

  it('the poster reports the winner\'s card (and a bidder whose bid was in may report the poster\'s); once per open report', async () => {
    expect((await call(poster, 'GET', `/api/people/${winner.id}`)).status).toBe(200);
    expect((await reportCard(poster, winner.id, { reason: 'offensive' })).json).toMatchObject({ ok: true, already: false, message: THANKS });
    expect((await reportCard(poster, winner.id, { reason: 'misleading', note: NOTE })).json).toMatchObject({ ok: true, already: true });
    expect((await reportCard(loser, poster.id, { reason: 'abusive' })).status).toBe(400); // a message reason, not a card one
    expect((await reportCard(loser, poster.id, { reason: 'other', note: NOTE })).json).toMatchObject({ ok: true, already: false });
    const rows = await db.query<{ reporter_id: string; subject_id: string; reason: string }>(
      `select reporter_id, subject_id, reason from content_reports where kind = 'profile' order by id`);
    expect(rows).toEqual([
      { reporter_id: poster.id, subject_id: winner.id, reason: 'offensive' },
      { reporter_id: loser.id, subject_id: poster.id, reason: 'other' },
    ]);
    const all = await everyAnswer(winner, poster);
    expect(all).not.toContain(NOTE);
    expect(all).not.toMatch(/report/i);
  });
});

describe('the writing statement decides who may report a card (review rs-9)', () => {
  it('insertProfileReport itself refuses two people who never dealt with each other, and one\'s own card', async () => {
    const { insertProfileReport } = await import('../src/jobs/repo.js');
    expect(await insertProfileReport(db, winner.id, stranger.id, 'spam', null, clock)).toBe(false);
    expect(await insertProfileReport(db, loser.id, winner.id, 'spam', null, clock)).toBe(false);
    expect(await insertProfileReport(db, poster.id, poster.id, 'spam', null, clock)).toBe(false);
    expect(await db.query(`select 1 from content_reports where kind = 'profile' and (reporter_id in ($1, $2) or subject_id = reporter_id)`, [stranger.id, winner.id]))
      .toHaveLength(0);
  });
});

describe('the operators', () => {
  it('every operator route needs the admin token', async () => {
    for (const [method, url] of [['GET', '/api/admin/jobs/reports'], ['POST', '/api/admin/jobs/messages/1/remove'], ['POST', `/api/admin/people/${winner.id}/hide`],
      ['POST', `/api/admin/people/${winner.id}/unhide`], ['POST', '/api/admin/reports/1/resolve']] as const) {
      const res = await call(poster, method, url);
      expect(res.status, url).toBe(401);
      const wrong = await call(null, method, url, undefined, { 'x-admin-token': 'TEST-wrong' });
      expect(wrong.status, url).toBe(401);
    }
  });

  it('the list carries what is needed to judge: the thread for a conversation, the card for a profile', async () => {
    const res = await admin('GET', '/api/admin/jobs/reports');
    expect(res.status).toBe(200);
    const convo = res.json.conversationReports.find((r: { reporterId: string }) => r.reporterId === winner.id);
    expect(convo).toMatchObject({
      kind: 'conversation', jobId, jobTitle: 'Swap a light fixture (TEST)', reporterRole: 'winner', subjectId: poster.id, reason: 'off_platform', note: NOTE,
      resolvedAt: null, card: null,
    });
    expect(convo.messages).toEqual([expect.objectContaining({ from: 'winner', senderId: winner.id, body: SECRET, removed: false })]);
    const prof = res.json.profileReports.find((r: { subjectId: string }) => r.subjectId === winner.id);
    expect(prof).toMatchObject({ kind: 'profile', reporterId: poster.id, reason: 'offensive', hidden: false, messages: null, card: { headline: HEADLINE, about: ABOUT } });
    expect(Array.isArray(res.json.reports)).toBe(true);
  });

  it('hide a card: everyone else sees the lite card and the flag, in every answer; the owner still has their text', async () => {
    const before = await jobState();
    const hidAt = new Date(clock).toISOString();
    expect((await admin('POST', `/api/admin/people/${winner.id}/hide`)).json).toEqual({ ok: true, hidden: true, hiddenAt: hidAt });
    clock += 1000;
    expect((await admin('POST', `/api/admin/people/${winner.id}/hide`)).json.hiddenAt).toBe(hidAt); // twice keeps the first time

    const card = (await call(poster, 'GET', `/api/people/${winner.id}`)).json.card;
    expect(card).toMatchObject({
      id: winner.id, name: 'BidSwipe member', hidden: true, headline: null, about: null, yearsExperience: null, skills: [],
      license: null, experience: [], resumeUrl: null,
    });
    expect(card.stats).toBeTruthy();
    const job = (await call(poster, 'GET', `/api/jobs/${jobId}`)).json.job;
    expect(job.award.winner).toMatchObject({ hidden: true, headline: null });
    expect(job.tab.find((r: { amountCents: number }) => r.amountCents === 30_001).bidder).toMatchObject({ hidden: true, about: null });
    const conv = (await call(poster, 'GET', '/api/jobs/conversations')).json.conversations[0];
    expect(conv.other).toMatchObject({ hidden: true, headline: null, name: 'BidSwipe member' });
    // The person's own name is user-written too: it is on no hidden card (review rs-4).
    expect(JSON.stringify([card, job, conv])).not.toContain('TEST Rep Winner');
    for (const who of [poster, loser]) {
      const all = await everyAnswer(who, winner);
      expect(all).not.toContain('TEST-HEADLINE-qz7');
      expect(all).not.toContain('TEST-ABOUT-qz7');
    }
    // the owner: their own text to edit, and the card as others now see it
    const mine = (await call(winner, 'GET', '/api/work-profile')).json;
    expect(mine.workProfile).toMatchObject({ headline: HEADLINE, about: ABOUT });
    expect(mine.card).toMatchObject({ hidden: true, headline: null });
    const edited = await call(winner, 'PUT', '/api/work-profile', { headline: `${HEADLINE} v2` });
    expect(edited.status).toBe(200);
    expect(edited.json.card.hidden).toBe(true); // editing does not bring it back
    // the operator still sees the text, to decide
    const list = (await admin('GET', '/api/admin/jobs/reports')).json.profileReports.find((r: { subjectId: string }) => r.subjectId === winner.id);
    expect(list).toMatchObject({ hidden: true, card: { headline: `${HEADLINE} v2`, hidden: true } });
    expect(await jobState()).toEqual(before);
  });

  it('unhide: the card is back as it was written; an unknown person is 404', async () => {
    expect((await admin('POST', `/api/admin/people/${winner.id}/unhide`)).json).toEqual({ ok: true, hidden: false, hiddenAt: null });
    expect((await call(poster, 'GET', `/api/people/${winner.id}`)).json.card).toMatchObject({ hidden: false, headline: `${HEADLINE} v2`, about: ABOUT });
    expect((await admin('POST', '/api/admin/people/TEST-nobody/hide')).status).toBe(404);
    expect((await admin('POST', '/api/admin/people/TEST-nobody/unhide')).status).toBe(404);
  });

  it('remove a message: the row stays, both sides see it removed, its text is in no answer; nothing else moves', async () => {
    const msgId = (await call(poster, 'GET', `/api/jobs/${jobId}/conversation`)).json.messages[0].id as number;
    expect(await everyAnswer(poster, winner)).toContain('TEST-SECRET-qz7'); // the bell and the thread had it
    const before = await jobState();
    const unreadBefore = (await call(poster, 'GET', '/api/jobs/conversations')).json.conversations[0].unread;

    expect((await admin('POST', `/api/admin/jobs/messages/${msgId}/remove`)).json).toEqual({ ok: true });
    expect((await admin('POST', `/api/admin/jobs/messages/${msgId}/remove`)).status).toBe(200); // twice: fine
    for (const [who, other] of [[poster, winner], [winner, poster], [loser, poster]] as const) {
      expect(await everyAnswer(who, other)).not.toContain('TEST-SECRET-qz7');
    }
    for (const who of [poster, winner]) {
      const conv = (await call(who, 'GET', `/api/jobs/${jobId}/conversation`)).json;
      expect(conv.messages).toEqual([expect.objectContaining({ id: msgId, removed: true, body: '' })]);
      expect(conv.conversation.last).toMatchObject({ removed: true, preview: '' });
      expect((await call(who, 'GET', `/api/jobs/${jobId}`)).json.messages[0]).toMatchObject({ removed: true, body: '' });
    }
    const alert = (await db.query<{ body: string }>(
      `select body from alerts where kind = 'job_message' and dedupe_key = $1`, [`${jobId}:${msgId}`]))[0];
    expect(alert?.body).toBe('Message removed by BidSwipe');
    const admins = (await admin('GET', '/api/admin/jobs/reports')).text;
    expect(admins).not.toContain('TEST-SECRET-qz7');
    // not the stage, not made-contact, not fees, not read marks, not unread
    expect(await jobState()).toEqual(before);
    expect((await call(poster, 'GET', '/api/jobs/conversations')).json.conversations[0].unread).toBe(unreadBefore);
    expect((await call(poster, 'GET', `/api/jobs/${jobId}`)).json.job.award.bidderContactedAt).not.toBeNull();
  });

  it('a later message is not touched, and an unknown or malformed message id is 404', async () => {
    clock += 60_000;
    expect((await call(poster, 'POST', `/api/jobs/${jobId}/messages`, { body: 'TEST-LATER-qz7 Thursday is fine (simulated)' })).status).toBe(200);
    const msgs = (await call(winner, 'GET', `/api/jobs/${jobId}/conversation`)).json.messages;
    expect(msgs.map((m: { removed: boolean; body: string }) => [m.removed, m.body])).toEqual([[true, ''], [false, 'TEST-LATER-qz7 Thursday is fine (simulated)']]);
    expect((await admin('POST', '/api/admin/jobs/messages/999999/remove')).status).toBe(404);
    expect((await admin('POST', '/api/admin/jobs/messages/abc/remove')).status).toBe(404);
  });

  it('resolve a report: it stays listed with its time; then the same person may report again', async () => {
    const list = (await admin('GET', '/api/admin/jobs/reports')).json;
    const mine = list.conversationReports.find((r: { reporterId: string }) => r.reporterId === winner.id);
    expect((await admin('POST', `/api/admin/reports/${mine.id}/resolve`)).json).toEqual({ ok: true });
    const again = (await admin('GET', '/api/admin/jobs/reports')).json.conversationReports.find((r: { id: number }) => r.id === mine.id);
    expect(again.resolvedAt).toBe(new Date(clock).toISOString());
    expect((await reportConvo(winner, jobId, { reason: 'spam' })).json).toMatchObject({ already: false });
    expect((await admin('POST', '/api/admin/reports/999999/resolve')).status).toBe(404);
  });
});

describe('rate limit', () => {
  it('reports share the job report\'s 10 per hour per account (already-reported answers count as tries)', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await reportCard(loser, poster.id, { reason: 'other' })).status;
    expect(last).toBe(429);
    expect((await call(loser, 'POST', `/api/jobs/${jobId}/report`, { reason: 'TEST report (simulated)' })).status).toBe(429);
  });
});
