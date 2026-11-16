import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/db.js';
import { DEFAULT_JOB_RULES } from '../src/jobs/config.js';
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

  it('Messages on Postgres: the list, read marks that only move up, and the bell alerts retired once', async () => {
    const job = await post(1);
    await jobs.placeBid(deps(), ids[3]!, job, { amountCents: 22_222, agree: true }, T0 + 1000);
    await jobs.placeBid(deps(), ids[4]!, job, { amountCents: 44_444, agree: true }, T0 + 2000);
    await jobs.settleDue(deps(), T0 + DAY);
    // the poster's profile, so the bell's alerts have somewhere to live (alerts are per profile)
    await db.query(`delete from profiles where id = 'TEST-pg-profile-0'`);
    await db.query(`insert into profiles (id, name, prefs, account_id) values ('TEST-pg-profile-0', 'TEST pg (simulated)', '{}'::jsonb, $1)`, [ids[0]]);
    const sent: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await jobs.sendMessage(deps(), ids[3]!, job, { body: `TEST message ${i} (simulated)` }, T0 + DAY + 10_000 + i);
      if (!r.ok) throw new Error(JSON.stringify(r.refusal));
      sent.push(r.value.id);
      await db.query(
        `insert into alerts (profile_id, kind, dedupe_key, title, body) values ('TEST-pg-profile-0', 'job_message', $1, 'TEST', 'TEST')`,
        [`${job}:${r.value.id}`],
      );
    }
    await db.query(`insert into alerts (profile_id, kind, dedupe_key, title, body) values ('TEST-pg-profile-0', 'job_message', $1, 'TEST', 'TEST')`, [`${job}:agreed:winner`]);

    const before = await jobs.conversations(deps(), ids[0]!, T0 + DAY + 20_000);
    expect(before.conversations.find((c) => c.jobId === job)).toMatchObject({ unread: true, messageCount: 3, role: 'poster' });
    expect((await jobs.conversations(deps(), ids[4]!, T0 + DAY + 20_000)).conversations.some((c) => c.jobId === job)).toBe(false);

    // ten opens at once, some up to the first message only: the mark ends at the newest, each alert retired once
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      jobs.readConversation(deps(), ids[0]!, job, i % 2 ? { upTo: sent[0] } : {}, T0 + DAY + 30_000)));
    expect(results.every((r) => r.ok)).toBe(true);
    const retired = results.reduce((n, r) => n + (r.ok ? r.value.alertsRetired : 0), 0);
    expect(retired).toBe(3);
    const mark = (await db.query<{ poster_read_msg_id: string }>('select poster_read_msg_id from jobs where id = $1', [job]))[0]!;
    expect(Number(mark.poster_read_msg_id)).toBe(sent[2]);
    // the one-sided "We've agreed" alert still asks for its tap
    expect(await db.query(`select 1 from alerts where profile_id = 'TEST-pg-profile-0' and dedupe_key = $1 and read_at is null`, [`${job}:agreed:winner`])).toHaveLength(1);
    expect((await jobs.conversations(deps(), ids[0]!, T0 + DAY + 40_000)).conversations.find((c) => c.jobId === job)).toMatchObject({ unread: false });
    await db.query(`delete from profiles where id = 'TEST-pg-profile-0'`);
  });

  it('reports on Postgres: twenty at once leave one open report per reporter and target; each answer is kind', async () => {
    const job = await post(1);
    await jobs.placeBid(deps(), ids[5]!, job, { amountCents: 21_000, agree: true }, T0 + 1000);
    await jobs.placeBid(deps(), ids[6]!, job, { amountCents: 31_000, agree: true }, T0 + 2000);
    await jobs.settleDue(deps(), T0 + DAY);
    const before = (await db.query('select * from jobs where id = $1', [job]))[0];

    const convo = await Promise.all(Array.from({ length: 20 }, () =>
      jobs.reportConversation(deps(), ids[5]!, job, { reason: 'spam', note: 'TEST (simulated)' }, T0 + DAY + 1000)));
    expect(convo.every((r) => r.ok)).toBe(true);
    expect(convo.filter((r) => r.ok && !r.value.already)).toHaveLength(1);
    const card = await Promise.all(Array.from({ length: 20 }, () =>
      jobs.reportPerson(deps(), ids[0]!, ids[5]!, { reason: 'misleading' }, T0 + DAY + 1000)));
    expect(card.filter((r) => r.ok && !r.value.already)).toHaveLength(1);
    expect(await db.query('select 1 from content_reports where job_id = $1', [job])).toHaveLength(1);
    expect(await db.query(`select 1 from content_reports where kind = 'profile' and subject_id = $1 and reporter_id = $2`, [ids[5], ids[0]])).toHaveLength(1);
    // the losing bidder is not in the thread: refused, and nothing stored
    const lost = await jobs.reportConversation(deps(), ids[6]!, job, { reason: 'spam' }, T0 + DAY + 1000);
    expect(lost.ok ? null : lost.refusal.error).toBe('not_allowed');
    // reporting moved nothing on the job
    expect((await db.query('select * from jobs where id = $1', [job]))[0]).toEqual(before);
  });

  it('operators on Postgres: ten removals of one message at once, ten hides at once; each one statement, nothing else moves', async () => {
    const job = await post(1);
    await jobs.placeBid(deps(), ids[7]!, job, { amountCents: 25_000, agree: true }, T0 + 1000);
    await jobs.settleDue(deps(), T0 + DAY);
    const sent = await jobs.sendMessage(deps(), ids[7]!, job, { body: 'TEST-PG-SECRET (simulated)' }, T0 + DAY + 1000);
    if (!sent.ok) throw new Error(JSON.stringify(sent.refusal));
    await db.query(`delete from profiles where id = 'TEST-pg-profile-r'`);
    await db.query(`insert into profiles (id, name, prefs, account_id) values ('TEST-pg-profile-r', 'TEST pg (simulated)', '{}'::jsonb, $1)`, [ids[0]]);
    await db.query(`insert into alerts (profile_id, kind, dedupe_key, title, body) values ('TEST-pg-profile-r', 'job_message', $1, 'TEST', 'TEST-PG-SECRET (simulated)')`,
      [`${job}:${sent.value.id}`]);
    const before = (await db.query('select * from jobs where id = $1', [job]))[0];

    const removed = await Promise.all(Array.from({ length: 10 }, (_, i) => jobs.removeMessage(deps(), sent.value.id, T0 + DAY + 2000 + i)));
    expect(removed.every(Boolean)).toBe(true);
    const row = (await db.query<{ removed_at: Date; body: string }>('select removed_at, body from job_messages where id = $1', [sent.value.id]))[0]!;
    expect(new Date(row.removed_at).getTime()).toBeGreaterThanOrEqual(T0 + DAY + 2000);
    const list = await jobs.conversationFor(deps(), ids[0]!, job, T0 + DAY + 3000);
    expect(list.ok && list.value.messages[0]).toMatchObject({ removed: true, body: '' });
    expect(JSON.stringify(list)).not.toContain('TEST-PG-SECRET');
    expect((await db.query<{ body: string }>(`select body from alerts where profile_id = 'TEST-pg-profile-r'`))[0]!.body).toBe('Message removed by BidSwipe');
    expect((await db.query('select * from jobs where id = $1', [job]))[0]).toEqual(before);

    const hides = await Promise.all(Array.from({ length: 10 }, (_, i) => jobs.setPersonHidden(deps(), ids[7]!, i % 2 === 0, T0 + DAY + 4000 + i)));
    expect(hides.every((h) => h !== null)).toBe(true);
    expect(await db.query('select 1 from profile_hides where account_id = $1', [ids[7]])).toHaveLength(1);
    expect((await jobs.setPersonHidden(deps(), ids[7]!, true, T0 + DAY + 5000))?.hidden).toBe(true);
    expect((await jobs.setPersonHidden(deps(), 'TEST-pg-nobody', true, T0 + DAY + 5000))).toBeNull();
    await db.query(`delete from profiles where id = 'TEST-pg-profile-r'`);
  });
});
