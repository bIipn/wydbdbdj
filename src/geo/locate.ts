import { FLAGS } from '../sources/flags.js';
import { statesInText } from '../sources/samgov.js';
import type { BidDraft, BidLocation, LocationPrecision } from '../types.js';
import { placeCaleprocure } from './caleprocure-place.js';
import { caCounty, seatOf } from './california.js';
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
 * explicit point → gazetteer town → ZIP → city + state → county → place named in the text → agency → region → state.
 * ZIP and city try the hand-checked gazetteer first, then the nationwide ZIP table (federal notices name places
 * anywhere in the US). Free text is only ever searched for gazetteer towns, never for every US city name.
 *
 * When the listing named a place of its own (a ZIP or an address line, as SAM.gov gives) and none of it could be
 * placed, we stop: no guess from the title, agency or region, coordinates stay null and the label repeats what
 * the listing said. A guess would put a Marine Corps base in Bridgeport because the title lists four bases.
 */
export function locate(
  draft: Pick<BidDraft, 'title' | 'description' | 'agency' | 'location'> & Pick<Partial<BidDraft>, 'flags' | 'source' | 'sourceId'>,
): BidLocation {
  // The state's own list names no site: only its title, department and event id say where (./caleprocure-place.ts).
  // Never the town-in-text guess below, which put "Butte Slough … Sacramento River" in the City of Sacramento.
  if (draft.source === 'caleprocure' && draft.sourceId) {
    return placeCaleprocure({ title: draft.title, agency: draft.agency, sourceId: draft.sourceId });
  }
  // A federal notice that named no work site carries its contracting office as its place (FLAGS.placeFromOffice):
  // it is placed from the office's own city / ZIP only, never guessed from the title, and its label says so.
  if (draft.flags?.includes(FLAGS.placeFromOffice)) {
    const office = officeLabel(locateGiven(draft, true));
    // The title often names the job's state when the place fields do not ("CA-SAN LUIS NWR-FIRE SYSTEM REHAB" from
    // a Virginia office, "Snow Removal Services Detroit Michigan" from Seattle): that state wins, with no point.
    const site = stateInTitle(draft.title);
    if (site && site !== office.state) {
      const where = office.city && office.state ? `${office.city}, ${office.state}` : office.state;
      return {
        city: null, county: null, state: site, zip: null, lat: null, lng: null, precision: 'state',
        label: `${site}: work site not named${where ? ` (contracting office: ${where})` : ''}`,
      };
    }
    return office;
  }
  return locateGiven(draft, false);
}

/** US state codes a "XX-" title prefix may carry (VA is left out: "VA-…" is usually Veterans Affairs). */
const PREFIX_STATES = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT WA WV WI WY PR GU VI'.split(' '),
);
/** Place names that hold a state's name but are not in it ("Washington Navy Yard" is in DC). */
const NOT_THE_STATE = /\bwashington(?:,? d\.?c\.?| navy yard| headquarters)\b|\bnew york ave(?:nue)?\b/gi;

/** The one state a federal title names: a leading "CA-" code, else exactly one state named in it; else null. */
export function stateInTitle(title: string | null | undefined): string | null {
  const t = (title ?? '').trim();
  const prefix = /^([A-Z]{2})-(?=[A-Z])/.exec(t);
  if (prefix && PREFIX_STATES.has(prefix[1]!)) return prefix[1]!;
  const named = statesInText(t.replace(NOT_THE_STATE, ' '));
  return named.length === 1 ? named[0]! : null;
}

/**
 * What the card says for a notice placed at its contracting office: where the office is, and that the job site
 * was not named. "Contracting office: Sacramento, CA (job site not named)".
 */
function officeLabel(loc: BidLocation): BidLocation {
  const where = loc.city && loc.state ? `${loc.city}, ${loc.state}` : loc.state;
  return { ...loc, label: where ? `Contracting office: ${where} (job site not named)` : 'Contracting office (job site not named)' };
}

function locateGiven(draft: Pick<BidDraft, 'title' | 'description' | 'agency' | 'location'>, officeOnly: boolean): BidLocation {
  const given = draft.location ?? {};
  const state = given.state?.toUpperCase() ?? null;
  const zip = given.zip?.trim() || null;
  const label = given.label?.trim() || null;

  if (given.lat != null && given.lng != null) {
    return {
      city: given.city ?? null, county: given.county ?? null, state, zip,
      lat: given.lat, lng: given.lng, precision: 'exact',
      label: label ?? ([given.city, state].filter(Boolean).join(', ') || null),
    };
  }

  // A gazetteer town named with its state keeps its hand-checked centre, whatever ZIP comes with it.
  // With no state, a ZIP in another state decides: "Jackson" + 39216 (and no state) is Jackson, MS, not the
  // gazetteer's Jackson, CA (a real SAM.gov notice of 2026-11-02, VA medical center, Mississippi).
  const city = findPlace(given.city);
  const zipState = !state && zip ? lookupZip(zip)?.state ?? null : null;
  if (city && (state ? city.state === state : !zipState || zipState === city.state)) return placeLoc(city, 'city', zip);

  const nearHome = zip ? findPlace(ZIP_PLACES[zip.slice(0, 5)]) : null;
  if (nearHome) return placeLoc(nearHome, 'city', zip);

  // Anywhere else in the US: the ZIP first, then city + state (SAM's city field is sometimes "0" or a base name).
  const us = nationwide(given.city, state, zip);
  if (us) return us;

  // A metro prefix ("891" = Las Vegas) is only a guess, so it waits until the table that knows exact ZIPs has passed.
  const metro = zip ? findPlace(ZIP_PLACES[zip.slice(0, 3)]) : null;
  if (metro) return placeLoc(metro, 'city', zip);

  if (zip || label || officeOnly) return unplaced(given, state, zip, label);

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
    // Any other California county: its county seat (./california.ts), the same rule.
    const ca = state === 'CA' ? caCounty(county) : null;
    const caSeat = ca ? seatOf(ca.name) : null;
    if (ca && caSeat) {
      return {
        city: null, county: ca.name, state, zip, lat: caSeat.lat, lng: caSeat.lng, precision: 'county', label: `${ca.name} County, CA`,
      };
    }
  }

  if (named) return placeLoc(named, 'city', zip); // Tahoe-area work crosses the state line, so accept either state

  if (home && draft.agency) {
    for (const { re, title, place } of AGENCY_PLACES) {
      if (re.test(draft.agency) && (!title || title.test(draft.title ?? ''))) {
        const p = findPlace(place);
        if (p) return placeLoc(p, 'agency', zip);
      }
    }
  }

  const regionText = [text, draft.agency].filter(Boolean).join(' ');
  for (const r of home ? REGIONS : []) {
    if (r.re.test(regionText)) {
      return {
        city: null, county: null, state: state ?? r.state, zip,
        lat: r.lat ?? null, lng: r.lng ?? null, precision: 'region', label: r.label,
      };
    }
  }

  return unplaced(given, state, zip, label);
}

/** Nothing we could put on the map: keep what the listing said, never a made-up point. */
function unplaced(given: Partial<BidLocation>, state: string | null, zip: string | null, label: string | null): BidLocation {
  return {
    city: given.city ?? null, county: given.county ?? null, state, zip,
    lat: null, lng: null,
    precision: state ? 'state' : 'unknown',
    // The listing's own address words when it gave some (SAM.gov), else the plain fallback.
    label: label ?? (state ? (state === 'NV' ? 'Nevada (location not listed)' : `${state} (location not listed)`) : null),
  };
}
