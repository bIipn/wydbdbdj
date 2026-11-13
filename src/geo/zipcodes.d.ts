/** The `zipcodes` package ships no types. CommonJS: import the default export. */
declare module 'zipcodes' {
  interface ZipCode {
    zip: string;
    latitude: number;
    longitude: number;
    city: string;
    state: string; // 2-letter (US states and Canadian provinces)
    country: string; // "US" | "Canada"
  }
  const zipcodes: {
    /** Every code keyed by ZIP (US) or 3-character prefix (Canada). */
    codes: Record<string, ZipCode>;
    states: { abbr: Record<string, string>; normalize(state: string): string };
    lookup(zip: string | number): ZipCode | undefined;
    lookupByName(city: string, state: string): ZipCode[];
    lookupByState(state: string): ZipCode[];
    lookupByCoords(lat: number, lng: number): ZipCode | null;
    /** Miles between two ZIPs, rounded; null when either is unknown. */
    distance(zipA: string | number, zipB: string | number): number | null;
    /** Scans every code — slow. */
    radius(zip: string | number, miles: number): string[];
    radius(zip: string | number, miles: number, full: true): ZipCode[];
  };
  export = zipcodes;
}
