// Integer money primitives for the cost engine (spec section 0).
//
// Everything in the money path is an integer: cents, parts per million, hundredths of an hour,
// thousandths of a unit, millionths of an hour per unit. Intermediate products are BigInt
// (spec 0.1 rule 1); every number handed back must be a safe integer or we throw RangeError.
// Nothing here reads the clock, the network or randomness.

// ---------------------------------------------------------------- errors

/** Every refusal of the engine is a RangeError (spec 0.1 rule 2) carrying a stable code. */
export class CostEngineError extends RangeError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CostEngineError';
    this.code = code;
  }
}

export function refuse(code: string, message: string): never {
  throw new CostEngineError(code, message);
}

// ---------------------------------------------------------------- branded integer types (spec 0.1)

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Integer cents. $45.00 = 4500. Never negative. */
export type Cents = Brand<number, 'Cents'>;
/** Integer parts per million. 6.2% = 62_000; $25 per $1,000 = 25_000; $2.50 per $100 = 25_000. */
export type Ppm = Brand<number, 'Ppm'>;
/** Integer hundredths of an hour. 8.25 h = 825. */
export type HoursC = Brand<number, 'HoursC'>;
/** Integer thousandths of a unit. 2,400 ft = 2_400_000. */
export type QtyM = Brand<number, 'QtyM'>;
/** Integer millionths of an hour per unit (a labor unit). 0.035 h/ft = 35_000. */
export type MicroHours = Brand<number, 'MicroHours'>;
/** Integer days. */
export type Days = Brand<number, 'Days'>;
/** Calendar date 'YYYY-MM-DD'. */
export type IsoDate = Brand<string, 'IsoDate'>;

/** Rounding mode is a named parameter (spec 0.2); half-up is the engine default. */
export type RoundingMode = 'half-up' | 'half-even';

export const PPM_ONE = 1_000_000 as Ppm;
const B_PPM = 1_000_000n;

function checkInt(kind: string, n: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) refuse('NOT_SAFE_INTEGER', `${kind} must be a safe integer, got ${String(n)}`);
  if (n < min) refuse('NEGATIVE', `${kind} must be >= ${min}, got ${n}`);
  if (n > max) refuse('OUT_OF_RANGE', `${kind} must be <= ${max}, got ${n}`);
  return n;
}

export const cents = (n: number): Cents => checkInt('Cents', n) as Cents;
export const ppm = (n: number): Ppm => checkInt('Ppm', n) as Ppm;
export const hoursC = (n: number): HoursC => checkInt('HoursC', n) as HoursC;
export const qtyM = (n: number): QtyM => checkInt('QtyM', n) as QtyM;
export const microHours = (n: number): MicroHours => checkInt('MicroHours', n) as MicroHours;
export const days = (n: number): Days => checkInt('Days', n) as Days;

/** Validate a calendar date 'YYYY-MM-DD' (real month lengths, leap years). Pure: no Date object. */
export function isoDate(s: string): IsoDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) refuse('BAD_DATE', `expected YYYY-MM-DD, got ${JSON.stringify(s)}`);
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const len = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (len === undefined || d < 1 || d > len) refuse('BAD_DATE', `not a calendar date: ${s}`);
  return s as IsoDate;
}

/** Same-format ISO dates compare correctly as strings. */
export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Guard a value already typed as a branded integer (callers from plain JS can pass anything). */
export function assertCents(n: number, what = 'amount'): Cents {
  return checkInt(`${what} (Cents)`, n) as Cents;
}
export function assertPpm(n: number, what = 'rate', min = 0, max = Number.MAX_SAFE_INTEGER): Ppm {
  return checkInt(`${what} (Ppm)`, n, min, max) as Ppm;
}
export function assertHours(n: number, what = 'hours', max = Number.MAX_SAFE_INTEGER): HoursC {
  return checkInt(`${what} (HoursC)`, n, 0, max) as HoursC;
}
export function assertInt(n: number, what: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return checkInt(what, n, min, max);
}

// ---------------------------------------------------------------- BigInt <-> safe number

/** Convert a BigInt result back to a number; throw unless it is a non-negative safe integer (spec 0.1 rule 1). */
export function toSafe(n: bigint, what = 'result'): number {
  if (n < 0n) refuse('NEGATIVE', `${what} is negative (${n})`);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) refuse('UNSAFE_INTEGER', `${what} exceeds 2^53 - 1 (${n})`);
  return Number(n);
}
export const toCents = (n: bigint, what = 'amount'): Cents => toSafe(n, what) as Cents;
export const toPpm = (n: bigint, what = 'rate'): Ppm => toSafe(n, what) as Ppm;

function big(n: bigint | number, what: string): bigint {
  if (typeof n === 'bigint') return n;
  if (!Number.isSafeInteger(n)) refuse('NOT_SAFE_INTEGER', `${what} must be a safe integer, got ${String(n)}`);
  return BigInt(n);
}

// ---------------------------------------------------------------- the one rounding division (spec 0.2)

/**
 * Integer division of n >= 0 by d >= 1, rounded to the nearest integer.
 * 'half-up' (default): ties go up — q = floor(n/d); r = n - q*d; (2r >= d) ? q+1 : q.
 * 'half-even': ties go to the even quotient (NIST HB 130, D-63) — available, never the default.
 */
export function divRound(n: bigint | number, d: bigint | number, mode: RoundingMode = 'half-up'): bigint {
  const N = big(n, 'numerator');
  const D = big(d, 'divisor');
  if (D < 1n) refuse('BAD_DIVISOR', `divisor must be >= 1, got ${D}`);
  if (N < 0n) refuse('NEGATIVE', `numerator must be >= 0, got ${N}`);
  const q = N / D;
  const r = N - q * D;
  if (mode === 'half-up') return 2n * r >= D ? q + 1n : q;
  if (mode === 'half-even') {
    if (2n * r > D) return q + 1n;
    if (2n * r < D) return q;
    return q % 2n === 0n ? q : q + 1n;
  }
  return refuse('BAD_ROUNDING_MODE', `unknown rounding mode ${String(mode)}`);
}

/** Spec 0.2 divRoundHalfUp(n, d). BigInt in, BigInt out. */
export const divRoundHalfUp = (n: bigint | number, d: bigint | number): bigint => divRound(n, d, 'half-up');

/** Ceiling division for n >= 0, d >= 1 (used only by the optional bid rounding, spec 2.14). */
export function divCeil(n: bigint, d: bigint): bigint {
  if (d < 1n) refuse('BAD_DIVISOR', `divisor must be >= 1, got ${d}`);
  if (n < 0n) refuse('NEGATIVE', `numerator must be >= 0, got ${n}`);
  return (n + d - 1n) / d;
}

// ---------------------------------------------------------------- spec 0.2 primitives

/** mulRate(c, r) = divRoundHalfUp(c*r, 10^6): cents times a ppm rate, rounded once. */
export function mulRate(c: Cents, r: Ppm, mode: RoundingMode = 'half-up'): Cents {
  assertCents(c);
  assertPpm(r);
  return toCents(divRound(BigInt(c) * BigInt(r), B_PPM, mode), 'mulRate');
}

/** mulHours(h, rate) = divRoundHalfUp(h*rate, 100): hundredths of an hour times cents per hour. */
export function mulHours(h: HoursC, rate: Cents, mode: RoundingMode = 'half-up'): Cents {
  assertHours(h);
  assertCents(rate, 'hourly rate');
  return toCents(divRound(BigInt(h) * BigInt(rate), 100n, mode), 'mulHours');
}

/** extend(q, waste, unit) = divRoundHalfUp(q*(10^6+waste)*unit, 10^9): a material line extension (spec 2.6). */
export function extend(q: QtyM, waste: Ppm, unit: Cents, mode: RoundingMode = 'half-up'): Cents {
  checkInt('QtyM', q);
  assertPpm(waste, 'waste');
  assertCents(unit, 'unit price');
  return toCents(divRound(BigInt(q) * (B_PPM + BigInt(waste)) * BigInt(unit), 1_000_000_000n, mode), 'extend');
}

/**
 * effRate(rate, W, cap): the effective rate of a capped tax on annual wages W (spec 0.2).
 * Display figure. The engine's tax lines use cappedShare() instead, which rounds once (see specIssues).
 */
export function effRate(rate: Ppm, W: Cents, cap: Cents | null): Ppm {
  assertPpm(rate);
  assertCents(W, 'annual wages W');
  if (cap === null || W <= cap) return rate;
  if (W < 1) refuse('BAD_DIVISOR', 'annual wages W must be > 0');
  assertCents(cap, 'wage base');
  return toPpm(divRoundHalfUp(BigInt(rate) * BigInt(cap), BigInt(W)), 'effRate');
}

/**
 * Tax on this job's wages G under a capped annual base, rounded ONCE:
 * divRoundHalfUp(G * rate * min(W, cap), 10^6 * W). Equals mulRate(G, effRate) except that it
 * skips the intermediate rounding of the rate to whole ppm (spec 2.3, 3.7).
 */
export function cappedShare(G: Cents, rate: Ppm, W: Cents, cap: Cents | null, mode: RoundingMode = 'half-up'): Cents {
  assertCents(G, 'wages G');
  assertPpm(rate);
  assertCents(W, 'annual wages W');
  if (cap === null) return mulRate(G, rate, mode);
  assertCents(cap, 'wage base');
  if (W < 1) refuse('BAD_DIVISOR', 'annual wages W must be > 0 for a capped tax');
  const base = BigInt(Math.min(W, cap));
  return toCents(divRound(BigInt(G) * BigInt(rate) * base, B_PPM * BigInt(W), mode), 'cappedShare');
}

/**
 * Year-to-date slice of a capped base (spec 2.3 mode ytd): min(Y + pay, cap) - min(Y, cap).
 * Slices of consecutive pays sum to min(total, cap) exactly (invariant 24).
 */
export function ytdTaxableSlice(Y: Cents, pay: Cents, cap: Cents | null): Cents {
  assertCents(Y, 'year-to-date wages');
  assertCents(pay, 'pay');
  if (cap === null) return pay;
  assertCents(cap, 'wage base');
  const after = BigInt(Y) + BigInt(pay);
  const c = BigInt(cap);
  const hi = after < c ? after : c;
  const lo = BigInt(Y) < c ? BigInt(Y) : c;
  return toCents(hi - lo, 'ytd slice');
}

/** Sum of cents, exact (BigInt) and range-checked. Totals are sums of rounded lines (spec 0.3). */
export function sumCents(xs: readonly number[]): Cents {
  let s = 0n;
  for (const x of xs) s += BigInt(assertCents(x));
  return toCents(s, 'sum');
}

/** a - b for cents, refusing a negative result. */
export function subCents(a: Cents, b: Cents, what = 'difference'): Cents {
  return toCents(BigInt(assertCents(a)) - BigInt(assertCents(b)), what);
}

/**
 * Largest-remainder allocation (spec 2.15): floor_i = floor(T*w_i/W); the leftover cents go one at a
 * time to the largest remainders (T*w_i) mod W, ties to the lowest index. Parts sum to T exactly.
 */
export function allocate(T: Cents, w: readonly number[]): Cents[] {
  assertCents(T, 'total to allocate');
  if (w.length === 0) refuse('NO_WEIGHTS', 'allocate needs at least one weight');
  const ws = w.map((x, i) => BigInt(assertInt(x, `weight ${i}`)));
  const W = ws.reduce((a, b) => a + b, 0n);
  if (W === 0n) refuse('ZERO_WEIGHTS', 'all weights are zero');
  const t = BigInt(T);
  const floors = ws.map((wi) => (t * wi) / W);
  const rems = ws.map((wi) => (t * wi) % W);
  let left = t - floors.reduce((a, b) => a + b, 0n);
  const order = ws.map((_, i) => i).sort((a, b) => {
    const ra = rems[a]!, rb = rems[b]!;
    return ra > rb ? -1 : ra < rb ? 1 : a - b;
  });
  // left < number of positive-weight lines, and every line with remainder > 0 has positive weight.
  for (const i of order) {
    if (left === 0n) break;
    floors[i] = floors[i]! + 1n;
    left -= 1n;
  }
  return floors.map((f) => toCents(f, 'allocated part'));
}

// ---------------------------------------------------------------- parsing and formatting

/**
 * Parse '$1,234.56', '1234.5', '1234' into cents. Refuses negatives, more than two decimals
 * (a third decimal would need a rounding decision the caller must make) and junk.
 */
export function parseCents(s: string): Cents {
  const t = s.trim().replace(/^\$/, '').replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) refuse('BAD_MONEY', `cannot parse money: ${JSON.stringify(s)}`);
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? '').padEnd(2, '0'));
  return toCents(whole * 100n + frac, 'parsed amount');
}

/** Format cents as '$1,234.56'. */
export function formatCents(c: Cents): string {
  assertCents(c);
  const d = Math.floor(c / 100);
  const r = c % 100;
  return `$${d.toLocaleString('en-US')}.${String(r).padStart(2, '0')}`;
}

/** Format ppm as a percent string with up to 4 decimals, e.g. 62_000 -> '6.2%'. Display only. */
export function formatPpm(r: Ppm): string {
  assertPpm(r);
  const whole = Math.floor(r / 10_000);
  const frac = String(r % 10_000).padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}%` : `${whole}%`;
}

// ---------------------------------------------------------------- exact fractions

/** An exact non-negative-denominator fraction (BigInt). Used by identities and exact checks. */
export interface Ratio {
  readonly num: bigint;
  readonly den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

export function ratio(num: bigint | number, den: bigint | number = 1n): Ratio {
  let n = big(num, 'numerator');
  let d = big(den, 'denominator');
  if (d === 0n) refuse('BAD_DIVISOR', 'zero denominator');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d) || 1n;
  return { num: n / g, den: d / g };
}
export const rAdd = (a: Ratio, b: Ratio): Ratio => ratio(a.num * b.den + b.num * a.den, a.den * b.den);
export const rSub = (a: Ratio, b: Ratio): Ratio => ratio(a.num * b.den - b.num * a.den, a.den * b.den);
export const rMul = (a: Ratio, b: Ratio): Ratio => ratio(a.num * b.num, a.den * b.den);
export function rDiv(a: Ratio, b: Ratio): Ratio {
  if (b.num === 0n) refuse('BAD_DIVISOR', 'division by zero');
  return ratio(a.num * b.den, a.den * b.num);
}
export const rCmp = (a: Ratio, b: Ratio): number => {
  const l = a.num * b.den, r = b.num * a.den;
  return l < r ? -1 : l > r ? 1 : 0;
};
export const rEq = (a: Ratio, b: Ratio): boolean => rCmp(a, b) === 0;
export const fromPpm = (r: Ppm | number): Ratio => ratio(BigInt(r), B_PPM);
/** Round a non-negative ratio to an integer, half-up. */
export function rRound(a: Ratio, mode: RoundingMode = 'half-up'): bigint {
  return divRound(a.num, a.den, mode);
}
/** Round a non-negative ratio to ppm, half-up. */
export const rToPpm = (a: Ratio): Ppm => toPpm(divRoundHalfUp(a.num * B_PPM, a.den));
/** Float view for display only. Never feed it back into the money path (spec 0.1 rule 3). */
export const rToNumber = (a: Ratio): number => Number(a.num) / Number(a.den);
