// Independent reference for spec section 6 (time). Index values are parsed from their published decimal
// text; ratios are exact; the irrational forward factor (1 + r)^(m/12) is never evaluated in floating point:
// a rounded result is found by comparing 12th powers of exact rationals (x < y <=> x^12 < y^12 for x, y > 0).
import { add, cmp, dec, div, mul, pow, q, roundHalfUp, sub, ONE, type Q } from './rational.js';

const B = (x: number) => BigInt(x);
const MILLION = 1_000_000n;

export interface Obs {
  period: string; // 'YYYY-MM'
  value: string;
  preliminary: boolean;
}
export const monthOrd = (p: string) => {
  const [y, m] = p.split('-').map(Number);
  return y! * 12 + (m! - 1);
};
export const monthOfDate = (d: string) => d.slice(0, 7);

function indexAt(obs: readonly Obs[], ord: number): Q {
  const o = obs.find((x) => monthOrd(x.period) === ord);
  if (!o) throw new RangeError('oracle: missing index value');
  const v = dec(o.value);
  if (v.n <= 0n) throw new RangeError('oracle: index <= 0');
  return v;
}
/** spec 6.1: C(t2) = C(t1) * I(t2)/I(t1), rounded once. */
export function escalateLineQ(c: number, i1: string, i2: string): number {
  return Number(roundHalfUp(mul(q(B(c)), div(dec(i2), dec(i1)))));
}

/** Smallest integer X with  value < X + 1/2,  where value^12 = base12 (exact, base12 >= 0). Half-up rounding of value. */
function roundTwelfthRoot(base12: Q, scale: Q, lo: bigint, hi: bigint): bigint {
  // find smallest X in [lo, hi] such that base12 < ((X + 1/2)/scale)^12, assuming (X+1/2)/scale > 0
  const ok = (X: bigint) => {
    const y = div(add(q(X), q(1, 2)), scale);
    if (y.n <= 0n) return false;
    return cmp(base12, pow(y, 12)) < 0;
  };
  while (!ok(hi)) hi = hi * 2n + 1n; // grow the window until it brackets the root
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    if (ok(mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/** round(C * (1 + r)^(m/12)) to the cent, half up, exactly (spec 6.2, I-18). */
export function escalateForwardQ(c: number, rPpm: number, m: number): number {
  const base12 = mul(pow(q(B(c)), 12), pow(q(MILLION + B(rPpm), MILLION), m));
  return Number(roundTwelfthRoot(base12, ONE, 0n, B(c) * 64n + 10n));
}

export interface QuoteQ {
  quotedOn: string;
  purchaseDate: string;
  holdThrough?: string;
  obs?: readonly Obs[];
  rFwdPpm?: number;
}
/**
 * spec 6.2: factor = hist * (1 + r_fwd)^(m/12); e = round((factor - 1) * 10^6), half up.
 * A price hold through the purchase date gives exactly 0. The historical part stops at the latest FINAL month,
 * or at the purchase month when that is earlier (then no forward months are left: m = 0).
 */
export function ePpmQ(x: QuoteQ): { ePpm: number; hist: Q; m: number } {
  if (x.purchaseDate < x.quotedOn) throw new RangeError('oracle: purchase dated before its quote');
  if (x.holdThrough && x.holdThrough >= x.purchaseDate) return { ePpm: 0, hist: ONE, m: 0 };
  const qm = monthOrd(monthOfDate(x.quotedOn)), pm = monthOrd(monthOfDate(x.purchaseDate));
  let hist: Q = ONE;
  let start = qm;
  if (x.obs && x.obs.length) {
    const finals = x.obs.filter((o) => !o.preliminary).map((o) => monthOrd(o.period));
    if (!finals.length) throw new RangeError('oracle: no final index value');
    const tLast = Math.max(...finals);
    const end = Math.min(tLast, pm);
    if (qm < end) hist = div(indexAt(x.obs, end), indexAt(x.obs, qm));
    start = Math.max(qm, tLast);
  }
  const m = Math.max(0, pm - start);
  if (m > 0 && x.rFwdPpm === undefined) throw new RangeError('oracle: forward months need r_fwd (A-21)');
  const r = x.rFwdPpm ?? 0;
  // value = (factor - 1) * 10^6 ; find e with  factor < 1 + (e + 1/2)/10^6, smallest such e
  // factor^12 = hist^12 * (1+r)^m ; compare with ((10^6 + e + 1/2)/10^6)^12  -> shift X = 10^6 + e
  const base12 = mul(pow(hist, 12), pow(q(MILLION + B(r), MILLION), m));
  const X = roundTwelfthRoot(base12, q(MILLION), 1n, 64n * MILLION);
  return { ePpm: Number(X - MILLION), hist, m };
}

/** spec 6.4: F(Y) = prod (1 + r_y), F(base) = 1. */
export function factorTableQ(ratesPpm: readonly number[]): Q[] {
  const out: Q[] = [ONE];
  for (const r of ratesPpm) out.push(mul(out[out.length - 1]!, q(MILLION + B(r), MILLION)));
  return out;
}
/** spec 6.4 linear DoD interpolation between two 1 October anchors; m = months after anchor k. */
export function interpolateQ(Fk: Q, Fk1: Q, m: number): Q {
  return add(Fk, mul(q(B(m), 12n), sub(Fk1, Fk)));
}
/** spec 6.6 composite / 6.1 dollar-weighted factor of escalated lines. */
export function compositeQ(lines: readonly { amount: number; factor: Q }[]): Q {
  const tot = lines.reduce((a, l) => a + B(l.amount), 0n);
  const adj = lines.reduce((a, l) => add(a, mul(q(B(l.amount)), l.factor)), q(0));
  return div(adj, q(tot));
}
