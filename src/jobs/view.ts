/**
 * The Job as ONE viewer may see it. This is where the marketplace's privacy lives: every field a viewer may
 * not see is null (or an empty list), never missing, so a screen cannot show it by accident and a test can
 * look for it in the raw JSON.
 *
 *   amounts      sealed while open: only the bidder sees their own. After closing, the poster and the people
 *                who bid see the ranked tab (contract rule 5); bidders are named only to the poster.
 *   address/phone  the poster always; the winner after the award; nobody else, ever.
 *   messages     the poster and the winner, after the award (service.ts decides; this file shapes them).
 *   fees         the poster and the one who owes it.
 *
 * Pure: it takes rows that were already read, and the time.
 */
import type { PersonCard } from '../profile/person.js';
import { getTrade } from '../trades/catalog.js';
import type { JobStats } from './stats.js';
import type { PublicRules } from './config.js';
import type { BidRecord, FeeRecord, JobRecord, MessageRecord } from './repo.js';
import { bidsOpened, compareBids, contactMadeAt, posterAnsweredAt, type BidStatus, type FeeKind, type JobOutcome, type JobStatus } from './rules.js';

/** What everyone may know about a person on a job: a name, when they joined, their record here. */
export interface PersonLite {
  id: string;
  name: string;
  memberSince: string;
  stats: JobStats;
}

export type Role = 'poster' | 'bidder' | 'viewer';

export interface JobView {
  id: string;
  title: string;
  description: string;
  trades: string[];
  tradeLabels: string[];
  place: { city: string; state: string; zip: string };
  postedAt: string;
  closesAt: string;
  status: JobStatus;
  outcome: JobOutcome | null;
  budgetMaxCents: number | null;
  bidCount: number;
  poster: PersonLite;
  my: {
    role: Role;
    bid: { amountCents: number; note: string | null; status: BidStatus; updatedAt: string } | null;
    canBid: boolean;
    whyNot: string | null;
  };
  award: null | {
    amountCents: number;
    awardedAt: string;
    contactDeadline: string;
    isMe: boolean;
    winner: PersonCard | PersonLite | null;
    bidderContactedAt: string | null;
    posterContactedAt: string | null;
    bidderConfirmedAt: string | null;
    posterConfirmedAt: string | null;
  };
  tab: null | Array<{ rank: number; amountCents: number; mine: boolean; bidder: PersonCard | PersonLite | null }>;
  private: null | { address: string | null; phone: string | null };
  fees: Array<{ kind: FeeKind; amountCents: number; posterShareCents: number; status: 'recorded' | 'waived'; owedByMe: boolean }>;
  repostedFrom: string | null;
  rules: PublicRules;
}

export interface MessageView {
  id: number;
  from: 'poster' | 'winner';
  mine: boolean;
  body: string;
  at: string;
}

/** Everything view() needs, read beforehand by the service. `cards` holds whoever the viewer may be shown. */
export interface JobBundle {
  job: JobRecord;
  bids: BidRecord[];
  fees: FeeRecord[];
  /** The poster's lite card, always. */
  poster: PersonLite;
  /** Cards by account id: the winner and the bidders. Used only for the poster. */
  cards: Map<string, PersonCard | PersonLite>;
}

const iso = (t: number | null): string | null => (t == null ? null : new Date(t).toISOString());

/** Bids that were in when the job closed: what the tab shows and what the count counts after closing. */
const IN_AT_CLOSING: ReadonlySet<BidStatus> = new Set(['won', 'lost', 'defaulted']);

export const tradeLabels = (ids: readonly string[]): string[] => ids.map((id) => getTrade(id)?.label ?? id);

export function viewJob(b: JobBundle, viewerId: string | null, now: number, rules: PublicRules): JobView {
  const { job } = b;
  const isPoster = viewerId !== null && viewerId === job.posterId;
  const mine = viewerId === null ? null : b.bids.find((x) => x.bidderId === viewerId) ?? null;
  const role: Role = isPoster ? 'poster' : mine ? 'bidder' : 'viewer';
  const open = job.status === 'open' && now < job.closesAt;
  const opened = bidsOpened(job.status);
  const inTab = opened ? b.bids.filter((x) => IN_AT_CLOSING.has(x.status)).sort(compareBids) : [];
  // After closing, the tab is for the poster and for everyone whose bid was in it.
  const seesTab = opened && (isPoster || (mine !== null && IN_AT_CLOSING.has(mine.status)));
  const isWinner = viewerId !== null && job.winnerId === viewerId && job.awardCents !== null;
  const afterAward = job.status === 'awarded' || job.status === 'agreed' || job.status === 'completed';

  let whyNot: string | null = null;
  if (viewerId === null) whyNot = 'Sign in to bid.';
  else if (isPoster) whyNot = 'This is your job.';
  else if (!open) whyNot = 'Bidding has closed.';

  const card = (accountId: string | null): PersonCard | PersonLite | null => (isPoster && accountId ? b.cards.get(accountId) ?? null : null);

  return {
    id: job.id,
    title: job.title,
    description: job.description,
    trades: [...job.trades],
    tradeLabels: tradeLabels(job.trades),
    place: { city: job.city, state: job.state, zip: job.zip },
    postedAt: iso(job.postedAt)!,
    closesAt: iso(job.closesAt)!,
    status: job.status,
    outcome: job.outcome,
    budgetMaxCents: job.budgetMaxCents,
    // A count, never an amount: while open the active bids, after closing the bids that were in.
    bidCount: opened ? inTab.length : b.bids.filter((x) => x.status === 'active').length,
    poster: b.poster,
    my: {
      role,
      bid: mine ? { amountCents: mine.amountCents, note: mine.note, status: mine.status, updatedAt: iso(mine.updatedAt)! } : null,
      canBid: whyNot === null,
      whyNot,
    },
    award: job.awardCents !== null && job.awardedAt !== null && job.contactDeadline !== null && seesTab
      ? {
        amountCents: job.awardCents,
        awardedAt: iso(job.awardedAt)!,
        contactDeadline: iso(job.contactDeadline)!,
        isMe: isWinner,
        winner: card(job.winnerId),
        // The winner "made contact" (rules.madeContact): the earliest of their first message, their "We've agreed",
        // the poster's "They contacted me" and the poster's "We've agreed".
        bidderContactedAt: iso(contactMadeAt(job)),
        // The poster answered: the earliest of their first message, "They contacted me" and "We've agreed".
        posterContactedAt: iso(posterAnsweredAt(job)),
        bidderConfirmedAt: iso(job.bidderConfirmedAt),
        posterConfirmedAt: iso(job.posterConfirmedAt),
      }
      : null,
    tab: seesTab
      ? inTab.map((x, i) => ({ rank: i + 1, amountCents: x.amountCents, mine: x.bidderId === viewerId, bidder: card(x.bidderId) }))
      : null,
    private: isPoster || (isWinner && afterAward) ? { address: job.address, phone: job.phone } : null,
    fees: isPoster || isWinner
      ? b.fees
        .filter((f) => isPoster || f.payerId === viewerId)
        .map((f) => ({ kind: f.kind, amountCents: f.amountCents, posterShareCents: f.posterShareCents, status: f.status, owedByMe: f.payerId === viewerId }))
      : [],
    repostedFrom: job.repostedFrom,
    rules,
  };
}

/** The thread, for the poster or the winner after the award (the service checks who may read it). */
export function viewMessages(messages: readonly MessageRecord[], job: Pick<JobRecord, 'posterId'>, viewerId: string): MessageView[] {
  return messages.map((m) => ({
    id: m.id, from: m.senderId === job.posterId ? 'poster' : 'winner', mine: m.senderId === viewerId, body: m.body, at: new Date(m.createdAt).toISOString(),
  }));
}

/** May this viewer read (and write) the job's thread? The poster and the winner, once there is a winner. */
export const inThread = (job: Pick<JobRecord, 'posterId' | 'winnerId' | 'awardCents'>, viewerId: string | null): boolean =>
  viewerId !== null && job.awardCents !== null && job.winnerId !== null && (viewerId === job.posterId || viewerId === job.winnerId);
