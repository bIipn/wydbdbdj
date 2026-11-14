import type { FeedItem, Verdict } from '../types.js';

/**
 * "What should I look at next?" — one bid, chosen on fit and urgency, with the reasons in plain
 * English. Pure: it only uses what is on the items, so it is the same pick for the same feed.
 *
 * Candidates: not swiped, still open, not over the spend limit, score ≥ 35 (the swipe deck's floor), and not
 * sub work (tier 'sub': a GC's job to quote, not a bid to place; the deck shows it, the pick does not).
 *
 *   rank  = score + boost
 *   boost = 10 × (14 − d) / 12   when the deadline is d days away and 2 ≤ d < 14
 *         = 0                    no deadline, under 2 days (too late to price properly), or 14+ days
 *
 * So the boost is 10 at two days out and fades to 0 at two weeks. Two things always hold:
 *   - a better score never ranks lower, deadline being equal;
 *   - of two deadlines that are both workable (2+ days), the sooner never ranks lower, score being equal.
 * 10 points is half a verdict band (bands are 20 wide): urgency settles close calls, but a bid
 * that scores more than 10 points better always wins.
 * Ties go to the sooner deadline, then the closer job, then the id (so the pick is stable).
 */
export const NEXT_MIN_SCORE = 35;
const MIN_WORKABLE_DAYS = 2;
const URGENT_WITHIN_DAYS = 14;
const MAX_BOOST = 10;
const MAX_WHY = 3;

/** Whole and part days until the deadline; null when there is none (or it cannot be read). */
function daysLeft(item: FeedItem, now: Date): number | null {
  const due = item.dueAt ? Date.parse(item.dueAt) : NaN;
  return Number.isFinite(due) ? (due - now.getTime()) / 86_400_000 : null;
}

export function urgencyBoost(days: number | null): number {
  if (days === null || days < MIN_WORKABLE_DAYS || days >= URGENT_WITHIN_DAYS) return 0;
  return (MAX_BOOST * (URGENT_WITHIN_DAYS - days)) / (URGENT_WITHIN_DAYS - MIN_WORKABLE_DAYS);
}

const FIT_LABEL: Record<Verdict, string> = { great: 'Great fit', good: 'Good fit', maybe: 'Maybe a fit', skip: 'Not a fit' };

/** Up to three lines: the fit, the deadline when it helped the pick, then the bid's own plus points. */
function whyLines(item: FeedItem, days: number | null): string[] {
  const why = [`${FIT_LABEL[item.verdict]} — ${item.score} out of 100`];
  // A boost means 2–14 days are left, so "days" is always plural here.
  if (days !== null && urgencyBoost(days) > 0) why.push(`Due in ${Math.floor(days)} days — soon, but still time to bid`);
  for (const r of item.reasons) if (r.kind === 'plus') why.push(r.text);
  return why.slice(0, MAX_WHY);
}

/** Smallest first, unknown (null) last. */
const asc = (a: number | null, b: number | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b);

export function pickNext(items: FeedItem[], now: Date): { item: FeedItem | null; why: string[] } {
  const ranked = items
    .map((item) => ({ item, days: daysLeft(item, now) }))
    .filter(({ item, days }) => !item.swipe && !item.overLimit && item.tier !== 'sub' && item.score >= NEXT_MIN_SCORE && (days === null || days > 0))
    .map((c) => ({ ...c, rank: c.item.score + urgencyBoost(c.days) }))
    .sort(
      (a, b) =>
        b.rank - a.rank ||
        asc(a.days, b.days) ||
        asc(a.item.distanceMi, b.item.distanceMi) ||
        (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
    );
  const best = ranked[0];
  return best ? { item: best.item, why: whyLines(best.item, best.days) } : { item: null, why: [] };
}
