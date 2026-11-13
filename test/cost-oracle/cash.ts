// Independent reference for spec section 5: a plain period-by-period cash loop in exact rationals,
// plus the closed form of spec 5.5. Only two things are rounded, because they are money that changes
// hands in whole cents: each bill amount E(t_j) (half up, cumulative, spec 5.3) and the retainage parts
// (spec 4.5). Costs and their payments stay exact fractions (spec 5.2 states them as C_k * w_k(t)).
import type { CashJobInput } from '../../src/cost/cash.js';
import { retainageQ, type RetRule } from './bonds.js';
import { add, cmp, div, max, mul, neg, q, roundHalfUp, sub, sum, ZERO, ONE, type Q, min } from './rational.js';

const B = (x: number) => BigInt(x);
const MILLION = 1_000_000n;

export interface CashOracle {
  H: number;
  Ccash: Q;
  OUT: Q[];
  IN: Q[];
  K: Q[];
  Nminus: Q[];
  N: Q[];
  bills: { t: number; A: number; W: number; Rel: number; receivedAt: number }[];
  F: Q;
  tStar: number;
  Frf: Q;
  upFront: Q;
  dollarDays: Q;
  finalCash: Q;
}

export function cashOracle(job: CashJobInput): CashOracle {
  const D = job.workPeriods, b = job.billingPeriods, lam = job.ownerLagPeriods, lamR = job.retainageReleasePeriods;
  const outAt = new Map<number, Q>();
  const inAt = new Map<number, Q>();
  const incAt = new Map<number, Q>();
  const put = (m: Map<number, Q>, t: number, v: Q) => m.set(t, add(m.get(t) ?? ZERO, v));
  let Ccash: Q = ZERO;
  for (const c of job.categories) {
    const C = q(B(c.amount));
    Ccash = add(Ccash, C);
    const Wsum = c.weights.reduce((a, w) => a + w, 0);
    if (Wsum <= 0) throw new RangeError('oracle: all-zero weights');
    const d = c.deposit ? q(B(c.deposit.sharePpm), MILLION) : ZERO;
    if (c.deposit) put(outAt, c.deposit.period, mul(d, C));
    c.weights.forEach((w, t) => {
      if (w === 0) return;
      const inc = mul(C, q(B(w), B(Wsum)));
      put(incAt, t, inc); // spec 5.2 c(t)
      put(outAt, t + c.lagPeriods, mul(sub(ONE, d), inc)); // (1 - d_k) C_k w_k(t - l_k)
    });
  }
  // spec 5.3 bills at t_j = min(j*b, D), j = 1..ceil(D/b); E(t) = P*K(t)/C_cash rounded to the cent
  const P = q(B(job.price));
  const Kat = (t: number) => sum([...incAt.entries()].filter(([s]) => s <= t).map(([, v]) => v));
  const J = Math.ceil(D / b);
  const billT: number[] = [];
  for (let j = 1; j <= J; j++) billT.push(Math.min(j * b, D));
  const Er = billT.map((t) => roundHalfUp(div(mul(P, Kat(t)), Ccash)));
  const A = Er.map((e, i) => Number(e - (i === 0 ? 0n : Er[i - 1]!)));
  const ret = retainageQ(job.retainage as unknown as RetRule, job.price, A);
  const bills = billT.map((t, i) => {
    const row = ret.rows[i]!;
    put(inAt, t + lam, q(B(A[i]! - row.W + row.Rel))); // net payment, and a half release with it (A-22)
    return { t, A: A[i]!, W: row.W, Rel: row.Rel, receivedAt: t + lam };
  });
  const finalAt = D + lamR;
  if (finalAt < billT[billT.length - 1]! + lam) throw new RangeError('oracle: release before the last receipt');
  put(inAt, finalAt, q(B(ret.held)));
  const H = Math.max(finalAt, ...outAt.keys(), ...inAt.keys());
  const OUT: Q[] = [], IN: Q[] = [], K: Q[] = [], Nminus: Q[] = [], N: Q[] = [];
  let prev: Q = ZERO, k: Q = ZERO;
  let F: Q = ZERO, tStar = 0, Frf: Q = ZERO, dd: Q = ZERO, upFront: Q = ZERO;
  let firstIn = -1;
  for (let t = 0; t <= H; t++) {
    const o = outAt.get(t) ?? ZERO, i = inAt.get(t) ?? ZERO;
    k = add(k, incAt.get(t) ?? ZERO);
    const nm = sub(prev, o);
    const nn = add(nm, i);
    OUT.push(o); IN.push(i); K.push(k); Nminus.push(nm); N.push(nn);
    if (cmp(neg(nm), F) > 0) [F, tStar] = [neg(nm), t];
    if (cmp(neg(nn), Frf) > 0) Frf = neg(nn);
    if (cmp(nn, ZERO) < 0) dd = add(dd, mul(neg(nn), q(B(job.periodDays))));
    if (firstIn < 0) upFront = add(upFront, o);
    if (firstIn < 0 && cmp(i, ZERO) > 0) firstIn = t;
    prev = nn;
  }
  return { H, Ccash, OUT, IN, K, Nminus, N, bills, F, tStar, Frf, upFront, dollarDays: dd, finalCash: prev };
}

/** spec 5.6: interest on the opening balance each period, exact; FIN rounded once. */
export function financingOracle(c: CashOracle, periodDays: number, ratePpm: number, basis: number): { FIN: number; exact: Q; simple: Q; finalCash: Q } {
  const iper = q(B(ratePpm) * B(periodDays), MILLION * B(basis));
  let Nf: Q = ZERO, tot: Q = ZERO, simple: Q = ZERO;
  for (let t = 0; t <= c.H; t++) {
    const I = mul(iper, max(ZERO, neg(Nf)));
    tot = add(tot, I);
    Nf = sub(add(Nf, c.IN[t]!), add(c.OUT[t]!, I));
    simple = add(simple, mul(iper, max(ZERO, neg(c.N[t]!))));
  }
  return { FIN: Number(roundHalfUp(tot)), exact: tot, simple, finalCash: Nf };
}

/**
 * spec 5.5 closed form, uniform cost paid when incurred:
 * F* = (C/D) max_j [min(t_j + lam, D) - g t_{j-1}], g = (1 - r)(1 + m); if g >= 1, F* = C min(1, (b + lam)/D).
 */
export function closedFormOracle(C: Q, P: Q, D: number, b: number, lam: number, rPpm: number): Q {
  const g = mul(sub(ONE, q(B(rPpm), MILLION)), div(P, C));
  if (cmp(g, ONE) >= 0) return mul(C, min(ONE, q(B(b + lam), B(D))));
  const J = Math.ceil(D / b);
  let best: Q | null = null;
  for (let j = 1; j <= J; j++) {
    const tj = Math.min(j * b, D), tp = j === 1 ? 0 : Math.min((j - 1) * b, D);
    const v = sub(q(B(Math.min(tj + lam, D))), mul(g, q(B(tp))));
    if (best === null || cmp(v, best) > 0) best = v;
  }
  return mul(div(C, q(B(D))), best!);
}
