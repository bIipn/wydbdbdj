import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db.js';

/**
 * Needs a real Postgres, so it only runs when TEST_DATABASE_URL names a throwaway database:
 *   TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/scratch npx vitest run test/pg-startup.test.ts
 * The embedded database (every other test) has one connection and cannot show this race.
 *
 * Twelve server instances start at the same moment against the same database. Without the advisory
 * lock in openDb, 11 of 12 failed on an empty database ("duplicate key value violates unique
 * constraint pg_type_typname_nsp_index"): measured 2026-11-13 on Postgres 16, three runs of three.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Postgres start-up (TEST_DATABASE_URL)', () => {
  it('twelve instances can run the schema at once', async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => openDb({ url })));
    const failed = results.filter((r) => r.status === 'rejected');
    for (const r of results) if (r.status === 'fulfilled') await r.value.close();
    expect(failed.map((f) => String((f as PromiseRejectedResult).reason))).toEqual([]);
  }, 60_000);
});
