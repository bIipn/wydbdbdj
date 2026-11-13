/**
 * A SIMULATED takeoff for a persona's cost check, built from the cost engine's own seeded company generator
 * (src/cost/synthetic.ts: wages from the D-80 BLS percentiles, overhead and profit from the D-65 ranges, the
 * rest marked ASSUMPTION there). Every figure here is made up for the run and is reported as simulated: it is
 * what a persona would type into the cost form, not a fact about the bid or the market.
 *
 * Pure: same (seed, persona index, bid, target) → same request.
 */
import type { EstimateRequest, LaborClassRequest, PrevailingWage } from '../cost/estimate.js';
import { D80_NV_WAGE_PCTL, percentileSample, Rng, simCompany, type OwnerType } from '../cost/synthetic.js';
import type { Bid } from '../types.js';

export interface SimTakeoff {
  request: EstimateRequest;
  /** Whole dollars the takeoff was sized to (simulated: no captured bid carries an estimate). */
  sizedTo: number;
  ownerType: OwnerType;
  prevailingWage: PrevailingWage;
  /** One line per simulated input, for the report. */
  notes: string[];
}

/** Cents (integer) → "123.45". Integer arithmetic only. */
const usd = (cents: number): string => {
  const c = Math.max(0, Math.round(cents));
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
};
/** Parts per million → percent string with up to 4 decimals ("2.5"). */
const pct = (ppm: number): string => (Math.round(ppm) / 10_000).toFixed(4).replace(/\.?0+$/, '');

/** Who owns the job, from the board it came from (the engine's bond and retainage rules follow the owner). */
export function ownerTypeFor(bid: Bid): OwnerType {
  const state = bid.location.state;
  if (bid.source === 'samgov') return 'federal';
  if (state === 'CA') return 'ca_local';
  if (bid.source === 'questcdn') return 'nv_state_spwd'; // the captured QuestCDN board is NV State Public Works
  return 'nv_local';
}

/**
 * The prevailing-wage regime the persona picks: federal construction → Davis-Bacon; a Nevada bid the board
 * flags "Prevailing wage" → NRS 338; California public works → DIR; otherwise none.
 */
export function prevailingFor(bid: Bid, owner: OwnerType): PrevailingWage {
  if (owner === 'federal') return 'davis_bacon';
  if (owner === 'ca_local' || owner === 'ca_state') return 'ca_dir';
  return bid.flags.some((f) => /prevailing wage/i.test(f)) ? 'nv_338' : 'none';
}

/** Simulated job size: the geometric middle of the persona's own range, in whole dollars. */
export function targetDollars(range: { min: number; max: number }): number {
  const lo = Math.max(1_000, range.min);
  return Math.round(Math.sqrt(lo * Math.max(lo, range.max)));
}

/**
 * A complete takeoff for one bid. `missing` drops named inputs on purpose so the run also exercises the
 * engine's "needed" answer (a quick check with half a form): e.g. ['markups'] leaves overhead and profit out.
 */
export function simTakeoff(seed: number, personaIndex: number, bid: Bid, dollars: number, missing: readonly string[] = []): SimTakeoff {
  const co = simCompany(seed, personaIndex);
  const g = new Rng((seed ^ Math.imul(personaIndex + 101, 0x2545f491)) >>> 0);
  const owner = ownerTypeFor(bid);
  const prevailing = prevailingFor(bid, owner);
  const state = bid.location.state === 'CA' ? 'CA' : 'NV';
  const notes: string[] = [];

  // Cost split (ASSUMPTION, as in synthetic.ts): labor 35–50% of cost, cost ≈ 82% of the job size.
  const costCents = dollars * 100 * 0.82;
  const laborShare = 0.35 + g.next() * 0.15;
  const jw = co.journeymanWage as number;
  const aw = co.apprenticeWage as number;
  const classes: LaborClassRequest[] = [];
  const mk = (label: string, wage: number, share: number): LaborClassRequest => {
    const hours = Math.max(8, Math.round((costCents * laborShare * share) / (wage * 1.45)));
    const base: LaborClassRequest = {
      label, hours: String(hours), wage: usd(wage), planFringe: usd(g.int(150, 900)),
      annualWages: usd(wage * 1_800), workersCompPer100: pct(co.wcRatePpm),
    };
    if (prevailing === 'none') return base;
    // A determination near the D-80 upper half; fringe 30–60% of base (both ASSUMPTION, simulated).
    const basic = Math.round(percentileSample(D80_NV_WAGE_PCTL, 0.5 + g.next() * 0.45));
    const fringe = Math.round(basic * (0.3 + g.next() * 0.3));
    return { ...base, wage: usd(Math.max(wage, basic)), prevailing: { basic: usd(basic), fringe: usd(fringe), fringePaidAs: 'plan' }, planFringe: usd(fringe) };
  };
  classes.push(mk('Journeyman (simulated)', jw, 0.7));
  classes.push(mk('Apprentice (simulated)', aw, 0.3));
  const totalHours = classes.reduce((a, c) => a + Number(c.hours), 0);
  const crew = Math.max(1, Math.min(co.headcount, Math.round(co.headcount / 3) + 1));
  const days = Math.max(5, Math.min(360, Math.ceil(totalHours / (crew * 8)) + 2));
  const start = Date.UTC(2026, 11, 7); // simulated start: Monday 2026-12-07
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const endDate = iso(start + Math.ceil((days * 7) / 5) * 86_400_000);
  notes.push(`labor: ${classes.length} classes, ${totalHours} h, journeyman $${usd(jw)}/h (simulated from BLS D-80 percentiles)`);

  // Materials: 2–5 lines sized to ~40% of cost (ASSUMPTION), simulated quotes.
  const nLines = g.int(2, 5);
  const matCents = costCents * 0.4;
  const lines = Array.from({ length: nLines }, (_, i) => {
    const unit = g.int(500, 250_000);
    const qty = Math.max(1, Math.round(matCents / nLines / unit));
    return { label: `Material line ${i + 1} (simulated)`, quantity: String(qty), unitPrice: usd(unit), wastePercent: String(g.int(0, 8)) };
  });
  const salesTax = state === 'NV' ? g.pick(['6.85', '7.1', '7.6', '8.375']) : g.pick(['7.25', '7.75', '8.75']);
  notes.push(`materials: ${nLines} lines, sales tax ${salesTax}% (simulated persona input)`);

  const request: Record<string, unknown> = {
    job: {
      ownerType: owner, state, prevailingWage: prevailing, estimatedCost: String(dollars),
      startDate: iso(start), endDate,
    },
    labor: {
      classes,
      // The company's own rate when it is in the state of the job; otherwise the new-employer rate there (D-7 NV 2.95%, D-10 CA 3.4%).
      stateUiRatePercent: co.state === state ? pct(co.uiRatePpm) : state === 'NV' ? '2.95' : '3.4',
      ...(state === 'NV'
        ? { mbt: co.mbtMode === 'none' ? { mode: 'none' } : { mode: co.mbtMode, quarterlyGrossWages: usd(co.headcount * jw * 520), quarterlyHealthDeduction: '0' } }
        : { futaCreditReductionPercent: '1.5' }),
      workersComp: { experienceMod: (co.xModPpm / 1_000_000).toFixed(2), policyEffectiveDate: '2026-07-01' },
    },
    materials: { lines, salesTaxPercent: salesTax },
    jobOverhead: [{ label: 'Permit (simulated)', amount: usd(g.int(10_000, 150_000)) }],
    markups: {
      overhead: { method: 'on_cost', percent: pct(co.overheadOnSalesPpm) },
      profitPercent: pct(co.profitOnCostPpm),
    },
    insurance: { generalLiability: co.glReceiptsPpm > 0 ? { basis: 'receipts', per1000: (co.glReceiptsPpm / 1000).toFixed(3) } : { basis: 'none' } },
    bond: { required: 'auto' },
    payment: { billingCycleDays: 30, ownerPayDays: 30, retainageReleaseDays: 45 },
    financing: { include: false },
    limits: {
      cashForJob: usd(co.limits.cashForJob as number), unusedCreditLine: usd(co.limits.unusedCreditLine as number),
    },
  };
  notes.push(`markups: overhead ${pct(co.overheadOnSalesPpm)}% on cost, profit ${pct(co.profitOnCostPpm)}% (simulated within D-65 ranges)`);
  for (const key of missing) delete request[key];
  if (missing.length) notes.push(`left out on purpose: ${missing.join(', ')}`);
  return { request: request as EstimateRequest, sizedTo: dollars, ownerType: owner, prevailingWage: prevailing, notes };
}
