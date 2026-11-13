// Spec section 8: the defaults table as typed, dated data. Every row of section 8 is here with its name,
// value(s) in engine integer units, unit, jurisdiction, effective-from / effective-to, kind and source URL.
// The row metadata (id, name, value text, effective text, kind text, evidence, sources) is the spec text
// verbatim; the engine values are in VALUES below. test/cost-defaults.test.ts checks the table against
// the spec row for row (count + checksum of names), so nobody edits one side only.
//
// Rules (spec 8 intro, 12.1): rows marked *context* are shown for orientation and are never multiplied
// into a bid; lookups fail closed (a date or jurisdiction no row covers is refused, never guessed);
// every value used is reported with its date and URL. Builders at the bottom turn rows into the typed
// tables the engine modules take as parameters (payroll, bonds, retainage, payment timing, SBA fee).

import { compareDates, isoDate, refuse, type Cents, type IsoDate, type Ppm } from './money.js';
import type { AssumptionUsed, BondTier, PayrollTaxTable } from './types.js';
import type { BondRequirementTable, BondBand, LegalSource, SbaFeeTable } from './bonds.js';
import type { PaymentTimingPreset, RetainageRule } from './payment.js';
import { useAssumption } from './assumptions.js';

export type DefaultKind = 'law' | 'published_rate' | 'study' | 'rule_of_thumb' | 'guidance' | 'fact';
export type DefaultUnit = 'ppm' | 'cents' | 'days' | 'months' | 'count' | 'hoursC' | 'factor' | 'boolean' | 'rule' | 'text';

/** One dated value of a row, in engine units (Cents, Ppm, HoursC, ...); strings for exact decimals, rules and context text. */
export interface DefaultValue {
  readonly key: string;
  readonly value: number | string | boolean;
  readonly unit: DefaultUnit;
  /** 'US', 'NV', 'CA', 'WA', 'IA', or 'n/a' for mathematics. */
  readonly jurisdiction: string;
  /** First day in force; null = the source states no start date (in force when read). */
  readonly from: IsoDate | null;
  /** Last day in force; null = open-ended. */
  readonly to: IsoDate | null;
  readonly note?: string;
}

export interface DefaultRow {
  readonly id: string; // 'D-1' .. 'D-87'
  readonly section: string; // '8.1' .. '8.7'
  readonly name: string; // verbatim spec name
  readonly valueText: string; // verbatim spec value column
  readonly unitText: string;
  readonly jurisdictionText: string;
  readonly effectiveText: string;
  readonly kind: DefaultKind;
  readonly kindText: string; // verbatim spec kind
  readonly evidence: string; // R / X / S
  readonly sources: readonly string[]; // URLs
  /** *context* / *reference* rows: displayed for orientation, never multiplied into a bid. */
  readonly context: boolean;
  readonly values: readonly DefaultValue[];
}

/** Date the section 8 table was read (spec version 1, written 2026-11-13). */
export const DEFAULTS_READ_ON = '2026-11-13' as IsoDate;
/** Spec 8 row count; the integrity test also checks a checksum of `${id}|${name}`. */
export const DEFAULT_ROW_COUNT = 87;

type Meta = Omit<DefaultRow, 'values'>;

// ---------------------------------------------------------------- spec 8 rows, verbatim metadata
const META: readonly Meta[] = [
  { id: "D-1", section: "8.1", name: "Social Security, employer share", valueText: "6.2", unitText: "% of wages up to the wage base", jurisdictionText: "US", effectiveText: "2026; 2027 by statute", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.irs.gov/taxtopics/tc751"], context: false },
  { id: "D-2", section: "8.1", name: "Social Security wage base", valueText: "176,100 (2025); 184,500 (2026); 192,300 (2027)", unitText: "USD per employee per year", jurisdictionText: "US", effectiveText: "calendar year", kind: "law", kindText: "law", evidence: "X; 2027 from reports of the SSA announcement", sources: ["https://www.irs.gov/taxtopics/tc751","https://www.ssa.gov/oact/cola/cbb.html"], context: false },
  { id: "D-3", section: "8.1", name: "Medicare, employer share", valueText: "1.45, no wage cap. Additional Medicare 0.9% over $200,000 is employee-only (employer cost 0)", unitText: "% of wages", jurisdictionText: "US", effectiveText: "2026", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.irs.gov/taxtopics/tc751"], context: false },
  { id: "D-4", section: "8.1", name: "FUTA", valueText: "6.0 on the first 7,000; credit up to 5.4; net 0.6 where there is no credit reduction (at most $42.00 per employee)", unitText: "%; USD per employee per year", jurisdictionText: "US", effectiveText: "2025, 2026", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.irs.gov/taxtopics/tc759"], context: false },
  { id: "D-5", section: "8.1", name: "FUTA credit reduction", valueText: "0.3 points per year a state stays on the list (add-ons possible from the 3rd and 5th year); California 2025: 1.2 (net 1.8%, $126 per employee)", unitText: "% of FUTA wages", jurisdictionText: "US; California", effectiveText: "tax year 2025", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.irs.gov/businesses/small-businesses-self-employed/futa-credit-reduction","https://www.irs.gov/pub/irs-pdf/f940sa.pdf"], context: false },
  { id: "D-6", section: "8.1", name: "Nevada unemployment taxable wage base", valueText: "41,800 (2025); 43,700 (2026); 45,400 (2027)", unitText: "USD per employee per year", jurisdictionText: "Nevada", effectiveText: "calendar year", kind: "law", kindText: "law", evidence: "X", sources: ["https://detr.nv.gov/Page/UI_Tax"], context: false },
  { id: "D-7", section: "8.1", name: "Nevada unemployment rate", valueText: "new employer 2.95 (kept 14 to 17 quarters); experience-rated 0.25 to 5.40 (18 rates)", unitText: "% of taxable wages", jurisdictionText: "Nevada", effectiveText: "2026 schedule", kind: "law", kindText: "law", evidence: "X", sources: ["https://detr.nv.gov/Page/UI_Information_for_Employers"], context: false },
  { id: "D-8", section: "8.1", name: "Nevada Career Enhancement Program", valueText: "0.05; not owed by employers at the 5.4% rate (new employer total 3.00%)", unitText: "% of taxable wages", jurisdictionText: "Nevada", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://detr.nv.gov/Page/NUI_View_Quarterly_Reporting_Info"], context: false },
  { id: "D-9", section: "8.1", name: "Nevada Modified Business Tax, general business", valueText: "1.17 of quarterly gross wages less employer-paid health benefits, above 50,000 per quarter per employer", unitText: "%; USD", jurisdictionText: "Nevada", effectiveText: "since 2023-07-01", kind: "law", kindText: "law", evidence: "X", sources: ["https://tax.nv.gov/tax-types/modified-business-tax/"], context: false },
  { id: "D-10", section: "8.1", name: "California unemployment", valueText: "wage base 7,000; new employer 3.4; 2026 schedule F+ 1.5 to 6.2 (at most $434 per employee)", unitText: "USD; %", jurisdictionText: "California", effectiveText: "2026", kind: "law", kindText: "law", evidence: "X", sources: ["https://edd.ca.gov/en/payroll_taxes/rates_and_withholding/"], context: false },
  { id: "D-11", section: "8.1", name: "California ETT and SDI", valueText: "ETT 0.1 on the first 7,000 (at most $7); SDI 1.3 (2026), 1.2 (2025), no cap, withheld from the employee (employer cost 0)", unitText: "%", jurisdictionText: "California", effectiveText: "2026; 2025", kind: "law", kindText: "law", evidence: "X", sources: ["https://edd.ca.gov/en/payroll_taxes/rates_and_withholding/"], context: false },
  { id: "D-17", section: "8.1", name: "Federal employment-tax deposits, monthly depositor", valueText: "by the 15th of the following month; monthly schedule when lookback taxes are 50,000 or less", unitText: "date; USD", jurisdictionText: "US", effectiveText: "2026", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.irs.gov/publications/p15"], context: false },
  { id: "D-18", section: "8.1", name: "Per-paycheck rounding differs from the total", valueText: "IRS \"fractions-of-cents\" adjustment exists", unitText: "rule", jurisdictionText: "US", effectiveText: "2026", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.irs.gov/publications/p15"], context: false },
  { id: "D-12", section: "8.2", name: "Nevada workers' comp payroll cap", valueText: "36,000 per employee per policy year under the statute in force through 2026-09-30; 12 x maximum average monthly wage = 98,433.60 for new and renewal policies from 2026-10-01; re-set each 1 January", unitText: "USD", jurisdictionText: "Nevada", effectiveText: "by policy effective date", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.leg.state.nv.us/nrs/NRS-616B.html","https://dir.nv.gov/uploadedFiles/dirnvgov/content/WCS/ImportantDocs/FYI-DR-NV-2026-01.pdf"], context: false },
  { id: "D-13", section: "8.2", name: "Nevada premium payroll includes overtime pay", valueText: "no exclusion of the overtime premium (corrected by the verifier); confirm with the carrier", unitText: "rule", jurisdictionText: "Nevada", effectiveText: "current", kind: "law", kindText: "law (NAC 616A.200)", evidence: "X", sources: ["https://www.leg.state.nv.us/nac/nac-616a.html"], context: false },
  { id: "D-14", section: "8.2", name: "California electrical dual-wage threshold", valueText: "40.00 (was 36.00): class 5140 at or above, 5190 below", unitText: "USD per hour, regular hourly wage", jurisdictionText: "California", effectiveText: "policies effective on or after 2026-09-01", kind: "law", kindText: "regulation", evidence: "X", sources: ["https://www.wcirb.com/filings-and-plans/usrp-erp-and-miscellaneous-regulations/september-1-2026-regulatory-filing-quick-reference-guide-usrp-and-erp-changes"], context: false },
  { id: "D-15", section: "8.2", name: "California advisory pure premium rates (*context*; loss-only benchmark, not what an insurer charges)", valueText: "all-class average 1.65; class 5190 3.729; class 5140 2.109", unitText: "USD per $100 of payroll", jurisdictionText: "California", effectiveText: "policies from 2026-09-01", kind: "published_rate", kindText: "rate", evidence: "average X; class values S", sources: ["https://www.insurance.ca.gov/0400-news/0100-press-releases/2026/upload/Workers-Comp-Decision-and-Order-7-10-26.pdf","https://wcirb.com/class-search/electrical-wiring-low-wage"], context: true },
  { id: "D-16", section: "8.2", name: "Nevada loss-cost level changes (*context*)", valueText: "+6.5% (2025-03-01); +21.6% (2026-03-01); -32.8% (2026-10-01, paired with the larger payroll base)", unitText: "% change, overall voluntary market", jurisdictionText: "Nevada", effectiveText: "as dated", kind: "published_rate", kindText: "rate", evidence: "X for 2025; S (trade press) for 2026", sources: ["https://doi.nv.gov/Insurers/Property-Casualty/Filing-Information/Workers-Compensation/"], context: true },
  { id: "D-19", section: "8.3", name: "FLSA overtime", valueText: "1.5 x regular rate over 40 hours per workweek; bona fide plan contributions excluded from the regular rate", unitText: "multiple", jurisdictionText: "US", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title29-section207&num=0&edition=prelim"], context: false },
  { id: "D-20", section: "8.3", name: "Davis-Bacon fringe obligation", valueText: "basic rate + fringe may be met with cash, bona fide plan contributions, or a mix; plan credit annualized over all hours worked, with exceptions", unitText: "rule", jurisdictionText: "US", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.dol.gov/agencies/whd/fact-sheets/66E-DBRA-compliance-fringe-benefit-requirements"], context: false },
  { id: "D-21", section: "8.3", name: "Davis-Bacon overtime arithmetic", valueText: "fringe at straight rate on every hour; half-time premium on the basic rate", unitText: "rule", jurisdictionText: "US", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.dol.gov/agencies/whd/government-contracts/prevailing-wage-resource-book/db-compliance-principles"], context: false },
  { id: "D-22", section: "8.3", name: "California private overtime (Labor Code 510)", valueText: "1.5x over 8 per day, over 40 per week, first 8 hours of the 7th day of work in the workweek; 2x over 12 per day and over 8 on that 7th day", unitText: "multiple of regular rate", jurisdictionText: "California", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=510"], context: false },
  { id: "D-23", section: "8.3", name: "California public works overtime (Labor Code 1815)", valueText: "1.5 x basic rate over 8 per day and 40 per week; employer payments at straight rate", unitText: "multiple of basic rate", jurisdictionText: "California", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=1815.","https://www.dir.ca.gov/dlse/PWManualCombined.pdf"], context: false },
  { id: "D-24", section: "8.3", name: "Nevada private overtime (NRS 608.018)", valueText: "1.5x over 40 per week; over 8 per workday only below 1.5 x minimum wage (4x10 exception)", unitText: "multiple of regular wage rate", jurisdictionText: "Nevada", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.leg.state.nv.us/NRS/NRS-608.html"], context: false },
  { id: "D-25", section: "8.3", name: "Nevada public works overtime (NRS 338.020)", valueText: "1.5 x prevailing rate of wages (base + fringe per the Labor Commissioner's handbook) over 40 per week or 8 per workday; 4x10 and collective-agreement exceptions", unitText: "multiple", jurisdictionText: "Nevada", effectiveText: "handbook rev. 2026-07-22", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.leg.state.nv.us/nrs/NRS-338.html"], context: false },
  { id: "D-26", section: "8.3", name: "Minimum wage-payment frequency", valueText: "Nevada semimonthly (NRS 608.060); California twice per calendar month (Labor Code 204)", unitText: "frequency", jurisdictionText: "Nevada; California", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.leg.state.nv.us/NRS/NRS-608.html","https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=204"], context: false },
  { id: "D-27", section: "8.3", name: "CWHSSA coverage (corrected)", valueText: "only contracts over 100,000 (over 150,000 for contracts under federal acquisition rules); at or below, FLSA overtime applies", unitText: "USD", jurisdictionText: "US", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title40-section3702&num=0&edition=prelim","https://www.dol.gov/agencies/whd/government-contracts/prevailing-wage-resource-book/dbra-coverage"], context: false },
  { id: "D-28", section: "8.3", name: "Nevada minimum wage and daily-overtime threshold", valueText: "12.00; daily overtime only for employees earning less than 18.00", unitText: "USD per hour", jurisdictionText: "Nevada", effectiveText: "bulletin effective 2026-07-01", kind: "law", kindText: "law", evidence: "X", sources: ["https://labor.nv.gov/uploadedFiles/labornvgov/content/Employer/26.06.29%20Annual%20Bulletin%20-%20Daily%20Overtime.pdf"], context: false },
  { id: "D-29", section: "8.3", name: "Davis-Bacon wage payment", valueText: "not less often than once a week", unitText: "frequency", jurisdictionText: "US federal and federally assisted construction", effectiveText: "current (29 CFR 5.5)", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.ecfr.gov/current/title-29/part-5"], context: false },
  { id: "D-30", section: "8.3", name: "Nevada prevailing-wage project threshold", valueText: "NRS 338.020 to 338.090 do not apply when the estimated cost is less than 100,000 (\"except as otherwise provided in NRS 226.826\")", unitText: "USD estimated cost", jurisdictionText: "Nevada", effectiveText: "current (NRS 338.080)", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.leg.state.nv.us/nrs/NRS-338.html"], context: false },
  { id: "D-31", section: "8.3", name: "Nevada annualization exceptions (NRS 338.035)", valueText: "benefits set by a collective bargaining agreement; or defined-contribution plan contributions up to 25% of the hourly prevailing rate", unitText: "%", jurisdictionText: "Nevada", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.leg.state.nv.us/nrs/NRS-338.html"], context: false },
  { id: "D-32", section: "8.4", name: "Federal performance and payment bonds", valueText: "contract exceeding 150,000; performance 100% of the original price plus 100% of increases; payment 100% (statute text: more than 100,000)", unitText: "USD; %", jurisdictionText: "US federal", effectiveText: "current FAR", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.acquisition.gov/far/28.102-1","https://www.acquisition.gov/far/28.102-2"], context: false },
  { id: "D-33", section: "8.4", name: "Federal payment protection band", valueText: "exceeding 35,000 and not exceeding 150,000: payment bond or alternative protection at 100%", unitText: "USD", jurisdictionText: "US federal", effectiveText: "current FAR", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.acquisition.gov/far/28.102-1"], context: false },
  { id: "D-34", section: "8.4", name: "Federal bid guarantee", valueText: "at least 20% of the bid price, at most 3,000,000; only when a performance bond is also required; on default the bidder owes the excess cost over its bid", unitText: "%; USD", jurisdictionText: "US federal", effectiveText: "current FAR", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.acquisition.gov/far/28.101-2","https://www.acquisition.gov/far/52.228-1"], context: false },
  { id: "D-35", section: "8.4", name: "Nevada bonds and bid security", valueText: "NRS 339.025: contract exceeding 100,000 (not NRS 408 work), performance and payment each not less than 50%, for State, county, city, town, school district; State Public Works subs over max(50,000, 1% of project) bond to the Division; State Public Works bid security at least 5% of base bid plus alternates for bids over 100,000; NDOT bid security at least 5%, bonds equal to the full contract amount", unitText: "USD; %", jurisdictionText: "Nevada", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.leg.state.nv.us/nrs/NRS-339.html","https://www.leg.state.nv.us/nac/nac-341.html","https://www.leg.state.nv.us/nrs/NRS-408.html"], context: false },
  { id: "D-36", section: "8.4", name: "California bonds and bid security", valueText: "payment bond for expenditure over 25,000, at 100% of the amount payable; bid security at least 10% of the amount bid (state and cities); State Contract Act bonds at least 50% each", unitText: "USD; %", jurisdictionText: "California", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=9550.","https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PCC&sectionNum=10167."], context: false },
  { id: "D-37", section: "8.4", name: "SBA surety bond guarantee (corrected)", valueText: "contractor fee 6.00 per 1,000 of contract price for guarantees approved before 2026-11-30, 7.29 per 1,000 on or after; rounded to the nearest dollar; no fee on bid-bond guarantees; contract limit 9,000,000 (14,000,000 federal with certification); Quick Bond 500,000 or less", unitText: "USD", jurisdictionText: "US", effectiveText: "as dated", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.federalregister.gov/documents/2026/10/30/2026-22177/surety-bond-guarantee-program-fees","https://www.sba.gov/funding-programs/surety-bonds"], context: false },
  { id: "D-38", section: "8.4", name: "Sample tiered bond rates, Class B (lists Electrical), non-deviating (**illustrative; shown as an assumption; never a quote**)", valueText: "first 100,000: 25.00; next 400,000: 15.00; next 2,000,000: 10.00; next 2,500,000: 7.50; next 2,500,000: 7.00; over 7,500,000: 6.50. Deviating sample: 10.00 / 8.00 / 7.00 / 6.00 / 5.00 / 4.50", unitText: "USD per $1,000 of contract price, 12 months or less", jurisdictionText: "US advisory sample", effectiveText: "2010 table; first three tiers repeated in the 2026 example", kind: "published_rate", kindText: "rate", evidence: "tiers 1 to 4 R; tier 5 corrected from the printed 7.50 by two independent government-hosted sources; tier 6 6.50 (a 2006 source shows 6.00)", sources: ["https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ARCHIVES/ufc_3_740_05_2010_c1.pdf","https://www.fhwa.dot.gov/publications/research/infrastructure/14034/003.cfm"], context: false },
  { id: "D-39", section: "8.4", name: "Bond premium duration surcharge", valueText: "non-deviating: 1% of premium per month over 12; deviating: 0.5% per month for months 13 to 24 and 1% after 24; five states use a 24-month table", unitText: "% of premium per month", jurisdictionText: "US (surety manual rules as described by DoD)", effectiveText: "2026-02-02", kind: "published_rate", kindText: "rate", evidence: "R", sources: ["https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ufs_3_740_05_2026.pdf"], context: false },
  { id: "D-40", section: "8.4", name: "Federally funded state and local construction (2 CFR 200.326)", valueText: "bid guarantee 5% of bid price; performance and payment bonds 100% each", unitText: "%", jurisdictionText: "US grants, above the simplified acquisition threshold", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.ecfr.gov/current/title-2/part-200"], context: false },
  { id: "D-41", section: "8.4", name: "Bond premium ranges (*context*)", valueText: "1.5% to 3.0% of contract amount; 1% to 3% of bond amount; reported one-time premiums: $100,000 contract $1,200 to $2,500, $1M $7,700 to $13,500, $10M $56,950 to $81,000, $50M $206,475 to $341,000; state DOT survey under $100,000: 0.22 / 1.06 / 2.5% low / average / high", unitText: "%; USD", jurisdictionText: "US", effectiveText: "2014 for the dollar table", kind: "study", kindText: "study", evidence: "X", sources: ["https://www.congress.gov/crs-product/R42037","https://www.fhwa.dot.gov/publications/research/infrastructure/14034/003.cfm"], context: true },
  { id: "D-42", section: "8.4", name: "How premiums are set", valueText: "sureties file their own rates (no state-set rate); the premium is usually based on the contract amount and duration", unitText: "rule", jurisdictionText: "Texas page; US study", effectiveText: "current", kind: "law", kindText: "law / study", evidence: "X", sources: ["https://www.tdi.texas.gov/commercial/pcbond.html"], context: false },
  { id: "D-43", section: "8.5", name: "Federal retainage", valueText: "none when progress is satisfactory; at most 10% of the payment otherwise; total not above 10% of the approved estimated amount", unitText: "%", jurisdictionText: "US federal", effectiveText: "current FAR", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.acquisition.gov/far/52.232-5","https://www.acquisition.gov/far/32.103"], context: false },
  { id: "D-44", section: "8.5", name: "Federal construction payments", valueText: "monthly progress payments; due 14 days after a proper request; final payment 30 days; retained amounts 30 days after approval of release unless the contract says otherwise; subs paid within 7 days; small-business accelerated-payment goal 15 days", unitText: "days", jurisdictionText: "US federal", effectiveText: "current FAR", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.acquisition.gov/far/32.904","https://www.acquisition.gov/far/52.232-27"], context: false },
  { id: "D-45", section: "8.5", name: "Federal bond-premium reimbursement", valueText: "on request, inside progress payments, after proof of payment to the surety", unitText: "rule", jurisdictionText: "US federal", effectiveText: "current FAR", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.acquisition.gov/far/52.232-5"], context: false },
  { id: "D-46", section: "8.5", name: "Prompt Payment Act interest", valueText: "4.75 (2026-07-01 to 2026-12-31); 4.125 (Jan to Jun 2026); 4.625 (Jul to Dec 2025); simple formula `P * r/360 * d`; the rate in effect the day after the due date applies", unitText: "% per year", jurisdictionText: "US federal", effectiveText: "as dated", kind: "published_rate", kindText: "rate / law", evidence: "X", sources: ["https://fiscal.treasury.gov/payments-from-government/prompt-payment/rates","https://www.ecfr.gov/current/title-5/section-1315.17"], context: false },
  { id: "D-47", section: "8.5", name: "Federal liquidated damages", valueText: "a rate per day of delay stated in the contract", unitText: "USD per calendar day", jurisdictionText: "US federal", effectiveText: "current FAR", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.acquisition.gov/far/11.502"], context: false },
  { id: "D-48", section: "8.5", name: "Nevada public works progress payments (NRS 338.515)", valueText: "due within 30 days after the public body receives the progress bill (or sooner per contract); 5% withheld until 50% of the work is performed", unitText: "days; %", jurisdictionText: "Nevada", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.leg.state.nv.us/nrs/NRS-338.html"], context: false },
  { id: "D-49", section: "8.5", name: "Nevada retainage after 50% (corrected)", valueText: "the public body may pay without further retainage; if it keeps withholding: at most 2.5% per payment after first paying 50% of the retainage withheld so far, or at most 5% (keeping earlier retainage) when it withholds under NRS 338.525", unitText: "%", jurisdictionText: "Nevada", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.leg.state.nv.us/nrs/NRS-338.html"], context: false },
  { id: "D-50", section: "8.5", name: "Nevada interest on retainage and pay-down", valueText: "interest paid quarterly at a bank-quoted rate; contractor and subcontractors pay lower tiers within 10 days of receiving money; the same 2.5% and half-release rule applies prime-to-sub", unitText: "rule; days", jurisdictionText: "Nevada", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.leg.state.nv.us/nrs/NRS-338.html"], context: false },
  { id: "D-51", section: "8.5", name: "NDOT payments (corrected)", valueText: "progress payments not more than 95% of the contract price; the retained 5% is not more than 50,000", unitText: "%; USD", jurisdictionText: "Nevada DOT", effectiveText: "current (NRS 408)", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.leg.state.nv.us/nrs/NRS-408.html"], context: false },
  { id: "D-52", section: "8.5", name: "California retention", valueText: "at most 5% of each payment and 5% of the contract price (more only if found \"substantially complex\" and stated in the bid documents); local agencies not less than 5%, may pay in full after 50%; Caltrans transportation projects none", unitText: "%", jurisdictionText: "California", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PCC&sectionNum=7201"], context: false },
  { id: "D-53", section: "8.5", name: "California payment timing", valueText: "progress payment within 30 days of an undisputed proper request (7 days to return an improper one); late interest 10% per year; retention released within 60 days of completion (150% of a disputed amount may be withheld); subs paid within 7 days, 2% per month penalty", unitText: "days; %", jurisdictionText: "California", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PCC&sectionNum=20104.50","https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PCC&sectionNum=7107"], context: false },
  { id: "D-54", section: "8.5", name: "California delay damages", valueText: "enforceable only if liquidated to a set amount identified in the contract", unitText: "rule", jurisdictionText: "California", effectiveText: "contracts from 2016-01-01", kind: "law", kindText: "law", evidence: "X", sources: ["https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PCC&sectionNum=7203."], context: false },
  { id: "D-55", section: "8.5", name: "SBA 7(a) maximum variable rates", valueText: "base + 6.5 points (loans of 50,000 or less); + 6.0 (to 250,000); + 4.5 (to 350,000); + 3.0 (above 350,000)", unitText: "percentage points", jurisdictionText: "US", effectiveText: "current (13 CFR 120.214)", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.ecfr.gov/current/title-13/section-120.214"], context: false },
  { id: "D-56", section: "8.5", name: "Typical supplier net terms (*context*)", valueText: "net 30 and net 60", unitText: "days", jurisdictionText: "US, general trade", effectiveText: "current", kind: "rule_of_thumb", kindText: "thumb", evidence: "X", sources: ["https://sba.gov/blog/top-10-business-credit-terms-small-business-owners-should-know"], context: true },
  { id: "D-57", section: "8.5", name: "State capacity rules (*context*; analogues, not surety practice)", valueText: "South Dakota: at most 10 x working capital; Tennessee: 10 x the lesser of working capital and net worth; Washington: 5.0 x net worth; Illinois: 10, 11 or 12 x allowable net current assets, real estate and equipment; Kentucky: 12 x net current assets plus 6 x equipment book value", unitText: "multiple", jurisdictionText: "as named", effectiveText: "current", kind: "law", kindText: "law (prequalification or licensing rules)", evidence: "X", sources: ["https://sdlegislature.gov/Rules/Administrative/70:07:02:09","https://ilga.gov/agencies/JCAR/EntirePart?titlepart=04400650"], context: true },
  { id: "D-58", section: "8.5", name: "Staged mobilization payment (*context*, example of the pattern)", valueText: "25% of the mobilization item once 5% of the original contract amount is complete", unitText: "%", jurisdictionText: "Iowa specification; not Nevada", effectiveText: "current", kind: "published_rate", kindText: "rate", evidence: "X", sources: ["https://ia.iowadot.gov/erl/current/US/content/11020.htm"], context: true },
  { id: "D-60", section: "8.5", name: "Bank prime loan rate (*context*)", valueText: "7.00", unitText: "% per year", jurisdictionText: "US", effectiveText: "observation of 2026-10-09 (release of 2026-10-16); refresh before use", kind: "published_rate", kindText: "rate", evidence: "X", sources: ["https://www.federalreserve.gov/releases/h15/"], context: true },
  { id: "D-59", section: "8.6", name: "Small-business size standard, NAICS 238210", valueText: "19.0", unitText: "million USD average annual receipts", jurisdictionText: "US", effectiveText: "current (13 CFR 121.201)", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.ecfr.gov/current/title-13/section-121.201"], context: false },
  { id: "D-61", section: "8.6", name: "Nevada sales-tax rounding (NRS 372.366)", valueText: "computed to the third decimal place; rounded up to the next cent if the third decimal is greater than 4; per item or per invoice", unitText: "rule", jurisdictionText: "Nevada", effectiveText: "2025 NRS", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.leg.state.nv.us/NRS/NRS-372.html"], context: false },
  { id: "D-62", section: "8.6", name: "Unit price governs over the extension", valueText: "\"the unit bid prices shall govern\"", unitText: "rule", jurisdictionText: "Nevada DOT contracts", effectiveText: "2014 Standard Specifications", kind: "law", kindText: "contract specification", evidence: "X", sources: ["https://www.dot.nv.gov/home/showpublisheddocument/6916/636257041112930000"], context: false },
  { id: "D-63", section: "8.6", name: "Half-even rounding exists in regulation", valueText: "984.50 becomes 984; 985.50 becomes 986", unitText: "rule", jurisdictionText: "US model regulation", effectiveText: "2025", kind: "published_rate", kindText: "rate", evidence: "X", sources: ["https://nvlpubs.nist.gov/nistpubs/hb/2025/NIST.HB.130-2025.pdf"], context: false },
  { id: "D-64", section: "8.6", name: "JavaScript number limits", valueText: "largest exact integer 9,007,199,254,740,991; `Math.round` sends ties toward +infinity", unitText: "integer", jurisdictionText: "n/a", effectiveText: "n/a", kind: "fact", kindText: "engineering fact", evidence: "R", sources: ["https://github.com/mdn/content/blob/main/files/en-us/web/javascript/reference/global_objects/number/max_safe_integer/index.md"], context: false },
  { id: "D-65", section: "8.6", name: "Overhead and profit ranges (*context only, never defaults*)", valueText: "home-office overhead 3% (large) to 10% (small contractors) of contract amount; overhead 7% to 20% of volume of work; profit 3% to 10% of direct plus indirect cost", unitText: "% of **revenue** for the overhead figures", jurisdictionText: "US Army (1997 text, cancelled); state DOT estimating guides", effectiveText: "as dated", kind: "rule_of_thumb", kindText: "thumb", evidence: "R (Army); X (state guides; one verification pass could not confirm them)", sources: ["https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ARCHIVES/ufc_3_700_02a_2005.pdf","https://apps.itd.idaho.gov/apps/manuals/Const-Cost-Estimating-Guide.pdf"], context: true },
  { id: "D-66", section: "8.6", name: "Small tools allowance", valueText: "typically 2% of direct labor cost for the prime contractor (1997 text: up to 12%); must not also be in overhead", unitText: "%", jurisdictionText: "US DoD estimating guidance", effectiveText: "2026-02-02", kind: "published_rate", kindText: "rate", evidence: "R", sources: ["https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ufs_3_740_05_2026.pdf"], context: false },
  { id: "D-67", section: "8.6", name: "DoD weighted-guidelines profit (*reference calculator*; Government estimates and negotiated changes, not a cap on a bid)", valueText: "each of 7 factors weighted 0.03 to 0.12, so profit 3% to 12%; size-of-job weight 0.12 at 100,000 or less, linear to 0.05 at 5,000,000, 0.04 for 5 to 10 million, 0.03 above; factor rates 20/15/15/15/5/5/25 (historical, from the cancelled 2005 edition)", unitText: "weight; %", jurisdictionText: "US DoD", effectiveText: "2026-02-02 (weights); 2005 (rates)", kind: "published_rate", kindText: "rate", evidence: "R", sources: ["https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ufs_3_740_05_2026.pdf"], context: true },
  { id: "D-68", section: "8.6", name: "Change-order markup limits (*context*; specific owners; **never applied to a bid**)", valueText: "GSA: profit at most 10%, subcontracted work at 50% of own rates and at most 10% combined; VA: 10 / 7.5 / 5% on the first 20,000 / next 30,000 / balance, for changes of 500,000 or less; NASA: 10 / 10 / 10; Caltrans force account: labor 35%, equipment 15%, materials 15%, subcontractor +10%", unitText: "%", jurisdictionText: "owner-specific", effectiveText: "as dated", kind: "law", kindText: "law (contract clauses)", evidence: "X / S", sources: ["https://www.acquisition.gov/gsam/552.243-71","https://www.ecfr.gov/current/title-48/chapter-8/subchapter-H/part-852/subpart-852.2/section-852.243-70"], context: true },
  { id: "D-69", section: "8.6", name: "FEMA cost-estimating factors (*context*, owner side)", valueText: "contractor home-office overhead 7.7%; insurance and bonds 3.3% in total", unitText: "%", jurisdictionText: "US FEMA", effectiveText: "1999-era tool", kind: "published_rate", kindText: "rate", evidence: "S", sources: ["https://www.fema.gov/sites/default/files/documents/fema_pa-cef-instructional-guide.pdf"], context: true },
  { id: "D-70", section: "8.6", name: "Nevada small public works solicitation (NRS 338.13862)", valueText: "estimated cost over 25,000 up to 100,000: at least three licensed contractors; 25,000 or less: at least one", unitText: "contractors solicited", jurisdictionText: "Nevada", effectiveText: "2025 NRS", kind: "law", kindText: "law", evidence: "X", sources: ["https://law.justia.com/codes/nevada/chapter-338/statute-338-13862/"], context: false },
  { id: "D-71", section: "8.6", name: "Nevada bidder preferences", valueText: "5% on public works with estimated cost over 250,000 (certificate of eligibility plus affidavit within 2 hours of opening); on State public works under 250,000 a qualifying veteran-owned local business's bid is deemed 5% lower", unitText: "%", jurisdictionText: "Nevada", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.leg.state.nv.us/nrs/NRS-338.html"], context: false },
  { id: "D-72", section: "8.6", name: "Federal award rule and HUBZone preference (corrected)", valueText: "award on price and price-related factors to the responsible bidder with the conforming bid most advantageous to the Government; HUBZone: 10% added to offers other than non-waiving HUBZone small businesses and otherwise-successful small businesses", unitText: "%", jurisdictionText: "US federal", effectiveText: "current", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.acquisition.gov/far/14.408-1","https://www.ecfr.gov/current/title-48/section-19.1307"], context: false },
  { id: "D-73", section: "8.6", name: "Federal construction magnitude ranges", valueText: "under 25,000; 25,000 to 100,000; 100,000 to 250,000; 250,000 to 500,000; 500,000 to 1,000,000; 1 to 5 million; 5 to 10 million; over 10 million", unitText: "USD", jurisdictionText: "US federal", effectiveText: "current (FAR 36.204)", kind: "law", kindText: "law", evidence: "X", sources: ["https://www.acquisition.gov/far/36.204"], context: false },
  { id: "D-74", section: "8.6", name: "Owner-side award guidelines by number of bids (*legacy guidance*)", valueText: "FHWA 2004 table: 1 bid 100%, 2: 105%, 3: 110%, 4: 115%, 5: 120% of the engineer's estimate; Washington DOT: 3 or more 110%, 4 or more 115%, 5 or more 120%; FHWA legacy accuracy target: estimate within 10% of the low bid for at least half of projects", unitText: "% of engineer's estimate", jurisdictionText: "US federal-aid highway; Washington", effectiveText: "2004 text (dropped in 2021); manual as indexed", kind: "guidance", kindText: "guidance", evidence: "R (FHWA); X (Washington)", sources: ["https://www.fhwa.dot.gov/programadmin/contracts/cacc.pdf","https://www.wsdot.wa.gov/publications/manuals/fulltext/m27-02/adandaward.pdf"], context: false },
  { id: "D-75", section: "8.6", name: "Low bid versus engineer's estimate by number of bidders (*context*; highway work)", valueText: "Washington FY1985: 1 to 2 bidders +9 to +10%, 3 to 5 +1 to +2%, 6 or more -2 to -4%. Washington 2017 to 2024: +65.5 / +10.3 / +3.9 / -3.0 / -5.5% for 1 / 2 / 3 / 4 / 5 or more (mapping inferred from chart order). Colorado 2011 to 2015: -0.90, -2.53, +1.78, -0.22, -5.23, -4.32, -5.48, -8.13% for 1 to 7 and 8 or more. Kentucky 2018 to 2023, awarded over estimate: 100.5, 93.5, 93.2, 92.1% for 1 to 4 bidders (the printed average is not the mean of the year columns). Maine, large one-bid projects: +15%", unitText: "%", jurisdictionText: "as named", effectiveText: "as dated", kind: "study", kindText: "study", evidence: "R (Colorado); X (others)", sources: ["https://www.codot.gov/business/eema/assets/fhwa-validation-of-project-level-construction-cost-index-estimation-methodology.pdf","https://apps.legislature.ky.gov/lrc/publications/ResearchReports/RR488.pdf"], context: true },
  { id: "D-76", section: "8.6", name: "Statistical constants", valueText: "expected maximum of N standard normals 0.5642, 0.8463, 1.0294, 1.1630, 1.2672, 1.3522, 1.4236 (N = 2 to 8), 1.5388 (N = 10); kernel bandwidth 0.9 x min(s, IQR/1.34) x n^(-1/5); logistic models: at least 10 events per predictor", unitText: "number", jurisdictionText: "mathematics / statistics", effectiveText: "n/a", kind: "fact", kindText: "mathematics; thumb", evidence: "recomputed by the verifier", sources: ["https://www.itl.nist.gov/div898/software/dataplot/refman1/auxillar/kernplot.htm","https://doi.org/10.1016/s0895-4356(96)00236-3"], context: false },
  { id: "D-77", section: "8.7", name: "DoD escalation table (*reference*; budget guidance, not a forecast)", valueText: "projected rates FY2026 2.1%, FY2027 onward 2.0%; factors 1.021 (1 Oct 2026), 1.04142, 1.0622484, 1.083493368, 1.10516323536, 1.1272665000672 (base 1 Oct 2025 = 1); Selling Price Index Oct 2023 172.87, Oct 2024 179.05, Oct 2025 186.35 (Oct 2007 = 100); assumed midpoint: halfway through a 15-month project awarded in March", unitText: "%; factor; index", jurisdictionText: "US DoD", effectiveText: "guidance dated 2026-03-25", kind: "published_rate", kindText: "rate", evidence: "R", sources: ["https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ufs_3_701_01_2026_Data_Tables.xlsx"], context: true },
  { id: "D-78", section: "8.7", name: "DoD Area Cost Factors, MILCON / Sustainment (*context only*)", valueText: "NAS Fallon 1.20 / 1.21; Nellis 1.17 / 1.22; Creech 1.23 / 1.27; Hawthorne 1.30 / 1.31; Carson City and Reno 1.17 / 1.19; Las Vegas (non-Nellis) 1.13 / 1.17; Travis 1.27 / 1.33; Beale 1.22 / 1.27; Sierra Army Depot 1.26 / 1.31; Bridgeport 1.27 / 1.32; Sacramento 1.18 / 1.22; San Diego 1.13 / 1.18; Camp Pendleton 1.11 / 1.15; Los Angeles AFB 1.11 / 1.16; San Francisco 1.32 / 1.38. Basket weights materials / labor / equipment 63 / 35 / 2 (MILCON), 46 / 53 / 1 (Sustainment)", unitText: "factor, national average = 1.00", jurisdictionText: "Nevada; California", effectiveText: "2026 edition; workbook saved 2026-06-08 (re-download before use)", kind: "published_rate", kindText: "rate", evidence: "R", sources: ["https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ufs_3_701_01_2026_Data_Tables.xlsx"], context: true },
  { id: "D-79", section: "8.7", name: "BLS PPI values, May 2025 to May 2026 (final)", valueText: "WPU10260314 459.176 to 564.877 (Sep 2026 607.705 preliminary); WPU11710216 204.296 to 207.695; WPU1175 374.197 to 413.241; WPU1083 235.199 to 243.385; PCU23821X23821X 171.680 to 178.148; WPUIP2312001 164.704 to 179.556; PCU236223236223 210.845 to 218.935; all indexes revisable up to four months after publication", unitText: "index", jurisdictionText: "US national", effectiveText: "pulled 2026-11-13", kind: "study", kindText: "study", evidence: "R (API)", sources: ["https://api.bls.gov/publicAPI/v2/timeseries/data/"], context: false },
  { id: "D-80", section: "8.7", name: "BLS OEWS electricians (47-2111), hourly", valueText: "mean: US 34.37; Nevada 36.40; Reno 35.20; Carson City 40.86; Balance of Nevada nonmetropolitan 38.81; Las Vegas 36.16; California 41.28; Sacramento 38.40. Nevada percentiles: p10 22.17, p25 23.52, median 35.37, p75 46.42, p90 58.27", unitText: "USD per hour, straight time, no benefits", jurisdictionText: "as named (area names not verified)", effectiveText: "May 2025", kind: "study", kindText: "study", evidence: "R (API)", sources: ["https://api.bls.gov/publicAPI/v2/timeseries/data/"], context: false },
  { id: "D-81", section: "8.7", name: "FHWA National Highway Construction Cost Index (*context*; highway bid items only)", valueText: "2003 Q1 = 1; 2025 Q1 3.162838217; 2026 Q1 3.134822428", unitText: "index", jurisdictionText: "US national", effectiveText: "fetched 2026-11-13", kind: "study", kindText: "study", evidence: "R", sources: ["https://data.transportation.gov/resource/r94d-n4f9.json"], context: true },
  { id: "D-82", section: "8.7", name: "Price-adjustment clause parameters", valueText: "FHWA advisory: trigger 3% to 10% (5% suggested by AASHTO), ceiling 25% to 100% increase from the material's base price; FAR 52.216-4: increases at most 10% of the original unit price, no adjustment below a 3% net change of the then-current total contract price", unitText: "%", jurisdictionText: "US federal-aid guidance (1980); federal contracts with the clause", effectiveText: "as dated", kind: "guidance", kindText: "guidance; law", evidence: "R", sources: ["https://www.fhwa.dot.gov/programadmin/contracts/ta50803.cfm","https://raw.githubusercontent.com/GSA/GSA-Acquisition-FAR/master/dita/52.216-4.dita"], context: false },
  { id: "D-83", section: "8.7", name: "Midpoint-of-construction convention", valueText: "escalate to the midpoint of construction; with a cost-loaded schedule, by activity", unitText: "rule", jurisdictionText: "US DoD; GSA", effectiveText: "2026-02-02; 2022-11-07", kind: "guidance", kindText: "guidance", evidence: "R", sources: ["https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ufs_3_740_05_2026.pdf","https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/GSA/p120_2022.pdf"], context: false },
  { id: "D-84", section: "8.7", name: "Caltrans cost index (for adjusting Caltrans rows only)", valueText: "2020 = 100; 2024 Q1 to Q4: 190.72, 168.45, 197.13, 141.33; 2025: 210.72, 204.25, 166.63, 149.76; 2026 Q1 126.75, Q2 146.53 (also the site's \"current\" index); adjustment uses the bid-open quarter", unitText: "index", jurisdictionText: "California", effectiveText: "read 2026-11-12", kind: "published_rate", kindText: "rate", evidence: "R", sources: ["https://sv08data.dot.ca.gov/indexes.php"], context: false },
  { id: "D-85", section: "8.7", name: "Agency rules of thumb for reading bid data", valueText: "at least 20 results for a usable average; average not representative when the standard deviation exceeds the minimum or average price; compare quantities within an order of magnitude; bids treated as normal from 20% under to 10% over the engineer's estimate", unitText: "rows; %", jurisdictionText: "California (district guidance)", effectiveText: "read 2026-11-12", kind: "rule_of_thumb", kindText: "thumb", evidence: "R", sources: ["https://sv08data.dot.ca.gov/searchtips.php"], context: false },
  { id: "D-86", section: "8.7", name: "Federal electrical awards in Nevada, size distribution (*context*; thin sample)", valueText: "n = 36; min 3,380.00; p25 12,271.75; median 38,209.62; p75 82,771.61; p90 166,702.02; max 2,838,934.31 (dollars obligated to date)", unitText: "USD per award", jurisdictionText: "Nevada, federal awards, NAICS 238210", effectiveText: "2024-11-13 to 2026-11-13", kind: "study", kindText: "study", evidence: "R (API re-run)", sources: ["https://api.usaspending.gov/api/v2/search/spending_by_award/"], context: true },
  { id: "D-87", section: "8.7", name: "Public unit-price observations (*context*; roadway electrical only; store as dated rows)", valueText: "Washington conduit pipe 2 in.: low bids 30.35, 85.00, 30.00 per LF, quantity-weighted state average 33.04 (3 contracts); California loop detector 480.00 and 725.00 each (2 awarded rows); Oregon illumination \"unit\" prices are lump sums divided by a plan quantity; Albuquerque figures are an engineer's list, not bids", unitText: "USD per unit", jurisdictionText: "Washington; California; Oregon; New Mexico", effectiveText: "2024 to 2026", kind: "published_rate", kindText: "rate", evidence: "R", sources: ["https://wsdot.wa.gov/biz/contaa/uba/","https://sv08data.dot.ca.gov/"], context: true },
];

// ---------------------------------------------------------------- engine values
const yr = (y: number): [IsoDate, IsoDate] => [`${y}-01-01` as IsoDate, `${y}-12-31` as IsoDate];
function v(key: string, value: number | string | boolean, unit: DefaultUnit, jurisdiction: string, from: string | null, to: string | null, note?: string): DefaultValue {
  return { key, value, unit, jurisdiction, from: from === null ? null : isoDate(from), to: to === null ? null : isoDate(to), ...(note ? { note } : {}) };
}
/** D-38 sample schedule slice upper bounds: first 100,000; next 400,000; next 2,000,000; next 2,500,000; next 2,500,000; over 7,500,000. */
const SAMPLE_BOUNDS: readonly (number | null)[] = [10_000_000, 50_000_000, 250_000_000, 500_000_000, 750_000_000, null];

// Values in engine units, row by row. Signature: v(key, value, unit, jurisdiction, from, to, note?).
// yr(y) = the calendar year y; cur = in force when read, no start date stated in the source.
const VALUES: Readonly<Record<string, readonly DefaultValue[]>> = {
  // ---- 8.1 payroll taxes
  'D-1': [v('ss.employerRate', 62_000, 'ppm', 'US', '2026-01-01', '2027-12-31', '2027 by statute')],
  'D-2': [
    v('ss.wageBase', 17_610_000, 'cents', 'US', ...yr(2025)),
    v('ss.wageBase', 18_450_000, 'cents', 'US', ...yr(2026)),
    v('ss.wageBase', 19_230_000, 'cents', 'US', ...yr(2027), '2027 from reports of the SSA announcement'),
  ],
  'D-3': [
    v('medicare.employerRate', 14_500, 'ppm', 'US', ...yr(2026), 'no wage cap'),
    v('medicare.additionalEmployerRate', 0, 'ppm', 'US', ...yr(2026), 'Additional Medicare 0.9% is employee-only'),
    v('medicare.additionalThreshold', 20_000_000, 'cents', 'US', ...yr(2026)),
  ],
  'D-4': [
    v('futa.grossRate', 60_000, 'ppm', 'US', '2025-01-01', '2026-12-31'),
    v('futa.maxCredit', 54_000, 'ppm', 'US', '2025-01-01', '2026-12-31'),
    v('futa.netRate', 6_000, 'ppm', 'US', '2025-01-01', '2026-12-31', 'where there is no credit reduction'),
    v('futa.wageBase', 700_000, 'cents', 'US', '2025-01-01', '2026-12-31'),
    v('futa.maxPerEmployee', 4_200, 'cents', 'US', '2025-01-01', '2026-12-31'),
  ],
  'D-5': [
    v('futa.creditReductionStepPerYear', 3_000, 'ppm', 'US', ...yr(2025), 'add-ons possible from the 3rd and 5th year'),
    v('futa.creditReduction', 12_000, 'ppm', 'CA', ...yr(2025)),
    v('futa.netRateWithReduction', 18_000, 'ppm', 'CA', ...yr(2025)),
    v('futa.maxPerEmployeeWithReduction', 12_600, 'cents', 'CA', ...yr(2025)),
  ],
  'D-6': [
    v('ui.wageBase', 4_180_000, 'cents', 'NV', ...yr(2025)),
    v('ui.wageBase', 4_370_000, 'cents', 'NV', ...yr(2026)),
    v('ui.wageBase', 4_540_000, 'cents', 'NV', ...yr(2027)),
  ],
  'D-7': [
    v('ui.newEmployerRate', 29_500, 'ppm', 'NV', ...yr(2026), 'kept 14 to 17 quarters'),
    v('ui.rateMin', 2_500, 'ppm', 'NV', ...yr(2026)),
    v('ui.rateMax', 54_000, 'ppm', 'NV', ...yr(2026)),
    v('ui.rateCount', 18, 'count', 'NV', ...yr(2026)),
  ],
  'D-8': [
    v('ui.surcharge', 500, 'ppm', 'NV', null, null, 'Career Enhancement Program'),
    v('ui.surchargeExemptAtRate', 54_000, 'ppm', 'NV', null, null, 'CEP not owed at the 5.4% rate'),
    v('ui.newEmployerTotal', 30_000, 'ppm', 'NV', null, null),
  ],
  'D-9': [
    v('mbt.rate', 11_700, 'ppm', 'NV', '2023-07-01', null, 'general business'),
    v('mbt.quarterlyExemptWages', 5_000_000, 'cents', 'NV', '2023-07-01', null, 'per quarter per employer'),
  ],
  'D-10': [
    v('ui.wageBase', 700_000, 'cents', 'CA', ...yr(2026)),
    v('ui.newEmployerRate', 34_000, 'ppm', 'CA', ...yr(2026)),
    v('ui.rateMin', 15_000, 'ppm', 'CA', ...yr(2026), 'schedule F+'),
    v('ui.rateMax', 62_000, 'ppm', 'CA', ...yr(2026), 'schedule F+'),
    v('ui.maxPerEmployee', 43_400, 'cents', 'CA', ...yr(2026)),
  ],
  'D-11': [
    v('ui.surcharge', 1_000, 'ppm', 'CA', ...yr(2026), 'ETT on the first 7,000'),
    v('ett.maxPerEmployee', 700, 'cents', 'CA', ...yr(2026)),
    v('sdi.employeeRate', 13_000, 'ppm', 'CA', ...yr(2026), 'withheld from the employee; employer cost 0'),
    v('sdi.employeeRate', 12_000, 'ppm', 'CA', ...yr(2025), 'withheld from the employee; employer cost 0'),
    v('sdi.employerRate', 0, 'ppm', 'CA', '2025-01-01', '2026-12-31'),
  ],
  'D-17': [
    v('deposit.monthlyDueDayOfNextMonth', 15, 'count', 'US', ...yr(2026)),
    v('deposit.monthlyLookbackMax', 5_000_000, 'cents', 'US', ...yr(2026)),
  ],
  'D-18': [v('payroll.fractionsOfCentsAdjustment', 'IRS fractions-of-cents adjustment exists', 'rule', 'US', ...yr(2026))],
  // ---- 8.2 workers' compensation
  'D-12': [
    v('wc.payrollCap', 3_600_000, 'cents', 'NV', null, '2026-09-30', 'by policy effective date; statute in force through 2026-09-30'),
    v('wc.payrollCap', 9_843_360, 'cents', 'NV', '2026-10-01', '2026-12-31', '12 x maximum average monthly wage; re-set each 1 January (A-10 after)'),
  ],
  'D-13': [v('wc.excludeOtPremium', false, 'boolean', 'NV', null, null, 'NAC 616A.200; confirm with the carrier')],
  'D-14': [
    v('wc.electricalDualWageThreshold', 3_600, 'cents', 'CA', null, '2026-08-31', 'previous threshold'),
    v('wc.electricalDualWageThreshold', 4_000, 'cents', 'CA', '2026-09-01', null, '5140 at or above, 5190 below'),
  ],
  'D-15': [
    v('wc.advisoryPurePremium.average', 16_500, 'ppm', 'CA', '2026-09-01', null, '$1.65 per $100; loss-only benchmark'),
    v('wc.advisoryPurePremium.5190', 37_290, 'ppm', 'CA', '2026-09-01', null, '$3.729 per $100'),
    v('wc.advisoryPurePremium.5140', 21_090, 'ppm', 'CA', '2026-09-01', null, '$2.109 per $100'),
  ],
  'D-16': [
    v('wc.lossCostChange', 65_000, 'ppm', 'NV', '2025-03-01', null),
    v('wc.lossCostChange', 216_000, 'ppm', 'NV', '2026-03-01', null),
    v('wc.lossCostChange', -328_000, 'ppm', 'NV', '2026-10-01', null, 'paired with the larger payroll base'),
  ],
  // ---- 8.3 overtime and prevailing wage
  'D-19': [
    v('ot.flsa.multiple', '1.5', 'factor', 'US', null, null),
    v('ot.flsa.weeklyThreshold', 4_000, 'hoursC', 'US', null, null),
  ],
  'D-20': [v('pw.davisBacon.fringeMetBy', 'cash, bona fide plan contributions, or a mix; plan credit annualized over all hours, with exceptions', 'rule', 'US', null, null)],
  'D-21': [v('ot.davisBacon.premiumOnBasic', '0.5', 'factor', 'US', null, null, 'fringe at straight rate on every hour')],
  'D-22': [
    v('ot.caPrivate.dailyThreshold', 800, 'hoursC', 'CA', null, null),
    v('ot.caPrivate.weeklyThreshold', 4_000, 'hoursC', 'CA', null, null),
    v('ot.caPrivate.doubleDailyThreshold', 1_200, 'hoursC', 'CA', null, null),
    v('ot.caPrivate.seventhDayThreshold', 800, 'hoursC', 'CA', null, null),
  ],
  'D-23': [
    v('ot.caPublic.dailyThreshold', 800, 'hoursC', 'CA', null, null),
    v('ot.caPublic.weeklyThreshold', 4_000, 'hoursC', 'CA', null, null),
    v('ot.caPublic.multiple', '1.5', 'factor', 'CA', null, null, 'of the basic rate; employer payments at straight rate'),
  ],
  'D-24': [
    v('ot.nvPrivate.weeklyThreshold', 4_000, 'hoursC', 'NV', null, null),
    v('ot.nvPrivate.dailyThreshold', 800, 'hoursC', 'NV', null, null, 'only below 1.5 x minimum wage; 4x10 exception'),
  ],
  'D-25': [
    v('ot.nvPublic.weeklyThreshold', 4_000, 'hoursC', 'NV', '2026-07-22', null),
    v('ot.nvPublic.dailyThreshold', 800, 'hoursC', 'NV', '2026-07-22', null),
    v('ot.nvPublic.multiple', '1.5', 'factor', 'NV', '2026-07-22', null, 'of base + fringe (Labor Commissioner handbook)'),
  ],
  'D-26': [
    v('wages.minPaymentsPerMonth', 2, 'count', 'NV', null, null, 'semimonthly (NRS 608.060)'),
    v('wages.minPaymentsPerMonth', 2, 'count', 'CA', null, null, 'twice per calendar month (Labor Code 204)'),
  ],
  'D-27': [
    v('cwhssa.threshold', 10_000_000, 'cents', 'US', null, null),
    v('cwhssa.thresholdFederalAcquisition', 15_000_000, 'cents', 'US', null, null),
  ],
  'D-28': [
    v('minimumWage', 1_200, 'cents', 'NV', '2026-07-01', null),
    v('ot.nvPrivate.dailyWageThreshold', 1_800, 'cents', 'NV', '2026-07-01', null, 'daily overtime only below this rate'),
  ],
  'D-29': [v('wages.davisBacon.maxDaysBetweenPayments', 7, 'days', 'US', null, null)],
  'D-30': [v('pw.nv.projectThreshold', 10_000_000, 'cents', 'NV', null, null, 'NRS 338.020-.090 do not apply below this estimated cost')],
  'D-31': [v('pw.nv.dcPlanExceptionShare', 250_000, 'ppm', 'NV', null, null, 'of the hourly prevailing rate')],
  // ---- 8.4 bonds
  'D-32': [
    v('bond.federal.threshold', 15_000_000, 'cents', 'US', null, null, 'statute text: 100,000'),
    v('bond.federal.performancePct', 1_000_000, 'ppm', 'US', null, null),
    v('bond.federal.paymentPct', 1_000_000, 'ppm', 'US', null, null),
  ],
  'D-33': [
    v('bond.federal.paymentProtectionAbove', 3_500_000, 'cents', 'US', null, null),
    v('bond.federal.paymentProtectionAtMost', 15_000_000, 'cents', 'US', null, null),
    v('bond.federal.paymentProtectionPct', 1_000_000, 'ppm', 'US', null, null),
  ],
  'D-34': [
    v('bidSecurity.federal.pct', 200_000, 'ppm', 'US', null, null),
    v('bidSecurity.federal.cap', 300_000_000, 'cents', 'US', null, null),
  ],
  'D-35': [
    v('bond.nv.threshold', 10_000_000, 'cents', 'NV', null, null, 'NRS 339.025, not NRS 408 work'),
    v('bond.nv.minPct', 500_000, 'ppm', 'NV', null, null, 'performance and payment each'),
    v('bond.nvSpwd.subFloor', 5_000_000, 'cents', 'NV', null, null),
    v('bond.nvSpwd.subProjectShare', 10_000, 'ppm', 'NV', null, null),
    v('bidSecurity.nvSpwd.pct', 50_000, 'ppm', 'NV', null, null, 'of base bid plus alternates'),
    v('bidSecurity.nvSpwd.above', 10_000_000, 'cents', 'NV', null, null),
    v('bidSecurity.ndot.pct', 50_000, 'ppm', 'NV', null, null),
    v('bond.ndot.pct', 1_000_000, 'ppm', 'NV', null, null, 'full contract amount'),
  ],
  'D-36': [
    v('bond.ca.paymentThreshold', 2_500_000, 'cents', 'CA', null, null),
    v('bond.ca.paymentPct', 1_000_000, 'ppm', 'CA', null, null),
    v('bidSecurity.ca.pct', 100_000, 'ppm', 'CA', null, null, 'state and cities'),
    v('bond.caStateContractAct.minPct', 500_000, 'ppm', 'CA', null, null),
  ],
  'D-37': [
    v('sba.feeRate', 6_000, 'ppm', 'US', null, '2026-11-29', 'by guarantee approval date'),
    v('sba.feeRate', 7_290, 'ppm', 'US', '2026-11-30', null, 'by guarantee approval date'),
    v('sba.contractLimit', 900_000_000, 'cents', 'US', null, null),
    v('sba.federalCertifiedLimit', 1_400_000_000, 'cents', 'US', null, null),
    v('sba.quickBondLimit', 50_000_000, 'cents', 'US', null, null),
    v('sba.bidBondFee', 0, 'cents', 'US', null, null),
  ],
  'D-38': [
    ...SAMPLE_BOUNDS.map((b, i) => v(`bond.sample.tier${i + 1}.upTo`, b === null ? 'none' : b, b === null ? 'text' : 'cents', 'US', null, null)),
    ...[25_000, 15_000, 10_000, 7_500, 7_000, 6_500].map((r, i) => v(`bond.sample.nonDeviating.tier${i + 1}.rate`, r, 'ppm', 'US', null, null, '$ per $1,000, 12 months or less')),
    ...[10_000, 8_000, 7_000, 6_000, 5_000, 4_500].map((r, i) => v(`bond.sample.deviating.tier${i + 1}.rate`, r, 'ppm', 'US', null, null, '$ per $1,000, 12 months or less')),
  ],
  'D-39': [
    v('bond.surcharge.nonDeviating.M1', 12, 'months', 'US', '2026-02-02', null),
    v('bond.surcharge.nonDeviating.s', 10_000, 'ppm', 'US', '2026-02-02', null, 'of premium per month over 12'),
    v('bond.surcharge.deviating.M1', 12, 'months', 'US', '2026-02-02', null),
    v('bond.surcharge.deviating.M2', 24, 'months', 'US', '2026-02-02', null),
    v('bond.surcharge.deviating.s1', 5_000, 'ppm', 'US', '2026-02-02', null),
    v('bond.surcharge.deviating.s2', 10_000, 'ppm', 'US', '2026-02-02', null),
    v('bond.surcharge.table24.M1', 24, 'months', 'US', '2026-02-02', null, 'South Carolina, Louisiana, Delaware, Hawaii, Arkansas'),
    v('bond.surcharge.table24.s', 10_000, 'ppm', 'US', '2026-02-02', null),
  ],
  'D-40': [
    v('bidSecurity.grants.pct', 50_000, 'ppm', 'US', null, null),
    v('bond.grants.performancePct', 1_000_000, 'ppm', 'US', null, null),
    v('bond.grants.paymentPct', 1_000_000, 'ppm', 'US', null, null),
  ],
  'D-41': [
    v('bond.premiumRange.ofContract', '1.5% to 3.0%', 'text', 'US', null, null),
    v('bond.premiumRange.ofBond', '1% to 3%', 'text', 'US', null, null),
    v('bond.premiumReported', '$100,000: 1,200-2,500; $1M: 7,700-13,500; $10M: 56,950-81,000; $50M: 206,475-341,000', 'text', 'US', null, null, '2014'),
    v('bond.premiumDotSurveyUnder100k', '0.22 / 1.06 / 2.5% low / average / high', 'text', 'US', null, null),
  ],
  'D-42': [v('bond.premiumSetting', 'sureties file their own rates (no state-set rate); premium usually based on contract amount and duration', 'rule', 'US', null, null)],
  // ---- 8.5 retainage, payment timing, interest
  'D-43': [
    v('retainage.federal.satisfactory', 0, 'ppm', 'US', null, null),
    v('retainage.federal.maxPerPayment', 100_000, 'ppm', 'US', null, null),
    v('retainage.federal.maxTotal', 100_000, 'ppm', 'US', null, null, 'of the approved estimated amount'),
  ],
  'D-44': [
    v('payment.federal.billing', 'monthly', 'text', 'US', null, null),
    v('payment.federal.payLag', 14, 'days', 'US', null, null),
    v('payment.federal.finalPayment', 30, 'days', 'US', null, null),
    v('payment.federal.retainageRelease', 30, 'days', 'US', null, null),
    v('payment.federal.subPay', 7, 'days', 'US', null, null),
    v('payment.federal.smallBusinessGoal', 15, 'days', 'US', null, null, 'a goal, not a due date'),
  ],
  'D-45': [v('payment.federal.bondPremiumReimbursement', 'on request, inside progress payments, after proof of payment', 'rule', 'US', null, null)],
  'D-46': [
    v('interest.promptPayment.rate', 46_250, 'ppm', 'US', '2025-07-01', '2025-12-31'),
    v('interest.promptPayment.rate', 41_250, 'ppm', 'US', '2026-01-01', '2026-06-30'),
    v('interest.promptPayment.rate', 47_500, 'ppm', 'US', '2026-07-01', '2026-12-31'),
    v('interest.promptPayment.dayCount', 360, 'days', 'US', null, null),
  ],
  'D-47': [v('ld.federal', 'a rate per day of delay stated in the contract', 'rule', 'US', null, null)],
  'D-48': [
    v('payment.nv.payLag', 30, 'days', 'NV', null, null, 'or sooner per contract'),
    v('retainage.nv.rate1', 50_000, 'ppm', 'NV', null, null),
    v('retainage.nv.switchShare', 500_000, 'ppm', 'NV', null, null),
  ],
  'D-49': [
    v('retainage.nv.rate2Best', 0, 'ppm', 'NV', null, null, 'may pay without further retainage'),
    v('retainage.nv.rate2Base', 25_000, 'ppm', 'NV', null, null, 'after first paying 50% of the retainage withheld so far'),
    v('retainage.nv.halfReleaseShare', 500_000, 'ppm', 'NV', null, null),
    v('retainage.nv.rate2Stress', 50_000, 'ppm', 'NV', null, null, 'NRS 338.525 withholding'),
  ],
  'D-50': [v('payment.nv.subPay', 10, 'days', 'NV', null, null)],
  'D-51': [
    v('payment.ndot.maxProgressShare', 950_000, 'ppm', 'NV', null, null),
    v('retainage.ndot.rate', 50_000, 'ppm', 'NV', null, null),
    v('retainage.ndot.dollarCap', 5_000_000, 'cents', 'NV', null, null),
  ],
  'D-52': [
    v('retainage.ca.maxRate', 50_000, 'ppm', 'CA', null, null),
    v('retainage.ca.maxShareOfContract', 50_000, 'ppm', 'CA', null, null),
    v('retainage.caLocal.minRate', 50_000, 'ppm', 'CA', null, null),
    v('retainage.caltrans.rate', 0, 'ppm', 'CA', null, null),
  ],
  'D-53': [
    v('payment.ca.payLag', 30, 'days', 'CA', null, null),
    v('payment.ca.improperReturn', 7, 'days', 'CA', null, null),
    v('interest.ca.lateRate', 100_000, 'ppm', 'CA', null, null, 'per year'),
    v('payment.ca.retainageRelease', 60, 'days', 'CA', null, null, 'after completion'),
    v('retainage.ca.disputedMultiple', 1_500_000, 'ppm', 'CA', null, null),
    v('payment.ca.subPay', 7, 'days', 'CA', null, null),
    v('interest.ca.subPenaltyPerMonth', 20_000, 'ppm', 'CA', null, null),
  ],
  'D-54': [v('ld.ca.rule', 'enforceable only if liquidated to a set amount identified in the contract', 'rule', 'CA', '2016-01-01', null)],
  'D-55': [
    v('sba7a.spread.upTo5000000', 65_000, 'ppm', 'US', null, null, 'loans of 50,000 or less'),
    v('sba7a.spread.upTo25000000', 60_000, 'ppm', 'US', null, null),
    v('sba7a.spread.upTo35000000', 45_000, 'ppm', 'US', null, null),
    v('sba7a.spread.above35000000', 30_000, 'ppm', 'US', null, null),
  ],
  'D-56': [v('supplier.typicalNet', '30, 60', 'days', 'US', null, null)],
  'D-57': [v('capacity.stateRules', 'SD 10 x WC; TN 10 x min(WC, NW); WA 5.0 x NW; IL 10/11/12 x allowable net current assets; KY 12 x net current assets + 6 x equipment', 'text', 'US', null, null)],
  'D-58': [
    v('mobilization.iowa.share', 250_000, 'ppm', 'IA', null, null),
    v('mobilization.iowa.trigger', 50_000, 'ppm', 'IA', null, null, 'of the original contract amount complete'),
  ],
  'D-60': [v('rate.bankPrime', 70_000, 'ppm', 'US', '2026-10-09', '2026-10-09', 'observation of 2026-10-09; refresh before use')],
  // ---- 8.6 tax rounding, estimating guidance, bidding rules
  'D-59': [v('sizeStandard.238210', 1_900_000_000, 'cents', 'US', null, null, 'average annual receipts')],
  'D-61': [v('salesTax.nv.rounding', 'computed to the third decimal; rounded up when the third decimal is greater than 4; per item or per invoice', 'rule', 'NV', null, null)],
  'D-62': [v('ndot.unitPriceGoverns', 'the unit bid prices shall govern', 'rule', 'NV', null, null)],
  'D-63': [v('rounding.halfEvenExists', '984.50 -> 984; 985.50 -> 986', 'rule', 'US', null, null)],
  'D-64': [v('js.maxSafeInteger', '9007199254740991', 'text', 'n/a', null, null)],
  'D-65': [
    v('overhead.range.homeOffice', '3% to 10% of contract amount', 'text', 'US', null, null, 'revenue basis'),
    v('overhead.range.volume', '7% to 20% of volume', 'text', 'US', null, null, 'revenue basis'),
    v('profit.range', '3% to 10% of direct plus indirect cost', 'text', 'US', null, null),
  ],
  'D-66': [
    v('smallTools.prime', 20_000, 'ppm', 'US', '2026-02-02', null, 'of direct labor cost for the prime contractor'),
    v('smallTools.1997Max', 120_000, 'ppm', 'US', null, null, '1997 text'),
  ],
  'D-67': [v('wgl.weights', '0.03 to 0.12 per factor; size-of-job 0.12 at <= 100,000 linear to 0.05 at 5,000,000, 0.04 to 10M, 0.03 above; rates 20/15/15/15/5/5/25', 'text', 'US', '2026-02-02', null)],
  'D-68': [v('changeOrder.limits', 'GSA 10%; VA 10/7.5/5%; NASA 10/10/10; Caltrans force account 35/15/15, sub +10%', 'text', 'US', null, null, 'never applied to a bid')],
  'D-69': [
    v('fema.homeOfficeOverhead', 77_000, 'ppm', 'US', null, null),
    v('fema.insuranceAndBonds', 33_000, 'ppm', 'US', null, null),
  ],
  'D-70': [
    v('smallWorks.nv.oneBelow', 2_500_000, 'cents', 'NV', null, null, 'at least one contractor at or below'),
    v('smallWorks.nv.threeUpTo', 10_000_000, 'cents', 'NV', null, null, 'at least three over 25,000 up to 100,000'),
    v('smallWorks.nv.minSolicitedLow', 1, 'count', 'NV', null, null),
    v('smallWorks.nv.minSolicitedHigh', 3, 'count', 'NV', null, null),
  ],
  'D-71': [
    v('preference.nv.pct', 50_000, 'ppm', 'NV', null, null),
    v('preference.nv.above', 25_000_000, 'cents', 'NV', null, null),
    v('preference.nv.veteranPct', 50_000, 'ppm', 'NV', null, null, 'State public works under 250,000'),
  ],
  'D-72': [v('preference.hubzone.pct', 100_000, 'ppm', 'US', null, null)],
  'D-73': [v('magnitude.federal.bounds', '25000, 100000, 250000, 500000, 1000000, 5000000, 10000000', 'text', 'US', null, null, 'USD band edges')],
  'D-74': [
    v('adequacy.fhwa', '1:100%, 2:105%, 3:110%, 4:115%, 5:120%', 'text', 'US', null, null, '2004 text, dropped in 2021'),
    v('adequacy.wsdot', '3+:110%, 4+:115%, 5+:120%', 'text', 'WA', null, null),
  ],
  'D-75': [v('lowBidVsEstimate.context', 'see spec D-75 (highway studies; never a Nevada electrical figure)', 'text', 'US', null, null)],
  'D-76': [
    v('stats.expectedMaxNormal', 'N=2..8: 0.5642, 0.8463, 1.0294, 1.1630, 1.2672, 1.3522, 1.4236; N=10: 1.5388', 'text', 'n/a', null, null),
    v('stats.kernelBandwidth', '0.9 x min(s, IQR/1.34) x n^(-1/5)', 'text', 'n/a', null, null),
    v('stats.eventsPerPredictor', 10, 'count', 'n/a', null, null),
  ],
  // ---- 8.7 time, place and reference data
  'D-77': [
    v('dod.escalation.rates', 'FY2026 2.1%, FY2027 onward 2.0%', 'text', 'US', '2026-03-25', null),
    v('dod.escalation.factors', '1.021, 1.04142, 1.0622484, 1.083493368, 1.10516323536, 1.1272665000672 (base 1 Oct 2025 = 1)', 'text', 'US', '2026-03-25', null),
    v('dod.spi', 'Oct 2023 172.87, Oct 2024 179.05, Oct 2025 186.35 (Oct 2007 = 100)', 'text', 'US', '2026-03-25', null),
  ],
  'D-78': [v('dod.acf', 'see spec D-78 (2026 edition; context only)', 'text', 'NV', '2026-06-08', null)],
  'D-79': [v('bls.ppi', 'May 2025 to May 2026 final values per spec D-79', 'text', 'US', '2026-11-13', null, 'revisable up to four months after publication')],
  'D-80': [
    v('oews.electricians.mean', 3_437, 'cents', 'US', '2025-05-01', '2025-05-31'),
    v('oews.electricians.mean', 3_640, 'cents', 'NV', '2025-05-01', '2025-05-31'),
    v('oews.electricians.mean', 4_128, 'cents', 'CA', '2025-05-01', '2025-05-31'),
  ],
  'D-81': [v('fhwa.nhcci', '2025 Q1 3.162838217; 2026 Q1 3.134822428 (2003 Q1 = 1)', 'text', 'US', '2026-11-13', null)],
  'D-82': [
    v('clause.fhwa.triggerRange', '3% to 10% (5% AASHTO)', 'text', 'US', null, null),
    v('clause.fhwa.ceilingRange', '25% to 100%', 'text', 'US', null, null),
    v('clause.far52216_4.increaseCap', 100_000, 'ppm', 'US', null, null),
    v('clause.far52216_4.threshold', 30_000, 'ppm', 'US', null, null),
  ],
  'D-83': [v('escalation.midpointConvention', 'escalate to the midpoint of construction; with a cost-loaded schedule, by activity', 'rule', 'US', null, null)],
  'D-84': [v('caltrans.index', '2020 = 100; 2026 Q2 146.53 current', 'text', 'CA', '2026-11-12', null)],
  'D-85': [
    v('bidData.minResults', 20, 'count', 'CA', '2026-11-12', null),
    v('bidData.normalBand', '-20% to +10% of the engineer\'s estimate', 'text', 'CA', '2026-11-12', null),
  ],
  'D-86': [v('awards.nv.238210', 'n = 36; median 38,209.62; p25 12,271.75; p75 82,771.61', 'text', 'NV', '2024-11-13', '2026-11-13')],
  'D-87': [v('unitPrice.observations', 'roadway electrical only; see spec D-87', 'text', 'US', null, null)],
};

export const DEFAULT_ROWS: readonly DefaultRow[] = META.map((m) => {
  const values = VALUES[m.id];
  if (!values) throw new Error(`defaults: row ${m.id} has no values`);
  return { ...m, values };
});
const ROW_BY_ID = new Map(DEFAULT_ROWS.map((r) => [r.id, r]));

/** Canonical text the integrity test hashes: one `${id}|${name}` line per row, in spec order. */
export function defaultsCanonical(rows: readonly DefaultRow[] = DEFAULT_ROWS): string {
  return rows.map((r) => `${r.id}|${r.name}`).join('\n');
}

export function defaultRow(id: string): DefaultRow {
  const r = ROW_BY_ID.get(id);
  if (!r) return refuse('UNKNOWN_DEFAULT', `no row ${id} in spec section 8`);
  return r;
}

// ---------------------------------------------------------------- lookup (fails closed)

export interface DefaultHit {
  readonly row: DefaultRow;
  readonly value: DefaultValue;
}

function covers(x: DefaultValue, date: IsoDate): boolean {
  return (x.from === null || compareDates(x.from, date) <= 0) && (x.to === null || compareDates(date, x.to) <= 0);
}

/**
 * The value of `key` in force on `date` in `jurisdiction`. Fails closed: no row, a date outside every
 * row's effective period, or two rows that both claim the date -> CostEngineError (RangeError).
 * Context rows are refused unless `allowContext` (they are never multiplied into a bid).
 */
export function lookupDefault(key: string, jurisdiction: string, date: IsoDate, opts: { allowContext?: boolean } = {}): DefaultHit {
  isoDate(date);
  const hits: DefaultHit[] = [];
  let sameKey = false;
  for (const row of DEFAULT_ROWS)
    for (const value of row.values)
      if (value.key === key && value.jurisdiction === jurisdiction) {
        sameKey = true;
        if (covers(value, date)) hits.push({ row, value });
      }
  if (!sameKey) return refuse('NO_DEFAULT', `no section 8 default '${key}' for ${jurisdiction}`);
  if (hits.length === 0) return refuse('NO_DEFAULT_FOR_DATE', `section 8 has '${key}' for ${jurisdiction}, but no row covers ${date}`);
  if (hits.length > 1) return refuse('AMBIGUOUS_DEFAULT', `two section 8 rows claim '${key}' for ${jurisdiction} on ${date}`);
  const hit = hits[0]!;
  if (hit.row.context && !opts.allowContext) refuse('CONTEXT_ONLY', `${hit.row.id} is context only and is never multiplied into a bid`);
  return hit;
}

/** Numeric lookup (engine units). */
export function lookupNumber(key: string, jurisdiction: string, date: IsoDate, log?: SourceLog): number {
  const hit = lookupDefault(key, jurisdiction, date);
  if (typeof hit.value.value !== 'number') refuse('BAD_TABLE', `${hit.row.id} '${key}' is not a number`);
  log?.use(hit);
  return hit.value.value as number;
}

/** Numeric lookup that must hold for the whole calendar year (payroll tables are per year). */
export function lookupForYear(key: string, jurisdiction: string, year: number, log?: SourceLog): number {
  const a = lookupDefault(key, jurisdiction, `${year}-01-01` as IsoDate);
  const b = lookupDefault(key, jurisdiction, `${year}-12-31` as IsoDate);
  if (a.value !== b.value) refuse('NO_DEFAULT_FOR_DATE', `'${key}' for ${jurisdiction} changes during ${year}: pass dated pieces`);
  return lookupNumber(key, jurisdiction, `${year}-06-30` as IsoDate, log);
}

// ---------------------------------------------------------------- sources used by a result

/** One default a result used: shown beside the number with its date and URL (spec 8 intro, 12.1 rule 10). */
export interface SourceUsed {
  readonly id: string; // 'D-2'
  readonly name: string;
  readonly key: string;
  readonly value: number | string | boolean;
  readonly unit: DefaultUnit;
  readonly jurisdiction: string;
  readonly effective: string; // verbatim effective text of the row
  readonly from: IsoDate | null;
  readonly to: IsoDate | null;
  readonly kind: DefaultKind;
  readonly evidence: string;
  readonly urls: readonly string[];
}

export interface SourceLog {
  use(hit: DefaultHit): void;
  list(): SourceUsed[];
}

/** A collector a single estimate passes to the builders; list() is sorted by row number then key. */
export function createSourceLog(): SourceLog {
  const seen = new Map<string, SourceUsed>();
  return {
    use({ row, value }) {
      const k = `${row.id}|${value.key}|${value.jurisdiction}|${value.from}|${value.to}`;
      if (!seen.has(k))
        seen.set(k, {
          id: row.id, name: row.name, key: value.key, value: value.value, unit: value.unit, jurisdiction: value.jurisdiction,
          effective: row.effectiveText, from: value.from, to: value.to, kind: row.kind, evidence: row.evidence, urls: row.sources,
        });
    },
    list() {
      const n = (id: string) => Number(id.slice(2));
      return [...seen.values()].sort((a, b) => n(a.id) - n(b.id) || a.key.localeCompare(b.key));
    },
  };
}

const src = (rowId: string, citation: string): LegalSource => {
  const r = defaultRow(rowId);
  return { citation: `${rowId} ${citation}`, url: r.sources[0]!, effective: r.effectiveText };
};

// ---------------------------------------------------------------- builders: payroll (spec 2.3, 8.1)

export type SupportedState = 'NV' | 'CA';

/**
 * The payroll tax table for one state and calendar year (D-1 .. D-11). Fails closed for a year no row covers.
 * Nevada 2027: the wage bases are confirmed (D-2, D-6); rates are carried from 2026 under A-34 and the
 * FUTA credit reduction must be entered (null). Nevada 2026: credit reduction 0 with a warning (A-9).
 * California 2026: credit reduction must be entered (A-9); California 2027 is not loaded (A-34).
 */
export function payrollTable(state: SupportedState, year: number, log?: SourceLog): { table: PayrollTaxTable; assumptions: AssumptionUsed[] } {
  const assumptions: AssumptionUsed[] = [];
  let rateYear = year;
  if (state === 'NV' && year === 2027) {
    rateYear = 2026;
    assumptions.push(useAssumption('A-34', 'Nevada 2027: 2026 rates (Medicare, FUTA, UI schedule, CEP) carried forward; 2027 wage bases from D-2, D-6'));
  }
  const ssRate = lookupForYear('ss.employerRate', 'US', year, log);
  const ssBase = lookupForYear('ss.wageBase', 'US', year, log);
  const med = lookupForYear('medicare.employerRate', 'US', rateYear, log);
  const futaNet = lookupForYear('futa.netRate', 'US', rateYear, log);
  const futaBase = lookupForYear('futa.wageBase', 'US', rateYear, log);
  const uiBase = lookupForYear('ui.wageBase', state, year, log);
  const uiMin = lookupForYear('ui.rateMin', state, rateYear, log);
  const uiMax = lookupForYear('ui.rateMax', state, rateYear, log);
  const sur = lookupForYear('ui.surcharge', state, rateYear, log);
  let cr: Ppm | null = null;
  if (state === 'NV' && year === 2026) {
    cr = 0 as Ppm;
    assumptions.push(useAssumption('A-9', 'Nevada 2026 FUTA credit reduction 0 (list not final)'));
  } else if (state === 'CA' && year === 2026) {
    assumptions.push(useAssumption('A-9', 'California 2026 FUTA credit reduction must be entered'));
  }
  const table: PayrollTaxTable = {
    year,
    state,
    sources: [...new Set([...defaultRow('D-1').sources, ...defaultRow('D-4').sources, ...defaultRow(state === 'NV' ? 'D-6' : 'D-10').sources])],
    effective: `calendar year ${year}`,
    socialSecurity: { ratePpm: ssRate as Ppm, wageBase: ssBase as Cents },
    medicare: { ratePpm: med as Ppm },
    futa: { netRatePpm: futaNet as Ppm, wageBase: futaBase as Cents, creditReductionPpm: cr, creditReductionFinal: false },
    stateUnemployment: {
      wageBase: uiBase as Cents,
      ratePpmMin: uiMin as Ppm,
      ratePpmMax: uiMax as Ppm,
      surchargePpm: sur as Ppm,
      surchargeLabel: state === 'NV' ? 'Career Enhancement Program' : 'ETT',
      surchargeExemptAtRatePpm: state === 'NV' ? (lookupNumber('ui.surchargeExemptAtRate', 'NV', `${year}-06-30` as IsoDate, log) as Ppm) : null,
    },
    ...(state === 'NV'
      ? { mbt: { ratePpm: lookupNumber('mbt.rate', 'NV', `${year}-01-01` as IsoDate, log) as Ppm, quarterlyExemptWages: lookupNumber('mbt.quarterlyExemptWages', 'NV', `${year}-01-01` as IsoDate, log) as Cents } }
      : {}),
  };
  return { table, assumptions };
}

/** New-employer unemployment rate (D-7, D-10): the labelled default when no rate notice is entered (spec 1.3). */
export function newEmployerUiRate(state: SupportedState, year: number, log?: SourceLog): { ratePpm: Ppm; assumptions: AssumptionUsed[] } {
  const assumptions: AssumptionUsed[] = [];
  let y = year;
  if (state === 'NV' && year === 2027) {
    y = 2026;
    assumptions.push(useAssumption('A-34', 'Nevada 2027 unemployment rates unchanged from 2026'));
  }
  return { ratePpm: lookupForYear('ui.newEmployerRate', state, y, log) as Ppm, assumptions };
}

/** Nevada workers' comp payroll cap by policy effective date (D-12); from 2027-01-01 keep 98,433.60 with a warning (A-10). */
export function nvWcPayrollCap(policyEffective: IsoDate, log?: SourceLog): { cap: Cents; assumptions: AssumptionUsed[]; warning?: string } {
  isoDate(policyEffective);
  if (compareDates(policyEffective, '2027-01-01' as IsoDate) >= 0) {
    const cap = lookupNumber('wc.payrollCap', 'NV', '2026-12-31' as IsoDate, log) as Cents;
    return { cap, assumptions: [useAssumption('A-10', '98,433.60 kept for a policy from 2027-01-01')], warning: 'Nevada workers\' comp payroll cap is re-set each 1 January: check the new cap (A-10)' };
  }
  return { cap: lookupNumber('wc.payrollCap', 'NV', policyEffective, log) as Cents, assumptions: [] };
}

// ---------------------------------------------------------------- builders: bonds (spec 4.1 to 4.4, 8.4)

export type OwnerType = 'federal' | 'federal_aided_local' | 'nv_state_spwd' | 'nv_local' | 'ndot' | 'ca_state' | 'ca_local' | 'caltrans' | 'private';
export const OWNER_TYPES: readonly OwnerType[] = ['federal', 'federal_aided_local', 'nv_state_spwd', 'nv_local', 'ndot', 'ca_state', 'ca_local', 'caltrans', 'private'];

const pct = (ppm: number, minimum = false) => ({ kind: 'pct' as const, ppm: ppm as Ppm, minimum });
const at = '2026-11-13' as IsoDate; // 'current' rows: read on the spec date

/**
 * Who needs a performance / payment bond (spec 4.2) by owner type. Fails closed where section 8 has no
 * trigger value: federally funded state/local work (2 CFR 200.326 uses the simplified acquisition threshold,
 * not in section 8) and private work (no statute; the contract decides).
 */
export function bondRequirementTable(owner: OwnerType, log?: SourceLog): BondRequirementTable {
  const n = (key: string, j: string) => lookupNumber(key, j, at, log);
  switch (owner) {
    case 'federal': {
      const bands: BondBand[] = [
        { above: n('bond.federal.threshold', 'US') as Cents, atMost: null, performance: pct(n('bond.federal.performancePct', 'US')), payment: pct(n('bond.federal.paymentPct', 'US')), label: 'C > $150,000' },
        { above: n('bond.federal.paymentProtectionAbove', 'US') as Cents, atMost: n('bond.federal.paymentProtectionAtMost', 'US') as Cents, performance: { kind: 'none' }, payment: { kind: 'officer_choice', ppm: n('bond.federal.paymentProtectionPct', 'US') as Ppm }, label: '$35,000 < C <= $150,000' },
      ];
      return { id: 'federal', bands, source: src('D-32', 'FAR 28.102-1, 28.102-2') };
    }
    case 'nv_state_spwd':
    case 'nv_local': {
      const p = n('bond.nv.minPct', 'NV');
      return { id: 'nv_339', bands: [{ above: n('bond.nv.threshold', 'NV') as Cents, atMost: null, performance: pct(p, true), payment: pct(p, true), label: 'C > $100,000' }], source: src('D-35', 'NRS 339.025') };
    }
    case 'ndot': {
      const p = n('bond.ndot.pct', 'NV');
      return { id: 'ndot', bands: [{ above: null, atMost: null, performance: pct(p), payment: pct(p), label: 'all contracts' }], source: src('D-35', 'NRS 408') };
    }
    case 'ca_state':
    case 'ca_local':
    case 'caltrans': {
      const performance = owner === 'ca_local' ? ({ kind: 'from_bid_documents' } as const) : pct(n('bond.caStateContractAct.minPct', 'CA'), true);
      return {
        id: owner === 'ca_local' ? 'ca_local' : 'ca_state',
        bands: [{ above: n('bond.ca.paymentThreshold', 'CA') as Cents, atMost: null, performance, payment: pct(n('bond.ca.paymentPct', 'CA')), label: 'expenditure > $25,000' }],
        source: src('D-36', 'Civ. Code 9550; PCC 10167'),
      };
    }
    case 'federal_aided_local':
      return refuse('NO_DEFAULT', '2 CFR 200.326 bonds trigger above the simplified acquisition threshold, which section 8 does not ship: read the bid documents');
    case 'private':
      return refuse('NO_DEFAULT', 'no statute sets bonds on private work: the contract decides');
  }
}

/** D-38 illustrative sample schedule (A-1): never a quote, always labelled. */
export function sampleBondTiers(kind: 'non_deviating' | 'deviating', log?: SourceLog): { tiers: BondTier[]; assumption: AssumptionUsed } {
  const row = defaultRow('D-38');
  const tiers: BondTier[] = SAMPLE_BOUNDS.map((b, i) => {
    const rate = row.values.find((x) => x.key === `bond.sample.${kind === 'deviating' ? 'deviating' : 'nonDeviating'}.tier${i + 1}.rate`)!;
    log?.use({ row, value: rate });
    return { upperBound: b as Cents | null, ratePpm: rate.value as Ppm };
  });
  return { tiers, assumption: useAssumption('A-1', `illustrative D-38 Class B ${kind.replace('_', '-')} sample rates (never a quote)`) };
}

export type SurchargePreset = 'non_deviating' | 'deviating' | 'table_24';

/** D-39 duration-surcharge presets (spec 4.3): M1, M2, s1, s2 for durationMultiplierPpm(). */
export function surchargePreset(kind: SurchargePreset, log?: SourceLog): { M1: number; M2: number; s1: Ppm; s2: Ppm } {
  const n = (k: string) => lookupNumber(`bond.surcharge.${k}`, 'US', at, log);
  if (kind === 'non_deviating') { const M1 = n('nonDeviating.M1'), s = n('nonDeviating.s') as Ppm; return { M1, M2: M1, s1: s, s2: s }; }
  if (kind === 'deviating') return { M1: n('deviating.M1'), M2: n('deviating.M2'), s1: n('deviating.s1') as Ppm, s2: n('deviating.s2') as Ppm };
  const M1 = n('table24.M1'), s = n('table24.s') as Ppm;
  return { M1, M2: M1, s1: s, s2: s };
}

/** D-37 SBA guarantee fee table for bondsSbaFee / sbaFeeCharge (spec 4.4). */
export function sbaFeeTable(log?: SourceLog): SbaFeeTable {
  const before = lookupDefault('sba.feeRate', 'US', '2026-11-29' as IsoDate);
  const after = lookupDefault('sba.feeRate', 'US', '2026-11-30' as IsoDate);
  log?.use(before);
  log?.use(after);
  return {
    switchDate: after.value.from!,
    rateBeforePpm: before.value.value as Ppm,
    rateFromPpm: after.value.value as Ppm,
    contractLimit: lookupNumber('sba.contractLimit', 'US', at, log) as Cents,
    federalCertifiedLimit: lookupNumber('sba.federalCertifiedLimit', 'US', at, log) as Cents,
    source: src('D-37', 'SBA surety bond guarantee fee'),
  };
}

// ---------------------------------------------------------------- builders: retainage and timing (spec 4.5, 4.6, 8.5)

export type RetainageCase = 'base' | 'best' | 'stress';

/**
 * Retainage preset by owner type and case (spec 4.5 table). Federal base = none (satisfactory progress),
 * stress = 10%. Nevada (NRS 338.515): best 5% to 50% then 0; base adds 2.5% with the half release; stress 5%.
 * NDOT 5% capped at min(5% of C, $50,000); California PCC 7201 5% capped at 5% of C; Caltrans none.
 * Federally funded local and private work: no preset (the contract decides) -> refused.
 */
export function retainageRule(owner: OwnerType, kase: RetainageCase, log?: SourceLog): RetainageRule {
  const n = (k: string, j: string) => lookupNumber(k, j, at, log);
  const R = (id: string, rho1: number, theta: number | null, rho2: number, kappa: number | null, cap: number | null, half: boolean, s: LegalSource): RetainageRule => ({
    id, rho1Ppm: rho1 as Ppm, thetaPpm: theta as Ppm | null, rho2Ppm: rho2 as Ppm, kappaPpm: kappa as Ppm | null, dollarCap: cap as Cents | null, halfRelease: half, source: s,
  });
  switch (owner) {
    case 'federal': {
      const s = src('D-43', 'FAR 52.232-5, 32.103');
      if (kase === 'stress') { const r = n('retainage.federal.maxPerPayment', 'US'); return R('federal_stress', r, null, r, n('retainage.federal.maxTotal', 'US'), null, false, s); }
      const z = n('retainage.federal.satisfactory', 'US');
      return R('federal', z, null, z, null, null, false, s);
    }
    case 'nv_state_spwd':
    case 'nv_local': {
      const s = src('D-48', 'NRS 338.515');
      const r1 = n('retainage.nv.rate1', 'NV'), th = n('retainage.nv.switchShare', 'NV');
      if (kase === 'best') return R('nv_best', r1, th, n('retainage.nv.rate2Best', 'NV'), null, null, false, s);
      if (kase === 'stress') return R('nv_stress', r1, th, n('retainage.nv.rate2Stress', 'NV'), null, null, false, src('D-49', 'NRS 338.525'));
      log?.use(lookupDefault('retainage.nv.halfReleaseShare', 'NV', at));
      return R('nv_base', r1, th, n('retainage.nv.rate2Base', 'NV'), null, null, true, src('D-49', 'NRS 338.515'));
    }
    case 'ndot': {
      const r = n('retainage.ndot.rate', 'NV');
      return R('ndot', r, null, r, r, n('retainage.ndot.dollarCap', 'NV'), false, src('D-51', 'NRS 408'));
    }
    case 'ca_state':
    case 'ca_local': {
      const r = n('retainage.ca.maxRate', 'CA');
      return R('ca_7201', r, null, r, n('retainage.ca.maxShareOfContract', 'CA'), null, false, src('D-52', 'PCC 7201'));
    }
    case 'caltrans': {
      const z = n('retainage.caltrans.rate', 'CA');
      return R('caltrans', z, null, z, null, null, false, src('D-52', 'PCC 7202'));
    }
    case 'federal_aided_local':
    case 'private':
      return refuse('NO_DEFAULT', `no retainage preset for ${owner} work in section 8: enter the contract's retainage`);
  }
}

/**
 * Payment-timing preset (spec 4.6): federal (D-44), Nevada public works (D-48, D-50), California public works (D-53).
 * Deadlines are maximums for a proper, undisputed request. NDOT, federally funded local and private work have no preset.
 */
export function paymentTiming(owner: OwnerType, log?: SourceLog): PaymentTimingPreset {
  const n = (k: string, j: string) => lookupNumber(k, j, at, log);
  switch (owner) {
    case 'federal':
      log?.use(lookupDefault('payment.federal.billing', 'US', at));
      return { id: 'federal', billingCycle: 'monthly', payLagDays: n('payment.federal.payLag', 'US'), retainageReleaseLagDays: n('payment.federal.retainageRelease', 'US'), subPayLagDays: n('payment.federal.subPay', 'US'), source: src('D-44', 'FAR 32.904, 52.232-27') };
    case 'nv_state_spwd':
    case 'nv_local':
      return { id: 'nv', billingCycle: 'per_contract', payLagDays: n('payment.nv.payLag', 'NV'), retainageReleaseLagDays: null, subPayLagDays: n('payment.nv.subPay', 'NV'), source: src('D-48', 'NRS 338.515') };
    case 'ca_state':
    case 'ca_local':
    case 'caltrans':
      return { id: 'ca', billingCycle: 'per_contract', payLagDays: n('payment.ca.payLag', 'CA'), retainageReleaseLagDays: n('payment.ca.retainageRelease', 'CA'), subPayLagDays: n('payment.ca.subPay', 'CA'), source: src('D-53', 'PCC 20104.50, 7107') };
    case 'ndot':
    case 'federal_aided_local':
    case 'private':
      return refuse('NO_DEFAULT', `no payment-timing preset for ${owner} work in section 8: enter the contract's terms`);
  }
}

/** State of an owner type; private and federal work take the job's state. */
export function ownerState(owner: OwnerType): SupportedState | null {
  if (owner.startsWith('nv_') || owner === 'ndot') return 'NV';
  if (owner.startsWith('ca_') || owner === 'caltrans') return 'CA';
  return null;
}
