/**
 * All SQL for the job marketplace (tables in src/db/schema-jobs.ts).
 *
 * Every write whose meaning depends on the job's state is ONE statement with the state in its WHERE
 * (`… where status = 'open' … returning *`): when two requests race, the database lets exactly one of them
 * change the row and the other gets no row back. Nothing here reads a row and then writes on the strength
 * of what it read. Where one change has to touch two tables (an award marks the bids won/lost; a no-show
 * writes its fee), the second write is a data-modifying CTE of the same statement, so it happens with the
 * first or not at all.
 *
 * Times go in as ISO strings and come out as ms since epoch (null when unset). Money is integer cents.
 */
import type { Db } from '../db/db.js';
import type { BidState, BidStatus, FeeKind, FeeLine, JobOutcome, JobState, JobStatus } from './rules.js';

// ------------------------------------------------------------------ rows --

/** A job row, mapped. */
export interface JobRecord extends JobState {
  id: string;
  posterId: string;
  title: string;
  description: string;
  trades: string[];
  zip: string;
  city: string;
  state: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  phone: string | null;
  budgetMaxCents: number | null;
  postedAt: number;
  agreedAt: number | null;
  completedAt: number | null;
  repostedFrom: string | null;
  removedAt: number | null;
}

export interface BidRecord extends BidState {
  jobId: string;
  note: string | null;
  updatedAt: number;
}

export interface MessageRecord {
  id: number;
  jobId: string;
  senderId: string;
  body: string;
  createdAt: number;
}

export interface FeeRecord extends FeeLine {
  id: number;
  jobId: string;
  /** null once the payer deleted their account: payerRef, payerName and payerDeletedAt then say who it was. */
  payerId: string | null;
  status: 'recorded' | 'waived';
  createdAt: number;
  waivedAt: number | null;
  /** The account id the fee was recorded against. It stays when the account is gone (and then leads nowhere). */
  payerRef: string | null;
  /** The name on the payer's account when they deleted it. Never an email. null while the account exists. */
  payerName: string | null;
  payerDeletedAt: number | null;
}

type Ts = Date | string | null;
type Big = number | string | null;

const ms = (v: Ts): number | null => (v == null ? null : new Date(v).getTime());
const n = (v: Big): number | null => (v == null ? null : Number(v));
const arr = (v: string[] | string | null): string[] => {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  // node-postgres hands text[] over as an array; this is the fallback for a "{a,b}" literal
  return v.replace(/^\{|\}$/g, '').split(',').filter(Boolean).map((s) => s.replace(/^"|"$/g, ''));
};

interface JobRow {
  id: string; poster_id: string; title: string; description: string; trades: string[] | string; zip: string; city: string;
  state: string; lat: number | null; lng: number | null; address: string | null; phone: string | null; budget_max_cents: Big;
  posted_at: Ts; closes_at: Ts; status: JobStatus; outcome: JobOutcome | null; winner_bid_id: Big; winner_id: string | null;
  award_cents: Big; awarded_at: Ts; contact_deadline: Ts; bidder_messaged_at: Ts; poster_messaged_at: Ts; poster_tapped_at: Ts;
  bidder_confirmed_at: Ts; poster_confirmed_at: Ts; agreed_at: Ts; completed_at: Ts; ended_at: Ts; reposted_from: string | null;
  removed_at: Ts;
}

function toJob(r: JobRow): JobRecord {
  return {
    id: r.id, posterId: r.poster_id, title: r.title, description: r.description, trades: arr(r.trades), zip: r.zip, city: r.city,
    state: r.state, lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng), address: r.address,
    phone: r.phone, budgetMaxCents: n(r.budget_max_cents), postedAt: ms(r.posted_at)!, closesAt: ms(r.closes_at)!, status: r.status,
    outcome: r.outcome, winnerBidId: n(r.winner_bid_id), winnerId: r.winner_id, awardCents: n(r.award_cents),
    awardedAt: ms(r.awarded_at), contactDeadline: ms(r.contact_deadline), bidderMessagedAt: ms(r.bidder_messaged_at),
    posterMessagedAt: ms(r.poster_messaged_at), posterTappedAt: ms(r.poster_tapped_at), bidderConfirmedAt: ms(r.bidder_confirmed_at),
    posterConfirmedAt: ms(r.poster_confirmed_at), agreedAt: ms(r.agreed_at), completedAt: ms(r.completed_at), endedAt: ms(r.ended_at),
    repostedFrom: r.reposted_from, removedAt: ms(r.removed_at),
  };
}

interface BidRow {
  id: Big; job_id: string; bidder_id: string; amount_cents: Big; note: string | null; status: BidStatus; created_at: Ts; updated_at: Ts;
}

const toBid = (r: BidRow): BidRecord => ({
  id: n(r.id)!, jobId: r.job_id, bidderId: r.bidder_id, amountCents: n(r.amount_cents)!, note: r.note, status: r.status,
  createdAt: ms(r.created_at)!, updatedAt: ms(r.updated_at)!,
});

interface MessageRow { id: Big; job_id: string; sender_id: string; body: string; created_at: Ts }
const toMessage = (r: MessageRow): MessageRecord => ({ id: n(r.id)!, jobId: r.job_id, senderId: r.sender_id, body: r.body, createdAt: ms(r.created_at)! });

interface FeeRow {
  id: Big; job_id: string; kind: FeeKind; payer_id: string | null; basis_cents: Big; rate_ppm: Big; amount_cents: Big; poster_share_ppm: Big;
  poster_share_cents: Big; platform_cents: Big; status: 'recorded' | 'waived'; created_at: Ts; waived_at: Ts;
  payer_ref: string | null; payer_name: string | null; payer_deleted_at: Ts;
}
const toFee = (r: FeeRow): FeeRecord => ({
  id: n(r.id)!, jobId: r.job_id, kind: r.kind, payerId: r.payer_id, basisCents: n(r.basis_cents)!, ratePpm: n(r.rate_ppm)!,
  amountCents: n(r.amount_cents)!, posterSharePpm: n(r.poster_share_ppm)!, posterShareCents: n(r.poster_share_cents)!,
  platformCents: n(r.platform_cents)!, status: r.status, createdAt: ms(r.created_at)!, waivedAt: ms(r.waived_at),
  payerRef: r.payer_ref, payerName: r.payer_name, payerDeletedAt: ms(r.payer_deleted_at),
});

const iso = (t: number | null): string | null => (t == null ? null : new Date(t).toISOString());

/**
 * The fee insert as a CTE tail: `insert into job_fees … select … from j` (j = the updated job). payer_ref is the
 * payer's account id a second time: it stays on the row when the account is deleted and payer_id becomes null.
 */
const FEE_FROM_J = (p: number) => `
  insert into job_fees (job_id, kind, payer_id, basis_cents, rate_ppm, amount_cents, poster_share_ppm, poster_share_cents,
                        platform_cents, status, created_at, payer_ref)
  select j.id, $${p}, j.winner_id, $${p + 1}::bigint, $${p + 2}::integer, $${p + 3}::bigint, $${p + 4}::integer, $${p + 5}::bigint,
         $${p + 6}::bigint, 'recorded', $${p + 7}::timestamptz, j.winner_id
  from j where j.winner_id is not null
  on conflict (job_id, kind) do nothing`;

const feeParams = (f: FeeLine, at: string): unknown[] =>
  [f.kind, f.basisCents, f.ratePpm, f.amountCents, f.posterSharePpm, f.posterShareCents, f.platformCents, at];

// ------------------------------------------------------------------ jobs --

export interface NewJob {
  id: string;
  posterId: string;
  title: string;
  description: string;
  trades: string[];
  zip: string;
  city: string;
  state: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  phone: string | null;
  budgetMaxCents: number | null;
  postedAt: number;
  closesAt: number;
  repostedFrom: string | null;
}

/** The new job, or null when it is a repost of a job that was already posted again (jobs_one_repost_idx). */
export async function insertJob(db: Db, j: NewJob): Promise<JobRecord | null> {
  const rows = await db.query<JobRow>(
    `insert into jobs (id, poster_id, title, description, trades, zip, city, state, lat, lng, address, phone, budget_max_cents,
                       posted_at, closes_at, reposted_from)
     values ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     on conflict do nothing
     returning *`,
    [j.id, j.posterId, j.title, j.description, j.trades, j.zip, j.city, j.state, j.lat, j.lng, j.address, j.phone, j.budgetMaxCents,
      iso(j.postedAt), iso(j.closesAt), j.repostedFrom],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/** Was this job already posted again (a repost that an operator has not removed)? */
export async function hasRepost(db: Db, jobId: string): Promise<boolean> {
  const rows = await db.query('select 1 from jobs where reposted_from = $1 and removed_at is null limit 1', [jobId]);
  return rows.length > 0;
}

/** A job anyone may look at: removed jobs are gone (null). */
export async function getJob(db: Db, id: string): Promise<JobRecord | null> {
  const rows = await db.query<JobRow>('select * from jobs where id = $1 and removed_at is null', [id]);
  return rows[0] ? toJob(rows[0]) : null;
}

export async function jobsPostedBy(db: Db, accountId: string): Promise<JobRecord[]> {
  const rows = await db.query<JobRow>(
    'select * from jobs where poster_id = $1 and removed_at is null order by posted_at desc, id', [accountId],
  );
  return rows.map(toJob);
}

export async function jobsBidOnBy(db: Db, accountId: string): Promise<JobRecord[]> {
  const rows = await db.query<JobRow>(
    `select j.* from jobs j join job_bids b on b.job_id = j.id
     where b.bidder_id = $1 and j.removed_at is null order by j.closes_at desc, j.id`, [accountId],
  );
  return rows.map(toJob);
}

/** Ids of open jobs whose closing time has passed: what settleDue closes. */
export async function openJobsDue(db: Db, now: number): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `select id from jobs where status = 'open' and closes_at <= $1 and removed_at is null order by closes_at, id`, [iso(now)],
  );
  return rows.map((r) => r.id);
}

/** Ids of awarded jobs whose contact deadline has passed: what settleDue ends. */
export async function awardedJobsDue(db: Db, now: number): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `select id from jobs where status = 'awarded' and contact_deadline <= $1 and removed_at is null order by contact_deadline, id`, [iso(now)],
  );
  return rows.map((r) => r.id);
}

/**
 * Close an open job at its closing time: award it to `winner` (or end it 'no_bids' when winner is null) and mark
 * every active bid won or lost, in one statement. The guard is that the job is still open AND `winner` is still
 * the lowest active bid (or there still is none): a bid that changed between the read and this write makes the
 * statement change nothing, and the caller reads again. Returns the job as stored, or null when it lost the race.
 * The last statement sweeps any bid still marked active on a job that is no longer open (it cannot win any more).
 */
export async function closeJob(
  db: Db, jobId: string,
  next: { winner: BidState | null; awardedAt: number; contactDeadline: number | null; endedAt: number | null },
  now: number,
): Promise<JobRecord | null> {
  const w = next.winner;
  const rows = await db.query<JobRow>(
    `with j as (
       update jobs set
         status = case when $2::bigint is null then 'unfilled' else 'awarded' end,
         outcome = case when $2::bigint is null then 'no_bids' else null end,
         winner_bid_id = $2::bigint, winner_id = $3::text, award_cents = $4::bigint,
         awarded_at = case when $2::bigint is null then null else $5::timestamptz end,
         contact_deadline = $6::timestamptz, ended_at = $7::timestamptz
       where id = $1 and status = 'open' and removed_at is null
         and case when $2::bigint is null
               then not exists (select 1 from job_bids x where x.job_id = $1 and x.status = 'active')
               else exists (select 1 from job_bids x where x.id = $2::bigint and x.job_id = $1 and x.status = 'active' and x.amount_cents = $4::bigint)
                and not exists (select 1 from job_bids x where x.job_id = $1 and x.status = 'active'
                                  and (x.amount_cents, x.created_at, x.id) < ($4::bigint, $8::timestamptz, $2::bigint))
             end
       returning *
     ), b as (
       update job_bids set status = case when id = $2::bigint then 'won' else 'lost' end, updated_at = $9::timestamptz
       where job_id in (select id from j) and status = 'active'
       returning id
     )
     select * from j`,
    [jobId, w?.id ?? null, w?.bidderId ?? null, w?.amountCents ?? null, iso(next.awardedAt), iso(next.contactDeadline),
      iso(next.endedAt), iso(w?.createdAt ?? null), iso(now)],
  );
  if (!rows[0]) return null;
  await db.query(
    `update job_bids set status = 'lost', updated_at = $2 where job_id = $1 and status = 'active'
       and exists (select 1 from jobs where id = $1 and status <> 'open')`,
    [jobId, iso(now)],
  );
  return toJob(rows[0]);
}

/**
 * End an awarded job whose contact deadline passed, as `outcome`. The guard carries the contact facts the
 * decision was made on, so a message that got in first makes this change nothing (the caller reads again).
 * With a fee: the winner's bid becomes 'defaulted' and the fee row is written in the same statement.
 */
export async function endContact(
  db: Db, job: JobRecord, outcome: JobOutcome, fee: FeeLine | null, now: number,
): Promise<JobRecord | null> {
  const feeSql = fee ? `, f as (${FEE_FROM_J(9)}),
       d as (update job_bids set status = 'defaulted', updated_at = $8::timestamptz where id in (select winner_bid_id from j) returning id)` : '';
  const rows = await db.query<JobRow>(
    `with j as (
       update jobs set status = 'unfilled', outcome = $2, ended_at = contact_deadline
       where id = $1 and status = 'awarded' and contact_deadline <= $8::timestamptz
         and bidder_messaged_at is not distinct from $3::timestamptz and poster_messaged_at is not distinct from $4::timestamptz
         and poster_tapped_at is not distinct from $5::timestamptz and bidder_confirmed_at is not distinct from $6::timestamptz
         and poster_confirmed_at is not distinct from $7::timestamptz
       returning *
     )${feeSql}
     select * from j`,
    [job.id, outcome, iso(job.bidderMessagedAt), iso(job.posterMessagedAt), iso(job.posterTappedAt), iso(job.bidderConfirmedAt),
      iso(job.posterConfirmedAt), iso(now), ...(fee ? feeParams(fee, iso(now)!) : [])],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/** Poster cancels an open job before closing: it ends 'cancelled' and every active bid is closed as lost. */
export async function cancelOpenJob(db: Db, jobId: string, posterId: string, now: number): Promise<JobRecord | null> {
  const rows = await db.query<JobRow>(
    `with j as (
       update jobs set status = 'cancelled', ended_at = $3
       where id = $1 and poster_id = $2 and status = 'open' and closes_at > $3 and removed_at is null
       returning *
     ), b as (
       update job_bids set status = 'lost', updated_at = $3 where job_id in (select id from j) and status = 'active' returning id
     )
     select * from j`,
    [jobId, posterId, iso(now)],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/** Poster cancels after the award, inside the contact window: unfilled / poster_cancelled, no fee for anyone. */
export async function cancelAwardedJob(db: Db, jobId: string, posterId: string, now: number): Promise<JobRecord | null> {
  const rows = await db.query<JobRow>(
    `update jobs set status = 'unfilled', outcome = 'poster_cancelled', ended_at = $3
     where id = $1 and poster_id = $2 and status = 'awarded' and contact_deadline > $3 and removed_at is null
     returning *`,
    [jobId, posterId, iso(now)],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/** The winner gives the job back inside the window: unfilled / bidder_backed_out, bid 'defaulted', the no-show fee. */
export async function backOut(db: Db, jobId: string, winnerId: string, fee: FeeLine, now: number): Promise<JobRecord | null> {
  const rows = await db.query<JobRow>(
    `with j as (
       update jobs set status = 'unfilled', outcome = 'bidder_backed_out', ended_at = $3::timestamptz
       where id = $1 and winner_id = $2 and status = 'awarded' and contact_deadline > $3::timestamptz and removed_at is null
       returning *
     ), f as (${FEE_FROM_J(4)}),
     d as (update job_bids set status = 'defaulted', updated_at = $3::timestamptz where id in (select winner_bid_id from j) returning id)
     select * from j`,
    [jobId, winnerId, iso(now), ...feeParams(fee, iso(now)!)],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/** "They contacted me" (poster, inside the window). Tapping twice keeps the first time. */
export async function tapContacted(db: Db, jobId: string, posterId: string, now: number): Promise<JobRecord | null> {
  const rows = await db.query<JobRow>(
    `update jobs set poster_tapped_at = coalesce(poster_tapped_at, $3)
     where id = $1 and poster_id = $2 and status = 'awarded' and contact_deadline > $3 and removed_at is null
     returning *`,
    [jobId, posterId, iso(now)],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/**
 * "We've agreed" from one side. One statement: it sets that side's time and, when the other side's is
 * already there, moves the job to 'agreed' and writes the service fee. Two confirms at once cannot both
 * miss the other: the database applies them to the row one after the other.
 */
export async function confirm(
  db: Db, jobId: string, side: 'poster' | 'winner', accountId: string, fee: (awardCents: number) => FeeLine, awardCents: number, now: number,
): Promise<JobRecord | null> {
  const mine = side === 'poster' ? 'poster_confirmed_at' : 'bidder_confirmed_at';
  const theirs = side === 'poster' ? 'bidder_confirmed_at' : 'poster_confirmed_at';
  const who = side === 'poster' ? 'poster_id' : 'winner_id';
  const f = fee(awardCents);
  const rows = await db.query<JobRow>(
    `with j as (
       update jobs set
         ${mine} = coalesce(${mine}, $3::timestamptz),
         status = case when ${theirs} is not null then 'agreed' else status end,
         agreed_at = case when ${theirs} is not null then $3::timestamptz else agreed_at end
       where id = $1 and ${who} = $2 and status = 'awarded' and contact_deadline > $3::timestamptz and removed_at is null
         and award_cents = $4::bigint
       returning *
     ), f as (
       insert into job_fees (job_id, kind, payer_id, basis_cents, rate_ppm, amount_cents, poster_share_ppm, poster_share_cents,
                             platform_cents, status, created_at, payer_ref)
       select j.id, $5, j.winner_id, $6::bigint, $7::integer, $8::bigint, $9::integer, $10::bigint, $11::bigint, 'recorded', $3::timestamptz,
              j.winner_id
       from j where j.status = 'agreed' and j.winner_id is not null
       on conflict (job_id, kind) do nothing
     )
     select * from j`,
    [jobId, accountId, iso(now), awardCents, f.kind, f.basisCents, f.ratePpm, f.amountCents, f.posterSharePpm, f.posterShareCents, f.platformCents],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/** "Job done" (poster, of an agreed job). */
export async function completeJob(db: Db, jobId: string, posterId: string, now: number): Promise<JobRecord | null> {
  const rows = await db.query<JobRow>(
    `update jobs set status = 'completed', completed_at = $3, ended_at = $3
     where id = $1 and poster_id = $2 and status = 'agreed' and removed_at is null
     returning *`,
    [jobId, posterId, iso(now)],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/** An operator takes a job down. It disappears everywhere (getJob answers null); the rows stay. */
export async function removeJob(db: Db, jobId: string, now: number): Promise<JobRecord | null> {
  const rows = await db.query<JobRow>(
    'update jobs set removed_at = coalesce(removed_at, $2) where id = $1 returning *', [jobId, iso(now)],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

// ------------------------------------------------------------------ bids --

export async function listBids(db: Db, jobId: string): Promise<BidRecord[]> {
  const rows = await db.query<BidRow>('select * from job_bids where job_id = $1 order by amount_cents, created_at, id', [jobId]);
  return rows.map(toBid);
}

export async function getMyBid(db: Db, jobId: string, accountId: string): Promise<BidRecord | null> {
  const rows = await db.query<BidRow>('select * from job_bids where job_id = $1 and bidder_id = $2', [jobId, accountId]);
  return rows[0] ? toBid(rows[0]) : null;
}

/** Active bids per job, for many jobs at once. */
export async function activeBidCounts(db: Db, jobIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (jobIds.length === 0) return out;
  const rows = await db.query<{ job_id: string; n: Big }>(
    `select job_id, count(*) as n from job_bids where job_id = any($1::text[]) and status in ('active', 'won', 'lost', 'defaulted')
     group by job_id`, [[...jobIds]],
  );
  for (const r of rows) out.set(r.job_id, Number(r.n));
  return out;
}

/**
 * Place or replace this account's bid, in one statement that only writes while the job is open, not past its
 * closing time, not the bidder's own and not over its budget ceiling. The unique (job, bidder) key makes two
 * taps at once leave one bid. A new amount (or a bid coming back after a withdrawal) counts as placed now —
 * the tie-break is "placed first"; a note-only change keeps its place. null = nothing was written.
 * The job row is read FOR SHARE: a closing that is writing the same row is waited for, then seen.
 */
export async function placeBid(
  db: Db, b: { jobId: string; bidderId: string; amountCents: number; note: string | null }, now: number,
): Promise<BidRecord | null> {
  const rows = await db.query<BidRow>(
    `insert into job_bids (job_id, bidder_id, amount_cents, note, status, created_at, updated_at)
     select j.id, $2, $3::bigint, $4, 'active', $5::timestamptz, $5::timestamptz
     from jobs j
     where j.id = $1 and j.status = 'open' and j.closes_at > $5::timestamptz and j.removed_at is null and j.poster_id <> $2
       and (j.budget_max_cents is null or $3::bigint <= j.budget_max_cents)
     for share
     on conflict (job_id, bidder_id) do update set
       amount_cents = excluded.amount_cents, note = excluded.note, status = 'active', updated_at = excluded.updated_at,
       created_at = case when job_bids.amount_cents <> excluded.amount_cents or job_bids.status <> 'active'
                         then excluded.created_at else job_bids.created_at end
     returning *`,
    [b.jobId, b.bidderId, b.amountCents, b.note, iso(now)],
  );
  return rows[0] ? toBid(rows[0]) : null;
}

/** Withdraw while the job is open. Free. */
export async function withdrawBid(db: Db, jobId: string, bidderId: string, now: number): Promise<BidRecord | null> {
  const rows = await db.query<BidRow>(
    `update job_bids b set status = 'withdrawn', updated_at = $3
     where b.job_id = $1 and b.bidder_id = $2 and b.status = 'active'
       and exists (select 1 from jobs j where j.id = $1 and j.status = 'open' and j.closes_at > $3 and j.removed_at is null)
     returning b.*`,
    [jobId, bidderId, iso(now)],
  );
  return rows[0] ? toBid(rows[0]) : null;
}

// -------------------------------------------------------------- messages --

/**
 * A message from the poster or the winner, after the award: while 'awarded' (inside the window) or 'agreed'.
 * The same statement stamps that side's first message on the job ("made contact"). null = not allowed now.
 */
export async function insertMessage(db: Db, jobId: string, senderId: string, body: string, now: number): Promise<MessageRecord | null> {
  const rows = await db.query<MessageRow>(
    `with j as (
       update jobs set
         bidder_messaged_at = case when winner_id = $2 then coalesce(bidder_messaged_at, $4::timestamptz) else bidder_messaged_at end,
         poster_messaged_at = case when poster_id = $2 then coalesce(poster_messaged_at, $4::timestamptz) else poster_messaged_at end
       where id = $1 and removed_at is null and (poster_id = $2 or winner_id = $2)
         and (status = 'agreed' or (status = 'awarded' and contact_deadline > $4::timestamptz))
       returning id
     )
     insert into job_messages (job_id, sender_id, body, created_at)
     select j.id, $2, $3, $4::timestamptz from j
     returning *`,
    [jobId, senderId, body, iso(now)],
  );
  return rows[0] ? toMessage(rows[0]) : null;
}

export async function listMessages(db: Db, jobId: string): Promise<MessageRecord[]> {
  const rows = await db.query<MessageRow>('select * from job_messages where job_id = $1 order by id', [jobId]);
  return rows.map(toMessage);
}

// ------------------------------------------------------------------ fees --

export async function listFees(db: Db, jobId: string): Promise<FeeRecord[]> {
  const rows = await db.query<FeeRow>('select * from job_fees where job_id = $1 order by id', [jobId]);
  return rows.map(toFee);
}

/** An operator waives a fee. Waiving twice keeps the first time. null = no such fee. */
export async function waiveFee(db: Db, feeId: number, now: number): Promise<FeeRecord | null> {
  const rows = await db.query<FeeRow>(
    `update job_fees set status = 'waived', waived_at = coalesce(waived_at, $2) where id = $1 returning *`, [feeId, iso(now)],
  );
  return rows[0] ? toFee(rows[0]) : null;
}

export interface LedgerTotals {
  /** Every row: recorded and waived. */
  rows: number;
  /** Rows whose payer deleted their account (payer_id is null; payer_ref and payer_name say who it was). */
  payerGone: number;
  /** The sum of the fees still on record ('recorded'): what the ledger says is owed. Nothing is collected. */
  recordedCents: number;
  waivedCents: number;
  /** Of the recorded fees: the posters' part and BidSwipe's part. posterShareCents + platformCents = recordedCents. */
  posterShareCents: number;
  platformCents: number;
}

/**
 * What the whole ledger adds up to. Deleting an account never takes a row away: the fees that account owed stay
 * in recordedCents. The one thing a deletion moves is the service fee of an agreed job whose POSTER left: it
 * goes from recordedCents to waivedCents, so the winner who stayed owes nothing (deleteAccount below).
 */
export async function ledgerTotals(db: Db): Promise<LedgerTotals> {
  const rows = await db.query<Record<'rows' | 'payer_gone' | 'recorded' | 'waived' | 'poster_share' | 'platform', Big>>(
    `select count(*) as rows,
            count(*) filter (where payer_id is null) as payer_gone,
            coalesce(sum(amount_cents) filter (where status = 'recorded'), 0) as recorded,
            coalesce(sum(amount_cents) filter (where status = 'waived'), 0) as waived,
            coalesce(sum(poster_share_cents) filter (where status = 'recorded'), 0) as poster_share,
            coalesce(sum(platform_cents) filter (where status = 'recorded'), 0) as platform
     from job_fees`,
  );
  const r = rows[0]!;
  return {
    rows: Number(r.rows), payerGone: Number(r.payer_gone), recordedCents: Number(r.recorded), waivedCents: Number(r.waived),
    posterShareCents: Number(r.poster_share), platformCents: Number(r.platform),
  };
}

/** The ledger's newest rows, for an operator (GET /api/admin/jobs/fees). */
export async function listLedger(db: Db, limit = 200): Promise<FeeRecord[]> {
  const rows = await db.query<FeeRow>('select * from job_fees order by id desc limit $1', [limit]);
  return rows.map(toFee);
}

// --------------------------------------------------------------- reports --

export async function upsertReport(db: Db, jobId: string, reporterId: string, reason: string, now: number): Promise<boolean> {
  const rows = await db.query(
    `insert into job_reports (job_id, reporter_id, reason, created_at)
     select id, $2, $3, $4 from jobs where id = $1 and removed_at is null
     on conflict (job_id, reporter_id) do update set reason = excluded.reason, created_at = excluded.created_at
     returning id`,
    [jobId, reporterId, reason, iso(now)],
  );
  return rows.length > 0;
}

export interface ReportRecord {
  id: number;
  jobId: string;
  jobTitle: string;
  jobStatus: JobStatus;
  jobRemoved: boolean;
  reporterId: string;
  reason: string;
  createdAt: string;
}

export async function listReports(db: Db, limit = 200): Promise<ReportRecord[]> {
  const rows = await db.query<{ id: Big; job_id: string; title: string; status: JobStatus; removed_at: Ts; reporter_id: string; reason: string; created_at: Ts }>(
    `select r.id, r.job_id, j.title, j.status, j.removed_at, r.reporter_id, r.reason, r.created_at
     from job_reports r join jobs j on j.id = r.job_id order by r.id desc limit $1`, [limit],
  );
  return rows.map((r) => ({
    id: n(r.id)!, jobId: r.job_id, jobTitle: r.title, jobStatus: r.status, jobRemoved: r.removed_at != null, reporterId: r.reporter_id,
    reason: r.reason, createdAt: new Date(r.created_at!).toISOString(),
  }));
}

// -------------------------------------------------------------- accounts --

export interface AccountBasics {
  id: string;
  name: string;
  memberSince: string;
}

/** Name and join date for the people on a job, for the cards' fallback. Never the email. */
export async function accountBasics(db: Db, ids: readonly string[]): Promise<Map<string, AccountBasics>> {
  const out = new Map<string, AccountBasics>();
  if (ids.length === 0) return out;
  const rows = await db.query<{ id: string; name: string | null; created_at: Ts }>(
    'select id, name, created_at from accounts where id = any($1::text[])', [[...new Set(ids)]],
  );
  for (const r of rows) out.set(r.id, { id: r.id, name: r.name?.trim() || 'BidSwipe member', memberSince: new Date(r.created_at!).toISOString() });
  return out;
}

/** The profile an account owns (alerts hang off profiles), or null. */
export async function profileIdOf(db: Db, accountId: string): Promise<string | null> {
  const rows = await db.query<{ id: string }>('select id from profiles where account_id = $1', [accountId]);
  return rows[0]?.id ?? null;
}

// ------------------------------------------------------------- the feed --

/** The mirrored feed ids ('local:<jobId>') of the jobs a profile's own account posted: never scored for it. */
export async function ownLocalBidIds(db: Db, profileId: string): Promise<Set<string>> {
  const rows = await db.query<{ id: string }>(
    `select 'local:' || j.id as id from jobs j join profiles p on p.account_id = j.poster_id where p.id = $1`, [profileId],
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * The profiles that belong to an account. Local jobs are an accounts-mode feature: a config profile (the pilot's
 * config/<id>.json, stored by single mode) has no account to bid with, so it is never shown one.
 */
export async function accountProfileIds(db: Db): Promise<Set<string>> {
  const rows = await db.query<{ id: string }>('select id from profiles where account_id is not null');
  return new Set(rows.map((r) => r.id));
}

/** Take a job out of every feed at once: its mirrored bid closes now (removed: the row goes, with its scores). */
export async function closeMirror(db: Db, jobId: string, now: number, remove = false): Promise<void> {
  if (remove) await db.query('delete from bids where id = $1', [`local:${jobId}`]);
  else {
    await db.query(
      `update bids set due_at = least(coalesce(due_at, $2::timestamptz), $2::timestamptz) where id = $1`, [`local:${jobId}`, iso(now)],
    );
  }
}

// ------------------------------------------------------------- reminders --

/**
 * Awarded jobs whose winner has not made contact and whose deadline is within `hours`. "Made contact" is
 * rules.madeContact(): the winner's message or "We've agreed", the poster's "They contacted me" or "We've agreed".
 */
export async function awardedWithoutContact(db: Db, now: number, hours: number): Promise<JobRecord[]> {
  const rows = await db.query<JobRow>(
    `select * from jobs
     where status = 'awarded' and removed_at is null and bidder_messaged_at is null and poster_tapped_at is null
       and bidder_confirmed_at is null and poster_confirmed_at is null
       and contact_deadline > $1 and contact_deadline <= $2
     order by contact_deadline, id`,
    [iso(now), iso(now + hours * 3_600_000)],
  );
  return rows.map(toJob);
}

// ----------------------------------------------------------------- stats --

export interface StatsRow {
  posted: number; won: number; agreed: number; completed: number; noShows: number; backedOut: number; posterNoShows: number;
}

export async function statsFor(db: Db, accountId: string): Promise<StatsRow> {
  const rows = await db.query<Record<keyof StatsRow, Big>>(
    `select
       (select count(*) from jobs where poster_id = $1 and removed_at is null) as "posted",
       (select count(*) from jobs where winner_id = $1 and removed_at is null) as "won",
       (select count(*) from jobs where winner_id = $1 and status in ('agreed', 'completed') and removed_at is null) as "agreed",
       (select count(*) from jobs where winner_id = $1 and status = 'completed' and removed_at is null) as "completed",
       (select count(*) from jobs where winner_id = $1 and outcome = 'bidder_no_show' and removed_at is null) as "noShows",
       (select count(*) from jobs where winner_id = $1 and outcome = 'bidder_backed_out' and removed_at is null) as "backedOut",
       (select count(*) from jobs where poster_id = $1 and outcome = 'poster_no_show' and removed_at is null) as "posterNoShows"`,
    [accountId],
  );
  const r = rows[0]!;
  return {
    posted: Number(r.posted), won: Number(r.won), agreed: Number(r.agreed), completed: Number(r.completed),
    noShows: Number(r.noShows), backedOut: Number(r.backedOut), posterNoShows: Number(r.posterNoShows),
  };
}

/** One posted a job the other bid on, after the bids were opened (or won). */
export async function dealtWith(db: Db, a: string, b: string): Promise<boolean> {
  const rows = await db.query(
    `select 1 from jobs j
     where j.removed_at is null and j.status not in ('open', 'cancelled')
       and ((j.poster_id = $1 and (j.winner_id = $2 or exists (select 1 from job_bids x where x.job_id = j.id and x.bidder_id = $2
                                                                 and x.status in ('won', 'lost', 'defaulted'))))
         or (j.poster_id = $2 and (j.winner_id = $1 or exists (select 1 from job_bids x where x.job_id = j.id and x.bidder_id = $1
                                                                 and x.status in ('won', 'lost', 'defaulted')))))
     limit 1`,
    [a, b],
  );
  return rows.length > 0;
}

// ------------------------------------------------------- account deletion --

/** What is left of a job whose poster deleted their account, for one person who was waiting on it. */
export interface Tombstone {
  jobId: string;
  role: 'winner' | 'bidder';
  title: string;
  /** What the job was when it went: open for bids, awarded, or agreed. */
  was: 'open' | 'awarded' | 'agreed';
  /** This person's own bid on it (the winning bid, for the winner). */
  amountCents: number | null;
  /** A service fee that was on record for them on this job and was waived by the deletion. */
  feeWaivedCents: number | null;
  endedAt: number;
}

/** A live job the deleted account had won: it ended 'bidder_left' for its poster. */
export interface WonEnded {
  jobId: string;
  posterId: string;
  title: string;
  was: 'awarded' | 'agreed';
  awardCents: number | null;
  contactDeadline: number | null;
}

export interface DeletedAccount {
  /** False when there was no such account (deleted already, a double tap): nothing was changed. */
  deleted: boolean;
  /** Posters who must be told their winner is gone. */
  wonEnded: WonEnded[];
  /** People who were waiting on a job the account posted: each now has a tombstone, and is told. */
  leftBehind: Array<Omit<Tombstone, 'endedAt'> & { accountId: string }>;
  /** Counts for the log. No ids, no names. */
  jobsRemoved: number;
  mirrorsRemoved: number;
  feesKept: number;
  feesWaived: number;
}

interface DeletedRow {
  deleted: Big; jobs_removed: Big; mirrors_removed: Big; fees_kept: Big; fees_waived: Big;
  won: unknown; tombs: unknown;
}

const list = <T>(v: unknown): T[] => (typeof v === 'string' ? (JSON.parse(v) as T[]) : ((v as T[] | null) ?? []));

/**
 * Delete an account and everything that hangs off it, in ONE statement, so it happens whole or not at all.
 *
 * The foreign keys do most of it: the accounts row takes its profile (with matches, swipes, alerts, cost checks),
 * sessions, sign-in identities, reset links, devices, promo redemptions, work profile, the jobs it posted (with
 * their bids, messages and reports), and its own bids, messages and reports on other people's jobs.
 * What no foreign key does is written here, in the same statement:
 *
 *   won           a job the account had WON and that is still live (awarded or agreed) ends now for its poster:
 *                 unfilled / 'bidder_left'. No fee is recorded for anyone because of a deletion.
 *   tombs         everyone waiting on a live job the account POSTED (the winner of an awarded or agreed job, each
 *                 sealed bid on an open one) gets one line in job_tombstones: the job row itself goes.
 *   waived        the one who stays owes nothing: a service fee already recorded for the winner of an agreed
 *                 job whose poster leaves is waived (the row stays in the ledger as 'waived').
 *   kept          the fee lines the account itself owes stay in the ledger. payer_id becomes null; payer_ref
 *                 (written with the fee), payer_name and payer_deleted_at keep who it was. Never the email.
 *   mirrors       the feed rows 'local:<jobId>' of every job the account posted (their matches and swipes
 *                 cascade from bids), and mirror_alerts: every alert that points at one of them, for anybody.
 *
 * Every part joins `me`, so for an id that is not an account the statement changes nothing. The parts read
 * the rows as they were when the statement began (that is how Postgres runs a WITH); the cascades run at its end.
 */
export async function deleteAccount(db: Db, accountId: string, now: number): Promise<DeletedAccount> {
  const rows = await db.query<DeletedRow>(
    `with me as (
       select id, name from accounts where id = $1
     ), won as (
       update jobs j set status = 'unfilled', outcome = 'bidder_left', ended_at = $2::timestamptz, winner_id = null
       from me
       where j.winner_id = me.id and j.status in ('awarded', 'agreed')
       returning j.id, j.poster_id, j.title, j.award_cents, j.contact_deadline, j.agreed_at, j.removed_at
     ), stayers as (
       select j.id as job_id, j.winner_id as account_id, 'winner' as role, j.title, j.status as was, j.award_cents as amount_cents
       from jobs j join me on j.poster_id = me.id
       where j.status in ('awarded', 'agreed') and j.winner_id is not null and j.removed_at is null
       union all
       select j.id, b.bidder_id, 'bidder', j.title, 'open', b.amount_cents
       from jobs j join me on j.poster_id = me.id join job_bids b on b.job_id = j.id and b.status = 'active'
       where j.status = 'open' and j.removed_at is null
     ), waived as (
       update job_fees f set status = 'waived', waived_at = $2::timestamptz
       from jobs j join me on j.poster_id = me.id
       where f.job_id = j.id and j.status in ('awarded', 'agreed') and f.status = 'recorded'
       returning f.job_id, f.payer_id, f.amount_cents
     ), tombs as (
       insert into job_tombstones (job_id, account_id, role, title, was, amount_cents, fee_waived_cents, ended_at)
       select s.job_id, s.account_id, s.role, s.title, s.was, s.amount_cents,
              (select sum(w.amount_cents)::bigint from waived w where w.job_id = s.job_id and w.payer_id = s.account_id),
              $2::timestamptz
       from stayers s
       on conflict (job_id, account_id) do nothing
       returning job_id, account_id, role, title, was, amount_cents, fee_waived_cents
     ), kept as (
       update job_fees f set payer_ref = coalesce(f.payer_ref, f.payer_id), payer_name = me.name,
                             payer_deleted_at = $2::timestamptz, payer_id = null
       from me
       where f.payer_id = me.id
       returning f.id
     ), mirror_alerts as (
       delete from alerts a using jobs j, me
       where j.poster_id = me.id and a.bid_id = 'local:' || j.id
       returning a.id
     ), mirrors as (
       delete from bids b using jobs j, me
       where j.poster_id = me.id and b.id = 'local:' || j.id
       returning b.id
     ), posted as (
       select count(*) as n from jobs j join me on j.poster_id = me.id
     ), gone as (
       delete from accounts a using me where a.id = me.id returning a.id
     )
     select
       (select count(*) from gone) as deleted,
       (select n from posted) as jobs_removed,
       (select count(*) from mirrors) as mirrors_removed,
       (select count(*) from kept) as fees_kept,
       (select count(*) from waived) as fees_waived,
       (select coalesce(json_agg(json_build_object(
          'jobId', w.id, 'posterId', w.poster_id, 'title', w.title,
          'was', case when w.agreed_at is null then 'awarded' else 'agreed' end, 'awardCents', w.award_cents,
          'contactDeadline', (extract(epoch from w.contact_deadline) * 1000)::bigint) order by w.id), '[]'::json)
        from won w where w.removed_at is null) as won,
       (select coalesce(json_agg(json_build_object(
          'jobId', t.job_id, 'accountId', t.account_id, 'role', t.role, 'title', t.title, 'was', t.was,
          'amountCents', t.amount_cents, 'feeWaivedCents', t.fee_waived_cents) order by t.job_id, t.account_id), '[]'::json)
        from tombs t) as tombs`,
    [accountId, iso(now)],
  );
  const r = rows[0]!;
  return {
    deleted: Number(r.deleted) > 0,
    wonEnded: list<WonEnded>(r.won).map((w) => ({ ...w, awardCents: n(w.awardCents), contactDeadline: n(w.contactDeadline) })),
    leftBehind: list<DeletedAccount['leftBehind'][number]>(r.tombs)
      .map((t) => ({ ...t, amountCents: n(t.amountCents), feeWaivedCents: n(t.feeWaivedCents) })),
    jobsRemoved: Number(r.jobs_removed ?? 0), mirrorsRemoved: Number(r.mirrors_removed), feesKept: Number(r.fees_kept),
    feesWaived: Number(r.fees_waived),
  };
}

interface TombstoneRow {
  job_id: string; role: Tombstone['role']; title: string; was: Tombstone['was']; amount_cents: Big; fee_waived_cents: Big; ended_at: Ts;
}
const toTombstone = (r: TombstoneRow): Tombstone => ({
  jobId: r.job_id, role: r.role, title: r.title, was: r.was, amountCents: n(r.amount_cents), feeWaivedCents: n(r.fee_waived_cents),
  endedAt: ms(r.ended_at)!,
});

/** The line left for this person about a job that is gone, or null: nobody else may read it. */
export async function getTombstone(db: Db, jobId: string, accountId: string): Promise<Tombstone | null> {
  const rows = await db.query<TombstoneRow>('select * from job_tombstones where job_id = $1 and account_id = $2', [jobId, accountId]);
  return rows[0] ? toTombstone(rows[0]) : null;
}

/** Every such line for one person, newest first: the "ended" part of their jobs list. */
export async function tombstonesFor(db: Db, accountId: string): Promise<Tombstone[]> {
  const rows = await db.query<TombstoneRow>(
    'select * from job_tombstones where account_id = $1 order by ended_at desc, job_id limit 100', [accountId],
  );
  return rows.map(toTombstone);
}

/** What deleting an account would end, counted for the "Delete my account" screen before anything is changed. */
export interface DeletionPreview {
  /** Every job the account posted, in any state: all of them are removed. */
  jobsPosted: number;
  /** Of those, the ones still open for bids, and how many sealed bids are on them (those bidders are told). */
  openPosted: number;
  bidsOnOpenPosted: number;
  /** Jobs it posted that someone has won and is waiting on: they end for that winner, who owes nothing. */
  livePosted: Array<{ title: string; status: 'awarded' | 'agreed' }>;
  /** Jobs it won that are still live: they go back to their posters, with no fee. */
  liveWon: Array<{ title: string; status: 'awarded' | 'agreed'; awardCents: number | null }>;
  /** Its own sealed bids on other people's open jobs: withdrawn. */
  activeBids: number;
  /** Fee lines it owes: they stay in the ledger, with the name on the account and without the email. */
  feeLines: number;
  feeCents: number;
}

export async function deletionPreview(db: Db, accountId: string): Promise<DeletionPreview> {
  const rows = await db.query<{
    jobs_posted: Big; open_posted: Big; bids_on_open: Big; live_posted: unknown; live_won: unknown; active_bids: Big; fee_lines: Big; fee_cents: Big;
  }>(
    `select
       (select count(*) from jobs where poster_id = $1) as jobs_posted,
       (select count(*) from jobs where poster_id = $1 and status = 'open' and removed_at is null) as open_posted,
       (select count(*) from job_bids b join jobs j on j.id = b.job_id
         where j.poster_id = $1 and j.status = 'open' and j.removed_at is null and b.status = 'active') as bids_on_open,
       (select coalesce(json_agg(json_build_object('title', title, 'status', status) order by posted_at, id), '[]'::json)
          from jobs where poster_id = $1 and status in ('awarded', 'agreed') and winner_id is not null and removed_at is null) as live_posted,
       (select coalesce(json_agg(json_build_object('title', title, 'status', status, 'awardCents', award_cents) order by posted_at, id), '[]'::json)
          from jobs where winner_id = $1 and status in ('awarded', 'agreed') and removed_at is null) as live_won,
       (select count(*) from job_bids b join jobs j on j.id = b.job_id
         where b.bidder_id = $1 and b.status = 'active' and j.status = 'open' and j.removed_at is null) as active_bids,
       (select count(*) from job_fees where payer_id = $1) as fee_lines,
       (select coalesce(sum(amount_cents), 0) from job_fees where payer_id = $1 and status = 'recorded') as fee_cents`,
    [accountId],
  );
  const r = rows[0]!;
  return {
    jobsPosted: Number(r.jobs_posted), openPosted: Number(r.open_posted), bidsOnOpenPosted: Number(r.bids_on_open),
    livePosted: list<DeletionPreview['livePosted'][number]>(r.live_posted),
    liveWon: list<DeletionPreview['liveWon'][number]>(r.live_won).map((w) => ({ ...w, awardCents: n(w.awardCents) })),
    activeBids: Number(r.active_bids), feeLines: Number(r.fee_lines), feeCents: Number(r.fee_cents),
  };
}
