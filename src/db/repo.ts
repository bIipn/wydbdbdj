import type { Bid, FeedItem, Profile, Reason, ScoreResult, SourceId, SwipeAction, Verdict } from '../types.js';
import type { Db } from './db.js';

// --------------------------------------------------------------- bids --

const BID_COLS = [
  'id', 'source', 'source_id', 'source_name', 'title', 'agency', 'description', 'category', 'city', 'county', 'state',
  'zip', 'lat', 'lng', 'loc_precision', 'loc_label', 'posted_at', 'due_at', 'est_min', 'est_max', 'naics', 'set_aside',
  'url', 'flags', 'sol_number', 'last_seen_at',
] as const;

function bidParams(b: Bid, seenAt: Date): unknown[] {
  return [
    b.id, b.source, b.sourceId, b.sourceName, b.title, b.agency, b.description, b.category,
    b.location.city, b.location.county, b.location.state, b.location.zip, b.location.lat, b.location.lng,
    b.location.precision, b.location.label, b.postedAt, b.dueAt, b.estValue?.min ?? null, b.estValue?.max ?? null,
    b.naics, b.setAside, b.url, JSON.stringify(b.flags), b.solNumber ?? null, seenAt.toISOString(),
  ];
}

/**
 * Rows per statement for the multi-row writes below. A few hundred keeps each statement well under
 * Postgres' 65,535-parameter limit (bids: 26 columns x 250 = 6,500) while turning thousands of round
 * trips into a handful. The same SQL runs on PGlite and on node-postgres.
 */
export const BID_BATCH = 250;
export const MATCH_BATCH = 500;

/** "($1, $2::jsonb, ...), ($27, ...)" for `rows` rows of `cols` columns; `cast(i)` adds a cast to column i. */
function valuesList(rows: number, cols: number, cast: (i: number) => string = () => ''): string {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) cells.push(`$${r * cols + c + 1}${cast(c)}`);
    out.push(`(${cells.join(', ')})`);
  }
  return out.join(', ');
}

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/**
 * Insert new bids, refresh existing ones, BID_BATCH rows per statement. Returns the ids that were brand new.
 * Ids must be unique within one statement (Postgres refuses to update one row twice in it), so a
 * repeated id keeps its last version.
 */
export async function upsertBids(db: Db, bids: Bid[], seenAt = new Date()): Promise<Set<string>> {
  const fresh = new Set<string>();
  const unique = [...new Map(bids.map((b) => [b.id, b])).values()];
  const flagsCol = BID_COLS.indexOf('flags');
  const updates = BID_COLS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
  for (const batch of chunks(unique, BID_BATCH)) {
    const rows = await db.query<{ id: string; inserted: boolean }>(
      `insert into bids (${BID_COLS.join(', ')}) values ${valuesList(batch.length, BID_COLS.length, (c) => (c === flagsCol ? '::jsonb' : ''))}
       on conflict (id) do update set ${updates}
       returning id, (xmax = 0) as inserted`,
      batch.flatMap((b) => bidParams(b, seenAt)),
    );
    for (const r of rows) if (r.inserted) fresh.add(r.id);
  }
  return fresh;
}

/**
 * Store a config-file profile (single mode / the scan). A profile an account owns is left alone:
 * the account's own saves (saveProfileForAccount) are the only thing that may change it.
 */
export async function upsertProfile(db: Db, p: Profile): Promise<void> {
  await db.query(
    `insert into profiles (id, name, prefs) values ($1, $2, $3::jsonb)
     on conflict (id) do update set name = excluded.name, prefs = excluded.prefs, updated_at = now()
       where profiles.account_id is null`,
    [p.id, p.name, JSON.stringify(p)],
  );
}

const MATCH_COLS = ['profile_id', 'bid_id', 'score', 'verdict', 'reasons', 'distance_mi', 'over_limit'] as const;
/** Casts on the first VALUES row's types: a VALUES list is typed before the insert sees it. */
const MATCH_CASTS: Record<number, string> = { 2: '::integer', 4: '::jsonb', 5: '::double precision', 6: '::boolean' };

export async function upsertMatch(db: Db, profileId: string, bidId: string, s: ScoreResult): Promise<void> {
  await upsertMatches(db, profileId, [{ bidId, score: s }]);
}

/** Store one profile's scores, MATCH_BATCH rows per statement. A bid id listed twice keeps its last score. */
export async function upsertMatches(db: Db, profileId: string, scored: ReadonlyArray<{ bidId: string; score: ScoreResult }>): Promise<void> {
  const unique = [...new Map(scored.map((x) => [x.bidId, x])).values()];
  for (const batch of chunks(unique, MATCH_BATCH)) {
    await db.query(
      `insert into matches (${MATCH_COLS.join(', ')}, scored_at)
       select v.*, now() from (values ${valuesList(batch.length, MATCH_COLS.length, (c) => MATCH_CASTS[c] ?? '')}) as v (${MATCH_COLS.join(', ')})
       on conflict (profile_id, bid_id) do update set
         score = excluded.score, verdict = excluded.verdict, reasons = excluded.reasons,
         distance_mi = excluded.distance_mi, over_limit = excluded.over_limit, scored_at = excluded.scored_at`,
      batch.flatMap(({ bidId, score: s }) => [profileId, bidId, s.score, s.verdict, JSON.stringify(s.reasons), s.distanceMi, s.overLimit]),
    );
  }
}

/**
 * Take back a profile's stored scores for open bids that are no longer its candidates (it moved, or narrowed
 * its range): they would otherwise sit in Browse with a score from the old settings. Kept: anything the
 * company swiped (Saved must not lose a bid), closed bids (the feed already hides them), and bids the digest
 * already emailed (notified_at): deleting those would forget the "sent" mark, so moving back would email the
 * same bid again, and the email's link would open nothing.
 * Returns how many rows went.
 */
export async function pruneMatches(db: Db, profileId: string, candidateIds: readonly string[], now: Date): Promise<number> {
  const rows = await db.query<{ bid_id: string }>(
    `delete from matches m
     using bids b
     where m.profile_id = $1 and b.id = m.bid_id
       and (b.due_at is null or b.due_at > $2)
       and not (m.bid_id = any ($3::text[]))
       and not exists (select 1 from swipes s where s.profile_id = m.profile_id and s.bid_id = m.bid_id)
       and m.notified_at is null
     returning m.bid_id`,
    [profileId, now.toISOString(), [...candidateIds]],
  );
  return rows.length;
}

// --------------------------------------------------------------- feed --

interface BidRow {
  id: string; source: Bid['source']; source_id: string; source_name: string; title: string; agency: string | null;
  description: string | null; category: string | null; city: string | null; county: string | null; state: string | null;
  zip: string | null; lat: number | null; lng: number | null; loc_precision: Bid['location']['precision'];
  loc_label: string | null; posted_at: Date | string | null; due_at: Date | string | null; est_min: string | number | null;
  est_max: string | number | null; naics: string | null; set_aside: string | null; url: string; flags: string[] | string;
  sol_number: string | null; first_seen_at: Date | string;
}

interface FeedRow extends BidRow {
  score: number; verdict: Verdict; reasons: Reason[] | string; distance_mi: number | null; over_limit: boolean;
  action: SwipeAction | null;
}

const iso = (v: Date | string | null): string | null => (v == null ? null : new Date(v).toISOString());
const num = (v: string | number | null): number | null => (v == null ? null : Number(v));
const json = <T>(v: T | string): T => (typeof v === 'string' ? (JSON.parse(v) as T) : v);

function toBid(r: BidRow): Bid {
  const estMin = num(r.est_min);
  const estMax = num(r.est_max);
  return {
    id: r.id, source: r.source, sourceId: r.source_id, sourceName: r.source_name, title: r.title, agency: r.agency,
    description: r.description, category: r.category,
    location: {
      city: r.city, county: r.county, state: r.state, zip: r.zip, lat: r.lat, lng: r.lng,
      precision: r.loc_precision, label: r.loc_label,
    },
    postedAt: iso(r.posted_at), dueAt: iso(r.due_at),
    estValue: estMin == null && estMax == null ? null : { min: estMin, max: estMax },
    naics: r.naics, setAside: r.set_aside, url: r.url, flags: json(r.flags), solNumber: r.sol_number,
  };
}

function toFeedItem(r: FeedRow): FeedItem {
  return {
    ...toBid(r),
    score: r.score, verdict: r.verdict, reasons: json(r.reasons), distanceMi: r.distance_mi == null ? null : Number(r.distance_mi),
    swipe: r.action, firstSeenAt: iso(r.first_seen_at)!, overLimit: r.over_limit,
  };
}

/** Every bid still open at `now` (no deadline, or a deadline in the future). */
export async function getOpenBids(db: Db, now: Date): Promise<Bid[]> {
  const rows = await db.query<BidRow>('select * from bids where due_at is null or due_at > $1 order by id', [now.toISOString()]);
  return rows.map(toBid);
}

/** Several stored bids by id, BID_BATCH ids per query. Ids not stored are simply absent from the map. */
export async function getBids(db: Db, ids: readonly string[]): Promise<Map<string, Bid>> {
  const out = new Map<string, Bid>();
  for (const batch of chunks([...new Set(ids)], BID_BATCH * 4)) {
    const rows = await db.query<BidRow>('select * from bids where id = any ($1::text[])', [batch]);
    for (const r of rows) out.set(r.id, toBid(r));
  }
  return out;
}

export async function getBid(db: Db, bidId: string): Promise<Bid | null> {
  const rows = await db.query<BidRow>('select * from bids where id = $1', [bidId]);
  return rows[0] ? toBid(rows[0]) : null;
}

const FEED_SELECT = `
  select b.*, m.score, m.verdict, m.reasons, m.distance_mi, m.over_limit, s.action
  from matches m
  join bids b on b.id = m.bid_id
  left join swipes s on s.profile_id = m.profile_id and s.bid_id = m.bid_id`;

export type FeedSort = 'fit' | 'due' | 'near' | 'new' | 'value';

export interface FeedQuery {
  minScore?: number;
  limit?: number;
  /** Include bids already swiped (for the Browse list). */
  includeSwiped?: boolean;
  /** Leave out bids over the profile's spend limits (the swipe deck never shows them). */
  hideOverLimit?: boolean;
  /** Same idea with a third choice, 'only' (just the over-limit bids). Wins over hideOverLimit when set. */
  overLimit?: 'include' | 'exclude' | 'only';
  /** Search words. Every word must appear in the title, agency, description, category, place or bid number; case does not matter. */
  q?: string;
  /** Dollars. Keeps bids whose estimate range overlaps [minValue, maxValue]; either end may be left open. */
  minValue?: number;
  maxValue?: number;
  /** Drop bids with no estimate. Without it they are kept, whatever minValue / maxValue say. */
  hasValue?: boolean;
  /** Miles from the profile's base. Bids whose distance is unknown are dropped. */
  maxDistance?: number;
  /** Deadline no later than this many days from `now`. Bids with no deadline are dropped. */
  dueWithinDays?: number;
  sources?: SourceId[];
  verdicts?: Verdict[];
  /** Default 'fit'. */
  sort?: FeedSort;
  now?: Date;
}

/** Fixed ORDER BY clauses: nothing from a request is ever put into the SQL text. */
const FEED_ORDER: Record<FeedSort, string> = {
  fit: 'm.score desc, b.due_at asc nulls last, b.first_seen_at desc', // best fit, then soonest deadline
  due: 'b.due_at asc nulls last, m.score desc', // soonest deadline; "no deadline" last
  near: 'm.distance_mi asc nulls last, m.score desc', // closest; unknown distance last
  new: 'coalesce(b.posted_at, b.first_seen_at) desc, m.score desc', // newest posting (or first sighting when the board gives no date)
  value: 'coalesce(b.est_max, b.est_min) desc nulls last, m.score desc', // biggest estimate; "not listed" last
};

/**
 * What the search box looks through. category and loc_label are there because a board often says
 * "Electrical" or "Sparks, NV" only in those; source_id is the board's own number, for bids with no
 * solicitation number.
 */
const FEED_SEARCH_TEXT = `concat_ws(' ', b.title, b.agency, b.description, b.category, b.loc_label, b.sol_number, b.source_id)`;

/** Search words → ILIKE patterns, with LIKE's own wildcards (% _ \) in the user's text made literal. */
function searchPatterns(q: string | undefined): string[] {
  return (q ?? '').split(/\s+/).filter(Boolean).map((word) => `%${word.replace(/[\\%_]/g, '\\$&')}%`);
}

/**
 * Open bids for one profile, filtered and sorted in SQL. The defaults are the swipe deck's:
 * score ≥ 35, not yet swiped, best fit first, 100 at most.
 */
export async function getFeed(db: Db, profileId: string, q: FeedQuery = {}): Promise<FeedItem[]> {
  const now = q.now ?? new Date();
  const dueBy = q.dueWithinDays == null ? null : new Date(now.getTime() + q.dueWithinDays * 86_400_000).toISOString();
  const rows = await db.query<FeedRow>(
    `${FEED_SELECT}
     where m.profile_id = $1
       and m.score >= $2
       and (b.due_at is null or b.due_at > $3)
       and ($4::boolean or s.action is null)
       and ($5::text = 'include' or m.over_limit = ($5::text = 'only'))
       and ${FEED_SEARCH_TEXT} ilike all ($6::text[])
       and case when b.est_min is null and b.est_max is null then not $7::boolean
                else ($8::numeric is null or b.est_max is null or b.est_max >= $8::numeric)
                 and ($9::numeric is null or b.est_min is null or b.est_min <= $9::numeric) end
       and ($10::double precision is null or m.distance_mi <= $10::double precision)
       and ($11::timestamptz is null or b.due_at <= $11::timestamptz)
       and ($12::text[] is null or b.source = any ($12::text[]))
       and ($13::text[] is null or m.verdict = any ($13::text[]))
     order by ${FEED_ORDER[q.sort ?? 'fit']}, b.id
     limit $14`,
    [
      profileId, q.minScore ?? 35, now.toISOString(), q.includeSwiped ?? false,
      q.overLimit ?? (q.hideOverLimit ? 'exclude' : 'include'), searchPatterns(q.q),
      q.hasValue ?? false, q.minValue ?? null, q.maxValue ?? null, q.maxDistance ?? null, dueBy,
      q.sources?.length ? q.sources : null, q.verdicts?.length ? q.verdicts : null, q.limit ?? 100,
    ],
  );
  return rows.map(toFeedItem);
}

export async function getSaved(db: Db, profileId: string): Promise<FeedItem[]> {
  const rows = await db.query<FeedRow>(
    `${FEED_SELECT}
     where m.profile_id = $1 and s.action in ('save', 'bid')
     order by b.due_at asc nulls last`,
    [profileId],
  );
  return rows.map(toFeedItem);
}

export async function getItem(db: Db, profileId: string, bidId: string): Promise<FeedItem | null> {
  const rows = await db.query<FeedRow>(`${FEED_SELECT} where m.profile_id = $1 and b.id = $2`, [profileId, bidId]);
  return rows[0] ? toFeedItem(rows[0]) : null;
}

export async function recordSwipe(db: Db, profileId: string, bidId: string, action: SwipeAction): Promise<boolean> {
  const rows = await db.query(
    `insert into swipes (profile_id, bid_id, action)
     select $1, $2, $3 where exists (select 1 from matches where profile_id = $1 and bid_id = $2)
     on conflict (profile_id, bid_id) do update set action = excluded.action, created_at = now()
     returning bid_id`,
    [profileId, bidId, action],
  );
  return rows.length > 0;
}

export async function undoSwipe(db: Db, profileId: string, bidId: string): Promise<void> {
  await db.query('delete from swipes where profile_id = $1 and bid_id = $2', [profileId, bidId]);
}

// ------------------------------------------------------------ digest --

export async function getUnnotified(db: Db, profileId: string, minScore: number, now = new Date()): Promise<FeedItem[]> {
  const rows = await db.query<FeedRow>(
    `${FEED_SELECT}
     where m.profile_id = $1 and m.score >= $2 and m.notified_at is null and not m.over_limit
       and (b.due_at is null or b.due_at > $3) and s.action is null
     order by m.score desc, b.due_at asc nulls last`,
    [profileId, minScore, now.toISOString()],
  );
  return rows.map(toFeedItem);
}

export async function markNotified(db: Db, profileId: string, bidIds: string[]): Promise<void> {
  if (bidIds.length === 0) return;
  await db.query(`update matches set notified_at = now() where profile_id = $1 and bid_id = any($2::text[])`, [profileId, bidIds]);
}

// ----------------------------------------------------------- profiles --

/** prefs holds the whole Profile; the row id is the source of truth for its id. */
const toProfile = (r: { id: string; prefs: Profile | string }): Profile => ({ ...json(r.prefs), id: r.id });

export async function getProfile(db: Db, profileId: string): Promise<Profile | null> {
  const rows = await db.query<{ id: string; prefs: Profile | string }>('select id, prefs from profiles where id = $1', [profileId]);
  return rows[0] ? toProfile(rows[0]) : null;
}

/** The business profile an account owns, or null before onboarding. */
export async function getProfileByAccount(db: Db, accountId: string): Promise<Profile | null> {
  const rows = await db.query<{ id: string; prefs: Profile | string }>('select id, prefs from profiles where account_id = $1', [accountId]);
  return rows[0] ? toProfile(rows[0]) : null;
}

/** Every stored profile — what the scan scores in accounts mode. */
export async function listProfiles(db: Db): Promise<Profile[]> {
  const rows = await db.query<{ id: string; prefs: Profile | string }>('select id, prefs from profiles order by id');
  return rows.map(toProfile);
}

/**
 * Create or replace the one profile an account owns. Its id is fixed by the first save, because
 * matches, swipes, alerts and estimates hang off it; later saves keep that id whatever `profile.id` says.
 * Returns the profile as stored. Throws if the id already belongs to another account or a config profile.
 */
export async function saveProfileForAccount(db: Db, accountId: string, profile: Profile): Promise<Profile> {
  const owned = await db.query<{ id: string }>('select id from profiles where account_id = $1', [accountId]);
  const stored: Profile = { ...profile, id: owned[0]?.id ?? profile.id };
  const rows = await db.query(
    `insert into profiles (id, name, prefs, account_id) values ($1, $2, $3::jsonb, $4)
     on conflict (id) do update set name = excluded.name, prefs = excluded.prefs, updated_at = now()
       where profiles.account_id = excluded.account_id
     returning id`,
    [stored.id, stored.name, JSON.stringify(stored), accountId],
  );
  if (rows.length === 0) throw new Error(`Profile id "${stored.id}" is already taken`);
  return stored;
}

// -------------------------------------------------------------- scans --

export async function recordScan(db: Db, startedAt: Date, report: unknown): Promise<void> {
  await db.query('insert into scans (started_at, finished_at, report) values ($1, now(), $2::jsonb)', [
    startedAt.toISOString(),
    JSON.stringify(report),
  ]);
}

/** When the last scan finished (ISO), or null: what a polling app compares to know the feed changed. */
export async function lastScanAt(db: Db): Promise<string | null> {
  const rows = await db.query<{ finished_at: Date | string }>('select finished_at from scans order by id desc limit 1');
  return rows[0] ? new Date(rows[0].finished_at).toISOString() : null;
}

export async function lastScan(db: Db): Promise<{ finishedAt: string; report: unknown } | null> {
  const rows = await db.query<{ finished_at: Date | string; report: unknown }>(
    'select finished_at, report from scans order by id desc limit 1',
  );
  const r = rows[0];
  return r ? { finishedAt: new Date(r.finished_at).toISOString(), report: json(r.report as object) } : null;
}
