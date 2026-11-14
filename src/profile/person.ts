import type { Db } from '../db/db.js';
import { cardFacts, getWorkProfile } from '../db/work.js';
import { jobStats, type JobStats } from '../jobs/stats.js';

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

/** Who a card is for when nothing better is known. */
export const ANONYMOUS_NAME = 'BidSwipe member';

/**
 * The name on a card: the business name from the profile, else the account's own name, else "BidSwipe member".
 * A name that looks like an email address is skipped (a sign-in provider can fill the name with one), so
 * a card never shows an email.
 */
export function cardName(businessName: string | null, accountName: string | null): string {
  for (const n of [businessName, accountName]) {
    const name = n?.replace(/\s+/g, ' ').trim();
    if (name && !name.includes('@') && !(n === businessName && isDefaultShopName(name))) return name;
  }
  // Only the onboarding default was there: better that than nothing.
  const fallback = businessName?.replace(/\s+/g, ' ').trim();
  return fallback && !fallback.includes('@') ? fallback : ANONYMOUS_NAME;
}

/**
 * The name onboarding fills in when the business-name step is skipped ("My electrical shop", "My shop":
 * web/js/profile-form.js defaultBusinessName). Every electrician who skipped the step has the same one, so on a
 * card it would leave the poster unable to tell bidders apart: the account's own name is used instead.
 */
export const isDefaultShopName = (name: string): boolean => /^My( .+)? shop$/.test(name);

/**
 * The card for an account, or null when there is no such account. Built field by field from the work
 * profile, so nothing else stored about the account (email, phone, the address on a job) can slip onto it.
 */
export async function personCard(db: Db, accountId: string): Promise<PersonCard | null> {
  const facts = await cardFacts(db, accountId);
  if (!facts) return null;
  const [wp, stats] = await Promise.all([getWorkProfile(db, accountId), jobStats(db, accountId)]);
  return {
    id: accountId,
    name: cardName(facts.businessName, facts.accountName),
    headline: wp.headline,
    about: wp.about,
    yearsExperience: wp.yearsExperience,
    skills: [...wp.skills],
    license: wp.license ? { state: wp.license.state, number: wp.license.number } : null,
    insured: wp.insured,
    experience: wp.experience.map((e) => ({ title: e.title, company: e.company, from: e.from, to: e.to, summary: e.summary })),
    resumeUrl: wp.resumeUrl,
    memberSince: facts.createdAt,
    stats,
  };
}
