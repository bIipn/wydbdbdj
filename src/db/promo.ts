/** SQL for promo-code redemptions (table in schema-promo.ts). Codes arrive here as keys (sha256 hex) only. */
import type { Plan } from '../types.js';
import type { Db } from './db.js';

export type RedeemOutcome =
  /** First redemption of this code by this account: the plan is set. */
  | 'redeemed'
  /** This account redeemed this code before: nothing new is counted; the plan is set again. */
  | 'again'
  /** The code already reached its limit of different accounts. */
  | 'used_up';

/**
 * Record a redemption and set the account's plan, in one statement:
 *   - a row this account already has for the code → 'again' (no new use counted);
 *   - otherwise the row goes in only while fewer than `maxUses` accounts have one → 'redeemed', else 'used_up'.
 * The plan is set only when a row exists for the account afterwards. On embedded PGlite statements run one at
 * a time, so the count cannot race; on a busy Postgres two last-seat redeems at the same instant could both
 * get in (one use over the limit) — acceptable for a free-Pro code, and cheaper than a lock.
 */
export async function redeemPromo(
  db: Db, r: { accountId: string; codeKey: string; plan: Plan; maxUses: number | null; now: Date },
): Promise<RedeemOutcome> {
  const rows = await db.query<{ had: boolean; added: boolean }>(
    `with had as (
       select 1 from promo_redemptions where account_id = $1 and code_key = $2
     ), added as (
       insert into promo_redemptions (account_id, code_key, plan, redeemed_at)
       select $1, $2, $3, $5
       where not exists (select 1 from had)
         and ($4::int is null or (select count(*) from promo_redemptions where code_key = $2) < $4::int)
       on conflict (account_id, code_key) do nothing
       returning 1
     ), upgraded as (
       update accounts set plan = $3
       where id = $1 and (exists (select 1 from had) or exists (select 1 from added))
     )
     select exists (select 1 from had) as had, exists (select 1 from added) as added`,
    [r.accountId, r.codeKey, r.plan, r.maxUses, r.now.toISOString()],
  );
  const { had, added } = rows[0]!;
  return had ? 'again' : added ? 'redeemed' : 'used_up';
}

/** How many different accounts redeemed a code (tests, and the operator's curiosity). */
export async function promoUses(db: Db, codeKey: string): Promise<number> {
  const rows = await db.query<{ n: string | number }>('select count(*) as n from promo_redemptions where code_key = $1', [codeKey]);
  return Number(rows[0]!.n);
}
