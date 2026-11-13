/** SQL for the alerts inbox and push_subscriptions (tables in schema.ts). Owner: the realtime builder. */
import type { Account, Alert, AlertKind, Plan, Profile } from '../types.js';
import type { Db } from './db.js';

// -------------------------------------------------------------- alerts --

/** An alert before it is stored: the insert adds the id, the profile and the timestamps. */
export interface NewAlert {
  kind: AlertKind;
  bidId: string | null;
  /** Unique per (profile, kind): the same key is never stored, streamed or pushed twice. */
  dedupeKey: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

interface AlertRow {
  id: number | string; profile_id: string; kind: AlertKind; bid_id: string | null; dedupe_key: string; title: string;
  body: string; data: Record<string, unknown> | string; created_at: Date | string; pushed_at: Date | string | null;
  read_at: Date | string | null;
}

const iso = (v: Date | string | null): string | null => (v == null ? null : new Date(v).toISOString());
const json = <T>(v: T | string): T => (typeof v === 'string' ? (JSON.parse(v) as T) : v);

/**
 * Delivery bookkeeping kept inside alerts.data: `"_push": true` = this alert should buzz the phone.
 * Together with pushed_at it is the whole push state: wanted + pushed_at null = still waiting
 * (quiet hours, or no device accepted it yet). Clients never see the key.
 */
const WANTS_PUSH = '_push';
const WAITING = `pushed_at is null and read_at is null and data->>'${WANTS_PUSH}' = 'true'`;

function toAlert(r: AlertRow): Alert {
  const { [WANTS_PUSH]: _wanted, ...data } = json(r.data);
  return {
    id: Number(r.id), // bigserial: node-postgres hands it over as a string
    profileId: r.profile_id, kind: r.kind, bidId: r.bid_id, dedupeKey: r.dedupe_key, title: r.title, body: r.body, data,
    createdAt: iso(r.created_at)!, pushedAt: iso(r.pushed_at), readAt: iso(r.read_at),
  };
}

/**
 * Store an alert unless this profile already has one of that kind with the same dedupe key.
 * Returns the stored alert, or null for a repeat — the caller must then do nothing at all.
 */
export async function insertAlert(db: Db, profileId: string, a: NewAlert, opts: { push?: boolean; now?: Date } = {}): Promise<Alert | null> {
  const data = opts.push ? { ...a.data, [WANTS_PUSH]: true } : a.data;
  const rows = await db.query<AlertRow>(
    `insert into alerts (profile_id, kind, bid_id, dedupe_key, title, body, data, created_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     on conflict (profile_id, kind, dedupe_key) do nothing
     returning *`,
    [profileId, a.kind, a.bidId, a.dedupeKey, a.title, a.body, JSON.stringify(data), (opts.now ?? new Date()).toISOString()],
  );
  return rows[0] ? toAlert(rows[0]) : null;
}

export interface InboxQuery {
  unread?: boolean;
  /** Default 50, at most 200. */
  limit?: number;
  /** Paging: only alerts older than this id. */
  before?: number;
}

/** The inbox, newest first. */
export async function listAlerts(db: Db, profileId: string, q: InboxQuery = {}): Promise<Alert[]> {
  const rows = await db.query<AlertRow>(
    `select * from alerts
     where profile_id = $1 and (not $2::boolean or read_at is null) and ($3::bigint is null or id < $3::bigint)
     order by id desc
     limit $4`,
    [profileId, q.unread ?? false, q.before ?? null, Math.min(Math.max(q.limit ?? 50, 1), 200)],
  );
  return rows.map(toAlert);
}

export async function countUnread(db: Db, profileId: string): Promise<number> {
  const rows = await db.query<{ n: number | string }>('select count(*) as n from alerts where profile_id = $1 and read_at is null', [profileId]);
  return Number(rows[0]?.n ?? 0);
}

/** Mark alerts read (only this profile's). Returns how many changed. */
export async function markAlertsRead(db: Db, profileId: string, ids: number[] | 'all', now: Date): Promise<number> {
  const all = ids === 'all';
  const rows = await db.query(
    `update alerts set read_at = $2
     where profile_id = $1 and read_at is null and ($3::boolean or id = any($4::bigint[]))
     returning id`,
    [profileId, now.toISOString(), all, all ? [] : ids],
  );
  return rows.length;
}

/** The newest `limit` alerts after `afterId`, oldest first — what a reconnecting stream missed. */
export async function alertsAfter(db: Db, profileId: string, afterId: number, limit = 100): Promise<Alert[]> {
  const rows = await db.query<AlertRow>(
    `select * from (
       select * from alerts where profile_id = $1 and id > $2::bigint order by id desc limit $3
     ) newest order by id asc`,
    [profileId, afterId, limit],
  );
  return rows.map(toAlert);
}

/** The id of the profile's newest alert, 0 when it has none. */
export async function latestAlertId(db: Db, profileId: string): Promise<number> {
  const rows = await db.query<{ id: number | string | null }>('select max(id) as id from alerts where profile_id = $1', [profileId]);
  return Number(rows[0]?.id ?? 0);
}

// -------------------------------------------------------- push state --

/** Profiles with alerts still waiting for their push, created after `since`. */
export async function profilesWithWaitingPush(db: Db, since: Date): Promise<string[]> {
  const rows = await db.query<{ profile_id: string }>(
    `select distinct profile_id from alerts where ${WAITING} and created_at > $1 order by profile_id`, [since.toISOString()],
  );
  return rows.map((r) => r.profile_id);
}

/**
 * Take a profile's waiting pushes: marks them pushed and returns them, oldest first. One statement,
 * so two callers can never both get the same alert — that is what keeps a push from going out twice.
 * An alert the owner already read in the app is left alone.
 */
export async function claimWaitingPushes(db: Db, profileId: string, since: Date, now: Date): Promise<Alert[]> {
  const rows = await db.query<AlertRow>(
    `update alerts set pushed_at = $3 where profile_id = $1 and ${WAITING} and created_at > $2 returning *`,
    [profileId, since.toISOString(), now.toISOString()],
  );
  return rows.map(toAlert).sort((a, b) => a.id - b.id);
}

/** Hand claimed pushes back (no device accepted them) so a later tick tries again. */
export async function releasePushClaim(db: Db, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query('update alerts set pushed_at = null where id = any($1::bigint[])', [ids]);
}

// ------------------------------------------------- push subscriptions --

/** What the browser's PushSubscription.toJSON() gives us. The keys are secrets: never log them. */
export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Devices kept per account; registering one more drops the one that has been silent longest. */
export const MAX_DEVICES = 10;

/**
 * Register a device for an account. An endpoint belongs to one browser profile, so when it turns up
 * under another account (someone else signed in on that phone) it moves to them.
 */
export async function saveSubscription(db: Db, accountId: string, sub: StoredSubscription, now: Date): Promise<void> {
  await db.query(
    `insert into push_subscriptions (endpoint, account_id, keys, created_at) values ($1, $2, $3::jsonb, $4)
     on conflict (endpoint) do update set account_id = excluded.account_id, keys = excluded.keys, fail_count = 0`,
    [sub.endpoint, accountId, JSON.stringify(sub.keys), now.toISOString()],
  );
  await db.query(
    `delete from push_subscriptions where account_id = $1 and endpoint not in (
       select endpoint from push_subscriptions where account_id = $1
       order by coalesce(last_ok_at, created_at) desc, endpoint limit $2)`,
    [accountId, MAX_DEVICES],
  );
}

/** Unregister one of the account's own devices. False when it was not theirs (or not there). */
export async function deleteSubscription(db: Db, accountId: string, endpoint: string): Promise<boolean> {
  const rows = await db.query('delete from push_subscriptions where endpoint = $1 and account_id = $2 returning endpoint', [endpoint, accountId]);
  return rows.length > 0;
}

interface SubscriptionRow { endpoint: string; keys: StoredSubscription['keys'] | string }
const toSubscription = (r: SubscriptionRow): StoredSubscription => ({ endpoint: r.endpoint, keys: json(r.keys) });

export async function listSubscriptions(db: Db, accountId: string): Promise<StoredSubscription[]> {
  const rows = await db.query<SubscriptionRow>('select endpoint, keys from push_subscriptions where account_id = $1 order by created_at, endpoint', [accountId]);
  return rows.map(toSubscription);
}

/**
 * push_subscriptions hang off an account, and single mode (the pilot) has none. So the pilot's
 * devices are registered to one system account per config profile: no password, no identity, an
 * address under the reserved .invalid domain — nobody can sign in as it, and the profile row is not
 * linked to it (the scan must keep refreshing a config profile).
 */
export const singleOwnerId = (profileId: string): string => `single-${profileId}`;

export async function ensureSingleOwner(db: Db, profile: Pick<Profile, 'id' | 'name'>): Promise<string> {
  const id = singleOwnerId(profile.id);
  await db.query(
    'insert into accounts (id, email, name) values ($1, $2, $3) on conflict do nothing',
    [id, `${profile.id}@single-mode.invalid`, `${profile.name} (this server's own devices)`],
  );
  return id;
}

/** Every device that should buzz for a profile: its account's, or the single-mode owner's. */
export async function subscriptionsForProfile(db: Db, profileId: string): Promise<StoredSubscription[]> {
  const rows = await db.query<SubscriptionRow>(
    `select endpoint, keys from push_subscriptions
     where account_id = coalesce((select account_id from profiles where id = $1), $2)
     order by created_at, endpoint`,
    [profileId, singleOwnerId(profileId)],
  );
  return rows.map(toSubscription);
}

export type PushOutcome = 'ok' | 'failed' | 'gone';

/**
 * Note how a send to one device went. 'gone' = the push service answered 404 or 410: the
 * subscription is dead for good, so it is deleted.
 */
export async function recordPushResult(db: Db, endpoint: string, outcome: PushOutcome, now: Date): Promise<void> {
  if (outcome === 'gone') await db.query('delete from push_subscriptions where endpoint = $1', [endpoint]);
  else if (outcome === 'ok') await db.query('update push_subscriptions set last_ok_at = $2, fail_count = 0 where endpoint = $1', [endpoint, now.toISOString()]);
  else await db.query('update push_subscriptions set fail_count = fail_count + 1 where endpoint = $1', [endpoint]);
}

// ------------------------------------------------------------ targets --

/** A profile with the account that owns it (null for a config profile). The plan comes from the account. */
export interface AlertTarget {
  profile: Profile;
  account: Account | null;
}

interface TargetRow {
  id: string; prefs: Profile | string; account_id: string | null; email: string | null; account_name: string | null;
  plan: string | null; account_created_at: Date | string | null;
}

const TARGET_SELECT = `
  select p.id, p.prefs, a.id as account_id, a.email, a.name as account_name, a.plan, a.created_at as account_created_at
  from profiles p left join accounts a on a.id = p.account_id`;

const PLANS: readonly Plan[] = ['free', 'pro', 'pilot'];

function toTarget(r: TargetRow): AlertTarget {
  const plan = PLANS.find((p) => p === r.plan) ?? 'free';
  return {
    profile: { ...json(r.prefs), id: r.id },
    account: r.account_id === null
      ? null
      : { id: r.account_id, email: r.email ?? '', name: r.account_name, plan, createdAt: iso(r.account_created_at) ?? '' },
  };
}

/** Who an alert for this profile goes to — read fresh each time, so a setting saved a moment ago counts. */
export async function getAlertTarget(db: Db, profileId: string): Promise<AlertTarget | null> {
  const rows = await db.query<TargetRow>(`${TARGET_SELECT} where p.id = $1`, [profileId]);
  return rows[0] ? toTarget(rows[0]) : null;
}

/** Every profile with its owner — for an alert that is about no one profile (a price move). */
export async function listAlertTargets(db: Db): Promise<AlertTarget[]> {
  const rows = await db.query<TargetRow>(`${TARGET_SELECT} order by p.id`);
  return rows.map(toTarget);
}

// ---------------------------------------------------------- deadlines --

/** A bid someone saved (or tapped "Bid on …") whose deadline is coming up. */
export interface SavedDeadline {
  profileId: string;
  bidId: string;
  title: string;
  dueAt: string;
  place: string | null;
  url: string;
}

/** Saved bids due after `now` and within `hours`. Over-limit bids are never alerted, so they are left out. */
export async function savedBidsDueWithin(db: Db, now: Date, hours: number): Promise<SavedDeadline[]> {
  const rows = await db.query<{ profile_id: string; id: string; title: string; due_at: Date | string; loc_label: string | null; url: string }>(
    `select s.profile_id, b.id, b.title, b.due_at, b.loc_label, b.url
     from swipes s
     join bids b on b.id = s.bid_id
     join matches m on m.profile_id = s.profile_id and m.bid_id = s.bid_id
     where s.action in ('save', 'bid') and not m.over_limit and b.due_at > $1 and b.due_at <= $2
     order by s.profile_id, b.due_at, b.id`,
    [now.toISOString(), new Date(now.getTime() + hours * 3_600_000).toISOString()],
  );
  return rows.map((r) => ({ profileId: r.profile_id, bidId: r.id, title: r.title, dueAt: iso(r.due_at)!, place: r.loc_label, url: r.url }));
}

// ------------------------------------------------------------- series --

/** Title and source of a published series, so a price alert can say what moved and who says so. */
export async function seriesLabel(db: Db, seriesId: string): Promise<{ title: string; source: string; sourceUrl: string | null; kind: string; area: string | null } | null> {
  const rows = await db.query<{ title: string; source: string; source_url: string | null; kind: string; area: string | null }>(
    'select title, source, source_url, kind, area from market_series_meta where series_id = $1', [seriesId],
  );
  const r = rows[0];
  return r ? { title: r.title, source: r.source, sourceUrl: r.source_url, kind: r.kind, area: r.area } : null;
}

// ------------------------------------------------------------- awards --

/** Bids a profile saved or said it bid on that carry a solicitation number: what an award can be matched to. */
export async function savedSolicitations(db: Db, profileId?: string): Promise<Array<{ profileId: string; bidId: string; solNumber: string }>> {
  const rows = await db.query<{ profile_id: string; id: string; sol_number: string }>(
    `select distinct s.profile_id, b.id, b.sol_number
     from swipes s join bids b on b.id = s.bid_id
     where s.action in ('save', 'bid') and b.sol_number is not null and btrim(b.sol_number) <> ''
       and ($1::text is null or s.profile_id = $1)
     order by s.profile_id, b.id`,
    [profileId ?? null],
  );
  return rows.map((r) => ({ profileId: r.profile_id, bidId: r.id, solNumber: r.sol_number }));
}

/** How many bids a profile saved or bid on, in all (with or without a solicitation number). */
export async function countSavedBids(db: Db, profileId: string): Promise<number> {
  const rows = await db.query<{ n: number | string }>(
    "select count(distinct bid_id) as n from swipes where profile_id = $1 and action in ('save', 'bid')", [profileId],
  );
  return Number(rows[0]?.n ?? 0);
}
