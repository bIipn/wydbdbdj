/**
 * The job marketplace's operations: post, bid, withdraw, cancel, repost, message, contacted, confirm, back out,
 * complete, report, and settleDue (the lazy, idempotent settlement every route runs first).
 *
 * Each operation checks its input, then makes its change with ONE conditional statement in src/jobs/repo.ts
 * (the job's state is in the statement's WHERE). When that statement changes nothing, the job moved on under
 * us (closed, settled, someone else's tap) and the answer is read again from the database, never guessed.
 * Decisions (who wins, what a deadline ends as, the fee) come from the pure rules in src/jobs/rules.ts.
 *
 * Alerts go out as 'job' events on the bus (src/realtime turns them into inbox alerts for that person).
 * The time always comes in from the caller (ctx.now() in the routes): nothing here reads the clock.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db.js';
import { upsertMirrorBid } from '../db/repo.js';
import { getWorkProfile } from '../db/work.js';
import { lookupZip } from '../geo/zip.js';
import { LOCAL_JOB_FLAG } from '../sources/flags.js';
import { personCard, type PersonCard } from '../profile/person.js';
import type { Bus, JobEvent } from '../realtime/bus.js';
import { scoreNewBid } from '../scan.js';
import { getTrade } from '../trades/catalog.js';
import type { Bid } from '../types.js';
import { publicRules } from './config.js';
import * as repo from './repo.js';
import type { BidRecord, JobRecord } from './repo.js';
import { contactDeadlineFor, endOfContact, FEE_OUTCOMES, feeLine, formatUsd, pickWinner, type JobRules } from './rules.js';
import { jobStats, sharesJob } from './stats.js';
import { countUnread, retireMessageAlerts } from '../db/alerts.js';
import {
  inThread, tradeLabels, viewConversation, viewJob, viewMessages, type ConversationView, type JobView, type MessageView, type PersonLite,
} from './view.js';

export interface JobsDeps {
  db: Db;
  rules: JobRules;
  /** Public base URL, no trailing slash: the mirrored feed card links to `${appUrl}/?job=<id>`. */
  appUrl: string;
  /** Alerts and the feed's 'match' events. Absent = nobody is told (tests of the rules alone). */
  bus?: Bus;
  log?: (msg: string) => void;
}

// ------------------------------------------------------------- answers --

export interface FieldError {
  path: string;
  message: string;
}

/** Why an operation was refused. src/routes/jobs.ts turns each into its status and body. */
export type Refusal =
  | { error: 'invalid_input'; fields: FieldError[] }
  | { error: 'not_allowed'; message: string }
  | { error: 'not_found' }
  | { error: 'closed'; message: string };

export type Result<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const refuse = <T>(refusal: Refusal): Result<T> => ({ ok: false, refusal });
const invalid = <T>(fields: FieldError[]): Result<T> => refuse({ error: 'invalid_input', fields });
const notAllowed = <T>(message: string): Result<T> => refuse({ error: 'not_allowed', message });
const notFound = <T>(): Result<T> => refuse({ error: 'not_found' });
const closed = <T>(message: string): Result<T> => refuse({ error: 'closed', message });

// --------------------------------------------------------------- input --

export const TITLE = { min: 8, max: 100 };
export const DESCRIPTION = { min: 20, max: 2_000 };
export const MESSAGE = { min: 1, max: 1_000 };
export const NOTE_MAX = 500;
export const REASON = { min: 3, max: 500 };
export const ADDRESS_MAX = 200;
export const MAX_TRADES = 4;
export const CLOSES_IN_DAYS = { min: 1, max: 30 };

const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** Postgres refuses NUL in text, and other control characters have no business in a title. Newlines stay. */
const clean = (s: string): string => s.replace(/\u0000/g, '').replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();

/** A text field: required or optional, within length limits. Pushes a field error and returns null when wrong. */
function text(v: unknown, path: string, what: string, lim: { min: number; max: number }, errors: FieldError[], optional = false): string | null {
  if (v === undefined || v === null || (optional && typeof v === 'string' && v.trim() === '')) {
    if (!optional) errors.push({ path, message: `Add ${what}.` });
    return null;
  }
  if (typeof v !== 'string') {
    errors.push({ path, message: `${what[0]!.toUpperCase()}${what.slice(1)} must be text.` });
    return null;
  }
  const s = clean(v);
  if (s.length < lim.min || s.length > lim.max) {
    errors.push({ path, message: `Use ${lim.min.toLocaleString('en-US')} to ${lim.max.toLocaleString('en-US')} characters for ${what}.` });
    return null;
  }
  return s;
}

/** Whole cents within the limits. */
function cents(v: unknown, path: string, rules: JobRules, errors: FieldError[]): number | null {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    errors.push({ path, message: 'Give the amount in whole cents (for example 15000 for $150.00).' });
    return null;
  }
  if (v < rules.minCents || v > rules.maxCents) {
    errors.push({ path, message: `Use an amount from ${formatUsd(rules.minCents)} to ${formatUsd(rules.maxCents)}.` });
    return null;
  }
  return v;
}

function closesIn(v: unknown, errors: FieldError[]): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < CLOSES_IN_DAYS.min || v > CLOSES_IN_DAYS.max) {
    errors.push({ path: 'closesInDays', message: `Pick how long bids stay open: ${CLOSES_IN_DAYS.min} to ${CLOSES_IN_DAYS.max} days.` });
    return null;
  }
  return v;
}

export interface PostInput {
  title: string;
  description: string;
  trades: string[];
  zip: string;
  address: string | null;
  phone: string | null;
  budgetMaxCents: number | null;
  closesInDays: number;
}

/** Check a POST /api/jobs body. Every problem is reported at once, one plain sentence per field. */
export function validatePost(body: unknown, rules: JobRules): Result<PostInput> {
  const b = record(body);
  const errors: FieldError[] = [];
  const title = text(b.title, 'title', 'a title', TITLE, errors);
  const description = text(b.description, 'description', 'a description', DESCRIPTION, errors);

  let trades: string[] = [];
  if (!Array.isArray(b.trades) || b.trades.length === 0) errors.push({ path: 'trades', message: 'Pick at least one trade.' });
  else if (b.trades.length > MAX_TRADES) errors.push({ path: 'trades', message: `Pick at most ${MAX_TRADES} trades.` });
  else {
    trades = [...new Set(b.trades.map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : '')))];
    const unknown = trades.filter((t) => !getTrade(t));
    if (unknown.length) errors.push({ path: 'trades', message: 'Pick trades from the list.' });
  }

  let zip = '';
  if (typeof b.zip !== 'string' || !lookupZip(b.zip)) errors.push({ path: 'zip', message: 'Enter a 5-digit US ZIP code we know.' });
  else zip = lookupZip(b.zip)!.zip;

  const address = text(b.address, 'address', 'the address', { min: 3, max: ADDRESS_MAX }, errors, true);
  let phone: string | null = null;
  if (b.phone !== undefined && b.phone !== null && !(typeof b.phone === 'string' && b.phone.trim() === '')) {
    const digits = typeof b.phone === 'string' ? b.phone.replace(/\D/g, '') : '';
    if (typeof b.phone !== 'string' || !/^[\d\s()+.-]+$/.test(b.phone.trim()) || digits.length < 7 || digits.length > 15) {
      errors.push({ path: 'phone', message: 'Enter a phone number with 7 to 15 digits, or leave it empty.' });
    } else phone = b.phone.trim();
  }

  let budgetMaxCents: number | null = null;
  if (b.budgetMaxCents !== undefined && b.budgetMaxCents !== null) budgetMaxCents = cents(b.budgetMaxCents, 'budgetMaxCents', rules, errors);
  const days = closesIn(b.closesInDays, errors);

  if (errors.length) return invalid(errors);
  return ok({ title: title!, description: description!, trades, zip, address, phone, budgetMaxCents, closesInDays: days! });
}

// ---------------------------------------------------------------- views --

/** A person's card for someone allowed to see it; until the work-profile card exists, the lite one. */
async function cardFor(db: Db, accountId: string, basics: Map<string, repo.AccountBasics>): Promise<PersonCard | PersonLite> {
  const full = await personCard(db, accountId);
  if (full) return full;
  const b = basics.get(accountId);
  return { id: accountId, name: b?.name ?? 'BidSwipe member', memberSince: b?.memberSince ?? new Date(0).toISOString(), stats: await jobStats(db, accountId) };
}

const lite = (c: PersonCard | PersonLite): PersonLite => ({ id: c.id, name: c.name, memberSince: c.memberSince, stats: c.stats });

/** Everything one viewer may see of a job, read fresh. */
export async function loadView(deps: JobsDeps, job: JobRecord, viewerId: string | null, now: number): Promise<JobView> {
  const { db } = deps;
  const [bids, fees] = await Promise.all([repo.listBids(db, job.id), repo.listFees(db, job.id)]);
  const isPoster = viewerId === job.posterId;
  // Cards of the winner and the bidders are for the poster only: they are not even read for anyone else.
  const people = isPoster ? [...new Set([...(job.winnerId ? [job.winnerId] : []), ...bids.map((b) => b.bidderId)])] : [];
  const basics = await repo.accountBasics(db, [job.posterId, ...people]);
  const cards = new Map<string, PersonCard | PersonLite>();
  for (const id of people) cards.set(id, await cardFor(db, id, basics));
  const poster = lite(await cardFor(db, job.posterId, basics));
  return viewJob({ job, bids, fees, poster, cards }, viewerId, now, publicRules(deps.rules));
}

export async function getJobFor(deps: JobsDeps, jobId: string, viewerId: string | null, now: number): Promise<Result<{ job: JobView; messages: MessageView[] }>> {
  const job = await repo.getJob(deps.db, jobId);
  if (!job) return notFound();
  const messages = viewerId && inThread(job, viewerId) ? viewMessages(await repo.listMessages(deps.db, job.id), job, viewerId) : [];
  return ok({ job: await loadView(deps, job, viewerId, now), messages });
}

export async function myJobs(deps: JobsDeps, accountId: string, now: number): Promise<{ posted: JobView[]; bidding: JobView[] }> {
  const [posted, bidding] = await Promise.all([repo.jobsPostedBy(deps.db, accountId), repo.jobsBidOnBy(deps.db, accountId)]);
  const views = async (jobs: JobRecord[]) => {
    const out: JobView[] = [];
    for (const j of jobs) out.push(await loadView(deps, j, accountId, now));
    return out;
  };
  return { posted: await views(posted), bidding: await views(bidding) };
}

// ------------------------------------------------------------- the feed --

/** The flag on every mirrored card; its one copy lives in src/sources/flags.ts (re-exported for old imports). */
export { LOCAL_JOB_FLAG };

/** An open job as a row of the public-bids feed (contract section 3), so scoring, Browse, deck and alerts just work. */
export function mirrorBid(job: JobRecord, appUrl: string): Bid {
  return {
    id: `local:${job.id}`, source: 'local', sourceId: job.id, sourceName: 'Local job', title: job.title, agency: null,
    description: job.description, category: tradeLabels(job.trades).join(', '),
    location: {
      city: job.city, county: null, state: job.state, zip: job.zip, lat: job.lat, lng: job.lng, precision: 'city',
      label: `${job.city}, ${job.state}`,
    },
    postedAt: new Date(job.postedAt).toISOString(), dueAt: new Date(job.closesAt).toISOString(),
    // The feed's estimate is in dollars (the boards' shape): the budget ceiling, when the poster gave one.
    estValue: job.budgetMaxCents === null ? null : { min: null, max: job.budgetMaxCents / 100 },
    naics: null, setAside: null, url: `${appUrl}/?job=${encodeURIComponent(job.id)}`, flags: [LOCAL_JOB_FLAG], solNumber: null,
  };
}

/**
 * Put a new open job in the feed and score it for everyone it could fit, except its poster. False, and nothing scored,
 * when the job is no longer there: its poster's account was deleted in the same instant (review del-2).
 */
async function publish(deps: JobsDeps, job: JobRecord, now: number): Promise<boolean> {
  const bid = mirrorBid(job, deps.appUrl);
  if (!(await upsertMirrorBid(deps.db, bid, job.id, new Date(now)))) return false;
  const except = await repo.profileIdOf(deps.db, job.posterId);
  const n = await scoreNewBid(deps.db, bid, new Date(now), deps.bus, { exceptProfileId: except });
  deps.log?.(`jobs: ${job.id} posted, scored for ${n} profile(s)`);
  return true;
}

// ------------------------------------------------------------------ post --

export async function postJob(deps: JobsDeps, accountId: string, body: unknown, now: number, repostedFrom: string | null = null): Promise<Result<JobView>> {
  const input = validatePost(body, deps.rules);
  if (!input.ok) return input;
  const v = input.value;
  const place = lookupZip(v.zip)!;
  const job = await repo.insertJob(deps.db, {
    id: randomUUID(), posterId: accountId, title: v.title, description: v.description, trades: v.trades, zip: place.zip,
    city: place.city, state: place.state, lat: place.lat, lng: place.lng, address: v.address, phone: v.phone,
    budgetMaxCents: v.budgetMaxCents, postedAt: now, closesAt: now + v.closesInDays * 86_400_000, repostedFrom,
  });
  // Only a repost can collide (one live repost per job): two taps at once, the second one lands here.
  if (!job) return closed(ALREADY_REPOSTED);
  // The job went with its poster's account, deleted in the same instant: nothing is published, and it is not there.
  if (!(await publish(deps, job, now))) return notFound();
  return ok(await loadView(deps, job, accountId, now));
}

const ALREADY_REPOSTED = 'This job was already posted again. Open the newer post instead.';

/** Post an unfilled or cancelled job again: a new job with the same details and a new closing time. */
export async function repostJob(deps: JobsDeps, accountId: string, jobId: string, body: unknown, now: number): Promise<Result<JobView>> {
  const job = await repo.getJob(deps.db, jobId);
  if (!job) return notFound();
  if (job.posterId !== accountId) return notAllowed('Only the person who posted this job can post it again.');
  if (job.status !== 'unfilled' && job.status !== 'cancelled') return closed('Only a job that ended unfilled or was cancelled can be posted again.');
  // One repost per job, so the same job is never listed twice. To try again after a repost ends, repost that one.
  if (await repo.hasRepost(deps.db, job.id)) return closed(ALREADY_REPOSTED);
  const errors: FieldError[] = [];
  const days = closesIn(record(body).closesInDays, errors);
  if (errors.length) return invalid(errors);
  return postJob(deps, accountId, {
    title: job.title, description: job.description, trades: job.trades, zip: job.zip, address: job.address, phone: job.phone,
    budgetMaxCents: job.budgetMaxCents, closesInDays: days,
  }, now, job.id);
}

// ------------------------------------------------------------------ bids --

export async function placeBid(deps: JobsDeps, accountId: string, jobId: string, body: unknown, now: number): Promise<Result<JobView>> {
  const job = await repo.getJob(deps.db, jobId);
  if (!job) return notFound();
  if (job.posterId === accountId) return notAllowed("You can't bid on your own job.");
  // "Get work done" posts only (CLAUDE.md, the Jobs screen hides bidding for it): the server says so too (audit
  // authz-1). Only intent 'hire' is refused: 'both' bids, and an account with no stored work profile reads as
  // 'work' (getWorkProfile's default), so accounts from before the marketplace keep bidding.
  if ((await getWorkProfile(deps.db, accountId)).intent === 'hire') {
    return notAllowed('To bid, pick “Both” in Settings and add your trade.');
  }
  if (job.status !== 'open' || now >= job.closesAt) return closed('Bidding on this job has closed.');

  const b = record(body);
  const errors: FieldError[] = [];
  const amount = cents(b.amountCents, 'amountCents', deps.rules, errors);
  if (amount !== null && job.budgetMaxCents !== null && amount > job.budgetMaxCents) {
    errors.push({ path: 'amountCents', message: `Your bid is above the poster's budget of ${formatUsd(job.budgetMaxCents)}.` });
  }
  const note = text(b.note, 'note', 'the note', { min: 1, max: NOTE_MAX }, errors, true);
  if (b.agree !== true) errors.push({ path: 'agree', message: 'Tick the box to agree to the rules before you bid.' });
  if (errors.length) return invalid(errors);

  const placed = await repo.placeBid(deps.db, { jobId, bidderId: accountId, amountCents: amount!, note }, now);
  if (!placed) {
    // The statement wrote nothing: the job closed (or was taken down) between the read and the write.
    const again = await repo.getJob(deps.db, jobId);
    return again ? closed('Bidding on this job has closed.') : notFound();
  }
  return ok(await loadView(deps, job, accountId, now));
}

export async function withdrawBid(deps: JobsDeps, accountId: string, jobId: string, now: number): Promise<Result<JobView>> {
  const job = await repo.getJob(deps.db, jobId);
  if (!job) return notFound();
  if (job.status !== 'open' || now >= job.closesAt) return closed('Bidding on this job has closed. A bid can only be withdrawn while it is open.');
  const done = await repo.withdrawBid(deps.db, jobId, accountId, now);
  if (!done) {
    const mine = await repo.getMyBid(deps.db, jobId, accountId);
    if (!mine || mine.status === 'withdrawn') return notAllowed('You have no bid on this job to withdraw.');
    return closed('Bidding on this job has closed. A bid can only be withdrawn while it is open.');
  }
  return ok(await loadView(deps, job, accountId, now));
}

// ---------------------------------------------------------------- alerts --

type JobFacts = Omit<JobEvent, 'type' | 'kind' | 'accountId' | 'role' | 'myAmountCents'>;

const facts = (job: JobRecord): JobFacts => ({
  jobId: job.id, title: job.title, status: job.status, outcome: job.outcome, amountCents: job.awardCents,
  contactDeadline: job.contactDeadline === null ? null : new Date(job.contactDeadline).toISOString(),
});

async function tell(deps: JobsDeps, events: JobEvent[]): Promise<void> {
  if (!deps.bus) return;
  for (const e of events) await deps.bus.emit(e);
}

/** "The job ended": both sides (the poster, and the winner when there is one). */
const endedEvents = (job: JobRecord): JobEvent[] => [
  { type: 'job', kind: 'job_closed', accountId: job.posterId, role: 'poster', ...facts(job) },
  ...(job.winnerId ? [{ type: 'job' as const, kind: 'job_closed' as const, accountId: job.winnerId, role: 'winner' as const, ...facts(job) }] : []),
];

// ----------------------------------------------------------- settlement --

/** How many races a settlement step retries before leaving the job for the next call. */
const RETRIES = 3;

/** Close one open job whose closing time has passed. True when this call did it. */
async function closeOne(deps: JobsDeps, jobId: string, now: number): Promise<boolean> {
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const job = await repo.getJob(deps.db, jobId);
    if (!job || job.status !== 'open' || now < job.closesAt) return false;
    const bids = await repo.listBids(deps.db, jobId);
    const winner = pickWinner(bids);
    const deadline = winner ? contactDeadlineFor(job.closesAt, deps.rules.contactDays) : null;
    const done = await repo.closeJob(deps.db, jobId, { winner, awardedAt: job.closesAt, contactDeadline: deadline, endedAt: winner ? null : job.closesAt }, now);
    if (!done) continue; // a bid changed or another settlement got there first: read again
    await repo.closeMirror(deps.db, jobId, now);
    const events: JobEvent[] = [];
    if (winner) {
      events.push({ type: 'job', kind: 'job_awarded', accountId: done.posterId, role: 'poster', ...facts(done) });
      events.push({ type: 'job', kind: 'job_awarded', accountId: winner.bidderId, role: 'winner', ...facts(done) });
      for (const b of bids) {
        if (b.status === 'active' && b.id !== winner.id) {
          events.push({ type: 'job', kind: 'job_closed', accountId: b.bidderId, role: 'bidder', myAmountCents: b.amountCents, ...facts(done) });
        }
      }
    } else {
      events.push({ type: 'job', kind: 'job_closed', accountId: done.posterId, role: 'poster', ...facts(done) });
    }
    await tell(deps, events);
    return true;
  }
  return false;
}

/** End one awarded job whose contact deadline has passed. True when this call did it. */
async function endOne(deps: JobsDeps, jobId: string, now: number): Promise<boolean> {
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const job = await repo.getJob(deps.db, jobId);
    if (!job || job.status !== 'awarded' || job.contactDeadline === null || now < job.contactDeadline) return false;
    const outcome = endOfContact(job);
    const fee = FEE_OUTCOMES.has(outcome) ? feeLine('no_show', job.awardCents ?? 0, deps.rules) : null;
    const done = await repo.endContact(deps.db, job, outcome, fee, now);
    if (!done) continue;
    await tell(deps, endedEvents(done));
    return true;
  }
  return false;
}

/**
 * Everything that is due: every open job past its closing time is awarded (or ends 'no_bids'), then every
 * awarded job past its contact deadline ends as the rules say. There are no timers on a serverless host, so
 * every jobs route calls this first, and so does the alert rules' tick (GET /api/cron/tick). Running it twice
 * changes nothing: each step is a conditional UPDATE that only the first caller gets a row back from.
 */
export async function settleDue(deps: JobsDeps, now: number): Promise<{ closed: number; ended: number }> {
  let closedN = 0;
  let endedN = 0;
  for (const id of await repo.openJobsDue(deps.db, now)) if (await closeOne(deps, id, now)) closedN++;
  for (const id of await repo.awardedJobsDue(deps.db, now)) if (await endOne(deps, id, now)) endedN++;
  if (closedN || endedN) deps.log?.(`jobs: settled ${closedN} closing(s), ${endedN} contact deadline(s)`);
  return { closed: closedN, ended: endedN };
}

/** The 2-days-left reminder for winners who have not made contact (alert dedupe makes repeats silent). */
export async function remindContact(deps: JobsDeps, now: number): Promise<number> {
  const due = await repo.awardedWithoutContact(deps.db, now, 48);
  await tell(deps, due.filter((j) => j.winnerId).map((j) => ({ type: 'job' as const, kind: 'job_deadline' as const, accountId: j.winnerId!, role: 'winner' as const, ...facts(j) })));
  return due.length;
}

// ------------------------------------------------------- after the award --

/** Poster cancels: free while open (bids closed as lost); after the award it ends unfilled, nobody owes anything. */
export async function cancelJob(deps: JobsDeps, accountId: string, jobId: string, now: number): Promise<Result<JobView>> {
  const job = await repo.getJob(deps.db, jobId);
  if (!job) return notFound();
  if (job.posterId !== accountId) return notAllowed('Only the person who posted this job can cancel it.');
  if (job.status === 'open') {
    const bids = await repo.listBids(deps.db, jobId);
    const done = await repo.cancelOpenJob(deps.db, jobId, accountId, now);
    if (!done) return closed('This job has already closed.');
    await repo.closeMirror(deps.db, jobId, now);
    await tell(deps, bids.filter((b) => b.status === 'active')
      .map((b) => ({ type: 'job' as const, kind: 'job_closed' as const, accountId: b.bidderId, role: 'bidder' as const, ...facts(done) })));
    return ok(await loadView(deps, done, accountId, now));
  }
  if (job.status === 'awarded') {
    const done = await repo.cancelAwardedJob(deps.db, jobId, accountId, now);
    if (!done) return closed('This job has already ended.');
    await tell(deps, endedEvents(done));
    return ok(await loadView(deps, done, accountId, now));
  }
  return closed('This job has already ended.');
}

/** The poster or the winner, or 404 when the job is gone. */
async function partyJob(deps: JobsDeps, jobId: string): Promise<JobRecord | null> {
  return repo.getJob(deps.db, jobId);
}

export async function sendMessage(deps: JobsDeps, accountId: string, jobId: string, body: unknown, now: number): Promise<Result<MessageView>> {
  const job = await partyJob(deps, jobId);
  if (!job) return notFound();
  if (!inThread(job, accountId)) return notAllowed('Messages are only between the poster and the winner, after the award.');
  const errors: FieldError[] = [];
  const text1 = text(record(body).body, 'body', 'the message', MESSAGE, errors);
  if (errors.length) return invalid(errors);
  const msg = await repo.insertMessage(deps.db, jobId, accountId, text1!, now);
  if (!msg) return closed('The contact window for this job has closed.');
  const other = accountId === job.posterId ? job.winnerId : job.posterId;
  if (other) {
    await tell(deps, [{
      type: 'job', kind: 'job_message', accountId: other, role: other === job.posterId ? 'poster' : 'winner', ...facts(job),
      messageId: msg.id, preview: text1!.slice(0, 200),
    }]);
  }
  return ok(viewMessages([msg], job, accountId)[0]!);
}

// -------------------------------------------------------- conversations --
// The Messages tab: the same threads as the job page, listed. Who may read and write them does not change here
// (view.ts inThread; repo.insertMessage's WHERE is the only gate for writing).

/** The other side as the job page shows them to this viewer: the winner's card for the poster, the poster's lite card for the winner. */
async function otherSide(db: Db, job: JobRecord, viewerId: string, basics: Map<string, repo.AccountBasics>): Promise<PersonCard | PersonLite> {
  if (viewerId === job.posterId) return cardFor(db, job.winnerId!, basics);
  return lite(await cardFor(db, job.posterId, basics));
}

/**
 * The viewer's conversations, newest activity first, and how many have something unread. A job whose thread can no
 * longer be written and never had a message (it ended in silence) is left out: there is nothing to read.
 */
export async function conversations(deps: JobsDeps, accountId: string, now: number): Promise<{ conversations: ConversationView[]; unread: number }> {
  const { db } = deps;
  const rows = (await repo.conversationsFor(db, accountId)).filter((r) => inThread(r.job, accountId));
  const basics = await repo.accountBasics(db, rows.flatMap((r) => [r.job.posterId, r.job.winnerId!]));
  const out: ConversationView[] = [];
  for (const r of rows) {
    const v = viewConversation({ ...r, other: await otherSide(db, r.job, accountId, basics) }, accountId, now);
    if (v.messageCount > 0 || v.canWrite) out.push(v);
  }
  return { conversations: out, unread: out.filter((c) => c.unread).length };
}

/** One conversation and its messages, for its poster or its winner. Reading changes nothing (POST …/read does). */
export async function conversationFor(
  deps: JobsDeps, accountId: string, jobId: string, now: number,
): Promise<Result<{ conversation: ConversationView; messages: MessageView[] }>> {
  const job = await repo.getJob(deps.db, jobId);
  if (!job) return notFound();
  if (!inThread(job, accountId)) return notAllowed('Messages are only between the poster and the winner, after the award.');
  const one = (await repo.conversationsFor(deps.db, accountId)).find((r) => r.job.id === jobId);
  if (!one) return notFound();
  const basics = await repo.accountBasics(deps.db, [job.posterId, job.winnerId!]);
  const conversation = viewConversation({ ...one, other: await otherSide(deps.db, one.job, accountId, basics) }, accountId, now);
  return ok({ conversation, messages: viewMessages(await repo.listMessages(deps.db, jobId), one.job, accountId) });
}

/**
 * The viewer opened the conversation: it is read up to its newest message, and the bell's "New message" alerts for
 * those messages are retired with it, so nothing is counted as new twice. Answers the bell's new unread count.
 */
export async function readConversation(
  deps: JobsDeps, accountId: string, jobId: string, body: unknown, now: number,
): Promise<Result<{ readUpTo: number; alertsRetired: number; alertsUnread: number | null }>> {
  const job = await repo.getJob(deps.db, jobId);
  if (!job) return notFound();
  if (!inThread(job, accountId)) return notAllowed('Messages are only between the poster and the winner, after the award.');
  // upTo: the newest message id the screen showed (optional). Anything else is a bad request, not a guess.
  // A body that is there but is not a plain object (an array, a bare string) is a bad request too: it must
  // never read as "no upTo", which would mark every stored message read.
  if (body != null && (typeof body !== 'object' || Array.isArray(body))) {
    return invalid([{ path: 'upTo', message: 'Send {"upTo": <message id>} or nothing.' }]);
  }
  const raw = body == null ? undefined : record(body).upTo;
  if (raw !== undefined && raw !== null && !(Number.isSafeInteger(raw) && (raw as number) >= 0)) {
    return invalid([{ path: 'upTo', message: 'upTo must be a message id (a whole number).' }]);
  }
  const upTo = await repo.markConversationRead(deps.db, jobId, accountId, typeof raw === 'number' ? raw : null);
  if (upTo === null) return notFound();
  const profileId = await repo.profileIdOf(deps.db, accountId);
  const retired = profileId ? await retireMessageAlerts(deps.db, profileId, jobId, upTo, new Date(now)) : 0;
  return ok({ readUpTo: upTo, alertsRetired: retired, alertsUnread: profileId ? await countUnread(deps.db, profileId) : null });
}

export async function markContacted(deps: JobsDeps, accountId: string, jobId: string, now: number): Promise<Result<JobView>> {
  const job = await partyJob(deps, jobId);
  if (!job) return notFound();
  if (job.posterId !== accountId) return notAllowed('Only the poster can say they were contacted.');
  if (job.status !== 'awarded') return closed('This only works while the winner has time to make contact.');
  const done = await repo.tapContacted(deps.db, jobId, accountId, now);
  if (!done) return closed('The contact window for this job has closed.');
  return ok(await loadView(deps, done, accountId, now));
}

export async function confirmAgreement(deps: JobsDeps, accountId: string, jobId: string, now: number): Promise<Result<JobView>> {
  const job = await partyJob(deps, jobId);
  if (!job) return notFound();
  const side = job.posterId === accountId ? 'poster' : job.winnerId === accountId && job.awardCents !== null ? 'winner' : null;
  if (!side) return notAllowed('Only the poster and the winner can confirm an agreement.');
  if (job.status !== 'awarded' || job.awardCents === null) return closed('This job is not waiting for an agreement.');
  const done = await repo.confirm(deps.db, jobId, side, accountId, (basis) => feeLine('service', basis, deps.rules), job.awardCents, now);
  if (!done) return closed('The contact window for this job has closed.');
  if (done.status === 'agreed') {
    await tell(deps, endedEvents(done));
  } else {
    // A one-sided "We've agreed": tell the other side once, so they know to tap it too (the dedupe key
    // <jobId>:agreed:<role> keeps a second tap, or two at once, from telling them again).
    // The row is read again first: the other side may have tapped in the same instant and completed the agreement
    // (src/realtime/index.ts onJob checks once more when it builds the alert).
    const tapped = side === 'poster' ? job.posterConfirmedAt : job.bidderConfirmedAt;
    const other = side === 'poster' ? done.winnerId : done.posterId;
    const now2 = await repo.getJob(deps.db, jobId);
    const otherTapped = side === 'poster' ? now2?.bidderConfirmedAt : now2?.posterConfirmedAt;
    if (tapped === null && other && now2?.status === 'awarded' && otherTapped == null) {
      await tell(deps, [{ type: 'job', kind: 'job_message', accountId: other, role: side === 'poster' ? 'winner' : 'poster', ...facts(done), tap: 'agreed' }]);
    }
  }
  return ok(await loadView(deps, done, accountId, now));
}

export async function backOutOfJob(deps: JobsDeps, accountId: string, jobId: string, now: number): Promise<Result<JobView>> {
  const job = await partyJob(deps, jobId);
  if (!job) return notFound();
  if (job.winnerId !== accountId || job.awardCents === null) return notAllowed('Only the winner can give the job back.');
  if (job.status !== 'awarded') return closed('This job is no longer waiting on you.');
  const done = await repo.backOut(deps.db, jobId, accountId, feeLine('no_show', job.awardCents, deps.rules), now);
  if (!done) return closed('The contact window for this job has closed.');
  await tell(deps, endedEvents(done));
  return ok(await loadView(deps, done, accountId, now));
}

export async function completeJob(deps: JobsDeps, accountId: string, jobId: string, now: number): Promise<Result<JobView>> {
  const job = await partyJob(deps, jobId);
  if (!job) return notFound();
  if (job.posterId !== accountId) return notAllowed('Only the poster can mark the job done.');
  if (job.status !== 'agreed') return closed('Only an agreed job can be marked done.');
  const done = await repo.completeJob(deps.db, jobId, accountId, now);
  if (!done) return closed('Only an agreed job can be marked done.');
  await tell(deps, endedEvents(done));
  return ok(await loadView(deps, done, accountId, now));
}

// ------------------------------------------------------------- safety --

export async function reportJob(deps: JobsDeps, accountId: string, jobId: string, body: unknown, now: number): Promise<Result<{ ok: true }>> {
  const job = await repo.getJob(deps.db, jobId);
  if (!job) return notFound();
  const errors: FieldError[] = [];
  const reason = text(record(body).reason, 'reason', 'a reason', REASON, errors);
  if (errors.length) return invalid(errors);
  const saved = await repo.upsertReport(deps.db, jobId, accountId, reason!, now);
  return saved ? ok({ ok: true }) : notFound();
}

// ------------------------------------------- reporting what people write --
// A conversation (one job's thread) and a person's card. Rules (docs/MARKETPLACE.md "Reports"): only someone who may
// see the thing may report it; nobody else gets a different answer than they get on that thing's own route; a
// report tells the reported side nothing and changes nothing on the job (it is not contact); one open report per
// reporter and target, and a second one is a kind "already" (200), not an error.

/** Why someone reports a conversation. The screen's labels are in web/js/job-words.js REPORT_REASONS. */
export const CONVERSATION_REPORT_REASONS = ['abusive', 'spam', 'off_platform', 'other'] as const;
/** Why someone reports a card. */
export const PROFILE_REPORT_REASONS = ['misleading', 'offensive', 'spam', 'other'] as const;
export const REPORT_NOTE_MAX = 500;
/** The reporter's confirmation. Honest: the report is stored for BidSwipe; no promise of who reads it or how fast
 *  (that is the owner's to make, review rs-3). */
export const REPORT_THANKS = 'Thanks. Your report was sent to BidSwipe.';
export const REPORT_ALREADY = 'You already reported this. It was sent to BidSwipe.';
const THREAD_ONLY = 'Messages are only between the poster and the winner, after the award.';

export interface ReportAnswer {
  ok: true;
  /** true = this person already had an open report on it; nothing new was stored. */
  already: boolean;
  message: string;
}

function reportInput(body: unknown, reasons: readonly string[]): Result<{ reason: string; note: string | null }> {
  const b = record(body);
  const errors: FieldError[] = [];
  const reason = typeof b.reason === 'string' && reasons.includes(b.reason) ? b.reason : null;
  if (!reason) errors.push({ path: 'reason', message: 'Pick a reason from the list.' });
  const note = text(b.note, 'note', 'the note', { min: 1, max: REPORT_NOTE_MAX }, errors, true);
  if (errors.length) return invalid(errors);
  return ok({ reason: reason!, note });
}

const reported = (already: boolean): Result<ReportAnswer> => ok({ ok: true, already, message: already ? REPORT_ALREADY : REPORT_THANKS });

/** Report a job's thread: its poster or its winner only (view.ts inThread), with the thread routes' own refusals. */
export async function reportConversation(deps: JobsDeps, accountId: string, jobId: string, body: unknown, now: number): Promise<Result<ReportAnswer>> {
  const job = await repo.getJob(deps.db, jobId);
  if (!job) return notFound();
  if (!inThread(job, accountId)) return notAllowed(THREAD_ONLY);
  const input = reportInput(body, CONVERSATION_REPORT_REASONS);
  if (!input.ok) return input;
  if (await repo.insertConversationReport(deps.db, jobId, accountId, input.value.reason, input.value.note, now)) {
    deps.log?.(`jobs: a conversation was reported (${input.value.reason})`);
    return reported(false);
  }
  if (await repo.hasOpenContentReport(deps.db, 'conversation', jobId, accountId)) return reported(true);
  return notFound(); // taken down between the read and the write
}

/**
 * Report a person's card: only someone allowed to see it (GET /api/people/:id: they dealt with each other on a job,
 * src/jobs/stats.ts sharesJob), never one's own. Anyone else gets that route's 404, so a report cannot probe for ids.
 */
export async function reportPerson(deps: JobsDeps, accountId: string, personId: string, body: unknown, now: number): Promise<Result<ReportAnswer>> {
  if (personId === accountId || !(await sharesJob(deps.db, accountId, personId))) return notFound();
  const input = reportInput(body, PROFILE_REPORT_REASONS);
  if (!input.ok) return input;
  if (await repo.insertProfileReport(deps.db, personId, accountId, input.value.reason, input.value.note, now)) {
    deps.log?.(`jobs: a profile was reported (${input.value.reason})`);
    return reported(false);
  }
  if (await repo.hasOpenContentReport(deps.db, 'profile', personId, accountId)) return reported(true);
  return notFound();
}

/** One report as an operator sees it: what was reported, with what they need to judge it. Never shown to a user. */
export type ContentReportView = Omit<repo.ContentReportRecord, 'posterId'> & {
  /** conversation: who reported it, on that job. */
  reporterRole: 'poster' | 'winner' | null;
  /** conversation: the whole thread (a removed message's text is not here either). */
  messages: Array<{ id: number; from: 'poster' | 'winner'; senderId: string; body: string; at: string; removed: boolean }> | null;
  /** profile: the card with its text even when hidden, and whether it is hidden now. */
  card: PersonCard | null;
  hidden: boolean | null;
};

export async function contentReports(deps: JobsDeps): Promise<ContentReportView[]> {
  const out: ContentReportView[] = [];
  for (const r of await repo.listContentReports(deps.db)) {
    const { posterId, ...rest } = r;
    if (r.kind === 'conversation') {
      const msgs = r.jobId ? await repo.listMessages(deps.db, r.jobId) : [];
      out.push({
        ...rest, reporterRole: posterId === null ? null : r.reporterId === posterId ? 'poster' : 'winner',
        messages: msgs.map((m) => ({
          id: m.id, from: m.senderId === posterId ? 'poster' : 'winner', senderId: m.senderId, body: m.removed ? '' : m.body,
          at: new Date(m.createdAt).toISOString(), removed: m.removed,
        })),
        card: null, hidden: null,
      });
    } else {
      const card = await personCard(deps.db, r.subjectId, { forOperator: true });
      out.push({ ...rest, reporterRole: null, messages: null, card, hidden: card?.hidden ?? null });
    }
  }
  return out;
}

/** Operator: remove one message (repo.removeMessage). Nothing else about the job moves. */
export async function removeMessage(deps: JobsDeps, messageId: number, now: number): Promise<boolean> {
  const done = await repo.removeMessage(deps.db, messageId, now);
  if (done) deps.log?.(`jobs: message ${done.id} on ${done.jobId} removed by an operator`);
  return done !== null;
}

/** Operator: hide or show again a person's card. false = no such account. */
export async function setPersonHidden(deps: JobsDeps, accountId: string, hidden: boolean, now: number): Promise<{ hidden: boolean; hiddenAt: string | null } | null> {
  const at = await repo.setProfileHidden(deps.db, accountId, hidden, now);
  if (at === undefined) return null;
  deps.log?.(`jobs: a profile was ${hidden ? 'hidden' : 'shown again'} by an operator`);
  return { hidden: at !== null, hiddenAt: at === null ? null : new Date(at).toISOString() };
}

/** Operator: take a job down. It leaves every feed and answers 404 to everyone. */
export async function removeJob(deps: JobsDeps, jobId: string, now: number): Promise<boolean> {
  const done = await repo.removeJob(deps.db, jobId, now);
  if (!done) return false;
  await repo.closeMirror(deps.db, jobId, now, true);
  deps.log?.(`jobs: ${jobId} removed by an operator`);
  return true;
}

export type { BidRecord };
