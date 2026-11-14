import type { Db } from '../db/db.js';
import { dealtWith, statsFor, statsForAccounts } from './repo.js';

/** What someone's history on the job marketplace adds up to. Shown on their card to the people they deal with. */
export interface JobStats {
  /** Jobs they posted. */
  posted: number;
  /** Jobs they won as the lowest bidder. */
  won: number;
  /** Won jobs where both sides confirmed an agreement. */
  agreed: number;
  /** Agreed jobs the poster marked done. */
  completed: number;
  /** Won jobs where they never made contact inside the window. */
  noShows: number;
  /** Won jobs they gave back after the award. */
  backedOut: number;
  /** Jobs they posted where the winner made contact and they never answered. */
  posterNoShows: number;
}

export const NO_JOB_STATS: JobStats = { posted: 0, won: 0, agreed: 0, completed: 0, noShows: 0, backedOut: 0, posterNoShows: 0 };

/** Counted from the jobs tables (removed jobs do not count, for or against anyone). */
export async function jobStats(db: Db, accountId: string): Promise<JobStats> {
  return { ...NO_JOB_STATS, ...(await statsFor(db, accountId)) };
}

/** The same for several accounts in one statement, by account id. Every id asked for is there (zeros when it has no jobs). */
export async function jobStatsFor(db: Db, accountIds: readonly string[]): Promise<Map<string, JobStats>> {
  const out = new Map<string, JobStats>();
  for (const [id, row] of await statsForAccounts(db, accountIds)) out.set(id, { ...NO_JOB_STATS, ...row });
  return out;
}

/**
 * True when the two accounts have dealt with each other on a job: one posted it and the other bid on it
 * and the bids are no longer sealed, or one won the other's job. Only then may one see the other's card.
 * Bids are "no longer sealed" once the job closed the normal way (not open, not cancelled while open).
 * Nobody "shares a job" with themselves.
 */
export async function sharesJob(db: Db, a: string, b: string): Promise<boolean> {
  if (!a || !b || a === b) return false;
  return dealtWith(db, a, b);
}
