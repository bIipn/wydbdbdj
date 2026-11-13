/**
 * Areas the market data is published for.
 *
 * States: USPS code, 2-digit FIPS code and name for the 50 states and DC. The FIPS code is what
 * BLS puts in an OEWS state series id (NV = 32, CA = 06, TX = 48 ran live on 2026-11-13).
 *
 * OEWS areas below state level: ONLY the ones the research brief lists as checked against
 * api.bls.gov. There is no ZIP → OEWS-area table yet (it has to be built from the BLS area
 * definitions file), so nothing here maps a ZIP or county to one of these areas.
 */
export interface StateInfo {
  code: string; // USPS, e.g. "NV"
  fips: string; // 2 digits, e.g. "32"
  name: string;
}

export const STATES: readonly StateInfo[] = [
  { code: 'AL', fips: '01', name: 'Alabama' }, { code: 'AK', fips: '02', name: 'Alaska' },
  { code: 'AZ', fips: '04', name: 'Arizona' }, { code: 'AR', fips: '05', name: 'Arkansas' },
  { code: 'CA', fips: '06', name: 'California' }, { code: 'CO', fips: '08', name: 'Colorado' },
  { code: 'CT', fips: '09', name: 'Connecticut' }, { code: 'DE', fips: '10', name: 'Delaware' },
  { code: 'DC', fips: '11', name: 'District of Columbia' }, { code: 'FL', fips: '12', name: 'Florida' },
  { code: 'GA', fips: '13', name: 'Georgia' }, { code: 'HI', fips: '15', name: 'Hawaii' },
  { code: 'ID', fips: '16', name: 'Idaho' }, { code: 'IL', fips: '17', name: 'Illinois' },
  { code: 'IN', fips: '18', name: 'Indiana' }, { code: 'IA', fips: '19', name: 'Iowa' },
  { code: 'KS', fips: '20', name: 'Kansas' }, { code: 'KY', fips: '21', name: 'Kentucky' },
  { code: 'LA', fips: '22', name: 'Louisiana' }, { code: 'ME', fips: '23', name: 'Maine' },
  { code: 'MD', fips: '24', name: 'Maryland' }, { code: 'MA', fips: '25', name: 'Massachusetts' },
  { code: 'MI', fips: '26', name: 'Michigan' }, { code: 'MN', fips: '27', name: 'Minnesota' },
  { code: 'MS', fips: '28', name: 'Mississippi' }, { code: 'MO', fips: '29', name: 'Missouri' },
  { code: 'MT', fips: '30', name: 'Montana' }, { code: 'NE', fips: '31', name: 'Nebraska' },
  { code: 'NV', fips: '32', name: 'Nevada' }, { code: 'NH', fips: '33', name: 'New Hampshire' },
  { code: 'NJ', fips: '34', name: 'New Jersey' }, { code: 'NM', fips: '35', name: 'New Mexico' },
  { code: 'NY', fips: '36', name: 'New York' }, { code: 'NC', fips: '37', name: 'North Carolina' },
  { code: 'ND', fips: '38', name: 'North Dakota' }, { code: 'OH', fips: '39', name: 'Ohio' },
  { code: 'OK', fips: '40', name: 'Oklahoma' }, { code: 'OR', fips: '41', name: 'Oregon' },
  { code: 'PA', fips: '42', name: 'Pennsylvania' }, { code: 'RI', fips: '44', name: 'Rhode Island' },
  { code: 'SC', fips: '45', name: 'South Carolina' }, { code: 'SD', fips: '46', name: 'South Dakota' },
  { code: 'TN', fips: '47', name: 'Tennessee' }, { code: 'TX', fips: '48', name: 'Texas' },
  { code: 'UT', fips: '49', name: 'Utah' }, { code: 'VT', fips: '50', name: 'Vermont' },
  { code: 'VA', fips: '51', name: 'Virginia' }, { code: 'WA', fips: '53', name: 'Washington' },
  { code: 'WV', fips: '54', name: 'West Virginia' }, { code: 'WI', fips: '55', name: 'Wisconsin' },
  { code: 'WY', fips: '56', name: 'Wyoming' },
];

const BY_CODE = new Map(STATES.map((s) => [s.code, s]));

/** The state for a USPS code in any letter case, or null. */
export function stateInfo(code: string | null | undefined): StateInfo | null {
  return (code && BY_CODE.get(code.trim().toUpperCase())) || null;
}

export function isStateCode(code: string): boolean {
  return BY_CODE.has(code);
}

/** One area BLS publishes OEWS wages for. `areaCode` is the 7-character code inside the series id. */
export interface OewsArea {
  level: 'nation' | 'state' | 'metro' | 'nonmetro';
  /** N national, S state, M metropolitan or nonmetropolitan area. */
  areaType: 'N' | 'S' | 'M';
  areaCode: string;
  name: string;
  /** State the area is listed under (2-letter). null for the nation. */
  state: string | null;
  /** 5-digit CBSA code, metros only. */
  cbsa: string | null;
}

export const NATION_AREA: OewsArea = { level: 'nation', areaType: 'N', areaCode: '0000000', name: 'United States', state: null, cbsa: null };

export function stateArea(code: string): OewsArea | null {
  const s = stateInfo(code);
  return s ? { level: 'state', areaType: 'S', areaCode: `${s.fips}00000`, name: s.name, state: s.code, cbsa: null } : null;
}

/** Area code for a metro: "00" + the 5-digit CBSA code. */
export function metroAreaCode(cbsa: string): string {
  if (!/^\d{5}$/.test(cbsa)) throw new Error(`CBSA code must be 5 digits, got "${cbsa}"`);
  return `00${cbsa}`;
}

/**
 * Metro and nonmetro areas whose series returned data from api.bls.gov on 2026-11-13
 * (research brief 2.2). Names are the BLS area names where the brief gives them.
 */
export const VERIFIED_OEWS_AREAS: readonly OewsArea[] = [
  { level: 'metro', areaType: 'M', areaCode: '0039900', name: 'Reno, NV', state: 'NV', cbsa: '39900' },
  { level: 'metro', areaType: 'M', areaCode: '0029820', name: 'Las Vegas-Henderson-North Las Vegas, NV', state: 'NV', cbsa: '29820' },
  { level: 'metro', areaType: 'M', areaCode: '0016180', name: 'Carson City, NV', state: 'NV', cbsa: '16180' },
  { level: 'nonmetro', areaType: 'M', areaCode: '3200006', name: 'Balance of Nevada nonmetropolitan area', state: 'NV', cbsa: null },
  { level: 'metro', areaType: 'M', areaCode: '0040900', name: 'Sacramento-Roseville-Folsom, CA', state: 'CA', cbsa: '40900' },
  { level: 'metro', areaType: 'M', areaCode: '0035620', name: 'New York metro area', state: 'NY', cbsa: '35620' },
];

/** Every area the wage refresh asks BLS for: the nation, each state and DC, then the verified metros. */
export function oewsRefreshAreas(): OewsArea[] {
  return [NATION_AREA, ...STATES.map((s) => stateArea(s.code)!), ...VERIFIED_OEWS_AREAS];
}

/** A known area by its 7-character code (nation, any state, or a verified metro / nonmetro area). */
export function oewsAreaByCode(areaCode: string): OewsArea | null {
  return oewsRefreshAreas().find((a) => a.areaCode === areaCode) ?? null;
}
