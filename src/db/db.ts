import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCHEMA_SQL } from './schema.js';

/** The tiny slice of a Postgres client we use, so PGlite and node-postgres look the same. */
export interface Db {
  kind: 'pglite' | 'postgres';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export interface OpenDbOptions {
  /** Postgres connection string (Supabase etc). If absent, uses embedded PGlite. */
  url?: string;
  /** PGlite storage directory. "memory://" for throwaway (tests). */
  dataDir?: string;
  /** PGlite only: start from a data-directory dump (PGlite's dumpDataDir) instead of an empty cluster. */
  loadDataDir?: Blob;
  sslNoVerify?: boolean;
}

/** Any fixed number: the advisory-lock key every instance takes before it runs the schema. */
const SCHEMA_LOCK = 4217001;

export async function openDb(opts: OpenDbOptions = {}): Promise<Db> {
  const db = opts.url ? await openPostgres(opts.url, opts.sslNoVerify) : await openPglite(opts.dataDir, opts.loadDataDir);
  // Two server instances can start at the same moment (serverless cold starts). The schema is
  // idempotent, but two sessions running its ALTER TABLEs together can deadlock or fail with
  // "tuple concurrently updated", and that instance would crash on its first request. The lock makes
  // the second wait for the first. It is held for the transaction, and the whole statement batch is
  // one implicit transaction, so it is released when the schema is done. The embedded database has a
  // single connection: nothing to wait for.
  await db.exec(db.kind === 'postgres' ? `select pg_advisory_xact_lock(${SCHEMA_LOCK});\n${SCHEMA_SQL}` : SCHEMA_SQL);
  return db;
}

/** The embedded database folder: DATA_DIR when set (a second server or a test run), else ./data/pglite. */
function defaultDataDir(): string {
  return resolve(process.cwd(), process.env.DATA_DIR?.trim() || 'data/pglite');
}

async function openPglite(dataDir = defaultDataDir(), loadDataDir?: Blob): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (!dataDir.startsWith('memory://')) mkdirSync(dataDir, { recursive: true });
  const pg = new PGlite(dataDir, { loadDataDir });
  await pg.waitReady;
  return {
    kind: 'pglite',
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pg.query<T>(sql, params as never[]);
      return res.rows;
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async close() {
      await pg.close();
    },
  };
}

async function openPostgres(url: string, sslNoVerify?: boolean): Promise<Db> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    ssl: sslNoVerify ? { rejectUnauthorized: false } : undefined,
  });
  // An idle pooled connection can be closed by the server or a pooler. Without a listener node-postgres
  // raises that as an unhandled 'error' event and the process dies; the pool replaces the client itself.
  pool.on('error', (err) => console.error(`[db] idle connection dropped: ${err.message}`));
  return {
    kind: 'postgres',
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return res.rows as T[];
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
}
