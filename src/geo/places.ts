/**
 * Small gazetteer for Northern Nevada, the Tahoe basin, and the far-away places
 * we need to recognize so we can say "too far". Coordinates are town centers.
 *
 * `scan: false` = don't look for this name inside free text (it's also a common
 * surname or word, e.g. "Jackson", "Henderson", "Austin").
 */
export interface Place {
  name: string;
  state: 'NV' | 'CA';
  county: string;
  lat: number;
  lng: number;
  aliases?: string[];
  scan?: boolean;
}

export const PLACES: Place[] = [
  // --- Douglas County, NV (L&M's home turf) ---
  { name: 'Gardnerville', state: 'NV', county: 'Douglas', lat: 38.9413, lng: -119.7499 },
  { name: 'Gardnerville Ranchos', state: 'NV', county: 'Douglas', lat: 38.8885, lng: -119.7413 },
  { name: 'Minden', state: 'NV', county: 'Douglas', lat: 38.9541, lng: -119.7657 },
  { name: 'Genoa', state: 'NV', county: 'Douglas', lat: 39.0041, lng: -119.8471 },
  { name: 'Johnson Lane', state: 'NV', county: 'Douglas', lat: 39.0477, lng: -119.7224 },
  { name: 'Indian Hills', state: 'NV', county: 'Douglas', lat: 39.0866, lng: -119.784 },
  { name: 'Stateline', state: 'NV', county: 'Douglas', lat: 38.9616, lng: -119.9399 },
  { name: 'Zephyr Cove', state: 'NV', county: 'Douglas', lat: 39.0063, lng: -119.9488 },
  { name: 'Glenbrook', state: 'NV', county: 'Douglas', lat: 39.0877, lng: -119.9399 },
  { name: 'Topaz Ranch Estates', state: 'NV', county: 'Douglas', lat: 38.735, lng: -119.5099, aliases: ['Topaz Lake'] },
  // --- Carson City / Lyon / Storey ---
  { name: 'Carson City', state: 'NV', county: 'Carson City', lat: 39.1638, lng: -119.7674, aliases: ['Stewart Facility', 'Carson'] },
  { name: 'Dayton', state: 'NV', county: 'Lyon', lat: 39.2371, lng: -119.5929 },
  { name: 'Mound House', state: 'NV', county: 'Lyon', lat: 39.2163, lng: -119.691 },
  { name: 'Silver Springs', state: 'NV', county: 'Lyon', lat: 39.4155, lng: -119.2246 },
  { name: 'Fernley', state: 'NV', county: 'Lyon', lat: 39.608, lng: -119.2518 },
  { name: 'Yerington', state: 'NV', county: 'Lyon', lat: 38.9858, lng: -119.1629 },
  { name: 'Smith Valley', state: 'NV', county: 'Lyon', lat: 38.79, lng: -119.33, aliases: ['Wellington'], scan: true },
  { name: 'Virginia City', state: 'NV', county: 'Storey', lat: 39.3096, lng: -119.6497 },
  { name: 'USA Parkway', state: 'NV', county: 'Storey', lat: 39.537, lng: -119.442, aliases: ['Tahoe Reno Industrial Center', 'TRIC'] },
  // --- Washoe ---
  { name: 'Reno', state: 'NV', county: 'Washoe', lat: 39.5296, lng: -119.8138 },
  { name: 'Sparks', state: 'NV', county: 'Washoe', lat: 39.5349, lng: -119.7527 },
  { name: 'Sun Valley', state: 'NV', county: 'Washoe', lat: 39.5963, lng: -119.776 },
  { name: 'Spanish Springs', state: 'NV', county: 'Washoe', lat: 39.6491, lng: -119.7074 },
  { name: 'Washoe Valley', state: 'NV', county: 'Washoe', lat: 39.2985, lng: -119.8077 },
  { name: 'Incline Village', state: 'NV', county: 'Washoe', lat: 39.2513, lng: -119.973 },
  { name: 'Crystal Bay', state: 'NV', county: 'Washoe', lat: 39.2266, lng: -120.0035 },
  { name: 'Verdi', state: 'NV', county: 'Washoe', lat: 39.5185, lng: -119.9888 },
  { name: 'Gerlach', state: 'NV', county: 'Washoe', lat: 40.6518, lng: -119.3554 },
  // --- Rest of NV (mostly "too far", but we must recognize them) ---
  { name: 'Fallon', state: 'NV', county: 'Churchill', lat: 39.4735, lng: -118.7774 },
  { name: 'Lovelock', state: 'NV', county: 'Pershing', lat: 40.1794, lng: -118.4735 },
  { name: 'Hawthorne', state: 'NV', county: 'Mineral', lat: 38.5246, lng: -118.6246 },
  { name: 'Tonopah', state: 'NV', county: 'Nye', lat: 38.0671, lng: -117.2301 },
  { name: 'Pahrump', state: 'NV', county: 'Nye', lat: 36.2083, lng: -115.9839 },
  { name: 'Winnemucca', state: 'NV', county: 'Humboldt', lat: 40.973, lng: -117.7357 },
  { name: 'Battle Mountain', state: 'NV', county: 'Lander', lat: 40.6421, lng: -116.9343 },
  { name: 'Austin', state: 'NV', county: 'Lander', lat: 39.4935, lng: -117.0698, scan: false },
  { name: 'Eureka', state: 'NV', county: 'Eureka', lat: 39.5127, lng: -115.9606, scan: false },
  { name: 'Elko', state: 'NV', county: 'Elko', lat: 40.8324, lng: -115.7631 },
  { name: 'Spring Creek', state: 'NV', county: 'Elko', lat: 40.7266, lng: -115.5859 },
  { name: 'Ely', state: 'NV', county: 'White Pine', lat: 39.2533, lng: -114.8742 },
  { name: 'Pioche', state: 'NV', county: 'Lincoln', lat: 37.9297, lng: -114.4522 },
  { name: 'Goldfield', state: 'NV', county: 'Esmeralda', lat: 37.7085, lng: -117.2356 },
  { name: 'Las Vegas', state: 'NV', county: 'Clark', lat: 36.1699, lng: -115.1398, aliases: ['Nellis'] },
  { name: 'North Las Vegas', state: 'NV', county: 'Clark', lat: 36.1989, lng: -115.1175 },
  { name: 'Henderson', state: 'NV', county: 'Clark', lat: 36.0395, lng: -114.9817, scan: false },
  { name: 'Boulder City', state: 'NV', county: 'Clark', lat: 35.9786, lng: -114.8325 },
  { name: 'Mesquite', state: 'NV', county: 'Clark', lat: 36.8055, lng: -114.0672 },
  { name: 'Laughlin', state: 'NV', county: 'Clark', lat: 35.1678, lng: -114.573 },
  // --- California side ---
  { name: 'South Lake Tahoe', state: 'CA', county: 'El Dorado', lat: 38.9399, lng: -119.9772 },
  { name: 'Meyers', state: 'CA', county: 'El Dorado', lat: 38.8566, lng: -120.013, scan: false },
  { name: 'Tahoe City', state: 'CA', county: 'Placer', lat: 39.1677, lng: -120.1452 },
  { name: 'Kings Beach', state: 'CA', county: 'Placer', lat: 39.2377, lng: -120.0266 },
  { name: 'Truckee', state: 'CA', county: 'Nevada', lat: 39.328, lng: -120.1833 },
  { name: 'Markleeville', state: 'CA', county: 'Alpine', lat: 38.6946, lng: -119.7802 },
  { name: 'Kirkwood', state: 'CA', county: 'Alpine', lat: 38.7024, lng: -120.071, scan: false },
  { name: 'Coleville', state: 'CA', county: 'Mono', lat: 38.5658, lng: -119.5055, aliases: ['Walker'], scan: false },
  { name: 'Bridgeport', state: 'CA', county: 'Mono', lat: 38.2557, lng: -119.2313 },
  { name: 'Mammoth Lakes', state: 'CA', county: 'Mono', lat: 37.6485, lng: -118.9721 },
  { name: 'Placerville', state: 'CA', county: 'El Dorado', lat: 38.7296, lng: -120.7985 },
  { name: 'Jackson', state: 'CA', county: 'Amador', lat: 38.3488, lng: -120.7741, scan: false },
  { name: 'Portola', state: 'CA', county: 'Plumas', lat: 39.8105, lng: -120.4691 },
  { name: 'Loyalton', state: 'CA', county: 'Sierra', lat: 39.6763, lng: -120.241 },
  { name: 'Susanville', state: 'CA', county: 'Lassen', lat: 40.4163, lng: -120.653 },
  { name: 'Auburn', state: 'CA', county: 'Placer', lat: 38.8966, lng: -121.0769, scan: false },
  { name: 'Sacramento', state: 'CA', county: 'Sacramento', lat: 38.5816, lng: -121.4944 },
];

/** County → the town we use as its point when the bid only names a county. */
export const COUNTY_SEATS: Record<string, string> = {
  'NV:douglas': 'Minden',
  'NV:carson city': 'Carson City',
  'NV:lyon': 'Yerington',
  'NV:storey': 'Virginia City',
  'NV:washoe': 'Reno',
  'NV:churchill': 'Fallon',
  'NV:pershing': 'Lovelock',
  'NV:mineral': 'Hawthorne',
  'NV:nye': 'Tonopah',
  'NV:humboldt': 'Winnemucca',
  'NV:lander': 'Battle Mountain',
  'NV:eureka': 'Eureka',
  'NV:elko': 'Elko',
  'NV:white pine': 'Ely',
  'NV:lincoln': 'Pioche',
  'NV:esmeralda': 'Goldfield',
  'NV:clark': 'Las Vegas',
  'CA:el dorado': 'Placerville',
  'CA:placer': 'Auburn',
  'CA:alpine': 'Markleeville',
  'CA:mono': 'Bridgeport',
  'CA:nevada': 'Truckee',
  'CA:sierra': 'Loyalton',
  'CA:plumas': 'Portola',
  'CA:lassen': 'Susanville',
  'CA:amador': 'Jackson',
  'CA:sacramento': 'Sacramento',
};

/**
 * Vague regional phrases that still tell us roughly where the work is. A region is never a town (city stays
 * null, precision 'region', and a distance to it reads "(approx.)"). Only a region small enough to measure
 * from gets a point. "Northern Nevada"
 * runs from Carson City (15 mi) to Elko (250 mi), so it has none: the bid stays in Nevada, distance unknown.
 */
export const REGIONS: Array<{ re: RegExp; label: string; state: 'NV' | 'CA'; lat?: number; lng?: number }> = [
  { re: /\bcarson valley\b/i, label: 'Carson Valley, NV', state: 'NV', lat: 38.95, lng: -119.76 },
  { re: /\bnorthern nevada\b|\bnorth(?:ern)? nv\b/i, label: 'Northern Nevada (approx.) — sites not listed', state: 'NV' },
  { re: /\b(?:lake )?tahoe(?: basin)?\b/i, label: 'Lake Tahoe', state: 'NV', lat: 39.05, lng: -119.98 },
  { re: /\btruckee meadows\b/i, label: 'Reno area, NV', state: 'NV', lat: 39.53, lng: -119.81 },
  { re: /\bsouthern nevada\b|\bsouth(?:ern)? nv\b/i, label: 'Southern Nevada', state: 'NV', lat: 36.17, lng: -115.14 },
];

/**
 * Agencies whose name tells us where they work. Checked after explicit fields, in order: the first row
 * whose agency pattern (and title pattern, when it has one) matches wins. A title pattern narrows a buyer
 * that serves several towns, e.g. BCN Purchasing buys for UNR and TMCC in Reno and for WNC in Carson City.
 */
export const AGENCY_PLACES: Array<{ re: RegExp; title?: RegExp; place: string }> = [
  { re: /douglas county|tahoe[- ]douglas|minden[- ]gardnerville|east fork/i, place: 'Minden' },
  { re: /carson city/i, place: 'Carson City' },
  // Western Nevada College's main campus is in Carson City (2201 W College Pkwy); its jobs say "WNC - …".
  { re: /bcn purchasing|business center north/i, title: /^\s*WNC\b|western nevada college/i, place: 'Carson City' },
  // The Office of the Adjutant General (OTAG) and Emergency Management (DEM) sit on Fairview Dr, Carson City.
  // Other Guard work ("Northern Nevada - HVAC Maintenance Services") is left to the region or the state.
  { re: /adjutant general/i, title: /\bOTAG\b|^\s*DEM\b|emergency management/i, place: 'Carson City' },
  { re: /reno[- ]tahoe airport|city of reno|washoe county|truckee meadows|\btmcc\b|\bunr\b|university of nevada,? reno|bcn purchasing|business center north/i, place: 'Reno' },
  { re: /city of sparks/i, place: 'Sparks' },
  { re: /lyon county/i, place: 'Yerington' },
  { re: /storey county/i, place: 'Virginia City' },
  { re: /churchill county/i, place: 'Fallon' },
  { re: /incline village/i, place: 'Incline Village' },
  { re: /south lake tahoe|lake tahoe unified/i, place: 'South Lake Tahoe' },
  { re: /north las vegas/i, place: 'North Las Vegas' },
  { re: /city of henderson/i, place: 'Henderson' },
  { re: /boulder city/i, place: 'Boulder City' },
  { re: /mesquite/i, place: 'Mesquite' },
  // University Medical Center is Clark County's public hospital, in Las Vegas.
  { re: /clark county|las vegas|\blvcva\b|\blvmpd\b|\bunlv\b|business center south|college of southern nevada|\bcsn\b|nellis|university medical center|\bumc\b/i, place: 'Las Vegas' },
  { re: /elko county|city of elko/i, place: 'Elko' },
];

/** Exact ZIPs near home, plus 3-digit prefixes for the big metros. */
export const ZIP_PLACES: Record<string, string> = {
  '89410': 'Gardnerville', '89460': 'Gardnerville Ranchos', '89423': 'Minden', '89411': 'Genoa',
  '89413': 'Glenbrook', '89448': 'Zephyr Cove', '89449': 'Stateline', '89403': 'Dayton',
  '89408': 'Fernley', '89406': 'Fallon', '89447': 'Yerington', '89429': 'Silver Springs',
  '89440': 'Virginia City', '89451': 'Incline Village', '89402': 'Crystal Bay', '89444': 'Smith Valley',
  '96150': 'South Lake Tahoe', '96151': 'South Lake Tahoe', '96155': 'South Lake Tahoe',
  '96161': 'Truckee', '96162': 'Truckee', '96145': 'Tahoe City', '96143': 'Kings Beach',
  '96120': 'Markleeville', '93517': 'Bridgeport', '95667': 'Placerville', '95642': 'Jackson',
  '897': 'Carson City', '895': 'Reno', '889': 'Las Vegas', '890': 'Las Vegas', '891': 'Las Vegas',
  '893': 'Ely', '898': 'Elko',
};
