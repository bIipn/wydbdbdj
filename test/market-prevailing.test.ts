/**
 * Prevailing wage table + hint copy. The rates are the ones read from the Nevada Labor
 * Commissioner's 2026-2027 PDFs (Amendment #01). Bids here are synthetic (TEST ids).
 */
import { describe, expect, it } from 'vitest';
import {
  BID_DOCUMENTS_CONTROL, DAVIS_BACON_SEARCH_URL, loadPrevailingWageTables, prevailingWageHint, prevailingWageTables, regionForCounty,
  validatePrevailingWage, zoneFor, type HintBid, type PrevailingWageTable,
} from '../src/market/prevailing.js';
import { findPlace } from '../src/geo/locate.js';
import type { BidLocation } from '../src/types.js';

const table = prevailingWageTables().find((t) => t.jurisdiction === 'NV')!;
const clone = (): PrevailingWageTable => structuredClone(table);

const place = (over: Partial<BidLocation>): BidLocation => ({ city: null, county: null, state: 'NV', zip: null, lat: null, lng: null, precision: 'unknown', label: null, ...over });
/** A town from the app's own gazetteer (src/geo/places.ts), as a city-level bid location. */
const town = (name: string): BidLocation => {
  const p = findPlace(name)!;
  return place({ city: p.name, county: p.county, state: p.state, lat: p.lat, lng: p.lng, precision: 'city', label: `${p.name}, ${p.state}` });
};
const GARDNERVILLE = town('Gardnerville');
const ELKO = town('Elko');
const bid = (over: Partial<HintBid> = {}): HintBid => ({ source: 'nevadaepro', location: GARDNERVILLE, estValue: null, naics: null, flags: [], ...over });
const value = (min: number | null, max: number | null = min) => ({ min, max });
const text = (h: { headline: string; lines: string[] }): string => [h.headline, ...h.lines].join('\n');

describe('the Nevada table', () => {
  it('loads, validates, and says nobody has checked it yet', () => {
    expect(loadPrevailingWageTables()).toHaveLength(1);
    expect(table).toMatchObject({
      jurisdiction: 'NV', editionLabel: 'Nevada 2026-2027 prevailing wage rates, Amendment #01', determinationDate: '2026-10-01',
      effectiveFrom: '2026-10-13', thresholdUsd: 100000, checkedBy: null, checkedAt: null,
      sourceIndexUrl: 'https://labor.nv.gov/PrevailingWage/2026-2027_Prevailing_Wages/',
    });
  });

  it('holds the wireman rates, identical for Washoe and Northern Rural, with source page numbers', () => {
    expect(table.crafts).toHaveLength(1);
    const wireman = table.crafts[0]!;
    expect(wireman).toMatchObject({ craft: 'Electrician Wireman', rateType: 'Union Rate', regionCodes: ['WASHOE', 'NORTHERN_RURAL'] });
    expect(wireman.rates.map((r) => [r.classification, r.totalHourly, r.basicHourly, r.fringeHourly])).toEqual([
      ['Wireman', 83.81, null, null], ['Wireman-Cable Splicer', 91.61, null, null], ['Wireman Foreman', 91.61, null, null], ['Wireman General Foreman', 96.81, null, null],
    ]);
    expect(wireman.zoneAdders!.zones).toEqual([
      { zone: 1, fromMi: 0, toMi: 50, addPerHour: 0 }, { zone: 2, fromMi: 51, toMi: 70, addPerHour: 3 },
      { zone: 3, fromMi: 71, toMi: 90, addPerHour: 10 }, { zone: 4, fromMi: 91, toMi: null, addPerHour: 15 },
    ]);
    expect(wireman.zoneAdders!.measuredFrom.label).toBe('Washoe County Courthouse, Reno, Nevada');
    expect(wireman.overtimeNote).toMatch(/Never multiply the all-in rate/);
    const page = Object.fromEntries(table.regions.map((r) => [r.code, r.sourcePage]));
    expect(page).toEqual({ WASHOE: 15, NORTHERN_RURAL: 16, CLARK: null, SOUTHERN_RURAL: null });
    expect(table.regions.filter((r) => r.sourceUrl).every((r) => r.sourceUrl!.startsWith('https://labor.nv.gov/') && r.sourceUrl!.endsWith('Amendment%2001.pdf'))).toBe(true);
  });

  it('maps every Nevada county to its region', () => {
    const regions = Object.fromEntries(table.regions.map((r) => [r.code, r.counties]));
    expect(regions).toEqual({
      WASHOE: ['Washoe'],
      NORTHERN_RURAL: ['Carson City', 'Churchill', 'Douglas', 'Elko', 'Eureka', 'Humboldt', 'Lander', 'Lyon', 'Mineral', 'Storey', 'Pershing', 'White Pine'],
      CLARK: ['Clark'],
      SOUTHERN_RURAL: ['Esmeralda', 'Lincoln', 'Nye'],
    });
    expect(table.regions.flatMap((r) => r.counties)).toHaveLength(17); // Nevada: 16 counties + Carson City
    expect(regionForCounty(table, 'Douglas')?.code).toBe('NORTHERN_RURAL');
    expect(regionForCounty(table, 'DOUGLAS COUNTY')?.code).toBe('NORTHERN_RURAL');
    expect(regionForCounty(table, 'carson city')?.code).toBe('NORTHERN_RURAL');
    expect(regionForCounty(table, 'Washoe County')?.code).toBe('WASHOE');
    expect(regionForCounty(table, 'Clark')?.code).toBe('CLARK');
    expect(regionForCounty(table, 'Nye')?.code).toBe('SOUTHERN_RURAL');
    expect(regionForCounty(table, 'Placer')).toBeNull();
    expect(regionForCounty(table, null)).toBeNull();
  });

  it('validation catches the typos that would put a wrong rate on a card', () => {
    const broken = (edit: (t: PrevailingWageTable) => void): (() => unknown) => () => {
      const t = clone();
      edit(t);
      return validatePrevailingWage(t, 'TEST table');
    };
    expect(() => validatePrevailingWage(clone())).not.toThrow();
    expect(broken((t) => { t.crafts[0]!.rates[0]!.totalHourly = '83.81' as unknown as number; })).toThrow(/totalHourly/);
    expect(broken((t) => { t.crafts[0]!.rates[0]!.totalHourly = -1; })).toThrow(/totalHourly/);
    expect(broken((t) => { t.effectiveFrom = '10/13/26'; })).toThrow(/effectiveFrom/);
    expect(broken((t) => { t.sourceIndexUrl = 'labor.nv.gov'; })).toThrow(/sourceIndexUrl/);
    expect(broken((t) => { t.regions[1]!.counties.push('Washoe'); })).toThrow(/listed twice/);
    expect(broken((t) => { t.crafts[0]!.regionCodes = ['WASHOE', 'NOWHERE']; })).toThrow(/regionCodes/);
    expect(broken((t) => { t.crafts[0]!.regionCodes = ['CLARK']; })).toThrow(/no sourceUrl/);
    expect(broken((t) => { t.crafts[0]!.zoneAdders!.zones[1]!.fromMi = 40; })).toThrow(/overlapping/);
    expect(broken((t) => { t.crafts[0]!.zoneAdders!.zones[3]!.toMi = 120; })).toThrow(/toMi/);
    expect(broken((t) => { t.checkedBy = ''; })).toThrow(/checkedBy/);
    expect(broken((t) => { t.checkedAt = '2026-11-20'; })).toThrow(/checkedAt needs checkedBy/);
    expect(broken((t) => { t.thresholdUsd = 0; })).toThrow(/thresholdUsd/);
    expect(() => validatePrevailingWage(null)).toThrow(/Invalid prevailing wage table/);
    const checked = clone();
    checked.checkedBy = 'TEST Reviewer (simulated)';
    checked.checkedAt = '2026-11-20';
    expect(validatePrevailingWage(checked).checkedBy).toBe('TEST Reviewer (simulated)');
  });

  it('zone lookup: 0–50, 51–70, 71–90, 91 and over, flagged near a line', () => {
    const zones = table.crafts[0]!.zoneAdders!.zones;
    expect(zoneFor(zones, 0)).toEqual({ distanceMi: 0, zone: 1, addPerHour: 0, nearBoundary: false });
    expect(zoneFor(zones, 42.6)).toEqual({ distanceMi: 43, zone: 1, addPerHour: 0, nearBoundary: false });
    expect(zoneFor(zones, 48)).toEqual({ distanceMi: 48, zone: 1, addPerHour: 0, nearBoundary: true });
    expect(zoneFor(zones, 60)).toEqual({ distanceMi: 60, zone: 2, addPerHour: 3, nearBoundary: false });
    expect(zoneFor(zones, 80)).toEqual({ distanceMi: 80, zone: 3, addPerHour: 10, nearBoundary: false });
    expect(zoneFor(zones, 92)).toEqual({ distanceMi: 92, zone: 4, addPerHour: 15, nearBoundary: true });
    expect(zoneFor(zones, 250)).toEqual({ distanceMi: 250, zone: 4, addPerHour: 15, nearBoundary: false });
  });
});

describe('prevailingWageHint', () => {
  it('federal construction over $2,000: Davis-Bacon likely applies, with a link out and no state rate', () => {
    const h = prevailingWageHint(bid({ source: 'samgov', naics: '238210', estValue: value(25_000, 100_000) }));
    expect(h).toMatchObject({ basis: 'davis_bacon', applies: 'likely', headline: 'Davis-Bacon wages likely apply', rates: [], zone: null, asOf: null });
    expect(h.links).toEqual([{ label: 'Look up Davis-Bacon wage determinations on SAM.gov', url: DAVIS_BACON_SEARCH_URL }]);
    expect(h.lines).toContain(BID_DOCUMENTS_CONTROL);
    expect(text(h)).not.toMatch(/83\.81/);
    // Value unknown: still likely, because the federal floor is only $2,000.
    expect(prevailingWageHint(bid({ source: 'samgov', naics: '236220' }))).toMatchObject({ basis: 'davis_bacon', applies: 'likely' });
  });

  it('federal, not clearly construction or tiny: says "may" and "normally", never "does not apply"', () => {
    const unknownKind = prevailingWageHint(bid({ source: 'samgov', naics: null, estValue: value(40_000) }));
    expect(unknownKind).toMatchObject({ basis: 'davis_bacon', applies: 'depends', headline: 'Davis-Bacon wages may apply' });
    expect(unknownKind.lines[0]).toBe('If this is construction work over $2,000, Davis-Bacon wages likely apply.');
    expect(prevailingWageHint(bid({ source: 'samgov', naics: '561621' })).applies).toBe('depends');

    const tiny = prevailingWageHint(bid({ source: 'samgov', naics: '238210', estValue: value(1_500) }));
    expect(tiny).toMatchObject({ applies: 'normally_not', headline: 'Davis-Bacon wages normally not required at this size' });
    expect(text(tiny)).toMatch(/normally/);
    expect(tiny.lines).toContain(BID_DOCUMENTS_CONTROL);
  });

  it('Nevada, $100K and up: the rates on file, the zone adder, and every caution', () => {
    const h = prevailingWageHint(bid({ estValue: value(250_000) }));
    expect(h).toMatchObject({
      basis: 'state', applies: 'likely', headline: 'Nevada prevailing wage normally applies at $100K and up',
      asOf: 'As of 10/13/26', edition: 'Nevada 2026-2027 prevailing wage rates, Amendment #01', checked: false,
      links: [{ label: 'Nevada prevailing wage rates (Labor Commissioner)', url: 'https://labor.nv.gov/PrevailingWage/2026-2027_Prevailing_Wages/' }],
    });
    expect(h.rates).toEqual([
      { craft: 'Electrician Wireman', classification: 'Wireman', totalHourly: 83.81 },
      { craft: 'Electrician Wireman', classification: 'Wireman-Cable Splicer', totalHourly: 91.61 },
      { craft: 'Electrician Wireman', classification: 'Wireman Foreman', totalHourly: 91.61 },
      { craft: 'Electrician Wireman', classification: 'Wireman General Foreman', totalHourly: 96.81 },
    ]);
    // Gardnerville is about 41 straight-line miles from Reno: Zone 1.
    expect(h.zone).toEqual({ distanceMi: 41, zone: 1, addPerHour: 0, nearBoundary: false });
    expect(h.zoneTable).toHaveLength(4);
    expect(h.lines).toEqual([
      'Electrician Wireman, Northern Nevada Rural Region: Wireman $83.81/hr · Wireman-Cable Splicer $91.61/hr · Wireman Foreman $91.61/hr · Wireman General Foreman $96.81/hr. Base plus fringes in one number.',
      'The classification comes from the bid documents: we do not pick one.',
      'About 41 mi from the Washoe County Courthouse, Reno, Nevada in a straight line: Zone 1, no zone adder.',
      'Overtime is figured on a base rate this table does not have. Do not multiply the all-in rate.',
      'These rates were typed in from the state PDF and have not been double-checked on our side yet.',
      'As of 10/13/26. The wage determination in the bid documents controls.',
    ]);
    expect(prevailingWageHint(bid({ estValue: value(100_000) })).applies).toBe('likely');
    expect(prevailingWageHint(bid({ estValue: value(null, 400_000) })).applies).toBe('likely');
  });

  it('never works out an overtime rate from the all-in number', () => {
    const h = prevailingWageHint(bid({ estValue: value(250_000) }));
    const dollars = [...text(h).matchAll(/\$(\d+\.\d{2})/g)].map((m) => Number(m[1]));
    expect(new Set(dollars)).toEqual(new Set([83.81, 91.61, 96.81]));
    for (const rate of [83.81, 91.61, 96.81]) for (const factor of [1.5, 2]) expect(text(h)).not.toContain((rate * factor).toFixed(2));
    expect(JSON.stringify(h)).not.toMatch(/overtimeRate|doubleTime/i);
  });

  it('a far job gets its zone adder, and a job near a zone line is told to confirm', () => {
    const elko = prevailingWageHint(bid({ location: ELKO, estValue: value(300_000) }));
    expect(elko.zone).toMatchObject({ zone: 4, addPerHour: 15, nearBoundary: false });
    expect(elko.zone!.distanceMi).toBeGreaterThan(200);
    expect(text(elko)).toMatch(/Zone 4, add \$15\.00\/hr\./);
    expect(text(elko)).toContain('Northern Nevada Rural Region');

    // TEST point about 52 miles due south of the measuring point: just past the Zone 1 line.
    const edge = prevailingWageHint(bid({ location: place({ county: 'Douglas', lat: 39.5296 - 52 / 69.09, lng: -119.8138, precision: 'exact' }), estValue: value(300_000) }));
    expect(edge.zone).toMatchObject({ zone: 2, addPerHour: 3, nearBoundary: true });
    expect(text(edge)).toMatch(/Zone 2, add \$3\.00\/hr\. Close to a zone line: confirm the zone\./);

    // No point we can trust (county-level or unknown location): the whole adder range, no guess.
    const vague = prevailingWageHint(bid({ location: { ...town('Yerington'), city: null, precision: 'county' }, estValue: value(300_000) }));
    expect(vague.zone).toBeNull();
    expect(text(vague)).toContain('Zone adder of $0.00 to $15.00/hr by distance from the Washoe County Courthouse, Reno, Nevada.');
  });

  it('Nevada under $100K: "normally not required. Check the bid documents." and no rates', () => {
    const h = prevailingWageHint(bid({ estValue: value(10_000, 50_000) }));
    expect(h).toMatchObject({ basis: 'state', applies: 'normally_not', headline: 'Prevailing wage normally not required under $100K', rates: [], zone: null, zoneTable: [] });
    expect(h.lines).toEqual([
      'Nevada public works under $100K are normally not required to pay prevailing wage. Check the bid documents.',
      BID_DOCUMENTS_CONTROL,
    ]);
    expect(prevailingWageHint(bid({ estValue: value(99_999.99) })).applies).toBe('normally_not');
    expect(text(h)).not.toMatch(/exempt|not required\.|does not apply/i);
  });

  it('Nevada, value unknown or straddling the line: "applies if the job is over $100K", with the rates it would mean', () => {
    const unknown = prevailingWageHint(bid());
    expect(unknown).toMatchObject({ applies: 'depends', headline: 'Prevailing wage applies if the job is over $100K' });
    expect(unknown.lines[0]).toBe('No job value is listed.');
    expect(unknown.rates).toHaveLength(4);
    const straddle = prevailingWageHint(bid({ estValue: value(80_000, 150_000) }));
    expect(straddle).toMatchObject({ applies: 'depends', headline: 'Prevailing wage applies if the job is over $100K' });
    expect(straddle.lines[0]).toBe('The estimate straddles $100K.');
  });

  it('a board the scanner tags "Prevailing wage likely" tips an unknown value to likely, but not a small job', () => {
    const tagged = prevailingWageHint(bid({ flags: ['SPWD bidder qualification', 'Prevailing wage likely'] }));
    expect(tagged).toMatchObject({ applies: 'likely', headline: 'Prevailing wage likely applies (jobs over $100K)' });
    expect(tagged.lines.slice(0, 2)).toEqual(['No job value is listed.', 'Jobs on this bid board normally carry prevailing wage.']);
    expect(tagged.rates).toHaveLength(4);
    expect(prevailingWageHint(bid({ estValue: value(40_000), flags: ['Prevailing wage likely'] })).applies).toBe('normally_not');
  });

  it('a notice that mentions prevailing wage wins over a small estimate', () => {
    const h = prevailingWageHint(bid({ estValue: value(40_000), flags: ['Bid bond', 'Prevailing wage'] }));
    expect(h).toMatchObject({ applies: 'likely', headline: 'The notice mentions prevailing wage' });
    expect(h.rates).toHaveLength(4);
    expect(prevailingWageHint(bid({ estValue: value(40_000), flags: ['Certified payroll'] })).applies).toBe('likely');
    expect(prevailingWageHint(bid({ estValue: value(40_000), flags: ['Bid bond'] })).applies).toBe('normally_not');
  });

  it('says so when the region has no rates on file or the county is unknown', () => {
    const clark = prevailingWageHint(bid({ location: town('Las Vegas'), estValue: value(300_000) }));
    expect(clark).toMatchObject({ applies: 'likely', rates: [], zone: null });
    expect(clark.lines[0]).toBe("We do not have the Clark County Region rates on file. See the Labor Commissioner's rate sheets.");
    expect(text(clark)).not.toMatch(/\$\d+\.\d{2}\/hr/);

    const nowhere = prevailingWageHint(bid({ location: place({ county: null }), estValue: value(300_000) }));
    expect(nowhere.rates).toEqual([]);
    expect(nowhere.lines[0]).toBe('We could not tell the county, so we cannot tell which Nevada wage region this is.');
    expect(nowhere.lines.at(-1)).toBe('As of 10/13/26. The wage determination in the bid documents controls.');
  });

  it('Washoe uses the same wireman table', () => {
    const reno = prevailingWageHint(bid({ location: town('Reno'), estValue: value(300_000) }));
    expect(reno.rates.map((r) => r.totalHourly)).toEqual([83.81, 91.61, 91.61, 96.81]);
    expect(reno.zone).toEqual({ distanceMi: 0, zone: 1, addPerHour: 0, nearBoundary: false });
    expect(reno.lines[0]).toContain('Washoe County Region');
  });

  it('other states: nothing on file, said plainly; and a checked table drops the "not double-checked" line', () => {
    const ca = prevailingWageHint(bid({ source: 'questcdn', location: place({ state: 'CA', county: 'El Dorado' }), estValue: value(300_000) }));
    expect(ca).toEqual({
      basis: 'none', applies: 'unknown', headline: 'No prevailing wage table on file for CA',
      lines: ['If this is a public works job, prevailing wage may apply. The wage determination in the bid documents controls.'],
      rates: [], zone: null, zoneTable: [], asOf: null, edition: null, checked: false, links: [],
    });
    expect(prevailingWageHint(bid({ location: place({ state: null }) })).headline).toBe('No prevailing wage table on file for this bid');

    const checked = clone();
    checked.checkedBy = 'TEST Reviewer (simulated)';
    const h = prevailingWageHint(bid({ estValue: value(250_000) }), [checked]);
    expect(h.checked).toBe(true);
    expect(text(h)).not.toMatch(/double-checked/);
    // With no table passed in, a Nevada bid has nothing on file either.
    expect(prevailingWageHint(bid({ estValue: value(250_000) }), []).basis).toBe('none');
  });

  it('every hint keeps the cautious words', () => {
    const cases: HintBid[] = [
      bid(), bid({ estValue: value(5_000) }), bid({ estValue: value(500_000) }), bid({ estValue: value(80_000, 150_000) }),
      bid({ source: 'samgov', naics: '238210' }), bid({ source: 'samgov' }), bid({ location: place({ state: 'CA' }) }),
      bid({ location: place({ county: 'Clark' }), estValue: value(500_000) }),
    ];
    for (const c of cases) {
      const h = prevailingWageHint(c);
      expect(text(h), text(h)).toContain('bid documents');
      expect(text(h), text(h)).not.toMatch(/\b(guaranteed|definitely|exempt|always)\b/i);
    }
  });
});
