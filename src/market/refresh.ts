/**
 * One market-data refresh: federal awards (USAspending) and wages + price indexes (BLS).
 * Called by the CLI (src/cli/market.ts) and by POST /api/admin/market/refresh. Never by a user request.
 */
import type { Db } from '../db/db.js';
import type { FetchLike } from '../types.js';
import { createHttp } from '../util/http.js';
import { refreshBls, type BlsRefreshReport } from './bls.js';
import { refreshAwards, type AwardsRefreshReport } from './usaspending.js';

/**
 * NAICS codes pulled when the caller names none: electrical contractors, plumbing / HVAC
 * contractors, and commercial building construction (general contracts that carry electrical scope).
 */
export const DEFAULT_AWARD_NAICS: readonly string[] = ['238210', '238220', '236220'];
/** A routine refresh re-pulls about 120 days: Defense awards show up roughly 90 days late. The first load wants 24. */
export const DEFAULT_REFRESH_MONTHS = 4;
/** Per state and run: how many awards without a Mod 0 row get their price looked up one by one. */
export const DEFAULT_PRICE_LOOKUPS = 25;

export interface MarketHttp {
  /** api.usaspending.gov: paced, with the client's bounded back-off on 429 / 5xx. */
  awards: FetchLike;
  /** api.bls.gov: paced, NO retries (every attempt counts against a small daily allowance). */
  bls: FetchLike;
}

/** Polite clients for the two sources: about one request a second per host. */
export function createMarketHttp(userAgent: string): MarketHttp {
  return {
    awards: createHttp({ userAgent, perHostDelayMs: 1100, retries: 2, timeoutMs: 60_000 }),
    bls: createHttp({ userAgent, perHostDelayMs: 1100, retries: 0, timeoutMs: 60_000 }),
  };
}

export interface MarketRefreshOptions {
  /** 2-letter state codes and/or "US". Needed unless awards is false. */
  states?: string[];
  months?: number;
  naics?: string[];
  /** Pull federal awards. Default true. */
  awards?: boolean;
  /** Pull BLS wages and price indexes. Default true. */
  bls?: boolean;
  /** Award detail lookups (solicitation id, offers received) to make this run. Default 0. */
  details?: number;
  /** Per state: one-by-one price lookups for awards the transaction search gave no Mod 0 row for. Default 25. */
  priceLookups?: number;
  blsApiKey?: string;
  blsMaxQueries?: number;
  /** States whose wages BLS is asked for first. Default: `states`. */
  blsPriorityStates?: string[];
  now?: Date;
  log?: (msg: string) => void;
}

export interface MarketRefreshReport {
  startedAt: string;
  finishedAt: string;
  /** True when every part that ran finished without an error. */
  ok: boolean;
  awards: AwardsRefreshReport | null;
  bls: BlsRefreshReport | null;
  errors: string[];
}

/** Run the parts asked for, one after the other. One part failing never stops the other. */
export async function refreshMarket(db: Db, http: MarketHttp, opts: MarketRefreshOptions = {}): Promise<MarketRefreshReport> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  let awards: AwardsRefreshReport | null = null;
  let bls: BlsRefreshReport | null = null;

  if (opts.awards !== false) {
    try {
      if (!opts.states?.length) throw new Error('no states given');
      awards = await refreshAwards(db, http.awards, {
        states: opts.states, months: opts.months ?? DEFAULT_REFRESH_MONTHS, naics: opts.naics?.length ? opts.naics : [...DEFAULT_AWARD_NAICS],
        details: opts.details, priceLookups: opts.priceLookups ?? DEFAULT_PRICE_LOOKUPS, now, log: (m) => log(`[awards] ${m}`),
      });
      for (const s of awards.scopes) if (!s.ok) errors.push(`awards ${s.scope}: ${s.error ?? 'failed'}`);
    } catch (err) {
      errors.push(`awards: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (opts.bls !== false) {
    try {
      bls = await refreshBls(db, http.bls, {
        apiKey: opts.blsApiKey, maxQueries: opts.blsMaxQueries, now, log: (m) => log(`[bls] ${m}`),
        // The states awards are pulled for are the states customers work in: their wages come first.
        priorityStates: opts.blsPriorityStates ?? opts.states?.filter((s) => s.length === 2 && s.toUpperCase() !== 'US'),
      });
      if (bls.error) errors.push(`bls: ${bls.error}`);
    } catch (err) {
      errors.push(`bls: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { startedAt, finishedAt: new Date().toISOString(), ok: errors.length === 0, awards, bls, errors };
}
