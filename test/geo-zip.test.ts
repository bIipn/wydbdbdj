/**
 * Nationwide location: ZIP → place, city + state → place, states inside a radius, and locate() using them.
 * The ZIPs and reference coordinates are real, well-known places. Bids built here are synthetic (TEST- ids).
 */
import { createRequire } from 'node:module';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { locate, milesBetween } from '../src/geo/locate.js';
import { lookupCity, lookupZip, statesWithin, type ZipPlace } from '../src/geo/zip.js';
import { parseSamResponse, type SamResponse } from '../src/sources/samgov.js';

type LatLng = { lat: number; lng: number };

const require = createRequire(import.meta.url);
const pkg = require('zipcodes') as { codes: Record<string, unknown>; distance(a: string, b: string): number | null };

/** Every ZIP the module is willing to use, for exhaustive checks and as the brute-force oracle. */
let memo: ZipPlace[] | undefined;
const everyZip = (): ZipPlace[] => (memo ??= Object.keys(pkg.codes).map((zip) => lookupZip(zip)).filter((p) => p !== null));

/** Anywhere on Earth. */
const point = fc.record({ lat: fc.double({ min: -90, max: 90, noNaN: true }), lng: fc.double({ min: -180, max: 180, noNaN: true }) });
/**
 * Anywhere the US has ground: American Samoa (15°S) to northern Alaska (72°N), and from Palau (134°E) east across
 * the Pacific to the Virgin Islands (64°W). No two points in this box are on opposite sides of the globe.
 */
const usPoint = fc.record({ lat: fc.double({ min: -15, max: 72, noNaN: true }), east: fc.double({ min: 0, max: 162, noNaN: true }) })
  .map(({ lat, east }) => ({ lat, lng: east <= 46 ? 134 + east : east - 226 }));
const anyText = fc.oneof(fc.string(), fc.string({ unit: 'binary' }));

describe('loading the ZIP table', () => {
  it('reads the 5 MB table on first use, not at import, and only once', async () => {
    const id = require.resolve('zipcodes');
    const loaded = () => id in require.cache;
    delete require.cache[id];
    vi.resetModules();
    const fresh = await import('../src/geo/zip.js');
    expect(loaded()).toBe(false);
    expect(fresh.lookupZip('not a zip')).toBeNull(); // nothing to look up, so still nothing loaded
    expect(loaded()).toBe(false);

    expect(fresh.lookupZip('89410')?.city).toBe('Gardnerville');
    expect(loaded()).toBe(true);

    delete require.cache[id]; // a second read would put it back
    expect(fresh.lookupZip('10001')?.state).toBe('NY');
    expect(fresh.lookupCity('Reno', 'NV')?.state).toBe('NV');
    expect(fresh.statesWithin({ lat: 39.5296, lng: -119.8138 }, 10)).toEqual(['NV']);
    expect(loaded()).toBe(false);
  });
});

describe('milesBetween', () => {
  // Reference great-circle distances between the two downtowns; ZIP centres sit within a few miles of them.
  it.each<[string, string, number, number, string]>([
    ['10001', '90012', 2446, 15, 'New York ↔ Los Angeles'],
    ['98101', '33101', 2733, 15, 'Seattle ↔ Miami'],
    ['60601', '77002', 940, 10, 'Chicago ↔ Houston'],
    ['89501', '89101', 345, 8, 'Reno ↔ Las Vegas'],
    ['76102', '75201', 30, 4, 'Fort Worth ↔ Dallas'],
  ])('%s ↔ %s is about %i mi (±%i) — %s', (a, b, miles, tolerance) => {
    const d = milesBetween(lookupZip(a)!, lookupZip(b)!);
    expect(Math.abs(d - miles)).toBeLessThanOrEqual(tolerance);
    // The package has its own formula (spherical law of cosines, whole miles): an independent second opinion.
    expect(Math.abs(d - pkg.distance(a, b)!)).toBeLessThanOrEqual(1);
  });

  it('puts the pilot 15–25 mi from Carson City when both are given as ZIPs', () => {
    const d = milesBetween(lookupZip('89410')!, lookupZip('89701')!);
    expect(d).toBeGreaterThan(15);
    expect(d).toBeLessThan(25);
  });

  it('is a distance wherever the US has ground: zero to itself, the same both ways, never shorter by a detour', () => {
    fc.assert(fc.property(usPoint, usPoint, usPoint, (a, b, c) => {
      expect(milesBetween(a, a)).toBe(0);
      expect(milesBetween(a, b)).toBe(milesBetween(b, a));
      expect(milesBetween(a, b)).toBeGreaterThanOrEqual(0);
      expect(milesBetween(a, c)).toBeLessThanOrEqual(milesBetween(a, b) + milesBetween(b, c) + 1e-6);
    }), { numRuns: 500 });
  });

  it('stays a distance anywhere on Earth, to within five feet', () => {
    // Between two points on opposite sides of the globe the haversine formula loses its last digits:
    // up to about 0.0001 mi in 12,437. Nothing in the US is that far apart; the looser 0.001 covers it anyway.
    expect(milesBetween({ lat: 0, lng: 0 }, { lat: 0, lng: 180 })).toBeCloseTo(Math.PI * 3958.8, 3);
    fc.assert(fc.property(point, point, point, (a, b, c) => {
      expect(milesBetween(a, b)).toBeGreaterThanOrEqual(0);
      expect(milesBetween(a, b)).toBeLessThanOrEqual(Math.PI * 3958.8 + 1e-3);
      expect(milesBetween(a, c)).toBeLessThanOrEqual(milesBetween(a, b) + milesBetween(b, c) + 1e-3);
    }), { numRuns: 500 });
  });

  it('is never less than 69 mi per degree of latitude apart (what statesWithin uses to skip far ZIPs)', () => {
    fc.assert(fc.property(point, point, (a, b) => {
      expect(milesBetween(a, b)).toBeGreaterThanOrEqual(69 * Math.abs(a.lat - b.lat) - 1e-6);
    }));
  });
});

describe('lookupZip', () => {
  // [ZIP, city, state, a landmark in that ZIP's town]
  it.each<[string, string, string, number, number]>([
    ['10001', 'New York', 'NY', 40.7506, -73.9972],
    ['90210', 'Beverly Hills', 'CA', 34.0736, -118.4004],
    ['60601', 'Chicago', 'IL', 41.8853, -87.6216],
    ['77002', 'Houston', 'TX', 29.7589, -95.3677],
    ['33101', 'Miami', 'FL', 25.7743, -80.1937],
    ['98101', 'Seattle', 'WA', 47.6101, -122.3344],
    ['02108', 'Boston', 'MA', 42.3588, -71.0638],
    ['20500', 'Washington', 'DC', 38.8977, -77.0365],
    ['80202', 'Denver', 'CO', 39.7525, -104.9995],
    ['99501', 'Anchorage', 'AK', 61.2176, -149.8997],
    ['96813', 'Honolulu', 'HI', 21.3069, -157.8583],
    ['00601', 'Adjuntas', 'PR', 18.1627, -66.7222],
  ])('%s is %s, %s', (zip, city, state, lat, lng) => {
    const p = lookupZip(zip)!;
    expect(p).toMatchObject({ zip, city, state });
    expect(milesBetween(p, { lat, lng })).toBeLessThan(5);
  });

  it("knows the pilot's ZIP: 89410 is Gardnerville, NV", () => {
    const p = lookupZip('89410')!;
    expect(p).toMatchObject({ zip: '89410', city: 'Gardnerville', state: 'NV' });
    // The ZIP reaches well south-east of town, so its middle is a few miles from Main Street.
    expect(milesBetween(p, { lat: 38.9413, lng: -119.7499 })).toBeLessThan(12);
  });

  it('accepts ZIP+4 and stray spaces, and keeps leading zeros', () => {
    const base = lookupZip('89410');
    for (const form of ['89410-1234', '894101234', '89410 1234', ' 89410 ', '89410\n']) expect(lookupZip(form)).toEqual(base);
    expect(lookupZip('02108-3105')).toMatchObject({ zip: '02108', city: 'Boston', state: 'MA' });
    expect(lookupZip('2108')).toBeNull(); // four digits is not a ZIP — we do not guess the missing zero
  });

  it('knows PO-box and single-building ZIPs', () => {
    expect(lookupZip('89702')).toMatchObject({ city: 'Carson City', state: 'NV' }); // PO boxes
    expect(lookupZip('10008')).toMatchObject({ city: 'New York', state: 'NY' }); // PO boxes
    expect(lookupZip('00501')).toMatchObject({ city: 'Holtsville', state: 'NY' }); // IRS, the lowest ZIP there is
  });

  it('answers null for anything that is not a known US place', () => {
    for (const zip of ['00000', '99999', '', '8941', '894100', '89410-12', '89410-12345', 'abcde', 'eight9410', '８９４１０']) {
      expect(lookupZip(zip), zip).toBeNull();
    }
    expect(lookupZip('H2X')).toBeNull(); // Montréal: the table also carries Canada
    expect(lookupZip('09001')).toBeNull(); // APO AE: a mail route, not a place
    expect(lookupZip('96201')).toBeNull(); // APO AP
    expect(lookupZip('10200')).toBeNull(); // the table puts this New York ZIP at 73.95° EAST
  });

  it('covers every state, DC and Puerto Rico — and only real places on the US side of the globe', () => {
    const all = everyZip();
    expect(all.length).toBeGreaterThan(41_000);
    expect(all.length).toBeLessThan(Object.keys(pkg.codes).length);
    const states = new Set(all.map((p) => p.state));
    const fifty = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY';
    for (const st of [...fifty.split(' '), 'DC', 'PR']) expect(states.has(st), st).toBe(true);
    for (const st of ['AA', 'AE', 'AP']) expect(states.has(st), st).toBe(false);
    const wellFormed = (p: ZipPlace) => /^\d{5}$/.test(p.zip) && /^[A-Z]{2}$/.test(p.state) && p.city.length > 0;
    const onUsSoil = (p: ZipPlace) =>
      p.lat > -15 && p.lat < 72 // American Samoa … northern Alaska
      && (p.lng < -60 || p.lng > 130); // Palau … Virgin Islands, going east across the Pacific
    expect(all.filter((p) => !wellFormed(p) || !onUsSoil(p))).toEqual([]);
  });

  it('never throws, whatever is typed, and only ever answers with the ZIP that was asked for', () => {
    fc.assert(fc.property(anyText, (text) => {
      const p = lookupZip(text);
      if (p !== null) expect(text.trim().startsWith(p.zip)).toBe(true);
    }), { numRuns: 1000 });
    fc.assert(fc.property(fc.stringMatching(/^\d{5}(-\d{4})?$/), (zip) => {
      const p = lookupZip(zip);
      expect(p === null || p.zip === zip.slice(0, 5)).toBe(true);
      expect(lookupZip(zip.slice(0, 5))).toEqual(p);
    }), { numRuns: 1000 });
  });
});

describe('lookupCity', () => {
  const near = (p: LatLng | null, lat: number, lng: number, miles = 10) => {
    expect(p).not.toBeNull();
    expect(milesBetween(p!, { lat, lng })).toBeLessThan(miles);
  };

  it('finds a city in its state, whatever the capitals', () => {
    near(lookupCity('Boise', 'ID'), 43.615, -116.2023);
    expect(lookupCity('BOISE', 'id')).toEqual(lookupCity('Boise', 'ID'));
    expect(lookupCity('  boise ', ' Id ')).toEqual(lookupCity('Boise', 'ID'));
    expect(lookupCity('Boise', 'ID')).toMatchObject({ city: 'Boise', state: 'ID' });
  });

  it('reads "St." as Saint, "Ft." as Fort and "Mt." as Mount', () => {
    const stl = lookupCity('Saint Louis', 'MO');
    near(stl, 38.627, -90.1994);
    for (const name of ['St. Louis', 'St Louis', 'ST LOUIS', 'saint louis']) expect(lookupCity(name, 'MO')).toEqual(stl);
    near(lookupCity('St. Paul', 'MN'), 44.9537, -93.09);
    near(lookupCity('Port St. Lucie', 'FL'), 27.273, -80.3582);
    near(lookupCity('Sault Ste. Marie', 'MI'), 46.4953, -84.3453);
    expect(lookupCity('Ft. Worth', 'TX')).toEqual(lookupCity('Fort Worth', 'TX'));
    near(lookupCity('Ft Worth', 'TX'), 32.7555, -97.3308);
    expect(lookupCity('Mt. Vernon', 'WA')).toEqual(lookupCity('Mount Vernon', 'WA'));
    near(lookupCity('St. Thomas', 'VI'), 18.3419, -64.9307); // the table itself spells this one "St Thomas"
  });

  it('shrugs off punctuation, accents and spacing', () => {
    near(lookupCity("Coeur d'Alene", 'ID'), 47.6777, -116.7805);
    near(lookupCity('Winston-Salem', 'NC'), 36.0999, -80.2442);
    near(lookupCity('McLean', 'VA'), 38.9339, -77.1773);
    expect(lookupCity('Mc Lean', 'VA')).toEqual(lookupCity('McLean', 'VA'));
    expect(lookupCity('LaGrange', 'IL')).toEqual(lookupCity('La Grange', 'IL'));
    expect(lookupCity('Cañon City', 'CO')).toEqual(lookupCity('Canon City', 'CO'));
    near(lookupCity('JBPHH', 'HI'), 21.3445, -157.9748); // Pearl Harbor; the table spells it "J B P H H"
  });

  it('drops a state repeated after the city, but not a city that is named like a state', () => {
    const reno = lookupCity('Reno', 'NV');
    near(reno, 39.5296, -119.8138);
    for (const name of ['Reno, NV', 'Reno NV', 'Reno, Nevada', 'RENO, NEVADA']) expect(lookupCity(name, 'NV')).toEqual(reno);
    expect(lookupCity('Washington, District of Columbia', 'DC')).toEqual(lookupCity('Washington', 'DC'));
    expect(lookupCity('New York, New York', 'NY')).toEqual(lookupCity('New York', 'NY'));
    near(lookupCity('Nevada', 'MO'), 37.8392, -94.3547); // Nevada, Missouri is a town
    expect(lookupCity('Mid Florida', 'FL')).toMatchObject({ city: 'Mid Florida', state: 'FL' }); // a real postal name that ends in its state
    expect(lookupCity('Reno, CA', 'NV')).toBeNull(); // the wrong state is not waved through
  });

  it('keeps same-named cities in different states apart', () => {
    const ks = lookupCity('Kansas City, Kansas', 'KS')!;
    const mo = lookupCity('Kansas City', 'MO')!;
    expect(ks.state).toBe('KS');
    expect(mo.state).toBe('MO');
    expect(ks.lng).toBeLessThan(mo.lng); // Kansas is the western one
    near(lookupCity('Portland', 'OR'), 45.5152, -122.6784, 12);
    near(lookupCity('Portland', 'ME'), 43.6591, -70.2568, 12);
  });

  it('takes the state as a name too', () => {
    expect(lookupCity('Boise', 'Idaho')).toEqual(lookupCity('Boise', 'ID'));
    expect(lookupCity('Reno', 'nevada')).toEqual(lookupCity('Reno', 'NV'));
  });

  it("answers the middle of the city's ZIPs", () => {
    // Gardnerville has two ZIPs: 89410 and 89460.
    const [a, b] = [lookupZip('89410')!, lookupZip('89460')!];
    const mid = lookupCity('Gardnerville', 'NV')!;
    expect(mid.lat).toBeCloseTo((a.lat + b.lat) / 2, 3);
    expect(mid.lng).toBeCloseTo((a.lng + b.lng) / 2, 3);
    // A one-ZIP town is that ZIP.
    expect(lookupCity('Genoa', 'NV')).toMatchObject({ lat: lookupZip('89411')!.lat, lng: lookupZip('89411')!.lng });
    // New York has ~160 ZIPs; one bad row used to drag this 49 miles east.
    near(lookupCity('New York', 'NY'), 40.7549, -73.984, 3);
  });

  it('resolves every ZIP to its own city, never more than 45 mi from that city centre', () => {
    // 45 mi is the widest real spread in the table (Orlando's far-flung ZIPs are 40 mi out).
    const astray = everyZip().filter((p) => {
      const c = lookupCity(p.city, p.state);
      return !c || c.state !== p.state || milesBetween(c, p) >= 45;
    });
    expect(astray).toEqual([]);
  });

  it('answers null for places that do not exist', () => {
    expect(lookupCity('TEST Nowhereville', 'ZZ')).toBeNull();
    expect(lookupCity('TEST Nowhereville', 'TX')).toBeNull();
    expect(lookupCity('Reno', 'CA')).toBeNull();
    expect(lookupCity('Toronto', 'Ontario')).toBeNull();
    expect(lookupCity('Apo', 'AE')).toBeNull();
    expect(lookupCity('', 'NV')).toBeNull();
    expect(lookupCity('Reno', '')).toBeNull();
    expect(lookupCity('Reno', 'Nevadaa')).toBeNull();
  });

  it('hands out a copy, so a caller cannot move a city for everyone else', () => {
    lookupCity('Reno', 'NV')!.lat = 0;
    near(lookupCity('Reno', 'NV'), 39.5296, -119.8138);
  });

  it('never throws, whatever is typed', () => {
    fc.assert(fc.property(anyText, anyText, (city, state) => {
      const p = lookupCity(city, state);
      expect(p === null || /^[A-Z]{2}$/.test(p.state)).toBe(true);
    }), { numRuns: 1000 });
    fc.assert(fc.property(anyText, fc.constantFrom('NV', 'CA', 'TX', 'NY', 'Nevada'), (city, state) => {
      lookupCity(city, state);
    }), { numRuns: 500 });
  });
});

describe('statesWithin', () => {
  const GARDNERVILLE = { lat: 38.9413, lng: -119.7499 };
  const BRADY_TX = { lat: 31.1352, lng: -99.3351 }; // the "Heart of Texas": the nearest other state is ~200 mi off

  it('sees both sides of the Nevada/California line', () => {
    expect(statesWithin(GARDNERVILLE, 90)).toEqual(['CA', 'NV']);
    expect(statesWithin({ lat: 38.9616, lng: -119.9399 }, 10)).toEqual(['CA', 'NV']); // Stateline
    expect(statesWithin({ lat: 39.5296, lng: -119.8138 }, 10)).toEqual(['NV']); // downtown Reno, small radius
  });

  it('stays inside a large state until the radius really reaches the next one', () => {
    expect(statesWithin(BRADY_TX, 100)).toEqual(['TX']);
    expect(statesWithin(BRADY_TX, 150)).toEqual(['TX']);
    expect(statesWithin(BRADY_TX, 300)).toEqual(['NM', 'OK', 'TX']);
  });

  it('finds all four states at Four Corners, and the island neighbours', () => {
    expect(statesWithin({ lat: 36.999, lng: -109.0452 }, 60)).toEqual(['AZ', 'CO', 'NM', 'UT']);
    expect(statesWithin({ lat: 39.0997, lng: -94.5786 }, 25)).toEqual(['KS', 'MO']); // Kansas City
    expect(statesWithin({ lat: 21.3069, lng: -157.8583 }, 50)).toEqual(['HI']); // Honolulu
    expect(statesWithin({ lat: 18.4655, lng: -66.1057 }, 120)).toEqual(['PR', 'VI']); // San Juan
  });

  it('counts US states only: Windsor and Vancouver are across the river, not in the list', () => {
    expect(statesWithin({ lat: 42.3314, lng: -83.0458 }, 30)).toEqual(['MI']); // Detroit
    expect(statesWithin({ lat: 48.9937, lng: -122.7471 }, 40)).toEqual(['WA']); // Blaine, on the BC border
  });

  it('includes a state whose nearest ZIP is due north or south, only just inside the radius', () => {
    // The hardest case for the latitude shortcut: stand 99.85% of the radius straight above or below
    // each state's last ZIP. That ZIP is in range, so the state must be listed.
    const DEGREE = 69.2; // miles per degree of latitude is 69.09, so radius / 69.2 degrees is just inside
    const all = everyZip();
    const missed: string[] = [];
    for (const state of new Set(all.map((p) => p.state))) {
      const own = all.filter((p) => p.state === state).sort((a, b) => a.lat - b.lat);
      const [south, north] = [own[0]!, own.at(-1)!];
      for (const r of [25, 100, 400]) {
        const above = { lat: north.lat + r / DEGREE, lng: north.lng };
        const below = { lat: south.lat - r / DEGREE, lng: south.lng };
        if (above.lat < 90 && !statesWithin(above, r).includes(state)) missed.push(`${state} from the north, ${r} mi`);
        if (!statesWithin(below, r).includes(state)) missed.push(`${state} from the south, ${r} mi`);
      }
    }
    expect(missed).toEqual([]);
  });

  it("always includes the home state when the centre is the contractor's own ZIP", () => {
    for (const zip of ['89410', '76102', '10001', '99501', '00601', '59601']) {
      const home = lookupZip(zip)!;
      expect(statesWithin(home, 0), zip).toEqual([home.state]);
      expect(statesWithin(home, 50), zip).toContain(home.state);
    }
  });

  it('answers an empty list for open ocean or a nonsense request', () => {
    expect(statesWithin({ lat: 35, lng: -40 }, 200)).toEqual([]); // mid-Atlantic
    expect(statesWithin(GARDNERVILLE, -1)).toEqual([]);
    expect(statesWithin(GARDNERVILLE, Number.NaN)).toEqual([]);
    expect(statesWithin({ lat: Number.NaN, lng: -119.75 }, 90)).toEqual([]);
    expect(statesWithin({ lat: 38.94, lng: Number.POSITIVE_INFINITY }, 90)).toEqual([]);
  });

  it('agrees with checking every ZIP one by one, for any point and radius', () => {
    const centre = fc.record({ lat: fc.double({ min: 15, max: 72, noNaN: true }), lng: fc.double({ min: -170, max: -60, noNaN: true }) });
    const radius = fc.oneof(fc.double({ min: 0, max: 150, noNaN: true }), fc.double({ min: 0, max: 3000, noNaN: true }));
    const all = everyZip();
    fc.assert(fc.property(centre, radius, (c, r) => {
      const slow = [...new Set(all.filter((p) => milesBetween(c, p) <= r).map((p) => p.state))].sort();
      expect(statesWithin(c, r)).toEqual(slow);
    }), { numRuns: 60 });
  });

  it('is quick enough to run inside a signup request', () => {
    statesWithin(GARDNERVILLE, 90); // table already loaded by the tests above; this warms the loop
    const started = performance.now();
    for (let i = 0; i < 50; i++) statesWithin({ lat: 30 + (i % 18), lng: -120 + i }, 50 + i * 10);
    // Measured at 1–4 ms a call; the budget is loose because other suites share this machine.
    expect((performance.now() - started) / 50).toBeLessThan(40);
  });
});

describe('locate — anywhere in the US', () => {
  type Pop = NonNullable<NonNullable<SamResponse['opportunitiesData']>[number]['placeOfPerformance']>;
  /** A synthetic notice shaped like SAM.gov's, through the real parser. */
  const samBid = (placeOfPerformance: Pop, title = 'TEST Replace Switchgear (synthetic notice)') =>
    parseSamResponse({ opportunitiesData: [{ noticeId: 'TEST-GEO-0001', title, placeOfPerformance }] })[0]!;
  const draft = (location: Parameters<typeof locate>[0]['location'], title = 'TEST job', agency: string | null = null) =>
    ({ title, description: null, agency, location });

  it('gives federal place data (city + state + ZIP) real coordinates', () => {
    const loc = locate(samBid({ city: { code: '27000', name: 'Fort Worth' }, state: { code: 'TX', name: 'Texas' }, zip: '76102' }));
    expect(loc).toMatchObject({ city: 'Fort Worth', state: 'TX', zip: '76102', precision: 'city', label: 'Fort Worth, TX' });
    expect(milesBetween({ lat: loc.lat!, lng: loc.lng! }, { lat: 32.7555, lng: -97.3308 })).toBeLessThan(5);
  });

  it('uses the ZIP when the city is a base name the table spells differently, and keeps ZIP+4 as given', () => {
    const loc = locate(samBid({ city: { name: 'Joint Base Pearl Harbor Hickam' }, state: { code: 'HI' }, zip: '96860-4549' }));
    expect(loc).toMatchObject({ state: 'HI', zip: '96860-4549', precision: 'city' });
    expect(milesBetween({ lat: loc.lat!, lng: loc.lng! }, { lat: 21.3445, lng: -157.9748 })).toBeLessThan(5);
  });

  it('resolves a city + state with no ZIP — no more "location not listed"', () => {
    for (const [city, state, lat, lng] of [['Boise', 'ID', 43.615, -116.2023], ['ST. LOUIS', 'MO', 38.627, -90.1994], ['Jackson', 'MS', 32.2988, -90.1848]] as const) {
      const loc = locate(samBid({ city: { name: city }, state: { code: state } }));
      expect(loc.precision, city).toBe('city');
      expect(loc.label, city).not.toMatch(/not listed/);
      expect(loc.state).toBe(state);
      expect(milesBetween({ lat: loc.lat!, lng: loc.lng! }, { lat, lng }), city).toBeLessThan(10);
    }
    expect(locate(draft({ city: 'Jackson', state: 'MS' })).label).toBe('Jackson, MS'); // not the gazetteer's Jackson, CA
  });

  it('lets a contractor far from Nevada get a real distance to a bid', () => {
    const base = lookupZip('76102')!; // Fort Worth
    const dallas = locate(samBid({ city: { name: 'Dallas' }, state: { code: 'TX' }, zip: '75201' }));
    const d = milesBetween(base, { lat: dallas.lat!, lng: dallas.lng! });
    expect(d).toBeGreaterThan(26);
    expect(d).toBeLessThan(34);
  });

  it('ignores a ZIP that sits in a different state than the bid says', () => {
    // 89410 is an exact gazetteer ZIP, so use one that is not: 83702 is Boise, ID.
    expect(locate(draft({ city: 'Houston', state: 'TX', zip: '83702' }))).toMatchObject({ city: 'Houston', state: 'TX', precision: 'city' });
    expect(locate(draft({ state: 'TX', zip: '83702' }))).toMatchObject({ precision: 'state', lat: null, label: 'TX (location not listed)' });
    expect(locate(draft({ zip: '83702' }))).toMatchObject({ city: 'Boise', state: 'ID', precision: 'city' }); // no state to contradict it
  });

  it('still says so when a place cannot be resolved', () => {
    expect(locate(draft({ city: 'TEST Nowhereville', state: 'TX' }))).toMatchObject({ precision: 'state', lat: null, label: 'TX (location not listed)' });
    expect(locate(draft({ city: 'TEST Nowhereville' }))).toMatchObject({ precision: 'unknown', lat: null, label: null });
    expect(locate(draft({ city: 'Boise' }))).toMatchObject({ precision: 'unknown', lat: null }); // a city name alone could be in any state
  });

  it('never reads a US city out of free text', () => {
    const loc = locate(draft({ state: 'IL' }, 'TEST Chicago Avenue lighting retrofit, Springfield depot'));
    expect(loc).toMatchObject({ precision: 'state', lat: null, label: 'IL (location not listed)' });
  });

  it('keeps gazetteer guesses out of other states: "Dayton" in an Ohio bid is not Dayton, NV', () => {
    expect(locate(draft({ state: 'OH' }, 'TEST Dayton Street Lighting'))).toMatchObject({ precision: 'state', label: 'OH (location not listed)' });
    expect(locate(draft({ state: 'GA' }, 'TEST Courthouse lighting', 'Douglas County'))).toMatchObject({ precision: 'state', lat: null });
    expect(locate(draft({ state: 'OR' }, 'TEST Lake Tahoe conference travel'))).toMatchObject({ precision: 'state', lat: null });
    // On home turf, and when no state is given, those guesses work as before.
    expect(locate(draft({ state: 'NV' }, 'TEST Dayton Street Lighting'))).toMatchObject({ city: 'Dayton', state: 'NV', precision: 'city' });
    expect(locate(draft({}, 'TEST Dayton Street Lighting'))).toMatchObject({ city: 'Dayton', state: 'NV', precision: 'city' });
    expect(locate(draft({ state: 'NV' }, 'TEST Courthouse lighting', 'Douglas County'))).toMatchObject({ city: 'Minden', precision: 'agency' });
    expect(locate(draft({ state: 'CA' }, 'TEST Lake Tahoe trail lighting'))).toMatchObject({ precision: 'region', label: 'Lake Tahoe' });
  });
});

describe('locate — Northern Nevada gazetteer still comes first', () => {
  const at = (location: Parameters<typeof locate>[0]['location']) => locate({ title: 'TEST job', description: null, agency: null, location });
  const CARSON = { city: 'Carson City', county: 'Carson City', state: 'NV', lat: 39.1638, lng: -119.7674, precision: 'city', label: 'Carson City, NV' };
  const RENO = { city: 'Reno', county: 'Washoe', state: 'NV', lat: 39.5296, lng: -119.8138, precision: 'city', label: 'Reno, NV' };
  const VEGAS = { city: 'Las Vegas', county: 'Clark', state: 'NV', lat: 36.1699, lng: -115.1398, precision: 'city', label: 'Las Vegas, NV' };

  it('a named gazetteer town keeps its hand-checked centre, whatever ZIP comes with it', () => {
    expect(at({ city: 'Carson City', state: 'NV', zip: '89701' })).toEqual({ ...CARSON, zip: '89701' });
    expect(at({ city: 'Las Vegas', state: 'NV', zip: '89191' })).toEqual({ ...VEGAS, zip: '89191' });
    expect(at({ city: 'Reno', state: 'NV', zip: '89502' })).toEqual({ ...RENO, zip: '89502' });
    expect(at({ city: 'Carson Cit', state: 'NV' })).toEqual({ ...CARSON, zip: null }); // truncated by the board
  });

  it('the exact ZIPs near home keep their gazetteer town', () => {
    expect(at({ zip: '89410' })).toMatchObject({ city: 'Gardnerville', county: 'Douglas', lat: 38.9413, lng: -119.7499 });
    expect(at({ zip: '89460' })).toMatchObject({ city: 'Gardnerville Ranchos', lat: 38.8885, lng: -119.7413 });
    expect(at({ zip: '89423-1234', state: 'NV' })).toMatchObject({ city: 'Minden', zip: '89423-1234' });
    expect(at({ zip: '96150', state: 'NV' })).toMatchObject({ city: 'South Lake Tahoe', state: 'CA' });
  });

  it('a ZIP of a gazetteer town lands on that same centre, with its county', () => {
    expect(at({ zip: '89502', state: 'NV' })).toEqual({ ...RENO, zip: '89502' });
    expect(at({ zip: '89701' })).toEqual({ ...CARSON, zip: '89701' });
    expect(at({ zip: '89101' })).toEqual({ ...VEGAS, zip: '89101' });
    expect(at({ zip: '89431' })).toMatchObject({ city: 'Sparks', county: 'Washoe', lat: 39.5349, lng: -119.7527 });
    expect(at({ city: 'Reno, NV', state: 'NV' })).toEqual({ ...RENO, zip: null });
  });

  it('a metro prefix no longer overrules a ZIP the table knows exactly', () => {
    // "890" used to mean Las Vegas for all of these.
    expect(at({ zip: '89018', state: 'NV' })).toMatchObject({ city: 'Indian Springs', state: 'NV', label: 'Indian Springs, NV' }); // Creech AFB, 45 mi out
    expect(at({ zip: '89049' })).toMatchObject({ city: 'Tonopah', county: 'Nye', lat: 38.0671, lng: -117.2301 });
    expect(at({ zip: '89029' })).toMatchObject({ city: 'Laughlin', county: 'Clark' });
    expect(at({ city: 'Alamo', state: 'NV', zip: '89001' })).toMatchObject({ city: 'Alamo', label: 'Alamo, NV' });
    expect(at({ zip: '89704' })).toMatchObject({ city: 'Washoe Valley', county: 'Washoe' }); // "897" used to say Carson City
  });

  it('the prefix is still the fallback for a ZIP newer than the table', () => {
    expect(lookupZip('89500')).toBeNull();
    expect(at({ zip: '89500' })).toEqual({ ...RENO, zip: '89500' });
    expect(lookupZip('89100')).toBeNull();
    expect(at({ zip: '89100', state: 'NV' })).toEqual({ ...VEGAS, zip: '89100' });
  });

  it('a town the gazetteer lacks beats the county seat, a truncated one does not', () => {
    expect(at({ city: 'Round Mountain', county: 'Nye', state: 'NV' })).toMatchObject({ city: 'Round Mountain', precision: 'city' });
    expect(at({ city: 'Round Mounta', county: 'Nye', state: 'NV' })).toMatchObject({ precision: 'county', label: 'Nye County, NV' });
  });
});
