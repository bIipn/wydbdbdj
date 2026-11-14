/**
 * What the marketplace SHOULD do with the script, worked out by the simulation itself from the contract
 * (docs: the jobs contract, sections 1, 2 and 4), never by calling the product's own rules. The checks
 * compare this with what the API answered.
 *
 *   winner   the lowest bid standing at closing; on a tie the one placed first (rule 4)
 *   ending   from the actions after the award and the contact deadline (rule 6)
 *   fees     rule 8, in this file's own arithmetic: cents × rate in parts per million, BigInt, rounded half up
 *            once; the poster's share is its own rounding of the bid; BidSwipe keeps the difference
 *   alerts   who must hear what (section 4), each exactly once
 */
import { byAward, DAY, HOUR, replayBids, type BidAction, type ModelBid, type Plan, type PlannedJob, type Side } from './plan.js';

export interface RatesPpm {
  noShow: number;
  posterShare: number;
  service: number;
}

/** "5" → 50_000 parts per million. The API sends percentages as numbers. */
export const pctToPpmSim = (pct: number): number => Math.round(pct * 10_000);

/** cents × ppm / 1,000,000, rounded half up, in BigInt (no floating point anywhere). */
export function halfUp(cents: number, ppm: number): number {
  const twice = BigInt(cents) * BigInt(ppm) * 2n + 1_000_000n;
  return Number(twice / 2_000_000n);
}

export type FeeKind = 'no_show' | 'service';

export interface ExpectedFee {
  kind: FeeKind;
  payer: string;
  basisCents: number;
  amountCents: number;
  posterShareCents: number;
  platformCents: number;
}

export function expectedFee(kind: FeeKind, basisCents: number, payer: string, rates: RatesPpm): ExpectedFee {
  const amountCents = halfUp(basisCents, kind === 'no_show' ? rates.noShow : rates.service);
  const posterShareCents = kind === 'no_show' ? halfUp(basisCents, Math.min(rates.posterShare, rates.noShow)) : 0;
  return { kind, payer, basisCents, amountCents, posterShareCents, platformCents: amountCents - posterShareCents };
}

export interface ExpectedAlert {
  who: string;
  kind: 'job_awarded' | 'job_closed' | 'job_message' | 'job_deadline';
  job: string;
  role: 'poster' | 'winner' | 'bidder';
  status: string;
  outcome: string | null;
}

export const alertKey = (a: Omit<ExpectedAlert, 'who'> & { who: string }): string =>
  `${a.who}|${a.kind}|${a.job}|${a.role}|${a.status}|${a.outcome ?? '-'}`;

export interface JobExpect {
  key: string;
  poster: string;
  postAt: number;
  closesAt: number;
  deadline: number;
  /** Cancelled by the poster while bids were open (bids never opened). */
  cancelledOpenAt: number | null;
  /** Bids standing at closing, in the bid tab's order. Empty when cancelled while open. */
  inAtClose: ModelBid[];
  winner: ModelBid | null;
  /** Two or more bids at the lowest amount. */
  tieAtLowest: boolean;
  status: 'open' | 'awarded' | 'agreed' | 'completed' | 'unfilled' | 'cancelled';
  outcome: string | null;
  fees: ExpectedFee[];
  alerts: ExpectedAlert[];
  /** Every amount ever placed on this job by anyone. */
  amounts: Set<number>;
  /** People who see the bid tab after closing: the poster and everyone whose bid was in. */
  tabPeople: Set<string>;
  /** Times when the job is in the feed: [postAt, end of bidding). */
  openUntil: number;
}

/**
 * The expected life of every job in the plan. `rates` and `contactDays` come from GET /api/jobs/rules (they
 * are settings); everything else is the contract.
 */
export function expectJobs(plan: Plan, rates: RatesPpm): Map<string, JobExpect> {
  const out = new Map<string, JobExpect>();
  const byJob = new Map<string, Plan['steps']>();
  for (const s of plan.steps) {
    const job = 'job' in s.act ? s.act.job : null;
    if (job) byJob.set(job, [...(byJob.get(job) ?? []), s]);
  }
  for (const job of plan.jobs) out.set(job.key, expectJob(job, byJob.get(job.key) ?? [], plan, rates));
  return out;
}

function expectJob(job: PlannedJob, steps: Plan['steps'], plan: Plan, rates: RatesPpm): JobExpect {
  const D = job.closesAt + plan.contactDays * DAY;
  const bidActions: BidAction[] = [];
  const amounts = new Set<number>();
  for (const s of steps) {
    if (s.act.kind === 'bid') {
      bidActions.push({ t: s.t, seq: s.seq, who: s.act.who, kind: 'bid', amountCents: s.act.amountCents });
      amounts.add(s.act.amountCents);
    } else if (s.act.kind === 'withdraw') bidActions.push({ t: s.t, seq: s.seq, who: s.act.who, kind: 'withdraw' });
  }
  const alerts: ExpectedAlert[] = [];
  const fees: ExpectedFee[] = [];
  const say = (who: string, kind: ExpectedAlert['kind'], role: ExpectedAlert['role'], status: string, outcome: string | null) =>
    alerts.push({ who, kind, job: job.key, role, status, outcome });

  const base = {
    key: job.key, poster: job.poster, postAt: job.postAt, closesAt: job.closesAt, deadline: D, amounts,
  };

  // Cancelled while open: every active bid is closed as lost and its bidder told; no tab, no award.
  if (job.openCancelAt !== null) {
    const standing = [...replayBids(bidActions, job.openCancelAt).values()].filter((b) => b.active);
    for (const b of standing) say(b.who, 'job_closed', 'bidder', 'cancelled', null);
    return {
      ...base, cancelledOpenAt: job.openCancelAt, inAtClose: [], winner: null, tieAtLowest: false, status: 'cancelled', outcome: null,
      fees, alerts, tabPeople: new Set(), openUntil: job.openCancelAt,
    };
  }

  const inAtClose = [...replayBids(bidActions, job.closesAt).values()].filter((b) => b.active).sort(byAward);
  const winner = inAtClose[0] ?? null;
  const tieAtLowest = inAtClose.length > 1 && inAtClose[1]!.amountCents === inAtClose[0]!.amountCents;
  const tabPeople = new Set([job.poster, ...inAtClose.map((b) => b.who)]);
  const common = { ...base, cancelledOpenAt: null, inAtClose, winner, tieAtLowest, tabPeople, openUntil: job.closesAt };

  if (!winner) {
    say(job.poster, 'job_closed', 'poster', 'unfilled', 'no_bids');
    return { ...common, status: 'unfilled', outcome: 'no_bids', fees, alerts };
  }

  say(job.poster, 'job_awarded', 'poster', 'awarded', null);
  say(winner.who, 'job_awarded', 'winner', 'awarded', null);
  for (const b of inAtClose.slice(1)) say(b.who, 'job_closed', 'bidder', 'awarded', null);

  // The contact window, replayed with the deadline reminders (ticks) in time order.
  type Ev = { t: number; seq: number; s?: Plan['steps'][number]; tick?: true };
  const events: Ev[] = [
    ...steps.filter((s) => s.t > job.closesAt).map((s) => ({ t: s.t, seq: s.seq, s })),
    ...plan.ticks.filter((t) => t >= job.closesAt).map((t) => ({ t, seq: Number.MAX_SAFE_INTEGER, tick: true as const })),
  ].sort((a, b) => a.t - b.t || a.seq - b.seq);

  let status = 'awarded' as JobExpect['status']; // (a cast: the closures below change it)
  let outcome: string | null = null;
  let winnerWrote = false;
  let posterWrote = false;
  let tapped = false;
  let winnerConfirmed = false;
  let posterConfirmed = false;
  let reminded = false;
  const ended = (st: JobExpect['status'], oc: string | null) => {
    status = st;
    outcome = oc;
    say(job.poster, 'job_closed', 'poster', st, oc);
    say(winner.who, 'job_closed', 'winner', st, oc);
  };
  const atDeadline = () => {
    // Rule 6: no contact → bidder_no_show (fee); contact but the poster never answered → poster_no_show; else no_agreement.
    const contact = winnerWrote || tapped;
    const answered = posterWrote || tapped || posterConfirmed;
    const oc = !contact ? 'bidder_no_show' : !answered ? 'poster_no_show' : 'no_agreement';
    if (oc === 'bidder_no_show') fees.push(expectedFee('no_show', winner.amountCents, winner.who, rates));
    ended('unfilled', oc);
  };

  for (const e of events) {
    if (status === 'awarded' && e.t >= D) atDeadline();
    if (e.tick) {
      // The 2-days-left reminder: awarded, no contact yet, deadline within 48 hours.
      if (status === 'awarded' && !winnerWrote && !tapped && !reminded && D > e.t && D <= e.t + 48 * HOUR) {
        reminded = true;
        say(winner.who, 'job_deadline', 'winner', 'awarded', null);
      }
      continue;
    }
    const a = e.s!.act;
    const live = status === 'awarded' || status === 'agreed';
    switch (a.kind) {
      case 'message': {
        if (!live) break;
        const side: Side = a.side;
        if (side === 'winner') winnerWrote = true;
        else posterWrote = true;
        say(side === 'winner' ? job.poster : winner.who, 'job_message', side === 'winner' ? 'poster' : 'winner', status, null);
        break;
      }
      case 'contacted':
        if (status === 'awarded') tapped = true;
        break;
      case 'confirm':
        if (status !== 'awarded') break;
        if (a.side === 'winner') winnerConfirmed = true;
        else posterConfirmed = true;
        if (winnerConfirmed && posterConfirmed) {
          fees.push(expectedFee('service', winner.amountCents, winner.who, rates));
          ended('agreed', null);
        }
        break;
      case 'back-out':
        if (status !== 'awarded') break;
        fees.push(expectedFee('no_show', winner.amountCents, winner.who, rates));
        ended('unfilled', 'bidder_backed_out');
        break;
      case 'cancel-awarded':
        if (status === 'awarded') ended('unfilled', 'poster_cancelled');
        break;
      case 'complete':
        if (status === 'agreed') ended('completed', null);
        break;
      default:
        break;
    }
  }
  if (status === 'awarded') atDeadline();
  return { ...common, status, outcome, fees, alerts };
}

/** Is the job in the feed at time t (open for bids)? */
export const openAt = (j: JobExpect, t: number): boolean => t >= j.postAt && t < j.openUntil;

/** The "ending" a non-engineer reads in the report. */
export function endingLabel(j: Pick<JobExpect, 'status' | 'outcome'>): string {
  if (j.status === 'completed') return 'agreed and done';
  if (j.status === 'agreed') return 'agreed';
  if (j.status === 'cancelled') return 'cancelled while open';
  if (j.status === 'unfilled') {
    return ({
      no_bids: 'no bids', bidder_no_show: 'winner never made contact', bidder_backed_out: 'winner backed out',
      poster_no_show: 'poster never answered', no_agreement: 'talked, no agreement', poster_cancelled: 'poster cancelled after the award',
    } as Record<string, string>)[j.outcome ?? ''] ?? `unfilled (${j.outcome})`;
  }
  return j.status;
}
