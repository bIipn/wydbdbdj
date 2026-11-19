/**
 * GET /api/admin/usage (docs/PLAN.md N11, §4 "How we know"): counts only, never an id, e-mail, name or text.
 *
 * Days are each person's OWN calendar days: the alert clock in Settings (alerts.timeZone), else Pacific, where the
 * pilot and the boards are. A UTC day would split one Pacific working day in two at 16:00 (17:00 in summer).
 *
 * Return visits read table `account_days`: one row per account per local day on which it made a signed-in request
 * (src/context.ts identify, through createVisitLog below). Nothing else is kept about a visit: no time, page, address
 * or device. The rest is counted from what the app already stores: alerts, swipes (swipes.first_at: when the profile
 * first decided on a bid), and profiles' alert switches. The local jobs' counts are in src/jobs/repo.ts (all their SQL
 * lives there).
 */
import { wallClock } from '../realtime/alerts.js';
import { PACIFIC } from '../util/time.js';
import type { Db } from './db.js';

const DAY_MS = 86_400_000;
/** A first decision before 12:00 on the person's clock is a morning one (§4: "decisions on 4+ mornings a week"). */
const MORNING_ENDS_MIN = 12 * 60;
/** The visit log forgets every account it remembers past this many (one server instance, one day). */
const VISIT_LOG_MAX = 50_000;

/** Today's UTC day, "2026-11-18". */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** The calendar day ("2026-11-18") at `now` on a zone's clock; no zone, or one unknown, reads as Pacific. */
export const localDay = (now: Date, timeZone: string | null | undefined): string => wallClock(now, timeZone || PACIFIC).date;

/** Store that `accountId` used the app on `day` (its own calendar day). A second call the same day writes nothing. */
export async function recordVisitDay(db: Db, accountId: string, day: string): Promise<void> {
  await db.query('insert into account_days (account_id, day) values ($1, $2::date) on conflict do nothing', [accountId, day]);
}

/**
 * The visit recorder one server instance keeps: it asks the database at most once per account per day of that
 * account's own calendar (`timeZone`: its profile's alert clock; none = Pacific). A failure (the account deleted in the
 * middle of the request, a database hiccup) is logged without the account and never fails the request it came with.
 */
export function createVisitLog(db: Db, log: (msg: string) => void = () => {}): (accountId: string, now: Date, timeZone?: string | null) => Promise<void> {
  const seen = new Map<string, string>(); // account → the last day stored for it here
  return async (accountId, now, timeZone) => {
    const today = localDay(now, timeZone);
    if (seen.get(accountId) === today) return;
    if (seen.size >= VISIT_LOG_MAX) seen.clear();
    seen.set(accountId, today); // before the await: a second request of the same account in flight does not write again
    try {
      await recordVisitDay(db, accountId, today);
    } catch (err) {
      log(`usage: a visit day was not stored (${(err as { code?: string }).code ?? 'error'})`);
    }
  };
}

/** 4+ days a week, counted per person over the whole weeks of a window. */
export interface WeeklyDays {
  /** People with at least one such day in the window. */
  people: number;
  /** Of those, how many had 4 or more different such days in at least one of the window's weeks. */
  fourPlusAnyWeek: number;
  /** ... in every one of its weeks. */
  fourPlusEveryWeek: number;
}

/** One window of GET /api/admin/usage. */
export interface UsageWindow {
  days: number;
  /** ISO: 00:00 UTC on the window's first day (today counts as its last), where the alert, bid and job counts start. */
  from: string;
  /**
   * Return visits: the local days an account made a signed-in request (table account_days), in the weeks of 7 days
   * that end on its own today. null in single mode: no accounts there.
   */
  returnVisits: WeeklyDays | null;
  /**
   * The days a profile first decided on a bid (a save, a pass or "Bid on …": swipes.first_at), on its own clock, in the
   * weeks of 7 days that end on its own today; mornings = such a decision before 12:00. The pilot (single mode) too.
   */
  decisionDays: { days: WeeklyDays; mornings: WeeklyDays };
  /**
   * The 'match' alerts made in the window, and what their profiles did with those bids (at any time since).
   *   sent         match alerts made
   *   decided      of those, how many bids got a first save, pass or "Bid on …" after the alert (an Undo forgets a
   *                decision, so the next one counts as the first; swipes stored before 2026-11-18 have no first_at)
   *   medianMinutesToFirstDecision  the median of those minutes (one decimal); null when none was decided
   *   saved        of the decided ones, how many are saved or opened now (the Saved list's rule: save or bid); a bid
   *                saved before its alert was made is not counted
   *   savesPerAlert  saved / sent (two decimals); null when no alert was sent
   */
  matchAlerts: { sent: number; decided: number; medianMinutesToFirstDecision: number | null; saved: number; savesPerAlert: number | null };
  /**
   * Bids whose agency page was opened from "Bid on …" in the window: one per bid (the latest decision on it, made in
   * the window, is that tap). The app records a tap only on a bid with no decision yet (web/js/parts.js bidLink, the
   * deck's open button), so a tap on a bid already saved or passed, and a second tap, add nothing: a lower bound on
   * the bids opened, never a count of taps.
   */
  bidsOpened: number;
  /**
   * Every kind of alert made in the window, and how many of them are marked read. A job's end also marks its one-sided
   * "We've agreed" alert read (src/db/alerts.ts retireTapAlert), so `read` can hold a few nobody opened.
   */
  alerts: { sent: number; read: number };
  /** Local jobs posted in the window, and how many of THOSE have since got a bid, an award, an agreement, "done". */
  localJobs: LocalJobCounts | null;
}

export interface LocalJobCounts { posted: number; withBids: number; awarded: number; agreed: number; done: number }

/** Profiles with an alert switched off in Settings, now (not per window): the opt-outs. */
export interface AlertOptOuts {
  profiles: number;
  /** Profiles with phone alerts switched off (alerts.push false): no push of any kind. */
  phoneAlertsOff: number;
  /** Profiles with at least one kind off. */
  anyKindOff: number;
  /** Per kind (every kind with a switch), how many profiles have it off. */
  byKind: Record<string, number>;
}

const n = (v: unknown): number => Number(v ?? 0);

/** 00:00 UTC on the first day of a window of `days` days that ends today. */
export function windowStart(now: Date, days: number): Date {
  const today = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  return new Date(today - (days - 1) * DAY_MS);
}

/** "2026-11-18" → a day number (days since 1970-01-01), so two of them subtract to "days apart". */
const dayNumber = (isoDay: string): number => Date.parse(`${isoDay}T00:00:00.000Z`) / DAY_MS;

/**
 * Count 4+ days a week. `people` maps each person to their own today (a day number) and the days they had; only the
 * `days` days that end on their today count, cut into weeks of 7 ending today.
 */
function weekly(people: Map<string, { today: number; days: Set<number> }>, days: number): WeeklyDays {
  const weeks = days / 7;
  const out: WeeklyDays = { people: 0, fourPlusAnyWeek: 0, fourPlusEveryWeek: 0 };
  for (const { today, days: had } of people.values()) {
    const perWeek = new Array<number>(weeks).fill(0);
    for (const d of had) {
      const back = today - d;
      if (back >= 0 && back < days) perWeek[Math.floor(back / 7)]! += 1;
    }
    if (!perWeek.some((c) => c > 0)) continue;
    out.people += 1;
    const good = perWeek.filter((c) => c >= 4).length;
    if (good >= 1) out.fourPlusAnyWeek += 1;
    if (good === weeks) out.fourPlusEveryWeek += 1;
  }
  return out;
}

/** Whole weeks only: the window's days must be a multiple of 7. */
function wholeWeeks(days: number, what: string): void {
  if (days % 7 !== 0) throw new Error(`${what}: the window must be whole weeks`);
}

/** Return visits over the `days` (a multiple of 7) days that end on each account's own today. */
export async function returnVisits(db: Db, now: Date, days: number): Promise<WeeklyDays> {
  wholeWeeks(days, 'returnVisits');
  const start = windowStart(now, days);
  // A local day is at most one day off the UTC one: read a day more on each side, then keep each account's own window.
  const rows = await db.query<{ account_id: string; day: string; tz: string | null }>(
    `select d.account_id, to_char(d.day, 'YYYY-MM-DD') as day, p.prefs->'alerts'->>'timeZone' as tz
     from account_days d left join profiles p on p.account_id = d.account_id
     where d.day between $1::date and $2::date`,
    [utcDay(new Date(start.getTime() - DAY_MS)), utcDay(new Date(now.getTime() + DAY_MS))],
  );
  const people = new Map<string, { today: number; days: Set<number> }>();
  for (const r of rows) {
    let p = people.get(r.account_id);
    if (!p) people.set(r.account_id, (p = { today: dayNumber(localDay(now, r.tz)), days: new Set() }));
    p.days.add(dayNumber(r.day));
  }
  return weekly(people, days);
}

/** The days, and the mornings, on which each profile first decided on a bid, over the `days` that end on its today. */
export async function decisionDays(db: Db, now: Date, days: number): Promise<UsageWindow['decisionDays']> {
  wholeWeeks(days, 'decisionDays');
  const start = windowStart(now, days);
  // Quarter hours are enough: every zone's offset is a whole number of them, so midnight and noon fall on one.
  const rows = await db.query<{ profile_id: string; tz: string | null; q: unknown }>(
    `select distinct s.profile_id, p.prefs->'alerts'->>'timeZone' as tz, floor(extract(epoch from s.first_at) / 900) * 900 as q
     from swipes s join profiles p on p.id = s.profile_id
     where s.first_at >= $1::timestamptz and s.first_at <= $2::timestamptz`,
    [new Date(start.getTime() - DAY_MS).toISOString(), now.toISOString()],
  );
  const all = new Map<string, { today: number; days: Set<number> }>();
  const mornings = new Map<string, { today: number; days: Set<number> }>();
  for (const r of rows) {
    const zone = r.tz || PACIFIC;
    const clock = wallClock(new Date(Number(r.q) * 1000), zone);
    let a = all.get(r.profile_id);
    if (!a) {
      a = { today: wallClock(now, zone).day, days: new Set() };
      all.set(r.profile_id, a);
      mornings.set(r.profile_id, { today: a.today, days: new Set() });
    }
    a.days.add(clock.day);
    if (clock.minutes < MORNING_ENDS_MIN) mornings.get(r.profile_id)!.days.add(clock.day);
  }
  return { days: weekly(all, days), mornings: weekly(mornings, days) };
}

/** Match alerts made in [from, now] and what was decided on their bids; bids opened; every alert kind made and read. */
export async function alertCounts(db: Db, from: Date, now: Date): Promise<Pick<UsageWindow, 'matchAlerts' | 'bidsOpened' | 'alerts'>> {
  const span = [from.toISOString(), now.toISOString()];
  const m = (await db.query<Record<string, unknown>>(
    `select count(*) as sent,
            count(*) filter (where s.first_at >= a.created_at) as decided,
            percentile_cont(0.5) within group (order by extract(epoch from (s.first_at - a.created_at)) / 60.0)
              filter (where s.first_at >= a.created_at) as median_min,
            count(*) filter (where s.first_at >= a.created_at and s.action in ('save', 'bid')) as saved
     from alerts a
     left join swipes s on s.profile_id = a.profile_id and s.bid_id = a.bid_id
     where a.kind = 'match' and a.created_at >= $1::timestamptz and a.created_at <= $2::timestamptz`,
    span,
  ))[0] ?? {};
  const opened = (await db.query<Record<string, unknown>>(
    `select count(*) as n from swipes where action = 'bid' and created_at >= $1::timestamptz and created_at <= $2::timestamptz`,
    span,
  ))[0] ?? {};
  const all = (await db.query<Record<string, unknown>>(
    `select count(*) as sent, count(read_at) as read from alerts where created_at >= $1::timestamptz and created_at <= $2::timestamptz`,
    span,
  ))[0] ?? {};
  const sent = n(m.sent);
  const saved = n(m.saved);
  const median = m.median_min == null ? null : Math.round(Number(m.median_min) * 10) / 10;
  return {
    matchAlerts: { sent, decided: n(m.decided), medianMinutesToFirstDecision: median, saved, savesPerAlert: sent ? Math.round((saved / sent) * 100) / 100 : null },
    bidsOpened: n(opened.n),
    alerts: { sent: n(all.sent), read: n(all.read) },
  };
}

/** How many profiles have phone alerts or each alert kind switched off (profiles.prefs is the whole Profile). */
export async function alertOptOuts(db: Db, kinds: readonly string[]): Promise<AlertOptOuts> {
  const total = (await db.query<Record<string, unknown>>(
    `select count(*) as profiles,
            count(*) filter (where prefs->'alerts'->'push' = 'false'::jsonb) as push_off,
            count(*) filter (where exists (
              select 1 from jsonb_each(case when jsonb_typeof(prefs->'alerts'->'kinds') = 'object' then prefs->'alerts'->'kinds' else '{}'::jsonb end) k
              where k.key = any($1::text[]) and k.value = 'false'::jsonb)) as any_off
     from profiles`,
    [[...kinds]],
  ))[0] ?? {};
  const per = await db.query<{ kind: string; off: unknown }>(
    `select k.kind, count(p.id) as off
     from unnest($1::text[]) as k(kind)
     left join profiles p on p.prefs->'alerts'->'kinds'->k.kind = 'false'::jsonb
     group by k.kind`,
    [[...kinds]],
  );
  const byKind = Object.fromEntries(kinds.map((k) => [k, 0]));
  for (const r of per) byKind[r.kind] = n(r.off);
  return { profiles: n(total.profiles), phoneAlertsOff: n(total.push_off), anyKindOff: n(total.any_off), byKind };
}
