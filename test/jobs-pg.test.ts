import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/db.js';
import { DEFAULT_JOB_RULES } from '../src/jobs/config.js';
import { deleteAccount as deleteAccountRows, ledgerTotals } from '../src/jobs/repo.js';
import * as jobs from '../src/jobs/service.js';
import { createBus } from '../src/realtime/bus.js';

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

  it('ten deletions of one account at once delete it once; the fee rows outlive the payer, then the poster and the jobs', async () => {
    const [poster, payer, other] = [ids[0]!, ids[6]!, ids[7]!];
    // The payer no-shows on one job (5% of $377.00 = $18.85) and agrees another (1% of $291.00 = $2.91); a third is open.
    const noShow = await post(1);
    await jobs.placeBid(deps(), payer, noShow, { amountCents: 37_700, agree: true }, T0 + 1000);
    await jobs.settleDue(deps(), T0 + DAY);
    await jobs.settleDue(deps(), T0 + 9 * DAY);
    const at = T0 + 10 * DAY;
    const postAt = async (closesInDays: number) => {
      const r = await jobs.postJob(deps(), poster, {
        title: 'TEST pg job for a deletion (simulated)', description: 'A synthetic job to test the deletion statement. TEST.', trades: ['electrical'],
        zip: '89423', closesInDays,
      }, at);
      if (!r.ok) throw new Error(JSON.stringify(r.refusal));
      return r.value.id;
    };
    const agreed = await postAt(1);
    const open = await postAt(5);
    await jobs.placeBid(deps(), payer, agreed, { amountCents: 29_100, agree: true }, at + 1000);
    await jobs.placeBid(deps(), payer, open, { amountCents: 45_500, agree: true }, at + 1000);
    await jobs.placeBid(deps(), other, open, { amountCents: 47_700, agree: true }, at + 2000);
    await jobs.settleDue(deps(), at + DAY);
    expect((await jobs.confirmAgreement(deps(), payer, agreed, at + DAY + 1000)).ok).toBe(true);
    expect((await jobs.confirmAgreement(deps(), poster, agreed, at + DAY + 2000)).ok).toBe(true);
    const mine = [noShow, agreed, open];
    const feeRows = () => db.query<{ job_id: string; kind: string; payer_id: string | null; payer_ref: string | null; payer_name: string | null; amount_cents: string; status: string }>(
      'select job_id, kind, payer_id, payer_ref, payer_name, amount_cents, status from job_fees where job_id = any($1) order by id', [mine]);
    expect((await feeRows()).map((f) => [f.kind, f.payer_id, Number(f.amount_cents)])).toEqual([['no_show', payer, 1_885], ['service', payer, 291]]);
    const before = await ledgerTotals(db);

    // The payer deletes their account, ten requests at the same moment.
    const results = await Promise.all(Array.from({ length: 10 }, () => deleteAccountRows(db, payer, at + 2 * DAY)));
    expect(results.filter((r) => r.deleted)).toHaveLength(1);
    const done = results.find((r) => r.deleted)!;
    expect(done).toMatchObject({ feesKept: 2, feesWaived: 0, jobsRemoved: 0, leftBehind: [] });
    expect(done.wonEnded).toEqual([{ jobId: agreed, posterId: poster, title: 'TEST pg job for a deletion (simulated)', was: 'agreed', awardCents: 29_100, contactDeadline: at + 8 * DAY }]);
    expect(await db.query('select 1 from accounts where id = $1', [payer])).toHaveLength(0);
    expect(await db.query('select 1 from job_bids where bidder_id = $1', [payer])).toHaveLength(0);
    expect((await db.query<{ status: string; outcome: string; winner_id: string | null }>('select status, outcome, winner_id from jobs where id = $1', [agreed]))[0])
      .toEqual({ status: 'unfilled', outcome: 'bidder_left', winner_id: null });
    expect(await ledgerTotals(db)).toEqual({ ...before, payerGone: before.payerGone + 2 });
    expect((await feeRows()).map((f) => [f.kind, f.payer_id, f.payer_ref, f.payer_name, Number(f.amount_cents), f.status])).toEqual([
      ['no_show', null, payer, `${payer} (simulated)`, 1_885, 'recorded'], ['service', null, payer, `${payer} (simulated)`, 291, 'recorded'],
    ]);

    // Then the poster deletes theirs: the jobs and their feed rows go, the ledger keeps every row and every cent.
    const totals = await ledgerTotals(db);
    const mirrors = (await db.query<{ id: string }>('select id from jobs where poster_id = $1', [poster])).map((j) => `local:${j.id}`);
    expect((await db.query('select 1 from bids where id = any($1)', [mirrors])).length).toBe(mirrors.length);
    const gone = await deleteAccountRows(db, poster, at + 3 * DAY);
    expect(gone.deleted).toBe(true);
    expect(gone.leftBehind).toContainEqual({ jobId: open, accountId: other, role: 'bidder', title: 'TEST pg job for a deletion (simulated)', was: 'open', amountCents: 47_700, feeWaivedCents: null });
    // The job agreed in the test above was still live: its winner stayed, so their service fee (1% of $333.33) is waived, not erased.
    expect(gone.leftBehind).toContainEqual(expect.objectContaining({ accountId: ids[2], role: 'winner', was: 'agreed', amountCents: 33_333, feeWaivedCents: 333 }));
    expect(await db.query('select 1 from jobs where poster_id = $1', [poster])).toHaveLength(0);
    expect(await db.query('select 1 from bids where id = any($1)', [mirrors])).toHaveLength(0);
    expect(await db.query('select role, was from job_tombstones where job_id = $1 and account_id = $2', [open, other])).toEqual([{ role: 'bidder', was: 'open' }]);
    expect(await feeRows()).toHaveLength(2);
    const after = await ledgerTotals(db);
    expect(after.rows).toBe(totals.rows);
    expect(after.waivedCents - totals.waivedCents).toBe(333);
    expect(after.recordedCents + after.waivedCents).toBe(totals.recordedCents + totals.waivedCents);
  }, 30_000);
});
