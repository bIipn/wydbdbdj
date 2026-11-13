/**
 * Promo-code tables. Kept in its own file so the accounts work can add its tables without touching
 * schema.ts; schema.ts appends this to SCHEMA_SQL. Plain Postgres, idempotent (create … if not exists).
 */
export const PROMO_SCHEMA_SQL = /* sql */ ``;
