/**
 * Caltrans is switched off (src/sources/caltrans.ts): its host's robots.txt disallows every path and the
 * advertised-projects page has no rows in its HTML. These tests keep it off and honest about why.
 * test/fixtures/caltrans-robots.txt = GET https://ppmoe.dot.ca.gov/robots.txt, raw, 2026-11-14 ~07:00 UTC.
 */
import { describe, expect, it, vi } from 'vitest';
import { caltransSource, CALTRANS_DISABLED } from '../src/sources/caltrans.js';
import { ALL_SOURCES } from '../src/sources/index.js';
import type { SourceContext } from '../src/types.js';
import { fx } from './helpers.js';

describe('caltrans (switched off)', () => {
  it('the saved robots.txt is the one the reason quotes', () => {
    const robots = fx('caltrans-robots.txt');
    expect(robots).toMatch(/^User-agent: \*\s+Disallow: \/\s*$/);
    expect(CALTRANS_DISABLED).toContain('"User-agent: * Disallow: /"');
  });

  it('is registered, in the west group, and says why it is off', () => {
    expect(ALL_SOURCES.find((s) => s.id === 'caltrans')).toBe(caltransSource);
    expect(caltransSource).toMatchObject({ group: 'west', states: ['CA'], timeZone: 'America/Los_Angeles' });
    expect(caltransSource.disabledReason?.({} as SourceContext)).toBe(CALTRANS_DISABLED);
  });

  it('fetch() fails loudly without making a request', async () => {
    const http = { text: vi.fn(), json: vi.fn() };
    await expect(caltransSource.fetch({ http } as unknown as SourceContext)).rejects.toThrow(/not built/);
    expect(http.text).not.toHaveBeenCalled();
    expect(http.json).not.toHaveBeenCalled();
  });
});
