import type { BidDraft, BidLocation, LocationPrecision } from '../types.js';
import { AGENCY_PLACES, COUNTY_SEATS, PLACES, REGIONS, ZIP_PLACES, type Place } from './places.js';

const byName = new Map<string, Place>();
for (const p of PLACES) {
  byName.set(p.name.toLowerCase(), p);
  for (const a of p.aliases ?? []) byName.set(a.toLowerCase(), p);
}

// Longest names first so "North Las Vegas" wins over "Las Vegas" and
// "South Lake Tahoe" over the generic Tahoe region.
const scanList = PLACES.filter((p) => p.scan !== false)
  .flatMap((p) => [p.name, ...(p.aliases ?? [])].map((n) => ({ n, p })))
  .sort((a, b) => b.n.length - a.n.length)
  .map(({ n, p }) => ({ re: new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), p }));

export function findPlace(name: string | null | undefined): Place | null {
  if (!name) return null;
  const key = name.trim().toLowerCase().replace(/\s*(?:\.{3}|…)$/, '');
  if (!key || key === 'various' || key === 'multiple locations' || key === 'united states') return null;
  const exact = byName.get(key);
  if (exact) return exact;
  // Truncated values like "Carson Cit..." or "Boulder Ci..." — match on prefix.
  if (key.length >= 4) {
    for (const [n, p] of byName) if (n.startsWith(key)) return p;
  }
  return null;
}

function placeLoc(p: Place, precision: LocationPrecision, zip: string | null = null): BidLocation {
  return {
    city: p.name,
    county: p.county,
    state: p.state,
    zip,
    lat: p.lat,
    lng: p.lng,
    precision,
    label: `${p.name}, ${p.state}`,
  };
}

/** Haversine distance in miles. */
export function milesBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Work out where a bid's work happens, from best evidence to worst:
 * explicit city → ZIP → county → place named in the text → agency name → region → state.
 */
export function locate(draft: Pick<BidDraft, 'title' | 'description' | 'agency' | 'location'>): BidLocation {
  const given = draft.location ?? {};
  const state = given.state?.toUpperCase() ?? null;
  const zip = given.zip ?? null;

  if (given.lat != null && given.lng != null) {
    return {
      city: given.city ?? null, county: given.county ?? null, state, zip,
      lat: given.lat, lng: given.lng, precision: 'exact',
      label: given.label ?? ([given.city, state].filter(Boolean).join(', ') || null),
    };
  }

  const city = findPlace(given.city);
  if (city && (!state || city.state === state)) return placeLoc(city, 'city', zip);

  if (zip) {
    const z = ZIP_PLACES[zip.slice(0, 5)] ?? ZIP_PLACES[zip.slice(0, 3)];
    const p = z ? findPlace(z) : null;
    if (p) return placeLoc(p, 'city', zip);
  }

  const text = [draft.title, draft.description].filter(Boolean).join(' \n ');
  const named = scanList.find(({ re }) => re.test(text))?.p ?? null;

  if (given.county && state) {
    const county = given.county.toLowerCase().replace(/\s+county$/, '');
    // A town named in the text beats the county seat when it's in the same county ("Stateline" in a Douglas bid).
    if (named && named.state === state && named.county.toLowerCase() === county) return placeLoc(named, 'city', zip);
    const seat = COUNTY_SEATS[`${state}:${county}`];
    const p = seat ? findPlace(seat) : null;
    if (p) {
      return { ...placeLoc(p, 'county', zip), city: null, county: p.county, label: `${p.county} County, ${p.state}` };
    }
  }

  if (named) return placeLoc(named, 'city', zip); // Tahoe-area work crosses the state line, so accept either state

  if (draft.agency) {
    for (const { re, place } of AGENCY_PLACES) {
      if (re.test(draft.agency)) {
        const p = findPlace(place);
        if (p) return placeLoc(p, 'agency', zip);
      }
    }
  }

  const regionText = [text, draft.agency].filter(Boolean).join(' ');
  for (const r of REGIONS) {
    if (r.re.test(regionText)) {
      return { city: null, county: null, state: state ?? r.state, zip, lat: r.lat, lng: r.lng, precision: 'region', label: r.label };
    }
  }

  return {
    city: given.city ?? null, county: given.county ?? null, state, zip,
    lat: null, lng: null,
    precision: state ? 'state' : 'unknown',
    label: state ? (state === 'NV' ? 'Nevada (location not listed)' : `${state} (location not listed)`) : null,
  };
}
