/**
 * Tables for work profiles (experience, licence, what someone is looking for).
 * Its own file so that work can add tables without touching schema.ts, which appends this to SCHEMA_SQL.
 * Plain Postgres, idempotent (create … if not exists).
 */
export const WORK_SCHEMA_SQL = /* sql */ `
-- One work profile per account: the WorkProfile object from src/profile/work.ts, checked before it is
-- stored. JSON, like profiles.prefs: the shape grows (more chips, more fields) without a migration.
-- Deleting the account deletes it.
create table if not exists work_profiles (
  account_id  text primary key references accounts(id) on delete cascade,
  prefs       jsonb not null,
  updated_at  timestamptz not null default now()
);
`;
