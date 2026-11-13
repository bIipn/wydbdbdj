/**
 * Prevailing wage: a small owner-maintained table (config/prevailing-wage/*.json) plus cautious copy.
 *
 * We do not scrape wage determinations. The table holds what a person typed in from the state's
 * PDFs, with the edition, the date it took effect and where it came from. Rules for the copy:
 *  - keep "normally" and "the bid documents control": the table can be stale and thresholds have exceptions
 *  - never pick the classification for the contractor
 *  - never work out overtime from the all-in rate (overtime is on a base rate the PDF does not publish)
 *  - the state rate is not presented as the federal Davis-Bacon rate
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { milesBetween } from '../geo/locate.js';
import type { Bid } from '../types.js';
import { pacificParts } from '../util/time.js';
import { normalizeCounty } from './stats.js';

// ------------------------------------------------------------------ table --

export interface PrevailingRegion {
  code: string;
  name: string;
  counties: string[];
  /** The PDF the rates were read from. null = that region's rates are not on file. */
  sourceUrl: string | null;
  sourcePage: number | null;
}

export interface PrevailingRate {
  classification: string;
  /** Base + fringes, per hour. */
  totalHourly: number;
  basicHourly: number | null;
  fringeHourly: number | null;
}

export interface ZoneRow {
  zone: number;
  fromMi: number;
  /** null = no upper end. */
  toMi: number | null;
  addPerHour: number;
}

export interface PrevailingCraft {
  craft: string;
  rateType: string;
  /** Regions these rates are on file for. */
  regionCodes: string[];
  rateBasis: string;
  rates: PrevailingRate[];
  zoneAdders: { measuredFrom: { label: string; lat: number; lng: number; pointNote?: string }; zones: ZoneRow[] } | null;
  overtimeNote: string;
}

export interface PrevailingWageTable {
  jurisdiction: string; // 2-letter state
  jurisdictionName: string;
  editionLabel: string;
  determinationDate: string | null;
  /** YYYY-MM-DD */
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Public works under this estimated cost are normally outside the state's prevailing wage rules. */
  thresholdUsd: number;
  sourceIndexUrl: string;
  retrievedOn: string | null;
  /** Who on the owner's side compared the numbers with the source. null = nobody yet. */
  checkedBy: string | null;
  checkedAt: string | null;
  regions: PrevailingRegion[];
  crafts: PrevailingCraft[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isHttps = (v: unknown): v is string => typeof v === 'string' && /^https:\/\/\S+$/.test(v);
const isMoney = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Check a prevailing wage file so a typo fails loudly instead of putting a wrong rate on a card. */
export function validatePrevailingWage(input: unknown, file = 'prevailing wage table'): PrevailingWageTable {
  const errors: string[] = [];
  const need = (cond: unknown, msg: string): void => {
    if (!cond) errors.push(msg);
  };
  const t = (input ?? {}) as Partial<PrevailingWageTable>;
  const dateOrNull = (v: unknown): boolean => v === null || (typeof v === 'string' && ISO_DATE.test(v));

  need(typeof t.jurisdiction === 'string' && /^[A-Z]{2}$/.test(t.jurisdiction), 'jurisdiction: 2-letter state code');
  need(typeof t.jurisdictionName === 'string' && t.jurisdictionName, 'jurisdictionName: string');
  need(typeof t.editionLabel === 'string' && t.editionLabel, 'editionLabel: string');
  need(typeof t.effectiveFrom === 'string' && ISO_DATE.test(t.effectiveFrom), 'effectiveFrom: YYYY-MM-DD');
  need(dateOrNull(t.effectiveTo), 'effectiveTo: YYYY-MM-DD or null');
  need(dateOrNull(t.determinationDate), 'determinationDate: YYYY-MM-DD or null');
  need(dateOrNull(t.retrievedOn), 'retrievedOn: YYYY-MM-DD or null');
  need(isMoney(t.thresholdUsd) && t.thresholdUsd > 0, 'thresholdUsd: number above 0');
  need(isHttps(t.sourceIndexUrl), 'sourceIndexUrl: https URL');
  need(t.checkedBy === null || (typeof t.checkedBy === 'string' && t.checkedBy.trim()), 'checkedBy: a name, or null when nobody has checked');
  need(dateOrNull(t.checkedAt), 'checkedAt: YYYY-MM-DD or null');
  need(!(t.checkedBy === null && t.checkedAt), 'checkedAt needs checkedBy');

  const regions = Array.isArray(t.regions) ? t.regions : [];
  need(regions.length > 0, 'regions: at least one');
  const codes = new Set<string>();
  const counties = new Set<string>();
  for (const [i, r] of regions.entries()) {
    const at = `regions[${i}]`;
    need(typeof r?.code === 'string' && /^[A-Z_]+$/.test(r.code) && !codes.has(r.code), `${at}.code: unique UPPER_SNAKE code`);
    if (typeof r?.code === 'string') codes.add(r.code);
    need(typeof r?.name === 'string' && r.name, `${at}.name: string`);
    need(Array.isArray(r?.counties) && r.counties.length > 0, `${at}.counties: at least one`);
    for (const c of Array.isArray(r?.counties) ? r.counties : []) {
      const key = normalizeCounty(c);
      need(key && !counties.has(key), `${at}.counties: "${c}" is empty or listed twice`);
      if (key) counties.add(key);
    }
    need(r?.sourceUrl === null || isHttps(r?.sourceUrl), `${at}.sourceUrl: https URL or null`);
    need(r?.sourcePage === null || (Number.isInteger(r?.sourcePage) && r.sourcePage! > 0), `${at}.sourcePage: page number or null`);
  }

  const crafts = Array.isArray(t.crafts) ? t.crafts : [];
  for (const [i, c] of crafts.entries()) {
    const at = `crafts[${i}]`;
    need(typeof c?.craft === 'string' && c.craft, `${at}.craft: string`);
    need(typeof c?.rateType === 'string', `${at}.rateType: string`);
    need(typeof c?.rateBasis === 'string' && c.rateBasis, `${at}.rateBasis: string`);
    need(typeof c?.overtimeNote === 'string' && c.overtimeNote, `${at}.overtimeNote: string`);
    need(Array.isArray(c?.regionCodes) && c.regionCodes.length > 0 && c.regionCodes.every((code) => codes.has(code)), `${at}.regionCodes: codes from regions`);
    for (const code of Array.isArray(c?.regionCodes) ? c.regionCodes : []) {
      const region = regions.find((r) => r?.code === code);
      need(!region || (region.sourceUrl && region.sourcePage), `${at}: region ${code} has rates but no sourceUrl / sourcePage`);
    }
    need(Array.isArray(c?.rates) && c.rates.length > 0, `${at}.rates: at least one`);
    for (const [j, r] of (Array.isArray(c?.rates) ? c.rates : []).entries()) {
      need(typeof r?.classification === 'string' && r.classification, `${at}.rates[${j}].classification: string`);
      need(isMoney(r?.totalHourly) && r.totalHourly > 0, `${at}.rates[${j}].totalHourly: dollars per hour`);
      need(r?.basicHourly === null || isMoney(r?.basicHourly), `${at}.rates[${j}].basicHourly: number or null`);
      need(r?.fringeHourly === null || isMoney(r?.fringeHourly), `${at}.rates[${j}].fringeHourly: number or null`);
    }
    const z = c?.zoneAdders;
    if (z !== null) {
      need(typeof z?.measuredFrom?.label === 'string' && Number.isFinite(z.measuredFrom.lat) && Number.isFinite(z.measuredFrom.lng), `${at}.zoneAdders.measuredFrom: { label, lat, lng }`);
      const zones = Array.isArray(z?.zones) ? z.zones : [];
      need(zones.length > 0, `${at}.zoneAdders.zones: at least one`);
      for (const [j, row] of zones.entries()) {
        const last = j === zones.length - 1;
        need(Number.isInteger(row?.zone) && isMoney(row?.addPerHour) && isMoney(row?.fromMi), `${at}.zoneAdders.zones[${j}]: { zone, fromMi, toMi, addPerHour }`);
        need(last ? row?.toMi === null : isMoney(row?.toMi) && row.toMi! >= row.fromMi, `${at}.zoneAdders.zones[${j}].toMi: a number, or null on the last zone only`);
        need(j === 0 || row?.fromMi > (zones[j - 1]?.toMi ?? Infinity), `${at}.zoneAdders.zones[${j}]: zones must go up without overlapping`);
      }
    }
  }

  if (errors.length) throw new Error(`Invalid ${file}:\n  - ${errors.join('\n  - ')}`);
  return t as PrevailingWageTable;
}

const CONFIG_DIR = fileURLToPath(new URL('../../config/prevailing-wage/', import.meta.url));

/** Every table in config/prevailing-wage/, validated. */
export function loadPrevailingWageTables(dir: string = CONFIG_DIR): PrevailingWageTable[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => validatePrevailingWage(JSON.parse(readFileSync(`${dir.replace(/\/+$/, '')}/${f}`, 'utf8')), f));
}

let cached: PrevailingWageTable[] | null = null;
/** The tables shipped with the app, read once. */
export function prevailingWageTables(): PrevailingWageTable[] {
  cached ??= loadPrevailingWageTables();
  return cached;
}

export function regionForCounty(table: PrevailingWageTable, county: string | null | undefined): PrevailingRegion | null {
  const key = normalizeCounty(county);
  return key ? table.regions.find((r) => r.counties.some((c) => normalizeCounty(c) === key)) ?? null : null;
}

// ------------------------------------------------------------------- hint --

export const DAVIS_BACON_THRESHOLD_USD = 2000;
/** Search page for federal wage determinations. A link out: we never fetch it. */
export const DAVIS_BACON_SEARCH_URL = 'https://sam.gov/search?index=dbra&page=1&pageSize=25&sort=-modifiedDate&sfm%5Bstatus%5D%5Bis_active%5D=true';
export const BID_DOCUMENTS_CONTROL = 'The wage determination in the bid documents controls.';

export type HintBid = Pick<Bid, 'source' | 'location' | 'estValue' | 'naics' | 'flags'>;

export interface ZoneEstimate {
  /** Straight-line miles from the measuring point, rounded. */
  distanceMi: number;
  /** The zone for the straight-line miles. The road is never shorter, so a count by road can only raise it. */
  zone: number;
  addPerHour: number;
  /** The real zone may differ: within 5 miles of a zone line, or a count by road could reach the next zone. */
  nearBoundary: boolean;
  /**
   * The zone if the miles are counted by road (straight line × ROAD_ALLOWANCE). Equal to `zone` when
   * that stays inside it. Anything that costs labor from this estimate must use `maxAddPerHour`.
   */
  maxZone: number;
  maxAddPerHour: number;
}

export interface PrevailingWageHint {
  /** davis_bacon = federal rules · state = a state table we hold · none = nothing on file for this bid */
  basis: 'davis_bacon' | 'state' | 'none';
  /** likely · normally_not (under the threshold) · depends (turns on the job value or the kind of work) · unknown */
  applies: 'likely' | 'normally_not' | 'depends' | 'unknown';
  headline: string;
  /** Short lines for the card, most important first. */
  lines: string[];
  /** Every classification on file for the bid's region. Empty when none applies or none is on file. We never pick one. */
  rates: Array<{ craft: string; classification: string; totalHourly: number }>;
  /** Our estimate of the zone, when we know where the job is. */
  zone: ZoneEstimate | null;
  zoneTable: ZoneRow[];
  /** e.g. "As of 10/13/26". null when no table is involved. */
  asOf: string | null;
  edition: string | null;
  /** False until someone on the owner's side has compared the table with its source. */
  checked: boolean;
  links: Array<{ label: string; url: string }>;
}

const usd = (v: number): string => `$${v.toFixed(2)}`;
const thousands = (v: number): string => `$${Math.round(v / 1000)}K`;

/** "2026-10-13" → "10/13/26". */
function shortDate(isoDay: string): string {
  const [y, m, d] = isoDay.split('-');
  return `${Number(m)}/${Number(d)}/${y!.slice(2)}`;
}

/**
 * Roads run longer than the straight line, so a straight-line zone can only be too LOW. This factor
 * decides when to warn and show the next zone as well. It is a judgment allowance, not a
 * measurement: it is never shown as a mileage, and a mountain route can exceed it, which is why
 * the copy keeps "the bid documents control" and the whole zone table.
 */
export const ROAD_ALLOWANCE = 1.25;

/**
 * The zone for a straight-line distance (the first zone whose upper end is not passed), and the
 * zone the same trip could fall in when counted by road.
 */
export function zoneFor(zones: readonly ZoneRow[], distanceMi: number): ZoneEstimate | null {
  const at = (mi: number): ZoneRow | undefined => zones.find((z) => z.toMi === null || mi <= z.toMi);
  const row = at(distanceMi);
  if (!row) return null;
  const byRoad = at(distanceMi * ROAD_ALLOWANCE) ?? row;
  const nearBoundary = byRoad.zone !== row.zone || zones.some((z) => z.toMi !== null && Math.abs(distanceMi - z.toMi) <= 5);
  return { distanceMi: Math.round(distanceMi), zone: row.zone, addPerHour: row.addPerHour, nearBoundary, maxZone: byRoad.zone, maxAddPerHour: byRoad.addPerHour };
}

/** Today's date in Pacific time, YYYY-MM-DD (the tables are Nevada's). */
export function pacificDay(now: Date = new Date()): string {
  const { y, mo, d } = pacificParts(now);
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function valueBounds(est: Bid['estValue']): { lo: number; hi: number } | null {
  const lo = est?.min ?? est?.max ?? null;
  const hi = est?.max ?? est?.min ?? null;
  return lo === null || hi === null ? null : { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
}

function davisBaconHint(bid: HintBid): PrevailingWageHint {
  const value = valueBounds(bid.estValue);
  const construction = typeof bid.naics === 'string' && bid.naics.startsWith('23');
  const link = { label: 'Look up Davis-Bacon wage determinations on SAM.gov', url: DAVIS_BACON_SEARCH_URL };
  const base = { basis: 'davis_bacon' as const, rates: [], zone: null, zoneTable: [], asOf: null, edition: null, checked: false, links: [link] };

  if (value && value.hi <= DAVIS_BACON_THRESHOLD_USD) {
    return {
      ...base, applies: 'normally_not', headline: 'Davis-Bacon wages normally not required at this size',
      lines: ['Davis-Bacon normally covers federal construction contracts over $2,000. Check the bid documents.', BID_DOCUMENTS_CONTROL],
    };
  }
  if (!construction) {
    return {
      ...base, applies: 'depends', headline: 'Davis-Bacon wages may apply',
      lines: ['If this is construction work over $2,000, Davis-Bacon wages likely apply.', BID_DOCUMENTS_CONTROL],
    };
  }
  return {
    ...base, applies: 'likely', headline: 'Davis-Bacon wages likely apply',
    lines: ['Federal construction contracts over $2,000 normally carry a Davis-Bacon wage determination.', BID_DOCUMENTS_CONTROL],
  };
}

const zoneAdd = (addPerHour: number): string => (addPerHour > 0 ? `add ${usd(addPerHour)}/hr` : 'no zone adder');

function stateHint(bid: HintBid, table: PrevailingWageTable, today: string): PrevailingWageHint {
  const limit = thousands(table.thresholdUsd);
  const value = valueBounds(bid.estValue);
  const noticeSaysSo = bid.flags.some((f) => f === 'Prevailing wage' || f === 'Certified payroll');
  // Some boards (the State Public Works Division's) are tagged by the scanner as usually prevailing wage.
  const boardSaysLikely = bid.flags.includes('Prevailing wage likely');
  const link = { label: `${table.jurisdictionName} prevailing wage rates (Labor Commissioner)`, url: table.sourceIndexUrl };
  const asOf = `As of ${shortDate(table.effectiveFrom)}`;
  const base = { basis: 'state' as const, asOf, edition: table.editionLabel, checked: table.checkedBy !== null, links: [link] };

  let applies: PrevailingWageHint['applies'];
  let headline: string;
  const lines: string[] = [];
  if (noticeSaysSo) {
    applies = 'likely';
    headline = 'The notice mentions prevailing wage';
  } else if (!value || (value.lo < table.thresholdUsd && value.hi >= table.thresholdUsd)) {
    applies = boardSaysLikely ? 'likely' : 'depends';
    headline = boardSaysLikely ? `Prevailing wage likely applies (jobs over ${limit})` : `Prevailing wage applies if the job is over ${limit}`;
    lines.push(value ? `The estimate straddles ${limit}.` : 'No job value is listed.');
    if (boardSaysLikely) lines.push('Jobs on this bid board normally carry prevailing wage.');
  } else if (value.hi < table.thresholdUsd) {
    applies = 'normally_not';
    headline = `Prevailing wage normally not required under ${limit}`;
    lines.push(`${table.jurisdictionName} public works under ${limit} are normally not required to pay prevailing wage. Check the bid documents.`);
  } else {
    applies = 'likely';
    headline = `${table.jurisdictionName} prevailing wage normally applies at ${limit} and up`;
  }

  if (applies === 'normally_not') {
    return { ...base, applies, headline, lines: [...lines, BID_DOCUMENTS_CONTROL], rates: [], zone: null, zoneTable: [] };
  }

  // Past the table's last day its rates are history: say so and show none (a stale rate is a wage violation waiting to happen).
  if (table.effectiveTo !== null && today > table.effectiveTo) {
    lines.push(`The rates we have on file (${table.editionLabel}) ended ${shortDate(table.effectiveTo)}, so we are not showing them. See the Labor Commissioner's current rate sheets.`);
    return { ...base, asOf: null, applies, headline, lines: [...lines, BID_DOCUMENTS_CONTROL], rates: [], zone: null, zoneTable: [] };
  }

  const region = regionForCounty(table, bid.location.county);
  const crafts = region ? table.crafts.filter((c) => c.regionCodes.includes(region.code)) : [];
  const rates = crafts.flatMap((c) => c.rates.map((r) => ({ craft: c.craft, classification: r.classification, totalHourly: r.totalHourly })));
  let zone: ZoneEstimate | null = null;
  let zoneTable: ZoneRow[] = [];

  if (!region) {
    lines.push(`We could not tell the county, so we cannot tell which ${table.jurisdictionName} wage region this is.`);
  } else if (crafts.length === 0) {
    lines.push(`We do not have the ${region.name} rates on file. See the Labor Commissioner's rate sheets.`);
  } else {
    for (const c of crafts) {
      lines.push(`${c.craft}, ${region.name}: ${c.rates.map((r) => `${r.classification} ${usd(r.totalHourly)}/hr`).join(' · ')}. Base plus fringes in one number.`);
    }
    lines.push('The classification comes from the bid documents: we do not pick one.');
    const adders = crafts[0]!.zoneAdders;
    if (adders) {
      zoneTable = adders.zones;
      const { lat, lng, precision } = bid.location;
      const pinned = lat !== null && lng !== null && (precision === 'exact' || precision === 'city');
      zone = pinned ? zoneFor(adders.zones, milesBetween(adders.measuredFrom, { lat, lng })) : null;
      const top = Math.max(...adders.zones.map((z) => z.addPerHour));
      const about = zone ? `About ${zone.distanceMi} mi from the ${adders.measuredFrom.label} in a straight line` : '';
      lines.push(!zone
        ? `Zone adder of $0.00 to ${usd(top)}/hr by distance from the ${adders.measuredFrom.label}.`
        : zone.maxZone !== zone.zone
          // The straight line can only come out too low: show the next zone too, never one adder alone.
          ? `${about}: Zone ${zone.zone} (${zoneAdd(zone.addPerHour)}), or up to Zone ${zone.maxZone} (${zoneAdd(zone.maxAddPerHour)}) if the miles are counted by road, which runs longer. Confirm the zone.`
          : `${about}: Zone ${zone.zone}, ${zoneAdd(zone.addPerHour)}.${zone.nearBoundary ? ' Close to a zone line: confirm the zone.' : ''}`);
    }
    lines.push('Overtime is figured on a base rate this table does not have. Do not multiply the all-in rate.');
    if (table.checkedBy === null) lines.push('These rates were typed in from the state PDF and have not been double-checked on our side yet.');
  }

  return { ...base, applies, headline, lines: [...lines, `${asOf}. ${BID_DOCUMENTS_CONTROL}`], rates, zone, zoneTable };
}

/**
 * What to tell a contractor about prevailing wage on this bid. Pure when `tables` and `today` are passed: the bid in, copy out.
 *  - a federal bid (SAM.gov): Davis-Bacon, with a link out. No state table is read for it.
 *  - a state we hold a table for: the threshold rule, and from the threshold up the rates and zone adder,
 *    unless `today` (YYYY-MM-DD, default: today in Pacific time) is past the table's last day
 *  - anything else: we say we have nothing on file
 *
 * A broken table file throws here, on purpose (a typo must not turn into "no table on file"). Call
 * prevailingWageTables() once at startup when this is wired into the server, so it stops the boot instead.
 */
export function prevailingWageHint(bid: HintBid, tables?: readonly PrevailingWageTable[], today: string = pacificDay()): PrevailingWageHint {
  if (bid.source === 'samgov') return davisBaconHint(bid);
  const state = bid.location.state?.toUpperCase() ?? null;
  const table = state ? (tables ?? prevailingWageTables()).find((t) => t.jurisdiction === state) : undefined;
  if (table) return stateHint(bid, table, today);
  return {
    basis: 'none', applies: 'unknown',
    headline: state ? `No prevailing wage table on file for ${state}` : 'No prevailing wage table on file for this bid',
    lines: [`If this is a public works job, prevailing wage may apply. ${BID_DOCUMENTS_CONTROL}`],
    rates: [], zone: null, zoneTable: [], asOf: null, edition: null, checked: false, links: [],
  };
}
