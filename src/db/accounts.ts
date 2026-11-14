/** SQL for accounts, identities and sessions (tables in schema.ts). Owner: the auth builder. */
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

/** The same for a signed-in account, by id: what "type your password again" checks against. */
export async function findCredentialsById(db: Db, accountId: string): Promise<{ account: Account; passwordHash: string | null } | null> {
  const rows = await db.query<AccountRow & { password_hash: string | null }>(
    `select ${ACCOUNT_COLS}, password_hash from accounts where id = $1`, [accountId],
  );
  return rows[0] ? { account: toAccount(rows[0]), passwordHash: rows[0].password_hash } : null;
}

export async function setPasswordHash(db: Db, accountId: string, passwordHash: string): Promise<void> {
  await db.query('update accounts set password_hash = $2 where id = $1', [accountId, passwordHash]);
}

export async function recordLogin(db: Db, accountId: string, now: Date): Promise<void> {
  await db.query('update accounts set last_login_at = $2 where id = $1', [accountId, now.toISOString()]);
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

/** When a live session was opened (its sign-in), or null. */
export async function sessionStartedAt(db: Db, tokenHash: string, now: Date): Promise<Date | null> {
  const rows = await db.query<{ created_at: Date | string }>(
    'select created_at from sessions where token_hash = $1 and expires_at > $2', [tokenHash, now.toISOString()],
  );
  return rows[0] ? new Date(rows[0].created_at) : null;
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

// ----------------------------------------------------- password resets --

/** Live reset links one account may have at once, the new one included. Older ones go first. */
const MAX_LIVE_RESETS = 5;

/**
 * Store a new reset link for an account (only the token's hash). An earlier link of the account stays good:
 * were a new request to cancel it, anyone who knows the address could keep killing the link its owner is about
 * to open. Using one link ends all of them (useResetToken). The same statement sweeps out every link of
 * anybody's that has run out, and this account's oldest beyond MAX_LIVE_RESETS.
 */
export async function addResetToken(db: Db, accountId: string, tokenHash: string, now: Date, expiresAt: Date): Promise<void> {
  await db.query(
    `with old as (
       delete from password_resets
       where expires_at <= $3
          or (account_id = $2 and token_hash not in (
                select token_hash from password_resets where account_id = $2 and expires_at > $3
                order by created_at desc, token_hash limit $5))
     )
     insert into password_resets (token_hash, account_id, created_at, expires_at) values ($1, $2, $3, $4)`,
    [tokenHash, accountId, now.toISOString(), expiresAt.toISOString(), MAX_LIVE_RESETS - 1],
  );
}

/** Is this the hash of a reset link that has not been used and has not run out? (A read: the write below decides.) */
export async function isLiveResetToken(db: Db, tokenHash: string, now: Date): Promise<boolean> {
  const rows = await db.query(
    'select 1 from password_resets where token_hash = $1 and used_at is null and expires_at > $2', [tokenHash, now.toISOString()],
  );
  return rows.length > 0;
}

/**
 * Use a reset link: ONE statement marks it used, stores the new password hash, ends every session and push
 * subscription of the account (whoever knew the old password is signed out everywhere) and deletes the
 * account's other reset links. The link's state is in the WHERE, so of two requests with the same link exactly
 * one gets the account back; the other, like a link that ran out or was never ours, gets null and nothing is changed.
 */
export async function useResetToken(db: Db, tokenHash: string, passwordHash: string, now: Date): Promise<Account | null> {
  const rows = await db.query<AccountRow>(
    `with used as (
       update password_resets set used_at = $3
       where token_hash = $1 and used_at is null and expires_at > $3
       returning account_id
     ), changed as (
       update accounts set password_hash = $2 where id in (select account_id from used)
       returning ${ACCOUNT_COLS}
     ), signed_out as (
       delete from sessions where account_id in (select account_id from used)
     ), unsubscribed as (
       delete from push_subscriptions where account_id in (select account_id from used)
     ), other_links as (
       delete from password_resets where account_id in (select account_id from used) and token_hash <> $1
     )
     select ${ACCOUNT_COLS} from changed`,
    [tokenHash, passwordHash, now.toISOString()],
  );
  return rows[0] ? toAccount(rows[0]) : null;
}
