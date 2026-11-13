// Independent reference for spec 7.4(a) + 7.7: the expected-profit optimum by brute force over EVERY cent.
// EV(B) = profitIfWon(B) * count(B)/J - K is compared in exact integers (all EVs share the denominator J).
import type { PriceChargesInput } from '../../src/cost/index.js';
import { grossUpQ, qOf } from './buildup.js';
import { q, roundHalfUp } from './rational.js';

const B = (x: number) => BigInt(x);

export interface Letting {
  anchor: number; // A_j
  lowestCompeting: number; // Lc_j
}
export interface BruteInput {
  lettings: readonly Letting[];
  anchor: number; // A for this job
  TJC: number;
  OH: number;
  FIN: number;
  K: number;
  charges: PriceChargesInput;
  minMarkupPpm: number;
  deltaNum: bigint; // delta = deltaNum / deltaDen (A-24: 1/20)
  deltaDen: bigint;
}
export interface BruteResult {
  floor: number;
  status: 'bid' | 'no_bid';
  best: number;
  bestEvNum: bigint; // EV * J
  low: number;
  high: number;
  inRange: (Bc: number) => boolean;
  J: number;
  count: (Bc: number) => number;
  ev: (Bc: number) => number; // float, display
}

export function bruteForceBid(x: BruteInput): BruteResult {
  const J = x.lettings.length;
  // 7.4(a): win iff x_j > B/A  <=>  Lc_j * A > B * A_j  (exact integers)
  const count = (Bc: number) => {
    let k = 0;
    for (const l of x.lettings) if (B(l.lowestCompeting) * B(x.anchor) > B(Bc) * B(l.anchor)) k++;
    return k;
  };
  const BE = B(x.TJC) + B(x.OH);
  // floor = grossUp(BE * (1 + m_min) + FIN); BE*(1+m_min) rounded half up once (spec gives no rounding point)
  const floorS = roundHalfUp(q(BE * (1_000_000n + B(x.minMarkupPpm)), 1_000_000n)) + B(x.FIN);
  const floor = grossUpQ(floorS, x.charges);
  // beyond the largest jump the win probability is 0 and EV = -K for good
  let hi = floor;
  for (const l of x.lettings) {
    const t = (B(l.lowestCompeting) * B(x.anchor)) / B(l.anchor) + 2n;
    if (t > hi) hi = t;
  }
  const cost = B(x.TJC) + B(x.OH) + B(x.FIN);
  const evNum = (Bc: bigint) => (Bc - qOf(Bc, x.charges) - cost) * B(count(Number(Bc))) - B(x.K) * B(J);
  let best = floor, bestEv = evNum(floor);
  const evs: bigint[] = [];
  for (let b = floor; b <= hi; b++) {
    const e = evNum(b);
    evs.push(e);
    if (e > bestEv) [best, bestEv] = [b, e]; // strict: ties keep the LOWEST price
  }
  let low = -1, high = -1;
  const inSet = (e: bigint) => e * x.deltaDen >= (x.deltaDen - x.deltaNum) * bestEv;
  if (bestEv > 0n) {
    evs.forEach((e, i) => {
      if (inSet(e)) {
        if (low < 0) low = Number(floor) + i;
        high = Number(floor) + i;
      }
    });
  }
  return {
    floor: Number(floor),
    status: bestEv > 0n ? 'bid' : 'no_bid',
    best: Number(best),
    bestEvNum: bestEv,
    low,
    high,
    inRange: (Bc: number) => Bc >= Number(floor) && Bc <= Number(hi) ? inSet(evs[Bc - Number(floor)]!) : false,
    J,
    count,
    ev: (Bc: number) => Number(evNum(B(Bc))) / J,
  };
}
