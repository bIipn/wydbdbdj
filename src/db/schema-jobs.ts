/**
 * Tables for the job marketplace (jobs people post, bids on them, messages, no-show fees).
 * Its own file so that work can add tables without touching schema.ts, which appends this to SCHEMA_SQL.
 * Plain Postgres, idempotent (create … if not exists).
 */
export const JOBS_SCHEMA_SQL = /* sql */ ``;
