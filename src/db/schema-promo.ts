/**
 * Promo-code tables. Kept in its own file so the accounts work can add its tables without touching
 * schema.ts; schema.ts appends this to SCHEMA_SQL. Plain Postgres, idempotent (create … if not exists).
 */
export const PROMO_SCHEMA_SQL = /* sql */ `
-- Who redeemed which promo code (src/auth/promo.ts, POST /api/promo/redeem). code_key is the sha256 of
-- the normalized code, never the code itself: a database dump does not hand out free Pro. One row per
-- account and code, so a code's use limit counts different accounts, and redeeming twice is harmless.
create table if not exists promo_redemptions (
  account_id   text not null references accounts(id) on delete cascade,
  code_key     text not null,
  plan         text not null,
  redeemed_at  timestamptz not null default now(),
  primary key (account_id, code_key)
);
create index if not exists promo_redemptions_code_idx on promo_redemptions (code_key);
-- How many uses each limited code has given (src/db/promo.ts redeemPromo). The row is the gate that keeps a
-- code inside its use limit when many accounts redeem it at the same instant: the UPDATE … where uses < limit
-- waits for the row lock and re-reads the newest count, which a count(*) in the same statement cannot do.
create table if not exists promo_codes (
  code_key  text primary key,
  uses      integer not null default 0
);
`;
