/** Dollar amounts and job-size estimates pulled out of legal-ad text. */

const UNIT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6 };

export function parseMoney(raw: string, unit?: string): number | null {
  const n = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = unit ? UNIT[unit.toLowerCase()] ?? 1 : 1;
  return Math.round(n * mult);
}

const AMOUNT = String.raw`\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d+)?)\s*(k|mm|m|million|thousand)?\b`;
const CUE = String.raw`(?:engineer'?s estimate|estimated (?:construction )?(?:cost|budget|value|amount|contract value)|construction budget|project budget|budget|estimate[ds]?|not[- ]to[- ]exceed|approximately|valued at|estimated value)`;

const RANGE = new RegExp(`${CUE}[^.;$]{0,60}?${AMOUNT}\\s*(?:-|–|to)\\s*${AMOUNT}`, 'i');
const SINGLE = new RegExp(`${CUE}[^.;$]{0,80}?(<|under|less than|up to)?\\s*${AMOUNT}`, 'i');

/**
 * Finds an estimate like "The Engineer's estimate for this work is $81,000.00"
 * or "Estimated value $500K-$800K". Ignores dollar amounts that aren't tied to an
 * estimate/budget cue (liquidated damages, bid-document fees, etc.).
 */
export function findEstimate(text: string | null | undefined): { min: number | null; max: number | null } | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ');
  const r = RANGE.exec(flat);
  if (r) {
    const unitB = r[4];
    const a = parseMoney(r[1]!, r[2] ?? unitB);
    const b = parseMoney(r[3]!, unitB);
    if (a !== null && b !== null && b >= a) return { min: a, max: b };
  }
  const s = SINGLE.exec(flat);
  if (s) {
    const v = parseMoney(s[2]!, s[3]);
    if (v === null || v < 500) return null; // "$350 per day" style noise
    return s[1] ? { min: null, max: v } : { min: v, max: v };
  }
  return null;
}

/** $81000 → "$81K", $1500000 → "$1.5M" */
export function formatMoneyShort(v: number): string {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${v}`;
}

export function formatRange(est: { min: number | null; max: number | null }): string {
  if (est.min !== null && est.max !== null && est.min !== est.max) return `${formatMoneyShort(est.min)}–${formatMoneyShort(est.max)}`;
  const v = est.max ?? est.min;
  if (v === null) return 'Unknown';
  return est.min === null ? `under ${formatMoneyShort(v)}` : formatMoneyShort(v);
}
