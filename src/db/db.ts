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
  sslNoVerify?: boolean;
}

export async function openDb(opts: OpenDbOptions = {}): Promise<Db> {
  const db = opts.url ? await openPostgres(opts.url, opts.sslNoVerify) : await openPglite(opts.dataDir);
  await db.exec(SCHEMA_SQL);
  return db;
}

async function openPglite(dataDir = resolve(process.cwd(), 'data/pglite')): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (!dataDir.startsWith('memory://')) mkdirSync(dataDir, { recursive: true });
  const pg = new PGlite(dataDir);
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
