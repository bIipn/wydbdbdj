/** SQL for accounts, identities and sessions (tables in schema.ts). Owner: the auth builder. */
import { jobsInProgressCtes } from '../jobs/repo.js';
import type { Account, Plan } from '../types.js';
import type { Db } from './db.js';

const PLANS: readonly Plan[] = ['free', 'pro', 'pilot'];
export const isPlan = (value: unknown): value is Plan => PLANS.includes(value as Plan);

// ----------------------------------------------------------- accounts --

/** The public columns. password_hash is read by findCredentials only and never leaves src/auth. */
const ACCOUNT_COLS = 'id, email, name, plan, created_at';
/** The same columns in a join where accounts is aliased `a`. */
const A_COLS = 'a.id, a.email, a.name, a.plan, a.created_at';

interface AccountRow { id: string; email: string; name: string | null; plan: string; created_at: Date | string }

const toAccount = (r: AccountRow): Account => ({
  id: r.id, email: r.email, name: r.name, plan: isPlan(r.plan) ? r.plan : 'free', createdAt: new Date(r.created_at).toISOString(),
});

export interface NewAccount {
  id: string;
  /** Already lower-cased: the unique index is the only thing that stops two accounts for one address. */
  email: string;
  name: string | null;
  /** null for an account that signs in through a provider only. */
  passwordHash: string | null;
}

/**
 * Create an account, with its first sign-in identity when it comes from a provider (one statement,
 * so there is never an account without the identity that created it). Null when the email is taken.
 */
export async function createAccount(
  db: Db, a: NewAccount, now: Date, identity?: { provider: string; subject: string },
): Promise<Account | null> {
  const rows = await db.query<AccountRow>(
    `with a as (
       insert into accounts (id, email, name, password_hash, created_at, last_login_at) values ($1, $2, $3, $4, $5, $5)
       on conflict (email) do nothing
       returning ${ACCOUNT_COLS}
     ), i as (
       insert into identities (provider, subject, account_id)
       select $6::text, $7::text, id from a where $6::text is not null
     )
     select ${ACCOUNT_COLS} from a`,
    [a.id, a.email, a.name, a.passwordHash, now.toISOString(), identity?.provider ?? null, identity?.subject ?? null],
  );
  return rows[0] ? toAccount(rows[0]) : null;
}

/** The account for an email plus its password hash (null when it has none). For sign-in only. */
export async function findCredentials(db: Db, email: string): Promise<{ account: Account; passwordHash: string | null } | null> {
  const rows = await db.query<AccountRow & { password_hash: string | null }>(
    `select ${ACCOUNT_COLS}, password_hash from accounts where email = $1`, [email],
  );
  return rows[0] ? { account: toAccount(rows[0]), passwordHash: rows[0].password_hash } : null;
}

export async function setPasswordHash(db: Db, accountId: string, passwordHash: string): Promise<void> {
  await db.query('update accounts set password_hash = $2 where id = $1', [accountId, passwordHash]);
}

export async function recordLogin(db: Db, accountId: string, now: Date): Promise<void> {
  await db.query('update accounts set last_login_at = $2 where id = $1', [accountId, now.toISOString()]);
}

/** What deleteAccount did. Exactly one of the two is true: deleted, or blocked by `blocking` (nothing was touched). */
export interface AccountDeletion {
  deleted: boolean;
  /** Jobs still in progress (src/jobs/repo.ts jobsInProgressCtes), title order. Empty when it was deleted. */
  blocking: Array<{ id: string; title: string }>;
}

/**
 * Delete an account and everything it owns, in ONE statement (one transaction): either all of it goes, or nothing
 * does. Nothing goes while the account is in a job in progress (`blocking`, decided in the same statement).
 *
 * The foreign keys do most of it (schema.ts, schema-*.ts): the account row's delete cascades to its identities,
 * sessions, push devices, profile (and with it matches, swipes, alerts, cost checks), work profile, promo
 * redemptions, the hidden-card mark, the jobs it posted (their bids, messages, fees, reports), its bids and messages
 * on other people's jobs, its fees, the reports it sent and the reports about it; a job it won keeps its record with
 * winner_id set to null (src/jobs/view.ts says "deleted their account"). This statement also removes what the keys
 * do not reach:
 *   - the feed's copy of each job it posted (bids row 'local:<jobId>': no key; its scores and saves cascade from it);
 *   - other people's alerts about those jobs (a match on the copy, an award, a closing), and the "New message"
 *     alerts that carry its own words (alerts.bid_id / data.jobId / dedupe_key '<jobId>:<messageId>' have no key);
 *   - the attempt counters that name it (auth_attempts keys: 'login:email:<email>', 'login:pair:<email>|<address>',
 *     'login:known:<email>|<address>', the per-session 'account:delete:<id>:<session>', the per-account 'promo:account:',
 *     'profile:save:' and 'push:test:' and per-profile 'estimate:' keys; src/routes/*.ts). An e-mail is a prefix only up
 *     to its '|';
 *   - its entry in each stored scan report (scans.report.profiles['acct-<account id>']: counts of what was scored).
 * One profile per account (profiles_account_idx), so a scan report has at most one key of it.
 * A promo code's use count (promo_codes) stays: the code was used, and a new account must not get it back.
 *
 * Fees: the fee rows it owes go with it (job_fees.payer_id cascades), and so do the rows of the jobs it posted.
 * PAYMENTS ARE OFF, so these are records only. When payments are turned on, fee records must outlive the account
 * (law and disputes): revisit before then.
 */
export async function deleteAccount(db: Db, accountId: string, now: Date): Promise<AccountDeletion> {
  const rows = await db.query<{ what: string; id: string; title: string | null }>(
    `with ${jobsInProgressCtes('$1', '$2')},
     go as (
       select a.id, a.email from accounts a where a.id = $1 and not exists (select 1 from blocking)
     ), posted as (
       select j.id from jobs j where j.poster_id in (select id from go)
     ), sent as (
       select m.job_id || ':' || m.id as k from job_messages m where m.sender_id in (select id from go)
     ), mirrors as (
       delete from bids where id in (select 'local:' || id from posted) returning id
     ), their_alerts as (
       delete from alerts
       where bid_id in (select 'local:' || id from posted)
          or (kind in ('job_awarded', 'job_message', 'job_deadline', 'job_closed') and data->>'jobId' in (select id from posted))
          or (kind = 'job_message' and dedupe_key in (select k from sent))
       returning id
     ), counters as (
       delete from auth_attempts x using go
       where x.key in ('login:email:' || go.email, 'promo:account:' || go.id, 'profile:save:' || go.id, 'push:test:' || go.id)
          or starts_with(x.key, 'account:delete:' || go.id || ':')
          or x.key in (select 'estimate:' || p.id from profiles p where p.account_id = go.id)
          or (starts_with(x.key, 'login:pair:' || go.email || '|')
              and strpos(substr(x.key, length('login:pair:' || go.email || '|') + 1), '|') = 0)
          or (starts_with(x.key, 'login:known:' || go.email || '|')
              and strpos(substr(x.key, length('login:known:' || go.email || '|') + 1), '|') = 0)
       returning x.key
     ), scan_reports as (
       update scans s set report = jsonb_set(s.report, '{profiles}', (s.report->'profiles') - p.id)
       from (select id from profiles where account_id in (select id from go)) p
       where jsonb_typeof(s.report->'profiles') = 'object' and (s.report->'profiles') ? p.id
       returning s.id
     ), gone as (
       delete from accounts a using go where a.id = go.id returning a.id
     )
     select 'blocking' as what, b.id, b.title from blocking b
     union all
     select 'deleted' as what, g.id, null from gone g`,
    [accountId, now.toISOString()],
  );
  const blocking = rows.filter((r) => r.what === 'blocking').map((r) => ({ id: r.id, title: r.title ?? '' }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const deleted = rows.some((r) => r.what === 'deleted');
  if (deleted) await sweepOrphanMirrors(db);
  return { deleted, blocking };
}

/**
 * The backstop for a job posted in the same instant as its poster's deletion (review del-2). The feed copy is written
 * only while its job exists, under a lock on the job row (src/db/repo.ts upsertMirrorBid); when that write got the lock
 * first, the deletion waited for it, but its statement reads the rows as they were when it started and so missed the
 * copy. This runs after, as its own statement, and sees it: a 'local:<jobId>' feed row whose job is gone, with its
 * alerts (its scores and saves cascade). A scoring that comes later still fails on the missing row and announces
 * nothing (src/scan.ts scoreNewBid stores the score before any alert). A job row is never deleted except with its
 * poster's account (an operator's removal keeps it), so nothing else matches.
 */
async function sweepOrphanMirrors(db: Db): Promise<void> {
  await db.query(
    `with gone as (
       select b.id from bids b where b.source = 'local' and not exists (select 1 from jobs j where j.id = substr(b.id, 7))
     ), copies as (
       delete from bids where id in (select id from gone) returning id
     )
     delete from alerts where bid_id in (select id from gone)`,
  );
}

/** The operator's plan switch. Null when no account has that email. */
export async function setPlan(db: Db, email: string, plan: Plan): Promise<Account | null> {
  const rows = await db.query<AccountRow>(`update accounts set plan = $2 where email = $1 returning ${ACCOUNT_COLS}`, [email, plan]);
  return rows[0] ? toAccount(rows[0]) : null;
}

// --------------------------------------------------------- identities --

export async function findAccountByIdentity(db: Db, provider: string, subject: string): Promise<Account | null> {
  const rows = await db.query<AccountRow>(
    `select ${A_COLS} from identities i join accounts a on a.id = i.account_id
     where i.provider = $1 and i.subject = $2`,
    [provider, subject],
  );
  return rows[0] ? toAccount(rows[0]) : null;
}

/**
 * Attach a provider identity whose email is VERIFIED to the account that already has that email.
 *
 * A password account never proved it owns its address (sign-up sends no email), so it may have been
 * opened by someone else to lie in wait for the real owner. The first verified identity therefore
 * takes the account over: the unproven password, every open session and every push subscription
 * go, in the same statement. Supabase Auth links identities the same way ("Identity Linking" guide).
 * Returns true when a password was removed.
 */
export async function linkVerifiedIdentity(db: Db, provider: string, subject: string, accountId: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `with link as (
       insert into identities (provider, subject, account_id) values ($1, $2, $3)
       on conflict (provider, subject) do nothing
     ), unproven as (
       update accounts set password_hash = null where id = $3 and password_hash is not null returning id
     ), signed_out as (
       delete from sessions where account_id in (select id from unproven)
     ), unsubscribed as (
       delete from push_subscriptions where account_id in (select id from unproven)
     )
     select id from unproven`,
    [provider, subject, accountId],
  );
  return rows.length > 0;
}

// ----------------------------------------------------------- sessions --

export async function insertSession(db: Db, tokenHash: string, accountId: string, now: Date, expiresAt: Date): Promise<void> {
  await db.query('insert into sessions (token_hash, account_id, created_at, expires_at) values ($1, $2, $3, $4)', [
    tokenHash, accountId, now.toISOString(), expiresAt.toISOString(),
  ]);
}

/** The account behind a live session, and when the session runs out. */
export async function findSession(db: Db, tokenHash: string, now: Date): Promise<{ account: Account; expiresAt: Date } | null> {
  const rows = await db.query<AccountRow & { expires_at: Date | string }>(
    `select ${A_COLS}, s.expires_at from sessions s join accounts a on a.id = s.account_id
     where s.token_hash = $1 and s.expires_at > $2`,
    [tokenHash, now.toISOString()],
  );
  return rows[0] ? { account: toAccount(rows[0]), expiresAt: new Date(rows[0].expires_at) } : null;
}

export async function extendSession(db: Db, tokenHash: string, expiresAt: Date): Promise<void> {
  await db.query('update sessions set expires_at = $2 where token_hash = $1', [tokenHash, expiresAt.toISOString()]);
}

export async function deleteSession(db: Db, tokenHash: string): Promise<void> {
  await db.query('delete from sessions where token_hash = $1', [tokenHash]);
}

export async function deleteExpiredSessions(db: Db, now: Date): Promise<void> {
  await db.query('delete from sessions where expires_at <= $1', [now.toISOString()]);
}
