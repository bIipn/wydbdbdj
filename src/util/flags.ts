/** Requirements a contractor wants to know about before opening the bid package. */
const RULES: Array<[RegExp, string]> = [
  [/\bbid (?:bond|security)\b/i, 'Bid bond'],
  [/\b(?:performance|payment) bond/i, 'Performance/payment bond'],
  [/\bprevailing wage/i, 'Prevailing wage'],
  [/\bmandatory\b[^.]{0,60}\bpre-?bid|\bpre-?bid\b[^.]{0,80}\bmandatory\b/i, 'Mandatory pre-bid'],
  [/\bcertified payroll/i, 'Certified payroll'],
  [/\b(?:qualified as a bidder|prequalif(?:ied|ication))/i, 'Bidder prequalification'],
  [/\bc-?2\b[^.]{0,40}licen|licen[^.]{0,40}\bc-?2\b/i, 'NV C-2 license'],
  [/\bc-?10\b[^.]{0,40}licen|licen[^.]{0,40}\bc-?10\b/i, 'CA C-10 license'],
];

export function detectFlags(text: string | null | undefined): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const [re, label] of RULES) if (re.test(text) && !found.includes(label)) found.push(label);
  return found;
}
