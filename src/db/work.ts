/** SQL for work profiles (table in schema-work.ts) and the few account facts a person's card needs. */
import { defaultWorkProfile, readStoredWorkProfile, type Intent, type WorkProfile } from '../profile/work.js';
import type { Db } from './db.js';

/** The account's work profile, or the defaults when it never saved one. */
export async function getWorkProfile(db: Db, accountId: string): Promise<WorkProfile> {
  return (await getWorkProfiles(db, [accountId])).get(accountId) ?? defaultWorkProfile();
}

/**
 * The work profiles of several accounts in ONE statement, by account id. An account that never saved one has
 * no entry (the caller uses defaultWorkProfile()).
 */
export async function getWorkProfiles(db: Db, accountIds: readonly string[]): Promise<Map<string, WorkProfile>> {
  const out = new Map<string, WorkProfile>();
  if (accountIds.length === 0) return out;
  const rows = await db.query<{ account_id: string; prefs: unknown }>(
    'select account_id, prefs from work_profiles where account_id = any($1::text[])', [[...new Set(accountIds)]],
  );
  for (const r of rows) out.set(r.account_id, readStoredWorkProfile(typeof r.prefs === 'string' ? JSON.parse(r.prefs) : r.prefs));
  return out;
}

/** Create or replace the account's work profile (already checked by validateWorkProfile). */
export async function saveWorkProfile(db: Db, accountId: string, wp: WorkProfile, now: Date): Promise<void> {
  await db.query(
    `insert into work_profiles (account_id, prefs, updated_at) values ($1, $2::jsonb, $3)
     on conflict (account_id) do update set prefs = excluded.prefs, updated_at = excluded.updated_at`,
    [accountId, JSON.stringify(wp), now.toISOString()],
  );
}

/** Change only "what brings you here", keeping everything else the account saved. */
export async function saveIntent(db: Db, accountId: string, intent: Intent, now: Date): Promise<WorkProfile> {
  const wp = { ...(await getWorkProfile(db, accountId)), intent };
  await saveWorkProfile(db, accountId, wp, now);
  return wp;
}

/** What a card needs from the account itself. Never the email. */
export interface CardFacts {
  /** The account's own name. */
  accountName: string | null;
  /** The name on its scoring profile (the business name from onboarding), when it has one. */
  businessName: string | null;
  /** When it joined (ISO). */
  createdAt: string;
}

/** The card facts of several accounts in ONE statement, by account id. An id with no account has no entry. */
export async function cardFactsFor(db: Db, accountIds: readonly string[]): Promise<Map<string, CardFacts>> {
  const out = new Map<string, CardFacts>();
  if (accountIds.length === 0) return out;
  const rows = await db.query<{ id: string; name: string | null; created_at: Date | string; business: string | null }>(
    `select a.id, a.name, a.created_at, p.name as business
       from accounts a left join profiles p on p.account_id = a.id
      where a.id = any($1::text[])`,
    [[...new Set(accountIds)]],
  );
  for (const r of rows) out.set(r.id, { accountName: r.name, businessName: r.business, createdAt: new Date(r.created_at).toISOString() });
  return out;
}
