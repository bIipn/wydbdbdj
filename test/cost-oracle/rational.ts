// Independent reference (spec 10.0 layer L5): exact BigInt rationals. No code shared with src/cost.
// Every value is a normalised fraction n/d with d > 0. Rounding happens ONLY where a caller asks for it,
// at the rounding points the spec lists (spec 0.3).

export interface Q {
  readonly n: bigint;
  readonly d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function q(n: bigint | number, d: bigint | number = 1n): Q {
  let N = BigInt(n);
  let D = BigInt(d);
  if (D === 0n) throw new RangeError('oracle: zero denominator');
  if (D < 0n) [N, D] = [-N, -D];
  const g = gcd(N, D) || 1n;
  return { n: N / g, d: D / g };
}

export const ZERO = q(0);
export const ONE = q(1);
export const add = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
export const div = (a: Q, b: Q): Q => {
  if (b.n === 0n) throw new RangeError('oracle: division by zero');
  return q(a.n * b.d, a.d * b.n);
};
export const cmp = (a: Q, b: Q): number => {
  const l = a.n * b.d, r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
};
export const eq = (a: Q, b: Q) => cmp(a, b) === 0;
export const lt = (a: Q, b: Q) => cmp(a, b) < 0;
export const le = (a: Q, b: Q) => cmp(a, b) <= 0;
export const max = (a: Q, b: Q) => (cmp(a, b) >= 0 ? a : b);
export const min = (a: Q, b: Q) => (cmp(a, b) <= 0 ? a : b);
export const sum = (xs: readonly Q[]) => xs.reduce(add, ZERO);
export const neg = (a: Q): Q => q(-a.n, a.d);
export const isInt = (a: Q) => a.d === 1n;

/** floor for any sign. */
export function floor(a: Q): bigint {
  const r = a.n / a.d; // truncates toward zero
  return a.n < 0n && r * a.d !== a.n ? r - 1n : r;
}
export function ceil(a: Q): bigint {
  return -floor(neg(a));
}
/** Half-up = floor(x + 1/2): ties go up (spec 0.2 divRoundHalfUp, extended to all signs). */
export function roundHalfUp(a: Q): bigint {
  return floor(add(a, q(1, 2)));
}
/** Integer power of a rational. */
export function pow(a: Q, k: number): Q {
  let r = ONE;
  for (let i = 0; i < k; i++) r = mul(r, a);
  return r;
}
/** Parse a published decimal string ("564.877") exactly. */
export function dec(s: string): Q {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new RangeError(`oracle: bad decimal ${s}`);
  const frac = m[3] ?? '';
  const v = q(BigInt(m[2]! + frac), 10n ** BigInt(frac.length));
  return m[1] ? neg(v) : v;
}
/** ppm -> fraction. */
export const ppmQ = (p: number | bigint) => q(BigInt(p), 1_000_000n);
export const toNum = (a: Q) => Number(a.n) / Number(a.d); // display / tolerance only
export const big = (n: number) => BigInt(n);
/** Exact -> safe number or throw (the engine's own safe-integer rule, re-stated here). */
export function safe(n: bigint, what = 'value'): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`oracle: ${what} not a safe integer`);
  return Number(n);
}
