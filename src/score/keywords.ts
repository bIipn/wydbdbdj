/** Keyword lists → matchers. Shared by the scorer (score.ts) and the sub-work rule (subwork.ts). */

export interface Matcher {
  test(text: string | null | undefined): string | null; // returns the keyword that hit
}

/** "electric*" → prefix match; anything else → whole word/phrase. Case-insensitive. */
export function compileKeywords(list: readonly string[]): Matcher {
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
