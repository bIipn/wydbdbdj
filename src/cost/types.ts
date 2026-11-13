// Input and output types of the cost engine (spec section 1), with units in names or doc comments
// and who supplies each input:
//   [C] contractor (takeoff, quotes, policies, notices)   [D] bid documents for this job
//   [P] dated public table shipped with the engine (spec 8) — passed IN as typed, dated tables
//   [A] labelled assumption (spec 9), editable, always surfaced in the output's `assumptions` list
// Guard ranges are engine guards (design choices), enforced by the validate…() functions below.

import {
  refuse,
  assertCents,
  assertPpm,
  assertHours,
  assertInt,
  isoDate,
  type Cents,
  type Ppm,
  type HoursC,
  type QtyM,
  type MicroHours,
  type IsoDate,
  type RoundingMode,
} from './money.js';

// ---------------------------------------------------------------- rate base tags (spec 0.4)

export type BaseTag =
  | 'on_cost' // total job cost TJC (overhead) or TJC + OH (profit)
  | 'on_sales' // the price before price-based charges (revenue basis)
  | 'on_labor_cost' // direct labor dollars (state which: G or L)
  | 'per_labor_hour' // job labor hours
  | 'on_taxable_wages' // taxable cash wages G
  | 'per_100_payroll' // workers' compensation payroll
  | 'per_1000_receipts' // contract price including the charge itself
  | 'on_price'; // same as per_1000_receipts

export const BASE_TAGS: readonly BaseTag[] = [
  'on_cost',
  'on_sales',
  'on_labor_cost',
  'per_labor_hour',
  'on_taxable_wages',
  'per_100_payroll',
  'per_1000_receipts',
  'on_price',
];

/** A rate that always carries its base (spec 0.4: a rate without a base tag is rejected). */
export interface TaggedRate<B extends BaseTag = BaseTag> {
  readonly ppm: Ppm;
  readonly base: B;
}

/** Runtime check for callers from plain JS: missing or wrong base tag -> RangeError (invariant 10). */
export function requireBase<B extends BaseTag>(rate: unknown, allowed: readonly B[], what: string): TaggedRate<B> {
  if (!rate || typeof rate !== 'object') refuse('MISSING_RATE', `${what}: rate missing`);
  const r = rate as { ppm?: unknown; base?: unknown };
  if (typeof r.base !== 'string' || !(BASE_TAGS as readonly string[]).includes(r.base))
    refuse('MISSING_BASE_TAG', `${what}: rate has no valid base tag`);
  if (!(allowed as readonly string[]).includes(r.base))
    refuse('WRONG_BASE_TAG', `${what}: base '${r.base}' not allowed here (expected ${allowed.join(' | ')})`);
  assertPpm(r.ppm as number, what);
  return rate as TaggedRate<B>;
}

// ---------------------------------------------------------------- provenance and assumptions

export type Supplier = 'contractor' | 'bid_documents' | 'public_table' | 'assumption';

/** A section 9 assumption the engine used. Shown to the user as an assumption, never as a fact. */
export interface AssumptionUsed {
  readonly id: string; // 'A-8', 'A-17', 'A-18', 'A-19', ...
  readonly text: string;
  readonly value: string;
}

// ---------------------------------------------------------------- dated public tables (spec 1.3, section 8)

/** Federal and state payroll tax figures for ONE calendar year and ONE state. [P], dated, sourced. */
export interface PayrollTaxTable {
  readonly year: number;
  readonly state: string; // 'NV', 'CA', ...
  readonly sources: readonly string[]; // URLs (spec 8 rows)
  readonly effective: string; // human-readable effective period
  readonly socialSecurity: { readonly ratePpm: Ppm; readonly wageBase: Cents }; // D-1, D-2
  readonly medicare: { readonly ratePpm: Ppm }; // D-3 (Additional Medicare is employee-only: never here)
  readonly futa: {
    readonly netRatePpm: Ppm; // 6.0% - 5.4% credit (D-4)
    readonly wageBase: Cents;
    /** Credit reduction CR[state][year] (D-5). null = not published: the contractor must enter it (A-9). */
    readonly creditReductionPpm: Ppm | null;
    readonly creditReductionFinal: boolean; // false -> warning (A-9)
  };
  readonly stateUnemployment: {
    readonly wageBase: Cents; // D-6 / D-10
    readonly ratePpmMin: Ppm; // guard on the contractor's notice rate (spec 1.3)
    readonly ratePpmMax: Ppm;
    /** Employer surcharge added to the UI rate: Nevada CEP (D-8), California ETT (D-11). */
    readonly surchargePpm: Ppm;
    readonly surchargeLabel: string;
    /** Surcharge not owed at exactly this UI rate (Nevada: 54_000, D-8); null when always owed. */
    readonly surchargeExemptAtRatePpm: Ppm | null;
  };
  /** Nevada Modified Business Tax (D-9); absent where no such tax. */
  readonly mbt?: { readonly ratePpm: Ppm; readonly quarterlyExemptWages: Cents };
}

// ---------------------------------------------------------------- labor (spec 1.2, 2.1, 2.2)

export type OtRegime = 'FLSA' | 'NV_PRIVATE' | 'NV_PUBLIC' | 'CA_PRIVATE' | 'CA_PUBLIC' | 'DAVIS_BACON';
export const OT_REGIMES: readonly OtRegime[] = ['FLSA', 'NV_PRIVATE', 'NV_PUBLIC', 'CA_PRIVATE', 'CA_PUBLIC', 'DAVIS_BACON'];

/** One task of the takeoff [C]. Hours = Q * u * pf (spec 2.1). */
export interface LaborTask {
  readonly id: string;
  readonly quantity: QtyM; // Q, thousandths of a unit, >= 0
  readonly laborUnit: MicroHours; // u, millionths of an hour per unit, > 0
  /** pf, 500_000..5_000_000; >= 1_000_000 means worse than normal. Omitted -> 1.00 (A-31). */
  readonly productivityPpm?: Ppm;
  readonly productivityReason?: string;
  /** Crew mix: class id -> head count (>= 0, not all zero). */
  readonly crew: Readonly<Record<string, number>>;
}

/** Bona fide plan, for the prevailing-wage plan credit (spec 2.2). [C] */
export interface PlanCreditInput {
  readonly label: string;
  /** false for plans the rules except from annualization (D-20, D-31). */
  readonly annualize: boolean;
  /** Employer contribution per hour worked on this job, cents/h. Used when annualize = false. */
  readonly ratePerHour: Cents;
  /** Annual plan cost for the worker and all hours worked that year (public and private). annualize = true only. */
  readonly annualCost?: Cents;
  readonly annualHours?: HoursC;
}

/** Wage determination for a class [D] plus how the contractor meets it [C]. */
export interface PrevailingWageInput {
  readonly bhrWd: Cents; // basic hourly rate on the determination, > 0
  readonly fbWd: Cents; // fringe benefit rate on the determination, >= 0
  /** Plans for the plan credit; omitted -> plan credit = fPlan (no annualization). */
  readonly plans?: readonly PlanCreditInput[];
  /** Davis-Bacon: basicRate = w_tax instead of max(BHR_wd, w_basic) (spec 2.2). */
  readonly cashInLieuCountsAsBasic?: boolean;
}

/** One labor class (journeyman, apprentice, ...). All money per hour is cents/h. */
export interface LaborClassInput {
  readonly id: string;
  readonly label?: string;
  /** Straight, 1.5x and 2x bucket hours (HoursC, 0..10_000_000 each). */
  readonly h10: HoursC;
  readonly h15: HoursC;
  readonly h20: HoursC;
  readonly wBasic: Cents; // cash basic wage actually paid, > 0 [C]
  readonly wCil: Cents; // fringe paid as cash in lieu (taxable wages), >= 0 [C]
  readonly fPlan: Cents; // employer contributions to bona fide plans, >= 0 [C]
  readonly fHealth: Cents; // of which health, 0 <= fHealth <= fPlan [C]
  readonly travelPerHour: Cents; // T: travel / subsistence, >= 0 [C]
  readonly otherPerHour: Cents; // other_h: paid time off, training fund, vehicle, >= 0 [C]
  /** W: expected annual taxable wages of a representative worker, > 0. Omitted -> A-8. [C/A] */
  readonly annualTaxableWages?: Cents;
  /** W_wc: the worker's annual workers' comp payroll for the Nevada cap. Omitted -> W. [C] */
  readonly wcAnnualPayroll?: Cents;
  /** Y: wages paid this year before this job (burden mode 'ytd' only). [C] */
  readonly ytdWagesBefore?: Cents;
  /** Calendar year the wages are paid: selects the payroll table (spec 2.3). [C/D] */
  readonly taxYear: number;
  /** Workers' comp rate for this class from the contractor's policy, per $100 of payroll as ppm (A-11: no default). */
  readonly wcRatePpm: Ppm;
  /** 2x hourly pay per the wage determination's footnotes (needed for h20 outside CA_PRIVATE). [D] */
  readonly pay20?: Cents;
  readonly prevailing?: PrevailingWageInput;
  /** true when these wages are already priced at a known future rate: no labor escalation (spec 2.10). */
  readonly wageScheduled?: boolean;
}

export type BurdenMode = 'statutory' | 'ytd' | 'flat';

export interface MbtInput {
  readonly mode: 'none' | 'marginal' | 'average';
  readonly quarterlyGrossWages: Cents; // GW_q, firm-level [C]
  readonly quarterlyHealthDeduction: Cents; // HC_q [C]
}

export interface WorkersCompInput {
  readonly xModPpm: Ppm; // experience modification, 1.00 = 1_000_000, > 0 [C]
  /** Product of other policy modifiers, 1.00 = 1_000_000 (identity when none). [C] */
  readonly otherModsPpm: Ppm;
  /** Nevada: false (D-13). Elsewhere the policy decides (A-12). [C/P] */
  readonly excludeOtPremium: boolean;
  /** Nevada per-employee payroll cap by policy date (D-12); null where no cap. [P] */
  readonly payrollCap: Cents | null;
}

export interface LaborInput {
  readonly regime: OtRegime;
  readonly stateOfWork: string; // 'NV', 'CA', other [D]
  readonly burdenMode: BurdenMode; // default 'statutory' is the caller's choice; required here
  readonly classes: readonly LaborClassInput[];
  /** Payroll tables keyed by year (statutory and ytd modes). [P] */
  readonly payrollTables?: Readonly<Record<number, PayrollTaxTable>>;
  /** State UI rate from the contractor's rate notice (or the labelled new-employer default) [C]. */
  readonly stateUiRatePpm?: Ppm;
  /** FUTA credit reduction entered by the contractor when the table has none (A-9). */
  readonly futaCreditReductionPpm?: Ppm;
  readonly mbt?: MbtInput;
  readonly workersComp: WorkersCompInput;
  /** Payroll-rated general liability [C]; receipts-rated GL is a price-based charge instead. */
  readonly generalLiabilityPayrollPpm?: Ppm;
  /** Flat-mode burden on taxable wages, 0..2_000_000 (flat mode only). [C] */
  readonly flatBurdenPpm?: Ppm;
  readonly roundingMode?: RoundingMode;
}

// ---------------------------------------------------------------- materials (spec 1.4, 2.6)

export interface MaterialLine {
  readonly id: string;
  readonly quantity: QtyM; // q
  readonly unitPrice: Cents; // per unit, from the quote [C]
  readonly wastePpm: Ppm; // 0..500_000
  readonly taxable?: boolean; // default true
  readonly quotedOn?: IsoDate;
  readonly holdThrough?: IsoDate;
  readonly purchaseDate?: IsoDate;
  readonly ppiSeriesId?: string;
  /** e_i from spec 6.2 (computed by the time module and stored with the line). Omitted -> 0. */
  readonly escalationPpm?: Ppm;
}

export interface MaterialsInput {
  readonly lines: readonly MaterialLine[];
  readonly freight: Cents; // FRT, freight not included in quotes [C]
  /** Freight taxability is state-specific and unverified: omitted -> false (A-17). */
  readonly freightTaxable?: boolean;
  readonly salesTaxPpm: Ppm; // s, combined rate at the taxing location, 0..150_000. No default (A-14).
  readonly taxBasis?: 'total' | 'line'; // default 'total'
  /** Optional hook: supplies e_i per line (spec 6.2). Must be pure. Overrides line.escalationPpm. */
  readonly escalation?: (line: MaterialLine, index: number) => Ppm;
}

// ---------------------------------------------------------------- equipment, subs, job overhead (spec 1.5)

export type EquipmentLine =
  | { readonly id: string; readonly kind: 'hourly'; readonly hours: HoursC; readonly rate: Cents }
  | { readonly id: string; readonly kind: 'lump'; readonly amount: Cents }; // rental incl. fuel

export interface SubcontractQuote {
  readonly id: string;
  readonly amount: Cents; // the sub's full price
}

export type JobOverheadItem =
  | { readonly id: string; readonly kind: 'monthly'; readonly months: QtyM; readonly monthlyCost: Cents }
  | { readonly id: string; readonly kind: 'hours'; readonly hours: HoursC; readonly rate: Cents }
  | { readonly id: string; readonly kind: 'once'; readonly amount: Cents };

// ---------------------------------------------------------------- markups (spec 1.6, 2.11, 2.12)

/** Home-office overhead by one of the five methods (spec 2.11). No default rate (A-7). */
export type OverheadInput =
  | { readonly method: 'on_cost'; readonly rate: TaggedRate<'on_cost'> }
  | { readonly method: 'on_cost'; readonly annual: { readonly overhead: Cents; readonly directCost: Cents } }
  | { readonly method: 'on_sales'; readonly rate: TaggedRate<'on_sales'>; readonly profit: TaggedRate<'on_sales'> }
  | { readonly method: 'per_labor_hour'; readonly centsPerHour: Cents }
  | { readonly method: 'per_labor_hour'; readonly annual: { readonly overhead: Cents; readonly laborHours: HoursC } }
  | { readonly method: 'on_labor_cost'; readonly measure: 'L' | 'G'; readonly rate: TaggedRate<'on_labor_cost'> }
  | {
      readonly method: 'on_labor_cost';
      readonly measure: 'L' | 'G';
      readonly annual: { readonly overhead: Cents; readonly directLabor: Cents };
    }
  | { readonly method: 'dual'; readonly rateL: TaggedRate<'on_labor_cost'>; readonly rateM: TaggedRate<'on_cost'> }
  | {
      readonly method: 'dual';
      readonly annual: { readonly overhead: Cents; readonly labor: Cents; readonly nonLabor: Cents };
      readonly weightXPpm: Ppm; // X > 1 (A-38)
    };

/** Profit on cost + overhead (p_c). For method 'on_sales' the profit is set by m_s in OverheadInput. */
export type ProfitInput = { readonly rate: TaggedRate<'on_cost'> } | { readonly fromOverheadOnSales: true };

/** Financing line (spec 2.12). FIN is computed by the cash module (spec 5.6) at the price without FIN. */
export type FinancingInput =
  | { readonly include: false }
  | { readonly include: true; readonly amount: Cents }
  | {
      readonly include: true;
      /** Pure function: S without FIN and its grossed-up price -> financing cost. One pass (A-20). */
      readonly compute: (priceBeforeChargesWithoutFin: Cents, grossedUpPriceWithoutFin: Cents) => Cents;
    };

// ---------------------------------------------------------------- price-based charges (spec 1.7, 2.13)

/** One marginal tier: rate per $1,000 as ppm on the slice up to upperBound (null = infinity, last only). */
export interface BondTier {
  readonly upperBound: Cents | null;
  readonly ratePpm: Ppm; // $25.00 per $1,000 = 25_000
}

export interface PriceChargesInput {
  /** Bond schedule from the surety [C], or the labelled illustrative sample (A-1). Empty = no bond. */
  readonly tiers: readonly BondTier[];
  /** Duration multiplier m_dur in ppm (1.00 = 1_000_000); see durationMultiplierPpm(). */
  readonly mDurPpm: Ppm;
  /** Fees proportional to price (receipts-rated GL, SBA fee, gross-receipts tax). */
  readonly fees: readonly { readonly label: string; readonly rate: TaggedRate<'on_price' | 'per_1000_receipts'> }[];
  /**
   * 'auto' bond (spec 2.13 last bullet): given P without bond tiers, returns whether the bond is required
   * (section 4.2 thresholds live in the bonds module). Omitted -> tiers apply as given.
   */
  readonly bondRequiredAuto?: (priceWithoutBond: Cents) => boolean;
}

// ---------------------------------------------------------------- bid items (spec 1.1, 2.15)

export interface BidItem {
  readonly id: string;
  readonly directCost: Cents;
}

// ---------------------------------------------------------------- the whole build-up input

export interface BidInput {
  readonly labor: LaborInput;
  /** st on burdened labor L, 0..200_000. Omitted -> 2% (A-18, D-66), labelled. */
  readonly smallToolsPpm?: Ppm;
  readonly materials: MaterialsInput;
  readonly equipment: readonly EquipmentLine[];
  readonly subcontracts: readonly SubcontractQuote[];
  readonly jobOverhead: readonly JobOverheadItem[];
  /** e_L on wages not already priced at a known future rate. Omitted -> 0 (no escalation line). */
  readonly laborEscalationPpm?: Ppm;
  /** c on DC0, 0..500_000. Omitted -> 0 (A-19), labelled. */
  readonly contingencyPpm?: Ppm;
  readonly overhead: OverheadInput;
  readonly profit: ProfitInput;
  readonly financing: FinancingInput;
  readonly charges: PriceChargesInput;
  /** Optional upward bid rounding unit in cents (1, 100, 10_000, ...). */
  readonly bidRoundingUnit?: Cents;
  readonly bidItems?: readonly BidItem[];
  /** Job dates, only used to warn when wages span a year end (spec 2.3). */
  readonly startDate?: IsoDate;
  readonly endDate?: IsoDate;
}

// ---------------------------------------------------------------- output: lines that show the work

/** Where a line was rounded (spec 0.3). */
export type RoundingPoint =
  | 'once-half-up' // one divRoundHalfUp at this line
  | 'sum-of-rounded' // a total: exact sum of already-rounded lines, never re-rounded
  | 'exact' // integer arithmetic, no rounding needed (lump sums, differences)
  | 'fixed-point' // the price-based charge fixed point (spec 2.13)
  | 'ceil-to-unit' // optional bid rounding (spec 2.14)
  | 'largest-remainder'; // allocation (spec 2.15)

/** One line of the breakdown. Every line names its formula, its base and its rounding point. */
export interface Line {
  readonly key: string; // stable machine key, e.g. 'labor.journeyman.SS'
  readonly label: string; // short human label
  readonly amount: Cents;
  readonly formula: string; // spec id + formula text, e.g. '2.3 SS_k = G_k*rate*min(W,SSB)/W'
  readonly base?: { readonly name: string; readonly amount: number; readonly unit: 'cents' | 'hoursC' | 'qtyM' };
  readonly rate?: { readonly value: number; readonly unit: 'ppm' | 'cents/h' | 'cents/unit' | 'half-cents/h' };
  readonly rounding: RoundingPoint;
  readonly assumption?: string; // 'A-18' etc. when the line uses a section 9 value
}

// ---------------------------------------------------------------- validation (spec 1 guard ranges)

const MAX_BUCKET_HOURS = 10_000_000; // spec 1.2 guard 0..10,000,000 HoursC

export function validateLaborClass(c: LaborClassInput, regime: OtRegime): void {
  const w = `class ${c.id}`;
  if (!c.id) refuse('BAD_INPUT', 'labor class needs an id');
  assertHours(c.h10, `${w} h10`, MAX_BUCKET_HOURS);
  assertHours(c.h15, `${w} h15`, MAX_BUCKET_HOURS);
  assertHours(c.h20, `${w} h20`, MAX_BUCKET_HOURS);
  assertCents(c.wBasic, `${w} w_basic`);
  if (c.wBasic <= 0) refuse('OUT_OF_RANGE', `${w}: w_basic must be > 0`);
  assertCents(c.wCil, `${w} w_cil`);
  assertCents(c.fPlan, `${w} f_plan`);
  assertCents(c.fHealth, `${w} f_health`);
  if (c.fHealth > c.fPlan) refuse('OUT_OF_RANGE', `${w}: f_health must not exceed f_plan`);
  assertCents(c.travelPerHour, `${w} T`);
  assertCents(c.otherPerHour, `${w} other_h`);
  if (c.annualTaxableWages !== undefined) {
    assertCents(c.annualTaxableWages, `${w} W`);
    if (c.annualTaxableWages <= 0) refuse('OUT_OF_RANGE', `${w}: W must be > 0`);
  }
  if (c.wcAnnualPayroll !== undefined) {
    assertCents(c.wcAnnualPayroll, `${w} W_wc`);
    if (c.wcAnnualPayroll <= 0) refuse('OUT_OF_RANGE', `${w}: W_wc must be > 0`);
  }
  if (c.ytdWagesBefore !== undefined) assertCents(c.ytdWagesBefore, `${w} ytd wages`);
  assertInt(c.taxYear, `${w} taxYear`, 1900, 2200);
  assertPpm(c.wcRatePpm, `${w} workers' comp rate`, 0, 1_000_000);
  if (c.pay20 !== undefined) assertCents(c.pay20, `${w} pay_20`);
  if (c.prevailing) {
    assertCents(c.prevailing.bhrWd, `${w} BHR_wd`);
    if (c.prevailing.bhrWd <= 0) refuse('OUT_OF_RANGE', `${w}: BHR_wd must be > 0`);
    assertCents(c.prevailing.fbWd, `${w} FB_wd`);
    for (const p of c.prevailing.plans ?? []) {
      assertCents(p.ratePerHour, `${w} plan ${p.label} rate`);
      if (p.annualize) {
        if (p.annualCost === undefined || p.annualHours === undefined)
          refuse('MISSING_INPUT', `${w} plan ${p.label}: annualized plan needs annualCost and annualHours`);
        assertCents(p.annualCost, `${w} plan annual cost`);
        assertHours(p.annualHours, `${w} plan annual hours`);
        if (p.annualHours <= 0) refuse('BAD_DIVISOR', `${w} plan ${p.label}: annualHours must be > 0`);
      }
    }
  } else if (regime === 'NV_PUBLIC' || regime === 'CA_PUBLIC' || regime === 'DAVIS_BACON') {
    refuse('MISSING_INPUT', `${w}: regime ${regime} needs the wage determination (prevailing.bhrWd, fbWd)`);
  }
}

export function validateTask(t: LaborTask): void {
  assertInt(t.quantity, `task ${t.id} quantity`);
  assertInt(t.laborUnit, `task ${t.id} labor unit`, 1);
  if (t.productivityPpm !== undefined) assertPpm(t.productivityPpm, `task ${t.id} pf`, 500_000, 5_000_000);
  const counts = Object.values(t.crew);
  if (counts.length === 0) refuse('NO_WEIGHTS', `task ${t.id}: crew mix is empty`);
  counts.forEach((n) => assertInt(n, `task ${t.id} crew count`));
  if (counts.every((n) => n === 0)) refuse('ZERO_WEIGHTS', `task ${t.id}: crew mix is all zero`);
}

export function validateMaterialLine(l: MaterialLine): void {
  assertInt(l.quantity, `material ${l.id} quantity`);
  assertCents(l.unitPrice, `material ${l.id} unit price`);
  assertPpm(l.wastePpm, `material ${l.id} waste`, 0, 500_000);
  if (l.escalationPpm !== undefined) assertPpm(l.escalationPpm, `material ${l.id} escalation`);
  for (const d of [l.quotedOn, l.holdThrough, l.purchaseDate]) if (d !== undefined) isoDate(d);
}

export function validatePayrollTable(t: PayrollTaxTable): void {
  assertInt(t.year, 'table year', 1900, 2200);
  if (!t.sources.length) refuse('MISSING_SOURCE', `payroll table ${t.state} ${t.year} has no source`);
  assertPpm(t.socialSecurity.ratePpm, 'SS rate', 0, 1_000_000);
  assertCents(t.socialSecurity.wageBase, 'SS wage base');
  assertPpm(t.medicare.ratePpm, 'Medicare rate', 0, 1_000_000);
  assertPpm(t.futa.netRatePpm, 'FUTA net rate', 0, 1_000_000);
  assertCents(t.futa.wageBase, 'FUTA wage base');
  if (t.futa.creditReductionPpm !== null) assertPpm(t.futa.creditReductionPpm, 'FUTA credit reduction', 0, 60_000);
  const s = t.stateUnemployment;
  assertCents(s.wageBase, 'state UI wage base');
  assertPpm(s.ratePpmMin, 'UI rate min');
  assertPpm(s.ratePpmMax, 'UI rate max');
  if (s.ratePpmMin > s.ratePpmMax) refuse('OUT_OF_RANGE', 'UI rate min > max');
  assertPpm(s.surchargePpm, 'UI surcharge');
  if (t.mbt) {
    assertPpm(t.mbt.ratePpm, 'MBT rate', 0, 1_000_000);
    assertCents(t.mbt.quarterlyExemptWages, 'MBT exempt wages');
  }
}
