import type { Bid, FeedItem, Profile, Reason, ScoreResult, SwipeAction, Verdict } from '../types.js';
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

/** Insert new bids, refresh existing ones. Returns the ids that were brand new. */
export async function upsertBids(db: Db, bids: Bid[], seenAt = new Date()): Promise<Set<string>> {
  const fresh = new Set<string>();
  const placeholders = BID_COLS.map((c, i) => (c === 'flags' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ');
  const updates = BID_COLS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
  const sql = `insert into bids (${BID_COLS.join(', ')}) values (${placeholders})
    on conflict (id) do update set ${updates}
    returning id, (xmax = 0) as inserted`;
  for (const b of bids) {
    const rows = await db.query<{ id: string; inserted: boolean }>(sql, bidParams(b, seenAt));
    if (rows[0]?.inserted) fresh.add(b.id);
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

export async function upsertMatch(db: Db, profileId: string, bidId: string, s: ScoreResult): Promise<void> {
  await db.query(
    `insert into matches (profile_id, bid_id, score, verdict, reasons, distance_mi, over_limit, scored_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, now())
     on conflict (profile_id, bid_id) do update set
       score = excluded.score, verdict = excluded.verdict, reasons = excluded.reasons,
       distance_mi = excluded.distance_mi, over_limit = excluded.over_limit, scored_at = excluded.scored_at`,
    [profileId, bidId, s.score, s.verdict, JSON.stringify(s.reasons), s.distanceMi, s.overLimit],
  );
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

export async function getBid(db: Db, bidId: string): Promise<Bid | null> {
  const rows = await db.query<BidRow>('select * from bids where id = $1', [bidId]);
  return rows[0] ? toBid(rows[0]) : null;
}

const FEED_SELECT = `
  select b.*, m.score, m.verdict, m.reasons, m.distance_mi, m.over_limit, s.action
  from matches m
  join bids b on b.id = m.bid_id
  left join swipes s on s.profile_id = m.profile_id and s.bid_id = m.bid_id`;

export interface FeedQuery {
  minScore?: number;
  limit?: number;
  /** Include bids already swiped (for the Browse list). */
  includeSwiped?: boolean;
  /** Leave out bids over the profile's spend limits (the swipe deck never shows them). */
  hideOverLimit?: boolean;
  now?: Date;
}

/** Open bids for the swipe deck: best fit first, then soonest deadline. */
export async function getFeed(db: Db, profileId: string, q: FeedQuery = {}): Promise<FeedItem[]> {
  const rows = await db.query<FeedRow>(
    `${FEED_SELECT}
     where m.profile_id = $1
       and m.score >= $2
       and (b.due_at is null or b.due_at > $3)
       and ($4::boolean or s.action is null)
       and not ($6::boolean and m.over_limit)
     order by m.score desc, b.due_at asc nulls last, b.first_seen_at desc
     limit $5`,
    [profileId, q.minScore ?? 35, (q.now ?? new Date()).toISOString(), q.includeSwiped ?? false, q.limit ?? 100, q.hideOverLimit ?? false],
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

export async function lastScan(db: Db): Promise<{ finishedAt: string; report: unknown } | null> {
  const rows = await db.query<{ finished_at: Date | string; report: unknown }>(
    'select finished_at, report from scans order by id desc limit 1',
  );
  const r = rows[0];
  return r ? { finishedAt: new Date(r.finished_at).toISOString(), report: json(r.report as object) } : null;
}
