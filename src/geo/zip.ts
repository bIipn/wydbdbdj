/**
 * ZIP → place, city + state → place, and which states a radius touches (onboarding).
 * Backed by the `zipcodes` package (typed in ./zipcodes.d.ts; import its default export).
 */
export interface ZipPlace {
  zip: string;
  city: string;
  state: string; // 2-letter
  lat: number;
  lng: number;
}

/** STUB (foundation): always null. */
export function lookupZip(_zip: string): ZipPlace | null {
  return null;
}

/** STUB (foundation): always null. */
export function lookupCity(_city: string, _state: string): { city: string; state: string; lat: number; lng: number } | null {
  return null;
}

/** 2-letter codes of every state with ground inside the circle (feeds Profile.states). STUB (foundation): always []. */
export function statesWithin(_center: { lat: number; lng: number }, _radiusMi: number): string[] {
  return [];
}
