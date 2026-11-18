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
 *   off   the owner turned phone alerts off, the alert is about a public bid and the plan has no instant
 *         push (free), or it is about a bid that was already on the boards (inbox only).
 *
 * Local jobs (BidSwipe's own marketplace) buzz the same way on every plan (docs/PLAN.md R2): a winner who can be
 * recorded as a no-show hears "You won" on Free as on Pro, and no plan hears of a new local job first.
 */
import type { NewAlert, SavedDeadline } from '../db/alerts.js';
import { formatUsd } from '../jobs/rules.js';
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

/** The zone a profile's quiet hours and deadline reminders' calendar days are read in. */
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
 * What an alert is about, for the push: 'bid' = a public bid or the market (Pro and the pilot buzz, Free reads the
 * inbox), 'local' = a local job (every plan alike).
 */
export type PushTopic = 'bid' | 'local';

/** A local job's card in the feed is the bid `local:<jobId>` (src/jobs/service.ts mirrorBid). */
const LOCAL_BID = 'local:';

/**
 * Is this alert about a local job: one of the job_* kinds, or a 'match' or 'deadline' alert on a `local:<jobId>` card?
 * src/db/alerts.ts claimWaitingPushes asks the same in SQL (localOnly).
 */
export const isLocalJobAlert = (kind: string, bidId: string | null | undefined): boolean =>
  kind.startsWith('job_') || (typeof bidId === 'string' && bidId.startsWith(LOCAL_BID));

const topicOf = (bidId: string): PushTopic => (bidId.startsWith(LOCAL_BID) ? 'local' : 'bid');

/**
 * Should an alert buzz this profile's phone right now? Registering a device is the opt-in, so
 * `alerts.push` only matters when it is an explicit false. The plan only decides for public bids
 * ('bid'); a local job ('local') takes the same answer on every plan. Quiet hours hold both.
 */
export function pushDecision(alerts: AlertSettings | undefined, plan: Plan, now: Date, topic: PushTopic = 'bid'): PushDecision {
  if ((topic === 'bid' && !featuresFor(plan).instantPush) || alerts?.push === false) return 'off';
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
 * notify.minScore), it is not a hard no, not over the spend limit, not held down by a gate (capped), and
 * match alerts are on.
 * Title = fit + place; body = the job, the top reason and the time left.
 */
export function decideMatch(event: BusEventOf<'match'>, profile: Profile, plan: Plan, now: Date): AlertDecision | null {
  const { bid, score } = event;
  // Sub work is always capped too; the tier check says it again so no change to `capped` can make it alert.
  if (!kindOn(profile, 'match') || score.rejected || score.overLimit || score.capped || score.tier === 'sub' || score.score < alertThreshold(profile)) return null;

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
    // A new local job (local:<jobId>) buzzes on every plan alike; a public bid by the plan.
    push: event.isNewBid ? pushDecision(profile.alerts, plan, now, topicOf(bid.id)) : 'off',
  };
}

// ------------------------------------------------------------- deadline --

/** Three calendar days before the due day, the day before, and the due day itself. */
export type DeadlineStage = '3d' | '1d' | 'day';

/** A reminder waits for 07:00 on the profile's wall clock, unless that day's last run of the job comes earlier. */
export const MORNING_MINUTES = 7 * 60;
/**
 * How far ahead the reminder job looks: from 00:00 three calendar days before the due day to the end of the due day
 * is under 4 days, plus an hour on the night the clocks go back.
 */
export const DEADLINE_LOOKAHEAD_HOURS = 100;

const STAGE_BY_DAYS: ReadonlyMap<number, DeadlineStage> = new Map([[3, '3d'], [1, '1d'], [0, 'day']]);

/**
 * The reminder that is due for a deadline right now, if any. Each stage belongs to one calendar day on the profile's
 * clock: '3d' three days before the due day, '1d' the day before, 'day' the due day until the deadline. It goes out
 * at the first run of the job on its day from 07:00, or earlier that day when this run is the day's last one:
 * `nextRunAt` = when the job runs next (null = not known: from 07:00 only).
 *   - The host runs the job once a day (vercel.json: /api/cron/tick at 14:50 UTC, 04:50 in Hawaii to 10:50 in New
 *     York in summer). Every run there is its day's last, so each stage goes out on its own day in every zone.
 *   - A long-running server runs it every 15 minutes, so a stage goes out at 07:00 and never in the night.
 * A bid saved after a stage's day gets the next stage, never a stale one. A deadline before the day's first run
 * (before 07:00 on a server, before the host's tick) has no due-day reminder: the day before told the time.
 */
export function deadlineStage(dueAt: Date, now: Date, timeZone: string, nextRunAt: Date | null = null): DeadlineStage | null {
  if (!(dueAt.getTime() > now.getTime())) return null;
  const today = wallClock(now, timeZone);
  const stage = STAGE_BY_DAYS.get(wallClock(dueAt, timeZone).day - today.day);
  if (!stage) return null;
  if (today.minutes >= MORNING_MINUTES) return stage;
  return nextRunAt && wallClock(nextRunAt, timeZone).day !== today.day ? stage : null;
}

/**
 * On the day-before and due-day reminders of a public bid, and under "Bid on …" in its detail sheet (web/js/format.js
 * ADDENDA_LINE, kept equal by test/realtime.test.ts). BidSwipe does not read addenda, and says so.
 */
export const ADDENDA_LINE = 'Check the agency’s page for addenda (amendments) before you bid. BidSwipe doesn’t read them.';

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
 * so a deadline an addendum moves to another day is reminded again. `nextRunAt`: see deadlineStage.
 * The day-before and due-day reminders of a public bid end with ADDENDA_LINE; a local job has no agency page.
 */
export function decideDeadline(saved: SavedDeadline, profile: Profile, plan: Plan, now: Date, nextRunAt: Date | null = null): AlertDecision | null {
  if (!kindOn(profile, 'deadline')) return null;
  const zone = formatFor(alertZone(profile.alerts)).resolvedOptions().timeZone;
  const due = new Date(saved.dueAt);
  const stage = deadlineStage(due, now, zone, nextRunAt);
  if (!stage) return null;
  const topic = topicOf(saved.bidId);
  const subject = `${clip(saved.title, 110)}${saved.place ? ` — ${saved.place}` : ''}`;
  const addenda = stage !== '3d' && topic === 'bid';
  return {
    alert: {
      kind: 'deadline', bidId: saved.bidId, dedupeKey: `${saved.bidId}:${stage}:${wallClock(due, zone).date}`,
      title: dueLabel(due, now, zone),
      // The addenda line is never the part that is cut: the subject makes room for it.
      body: addenda ? `${clip(subject, 200 - ADDENDA_LINE.length - 3)} · ${ADDENDA_LINE}` : clip(subject, 200),
      data: { bidId: saved.bidId, stage, dueAt: saved.dueAt, url: saved.url },
    },
    // A saved local job is a local-job alert: every plan alike. A public bid by the plan.
    push: pushDecision(profile.alerts, plan, now, topic),
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

// ------------------------------------------------------------------ jobs --

/** "Mon, Nov 23, 5:00 PM" on the profile's wall clock. */
function whenLabel(iso: string | null, timeZone: string): string {
  if (!iso) return 'the deadline';
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    .format(new Date(iso));
}

/** Integer cents → "$1,234.56" without floating point (src/jobs/rules.ts formatUsd). */
const centsLabel = (cents: number | null | undefined): string => (cents == null ? 'not stated' : formatUsd(cents));

/** Fees are off (contract rule 8): every line that mentions a no-show says so, and never that anything was charged. */
const NO_FEES_YET = 'Fees are not being collected yet. A no-show is recorded on your profile.';
const POST_AGAIN = 'You can post it again with one tap.';

/** Title and body for a job that ended, by who this person is on it. */
function closedCopy(e: BusEventOf<'job'>): { title: string; body: string } {
  const t = clip(e.title, 60);
  const mine = e.role === 'poster';
  if (e.role === 'bidder') {
    if (e.status === 'cancelled') return { title: `Cancelled: ${t}`, body: 'The poster cancelled this job before it closed. Your bid is closed.' };
    return {
      title: `Not this time: ${t}`,
      body: `Lowest bid: ${centsLabel(e.amountCents)}${e.myAmountCents != null ? ` · yours: ${centsLabel(e.myAmountCents)}` : ''}.`,
    };
  }
  if (e.status === 'agreed') return { title: `Agreed: ${t}`, body: 'You both confirmed. Good luck with the job.' };
  if (e.status === 'completed') return { title: `Job done: ${t}`, body: mine ? 'You marked the job done.' : 'The poster marked the job done.' };
  switch (e.outcome) {
    case 'no_bids': return { title: `No bids: ${t}`, body: `Nobody bid before it closed. ${POST_AGAIN}` };
    case 'bidder_no_show':
      return mine
        ? { title: `No contact: ${t}`, body: `The winner didn't make contact in time. ${POST_AGAIN}` }
        : { title: `No-show recorded: ${t}`, body: `You didn't make contact in time. ${NO_FEES_YET}` };
    case 'bidder_backed_out':
      return mine
        ? { title: `The winner gave it back: ${t}`, body: POST_AGAIN }
        : { title: `You gave it back: ${t}`, body: NO_FEES_YET };
    case 'poster_no_show':
      return mine
        ? { title: `Contact window closed: ${t}`, body: `The winner reached out and there was no answer in time. ${POST_AGAIN}` }
        : { title: `No answer: ${t}`, body: "The poster didn't answer in time. Nothing is owed." };
    case 'no_agreement':
      return { title: `No agreement: ${t}`, body: `The contact window closed without an agreement. Nothing is owed.${mine ? ` ${POST_AGAIN}` : ''}` };
    case 'poster_cancelled':
      return mine
        ? { title: `You cancelled: ${t}`, body: `Nothing is owed. ${POST_AGAIN}` }
        : { title: `Cancelled: ${t}`, body: 'The poster cancelled after the award. Nothing is owed.' };
    default:
      return { title: `Ended: ${t}`, body: 'This job has ended.' };
  }
}

/**
 * A local job alert for one person (src/jobs/service.ts publishes the 'job' event). Each kind has its own switch
 * in Settings (alerts.kinds.job_awarded and so on). The dedupe keys make a settlement that runs twice tell
 * nobody twice:
 *   job_awarded   <jobId>:<role>                      one per side
 *   job_message   <jobId>:<messageId>                 one per message
 *                 <jobId>:agreed:<role>               the other side's one-sided "We've agreed": once per side
 *   job_deadline  <jobId>:<contact deadline>          one per award
 *   job_closed    <jobId>:<role>:<status>:<outcome>   one per way the job ended
 */
export function decideJob(e: BusEventOf<'job'>, profile: Profile, plan: Plan, now: Date): AlertDecision | null {
  if (!kindOn(profile, e.kind)) return null;
  const zone = formatFor(alertZone(profile.alerts)).resolvedOptions().timeZone;
  const t = clip(e.title, 60);
  let title: string;
  let body: string;
  let dedupeKey: string;
  switch (e.kind) {
    case 'job_awarded':
      dedupeKey = `${e.jobId}:${e.role}`;
      if (e.role === 'winner') {
        title = `You won: ${t}`;
        body = `Your bid of ${centsLabel(e.amountCents)} was the lowest. Contact the poster by ${whenLabel(e.contactDeadline, zone)} in the job's messages.`;
      } else {
        title = `Bids are in: ${t}`;
        body = `Lowest bid: ${centsLabel(e.amountCents)}. The winner has until ${whenLabel(e.contactDeadline, zone)} to contact you.`;
      }
      break;
    case 'job_message':
      if (e.tap === 'agreed') {
        // Not a message: the other side's one-sided "We've agreed" (src/jobs/service.ts confirmAgreement).
        const other = e.role === 'poster' ? 'The winner' : 'The poster';
        dedupeKey = `${e.jobId}:agreed:${e.role}`;
        title = `${other} tapped “We’ve agreed” · ${t}`;
        body = `${other} tapped “We’ve agreed” on ${t}. If that’s right, open the job and tap it too.`;
        break;
      }
      dedupeKey = `${e.jobId}:${e.messageId ?? 0}`;
      title = `New message · ${t}`;
      body = e.preview ?? '';
      break;
    case 'job_deadline':
      dedupeKey = `${e.jobId}:${e.contactDeadline ?? ''}`;
      title = '2 days left to make contact';
      body = `${t}: message the poster, or tap “We’ve agreed”, by ${whenLabel(e.contactDeadline, zone)}. If not, a no-show is recorded on your profile.`;
      break;
    case 'job_closed':
      dedupeKey = `${e.jobId}:${e.role}:${e.status}:${e.outcome ?? ''}`;
      ({ title, body } = closedCopy(e));
      break;
  }
  return {
    alert: {
      kind: e.kind, bidId: null, dedupeKey,
      title: clip(title, 80), body: clip(body, 200),
      data: { jobId: e.jobId, role: e.role, status: e.status, outcome: e.outcome },
    },
    // Every plan alike: the switch per kind (above), phone alerts off and quiet hours still apply.
    push: pushDecision(profile.alerts, plan, now, 'local'),
  };
}
