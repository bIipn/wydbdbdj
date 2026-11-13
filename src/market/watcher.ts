/**
 * The price and award watcher: the "price agent" that keeps checking for the contractor.
 *
 * One market refresh = snapshot what is stored → refreshMarket (USAspending + BLS) → snapshot again →
 * the pure rules in watch.ts decide → "price" and "award" events on the bus → src/realtime stores,
 * streams and pushes the alerts. It runs inside the server process (the embedded database allows one
 * process): from POST /api/admin/market/refresh, and once a day at MARKET_REFRESH_AT (Pacific) when set.
 *
 * A refresh that fails is logged and shows in the watch status; it never throws into the scheduler,
 * never stops the bid scan, and never takes the server down. Only one refresh runs at a time.
 */
import { savedSolicitations } from '../db/alerts.js';
import type { Db } from '../db/db.js';
import { awardSolicitations, awardsByIds, getAwardCoverage, marketFetchedAt, seriesOfKinds, type StoredSeries } from '../db/market.js';
import { listProfiles } from '../db/repo.js';
import { lookupZip, milesBetween } from '../geo/zip.js';
import type { Bus } from '../realtime/bus.js';
import { nextDailyRun, scheduleDaily } from '../scheduler.js';
import type { Award, Profile } from '../types.js';
import { isStateCode } from './areas.js';
import { createMarketHttp, refreshMarket, type MarketHttp, type MarketRefreshOptions, type MarketRefreshReport } from './refresh.js';
import type { FederalAward } from './usaspending.js';
import {
  awardMatches, coverageKey, isWatchable, nearbyAwards, priceMoves, priceWatchThreshold, type AwardSnapshot, type PriceMove, type SeriesSnapshot,
} from './watch.js';

/** Award detail lookups (solicitation number, offers) per scheduled refresh: what lets an award meet a saved bid. */
export const DAILY_DETAIL_LOOKUPS = 25;
const USASPENDING_NAME = 'USAspending.gov';

export type RefreshTrigger = 'admin' | 'schedule';

export interface WatchSummary {
  /** Series with a new latest period, whether or not they moved enough to alert. */
  priceMoves: PriceMove[];
  /** "price" events published (moves at or over the threshold, watchable series only). */
  priceEvents: number;
  /** "award" events published for bids a profile saved. */
  awardEvents: number;
  /** "award" events published for similar jobs near a profile. */
  nearbyEvents: number;
  /** Why the watcher could not decide (the refresh itself may still have stored data). */
  error: string | null;
}

export interface WatchedRefreshReport extends MarketRefreshReport {
  trigger: RefreshTrigger;
  watch: WatchSummary;
}

export interface LastRun {
  trigger: RefreshTrigger;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  errors: string[];
  priceEvents: number;
  awardEvents: number;
}

export interface WatchStatus {
  /** True when the daily refresh is scheduled (MARKET_REFRESH_AT). */
  enabled: boolean;
  /** "HH:MM" Pacific, or null. */
  schedule: string | null;
  running: boolean;
  /** When the market was last checked: the last run here, else the newest data stored. */
  lastRefreshAt: string | null;
  nextRefreshAt: string | null;
  lastRun: LastRun | null;
}

export class RefreshRunningError extends Error {
  constructor() {
    super('A market refresh is already running.');
    this.name = 'RefreshRunningError';
  }
}

export interface MarketWatcherDeps {
  db: Db;
  bus: Bus;
  now: () => Date;
  log: (msg: string) => void;
  env: (name: string) => string | undefined;
  /** Daily refresh time "HH:MM" Pacific (MARKET_REFRESH_AT). null/undefined = no daily refresh. */
  schedule?: string | null;
  /** The config profile in single mode: its states are refreshed even before its first scan stores it. */
  profile?: Profile | null;
  /** Default: polite real clients, built on first use. */
  http?: MarketHttp;
  /** Default: refreshMarket. Tests pass one that fails. */
  refresh?: typeof refreshMarket;
  /** Default: the ZIP table (src/geo/zip.ts). */
  pointOf?: (zip: string) => { lat: number; lng: number } | null;
}

export interface MarketWatcher {
  /**
   * Refresh now and publish what changed. Rejects with RefreshRunningError when one is running;
   * otherwise always resolves (failures are in the report's errors and in status()).
   */
  refresh(opts: MarketRefreshOptions, run?: { trigger?: RefreshTrigger; http?: MarketHttp }): Promise<WatchedRefreshReport>;
  status(): Promise<WatchStatus>;
  /** The states the daily refresh pulls: every state a stored or configured profile works in. */
  defaultStates(): Promise<string[]>;
  /** Arm the daily refresh (no-op without a schedule). Returns the function that disarms it. */
  start(): () => void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const observationsOf = (stored: Map<string, StoredSeries>): SeriesSnapshot =>
  new Map([...stored].filter(([, s]) => isWatchable(s.meta)).map(([id, s]) => [id, s.observations]));

/** An award as an alert carries it: the source by its public name, a link to its public page. */
export function awardForAlert(a: FederalAward): Award {
  return {
    ...a,
    source: USASPENDING_NAME,
    url: a.url ?? `https://www.usaspending.gov/award/${encodeURIComponent(a.generatedInternalId)}`,
  };
}

export function createMarketWatcher(deps: MarketWatcherDeps): MarketWatcher {
  const { db, bus, log } = deps;
  const schedule = deps.schedule?.trim() || null;
  const run = deps.refresh ?? refreshMarket;
  const pointOf = deps.pointOf ?? ((zip: string) => lookupZip(zip));
  let http = deps.http;
  let running = false;
  let lastRun: LastRun | null = null;

  const clients = (): MarketHttp => {
    const contact = deps.env('CONTACT_EMAIL');
    http ??= createMarketHttp(`BidSwipe/1.0 (market data refresh${contact ? `; contact ${contact}` : ''})`);
    return http;
  };

  async function defaultStates(): Promise<string[]> {
    const profiles = [deps.profile, ...(await listProfiles(db))].flatMap((p) => p ?? []);
    return [...new Set(profiles.flatMap((p) => p.states.map((s) => s.toUpperCase())).filter(isStateCode))];
  }

  /** Compare, decide, publish. Returns the summary; throws only on a database error (the caller records it). */
  async function publish(before: { series: SeriesSnapshot; awards: AwardSnapshot; loaded: Set<string> }): Promise<Omit<WatchSummary, 'error'>> {
    const threshold = priceWatchThreshold(deps.env);
    const moves = priceMoves(before.series, observationsOf(await seriesOfKinds(db, ['ppi', 'oews'])), threshold);
    let priceEvents = 0;
    for (const m of moves.filter((x) => x.alert)) {
      await bus.emit({
        type: 'price', seriesId: m.seriesId, changePct: m.changePct, period: m.period,
        previousPeriod: m.previousPeriod, yearChangePct: m.yearChangePct, preliminary: m.preliminary,
      });
      priceEvents++;
    }

    const now = await awardSolicitations(db);
    const changed = [...now].filter(([id, sol]) => !before.awards.has(id) || (sol !== null && before.awards.get(id) !== sol)).map(([id]) => id);
    const fresh = changed.length ? await awardsByIds(db, changed) : [];
    let awardEvents = 0;
    let nearbyEvents = 0;
    const told = new Set<string>(); // profile|award: one notice per award and profile
    for (const m of awardMatches(before.awards, fresh, await savedSolicitations(db))) {
      await bus.emit({ type: 'award', profileId: m.profileId, award: awardForAlert(m.award), bidId: m.bidId });
      told.add(`${m.profileId}|${m.award.id}`);
      awardEvents++;
    }
    if (fresh.length) {
      for (const profile of await listProfiles(db)) {
        for (const n of nearbyAwards(profile, before.awards, fresh, before.loaded, { pointOf, milesBetween })) {
          if (told.has(`${profile.id}|${n.award.id}`)) continue;
          await bus.emit({ type: 'award', profileId: profile.id, award: awardForAlert(n.award), nearby: { miles: n.miles, naics: n.award.naics ?? '' } });
          nearbyEvents++;
        }
      }
    }
    return { priceMoves: moves, priceEvents, awardEvents, nearbyEvents };
  }

  async function refresh(opts: MarketRefreshOptions, how: { trigger?: RefreshTrigger; http?: MarketHttp } = {}): Promise<WatchedRefreshReport> {
    if (running) throw new RefreshRunningError();
    running = true;
    const trigger = how.trigger ?? 'admin';
    const startedAt = deps.now().toISOString();
    try {
      let before: { series: SeriesSnapshot; awards: AwardSnapshot; loaded: Set<string> } | null = null;
      let watchError: string | null = null;
      try {
        before = {
          series: observationsOf(await seriesOfKinds(db, ['ppi', 'oews'])),
          awards: await awardSolicitations(db),
          // "scope|naics": a NAICS loaded for the first time in an already-loaded state is still history.
          loaded: new Set((await getAwardCoverage(db)).map((c) => coverageKey(c.scope, c.naics))),
        };
      } catch (err) {
        watchError = `watch: could not read what was stored before: ${message(err)}`;
      }

      let report: MarketRefreshReport;
      try {
        report = await run(db, how.http ?? clients(), { ...opts, now: opts.now ?? deps.now(), log: opts.log ?? log });
      } catch (err) {
        const at = deps.now().toISOString();
        report = { startedAt, finishedAt: at, ok: false, awards: null, bls: null, errors: [`refresh: ${message(err)}`] };
      }

      let summary: Omit<WatchSummary, 'error'> = { priceMoves: [], priceEvents: 0, awardEvents: 0, nearbyEvents: 0 };
      if (before) {
        try {
          summary = await publish(before);
        } catch (err) {
          watchError = `watch: ${message(err)}`;
        }
      }
      const errors = [...report.errors, ...(watchError ? [watchError] : [])];
      const ok = report.ok && watchError === null;
      lastRun = {
        trigger, startedAt, finishedAt: deps.now().toISOString(), ok, errors,
        priceEvents: summary.priceEvents, awardEvents: summary.awardEvents + summary.nearbyEvents,
      };
      log(`market watch (${trigger}): ${ok ? 'ok' : `FAILED: ${errors.join('; ')}`} · ${summary.priceMoves.length} new period(s), `
        + `${summary.priceEvents} price alert event(s), ${summary.awardEvents} saved-bid award(s), ${summary.nearbyEvents} nearby award(s)`);
      return { ...report, ok, errors, trigger, watch: { ...summary, error: watchError } };
    } finally {
      running = false;
    }
  }

  async function daily(): Promise<void> {
    try {
      const states = await defaultStates();
      const max = Number(deps.env('BLS_MAX_QUERIES'));
      await refresh({
        states, awards: states.length > 0, bls: true, details: DAILY_DETAIL_LOOKUPS, blsApiKey: deps.env('BLS_API_KEY'),
        blsMaxQueries: Number.isInteger(max) && max > 0 ? max : undefined,
      }, { trigger: 'schedule' });
    } catch (err) {
      // A refresh already running (an admin one) or a database error: logged, never thrown into the timer.
      const text = message(err);
      lastRun = { trigger: 'schedule', startedAt: deps.now().toISOString(), finishedAt: deps.now().toISOString(), ok: false, errors: [text], priceEvents: 0, awardEvents: 0 };
      log(`market watch (schedule): FAILED: ${text}`);
    }
  }

  return {
    refresh,
    defaultStates,
    async status() {
      let stored: string | null = null;
      try {
        stored = await marketFetchedAt(db);
      } catch {
        stored = null;
      }
      return {
        enabled: schedule !== null,
        schedule,
        running,
        lastRefreshAt: lastRun?.finishedAt ?? stored,
        nextRefreshAt: schedule ? nextDailyRun(schedule, deps.now(), 'MARKET_REFRESH_AT').toISOString() : null,
        lastRun,
      };
    },
    start() {
      if (!schedule) return () => {};
      return scheduleDaily(schedule, daily, log, 'market refresh');
    },
  };
}
