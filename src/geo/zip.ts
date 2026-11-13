/**
 * ZIP → place, city + state → place, and which states a radius touches (onboarding).
 *
 * Data: the `zipcodes` npm package, v8.0.0 — BSD licence, © 2007 Dav Glass, published 2018-10-27. Its README
 * credits federalgovernmentzipcodes.us for the ZIP list; its build script takes coordinates from GeoNames
 * where GeoNames has them. So a ZIP created after 2018 is unknown here (null), and a point is the middle of a
 * ZIP, not an address. About 41,900 US ZIPs are usable: every state, DC and the territories, PO-box ZIPs included.
 * Left out: Canada, and military APO/FPO/DPO codes (AA/AE/AP) — those are mail routes, not places.
 * Cost: nothing at import; the first lookup reads and indexes the table (about 0.3 s and 30 MB, once).
 */
import { createRequire } from 'node:module';
import type zipcodes from 'zipcodes';

export interface ZipPlace {
  zip: string;
  city: string;
  state: string; // 2-letter
  lat: number;
  lng: number;
}

export type CityPlace = Omit<ZipPlace, 'zip'>;

type LatLng = { lat: number; lng: number };
type Row = (typeof zipcodes)['codes'][string];

interface Table {
  rows: Record<string, Row>; // the package's own table, keyed by ZIP
  cities: Map<string, CityPlace>; // "NV:carsoncity" → the middle of that city's ZIPs
  byState: Array<{ state: string; points: LatLng[] }>; // sorted by state code
  stateNames: (typeof zipcodes)['states'];
}

const MILITARY = new Set(['AA', 'AE', 'AP']);
const LONG: Record<string, string> = { st: 'saint', ste: 'sainte', ft: 'fort', mt: 'mount' };
const MILES_PER_DEGREE_LAT = 69; // a touch under the true 69.09, so the latitude band below never cuts too tight

let table: Table | null = null;

/** Haversine distance in miles. */
export function milesBetween(a: LatLng, b: LatLng): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * A row we can use as a place. The US and its territories all sit between Palau (134°E) and the Virgin Islands
 * (65°W) going east across the Pacific; a longitude outside that is a bad row (one New York ZIP, 10200, has its
 * sign flipped, which would drag "New York, NY" 49 miles out to sea).
 */
function usable(r: Row): boolean {
  return r.country === 'US' && !MILITARY.has(r.state) && (r.longitude < -60 || r.longitude > 130);
}

/** "St. Louis" → "saint louis", "FT WORTH" → "fort worth", "Coeur d'Alene" → "coeur d alene". */
function words(name: string): string {
  return name.normalize('NFD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/\b(?:st|ste|ft|mt)(?= )/g, (w) => LONG[w]!);
}

/** Spaces go too, so "Mc Lean" = "McLean" and "La Grange" = "LaGrange" (no two towns in one state collide). */
function cityKey(state: string, spaced: string): string {
  return `${state}:${spaced.replace(/ /g, '')}`;
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** The table is 5 MB of JavaScript, so it is read and indexed on first use, not when the server starts. */
function load(): Table {
  if (table) return table;
  const pkg = createRequire(import.meta.url)('zipcodes') as typeof zipcodes;
  const sums = new Map<string, CityPlace & { n: number }>();
  const points = new Map<string, LatLng[]>();
  for (const r of Object.values(pkg.codes)) {
    if (!usable(r)) continue;
    const key = cityKey(r.state, words(r.city));
    const sum = sums.get(key) ?? { city: r.city, state: r.state, lat: 0, lng: 0, n: 0 };
    sum.lat += r.latitude;
    sum.lng += r.longitude;
    sum.n += 1;
    sums.set(key, sum);
    const pts = points.get(r.state) ?? [];
    pts.push({ lat: r.latitude, lng: r.longitude });
    points.set(r.state, pts);
  }
  const cities = new Map<string, CityPlace>();
  for (const [key, s] of sums) cities.set(key, { city: s.city, state: s.state, lat: round4(s.lat / s.n), lng: round4(s.lng / s.n) });
  const byState = [...points].sort(([a], [b]) => (a < b ? -1 : 1)).map(([state, pts]) => ({ state, points: pts }));
  return (table = { rows: pkg.codes, cities, byState, stateNames: pkg.states });
}

/** "89410", "89410-1234" or "894101234" → that ZIP's place. Leading zeros count ("02108" is Boston). Unknown → null. */
export function lookupZip(zip: string): ZipPlace | null {
  const m = /^\s*(\d{5})(?:[-\s]?\d{4})?\s*$/.exec(zip);
  const row = m ? load().rows[m[1]!] : undefined;
  if (!row || !usable(row)) return null;
  return { zip: row.zip, city: row.city, state: row.state, lat: row.latitude, lng: row.longitude };
}

/**
 * City + state (code or full name) → the middle of that city's ZIPs. Forgiving about case, punctuation,
 * "St." / "Ft." / "Mt.", and a state repeated after the city ("Reno, NV", "Kansas City, Kansas").
 */
export function lookupCity(city: string, state: string): CityPlace | null {
  const { cities, stateNames } = load();
  const given = state.trim().toUpperCase();
  const code = given.length === 2 ? given : stateNames.normalize(given);
  if (!code) return null;
  const spaced = words(city);
  const tail = [code.toLowerCase(), stateNames.abbr[code]?.toLowerCase()].find((t) => t && spaced.endsWith(` ${t}`));
  const hit = cities.get(cityKey(code, spaced)) ?? (tail ? cities.get(cityKey(code, spaced.slice(0, -tail.length))) : undefined);
  return hit ? { ...hit } : null;
}

/**
 * 2-letter codes (sorted) of every state, DC or territory with at least one ZIP within `radiusMi` of the point —
 * feeds Profile.states. ZIP centres stand in for "ground" because bids are placed on those same centres.
 * A negative or NaN radius, or a point that is not a number, matches nothing.
 */
export function statesWithin(center: LatLng, radiusMi: number): string[] {
  const band = radiusMi / MILES_PER_DEGREE_LAT; // nothing further north or south than this can be in range
  return load().byState
    .filter((s) => s.points.some((p) => Math.abs(p.lat - center.lat) <= band && milesBetween(center, p) <= radiusMi))
    .map((s) => s.state);
}
