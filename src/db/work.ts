/** SQL for work profiles (table in schema-work.ts) and the few account facts a person's card needs. */
import { defaultWorkProfile, readStoredWorkProfile, type Intent, type WorkProfile } from '../profile/work.js';
import type { Db } from './db.js';

/** The account's work profile, or the defaults when it never saved one. */
export async function getWorkProfile(db: Db, accountId: string): Promise<WorkProfile> {
  const rows = await db.query<{ prefs: unknown }>('select prefs from work_profiles where account_id = $1', [accountId]);
  if (!rows[0]) return defaultWorkProfile();
  const prefs = typeof rows[0].prefs === 'string' ? JSON.parse(rows[0].prefs) : rows[0].prefs;
  return readStoredWorkProfile(prefs);
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

/**
 * What a card needs from the account itself: its own name, when it joined, and the name on its scoring profile
 * (the business name from onboarding). Never the email. Null when there is no such account.
 */
export async function cardFacts(db: Db, accountId: string): Promise<{ accountName: string | null; businessName: string | null; createdAt: string } | null> {
  const rows = await db.query<{ name: string | null; created_at: Date | string; business: string | null }>(
    `select a.name, a.created_at, p.name as business
       from accounts a left join profiles p on p.account_id = a.id
      where a.id = $1`,
    [accountId],
  );
  const r = rows[0];
  return r ? { accountName: r.name, businessName: r.business, createdAt: new Date(r.created_at).toISOString() } : null;
}
