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
import { upsertBids } from '../db/repo.js';
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
import { jobStats } from './stats.js';
import { inThread, tradeLabels, viewJob, viewMessages, type JobView, type MessageView, type PersonLite } from './view.js';

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

/** What is left of a job whose poster deleted their account, as the person who was waiting on it is shown it. */
export interface GoneJob {
  id: string;
  title: string;
  /** Who this person was on it: the winner of an awarded or agreed job, or someone with a sealed bid on an open one. */
  role: 'winner' | 'bidder';
  was: 'open' | 'awarded' | 'agreed';
  /** Their own bid on it. */
  amountCents: number | null;
  /** A service fee that was on record for them and was waived, so they owe nothing. */
  feeWaivedCents: number | null;
  endedAt: string;
}

/** Why an operation was refused. src/routes/jobs.ts turns each into its status and body. */
export type Refusal =
  | { error: 'invalid_input'; fields: FieldError[] }
  | { error: 'not_allowed'; message: string }
  | { error: 'not_found' }
  | { error: 'closed'; message: string }
  /** The job's poster deleted their account and this person was waiting on it (410): the one line they are left. */
  | { error: 'gone'; message: string; gone: GoneJob };

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

const goneJob = (t: repo.Tombstone): GoneJob => ({
  id: t.jobId, title: t.title, role: t.role, was: t.was, amountCents: t.amountCents, feeWaivedCents: t.feeWaivedCents,
  endedAt: new Date(t.endedAt).toISOString(),
});

/** The sentence for someone left waiting on a job whose poster deleted their account. Nobody owes anything. */
export function goneWords(g: Pick<GoneJob, 'role' | 'was' | 'feeWaivedCents'>): string {
  if (g.role === 'bidder') return 'The person who posted this job deleted their BidSwipe account before bidding closed. The job was taken down and your sealed bid is closed.';
  const waived = g.feeWaivedCents ? ` The service fee of ${formatUsd(g.feeWaivedCents)} that was recorded for you was waived.` : '';
  return `The person who posted this job deleted their BidSwipe account, so the job ended here. You owe nothing.${waived}`;
}

export async function getJobFor(deps: JobsDeps, jobId: string, viewerId: string | null, now: number): Promise<Result<{ job: JobView; messages: MessageView[] }>> {
  const job = await repo.getJob(deps.db, jobId);
  if (!job) {
    // Gone with its poster's account? The people who were waiting on it get one line; everyone else a plain 404.
    const left = viewerId ? await repo.getTombstone(deps.db, jobId, viewerId) : null;
    if (!left) return notFound();
    const gone = goneJob(left);
    return refuse({ error: 'gone', message: goneWords(gone), gone });
  }
  const messages = viewerId && inThread(job, viewerId) ? viewMessages(await repo.listMessages(deps.db, job.id), job, viewerId) : [];
  return ok({ job: await loadView(deps, job, viewerId, now), messages });
}

/**
 * `ended`: jobs this person was waiting on (won, or had a sealed bid on) whose poster deleted their account. The
 * job rows are gone, so these are not Jobs: each is the one line that is left (GoneJob), newest first.
 */
export async function myJobs(deps: JobsDeps, accountId: string, now: number): Promise<{ posted: JobView[]; bidding: JobView[]; ended: GoneJob[] }> {
  const [posted, bidding, left] = await Promise.all([
    repo.jobsPostedBy(deps.db, accountId), repo.jobsBidOnBy(deps.db, accountId), repo.tombstonesFor(deps.db, accountId),
  ]);
  const views = async (jobs: JobRecord[]) => {
    const out: JobView[] = [];
    for (const j of jobs) out.push(await loadView(deps, j, accountId, now));
    return out;
  };
  return { posted: await views(posted), bidding: await views(bidding), ended: left.map(goneJob) };
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

/** Put a new open job in the feed and score it for everyone it could fit, except its poster. */
async function publish(deps: JobsDeps, job: JobRecord, now: number): Promise<void> {
  const bid = mirrorBid(job, deps.appUrl);
  await upsertBids(deps.db, [bid], new Date(now));
  const except = await repo.profileIdOf(deps.db, job.posterId);
  const n = await scoreNewBid(deps.db, bid, new Date(now), deps.bus, { exceptProfileId: except });
  deps.log?.(`jobs: ${job.id} posted, scored for ${n} profile(s)`);
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
  await publish(deps, job, now);
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
    const tapped = side === 'poster' ? job.posterConfirmedAt : job.bidderConfirmedAt;
    const other = side === 'poster' ? done.winnerId : done.posterId;
    if (tapped === null && other) {
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

// ---------------------------------------------------- account deletion --

/** What deleting this account would end, for the "Delete my account" screen. Changes nothing. */
export function deletionPreview(deps: JobsDeps, accountId: string): Promise<repo.DeletionPreview> {
  return repo.deletionPreview(deps.db, accountId);
}

/**
 * Delete an account for good. The caller has already made sure it is the owner asking (src/routes/account.ts
 * asks for the password again) and has run settleDue, so nothing that was due is ended by the deletion instead.
 *
 * One statement does all of it (repo.deleteAccount). What it means for the people on the other side of a job:
 *   - a live job the account had WON goes back to its poster: unfilled / 'bidder_left', nothing owed, post it again;
 *   - a live job the account had POSTED is gone: its winner (or each sealed bidder of an open one) is left one line
 *     (GET /api/jobs/:id answers 410 'gone' to them) and owes nothing; a service fee already on record is waived.
 * Deleting an account never records a new fee: leaving is not a no-show. The fee lines the account already owed
 * stay in the ledger without it (payer_id null, the name kept).
 * Then each of those people is told once, like any other ending. Returns false when there was no such account.
 */
export async function deleteAccount(deps: JobsDeps, accountId: string, now: number): Promise<boolean> {
  const done = await repo.deleteAccount(deps.db, accountId, now);
  if (!done.deleted) return false;
  deps.log?.(`account deleted: ${done.jobsRemoved} job(s) and ${done.mirrorsRemoved} feed row(s) removed, ${done.wonEnded.length} won job(s) handed back, `
    + `${done.leftBehind.length} person(s) left a line, ${done.feesKept} fee line(s) kept, ${done.feesWaived} waived`);
  const events: JobEvent[] = [];
  for (const w of done.wonEnded) {
    events.push({
      type: 'job', kind: 'job_closed', accountId: w.posterId, role: 'poster', jobId: w.jobId, title: w.title, status: 'unfilled',
      outcome: 'bidder_left', amountCents: w.awardCents, contactDeadline: w.contactDeadline === null ? null : new Date(w.contactDeadline).toISOString(),
    });
  }
  for (const t of done.leftBehind) {
    events.push({
      type: 'job', kind: 'job_closed', accountId: t.accountId, role: t.role, jobId: t.jobId, title: t.title,
      // 'poster_left' is never a stored outcome (the job row is gone): it only words this one alert.
      status: t.role === 'winner' ? 'unfilled' : 'cancelled', outcome: 'poster_left',
      amountCents: t.role === 'winner' ? t.amountCents : null, myAmountCents: t.amountCents, contactDeadline: null,
    });
  }
  await tell(deps, events);
  return true;
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

/** Operator: take a job down. It leaves every feed and answers 404 to everyone. */
export async function removeJob(deps: JobsDeps, jobId: string, now: number): Promise<boolean> {
  const done = await repo.removeJob(deps.db, jobId, now);
  if (!done) return false;
  await repo.closeMirror(deps.db, jobId, now, true);
  deps.log?.(`jobs: ${jobId} removed by an operator`);
  return true;
}

export type { BidRecord };
