/**
 * The marketplace's rules as pure functions: who wins, what an awarded job becomes at its contact deadline,
 * and how a fee splits. No database, no clock of its own (every function that needs the time is handed it),
 * no network. src/jobs/service.ts reads the rows, asks these functions, and writes the answer with a
 * conditional UPDATE, so the decision table here is the whole behaviour (test/jobs-rules.test.ts).
 *
 * Money is integer cents, rates are parts per million (5% = 50_000), products are BigInt and rounded ONCE,
 * half up — the same style as the cost engine (src/cost/money.ts).
 */
import { divRoundHalfUp } from '../cost/money.js';

export type JobStatus = 'open' | 'awarded' | 'agreed' | 'completed' | 'unfilled' | 'cancelled';
export type JobOutcome = 'no_bids' | 'bidder_no_show' | 'bidder_backed_out' | 'poster_no_show' | 'no_agreement' | 'poster_cancelled';
export type BidStatus = 'active' | 'won' | 'lost' | 'withdrawn' | 'defaulted';
export type FeeKind = 'no_show' | 'service';

export const JOB_STATUSES: readonly JobStatus[] = ['open', 'awarded', 'agreed', 'completed', 'unfilled', 'cancelled'];

/** The settings (src/jobs/config.ts reads them from the environment and checks their limits). */
export interface JobRules {
  /** What a winner who never made contact, or gave the job back, owes: 5% = 50_000. */
  noShowFeePpm: number;
  /** The part of that fee that goes to the poster whose time was wasted: 2% of the bid = 20_000. */
  posterSharePpm: number;
  /** What the winner owes when both sides confirm an agreement: 1% = 10_000. */
  serviceFeePpm: number;
  /** Days the winner has from the award to make contact and work it out. */
  contactDays: number;
  /** Smallest bid or budget, in cents ($20.00 = 2_000). */
  minCents: number;
  /** Largest bid or budget, in cents. */
  maxCents: number;
}

export const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- money --

const PPM = 1_000_000;

/** cents × ppm / 1,000,000, rounded half up, once. Throws on anything that is not a non-negative safe integer. */
export function applyRate(cents: number, ratePpm: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError(`cents must be a non-negative safe integer, got ${cents}`);
  if (!Number.isSafeInteger(ratePpm) || ratePpm < 0) throw new RangeError(`rate must be a non-negative integer ppm, got ${ratePpm}`);
  return Number(divRoundHalfUp(BigInt(cents) * BigInt(ratePpm), BigInt(PPM)));
}

/** One fee as it is written to the ledger (job_fees): every input kept, so it can be worked out again. */
export interface FeeLine {
  kind: FeeKind;
  basisCents: number;
  ratePpm: number;
  amountCents: number;
  posterSharePpm: number;
  posterShareCents: number;
  platformCents: number;
}

/**
 * The fee on a winning bid. no_show: the no-show rate, of which the poster's share goes to the poster and
 * BidSwipe keeps the rest. service: the service rate, all BidSwipe's (the poster lost nothing).
 * Each share is its own rounding of the bid (never a share of a rounded fee), and the platform part is the
 * difference, so poster + platform = fee exactly. The poster's rate never exceeds the fee's rate
 * (config.ts refuses it), so the platform part is never negative.
 */
export function feeLine(kind: FeeKind, basisCents: number, rules: Pick<JobRules, 'noShowFeePpm' | 'posterSharePpm' | 'serviceFeePpm'>): FeeLine {
  const ratePpm = kind === 'no_show' ? rules.noShowFeePpm : rules.serviceFeePpm;
  const posterSharePpm = kind === 'no_show' ? Math.min(rules.posterSharePpm, ratePpm) : 0;
  const amountCents = applyRate(basisCents, ratePpm);
  const posterShareCents = applyRate(basisCents, posterSharePpm);
  return { kind, basisCents, ratePpm, amountCents, posterSharePpm, posterShareCents, platformCents: amountCents - posterShareCents };
}

/** "$1,234.56" from integer cents, without floating point. "$20" when there are no cents. */
export function formatUsd(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = abs % 100;
  return `${neg ? '−' : ''}$${dollars}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}

// ------------------------------------------------------------- the award --

/** A bid as the rules see it. createdAt = when its current amount was placed (ms since epoch). */
export interface BidState {
  id: number;
  bidderId: string;
  amountCents: number;
  createdAt: number;
  status: BidStatus;
}

/** Lower amount first; on a tie the bid placed first, then the lower id. The order of the bid tab, too. */
export function compareBids(a: Pick<BidState, 'amountCents' | 'createdAt' | 'id'>, b: Pick<BidState, 'amountCents' | 'createdAt' | 'id'>): number {
  return a.amountCents - b.amountCents || a.createdAt - b.createdAt || a.id - b.id;
}

/** The winner at closing: the lowest active bid, the earliest of the lowest. null when nobody bid. */
export function pickWinner<B extends BidState>(bids: readonly B[]): B | null {
  let best: B | null = null;
  for (const b of bids) if (b.status === 'active' && (!best || compareBids(b, best) < 0)) best = b;
  return best;
}

/** The winner has `contactDays` from the award; the award happens at the closing time, however late it is settled. */
export const contactDeadlineFor = (closesAt: number, contactDays: number): number => closesAt + contactDays * DAY_MS;

// ---------------------------------------------------------- the job state --

/** A job as the rules see it. Times are ms since epoch, null when it has not happened. */
export interface JobState {
  status: JobStatus;
  outcome: JobOutcome | null;
  closesAt: number;
  winnerBidId: number | null;
  winnerId: string | null;
  awardCents: number | null;
  awardedAt: number | null;
  contactDeadline: number | null;
  /** The winner's first message in the job's thread. */
  bidderMessagedAt: number | null;
  /** The poster's first message. */
  posterMessagedAt: number | null;
  /** The poster tapped "They contacted me". */
  posterTappedAt: number | null;
  bidderConfirmedAt: number | null;
  posterConfirmedAt: number | null;
  endedAt: number | null;
}

/** "Made contact" = the winner sent a message, or the poster said they were contacted. */
export const madeContact = (j: Pick<JobState, 'bidderMessagedAt' | 'posterTappedAt'>): boolean =>
  j.bidderMessagedAt !== null || j.posterTappedAt !== null;

/** The poster answered: they sent a message, tapped "They contacted me", or confirmed. */
const posterAnswered = (j: Pick<JobState, 'posterMessagedAt' | 'posterTappedAt' | 'posterConfirmedAt'>): boolean =>
  j.posterMessagedAt !== null || j.posterTappedAt !== null || j.posterConfirmedAt !== null;

/**
 * What an awarded job becomes when its contact deadline passes without "We've agreed" from both:
 *   the winner never made contact             → bidder_no_show (the no-show fee)
 *   they did, and the poster never answered   → poster_no_show (no fee)
 *   both talked but did not agree             → no_agreement   (no fee)
 */
export function endOfContact(j: Pick<JobState, 'bidderMessagedAt' | 'posterMessagedAt' | 'posterTappedAt' | 'posterConfirmedAt'>): JobOutcome {
  if (!madeContact(j)) return 'bidder_no_show';
  if (!posterAnswered(j)) return 'poster_no_show';
  return 'no_agreement';
}

/** Outcomes that cost the winner the no-show fee. Every other outcome costs nobody anything. */
export const FEE_OUTCOMES: ReadonlySet<JobOutcome> = new Set(['bidder_no_show', 'bidder_backed_out']);

export interface Settled {
  job: JobState;
  bids: BidState[];
  fees: FeeLine[];
  /** False when nothing was due: the input comes back as it was. */
  changed: boolean;
}

/**
 * Everything that is due at `now`, applied in order: an open job past its closing time is awarded to the
 * lowest bid (or ends 'no_bids'); an awarded job past its contact deadline ends as endOfContact() says, with
 * the no-show fee when it is owed. Pure and idempotent: settle(settle(x)) = settle(x).
 */
export function settle(job: JobState, bids: readonly BidState[], now: number, rules: JobRules): Settled {
  let j = job;
  let bs = [...bids];
  const fees: FeeLine[] = [];
  let changed = false;

  if (j.status === 'open' && now >= j.closesAt) {
    const winner = pickWinner(bs);
    changed = true;
    bs = bs.map((b) => (b.status !== 'active' ? b : { ...b, status: b === winner ? 'won' : 'lost' }));
    j = winner
      ? {
        ...j, status: 'awarded', winnerBidId: winner.id, winnerId: winner.bidderId, awardCents: winner.amountCents,
        awardedAt: j.closesAt, contactDeadline: contactDeadlineFor(j.closesAt, rules.contactDays),
      }
      : { ...j, status: 'unfilled', outcome: 'no_bids', endedAt: j.closesAt };
  }

  if (j.status === 'awarded' && j.contactDeadline !== null && now >= j.contactDeadline) {
    const outcome = endOfContact(j);
    changed = true;
    j = { ...j, status: 'unfilled', outcome, endedAt: j.contactDeadline };
    if (FEE_OUTCOMES.has(outcome)) {
      bs = bs.map((b) => (b.id === j.winnerBidId ? { ...b, status: 'defaulted' } : b));
      fees.push(feeLine('no_show', j.awardCents ?? 0, rules));
    }
  }
  return { job: j, bids: bs, fees, changed };
}

/** Statuses where the job is over and nothing more can happen to it (a repost is a new job). */
export const isFinal = (s: JobStatus): boolean => s === 'completed' || s === 'unfilled' || s === 'cancelled';

/** The job closed for bidding the normal way (bids were opened), so the bid tab exists. */
export const bidsOpened = (s: JobStatus): boolean => s !== 'open' && s !== 'cancelled';
