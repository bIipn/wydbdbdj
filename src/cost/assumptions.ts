// Spec section 9: the assumptions table as a registry. Every row is a convention or an unverified value;
// each is editable and is shown to the user AS AN ASSUMPTION, never as a fact (spec 9, 12.1 rule 4).
// The rows below are the spec text verbatim (id, assumption, engine default, why); `editable`, `value`
// and `unit` are the engine-side reading of the default. test/cost-defaults.test.ts checks the table
// against the spec row for row (count + checksum), so nobody edits one side only.

import { refuse } from './money.js';
import type { AssumptionUsed } from './types.js';

export type AssumptionUnit = 'cents' | 'ppm' | 'hoursC' | 'days' | 'boolean' | 'number' | 'text' | 'none';

export interface AssumptionRow {
  readonly id: string; // 'A-1' .. 'A-40'
  readonly text: string; // the assumption, verbatim from spec 9
  readonly engineDefault: string; // the engine default, verbatim from spec 9
  readonly why: string; // why it is not in section 8, verbatim
  /** Can the contractor override it? false only where the engine never uses the row (A-5, A-33). */
  readonly editable: boolean;
  /** Engine-side value of the default in engine units; null when there is no default (the user must enter it). */
  readonly value: number | string | boolean | null;
  readonly unit: AssumptionUnit;
}

export const ASSUMPTIONS: readonly AssumptionRow[] = [
  { id: "A-1", text: "Bond rate schedule when the contractor has not entered their surety's", engineDefault: "sample D-38 with a visible \"illustrative rates\" label", why: "Real rates are filed per surety and priced per contractor; the sample is a 2010 advisory reprint with a corrected tier", editable: true, value: 'D-38 sample (illustrative)', unit: 'text' },
  { id: "A-2", text: "One premium covers both the performance and the payment bond; a bid bond costs nothing", engineDefault: "true; 0", why: "The handbook sentence could not be opened by the bonds verifier; \"nominal\" bid-bond cost rests on a 1975 report", editable: true, value: 0, unit: 'cents' },
  { id: "A-3", text: "Bonding capacity without a surety letter", engineDefault: "display-only estimate: single job about 10 x adjusted working capital, aggregate about 10 to 20 x the lesser of working capital and net worth; never a pass or fail", why: "Broker and CPA articles, not opened; state rules in D-57 are analogues only. With both multiples at 10 the aggregate test always dominates: use a larger aggregate multiple or enforce aggregate >= single", editable: true, value: '10x WC single; 10x to 20x min(WC, NW) aggregate', unit: 'text' },
  { id: "A-4", text: "Surety liquidity rules of thumb", engineDefault: "working capital about 10% of backlog (7% to 10% for subs); credit line about 10% of backlog; current ratio above 1.2; debt to equity below 2.5", why: "Unverified trade sources", editable: true, value: 100000, unit: 'ppm' },
  { id: "A-5", text: "Owner-side default markups (10% overhead, 10% profit, 0.5% bond; FEMA's 1.5 / 0.3 / 1.5 split; FEMA profit table)", engineDefault: "**not used**", why: "Federal Lands handbook text unreachable; FEMA table incomplete. Estimate defaults for larger general contractors", editable: false, value: null, unit: 'none' },
  { id: "A-6", text: "Part months in the bond duration surcharge", engineDefault: "whole months, rounded up", why: "Not specified in the source", editable: true, value: 'whole months, rounded up', unit: 'text' },
  { id: "A-7", text: "Home-office overhead and profit rates", engineDefault: "**none: the contractor must enter them**; D-65 ranges shown as context", why: "No law or public source fixes them; trade benchmark reports are paid and the figures quoted on vendor blogs conflict", editable: true, value: null, unit: 'none' },
  { id: "A-8", text: "Annual taxable wages `W` when not entered", engineDefault: "2,000 hours x straight-time cash wage", why: "Illustration convention; burden depends on it", editable: true, value: 200000, unit: 'hoursC' },
  { id: "A-9", text: "FUTA credit reduction for 2026", engineDefault: "Nevada 0 with a warning; California requires an explicit entry", why: "The final 2026 list was not published when checked; California's potential figure is 1.5% and could be 5.3% if an add-on is not waived", editable: true, value: 0, unit: 'ppm' },
  { id: "A-10", text: "Nevada workers' comp payroll cap from 2027-01-01", engineDefault: "keep 98,433.60 with a \"check the new cap\" warning", why: "The cap is re-set each January; the 2027 figure (102,452.16 if the fiscal-2027 wage figure is adopted) is not verified", editable: true, value: 9843360, unit: 'cents' },
  { id: "A-11", text: "Workers' comp rates", engineDefault: "**none: from the contractor's policy**; bureau figures (D-15) are reference only", why: "Nevada class 5190 loss cost (1.89 in March 2025, superseded three times) and the assigned-risk multiplier (1.499) could not be verified. A loss cost is not a rate", editable: true, value: null, unit: 'none' },
  { id: "A-12", text: "Workers' comp payroll rules outside Nevada: overtime premium excluded when recorded separately; plan contributions excluded; cash in lieu included", engineDefault: "`excludeOtPremium = true` outside Nevada", why: "Bureau manual wording not opened", editable: true, value: true, unit: 'boolean' },
  { id: "A-13", text: "General liability premium basis and rates", engineDefault: "from the contractor's policy; no default", why: "Rating-manual text not reached", editable: true, value: null, unit: 'none' },
  { id: "A-14", text: "Sales tax rate", engineDefault: "**none: entered per job location**", why: "Local rates were not researched", editable: true, value: null, unit: 'none' },
  { id: "A-15", text: "Reading of the Nevada rounding statute as \"truncate to three decimals, then round\"", engineDefault: "half-up to the cent", why: "The statute says only \"computed to the third decimal place\"; the other reading differs in about 5% of cases", editable: true, value: 'half-up', unit: 'text' },
  { id: "A-16", text: "In Nevada the contractor is the consumer and pays sales tax on materials, even for an exempt owner", engineDefault: "materials taxable", why: "The tax bulletin was not independently read", editable: true, value: true, unit: 'boolean' },
  { id: "A-17", text: "Freight is not taxable", engineDefault: "`freightTaxable = false`", why: "State-specific; not verified for Nevada", editable: true, value: false, unit: 'boolean' },
  { id: "A-18", text: "Small tools: base is burdened direct labor; 2% also applied to a subcontractor", engineDefault: "`st = 2%` on `L`", why: "The guide says \"direct labor cost ... for the Prime Contractor\"; base and applicability are our reading", editable: true, value: 20000, unit: 'ppm' },
  { id: "A-19", text: "Contingency 0, placed before overhead with escalation", engineDefault: "`c = 0`", why: "Placement is convention; a bid from finished plans carries no design contingency", editable: true, value: 0, unit: 'ppm' },
  { id: "A-20", text: "Financing cost placed after profit, computed in one pass", engineDefault: "included, shown as its own line", why: "Our convention; the fixed point is slightly lower", editable: true, value: true, unit: 'boolean' },
  { id: "A-21", text: "Forward escalation rate", engineDefault: "**none: the user enters it**, with a sensitivity range", why: "Published 2.0% to 2.1% is budget guidance; realized changes were higher", editable: true, value: null, unit: 'none' },
  { id: "A-22", text: "Cost-proportional schedule of values; a billing that crosses the 50% point is split pro rata; the Nevada half release arrives with the first payment after 50%", engineDefault: "as stated", why: "Modelling conventions; the statute does not settle the crossing billing", editable: true, value: 'as stated', unit: 'text' },
  { id: "A-23", text: "Winner's-curse inputs", engineDefault: "`kappa = 0` (off) until the contractor sets `sigma` from their own estimate-versus-actual history", why: "Judgment parameters", editable: true, value: 0, unit: 'number' },
  { id: "A-24", text: "Near-optimal tolerance `delta`", engineDefault: "0.05", why: "Product setting, not sourced", editable: true, value: 0.05, unit: 'number' },
  { id: "A-25", text: "Display thresholds", engineDefault: "\"not enough data\" below `J = 10`; no 10% tail below `J = 29`; unit-price band label \"thin\" below `n = 20`, no flag below `n_min = 5`; staleness threshold for dated quotes", why: "Design choices; 29 and 59 are mathematical minimums for tail bounds", editable: true, value: 'J >= 10; tail J >= 29; band n >= 20 (thin), n >= 5 (flag)', unit: 'text' },
  { id: "A-26", text: "Cash-timing conventions", engineDefault: "supplier terms net 30, no deposit, unless entered; pay-first ordering within a period; outflow lags rounded down, inflow lags rounded up", why: "Conventions; contract- and vendor-specific", editable: true, value: 30, unit: 'days' },
  { id: "A-27", text: "Safety buffer on peak float", engineDefault: "`beta = 0`", why: "No authoritative value found", editable: true, value: 0, unit: 'ppm' },
  { id: "A-28", text: "Owner-payment stress cases", engineDefault: "+30 and +60 days", why: "Legal deadlines are maximums for proper undisputed requests; survey averages (51 and 96 days) are unverified", editable: true, value: '30, 60', unit: 'days' },
  { id: "A-29", text: "Day-count basis for financing", engineDefault: "365", why: "Set by the loan agreement; federal late-payment interest uses 360", editable: true, value: 365, unit: 'days' },
  { id: "A-30", text: "Timing details not read", engineDefault: "the federal 14-day period can be lengthened by contract; Nevada retainage release per contract; California late interest on a 365-day basis", why: "From memory or not captured", editable: true, value: 'as stated', unit: 'text' },
  { id: "A-31", text: "Productivity factors", engineDefault: "1.00", why: "Estimator judgment, logged with a reason", editable: true, value: 1000000, unit: 'ppm' },
  { id: "A-32", text: "Location context", engineDefault: "nearest listed ACF site for a county with no row (Carson City for Douglas County); small-area wage ratios flagged low confidence; price parities not shipped", why: "Mapping is ours, not the publisher's; parity values unverified", editable: true, value: 'Carson City for Douglas County', unit: 'text' },
  { id: "A-33", text: "Synthetic-contractor generator fields without a published anchor", engineDefault: "working capital, credit line, bonding limits, crew-size distribution, labor / material / subcontract split", why: "No free published data; marked `ASSUMPTION` in code; simulated companies are never shown as real", editable: false, value: 'test generator only', unit: 'text' },
  { id: "A-34", text: "2027 tables beyond the confirmed wage bases", engineDefault: "Nevada unemployment rates unchanged; California 2027 values not loaded", why: "Not published or not found", editable: true, value: '2026 rates carried into 2027 (Nevada)', unit: 'text' },
  { id: "A-35", text: "PPI series titles and reference bases", engineDefault: "as listed in section 6.5", why: "The keyless API returns values only", editable: true, value: 'as listed in spec 6.5', unit: 'text' },
  { id: "A-36", text: "SBA fee notice exception clause", engineDefault: "none modelled", why: "Clause text truncated", editable: true, value: 'none modelled', unit: 'text' },
  { id: "A-37", text: "Nevada retainage rule applied to small solicited works; mobilization paid like any other cost unless the bid documents stage it", engineDefault: "as stated", why: "Not confirmed for the small-works procedure; schedules are agency-specific", editable: true, value: 'as stated', unit: 'text' },
  { id: "A-38", text: "Dual overhead rate: non-labor base is all of `TJC - L`; weight `X`", engineDefault: "contractor enters `X`", why: "The method is attributed only by secondary sources; no standard `X`", editable: true, value: null, unit: 'none' },
  { id: "A-39", text: "Davis-Bacon coverage threshold", engineDefault: "from the solicitation", why: "Mentioned by the verifier (over $2,000) without a captured quote", editable: true, value: null, unit: 'none' },
  { id: "A-40", text: "Bid-security rule on Nevada and California bid forms", engineDefault: "`difference`", why: "Not checked", editable: true, value: 'difference', unit: 'text' },
];

/** Spec 9 row count; the integrity test also checks a checksum of `${id}|${text}`. */
export const ASSUMPTION_COUNT = 40;

const BY_ID = new Map(ASSUMPTIONS.map((a) => [a.id, a]));

/** The registry row for an id; unknown ids are refused (a result may only cite real section 9 rows). */
export function assumption(id: string): AssumptionRow {
  const a = BY_ID.get(id);
  if (!a) return refuse('UNKNOWN_ASSUMPTION', `no assumption ${id} in spec section 9`);
  return a;
}

/** Canonical text the integrity test hashes: one `${id}|${text}` line per row, in spec order. */
export function assumptionsCanonical(rows: readonly AssumptionRow[] = ASSUMPTIONS): string {
  return rows.map((r) => `${r.id}|${r.text}`).join('\n');
}

/** An AssumptionUsed record for a registry row, with the value actually used in this result. */
export function useAssumption(id: string, valueUsed?: string): AssumptionUsed {
  const a = assumption(id);
  return { id: a.id, text: a.text, value: valueUsed ?? a.engineDefault };
}

/** One line of a result's "assumptions used" list: the registry row plus how this result used it. */
export interface AssumptionReport {
  readonly id: string;
  readonly text: string; // registry text (spec 9)
  readonly engineDefault: string;
  readonly editable: boolean;
  readonly label: 'assumption';
  /** Each distinct way the engine modules described their use of it in this result (deduplicated). */
  readonly usedAs: readonly { readonly text: string; readonly value: string }[];
}

const idNum = (id: string) => Number(id.slice(2));

/**
 * Exactly the assumptions a result used: deduplicated by id, each tied to its registry row,
 * sorted by number. An id that is not in spec 9 is refused rather than shown.
 */
export function assumptionsReport(used: readonly AssumptionUsed[]): AssumptionReport[] {
  const by = new Map<string, { text: string; value: string }[]>();
  for (const u of used) {
    assumption(u.id); // refuses unknown ids
    const list = by.get(u.id) ?? [];
    if (!list.some((x) => x.text === u.text && x.value === u.value)) list.push({ text: u.text, value: u.value });
    by.set(u.id, list);
  }
  return [...by.keys()]
    .sort((a, b) => idNum(a) - idNum(b))
    .map((id) => {
      const a = assumption(id);
      return { id, text: a.text, engineDefault: a.engineDefault, editable: a.editable, label: 'assumption' as const, usedAs: by.get(id)! };
    });
}
