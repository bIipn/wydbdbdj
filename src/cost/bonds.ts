// Bonds and bid security (spec 4.1 to 4.4).
//
// Jurisdiction rules are law, so none of their numbers live here: thresholds, percentages, caps
// and switch-over dates come in as dated tables (the defaults module ships the spec 8.4 values;
// tests carry them with source URLs). A value read from the bid documents overrides every preset.
// Pure functions, integer cents, BigInt intermediates, one half-up rounding per stated point.

import {
  assertCents,
  assertInt,
  assertPpm,
  compareDates,
  divRoundHalfUp,
  isoDate,
  mulRate,
  ratio,
  refuse,
  toCents,
  type Cents,
  type IsoDate,
  type Ppm,
  type Ratio,
} from './money.js';
import type { AssumptionUsed, PriceChargesInput } from './types.js';
import { chargeSplit } from './buildup.js';

const M6 = 1_000_000n;

// ---------------------------------------------------------------- dated tables (types only)

/** Where a legal figure came from. Every table row carries one. */
export interface LegalSource {
  readonly citation: string; // 'FAR 28.101-2', 'NRS 339.025'
  readonly url: string;
  readonly effective: string; // 'current FAR', '2025 NRS', a date
}

// ---------------------------------------------------------------- spec 4.1 bid security

/** One owner's bid-security rule (spec 4.1 table). */
export interface BidSecurityRule {
  readonly id: string;
  /** Minimum p_bid on B_basis. */
  readonly pctPpm: Ppm;
  /** FLOOR in cents (0 when the rule has none). */
  readonly floor: Cents;
  /** CAP in cents, null = none. */
  readonly cap: Cents | null;
  /** What B_basis is: the bid price, base bid plus all alternates, or the amount bid. */
  readonly basis: 'bid_price' | 'base_plus_alternates' | 'amount_bid';
  /** Strict trigger: required only for bids in excess of this amount. null = every bid. */
  readonly requiredAbove: Cents | null;
  /** Federal: only when a performance bond is also required (FAR 28.101). */
  readonly onlyWithPerformanceBond: boolean;
  readonly source: LegalSource;
}

/** Is bid security required? The bid documents (when they say) override the rule. */
export function bidSecurityRequired(
  rule: BidSecurityRule,
  bid: Cents,
  performanceBondRequired: boolean,
  bidDocumentsSay?: boolean,
): boolean {
  assertCents(bid, 'bid');
  if (bidDocumentsSay !== undefined) return bidDocumentsSay;
  if (rule.onlyWithPerformanceBond && !performanceBondRequired) return false;
  return rule.requiredAbove === null || bid > rule.requiredAbove; // strict, spec 4.2 convention
}

/** S_bid = required ? min(CAP, max(FLOOR, mulRate(B_basis, p_bid))) : 0 (spec 4.1). */
export function bidSecurity(rule: BidSecurityRule, basisAmount: Cents, required: boolean): Cents {
  assertCents(basisAmount, 'B_basis');
  assertPpm(rule.pctPpm, 'p_bid', 0, 1_000_000);
  assertCents(rule.floor, 'bid security floor');
  if (rule.cap !== null) {
    assertCents(rule.cap, 'bid security cap');
    if (rule.cap < rule.floor) refuse('BAD_TABLE', 'bid security cap is below its floor');
  }
  if (!required) return 0 as Cents;
  const s = Math.max(rule.floor, mulRate(basisAmount, rule.pctPpm));
  return (rule.cap === null ? s : Math.min(rule.cap, s)) as Cents;
}

/** A-2: a bid bond costs nothing unless the contractor enters a premium. */
export const A2_BID_BOND_PREMIUM: AssumptionUsed = {
  id: 'A-2',
  text: 'A bid bond costs nothing; one premium covers both the performance and the payment bond',
  value: '0',
};

/**
 * Cost_bidsec = bidBondPremium + (form == cash ? S_bid * i * d_hold / basis : 0), rounded once (spec 4.1).
 * The spec writes /365; the day-count basis is an explicit input (365 per spec 4.1, 360 if the lender says so).
 */
export function bidSecurityCost(args: {
  readonly sBid: Cents;
  readonly form: 'bond' | 'cash';
  /** Contractor-entered; omitted -> 0 under A-2 (surfaced). */
  readonly bidBondPremium?: Cents;
  /** Annual rate on the cash tied up, ppm. Needed for form 'cash'. */
  readonly annualRatePpm?: Ppm;
  readonly holdDays?: number;
  readonly dayCountBasis?: 360 | 365;
}): { cost: Cents; premium: Cents; carry: Cents; assumptions: AssumptionUsed[] } {
  assertCents(args.sBid, 'S_bid');
  const assumptions: AssumptionUsed[] = [];
  let premium = 0 as Cents;
  if (args.form === 'bond') {
    if (args.bidBondPremium === undefined) assumptions.push(A2_BID_BOND_PREMIUM);
    else premium = assertCents(args.bidBondPremium, 'bid bond premium');
  } else if (args.bidBondPremium !== undefined) refuse('BAD_INPUT', 'a cash bid security has no bond premium');
  let carry = 0 as Cents;
  if (args.form === 'cash') {
    if (args.annualRatePpm === undefined || args.holdDays === undefined || args.dayCountBasis === undefined)
      refuse('MISSING_INPUT', 'cash bid security needs annualRatePpm, holdDays and dayCountBasis');
    assertPpm(args.annualRatePpm, 'i', 0, 1_000_000);
    assertInt(args.holdDays, 'd_hold');
    if (args.dayCountBasis !== 360 && args.dayCountBasis !== 365) refuse('OUT_OF_RANGE', 'day-count basis must be 360 or 365');
    carry = toCents(
      divRoundHalfUp(BigInt(args.sBid) * BigInt(args.annualRatePpm) * BigInt(args.holdDays), M6 * BigInt(args.dayCountBasis)),
      'cash bid security carry',
    );
  }
  return { cost: toCents(BigInt(premium) + BigInt(carry), 'bid security cost'), premium, carry, assumptions };
}

/** Which exposure rule the bid form uses (spec 4.1). Nevada and California forms: input, A-40 suggests 'difference'. */
export type WalkAwayRule = 'federal' | 'difference' | 'forfeiture';

export const A40_BID_SECURITY_RULE: AssumptionUsed = {
  id: 'A-40',
  text: 'Bid-security rule on Nevada and California bid forms (not checked)',
  value: 'difference',
};

/**
 * Exposure if awarded and the bidder walks away (spec 4.1):
 * federal max(0, B_next - B) (not capped at S_bid); difference min(S_bid, max(0, B_next - B)); forfeiture S_bid.
 */
export function walkAwayExposure(rule: WalkAwayRule, sBid: Cents, bid: Cents, nextBid: Cents): Cents {
  assertCents(sBid, 'S_bid');
  assertCents(bid, 'B');
  assertCents(nextBid, 'B_next');
  const gap = Math.max(0, nextBid - bid);
  switch (rule) {
    case 'federal':
      return gap as Cents;
    case 'difference':
      return Math.min(sBid, gap) as Cents;
    case 'forfeiture':
      return sBid;
    default:
      return refuse('BAD_INPUT', `unknown walk-away rule ${String(rule)}`);
  }
}

// ---------------------------------------------------------------- spec 4.2 performance and payment bonds

/** A bond percentage in a band: a statutory figure, one the bid documents must fix, or none. */
export type BondPct =
  | { readonly kind: 'none' }
  /** ppm of C; minimum = the statute says "not less than" (the contracting body may require more). */
  | { readonly kind: 'pct'; readonly ppm: Ppm; readonly minimum: boolean }
  /** e.g. California local performance bond: amount from the bid documents. */
  | { readonly kind: 'from_bid_documents' }
  /** Federal $35,000 < C <= $150,000: payment bond OR alternative protection, chosen by the contracting officer. */
  | { readonly kind: 'officer_choice'; readonly ppm: Ppm };

/** One band of a bond-requirement table. Trigger is strict: C > above (spec 4.2). */
export interface BondBand {
  /** null = every contract (NDOT). */
  readonly above: Cents | null;
  /** Inclusive upper end of the band; null = no upper end. */
  readonly atMost: Cents | null;
  readonly performance: BondPct;
  readonly payment: BondPct;
  readonly label: string;
}

/** A dated bond-requirement table for one owner type (spec 4.2, D-32 .. D-36, D-40). */
export interface BondRequirementTable {
  readonly id: string;
  readonly bands: readonly BondBand[];
  readonly source: LegalSource;
}

export type BondNeed = 'required' | 'none' | 'officer_choice' | 'from_bid_documents';

export interface BondSide {
  readonly need: BondNeed;
  /** Penal percentage in ppm when known; null when the bid documents fix it. */
  readonly ppm: Ppm | null;
  /** penal = pct * C (cents, rounded once) when known. */
  readonly penal: Cents | null;
  readonly statutoryMinimum: boolean;
}

export interface BondRequirement {
  readonly table: string;
  readonly band: string | null;
  readonly performance: BondSide;
  readonly payment: BondSide;
  /** Is any surety bond needed (so a premium is owed, A-2)? 'officer_choice' is left to the caller. */
  readonly anyBond: 'yes' | 'no' | 'officer_choice';
  readonly overriddenByBidDocuments: boolean;
  readonly source: LegalSource;
}

function validateBondTable(t: BondRequirementTable): void {
  t.bands.forEach((b, i) => {
    if (b.above !== null) assertCents(b.above, `band ${i} threshold`);
    if (b.atMost !== null) {
      assertCents(b.atMost, `band ${i} upper end`);
      if (b.above !== null && b.atMost <= b.above) refuse('BAD_TABLE', `band ${i}: upper end must exceed the threshold`);
    }
    for (const s of [b.performance, b.payment]) if (s.kind === 'pct' || s.kind === 'officer_choice') assertPpm(s.ppm, `band ${i} pct`, 0, 1_000_000);
  });
}

function side(pct: BondPct, C: Cents): BondSide {
  switch (pct.kind) {
    case 'none':
      return { need: 'none', ppm: null, penal: null, statutoryMinimum: false };
    case 'pct':
      return { need: 'required', ppm: pct.ppm, penal: mulRate(C, pct.ppm), statutoryMinimum: pct.minimum };
    case 'officer_choice':
      return { need: 'officer_choice', ppm: pct.ppm, penal: mulRate(C, pct.ppm), statutoryMinimum: false };
    case 'from_bid_documents':
      return { need: 'from_bid_documents', ppm: null, penal: null, statutoryMinimum: false };
  }
}

/**
 * penal = pct * C if C > threshold, else 0 (spec 4.2). Comparisons are strict: exactly the threshold
 * does not trigger; one cent more does (invariant 61). The bid documents override the table.
 */
export function bondRequirement(
  table: BondRequirementTable,
  C: Cents,
  bidDocuments?: { readonly performancePpm?: Ppm | null; readonly paymentPpm?: Ppm | null },
): BondRequirement {
  assertCents(C, 'contract price C');
  validateBondTable(table);
  const band = table.bands.find((b) => (b.above === null || C > b.above) && (b.atMost === null || C <= b.atMost)) ?? null;
  let performance = band ? side(band.performance, C) : side({ kind: 'none' }, C);
  let payment = band ? side(band.payment, C) : side({ kind: 'none' }, C);
  let overridden = false;
  if (bidDocuments) {
    const fromDocs = (v: Ppm | null): BondSide =>
      v === null || v === 0
        ? { need: 'none', ppm: null, penal: null, statutoryMinimum: false }
        : { need: 'required', ppm: assertPpm(v, 'bid-document bond pct', 0, 1_000_000), penal: mulRate(C, v), statutoryMinimum: false };
    if (bidDocuments.performancePpm !== undefined) {
      performance = fromDocs(bidDocuments.performancePpm);
      overridden = true;
    }
    if (bidDocuments.paymentPpm !== undefined) {
      payment = fromDocs(bidDocuments.paymentPpm);
      overridden = true;
    }
  }
  const needs = [performance.need, payment.need];
  const anyBond = needs.some((n) => n === 'required' || n === 'from_bid_documents')
    ? 'yes'
    : needs.includes('officer_choice')
      ? 'officer_choice'
      : 'no';
  return { table: table.id, band: band?.label ?? null, performance, payment, anyBond, overriddenByBidDocuments: overridden, source: table.source };
}

/**
 * The hook buildBid's charges.bondRequiredAuto expects (spec 2.13 last bullet): P_nobond -> bond needed?
 * The federal officer-choice band is not decided here: the caller states how to treat it.
 */
export function bondRequiredAutoHook(table: BondRequirementTable, officerChoiceMeansBond: boolean): (priceWithoutBond: Cents) => boolean {
  validateBondTable(table);
  return (P: Cents) => {
    const r = bondRequirement(table, P);
    return r.anyBond === 'yes' || (r.anyBond === 'officer_choice' && officerChoiceMeansBond);
  };
}

// ---------------------------------------------------------------- spec 4.3 premium

/** A-6: part months in the duration surcharge are whole months rounded up. */
export const A6_PART_MONTHS: AssumptionUsed = { id: 'A-6', text: 'Part months in the bond duration surcharge', value: 'whole months, rounded up' };

/**
 * Contract duration Mo in whole calendar months, part months rounded up (A-6).
 * Jan 15 -> Feb 15 = 1; Jan 15 -> Feb 16 = 2. Pure date arithmetic, no Date object.
 */
export function bondMonths(start: IsoDate, end: IsoDate): { months: number; assumption: AssumptionUsed } {
  isoDate(start);
  isoDate(end);
  if (compareDates(end, start) < 0) refuse('BAD_DATE', 'end date is before start date');
  const [y1, m1, d1] = start.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = end.split('-').map(Number) as [number, number, number];
  let months = (y2 - y1) * 12 + (m2 - m1);
  if (d2 > d1) months += 1;
  return { months, assumption: A6_PART_MONTHS };
}

/** Surety premium on contract price C: chargeSplit's premium part (m_dur folded in, one rounding, spec 2.13). */
export function bondPremium(C: Cents, charges: PriceChargesInput): Cents {
  return chargeSplit(C, charges).premium;
}

/**
 * True-up at final price (spec 4.3, convention): delta = premium(C_final) - premium(C_orig);
 * additional premium if positive, refund if negative. Invariant 69: the sign follows C_final - C_orig.
 */
export function premiumTrueUp(
  charges: PriceChargesInput,
  cOrig: Cents,
  cFinal: Cents,
): { premiumOrig: Cents; premiumFinal: Cents; additional: Cents; refund: Cents; delta: number } {
  const a = bondPremium(cOrig, charges), b = bondPremium(cFinal, charges);
  return {
    premiumOrig: a,
    premiumFinal: b,
    additional: Math.max(0, b - a) as Cents,
    refund: Math.max(0, a - b) as Cents,
    delta: b - a,
  };
}

// ---------------------------------------------------------------- spec 4.4 SBA surety bond guarantee fee

/** Dated SBA fee table (D-37). */
export interface SbaFeeTable {
  /** Guarantees approved on or after this date pay rateFromPpm; before it, rateBeforePpm. */
  readonly switchDate: IsoDate;
  readonly rateBeforePpm: Ppm;
  readonly rateFromPpm: Ppm;
  /** eligible = C <= contractLimit (federal contracts up to federalCertifiedLimit with a contracting officer's certification). */
  readonly contractLimit: Cents;
  readonly federalCertifiedLimit: Cents;
  readonly source: LegalSource;
}

/** A-36: the notice's exception clause is not modelled. */
export const A36_SBA_EXCEPTION: AssumptionUsed = { id: 'A-36', text: 'SBA fee notice exception clause', value: 'none modelled' };

/** g = approvalDate < switchDate ? before : from (spec 4.4). The switch is exact at the date. */
export function sbaFeeRatePpm(t: SbaFeeTable, approvalDate: IsoDate): Ppm {
  isoDate(t.switchDate);
  isoDate(approvalDate);
  assertPpm(t.rateBeforePpm, 'SBA rate before', 0, 1_000_000);
  assertPpm(t.rateFromPpm, 'SBA rate from', 0, 1_000_000);
  return compareDates(approvalDate, t.switchDate) < 0 ? t.rateBeforePpm : t.rateFromPpm;
}

/**
 * feePayable = 100 * divRoundHalfUp(g * C, 10^8): cents, rounded to the nearest whole dollar (spec 4.4).
 * Bid-bond guarantees pay 0. Refuses a contract above the limit (invariant 22).
 * |feePayable - g*C| <= 50 cents.
 */
export function sbaFee(
  t: SbaFeeTable,
  C: Cents,
  approvalDate: IsoDate,
  opts: { readonly guarantee: 'contract' | 'bid_bond'; readonly federalCertified?: boolean },
): { ratePpm: Ppm; feePayable: Cents; feeExact: Ratio; limit: Cents; assumptions: AssumptionUsed[] } {
  assertCents(C, 'contract price C');
  assertCents(t.contractLimit, 'SBA contract limit');
  assertCents(t.federalCertifiedLimit, 'SBA certified limit');
  const limit = opts.federalCertified ? t.federalCertifiedLimit : t.contractLimit;
  if (C > limit) refuse('SBA_OVER_LIMIT', `contract ${C} cents exceeds the SBA guarantee limit ${limit} cents`);
  const g = sbaFeeRatePpm(t, approvalDate);
  const assumptions = [A36_SBA_EXCEPTION];
  if (opts.guarantee === 'bid_bond') return { ratePpm: g, feePayable: 0 as Cents, feeExact: ratio(0n), limit, assumptions };
  const num = BigInt(g) * BigInt(C);
  return { ratePpm: g, feePayable: toCents(100n * divRoundHalfUp(num, 100_000_000n), 'SBA fee'), feeExact: ratio(num, M6), limit, assumptions };
}

/** The SBA fee as a price-based charge (enters the fixed point as f = g, unrounded; spec 4.4, 2.13). */
export function sbaFeeCharge(t: SbaFeeTable, approvalDate: IsoDate): PriceChargesInput['fees'][number] {
  return { label: 'SBA surety bond guarantee fee', rate: { ppm: sbaFeeRatePpm(t, approvalDate), base: 'on_price' } };
}
