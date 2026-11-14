import type { Db } from '../db/db.js';

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

/** Counted from the jobs tables. (Seam: the marketplace work fills this in; the signature is fixed.) */
export async function jobStats(_db: Db, _accountId: string): Promise<JobStats> {
  return { ...NO_JOB_STATS };
}

/**
 * True when the two accounts have dealt with each other on a job: one posted it and the other bid on it
 * and the bids are no longer sealed, or one won the other's job. Only then may one see the other's card.
 * (Seam: the marketplace work fills this in; the signature is fixed.)
 */
export async function sharesJob(_db: Db, _a: string, _b: string): Promise<boolean> {
  return false;
}
