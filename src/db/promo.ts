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
 * Record a redemption and set the account's plan:
 *   - a row this account already has for the code → 'again' (no new use counted);
 *   - otherwise, for a code with a use limit, the gate row in promo_codes is bumped only while uses < maxUses, and
 *     the redemption goes in only when the gate let it through → 'redeemed', else 'used_up';
 *   - a code with no limit skips the gate.
 * The plan is set only when a row exists for the account afterwards.
 *
 * Why a gate row: on Postgres (READ COMMITTED, a pool of connections, many instances) a `count(*) < maxUses` check
 * inside the INSERT reads the statement's snapshot, so N redeems arriving together all saw the same count and up to
 * the pool size got in (4 accounts on a 1-use code, audit sec-session-4). Taking an advisory lock inside the same
 * statement does not help either: the snapshot is older than the lock. An UPDATE … where uses < $limit waits for the
 * row lock and then re-checks its WHERE against the newest row, so exactly maxUses redeems pass.
 *
 * Two statements: the gate row is created first (insert … on conflict do nothing; it starts at the uses already
 * recorded, for codes redeemed before the gate existed), then the gated redemption, in one statement.
 */
export async function redeemPromo(
  db: Db, r: { accountId: string; codeKey: string; plan: Plan; maxUses: number | null; now: Date },
): Promise<RedeemOutcome> {
  if (r.maxUses !== null) {
    await db.query(
      `insert into promo_codes (code_key, uses)
       select $1, (select count(*) from promo_redemptions where code_key = $1)
       on conflict (code_key) do nothing`,
      [r.codeKey],
    );
  }
  const rows = await db.query<{ had: boolean; added: boolean }>(
    `with had as (
       select 1 from promo_redemptions where account_id = $1 and code_key = $2
     ), gate as (
       update promo_codes set uses = uses + 1
       where $4::int is not null and code_key = $2 and uses < $4::int and not exists (select 1 from had)
       returning 1
     ), added as (
       insert into promo_redemptions (account_id, code_key, plan, redeemed_at)
       select $1, $2, $3, $5
       where not exists (select 1 from had)
         and ($4::int is null or exists (select 1 from gate))
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
