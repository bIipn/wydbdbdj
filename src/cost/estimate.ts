// The estimate orchestrator: one pure function for the app. It takes a contractor-friendly request
// (dollars and percents as decimal strings or plain numbers, dates as YYYY-MM-DD), maps it onto the
// engine (spec 2 build-up, 4 bonds and retainage, 5 cash and limits, 6.2 escalation, 7 bid range),
// and returns the itemised breakdown, the bid price, cash carried and financing, the limits verdicts,
// the bid range or the reason it is not shown, every dated default used (sources), every assumption
// used, warnings, and the inputs still NEEDED.
//
// Rules this file keeps (spec 0, 8, 9, 12.1):
//  - No floating point in the money path: decimals are parsed from their text into integers; a value
//    with more decimals than its unit allows is refused, never rounded silently.
//  - Nothing is guessed. A missing input with no dated section 8 default is listed in `needed`; a
//    section 9 value is used only as a labelled assumption. Missing price inputs -> no price at all.
//  - Pure: no I/O, no clock. Dates come in the request.

import {
  CostEngineError,
  compareDates,
  isoDate,
  toCents,
  type Cents,
  type HoursC,
  type IsoDate,
  type Ppm,
  type QtyM,
  type Ratio,
} from './money.js';
import type {
  AssumptionUsed,
  BidInput,
  BondTier,
  EquipmentLine,
  JobOverheadItem,
  LaborClassInput,
  Line,
  MaterialLine,
  OtRegime,
  OverheadInput,
  PayrollTaxTable,
  PriceChargesInput,
} from './types.js';
import { buildBid, durationMultiplierPpm, type BidBreakdown } from './buildup.js';
import { prevailingWageCheck } from './labor.js';
import { bondMonths, bondRequirement, sbaFee, sbaFeeCharge, type BondRequirementTable } from './bonds.js';
import type { RetainageRule } from './payment.js';
import { cashLedger, costWeights, financingCost, inflowLagPeriods, outflowLagPeriods, peakFloat, stressCases, type CashCategory, type CashJobInput, type CostKind } from './cash.js';
import { limitsCheck, type ContractorLimits } from './limits.js';
import { dayNumber, ePpmForMaterialLine, normalizeSeries, quoteEscalation, type IndexSeries, type IndexSeriesInput } from './escalation.js';
import { selectBid } from './bidding.js';
import { pWinEmpirical, type AwardRule, type LettingRecord } from './winprob.js';
import { assumptionsReport, useAssumption, type AssumptionReport } from './assumptions.js';
import {
  bondRequirementTable,
  createSourceLog,
  lookupDefault,
  lookupNumber,
  newEmployerUiRate,
  nvWcPayrollCap,
  ownerState,
  OWNER_TYPES,
  payrollTable,
  paymentTiming,
  retainageRule,
  sampleBondTiers,
  sbaFeeTable,
  surchargePreset,
  type OwnerType,
  type RetainageCase,
  type SourceLog,
  type SourceUsed,
  type SupportedState,
  type SurchargePreset,
} from './defaults.js';

// ================================================================ request (JSON, contractor-friendly)

/** A decimal as text ("1,234.50", "$45", "7.1") or a plain JSON number. Never more decimals than its unit allows. */
export type Dec = string | number;

export type PrevailingWage = 'none' | 'davis_bacon' | 'nv_338' | 'ca_dir';

export interface LaborClassRequest {
  readonly label: string;
  /** Straight-time hours (decimal hours). */
  readonly hours: Dec;
  readonly overtimeHours?: Dec; // 1.5x bucket
  readonly doubleTimeHours?: Dec; // 2x bucket
  /** Cash basic wage per hour actually paid. May be omitted with `prevailing.fringePaidAs` (pay exactly the determination). */
  readonly wage?: Dec;
  readonly cashInLieu?: Dec; // fringe paid as cash, per hour (taxable)
  readonly planFringe?: Dec; // employer contributions to bona fide plans, per hour
  readonly healthPlan?: Dec; // of which health, per hour
  readonly travelPerHour?: Dec;
  readonly otherPerHour?: Dec;
  /** Expected annual taxable wages of a representative worker; omitted -> 2,000 h x straight-time cash (A-8). */
  readonly annualWages?: Dec;
  /** 2x hourly pay per the wage determination's footnotes (needed for double time outside California private). */
  readonly doubleTimeRate?: Dec;
  readonly prevailing?: { readonly basic: Dec; readonly fringe: Dec; readonly fringePaidAs?: 'cash' | 'plan' };
  /** Workers' comp rate from YOUR policy, dollars per $100 of payroll ("2.50"). No default (A-11). */
  readonly workersCompPer100?: Dec;
  /** Wages already priced at a known future rate (no labor escalation on them). */
  readonly wageScheduled?: boolean;
}

export interface MaterialLineRequest {
  readonly label: string;
  readonly quantity: Dec; // up to 3 decimals
  readonly unitPrice: Dec;
  readonly wastePercent?: Dec;
  /** Omitted -> taxable (spec 1.4 default; Nevada: A-16). */
  readonly taxable?: boolean;
  readonly quotedOn?: string;
  readonly purchaseDate?: string;
  readonly holdThrough?: string;
  readonly forwardPriced?: boolean;
  /** Index series id from `indexes.series` for the historical part (spec 6.2). */
  readonly seriesId?: string;
}

export type OverheadRequest =
  | { readonly method: 'on_cost'; readonly percent: Dec }
  | { readonly method: 'on_cost'; readonly annualOverhead: Dec; readonly annualDirectCost: Dec }
  | { readonly method: 'on_sales'; readonly percent: Dec; readonly profitPercent: Dec }
  | { readonly method: 'per_labor_hour'; readonly perHour: Dec }
  | { readonly method: 'on_labor_cost'; readonly measure: 'L' | 'G'; readonly percent: Dec }
  | { readonly method: 'dual'; readonly laborPercent: Dec; readonly otherPercent: Dec };

export interface EstimateRequest {
  readonly job?: {
    readonly ownerType?: OwnerType;
    /** 'NV', 'CA', ...: needed for private and federal work; implied by state owner types. */
    readonly state?: string;
    /** Owner's estimate, for thresholds and the bid-range anchor. */
    readonly estimatedCost?: Dec;
    readonly prevailingWage?: PrevailingWage;
    readonly bidDate?: string;
    readonly startDate?: string;
    readonly endDate?: string;
  };
  readonly labor?: {
    readonly burdenMode?: 'statutory' | 'flat';
    /** Flat mode only: one burden percentage on taxable wages (labelled an approximation). */
    readonly flatBurdenPercent?: Dec;
    readonly classes?: readonly LaborClassRequest[];
    /** Your unemployment rate notice; omitted -> the new-employer rate (D-7, D-10), labelled. */
    readonly stateUiRatePercent?: Dec;
    readonly futaCreditReductionPercent?: Dec;
    /** Nevada Modified Business Tax (firm-level, D-9). Required in Nevada; mode 'none' if exempt. */
    readonly mbt?: { readonly mode: 'none' | 'marginal' | 'average'; readonly quarterlyGrossWages?: Dec; readonly quarterlyHealthDeduction?: Dec };
    readonly workersComp?: { readonly experienceMod?: Dec; readonly otherMods?: Dec; readonly policyEffectiveDate?: string; readonly excludeOtPremium?: boolean };
    readonly escalationPercent?: Dec;
  };
  readonly materials?: {
    readonly lines?: readonly MaterialLineRequest[];
    /** Instead of lines: one material total from your quotes. */
    readonly total?: { readonly amount: Dec; readonly taxable?: boolean };
    readonly freight?: Dec;
    readonly freightTaxable?: boolean;
    /** Combined state + local rate at the taxing location. No default (A-14). */
    readonly salesTaxPercent?: Dec;
    readonly taxBasis?: 'total' | 'line';
    /** Forward escalation rate per year for dated quotes. No default (A-21). */
    readonly forwardRatePercent?: Dec;
    readonly stalenessPercent?: Dec;
  };
  readonly equipment?: readonly ({ readonly label: string; readonly amount: Dec } | { readonly label: string; readonly hours: Dec; readonly rate: Dec })[];
  readonly subcontracts?: readonly { readonly label: string; readonly amount: Dec }[];
  readonly jobOverhead?: readonly (
    | { readonly label: string; readonly amount: Dec }
    | { readonly label: string; readonly months: Dec; readonly monthlyCost: Dec }
    | { readonly label: string; readonly hours: Dec; readonly rate: Dec }
  )[];
  readonly markups?: {
    readonly smallToolsPercent?: Dec; // omitted -> 2% of burdened labor (A-18, D-66)
    readonly contingencyPercent?: Dec; // omitted -> 0 (A-19)
    /** Home-office overhead. No default (A-7). */
    readonly overhead?: OverheadRequest;
    /** Profit on cost + overhead. No default (A-7). Not used with overhead method 'on_sales'. */
    readonly profitPercent?: Dec;
    /** Optional upward bid rounding, dollars (1, 100, ...). */
    readonly bidRoundingUnit?: Dec;
  };
  readonly bond?: {
    /** 'auto' applies spec 4.2 for the owner type (the bid documents override). */
    readonly required?: 'auto' | 'yes' | 'no';
    /** Federal $35,000 to $150,000 band: the contracting officer chooses a payment bond or other protection. */
    readonly officerChoiceMeansBond?: boolean;
    /** Your surety's schedule; omitted -> illustrative D-38 sample (A-1). Rates in dollars per $1,000. */
    readonly tiers?: readonly { readonly upTo: Dec | null; readonly ratePer1000: Dec }[];
    readonly surcharge?: SurchargePreset;
    readonly sba?: { readonly approvalDate: string; readonly federalCertified?: boolean };
  };
  readonly insurance?: {
    /** General liability from your policy (A-13: no default). 'none' if it sits in your overhead. */
    readonly generalLiability?: { readonly basis: 'payroll'; readonly percentOfWages: Dec } | { readonly basis: 'receipts'; readonly per1000: Dec } | { readonly basis: 'none' };
    readonly otherPriceFees?: readonly { readonly label: string; readonly per1000: Dec }[];
  };
  readonly payment?: {
    /** Days between pay applications; omitted -> monthly for federal work (D-44), else needed. */
    readonly billingCycleDays?: number;
    readonly ownerPayDays?: number;
    readonly retainage?: RetainageCase | { readonly percent: Dec };
    /** Days after completion the retainage still held is paid. */
    readonly retainageReleaseDays?: number;
    /** Supplier terms in days; omitted -> net 30 (A-26). */
    readonly supplierNetDays?: number;
    readonly materialDepositPercent?: Dec;
    /** Days after the cost is incurred that subs are paid; omitted -> 0 (paid when incurred, conservative). */
    readonly subPaidDays?: number;
  };
  readonly financing?: { readonly include?: boolean; readonly annualRatePercent?: Dec; readonly dayCount?: 360 | 365 };
  readonly limits?: {
    readonly cashForJob?: Dec;
    readonly unusedCreditLine?: Dec;
    readonly bufferPercent?: Dec;
    readonly maxJobSize?: Dec;
    readonly maxUpFrontCash?: Dec;
    readonly suretyLetter?: { readonly singleLimit: Dec; readonly aggregateLimit: Dec; readonly backlogRemaining: Dec };
    readonly workingCapital?: Dec;
    readonly netWorth?: Dec;
    readonly currentAssets?: Dec;
    readonly currentLiabilities?: Dec;
    readonly backlog?: Dec;
  };
  readonly stress?: { readonly laborIncreasePercent?: Dec; readonly unpaidChangeOrder?: Dec };
  readonly indexes?: { readonly series?: readonly IndexSeriesInput[] };
  /** Your own records of comparable lettings, for the bid range (spec 7). */
  readonly award?: {
    readonly referenceClass?: string;
    readonly lettings?: readonly { readonly anchor: Dec; readonly lowestCompeting: Dec; readonly anchorKind?: 'owner_estimate' | 'own_cost_estimate' }[];
    /** This job's anchor; omitted -> job.estimatedCost (owner estimate). */
    readonly anchor?: Dec;
    readonly minMarkupPercent?: Dec;
    readonly bidPrepCost?: Dec;
    readonly delta?: number;
  };
  readonly bidItems?: readonly { readonly label: string; readonly directCost: Dec }[];
}

/** What the route knows about a stored bid (spec contract 4: "pull the bid's known facts"). */
export interface BidFacts {
  readonly id: string;
  readonly estValue: { readonly min: number | null; readonly max: number | null } | null; // dollars
  readonly flags: readonly string[];
  /** Bid due date as a calendar date in the agency's time zone. */
  readonly dueDate: string | null;
  readonly state: string | null;
  readonly locationLabel: string | null;
}

export interface EstimateOptions {
  readonly bid?: BidFacts;
  /** Tenant id for the bid-range history (another customer's private rows are refused, spec 7.10). */
  readonly tenantId?: string;
}

// ================================================================ result (JSON-safe: no bigint)

export interface FieldError { readonly path: string; readonly message: string }

/** Bad input: carries field-level messages (the route answers 400 with them). A RangeError. */
export class EstimateInputError extends CostEngineError {
  readonly fields: readonly FieldError[];
  constructor(fields: readonly FieldError[]) {
    super('INVALID_INPUT', fields.map((f) => `${f.path}: ${f.message}`).join('; '));
    this.name = 'EstimateInputError';
    this.fields = fields;
  }
}

/** An input the contractor did not supply that has no dated default. `for` says what it blocks. */
export interface NeededInput {
  readonly field: string;
  readonly why: string;
  readonly for: 'price' | 'cash' | 'limits' | 'range';
}

export interface Check { readonly level: 'ok' | 'warn' | 'stop'; readonly text: string }

export interface BidFactUse { readonly fact: string; readonly value: string; readonly used: boolean; readonly how: string }

export interface EstimateResult {
  readonly status: 'complete' | 'incomplete';
  readonly needed: readonly NeededInput[];
  readonly job: {
    readonly ownerType: OwnerType | null;
    readonly state: string | null;
    readonly regime: OtRegime | null;
    readonly prevailingWage: PrevailingWage | null;
    readonly startDate: string | null;
    readonly endDate: string | null;
    readonly workDays: number | null;
    readonly bondApplied: boolean | null;
  };
  /** Contract field: the bid price in cents (P_bid), or null when inputs are missing. */
  readonly total: number | null;
  readonly price: null | {
    readonly bid: number; // P_bid
    readonly P: number;
    readonly S: number;
    readonly charges: number; // q at P_bid
    readonly premium: number;
    readonly otherCharges: number;
    readonly profitAsBid: number;
  };
  readonly totals: EstimateTotals | null;
  /** Every line of the build-up, in order, each with its formula, base, rate and rounding point. */
  readonly breakdown: readonly Line[];
  readonly items: readonly { readonly id: string; readonly label: string; readonly directCost: number; readonly indirect: number; readonly price: number }[] | null;
  readonly cash:
    | { readonly status: 'computed'; readonly peakFloat: number; readonly peakDay: number; readonly peakFloatReceiptsFirst: number; readonly upFront: number; readonly preStart: number; readonly daysToFirstCashIn: number | null; readonly daysCashNegative: number; readonly finalCash: number; readonly cashCost: number; readonly peakOverCost: string; readonly compositionAtPeak: Readonly<Record<string, number>>; readonly grid: { readonly periodDays: 1; readonly workDays: number; readonly billingCycleDays: number; readonly ownerPayDays: number; readonly retainage: string; readonly retainageReleaseDays: number } }
    | { readonly status: 'not_computed'; readonly reason: string };
  readonly financing: { readonly included: boolean; readonly FIN: number; readonly annualRatePpm: number | null; readonly dayCount: number | null; readonly note: string };
  readonly limits:
    | { readonly status: 'checked'; readonly checks: readonly { readonly id: string; readonly verdict: string; readonly outcome: string; readonly ruleOfThumb: boolean; readonly numbers: Readonly<Record<string, number | null>> }[]; readonly stress: readonly { readonly id: string; readonly label: string; readonly peakFloat: number; readonly verdict: string; readonly outcome: string }[]; readonly funds: number; readonly need: number; readonly headroom: number; readonly coverage: string | null }
    | { readonly status: 'not_checked'; readonly reason: string };
  readonly bidRange:
    | { readonly status: 'shown'; readonly floor: number; readonly recommended: PricePointOut; readonly low: PricePointOut; readonly high: PricePointOut; readonly contiguous: boolean; readonly intervals: readonly { readonly lo: number; readonly hi: number }[]; readonly J: number | null; readonly referenceClass: string; readonly model: string; readonly delta: number; readonly note: string }
    | { readonly status: 'no_bid'; readonly reason: string; readonly J: number | null; readonly referenceClass: string }
    | { readonly status: 'not_shown'; readonly reason: string };
  readonly checks: readonly Check[];
  readonly sources: readonly SourceUsed[];
  readonly assumptions: readonly AssumptionReport[];
  readonly warnings: readonly string[];
  readonly bidFacts: readonly BidFactUse[];
}

/** Build-up totals in cents (spec 2): each is the exact sum of its rounded lines. H is in hundredths of an hour. */
export interface EstimateTotals {
  readonly L: number; readonly G: number; readonly H: number; readonly ST: number; readonly MAT: number; readonly E: number; readonly SUB: number;
  readonly JOOH: number; readonly ESC_L: number; readonly DC0: number; readonly CONT: number; readonly TJC: number; readonly OH: number; readonly BE: number;
  readonly PR: number; readonly FIN: number; readonly S: number; readonly q: number; readonly premium: number; readonly otherCharges: number; readonly P: number;
  readonly Pbid: number; readonly qBid: number; readonly roundingToProfit: number; readonly roundingToCharges: number; readonly profitAsBid: number;
}

export interface PricePointOut { readonly price: number; readonly markupOnCost: string; readonly winProbability: { readonly p: number; readonly lo: number; readonly hi: number; readonly J: number | null }; readonly profitIfWon: number; readonly expectedProfit: number }

// ================================================================ parsing (exact decimals, field-level errors)

const DEC_RE = /^(\d+)(?:\.(\d+))?$/;

class Reader {
  readonly errors: FieldError[] = [];
  err(path: string, message: string): undefined {
    this.errors.push({ path, message });
    return undefined;
  }
  /** Non-negative decimal scaled by 10^places, exact; more decimals than `places` is an error. */
  scaled(x: unknown, path: string, places: number, what: string): number | undefined {
    if (x === undefined || x === null || x === '') return undefined;
    let t: string;
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) return this.err(path, `${what} must be a finite number`);
      t = String(x);
    } else if (typeof x === 'string') t = x.trim().replace(/^\$/, '').replace(/,/g, '').replace(/%$/, '');
    else return this.err(path, `${what} must be a number or a decimal string`);
    if (t.startsWith('-')) return this.err(path, `${what} must not be negative`);
    const m = DEC_RE.exec(t);
    if (!m) return this.err(path, `${what} is not a decimal number: ${JSON.stringify(x)}`);
    const frac = m[2] ?? '';
    if (frac.length > places) return this.err(path, `${what} allows at most ${places} decimal place${places === 1 ? '' : 's'}`);
    const n = BigInt(m[1]!) * 10n ** BigInt(places) + BigInt(frac.padEnd(places, '0') || '0');
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) return this.err(path, `${what} is too large`);
    return Number(n);
  }
  money(x: unknown, path: string): Cents | undefined { return this.scaled(x, path, 2, 'amount') as Cents | undefined; }
  /** Percent -> ppm (4 decimals). */
  pct(x: unknown, path: string, maxPct?: number): Ppm | undefined {
    const v = this.scaled(x, path, 4, 'percent');
    if (v !== undefined && maxPct !== undefined && v > maxPct * 10_000) return this.err(path, `percent must be at most ${maxPct}`);
    return v as Ppm | undefined;
  }
  /** Dollars per $1,000 -> ppm (3 decimals). */
  per1000(x: unknown, path: string): Ppm | undefined { return this.scaled(x, path, 3, 'rate per $1,000') as Ppm | undefined; }
  /** Dollars per $100 -> ppm (4 decimals). */
  per100(x: unknown, path: string): Ppm | undefined { return this.scaled(x, path, 4, 'rate per $100') as Ppm | undefined; }
  hours(x: unknown, path: string): HoursC | undefined { return this.scaled(x, path, 2, 'hours') as HoursC | undefined; }
  qty(x: unknown, path: string): QtyM | undefined { return this.scaled(x, path, 3, 'quantity') as QtyM | undefined; }
  factor(x: unknown, path: string): Ppm | undefined { return this.scaled(x, path, 6, 'factor') as Ppm | undefined; }
  days(x: unknown, path: string, min = 0): number | undefined {
    if (x === undefined || x === null) return undefined;
    if (typeof x !== 'number' || !Number.isInteger(x) || x < min || x > 3650) return this.err(path, `must be a whole number of days from ${min} to 3650`);
    return x;
  }
  date(x: unknown, path: string): IsoDate | undefined {
    if (x === undefined || x === null || x === '') return undefined;
    if (typeof x !== 'string') return this.err(path, 'must be a date YYYY-MM-DD');
    try {
      return isoDate(x);
    } catch {
      return this.err(path, 'must be a real calendar date YYYY-MM-DD');
    }
  }
  oneOf<T extends string>(x: unknown, path: string, allowed: readonly T[]): T | undefined {
    if (x === undefined || x === null) return undefined;
    if (typeof x !== 'string' || !(allowed as readonly string[]).includes(x)) return this.err(path, `must be one of ${allowed.join(', ')}`);
    return x as T;
  }
  bool(x: unknown, path: string): boolean | undefined {
    if (x === undefined || x === null) return undefined;
    if (typeof x !== 'boolean') return this.err(path, 'must be true or false');
    return x;
  }
  label(x: unknown, path: string): string {
    if (typeof x !== 'string' || !x.trim()) return this.err(path, 'needs a label') ?? '';
    if (x.length > 120) return this.err(path, 'label is too long (120 characters at most)') ?? '';
    return x.trim();
  }
  obj(x: unknown, path: string): Record<string, unknown> | undefined {
    if (x === undefined || x === null) return undefined;
    if (typeof x !== 'object' || Array.isArray(x)) return this.err(path, 'must be an object');
    return x as Record<string, unknown>;
  }
  arr(x: unknown, path: string, max = 200): unknown[] {
    if (x === undefined || x === null) return [];
    if (!Array.isArray(x)) return this.err(path, 'must be a list') ?? [];
    if (x.length > max) return this.err(path, `at most ${max} entries`) ?? [];
    return x;
  }
}

// ================================================================ helpers

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
const id = (i: number, label: string) => `${i + 1}-${slug(label)}`;
const PUBLIC_OWNERS: readonly OwnerType[] = OWNER_TYPES.filter((o) => o !== 'private');

function dollars(c: number): string {
  const a = Math.abs(c);
  return `${c < 0 ? '-' : ''}$${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
}
/** Exact ratio as a decimal string with `digits` places, half-up (display only). */
function ratioText(r: Ratio, digits = 4): string {
  const neg = r.num < 0n !== r.den < 0n && r.num !== 0n;
  const n = r.num < 0n ? -r.num : r.num, d = r.den < 0n ? -r.den : r.den;
  const s = 10n ** BigInt(digits);
  const q = (2n * n * s + d) / (2n * d);
  const whole = q / s, frac = q % s;
  return `${neg ? '-' : ''}${whole}${digits ? '.' + frac.toString().padStart(digits, '0') : ''}`;
}
/** Days from `start` to the same calendar day next month (clamped to month end): one monthly billing cycle. */
function monthlyCycleDays(start: IsoDate): number {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const leap = (ny % 4 === 0 && ny % 100 !== 0) || ny % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][nm - 1]!;
  const next = `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}` as IsoDate;
  return dayNumber(next) - dayNumber(start);
}

function regimeFor(state: string, pw: PrevailingWage): OtRegime {
  if (pw === 'davis_bacon') return 'DAVIS_BACON';
  if (pw === 'nv_338') return 'NV_PUBLIC';
  if (pw === 'ca_dir') return 'CA_PUBLIC';
  if (state === 'NV') return 'NV_PRIVATE';
  if (state === 'CA') return 'CA_PRIVATE';
  return 'FLSA';
}

const VERDICT_LEVEL: Record<string, Check['level']> = { ok: 'ok', warn: 'warn', stop: 'stop', unknown: 'warn', info: 'warn' };

// ================================================================ the orchestrator

/**
 * One estimate, end to end (spec 2, 4, 5, 6.2, 7). Pure: same request and options, same result.
 * Throws EstimateInputError (field-level) for malformed input and CostEngineError for values the
 * engine refuses (both are RangeError). Missing inputs are never guessed: they are returned in `needed`.
 */
export function estimate(req: EstimateRequest, opts: EstimateOptions = {}): EstimateResult {
  const r = new Reader();
  const needed: NeededInput[] = [];
  const need = (field: string, why: string, f: NeededInput['for'] = 'price') => {
    if (!needed.some((n) => n.field === field)) needed.push({ field, why, for: f });
  };
  const log: SourceLog = createSourceLog();
  const assumptions: AssumptionUsed[] = [];
  const warnings: string[] = [];
  const checks: Check[] = [];
  const bidFacts: BidFactUse[] = [];
  const top = r.obj(req, 'request') ?? {};
  const known = ['job', 'labor', 'materials', 'equipment', 'subcontracts', 'jobOverhead', 'markups', 'bond', 'insurance', 'payment', 'financing', 'limits', 'stress', 'indexes', 'award', 'bidItems'];
  for (const k of Object.keys(top)) if (!known.includes(k)) r.err(k, 'unknown field');

  // ---------------------------------------------------------------- job (spec 1.1)
  const job = r.obj(top.job, 'job') ?? {};
  const bid = opts.bid;
  const owner = r.oneOf(job.ownerType, 'job.ownerType', OWNER_TYPES);
  if (job.ownerType === undefined) need('job.ownerType', 'who owns the job decides bond, retainage and payment rules (federal, nv_local, ...)');
  let state = typeof job.state === 'string' ? job.state.trim().toUpperCase() : undefined;
  if (job.state !== undefined && (typeof job.state !== 'string' || !/^[A-Za-z]{2}$/.test(job.state.trim()))) r.err('job.state', 'must be a two-letter state code');
  const implied = owner ? ownerState(owner) : null;
  if (!state && bid?.state) {
    state = bid.state.toUpperCase();
    bidFacts.push({ fact: 'location', value: bid.locationLabel ?? bid.state, used: true, how: 'state of work' });
  } else if (bid?.state) bidFacts.push({ fact: 'location', value: bid.locationLabel ?? bid.state, used: false, how: 'state given in the request' });
  if (!state && implied) state = implied;
  if (state && implied && state !== implied) r.err('job.state', `owner type ${owner} is in ${implied}, not ${state}`);
  if (!state) need('job.state', 'the state of work picks the payroll tables and overtime rules');

  let estimatedCost = r.money(job.estimatedCost, 'job.estimatedCost');
  if (bid?.estValue && (bid.estValue.min !== null || bid.estValue.max !== null)) {
    const { min, max } = bid.estValue;
    const text = min !== null && max !== null && min !== max ? `$${min} to $${max}` : `$${min ?? max}`;
    if (estimatedCost === undefined && min !== null && min === max && Number.isFinite(min)) {
      estimatedCost = r.money(String(min), 'bid.estValue');
      bidFacts.push({ fact: 'estimate', value: text, used: true, how: "owner's estimate (thresholds and bid-range anchor)" });
    } else bidFacts.push({ fact: 'estimate', value: text, used: false, how: estimatedCost !== undefined ? 'estimate given in the request' : 'a range is not one number: enter the estimate if the notice gives one' });
  }

  let pw = r.oneOf(job.prevailingWage, 'job.prevailingWage', ['none', 'davis_bacon', 'nv_338', 'ca_dir'] as const);
  const pwFlag = bid?.flags.find((f) => /prevailing/i.test(f));
  if (pw === undefined && pwFlag && owner) {
    const mapped: PrevailingWage | undefined = owner === 'federal' || owner === 'federal_aided_local' ? 'davis_bacon' : implied === 'NV' ? 'nv_338' : implied === 'CA' ? 'ca_dir' : undefined;
    if (mapped) {
      pw = mapped;
      bidFacts.push({ fact: 'flag', value: pwFlag, used: true, how: `prevailing wage: ${mapped}` });
    } else bidFacts.push({ fact: 'flag', value: pwFlag, used: false, how: 'prevailing-wage law depends on the owner: set job.prevailingWage' });
  } else if (pwFlag) bidFacts.push({ fact: 'flag', value: pwFlag, used: false, how: pw ? 'prevailing wage given in the request' : 'owner type needed first' });
  if (pw === undefined && owner === 'private') pw = 'none'; // prevailing-wage laws cover public works only
  if (pw === undefined && owner && PUBLIC_OWNERS.includes(owner)) {
    let hint = '';
    if (state === 'NV' && estimatedCost !== undefined) {
      const th = lookupNumber('pw.nv.projectThreshold', 'NV', '2026-11-13' as IsoDate, log);
      hint = estimatedCost >= th ? ' (estimate is at or above $100,000: NRS 338 likely applies, D-30)' : ' (estimate under $100,000: NRS 338 does not apply, D-30)';
    }
    need('job.prevailingWage', `does the solicitation require prevailing wage (none, davis_bacon, nv_338, ca_dir)?${hint}`);
  }

  let bidDate = r.date(job.bidDate, 'job.bidDate');
  if (!bidDate && bid?.dueDate) {
    bidDate = r.date(bid.dueDate, 'bid.dueDate');
    bidFacts.push({ fact: 'due date', value: bid.dueDate, used: true, how: 'bid date' });
  }
  const start = r.date(job.startDate, 'job.startDate');
  const end = r.date(job.endDate, 'job.endDate');
  if (!start) need('job.startDate', 'the start date picks the tax year and the cash timeline');
  if (!end) need('job.endDate', 'the end date sets the duration (bond surcharge, cash timeline)');
  if (start && end && compareDates(end, start) < 0) r.err('job.endDate', 'is before the start date');
  if (bidDate && start && compareDates(start, bidDate) < 0) r.err('job.startDate', 'is before the bid date');
  const workDays = start && end && compareDates(end, start) >= 0 ? dayNumber(end) - dayNumber(start) + 1 : null;
  const regime = state && pw ? regimeFor(state, pw) : null;
  const taxYear = start ? Number(start.slice(0, 4)) : null;
  const supported: SupportedState | null = state === 'NV' || state === 'CA' ? state : null;

  // ---------------------------------------------------------------- labor (spec 1.2, 1.3, 2.1 to 2.4)
  const lab = r.obj(top.labor, 'labor') ?? {};
  const burdenMode = r.oneOf(lab.burdenMode, 'labor.burdenMode', ['statutory', 'flat'] as const) ?? 'statutory';
  const flatPpm = r.pct(lab.flatBurdenPercent, 'labor.flatBurdenPercent', 200);
  if (burdenMode === 'flat') {
    if (flatPpm === undefined) need('labor.flatBurdenPercent', 'flat burden mode needs your one burden percentage');
    warnings.push('Burden is one flat percentage: an approximation (spec 2.3)');
  }
  const classReqs = r.arr(lab.classes, 'labor.classes', 50);
  const classes: LaborClassInput[] = [];
  const classLabels: string[] = [];
  const cw = r.obj(lab.workersComp, 'labor.workersComp') ?? {};
  for (let i = 0; i < classReqs.length; i++) {
    const p = `labor.classes[${i}]`;
    const c = r.obj(classReqs[i], p) ?? {};
    const label = r.label(c.label, `${p}.label`);
    const h10 = r.hours(c.hours, `${p}.hours`) ?? (c.hours === undefined ? r.err(`${p}.hours`, 'straight-time hours are required (0 is allowed)') : undefined);
    const h15 = r.hours(c.overtimeHours, `${p}.overtimeHours`) ?? (0 as HoursC);
    const h20 = r.hours(c.doubleTimeHours, `${p}.doubleTimeHours`) ?? (0 as HoursC);
    const prev = r.obj(c.prevailing, `${p}.prevailing`);
    const bhr = prev ? r.money(prev.basic, `${p}.prevailing.basic`) : undefined;
    const fb = prev ? r.money(prev.fringe, `${p}.prevailing.fringe`) : undefined;
    if (prev && (bhr === undefined || bhr <= 0)) r.err(`${p}.prevailing.basic`, 'the determination basic rate is required and must be above 0');
    if (prev && fb === undefined) r.err(`${p}.prevailing.fringe`, 'the determination fringe rate is required (0 is allowed)');
    const paidAs = prev ? r.oneOf(prev.fringePaidAs, `${p}.prevailing.fringePaidAs`, ['cash', 'plan'] as const) : undefined;
    let wage = r.money(c.wage, `${p}.wage`);
    let cil = r.money(c.cashInLieu, `${p}.cashInLieu`) ?? (0 as Cents);
    let plan = r.money(c.planFringe, `${p}.planFringe`) ?? (0 as Cents);
    const health = r.money(c.healthPlan, `${p}.healthPlan`) ?? (0 as Cents);
    if (wage === undefined && bhr !== undefined && paidAs) {
      // "I pay exactly the determination": basic = BHR_wd and the fringe as cash or plan (the contractor's statement).
      wage = bhr;
      if (paidAs === 'cash') cil = (fb ?? 0) as Cents;
      else plan = (fb ?? 0) as Cents;
    }
    if (wage === undefined) need(`${p}.wage`, `${label || 'this class'}: the cash wage you pay per hour (or the determination with fringePaidAs)`);
    else if (wage <= 0) r.err(`${p}.wage`, 'must be above 0');
    if (health > plan) r.err(`${p}.healthPlan`, 'cannot exceed planFringe');
    const wc = r.per100(c.workersCompPer100, `${p}.workersCompPer100`);
    if (wc === undefined) need(`${p}.workersCompPer100`, `${label || 'this class'}: workers' comp rate per $100 from your policy (A-11: no default)`);
    if (wc !== undefined && wc > 1_000_000) r.err(`${p}.workersCompPer100`, 'must be at most $100 per $100');
    const pay20 = r.money(c.doubleTimeRate, `${p}.doubleTimeRate`);
    if (h20 > 0 && regime && regime !== 'CA_PRIVATE' && pay20 === undefined) need(`${p}.doubleTimeRate`, 'double-time pay per hour from the wage determination footnotes');
    if (regime && (regime === 'NV_PUBLIC' || regime === 'CA_PUBLIC' || regime === 'DAVIS_BACON') && !prev) need(`${p}.prevailing`, `${label || 'this class'}: basic and fringe rates from the wage determination`);
    const W = r.money(c.annualWages, `${p}.annualWages`);
    if (W !== undefined && W <= 0) r.err(`${p}.annualWages`, 'must be above 0');
    const ws = r.bool(c.wageScheduled, `${p}.wageScheduled`);
    classLabels.push(label);
    if (wage !== undefined && wage > 0 && h10 !== undefined && wc !== undefined && taxYear !== null)
      classes.push({
        id: `c${i + 1}`, label, h10, h15, h20, wBasic: wage, wCil: cil, fPlan: plan, fHealth: health,
        travelPerHour: r.money(c.travelPerHour, `${p}.travelPerHour`) ?? (0 as Cents),
        otherPerHour: r.money(c.otherPerHour, `${p}.otherPerHour`) ?? (0 as Cents),
        ...(W !== undefined ? { annualTaxableWages: W } : {}),
        taxYear, wcRatePpm: wc, ...(pay20 !== undefined ? { pay20 } : {}),
        ...(prev && bhr !== undefined && fb !== undefined ? { prevailing: { bhrWd: bhr, fbWd: fb } } : {}),
        ...(ws ? { wageScheduled: true } : {}),
      });
  }
  const hasLabor = classReqs.length > 0;
  if (!hasLabor) warnings.push('No labor classes entered: the estimate carries no labor (a subcontract-only job)');

  // payroll tables, UI, FUTA, MBT, workers' comp — only when there is labor
  let payroll: PayrollTaxTable | undefined;
  let uiRate: Ppm | undefined;
  let futaCr: Ppm | undefined;
  let mbt: BidInput['labor']['mbt'];
  let xMod: Ppm | undefined, otherMods: Ppm | undefined, payrollCap: Cents | null = null, excludeOt = false;
  if (hasLabor) {
    if (state && !supported) need('job.state', `payroll tables are shipped for NV and CA only, not ${state}`);
    if (supported && taxYear !== null && burdenMode === 'statutory') {
      try {
        const t = payrollTable(supported, taxYear, log);
        payroll = t.table;
        assumptions.push(...t.assumptions);
      } catch (e) {
        if (!(e instanceof CostEngineError)) throw e;
        need('job.startDate', `no shipped ${supported} payroll table covers ${taxYear} (${e.message})`);
      }
      uiRate = r.pct(lab.stateUiRatePercent, 'labor.stateUiRatePercent');
      if (uiRate === undefined) {
        try {
          const ne = newEmployerUiRate(supported, taxYear, log);
          uiRate = ne.ratePpm;
          assumptions.push(...ne.assumptions);
          warnings.push(`Unemployment rate: the ${supported} new-employer rate ${uiRate / 10_000}% is used (D-${supported === 'NV' ? '7' : '10'}); enter the rate on your notice`);
        } catch (e) {
          if (!(e instanceof CostEngineError)) throw e;
          need('labor.stateUiRatePercent', 'your unemployment rate notice (no dated new-employer rate covers this year)');
        }
      }
      if (payroll && uiRate !== undefined && (uiRate < payroll.stateUnemployment.ratePpmMin || uiRate > payroll.stateUnemployment.ratePpmMax))
        r.err('labor.stateUiRatePercent', `must be between ${payroll.stateUnemployment.ratePpmMin / 10_000}% and ${payroll.stateUnemployment.ratePpmMax / 10_000}% (${supported} schedule)`);
      futaCr = r.pct(lab.futaCreditReductionPercent, 'labor.futaCreditReductionPercent', 6);
      if (futaCr === undefined && payroll && payroll.futa.creditReductionPpm === null)
        need('labor.futaCreditReductionPercent', `FUTA credit reduction for ${supported} ${taxYear} is not published: enter it (A-9)`);
      if (supported === 'NV') {
        const m = r.obj(lab.mbt, 'labor.mbt');
        if (!m) need('labor.mbt', "Nevada Modified Business Tax: your firm's quarterly gross wages and health deduction, or mode 'none' (D-9)");
        else {
          const mode = r.oneOf(m.mode, 'labor.mbt.mode', ['none', 'marginal', 'average'] as const);
          if (!mode) r.err('labor.mbt.mode', 'is required');
          const gw = r.money(m.quarterlyGrossWages, 'labor.mbt.quarterlyGrossWages');
          const hc = r.money(m.quarterlyHealthDeduction, 'labor.mbt.quarterlyHealthDeduction') ?? (0 as Cents);
          if (mode && mode !== 'none' && gw === undefined) need('labor.mbt.quarterlyGrossWages', "your firm's quarterly gross wages for the MBT");
          if (mode) mbt = { mode, quarterlyGrossWages: (gw ?? 0) as Cents, quarterlyHealthDeduction: hc };
        }
      }
    }
    xMod = r.factor(cw.experienceMod, 'labor.workersComp.experienceMod');
    if (xMod === undefined) need('labor.workersComp.experienceMod', 'experience modification from your policy (1.00 if you have none)');
    else if (xMod <= 0) r.err('labor.workersComp.experienceMod', 'must be above 0');
    otherMods = r.factor(cw.otherMods, 'labor.workersComp.otherMods') ?? (1_000_000 as Ppm); // identity: no other modifiers
    const pol = r.date(cw.policyEffectiveDate, 'labor.workersComp.policyEffectiveDate');
    const exOt = r.bool(cw.excludeOtPremium, 'labor.workersComp.excludeOtPremium');
    if (state === 'NV') {
      const d13 = lookupDefault('wc.excludeOtPremium', 'NV', '2026-11-13' as IsoDate);
      log.use(d13);
      if (exOt === true) r.err('labor.workersComp.excludeOtPremium', 'Nevada premium payroll includes overtime pay (D-13)');
      excludeOt = false;
      if (!pol) need('labor.workersComp.policyEffectiveDate', "your policy's effective date sets the Nevada payroll cap (D-12)");
      else {
        try {
          const cap = nvWcPayrollCap(pol, log);
          payrollCap = cap.cap;
          assumptions.push(...cap.assumptions);
          if (cap.warning) warnings.push(cap.warning);
        } catch (e) {
          if (!(e instanceof CostEngineError)) throw e;
          need('labor.workersComp.policyEffectiveDate', e.message);
        }
      }
    } else {
      excludeOt = exOt ?? true;
      if (exOt === undefined) assumptions.push(useAssumption('A-12', 'overtime premium excluded from workers\' comp payroll outside Nevada'));
    }
  }

  // general liability (A-13: from the policy, no default)
  const ins = r.obj(top.insurance, 'insurance') ?? {};
  const gl = r.obj(ins.generalLiability, 'insurance.generalLiability');
  const fees: { label: string; rate: { ppm: Ppm; base: 'on_price' } }[] = [];
  let glPayroll: Ppm | undefined;
  if (!gl) need('insurance.generalLiability', "general liability from your policy: rated on payroll, on receipts, or 'none' if it sits in overhead (A-13)");
  else {
    const basis = r.oneOf(gl.basis, 'insurance.generalLiability.basis', ['payroll', 'receipts', 'none'] as const);
    if (basis === 'payroll') glPayroll = r.pct(gl.percentOfWages, 'insurance.generalLiability.percentOfWages') ?? r.err('insurance.generalLiability.percentOfWages', 'is required for payroll-rated GL');
    if (basis === 'receipts') {
      const f = r.per1000(gl.per1000, 'insurance.generalLiability.per1000');
      if (f === undefined) r.err('insurance.generalLiability.per1000', 'is required for receipts-rated GL');
      else fees.push({ label: 'General liability (receipts-rated)', rate: { ppm: f, base: 'on_price' } });
    }
    if (!basis) r.err('insurance.generalLiability.basis', 'is required');
  }
  r.arr(ins.otherPriceFees, 'insurance.otherPriceFees', 10).forEach((x, i) => {
    const o = r.obj(x, `insurance.otherPriceFees[${i}]`) ?? {};
    const f = r.per1000(o.per1000, `insurance.otherPriceFees[${i}].per1000`);
    if (f !== undefined) fees.push({ label: r.label(o.label, `insurance.otherPriceFees[${i}].label`), rate: { ppm: f, base: 'on_price' } });
  });

  // ---------------------------------------------------------------- materials (spec 1.4, 2.6, 6.2)
  const mat = r.obj(top.materials, 'materials') ?? {};
  const series = new Map<string, IndexSeries>();
  const idx = r.obj(top.indexes, 'indexes') ?? {};
  r.arr(idx.series, 'indexes.series', 20).forEach((s, i) => {
    try {
      const n = normalizeSeries(s as IndexSeriesInput);
      series.set(n.id, n);
    } catch (e) {
      if (!(e instanceof CostEngineError)) throw e;
      r.err(`indexes.series[${i}]`, e.message);
    }
  });
  const rFwd = r.pct(mat.forwardRatePercent, 'materials.forwardRatePercent', 50);
  const stalePpm = r.pct(mat.stalenessPercent, 'materials.stalenessPercent', 100);
  const lines: MaterialLine[] = [];
  const escalations: { lineId: string; ePpm: number }[] = [];
  const matReqs = r.arr(mat.lines, 'materials.lines', 200);
  const total = r.obj(mat.total, 'materials.total');
  if (matReqs.length && total) r.err('materials.total', 'give lines or a total, not both');
  matReqs.forEach((x, i) => {
    const p = `materials.lines[${i}]`;
    const l = r.obj(x, p) ?? {};
    const label = r.label(l.label, `${p}.label`);
    const q = r.qty(l.quantity, `${p}.quantity`);
    const u = r.money(l.unitPrice, `${p}.unitPrice`);
    if (q === undefined) r.err(`${p}.quantity`, 'is required');
    if (u === undefined) r.err(`${p}.unitPrice`, 'is required');
    const waste = r.pct(l.wastePercent, `${p}.wastePercent`, 50) ?? (0 as Ppm);
    const taxable = r.bool(l.taxable, `${p}.taxable`);
    const quotedOn = r.date(l.quotedOn, `${p}.quotedOn`);
    const purchase = r.date(l.purchaseDate, `${p}.purchaseDate`);
    const hold = r.date(l.holdThrough, `${p}.holdThrough`);
    const fwdPriced = r.bool(l.forwardPriced, `${p}.forwardPriced`);
    const sid = l.seriesId === undefined ? undefined : typeof l.seriesId === 'string' ? l.seriesId : r.err(`${p}.seriesId`, 'must be a series id');
    if (sid !== undefined && !series.has(sid)) r.err(`${p}.seriesId`, `no series '${sid}' in indexes.series`);
    const lid = id(i, label);
    let ePpm = 0;
    if (quotedOn && purchase && !fwdPriced) {
      if (compareDates(purchase, quotedOn) < 0) r.err(`${p}.purchaseDate`, 'is before the quote date');
      else
        try {
          const e = quoteEscalation({
            lineId: lid, quotedOn, purchaseDate: purchase, ...(hold ? { holdThrough: hold } : {}),
            ...(sid && series.has(sid) ? { series: series.get(sid)! } : {}),
            ...(rFwd !== undefined ? { rFwdPpm: rFwd } : {}),
            ...(stalePpm !== undefined ? { stalenessThresholdPpm: stalePpm } : {}),
          });
          const m = ePpmForMaterialLine(e, 'zero-with-warning');
          ePpm = m.ePpm;
          if (m.warning) warnings.push(`${label}: ${m.warning}`);
          warnings.push(...e.warnings.map((w) => `${label}: ${w}`));
          assumptions.push(...e.assumptions);
          if (e.stale) warnings.push(`${label}: the quote is stale against its index: re-quote (spec 6.5 rule 5)`);
        } catch (e) {
          if (!(e instanceof CostEngineError)) throw e;
          if (rFwd === undefined && /forward|r_fwd|A-21/i.test(e.message)) need('materials.forwardRatePercent', `${label} is bought after its quote month: enter a forward escalation rate per year (A-21: no default)`);
          else r.err(p, e.message);
        }
    } else if ((quotedOn || purchase) && !fwdPriced && !hold) {
      warnings.push(`${label}: give both the quote date and the purchase date to age the quote (spec 6.2); priced as quoted`);
    }
    if (ePpm) escalations.push({ lineId: lid, ePpm });
    if (q !== undefined && u !== undefined)
      lines.push({ id: lid, quantity: q, unitPrice: u, wastePpm: waste, ...(taxable !== undefined ? { taxable } : {}), ...(ePpm ? { escalationPpm: ePpm as Ppm } : {}) });
  });
  if (total) {
    const a = r.money(total.amount, 'materials.total.amount');
    const tx = r.bool(total.taxable, 'materials.total.taxable');
    if (a === undefined) r.err('materials.total.amount', 'is required');
    else lines.push({ id: '1-material-total', quantity: 1_000 as QtyM, unitPrice: a, wastePpm: 0 as Ppm, ...(tx !== undefined ? { taxable: tx } : {}) });
  }
  const anyTaxable = lines.some((l) => l.taxable !== false) || mat.freightTaxable === true;
  let salesTax = r.pct(mat.salesTaxPercent, 'materials.salesTaxPercent', 15);
  if (salesTax === undefined && anyTaxable) need('materials.salesTaxPercent', 'combined sales tax rate at the job location (A-14: no default)');
  if (salesTax === undefined && !anyTaxable) salesTax = 0 as Ppm; // no taxable base: tax is exactly 0 at any rate
  if (lines.some((l) => l.taxable === undefined)) {
    if (state === 'NV') assumptions.push(useAssumption('A-16', 'materials taxable (Nevada contractor is the consumer)'));
  }
  const freight = r.money(mat.freight, 'materials.freight') ?? (0 as Cents);
  const freightTaxable = r.bool(mat.freightTaxable, 'materials.freightTaxable');
  const taxBasis = r.oneOf(mat.taxBasis, 'materials.taxBasis', ['total', 'line'] as const);

  // ---------------------------------------------------------------- equipment, subs, job overhead (spec 1.5)
  const equipment: EquipmentLine[] = [];
  r.arr(top.equipment, 'equipment').forEach((x, i) => {
    const p = `equipment[${i}]`;
    const o = r.obj(x, p) ?? {};
    const label = r.label(o.label, `${p}.label`);
    if (o.amount !== undefined) {
      const a = r.money(o.amount, `${p}.amount`);
      if (a !== undefined) equipment.push({ id: id(i, label), kind: 'lump', amount: a });
    } else {
      const h = r.hours(o.hours, `${p}.hours`), rt = r.money(o.rate, `${p}.rate`);
      if (h === undefined || rt === undefined) r.err(p, 'give amount, or hours and rate');
      else equipment.push({ id: id(i, label), kind: 'hourly', hours: h, rate: rt });
    }
  });
  const subcontracts = r.arr(top.subcontracts, 'subcontracts').flatMap((x, i) => {
    const o = r.obj(x, `subcontracts[${i}]`) ?? {};
    const label = r.label(o.label, `subcontracts[${i}].label`);
    const a = r.money(o.amount, `subcontracts[${i}].amount`);
    if (a === undefined) return r.err(`subcontracts[${i}].amount`, 'is required') ?? [];
    return [{ id: id(i, label), amount: a }];
  });
  const jobOverhead: JobOverheadItem[] = [];
  r.arr(top.jobOverhead, 'jobOverhead').forEach((x, i) => {
    const p = `jobOverhead[${i}]`;
    const o = r.obj(x, p) ?? {};
    const label = r.label(o.label, `${p}.label`);
    if (o.amount !== undefined) {
      const a = r.money(o.amount, `${p}.amount`);
      if (a !== undefined) jobOverhead.push({ id: id(i, label), kind: 'once', amount: a });
    } else if (o.months !== undefined) {
      const m = r.qty(o.months, `${p}.months`), mc = r.money(o.monthlyCost, `${p}.monthlyCost`);
      if (m === undefined || mc === undefined) r.err(p, 'give months and monthlyCost');
      else jobOverhead.push({ id: id(i, label), kind: 'monthly', months: m, monthlyCost: mc });
    } else {
      const h = r.hours(o.hours, `${p}.hours`), rt = r.money(o.rate, `${p}.rate`);
      if (h === undefined || rt === undefined) r.err(p, 'give amount, months and monthlyCost, or hours and rate');
      else jobOverhead.push({ id: id(i, label), kind: 'hours', hours: h, rate: rt });
    }
  });

  // ---------------------------------------------------------------- markups (spec 1.6, 2.5, 2.10 to 2.12, 2.14)
  const mk = r.obj(top.markups, 'markups') ?? {};
  const st = r.pct(mk.smallToolsPercent, 'markups.smallToolsPercent', 20);
  if (st === undefined) log.use(lookupDefault('smallTools.prime', 'US', '2026-11-13' as IsoDate)); // A-18 rests on D-66
  const cont = r.pct(mk.contingencyPercent, 'markups.contingencyPercent', 50);
  const eL = r.pct(lab.escalationPercent, 'labor.escalationPercent', 50);
  let overhead: OverheadInput | undefined;
  const oh = r.obj(mk.overhead, 'markups.overhead');
  let profitPpm = r.pct(mk.profitPercent, 'markups.profitPercent', 100);
  if (!oh) need('markups.overhead', 'your home-office overhead method and rate (A-7: no default; D-65 ranges are context only)');
  else {
    const method = r.oneOf(oh.method, 'markups.overhead.method', ['on_cost', 'on_sales', 'per_labor_hour', 'on_labor_cost', 'dual'] as const);
    const P = 'markups.overhead';
    if (method === 'on_cost') {
      if (oh.percent !== undefined) {
        const x = r.pct(oh.percent, `${P}.percent`, 100);
        if (x !== undefined) overhead = { method, rate: { ppm: x, base: 'on_cost' } };
      } else {
        const a = r.money(oh.annualOverhead, `${P}.annualOverhead`), d = r.money(oh.annualDirectCost, `${P}.annualDirectCost`);
        if (a === undefined || d === undefined || d <= 0) r.err(P, 'give percent, or annualOverhead and a positive annualDirectCost');
        else overhead = { method, annual: { overhead: a, directCost: d } };
      }
    } else if (method === 'on_sales') {
      const o = r.pct(oh.percent, `${P}.percent`, 99), m = r.pct(oh.profitPercent, `${P}.profitPercent`, 99);
      if (o === undefined || m === undefined) r.err(P, 'on_sales needs percent and profitPercent (both on revenue)');
      else if (o + m >= 1_000_000) r.err(P, 'overhead + profit on sales must be below 100%');
      else overhead = { method, rate: { ppm: o, base: 'on_sales' }, profit: { ppm: m, base: 'on_sales' } };
      if (mk.profitPercent !== undefined) r.err('markups.profitPercent', "with method 'on_sales' the profit is overhead.profitPercent");
      profitPpm = undefined;
    } else if (method === 'per_labor_hour') {
      const x = r.money(oh.perHour, `${P}.perHour`);
      if (x === undefined) r.err(`${P}.perHour`, 'is required');
      else overhead = { method, centsPerHour: x };
    } else if (method === 'on_labor_cost') {
      const ms = r.oneOf(oh.measure, `${P}.measure`, ['L', 'G'] as const), x = r.pct(oh.percent, `${P}.percent`, 500);
      if (!ms || x === undefined) r.err(P, "on_labor_cost needs measure ('L' burdened or 'G' cash wages) and percent");
      else overhead = { method, measure: ms, rate: { ppm: x, base: 'on_labor_cost' } };
    } else if (method === 'dual') {
      const a = r.pct(oh.laborPercent, `${P}.laborPercent`, 500), b = r.pct(oh.otherPercent, `${P}.otherPercent`, 100);
      if (a === undefined || b === undefined) r.err(P, 'dual needs laborPercent and otherPercent');
      else {
        overhead = { method, rateL: { ppm: a, base: 'on_labor_cost' }, rateM: { ppm: b, base: 'on_cost' } };
        assumptions.push(useAssumption('A-38', 'non-labor base is all of TJC - L'));
      }
    } else if (!method) r.err(`${P}.method`, 'is required');
  }
  if (overhead && overhead.method !== 'on_sales' && profitPpm === undefined) need('markups.profitPercent', 'your profit on cost + overhead (A-7: no default)');
  const roundUnit = r.money(mk.bidRoundingUnit, 'markups.bidRoundingUnit');
  if (roundUnit !== undefined && roundUnit <= 0) r.err('markups.bidRoundingUnit', 'must be above 0');

  // ---------------------------------------------------------------- bond (spec 1.7, 2.13, 4.2 to 4.4)
  const bd = r.obj(top.bond, 'bond') ?? {};
  let bondMode = r.oneOf(bd.required, 'bond.required', ['auto', 'yes', 'no'] as const);
  const bondFlag = bid?.flags.find((f) => /(performance|payment)\s*bond/i.test(f));
  if (!bondMode && bondFlag) {
    bondMode = 'yes';
    bidFacts.push({ fact: 'flag', value: bondFlag, used: true, how: 'surety bond required' });
  } else if (bondFlag) bidFacts.push({ fact: 'flag', value: bondFlag, used: false, how: `bond setting given in the request (${bondMode})` });
  for (const f of bid?.flags ?? []) if (/bid\s*bond|bid security/i.test(f)) bidFacts.push({ fact: 'flag', value: f, used: false, how: 'bid security: a bid bond costs nothing by default (A-2); see the bid documents for its amount' });
  let bondTable: BondRequirementTable | undefined;
  if (!bondMode && owner) {
    try {
      bondTable = bondRequirementTable(owner, log);
      bondMode = 'auto';
      warnings.push('Bond requirement taken from the statute for this owner (spec 4.2); the bid documents override it');
    } catch (e) {
      if (!(e instanceof CostEngineError)) throw e;
      need('bond.required', `${e.message}: say whether a performance or payment bond is required (yes / no)`);
    }
  } else if (bondMode === 'auto' && owner) {
    try {
      bondTable = bondRequirementTable(owner, log);
    } catch (e) {
      if (!(e instanceof CostEngineError)) throw e;
      need('bond.required', `${e.message}: say yes or no`);
    }
  }
  const officerChoice = r.bool(bd.officerChoiceMeansBond, 'bond.officerChoiceMeansBond');
  let tiers: BondTier[] = [];
  let usedSample = false;
  const tierReqs = r.arr(bd.tiers, 'bond.tiers', 20);
  if (tierReqs.length) {
    tierReqs.forEach((x, i) => {
      const o = r.obj(x, `bond.tiers[${i}]`) ?? {};
      const up = o.upTo === null || o.upTo === undefined ? null : r.money(o.upTo, `bond.tiers[${i}].upTo`);
      const rate = r.per1000(o.ratePer1000, `bond.tiers[${i}].ratePer1000`);
      if (rate === undefined) r.err(`bond.tiers[${i}].ratePer1000`, 'is required');
      else tiers.push({ upperBound: (up ?? null) as Cents | null, ratePpm: rate });
    });
  } else if (bondMode && bondMode !== 'no') {
    tiers = sampleBondTiers('non_deviating').tiers; // logged as a source only if a bond applies
    usedSample = true;
  }
  let surcharge = r.oneOf(bd.surcharge, 'bond.surcharge', ['non_deviating', 'deviating', 'table_24'] as const);
  let mDur = 1_000_000 as Ppm;
  let months: number | null = null;
  if (bondMode && bondMode !== 'no' && start && end && compareDates(end, start) >= 0) {
    const bm = bondMonths(start, end);
    months = bm.months;
    if (!surcharge && usedSample) surcharge = 'non_deviating'; // the D-38 sample is the non-deviating table
    if (surcharge) {
      const sp = surchargePreset(surcharge); // logged as a source only if a bond applies
      mDur = durationMultiplierPpm(bm.months, sp.M1, sp.M2, sp.s1, sp.s2);
      if (bm.months > sp.M1) assumptions.push(bm.assumption);
    } else if (bm.months > 12) need('bond.surcharge', "your surety's duration surcharge table (non_deviating, deviating or table_24, D-39): the job runs over 12 months");
  }
  const sbaReq = r.obj(bd.sba, 'bond.sba');
  const sbaDate = sbaReq ? r.date(sbaReq.approvalDate, 'bond.sba.approvalDate') : undefined;
  if (sbaReq && !sbaDate) r.err('bond.sba.approvalDate', 'is required');
  const sbaTbl = sbaDate ? sbaFeeTable(log) : undefined;
  const officerHits: boolean[] = [];

  // ---------------------------------------------------------------- payment terms, financing (spec 1.8, 4.5, 4.6, 5.6)
  const pay = r.obj(top.payment, 'payment') ?? {};
  let timing: ReturnType<typeof paymentTiming> | undefined;
  if (owner) {
    try {
      timing = paymentTiming(owner, log);
    } catch {
      /* no preset: each piece is asked for below */
    }
  }
  let billDays = r.days(pay.billingCycleDays, 'payment.billingCycleDays', 1);
  if (billDays === undefined && timing?.billingCycle === 'monthly' && start) billDays = monthlyCycleDays(start);
  if (billDays === undefined && typeof timing?.billingCycle === 'number') billDays = timing.billingCycle;
  if (billDays === undefined) need('payment.billingCycleDays', 'days between pay applications (per your contract)', 'cash');
  const payDays = r.days(pay.ownerPayDays, 'payment.ownerPayDays') ?? timing?.payLagDays;
  if (payDays === undefined) need('payment.ownerPayDays', 'days after a pay application the owner pays (per your contract)', 'cash');
  let retRule: RetainageRule | undefined;
  const retReq = pay.retainage;
  if (retReq !== undefined && typeof retReq === 'object' && retReq !== null) {
    const x = r.pct((retReq as Record<string, unknown>).percent, 'payment.retainage.percent', 20);
    if (x !== undefined) retRule = { id: 'contract', rho1Ppm: x, thetaPpm: null, rho2Ppm: x, kappaPpm: null, dollarCap: null, halfRelease: false };
  } else {
    const kase = r.oneOf(retReq, 'payment.retainage', ['base', 'best', 'stress'] as const) ?? 'base';
    if (owner)
      try {
        retRule = retainageRule(owner, kase, log);
        if (retRule.halfRelease || retRule.thetaPpm !== null) assumptions.push(useAssumption('A-22', 'cost-proportional schedule of values; a billing crossing 50% is split pro rata; half release with the first payment after 50%'));
        if (implied === 'NV' && estimatedCost !== undefined && estimatedCost <= 10_000_000) assumptions.push(useAssumption('A-37', 'Nevada retainage rule applied to small solicited works'));
      } catch (e) {
        if (!(e instanceof CostEngineError)) throw e;
        need('payment.retainage', `${e.message}: enter { percent }`, 'cash');
      }
  }
  let relDays = r.days(pay.retainageReleaseDays, 'payment.retainageReleaseDays');
  if (relDays === undefined && timing && timing.retainageReleaseLagDays !== null) relDays = timing.retainageReleaseLagDays;
  const retNonZero = retRule ? retRule.rho1Ppm > 0 || retRule.rho2Ppm > 0 : false;
  if (relDays === undefined && retNonZero) {
    need('payment.retainageReleaseDays', 'days after completion the retainage is paid (per contract; A-30)', 'cash');
    assumptions.push(useAssumption('A-30', 'Nevada retainage release per contract'));
  }
  if (relDays === undefined && retRule && !retNonZero && payDays !== undefined) relDays = payDays; // nothing is held: the date is moot
  const supplierDays = r.days(pay.supplierNetDays, 'payment.supplierNetDays');
  const depositPpm = r.pct(pay.materialDepositPercent, 'payment.materialDepositPercent', 100);
  const subDays = r.days(pay.subPaidDays, 'payment.subPaidDays') ?? 0;
  if (pay.subPaidDays === undefined && subcontracts.length) warnings.push('Subcontractors are treated as paid when their cost is incurred (conservative; the pay-when-paid link is not modelled)');

  const finReq = r.obj(top.financing, 'financing') ?? {};
  const finInclude = r.bool(finReq.include, 'financing.include');
  const finRate = r.pct(finReq.annualRatePercent, 'financing.annualRatePercent', 100);
  const dayCountRaw = finReq.dayCount;
  if (dayCountRaw !== undefined && dayCountRaw !== 360 && dayCountRaw !== 365) r.err('financing.dayCount', 'must be 360 or 365');
  const includeFin = finInclude !== false; // spec 1.6: includeFinancingInPrice defaults to true
  if (includeFin && finRate === undefined) need('financing.annualRatePercent', 'interest rate on the money you borrow to carry the job (no default; D-60 prime is context only), or set financing.include to false');

  // ---------------------------------------------------------------- limits, stress, award (spec 1.9, 5.8, 7)
  const lim = r.obj(top.limits, 'limits');
  const lget = (k: string) => (lim ? r.money(lim[k], `limits.${k}`) : undefined);
  const cashForJob = lget('cashForJob'), credit = lget('unusedCreditLine');
  if (!lim || cashForJob === undefined) need('limits.cashForJob', 'cash you will commit to this job, for the carry check', 'limits');
  if (!lim || credit === undefined) need('limits.unusedCreditLine', 'unused credit line (0 if none), for the carry check', 'limits');
  const sl = lim ? r.obj(lim.suretyLetter, 'limits.suretyLetter') : undefined;
  const letter = sl ? { singleLimit: r.money(sl.singleLimit, 'limits.suretyLetter.singleLimit'), aggregateLimit: r.money(sl.aggregateLimit, 'limits.suretyLetter.aggregateLimit'), backlogRemaining: r.money(sl.backlogRemaining, 'limits.suretyLetter.backlogRemaining') } : undefined;
  if (letter && (letter.singleLimit === undefined || letter.aggregateLimit === undefined || letter.backlogRemaining === undefined)) r.err('limits.suretyLetter', 'needs singleLimit, aggregateLimit and backlogRemaining');
  const buffer = lim ? r.pct(lim.bufferPercent, 'limits.bufferPercent', 100) : undefined;
  const stressReq = r.obj(top.stress, 'stress') ?? {};
  const laborUp = r.pct(stressReq.laborIncreasePercent, 'stress.laborIncreasePercent', 100);
  const changeOrder = r.money(stressReq.unpaidChangeOrder, 'stress.unpaidChangeOrder');
  const aw = r.obj(top.award, 'award');
  const bidItemsReq = r.arr(top.bidItems, 'bidItems', 100).map((x, i) => {
    const o = r.obj(x, `bidItems[${i}]`) ?? {};
    return { id: id(i, r.label(o.label, `bidItems[${i}].label`)), label: String(o.label ?? ''), directCost: r.money(o.directCost, `bidItems[${i}].directCost`) ?? (r.err(`bidItems[${i}].directCost`, 'is required') as undefined) };
  });

  // Prevailing-wage compliance (spec 2.2, law): a failed check is an error, not a warning.
  classes.forEach((c) => {
    if (!c.prevailing) return;
    const pwc = prevailingWageCheck(c);
    const i = Number(c.id.slice(1)) - 1;
    if (!pwc.ok) r.err(`labor.classes[${i}].wage`, `pay is ${dollars(pwc.shortfallPerHour)}/h short of the prevailing rate ${dollars(pwc.required)}/h (law; the determination governs)`);
  });
  if (r.errors.length) throw new EstimateInputError(r.errors);

  // ================================================================ price (spec 2)
  const blockedPrice = needed.some((n) => n.for === 'price');
  const jobOut = { ownerType: owner ?? null, state: state ?? null, regime, prevailingWage: pw ?? null, startDate: start ?? null, endDate: end ?? null, workDays, bondApplied: null as boolean | null };
  const emptyLimits = { status: 'not_checked' as const, reason: 'no price yet' };
  if (blockedPrice || !regime || !overhead || salesTax === undefined || (hasLabor && burdenMode === 'statutory' && (!payroll || uiRate === undefined)) || (hasLabor && xMod === undefined)) {
    return finish(null);
  }

  const bondHook = bondTable
    ? (P: Cents) => {
        const req0 = bondRequirement(bondTable!, P);
        if (req0.anyBond === 'officer_choice') {
          officerHits.push(true);
          return officerChoice === true;
        }
        return req0.anyBond === 'yes';
      }
    : undefined;
  const chargesFor = (withSba: boolean): PriceChargesInput => ({
    tiers: bondMode === 'no' ? [] : tiers,
    mDurPpm: mDur,
    fees: [...fees, ...(withSba && sbaTbl && sbaDate ? [sbaFeeCharge(sbaTbl, sbaDate)] : [])],
    ...(bondMode === 'auto' && bondHook ? { bondRequiredAuto: bondHook } : {}),
  });
  // The core needs at least one class: a labor-free bid carries one zero-hour class (flat mode, all rates 0).
  const noLabor = classes.length === 0;
  const laborIn: BidInput['labor'] = {
    regime,
    stateOfWork: state!,
    burdenMode: noLabor ? 'flat' : burdenMode,
    classes: noLabor
      ? [{ id: 'none', label: 'no labor', h10: 0 as HoursC, h15: 0 as HoursC, h20: 0 as HoursC, wBasic: 1 as Cents, wCil: 0 as Cents, fPlan: 0 as Cents, fHealth: 0 as Cents, travelPerHour: 0 as Cents, otherPerHour: 0 as Cents, annualTaxableWages: 1 as Cents, taxYear: taxYear ?? 2026, wcRatePpm: 0 as Ppm }]
      : classes,
    ...(payroll && taxYear !== null ? { payrollTables: { [taxYear]: payroll } } : {}),
    ...(uiRate !== undefined ? { stateUiRatePpm: uiRate } : {}),
    ...(futaCr !== undefined ? { futaCreditReductionPpm: futaCr } : {}),
    ...(mbt ? { mbt } : {}),
    workersComp: { xModPpm: (xMod ?? 1_000_000) as Ppm, otherModsPpm: (otherMods ?? 1_000_000) as Ppm, excludeOtPremium: excludeOt, payrollCap },
    ...(glPayroll !== undefined ? { generalLiabilityPayrollPpm: glPayroll } : {}),
    ...(noLabor ? { flatBurdenPpm: 0 as Ppm } : flatPpm !== undefined ? { flatBurdenPpm: flatPpm } : {}),
  };
  const baseInput = (withSba: boolean): Omit<BidInput, 'financing'> => ({
    labor: laborIn,
    ...(st !== undefined ? { smallToolsPpm: st } : {}),
    materials: { lines, freight, ...(freightTaxable !== undefined ? { freightTaxable } : {}), salesTaxPpm: salesTax!, ...(taxBasis ? { taxBasis } : {}) },
    equipment,
    subcontracts,
    jobOverhead,
    ...(eL !== undefined ? { laborEscalationPpm: eL } : {}),
    ...(cont !== undefined ? { contingencyPpm: cont } : {}),
    overhead: overhead!,
    profit: overhead!.method === 'on_sales' ? { fromOverheadOnSales: true } : { rate: { ppm: profitPpm!, base: 'on_cost' } },
    charges: chargesFor(withSba),
    ...(roundUnit !== undefined ? { bidRoundingUnit: roundUnit } : {}),
    ...(bidItemsReq.length ? { bidItems: bidItemsReq.map((b) => ({ id: b.id, directCost: b.directCost! })) } : {}),
    ...(start ? { startDate: start } : {}),
    ...(end ? { endDate: end } : {}),
  });

  // Pass 1 without financing: TJC and the cost categories do not depend on FIN.
  let withSba = !!sbaDate;
  let pass1 = buildBid({ ...baseInput(withSba), financing: { include: false } });
  if (withSba && !pass1.bondApplied) {
    withSba = false; // no bond on this job: no SBA guarantee fee
    warnings.push('SBA guarantee fee dropped: no surety bond applies to this job');
    pass1 = buildBid({ ...baseInput(false), financing: { include: false } });
  }
  if (officerHits.length && officerChoice === undefined) {
    need('bond.officerChoiceMeansBond', 'federal $35,000 to $150,000: will the contracting officer require a payment bond (true) or accept other protection (false)? (D-33)');
    return finish(null);
  }

  // Cash model at a given price (spec 5): daily grid, uniform cost shapes, lags from the payment terms.
  const termsReady = workDays !== null && billDays !== undefined && payDays !== undefined && retRule !== undefined && relDays !== undefined;
  const nothingToCarry = pass1.totals.TJC === 0 && pass1.totals.q === 0;
  const cashReady = termsReady && !nothingToCarry;
  const premiumAt = (B: BidBreakdown) => B.totals.premium;
  const cashJob = (b: BidBreakdown, price: Cents, q: Cents): CashJobInput => {
    const t = b.totals;
    const D = workDays!;
    const uni = costWeights({ kind: 'uniform' }, D).weights;
    const pre = [1];
    const supplier = supplierDays ?? 30;
    const cats: CashCategory[] = [];
    const add = (cid: string, kind: CostKind, amount: number, lagDays: number, weights: readonly number[], dep?: Ppm) => {
      if (amount > 0) cats.push({ id: cid, kind, amount: amount as Cents, weights, lagPeriods: outflowLagPeriods(lagDays, 1), ...(dep ? { deposit: { sharePpm: dep, period: 0 } } : {}) });
    };
    add('labor', 'labor', t.L, 0, uni);
    add('material', 'material', t.MAT, supplier, uni, depositPpm);
    add('equipment', 'equipment', t.E, supplier, uni);
    add('subcontract', 'subcontract', t.SUB, subDays, uni);
    add('job_overhead', 'job_overhead', t.JOOH, 0, uni);
    add('other', 'other', t.ST + t.ESC_L + t.CONT, 0, uni);
    add('pre_start', 'pre_start', q, 0, pre);
    if (!cats.length) add('pre_start', 'pre_start', 0, 0, pre);
    const lam = inflowLagPeriods(payDays!, 1);
    let lamR = relDays!;
    if (lamR < lam) lamR = lam; // the release cannot come before the last progress receipt (spec 5.3)
    const fedEarly = owner === 'federal' && premiumAt(b) > 0 ? { earlyLine: { amount: premiumAt(b) as Cents, billing: 1 } } : {};
    return { periodDays: 1, workPeriods: D, price, categories: cats.length ? cats : [{ id: 'none', kind: 'other', amount: 0 as Cents, weights: [1], lagPeriods: 0 }], billingPeriods: billDays!, ownerLagPeriods: lam, retainage: retRule!, retainageReleasePeriods: lamR, ...fedEarly };
  };
  if (cashReady) {
    if (supplierDays === undefined && (pass1.totals.MAT > 0 || pass1.totals.E > 0)) assumptions.push(useAssumption('A-26', 'supplier terms net 30, no deposit; pay-first ordering; outflow lags rounded down, inflow lags up'));
    else assumptions.push(useAssumption('A-26', 'pay-first ordering within a period; outflow lags rounded down, inflow lags rounded up'));
    warnings.push('Cash model: labor, burden and job overhead are treated as paid in the period they are incurred (conservative); costs spread evenly over the work days unless you give a schedule');
  }

  // Pass 2 with the financing line (one pass, A-20).
  let breakdown: BidBreakdown;
  let FIN = 0;
  let dayCount: 360 | 365 | null = null;
  if (includeFin && nothingToCarry) {
    breakdown = pass1; // no cost at all: nothing to carry, nothing to finance
    dayCount = null;
  } else if (includeFin) {
    if (!cashReady) {
      need('payment', 'financing is priced from the cash model: the payment terms above are needed', 'price');
      return finish(null);
    }
    dayCount = (dayCountRaw as 360 | 365 | undefined) ?? 365;
    if (dayCountRaw === undefined) assumptions.push(useAssumption('A-29', '365-day basis'));
    const rate = finRate!;
    breakdown = buildBid({
      ...baseInput(withSba),
      financing: {
        include: true,
        compute: (SnoFin, PnoFin) => {
          const q = toCents(BigInt(PnoFin) - BigInt(SnoFin), 'q at P without FIN');
          return financingCost(cashLedger(cashJob(pass1, PnoFin, q)), rate, dayCount!).FIN;
        },
      },
    });
    FIN = breakdown.totals.FIN;
  } else breakdown = pass1;
  const T = breakdown.totals;
  jobOut.bondApplied = breakdown.bondApplied;
  if (breakdown.bondApplied && usedSample) assumptions.push(sampleBondTiers('non_deviating', log).assumption);
  if (breakdown.bondApplied && surcharge) surchargePreset(surcharge, log);
  if (breakdown.bondApplied) assumptions.push(useAssumption('A-2', 'one premium covers performance and payment bonds'));
  assumptions.push(...breakdown.assumptions);
  warnings.push(...breakdown.warnings);
  for (const c of classes) {
    if (!c.prevailing) continue;
    const pwc = prevailingWageCheck(c);
    const label = c.label ?? c.id;
    if (pwc.ok) checks.push({ level: 'ok', text: `${label}: pay meets the prevailing rate ${dollars(pwc.required)}/h on every hour` });
  }
  if (sbaDate && sbaTbl && withSba) {
    const f = sbaFee(sbaTbl, T.Pbid, sbaDate, { guarantee: 'contract', ...(sbaReq?.federalCertified ? { federalCertified: true } : {}) });
    assumptions.push(...f.assumptions);
    warnings.push(`SBA guarantee fee payable ${dollars(f.feePayable)} (${f.ratePpm / 1000} per $1,000, D-37; rounded to the dollar)`);
  }
  if (state === 'NV' && estimatedCost !== undefined && (owner === 'nv_local' || owner === 'nv_state_spwd')) {
    const one = lookupNumber('smallWorks.nv.oneBelow', 'NV', '2026-11-13' as IsoDate, log), three = lookupNumber('smallWorks.nv.threeUpTo', 'NV', '2026-11-13' as IsoDate, log);
    if (estimatedCost <= three) warnings.push(estimatedCost <= one ? 'Nevada small works: at least one licensed contractor is solicited (D-70)' : 'Nevada small works: at least three licensed contractors are solicited (D-70)');
  }

  // ================================================================ cash, limits (spec 5)
  let cashOut: EstimateResult['cash'] = { status: 'not_computed', reason: nothingToCarry ? 'the job has no cost to carry' : 'payment terms are needed (see needed)' };
  let limitsOut: EstimateResult['limits'] = { status: 'not_checked', reason: 'enter your cash for the job and unused credit line' };
  // spec 7.7 + 5.8: a cash check that fails at the estimate's price vetoes the bid range (see the range below)
  let cashVeto: string | null = null;
  if (cashReady) {
    const jobIn = cashJob(breakdown, T.Pbid, T.qBid);
    const L = cashLedger(jobIn);
    const pk = peakFloat(L);
    assumptions.push(...L.assumptions);
    cashOut = {
      status: 'computed', peakFloat: pk.F, peakDay: pk.tStar, peakFloatReceiptsFirst: pk.Frf, upFront: pk.upFront, preStart: pk.preStart,
      daysToFirstCashIn: pk.daysToFirstCashIn, daysCashNegative: pk.daysCashNegative, finalCash: pk.finalCash, cashCost: L.Ccash,
      peakOverCost: ratioText(pk.FOverCost), compositionAtPeak: pk.compositionAtPeak,
      grid: { periodDays: 1, workDays: workDays!, billingCycleDays: billDays!, ownerPayDays: payDays!, retainage: retRule!.id, retainageReleaseDays: jobIn.retainageReleasePeriods },
    };
    if (lim && cashForJob !== undefined && credit !== undefined) {
      const st = stressCases(jobIn, { codKinds: ['material', 'equipment'], ...(laborUp !== undefined ? { laborIncreasePpm: laborUp } : {}), ...(changeOrder !== undefined ? { unpaidChangeOrder: { amount: changeOrder, period: workDays! } } : {}) });
      assumptions.push(...st.assumptions);
      if (laborUp === undefined) warnings.push('Stress "labor up at the same price" not run: enter stress.laborIncreasePercent (no default)');
      const limits: ContractorLimits = {
        cashForJob, unusedCreditLine: credit,
        ...(buffer !== undefined ? { bufferPpm: buffer } : {}),
        ...(lget('maxJobSize') !== undefined ? { maxJobSize: lget('maxJobSize')! } : {}),
        ...(lget('maxUpFrontCash') !== undefined ? { maxUpFrontCash: lget('maxUpFrontCash')! } : {}),
        ...(letter && letter.singleLimit !== undefined ? { suretyLetter: letter as { singleLimit: Cents; aggregateLimit: Cents; backlogRemaining: Cents } } : {}),
        ...(lget('workingCapital') !== undefined ? { workingCapital: lget('workingCapital')! } : {}),
        ...(lget('netWorth') !== undefined ? { netWorth: lget('netWorth')! } : {}),
        ...(lget('currentAssets') !== undefined ? { currentAssets: lget('currentAssets')! } : {}),
        ...(lget('currentLiabilities') !== undefined ? { currentLiabilities: lget('currentLiabilities')! } : {}),
        ...(lget('backlog') !== undefined ? { backlog: lget('backlog')! } : {}),
      };
      const lc = limitsCheck({ price: T.Pbid, peak: pk, limits, bondRequired: breakdown.bondApplied, stress: st.cases });
      assumptions.push(...lc.assumptions, ...lc.checks.flatMap((c) => c.assumptions));
      const cashStop = lc.checks.find((c) => (c.id === 'peak_float' || c.id === 'up_front_cash') && c.verdict === 'stop');
      if (cashStop) cashVeto = `${cashStop.id === 'peak_float' ? 'cash to carry the job' : 'up-front cash'} does not fit at the estimated price (${cashStop.outcome})`;
      limitsOut = {
        status: 'checked',
        checks: lc.checks.map((c) => ({ id: c.id, verdict: c.verdict, outcome: c.outcome, ruleOfThumb: c.ruleOfThumb, numbers: c.numbers })),
        stress: lc.stress.map((s) => ({ id: s.id, label: s.label, peakFloat: s.F, verdict: s.verdict, outcome: s.outcome })),
        funds: lc.funds, need: lc.need, headroom: lc.headroom, coverage: lc.coverage ? ratioText(lc.coverage, 2) : null,
      };
      const name: Record<string, string> = { job_size: 'Job size', up_front_cash: 'Up-front cash', peak_float: 'Cash to carry the job', bonding: 'Bonding', liquidity_working_capital: 'Rule of thumb: working capital', liquidity_current_ratio: 'Rule of thumb: current ratio' };
      for (const c of lc.checks) checks.push({ level: VERDICT_LEVEL[c.verdict] ?? 'warn', text: `${name[c.id] ?? c.id}: ${c.outcome}` });
      for (const s of lc.stress) checks.push({ level: s.verdict, text: `Stress — ${s.label}: ${s.outcome}` });
    }
  }

  // ================================================================ bid range (spec 7)
  let range: EstimateResult['bidRange'] = { status: 'not_shown', reason: 'No comparable lettings entered: a bid range needs your own bid history (at least 10 comparable lettings, A-25)' };
  if (aw) {
    const ra = new Reader();
    const lettings: LettingRecord[] = ra.arr(aw.lettings, 'award.lettings', 500).flatMap((x, i) => {
      const o = ra.obj(x, `award.lettings[${i}]`) ?? {};
      const a = ra.money(o.anchor, `award.lettings[${i}].anchor`), lc = ra.money(o.lowestCompeting, `award.lettings[${i}].lowestCompeting`);
      const kind = ra.oneOf(o.anchorKind, `award.lettings[${i}].anchorKind`, ['owner_estimate', 'own_cost_estimate'] as const) ?? 'owner_estimate';
      if (a === undefined || lc === undefined || a <= 0) return ra.err(`award.lettings[${i}]`, 'needs a positive anchor and lowestCompeting') ?? [];
      return [{ id: `L${i + 1}`, anchor: a, anchorKind: kind, lowestCompeting: lc, provenance: { kind: 'private' as const, tenantId: opts.tenantId ?? 'self' } }];
    });
    const anchor = ra.money(aw.anchor, 'award.anchor') ?? estimatedCost;
    const mMin = ra.pct(aw.minMarkupPercent, 'award.minMarkupPercent', 100);
    const K = ra.money(aw.bidPrepCost, 'award.bidPrepCost');
    const delta = aw.delta === undefined ? undefined : typeof aw.delta === 'number' && aw.delta >= 0 && aw.delta < 1 ? aw.delta : (ra.err('award.delta', 'must be a number in [0, 1)') as undefined);
    const refClass = typeof aw.referenceClass === 'string' && aw.referenceClass.trim() ? aw.referenceClass.trim() : undefined;
    if (ra.errors.length) throw new EstimateInputError(ra.errors);
    const miss: string[] = [];
    if (anchor === undefined || anchor <= 0) { need('award.anchor', "this job's anchor (the owner's estimate) for the bid range", 'range'); miss.push('anchor'); }
    if (mMin === undefined) { need('award.minMarkupPercent', 'your minimum acceptable markup (the floor of the range)', 'range'); miss.push('minimum markup'); }
    if (K === undefined) { need('award.bidPrepCost', 'what preparing this bid costs you (sunk if you lose)', 'range'); miss.push('bid preparation cost'); }
    if (!refClass) { need('award.referenceClass', 'which comparable lettings these are (agency class, trade, size band)', 'range'); miss.push('reference class'); }
    if (miss.length) range = { status: 'not_shown', reason: `Bid range needs: ${miss.join(', ')}` };
    else {
      const rule: AwardRule = owner && implied === 'NV' && estimatedCost !== undefined ? { kind: 'nv_bidder_preference', estimatedCost } : { kind: 'sealed_low' };
      const curve = pWinEmpirical({ lettings, referenceClass: refClass!, requestingTenantId: opts.tenantId ?? 'self' }, { anchor: anchor!, rule, ourFlags: {} });
      // spec 7.7: the 5.8 limits are evaluated at every candidate price and can veto it. Upper limits bound the
      // search exactly: job size, the letter's single-job limit and the room left on its aggregate (5.8:
      // backlogRemaining + P <= aggregateLimit). The cash checks are vetoes taken at the estimate's price.
      const aggRoom = breakdown.bondApplied && letter?.aggregateLimit !== undefined && letter?.backlogRemaining !== undefined ? letter.aggregateLimit - letter.backlogRemaining : undefined;
      const caps = [
        ...(lget('maxJobSize') !== undefined ? [{ cap: lget('maxJobSize')!, reason: 'your maximum job size' }] : []),
        ...(breakdown.bondApplied && letter?.singleLimit !== undefined ? [{ cap: letter.singleLimit, reason: 'surety single-job limit' }] : []),
        ...(aggRoom !== undefined && aggRoom > 0 ? [{ cap: aggRoom as Cents, reason: 'surety aggregate limit less backlog' }] : []),
      ];
      const check = cashVeto ? (): { ok: boolean; reason: string } => ({ ok: false, reason: cashVeto! }) : undefined;
      const sel = aggRoom !== undefined && aggRoom <= 0
        ? null
        : selectBid({ costs: { TJC: T.TJC, OH: T.OH, FIN: FIN as Cents, K: K! }, charges: chargesFor(withSba), minMarkupPpm: mMin!, curve, ...(delta !== undefined ? { delta } : {}), ...(caps.length || check ? { limits: { ...(caps.length ? { caps } : {}), ...(check ? { check } : {}) } } : {}) });
      if (sel === null) range = { status: 'no_bid', reason: 'no room left on your surety aggregate limit after your backlog (spec 5.8)', J: null, referenceClass: refClass! };
      else if (sel.status === 'not_enough_data') range = { status: 'not_shown', reason: sel.reason };
      else if (sel.status === 'no_bid' && cashVeto) {
        assumptions.push(...sel.assumptions);
        warnings.push(...sel.warnings);
        range = { status: 'no_bid', reason: `No bid range: ${cashVeto} (spec 5.8, 7.7)`, J: sel.J, referenceClass: sel.referenceClass };
      }
      else {
        assumptions.push(...sel.assumptions);
        warnings.push(...sel.warnings);
        if (sel.status === 'no_bid') range = { status: 'no_bid', reason: sel.reason, J: sel.J, referenceClass: sel.referenceClass };
        else {
          const pp = (x: typeof sel.recommended): PricePointOut => ({ price: x.B, markupOnCost: ratioText(x.markupExact), winProbability: { p: x.win.p, lo: x.win.lo, hi: x.win.hi, J: x.win.J }, profitIfWon: x.profitIfWon, expectedProfit: x.evCents });
          range = {
            status: 'shown', floor: sel.floor, recommended: pp(sel.recommended), low: pp(sel.low), high: pp(sel.high), contiguous: sel.contiguous,
            intervals: sel.intervals.map((i) => ({ lo: i.lo, hi: i.hi })), J: sel.J, referenceClass: sel.referenceClass, model: sel.model, delta: sel.delta,
            note: `From ${sel.J} of your own comparable lettings (${sel.referenceClass}); win chances are estimates with their band, never a promise (spec 12.1)`,
          };
        }
      }
    }
  }

  return finish({ breakdown, cashOut, limitsOut, range, FIN, dayCount, rate: includeFin ? finRate! : null });

  // ---------------------------------------------------------------- assemble
  function finish(done: null | { breakdown: BidBreakdown; cashOut: EstimateResult['cash']; limitsOut: EstimateResult['limits']; range: EstimateResult['bidRange']; FIN: number; dayCount: number | null; rate: number | null }): EstimateResult {
    const priceBlocked = needed.some((n) => n.for === 'price') || done === null;
    for (const n of needed) checks.push({ level: 'warn', text: done ? `Needed (${n.for}): ${n.field}: ${n.why}` : `Needed: ${n.field}: ${n.why}` });
    const b = done?.breakdown;
    const t = b?.totals;
    return {
      status: priceBlocked ? 'incomplete' : 'complete',
      needed,
      job: jobOut,
      total: t ? t.Pbid : null,
      price: t ? { bid: t.Pbid, P: t.P, S: t.S, charges: t.qBid, premium: t.premium, otherCharges: t.otherCharges, profitAsBid: t.profitAsBid } : null,
      totals: t ? { L: t.L, G: t.G, H: t.H, ST: t.ST, MAT: t.MAT, E: t.E, SUB: t.SUB, JOOH: t.JOOH, ESC_L: t.ESC_L, DC0: t.DC0, CONT: t.CONT, TJC: t.TJC, OH: t.OH, BE: t.BE, PR: t.PR, FIN: t.FIN, S: t.S, q: t.q, premium: t.premium, otherCharges: t.otherCharges, P: t.P, Pbid: t.Pbid, qBid: t.qBid, roundingToProfit: t.roundingToProfit, roundingToCharges: t.roundingToCharges, profitAsBid: t.profitAsBid } : null,
      breakdown: b ? b.lines.map((l) => ({ ...l, label: labelFor(l) })) : [],
      items: b?.items ? b.items.items.map((x) => ({ id: x.id, label: bidItemsReq.find((y) => y.id === x.id)?.label ?? x.id, directCost: x.directCost, indirect: x.indirect, price: x.price })) : null,
      cash: done ? done.cashOut : { status: 'not_computed', reason: 'no price yet: see needed' },
      financing: done
        ? { included: done.rate !== null, FIN: done.FIN, annualRatePpm: done.rate, dayCount: done.dayCount, note: done.rate !== null ? 'Financing cost of the cash you carry, from the cash model at the price without it (one pass, A-20: the true fixed point is slightly lower)' : 'Financing not included in the price (your choice)' }
        : { included: false, FIN: 0, annualRatePpm: null, dayCount: null, note: 'no price yet' },
      limits: done ? done.limitsOut : emptyLimits,
      bidRange: done ? done.range : { status: 'not_shown', reason: 'no price yet: see needed' },
      checks,
      sources: log.list(),
      assumptions: assumptionsReport(assumptions),
      warnings: [...new Set(warnings.map((w) => w.replace(/\bclass c(\d+)\b/g, (_, n: string) => classLabels[Number(n) - 1] ?? `class c${n}`)))],
      bidFacts,
    };
  }

  function labelFor(l: Line): string {
    // Class lines are keyed 'labor.c1.SS': show the contractor's class label instead of the id.
    const m = /^labor\.c(\d+)\./.exec(l.key);
    if (m) {
      const lbl = classLabels[Number(m[1]) - 1];
      if (lbl) return l.label.replace(/\bc\d+\b/, lbl);
    }
    return l.label;
  }
}

/** Contract 4 quick form (`laborHours`, `laborRate`, `materials`, `burdenPct`, ...) -> EstimateRequest. Missing facts surface as `needed`. */
export function fromQuickForm(body: Record<string, unknown>): { request: EstimateRequest; notes: string[] } {
  const notes: string[] = [];
  const q = (k: string) => body[k] as Dec | undefined;
  const has = (k: string) => body[k] !== undefined && body[k] !== null;
  const request: EstimateRequest = {
    job: {},
    labor: {
      ...(has('burdenPct') ? { burdenMode: 'flat' as const, flatBurdenPercent: q('burdenPct')! } : {}),
      classes: has('laborHours') ? [{ label: 'Labor', hours: q('laborHours')!, ...(has('laborRate') ? { wage: q('laborRate')! } : {}) }] : [],
    },
    ...(has('materials') ? { materials: { total: { amount: q('materials')! } } } : {}),
    ...(has('equipment') ? { equipment: [{ label: 'Equipment', amount: q('equipment')! }] } : {}),
    ...(has('subs') ? { subcontracts: [{ label: 'Subcontracts', amount: q('subs')! }] } : {}),
    markups: {
      ...(has('overheadPct') ? { overhead: { method: 'on_cost' as const, percent: q('overheadPct')! } } : {}),
      ...(has('profitPct') ? { profitPercent: q('profitPct')! } : {}),
    },
    ...(has('bondPct') ? { bond: { required: 'yes' as const, tiers: [{ upTo: null, ratePer1000: bondPctToPer1000(q('bondPct')!) }] } } : {}),
  };
  if (has('burdenPct')) notes.push('burdenPct is one flat burden percentage: an approximation (spec 2.3)');
  if (has('bondPct')) notes.push('bondPct is used as one flat bond rate on the contract price (your number, not a surety quote)');
  if (has('upfrontWeeks')) notes.push('upfrontWeeks is not used: the cash model computes the carry from the payment terms');
  if (has('zip')) notes.push('zip is not used by the cost engine: give job.state');
  return { request, notes };
}

/** "1.5" percent of price -> "15" dollars per $1,000, as exact text. */
function bondPctToPer1000(x: Dec): string {
  const t = String(x).trim();
  const m = DEC_RE.exec(t);
  if (!m) return t; // the Reader reports the bad value
  const frac = (m[2] ?? '').padEnd(1, '0');
  // multiply by 10: shift the decimal point one place right
  const whole = m[1]! + frac[0]!;
  const rest = frac.slice(1);
  return rest ? `${BigInt(whole)}.${rest}` : `${BigInt(whole)}`;
}

/** Map an unknown thrown value to a 400 body, or null when it is a bug (500). */
export function estimateErrorBody(e: unknown): { error: 'invalid_input'; message: string; code: string; fields?: readonly FieldError[] } | null {
  if (e instanceof EstimateInputError) return { error: 'invalid_input', message: 'Some fields need fixing', code: e.code, fields: e.fields };
  if (e instanceof CostEngineError) return { error: 'invalid_input', message: e.message, code: e.code };
  if (e instanceof RangeError) return { error: 'invalid_input', message: e.message, code: 'RANGE' };
  return null;
}

