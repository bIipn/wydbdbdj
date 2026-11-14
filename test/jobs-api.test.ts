import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RouteContext } from '../src/context.js';
import type { Db } from '../src/db/db.js';
import { saveProfileForAccount } from '../src/db/repo.js';
import { loadJobRules } from '../src/jobs/config.js';
import { getJob as getJobRow, insertJob } from '../src/jobs/repo.js';
import { settleDue, type JobsDeps } from '../src/jobs/service.js';
import { sharesJob, jobStats } from '../src/jobs/stats.js';
import { buildProfile, profileIdFor } from '../src/profile/build.js';
import { loadProfile } from '../src/profiles.js';
import { createRealtime, type Realtime } from '../src/realtime/index.js';
import { buildApp, buildServer } from '../src/server.js';
import type { Account } from '../src/types.js';
import { accountsConfig, fakeAuth, memoryDb, seedAccount } from './helpers.js';

/**
 * The job marketplace through the real server (accounts mode) with an injected clock. Every person, job and
 * amount here is synthetic (TEST- accounts at example.com). The amounts are odd numbers on purpose, so a leak
 * shows up as plain text in a response.
 */

const DAY = 86_400_000;
const START = Date.parse('2026-11-14T18:00:00Z');
const ADMIN = 'TEST-admin-token';
/** Minden, NV: 12 mi from the electrician's Gardnerville base. */
const ZIP = '89423';
const ADDRESS = '1 TEST Lane (simulated)';
const PHONE = '775-555-0142';

let db: Db;
let app: FastifyInstance;
let ctx: RouteContext;
let rt: Realtime;
let clock = START;
let current: Account | null = null;
/** Who each request is from (the x-test-as header), so two calls in flight at once each keep their own account. */
const byId = new Map<string, Account>();

let poster: Account; // posts the jobs; is an electrician too (must never be shown their own job)
let sparky: Account; // electrician near the job
let sparky2: Account; // another electrician
let plumber: Account; // a plumber near the job
let nosy: Account; // has no bid on anything
let spammer: Account; // for the rate limit

const profileOf = (a: Account) => profileIdFor(a.id);

async function onboard(a: Account, trades: string[]): Promise<void> {
  await saveProfileForAccount(db, a.id, buildProfile(profileOf(a), {
    businessName: `${a.name}`, trades, zip: '89410', radiusMi: 90, valueRange: { min: 10_000, max: 50_000 },
  }));
}

beforeAll(async () => {
  db = await memoryDb();
  poster = await seedAccount(db, { name: 'TEST Poster (simulated)' });
  sparky = await seedAccount(db, { name: 'TEST Sparky (simulated)' });
  sparky2 = await seedAccount(db, { name: 'TEST Sparky Two (simulated)' });
  plumber = await seedAccount(db, { name: 'TEST Plumber (simulated)' });
  nosy = await seedAccount(db, { name: 'TEST Nosy (simulated)' });
  spammer = await seedAccount(db, { name: 'TEST Spammer (simulated)' });
  await onboard(poster, ['electrical']);
  await onboard(sparky, ['electrical']);
  await onboard(sparky2, ['electrical']);
  await onboard(plumber, ['plumbing']);
  await onboard(nosy, ['roofing']);
  const built = await buildApp({ db }, {
    config: accountsConfig({ adminToken: ADMIN, appUrl: 'https://bidswipe.example.com' }),
    auth: { authenticate: async (req) => {
      const as = req.headers['x-test-as'];
      return typeof as === 'string' ? (byId.get(as) ?? null) : current;
    } },
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

/** One request as `who` (null = signed out). Returns status, parsed body and the raw text. */
async function call(who: Account | null, method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) {
  current = who;
  if (who) byId.set(who.id, who);
  const res = await app.inject({
    method, url, headers: { 'x-bidswipe': '1', 'x-test-as': who?.id ?? '', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return { status: res.statusCode, json: res.body ? res.json() : null, text: res.body };
}

const JOB = {
  title: 'Add two outlets and a ceiling fan',
  description: 'Two new outlets on the back wall of the spare room and a ceiling fan where the light is now. TEST job (simulated).',
  trades: ['electrical'], zip: ZIP, address: ADDRESS, phone: PHONE, budgetMaxCents: 100_000, closesInDays: 3,
};

async function postJob(over: Record<string, unknown> = {}, who: Account = poster): Promise<string> {
  const res = await call(who, 'POST', '/api/jobs', { ...JOB, ...over });
  expect(res.status).toBe(201);
  return res.json.job.id as string;
}

const bid = (who: Account, jobId: string, amountCents: number, extra: Record<string, unknown> = {}) =>
  call(who, 'POST', `/api/jobs/${jobId}/bid`, { amountCents, agree: true, ...extra });

async function alertsOf(a: Account): Promise<Array<{ kind: string; title: string; body: string; dedupe_key: string; bid_id: string | null }>> {
  return db.query('select kind, title, body, dedupe_key, bid_id from alerts where profile_id = $1 order by id', [profileOf(a)]);
}

const deps = (): JobsDeps => ({ db, bus: ctx.bus, rules: loadJobRules(() => undefined), appUrl: 'https://bidswipe.example.com' });

// ------------------------------------------------------------------------------------------------------------

describe('modes and sign-in', () => {
  it('single mode answers 404 to every jobs route, like the sign-in routes', async () => {
    const single = await buildServer({ db, profile: loadProfile('lm-electric') }, {});
    for (const [method, url] of [['GET', '/api/jobs/rules'], ['POST', '/api/jobs'], ['GET', '/api/jobs/mine'], ['GET', '/api/jobs/x'],
      ['POST', '/api/jobs/x/bid'], ['DELETE', '/api/jobs/x/bid'], ['POST', '/api/jobs/x/messages'], ['GET', '/api/admin/jobs/reports']] as const) {
      const res = await single.inject({ method, url, headers: { 'x-bidswipe': '1' } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
    await single.close();
  });

  it('a fee setting out of its limits stops the boot with a plain sentence', async () => {
    process.env.JOB_NO_SHOW_FEE_PCT = '12';
    try {
      await expect(buildServer({ db }, { config: accountsConfig() })).rejects.toThrow(/JOB_NO_SHOW_FEE_PCT is 12%, which is above the 10% limit/);
    } finally {
      delete process.env.JOB_NO_SHOW_FEE_PCT;
    }
  });

  it('signed out: 401 sign_in_required; the rules are public and say payments are off', async () => {
    expect(await call(null, 'POST', '/api/jobs', JOB)).toMatchObject({ status: 401, json: { error: 'sign_in_required' } });
    expect(await call(null, 'GET', '/api/jobs/mine')).toMatchObject({ status: 401, json: { error: 'sign_in_required' } });
    const rules = await call(null, 'GET', '/api/jobs/rules');
    expect(rules.json).toEqual({
      rules: { noShowFeePct: 5, posterSharePct: 2, serviceFeePct: 1, contactDays: 7, minCents: 2_000, maxCents: 25_000_000, paymentsOn: false },
    });
  });
});

describe('posting', () => {
  it('refuses bad input with one plain sentence per field', async () => {
    const res = await call(poster, 'POST', '/api/jobs', {
      title: 'short', description: 'too short', trades: ['wizardry'], zip: '00000', phone: 'call me', budgetMaxCents: 1_999, closesInDays: 31,
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('invalid_input');
    const paths = (res.json.fields as Array<{ path: string; message: string }>).map((f) => f.path).sort();
    expect(paths).toEqual(['budgetMaxCents', 'closesInDays', 'description', 'phone', 'title', 'trades', 'zip']);
    for (const f of res.json.fields) expect(f.message).toMatch(/^[A-Z].*\.$/);
    expect((await call(poster, 'POST', '/api/jobs', { ...JOB, budgetMaxCents: 12.5 })).status).toBe(400);
  });

  it('a job shows its city, state and ZIP and nothing finer; the place comes from the ZIP table', async () => {
    const id = await postJob();
    const asNosy = await call(nosy, 'GET', `/api/jobs/${id}`);
    expect(asNosy.json.job.place).toEqual({ city: 'Minden', state: 'NV', zip: '89423' });
    expect(asNosy.json.job.private).toBeNull();
    expect(asNosy.text).not.toContain(ADDRESS);
    expect(asNosy.text).not.toContain('555-0142');
    expect(asNosy.text).not.toMatch(/@example\.com/); // no email on any card
    expect(asNosy.json.job.my).toEqual({ role: 'viewer', bid: null, canBid: true, whyNot: null });
    const asPoster = await call(poster, 'GET', `/api/jobs/${id}`);
    expect(asPoster.json.job.private).toEqual({ address: ADDRESS, phone: PHONE });
    expect(asPoster.json.job.my).toMatchObject({ role: 'poster', canBid: false, whyNot: 'This is your job.' });
    expect(asPoster.json.job.poster).toMatchObject({ id: poster.id, name: 'TEST Poster (simulated)', stats: { posted: expect.any(Number) } });
  });

  it('is rate-limited per account: the 11th post in an hour gets 429', async () => {
    for (let i = 0; i < 10; i++) expect((await call(spammer, 'POST', '/api/jobs', { ...JOB, title: `TEST job number ${i} (simulated)` })).status).toBe(201);
    expect(await call(spammer, 'POST', '/api/jobs', JOB)).toMatchObject({ status: 429, json: { error: 'too_many_attempts' } });
    expect((await call(poster, 'POST', '/api/jobs', JOB)).status).toBe(201); // another account is not affected
  });
});

describe('the feed mirror', () => {
  it("a posted electrical job reaches a nearby electrician's Browse and raises a match alert; never the poster's; never a plumber's", async () => {
    const id = await postJob({ title: 'Swap the garage panel breakers (TEST)' });
    const local = `local:${id}`;
    const browse = await call(sparky, 'GET', '/api/feed?sources=local&limit=200');
    expect(browse.status).toBe(200);
    const item = (browse.json.items as Array<{ id: string; verdict: string; sourceName: string; url: string; category: string }>).find((x) => x.id === local);
    expect(item).toBeDefined();
    expect(['good', 'great']).toContain(item!.verdict);
    expect(item!).toMatchObject({ sourceName: 'Local job', category: 'Electrical', url: `https://bidswipe.example.com/?job=${id}` });
    expect((await alertsOf(sparky)).some((a) => a.kind === 'match' && a.bid_id === local)).toBe(true);

    const own = await call(poster, 'GET', '/api/feed?limit=500');
    expect((own.json.items as Array<{ id: string }>).some((x) => x.id === local)).toBe(false);
    expect((await alertsOf(poster)).some((a) => a.bid_id === local)).toBe(false);
    const rows = await db.query('select 1 from matches where profile_id = $1 and bid_id = $2', [profileOf(poster), local]);
    expect(rows).toHaveLength(0);

    const plumb = await call(plumber, 'GET', '/api/feed?limit=500');
    expect((plumb.json.items as Array<{ id: string }>).some((x) => x.id === local)).toBe(false);
    expect((await alertsOf(plumber)).some((a) => a.bid_id === local)).toBe(false);

    // A scan of the boards neither rewrites nor removes the row.
    const { runScan } = await import('../src/scan.js');
    const before = await db.query('select title, due_at from bids where id = $1', [local]);
    await runScan({
      db, sources: [{ id: 'local', name: 'TEST rogue source', homepage: '', fetch: async () => [{ source: 'local', sourceId: id, sourceName: 'x', title: 'OVERWRITTEN', agency: null, description: null, category: null, postedAt: null, dueAt: null, estValue: null, naics: null, setAside: null, url: 'https://example.com' }] }],
      profiles: async () => [], ctx: { http: { text: async () => '', json: async () => ({}) as never }, now: new Date(clock), env: () => undefined, log: () => {} },
    });
    expect(await db.query('select title, due_at from bids where id = $1', [local])).toEqual(before);

    // Closing (here: the poster cancels) takes it out of every feed at once.
    expect((await call(poster, 'POST', `/api/jobs/${id}/cancel`)).status).toBe(200);
    const after = await call(sparky, 'GET', '/api/feed?sources=local&limit=200');
    expect((after.json.items as Array<{ id: string }>).some((x) => x.id === local)).toBe(false);
  });
});

describe('the life of a job', () => {
  let id: string;
  const A = 81_234; // sparky
  const B = 61_357; // sparky2, placed first
  const C = 61_357; // plumber, the same amount, placed later: loses the tie

  it('bids are sealed while open: an amount never reaches another account', async () => {
    id = await postJob({ title: 'Rewire the barn lights (TEST)' });
    expect((await bid(sparky, id, A, { note: 'TEST note' })).status).toBe(200);
    clock += 60_000;
    expect((await bid(sparky2, id, B)).status).toBe(200);
    clock += 60_000;
    const c = await bid(plumber, id, C);
    expect(c.status).toBe(200);
    expect(c.json.job.my.bid).toMatchObject({ amountCents: C, status: 'active' });

    for (const who of [poster, sparky, nosy]) {
      const res = await call(who, 'GET', `/api/jobs/${id}`);
      expect(res.text).not.toContain(String(B));
      expect(res.json.job.bidCount).toBe(3);
      expect(res.json.job.tab).toBeNull();
      expect(res.json.job.award).toBeNull();
      const mine = await call(who, 'GET', '/api/jobs/mine');
      expect(mine.text).not.toContain(String(B));
    }
    const asSparky = await call(sparky, 'GET', `/api/jobs/${id}`);
    expect(asSparky.json.job.my.bid).toMatchObject({ amountCents: A, note: 'TEST note' });
    expect(asSparky.text).not.toContain(ADDRESS);
    const feed = await call(sparky, 'GET', '/api/feed?sources=local&limit=200');
    expect(feed.text).not.toContain(String(B));
  });

  it('you cannot bid on your own job, above the ceiling, below $20, or without agree: true', async () => {
    expect(await bid(poster, id, 50_000)).toMatchObject({ status: 403, json: { error: 'not_allowed', message: "You can't bid on your own job." } });
    const over = await bid(nosy, id, 100_001);
    expect(over.status).toBe(400);
    expect(over.json).toEqual({ error: 'invalid_input', fields: [{ path: 'amountCents', message: "Your bid is above the poster's budget of $1,000." }] });
    expect((await bid(nosy, id, 1_999)).json.fields[0].path).toBe('amountCents');
    const noAgree = await call(nosy, 'POST', `/api/jobs/${id}/bid`, { amountCents: 50_000 });
    expect(noAgree.json).toEqual({ error: 'invalid_input', fields: [{ path: 'agree', message: 'Tick the box to agree to the rules before you bid.' }] });
    expect(await call(nosy, 'GET', '/api/jobs/no-such-job')).toMatchObject({ status: 404, json: { error: 'not_found' } });
  });

  it('two bids at once from one account leave one bid; withdrawing and bidding again works while open', async () => {
    const [x, y] = await Promise.all([bid(nosy, id, 90_001), bid(nosy, id, 90_002)]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(await db.query('select 1 from job_bids where job_id = $1 and bidder_id = $2', [id, nosy.id])).toHaveLength(1);
    expect((await call(nosy, 'DELETE', `/api/jobs/${id}/bid`)).json.job.my.bid.status).toBe('withdrawn');
    expect(await call(nosy, 'DELETE', `/api/jobs/${id}/bid`)).toMatchObject({ status: 403, json: { error: 'not_allowed' } });
    expect((await call(poster, 'GET', `/api/jobs/${id}`)).json.job.bidCount).toBe(3);
  });

  it('messages are refused before the award', async () => {
    expect(await call(sparky2, 'POST', `/api/jobs/${id}/messages`, { body: 'hi' })).toMatchObject({ status: 403, json: { error: 'not_allowed' } });
  });

  it('at closing the lowest bid wins (the tie goes to the bid placed first); two settlements at once award once', async () => {
    clock = START + 3 * DAY + 1;
    const [s1, s2] = await Promise.all([settleDue(deps(), clock), settleDue(deps(), clock)]);
    expect(s1.closed + s2.closed).toBeGreaterThanOrEqual(1);
    const job = (await db.query<{ status: string; winner_id: string; award_cents: string | number }>('select status, winner_id, award_cents from jobs where id = $1', [id]))[0]!;
    expect(job).toMatchObject({ status: 'awarded', winner_id: sparky2.id });
    expect(Number(job.award_cents)).toBe(B);
    const statuses = await db.query<{ bidder_id: string; status: string }>('select bidder_id, status from job_bids where job_id = $1 order by bidder_id', [id]);
    expect(Object.fromEntries(statuses.map((r) => [r.bidder_id, r.status]))).toEqual({
      [sparky.id]: 'lost', [sparky2.id]: 'won', [plumber.id]: 'lost', [nosy.id]: 'withdrawn',
    });

    // Alerts: once each, however many settlements ran.
    expect((await alertsOf(sparky2)).filter((a) => a.kind === 'job_awarded')).toHaveLength(1);
    expect((await alertsOf(poster)).filter((a) => a.kind === 'job_awarded' && a.dedupe_key.startsWith(id))).toHaveLength(1);
    const lost = (await alertsOf(sparky)).filter((a) => a.kind === 'job_closed');
    expect(lost).toHaveLength(1);
    expect(lost[0]!.body).toBe('Lowest bid: $613.57 · yours: $812.34.');
    expect((await alertsOf(nosy)).some((a) => a.kind.startsWith('job_'))).toBe(false); // withdrew: not told
    expect((await settleDue(deps(), clock)).closed).toBe(0);
  });

  it('after closing: the tab is open to the poster and the bidders, names only to the poster; address and phone to the winner', async () => {
    const asPoster = (await call(poster, 'GET', `/api/jobs/${id}`)).json.job;
    expect(asPoster.tab.map((r: { rank: number; amountCents: number }) => [r.rank, r.amountCents])).toEqual([[1, B], [2, C], [3, A]]);
    expect(asPoster.tab[0].bidder).toMatchObject({ id: sparky2.id, name: 'TEST Sparky Two (simulated)' });
    expect(asPoster.award).toMatchObject({ amountCents: B, isMe: false, winner: { id: sparky2.id } });
    expect(asPoster.award.contactDeadline).toBe(new Date(START + 3 * DAY + 7 * DAY).toISOString());

    const asLoser = await call(sparky, 'GET', `/api/jobs/${id}`);
    expect(asLoser.json.job.tab.map((r: { mine: boolean; bidder: unknown }) => [r.mine, r.bidder])).toEqual([[false, null], [false, null], [true, null]]);
    expect(asLoser.json.job.award).toMatchObject({ amountCents: B, isMe: false, winner: null });
    expect(asLoser.json.job.private).toBeNull();
    expect(asLoser.text).not.toContain(ADDRESS);
    expect(asLoser.text).not.toContain('555-0142');

    const asWinner = await call(sparky2, 'GET', `/api/jobs/${id}`);
    expect(asWinner.json.job.private).toEqual({ address: ADDRESS, phone: PHONE });
    expect(asWinner.json.job.award).toMatchObject({ isMe: true, winner: null });

    const asStranger = await call(nosy, 'GET', `/api/jobs/${id}`);
    expect(asStranger.json.job.tab).toBeNull(); // withdrew before closing: not in the tab
    expect(asStranger.json.job.award).toBeNull();
    expect(asStranger.text).not.toContain(String(B));
    expect(asStranger.text).not.toContain(ADDRESS);
    expect(await call(sparky, 'GET', `/api/jobs/${id}`).then((r) => r.json.messages)).toEqual([]);

    expect(await bid(nosy, id, 30_000)).toMatchObject({ status: 409, json: { error: 'closed', message: 'Bidding on this job has closed.' } });
    expect(await sharesJob(db, poster.id, sparky.id)).toBe(true);
    expect(await sharesJob(db, sparky.id, sparky2.id)).toBe(false);
    expect(await sharesJob(db, poster.id, nosy.id)).toBe(false);
  });

  it('messages run between the poster and the winner only, and tell the other side', async () => {
    expect(await call(sparky, 'POST', `/api/jobs/${id}/messages`, { body: 'me too' })).toMatchObject({ status: 403, json: { error: 'not_allowed' } });
    expect((await call(sparky2, 'POST', `/api/jobs/${id}/messages`, { body: '' })).json.fields[0].path).toBe('body');
    const sent = await call(sparky2, 'POST', `/api/jobs/${id}/messages`, { body: 'Hi, this is TEST Sparky Two. When can I come look?' });
    expect(sent.json.message).toMatchObject({ from: 'winner', mine: true });
    const read = await call(poster, 'GET', `/api/jobs/${id}`);
    expect(read.json.messages).toHaveLength(1);
    expect(read.json.messages[0]).toMatchObject({ from: 'winner', mine: false });
    expect(read.json.job.award.bidderContactedAt).not.toBeNull();
    expect((await alertsOf(poster)).filter((a) => a.kind === 'job_message')).toHaveLength(1);
  });

  it('both confirm → agreed with the 1% service fee recorded (not collected); then the poster marks it done', async () => {
    expect((await call(sparky2, 'POST', `/api/jobs/${id}/confirm`)).json.job.status).toBe('awarded');
    expect(await call(sparky, 'POST', `/api/jobs/${id}/confirm`)).toMatchObject({ status: 403 });
    const [p1, p2] = await Promise.all([call(poster, 'POST', `/api/jobs/${id}/confirm`), call(poster, 'POST', `/api/jobs/${id}/confirm`)]);
    expect([p1.json.job?.status, p2.json.job?.status]).toContain('agreed');
    const fees = await db.query<{ kind: string; amount_cents: string | number; payer_id: string; status: string }>('select kind, amount_cents, payer_id, status from job_fees where job_id = $1', [id]);
    expect(fees.map((f) => [f.kind, Number(f.amount_cents), f.payer_id, f.status])).toEqual([['service', 614, sparky2.id, 'recorded']]);
    const asWinner = (await call(sparky2, 'GET', `/api/jobs/${id}`)).json.job;
    expect(asWinner.fees).toEqual([{ kind: 'service', amountCents: 614, posterShareCents: 0, status: 'recorded', owedByMe: true }]);
    expect((await call(sparky, 'GET', `/api/jobs/${id}`)).json.job.fees).toEqual([]);
    expect(await call(sparky2, 'POST', `/api/jobs/${id}/complete`)).toMatchObject({ status: 403 });
    expect((await call(poster, 'POST', `/api/jobs/${id}/complete`)).json.job.status).toBe('completed');
    expect(await call(poster, 'POST', `/api/jobs/${id}/complete`)).toMatchObject({ status: 409, json: { error: 'closed' } });
    expect(await jobStats(db, sparky2.id)).toMatchObject({ won: 1, agreed: 1, completed: 1, noShows: 0 });
  });
});

describe('when the winner never makes contact', () => {
  let id: string;
  it('a reminder 2 days before, then bidder_no_show with the 5% fee (2% to the poster), recorded once', async () => {
    clock = START + 20 * DAY;
    id = await postJob({ title: 'Hang a porch light (TEST)', closesInDays: 1 });
    expect((await bid(sparky, id, 50_001)).status).toBe(200);
    clock += DAY; // closes
    await rt.tick();
    expect((await call(sparky, 'GET', `/api/jobs/${id}`)).json.job.status).toBe('awarded');
    clock += 5 * DAY + 3_600_000; // 1 day 23 h before the deadline
    await rt.tick();
    await rt.tick();
    const reminders = (await alertsOf(sparky)).filter((a) => a.kind === 'job_deadline');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.title).toBe('2 days left to make contact');

    clock += 2 * DAY;
    const [a, b] = await Promise.all([settleDue(deps(), clock), settleDue(deps(), clock)]);
    expect(a.ended + b.ended).toBe(1);
    const fees = await db.query<{ kind: string; amount_cents: string | number; poster_share_cents: string | number; platform_cents: string | number; basis_cents: string | number; rate_ppm: number }>('select * from job_fees where job_id = $1', [id]);
    expect(fees).toHaveLength(1);
    expect([fees[0]!.kind, Number(fees[0]!.basis_cents), fees[0]!.rate_ppm, Number(fees[0]!.amount_cents), Number(fees[0]!.poster_share_cents), Number(fees[0]!.platform_cents)])
      .toEqual(['no_show', 50_001, 50_000, 2_500, 1_000, 1_500]);
    const asPoster = (await call(poster, 'GET', `/api/jobs/${id}`)).json.job;
    expect(asPoster).toMatchObject({ status: 'unfilled', outcome: 'bidder_no_show' });
    expect(asPoster.fees).toEqual([{ kind: 'no_show', amountCents: 2_500, posterShareCents: 1_000, status: 'recorded', owedByMe: false }]);
    const told = (await alertsOf(sparky)).filter((a) => a.kind === 'job_closed' && a.dedupe_key.startsWith(id));
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toBe('You didn’t make contact in time. Fees are not being collected yet. A no-show is recorded on your profile.'.replace('’', "'"));
    expect(await jobStats(db, sparky.id)).toMatchObject({ noShows: 1 });
  });

  it('the poster reposts it with one tap: a new job, reposted_from set', async () => {
    const res = await call(poster, 'POST', `/api/jobs/${id}/repost`, { closesInDays: 7 });
    expect(res.status).toBe(201);
    expect(res.json.job).toMatchObject({ status: 'open', repostedFrom: id, title: 'Hang a porch light (TEST)' });
    expect(res.json.job.id).not.toBe(id);
    expect(await call(sparky, 'POST', `/api/jobs/${id}/repost`, { closesInDays: 7 })).toMatchObject({ status: 403, json: { error: 'not_allowed' } });
    expect((await call(poster, 'POST', `/api/jobs/${res.json.job.id}/repost`, { closesInDays: 7 })).json.error).toBe('closed');
    // A second "Post again" of the same job is refused: the job is never listed twice.
    const again = await call(poster, 'POST', `/api/jobs/${id}/repost`, { closesInDays: 1 });
    expect(again).toMatchObject({ status: 409, json: { error: 'closed', message: 'This job was already posted again. Open the newer post instead.' } });
    expect(await db.query('select id from jobs where reposted_from = $1', [id])).toHaveLength(1);
    expect(await db.query("select id from bids where id like 'local:%' and id in (select 'local:' || id from jobs where reposted_from = $1)", [id])).toHaveLength(1);
  });

  it('a repost that slips past the check (two requests at once) is stopped by the unique index', async () => {
    // Both requests can pass hasRepost() before either inserts; the second insert must then write nothing.
    const src = (await db.query<{ id: string }>('select id from jobs where reposted_from = $1', [id]))[0]!;
    const orig = (await getJobRow(db, id))!;
    const second = await insertJob(db, {
      id: 'TEST-race-repost', posterId: orig.posterId, title: orig.title, description: orig.description, trades: orig.trades,
      zip: orig.zip, city: orig.city, state: orig.state, lat: orig.lat, lng: orig.lng, address: null, phone: null,
      budgetMaxCents: null, postedAt: clock, closesAt: clock + DAY, repostedFrom: id,
    });
    expect(second).toBeNull();
    expect((await db.query('select id from jobs where reposted_from = $1', [id])).map((r: any) => r.id)).toEqual([src.id]);
  });

  it('an operator can waive the fee, list reports and take a job down (it disappears everywhere)', async () => {
    const fee = (await db.query<{ id: string | number }>('select id from job_fees where job_id = $1', [id]))[0]!;
    current = null;
    expect((await app.inject({ method: 'POST', url: `/api/admin/jobs/fees/${fee.id}/waive` })).statusCode).toBe(401);
    const waived = await app.inject({ method: 'POST', url: `/api/admin/jobs/fees/${fee.id}/waive`, headers: { 'x-admin-token': ADMIN } });
    expect(waived.json().fee).toMatchObject({ status: 'waived' });
    expect((await call(poster, 'GET', `/api/jobs/${id}`)).json.job.fees[0].status).toBe('waived');

    const target = await postJob({ title: 'TEST job to report (simulated)' });
    expect((await call(nosy, 'POST', `/api/jobs/${target}/report`, { reason: '' })).json.error).toBe('invalid_input');
    expect(await call(nosy, 'POST', `/api/jobs/${target}/report`, { reason: 'TEST: looks like spam' })).toMatchObject({ status: 200, json: { ok: true } });
    current = null;
    const reports = await app.inject({ url: '/api/admin/jobs/reports', headers: { 'x-admin-token': ADMIN } });
    expect(reports.json().reports[0]).toMatchObject({ jobId: target, reason: 'TEST: looks like spam' });
    const removed = await app.inject({ method: 'POST', url: `/api/admin/jobs/${target}/remove`, headers: { 'x-admin-token': ADMIN } });
    expect(removed.json()).toEqual({ ok: true });
    expect(await call(poster, 'GET', `/api/jobs/${target}`)).toMatchObject({ status: 404, json: { error: 'not_found' } });
    expect(await db.query('select 1 from bids where id = $1', [`local:${target}`])).toHaveLength(0);
  });
});

describe('giving the job back, and the poster cancelling', () => {
  it('back-out after the award = unfilled / bidder_backed_out with the no-show fee', async () => {
    clock = START + 40 * DAY;
    const id = await postJob({ title: 'Move a light switch (TEST)', closesInDays: 1 });
    await bid(sparky2, id, 30_000);
    clock += DAY;
    expect(await call(sparky, 'POST', `/api/jobs/${id}/back-out`)).toMatchObject({ status: 403 });
    const res = await call(sparky2, 'POST', `/api/jobs/${id}/back-out`);
    expect(res.json.job).toMatchObject({ status: 'unfilled', outcome: 'bidder_backed_out' });
    expect(res.json.job.fees).toEqual([{ kind: 'no_show', amountCents: 1_500, posterShareCents: 600, status: 'recorded', owedByMe: true }]);
    expect(await call(sparky2, 'POST', `/api/jobs/${id}/back-out`)).toMatchObject({ status: 409, json: { error: 'closed' } });
  });

  it('cancel after the award = unfilled / poster_cancelled, no fee; contact that was answered but not agreed = no fee', async () => {
    clock = START + 50 * DAY;
    const id = await postJob({ title: 'Fix a flickering kitchen light (TEST)', closesInDays: 1 });
    await bid(sparky, id, 25_000);
    clock += DAY;
    expect((await call(poster, 'POST', `/api/jobs/${id}/cancel`)).json.job).toMatchObject({ status: 'unfilled', outcome: 'poster_cancelled', fees: [] });

    const id2 = await postJob({ title: 'Install a doorbell camera (TEST)', closesInDays: 1 });
    await bid(sparky, id2, 25_000);
    clock += DAY;
    expect((await call(poster, 'POST', `/api/jobs/${id2}/contacted`)).status).toBe(200);
    clock += 8 * DAY;
    const job = (await call(poster, 'GET', `/api/jobs/${id2}`)).json.job;
    expect(job).toMatchObject({ status: 'unfilled', outcome: 'no_agreement', fees: [] });
    expect(await db.query('select 1 from job_fees where job_id = $1', [id2])).toHaveLength(0);
  });

  it('a job nobody bid on ends no_bids; a poster-only answer missing = poster_no_show, no fee', async () => {
    clock = START + 70 * DAY;
    const empty = await postJob({ title: 'Nobody wants this TEST job', closesInDays: 1 });
    const id = await postJob({ title: 'Replace an outdoor outlet (TEST)', closesInDays: 1 });
    await bid(sparky, id, 22_222);
    clock += DAY;
    expect((await call(poster, 'GET', `/api/jobs/${empty}`)).json.job).toMatchObject({ status: 'unfilled', outcome: 'no_bids', tab: [] });
    await call(sparky, 'POST', `/api/jobs/${id}/messages`, { body: 'TEST: I can do Tuesday.' });
    clock += 8 * DAY;
    expect((await call(sparky, 'GET', `/api/jobs/${id}`)).json.job).toMatchObject({ status: 'unfilled', outcome: 'poster_no_show', fees: [] });
    expect(await call(sparky, 'POST', `/api/jobs/${id}/messages`, { body: 'late' })).toMatchObject({ status: 409, json: { error: 'closed' } });
  });
});

describe('the contact rule is fair to both sides', () => {
  const tapAlerts = async (a: Account, jobId: string) =>
    (await alertsOf(a)).filter((x) => x.kind === 'job_message' && x.dedupe_key.startsWith(`${jobId}:agreed:`));

  it('a winner who ghosts and sends "hi" one minute before the deadline does not put a no-show on the poster', async () => {
    clock = START + 100 * DAY;
    const before = await jobStats(db, poster.id);
    const id = await postJob({ title: 'Swap a breaker (TEST, last-minute hi)', closesInDays: 1 });
    await bid(sparky, id, 33_333);
    clock += DAY; // awarded; deadline in 7 days
    clock += 7 * DAY - 60_000;
    expect((await call(sparky, 'POST', `/api/jobs/${id}/messages`, { body: 'TEST: hi' })).status).toBe(200);
    clock += 60_000;
    const job = (await call(poster, 'GET', `/api/jobs/${id}`)).json.job;
    expect(job).toMatchObject({ status: 'unfilled', outcome: 'no_agreement', fees: [] });
    expect((await jobStats(db, poster.id)).posterNoShows).toBe(before.posterNoShows);
    expect(await db.query('select 1 from job_fees where job_id = $1', [id])).toHaveLength(0);
  });

  it('an early message the poster never answers is still a poster no-show (no fee)', async () => {
    clock = START + 110 * DAY;
    const before = await jobStats(db, poster.id);
    const id = await postJob({ title: 'Wire a shed light (TEST, early hi)', closesInDays: 1 });
    await bid(sparky, id, 44_444);
    clock += DAY;
    clock += 7 * DAY - 48 * 3_600_000; // exactly deadline − 48 h: still a fair chance to answer
    expect((await call(sparky, 'POST', `/api/jobs/${id}/messages`, { body: 'TEST: when can I come look?' })).status).toBe(200);
    clock += 48 * 3_600_000;
    expect((await call(poster, 'GET', `/api/jobs/${id}`)).json.job).toMatchObject({ status: 'unfilled', outcome: 'poster_no_show', fees: [] });
    expect((await jobStats(db, poster.id)).posterNoShows).toBe(before.posterNoShows + 1);
  });

  it('agreed by phone, only the poster taps "We\'ve agreed": contact counts, no fee, the winner is told once', async () => {
    clock = START + 120 * DAY;
    const before = await jobStats(db, sparky.id);
    const id = await postJob({ title: 'Install a range outlet (TEST, poster tap)', closesInDays: 1 });
    await bid(sparky, id, 55_555);
    clock += DAY;
    const first = await call(poster, 'POST', `/api/jobs/${id}/confirm`);
    expect(first.json.job.status).toBe('awarded');
    expect(first.json.job.award.bidderContactedAt).toBe(new Date(clock).toISOString());
    expect(first.json.job.award.posterContactedAt).toBe(new Date(clock).toISOString());
    clock += 1_000;
    expect((await call(poster, 'POST', `/api/jobs/${id}/confirm`)).status).toBe(200); // a second tap tells nobody again
    const told = await tapAlerts(sparky, id);
    expect(told).toHaveLength(1);
    expect(told[0]!.title).toBe('The poster tapped “We’ve agreed” · Install a range outlet (TEST, poster tap)');
    expect(told[0]!.body).toMatch(/If that’s right, open the job and tap it too\.$/);
    expect(await tapAlerts(poster, id)).toHaveLength(0); // never to the person who tapped
    clock += 7 * DAY;
    expect((await call(sparky, 'GET', `/api/jobs/${id}`)).json.job).toMatchObject({ status: 'unfilled', outcome: 'no_agreement', fees: [] });
    expect(await db.query('select 1 from job_fees where job_id = $1', [id])).toHaveLength(0);
    expect((await jobStats(db, sparky.id)).noShows).toBe(before.noShows);
  });

  it('only the winner taps "We\'ve agreed": no fee, no "2 days left" reminder, the poster is told once', async () => {
    clock = START + 130 * DAY;
    const before = await jobStats(db, sparky.id);
    const id = await postJob({ title: 'Mount a TV and hide the wire (TEST, winner tap)', closesInDays: 1 });
    await bid(sparky, id, 66_666);
    clock += DAY;
    await Promise.all([call(sparky, 'POST', `/api/jobs/${id}/confirm`), call(sparky, 'POST', `/api/jobs/${id}/confirm`)]);
    expect(await tapAlerts(poster, id)).toHaveLength(1);
    expect((await tapAlerts(poster, id))[0]!.title).toMatch(/^The winner tapped “We’ve agreed” · /);
    expect(await tapAlerts(sparky, id)).toHaveLength(0);
    clock += 5 * DAY + 3_600_000; // inside the last 2 days
    await rt.tick();
    expect((await alertsOf(sparky)).filter((a) => a.kind === 'job_deadline' && a.dedupe_key.startsWith(id))).toHaveLength(0);
    clock += 2 * DAY;
    expect((await call(poster, 'GET', `/api/jobs/${id}`)).json.job).toMatchObject({ status: 'unfilled', outcome: 'no_agreement', fees: [] });
    expect((await jobStats(db, sparky.id)).noShows).toBe(before.noShows);
  });

  it('a tap that completes the agreement sends the "Agreed" alerts and no "tap it too" alert', async () => {
    clock = START + 140 * DAY;
    const id = await postJob({ title: 'Add a dedicated freezer circuit (TEST)', closesInDays: 1 });
    await bid(sparky, id, 77_777);
    clock += DAY;
    await call(sparky, 'POST', `/api/jobs/${id}/confirm`);
    expect((await call(poster, 'POST', `/api/jobs/${id}/confirm`)).json.job.status).toBe('agreed');
    expect(await tapAlerts(poster, id)).toHaveLength(1); // the winner's one-sided tap, earlier
    expect(await tapAlerts(sparky, id)).toHaveLength(0); // the poster's tap completed it
    expect((await alertsOf(sparky)).filter((a) => a.kind === 'job_closed' && a.dedupe_key.startsWith(id)).map((a) => a.title))
      .toEqual(['Agreed: Add a dedicated freezer circuit (TEST)']);
  });

  it('both sides tapping "We\'ve agreed" at the same moment ends agreed and leaves nobody asked to "tap it too"', async () => {
    for (const [i, order] of [[0, 'poster first'], [1, 'winner first']] as const) {
      clock = START + (150 + i * 10) * DAY;
      const id = await postJob({ title: `Swap a breaker panel, ${order} (TEST)`, closesInDays: 1 });
      await bid(sparky, id, 66_666);
      clock += DAY;
      const taps = i === 0
        ? [call(poster, 'POST', `/api/jobs/${id}/confirm`), call(sparky, 'POST', `/api/jobs/${id}/confirm`)]
        : [call(sparky, 'POST', `/api/jobs/${id}/confirm`), call(poster, 'POST', `/api/jobs/${id}/confirm`)];
      const answers = await Promise.all(taps);
      expect(answers.map((a) => a.status)).toEqual([200, 200]);
      expect(answers.map((a) => a.json.job.status)).toContain('agreed');
      // Nobody who already tapped is asked to tap: an alert decided before the second tap landed is retired
      // (read, never pushed) the moment the job is agreed.
      const unread = async (a: Account) => (await db.query<{ n: number | string }>(
        `select count(*) as n from alerts where profile_id = $1 and dedupe_key like $2 and read_at is null`,
        [profileOf(a), `${id}:agreed:%`]))[0]!.n;
      expect(Number(await unread(poster))).toBe(0);
      expect(Number(await unread(sparky))).toBe(0);
      expect((await call(poster, 'GET', `/api/jobs/${id}`)).json.job.status).toBe('agreed');
    }
  });
});
