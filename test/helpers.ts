/**
 * Shared test helpers (v1). Bids come from the REAL pages in test/fixtures; everything made up here
 * is obviously synthetic: TEST- ids, example.com emails, "(simulated)" names.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import * as cheerio from 'cheerio';
import type { AuthService } from '../src/auth/index.js';
import { loadConfig, type AppConfig } from '../src/context.js';
import { openDb, type Db } from '../src/db/db.js';
import { SCHEMA_SQL } from '../src/db/schema.js';
import { loadProfile } from '../src/profiles.js';
import { finalizeBid } from '../src/scan.js';
import { FIXTURES_CAPTURED_AT } from '../src/sources/fixtures.js';
import { parseQuestJson, QUEST_BOARDS } from '../src/sources/questcdn.js';
import type { Account, Bid, BidDraft, Profile, Source, SourceContext } from '../src/types.js';

/** The fixtures were captured on 2026-11-11; this "now" is before their deadlines. */
export const NOW = new Date('2026-11-11T20:00:00Z');

export const fx = (file: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url)), 'utf8');

// ------------------------------------------------------------- database --

/**
 * Starting an empty PGlite takes 2–3 s of CPU (it runs initdb); cloning one from a dump takes ~0.6 s.
 * So the first memoryDb() for a given schema saves an empty database under node_modules/.cache and
 * every later one, in any test file or run, starts from that. The file name carries a hash of the
 * schema, so a schema change makes a new snapshot.
 */
const SNAPSHOT = fileURLToPath(new URL(
  `../node_modules/.cache/bidswipe/pglite-${createHash('sha1').update(SCHEMA_SQL).digest('hex').slice(0, 12)}.tgz`,
  import.meta.url,
));

async function emptySnapshot(): Promise<Blob | undefined> {
  try {
    if (!existsSync(SNAPSHOT)) {
      const pg = new PGlite('memory://');
      await pg.exec(SCHEMA_SQL);
      const dump = await pg.dumpDataDir('gzip');
      await pg.close();
      const dir = dirname(SNAPSHOT);
      mkdirSync(dir, { recursive: true });
      // Snapshots of older schemas are dead weight.
      for (const f of readdirSync(dir)) if (f.endsWith('.tgz') && join(dir, f) !== SNAPSHOT) rmSync(join(dir, f), { force: true });
      // Write then rename: a test file starting at the same moment sees a whole snapshot or none.
      const tmp = `${SNAPSHOT}.${process.pid}.tmp`;
      writeFileSync(tmp, Buffer.from(await dump.arrayBuffer()));
      renameSync(tmp, SNAPSHOT);
    }
    return new Blob([readFileSync(SNAPSHOT)]);
  } catch {
    return undefined; // no cache → every database starts the slow way
  }
}

/** Throwaway in-memory database with the full schema. Close it in afterAll. */
export async function memoryDb(): Promise<Db> {
  const loadDataDir = await emptySnapshot();
  if (loadDataDir) {
    try {
      return await openDb({ dataDir: 'memory://', loadDataDir });
    } catch {
      // unreadable snapshot: fall through to a fresh database
    }
  }
  return openDb({ dataDir: 'memory://' });
}

/** Empty every table (much faster than opening a new database for each test). */
export async function resetDb(db: Db): Promise<void> {
  await db.exec('truncate table bids, profiles, accounts, scans, awards, market_series, market_series_meta restart identity cascade');
}

/** A scan context that never touches the network. */
export function scanCtx(now: Date = NOW, log: (msg: string) => void = () => {}): SourceContext {
  return { http: { text: async () => '', json: async () => ({}) as never }, now, env: () => undefined, log };
}

/** The captured NV State Public Works board: 13 real bids. */
export function questSource(): Source {
  return { id: 'questcdn', name: 'q', homepage: '', fetch: async () => parseQuestJson(JSON.parse(fx('questcdn-spwd.json')), QUEST_BOARDS[0]!) };
}

/** AUTH_MODE=accounts with nothing else configured. */
export function accountsConfig(over: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({ AUTH_MODE: 'accounts' }), ...over };
}

/** A simulated business: the pilot's scoring profile under another id. Not a real company. */
export function testProfile(id: string, over: Partial<Profile> = {}): Profile {
  return { ...structuredClone(loadProfile('lm-electric')), id, name: `TEST ${id} (simulated)`, ...over };
}

let accountSeq = 0;

/** Insert a simulated account row (the real account SQL lives in src/db/accounts.ts). */
export async function seedAccount(db: Db, over: Partial<Account> = {}): Promise<Account> {
  const n = ++accountSeq;
  const a = { id: `TEST-acct-${n}`, email: `test${n}@example.com`, name: `TEST Person ${n} (simulated)`, plan: 'free' as const, ...over };
  const rows = await db.query<{ created_at: Date | string }>(
    'insert into accounts (id, email, name, plan) values ($1, $2, $3, $4) returning created_at',
    [a.id, a.email, a.name, a.plan],
  );
  return { ...a, createdAt: new Date(rows[0]!.created_at).toISOString() };
}

/** An AuthService that is "signed in" as whatever `current()` returns (null = signed out). */
export function fakeAuth(current: Account | null | (() => Account | null)): AuthService {
  return { authenticate: async () => (typeof current === 'function' ? current() : current) };
}

let bidSeq = 0;

/** A synthetic bid (id "samgov:TEST-…", example.com link). Electrical, in Carson City, due in 3 weeks unless overridden. */
export function testBid(over: Partial<BidDraft> = {}): Bid {
  return finalizeBid({
    source: 'samgov', sourceId: `TEST-${++bidSeq}`, sourceName: 'TEST source', title: 'TEST electrical panel upgrade (synthetic)',
    agency: 'TEST agency', description: null, category: null, location: { city: 'Carson City', state: 'NV' }, postedAt: null,
    dueAt: '2026-12-02T22:00:00.000Z', estValue: null, naics: null, setAside: null, url: 'https://example.com/test-bid',
    ...over,
  });
}

// ------------------------------------------------- source pages (raw HTML) --

export const FIXTURE_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));

/** The day the HTML fixtures were fetched (2026-11-13, noon Pacific). */
export const CAPTURED = FIXTURES_CAPTURED_AT;

/** Change a fixture in memory with cheerio and hand back the HTML. */
export function edit(html: string, change: ($: cheerio.CheerioAPI) => void): string {
  const $ = cheerio.load(html);
  change($);
  return $.html();
}

/** A scan context whose "network" answers every request with `html`; collects the log lines. */
export function fakeCtx(html: string, now = CAPTURED): { ctx: SourceContext; logs: string[] } {
  const logs: string[] = [];
  const ctx: SourceContext = {
    http: { text: async () => html, json: async () => ({}) as never },
    now,
    env: () => undefined,
    log: (msg) => logs.push(msg),
  };
  return { ctx, logs };
}

// ------------------------------------------------------------------- NGEM --

export const NGEM_GRID = 'table.rgMasterTable';

/** __doPostBack target of the pager's "Go to Page n" link (pages 1–3 are ctl05–ctl07 on the live board). */
export const ngemTarget = (n: number) => `ctl00$mainContent$rgBidList$ctl00$ctl03$ctl01$ctl0${4 + n}`;

const NGEM_COLUMNS = ['', 'colBidNumber', 'colTitle', 'colTypeTitle', 'colWorkGroupName', 'colOpenDate', 'colCloseDate'];

/**
 * An NGEM page the way a browser's "save as" leaves it (the shape of the retired 2026-11-11 fixture):
 * page JavaScript has named the header cells with aria-label, dropped the sort handlers, and turned
 * the postback pager into plain "…ChangePage=2_20" links. The rows are untouched.
 */
export function browserSavedNgem(html: string): string {
  return edit(html, ($) => {
    $(`${NGEM_GRID} thead tr`).first().children('th').each((i, th) => {
      if (NGEM_COLUMNS[i]) $(th).attr('aria-label', NGEM_COLUMNS[i]);
      $(th).find('a').removeAttr('onclick').removeAttr('href');
    });
    $(`${NGEM_GRID} .rgNumPart a`).each((_, a) => {
      const link = $(a).removeAttr('onclick');
      if (link.hasClass('rgCurrentPage')) link.removeAttr('href');
      else link.attr('href', `https://nevada.ionwave.net/SourcingEvents.aspx?SourceType=1&ctl00_mainContent_rgBidListChangePage=${link.text()}_20`);
    });
  });
}
