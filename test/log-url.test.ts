import { describe, expect, it } from 'vitest';
import { logUrl } from '../src/util/log-url.js';

describe('logUrl: what a request URL looks like in the server log', () => {
  it('drops the "Use my location" point entirely', () => {
    expect(logUrl('/api/geo/nearest-zip?lat=38.87&lng=-119.61')).toBe('/api/geo/nearest-zip?…');
  });
  it('hides a promo code, also one with a bare "&", and keeps the other keys', () => {
    expect(logUrl('/?promo=A%26Btest')).toBe('/?promo=…');
    expect(logUrl('/?promo=A&Btest&bid=x')).toBe('/?promo=…&bid=x');
    expect(logUrl('/?bid=x&promo=TEST-1')).toBe('/?bid=x&promo=…');
  });
  it('leaves everything else as it came', () => {
    expect(logUrl('/api/feed?all=1&minScore=0')).toBe('/api/feed?all=1&minScore=0');
    expect(logUrl('/api/geo/zip/89410')).toBe('/api/geo/zip/89410');
    expect(logUrl(undefined)).toBe('');
  });
});
