/**
 * The marketplace settings, read once at start-up from the environment. A value outside its limits stops
 * the boot with one plain sentence (src/routes/jobs.ts reads them while the server is being built), the
 * same way a bad MARKET_REFRESH_AT does: better a server that will not start than one that charges 40%.
 *
 *   JOB_NO_SHOW_FEE_PCT   default 5   0 to 10      what a winner who never made contact (or backed out) owes
 *   JOB_POSTER_SHARE_PCT  default 2   0 to the no-show fee   the part of it that goes to the poster
 *   JOB_SERVICE_FEE_PCT   default 1   0 to 3       BidSwipe's small fee when both sides agree
 *   JOB_CONTACT_DAYS      default 7   1 to 30      days the winner has to make contact
 *   JOB_MAX_CENTS         default 25000000 ($250,000.00)   largest bid or budget; at least the $20.00 minimum
 *
 * Percentages may have up to 4 decimals ("2.5"); they are turned into parts per million from the text, never
 * through a float.
 */
import type { JobRules } from './rules.js';

/** $20.00: the smallest bid or budget (contract rule 9). Not a setting. */
export const MIN_CENTS = 2_000;
export const DEFAULT_MAX_CENTS = 25_000_000;
/** No setting may raise the largest amount past $10,000,000.00: cents stay far inside the safe-integer range. */
export const MAX_CENTS_LIMIT = 1_000_000_000;

export const DEFAULT_JOB_RULES: JobRules = {
  noShowFeePpm: 50_000, posterSharePpm: 20_000, serviceFeePpm: 10_000, contactDays: 7, minCents: MIN_CENTS, maxCents: DEFAULT_MAX_CENTS,
};

/** Thrown for a setting the server must not start with. The message is the sentence the operator reads. */
export class JobConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobConfigError';
  }
}

/** "5" / "2.5" / "0.25" → parts per million (50_000 / 25_000 / 2_500). null when it is not a plain number. */
export function pctToPpm(text: string): number | null {
  const m = /^\s*(\d{1,3})(?:\.(\d{1,4}))?\s*%?\s*$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * 10_000 + Number((m[2] ?? '').padEnd(4, '0'));
}

const pctText = (ppm: number): string => `${ppm / 10_000}%`;

/** The settings from an environment reader (process env by default in routes/jobs.ts). Throws JobConfigError. */
export function loadJobRules(get: (name: string) => string | undefined): JobRules {
  const read = (name: string): string | undefined => {
    const v = get(name)?.trim();
    return v ? v : undefined;
  };
  const pct = (name: string, fallback: number, max: number, maxWhy: string): number => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    if (/^-/.test(raw)) throw new JobConfigError(`${name} is ${raw}%, which is below 0. The server will not start with it.`);
    const ppm = pctToPpm(raw);
    if (ppm === null) throw new JobConfigError(`${name} must be a percentage such as 5 or 2.5, got "${raw}".`);
    if (ppm > max) throw new JobConfigError(`${name} is ${pctText(ppm)}, which is above ${maxWhy}. The server will not start with it.`);
    return ppm;
  };
  const int = (name: string, fallback: number, min: number, max: number, what: string): number => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) throw new JobConfigError(`${name} must be a whole number (${what}), got "${raw}".`);
    const n = Number(raw);
    if (n < min || n > max) throw new JobConfigError(`${name} must be from ${min} to ${max} (${what}), got ${n}.`);
    return n;
  };

  const noShowFeePpm = pct('JOB_NO_SHOW_FEE_PCT', DEFAULT_JOB_RULES.noShowFeePpm, 100_000, 'the 10% limit for the no-show fee');
  const posterSharePpm = pct('JOB_POSTER_SHARE_PCT', Math.min(DEFAULT_JOB_RULES.posterSharePpm, noShowFeePpm), noShowFeePpm,
    `the no-show fee (${pctText(noShowFeePpm)}): the poster's share is part of that fee`);
  const serviceFeePpm = pct('JOB_SERVICE_FEE_PCT', DEFAULT_JOB_RULES.serviceFeePpm, 30_000, 'the 3% limit for the service fee');
  const contactDays = int('JOB_CONTACT_DAYS', DEFAULT_JOB_RULES.contactDays, 1, 30, 'days the winner has to make contact');
  const maxCents = int('JOB_MAX_CENTS', DEFAULT_MAX_CENTS, MIN_CENTS, MAX_CENTS_LIMIT, 'the largest bid or budget, in cents');
  return { noShowFeePpm, posterSharePpm, serviceFeePpm, contactDays, minCents: MIN_CENTS, maxCents };
}

/** What GET /api/jobs/rules and every Job carry. Percentages as numbers (5, 2, 1); payments are off. */
export interface PublicRules {
  noShowFeePct: number;
  posterSharePct: number;
  serviceFeePct: number;
  contactDays: number;
  minCents: number;
  maxCents: number;
  paymentsOn: false;
}

export function publicRules(r: JobRules): PublicRules {
  return {
    noShowFeePct: r.noShowFeePpm / 10_000, posterSharePct: r.posterSharePpm / 10_000, serviceFeePct: r.serviceFeePpm / 10_000,
    contactDays: r.contactDays, minCents: r.minCents, maxCents: r.maxCents, paymentsOn: false,
  };
}
