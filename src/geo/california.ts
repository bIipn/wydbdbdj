/**
 * California reference tables: the 58 counties with their county seats, the 12 Caltrans districts, and the state
 * campuses and facilities the Cal eProcure list names often enough to place (src/geo/caleprocure-place.ts).
 *
 * A county's point is its county seat, through lookupCity(seat, 'CA') (the nationwide ZIP table, ./zip.ts):
 * test/california.test.ts proves all 58 resolve and that no two counties share a name or a seat.
 *
 * Sources:
 *   - Counties and seats: the California State Association of Counties' county list (counties.org, "County
 *     Websites"), the same 58 seats the Secretary of State lists. Ventura's seat is officially "San Buenaventura";
 *     the ZIP table (and everyone else) calls the city Ventura.
 *   - Caltrans districts: Caltrans' own "Caltrans Near Me" district pages (dot.ca.gov/caltrans-near-me/district-1 …
 *     district-12), each of which names its counties and its district office. Kern is split between District 6
 *     (west) and District 9 (east), so it is listed in both. District 12's office moved from Santa Ana to Irvine.
 *     test/california.test.ts checks the table against every real Caltrans row of the 2026-11-14 Cal eProcure list.
 *   - Campuses and facilities: only places whose town is certain (the campus or institution is in that town); see
 *     the notes on each row. Anything less certain is left out on purpose: an unplaced card is honest, a wrong place
 *     is not.
 */
import { lookupCity, milesBetween, type CityPlace } from './zip.js';

type LatLng = { lat: number; lng: number };

export interface CaCounty {
  /** "San Luis Obispo" (no "County"). */
  name: string;
  /** The county seat, as the ZIP table spells the city. */
  seat: string;
}

/** The 58 counties of California and their county seats. */
export const CA_COUNTIES: readonly CaCounty[] = [
  { name: 'Alameda', seat: 'Oakland' },
  { name: 'Alpine', seat: 'Markleeville' },
  { name: 'Amador', seat: 'Jackson' },
  { name: 'Butte', seat: 'Oroville' },
  { name: 'Calaveras', seat: 'San Andreas' },
  { name: 'Colusa', seat: 'Colusa' },
  { name: 'Contra Costa', seat: 'Martinez' },
  { name: 'Del Norte', seat: 'Crescent City' },
  { name: 'El Dorado', seat: 'Placerville' },
  { name: 'Fresno', seat: 'Fresno' },
  { name: 'Glenn', seat: 'Willows' },
  { name: 'Humboldt', seat: 'Eureka' },
  { name: 'Imperial', seat: 'El Centro' },
  { name: 'Inyo', seat: 'Independence' },
  { name: 'Kern', seat: 'Bakersfield' },
  { name: 'Kings', seat: 'Hanford' },
  { name: 'Lake', seat: 'Lakeport' },
  { name: 'Lassen', seat: 'Susanville' },
  { name: 'Los Angeles', seat: 'Los Angeles' },
  { name: 'Madera', seat: 'Madera' },
  { name: 'Marin', seat: 'San Rafael' },
  { name: 'Mariposa', seat: 'Mariposa' },
  { name: 'Mendocino', seat: 'Ukiah' },
  { name: 'Merced', seat: 'Merced' },
  { name: 'Modoc', seat: 'Alturas' },
  { name: 'Mono', seat: 'Bridgeport' },
  { name: 'Monterey', seat: 'Salinas' },
  { name: 'Napa', seat: 'Napa' },
  { name: 'Nevada', seat: 'Nevada City' },
  { name: 'Orange', seat: 'Santa Ana' },
  { name: 'Placer', seat: 'Auburn' },
  { name: 'Plumas', seat: 'Quincy' },
  { name: 'Riverside', seat: 'Riverside' },
  { name: 'Sacramento', seat: 'Sacramento' },
  { name: 'San Benito', seat: 'Hollister' },
  { name: 'San Bernardino', seat: 'San Bernardino' },
  { name: 'San Diego', seat: 'San Diego' },
  { name: 'San Francisco', seat: 'San Francisco' },
  { name: 'San Joaquin', seat: 'Stockton' },
  { name: 'San Luis Obispo', seat: 'San Luis Obispo' },
  { name: 'San Mateo', seat: 'Redwood City' },
  { name: 'Santa Barbara', seat: 'Santa Barbara' },
  { name: 'Santa Clara', seat: 'San Jose' },
  { name: 'Santa Cruz', seat: 'Santa Cruz' },
  { name: 'Shasta', seat: 'Redding' },
  { name: 'Sierra', seat: 'Downieville' },
  { name: 'Siskiyou', seat: 'Yreka' },
  { name: 'Solano', seat: 'Fairfield' },
  { name: 'Sonoma', seat: 'Santa Rosa' },
  { name: 'Stanislaus', seat: 'Modesto' },
  { name: 'Sutter', seat: 'Yuba City' },
  { name: 'Tehama', seat: 'Red Bluff' },
  { name: 'Trinity', seat: 'Weaverville' },
  { name: 'Tulare', seat: 'Visalia' },
  { name: 'Tuolumne', seat: 'Sonora' },
  { name: 'Ventura', seat: 'Ventura' },
  { name: 'Yolo', seat: 'Woodland' },
  { name: 'Yuba', seat: 'Marysville' },
];

export interface CaltransDistrict {
  district: number;
  /** The district office's city. */
  office: string;
  /** Its counties, alphabetical. */
  counties: readonly string[];
}

/** Caltrans' 12 districts (dot.ca.gov/caltrans-near-me/district-N). Kern is in 6 (west) and 9 (east). */
export const CALTRANS_DISTRICTS: readonly CaltransDistrict[] = [
  { district: 1, office: 'Eureka', counties: ['Del Norte', 'Humboldt', 'Lake', 'Mendocino'] },
  { district: 2, office: 'Redding', counties: ['Lassen', 'Modoc', 'Plumas', 'Shasta', 'Siskiyou', 'Tehama', 'Trinity'] },
  {
    district: 3, office: 'Marysville',
    counties: ['Butte', 'Colusa', 'El Dorado', 'Glenn', 'Nevada', 'Placer', 'Sacramento', 'Sierra', 'Sutter', 'Yolo', 'Yuba'],
  },
  {
    district: 4, office: 'Oakland',
    counties: ['Alameda', 'Contra Costa', 'Marin', 'Napa', 'San Francisco', 'San Mateo', 'Santa Clara', 'Solano', 'Sonoma'],
  },
  { district: 5, office: 'San Luis Obispo', counties: ['Monterey', 'San Benito', 'San Luis Obispo', 'Santa Barbara', 'Santa Cruz'] },
  { district: 6, office: 'Fresno', counties: ['Fresno', 'Kern', 'Kings', 'Madera', 'Tulare'] },
  { district: 7, office: 'Los Angeles', counties: ['Los Angeles', 'Ventura'] },
  { district: 8, office: 'San Bernardino', counties: ['Riverside', 'San Bernardino'] },
  { district: 9, office: 'Bishop', counties: ['Inyo', 'Kern', 'Mono'] },
  {
    district: 10, office: 'Stockton',
    counties: ['Alpine', 'Amador', 'Calaveras', 'Mariposa', 'Merced', 'San Joaquin', 'Stanislaus', 'Tuolumne'],
  },
  { district: 11, office: 'San Diego', counties: ['Imperial', 'San Diego'] },
  { district: 12, office: 'Irvine', counties: ['Orange'] },
];

const byKey = new Map(CA_COUNTIES.map((c) => [c.name.toLowerCase(), c]));

/** "san luis obispo" / "San Luis Obispo County" → the county; anything else → null. */
export function caCounty(name: string | null | undefined): CaCounty | null {
  if (!name) return null;
  return byKey.get(name.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s+county$/, '')) ?? null;
}

const seatCache = new Map<string, CityPlace | null>();

/** A county's point: its seat through the ZIP table (null only if the table lost the town, which a test rules out). */
export function seatOf(county: string): CityPlace | null {
  const c = caCounty(county);
  if (!c) return null;
  if (!seatCache.has(c.name)) seatCache.set(c.name, lookupCity(c.seat, 'CA'));
  return seatCache.get(c.name) ?? null;
}

export function districtOf(n: number): CaltransDistrict | null {
  return CALTRANS_DISTRICTS.find((d) => d.district === n) ?? null;
}

/**
 * The Caltrans district in an event id of department 2660, as the Cal eProcure list writes them: construction
 * "10-1H0204" (district, then the expenditure authorisation) and service contracts "03A4243" (district, "A", number).
 * Only 01–12 are districts; other leading numbers (32, 56, 75 …) are headquarters programs that name their counties
 * in the title instead, so they give null.
 */
export function caltransDistrictInId(eventId: string): CaltransDistrict | null {
  const m = /^(\d{2})(?:-|A\d)/.exec(eventId.trim());
  return m ? districtOf(Number(m[1])) : null;
}

/** Miles from a point to the nearest seat of the given counties (Infinity when none resolves). */
export function nearestSeatMiles(from: LatLng, counties: readonly string[]): number {
  let best = Infinity;
  for (const c of counties) {
    const s = seatOf(c);
    if (s) best = Math.min(best, milesBetween(from, s));
  }
  return best;
}

/** The county whose seat is nearest to a point (used to say a town lies in a county it was named with). */
export function nearestCounty(from: LatLng): CaCounty {
  let best: CaCounty = CA_COUNTIES[0]!;
  let d = Infinity;
  for (const c of CA_COUNTIES) {
    const s = seatOf(c.name);
    const m = s ? milesBetween(from, s) : Infinity;
    if (m < d) [best, d] = [c, m];
  }
  return best;
}

/**
 * An AREA stored on a card (several counties, or a Caltrans district): precision 'region', no point, state CA, and
 * the county field holding the list "Humboldt, Shasta". Returns the counties, or null for anything else (a Nevada
 * region has no county list, so it is never an area).
 */
export function areaCounties(loc: { precision: string; state: string | null; lat: number | null; county: string | null }): string[] | null {
  if (loc.precision !== 'region' || loc.state !== 'CA' || loc.lat != null || !loc.county) return null;
  const names = loc.county.split(',').map((s) => caCounty(s)?.name ?? null);
  return names.length >= 2 && names.every((n): n is string => n !== null) ? names : null;
}

/**
 * The state campuses and agencies that work in one town, matched on the department name as the list writes it.
 * Only those seen in the 2026-11-14 list, and only where the town is certain.
 */
export const CA_AGENCY_TOWNS: ReadonlyArray<{ re: RegExp; town: string; note?: string }> = [
  { re: /^CSU,\s*Fullerton$/i, town: 'Fullerton' },
  { re: /^CSU,\s*San Francisco$/i, town: 'San Francisco' },
  { re: /^CSU,\s*Fresno$/i, town: 'Fresno' },
  { re: /^CSU,\s*San Bernardino$/i, town: 'San Bernardino' },
  // Named after the islands offshore; the campus is in Camarillo (One University Drive).
  { re: /^CSU,\s*Channel Islands$/i, town: 'Camarillo', note: 'CSU Channel Islands' },
  { re: /^CSU,\s*Long Beach$/i, town: 'Long Beach' },
  // Northridge is a neighbourhood of the City of Los Angeles; the ZIP table has its own centre for it.
  { re: /^CSU,\s*Northridge$/i, town: 'Northridge', note: 'CSU Northridge, Los Angeles' },
  { re: /^CSU,\s*Sacramento$/i, town: 'Sacramento' },
  { re: /^CSU,\s*San Jose$/i, town: 'San Jose' },
  // Named after the old rancho; the campus is in the City of Carson (1000 E Victoria St).
  { re: /^CSU,\s*Dominguez Hills$/i, town: 'Carson', note: 'CSU Dominguez Hills' },
  { re: /^Cal-?\s?Poly San Luis Obispo$/i, town: 'San Luis Obispo' },
  { re: /^UCLA$/i, town: 'Los Angeles', note: 'UCLA' },
  { re: /^UC Santa Cruz$/i, town: 'Santa Cruz' },
  // UC Davis Health's medical center is on Stockton Blvd in Sacramento, not in Davis.
  { re: /^UC Davis Medical Center$/i, town: 'Sacramento', note: 'UC Davis Medical Center' },
  // The 22nd District Agricultural Association runs the Del Mar Fairgrounds.
  { re: /^22nd DAA$/i, town: 'Del Mar', note: 'Del Mar Fairgrounds' },
  { re: /^Office of Exposition Park$/i, town: 'Los Angeles', note: 'Exposition Park' },
];

/**
 * State facilities a title names, each in a town (or a county) that is certain. `agency` narrows a short code to the
 * department that uses it (CDCR's institution codes). Checked in order; the first match wins.
 */
export const CA_FACILITIES: ReadonlyArray<{ re: RegExp; agency?: RegExp; town?: string; county?: string; note: string }> = [
  // CDCR institutions (cdcr.ca.gov/facility-locator): California State Prison, Solano is in Vacaville.
  { re: /California State Prison,?\s+Solano|\bCSP[- ]Solano\b/i, town: 'Vacaville', note: 'CSP Solano' },
  { re: /Substance Abuse Treatment Facility|\bSATF\b/i, agency: /corrections/i, town: 'Corcoran', note: 'SATF Corcoran' },
  { re: /California State Prison,?\s+Corcoran|(?:^|[-\s])COR-/i, agency: /corrections/i, town: 'Corcoran', note: 'CSP Corcoran' },
  { re: /Pelican Bay State Prison|\bPBSP\b/i, agency: /corrections/i, town: 'Crescent City', note: 'Pelican Bay State Prison' },
  { re: /Salinas Valley State Prison|\bSVSP\b/i, agency: /corrections/i, town: 'Soledad', note: 'Salinas Valley State Prison' },
  // Department of State Hospitals and Developmental Services: each hospital is named after its town.
  { re: /Napa State Hospital/i, town: 'Napa', note: 'Napa State Hospital' },
  { re: /\bDSH\s+Atascadero\b|Atascadero State Hospital/i, town: 'Atascadero', note: 'Atascadero State Hospital' },
  { re: /Porterville Developmental Center/i, town: 'Porterville', note: 'Porterville Developmental Center' },
  // CalPERS' headquarters "Lincoln Plaza" is at 400 Q Street, Sacramento: an office building, not the City of Lincoln.
  { re: /\bPERS\b.*\bLincoln Plaza\b|\bLincoln Plaza\b.*\bPERS\b/i, town: 'Sacramento', note: 'CalPERS Lincoln Plaza' },
  // The CHP Academy is at 3500 Reed Ave, West Sacramento.
  { re: /\bCHP Academy\b/i, town: 'West Sacramento', note: 'CHP Academy' },
  // State parks named in titles, each in or beside one town.
  { re: /Weaverville Joss House/i, town: 'Weaverville', note: 'Weaverville Joss House SHP' },
  { re: /Will Rogers State Historic Park/i, town: 'Pacific Palisades', note: 'Will Rogers SHP' },
  { re: /Grover Hot Springs State Park/i, town: 'Markleeville', note: 'Grover Hot Springs SP' },
  { re: /Calaveras Big Trees State Park/i, town: 'Arnold', note: 'Calaveras Big Trees SP' },
  { re: /Caswell Memorial State Park/i, town: 'Ripon', note: 'Caswell Memorial SP' },
  { re: /George J\.? Hatfield State Recreation Area/i, town: 'Newman', note: 'George J. Hatfield SRA' },
  { re: /\bOceano Dunes\b/i, town: 'Oceano', note: 'Oceano Dunes' },
  // Humboldt Redwoods and Grizzly Creek Redwoods state parks: certain of the county, not of one town.
  { re: /Humboldt Redwoods State Park|Grizzly Creek Redwoods State Park/i, county: 'Humboldt', note: 'state park' },
  // CAL FIRE's Potrero fire station: the list's own replacement contract names "POTRERO, SAN DIEGO COUNTY".
  { re: /\bPotrero Fire Station\b/i, town: 'Potrero', note: 'Potrero Fire Station' },
  // CAL FIRE's Ramona Air Attack Base is at Ramona Airport.
  { re: /\bRamona Air Attack Base\b/i, town: 'Ramona', note: 'Ramona Air Attack Base' },
  // California Military Department: Camp San Luis Obispo (on Highway 1 at San Luis Obispo), Camp Roberts (beside San
  // Miguel), Hammer Field (the Air National Guard base at Fresno Yosemite airport), the AVCRAD (the Army Guard's
  // aviation depot at the same airport) and the Bakersfield Gateway Armory.
  { re: /\bCamp San Luis Obispo\b|\bCSLO\b/i, agency: /military/i, town: 'San Luis Obispo', note: 'Camp San Luis Obispo' },
  { re: /\bCamp Roberts\b/i, town: 'San Miguel', note: 'Camp Roberts' },
  { re: /\bHammer Field\b/i, town: 'Fresno', note: 'Hammer Field' },
  { re: /\bAVCRAD\b|Aviation Classification Repair Activity Depot/i, agency: /military/i, town: 'Fresno', note: 'AVCRAD Fresno' },
  { re: /\bBakersfield Gateway Armory\b/i, town: 'Bakersfield', note: 'Gateway Armory' },
];
