import { loadConfig, type AppConfig } from './context.js';
import { env } from './env.js';
import { openDb, type Db } from './db/db.js';
import { listProfiles } from './db/repo.js';
import { loadProfile } from './profiles.js';
import { scanSources } from './sources/groups.js';
import { selectSources } from './sources/index.js';
import { withCatalogLists } from './trades/catalog.js';
import type { Profile, Source, SourceContext } from './types.js';
import { createHttp } from './util/http.js';

/** Everything a server or CLI run needs, built from environment variables. */
export interface AppDeps {
  db: Db;
  config: AppConfig;
  /** The config profile (single mode). null in accounts mode, where profiles live in the database. */
  profile: Profile | null;
  /** Every source this deployment reads (the SOURCES setting, else all), unsliced: a full scan. */
  sources: Source[];
  /** One scan group's sources (src/sources/groups.ts), cut down to the SOURCES setting when it is set. Throws on an unknown group. */
  sourcesFor: (group: string) => Source[];
  makeCtx: () => SourceContext;
}

export async function buildDeps(config: AppConfig = loadConfig()): Promise<AppDeps> {
  const db = await openDb({ url: env('DATABASE_URL'), sslNoVerify: env('PG_SSL_NO_VERIFY') === '1' });
  const profile = config.authMode === 'single' ? loadProfile(env('PROFILE_ID') ?? 'lm-electric') : null;
  const contact = env('CONTACT_EMAIL');
  const http = createHttp({
    userAgent: `BidSwipe/0.1 (daily public-bid check${contact ? `; contact ${contact}` : ''})`,
  });
  return {
    db,
    config,
    profile,
    sources: selectSources(env('SOURCES')),
    sourcesFor: (group) => scanSources({ group, list: env('SOURCES') }),
    makeCtx: () => ({ http, now: new Date(), env, log: (m) => console.log(`[scan] ${m}`) }),
  };
}

/**
 * Who a scan scores for: the config profile, or (accounts mode) every stored profile, read when the
 * scan gets to scoring and brought up to the trade catalog's current keyword lists.
 */
export function scanProfiles(deps: Pick<AppDeps, 'db' | 'profile'>): Profile[] | (() => Promise<Profile[]>) {
  return deps.profile ? [deps.profile] : async () => (await listProfiles(deps.db)).map(withCatalogLists);
}
