import { describe, expect, it } from 'vitest';
import {
  CA_AGENCY_TOWNS, CA_COUNTIES, CA_FACILITIES, CALTRANS_DISTRICTS, areaCounties, caCounty, caltransDistrictInId, seatOf,
} from '../src/geo/california.js';
import { countiesNamed } from '../src/geo/caleprocure-place.js';
import { lookupCity, milesBetween } from '../src/geo/zip.js';

describe('California counties', () => {
  it('58 counties, distinct names and distinct seats, every seat found in the ZIP table and inside California', () => {
    expect(CA_COUNTIES).toHaveLength(58);
    expect(new Set(CA_COUNTIES.map((c) => c.name)).size).toBe(58);
    expect(new Set(CA_COUNTIES.map((c) => c.seat)).size).toBe(58);
    for (const c of CA_COUNTIES) {
      const s = seatOf(c.name);
      expect(s, c.name).not.toBeNull();
      expect(s!.state).toBe('CA');
      // California's box: 32.5–42.0 N, 114.1–124.5 W.
      expect(s!.lat, c.name).toBeGreaterThan(32.5);
      expect(s!.lat, c.name).toBeLessThan(42.0);
      expect(s!.lng, c.name).toBeLessThan(-114.1);
      expect(s!.lng, c.name).toBeGreaterThan(-124.5);
    }
  });

  it('a few seats where they belong (miles from a known neighbour)', () => {
    expect(milesBetween(seatOf('Amador')!, lookupCity('Sutter Creek', 'CA')!)).toBeLessThan(6); // Jackson
    expect(milesBetween(seatOf('Del Norte')!, lookupCity('Smith River', 'CA')!)).toBeLessThan(15); // Crescent City
    expect(milesBetween(seatOf('Santa Clara')!, lookupCity('San Jose', 'CA')!)).toBe(0);
    expect(milesBetween(seatOf('Nevada')!, lookupCity('Grass Valley', 'CA')!)).toBeLessThan(12); // Nevada City (ZIP-area centres)
  });

  it('caCounty reads a name with or without "County", any case; anything else is null', () => {
    expect(caCounty('SAN LUIS OBISPO COUNTY')?.name).toBe('San Luis Obispo');
    expect(caCounty('el dorado')?.name).toBe('El Dorado');
    expect(caCounty('Clark')).toBeNull();
    expect(caCounty('')).toBeNull();
  });
});

describe('Caltrans districts', () => {
  it('12 districts that together cover the 58 counties; Kern alone is in two (6 west, 9 east)', () => {
    expect(CALTRANS_DISTRICTS.map((d) => d.district)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const all = CALTRANS_DISTRICTS.flatMap((d) => d.counties);
    for (const n of all) expect(caCounty(n), n).not.toBeNull();
    expect(new Set(all).size).toBe(58);
    expect(all.filter((n) => n === 'Kern')).toHaveLength(2);
    expect(all.length).toBe(59);
    for (const d of CALTRANS_DISTRICTS) {
      expect(lookupCity(d.office, 'CA'), `District ${d.district} office`).not.toBeNull();
      expect([...d.counties].sort(), `District ${d.district} alphabetical`).toEqual([...d.counties]);
    }
  });

  it('the district in an event id: "10-1H0204", "03A4243"; never 32, 56, 75 (headquarters programs)', () => {
    expect(caltransDistrictInId('10-1H0204')?.district).toBe(10);
    expect(caltransDistrictInId('03A4243')?.district).toBe(3);
    expect(caltransDistrictInId('12-0R9704')?.district).toBe(12);
    expect(caltransDistrictInId('01-0H2464')?.district).toBe(1);
    expect(caltransDistrictInId('32A0740')).toBeNull();
    expect(caltransDistrictInId('56A0916')).toBeNull();
    expect(caltransDistrictInId('75A0605')).toBeNull();
    expect(caltransDistrictInId('32-12-6645')).toBeNull();
    expect(caltransDistrictInId('0000040420')).toBeNull();
  });

  // Every Caltrans (department 2660) row of the real Cal eProcure list of 2026-11-14 whose event id carries a district
  // and whose title names counties: event id and title copied verbatim from vol/first/fiscal-grid.out.
  const DISTRICT_ROWS: Array<[string, string]> = [
    ['11A4467', 'SB Minor B - 11A4467 - Imperial County'],
    ['08A4047', 'IFB 08A4047, Elevator Maintenance in San Bernardino County'],
    ['09A1153', 'Hazardous Waste Disposal Drums Services in Inyo, Mono, and Kern Counties'],
    ['07A6467', 'IFB Scheduled and On-call Trash Collection, Hauling, and Disposal Services, Los Angeles County'],
    ['02A2547', 'IFB 02A2547 - Multi-provider On-Call, and As-Needed Title and Escrow Services in Tehama County'],
    ['05A3054', 'IFB Hazardous Waste Disposal Services in Monterey, San Benito, San Luis Obispo, Santa Barbara, and Santa Cruz Counties'],
    ['07A6539', '**Certified SB/DVBE Only** IFPQ Boiler Inspection, Maintenance, Repair, Testing, and Reporting in Los Angeles County'],
    ['03A4243', 'SB Minor B 03A4243 - Bicycle Railing Installation - Placer County'],
    ['04A7610', 'IFB Dry Dock Ferry Maintenance and Repair Services in Solano County'],
    ['05A3057', 'Scrap Metal Recycling Services in Monterey, Santa Cruz, and San Benito Counties'],
    ['07A6511', 'IFB Guardrail Services, Los Angeles County'],
    ['07A6516', 'IFB Guardrail Services, Los Angeles County'],
    ['08A4064', 'Trash Collection, Hauling, and Disposal Services in Riverside County'],
    ['11A4478', 'SB Minor B- Replace Guardrail-San Diego County'],
    ['10A2952', 'IFB Title and Escrow Services in Mariposa County'],
    ['10A2951', 'IFB Title and Escrow Services in Tuolumne County'],
    ['08A4052', 'IFB Monthly and On-call Pest Control Services, San Bernardino County'],
    ['07A6504', 'IFB Tree Trimming, Pruning, & Removal Services, Los Angeles & Ventura Counties'],
    ['02A2557', 'Gate Operator Replacement Services in Shasta County'],
    ['02A2568', 'IFB Title and Escrow Lassen County'],
    ['05A3037', '*Certified SB/DVBE only* IFPQ HVAC Preventative Maintenance and Repair Services in San Luis Obispo County'],
    ['05A3060', 'IFB Routine and Non-Routine Generator Maintenance and Repair Services in Monterey, San Luis Obispo, Santa Barbara and Santa Clara Counties'],
    ['06A3342', 'Wildfire Fuel Reduction Vegetation and Tree Removal Services in Fresno, Tulare, and Kern Counties'],
    ['10A2976', 'SB Minor B 10A2976 - Replace Roadway Weather Information Systems (RWIS) System - San Joaquin County'],
    ['11A4303', 'IFB - Hazardous Waste Disposal Services in San Diego and Imperial Counties.'],
    ['12A2409', 'IFB Small Engine Repair Services, Orange County'],
  ];

  it('every real Caltrans row that names counties names counties of the district in its event id (one exception, below)', () => {
    let checked = 0;
    for (const [id, title] of DISTRICT_ROWS) {
      const d = caltransDistrictInId(id)!;
      const named = countiesNamed(title).counties;
      expect(named.length, id).toBeGreaterThan(0);
      const outside = named.filter((n) => !d.counties.includes(n));
      // 05A3060 (District 5) names Santa Clara, which Caltrans puts in District 4: the table is right (its own TMS row
      // 56A0917 below lists Santa Clara with the District 4 counties); the title is kept as written.
      expect(outside, id).toEqual(id === '05A3060' ? ['Santa Clara'] : []);
      checked++;
    }
    expect(checked).toBe(26);
  });

  // The statewide TMS program (event ids 56A09xx, not a district code) lists each district's counties in full: a
  // second, independent check that the table's county lists are Caltrans' own. Titles verbatim from the same list.
  const TMS_ROWS: Array<[number, string]> = [
    [3, 'IFB 56A0916 Maintenance and Repair of the Transportation Management Systems (TMS) Elements and Communications Infrastructure in Butte, Colusa, El Dorado, Glenn, Nevada, Placer, Sacramento, Sierra, Sutter, Yolo, and Yuba Counties.'],
    [4, 'IFB 56A0917 Maintenance and Repair of the Transportation Management Systems (TMS) Elements and Communications Infrastructure in Alameda, Contra Costa, Marin, Napa, San Francisco, San Mateo, Santa Clara, Solano, and Sonoma Counties.'],
    [5, 'IFB 56A0915 Maintenance and Repair of the Transportation Management Systems (TMS) Elements and Communications Infrastructure in San Benito, Santa Cruz, Monterey, San Luis Obispo, and Santa Barbara Counties.'],
    [6, 'IFB 56A0918 Maintenance and Repair of the Transportation Management Systems (TMS) Elements and Communications Infrastructure in Madera, Fresno, Kings, Tulare, and Kern Counties.'],
    [7, 'IFB 56A0919 Maintenance and Repair of the Transportation Management Systems (TMS) Elements and Communications Infrastructure in Los Angeles and Ventura Counties.'],
    [8, 'IFB 56A0920 Maintenance and Repair of the Transportation Management Systems (TMS) Elements and Communications Infrastructure in San Bernardino and Riverside Counties.'],
    [10, 'IFB 56A0921 Maintenance and Repair of the Transportation Management Systems (TMS) Elements and Communications Infrastructure in Alpine, Amador, Calaveras, Mariposa, Merced, San Joaquin, Stanislaus, and Tuolumne Counties.'],
    [11, 'IFB 56A0922 Maintenance and Repair of the Transportation Management Systems (TMS) Elements and Communications Infrastructure in San Diego and Imperial Counties.'],
    [12, 'IFB 56A0923 Maintenance and Repair of the Transportation Management Systems (TMS) Elements and Communications Infrastructure in Orange County.'],
  ];

  it("the TMS program's county lists are exactly the districts' county lists", () => {
    for (const [n, title] of TMS_ROWS) {
      expect(countiesNamed(title).counties.sort(), `District ${n}`).toEqual([...CALTRANS_DISTRICTS[n - 1]!.counties]);
    }
  });
});

describe('campuses and facilities', () => {
  it('every town resolves in California', () => {
    for (const a of CA_AGENCY_TOWNS) expect(lookupCity(a.town, 'CA'), a.town).not.toBeNull();
    for (const f of CA_FACILITIES) {
      expect(!!f.town !== !!f.county, f.note).toBe(true);
      if (f.town) expect(lookupCity(f.town, 'CA'), f.town).not.toBeNull();
      if (f.county) expect(caCounty(f.county), f.county).not.toBeNull();
    }
  });
});

describe('areaCounties', () => {
  it('only a California region with no point and a county list (one county alone is an area of one county)', () => {
    const base = { precision: 'region', state: 'CA', lat: null, county: 'Humboldt, Shasta' };
    expect(areaCounties(base)).toEqual(['Humboldt', 'Shasta']);
    expect(areaCounties({ ...base, county: 'Humboldt' })).toEqual(['Humboldt']);
    expect(areaCounties({ ...base, lat: 40 })).toBeNull();
    expect(areaCounties({ ...base, state: 'NV' })).toBeNull();
    expect(areaCounties({ ...base, precision: 'county' })).toBeNull();
    expect(areaCounties({ ...base, county: 'Humboldt, Atlantis' })).toBeNull();
    // A Nevada region keeps no county list: never an area.
    expect(areaCounties({ precision: 'region', state: 'NV', lat: null, county: null })).toBeNull();
  });
});
