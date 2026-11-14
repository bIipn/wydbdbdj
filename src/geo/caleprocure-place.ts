/**
 * Where a Cal eProcure event is, from the only things the state's list gives: the event name, the department and
 * the event id (src/sources/caleprocure.ts). Pure; tested on the real titles of the 2026-11-14 list
 * (test/caleprocure-place.test.ts).
 *
 * In this order, the first that applies wins:
 *   1. a TOWN the title names WITH corroboration: ", CA" / ", California" after it; a DMV, area or field office
 *      ("Carmichael DMV", "CHP Madera", "the … Bakersfield Office"); the last " - " part of the title being exactly a
 *      town ("… - Crescent City"); a state facility whose town is certain (CA_FACILITIES); a county named beside it
 *      that holds it (the town lies within TOWN_IN_COUNTY_MI of that county's seat, or that seat is its nearest);
 *      on a Caltrans row, a town in the reach of its district's counties. Never a bare capitalised word: "PERS Q
 *      Lincoln Plaza" is not the City of Lincoln, "Nevada Facilities" is not Nevada County.
 *   2. ONE county the title names → an area of one county: precision 'region', NO point, "Shasta County, CA (site
 *      not named)".
 *   3. SEVERAL counties → an AREA: precision 'region', NO point, the county field holds the list.
 *   4. the Caltrans district in the event id (department 2660, "10-1H0204", "03A4243") → an area of its counties
 *      (District 12 is Orange County alone: still an area, labelled "Caltrans District 12: Orange County").
 *   5. the department's own place: a CSU or UC campus, the Del Mar Fairgrounds … (CA_AGENCY_TOWNS), or a facility
 *      certain only of its county.
 *   6. else unplaced: California only, the board's own "(location not listed)" label.
 * An area is never measured: score.ts says whether any of its counties is in reach, and shows no miles.
 */
import type { BidLocation } from '../types.js';
import {
  CA_AGENCY_TOWNS, CA_COUNTIES, CA_FACILITIES, caCounty, caltransDistrictInId, nearestCounty, seatOf,
  type CaltransDistrict,
} from './california.js';
import { lookupCity, milesBetween, type CityPlace } from './zip.js';

/** A town named beside a county counts when it lies this close to that county's seat (or that seat is its nearest). */
export const TOWN_IN_COUNTY_MI = 45;

/** How many counties an area's label names before "+ N more". */
const LABEL_COUNTIES = 3;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COUNTY_ALT = [...CA_COUNTIES].map((c) => c.name).sort((a, b) => b.length - a.length).map(esc).join('|');
const COUNTY_AT_END = new RegExp(`(${COUNTY_ALT})\\s*$`, 'i');
const LIST_SEP_AT_END = /(?:\s*,\s*(?:and\s+|&\s*)?|\s+and\s+|\s*&\s*)$/i;
/** Where one element of a title ends: "IFB …; DEPARTMENT …; ATASCADERO" → "ATASCADERO". */
const ELEMENT_DELIM = /[,;:()¿]|\s[-–]\s/g;

export interface CountiesNamed {
  /** County names as the table spells them, in the title's order, once each. */
  counties: string[];
  /** The comma element right before a county list ("ATASCADERO, SAN LUIS OBISPO COUNTY" → "ATASCADERO"). */
  beside: string[];
  /** Character ranges of the county names, so a town search does not read "Imperial County" as the city Imperial. */
  spans: Array<[number, number]>;
}

/**
 * The California counties a title names with the word County/Counties: "in Fresno, Tulare, and Kern Counties",
 * "Placer County", "HUMBOLDT & SHASTA COUNTIES", "(Del Norte County)". A county word alone ("Sacramento River",
 * "Nevada Facilities") is not a county.
 */
export function countiesNamed(title: string): CountiesNamed {
  const out: CountiesNamed = { counties: [], beside: [], spans: [] };
  for (const w of title.matchAll(/\bcount(?:y|ies)\b/gi)) {
    let prefix = title.slice(0, w.index);
    let comma = false;
    let found = 0;
    const here: string[] = []; // read from the end backwards, so put back in the title's order below
    for (;;) {
      const m = COUNTY_AT_END.exec(prefix);
      if (!m || (m.index > 0 && /[a-z]/i.test(prefix[m.index - 1]!))) break;
      here.unshift(caCounty(m[1]!)!.name);
      out.spans.push([m.index, m.index + m[1]!.length]);
      found++;
      prefix = prefix.slice(0, m.index);
      const s = LIST_SEP_AT_END.exec(prefix);
      if (!s) { comma = false; break; }
      comma = s[0].includes(',');
      prefix = prefix.slice(0, s.index);
    }
    for (const name of here) if (!out.counties.includes(name)) out.counties.push(name);
    if (found && comma) {
      const cuts = [...prefix.matchAll(ELEMENT_DELIM)];
      const last = cuts.at(-1);
      const el = prefix.slice(last ? last.index! + last[0].length : 0).trim();
      if (el) out.beside.push(el);
    }
  }
  return out;
}

/** On a Caltrans district's row, its own counties named bare at the end: "…, Nevada & Placer". */
function districtCountiesAtEnd(title: string, d: CaltransDistrict): string[] {
  const tail = title.slice(title.lastIndexOf(',') + 1).trim().replace(/[.]+$/, '');
  const parts = tail.split(/\s*(?:&|\band\b)\s*/i).map((p) => p.trim()).filter(Boolean);
  const names = parts.map((p) => caCounty(p)?.name ?? null);
  return names.length && names.every((n) => n && d.counties.includes(n)) ? (names as string[]) : [];
}

const isCap = (w: string) => /^[A-Z]/.test(w);

/** The longest run of the LAST 1–4 words of `text` that is a California town, or null. */
function townAtEnd(text: string): CityPlace | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  for (let n = Math.min(4, words.length); n >= 1; n--) {
    const run = words.slice(-n);
    if (!run.every(isCap)) continue;
    const phrase = run.join(' ');
    if (/\bcount(?:y|ies)$/i.test(phrase)) return null;
    const hit = lookupCity(phrase, 'CA');
    if (hit) return hit;
  }
  return null;
}

/** The longest run of the FIRST 1–3 words of `text` that is a California town, or null. */
function townAtStart(text: string): CityPlace | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const run = words.slice(0, n);
    if (!run.every(isCap)) continue;
    const hit = lookupCity(run.join(' '), 'CA');
    if (hit) return hit;
  }
  return null;
}

/** Every California town spelled by 1–4 capitalised words in a row, outside the given spans, longest first. */
function townsIn(title: string, skip: Array<[number, number]>): Array<{ town: CityPlace; at: number }> {
  const tokens = [...title.matchAll(/[A-Za-z][A-Za-z.'’]*/g)].map((m) => ({ w: m[0].replace(/\.$/, ''), at: m.index!, end: m.index! + m[0].length }));
  const out: Array<{ town: CityPlace; at: number }> = [];
  const used = new Set<number>();
  for (let n = 4; n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const run = tokens.slice(i, i + n);
      if (run.some((_, k) => used.has(i + k))) continue;
      if (!run.every((t) => isCap(t.w))) continue;
      // Only words separated by single spaces form a name ("Smith River", not "Smith-River" or "Smith, River").
      if (run.some((t, k) => k > 0 && title.slice(run[k - 1]!.end, t.at) !== ' ')) continue;
      if (run.some((t) => skip.some(([a, b]) => t.at < b && t.end > a))) continue;
      const hit = lookupCity(run.map((t) => t.w).join(' '), 'CA');
      if (!hit) continue;
      out.push({ town: hit, at: run[0]!.at });
      for (let k = 0; k < n; k++) used.add(i + k);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Does this town lie in this county? Within TOWN_IN_COUNTY_MI of the seat, or that seat is the town's nearest. */
export function townInCounty(town: CityPlace, county: string): boolean {
  const seat = seatOf(county);
  if (!seat) return false;
  return milesBetween(town, seat) <= TOWN_IN_COUNTY_MI || nearestCounty(town).name === caCounty(county)!.name;
}

function cityLoc(town: CityPlace, county: string | null, note?: string, precision: 'city' | 'agency' = 'city'): BidLocation {
  return {
    city: town.city, county, state: 'CA', zip: null, lat: town.lat, lng: town.lng,
    precision,
    label: `${town.city}, CA${note && note !== town.city ? ` (${note})` : ''}`,
  };
}

/**
 * ONE county and no town: an area of one county. No point is stored: the seat is not the job, so no distance is
 * ever shown for it (score.ts treats it like any area: in reach when the company is in that county or its seat is
 * within the radius + AREA_REACH_EXTRA_MI).
 */
export function countyLoc(name: string): BidLocation {
  return {
    city: null, county: name, state: 'CA', zip: null, lat: null, lng: null, precision: 'region',
    label: `${name} County, CA (site not named)`,
  };
}

/** "A, B, C + 2 more counties" — the first LABEL_COUNTIES names, then how many more. */
function listWords(counties: readonly string[]): string {
  if (counties.length <= LABEL_COUNTIES) {
    if (counties.length === 1) return counties[0]!;
    return counties.length === 2 ? `${counties[0]} and ${counties[1]}` : `${counties.slice(0, -1).join(', ')} and ${counties.at(-1)}`;
  }
  const more = counties.length - LABEL_COUNTIES;
  return `${counties.slice(0, LABEL_COUNTIES).join(', ')} + ${more} more`;
}

export function areaLoc(counties: readonly string[], district: number | null): BidLocation {
  const shown = listWords(counties);
  const few = counties.length <= LABEL_COUNTIES;
  const label = district != null
    ? `Caltrans District ${district}: ${shown} ${counties.length === 1 ? 'County' : few ? 'counties' : counties.length - LABEL_COUNTIES === 1 ? 'county' : 'counties'}`
    : `${shown} ${few || counties.length - LABEL_COUNTIES > 1 ? 'counties' : 'county'}, CA`;
  return { city: null, county: counties.join(', '), state: 'CA', zip: null, lat: null, lng: null, precision: 'region', label };
}

const UNPLACED: BidLocation = {
  city: null, county: null, state: 'CA', zip: null, lat: null, lng: null, precision: 'state', label: 'CA (location not listed)',
};

/** "2660-10-1H0204" → { dept: "2660", eventId: "10-1H0204" }. */
export function splitSourceId(sourceId: string): { dept: string; eventId: string } {
  const i = sourceId.indexOf('-');
  return i < 0 ? { dept: sourceId, eventId: '' } : { dept: sourceId.slice(0, i), eventId: sourceId.slice(i + 1) };
}

export interface CaleprocureInput {
  title: string;
  agency: string | null;
  /** `${department}-${event id}` as the parser writes it. */
  sourceId: string;
}

/** The town step alone (1. above): a corroborated town, or null. Exported for the tests. */
export function corroboratedTown(input: CaleprocureInput, named: CountiesNamed, district: CaltransDistrict | null): BidLocation | null {
  const { title, agency } = input;

  // ", CA" / ", California" right after it: "Lice Treatment Services, Los Alamitos, CA", "in Oakland, CA".
  for (const m of title.matchAll(/,\s*(?:CA|California|CALIFORNIA)\b/g)) {
    const before = title.slice(0, m.index);
    const cuts = [...before.matchAll(ELEMENT_DELIM)];
    const last = cuts.at(-1);
    const el = before.slice(last ? last.index! + last[0].length : 0);
    const town = townAtEnd(el);
    if (town) return cityLoc(town, nearestCountyIf(town, named.counties));
  }

  // A DMV field office ("Carmichael DMV", "the Ventura DMV Field Office").
  for (const m of title.matchAll(/\bDMV\b/g)) {
    const town = townAtEnd(title.slice(0, m.index).replace(/[^A-Za-z.' ]+$/, ''));
    if (town) return cityLoc(town, null, `${town.city} DMV`);
  }

  // A department's office in a town: "CHP Madera …", "CHP Santa Cruz Area Office", "… Rail Authority Bakersfield Office".
  if (/highway patrol/i.test(agency ?? '')) {
    for (const m of title.matchAll(/\bCHP\s+/g)) {
      const town = townAtStart(title.slice(m.index! + m[0].length).replace(/[-,(].*$/, ''));
      if (town) return cityLoc(town, null, `CHP ${town.city}`);
    }
  }
  // DGS writes some names run together: "Project2765.OxnardFieldOfficeRenovation".
  const spaced = title.replace(/([a-z])(?=[A-Z])/g, '$1 ').replace(/\./g, ' ');
  for (const m of spaced.matchAll(/\s(?:(?:Area|Field)\s+)?Office\b/gi)) {
    const town = townAtEnd(spaced.slice(0, m.index).replace(/\s+(?:Area|Field)$/i, ''));
    if (town) return cityLoc(town, null);
  }

  // The title's last " - " part is exactly a town: "IFB 26C120002 - HVAC Maintenance - Crescent City".
  const tail = /\s[-–]\s+([A-Za-z][A-Za-z.' ]{1,40})$/.exec(title.trim());
  if (tail && tail[1]!.trim().split(/\s+/).length <= 4) {
    const words = tail[1]!.trim();
    const town = words.split(/\s+/).every(isCap) && !/\bcount(?:y|ies)$/i.test(words) ? lookupCity(words, 'CA') : null;
    if (town) return cityLoc(town, null);
  }

  // A county named beside it that holds it: "ATASCADERO, SAN LUIS OBISPO COUNTY", "Smith River BPS … (Del Norte County)".
  if (named.counties.length) {
    const candidates = [
      ...named.beside.map((b) => lookupCity(b, 'CA')).filter((t): t is CityPlace => !!t),
      ...townsIn(title, named.spans).map((t) => t.town),
    ];
    for (const town of candidates) {
      const county = named.counties.find((c) => townInCounty(town, c));
      if (county) return cityLoc(town, county);
    }
  }

  // On a Caltrans row: a town within reach of its district's counties.
  if (district && !named.counties.length) {
    for (const { town } of townsIn(title, [])) {
      const county = district.counties.find((c) => townInCounty(town, c));
      if (county) return cityLoc(town, county);
    }
  }

  // A state facility whose town is certain ("Fire Alarm Replacement at the California State Prison, Solano").
  for (const f of CA_FACILITIES) {
    if (!f.town || !f.re.test(title) || (f.agency && !f.agency.test(agency ?? ''))) continue;
    const town = lookupCity(f.town, 'CA');
    if (town) return cityLoc(town, null, f.note, 'agency');
  }
  return null;
}

function nearestCountyIf(town: CityPlace, counties: readonly string[]): string | null {
  return counties.find((c) => townInCounty(town, c)) ?? null;
}

/** Where a Cal eProcure event is (see the top of this file). */
export function placeCaleprocure(input: CaleprocureInput): BidLocation {
  const { title, agency, sourceId } = input;
  const { dept, eventId } = splitSourceId(sourceId);
  const district = dept === '2660' ? caltransDistrictInId(eventId) : null;
  const named = countiesNamed(title);
  if (district && !named.counties.length) named.counties.push(...districtCountiesAtEnd(title, district));

  const town = corroboratedTown(input, named, district);
  if (town) return town;
  if (named.counties.length === 1) return countyLoc(named.counties[0]!);
  if (named.counties.length > 1) return areaLoc(named.counties, null);
  // A district is always an AREA, even District 12 (Orange County alone): the id says the district, not the site.
  if (district) return areaLoc(district.counties, district.district);

  for (const a of CA_AGENCY_TOWNS) {
    if (!a.re.test((agency ?? '').trim())) continue;
    const t = lookupCity(a.town, 'CA');
    if (t) return cityLoc(t, null, a.note ?? (agency ?? undefined), 'agency');
  }
  for (const f of CA_FACILITIES) {
    if (f.county && f.re.test(title) && (!f.agency || f.agency.test(agency ?? ''))) return countyLoc(f.county);
  }
  return { ...UNPLACED };
}
