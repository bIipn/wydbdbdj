// Comparison with the contractor's limits (spec 5.8). Each limit gets a verdict with the numbers
// behind it: 'ok' / 'warn' / 'stop' for the contractor's own limits and a surety letter;
// 'unknown' when the limit is not set or there is no surety letter; 'info' for rules of thumb,
// which are never a pass or a fail (spec 12.1 #3, A-3, A-4).

import { assertCents, assertPpm, mulRate, ratio, refuse, type Cents, type Ppm, type Ratio } from './money.js';
import type { AssumptionUsed } from './types.js';
import type { PeakFloat, StressCase } from './cash.js';

export type Verdict = 'ok' | 'warn' | 'stop' | 'unknown' | 'info';

export interface LimitCheck {
  readonly id: 'job_size' | 'up_front_cash' | 'peak_float' | 'bonding' | 'liquidity_working_capital' | 'liquidity_current_ratio';
  readonly verdict: Verdict;
  /** Short, user-facing outcome: 'within', 'over by $x', 'fits', 'tight', 'short by $x', ... */
  readonly outcome: string;
  /** The numbers behind the verdict (cents unless named otherwise; null = not available). */
  readonly numbers: Readonly<Record<string, number | null>>;
  /** True when the figure is a rule of thumb: such a check never carries ok / warn / stop. */
  readonly ruleOfThumb: boolean;
  readonly assumptions: readonly AssumptionUsed[];
}

export interface StressVerdict {
  readonly id: string;
  readonly label: string;
  readonly F: Cents;
  readonly verdict: 'ok' | 'warn' | 'stop';
  readonly outcome: string;
  readonly headroom: number;
}

/** The contractor's limits (spec 1.9). Every figure is theirs; nothing is defaulted except the labelled buffer. */
export interface ContractorLimits {
  readonly cashForJob: Cents;
  readonly unusedCreditLine: Cents;
  /** beta: safety buffer on peak float. Omitted -> 0 (A-27), labelled. */
  readonly bufferPpm?: Ppm;
  readonly maxJobSize?: Cents;
  readonly maxUpFrontCash?: Cents;
  readonly suretyLetter?: { readonly singleLimit: Cents; readonly aggregateLimit: Cents; readonly backlogRemaining: Cents };
  /** Informational only. */
  readonly workingCapital?: Cents;
  readonly netWorth?: Cents;
  readonly currentAssets?: Cents;
  readonly currentLiabilities?: Cents;
  /** Backlog excluding this job, for the liquidity flag. */
  readonly backlog?: Cents;
}

/** A-27: safety buffer on peak float. */
export const A27_BUFFER_PPM = 0 as Ppm;
export const A27_BUFFER: AssumptionUsed = { id: 'A-27', text: 'Safety buffer on peak float (no authoritative value found)', value: 'beta = 0' };

/** A-3: bonding capacity without a surety letter, display-only rule of thumb. Never a pass or fail. */
export const A3_SINGLE_JOB_MULTIPLE_OF_WC = 10;
export const A3_AGGREGATE_MULTIPLES_OF_MIN_WC_NW: readonly [number, number] = [10, 20];
export const A3_BONDING: AssumptionUsed = {
  id: 'A-3',
  text: 'Bonding capacity without a surety letter: single job about 10 x working capital, aggregate about 10 to 20 x the lesser of working capital and net worth; display only, never a pass or fail',
  value: '10x; 10x to 20x',
};

/** A-4: surety liquidity rules of thumb (unverified trade sources). */
export const A4_WC_SHARE_OF_BACKLOG_PPM = 100_000 as Ppm; // working capital about 10% of backlog
export const A4_CURRENT_RATIO_MIN: Ratio = ratio(12n, 10n); // current ratio above 1.2
export const A4_LIQUIDITY: AssumptionUsed = {
  id: 'A-4',
  text: 'Surety liquidity rules of thumb: working capital about 10% of backlog; current ratio above 1.2',
  value: '10%; 1.2',
};

function dollars(c: number): string {
  const a = Math.abs(c);
  return `$${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
}

/** Peak-float verdict (spec 5.8): fits (ok), tight = fits only without the buffer (warn), short by $x (stop). */
export function floatVerdict(F: Cents, funds: Cents, bufferPpm: Ppm): { verdict: 'ok' | 'warn' | 'stop'; outcome: string; need: Cents; headroom: number } {
  assertCents(F, 'F*');
  assertCents(funds, 'funds');
  assertPpm(bufferPpm, 'beta', 0, 10_000_000);
  const need = mulRate(F, (1_000_000 + bufferPpm) as Ppm);
  const headroom = funds - need;
  if (headroom >= 0) return { verdict: 'ok', outcome: 'fits', need, headroom };
  if (funds >= F) return { verdict: 'warn', outcome: 'tight (fits only without the safety buffer)', need, headroom };
  return { verdict: 'stop', outcome: `short by ${dollars(F - funds)}`, need, headroom };
}

/**
 * spec 5.8:
 *   funds = cashForJob + unusedCreditLine;  need = mulRate(F*, 1 + beta);  headroom = funds - need;  coverage = funds / F*
 *   upFront = sum OUT(s) for s <= first period with IN > 0;  preStart = OUT(0)
 * Checks: job size, up-front cash, peak float (with every stress case), bonding (letter or "unknown"), liquidity flags.
 */
export function limitsCheck(args: {
  readonly price: Cents;
  readonly peak: PeakFloat;
  readonly limits: ContractorLimits;
  /** Does this job need a surety bond (spec 4.2 or the bid documents)? */
  readonly bondRequired: boolean;
  readonly stress?: readonly StressCase[];
}): { checks: LimitCheck[]; stress: StressVerdict[]; funds: Cents; need: Cents; headroom: number; coverage: Ratio | null; assumptions: AssumptionUsed[] } {
  const { price: P, peak, limits: lim } = args;
  assertCents(P, 'P');
  assertCents(lim.cashForJob, 'cash for job');
  assertCents(lim.unusedCreditLine, 'unused credit line');
  const assumptions: AssumptionUsed[] = [];
  const beta = lim.bufferPpm === undefined ? A27_BUFFER_PPM : assertPpm(lim.bufferPpm, 'beta', 0, 10_000_000);
  if (lim.bufferPpm === undefined) assumptions.push(A27_BUFFER);
  const funds = (lim.cashForJob + lim.unusedCreditLine) as Cents;
  assertCents(funds, 'funds');
  const checks: LimitCheck[] = [];

  // Job size: P <= maxJobSize (the contractor's own rule).
  if (lim.maxJobSize === undefined)
    checks.push({ id: 'job_size', verdict: 'unknown', outcome: 'no maximum job size set', numbers: { price: P, maxJobSize: null }, ruleOfThumb: false, assumptions: [] });
  else {
    assertCents(lim.maxJobSize, 'max job size');
    const over = P - lim.maxJobSize;
    checks.push({
      id: 'job_size',
      verdict: over <= 0 ? 'ok' : 'stop',
      outcome: over <= 0 ? 'within' : `over by ${dollars(over)}`,
      numbers: { price: P, maxJobSize: lim.maxJobSize, over: Math.max(0, over) },
      ruleOfThumb: false,
      assumptions: [],
    });
  }

  // Up-front cash: cash out before any money comes in.
  if (lim.maxUpFrontCash === undefined)
    checks.push({ id: 'up_front_cash', verdict: 'unknown', outcome: 'no up-front cash limit set', numbers: { upFront: peak.upFront, preStart: peak.preStart, maxUpFrontCash: null }, ruleOfThumb: false, assumptions: [] });
  else {
    assertCents(lim.maxUpFrontCash, 'max up-front cash');
    const over = peak.upFront - lim.maxUpFrontCash;
    checks.push({
      id: 'up_front_cash',
      verdict: over <= 0 ? 'ok' : 'stop',
      outcome: over <= 0 ? 'within' : `over by ${dollars(over)}`,
      numbers: { upFront: peak.upFront, preStart: peak.preStart, maxUpFrontCash: lim.maxUpFrontCash, over: Math.max(0, over) },
      ruleOfThumb: false,
      assumptions: [],
    });
  }

  // Peak float against cash plus unused credit, always with the stress cases.
  const fv = floatVerdict(peak.F, funds, beta);
  checks.push({
    id: 'peak_float',
    verdict: fv.verdict,
    outcome: fv.outcome,
    numbers: { peakFloat: peak.F, peakPeriod: peak.tStar, funds, need: fv.need, headroom: fv.headroom, bufferPpm: beta },
    ruleOfThumb: false,
    assumptions: lim.bufferPpm === undefined ? [A27_BUFFER] : [],
  });
  const stress: StressVerdict[] = (args.stress ?? []).map((s) => {
    const v = floatVerdict(s.peak.F, funds, beta);
    return { id: s.id, label: s.label, F: s.peak.F, verdict: v.verdict, outcome: v.outcome, headroom: v.headroom };
  });

  // Bonding.
  if (!args.bondRequired)
    checks.push({ id: 'bonding', verdict: 'ok', outcome: 'no surety bond required for this job', numbers: { price: P }, ruleOfThumb: false, assumptions: [] });
  else if (lim.suretyLetter) {
    const L = lim.suretyLetter;
    assertCents(L.singleLimit, 'single limit');
    assertCents(L.aggregateLimit, 'aggregate limit');
    assertCents(L.backlogRemaining, 'backlog remaining');
    const overSingle = P - L.singleLimit;
    const overAgg = L.backlogRemaining + P - L.aggregateLimit;
    const over = Math.max(overSingle, overAgg);
    checks.push({
      id: 'bonding',
      verdict: over <= 0 ? 'ok' : 'stop',
      outcome: over <= 0 ? 'within letter' : `over letter by ${dollars(over)}`,
      numbers: { price: P, singleLimit: L.singleLimit, aggregateLimit: L.aggregateLimit, backlogRemaining: L.backlogRemaining, overSingle: Math.max(0, overSingle), overAggregate: Math.max(0, overAgg) },
      ruleOfThumb: false,
      assumptions: [],
    });
  } else {
    // No letter: "Unknown: ask your surety agent." The A-3 estimate is display-only.
    const numbers: Record<string, number | null> = { price: P, estimatedSingle: null, estimatedAggregateLow: null, estimatedAggregateHigh: null };
    const a: AssumptionUsed[] = [];
    if (lim.workingCapital !== undefined) {
      const wc = assertCents(lim.workingCapital, 'working capital');
      const single = wc * A3_SINGLE_JOB_MULTIPLE_OF_WC;
      numbers.estimatedSingle = single;
      if (lim.netWorth !== undefined) {
        const base = Math.min(wc, assertCents(lim.netWorth, 'net worth'));
        // A-3 note: enforce aggregate >= single so the aggregate test does not silently dominate.
        numbers.estimatedAggregateLow = Math.max(single, base * A3_AGGREGATE_MULTIPLES_OF_MIN_WC_NW[0]);
        numbers.estimatedAggregateHigh = Math.max(single, base * A3_AGGREGATE_MULTIPLES_OF_MIN_WC_NW[1]);
      }
      a.push(A3_BONDING);
    }
    checks.push({ id: 'bonding', verdict: 'unknown', outcome: 'Unknown: ask your surety agent.', numbers, ruleOfThumb: a.length > 0, assumptions: a });
  }

  // Liquidity flags (informational, rule of thumb A-4).
  if (lim.workingCapital !== undefined && lim.backlog !== undefined) {
    const wc = assertCents(lim.workingCapital, 'working capital');
    const backlogWithJob = (assertCents(lim.backlog, 'backlog') + P) as Cents;
    const guide = mulRate(backlogWithJob, A4_WC_SHARE_OF_BACKLOG_PPM);
    checks.push({
      id: 'liquidity_working_capital',
      verdict: 'info',
      outcome: wc >= guide ? 'working capital is at least the rule-of-thumb 10% of backlog' : 'working capital is below the rule-of-thumb 10% of backlog',
      numbers: { workingCapital: wc, backlogWithJob, ruleOfThumbGuide: guide },
      ruleOfThumb: true,
      assumptions: [A4_LIQUIDITY],
    });
  }
  if (lim.currentAssets !== undefined && lim.currentLiabilities !== undefined) {
    const ca = assertCents(lim.currentAssets, 'current assets'), cl = assertCents(lim.currentLiabilities, 'current liabilities');
    const above = cl === 0 ? true : BigInt(ca) * A4_CURRENT_RATIO_MIN.den > A4_CURRENT_RATIO_MIN.num * BigInt(cl);
    checks.push({
      id: 'liquidity_current_ratio',
      verdict: 'info',
      outcome: above ? 'current ratio is above the rule-of-thumb 1.2' : 'current ratio is at or below the rule-of-thumb 1.2',
      numbers: { currentAssets: ca, currentLiabilities: cl },
      ruleOfThumb: true,
      assumptions: [A4_LIQUIDITY],
    });
  }
  if (checks.some((c) => c.ruleOfThumb && c.verdict !== 'info' && c.verdict !== 'unknown')) refuse('INTERNAL', 'a rule of thumb was given a pass or fail');
  return { checks, stress, funds, need: fv.need, headroom: fv.headroom, coverage: peak.F > 0 ? ratio(funds, peak.F) : null, assumptions };
}
