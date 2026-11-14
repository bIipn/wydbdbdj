import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/db.js';
import { getBid, saveProfileForAccount, upsertProfile } from '../src/db/repo.js';
import { DEFAULT_JOB_RULES } from '../src/jobs/config.js';
import * as jobs from '../src/jobs/service.js';
import { buildProfile, profileIdFor } from '../src/profile/build.js';
import { createBus } from '../src/realtime/bus.js';
import { scoreOneByOne, testProfile } from './helpers.js';

/**
 * The marketplace on a REAL Postgres through node-postgres, where requests truly run at the same time (a pool
 * of connections; the embedded database has one and runs statements one after another). Only when
 * TEST_DATABASE_URL names a throwaway database — it empties the tables:
 *   TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/scratch npx vitest run test/jobs-pg.test.ts
 * Everyone here is synthetic (TEST- accounts at example.com).
 */
const url = process.env.TEST_DATABASE_URL;
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-14T18:00:00Z');

describe.skipIf(!url)('job marketplace on Postgres (TEST_DATABASE_URL)', () => {
  let db: Db;
  const deps = () => ({ db, bus: createBus(), rules: DEFAULT_JOB_RULES, appUrl: 'https://bidswipe.example.com' });
  const ids = Array.from({ length: 8 }, (_, i) => `TEST-pg-${i}`);

  beforeAll(async () => {
    db = await openDb({ url });
    await db.exec('truncate table job_reports, job_fees, job_messages, job_bids, jobs restart identity cascade');
    await db.query(`delete from accounts where id like 'TEST-pg-%'`);
    await db.query(`delete from profiles where id like 'TEST-pg-%'`);
    await db.query(`delete from bids where id like 'local:%'`);
    for (const id of ids) await db.query('insert into accounts (id, email, name) values ($1, $2, $3)', [id, `${id}@example.com`, `${id} (simulated)`]);
  }, 60_000);
  afterAll(async () => db?.close());

  const post = async (closesInDays: number) => {
    const r = await jobs.postJob(deps(), ids[0]!, {
      title: 'TEST pg job (simulated)', description: 'A synthetic job to test the database statements. TEST.', trades: ['electrical'],
      zip: '89423', budgetMaxCents: 100_000, closesInDays,
    }, T0);
    if (!r.ok) throw new Error(JSON.stringify(r.refusal));
    return r.value.id;
  };

  it('twenty bids at once from one account leave one bid', async () => {
    const job = await post(3);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      jobs.placeBid(deps(), ids[1]!, job, { amountCents: 50_000 + i, agree: true }, T0 + 1000)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await db.query('select 1 from job_bids where job_id = $1', [job])).toHaveLength(1);
  });

  it('ten settlements at once award once, mark the bids once and write one fee row at the deadline', async () => {
    const job = await post(1);
    for (let i = 1; i < 6; i++) await jobs.placeBid(deps(), ids[i]!, job, { amountCents: 40_000 - i * 100, agree: true }, T0 + i * 1000);
    const closing = await Promise.all(Array.from({ length: 10 }, () => jobs.settleDue(deps(), T0 + DAY)));
    expect(closing.reduce((n, s) => n + s.closed, 0)).toBe(1);
    const won = await db.query<{ bidder_id: string }>(`select bidder_id from job_bids where job_id = $1 and status = 'won'`, [job]);
    expect(won.map((r) => r.bidder_id)).toEqual([ids[5]]);
    expect(await db.query(`select 1 from job_bids where job_id = $1 and status = 'active'`, [job])).toHaveLength(0);

    const ending = await Promise.all(Array.from({ length: 10 }, () => jobs.settleDue(deps(), T0 + 9 * DAY)));
    expect(ending.reduce((n, s) => n + s.ended, 0)).toBe(1);
    const fees = await db.query<{ kind: string; amount_cents: string }>('select kind, amount_cents from job_fees where job_id = $1', [job]);
    expect(fees.map((f) => [f.kind, Number(f.amount_cents)])).toEqual([['no_show', 1_975]]); // 5% of $395.00
  }, 30_000);

  it('both sides confirming at the same moment make it agreed once, with one service fee', async () => {
    const job = await post(1);
    await jobs.placeBid(deps(), ids[2]!, job, { amountCents: 33_333, agree: true }, T0 + 1000);
    await jobs.settleDue(deps(), T0 + DAY);
    const [a, b] = await Promise.all([
      jobs.confirmAgreement(deps(), ids[0]!, job, T0 + DAY + 1000), jobs.confirmAgreement(deps(), ids[2]!, job, T0 + DAY + 1000),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const row = (await db.query<{ status: string }>('select status from jobs where id = $1', [job]))[0]!;
    expect(row.status).toBe('agreed');
    expect(await db.query(`select 1 from job_fees where job_id = $1 and kind = 'service'`, [job])).toHaveLength(1);
  });

  // The set-based statements (the candidate query over the generated columns, the multi-row score write, the
  // bids, fees, cards and records of many jobs at once) on the real thing: test/jobs-scale.test.ts counts and
  // checks them on the embedded database, and the two have different maths libraries and JSON readers.
  it('a posted job is scored for exactly the profiles the rules give one by one, and "my jobs" reads every job back', async () => {
    const shop = (id: string, zip: string, radiusMi: number, trades = ['electrical']) => saveProfileForAccount(db, id, buildProfile(profileIdFor(id), {
      businessName: `${id} (simulated)`, trades, zip, radiusMi, valueRange: { min: 0, max: 50_000 },
    }));
    await shop(ids[0]!, '89410', 90); // the poster: never their own job
    await shop(ids[1]!, '89410', 90);
    await shop(ids[2]!, '89701', 25);
    await shop(ids[3]!, '95814', 250, ['plumbing']); // Sacramento: in reach by distance, another trade
    await shop(ids[4]!, '10001', 25); // New York: out of reach
    await saveProfileForAccount(db, ids[5]!, buildProfile(profileIdFor(ids[5]!), {
      intent: 'hire', businessName: `${ids[5]} (simulated)`, trades: [], zip: '89410', radiusMi: 25, valueRange: { min: 0, max: 250_000 },
    }));
    await upsertProfile(db, testProfile('TEST-pg-config')); // the pilot's kind of profile: no account

    const job = await post(3);
    const bid = (await getBid(db, `local:${job}`))!;
    const want = await scoreOneByOne(db, bid, new Date(T0), profileIdFor(ids[0]!));
    expect([...want.keys()].sort()).toEqual([ids[1]!, ids[2]!, ids[3]!].map(profileIdFor).sort());
    const stored = await db.query<{ profile_id: string; score: number; verdict: string; distance_mi: number; tier: string }>(
      'select profile_id, score, verdict, distance_mi, tier from matches where bid_id = $1', [bid.id],
    );
    expect(stored.map((r) => [r.profile_id, r.score, r.verdict, Number(r.distance_mi), r.tier]).sort()).toEqual(
      [...want].map(([id, { score: s }]) => [id, s.score, s.verdict, s.distanceMi, s.tier]).sort(),
    );

    // "My jobs" for the poster of every job in this file, and for someone who bid on some: each view is the job page's.
    expect((await jobs.placeBid(deps(), ids[1]!, job, { amountCents: 45_001, agree: true }, T0 + 1000)).ok).toBe(true);
    for (const who of [ids[0]!, ids[1]!, ids[2]!]) {
      const mine = await jobs.myJobs(deps(), who, T0 + 2000);
      const views = [...mine.posted, ...mine.bidding];
      expect(views.length, who).toBeGreaterThan(0);
      for (const view of views) {
        const page = await jobs.getJobFor(deps(), view.id, who, T0 + 2000);
        expect(page.ok && page.value.job, `${who} ${view.id}`).toEqual(view);
      }
    }
    const posted = (await jobs.myJobs(deps(), ids[0]!, T0 + 2000)).posted;
    expect(posted.length).toBeGreaterThanOrEqual(4);
    expect(posted.find((j) => j.id === job)).toMatchObject({ bidCount: 1, tab: null, my: { role: 'poster' } });
    // A closed job of this poster: the ranked tab with every bidder's card, and the winner's record counted.
    const closed = posted.find((j) => j.tab && j.tab.length === 5)!;
    expect(closed.tab!.map((r) => r.bidder?.name)).toEqual(expect.arrayContaining([`${ids[5]} (simulated)`, `${ids[1]} (simulated)`]));
    expect(closed.tab![0]!.bidder).toMatchObject({ id: ids[5], stats: { won: 1, noShows: 1, posted: 0 } });
    expect(closed.poster.stats).toMatchObject({ posted: posted.length });
  }, 30_000);
});
