/**
 * Which bids are worth scoring and storing for one company at all.
 *
 * With SAM.gov's whole-country file, most open bids are thousands of miles from any one company. Scoring
 * them is cheap, but storing a "skip — 2,400 mi away" row for every company × every bid is not: at 1,000
 * companies that is most of the database and most of the scan time. So before scoring, the scan asks
 * isCandidate(), and only candidates get a stored score (and so a place in the feed and in Browse).
 *
 * The test is deliberately conservative. It may drop a bid only when the scorer would certainly call it a
 * hard no anyway (score 0, "skip"):
 *   - a bid placed on the map (lat/lng known), outside the company's states, and farther than
 *     CANDIDATE_RADIUS_MULTIPLE × the travel radius and at least CANDIDATE_MIN_EXTRA_MI past it. score.ts
 *     rejects anything past 1 × the radius, so the margin is pure safety: a looser city-centre point, or a
 *     radius a little wider than when we scored. Never under CANDIDATE_MIN_MI, Browse's widest distance chip.
 *   - a bid we could not place whose state is not one of the company's states (score.ts: "Out of your states").
 * Everything else stays: any bid in one of the company's own states (Browse still shows "253 mi away" for a
 * job across their state: worth knowing, and a state's bids are a bounded number), an unplaced bid in one of
 * their states, and a bid with no state at all, because we cannot say it is out of reach.
 * test/candidates.test.ts scores every real captured bid with the real scorer for the pilot and the 16
 * simulated companies and checks that no maybe-or-better bid is ever dropped.
 *
 * A settings change (wider radius, new base) re-runs scoreProfile(), which asks again with the new values.
 */
import { milesBetween } from '../geo/locate.js';
import type { Bid, Profile } from '../types.js';

/** Keep placed bids up to this many times the travel radius… */
export const CANDIDATE_RADIUS_MULTIPLE = 2;
/** …and never less than this many miles past it (a 25 mi radius still keeps bids out to 125 mi). */
export const CANDIDATE_MIN_EXTRA_MI = 100;

/**
 * …and never less than this: the widest distance Browse offers ("Within 150 mi", web/js/filters.js DISTANCES).
 * Without it a company with a 25 mi radius (limit 125 mi) would pick "Within 150 mi" and silently miss the
 * out-of-state bids between 125 and 150 mi. Raise it together with that list.
 */
export const CANDIDATE_MIN_MI = 150;

/** How far out a placed bid is still a candidate for this company, in miles. */
export function candidateLimitMi(profile: Pick<Profile, 'maxDistanceMi'>): number {
  const r = Math.max(0, profile.maxDistanceMi);
  return Math.max(r * CANDIDATE_RADIUS_MULTIPLE, r + CANDIDATE_MIN_EXTRA_MI, CANDIDATE_MIN_MI);
}

/** Could this bid matter to this company? false only when it certainly cannot (see the top of this file). */
export function isCandidate(profile: Pick<Profile, 'base' | 'maxDistanceMi' | 'states'>, bid: Pick<Bid, 'location'>): boolean {
  const loc = bid.location;
  if (loc.state && profile.states.includes(loc.state)) return true;
  if (loc.lat != null && loc.lng != null) return milesBetween(profile.base, { lat: loc.lat, lng: loc.lng }) <= candidateLimitMi(profile);
  return !loc.state;
}

/** The candidates among `bids`, in the same order. */
export function candidatesFor<B extends Pick<Bid, 'location'>>(profile: Pick<Profile, 'base' | 'maxDistanceMi' | 'states'>, bids: readonly B[]): B[] {
  return bids.filter((b) => isCandidate(profile, b));
}
