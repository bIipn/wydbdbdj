// Independent reference for spec section 4 (bid security, bond triggers, SBA fee, retainage, interest).
// From the spec text only; exact rationals, one half-up rounding where the spec rounds.
import { add, cmp, mul, pow, q, roundHalfUp, sub, ZERO, type Q, ONE } from './rational.js';

const MILLION = 1_000_000n;
const B = (x: number) => BigInt(x);
const r = (x: Q) => {
  if (x.n < 0n) throw new RangeError('oracle: negative money');
  return roundHalfUp(x);
};
const mulRate = (c: bigint, ppm: number) => r(q(c * B(ppm), MILLION));

/** spec 4.1: S_bid = required ? min(CAP, max(FLOOR, mulRate(B, p))) : 0. */
export function bidSecurityQ(basis: number, pctPpm: number, floorC: number, cap: number | null, required: boolean): number {
  if (!required) return 0;
  let s = mulRate(B(basis), pctPpm);
  if (s < B(floorC)) s = B(floorC);
  if (cap !== null && s > B(cap)) s = B(cap);
  return Number(s);
}
/** spec 4.1 walk-away exposure. */
export function walkAwayQ(rule: 'federal' | 'difference' | 'forfeiture', sBid: number, bid: number, next: number): number {
  const diff = Math.max(0, next - bid);
  return rule === 'federal' ? diff : rule === 'difference' ? Math.min(sBid, diff) : sBid;
}
/** spec 4.2: strict comparison against a threshold. */
export const triggers = (C: number, threshold: number) => C > threshold;

/** spec 4.4: g by approval date; fee payable rounded to the nearest whole dollar. */
export function sbaFeeQ(C: number, approvalDate: string, switchDate: string, before: number, from: number, guarantee: 'contract' | 'bid_bond'): number {
  if (guarantee === 'bid_bond') return 0;
  const g = approvalDate < switchDate ? before : from;
  return Number(100n * r(q(B(g) * B(C), 10n ** 8n)));
}

export interface RetRule {
  rho1Ppm: number;
  thetaPpm: number | null;
  rho2Ppm: number;
  kappaPpm: number | null;
  dollarCap: number | null;
  halfRelease: boolean;
}
export interface RetRow {
  W: number;
  Rel: number;
  R: number;
  grossWithheld: number;
  pay: number;
  below: Q;
  above: Q;
}
/**
 * spec 4.5, literally, with theta*C kept EXACT (the spec gives it no rounding point). Each part's
 * retainage is rounded half-up on its own; the cap is on gross withheld; one half release.
 */
export function retainageQ(rule: RetRule, C: number, billings: readonly number[]): { rows: RetRow[]; held: number; withheld: number; released: number; thetaC: Q | null } {
  const thetaC = rule.thetaPpm === null ? null : q(B(C) * B(rule.thetaPpm), MILLION);
  let capTotal: bigint | null = null;
  if (rule.kappaPpm !== null) capTotal = mulRate(B(C), rule.kappaPpm);
  if (rule.dollarCap !== null) capTotal = capTotal === null ? B(rule.dollarCap) : capTotal < B(rule.dollarCap) ? capTotal : B(rule.dollarCap);
  let E: Q = ZERO, R = 0n, gross = 0n, firstPart = 0n, released = false, relTotal = 0n;
  const rows: RetRow[] = [];
  for (const b of billings) {
    const Bj = q(B(b));
    let below: Q;
    if (thetaC === null) below = Bj;
    else {
      const room = sub(thetaC, E);
      below = cmp(room, ZERO) <= 0 ? ZERO : cmp(room, Bj) < 0 ? room : Bj;
    }
    const above = sub(Bj, below);
    const wBelow = r(mul(below, q(B(rule.rho1Ppm), MILLION)));
    let W = wBelow + r(mul(above, q(B(rule.rho2Ppm), MILLION)));
    let wFirst = wBelow;
    if (capTotal !== null) {
      const room = capTotal - gross > 0n ? capTotal - gross : 0n;
      if (W > room) {
        W = room;
        if (wFirst > W) wFirst = W;
      }
    }
    firstPart += wFirst;
    let Rel = 0n;
    if (rule.halfRelease && !released && cmp(above, ZERO) > 0 && rule.rho2Ppm > 0) {
      Rel = r(q(firstPart, 2n));
      released = true;
    }
    gross += W;
    R = R + W - Rel;
    relTotal += Rel;
    E = add(E, Bj);
    rows.push({ W: Number(W), Rel: Number(Rel), R: Number(R), grossWithheld: Number(gross), pay: b - Number(W), below, above });
  }
  return { rows, held: Number(R), withheld: Number(gross), released: Number(relTotal), thetaC };
}

/** spec 4.8 simple form, gross of owner interest credits: sum W_j * i * (t_release - tau_j) / basis, one rounding. */
export function retainageFinancingQ(withheld: readonly { W: number; tau: number }[], release: number, ratePpm: number, basis: number): { exact: Q; cents: number } {
  let s: Q = ZERO;
  for (const w of withheld) s = add(s, q(B(w.W) * B(ratePpm) * B(release - w.tau), MILLION * B(basis)));
  return { exact: s, cents: Number(r(s)) };
}
/** spec 4.8 uniform closed form. */
export function retainageUniformQ(rhoPpm: number, C: number, ratePpm: number, T: number, delta: number, Lrel: number, basis: number): Q {
  // rho * C * i * ((T - 1) * Delta / 2 + L) / basis
  return mul(q(B(rhoPpm) * B(C) * B(ratePpm), MILLION * MILLION * B(basis)), add(q(B((T - 1) * delta), 2n), q(B(Lrel))));
}
/** spec 4.7 federal late-payment interest: n whole months, d remaining days. */
export function federalLateQ(P: number, ratePpm: number, months: number, days: number): { exact: Q; cents: number } {
  const rr = q(B(ratePpm), MILLION);
  const monthly = add(ONE, mul(rr, q(1, 12)));
  const daily = add(ONE, mul(rr, q(B(days), 360n)));
  const v = sub(mul(mul(q(B(P)), pow(monthly, months)), daily), q(B(P)));
  return { exact: v, cents: Number(r(v)) };
}
/** spec 4.7 simple interest on a day-count basis. */
export function simpleInterestQ(P: number, ratePpm: number, days: number, basis: number): number {
  return Number(r(q(B(P) * B(ratePpm) * B(days), MILLION * B(basis))));
}
/** spec 4.9 */
export const ldQ = (perDay: number, actual: number, allowed: number) => perDay * Math.max(0, actual - allowed);
