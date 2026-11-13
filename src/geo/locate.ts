import type { BidDraft, BidLocation, LocationPrecision } from '../types.js';
import { AGENCY_PLACES, COUNTY_SEATS, PLACES, REGIONS, ZIP_PLACES, type Place } from './places.js';
import { lookupCity, lookupZip } from './zip.js';

// The formula lives beside the ZIP table (statesWithin needs it too); everyone else keeps importing it from here.
export { milesBetween } from './zip.js';

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

// Where the gazetteer may guess from words (a town in the title, an agency's name, a region).
// A bid that says it is in another state is left alone: "Dayton" in an Ohio bid is not Dayton, NV.
const HOME_STATES = new Set<string>(PLACES.map((p) => p.state));

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

/**
 * Anywhere in the US (./zip.ts): the ZIP when we know it, else the named city in the bid's state.
 * A ZIP that sits in another state than the bid says is treated as a typo. When the town is one of ours, the
 * gazetteer's hand-checked centre and county are used, so a Reno ZIP and the word "Reno" land on the same point.
 */
function nationwide(city: string | null | undefined, state: string | null, zip: string | null): BidLocation | null {
  const byZip = zip ? lookupZip(zip) : null;
  const hit = (byZip && (!state || byZip.state === state) ? byZip : null) ?? (city && state ? lookupCity(city, state) : null);
  if (!hit) return null;
  const known = byName.get(hit.city.toLowerCase());
  if (known && known.state === hit.state) return placeLoc(known, 'city', zip);
  return {
    city: hit.city, county: null, state: hit.state, zip,
    lat: hit.lat, lng: hit.lng, precision: 'city', label: `${hit.city}, ${hit.state}`,
  };
}

/**
 * Work out where a bid's work happens, from best evidence to worst:
 * explicit city → ZIP → county → place named in the text → agency name → region → state.
 * City and ZIP try the hand-checked gazetteer first, then the nationwide ZIP table. Free text is only ever
 * searched for gazetteer towns, never for every US city name.
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

  const nearHome = zip ? findPlace(ZIP_PLACES[zip.slice(0, 5)]) : null;
  if (nearHome) return placeLoc(nearHome, 'city', zip);

  const us = nationwide(given.city, state, zip);
  if (us) return us;

  // A metro prefix ("891" = Las Vegas) is only a guess, so it waits until the table that knows exact ZIPs has passed.
  const metro = zip ? findPlace(ZIP_PLACES[zip.slice(0, 3)]) : null;
  if (metro) return placeLoc(metro, 'city', zip);

  const home = !state || HOME_STATES.has(state);
  const text = [draft.title, draft.description].filter(Boolean).join(' \n ');
  const named = home ? scanList.find(({ re }) => re.test(text))?.p ?? null : null;

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

  if (home && draft.agency) {
    for (const { re, place } of AGENCY_PLACES) {
      if (re.test(draft.agency)) {
        const p = findPlace(place);
        if (p) return placeLoc(p, 'agency', zip);
      }
    }
  }

  const regionText = [text, draft.agency].filter(Boolean).join(' ');
  for (const r of home ? REGIONS : []) {
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
