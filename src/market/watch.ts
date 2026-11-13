/**
 * The price and award watcher's decisions. Pure: no database, no clock of its own, no network.
 * src/market/watcher.ts takes a snapshot of what is stored before a market refresh and after it, and
 * these functions say which "price" and "award" events that difference is worth.
 *
 * Price: a series that gained a NEW latest period. Its change is reported against the period before
 * it and against the same period a year earlier, and an event goes out only when the move against the
 * period before reaches the watch threshold. Silent on purpose:
 *   - the first load of a series (nothing stored before: there is no "move", only history),
 *   - a re-load of the same periods,
 *   - a revision of an older period (the latest period is what a contractor re-quotes against).
 *
 * Award: an award that was not stored before (or whose solicitation number only became known in
 * this refresh). Matched by solicitation number to a bid a profile saved → an event for that profile
 * with the bid id. Bids are sealed: this is always a result notice after the fact, never a price
 * before the opening.
 */
import type { StoredObservation } from '../db/market.js';
import type { Profile } from '../types.js';
import { isStateCode, stateArea } from './areas.js';
import { ELECTRICIANS, OEWS_MEASURES, oewsSeriesId, periodLabel, shiftMonths, TRADE_SOC } from './bls.js';
import { hasPriceAtAward } from './stats.js';
import type { FederalAward } from './usaspending.js';

// ------------------------------------------------------------ threshold --

/**
 * How far a watched series has to move from one period to the next before it alerts anyone, in
 * percent. This is a PRODUCT SETTING, not a fact about the market: it decides how chatty the price
 * agent is. Users only ever see "up 2.4%" / "down 3.1%", never this number. Override with the
 * PRICE_WATCH_THRESHOLD_PCT environment variable (a positive number, e.g. 1.5).
 */
export const DEFAULT_PRICE_WATCH_THRESHOLD_PCT = 2;

/** The threshold in force: PRICE_WATCH_THRESHOLD_PCT when it is a positive number, else the default. */
export function priceWatchThreshold(env: (name: string) => string | undefined): number {
  const raw = env('PRICE_WATCH_THRESHOLD_PCT')?.trim();
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : DEFAULT_PRICE_WATCH_THRESHOLD_PCT;
}

// ---------------------------------------------------------------- periods --

const MONTHLY = /^(\d{4})-M(0[1-9]|1[0-2])$/;
const ANNUAL = /^(\d{4})-A01$/;

/**
 * The period one step before `period` and the same period a year earlier.
 * Monthly "2026-M10" → "2026-M09" and "2025-M10". Annual "2025-A01" (OEWS) → "2024-A01" for both.
 * Anything else (M13 averages, quarters) → nulls: no move is worked out for it.
 */
export function comparisonPeriods(period: string): { previous: string | null; yearAgo: string | null } {
  if (MONTHLY.test(period)) return { previous: shiftMonths(period, -1), yearAgo: shiftMonths(period, -12) };
  const a = ANNUAL.exec(period);
  if (a) {
    const prior = `${Number(a[1]) - 1}-A01`;
    return { previous: prior, yearAgo: prior };
  }
  return { previous: null, yearAgo: null };
}

/** Percent change, one decimal, the way the market cards round it (seriesTrend). null when it cannot be worked out. */
export function pctChange(from: number | undefined, to: number): number | null {
  if (from === undefined || !Number.isFinite(from) || from === 0 || !Number.isFinite(to)) return null;
  return Math.round((to / from - 1) * 1000) / 10;
}

const latestOf = (obs: readonly StoredObservation[]): StoredObservation | null =>
  obs.reduce<StoredObservation | null>((best, o) => (best === null || o.period > best.period ? o : best), null);

// ------------------------------------------------------------------ price --

/** What is stored for each series: series id → observations (any order). */
export type SeriesSnapshot = ReadonlyMap<string, readonly StoredObservation[]>;

export interface SeriesChange {
  seriesId: string;
  /** The latest period and its value. */
  period: string;
  value: number;
  /** Still subject to revision by the publisher (BLS footnote "P"). */
  preliminary: boolean;
  previousPeriod: string | null;
  /** Percent change against the period before, one decimal. null = that period is not stored. */
  changePct: number | null;
  yearAgoPeriod: string | null;
  /** Percent change against the same period a year earlier. null = that period is not stored. */
  yearChangePct: number | null;
}

/** The latest period of a series and how it compares with the period before and a year before. null = no usable period. */
export function seriesChange(seriesId: string, observations: readonly StoredObservation[]): SeriesChange | null {
  const latest = latestOf(observations.filter((o) => MONTHLY.test(o.period) || ANNUAL.test(o.period)));
  if (!latest) return null;
  const byPeriod = new Map(observations.map((o) => [o.period, o.value]));
  const { previous, yearAgo } = comparisonPeriods(latest.period);
  return {
    seriesId, period: latest.period, value: latest.value, preliminary: latest.preliminary,
    previousPeriod: previous, changePct: previous ? pctChange(byPeriod.get(previous), latest.value) : null,
    yearAgoPeriod: yearAgo, yearChangePct: yearAgo ? pctChange(byPeriod.get(yearAgo), latest.value) : null,
  };
}

/** A series that gained a new latest period in this refresh. `alert` = the move reached the threshold. */
export interface PriceMove extends SeriesChange {
  changePct: number;
  previousPeriod: string;
  alert: boolean;
}

/**
 * Every series whose latest period is new since `before`, with its change. Series that are new
 * altogether (first load), unchanged, or only revised in older periods are not in the list. A new
 * period whose period-before is not stored has no move to report and is left out too.
 */
export function priceMoves(before: SeriesSnapshot, after: SeriesSnapshot, thresholdPct: number): PriceMove[] {
  const moves: PriceMove[] = [];
  for (const [seriesId, obs] of after) {
    const old = latestOf(before.get(seriesId) ?? []);
    if (!old) continue; // first load: history, not news
    const change = seriesChange(seriesId, obs);
    if (!change || change.period <= old.period) continue; // same periods, or revisions of older ones
    if (change.changePct === null || change.previousPeriod === null) continue;
    moves.push({ ...change, changePct: change.changePct, previousPeriod: change.previousPeriod, alert: Math.abs(change.changePct) >= thresholdPct });
  }
  return moves.sort((a, b) => a.seriesId.localeCompare(b.seriesId));
}

/** "Sep 2026", "2025" (annual), as the alert says it. */
export const periodName = (period: string): string => (ANNUAL.test(period) ? period.slice(0, 4) : periodLabel(period));

// ------------------------------------------------------- what is watched --

/** The profile's home state: the "…, NV" at the end of its base label, else the first state it works in. */
export function homeState(profile: Profile): string | null {
  const fromLabel = /,\s*([A-Za-z]{2})$/.exec(profile.base.label)?.[1]?.toUpperCase();
  if (fromLabel && isStateCode(fromLabel)) return fromLabel;
  return profile.states.map((s) => s.toUpperCase()).find(isStateCode) ?? null;
}

/** The occupation whose wage a profile sees: from its trades, else electricians when it bids electrical NAICS. */
export function socFor(profile: Profile): string | null {
  for (const trade of profile.trades ?? []) if (TRADE_SOC[trade]) return TRADE_SOC[trade];
  return profile.naics.strong.includes('238210') ? ELECTRICIANS : null;
}

/** What the watcher needs to know about a stored series to decide who watches it. */
export interface WatchableSeries {
  seriesId: string;
  /** "ppi" | "oews". */
  kind: string;
}

/**
 * The series a profile's price agent watches: every material price index (national), and the median
 * hourly wage of its trade in its home state. Other wage measures and other states are not alerted on.
 */
export function watchedSeries<T extends WatchableSeries>(profile: Profile, stored: readonly T[]): T[] {
  const soc = socFor(profile);
  const area = (() => {
    const s = homeState(profile);
    return s ? stateArea(s) : null;
  })();
  const wage = soc && area
    ? oewsSeriesId({ areaType: area.areaType, areaCode: area.areaCode, soc, datatype: OEWS_MEASURES.median })
    : null;
  return stored.filter((s) => s.kind === 'ppi' || (s.kind === 'oews' && s.seriesId === wage));
}

/** True when this series is one any profile's agent could watch (a price index or a median wage). */
export function isWatchable(s: WatchableSeries): boolean {
  return s.kind === 'ppi' || (s.kind === 'oews' && s.seriesId.endsWith(OEWS_MEASURES.median));
}

// ----------------------------------------------------------------- awards --

/**
 * The stable part of a solicitation number, for matching an award to a bid: upper case, letters and
 * digits only, an amendment suffix ("_1") dropped. "w912qr-24-r-0012" and "W912QR24R0012" match.
 * Too short to be specific (under 5 characters) → null: no match is better than a wrong one.
 */
export function solKey(sol: string | null | undefined): string | null {
  if (!sol) return null;
  const key = sol.trim().toUpperCase().replace(/_\d{1,3}$/, '').replace(/[^A-Z0-9]/g, '');
  return key.length >= 5 ? key : null;
}

/** A bid a profile saved or said it bid on, with the solicitation number the board printed. */
export interface SavedSolicitation {
  profileId: string;
  bidId: string;
  solNumber: string;
}

/** What was stored about an award before the refresh: its id, and the solicitation number known then. */
export type AwardSnapshot = ReadonlyMap<string, string | null>;

export interface AwardMatch {
  profileId: string;
  bidId: string;
  award: FederalAward;
}

/**
 * Awards worth telling a profile about because they settle a bid it saved: the award is new since
 * `before` (or its solicitation number only became known now) and that number matches the saved bid's.
 * One match per profile, bid and award.
 */
export function awardMatches(before: AwardSnapshot, after: readonly FederalAward[], saved: readonly SavedSolicitation[]): AwardMatch[] {
  const bySol = new Map<string, SavedSolicitation[]>();
  for (const s of saved) {
    const key = solKey(s.solNumber);
    if (key) bySol.set(key, [...(bySol.get(key) ?? []), s]);
  }
  const out = new Map<string, AwardMatch>();
  for (const award of after) {
    const key = solKey(award.solNumber);
    if (!key) continue;
    const known = before.has(award.id);
    if (known && solKey(before.get(award.id)) === key) continue; // stored before with this number: not news
    for (const s of bySol.get(key) ?? []) out.set(`${s.profileId}|${s.bidId}|${award.id}`, { profileId: s.profileId, bidId: s.bidId, award });
  }
  return [...out.values()];
}

/** A point to measure from (an award's ZIP). */
export type PointOf = (zip: string) => { lat: number; lng: number } | null;
export type MilesBetween = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => number;

export interface NearbyAward {
  award: FederalAward;
  /** Miles from the profile's base to the award's ZIP, rounded. */
  miles: number;
}

/** Key of one award_coverage row: the scope (a state code or "US") and one NAICS code. */
export function coverageKey(scope: string, naics: string): string {
  return `${scope}|${naics}`;
}

/** At most this many "similar job awarded near you" notices per profile and refresh: newest first. */
export const MAX_NEARBY_PER_REFRESH = 3;

/**
 * New awards like the profile's own work near its base: one of its main NAICS codes, a usable amount
 * at signing, a place of performance ZIP inside its travel radius, and a state AND NAICS code whose
 * awards were already loaded before this refresh (`loadedBefore` holds coverageKey(scope, naics); a
 * first load of a state, or of a new code in a loaded state, is history, not news). These are what
 * decideAward can state honestly without a bid: who won, for how much, when, how far away, and the source.
 */
export function nearbyAwards(
  profile: Profile, before: AwardSnapshot, after: readonly FederalAward[], loadedBefore: ReadonlySet<string>,
  geo: { pointOf: PointOf; milesBetween: MilesBetween }, limit = MAX_NEARBY_PER_REFRESH,
): NearbyAward[] {
  const codes = new Set(profile.naics.strong);
  const base = { lat: profile.base.lat, lng: profile.base.lng };
  const out: NearbyAward[] = [];
  for (const award of after) {
    if (before.has(award.id) || !award.naics || !codes.has(award.naics) || !hasPriceAtAward(award) || !award.zip) continue;
    if (!loadedBefore.has(coverageKey(award.state ?? '', award.naics)) && !loadedBefore.has(coverageKey('US', award.naics))) continue;
    const point = geo.pointOf(award.zip);
    if (!point) continue;
    const miles = geo.milesBetween(base, point);
    if (miles <= profile.maxDistanceMi) out.push({ award, miles: Math.round(miles) });
  }
  return out
    .sort((a, b) => (b.award.actionDate ?? '').localeCompare(a.award.actionDate ?? '') || a.award.id.localeCompare(b.award.id))
    .slice(0, Math.max(0, limit));
}
