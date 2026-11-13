/**
 * Prevailing wage hint when config/prevailing-wage/ cannot be read (a deploy without the folder).
 * The folder is made to look missing by a stand-in for readdirSync; bids here are synthetic (TEST).
 */
import { describe, expect, it, vi } from 'vitest';
import type { HintBid } from '../src/market/prevailing.js';
import type { BidLocation } from '../src/types.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readdirSync: () => {
    throw Object.assign(new Error("ENOENT: no such file or directory, scandir 'TEST/config/prevailing-wage/'"), { code: 'ENOENT' });
  },
}));

const { prevailingWageHint, prevailingWageTables } = await import('../src/market/prevailing.js');

const place = (state: string | null): BidLocation => ({ city: null, county: null, state, zip: null, lat: null, lng: null, precision: 'unknown', label: null });

describe('prevailingWageHint without the table folder', () => {
  it('still answers a federal bid: Davis-Bacon does not depend on a state file', () => {
    expect(() => prevailingWageTables()).toThrow(/ENOENT/);
    const federal = prevailingWageHint({ source: 'samgov', location: place('NV'), estValue: { min: 25_000, max: 100_000 }, naics: '238210', flags: [] }, undefined, '2026-11-13');
    expect(federal).toMatchObject({ basis: 'davis_bacon', applies: 'likely', headline: 'Davis-Bacon wages likely apply' });
    // A bid with no state has no table to look for either.
    expect(prevailingWageHint({ source: 'questcdn', location: place(null), estValue: null, naics: null, flags: [] }, undefined, '2026-11-13').basis).toBe('none');
  });

  it('fails loudly for a state bid: a missing or broken table must not read as "no table on file"', () => {
    const nevada: HintBid = { source: 'nevadaepro', location: place('NV'), estValue: null, naics: null, flags: [] };
    expect(() => prevailingWageHint(nevada, undefined, '2026-11-13')).toThrow(/ENOENT/);
    // Given the tables by the caller, nothing is read from disk.
    expect(prevailingWageHint(nevada, [], '2026-11-13')).toMatchObject({ basis: 'none', headline: 'No prevailing wage table on file for NV' });
  });
});
