import { REQUIREMENT_FLAGS } from '../sources/flags.js';

// "not mandatory" / "non-mandatory" says the opposite. Douglas County's standard line:
// "Attendance at the pre-bid conference is highly encouraged but is not mandatory."
const MANDATORY = String.raw`(?<!\bnot\s+(?:(?:a|be)\s+)?|\bnon[\s-]?)\bmandatory\b`;

/** Requirements a contractor wants to know about before opening the bid package. */
const RULES: Array<[RegExp, string]> = [
  [/\bbid (?:bond|security)\b/i, REQUIREMENT_FLAGS.bidBond],
  [/\b(?:performance|payment) bond/i, REQUIREMENT_FLAGS.perfBond],
  [/\bprevailing wage/i, REQUIREMENT_FLAGS.prevailing],
  [new RegExp(String.raw`${MANDATORY}[^.]{0,60}\bpre-?bid|\bpre-?bid\b[^.]{0,80}${MANDATORY}`, 'i'), 'Mandatory pre-bid'],
  [/\bcertified payroll/i, REQUIREMENT_FLAGS.certifiedPayroll],
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
