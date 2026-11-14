import { describe, expect, it } from 'vitest';
import { countiesNamed, placeCaleprocure, TOWN_IN_COUNTY_MI, townInCounty } from '../src/geo/caleprocure-place.js';
import { seatOf } from '../src/geo/california.js';
import { lookupCity, milesBetween } from '../src/geo/zip.js';
import { finalizeBid } from '../src/scan.js';
import { parseCaleprocurePage } from '../src/sources/caleprocure.js';
import type { LocationPrecision } from '../src/types.js';
import { fx } from './helpers.js';

// Every row of the real grid fixture (68 whole rows of the 2026-11-14 list, test/fixtures/caleprocure-grid.md), with
// where it is placed and why: [sourceId, precision, label]. The comment is the start of the row's real title.
const EXPECTED: Array<[string, LocationPrecision, string]> = [
  ['6530-0000040760', 'agency', "Los Angeles, CA (UCLA)"], // UCLA Center for Health Sciences Fire Sprinkler Retrofit | School of Me
  ['5225-0000040653', 'state', "CA (location not listed)"], // C5613445-D American Sign Language (ASL) In-Person Interpreting (IPI) S
  ['3790-0000040921', 'agency', "Weaverville, CA (Weaverville Joss House SHP)"], // C26645003 Roof Replacement Weaverville Joss House, Visitor Center
  ['8940-0000040634', 'agency', "Fresno, CA (Hammer Field)"], // IFB No. 133713 FMS 25 Multiple Roll-up Door Repairs and Preventative M
  ['0531-0000040856', 'state', "CA (location not listed)"], // 79050750-Telesign Service Platform
  ['2720-0000040692', 'city', "Madera, CA (CHP Madera)"], // IFB 26C450003 - CHP Madera Fire & security Alarm Monitoring Services
  ['3600-0000040632', 'region', "Fresno County, CA (site not named)"], // P2640008: Generator Maintenance and Repairs, at the Salmon Conservatio
  ['3860-10221501', 'state', "CA (location not listed)"], // Dam Safety Engineering Services ¿ Southern California
  ['6580-3742', 'agency', "Santa Cruz, CA (UC Santa Cruz)"], // RFQ - 3742 Oakes College Housing Capital Improvements
  ['8570-0000040672', 'city', "Winterhaven, CA"], // 26-0052a - Winterhaven BPS Generator Replacement (Imperial County) Pub
  ['2660-09A1153', 'region', "Inyo, Mono and Kern counties, CA"], // Hazardous Waste Disposal Drums Services in Inyo, Mono, and Kern Counti
  ['2660-10-1H0204', 'region', "Caltrans District 10: Alpine, Amador, Calaveras + 5 more counties"], // Curb ramp, CRCP, JPCP, HMA, electrical, erosion control, and planting.
  ['2660-03A4224', 'region', "Nevada and Placer counties, CA"], // IFB Trash Collection, Hauling, and Disposal Services, Nevada & Placer
  ['2660-05A3054', 'region', "Monterey, San Benito, San Luis Obispo + 2 more counties, CA"], // IFB Hazardous Waste Disposal Services in Monterey, San Benito, San Lui
  ['77601-0000040916', 'state', "CA (location not listed)"], // RFI #2 - NASPO ValuePoint Commercial Card Services (State of Washingto
  ['7760-0000040420', 'city', "Napa, CA"], // CONTRACT NUMBER: 26-334792; AUGMENTATION OF ELECTRICAL SERVICE CAPACIT
  ['2660-03A4243', 'region', "Placer County, CA (site not named)"], // SB Minor B 03A4243 - Bicycle Railing Installation - Placer County
  ['3540-9CA07882', 'state', "CA (location not listed)"], // IFB 9CA07882 - Underground Electrical Power Infrastructure Installatio
  ['2740-26-134R', 'city', "Bishop, CA (Bishop DMV)"], // 26-134 REBID After-hours Janitorial Services for the Bishop DMV Field 
  ['8940-0000040809', 'state', "CA (location not listed)"], // IFB No. 134173 Roll-up Door Replacement, Sacramento Okinawa FMS-22
  ['2660-04A7610', 'region', "Solano County, CA (site not named)"], // IFB Dry Dock Ferry Maintenance and Repair Services in Solano County
  ['2660-56A0916', 'region', "Butte, Colusa, El Dorado + 8 more counties, CA"], // IFB 56A0916 Maintenance and Repair of the Transportation Management Sy
  ['2660-56A0921', 'region', "Alpine, Amador, Calaveras + 5 more counties, CA"], // IFB 56A0921 Maintenance and Repair of the Transportation Management Sy
  ['3540-7CA08060', 'state', "CA (location not listed)"], // IFB 7CA08060 - Portable Restroom and Handwash Station Rental Services
  ['2740-26-165', 'city', "Ventura, CA (Ventura DMV)"], // 26-165 Property Sweeping and Pressure Washing Services at the Ventura 
  ['5225-0000040865', 'agency', "Crescent City, CA (Pelican Bay State Prison)"], // RFO SD26-00017 Upgrade Nurse Call Light System (PBSP)
  ['5160-03-0190-8', 'agency', "Sacramento, CA (CalPERS Lincoln Plaza)"], // 03-0190-8 PERS Q Lincoln Plaza
  ['8940-0000040830', 'city', "Los Alamitos, CA"], // Lice Treatment Services, Los Alamitos, CA
  ['77601-0000038873', 'state', "CA (location not listed)"], // Plastic Trash Bags
  ['8940-0000040694', 'agency', "Bakersfield, CA (Gateway Armory)"], // IFB No.132421 Building Management System (BMS) Replacement, Bakersfiel
  ['2720-0000040786', 'city', "Santa Cruz, CA (CHP Santa Cruz)"], // IFB 26C720002 CHP Santa Cruz Area Office Protective Clothing and Opera
  ['6700-0000040674', 'agency', "Fresno, CA (CSU, Fresno)"], // Request for Qualifications - Task Order Construction Agreement - Gener
  ['2660-02A2557', 'region', "Shasta County, CA (site not named)"], // Gate Operator Replacement Services in Shasta County
  ['2660-05A3060', 'region', "Monterey, San Luis Obispo, Santa Barbara + 1 more county, CA"], // IFB Routine and Non-Routine Generator Maintenance and Repair Services 
  ['2660-06A3342', 'region', "Fresno, Tulare and Kern counties, CA"], // Wildfire Fuel Reduction Vegetation and Tree Removal Services in Fresno
  ['77601-0000040924', 'state', "CA (location not listed)"], // Renewable Diesel Request for Information
  ['2665-0000040867', 'city', "Bakersfield, CA"], // HSR26-35 - Janitorial Services at the California High-Speed Rail Autho
  ['6511-0000040930', 'agency', "Sacramento, CA (UC Davis Medical Center)"], // RFQ for Design Professional Services - Capital Infrastructure Projects
  ['2660-03-1N7504', 'region', "Caltrans District 3: Butte, Colusa, El Dorado + 8 more counties"], // Construct sound wall, drainage, and electrical.
  ['2660-12-0R9704', 'region', "Caltrans District 12: Orange County"], // Slab replacement, RHMA paving, modify signal and lighting systems.
  ['77601-0000040480', 'state', "CA (location not listed)"], // Tuna, Canned & Pouched
  ['2740-26-162', 'city', "Carmichael, CA (Carmichael DMV)"], // 26-162 Carmichael DMV Parking Lot Repairs Services
  ['2720-0000040872', 'state', "CA (location not listed)"], // CHP Central L.A. - HVAC Maintenance Services - IFB# 26C590001
  ['8940-0000040868', 'city', "San Luis Obispo, CA"], // Golf Cart Rental Services, San Luis Obispo, CA
  ['2660-01-0H2464', 'region', "Caltrans District 1: Del Norte, Humboldt, Lake + 1 more county"], // Install welded steel pipe; structural concrete; & alt pipe culvert.
  ['8940-0000040732', 'agency', "San Luis Obispo, CA (Camp San Luis Obispo)"], // IFB No. 133914 CSLO Bldg. 872 Computer Room Air Conditioner (CRAC) Sys
  ['8570-0000040876', 'region', "Imperial County, CA (site not named)"], // 26-0110 - Imperial County Tree Removal Services
  ['SS247-27-003', 'agency', "Del Mar, CA (Del Mar Fairgrounds)"], // Paddock Video Board Replacement (Public Works)
  ['3790-0000040673', 'agency', "Markleeville, CA (Grover Hot Springs SP)"], // C26863029 GROVER HOT SPRINGS STATE PARK - Maintenance Yard Rebuild
  ['6850-0000040943', 'agency', "Camarillo, CA (CSU Channel Islands)"], // CI-277 F17 Northwest Wing Abatement & Interior Demolition
  ['2720-0000040752', 'city', "Crescent City, CA"], // IFB 26C120002 - HVAC Maintenance - Crescent City
  ['3860-0000040808', 'state', "CA (location not listed)"], // Specification 26-10 (C51700) Butte Slough Outfall Gates Repairs, Sacra
  ['7760-0000040598', 'city', "Atascadero, CA"], // CONTRACT:26-337609; DSH ATASCADERO ELECTRICAL UPGRADES; DEPARTMENT OF 
  ['7760-0000040937', 'city', "Potrero, CA"], // CONTRACT: 26-344685; POTRERO FIRE STATION ¿ FACILITY REPLACEMENT; DEPA
  ['7760-0000040148', 'region', "Alpine County, CA (site not named)"], // CONTRACT NUMBER: 26-330888; CHPERS I: REPLACEMENT OF TOWERS AND VAULTS
  ['7760-0000040949', 'city', "Porterville, CA"], // CONTRACT NUMBER: 26-344753; STAFF RESIDENCES REHABILITATION, DEPARTMEN
  ['2665-0000040862', 'state', "CA (location not listed)"], // HSR26-79 Interior/Exterior Window Washing and De-webbing Services in B
  ['7760-0000040810', 'city', "Oxnard, CA"], // Project2765.OxnardFieldOfficeRenovation.CR26-342343
  ['6760-0000040365', 'agency', "Northridge, CA (CSU Northridge, Los Angeles)"], // PW2602 University Library (UL) Egress Stair
  ['8570-0000040888', 'city', "Smith River, CA"], // IFB 26-0094 - Smith River BPS HVAC Split System (Del Norte County) - P
  ['2660-75A0605', 'city', "Oakland, CA"], // IFB Locomotive Overhaul Services in Oakland, CA
  ['6780-0000040926', 'agency', "Sacramento, CA (CSU, Sacramento)"], // Request for Qualifications - Task Order Construction Agreement (TOCA)
  ['7760-0000040277', 'region', "Humboldt and Shasta counties, CA"], // CONTRACT : 26-333577; PHASE V COMMUNICATION FACILITIES REPLACEMENT: GR
  ['5225-0000040934', 'agency', "Vacaville, CA (CSP Solano)"], // Fire Alarm Replacement at the California State Prison, Solano
  ['5225-0000040932', 'agency', "Corcoran, CA (SATF Corcoran)"], // Fire Alarm Replacement project at the Substance Abuse Treatment Facili
  ['8570-0000040483', 'state', "CA (location not listed)"], // Blanket Advertisement for Fair-Time Services
  ['0515-0000039767', 'state', "CA (location not listed)"], // Homeless Data Integration System - Maintenance and Operations (HDIS - 
  ['6690-0000040619', 'agency', "Carson, CA (CSU Dominguez Hills)"], // ANNUAL BLANKET ADVERTISEMENT FOR POTENTIAL MINOR CAPITAL CONSTRUCTION 
];

const page = parseCaleprocurePage(fx('caleprocure-grid.html'));
const byId = new Map(page.bids.map((b) => [b.sourceId, b]));

describe('placeCaleprocure on the real list', () => {
  it('covers every fixture row, at least 40 placed by a rule', () => {
    expect(EXPECTED.map((e) => e[0]).sort()).toEqual([...byId.keys()].sort());
    expect(EXPECTED.filter((e) => e[1] !== 'state').length).toBeGreaterThanOrEqual(40);
  });

  for (const [id, precision, label] of EXPECTED) {
    it(`${id} → ${label}`, () => {
      const b = byId.get(id)!;
      const loc = placeCaleprocure(b);
      expect(loc).toMatchObject({ state: 'CA', precision, label });
      // Through the scan's own path too: locate() hands every Cal eProcure draft to placeCaleprocure.
      expect(finalizeBid(b).location).toEqual(loc);
      if (precision === 'region' || precision === 'state') {
        // An area or an unplaced card never claims a point.
        expect(loc.lat).toBeNull();
        expect(loc.lng).toBeNull();
      } else {
        expect(loc.lat).not.toBeNull();
      }
      // A county alone is an area of one county: no point (its seat is not the job).
      if (precision === 'county') throw new Error(`${id}: a county row must be an area, not a point`);
    });
  }

  it('an area stores its counties in the county field, in the order the title names them', () => {
    expect(placeCaleprocure(byId.get('2660-06A3342')!).county).toBe('Fresno, Tulare, Kern');
    expect(placeCaleprocure(byId.get('7760-0000040277')!).county).toBe('Humboldt, Shasta');
    // A district: its counties, alphabetical.
    expect(placeCaleprocure(byId.get('2660-10-1H0204')!).county).toBe('Alpine, Amador, Calaveras, Mariposa, Merced, San Joaquin, Stanislaus, Tuolumne');
    // On a District 3 row, its own counties named bare ("Nevada & Placer").
    expect(placeCaleprocure(byId.get('2660-03A4224')!).county).toBe('Nevada, Placer');
  });

  it('a town named beside a county is kept only when it lies in that county', () => {
    expect(placeCaleprocure(byId.get('7760-0000040598')!)).toMatchObject({ city: 'Atascadero', county: 'San Luis Obispo', precision: 'city' });
    expect(placeCaleprocure(byId.get('7760-0000040949')!)).toMatchObject({ city: 'Porterville', county: 'Tulare' });
    // Winterhaven is ~55 mi from El Centro, but El Centro is its nearest county seat: Imperial County holds it.
    expect(placeCaleprocure(byId.get('8570-0000040672')!)).toMatchObject({ city: 'Winterhaven', county: 'Imperial' });
    expect(townInCounty(lookupCity('Atascadero', 'CA')!, 'San Luis Obispo')).toBe(true);
    expect(townInCounty(lookupCity('Atascadero', 'CA')!, 'Shasta')).toBe(false);
    expect(milesBetween(lookupCity('Atascadero', 'CA')!, seatOf('San Luis Obispo')!)).toBeLessThan(TOWN_IN_COUNTY_MI);
  });
});

describe('never a bare capitalised word', () => {
  const place = (title: string, agency = 'Department of General Services', sourceId = '7760-0000000000') =>
    placeCaleprocure({ title, agency, sourceId });

  it('the real traps of the list stay unplaced, or go to the facility, never the town of the same name', () => {
    // "Lincoln Plaza" is CalPERS' office building in Sacramento, not the City of Lincoln.
    expect(placeCaleprocure(byId.get('5160-03-0190-8')!).city).toBe('Sacramento');
    expect(place('03-0190-8 Lincoln Plaza window washing (TEST, not a real row)').precision).toBe('state');
    // "Sacramento Okinawa FMS-22" and "… Sacramento River" name no town with corroboration.
    expect(placeCaleprocure(byId.get('8940-0000040809')!).precision).toBe('state');
    expect(placeCaleprocure(byId.get('3860-0000040808')!).precision).toBe('state');
    // "… Services in Bakersfield" (no office, county or ", CA").
    expect(placeCaleprocure(byId.get('2665-0000040862')!).precision).toBe('state');
  });

  it('words that are towns or counties elsewhere (TEST titles)', () => {
    expect(place('146380 Services, Fire Protection, Nevada Facilities').precision).toBe('state');
    expect(place('Orange Grove Irrigation Repair').precision).toBe('state');
    expect(place('Mission Critical Generator Service').precision).toBe('state');
    expect(place('Commerce Building HVAC').precision).toBe('state');
    expect(place('Sacramento Okinawa FMS-22 Repairs').precision).toBe('state');
    // "Imperial County" is the county, not the City of Imperial.
    expect(place('Tree Removal, Imperial County')).toMatchObject({ precision: 'region', county: 'Imperial', city: null, lat: null });
  });

  it('countiesNamed: only with the word County / Counties', () => {
    expect(countiesNamed('Butte Slough Outfall Gates Repairs, Sacramento River').counties).toEqual([]);
    expect(countiesNamed('in Los Angeles & Ventura Counties').counties).toEqual(['Los Angeles', 'Ventura']);
    expect(countiesNamed('ATASCADERO, SAN LUIS OBISPO COUNTY, CALIFORNIA')).toMatchObject({ counties: ['San Luis Obispo'], beside: ['ATASCADERO'] });
    expect(countiesNamed('Clark County Detention Center').counties).toEqual([]);
  });

  it('a District 12 row is an area of Orange County alone: no point, no seat', () => {
    expect(placeCaleprocure(byId.get('2660-12-0R9704')!)).toMatchObject({ precision: 'region', county: 'Orange', city: null, lat: null, lng: null });
  });
});
