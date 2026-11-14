/** Keyword lists → matchers. Shared by the scorer (score.ts) and the sub-work rule (subwork.ts). */

export interface Matcher {
  test(text: string | null | undefined): string | null; // returns the keyword that hit
}

/**
 * One compiled pattern per keyword text, shared by every profile. Thousands of profiles carry the same few
 * hundred words (the trade catalog's lists), and a job someone posts is scored for each of those profiles
 * inside the poster's request (scoreNewBid in src/scan.ts): compiling every list again for every profile was
 * most of that scoring time. The patterns have no state (no g or y flag), so sharing them changes no result.
 * Capped: past KEYWORD_CACHE_MAX distinct words a pattern is simply compiled each time, as before.
 */
const keywordPatterns = new Map<string, { kw: string; re: RegExp }>();
const KEYWORD_CACHE_MAX = 20_000;

function keywordPattern(kw: string): { kw: string; re: RegExp } {
  let hit = keywordPatterns.get(kw);
  if (!hit) {
    const prefix = kw.endsWith('*');
    const body = (prefix ? kw.slice(0, -1) : kw).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    hit = { kw: prefix ? kw.slice(0, -1) : kw, re: new RegExp(`(?<![a-z0-9])${body}${prefix ? '' : '(?![a-z0-9])'}`, 'i') };
    if (keywordPatterns.size < KEYWORD_CACHE_MAX) keywordPatterns.set(kw, hit);
  }
  return hit;
}

/** "electric*" → prefix match; anything else → whole word/phrase. Case-insensitive. */
export function compileKeywords(list: readonly string[]): Matcher {
  const regs = list.map(keywordPattern);
  return {
    test(text) {
      if (!text) return null;
      for (const { kw, re } of regs) if (re.test(text)) return kw;
      return null;
    },
  };
}
