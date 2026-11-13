import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Db } from '../src/db/db.js';
import { SCHEMA_SQL } from '../src/db/schema.js';
import { memoryDb, seedAccount, testProfile } from './helpers.js';

const V1_TABLES = ['accounts', 'identities', 'sessions', 'push_subscriptions', 'alerts', 'awards', 'market_series', 'market_series_meta', 'estimates'];

let db: Db;
beforeAll(async () => {
  db = await memoryDb();
});
afterAll(async () => db.close());

const columns = async (table: string) =>
  (await db.query<{ column_name: string }>('select column_name from information_schema.columns where table_name = $1', [table])).map((r) => r.column_name);

describe('schema', () => {
  it('is idempotent: running it again on a live database changes nothing and does not fail', async () => {
    await db.exec(SCHEMA_SQL);
    await db.exec(SCHEMA_SQL);
    const tables = (await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public'")).map((r) => r.table_name);
    expect(tables).toEqual(expect.arrayContaining(['bids', 'profiles', 'matches', 'swipes', 'scans', ...V1_TABLES]));
  });

  it('adds the v1 columns', async () => {
    expect(await columns('profiles')).toContain('account_id');
    expect(await columns('bids')).toContain('sol_number');
    expect(await columns('matches')).toContain('over_limit');
    expect(await columns('accounts')).toEqual(expect.arrayContaining(['id', 'email', 'name', 'password_hash', 'plan', 'created_at', 'last_login_at']));
    expect(await columns('alerts')).toEqual(expect.arrayContaining(['profile_id', 'kind', 'bid_id', 'dedupe_key', 'title', 'body', 'data', 'pushed_at', 'read_at']));
    expect(await columns('awards')).toEqual(expect.arrayContaining(['award_id', 'sol_number', 'recipient', 'amount', 'action_date', 'naics', 'psc', 'lat', 'lng', 'fetched_at']));
    expect(await columns('market_series_meta')).toEqual(expect.arrayContaining(['series_id', 'kind', 'title', 'area', 'unit', 'source', 'source_url']));
    expect(await columns('estimates')).toEqual(expect.arrayContaining(['profile_id', 'bid_id', 'inputs', 'result']));
  });

  it('upgrades a v0 database in place and keeps its rows', async () => {
    // What the pilot's database looks like today: only the v0 tables, with data in them.
    const v0 = SCHEMA_SQL.split(/^-- -+ v1 --$/m)[0]!;
    expect(v0).not.toContain('accounts');
    const pg = new PGlite('memory://');
    try {
      await pg.exec(v0);
      await pg.query("insert into profiles (id, name, prefs) values ('test-v0', 'TEST v0 (simulated)', '{}'::jsonb)");
      await pg.query("insert into bids (id, source, source_id, source_name, title, url) values ('samgov:TEST-v0', 'samgov', 'TEST-v0', 'TEST', 'TEST bid', 'https://example.com')");
      await pg.query("insert into matches (profile_id, bid_id, score, verdict, reasons) values ('test-v0', 'samgov:TEST-v0', 80, 'great', '[]'::jsonb)");
      await pg.exec(SCHEMA_SQL);
      await pg.exec(SCHEMA_SQL);
      const m = await pg.query<{ score: number; over_limit: boolean }>('select score, over_limit from matches');
      expect(m.rows).toEqual([{ score: 80, over_limit: false }]);
      const p = await pg.query<{ id: string; account_id: string | null }>('select id, account_id from profiles');
      expect(p.rows).toEqual([{ id: 'test-v0', account_id: null }]);
      expect((await pg.query<{ sol_number: string | null }>('select sol_number from bids')).rows).toEqual([{ sol_number: null }]);
    } finally {
      await pg.close();
    }
  });

  it('one profile per account, any number of config profiles, and deleting an account takes its data with it', async () => {
    const a = await seedAccount(db);
    const insert = (id: string, accountId: string | null) =>
      db.query('insert into profiles (id, name, prefs, account_id) values ($1, $1, $2::jsonb, $3)', [id, JSON.stringify(testProfile(id)), accountId]);
    await insert('test-schema-a', a.id);
    await expect(insert('test-schema-a2', a.id)).rejects.toThrow(/profiles_account_idx|unique/i);
    await insert('test-schema-config-1', null);
    await insert('test-schema-config-2', null);

    await db.query("insert into sessions (token_hash, account_id, expires_at) values ('TEST-hash', $1, now() + interval '1 day')", [a.id]);
    await db.query("insert into push_subscriptions (endpoint, account_id, keys) values ('https://example.com/push/TEST', $1, '{}'::jsonb)", [a.id]);
    await db.query("insert into estimates (profile_id, inputs, result) values ('test-schema-a', '{}'::jsonb, '{}'::jsonb)");
    await db.query('delete from accounts where id = $1', [a.id]);
    for (const table of ['sessions', 'push_subscriptions', 'estimates']) {
      expect(await db.query(`select 1 from ${table}`), table).toHaveLength(0);
    }
    expect((await db.query<{ id: string }>("select id from profiles where id like 'test-schema-%' order by id")).map((r) => r.id)).toEqual(['test-schema-config-1', 'test-schema-config-2']);
  });

  it('an alert is stored once per (profile, kind, dedupe key)', async () => {
    const add = (kind: string, key: string) =>
      db.query(
        `insert into alerts (profile_id, kind, dedupe_key, title, body) values ('test-schema-config-1', $1, $2, 'TEST', 'TEST')
         on conflict (profile_id, kind, dedupe_key) do nothing returning id`,
        [kind, key],
      );
    expect(await add('match', 'samgov:TEST-1')).toHaveLength(1);
    expect(await add('match', 'samgov:TEST-1')).toHaveLength(0);
    expect(await add('deadline', 'samgov:TEST-1')).toHaveLength(1);
    expect(await add('match', 'samgov:TEST-2')).toHaveLength(1);
  });
});
