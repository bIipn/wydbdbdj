// Materials (spec 2.6): extension with waste, per-line escalation hook, sales tax on the taxable base
// only, freight. Waste never touches labor hours (labor is computed elsewhere from the takeoff).

import {
  refuse,
  extend,
  mulRate,
  divRoundHalfUp,
  toCents,
  assertCents,
  assertPpm,
  compareDates,
  type Cents,
  type Ppm,
  type RoundingMode,
} from './money.js';
import { validateMaterialLine, type AssumptionUsed, type Line, type MaterialLine, type MaterialsInput } from './types.js';

export interface MaterialLineResult {
  readonly id: string;
  readonly ext: Cents; // ext_i = extend(q, waste, unitPrice)
  readonly escPpm: Ppm; // e_i actually applied (0 under a covering price hold)
  readonly esc: Cents; // esc_i = mulRate(ext_i, e_i)
  readonly taxable: boolean;
  readonly heldPrice: boolean;
}

export interface MaterialsResult {
  readonly lines: readonly MaterialLineResult[];
  readonly M: Cents; // sum ext_i
  readonly ESC_M: Cents; // sum esc_i
  readonly FRT: Cents;
  readonly TB: Cents; // taxable base
  readonly TAX: Cents;
  readonly MAT: Cents; // M + ESC_M + TAX + FRT
  readonly taxBasis: 'total' | 'line';
  readonly breakdown: readonly Line[];
  readonly assumptions: readonly AssumptionUsed[];
}

/** True when a price hold covers the purchase date: escalation is then exactly 0 (spec 2.6, 6.2). */
export function priceHoldCovers(l: MaterialLine): boolean {
  return l.holdThrough !== undefined && l.purchaseDate !== undefined && compareDates(l.holdThrough, l.purchaseDate) >= 0;
}

/**
 * The Nevada statutory procedure (NRS 372.366, D-61) as written, for testing that it equals mulRate
 * (invariant 5): compute the tax to the third decimal of a dollar (tenths of a cent, truncated), then
 * round up to the next cent when that digit is greater than 4. Reading: truncate-then-round (A-15).
 */
export function nevadaSalesTaxProcedure(amount: Cents, rate: Ppm): Cents {
  assertCents(amount);
  assertPpm(rate);
  const tenthsOfCent = (BigInt(amount) * BigInt(rate)) / 100_000n; // truncated
  const c = tenthsOfCent / 10n;
  return toCents(tenthsOfCent % 10n > 4n ? c + 1n : c);
}

/** Sales tax on a taxable base (spec 2.6), half-up (= the Nevada rule for non-negative amounts). */
export function salesTax(taxableBase: Cents, s: Ppm, mode: RoundingMode = 'half-up'): Cents {
  assertPpm(s, 'sales tax rate', 0, 150_000);
  return mulRate(taxableBase, s, mode);
}

/** All material lines, escalation, tax and freight (spec 2.6). */
export function materialLines(input: MaterialsInput, mode: RoundingMode = 'half-up'): MaterialsResult {
  assertPpm(input.salesTaxPpm, 'sales tax rate s', 0, 150_000);
  assertCents(input.freight, 'freight');
  const taxBasis = input.taxBasis ?? 'total';
  if (taxBasis !== 'total' && taxBasis !== 'line') refuse('BAD_INPUT', `taxBasis must be 'total' or 'line'`);
  const assumptions: AssumptionUsed[] = [];
  const freightTaxable = input.freightTaxable ?? false;
  if (input.freightTaxable === undefined && input.freight > 0)
    assumptions.push({ id: 'A-17', text: 'freight is not taxable (state-specific, unverified)', value: 'freightTaxable = false' });
  const ids = new Set<string>();
  const breakdown: Line[] = [];
  const lines: MaterialLineResult[] = input.lines.map((l, i) => {
    validateMaterialLine(l);
    if (ids.has(l.id)) refuse('BAD_INPUT', `duplicate material line id ${l.id}`);
    ids.add(l.id);
    const ext = extend(l.quantity, l.wastePpm, l.unitPrice, mode);
    const held = priceHoldCovers(l);
    let e = held ? 0 : input.escalation ? input.escalation(l, i) : (l.escalationPpm ?? 0);
    e = assertPpm(e, `escalation e_i for ${l.id} (a negative factor is refused, see spec issues)`);
    const esc = mulRate(ext, e as Ppm, mode);
    breakdown.push({
      key: `materials.${l.id}.ext`,
      label: `Material ${l.id}`,
      amount: ext,
      formula: '2.6 ext_i = extend(q, waste, unitPrice) = q*(10^6+waste)*unit / 10^9',
      base: { name: 'quantity q', amount: l.quantity, unit: 'qtyM' },
      rate: { value: l.unitPrice, unit: 'cents/unit' },
      rounding: 'once-half-up',
    });
    if (esc > 0 || e > 0)
      breakdown.push({
        key: `materials.${l.id}.esc`,
        label: `Escalation ${l.id}`,
        amount: esc,
        formula: '2.6 esc_i = mulRate(ext_i, e_i)',
        base: { name: 'ext_i', amount: ext, unit: 'cents' },
        rate: { value: e, unit: 'ppm' },
        rounding: 'once-half-up',
      });
    return { id: l.id, ext, escPpm: e as Ppm, esc, taxable: l.taxable ?? true, heldPrice: held };
  });
  const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);
  const M = toCents(sum(lines.map((x) => BigInt(x.ext))), 'M');
  const ESC_M = toCents(sum(lines.map((x) => BigInt(x.esc))), 'ESC_M');
  const FRT = input.freight;
  const taxableLines = lines.filter((x) => x.taxable);
  const TB = toCents(
    sum(taxableLines.map((x) => BigInt(x.ext) + BigInt(x.esc))) + (freightTaxable ? BigInt(FRT) : 0n),
    'TB',
  );
  let TAX: Cents;
  if (taxBasis === 'total') TAX = salesTax(TB, input.salesTaxPpm, mode);
  else {
    const per = taxableLines.map((x) => BigInt(salesTax(toCents(BigInt(x.ext) + BigInt(x.esc)), input.salesTaxPpm, mode)));
    if (freightTaxable) per.push(BigInt(salesTax(FRT, input.salesTaxPpm, mode)));
    TAX = toCents(sum(per), 'TAX');
  }
  breakdown.push({
    key: 'materials.TAX',
    label: 'Sales tax',
    amount: TAX,
    formula:
      taxBasis === 'total'
        ? '2.6 TAX = mulRate(TB, s), TB = taxable (ext_i + esc_i) + taxable freight'
        : "2.6 TAX = sum mulRate(ext_i + esc_i, s) (taxBasis 'line')",
    base: { name: 'TB', amount: TB, unit: 'cents' },
    rate: { value: input.salesTaxPpm, unit: 'ppm' },
    rounding: taxBasis === 'total' ? 'once-half-up' : 'sum-of-rounded',
  });
  if (FRT > 0)
    breakdown.push({ key: 'materials.FRT', label: 'Freight', amount: FRT, formula: '2.6 FRT (entered)', rounding: 'exact', ...(input.freightTaxable === undefined ? { assumption: 'A-17' } : {}) });
  const MAT = toCents(BigInt(M) + BigInt(ESC_M) + BigInt(TAX) + BigInt(FRT), 'MAT');
  return { lines, M, ESC_M, FRT, TB, TAX, MAT, taxBasis, breakdown, assumptions };
}

/** Effective-rate helper kept for callers that store e_i from a factor ratio: round((num/den - 1)*10^6). */
export function escalationPpmFromFactor(num: bigint, den: bigint): Ppm {
  if (den <= 0n) refuse('BAD_DIVISOR', 'factor denominator must be > 0');
  if (num < den) refuse('NEGATIVE', 'factor below 1 gives a negative escalation; refused (see spec issues)');
  return toCents(divRoundHalfUp((num - den) * 1_000_000n, den)) as number as Ppm;
}
