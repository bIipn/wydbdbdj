import { milesBetween } from '../geo/locate.js';
import type { Bid, Profile, Reason, ScoreResult, Verdict } from '../types.js';
import { formatRange } from '../util/money.js';

/**
 * Fit score, 0–100, with plain-English reasons so the owner can see *why*.
 *
 *   score = trade + context × tradeFactor − penalties
 *
 *   trade   (0–45)  is this electrical work?
 *   context (0–55)  distance (25) + job size (15) + days to bid (15)
 *   tradeFactor     strong 1.0 · related 0.75 · general construction 0.45
 *
 * The factor stops "close by and lots of time" from making a road job look good.
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

interface Compiled {
  strong: Matcher;
  related: Matcher;
  general: Matcher;
  otherTrades: Matcher;
  exclude: Matcher;
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

export function scoreBid(bid: Bid, profile: Profile, now: Date = new Date()): ScoreResult {
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
    plus.push({ kind: 'plus', text: `Electrical scope: “${strongTitle}” + NAICS ${bid.naics}` });
  } else if (strongTitle) {
    trade = 40; factor = 1;
    plus.push({ kind: 'plus', text: `Electrical scope: “${strongTitle}”` });
  } else if (naicsStrong) {
    trade = 36; factor = 1;
    plus.push({ kind: 'plus', text: `NAICS ${bid.naics} — electrical contractors` });
  } else if (strongBody) {
    trade = 30; factor = 1;
    plus.push({ kind: 'plus', text: `Electrical work mentioned: “${strongBody}”` });
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
    info.push({ kind: 'info', text: 'General construction — check the specs for electrical' });
  }

  const excluded = m.exclude.test(title) ?? m.exclude.test(bid.category);
  if (excluded && !strongTitle && !naicsStrong) rejected = `Not your trade (“${excluded}”)`;
  else if (trade === 0) rejected = 'No electrical or construction scope found';

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
