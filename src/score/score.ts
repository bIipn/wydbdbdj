import { milesBetween } from '../geo/locate.js';
import { compileKeywords, type Matcher } from './keywords.js';
import { isEquipmentPsc, tradesForPsc } from '../sources/psc.js';
import { pscLabel, subWorkFor } from './subwork.js';
import { FLAGS, NOT_OPEN_FLAGS, PROGRAM_ACRONYMS, PROGRAM_CONTRACT_TERMS, REQUIREMENT_FLAGS, SET_ASIDES } from '../sources/flags.js';
import { getTrade, tradeNoun } from '../trades/catalog.js';
import type { Bid, Profile, Qualifications, Reason, ScoreResult, SpendLimits, Tier, Verdict } from '../types.js';
import { formatMoneyShort, formatRange } from '../util/money.js';

/**
 * Fit score, 0–100, with plain-English reasons so the owner can see *why*.
 *
 *   score = trade + context × tradeFactor − penalties
 *
 *   trade   (0–45)  is this the contractor's own trade?
 *   context (0–55)  distance (25) + job size (15) + days to bid (15)
 *   tradeFactor     strong 1.0 · related 0.75 · general construction 0.45
 *
 * The factor stops "close by and lots of time" from making a road job look good.
 *
 * Gates come before points (each one checked on the 107 real bids of the 2026-11-13 scan):
 *   - a set-aside for a certification program the profile does not hold → hard no ("Reserved for …")
 *   - a program contract (IDIQ, JOC, MATOC, OTA …)                          → hard no ("not a single job")
 *   - a presolicitation or RFI                                              → never alerts, no days-to-bid credit
 *   - a work place we could not measure, outside the home-state boards      → no distance points, never alerts
 *   - paperwork the company said it does not have (SPWD, SAM, bonds, PW)    → stays visible, never alerts
 * A gate only ever lowers a score; it never raises one.
 *
 * Spend limits (profile.limits) come after the fit and never change the score: they add reasons
 * and set overLimit, which keeps a bid out of alerts, the swipe deck and the "next bid" pick.
 */

// ------------------------------------------------------------ keywords --

export { compileKeywords, type Matcher } from './keywords.js';

/** How the reasons name the contractor's own trade. */
interface TradeWords {
  scope: string; // "Electrical scope" → `Electrical scope: “lighting”`
  mentioned: string; // "Electrical work mentioned"
  naics: string; // "electrical contractors" → `NAICS 238210 — electrical contractors`
  specs: string; // "electrical" → `General construction — check the specs for electrical`
  none: string; // the hard no when nothing in the bid is their kind of work
}

const wordsFor = (noun: string): TradeWords => {
  const Noun = noun[0]!.toUpperCase() + noun.slice(1);
  return {
    scope: `${Noun} scope`, mentioned: `${Noun} work mentioned`, naics: `${noun} contractors`, specs: noun,
    none: `No ${noun} or construction scope found`,
  };
};

const SEVERAL_TRADES: TradeWords = {
  scope: 'Your trades', mentioned: 'Your trades mentioned', naics: 'one of your trades', specs: 'your trades',
  none: 'No work in your trades or construction scope found',
};

/**
 * A profile with one catalog trade is named by it ("Roofing scope: …"); with several it reads
 * "Your trades: …". A config profile with no `trades` is the pilot's, and the pilot is electrical.
 */
function tradeWords(p: Profile): TradeWords {
  const ids = p.trades ?? [];
  if (ids.length === 0) return wordsFor('electrical');
  const noun = ids.length === 1 ? tradeNoun(ids[0]!) : null;
  return noun ? wordsFor(noun) : SEVERAL_TRADES;
}

interface Compiled {
  strong: Matcher;
  related: Matcher;
  general: Matcher;
  otherTrades: Matcher;
  exclude: Matcher;
  words: TradeWords;
  /** The catalog trades the profile is scored as: its own, or ['electrical'] for a config profile (the pilot). */
  tradeIds: string[];
}

const cache = new WeakMap<Profile, Compiled>();
function matchers(p: Profile): Compiled {
  let c = cache.get(p);
  if (!c) {
    c = {
      strong: compileKeywords(p.keywords.strong),
      related: compileKeywords(p.keywords.related),
      general: compileKeywords(p.keywords.general),
      otherTrades: compileKeywords(p.keywords.otherTrades),
      exclude: compileKeywords(p.keywords.exclude),
      words: tradeWords(p),
      // No `trades` key at all = a config profile, the pilot's: electrical. An empty list ('hire') = no trade.
      tradeIds: p.trades === undefined ? ['electrical'] : [...p.trades],
    };
    cache.set(p, c);
  }
  return c;
}

// Set-aside codes, flag strings and program-contract terms come from src/sources/flags.ts, the same table the
// parsers write from. A certification set-aside (8(a), HUBZone, SDVOSB, WOSB…) the profile does not list is a
// hard no: an offer from anyone else cannot be awarded. Size standards (SBA, SBP) and unknown codes stay a
// "check you qualify" penalty.

/**
 * The title names work, not just a thing: tells a job (an install, a repair, a maintenance contract) from a
 * purchase on a supply board. A service contract that is not the profile's trade is the exclude list's job.
 */
const WORK_WORDS = compileKeywords([
  'install*', 'replac*', 'repair*', 'upgrad*', 'retrofit*', 'renovat*', 'remodel*', 'rewir*', 'wiring', 'connect*',
  'construct*', 'moderniz*', 'rehabilitat*', 'improvement*', 'conversion', 'maintenance', 'service*',
]);

/** "$465M", "$1.2 million", "$250,000" — the first dollar figure in a title, in dollars. */
const TITLE_AMOUNT = /\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|mm|m|b|million|billion|thousand)?(?![a-z0-9])/i;
const UNIT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
export function titleAmount(title: string | null | undefined): number | null {
  const m = title ? TITLE_AMOUNT.exec(title) : null;
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, '')) * (m[2] ? UNIT[m[2].toLowerCase()]! : 1);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The program-contract term for a bid ("IDIQ", "Job order contract"), from the parser's flag or the title. */
export function programTerm(bid: Pick<Bid, 'title' | 'flags'>): string | null {
  const flagged = bid.flags.some((f) => f === FLAGS.programContract);
  const w = PROGRAM_CONTRACT_TERMS.exec(bid.title)?.[1];
  if (!w) return flagged ? FLAGS.programContract : null; // the parser saw the term in the description
  if (PROGRAM_ACRONYMS.has(w.toLowerCase())) return w.toUpperCase();
  const words = w === w.toUpperCase() ? w.toLowerCase() : w; // a shouting title reads in sentence case
  return words[0]!.toUpperCase() + words.slice(1);
}

/** "Gardnerville, NV" → "NV"; the home state is where the state and county boards list bids without a site. */
function homeState(p: Profile): string | null {
  return /,\s*([A-Z]{2})\s*$/.exec(p.base.label)?.[1] ?? p.states[0] ?? null;
}

/**
 * The highest score a capped bid may keep: one under "good" (55, verdictFor below), so it reads "maybe" at best.
 * Used by every gate that keeps a bid visible but must not ping anyone: no measurable site, not open yet, and
 * paperwork the company said it does not have.
 */
export const BELOW_ALERT_CAP = 54;

/**
 * The lowest score a capped bid is held at: the "maybe" line (verdictFor below). Under it a bid reads "skip"
 * and the swipe deck (web/js/state.js DECK_MIN_SCORE, also 35) drops it. A company whose alert line is 35
 * ("Anything worth a look") would otherwise lose every capped bid from its deck. A capped bid that sits at or
 * above that alert line is still never announced: scoreFit marks it `capped`, and the scan and the alert
 * rules skip capped bids.
 */
export const CAPPED_FLOOR = 35;

/** The cap for this profile: BELOW_ALERT_CAP, and also under its own alert lines, never below CAPPED_FLOOR. */
function capFor(p: Profile): number {
  return Math.max(CAPPED_FLOOR, Math.min(BELOW_ALERT_CAP, p.notify.minScore - 1, (p.alerts?.minScore ?? Infinity) - 1));
}

// --------------------------------------------------------------- paperwork --
//
// Ev's rule: work with companies that have the paperwork AND with companies that do not. A bid is never
// hidden over an answer; the card says what the bid needs and where the company stands:
//   yes            → a plus line ("…: you have it"), no points added
//   unsure / blank → a neutral "check yours" line, no points lost
//   no             → a minus line, and the score is held at BELOW_ALERT_CAP so nobody is pinged for a job
//                    they cannot bid today. They still see it, and can get the paperwork.
// A profile without `qualifications` (the pilot's config, older accounts, the simulation) skips all of this:
// its flags are listed exactly as before.
//
// Which bids need what. The flag strings are written by the parsers (src/util/flags.ts detectFlags, the
// SPWD board's flags in src/sources/questcdn.ts) from REQUIREMENT_FLAGS in src/sources/flags.ts, and read
// here from the same table, so no flag string is typed a second time.

/** The SPWD QuestCDN board's flag. NRS 338.1375: the Division "shall not accept a bid" from a contractor not
 *  qualified under NRS 338.1379 (law.justia.com/codes/nevada/2021/chapter-338/statute-338-1379/). */
const SPWD_FLAGS: ReadonlySet<string> = new Set([REQUIREMENT_FLAGS.spwd]);
/** "Bid bond", "Performance/payment bond": what the notice asks for (we make no claim about the law). */
const BOND_FLAGS: ReadonlySet<string> = new Set([REQUIREMENT_FLAGS.bidBond, REQUIREMENT_FLAGS.perfBond]);
/** "Prevailing wage", "Prevailing wage likely", "Certified payroll". */
const PREVAILING_FLAGS: ReadonlySet<string> = new Set([
  REQUIREMENT_FLAGS.prevailing, REQUIREMENT_FLAGS.prevailingLikely, REQUIREMENT_FLAGS.certifiedPayroll,
]);

interface Need {
  key: keyof Qualifications;
  /** The bid's flags this need covers; their plain info lines are replaced by the one line below. */
  flags: string[];
  have: string;
  check: string;
  lack: string;
}

/** What this bid needs on paper, as far as its flags and source tell. Exported for tests. */
export function paperworkNeeds(bid: Pick<Bid, 'source' | 'flags'>, profile: Profile): Need[] {
  const needs: Need[] = [];
  const spwd = bid.flags.filter((f) => SPWD_FLAGS.has(f));
  if (spwd.length) {
    needs.push({
      // The state-public-works answer is about the HOME state's agency. Only a Nevada company's answer is an
      // answer about SPWD; anyone else gets the neutral line (see `answerFor`).
      key: 'statePublicWorks', flags: spwd,
      have: 'SPWD qualification: you have it',
      check: 'Needs SPWD bidder qualification — check yours',
      lack: 'Needs SPWD bidder qualification — you said you don’t have it yet',
    });
  }
  if (bid.source === 'samgov') {
    // FAR 52.204-7(b)(1): "An Offeror is required to be registered in SAM when submitting an offer or
    // quotation and at time of award" (acquisition.gov/far/52.204-7, FAC 2026-01).
    needs.push({
      key: 'samRegistered', flags: [],
      have: 'SAM.gov registration: you have it',
      check: 'Federal bid — needs SAM.gov registration, check yours',
      lack: 'Federal bid — needs SAM.gov registration; you said you’re not registered yet',
    });
  }
  const bonds = bid.flags.filter((f) => BOND_FLAGS.has(f));
  if (bonds.length) {
    const what = bonds.join(', ');
    needs.push({
      key: 'bonding', flags: bonds,
      have: `${what}: you can get bonds`,
      check: `${what} — check you can get bonded`,
      lack: `${what} — you said you can’t get bonds yet`,
    });
  }
  const pw = bid.flags.filter((f) => PREVAILING_FLAGS.has(f));
  if (pw.length) {
    const what = pw.join(', ');
    needs.push({
      key: 'prevailingWage', flags: pw,
      have: `${what}: you take these jobs`,
      check: `${what} — check you can run certified payroll`,
      lack: `${what} — you said you don’t take prevailing-wage jobs`,
    });
  }
  return needs;
}

/** The company's answer for a need; the state-public-works answer only counts for SPWD when home is Nevada. */
function answerFor(need: Need, q: Qualifications, profile: Profile) {
  if (need.key === 'statePublicWorks' && homeState(profile) !== 'NV') return 'unsure';
  return q[need.key] ?? 'unsure';
}

/**
 * A job posted on BidSwipe itself (source 'local', src/jobs) carries the trades its poster picked from the trades
 * list, as their labels in `category` ("Electrical, Plumbing"). When one of them is one of this company's trades,
 * that is as plain a statement of the trade as a board's text mentioning it. Only local jobs are read this way,
 * so no board's score changes. Returns the label, or null.
 */
export function postedTrade(bid: Pick<Bid, 'source' | 'category'>, profile: Pick<Profile, 'trades'>): string | null {
  if (bid.source !== 'local' || !bid.category) return null;
  const posted = new Set(bid.category.split(',').map((s) => s.trim()));
  for (const id of profile.trades ?? []) {
    const label = getTrade(id)?.label;
    if (label && posted.has(label)) return label;
  }
  return null;
}

export function verdictFor(score: number): Verdict {
  if (score >= 75) return 'great';
  if (score >= 55) return 'good';
  if (score >= 35) return 'maybe';
  return 'skip';
}

/** Sub work's score scale (src/score/subwork.ts): 36 at the least, 50 at the most, from reach + size + time left. */
export const SUB_MIN = 36;
export const SUB_MAX = 50;
/** The most the context can add: distance 25 + job size 15 + days to bid 15. */
const CONTEXT_MAX = 55;

/** The tier a scored bid that is not sub work gets: 'fit' at the deck line (CAPPED_FLOOR) or above, else 'other'. */
export function tierFor(score: number): Tier {
  return score >= CAPPED_FLOOR ? 'fit' : 'other';
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The fit alone, before spend limits. This is what scoreBid returns for a profile that has set none. */
export function scoreFit(bid: Bid, profile: Profile, now: Date = new Date()): ScoreResult {
  const m = matchers(profile);
  const plus: Reason[] = [];
  const minus: Reason[] = [];
  const info: Reason[] = [];
  let rejected: string | null = null;
  /** A hard no; when the bid already is one, the new reason is listed as a minus instead. */
  const reject = (text: string) => {
    if (rejected) minus.push({ kind: 'minus', text });
    else rejected = text;
  };
  let capped = false; // a gate that keeps the bid below the alert line

  // ---- trade ------------------------------------------------------------
  const title = bid.title;
  const body = [bid.category, bid.description].filter(Boolean).join(' · ');
  const strongTitle = m.strong.test(title);
  const strongBody = strongTitle ? null : m.strong.test(body);
  const naicsStrong = !!bid.naics && profile.naics.strong.includes(bid.naics);
  const naicsRelated = !!bid.naics && profile.naics.related.includes(bid.naics);
  const relatedTitle = m.related.test(title);
  const relatedBody = relatedTitle ? null : m.related.test(body);
  const general = m.general.test(title) ?? m.general.test(body);
  // A federal product-service code of one of the company's trades: a building, facility or service code (Y, Z, S,
  // F, P, M) counts like the trade's own NAICS code. An equipment code (J, N, K, H: repair, installation of
  // equipment) is only a weak signal unless the title names the scope: group 059 "electrical and electronic equipment components" is
  // radar, avionics and radio repair as often as it is building electrical (real 2026-11-14 notices).
  const pscHit = !naicsStrong && !!bid.psc && tradesForPsc(bid.psc).some((t) => m.tradeIds.includes(t));
  const pscEquip = pscHit && isEquipmentPsc(bid.psc);
  const pscTrade = pscHit && !pscEquip;
  const posted = strongTitle || naicsStrong || pscTrade ? null : postedTrade(bid, profile);
  const supplyOnly = bid.flags.includes('May be supply-only') && !WORK_WORDS.test(title);
  const otherInTitle = !strongTitle ? m.otherTrades.test(title) : null;
  // Sub work (src/score/subwork.ts) is decided before the weaker trade signals: a building or road prime whose
  // only tie to the trade is its text, a broad NAICS code or a generic word is a GC's job, not a fit.
  const sub = subWorkFor(bid, m.tradeIds, {
    fitInTitle: !!(strongTitle || naicsStrong || pscHit || posted || relatedTitle), otherInTitle, supplyOnly,
    program: programTerm(bid) !== null,
  });

  let trade = 0;
  let factor = 0;
  if (strongTitle && (naicsStrong || pscHit)) {
    trade = 45; factor = 1;
    plus.push({ kind: 'plus', text: `${m.words.scope}: “${strongTitle}” + ${naicsStrong ? `NAICS ${bid.naics}` : `PSC ${bid.psc}`}` });
  } else if (strongTitle) {
    trade = 40; factor = 1;
    plus.push({ kind: 'plus', text: `${m.words.scope}: “${strongTitle}”` });
  } else if (naicsStrong) {
    trade = 36; factor = 1;
    plus.push({ kind: 'plus', text: `NAICS ${bid.naics} — ${m.words.naics}` });
  } else if (pscTrade) {
    trade = 36; factor = 1;
    plus.push({ kind: 'plus', text: `Filed as ${pscLabel(bid.psc!)}` });
  } else if (posted) {
    // Worth the same as the trade named in a notice's text (strongBody below).
    trade = 30; factor = 1;
    plus.push({ kind: 'plus', text: `Posted as ${posted} work` });
  } else if (sub) {
    trade = 1; factor = 1; // never used for the score (subScore below); non-zero so it is not "no scope found"
  } else if (strongBody) {
    trade = 30; factor = 1;
    plus.push({ kind: 'plus', text: `${m.words.mentioned}: “${strongBody}”` });
  } else if (relatedTitle) {
    trade = 18; factor = 0.75;
    plus.push({ kind: 'plus', text: `Related trade: “${relatedTitle}”` });
  } else if (naicsRelated) {
    trade = 15; factor = 0.75;
    plus.push({ kind: 'plus', text: `NAICS ${bid.naics} — related construction` });
  } else if (pscEquip) {
    // Weak on its own: at most 8 + 55 × 0.45 ≈ 33, under the deck line, unless the title names the trade's scope.
    trade = 8; factor = 0.45;
    plus.push({ kind: 'plus', text: `Filed as ${pscLabel(bid.psc!)} — equipment work, check the scope` });
  } else if (relatedBody) {
    trade = 12; factor = 0.75;
    plus.push({ kind: 'plus', text: `Related trade mentioned: “${relatedBody}”` });
  } else if (general) {
    info.push({ kind: 'info', text: `General construction — check the specs for ${m.words.specs}` });
    trade = 8; factor = 0.45;
  }

  // A program contract is a seat on a multi-site contract, not one job: no trade word or NAICS code lets it through.
  const program = programTerm(bid);
  const amount = titleAmount(title);
  if (program) {
    const big = amount !== null && amount > profile.valueRange.max ? `, ${formatMoneyShort(amount)}` : '';
    reject(program === FLAGS.programContract ? `Program contract${big ? ` (${big.slice(2)})` : ''} — not a single job` : `Program contract (“${program}”${big}) — not a single job`);
  }

  const excluded = m.exclude.test(title) ?? m.exclude.test(bid.category);
  if (excluded && !strongTitle && !naicsStrong && !pscTrade) reject(`Not your trade (“${excluded}”)`);
  else if (trade === 0) reject(m.words.none);

  const other = otherInTitle;
  let penalty = 0;
  if (other) {
    penalty += 20;
    minus.push({ kind: 'minus', text: `Mostly another trade (“${other}”)` });
  }

  // ---- distance ---------------------------------------------------------
  let distanceMi: number | null = null;
  let dist = 8;
  const loc = bid.location;
  const atOffice = bid.flags.includes(FLAGS.placeFromOffice);
  if (loc.lat != null && loc.lng != null && atOffice) {
    // The notice names no work site; the point is its contracting office. The miles are real miles to the office,
    // not to the job: no distance points, never an alert (the same cap as a site we cannot measure).
    distanceMi = Math.round(milesBetween(profile.base, { lat: loc.lat, lng: loc.lng }));
    dist = 0; capped = true;
    if (distanceMi > profile.maxDistanceMi) {
      rejected ??= `${distanceMi} mi to the contracting office — outside your ${profile.maxDistanceMi} mi range (work site not named)`;
    } else {
      minus.push({ kind: 'minus', text: `Work site not named — ${distanceMi} mi is to the contracting office, check the notice` });
    }
  } else if (loc.lat != null && loc.lng != null) {
    distanceMi = Math.round(milesBetween(profile.base, { lat: loc.lat, lng: loc.lng }));
    const approx = loc.precision === 'exact' || loc.precision === 'city' ? '' : ' (approx.)';
    if (distanceMi > profile.maxDistanceMi) {
      rejected ??= `${distanceMi} mi away — outside your ${profile.maxDistanceMi} mi range`;
      dist = 0;
    } else {
      dist = distanceMi <= 25 ? 25 : distanceMi <= 50 ? 20 : distanceMi <= 75 ? 12 : 6;
      (distanceMi <= 50 ? plus : info).push({
        kind: distanceMi <= 50 ? 'plus' : 'info',
        text: `${distanceMi} mi from ${profile.base.label}${approx}`,
      });
    }
  } else if (loc.state && !profile.states.includes(loc.state)) {
    rejected ??= `Out of your states (${loc.state})`;
    dist = 0;
  } else if (atOffice) {
    // The title names the job's state, not the office's (src/geo/locate.ts stateInTitle): a state, no point.
    dist = 0; capped = true;
    minus.push({ kind: 'minus', text: `Work site not named — only the state is known (${loc.state ?? '?'}), check the distance` });
  } else {
    // No point to measure. Only a home-state board listing (state known, no site given) keeps the neutral
    // points; anything else could be anywhere, so it gets none and cannot alert.
    const listed = [loc.city, loc.zip].filter((s) => s && /[a-z0-9]/i.test(s)).join(' ')
      || (loc.label && !/\(location not listed\)$/.test(loc.label) ? loc.label : '');
    if (listed && loc.precision !== 'region') {
      dist = 0; capped = true;
      const several = /\b(various|multiple|several)\b|\bother locations\b/i.test(listed);
      minus.push({
        kind: 'minus',
        text: several ? 'Several work sites listed — check which are in reach' : `Location could not be placed (“${listed.slice(0, 60)}”) — check the distance`,
      });
    } else if (loc.state && loc.state === homeState(profile)) {
      const region = loc.precision === 'region' && loc.label ? loc.label : null;
      const text = !region ? 'Work location not listed — check the bid' : /not listed/i.test(region) ? region : `${region} — exact site not listed, check the bid`;
      info.push({ kind: 'info', text });
    } else {
      dist = 0; capped = true;
      info.push({ kind: 'info', text: `Work location not listed — can't confirm it's within ${profile.maxDistanceMi} mi` });
    }
  }

  // ---- job size ---------------------------------------------------------
  // Only what the notice says: an estimate, or a dollar figure in its own title. Never a guess from the agency.
  let value = 7;
  const est = bid.estValue && (bid.estValue.min != null || bid.estValue.max != null) ? bid.estValue
    : amount !== null && !program ? { min: null, max: amount } : null;
  const v = est ? est.max ?? est.min : null;
  if (est && v != null && sub) {
    // The figure is the WHOLE prime contract; the company's part is a share of it, how big we cannot say. Only
    // what is certain counts: a whole job under the company's smallest job leaves its part smaller still.
    const label = bid.estValue ? `est. ${formatRange(est)}` : `named in the notice: ${formatMoneyShort(v)}`;
    if (v < profile.valueRange.min) {
      value = 0;
      minus.push({ kind: 'minus', text: `Whole job ${label} — your part would be under your usual jobs` });
    } else info.push({ kind: 'info', text: `Whole job ${label} — your part is a share of it` });
  } else if (est && v != null) {
    const label = bid.estValue ? `Est. ${formatRange(est)}` : `Notice names ${formatMoneyShort(v)}`;
    const { min, max } = profile.valueRange;
    if (v >= min && v <= max) {
      value = 15;
      plus.push({ kind: 'plus', text: `${label} — right in your range` });
    } else if (v < min) {
      value = 8;
      info.push({ kind: 'info', text: `Small job (${label[0]!.toLowerCase()}${label.slice(1)})` });
    } else if (v <= max * 3) {
      value = 4; // known to be over the range scores below an unknown size (7)
      minus.push({ kind: 'minus', text: `${label} — bigger than your usual jobs` });
    } else {
      value = 0;
      minus.push({ kind: 'minus', text: `${label} — large job; sub to the GC?` });
    }
  } else if (!program) {
    info.push({ kind: 'info', text: 'Job size not stated' });
  }

  // ---- time to bid ------------------------------------------------------
  const notOpen = NOT_OPEN_FLAGS.find(({ flag }) => bid.flags.includes(flag));
  let runway = 7;
  if (bid.dueAt) {
    const days = (Date.parse(bid.dueAt) - now.getTime()) / 86_400_000;
    const whole = Math.floor(days);
    if (days < 0) {
      rejected ??= 'Bid deadline has passed';
      runway = 0;
    } else if (notOpen) {
      // A response date on a notice with no bid package is not "days to bid": no reason, and no more than the
      // neutral points (a close date still costs, so the gate never raises a score).
      runway = days < 1 ? 2 : days < profile.minDaysToBid ? 4 : 7;
    } else if (days < 1) {
      runway = 2;
      minus.push({ kind: 'minus', text: 'Due within 24 hours' });
    } else if (days < profile.minDaysToBid) {
      runway = 4;
      minus.push({ kind: 'minus', text: `Only ${plural(whole, 'day')} to bid` });
    } else if (days < 14) {
      runway = 10;
      info.push({ kind: 'info', text: `${plural(whole, 'day')} to bid` });
    } else {
      runway = 15;
      plus.push({ kind: 'plus', text: `${plural(whole, 'day')} to bid` });
    }
  } else if (!notOpen) {
    info.push({ kind: 'info', text: 'No deadline listed' });
  }
  if (notOpen) {
    capped = true;
    minus.push({ kind: 'minus', text: notOpen.text });
  }

  // ---- set-asides & requirements -----------------------------------------
  if (bid.setAside && !profile.setAsidesEligible.includes(bid.setAside)) {
    const known = SET_ASIDES[bid.setAside];
    // A set-aside says who may bid the prime contract. Sub work is quoted to the bidders, so it is said, not held against it.
    if (sub) info.push({ kind: 'info', text: `${known?.label ?? bid.setAside} set-aside — it applies to the prime bidder` });
    else if (known?.reserved) reject(known.reserved);
    else {
      penalty += 15;
      minus.push({ kind: 'minus', text: `${known?.label ?? bid.setAside} set-aside — check you qualify` });
    }
  }
  // A supply board lists purchases and installs alike. A title that names no work is most likely a purchase.
  if (supplyOnly) {
    penalty += 25;
    if (!rejected) minus.push({ kind: 'minus', text: 'No work named in the title — may be a purchase, not a job' });
  } else if (bid.flags.includes('May be supply-only')) penalty += 5;
  const quals = profile.qualifications;
  // FAR 52.204-7 asks the OFFEROR to be registered in SAM; a sub quoting the bidders is not the offeror.
  const needs = quals ? paperworkNeeds(bid, profile).filter((n) => !(sub && n.key === 'samRegistered')) : [];
  const covered = new Set(needs.flatMap((n) => n.flags));
  for (const f of bid.flags) {
    if (supplyOnly && f === 'May be supply-only') continue; // said by the minus above
    if (f === FLAGS.programContract || NOT_OPEN_FLAGS.some(({ flag }) => flag === f)) continue; // said above
    if (covered.has(f)) continue; // said by its paperwork line below
    if (f === FLAGS.placeFromOffice && atOffice) continue; // said by the distance line
    info.push({ kind: 'info', text: f });
  }
  for (const need of needs) {
    const a = answerFor(need, quals!, profile);
    if (a === 'yes') plus.push({ kind: 'plus', text: need.have });
    else if (a === 'no') {
      capped = true;
      minus.push({ kind: 'minus', text: need.lack });
    } else info.push({ kind: 'info', text: need.check });
  }

  if (sub) {
    // Sub work's own short scale: SUB_MIN–SUB_MAX from reach, time left and size, always 'maybe', always capped (so
    // never an alert, never a digest), never above a real fit of 55+. Its first reasons say what it is and what to do.
    const score = rejected ? 0 : SUB_MIN + Math.round(((SUB_MAX - SUB_MIN) * (dist + value + runway)) / CONTEXT_MAX);
    const lead: Reason[] = [
      { kind: 'info', text: sub.why },
      ...(sub.filed ? [{ kind: 'info' as const, text: sub.filed }] : []),
      { kind: 'info', text: sub.action },
    ];
    const reasons: Reason[] = rejected ? [{ kind: 'minus', text: rejected }, ...lead, ...plus, ...minus, ...info] : [...lead, ...plus, ...minus, ...info];
    return {
      score, verdict: verdictFor(score), reasons, distanceMi: atOffice ? null : distanceMi, rejected, overLimit: false,
      ...(rejected ? {} : { capped: true }),
      tier: rejected ? 'other' : 'sub',
    };
  }

  const raw = trade + (dist + value + runway) * factor - penalty;
  const fit = Math.max(0, Math.min(100, Math.round(raw)));
  // No point and no state: the job could be anywhere, abroad included ("USAG Humphreys"). It stays in Browse but is
  // held under the deck line, so it is never counted a fit (sub work has the same rule, src/score/subwork.ts).
  const nowhere = loc.lat == null && !loc.state;
  const score = rejected ? 0 : nowhere ? Math.min(fit, CAPPED_FLOOR - 1) : capped ? Math.min(fit, capFor(profile)) : fit;
  const reasons: Reason[] = rejected ? [{ kind: 'minus', text: rejected }, ...plus, ...minus, ...info] : [...plus, ...minus, ...info];
  // `capped` is only written when true, so results without a gate look exactly as they always did.
  return {
    score, verdict: verdictFor(score), reasons, distanceMi: atOffice ? null : distanceMi, rejected, overLimit: false,
    ...((capped || nowhere) && !rejected ? { capped: true } : {}),
    tier: tierFor(score),
  };
}

// -------------------------------------------------------- spend limits --

type Estimate = NonNullable<Bid['estValue']>;

/** A limit counts when it is a positive dollar amount; absent, null or 0 means "not set". */
const limitOf = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);

const dollars = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/** The contractor's own figure, never rounded: "$100K" / "$1.5M" when the short form is exact, otherwise "$75,500". */
function ownMoney(n: number): string {
  const step = n >= 1e7 ? 1e6 : n >= 1e6 ? 1e5 : 1e3; // the precision formatMoneyShort keeps at this size
  return n % step === 0 ? formatMoneyShort(n) : dollars(n);
}

/** The estimate as the card shows it ("$180K"), spelled out when rounding would make it read the same as the limit. */
function estLabel(est: Estimate, limit: number): string {
  const short = formatRange(est);
  return short === ownMoney(limit) ? dollars((est.min ?? est.max)!) : short;
}

/**
 * Where an estimate sits against a limit.
 *   over  = all of it is above the limit: a single figure, or the low end of a range
 *   maybe = only the top of a range, or the ceiling of an "under $X" estimate, is above it
 * Only "over" hides a bid: a range that straddles the limit can still come in under it.
 */
function against(est: Estimate, limit: number | null): 'over' | 'maybe' | 'ok' {
  if (limit === null) return 'ok';
  if (est.min != null && est.min > limit) return 'over';
  const top = est.max ?? est.min;
  return top != null && top > limit ? 'maybe' : 'ok';
}

const PCT = String.raw`(?<![\d.,])(\d{1,2}(?:\.\d{1,2})?)\s?(?:%|per\s?cent)`;
const BID_SECURITY = String.raw`\bbid\s+(?:bond|security|guarantee|guaranty)\b`;
// What may stand between "bid bond" and its figure: only the stock wording of a bid-security clause
// ("…, cashier's check or certified check in an amount not less than…"). Any other word — retention,
// performance, contingency — means the figure may belong to something else, so we do not guess.
const CLAUSE = String.raw`(?:\s|[,()/]|\b(?:in|the|an?|amount|sum|of|not|less|than|at|least|equal|to|shall|must|will|be|is|are|required|or|and|cashier['’]?s?|certified|checks?|money|order|surety|bonds?|security|deposit|made|payable)\b){0,40}?`;
// "bid bond in the amount of five percent (5%)": an amount word right before the figure.
const SECURITY_THEN_PCT = new RegExp(`${BID_SECURITY}${CLAUSE}\\b(?:of|to|than|least|is|be)\\s(?:[a-z-]+\\sper\\s?cent\\s)?\\(?${PCT}`, 'gi');
const LABEL_THEN_PCT = new RegExp(`${BID_SECURITY}\\s?[:=–-]\\s?${PCT}`, 'gi'); // "Bid Bond: 5%"
const PCT_THEN_SECURITY = new RegExp(`${PCT}\\)?\\s${BID_SECURITY}`, 'gi'); // "a 5% bid bond"

/**
 * The bid-bond percentage a notice states, e.g. 5 for "bid bond in the amount of five percent (5%)".
 * Null unless the text ties exactly one figure to the bid bond: every mention has to agree, and
 * anything above 25% is taken as a misread rather than a bid bond.
 */
export function parseBidBondPct(text: string | null | undefined): number | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ');
  const found = new Set<number>();
  for (const re of [SECURITY_THEN_PCT, LABEL_THEN_PCT, PCT_THEN_SECURITY]) {
    for (const m of flat.matchAll(re)) found.add(Number(m[1]));
  }
  const [pct] = [...found];
  return found.size === 1 && pct !== undefined && pct > 0 && pct <= 25 ? pct : null;
}

/** "5% bid bond ≈ $4,050 (est. $81K)": the notice's own percentage applied to the estimate we have. */
function bondMath(pct: number, est: Estimate): string {
  const share = (v: number) => dollars((v * pct) / 100);
  const top = (est.max ?? est.min)!;
  const amount =
    est.min == null ? `up to ${share(top)}` : est.max != null && est.max !== est.min ? `${share(est.min)}–${share(est.max)}` : share(top);
  return `${pct}% bid bond ≈ ${amount} (est. ${formatRange(est)})`;
}

/** Said when a bid bond is required but the notice text we hold does not state its percentage. */
export const BOND_NOTE = 'Bid bond is often 5–10% of the bid — check the notice';

/**
 * Spend limits on top of a fit. Score, verdict and rejection pass through untouched.
 *   - est. value over limits.maxJobSize                        → overLimit
 *   - a bond is required and est. value over bondingCapacity   → overLimit
 *   - bid bond + known value, not over: bond math from the notice's own percentage, else BOND_NOTE
 * With no limit set, or no estimate to compare, nothing is added.
 */
function applyLimits(fit: ScoreResult, bid: Bid, limits: SpendLimits | undefined): ScoreResult {
  // Sub work: the estimate and the bond belong to the prime bidder, not to the company's part of it.
  if (fit.tier === 'sub') return fit;
  const maxJob = limitOf(limits?.maxJobSize);
  const bonding = limitOf(limits?.bondingCapacity);
  const est = bid.estValue;
  const anyLimit = maxJob ?? bonding ?? limitOf(limits?.maxUpfront);
  if (anyLimit === null || !est || (est.min == null && est.max == null)) return fit;

  const minus: Reason[] = [];
  const job = against(est, maxJob);
  if (maxJob !== null && job !== 'ok') {
    minus.push({ kind: 'minus', text: `Est. ${estLabel(est, maxJob)} — ${job === 'over' ? 'over' : 'may run over'} your ${ownMoney(maxJob)} job limit` });
  }
  const bond = bid.flags.some((f) => BOND_FLAGS.has(f)) ? against(est, bonding) : 'ok';
  if (bonding !== null && bond !== 'ok') {
    const verb = bond === 'over' ? 'is over' : 'may run over';
    minus.push({ kind: 'minus', text: `Bond required — est. ${estLabel(est, bonding)} ${verb} your ${ownMoney(bonding)} bonding capacity` });
  }
  const overLimit = job === 'over' || bond === 'over';

  const info: Reason[] = [];
  if (!overLimit && bid.flags.includes(REQUIREMENT_FLAGS.bidBond)) {
    const pct = parseBidBondPct(bid.description);
    info.push({ kind: 'info', text: pct === null ? BOND_NOTE : bondMath(pct, est) });
  }

  // Limit reasons lead the minuses (after the rejection and the pluses); the bond note joins the infos.
  let at = fit.rejected ? 1 : 0;
  while (fit.reasons[at]?.kind === 'plus') at++;
  return { ...fit, reasons: [...fit.reasons.slice(0, at), ...minus, ...fit.reasons.slice(at), ...info], overLimit };
}

export function scoreBid(bid: Bid, profile: Profile, now: Date = new Date()): ScoreResult {
  return applyLimits(scoreFit(bid, profile, now), bid, profile.limits);
}
