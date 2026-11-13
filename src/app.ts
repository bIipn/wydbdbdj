import { env } from './env.js';
import { openDb, type Db } from './db/db.js';
import { loadProfile } from './profiles.js';
import { selectSources } from './sources/index.js';
import type { Profile, Source, SourceContext } from './types.js';
import { createHttp } from './util/http.js';

/** Everything a server or CLI run needs, built from environment variables. */
export interface AppDeps {
  db: Db;
  profile: Profile;
  sources: Source[];
  makeCtx: () => SourceContext;
}

export async function buildDeps(): Promise<AppDeps> {
  const db = await openDb({ url: env('DATABASE_URL'), sslNoVerify: env('PG_SSL_NO_VERIFY') === '1' });
  const profile = loadProfile(env('PROFILE_ID') ?? 'lm-electric');
  const contact = env('CONTACT_EMAIL');
  const http = createHttp({
    userAgent: `BidSwipe/0.1 (daily public-bid check${contact ? `; contact ${contact}` : ''})`,
  });
  return {
    db,
    profile,
    sources: selectSources(env('SOURCES')),
    makeCtx: () => ({ http, now: new Date(), env, log: (m) => console.log(`[scan] ${m}`) }),
  };
}
