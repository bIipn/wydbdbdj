/**
 * Tables for work profiles (experience, licence, what someone is looking for).
 * Its own file so that work can add tables without touching schema.ts, which appends this to SCHEMA_SQL.
 * Plain Postgres, idempotent (create … if not exists).
 */
export const WORK_SCHEMA_SQL = /* sql */ ``;
