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
    trade = 8; factor = 0.45;
    info.push({ kind: 'info', text: `General construction — check the specs for ${m.words.specs}` });
  }

  const excluded = m.exclude.test(title) ?? m.exclude.test(bid.category);
  if (excluded && !strongTitle && !naicsStrong) rejected = `Not your trade (“${excluded}”)`;
  else if (trade === 0) rejected = m.words.none;

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
    info.push({ kind: 'info', text: 'Work location not listed — check the bid' });
  }

  // ---- job size ---------------------------------------------------------
  let value = 7;
  const est = bid.estValue;
  const v = est ? est.max ?? est.min : null;
  if (est && v != null) {
    const label = formatRange(est);
    const { min, max } = profile.valueRange;
    if (v >= min && v <= max) {
      value = 15;
      plus.push({ kind: 'plus', text: `Est. ${label} — right in your range` });
    } else if (v < min) {
      value = 8;
      info.push({ kind: 'info', text: `Small job (est. ${label})` });
    } else if (v <= max * 3) {
      value = 9;
      minus.push({ kind: 'minus', text: `Est. ${label} — bigger than your usual jobs` });
    } else {
      value = 4;
      minus.push({ kind: 'minus', text: `Est. ${label} — large job; sub to the GC?` });
    }
  }

  // ---- time to bid ------------------------------------------------------
  let runway = 7;
  if (bid.dueAt) {
    const days = (Date.parse(bid.dueAt) - now.getTime()) / 86_400_000;
    const whole = Math.floor(days);
    if (days < 0) {
      rejected ??= 'Bid deadline has passed';
      runway = 0;
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
  } else {
    info.push({ kind: 'info', text: 'No deadline listed' });
  }

  // ---- set-asides & requirements -----------------------------------------
  if (bid.setAside && !profile.setAsidesEligible.includes(bid.setAside)) {
    penalty += 15;
    minus.push({ kind: 'minus', text: `${SET_ASIDE_LABELS[bid.setAside] ?? bid.setAside} set-aside — check you qualify` });
  }
  if (bid.flags.includes('May be supply-only')) penalty += 5;
  for (const f of bid.flags) info.push({ kind: 'info', text: f });

  const raw = trade + (dist + value + runway) * factor - penalty;
  const score = rejected ? 0 : Math.max(0, Math.min(100, Math.round(raw)));
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
