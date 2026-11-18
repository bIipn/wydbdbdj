import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth } from '../src/auth/index.js';
import { openSession } from '../src/auth/sessions.js';
import { findCredentials } from '../src/db/accounts.js';
import { openDb, type Db } from '../src/db/db.js';
import { upsertBids } from '../src/db/repo.js';
import { loadProfile } from '../src/profiles.js';
import { createRealtime, type Realtime } from '../src/realtime/index.js';
import { DELETE_ACCOUNT_LIMIT, DELETE_WORDS } from '../src/routes/account.js';
import { buildApp, buildServer } from '../src/server.js';
import { accountsConfig, memoryDb, seedAccount, testBid } from './helpers.js';

/**
 * "Delete account" (POST /api/account/delete) through the real server in accounts mode, with real sign-up, sign-in
 * and cookie sessions and an injected clock. Everyone here is synthetic (TEST- names at example.com).
 *
 * The whole suite runs on the embedded database, and again on a REAL Postgres when TEST_DATABASE_URL names a
 * throwaway one (it works in its own schema, test_account_delete, and drops it afterwards):
 *   TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/scratch npx vitest run test/account-delete.test.ts
 * There, the burst of wrong passwords really runs at the same time (a pool of connections).
 */

const DAY = 86_400_000;
const MIN = 60_000;
const START = Date.parse('2026-11-14T18:00:00Z');
const ADMIN = 'TEST-admin-token-delete';
const PASSWORD = 'TEST-password-123';
const ZIP = '95675';
const PG_SCHEMA = 'test_account_delete';

// web/js is plain JavaScript with no type declarations; a computed path keeps tsc from asking for them.
const wordsPath = '../web/js/job-words.js';
const words = (await import(wordsPath)) as {
  stage: (job: unknown, o?: { now?: number }) => { group: string; status: string; next: string | null };
  WINNER_DELETED: string;
};

interface Person { id: string; email: string; cookie: string }
interface Answer { status: number; json: Record<string, any>; headers: Record<string, unknown> }

/** Every column that holds an account id (and the profile id columns), per table: read from the database itself, so a
 *  table added later is checked too. */
const ACCOUNT_COLUMNS = ['account_id', 'poster_id', 'winner_id', 'bidder_id', 'sender_id', 'payer_id', 'reporter_id', 'subject_id'];

/** A seam for the races: `hold.run` runs once, right before the next statement whose text starts with `hold.prefix`
 *  (the statement then runs as it would have: a deletion that lands in that gap, as the review held it there). */
interface Hold { prefix: string; run: (params: unknown[]) => Promise<void> }
function withSeam(raw: Db, hold: { next: Hold | null }): Db {
  return {
    kind: raw.kind,
    exec: (sql) => raw.exec(sql),
    close: () => raw.close(),
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const h = hold.next;
      if (h && sql.trimStart().startsWith(h.prefix)) {
        hold.next = null;
        await h.run(params ?? []);
      }
      return raw.query<T>(sql, params);
    },
  };
}

function suite(label: string, open: () => Promise<Db>, close: (db: Db) => Promise<void>): void {
  describe(label, () => {
    let db: Db;
    const hold: { next: Hold | null } = { next: null };
    let app: FastifyInstance;
    let rt: Realtime;
    let clock = START;
    let seq = 0;

    beforeAll(async () => {
      db = withSeam(await open(), hold);
      const config = accountsConfig({ adminToken: ADMIN, appUrl: 'https://bidswipe.example.com' });
      const now = () => new Date(clock);
      const built = await buildApp({ db }, { config, auth: createAuth(db, config, { now, cost: { ln: 10, r: 8, p: 1 } }), now });
      app = built.app;
      rt = createRealtime(built.ctx, { sender: null, tickMs: 0 });
      // A stored public TEST bid far in the future: profiles score it when they are saved, and people save it.
      await upsertBids(db, [testBid({ sourceId: 'TEST-delete-1', dueAt: '2028-12-01T22:00:00.000Z', title: 'TEST panel upgrade for the delete test (synthetic)', location: { city: 'Auburn', state: 'CA' } })], new Date(clock));
    }, 60_000);
    afterAll(async () => {
      rt?.stop();
      await app?.close();
      if (db) await close(db);
    });

    // ------------------------------------------------------------------------------------------------ helpers --

    const tokenOf = (setCookie: unknown): string => /bs_session=([^;]*)/.exec([setCookie].flat().join(';'))?.[1] ?? '';

    async function call(who: Person | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, o: { csrf?: boolean; cookie?: string } = {}): Promise<Answer> {
      const headers: Record<string, string> = {};
      if (o.csrf !== false) headers['x-bidswipe'] = '1';
      const cookie = o.cookie ?? who?.cookie;
      if (cookie) headers.cookie = `bs_session=${cookie}`;
      if (url.startsWith('/api/admin/')) headers['x-admin-token'] = ADMIN;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
      return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, headers: res.headers };
    }
    const ok = async (p: Promise<Answer>, status = 200): Promise<Answer> => {
      const res = await p;
      expect(res.status, JSON.stringify(res.json)).toBe(status);
      return res;
    };

    async function signUp(tag: string, trade = 'electrical'): Promise<Person> {
      const email = `test-del-${tag}-${++seq}@example.com`;
      const res = await ok(call(null, 'POST', '/api/auth/signup', { email, password: PASSWORD, name: `TEST ${tag} (simulated)` }), 201);
      const p = { id: res.json.account.id as string, email, cookie: tokenOf(res.headers['set-cookie']) };
      await ok(call(p, 'PUT', '/api/profile', {
        intent: 'both', businessName: `TEST ${tag} Shop (simulated)`, trades: [trade], zip: ZIP, radiusMi: 100, valueRange: { min: 10_000, max: 500_000 },
      }));
      return p;
    }

    const JOB = (title: string, trade = 'electrical', closesInDays = 1) => ({
      title, description: 'Four exterior fixtures on an existing circuit. TEST job (simulated).', trades: [trade], zip: ZIP,
      address: '9 TEST Lane (simulated)', phone: '916-555-0142', budgetMaxCents: 90_000, closesInDays,
    });
    const postJob = async (p: Person, title: string, o: { trade?: string; days?: number } = {}): Promise<string> =>
      (await ok(call(p, 'POST', '/api/jobs', JOB(title, o.trade, o.days)), 201)).json.job.id;
    const bid = (p: Person, jobId: string, amountCents: number) => ok(call(p, 'POST', `/api/jobs/${jobId}/bid`, { amountCents, agree: true }));
    const jobAs = async (p: Person, jobId: string) => (await ok(call(p, 'GET', `/api/jobs/${jobId}`))).json.job;
    const remove = (p: Person, body: unknown = { password: PASSWORD }, o: { csrf?: boolean; cookie?: string } = {}) =>
      call(p, 'POST', '/api/account/delete', body, o);
    /** Move the clock and let the marketplace settle what is due (every jobs route does that first). */
    const later = async (ms: number, who: Person): Promise<void> => {
      clock += ms;
      await ok(call(who, 'GET', '/api/jobs/mine'));
    };

    const count = async (sql: string, params: unknown[]): Promise<number> => Number((await db.query<{ n: string | number }>(sql, params))[0]!.n);
    const profileIdOf = async (p: Person): Promise<string> => (await db.query<{ id: string }>('select id from profiles where account_id = $1', [p.id]))[0]?.id ?? '';

    /** Every (table, column) in this database whose column holds an account id or a profile id. */
    async function idColumns(): Promise<Array<{ table: string; column: string }>> {
      const rows = await db.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
         where table_schema = current_schema() and (column_name = any($1::text[]) or column_name = 'profile_id')
         order by table_name, column_name`,
        [[...ACCOUNT_COLUMNS]],
      );
      return rows.map((r) => ({ table: r.table_name, column: r.column_name }));
    }

    /**
     * How many rows each table holds for this person (by account id, by profile id), plus their counters. `notAbout`:
     * feed rows (bid ids) left out of the count, for a bystander whose profile was scored on the deleted account's jobs.
     */
    async function footprint(p: Person, profileId?: string, notAbout: string[] = []): Promise<Record<string, number>> {
      const profile = profileId ?? await profileIdOf(p);
      const out: Record<string, number> = {};
      const withBid = new Set((await db.query<{ table_name: string }>(
        `select table_name from information_schema.columns where table_schema = current_schema() and column_name = 'bid_id'`,
      )).map((r) => r.table_name));
      for (const { table, column } of await idColumns()) {
        const skip = column === 'profile_id' && withBid.has(table) ? ' and (bid_id is null or bid_id <> all($2::text[]))' : '';
        out[`${table}.${column}`] = await count(`select count(*) as n from ${table} where ${column} = $1${skip}`,
          [column === 'profile_id' ? profile : p.id, ...(skip ? [notAbout] : [])]);
      }
      out['accounts.id'] = await count('select count(*) as n from accounts where id = $1 or email = $2', [p.id, p.email]);
      out['profiles.id'] = await count('select count(*) as n from profiles where id = $1', [profile]);
      out['auth_attempts.key'] = await count(
        `select count(*) as n from auth_attempts where strpos(key, $1) > 0 or strpos(key, $2) > 0 or key = 'estimate:' || $3`, [p.email, p.id, profile],
      );
      return out;
    }

    // ------------------------------------------------------------------------------------------------- the gate --

    it('single mode has no accounts: the route answers 404 there', async () => {
      const single = await buildServer({ db, profile: loadProfile('lm-electric') }, {});
      const res = await single.inject({ method: 'POST', url: '/api/account/delete', headers: { 'x-bidswipe': '1', 'content-type': 'application/json' }, payload: '{"password":"TEST-x-12345"}' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
      await single.close();
    });

    it('signed out is 401; a signed-in request without the CSRF header is 403 and deletes nothing', async () => {
      const p = await signUp('gate');
      const out = await call(null, 'POST', '/api/account/delete', { password: PASSWORD });
      expect([out.status, out.json]).toEqual([401, { error: 'sign_in_required' }]);
      const forged = await remove(p, { password: PASSWORD }, { csrf: false });
      expect([forged.status, forged.json]).toEqual([403, { error: 'csrf' }]);
      expect(await findCredentials(db, p.email)).not.toBeNull();
    });

    it('nothing to check is a 400 and is not counted; a wrong password is 401', async () => {
      const p = await signUp('empty');
      for (const body of [{}, { password: '' }, { password: 42 }, { email: p.email }, [PASSWORD], 'null']) {
        const res = await remove(p, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.json).toEqual({ error: 'password_required', message: DELETE_WORDS.passwordRequired });
      }
      const deleteCounts = `select coalesce(sum(count), 0) as n from auth_attempts where starts_with(key, $1)`;
      expect(await count(deleteCounts, [`account:delete:${p.id}:`])).toBe(0);
      const wrong = await remove(p, { password: 'TEST-not-the-password' });
      expect([wrong.status, wrong.json]).toEqual([401, { error: 'wrong_password', message: DELETE_WORDS.wrongPassword }]);
      // 129 characters: longer than any password can be, refused without a hash, and counted like any wrong one.
      expect((await remove(p, { password: 'x'.repeat(129) })).status).toBe(401);
      expect(await count(deleteCounts, [`account:delete:${p.id}:`])).toBe(2);
      expect(await findCredentials(db, p.email)).not.toBeNull();
    });

    it('counted first: 20 wrong passwords at once give exactly 5 × 401 and 15 × 429 with the time left; the right one waits too', async () => {
      const p = await signUp('burst');
      const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => remove(p, { password: `TEST-wrong-guess-${i}` })));
      const by = (s: number) => burst.filter((r) => r.status === s).length;
      expect([by(401), by(429)]).toEqual([DELETE_ACCOUNT_LIMIT.limit, 20 - DELETE_ACCOUNT_LIMIT.limit]);
      const limited = burst.find((r) => r.status === 429)!;
      expect(limited.json).toEqual({ error: 'too_many_attempts', message: 'Too many wrong tries. Wait 15 minutes, then try again.' });
      expect(Number(limited.headers['retry-after'])).toBe(15 * 60);

      clock += 10 * MIN;
      const right = await remove(p);
      expect(right.status).toBe(429); // the right password too: a 200 would say which guess was right
      expect(right.json.message).toBe('Too many wrong tries. Wait 5 minutes, then try again.');
      expect(await findCredentials(db, p.email)).not.toBeNull();

      clock += 5 * MIN + 1000; // the window is over
      const done = await remove(p);
      expect([done.status, done.json]).toEqual([200, { ok: true }]);
      expect(await findCredentials(db, p.email)).toBeNull();
    });

    it('counted per session: a stolen session\'s wrong guesses never lock the owner\'s own session out (review del-4)', async () => {
      const p = await signUp('two-devices');
      const thief = p.cookie; // the session a thief copied
      const owner = tokenOf((await ok(call(null, 'POST', '/api/auth/login', { email: p.email, password: PASSWORD }))).headers['set-cookie']);
      expect(owner).not.toBe(thief);
      for (let window = 0; window < 3; window++) {
        // Every window the thief uses up its allowance first ...
        for (let i = 0; i < DELETE_ACCOUNT_LIMIT.limit; i++) expect((await remove(p, { password: `TEST-guess-${window}-${i}` }, { cookie: thief })).status).toBe(401);
        expect((await remove(p, { password: 'TEST-one-more-guess' }, { cookie: thief })).status).toBe(429);
        // ... and the owner's session still answers a typo as a typo, never "too many".
        const typo = await remove(p, { password: 'TEST-owner-typo' }, { cookie: owner });
        expect([typo.status, typo.json.error]).toEqual([401, 'wrong_password']);
        clock += DELETE_ACCOUNT_LIMIT.windowMs + 1000;
      }
      const done = await remove(p, { password: PASSWORD }, { cookie: owner });
      expect([done.status, done.json]).toEqual([200, { ok: true }]);
      expect(await count(`select count(*) as n from auth_attempts where strpos(key, $1) > 0`, [p.id])).toBe(0); // every session's counter went
      expect((await call(p, 'GET', '/api/me', undefined, { cookie: thief })).status).toBe(401);
    });

    it('an account with no password (social sign-in) confirms with its email address instead', async () => {
      const s = await seedAccount(db, { id: `TEST-del-social-${label.length}-${++seq}`, email: `test-del-social-${seq}@example.com`, name: 'TEST Social (simulated)' });
      const person: Person = { id: s.id, email: s.email, cookie: await openSession(db, s.id, new Date(clock)) };
      const asked = await remove(person, { password: 'TEST-anything-123' });
      expect([asked.status, asked.json]).toEqual([400, { error: 'email_required', message: DELETE_WORDS.emailRequired }]);
      const wrong = await remove(person, { email: 'someone-else@example.com' });
      expect([wrong.status, wrong.json]).toEqual([401, { error: 'wrong_email', message: DELETE_WORDS.wrongEmail }]);
      const done = await remove(person, { email: `  ${s.email.toUpperCase()} ` });
      expect([done.status, done.json]).toEqual([200, { ok: true }]);
      expect(await count('select count(*) as n from accounts where id = $1', [s.id])).toBe(0);
      expect((await call(person, 'GET', '/api/me')).status).toBe(401);
    });

    // ------------------------------------------------------------------------------------ jobs in progress --

    it('refused while in a job in progress: open with a bid, awarded (poster and winner), agreed; nothing is touched', async () => {
      const poster = await signUp('busy-poster');
      const winner = await signUp('busy-winner');
      const jobId = await postJob(poster, 'TEST Busy job with a bid (simulated)');
      await bid(winner, jobId, 41_000);
      const before = await footprint(poster);

      const open = await remove(poster);
      expect(open.status).toBe(409);
      expect(open.json).toEqual({ error: 'job_in_progress', message: DELETE_WORDS.inProgress, jobs: [{ id: jobId, title: 'TEST Busy job with a bid (simulated)' }] });
      expect(await footprint(poster)).toEqual(before); // nothing went, the counter included (a right password gives it back)
      expect(await count('select count(*) as n from bids where id = $1', [`local:${jobId}`])).toBe(1);

      await later(DAY + MIN, poster);
      expect((await jobAs(poster, jobId)).status).toBe('awarded');
      for (const who of [poster, winner]) {
        const res = await remove(who);
        expect(res.status, who.email).toBe(409);
        expect(res.json.jobs).toEqual([{ id: jobId, title: 'TEST Busy job with a bid (simulated)' }]);
      }

      await ok(call(winner, 'POST', `/api/jobs/${jobId}/confirm`));
      await ok(call(poster, 'POST', `/api/jobs/${jobId}/confirm`));
      expect((await jobAs(poster, jobId)).status).toBe('agreed');
      clock += 20 * DAY; // an agreed job has no deadline: it is in progress for its poster until they mark it done
      expect((await remove(poster)).status).toBe(409);
      expect(await findCredentials(db, poster.email)).not.toBeNull();
    });

    it('the winner of an agreed job is never held: only the poster can end it (review del-1); the job keeps its record', async () => {
      const poster = await signUp('agreed-poster');
      const winner = await signUp('agreed-winner');
      const jobId = await postJob(poster, 'TEST Agreed, never marked done (simulated)');
      await bid(winner, jobId, 46_000);
      await later(DAY + MIN, poster);
      await ok(call(winner, 'POST', `/api/jobs/${jobId}/messages`, { body: 'TEST hello from the winner (simulated)' }));
      await ok(call(winner, 'POST', `/api/jobs/${jobId}/confirm`));
      await ok(call(poster, 'POST', `/api/jobs/${jobId}/confirm`));
      clock += 400 * DAY; // the poster never taps "Job done"; the winner can neither back out, cancel nor mark it done
      const again = async (p: Person): Promise<Person> => ({
        ...p, cookie: tokenOf((await ok(call(null, 'POST', '/api/auth/login', { email: p.email, password: PASSWORD }))).headers['set-cookie']),
      });
      const back = await again(winner);
      const owner = await again(poster);
      expect((await call(back, 'POST', `/api/jobs/${jobId}/back-out`)).status).toBe(409);
      expect((await call(back, 'POST', `/api/jobs/${jobId}/complete`)).status).toBe(403);
      const gone = await remove(back);
      expect([gone.status, gone.json]).toEqual([200, { ok: true }]);

      const job = await jobAs(owner, jobId);
      expect([job.status, job.award.amountCents, job.award.winner, job.award.winnerDeleted, job.fees]).toEqual(['agreed', 46_000, null, true, []]);
      expect(words.stage(job, { now: clock })).toEqual({ group: 'needs', status: 'Agreed at $460', next: `${words.WINNER_DELETED} Tap “Job done” when the work is finished.` });
      expect((await call(owner, 'GET', `/api/jobs/${jobId}/conversation`)).status).toBe(403);
      // The poster still ends it with "Job done", and can then go too.
      expect((await remove(owner)).status).toBe(409);
      expect((await ok(call(owner, 'POST', `/api/jobs/${jobId}/complete`))).json.job.status).toBe('completed');
      expect((await remove(owner)).status).toBe(200);
    });

    it('settles first: an open job past its closing is awarded (409), an awarded job past its window ends (200)', async () => {
      const poster = await signUp('due-poster');
      const winner = await signUp('due-winner');
      const jobId = await postJob(poster, 'TEST Job closing right now (simulated)');
      await bid(winner, jobId, 42_000);
      clock += DAY + MIN; // nobody opened anything since: the deletion's own settlement awards it
      const res = await remove(poster);
      expect(res.status).toBe(409);
      expect(res.json.jobs.map((j: { id: string }) => j.id)).toEqual([jobId]);
      expect((await db.query<{ status: string }>('select status from jobs where id = $1', [jobId]))[0]!.status).toBe('awarded');

      clock += 7 * DAY + MIN; // the contact window ran out, unsettled: it is no longer in progress
      const gone = await remove(winner);
      expect([gone.status, gone.json]).toEqual([200, { ok: true }]);
      const job = await jobAs(poster, jobId);
      expect([job.status, job.outcome, job.award.winnerDeleted, job.award.winner, job.fees]).toEqual(['unfilled', 'bidder_no_show', true, null, []]);
      const st = words.stage(job, { now: clock });
      expect(st.next).toBe(`${words.WINNER_DELETED} You can post it again with one tap.`);
    });

    it('allowed with an open job WITHOUT bids (it goes, with its feed copy) and with a bid on someone else\'s open job (the bid goes)', async () => {
      const poster = await signUp('quiet-poster');
      const other = await signUp('other-poster');
      const lonely = await postJob(poster, 'TEST Job nobody bid on (simulated)', { days: 5 });
      const othersJob = await postJob(other, 'TEST Someone else\'s open job (simulated)', { days: 5 });
      await bid(poster, othersJob, 43_000);
      expect(await count('select count(*) as n from matches where bid_id = $1', [`local:${lonely}`])).toBeGreaterThan(0);

      expect((await remove(poster)).status).toBe(200);
      expect(await count('select count(*) as n from jobs where id = $1', [lonely])).toBe(0);
      for (const table of ['bids where id', 'matches where bid_id', 'swipes where bid_id', 'alerts where bid_id']) {
        expect(await count(`select count(*) as n from ${table} = $1`, [`local:${lonely}`]), table).toBe(0);
      }
      const theirs = await jobAs(other, othersJob);
      expect([theirs.status, theirs.bidCount]).toEqual(['open', 0]);
      expect(await count('select count(*) as n from job_bids where job_id = $1', [othersJob])).toBe(0);
      expect(await count('select count(*) as n from bids where id = $1', [`local:${othersJob}`])).toBe(1);
    });

    // ----------------------------------------------------------------------------- everything tied to it --

    it('deletes everything tied to the account, leaves no row anywhere, and the other people\'s pages still work', async () => {
      // D: the account that goes. X: D won X's job (done). W: D gave W's job back (a no-show fee); W won D's job.
      // Y: D has an active bid on Y's open job. Z and V: plumbers who never dealt with D (the bystanders).
      const D = await signUp('d');
      const X = await signUp('x');
      const W = await signUp('w');
      const Y = await signUp('y');
      const Z = await signUp('z', 'plumbing');
      const V = await signUp('v', 'plumbing');
      const dProfile = await profileIdOf(D);
      const publicBid = testBid({ sourceId: 'TEST-delete-1' }).id;
      await ok(call(D, 'POST', '/api/swipe', { bidId: publicBid, action: 'save' }));
      await ok(call(Z, 'POST', '/api/swipe', { bidId: publicBid, action: 'save' }));
      await ok(call(D, 'PUT', '/api/work-profile', { headline: 'TEST Licensed electrician (simulated)', yearsExperience: 12 }));
      await ok(call(Z, 'PUT', '/api/work-profile', { headline: 'TEST Plumber (simulated)', yearsExperience: 7 }));

      const jX = await postJob(X, 'TEST X porch lights (simulated)');
      const jW = await postJob(W, 'TEST W garage outlets (simulated)');
      const jD2 = await postJob(D, 'TEST D kitchen circuit (simulated)');
      const jZ = await postJob(Z, 'TEST Z water heater swap (simulated)', { trade: 'plumbing' });
      const jY = await postJob(Y, 'TEST Y shop lighting (simulated)', { days: 30 });
      await bid(D, jX, 41_000);
      await bid(Y, jX, 52_000);
      await bid(D, jW, 43_000);
      await bid(D, jY, 45_000);
      await bid(W, jD2, 47_000);
      await bid(V, jZ, 49_000);
      await later(DAY + MIN, X); // all four are awarded

      // X's job: D makes contact, X answers, both agree, X marks it done (a service fee for D).
      await ok(call(D, 'POST', `/api/jobs/${jX}/messages`, { body: 'TEST hello from D, the winner (simulated)' }));
      await ok(call(X, 'POST', `/api/jobs/${jX}/messages`, { body: 'TEST hello back from X (simulated)' }));
      await ok(call(D, 'POST', `/api/jobs/${jX}/confirm`));
      await ok(call(X, 'POST', `/api/jobs/${jX}/confirm`));
      await ok(call(X, 'POST', `/api/jobs/${jX}/complete`));
      // W's job: D gives it back (a no-show fee for D).
      await ok(call(D, 'POST', `/api/jobs/${jW}/back-out`));
      // D's job: W won it; they write to each other and never agree.
      await ok(call(W, 'POST', `/api/jobs/${jD2}/messages`, { body: 'TEST hello from W, the winner (simulated)' }));
      await ok(call(D, 'POST', `/api/jobs/${jD2}/messages`, { body: 'TEST hello back from D (simulated)' }));
      // The bystanders' own job and thread.
      await ok(call(V, 'POST', `/api/jobs/${jZ}/messages`, { body: 'TEST hello from V (simulated)' }));
      await ok(call(Z, 'POST', `/api/jobs/${jZ}/messages`, { body: 'TEST hello back from Z (simulated)' }));
      // Reports by D and about D, and an operator hid D's card.
      await ok(call(D, 'POST', `/api/jobs/${jX}/conversation/report`, { reason: 'spam', note: 'TEST report by D (simulated)' }));
      await ok(call(X, 'POST', `/api/people/${D.id}/report`, { reason: 'misleading', note: 'TEST report about D (simulated)' }));
      await ok(call(D, 'POST', `/api/jobs/${jY}/report`, { reason: 'TEST looks off to D (simulated)' }));
      await ok(call(null, 'POST', `/api/admin/people/${D.id}/hide`));

      await later(8 * DAY, X); // D's job and Z's job end (no agreement)
      const jD1 = await postJob(D, 'TEST D attic fan, no bids yet (simulated)', { days: 5 });
      await ok(call(X, 'POST', '/api/swipe', { bidId: `local:${jD1}`, action: 'save' }));
      const xProfile = await profileIdOf(X);
      // A "new match" alert in X's inbox for D's open job (whether the alert rules send one depends on the score).
      await db.query(`insert into alerts (profile_id, kind, bid_id, dedupe_key, title, body) values ($1, 'match', $2, $3, 'TEST new match (simulated)', 'TEST')
                      on conflict do nothing`, [xProfile, `local:${jD1}`, `TEST-match-${jD1}`]);

      // What the routes cannot make here: written straight in, so the check below has a row to look for in each table.
      await db.query(`insert into identities (provider, subject, account_id) values ('google', $1, $2)`, [`TEST-subject-${D.id}`, D.id]);
      await db.query(`insert into push_subscriptions (endpoint, account_id, keys) values ($1, $2, '{}'::jsonb)`, [`https://push.example.com/TEST-${D.id}`, D.id]);
      await db.query(`insert into promo_redemptions (account_id, code_key, plan) values ($1, $2, 'pro')`, [D.id, `TEST-code-key-${D.id}`]);
      await db.query(`insert into promo_codes (code_key, uses) values ($1, 1) on conflict (code_key) do nothing`, [`TEST-code-key-${D.id}`]);
      await db.query(`insert into estimates (profile_id, bid_id, inputs, result) values ($1, $2, '{}'::jsonb, '{}'::jsonb)`, [dProfile, publicBid]);
      const far = new Date(clock + DAY).toISOString();
      for (const key of [`promo:account:${D.id}`, `push:test:${D.id}`, `estimate:${dProfile}`,
        // Another address whose text starts with D's and a '|': it is someone else's, and stays.
        `login:pair:${D.email}|x.org|127.0.0.1`, `login:email:${D.email}|x.org`]) {
        await db.query('insert into auth_attempts (key, count, expires_at) values ($1, 1, $2) on conflict (key) do nothing', [key, far]);
      }
      // A stored scan report with an entry for D's profile and one for Z's (what a scan writes: counts per profile id).
      const zProfile = await profileIdOf(Z);
      const scanRow = (await db.query<{ id: string | number }>(
        `insert into scans (started_at, finished_at, report) values ($1, $1, $2::jsonb) returning id`,
        [new Date(clock).toISOString(), JSON.stringify({ TEST: 'synthetic scan report', sources: {}, totalBids: 0, newBids: 0,
          profiles: { [dProfile]: { scored: 3, newGood: 1 }, [zProfile]: { scored: 2, newGood: 0 } } })],
      ))[0]!.id;
      expect((await call(null, 'POST', '/api/auth/login', { email: D.email, password: 'TEST-wrong-password' })).status).toBe(401);
      expect((await remove(D, { password: 'TEST-not-the-password' })).status).toBe(401);

      // Before: D is in every table that holds people's rows (so "none after" means something), and the bystanders'.
      const dBefore = await footprint(D, dProfile);
      const tablesWithD = Object.entries(dBefore).filter(([, n]) => n > 0).map(([k]) => k);
      for (const k of ['accounts.id', 'profiles.id', 'identities.account_id', 'sessions.account_id', 'push_subscriptions.account_id',
        'work_profiles.account_id', 'promo_redemptions.account_id', 'profile_hides.account_id', 'matches.profile_id', 'swipes.profile_id',
        'alerts.profile_id', 'estimates.profile_id', 'jobs.poster_id', 'jobs.winner_id', 'job_bids.bidder_id', 'job_messages.sender_id',
        'job_fees.payer_id', 'job_reports.reporter_id', 'content_reports.reporter_id', 'content_reports.subject_id', 'auth_attempts.key']) {
        expect(tablesWithD, k).toContain(k);
      }
      // The bystanders' profiles were scored on D's jobs (every working profile in reach is): those feed rows go with
      // D's jobs and are left out here; everything that is theirs must stay exactly as it is.
      const dMirrors = [`local:${jD1}`, `local:${jD2}`];
      const bystanders = { Z: await footprint(Z, undefined, dMirrors), V: await footprint(V, undefined, dMirrors) };
      expect(bystanders.Z['jobs.poster_id']).toBe(1);
      expect(bystanders.V['job_messages.sender_id']).toBe(1);
      const dMessageKeys = (await db.query<{ k: string }>(`select job_id || ':' || id as k from job_messages where sender_id = $1`, [D.id])).map((r) => r.k);
      const othersAlertsOnD = (sqlTail: string, params: unknown[]) => count(`select count(*) as n from alerts where profile_id <> $1 and (${sqlTail})`, [dProfile, ...params]);
      expect(await othersAlertsOnD(`kind = 'job_message' and dedupe_key = any($2::text[])`, [dMessageKeys])).toBe(2); // X's and W's "New message"
      expect(await othersAlertsOnD(`data->>'jobId' = $2 or bid_id = $3`, [jD2, `local:${jD2}`])).toBeGreaterThan(0); // W's, about D's job
      expect(await othersAlertsOnD(`bid_id = $2`, [`local:${jD1}`])).toBeGreaterThan(0); // a match on D's open job
      expect(await count('select count(*) as n from swipes where bid_id = $1 and profile_id = $2', [`local:${jD1}`, xProfile])).toBe(1);
      const xOwnMessage = await count('select count(*) as n from job_messages where job_id = $1 and sender_id = $2', [jX, X.id]);
      expect(xOwnMessage).toBe(1);

      // ------------------------------------------------------------------------------------------- delete --
      const res = await remove(D);
      expect([res.status, res.json]).toEqual([200, { ok: true }]);
      expect(String(res.headers['set-cookie'])).toMatch(/^bs_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);

      // No row anywhere: every table with an account or profile column, the counters, the feed copies and their alerts.
      const dAfter = await footprint(D, dProfile);
      const decoys = [`login:email:${D.email}|x.org`, `login:pair:${D.email}|x.org|127.0.0.1`];
      expect(Object.entries(dAfter).filter(([, n]) => n > 0), 'rows left for the deleted account').toEqual([['auth_attempts.key', decoys.length]]);
      // ... and those two are someone else's address, which only starts with D's (below).
      const keysLeft = await db.query<{ key: string }>('select key from auth_attempts where strpos(key, $1) > 0 or strpos(key, $2) > 0 order by key', [D.email, D.id]);
      expect(keysLeft.map((r) => r.key)).toEqual(decoys);
      for (const jobId of [jD1, jD2]) {
        expect(await count('select count(*) as n from jobs where id = $1', [jobId])).toBe(0);
        expect(await count('select count(*) as n from bids where id = $1', [`local:${jobId}`])).toBe(0);
        expect(await count(`select count(*) as n from alerts where data->>'jobId' = $1 or bid_id = $2`, [jobId, `local:${jobId}`])).toBe(0);
        expect(await count('select count(*) as n from swipes where bid_id = $1', [`local:${jobId}`])).toBe(0);
      }
      expect(await count(`select count(*) as n from alerts where kind = 'job_message' and dedupe_key = any($1::text[])`, [dMessageKeys])).toBe(0);
      // Someone else's address that only starts with D's keeps its counters; a promo code's use count stays.
      expect(await count(`select count(*) as n from auth_attempts where key in ($1, $2)`, [`login:pair:${D.email}|x.org|127.0.0.1`, `login:email:${D.email}|x.org`])).toBe(2);
      expect(await count(`select uses as n from promo_codes where code_key = $1`, [`TEST-code-key-${D.id}`])).toBe(1);
      // The scan report keeps its other profiles' counts; D's entry is gone.
      const report = (await db.query<{ report: unknown }>('select report from scans where id = $1', [scanRow]))[0]!.report;
      const profilesInReport = (typeof report === 'string' ? JSON.parse(report) : report as { profiles: Record<string, unknown> }).profiles;
      expect(profilesInReport).toEqual({ [zProfile]: { scored: 2, newGood: 0 } });
      expect(await count(`select count(*) as n from scans where strpos(report::text, $1) > 0`, [D.id.toLowerCase()])).toBe(0);

      // The bystanders: not one row more or less.
      expect(await footprint(Z, undefined, dMirrors)).toEqual(bystanders.Z);
      expect(await footprint(V, undefined, dMirrors)).toEqual(bystanders.V);

      // D is gone for good: the old cookie, the old password; the address is free again.
      expect((await call(D, 'GET', '/api/me')).status).toBe(401);
      const signIn = await call(null, 'POST', '/api/auth/login', { email: D.email, password: PASSWORD });
      expect([signIn.status, signIn.json.error]).toEqual([401, 'invalid_credentials']);
      expect((await call(X, 'GET', `/api/people/${D.id}`)).status).toBe(404);
      const again = await ok(call(null, 'POST', '/api/auth/signup', { email: D.email, password: 'TEST-new-password-456' }), 201);
      expect(again.json.account.id).not.toBe(D.id);

      // X's finished job: the award stays on record, no one is named, and the words say why.
      const xJob = await jobAs(X, jX);
      expect([xJob.status, xJob.award.amountCents, xJob.award.winner, xJob.award.winnerDeleted]).toEqual(['completed', 41_000, null, true]);
      expect(xJob.tab).toEqual([
        { rank: 1, amountCents: 41_000, mine: false, bidder: null, gone: true },
        expect.objectContaining({ rank: 2, amountCents: 52_000, mine: false, gone: false, bidder: expect.objectContaining({ id: Y.id }) }),
      ]);
      expect(xJob.bidCount).toBe(2);
      expect(words.stage(xJob, { now: clock })).toEqual({ group: 'done', status: 'Done · $410', next: words.WINNER_DELETED });
      // Y lost X's job: the tab still shows the winning amount above theirs, with no one named.
      expect((await jobAs(Y, jX)).tab.map((r: { rank: number; amountCents: number; mine: boolean }) => [r.rank, r.amountCents, r.mine])).toEqual([[1, 41_000, false], [2, 52_000, true]]);
      expect(await count('select count(*) as n from job_messages where job_id = $1 and sender_id = $2', [jX, X.id])).toBe(1); // X's own words stay X's
      const convo = await call(X, 'GET', `/api/jobs/${jX}/conversation`);
      expect(convo.status).toBe(403); // a thread needs both sides
      const list = await ok(call(X, 'GET', '/api/jobs/conversations'));
      expect(list.json.conversations.map((c: { jobId: string }) => c.jobId)).not.toContain(jX);
      const mine = await ok(call(X, 'GET', '/api/jobs/mine'));
      expect(mine.json.posted.map((j: { id: string }) => j.id)).toContain(jX);
      expect((await ok(call(X, 'GET', '/api/alerts'))).json).toBeTruthy();

      // W's job D gave back: still unfilled as D left it; the fee D owed went with D (payments are off: records only).
      const wJob = await jobAs(W, jW);
      expect([wJob.status, wJob.outcome, wJob.fees, wJob.award.winnerDeleted]).toEqual(['unfilled', 'bidder_backed_out', [], true]);
      expect(words.stage(wJob, { now: clock }).next).toBe(`${words.WINNER_DELETED} You can post it again with one tap.`);
      // W won D's job: it is gone for W too, with W's bid and the thread.
      expect((await call(W, 'GET', `/api/jobs/${jD2}`)).status).toBe(404);
      expect((await ok(call(W, 'GET', '/api/jobs/mine'))).json.bidding.map((j: { id: string }) => j.id)).not.toContain(jD2);
      // Y's open job: intact, without D's bid.
      const yJob = await jobAs(Y, jY);
      expect([yJob.status, yJob.bidCount]).toEqual(['open', 0]);

      // The settlement and the alert rules' tick run over all of it without a fault.
      clock += 22 * DAY; // past Y's closing (30 days after posting), inside Y's 30-day session
      await rt.tick();
      expect((await jobAs(Y, jY)).status).toBe('unfilled');
    }, 60_000);

    it('a job posted the instant its poster is deleted leaves nothing behind: no feed card, score or alert (review del-2)', async () => {
      const poster = await signUp('ghost-poster');
      const neighbour = await signUp('ghost-neighbour'); // an electrician in reach, who would be told of a good fit
      let mirror = '';
      // Held where the review held it: the job row is written, the feed copy is not yet. The deletion lands in between.
      hold.next = {
        prefix: 'insert into bids',
        run: async (params) => {
          mirror = String(params[0]);
          const res = await remove(poster);
          expect([res.status, res.json]).toEqual([200, { ok: true }]);
        },
      };
      const posted = await call(poster, 'POST', '/api/jobs', JOB('TEST R6 ghost job (simulated)'));
      expect(hold.next).toBeNull(); // the seam ran
      expect(mirror).toMatch(/^local:/);
      expect([posted.status, posted.json]).toEqual([404, { error: 'not_found' }]);
      const jobId = mirror.slice('local:'.length);
      expect(await count('select count(*) as n from jobs where id = $1', [jobId])).toBe(0);
      for (const table of ['bids where id', 'matches where bid_id', 'alerts where bid_id']) {
        expect(await count(`select count(*) as n from ${table} = $1`, [mirror]), table).toBe(0);
      }
      const feed = await ok(call(neighbour, 'GET', '/api/feed?limit=300'));
      expect(feed.json.items.map((i: { id: string }) => i.id)).not.toContain(mirror);
      expect(await count(`select count(*) as n from bids where id like 'local:%' and title = $1`, ['TEST R6 ghost job (simulated)'])).toBe(0);
    });

    it('a write of an account deleted while the request ran is a 401, never a 500 (review del-5)', async () => {
      const other = await signUp('race-other');
      const theirs = await postJob(other, 'TEST Someone\'s job, bid on as the bidder leaves (simulated)', { days: 5 });
      const cases: Array<{ what: string; prefix: string; send: (p: Person) => Promise<Answer> }> = [
        { what: 'a sign-in on a second device', prefix: 'insert into sessions', send: (p) => call(null, 'POST', '/api/auth/login', { email: p.email, password: PASSWORD }) },
        { what: 'a bid', prefix: 'insert into job_bids', send: (p) => call(p, 'POST', `/api/jobs/${theirs}/bid`, { amountCents: 40_000, agree: true }) },
        { what: 'a work profile', prefix: 'insert into work_profiles', send: (p) => call(p, 'PUT', '/api/work-profile', { headline: 'TEST headline (simulated)' }) },
        { what: 'a job post', prefix: 'insert into jobs', send: (p) => call(p, 'POST', '/api/jobs', JOB('TEST Posted as the poster leaves (simulated)')) },
      ];
      for (const c of cases) {
        const p = await signUp(`race-${c.prefix.split(' ')[2]}`);
        hold.next = { prefix: c.prefix, run: async () => { expect((await remove(p)).status, c.what).toBe(200); } };
        const res = await c.send(p);
        expect(hold.next, c.what).toBeNull();
        expect([res.status, res.json], c.what).toEqual([401, { error: 'sign_in_required' }]);
        expect(await count('select count(*) as n from accounts where id = $1', [p.id]), c.what).toBe(0);
      }
    });

    it('a job awarded the instant its winner went (the race the statement\'s lock guards): pages and settlement still answer', async () => {
      const poster = await signUp('race-poster');
      const winner = await signUp('race-winner');
      const jobId = await postJob(poster, 'TEST Awarded as the winner left (simulated)');
      await bid(winner, jobId, 44_000);
      await later(DAY + MIN, poster);
      // Stand-in for the race: the account row is deleted straight in the database, as if the award had landed after
      // the deletion read the job (the route itself refuses: 409 above).
      await db.query('delete from accounts where id = $1', [winner.id]);
      const job = await jobAs(poster, jobId);
      expect([job.status, job.award.winner, job.award.winnerDeleted, job.tab[0].gone]).toEqual(['awarded', null, true, true]);
      expect(words.stage(job, { now: clock })).toEqual({ group: 'needs', status: 'Lowest bid $440', next: `${words.WINNER_DELETED} Cancel the job to post it again.` });
      expect((await call(poster, 'GET', `/api/jobs/${jobId}/conversation`)).status).toBe(403);
      await later(7 * DAY + MIN, poster); // the contact window ends with nobody to owe a fee
      const ended = await jobAs(poster, jobId);
      expect([ended.status, ended.outcome, ended.fees]).toEqual(['unfilled', 'bidder_no_show', []]);
      expect(await count('select count(*) as n from job_fees where job_id = $1', [jobId])).toBe(0);
    });
  });
}

// ------------------------------------------------------------------------------------------------------- run --

suite('POST /api/account/delete (embedded database)', memoryDb, (db) => db.close());

const url = process.env.TEST_DATABASE_URL;
/** The test's own schema on the throwaway database: nothing another test file reads or empties. */
const inSchema = (u: string): string => `${u}${u.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${PG_SCHEMA}`)}`;
async function adminQuery(sql: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}
if (url) {
  suite('POST /api/account/delete (Postgres, TEST_DATABASE_URL)', async () => {
    await adminQuery(`drop schema if exists ${PG_SCHEMA} cascade; create schema ${PG_SCHEMA}`);
    return openDb({ url: inSchema(url) });
  }, async (db) => {
    await db.close();
    await adminQuery(`drop schema if exists ${PG_SCHEMA} cascade`);
  });
}
