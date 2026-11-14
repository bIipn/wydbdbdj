import type { Db } from '../db/db.js';
import type { JobStats } from '../jobs/stats.js';

/** One past job or employer on a work profile. */
export interface Experience {
  title: string;
  company: string | null;
  /** Four-digit years; `to` is null while it is the current job. */
  from: number | null;
  to: number | null;
  summary: string | null;
}

/** The card other people see: who this is and what they have done. Never an email, phone or address. */
export interface PersonCard {
  id: string;
  name: string;
  headline: string | null;
  about: string | null;
  yearsExperience: number | null;
  skills: string[];
  /** As the person typed it. BidSwipe does not verify licences. */
  license: { state: string; number: string } | null;
  insured: 'yes' | 'no' | 'unsure';
  experience: Experience[];
  /** An http(s) link to a résumé or site the person chose to show. */
  resumeUrl: string | null;
  memberSince: string;
  stats: JobStats;
}

/** The card for an account, or null when there is no such account. (Seam: the work-profile work fills this in; the signature is fixed.) */
export async function personCard(_db: Db, _accountId: string): Promise<PersonCard | null> {
  return null;
}
