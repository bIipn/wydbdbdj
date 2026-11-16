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
  /**
   * BidSwipe hid this card after a report (POST /api/admin/people/:id/hide). Then everything the person wrote is
   * empty (null, [], 'unsure') and only what the lite card shows is left: the name, member since, the job record.
   */
  hidden: boolean;
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
/** The name on a card BidSwipe has hidden: none of the person's own words, not even their name. */
export const HIDDEN_NAME = 'BidSwipe member';

export const isDefaultShopName = (name: string): boolean => /^My( .+)? shop$/.test(name);

/**
 * The card for an account, or null when there is no such account. `forOperator`: the text even when the card is hidden
 * (the operators' report list only; never an answer to a user). Built field by field from the work
 * profile, so nothing else stored about the account (email, phone, the address on a job) can slip onto it.
 */
export async function personCard(db: Db, accountId: string, opts: { forOperator?: boolean } = {}): Promise<PersonCard | null> {
  const facts = await cardFacts(db, accountId);
  if (!facts) return null;
  if (facts.hidden && !opts.forOperator) {
    // Hidden by BidSwipe: the work profile is not even read, so none of its text can reach another person. The name
    // is user-written too (a business or account name an operator cannot edit), so it goes as well (review rs-4).
    return {
      id: accountId, name: HIDDEN_NAME, headline: null, about: null, yearsExperience: null, skills: [],
      license: null, insured: 'unsure', experience: [], resumeUrl: null, memberSince: facts.createdAt, stats: await jobStats(db, accountId), hidden: true,
    };
  }
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
    hidden: facts.hidden,
  };
}
