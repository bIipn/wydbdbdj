// Seeded generator of SIMULATED small electrical contractors and public jobs (spec 10.0 "Synthetic
// contractors and jobs", L6). Pure: the seed is an input, no Math.random, no Date.now, no I/O.
//
// Every generated field is either anchored to a spec section 8 row (cited as D-n with its source URL in the
// ANCHORS table below) or labelled ASSUMPTION (spec A-33: "no free published data; marked ASSUMPTION in code;
// simulated companies are never shown as real"). Ids are "SIM-0001", never a real company name.
//
// This module produces DATA only (engine input objects). It imports engine TYPES, never engine functions,
// so the engine and the independent test oracle can both price the same generated job.
import type {
  BidInput,
  BondTier,
  Cents,
  EquipmentLine,
  HoursC,
  JobOverheadItem,
  LaborClassInput,
  MaterialLine,
  OtRegime,
  OverheadInput,
  PayrollTaxTable,
  Ppm,
  PriceChargesInput,
  QtyM,
  SubcontractQuote,
} from './index.js';
import type { RetainageRule } from './payment.js';
import type { CashCategory, CashJobInput } from './cash.js';
import type { ContractorLimits } from './limits.js';

// ---------------------------------------------------------------- seeded PRNG (sfc32, seeded by splitmix32)

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  constructor(seed: number) {
    let s = seed >>> 0;
    const sm = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = sm();
    this.b = sm();
    this.c = sm();
    this.d = sm();
    for (let i = 0; i < 12; i++) this.u32();
  }
  u32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t >>> 0;
  }
  /** uniform on [0, 1) */
  next(): number {
    return this.u32() / 4294967296;
  }
  /** integer uniform on [lo, hi] */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ---------------------------------------------------------------- samplers (spec 10.0)

/**
 * Percentile-table sampler (spec 10.0): interpolate between the two published points that bracket u;
 * clamp outside the table (puts the tail mass exactly on the end values: acceptable for tests, labelled).
 */
export function percentileSample(table: readonly (readonly [number, number])[], u: number): number {
  if (u <= table[0]![0]) return table[0]![1];
  for (let i = 1; i < table.length; i++) {
    const [u1, v1] = table[i]!;
    if (u <= u1) {
      const [u0, v0] = table[i - 1]!;
      return v0 + ((u - u0) / (u1 - u0)) * (v1 - v0);
    }
  }
  return table[table.length - 1]![1];
}
/** Same, interpolating log-linearly (spec 10.0 job sizes: linear interpolation to the max overstates the mean). */
export function logPercentileSample(table: readonly (readonly [number, number])[], u: number): number {
  return Math.exp(percentileSample(table.map(([p, v]) => [p, Math.log(v)] as const), u));
}
/** Triangular three-point sampler, spec 10.0 formula: a = min, c = mode, b = max. */
export function triangular(a: number, c: number, b: number, u: number): number {
  return u < (c - a) / (b - a) ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
}
export const triangularMean = (a: number, c: number, b: number) => (a + b + c) / 3;
export const triangularVariance = (a: number, c: number, b: number) => (a * a + b * b + c * c - a * b - a * c - b * c) / 18;

// ---------------------------------------------------------------- published anchors (spec section 8)

export const ANCHORS = {
  'D-80': 'https://api.bls.gov/publicAPI/v2/timeseries/data/ (OEWS 47-2111, May 2025)',
  'D-86': 'https://api.usaspending.gov/api/v2/search/spending_by_award/ (NAICS 238210, Nevada, 2024-11-13 to 2026-11-13)',
  'D-65': 'https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ARCHIVES/ufc_3_700_02a_2005.pdf',
  'D-59': 'https://www.ecfr.gov/current/title-13/section-121.201',
  'D-1..D-4': 'https://www.irs.gov/taxtopics/tc751 ; https://www.irs.gov/taxtopics/tc759 ; https://www.ssa.gov/oact/cola/cbb.html',
  'D-6..D-9': 'https://detr.nv.gov/Page/UI_Tax ; https://detr.nv.gov/Page/UI_Information_for_Employers ; https://tax.nv.gov/tax-types/modified-business-tax/',
  'D-10..D-11': 'https://edd.ca.gov/en/payroll_taxes/rates_and_withholding/',
  'D-12': 'https://dir.nv.gov/uploadedFiles/dirnvgov/content/WCS/ImportantDocs/FYI-DR-NV-2026-01.pdf',
  'D-30': 'https://www.leg.state.nv.us/nrs/NRS-338.html',
  'D-32..D-36': 'https://www.acquisition.gov/far/28.102-1 ; https://www.leg.state.nv.us/nrs/NRS-339.html ; https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=9550.',
  'D-37': 'https://www.federalregister.gov/documents/2026/10/30/2026-22177/surety-bond-guarantee-program-fees',
  'D-38': 'https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ARCHIVES/ufc_3_740_05_2010_c1.pdf',
  'D-39': 'https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ufs_3_740_05_2026.pdf',
  'D-43..D-53': 'https://www.acquisition.gov/far/52.232-5 ; https://www.leg.state.nv.us/nrs/NRS-338.html ; https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PCC&sectionNum=7201',
  'D-55': 'https://www.ecfr.gov/current/title-13/section-120.214',
  'D-60': 'https://www.federalreserve.gov/releases/h15/ (observation 2026-10-09)',
} as const;

/** D-80 Nevada electrician hourly wage percentiles, cents (p10 22.17 ... p90 58.27). */
export const D80_NV_WAGE_PCTL: readonly (readonly [number, number])[] = [
  [0.1, 2217], [0.25, 2352], [0.5, 3537], [0.75, 4642], [0.9, 5827],
];
export const D80_NV_MEDIAN = 3537;
/** D-86 federal electrical awards in Nevada (n = 36), cents: min, p25, median, p75, p90, max. Resampled log-linearly. */
export const D86_AWARD_PCTL: readonly (readonly [number, number])[] = [
  [0, 338_000], [0.25, 1_227_175], [0.5, 3_820_962], [0.75, 8_277_161], [0.9, 16_670_202], [1, 283_893_431],
];
/** D-65 context ranges: home-office overhead 3% to 10% of contract amount (revenue); profit 3% to 10% of direct + indirect cost. */
export const D65_OVERHEAD_ON_SALES_PPM = [30_000, 100_000] as const;
export const D65_PROFIT_ON_COST_PPM = [30_000, 100_000] as const;
/** D-59 small-business size standard, NAICS 238210: $19.0 million average annual receipts. */
export const D59_SIZE_STANDARD: Cents = 1_900_000_000 as Cents;

const SRC_PAYROLL = [ANCHORS['D-1..D-4'], ANCHORS['D-6..D-9'], ANCHORS['D-10..D-11']];
/** 2026 Nevada payroll table: D-1, D-2 (184,500), D-3, D-4, D-5 / A-9 (Nevada 0 with a warning), D-6 (43,700), D-7, D-8, D-9. */
export const NV_2026: PayrollTaxTable = {
  year: 2026,
  state: 'NV',
  sources: SRC_PAYROLL,
  effective: 'calendar year 2026',
  socialSecurity: { ratePpm: 62_000 as Ppm, wageBase: 18_450_000 as Cents },
  medicare: { ratePpm: 14_500 as Ppm },
  futa: { netRatePpm: 6_000 as Ppm, wageBase: 700_000 as Cents, creditReductionPpm: 0 as Ppm, creditReductionFinal: false },
  stateUnemployment: {
    wageBase: 4_370_000 as Cents,
    ratePpmMin: 2_500 as Ppm,
    ratePpmMax: 54_000 as Ppm,
    surchargePpm: 500 as Ppm,
    surchargeLabel: 'Career Enhancement Program',
    surchargeExemptAtRatePpm: 54_000 as Ppm,
  },
  mbt: { ratePpm: 11_700 as Ppm, quarterlyExemptWages: 5_000_000 as Cents },
};
/** 2026 California payroll table: D-1..D-4; credit reduction must be entered (A-9); D-10 base 7,000; D-11 ETT 0.1%. */
export const CA_2026: PayrollTaxTable = {
  year: 2026,
  state: 'CA',
  sources: SRC_PAYROLL,
  effective: 'calendar year 2026',
  socialSecurity: { ratePpm: 62_000 as Ppm, wageBase: 18_450_000 as Cents },
  medicare: { ratePpm: 14_500 as Ppm },
  futa: { netRatePpm: 6_000 as Ppm, wageBase: 700_000 as Cents, creditReductionPpm: null, creditReductionFinal: false },
  stateUnemployment: {
    wageBase: 700_000 as Cents,
    ratePpmMin: 15_000 as Ppm,
    ratePpmMax: 62_000 as Ppm,
    surchargePpm: 1_000 as Ppm,
    surchargeLabel: 'ETT',
    surchargeExemptAtRatePpm: null,
  },
};
/** A-9: California's potential 2026 credit reduction 1.5%, entered explicitly (assumption, labelled). */
export const A9_CA_CREDIT_REDUCTION_PPM = 15_000 as Ppm;
/** D-12: Nevada WC payroll cap 98,433.60 for policies from 2026-10-01. */
export const D12_NV_WC_CAP = 9_843_360 as Cents;
/** D-38 sample Class B schedule, corrected fifth tier (illustrative; A-1). */
export const D38_CLASS_B: readonly BondTier[] = [
  { upperBound: 10_000_000 as Cents, ratePpm: 25_000 as Ppm },
  { upperBound: 50_000_000 as Cents, ratePpm: 15_000 as Ppm },
  { upperBound: 250_000_000 as Cents, ratePpm: 10_000 as Ppm },
  { upperBound: 500_000_000 as Cents, ratePpm: 7_500 as Ppm },
  { upperBound: 750_000_000 as Cents, ratePpm: 7_000 as Ppm },
  { upperBound: null, ratePpm: 6_500 as Ppm },
];
/** D-39 non-deviating surcharge: 1% of premium per month over 12 (M1 = M2 = 12, s1 = s2 = 1%). */
export const D39_NON_DEVIATING = { M1: 12, M2: 12, s1Ppm: 10_000, s2Ppm: 10_000 } as const;
/** D-37 SBA fee: $6.00 per $1,000 before 2026-11-30, $7.29 on or after. */
export const D37_SBA = { switchDate: '2026-11-30', beforePpm: 6_000, fromPpm: 7_290 } as const;
/** D-60 prime 7.00% (context) and D-55 SBA 7(a) maximum spreads (points over base) by loan size. */
export const D60_PRIME_PPM = 70_000;
export const D55_SPREADS_PPM = [65_000, 60_000, 45_000, 30_000] as const;

export type OwnerType = 'federal' | 'nv_local' | 'nv_state_spwd' | 'ndot' | 'ca_state' | 'ca_local' | 'caltrans' | 'private';

/** Spec 4.2 bond triggers on contract price C, strict ">" (D-32, D-33, D-35, D-36). */
export function bondTriggered(owner: OwnerType, C: number, federalOfficerChoiceMeansBond: boolean): boolean {
  switch (owner) {
    case 'federal':
      return C > 15_000_000 || (C > 3_500_000 && federalOfficerChoiceMeansBond); // D-32 > $150,000; D-33 band
    case 'nv_local':
    case 'nv_state_spwd':
      return C > 10_000_000; // D-35 NRS 339.025 > $100,000
    case 'ndot':
      return true; // D-35 NDOT: all contracts
    case 'ca_state':
    case 'ca_local':
    case 'caltrans':
      return C > 2_500_000; // D-36 payment bond > $25,000
    case 'private':
      return false; // no statute; ASSUMPTION: simulated private jobs are unbonded
  }
}

const RR = (id: string, rho1: number, theta: number | null, rho2: number, kappa: number | null, cap: number | null, half: boolean): RetainageRule => ({
  id,
  rho1Ppm: rho1 as Ppm,
  thetaPpm: theta as Ppm | null,
  rho2Ppm: rho2 as Ppm,
  kappaPpm: kappa as Ppm | null,
  dollarCap: cap as Cents | null,
  halfRelease: half,
});
/** Spec 4.5 presets (D-43, D-48, D-49, D-51, D-52). Private: ASSUMPTION flat 5% (no statute read). */
export const RETAINAGE: Readonly<Record<string, RetainageRule>> = {
  federal: RR('federal', 0, null, 0, null, null, false),
  federal_stress: RR('federal_stress', 100_000, null, 100_000, 100_000, null, false),
  nv_best: RR('nv_best', 50_000, 500_000, 0, null, null, false),
  nv_base: RR('nv_base', 50_000, 500_000, 25_000, null, null, true),
  nv_stress: RR('nv_stress', 50_000, 500_000, 50_000, null, null, false),
  ndot: RR('ndot', 50_000, null, 50_000, 50_000, 5_000_000, false),
  ca_7201: RR('ca_7201', 50_000, null, 50_000, 50_000, null, false),
  ca_9203: RR('ca_9203', 50_000, 500_000, 0, null, null, false),
  caltrans: RR('caltrans', 0, null, 0, null, null, false),
  private_assumption: RR('private_assumption', 50_000, null, 50_000, null, null, false),
};
/** Spec 4.6 owner payment lag, release lag and sub pay-down lag in days (D-44, D-48, D-50, D-53; NV release A-30; private ASSUMPTION). */
export const TIMING: Readonly<Record<'federal' | 'nv' | 'ca' | 'private', { payLag: number; releaseLag: number; subLag: number }>> = {
  federal: { payLag: 14, releaseLag: 30, subLag: 7 },
  nv: { payLag: 30, releaseLag: 30 /* A-30: per contract; ASSUMPTION 30 */, subLag: 10 },
  ca: { payLag: 30, releaseLag: 60, subLag: 7 },
  private: { payLag: 30 /* ASSUMPTION */, releaseLag: 30 /* ASSUMPTION */, subLag: 10 /* ASSUMPTION */ },
};

// ---------------------------------------------------------------- simulated companies and jobs

export interface SimCompany {
  readonly id: string; // 'SIM-0001'
  readonly simulated: true;
  readonly state: 'NV' | 'CA';
  readonly headcount: number; // ASSUMPTION (A-33): 2 to 50, log-uniform
  readonly annualRevenue: Cents; // ASSUMPTION revenue per head; capped below D-59
  readonly journeymanWage: Cents; // D-80 percentile sampler
  readonly apprenticeWage: Cents; // D-80 lower percentiles (p10 to p25)
  readonly overheadOnSalesPpm: number; // D-65
  readonly profitOnCostPpm: number; // D-65
  readonly uiRatePpm: number; // D-7 (NV) or D-10 (CA) range, new-employer rate for young firms
  readonly wcRatePpm: number; // ASSUMPTION (A-11: no default; simulated policy rate)
  readonly xModPpm: number; // ASSUMPTION
  readonly glReceiptsPpm: number; // ASSUMPTION (A-13: from the policy); 0 = payroll-rated or none
  readonly mbtMode: 'none' | 'marginal' | 'average';
  readonly sbaGuaranteed: boolean; // ASSUMPTION share
  readonly creditRatePpm: number; // D-60 prime + D-55 spread (ASSUMPTION: borrows at the maximum)
  readonly limits: ContractorLimits; // ASSUMPTION (A-33)
  readonly limitsProfile: 'tight' | 'loose';
}

export interface SimJob {
  readonly id: string; // 'SIM-0001-J01'
  readonly companyId: string;
  readonly owner: OwnerType;
  readonly state: 'NV' | 'CA';
  readonly targetValue: Cents; // D-86 resample
  readonly regime: OtRegime;
  readonly weeks: number; // duration, work periods on a weekly grid
  readonly months: number; // A-6 whole months rounded up
  readonly bonded: 'auto' | 'no';
  readonly federalOfficerChoiceMeansBond: boolean; // ASSUMPTION per job
  readonly retainageKey: string;
  readonly bid: BidInput; // engine input, financing off
  readonly cash: {
    readonly payLagDays: number;
    readonly releaseLagDays: number;
    readonly subLagDays: number;
    readonly laborLagWeeks: number; // ASSUMPTION payroll lag (D-29 weekly on Davis-Bacon; D-26 semimonthly otherwise)
    readonly materialDepositPpm: number; // ASSUMPTION (A-26 default none)
    readonly deliveryWeeks: readonly number[]; // ASSUMPTION
  };
}

const cents = (x: number) => Math.max(0, Math.round(x)) as Cents;
const pad = (n: number, w = 4) => String(n).padStart(w, '0');

/** One simulated company. Same (seed, index) -> same company. */
export function simCompany(seed: number, index: number): SimCompany {
  const g = new Rng((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  const state = g.chance(0.6) ? 'NV' : 'CA'; // ASSUMPTION mix
  const headcount = Math.round(Math.exp(Math.log(2) + g.next() * (Math.log(50) - Math.log(2)))); // ASSUMPTION A-33
  const perHead = 12_000_000 + g.next() * 13_000_000; // ASSUMPTION $120k..$250k revenue per head
  const annualRevenue = cents(Math.min(headcount * perHead, D59_SIZE_STANDARD - 100)); // below D-59
  const journeymanWage = cents(percentileSample(D80_NV_WAGE_PCTL, 0.25 + g.next() * 0.7)); // D-80
  const apprenticeWage = cents(percentileSample(D80_NV_WAGE_PCTL, 0.1 + g.next() * 0.15)); // D-80 p10..p25
  const os = g.int(D65_OVERHEAD_ON_SALES_PPM[0], D65_OVERHEAD_ON_SALES_PPM[1]); // D-65
  const pc = g.int(D65_PROFIT_ON_COST_PPM[0], D65_PROFIT_ON_COST_PPM[1]); // D-65
  // D-7: NV experience-rated 0.25..5.40, new employer 2.95; D-10: CA 1.5..6.2, new employer 3.4
  const young = g.chance(0.3);
  const uiRatePpm = state === 'NV' ? (young ? 29_500 : g.chance(0.1) ? 54_000 : g.int(2_500, 53_999)) : young ? 34_000 : g.int(15_000, 62_000);
  const wcRatePpm = g.int(10_000, 60_000); // ASSUMPTION $1 to $6 per $100 (no published default, A-11)
  const xModPpm = g.int(750_000, 1_400_000); // ASSUMPTION
  const glReceiptsPpm = g.chance(0.6) ? g.int(2_000, 9_000) : 0; // ASSUMPTION
  const mbtMode = state === 'NV' ? g.pick(['marginal', 'average', 'none'] as const) : 'none'; // D-9 only in NV
  const sbaGuaranteed = g.chance(0.25); // ASSUMPTION
  const creditRatePpm = D60_PRIME_PPM + g.pick(D55_SPREADS_PPM); // D-60 + D-55
  const limitsProfile = g.chance(0.5) ? 'tight' : 'loose';
  const k = limitsProfile === 'tight' ? 0.4 : 1.6; // ASSUMPTION scale between tight and loose firms
  const rev = annualRevenue as number;
  const workingCapital = cents(rev * (0.05 + g.next() * 0.15) * k); // ASSUMPTION
  const netWorth = cents((workingCapital as number) * (1 + g.next() * 2)); // ASSUMPTION
  const hasLetter = g.chance(0.5); // ASSUMPTION
  const single = cents((workingCapital as number) * (5 + g.next() * 10)); // ASSUMPTION
  const limits: ContractorLimits = {
    cashForJob: cents(rev * (0.01 + g.next() * 0.06) * k), // ASSUMPTION
    unusedCreditLine: cents(rev * g.next() * 0.1 * k), // ASSUMPTION
    bufferPpm: (g.chance(0.5) ? 0 : 100_000) as Ppm, // A-27 default 0; ASSUMPTION 10% for half the firms
    maxJobSize: cents(rev * (0.1 + g.next() * 0.4) * k), // ASSUMPTION
    maxUpFrontCash: cents(rev * (0.01 + g.next() * 0.05) * k), // ASSUMPTION
    ...(hasLetter
      ? { suretyLetter: { singleLimit: single, aggregateLimit: cents((single as number) * 2), backlogRemaining: cents((single as number) * g.next() * 1.5) } }
      : {}),
    workingCapital,
    netWorth,
    currentAssets: cents((workingCapital as number) * 2.5), // ASSUMPTION
    currentLiabilities: cents((workingCapital as number) * 1.5), // ASSUMPTION
    backlog: cents(rev * g.next() * 0.8), // ASSUMPTION
  };
  return {
    id: `SIM-${pad(index + 1)}`, simulated: true, state, headcount, annualRevenue, journeymanWage, apprenticeWage,
    overheadOnSalesPpm: os, profitOnCostPpm: pc, uiRatePpm, wcRatePpm, xModPpm, glReceiptsPpm, mbtMode, sbaGuaranteed,
    creditRatePpm, limits, limitsProfile,
  };
}

/** spec 2.13 m_dur (data for the job; the engine's own durationMultiplierPpm is tested separately). */
function mDur(months: number): number {
  const { M1, M2, s1Ppm, s2Ppm } = D39_NON_DEVIATING;
  return 1_000_000 + s1Ppm * Math.max(0, Math.min(months, M2) - M1) + s2Ppm * Math.max(0, months - M2);
}

function regimeFor(owner: OwnerType, state: 'NV' | 'CA', estimate: number): OtRegime {
  if (owner === 'federal') return 'DAVIS_BACON'; // A-39: ASSUMPTION every simulated federal job carries a determination
  if (owner === 'private') return state === 'NV' ? 'NV_PRIVATE' : 'CA_PRIVATE';
  if (state === 'NV') return estimate >= 10_000_000 ? 'NV_PUBLIC' : 'NV_PRIVATE'; // D-30: prevailing wage from $100,000
  return 'CA_PUBLIC'; // ASSUMPTION: simulated California public works carry a DIR determination
}

/** One simulated job for a company. Same (seed, company, j) -> same job. */
export function simJob(seed: number, co: SimCompany, j: number): SimJob {
  const g = new Rng((seed ^ Math.imul(j + 1, 0x85ebca6b) ^ Math.imul(Number(co.id.slice(4)), 0xc2b2ae35)) >>> 0);
  const owner: OwnerType =
    co.state === 'NV'
      ? g.pick(['federal', 'nv_local', 'nv_local', 'nv_state_spwd', 'ndot', 'private'] as const)
      : g.pick(['federal', 'ca_local', 'ca_local', 'ca_state', 'caltrans', 'private'] as const);
  const V = logPercentileSample(D86_AWARD_PCTL, g.next()); // D-86 resample, log-linear
  const regime = regimeFor(owner, co.state, V);
  const prevailing = regime === 'NV_PUBLIC' || regime === 'CA_PUBLIC' || regime === 'DAVIS_BACON';
  // ASSUMPTION (A-33) cost split
  const laborShare = 0.3 + g.next() * 0.25;
  const subShare = g.chance(0.6) ? g.next() * 0.2 : 0;
  const matShare = Math.max(0.1, 1 - laborShare - subShare - 0.12);
  const costBase = V * 0.82; // ASSUMPTION: cost ~ 82% of the award value before markups
  // labor classes
  const classes: LaborClassInput[] = [];
  const jw = co.journeymanWage as number;
  const mkClass = (id: string, wage: number, share: number, isLead: boolean): LaborClassInput => {
    const loaded = wage * 1.45; // ASSUMPTION rough loaded rate, only used to size hours
    const hours = Math.max(800, Math.round(((costBase * laborShare * share) / loaded) * 100)); // HoursC, >= 8 h
    const otShare = g.chance(0.5) ? g.next() * 0.12 : 0; // ASSUMPTION
    const h15 = Math.round(hours * otShare);
    let h20 = 0;
    if (regime === 'CA_PRIVATE' && g.chance(0.4)) h20 = Math.round(hours * g.next() * 0.03); // ASSUMPTION
    let wBasic = wage, wCil = 0, fPlan = g.chance(0.7) ? g.int(150, 900) : 0; // ASSUMPTION plan cents/h
    let fHealth = fPlan ? Math.min(fPlan, g.int(0, fPlan)) : 0;
    let pv: LaborClassInput['prevailing'];
    let pay20: number | undefined;
    if (prevailing) {
      const bhr = Math.round(percentileSample(D80_NV_WAGE_PCTL, 0.5 + g.next() * 0.45)); // ASSUMPTION determination near D-80 upper half
      const fb = Math.round(bhr * (0.3 + g.next() * 0.3)); // ASSUMPTION fringe 30% to 60% of base
      wBasic = Math.max(wage, bhr);
      // meet the package with plan contributions and cash in lieu (spec 2.2 compliance); sometimes over-pay
      fPlan = Math.min(fb, g.int(0, fb));
      fHealth = Math.min(fPlan, g.int(0, fPlan));
      wCil = fb - fPlan + (g.chance(0.2) ? g.int(0, 300) : 0);
      pv = { bhrWd: bhr as Cents, fbWd: fb as Cents, ...(regime === 'DAVIS_BACON' && g.chance(0.2) ? { cashInLieuCountsAsBasic: true } : {}) };
      if ((regime === 'NV_PUBLIC' || regime === 'CA_PUBLIC') && g.chance(0.3)) {
        h20 = Math.round(hours * g.next() * 0.02); // ASSUMPTION double time per determination footnote
        pay20 = 2 * (wBasic + wCil) + fPlan; // ASSUMPTION footnote figure (cash per 2x hour)
      }
    }
    const h10b = Math.max(0, hours - h15 - h20);
    const W = g.chance(0.8) ? cents((wBasic + wCil) * (1200 + g.next() * 1000)) : undefined; // ASSUMPTION annual hours; omitted -> A-8
    return {
      id, label: isLead ? 'Journeyman' : 'Apprentice',
      h10: h10b as HoursC, h15: h15 as HoursC, h20: h20 as HoursC,
      wBasic: wBasic as Cents, wCil: wCil as Cents, fPlan: fPlan as Cents, fHealth: fHealth as Cents,
      travelPerHour: (g.chance(0.2) ? g.int(0, 500) : 0) as Cents, // ASSUMPTION
      otherPerHour: (g.chance(0.2) ? g.int(0, 300) : 0) as Cents, // ASSUMPTION
      ...(W !== undefined ? { annualTaxableWages: W } : {}),
      ...(g.chance(0.2) && W !== undefined ? { wcAnnualPayroll: cents((W as number) * (0.8 + g.next() * 0.6)) } : {}),
      taxYear: 2026,
      wcRatePpm: co.wcRatePpm as Ppm,
      ...(pay20 !== undefined ? { pay20: pay20 as Cents } : {}),
      ...(pv ? { prevailing: pv } : {}),
      ...(g.chance(0.15) ? { wageScheduled: true } : {}),
    };
  };
  classes.push(mkClass('journeyman', jw, prevailing ? 0.6 : 0.7, true));
  if (prevailing) classes.push(mkClass('foreman', jw + g.int(200, 800), 0.4, true));
  else classes.push(mkClass('apprentice', co.apprenticeWage as number, 0.3, false));
  // materials (ASSUMPTION quantities and prices sized to the material share)
  const nLines = g.int(2, 7);
  const lines: MaterialLine[] = [];
  const matTarget = costBase * matShare;
  for (let i = 0; i < nLines; i++) {
    const unit = g.int(5, 250_000);
    const ext = matTarget / nLines;
    const qty = Math.max(1, Math.round((ext / unit) * 1000)); // QtyM
    lines.push({
      id: `m${i + 1}`,
      quantity: qty as QtyM,
      unitPrice: unit as Cents,
      wastePpm: (g.chance(0.6) ? g.int(0, 100_000) : 0) as Ppm, // ASSUMPTION
      taxable: g.chance(0.9),
      ...(g.chance(0.4) ? { escalationPpm: g.int(0, 40_000) as Ppm } : {}), // ASSUMPTION e_i (escalation tested separately)
    });
  }
  const taxBasis = g.chance(0.8) ? 'total' : 'line';
  const equipment: EquipmentLine[] = [];
  for (let i = g.int(0, 2); i > 0; i--)
    equipment.push(g.chance(0.5) ? { id: `e${i}`, kind: 'lump', amount: g.int(20_000, 400_000) as Cents } : { id: `e${i}`, kind: 'hourly', hours: g.int(100, 20_000) as HoursC, rate: g.int(2_000, 15_000) as Cents });
  const subcontracts: SubcontractQuote[] = [];
  if (subShare > 0) {
    const ns = g.int(1, 3);
    for (let i = 0; i < ns; i++) subcontracts.push({ id: `s${i + 1}`, amount: cents((costBase * subShare) / ns) });
  }
  // duration (ASSUMPTION crew of up to a third of the firm on one job, 40 h weeks)
  const totalHours = classes.reduce((a, c) => a + c.h10 + c.h15 + c.h20, 0) / 100;
  const crew = Math.max(1, Math.min(co.headcount, Math.round(co.headcount / 3) + 1));
  const weeks = Math.max(1, Math.min(104, Math.ceil(totalHours / (crew * 40))));
  const months = Math.ceil((weeks * 7) / 30); // A-6: whole months rounded up (30-day months: ASSUMPTION)
  const jobOverhead: JobOverheadItem[] = [
    { id: 'permit', kind: 'once', amount: g.int(10_000, 200_000) as Cents }, // ASSUMPTION
    { id: 'supervision', kind: 'hours', hours: Math.max(100, Math.round(totalHours * 100 * 0.05)) as HoursC, rate: (jw + 2_000) as Cents }, // ASSUMPTION
    { id: 'temp', kind: 'monthly', months: (months * 1000) as QtyM, monthlyCost: g.int(5_000, 60_000) as Cents }, // ASSUMPTION
  ];
  if (g.chance(0.5)) jobOverhead.push({ id: 'mobilization', kind: 'once', amount: g.int(10_000, 150_000) as Cents });
  // markups (D-65 converted to the method's basis, spec 2.11 / 3.3)
  const os = co.overheadOnSalesPpm, pc = co.profitOnCostPpm;
  const ms = Math.round((pc * 1_000_000) / (1_000_000 + pc)); // m_s = p_c/(1 + p_c)
  const oc = Math.round((os * 1_000_000) / (1_000_000 - os - ms)); // o_c = o_s/(1 - o_s - m_s)
  const methodPick = g.int(0, 4);
  let overhead: OverheadInput;
  let profitOnSales = false;
  if (methodPick === 0 || methodPick === 4) overhead = { method: 'on_cost', rate: { ppm: oc as Ppm, base: 'on_cost' } };
  else if (methodPick === 1) {
    overhead = { method: 'on_sales', rate: { ppm: os as Ppm, base: 'on_sales' }, profit: { ppm: ms as Ppm, base: 'on_sales' } };
    profitOnSales = true;
  } else if (methodPick === 2) overhead = { method: 'per_labor_hour', centsPerHour: g.int(500, 4_000) as Cents }; // ASSUMPTION
  else overhead = g.chance(0.5)
    ? { method: 'on_labor_cost', measure: g.chance(0.5) ? 'L' : 'G', rate: { ppm: g.int(100_000, 500_000) as Ppm, base: 'on_labor_cost' } } // ASSUMPTION
    : { method: 'dual', rateL: { ppm: g.int(150_000, 400_000) as Ppm, base: 'on_labor_cost' }, rateM: { ppm: g.int(30_000, 120_000) as Ppm, base: 'on_cost' } }; // ASSUMPTION r_L > r_M
  // price-based charges: D-38 tiers when the owner requires a bond, D-39 surcharge, GL on receipts, SBA fee (D-37)
  const bonded: 'auto' | 'no' = owner === 'private' ? 'no' : 'auto';
  const federalOfficerChoiceMeansBond = g.chance(0.5); // ASSUMPTION
  const bidDate = g.chance(0.5) ? '2026-11-20' : '2026-12-10'; // ASSUMPTION, straddles the D-37 switch date
  const fees: PriceChargesInput['fees'][number][] = [];
  if (co.glReceiptsPpm > 0) fees.push({ label: 'general liability (receipts)', rate: { ppm: co.glReceiptsPpm as Ppm, base: 'per_1000_receipts' } });
  if (co.sbaGuaranteed && bonded === 'auto')
    fees.push({ label: 'SBA guarantee fee', rate: { ppm: (bidDate < D37_SBA.switchDate ? D37_SBA.beforePpm : D37_SBA.fromPpm) as Ppm, base: 'on_price' } });
  const charges: PriceChargesInput = {
    tiers: bonded === 'auto' ? D38_CLASS_B : [],
    mDurPpm: mDur(months) as Ppm,
    fees,
    ...(bonded === 'auto' ? { bondRequiredAuto: (Pnb: Cents) => bondTriggered(owner, Pnb, federalOfficerChoiceMeansBond) } : {}),
  };
  const bid: BidInput = {
    labor: {
      regime,
      stateOfWork: co.state,
      burdenMode: g.chance(0.9) ? 'statutory' : 'flat',
      classes,
      payrollTables: { 2026: co.state === 'NV' ? NV_2026 : CA_2026 },
      stateUiRatePpm: co.uiRatePpm as Ppm,
      ...(co.state === 'CA' ? { futaCreditReductionPpm: A9_CA_CREDIT_REDUCTION_PPM } : {}),
      ...(co.mbtMode !== 'none'
        ? (() => {
            const gw = co.headcount * jw * 520; // ASSUMPTION quarterly gross wages: headcount x 520 h
            return { mbt: { mode: co.mbtMode, quarterlyGrossWages: cents(gw), quarterlyHealthDeduction: cents(gw * g.next() * 0.1) } };
          })()
        : {}),
      workersComp: {
        xModPpm: co.xModPpm as Ppm,
        otherModsPpm: 1_000_000 as Ppm,
        excludeOtPremium: co.state === 'NV' ? false : g.chance(0.5), // D-13 Nevada false; A-12 elsewhere
        payrollCap: co.state === 'NV' ? D12_NV_WC_CAP : null,
      },
      flatBurdenPpm: g.int(80_000, 250_000) as Ppm, // ASSUMPTION (flat mode only)
      ...(g.chance(0.2) ? { generalLiabilityPayrollPpm: g.int(5_000, 40_000) as Ppm } : {}), // ASSUMPTION
    },
    ...(g.chance(0.8) ? { smallToolsPpm: 20_000 as Ppm } : {}), // A-18 / D-66 2% (omitted -> engine default)
    materials: {
      lines,
      freight: (g.chance(0.6) ? g.int(0, 120_000) : 0) as Cents, // ASSUMPTION
      freightTaxable: taxBasis === 'total' && g.chance(0.2), // A-17 default false
      salesTaxPpm: g.int(0, 100_000) as Ppm, // ASSUMPTION (A-14: entered per job)
      taxBasis,
    },
    equipment,
    subcontracts,
    jobOverhead,
    ...(weeks > 26 && g.chance(0.5) ? { laborEscalationPpm: g.int(0, 30_000) as Ppm } : {}), // ASSUMPTION
    ...(g.chance(0.3) ? { contingencyPpm: g.int(0, 50_000) as Ppm } : {}), // A-19 default 0; ASSUMPTION otherwise
    overhead,
    profit: profitOnSales ? { fromOverheadOnSales: true } : { rate: { ppm: pc as Ppm, base: 'on_cost' } },
    financing: { include: false },
    charges,
    ...(g.chance(0.4) ? { bidRoundingUnit: g.pick([100, 10_000]) as Cents } : {}), // ASSUMPTION
  };
  const t = owner === 'federal' ? TIMING.federal : owner === 'private' ? TIMING.private : co.state === 'NV' ? TIMING.nv : TIMING.ca;
  const retainageKey =
    owner === 'federal' ? (g.chance(0.85) ? 'federal' : 'federal_stress')
    : owner === 'ndot' ? 'ndot'
    : owner === 'caltrans' ? 'caltrans'
    : owner === 'private' ? 'private_assumption'
    : co.state === 'NV' ? g.pick(['nv_base', 'nv_base', 'nv_best', 'nv_stress'])
    : owner === 'ca_local' && g.chance(0.4) ? 'ca_9203' : 'ca_7201';
  const deliveries = new Set<number>([1]);
  for (let i = g.int(0, 2); i > 0; i--) deliveries.add(g.int(1, weeks));
  return {
    id: `${co.id}-J${pad(j + 1, 2)}`, companyId: co.id, owner, state: co.state, targetValue: cents(V), regime, weeks, months,
    bonded, federalOfficerChoiceMeansBond, retainageKey, bid,
    cash: {
      payLagDays: t.payLag,
      releaseLagDays: t.releaseLag,
      subLagDays: t.subLag,
      laborLagWeeks: regime === 'DAVIS_BACON' ? 1 : g.pick([1, 2]), // D-29 weekly; D-26 semimonthly -> ASSUMPTION 1-2 weeks
      materialDepositPpm: g.chance(0.3) ? g.pick([100_000, 250_000]) : 0, // ASSUMPTION (A-26 default none)
      deliveryWeeks: [...deliveries].sort((a, b) => a - b),
    },
  };
}

/** Cost parts of a priced job, as the cash ledger needs them (spec 5.2). C_cash = TJC + q(P). */
export interface CostParts {
  readonly L: number;
  readonly MAT: number;
  readonly E: number;
  readonly SUB: number;
  readonly other: number; // ST + JOOH + ESC_L + CONT (field items incurred evenly)
  readonly q: number; // price-based charges, paid before start
}

/**
 * The spec 5 cash job for a priced bid, on a weekly grid (spec 5.1: inflow lags rounded up, outflow lags
 * rounded down, A-26). Monthly billing is taken as every 4 weeks (ASSUMPTION on a weekly grid).
 */
export function cashJobFor(job: SimJob, parts: CostParts, price: number): CashJobInput {
  const D = job.weeks;
  const up = (days: number) => Math.ceil(days / 7);
  const down = (days: number) => Math.floor(days / 7);
  const lam = up(job.cash.payLagDays);
  const lamR = Math.max(lam, up(job.cash.releaseLagDays));
  const even = [0, ...Array.from({ length: D }, () => 1)];
  const cats: CashCategory[] = [];
  const add = (c: CashCategory) => {
    if (c.amount > 0) cats.push(c);
  };
  add({ id: 'labor', kind: 'labor', amount: parts.L as Cents, weights: even, lagPeriods: job.cash.laborLagWeeks });
  const del = Array.from({ length: D + 1 }, (_, t) => (job.cash.deliveryWeeks.includes(t) ? 1 : 0));
  add({
    id: 'material',
    kind: 'material',
    amount: parts.MAT as Cents,
    weights: del,
    lagPeriods: down(30), // A-26 net 30
    ...(job.cash.materialDepositPpm > 0 ? { deposit: { sharePpm: job.cash.materialDepositPpm as Ppm, period: 0 } } : {}),
  });
  add({ id: 'equipment', kind: 'equipment', amount: parts.E as Cents, weights: even, lagPeriods: down(30) });
  add({ id: 'subcontract', kind: 'subcontract', amount: parts.SUB as Cents, weights: even, lagPeriods: lam + down(job.cash.subLagDays) });
  add({ id: 'field', kind: 'job_overhead', amount: parts.other as Cents, weights: even, lagPeriods: 0 });
  add({ id: 'charges', kind: 'pre_start', amount: parts.q as Cents, weights: [1], lagPeriods: 0 });
  return {
    periodDays: 7,
    workPeriods: D,
    price: price as Cents,
    categories: cats,
    billingPeriods: 4,
    ownerLagPeriods: lam,
    retainage: RETAINAGE[job.retainageKey]!,
    retainageReleasePeriods: lamR,
  };
}
