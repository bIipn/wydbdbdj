/**
 * "Use my location" in onboarding: a point → the nearest ZIP from the same table src/geo/zip.ts uses.
 *
 * Privacy: the browser sends coordinates rounded to 2 decimals (about 1 km), and we round again here in case a
 * client does not. They are used for this one lookup and never stored; only the ZIP the person then saves is kept.
 *
 * Index: ZIP centres bucketed into 1° × 1° cells, built on first use (about 42,000 points). A lookup looks at the
 * cells around the point, ring by ring, and stops once no farther ring can hold anything closer.
 */
import { createRequire } from 'node:module';
import type zipcodes from 'zipcodes';
import { lookupZip, milesBetween, type ZipPlace } from './zip.js';

/** Farther than this from every ZIP centre (out at sea, another country) → no answer, the person types a ZIP. */
export const NEAREST_MAX_MI = 60;

const CELL = 1; // degrees
type Point = { zip: string; lat: number; lng: number };
let grid: Map<string, Point[]> | null = null;

const cellOf = (lat: number, lng: number) => `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;

function index(): Map<string, Point[]> {
  if (grid) return grid;
  const pkg = createRequire(import.meta.url)('zipcodes') as typeof zipcodes;
  const g = new Map<string, Point[]>();
  for (const r of Object.values(pkg.codes)) {
    // lookupZip applies zip.ts's own "usable place" rule (US only, no military routes, no bad rows).
    if (r.country !== 'US' || !lookupZip(r.zip)) continue;
    const key = cellOf(r.latitude, r.longitude);
    const list = g.get(key) ?? [];
    list.push({ zip: r.zip, lat: r.latitude, lng: r.longitude });
    g.set(key, list);
  }
  return (grid = g);
}

/** Rounded to 2 decimals: all the precision a ZIP needs, and no more than that leaves the browser. */
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** The ZIP whose centre is nearest the point, or null when none is within NEAREST_MAX_MI or the point is not a point. */
export function nearestZip(latIn: number, lngIn: number): ZipPlace | null {
  if (!Number.isFinite(latIn) || !Number.isFinite(lngIn) || Math.abs(latIn) > 90 || Math.abs(lngIn) > 180) return null;
  const at = { lat: round2(latIn), lng: round2(lngIn) };
  const g = index();
  const row = Math.floor(at.lat / CELL);
  const col = Math.floor(at.lng / CELL);
  let best: Point | null = null;
  let bestMi = Infinity;
  // One degree of latitude is ~69 mi; a degree of longitude is less, so ring r is at least (r-1)·69·cos(lat) mi away.
  const perRingMi = 69 * Math.max(0.2, Math.cos((Math.min(Math.abs(at.lat), 78) * Math.PI) / 180));
  for (let r = 0; r <= Math.ceil(NEAREST_MAX_MI / perRingMi) + 1; r++) {
    if (best && (r - 1) * perRingMi > bestMi) break;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // only the ring's edge
        for (const p of g.get(`${row + dy}:${col + dx}`) ?? []) {
          const mi = milesBetween(at, p);
          if (mi < bestMi) { best = p; bestMi = mi; }
        }
      }
    }
  }
  return best && bestMi <= NEAREST_MAX_MI ? lookupZip(best.zip) : null;
}
