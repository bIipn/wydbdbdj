/**
 * Who gets alerted about what. Pure rules: no clock of its own, no database, no network — every
 * function takes `now`, so the decision table in test/realtime.test.ts is the spec.
 *
 * An alert is always stored in the inbox and streamed to the open app. Whether it also buzzes the
 * phone is a separate answer (PushDecision):
 *   send  now
 *   hold  the profile is in its quiet hours. The stored alert waits (pushed_at stays empty) and
 *         src/realtime/index.ts releases it on its first 15-minute tick after quiet hours end —
 *         everything that piled up goes out as ONE notification. A held push that is older than
 *         24 hours, or that the owner has already read in the app, is never sent.
 *   off   the plan has no instant push (free), the owner turned phone alerts off, or the alert is
 *         about a bid that was already on the boards (inbox only).
 */
import type { NewAlert, SavedDeadline } from '../db/alerts.js';
import { periodName } from '../market/watch.js';
import { featuresFor } from '../plans.js';
import { alertThreshold } from '../scan.js';
import type { AlertKind, AlertSettings, Bid, Plan, Profile, Verdict } from '../types.js';
import { PACIFIC } from '../util/time.js';
import type { BusEventOf } from './bus.js';

export type PushDecision = 'send' | 'hold' | 'off';

export interface AlertDecision {
  alert: NewAlert;
  push: PushDecision;
}

// ------------------------------------------------------------ the clock --

const formats = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock formatter for a zone. An unknown zone reads as Pacific, where the boards are. */
function formatFor(timeZone: string): Intl.DateTimeFormat {
  let f = formats.get(timeZone);
  if (!f) {
    const options: Intl.DateTimeFormatOptions = {
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    };
    try {
      f = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
    } catch {
      f = new Intl.DateTimeFormat('en-US', { ...options, timeZone: PACIFIC });
    }
    formats.set(timeZone, f);
  }
  return f;
}

interface WallClock {
  /** Calendar day as a count of days, so two of them subtract to "days apart". */
  day: number;
  /** YYYY-MM-DD */
  date: string;
  /** Minutes since local midnight. */
  minutes: number;
}

function wallClock(at: Date, timeZone: string): WallClock {
  const parts = formatFor(timeZone).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const [y, mo, d] = [n('year'), n('month'), n('day')];
  return {
    day: Date.UTC(y, mo - 1, d) / 86_400_000,
    date: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    minutes: n('hour') * 60 + n('minute'),
  };
}

/** The zone a profile's quiet hours and "morning of" are read in. */
export const alertZone = (alerts: AlertSettings | undefined): string => alerts?.timeZone ?? PACIFIC;

const minutesOf = (clock: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock);
  if (!m) return null;
  const [h, mi] = [Number(m[1]), Number(m[2])];
  return h < 24 && mi < 60 ? h * 60 + mi : null;
};

/**
 * True inside the quiet window, read on the wall clock of the profile's time zone. The window may
 * run past midnight ("21:00"–"06:00"); the start minute is quiet, the end minute is not.
 * No window, a malformed one, or one whose ends are equal = never quiet.
 */
export function inQuietHours(alerts: AlertSettings | undefined, now: Date): boolean {
  const quiet = alerts?.quietHours;
  if (!quiet) return false;
  const [start, end] = [minutesOf(String(quiet.start)), minutesOf(String(quiet.end))];
  if (start === null || end === null || start === end) return false;
  const at = wallClock(now, alertZone(alerts)).minutes;
  return start < end ? at >= start && at < end : at >= start || at < end;
}

/**
 * Should an alert buzz this profile's phone right now? Registering a device is the opt-in, so
 * `alerts.push` only matters when it is an explicit false.
 */
export function pushDecision(alerts: AlertSettings | undefined, plan: Plan, now: Date): PushDecision {
  if (!featuresFor(plan).instantPush || alerts?.push === false) return 'off';
  return inQuietHours(alerts, now) ? 'hold' : 'send';
}

const kindOn = (profile: Profile, kind: AlertKind): boolean => profile.alerts?.kinds?.[kind] !== false;

// ----------------------------------------------------------------- copy --

/** One line, at most `max` characters. */
const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const FIT_LABEL: Record<Verdict, string> = { great: 'Great fit', good: 'Good fit', maybe: 'Possible fit', skip: 'Weak fit' };

/** "12 days left", counted the way the card counts them. */
export function timeLeft(dueAt: string | null, now: Date): string {
  if (!dueAt) return 'no deadline listed';
  const ms = Date.parse(dueAt) - now.getTime();
  if (ms <= 0) return 'closed';
  if (ms < 3_600_000) return 'under 1 hour left';
  if (ms < 86_400_000) return `${plural(Math.floor(ms / 3_600_000), 'hour')} left`;
  return `${plural(Math.floor(ms / 86_400_000), 'day')} left`;
}

const titleCase = (s: string): string => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

const usd = (amount: number): string =>
  amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------- match --

/**
 * A bid that fits: alert when the score reaches the profile's threshold (alerts.minScore, else
 * notify.minScore), it is not a hard no, not over the spend limit, and match alerts are on.
 * Title = fit + place; body = the job, the top reason and the time left.
 */
export function decideMatch(event: BusEventOf<'match'>, profile: Profile, plan: Plan, now: Date): AlertDecision | null {
  const { bid, score } = event;
  if (!kindOn(profile, 'match') || score.rejected || score.overLimit || score.score < alertThreshold(profile)) return null;

  const place = bid.location.label ?? bid.agency;
  // Lead with a reason to bid; fall back to a neutral note, never to a minus.
  const reason = score.reasons.find((r) => r.kind === 'plus') ?? score.reasons.find((r) => r.kind === 'info');
  return {
    alert: {
      kind: 'match', bidId: bid.id, dedupeKey: bid.id,
      title: clip(`${FIT_LABEL[score.verdict]} (${score.score})${place ? ` · ${place}` : ''}`, 80),
      body: clip(`${clip(bid.title, 90)} — ${[reason?.text, timeLeft(bid.dueAt, now)].filter(Boolean).join(' · ')}`, 200),
      data: { bidId: bid.id, score: score.score, url: bid.url },
    },
    // "The moment the system sees it" is a bid that is new to the boards. One that was already
    // there (first scoring after onboarding, a changed setting) goes to the inbox without a buzz.
    push: event.isNewBid ? pushDecision(profile.alerts, plan, now) : 'off',
  };
}

// ------------------------------------------------------------- deadline --

/** 3 days before, 1 day before, and the morning of the due day. */
export type DeadlineStage = '3d' | '1d' | 'day';

/** "Morning of" starts at 07:00 on the profile's wall clock. */
export const MORNING_MINUTES = 7 * 60;
/** How far ahead the reminder job has to look. */
export const DEADLINE_LOOKAHEAD_HOURS = 72;

const HOUR = 3_600_000;

/**
 * The reminder that is due for a deadline right now, if any. The windows do not overlap, so a bid
 * saved late gets the next reminder rather than a stale one:
 *   3d   72 h to 48 h before the deadline
 *   1d   the last 24 h, until the due day begins on the profile's wall clock
 *   day  the due day from 07:00 local until the deadline (none when it is due before 07:00)
 */
export function deadlineStage(dueAt: Date, now: Date, timeZone: string): DeadlineStage | null {
  const left = dueAt.getTime() - now.getTime();
  if (!(left > 0)) return null;
  const today = wallClock(now, timeZone);
  if (wallClock(dueAt, timeZone).day === today.day) return today.minutes >= MORNING_MINUTES ? 'day' : null;
  if (left <= 24 * HOUR) return '1d';
  return left > 48 * HOUR && left <= DEADLINE_LOOKAHEAD_HOURS * HOUR ? '3d' : null;
}

/** "Due tomorrow at 2:00 PM", in calendar days on the profile's wall clock. */
function dueLabel(dueAt: Date, now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).formatToParts(dueAt);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const time = `${part('hour')}:${part('minute')} ${part('dayPeriod')}`.trim();
  const days = wallClock(dueAt, timeZone).day - wallClock(now, timeZone).day;
  if (days <= 0) return `Due today at ${time}`;
  if (days === 1) return `Due tomorrow at ${time}`;
  return `Due in ${days} days · ${part('weekday')} ${time}`;
}

/**
 * A reminder for a saved bid. One per bid, stage and due day: the dedupe key carries the due date,
 * so a deadline an addendum moves to another day is reminded again.
 */
export function decideDeadline(saved: SavedDeadline, profile: Profile, plan: Plan, now: Date): AlertDecision | null {
  if (!kindOn(profile, 'deadline')) return null;
  const zone = formatFor(alertZone(profile.alerts)).resolvedOptions().timeZone;
  const due = new Date(saved.dueAt);
  const stage = deadlineStage(due, now, zone);
  if (!stage) return null;
  return {
    alert: {
      kind: 'deadline', bidId: saved.bidId, dedupeKey: `${saved.bidId}:${stage}:${wallClock(due, zone).date}`,
      title: dueLabel(due, now, zone),
      body: clip(`${clip(saved.title, 110)}${saved.place ? ` — ${saved.place}` : ''}`, 200),
      data: { bidId: saved.bidId, stage, dueAt: saved.dueAt, url: saved.url },
    },
    push: pushDecision(profile.alerts, plan, now),
  };
}

// ---------------------------------------------------------------- award --

/**
 * An award / result notice (Pro: awardWatch). Bids are sealed, so this is always "what it went for",
 * after the fact — never a competitor's price before opening. Every figure is the award's own.
 */
export function decideAward(event: BusEventOf<'award'>, profile: Profile, plan: Plan, now: Date, bid: Bid | null): AlertDecision | null {
  if (!featuresFor(plan).awardWatch || !kindOn(profile, 'award')) return null;
  const { award, nearby } = event;
  const price = award.amount == null ? '' : ` for ${usd(award.amount)}`;
  const outcome = award.recipient ? `Awarded to ${award.recipient}${price}` : price ? `Awarded${price}` : 'Result posted';
  // A job like theirs near them (no bid of theirs): say why it is in their inbox, and nothing more.
  const where = [award.city ? titleCase(award.city) : null, award.state].filter(Boolean).join(', ');
  const title = bid
    ? `Award posted: ${bid.title}`
    : nearby
      ? `Similar job awarded · ${nearby.miles} mi away${where ? ` (${where})` : ''}`
      : `Award posted${award.agency ? ` · ${award.agency}` : ''}`;
  const what = nearby ? `${award.description ? `${clip(award.description, 70)} — ` : ''}` : '';
  return {
    alert: {
      // Each case has its own key: an award first told as "similar job nearby" (no solicitation
      // number yet) must still reach the inbox as "Award posted: <saved bid>" once its number is known.
      kind: 'award', bidId: event.bidId ?? null, dedupeKey: event.bidId ? `${award.id}:bid:${event.bidId}` : `${award.id}:nearby`,
      title: clip(title, 80),
      body: clip(`${what}${outcome}${award.actionDate ? ` on ${award.actionDate}` : ''} · source: ${award.source}`, 200),
      data: {
        awardId: award.id, bidId: event.bidId ?? null, recipient: award.recipient, amount: award.amount,
        actionDate: award.actionDate, source: award.source, url: award.url,
        ...(nearby ? { nearby: { miles: nearby.miles, naics: nearby.naics } } : {}),
      },
    },
    push: pushDecision(profile.alerts, plan, now),
  };
}

// ---------------------------------------------------------------- price --

/** What a published series is called and who publishes it (market_series_meta). */
export interface SeriesLabel {
  title: string;
  source: string;
  sourceUrl: string | null;
}

/**
 * A watched price or wage series moved (Pro: priceAlerts). A market number never goes out without
 * its source and period, so a series we cannot name gets no alert at all.
 */
export function decidePrice(event: BusEventOf<'price'>, label: SeriesLabel | null, profile: Profile, plan: Plan, now: Date): AlertDecision | null {
  if (!label || !Number.isFinite(event.changePct) || !featuresFor(plan).priceAlerts || !kindOn(profile, 'price')) return null;
  const pct = (n: number): string => Math.abs(n).toFixed(1).replace(/\.0$/, '');
  const signed = (n: number): string => `${n > 0 ? '+' : n < 0 ? '−' : ''}${pct(n)}%`;
  // From the watcher: "Sep 2026 (preliminary) vs Aug 2026 · 12 months: +4.1%". Without the period before, the bare period.
  const when = event.previousPeriod
    ? `${periodName(event.period)}${event.preliminary ? ' (preliminary)' : ''} vs ${periodName(event.previousPeriod)}`
      + `${typeof event.yearChangePct === 'number' && Number.isFinite(event.yearChangePct) ? ` · 12 months: ${signed(event.yearChangePct)}` : ''}`
    : `Period ${event.period}`;
  const extra = event.previousPeriod
    ? { previousPeriod: event.previousPeriod, yearChangePct: event.yearChangePct ?? null, preliminary: event.preliminary ?? false }
    : {};
  return {
    alert: {
      kind: 'price', bidId: null, dedupeKey: `${event.seriesId}:${event.period}`,
      title: clip(`${label.title} ${event.changePct < 0 ? 'down' : 'up'} ${pct(event.changePct)}%`, 80),
      body: clip(`${when} · source: ${label.source}. Re-check open quotes.`, 200),
      data: {
        seriesId: event.seriesId, changePct: event.changePct, period: event.period, source: label.source, sourceUrl: label.sourceUrl, ...extra,
      },
    },
    push: pushDecision(profile.alerts, plan, now),
  };
}
