import { milesBetween } from '../geo/locate.js';
import { tradeNoun } from '../trades/catalog.js';
import type { Bid, Profile, Reason, ScoreResult, SpendLimits, Verdict } from '../types.js';
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
 * A gate only ever lowers a score; it never raises one.
 *
 * Spend limits (profile.limits) come after the fit and never change the score: they add reasons
 * and set overLimit, which keeps a bid out of alerts, the swipe deck and the "next bid" pick.
 */

// ------------------------------------------------------------ keywords --

export interface Matcher {
  test(text: string | null | undefined): string | null; // returns the keyword that hit
}

/** "electric*" → prefix match; anything else → whole word/phrase. Case-insensitive. */
export function compileKeywords(list: string[]): Matcher {
  const regs = list.map((kw) => {
    const prefix = kw.endsWith('*');
    const body = (prefix ? kw.slice(0, -1) : kw).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return { kw: prefix ? kw.slice(0, -1) : kw, re: new RegExp(`(?<![a-z0-9])${body}${prefix ? '' : '(?![a-z0-9])'}`, 'i') };
  });
  return {
    test(text) {
      if (!text) return null;
      for (const { kw, re } of regs) if (re.test(text)) return kw;
      return null;
    },
  };
}

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
  /** Works inside buildings (the pilot is electrical), so a renovation is likely to carry some of its scope. */
  insideTrades: boolean;
}
/** Catalog trades whose work is outside the building: a remodel is not their scope. */
const OUTSIDE_TRADES: ReadonlySet<string> = new Set(['roofing', 'concrete-paving', 'landscaping', 'sitework', 'fencing']);

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
      insideTrades: (p.trades ?? []).length === 0 || (p.trades ?? []).some((t) => !OUTSIDE_TRADES.has(t)),
    };
    cache.set(p, c);
  }
  return c;
}

const SET_ASIDE_LABELS: Record<string, string> = {
  SBA: 'Small business', SBP: 'Partial small business', '8A': '8(a)', '8AN': '8(a) sole source',
  HZC: 'HUBZone', HZS: 'HUBZone sole source', SDVOSBC: 'Service-disabled veteran', SDVOSBS: 'SDVOSB sole source',
  WOSB: 'Women-owned', WOSBSS: 'WOSB sole source', EDWOSB: 'Economically disadvantaged WOSB', VSA: 'Veteran-owned',
  ISBEE: 'Indian small business',
};

/**
 * Set-asides only a certified firm can win. An offer from anyone else cannot be awarded, so a profile
 * that does not list the code gets a hard no. Size-standard set-asides (SBA, SBP) and codes not listed
 * here stay a "check you qualify" penalty.
 */
const RESERVED_FOR: Record<string, string> = {
  '8A': 'Reserved for 8(a) firms',
  '8AN': 'Sole source to an 8(a) firm',
  HZC: 'Reserved for HUBZone firms',
  HZS: 'Sole source to a HUBZone firm',
  SDVOSBC: 'Reserved for service-disabled veteran-owned firms',
  SDVOSBS: 'Sole source to a service-disabled veteran-owned firm',
  WOSB: 'Reserved for women-owned small businesses',
  WOSBSS: 'Sole source to a women-owned small business',
  EDWOSB: 'Reserved for economically disadvantaged women-owned small businesses',
  EDWOSBSS: 'Sole source to an economically disadvantaged women-owned small business',
  VSA: 'Reserved for veteran-owned small businesses',
  VSS: 'Sole source to a veteran-owned small business',
  ISBEE: 'Reserved for Indian small business economic enterprises',
  IEE: 'Reserved for Indian economic enterprises',
  BICiv: 'Reserved for Indian-owned firms (Buy Indian)',
};

/** A contract vehicle: a seat on a multi-site, multi-order contract, not one job. Whole words, any case. */
const PROGRAM_WORDS = /(?<![a-z0-9])(idiq|joc|matoc|macc|satoc|job order contract|multiple award|indefinite delivery|other transaction authority)(?![a-z0-9])/i;
const ACRONYMS = new Set(['idiq', 'joc', 'matoc', 'macc', 'satoc']);

/** The flag the federal parser sets, e.g. "Program contract (IDIQ)". */
const PROGRAM_FLAG = /^program contract\b(?:\s*\(([^)]+)\))?/i;
/** Not biddable yet: SAM.gov presolicitations and NGEM requests for information. */
const NOT_OPEN_FLAGS: ReadonlyArray<{ re: RegExp; text: string }> = [
  { re: /^presolicitation\b/i, text: 'Presolicitation — not open for bids yet' },
  { re: /^rfi\b/i, text: 'RFI — info only, not a bid' },
];

/**
 * The title names work, not just a thing: tells a job (an install, a repair, a maintenance contract) from a
 * purchase on a supply board. A service contract that is not the profile's trade is the exclude list's job.
 */
const WORK_WORDS = compileKeywords([
  'install*', 'replac*', 'repair*', 'upgrad*', 'retrofit*', 'renovat*', 'remodel*', 'rewir*', 'wiring', 'connect*',
  'construct*', 'moderniz*', 'rehabilitat*', 'improvement*', 'conversion', 'maintenance', 'service*',
]);

/** General-construction words that mean building work, which usually carries a sub scope for each trade. */
const BUILDING_WORDS = compileKeywords(['renovation*', 'remodel*', 'tenant improvement*', 'restroom*']);

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
  for (const f of bid.flags) {
    const m = PROGRAM_FLAG.exec(f);
    if (m) return m[1]?.trim() || (PROGRAM_WORDS.exec(bid.title)?.[1] ?? 'program').replace(/^./, (c) => c.toUpperCase());
  }
  const w = PROGRAM_WORDS.exec(bid.title)?.[1];
  if (!w) return null;
  if (ACRONYMS.has(w.toLowerCase())) return w.toUpperCase();
  const words = w === w.toUpperCase() ? w.toLowerCase() : w; // a shouting title reads in sentence case
  return words[0]!.toUpperCase() + words.slice(1);
}

/** "Gardnerville, NV" → "NV"; the home state is where the state and county boards list bids without a site. */
function homeState(p: Profile): string | null {
  return /,\s*([A-Z]{2})\s*$/.exec(p.base.label)?.[1] ?? p.states[0] ?? null;
}

/** The highest score a gated bid may keep: below every alert line, never above "maybe", never below 0. */
function capFor(p: Profile): number {
  return Math.max(0, Math.min(54, p.notify.minScore - 1, (p.alerts?.minScore ?? Infinity) - 1));
}

export function verdictFor(score: number): Verdict {
  if (score >= 75) return 'great';
  if (score >= 55) return 'good';
  if (score >= 35) return 'maybe';
  return 'skip';
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

  let trade = 0;
  let factor = 0;
  if (strongTitle && naicsStrong) {
    trade = 45; factor = 1;
    plus.push({ kind: 'plus', text: `${m.words.scope}: “${strongTitle}” + NAICS ${bid.naics}` });
  } else if (strongTitle) {
    trade = 40; factor = 1;
    plus.push({ kind: 'plus', text: `${m.words.scope}: “${strongTitle}”` });
  } else if (naicsStrong) {
    trade = 36; factor = 1;
    plus.push({ kind: 'plus', text: `NAICS ${bid.naics} — ${m.words.naics}` });
  } else if (strongBody) {
    trade = 30; factor = 1;
    plus.push({ kind: 'plus', text: `${m.words.mentioned}: “${strongBody}”` });
  } else if (relatedTitle) {
    trade = 18; factor = 0.75;
    plus.push({ kind: 'plus', text: `Related trade: “${relatedTitle}”` });
  } else if (naicsRelated) {
    trade = 15; factor = 0.75;
    plus.push({ kind: 'plus', text: `NAICS ${bid.naics} — related construction` });
  } else if (relatedBody) {
    trade = 12; factor = 0.75;
    plus.push({ kind: 'plus', text: `Related trade mentioned: “${relatedBody}”` });
  } else if (general) {
    info.push({ kind: 'info', text: `General construction — check the specs for ${m.words.specs}` });
    // Building work (a renovation, a restroom remodel) usually carries a sub scope for the building trades,
    // so it can reach "maybe" (max 12 + 55 × 0.75 = 53, never an alert). Other general work stays below it.
    const building = m.insideTrades ? BUILDING_WORDS.test(title) ?? BUILDING_WORDS.test(bid.category) : null;
    if (building) {
      trade = 12; factor = 0.75;
      info.push({ kind: 'info', text: `Building work (“${building}”) — often has a sub scope` });
    } else {
      trade = 8; factor = 0.45;
    }
  }

  // A program contract is a seat on a multi-site contract, not one job: no trade word or NAICS code lets it through.
  const program = programTerm(bid);
  const amount = titleAmount(title);
  if (program) {
    const big = amount !== null && amount > profile.valueRange.max ? `, ${formatMoneyShort(amount)}` : '';
    reject(`Program contract (“${program}”${big}) — not a single job`);
  }

  const excluded = m.exclude.test(title) ?? m.exclude.test(bid.category);
  if (excluded && !strongTitle && !naicsStrong) reject(`Not your trade (“${excluded}”)`);
  else if (trade === 0) reject(m.words.none);

  const other = !strongTitle ? m.otherTrades.test(title) : null;
  let penalty = 0;
  if (other) {
    penalty += 20;
    minus.push({ kind: 'minus', text: `Mostly another trade (“${other}”)` });
  }

  // ---- distance ---------------------------------------------------------
  let distanceMi: number | null = null;
  let dist = 8;
  const loc = bid.location;
  if (loc.lat != null && loc.lng != null) {
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
  if (est && v != null) {
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
  const notOpen = NOT_OPEN_FLAGS.find(({ re }) => bid.flags.some((f) => re.test(f)));
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
    const reserved = RESERVED_FOR[bid.setAside];
    if (reserved) reject(reserved);
    else {
      penalty += 15;
      minus.push({ kind: 'minus', text: `${SET_ASIDE_LABELS[bid.setAside] ?? bid.setAside} set-aside — check you qualify` });
    }
  }
  // A supply board lists purchases and installs alike. A title that names no work is most likely a purchase.
  const supplyOnly = bid.flags.includes('May be supply-only') && !WORK_WORDS.test(title);
  if (supplyOnly) {
    penalty += 25;
    if (!rejected) minus.push({ kind: 'minus', text: 'No work named in the title — may be a purchase, not a job' });
  } else if (bid.flags.includes('May be supply-only')) penalty += 5;
  for (const f of bid.flags) {
    if (supplyOnly && f === 'May be supply-only') continue; // said by the minus above
    if (NOT_OPEN_FLAGS.some(({ re }) => re.test(f)) || PROGRAM_FLAG.test(f)) continue; // said above
    info.push({ kind: 'info', text: f });
  }

  const raw = trade + (dist + value + runway) * factor - penalty;
  const fit = Math.max(0, Math.min(100, Math.round(raw)));
  const score = rejected ? 0 : capped ? Math.min(fit, capFor(profile)) : fit;
  const reasons: Reason[] = rejected ? [{ kind: 'minus', text: rejected }, ...plus, ...minus, ...info] : [...plus, ...minus, ...info];
  return { score, verdict: verdictFor(score), reasons, distanceMi, rejected, overLimit: false };
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
  const bond = bid.flags.some((f) => /\bbond/i.test(f)) ? against(est, bonding) : 'ok';
  if (bonding !== null && bond !== 'ok') {
    const verb = bond === 'over' ? 'is over' : 'may run over';
    minus.push({ kind: 'minus', text: `Bond required — est. ${estLabel(est, bonding)} ${verb} your ${ownMoney(bonding)} bonding capacity` });
  }
  const overLimit = job === 'over' || bond === 'over';

  const info: Reason[] = [];
  if (!overLimit && bid.flags.some((f) => /\bbid bond/i.test(f))) {
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
