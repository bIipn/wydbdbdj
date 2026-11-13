/**
 * The market:refresh command line. The "stored" printout is checked against a database filled from
 * the REAL captured USAspending and BLS pages; nothing here touches the network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { describeStored, main, parseArgs } from '../src/cli/market.js';
import type { Db } from '../src/db/db.js';
import { refreshBls } from '../src/market/bls.js';
import { refreshAwards } from '../src/market/usaspending.js';
import type { FetchLike } from '../src/types.js';
import { fx, memoryDb } from './helpers.js';

const NOW = new Date('2026-11-13T03:00:00Z');
const capture = (file: string) => JSON.parse(fx(file)).response as Record<string, unknown>;

describe('market:refresh arguments', () => {
  it('takes --states and --months, with sensible defaults for the rest', () => {
    expect(parseArgs(['--states=nv,CA', '--months=24'])).toEqual({
      states: ['NV', 'CA'], months: 24, naics: ['238210', '238220', '236220'], awards: true, bls: true, details: 0,
      blsMaxQueries: undefined, userAgent: undefined, json: false,
    });
    expect(parseArgs(['--states=NV'])).toMatchObject({ states: ['NV'], months: 4 });
    expect(parseArgs(['--states=US', '--naics=238210', '--details=25', '--bls-max-queries=12', '--json', '--user-agent=TEST agent/1.0'])).toMatchObject({
      states: ['US'], naics: ['238210'], details: 25, blsMaxQueries: 12, json: true, userAgent: 'TEST agent/1.0',
    });
    expect(parseArgs(['--skip-awards'])).toMatchObject({ awards: false, bls: true, states: [] });
    expect(parseArgs(['--states=NV,NV', '--skip-bls'])).toMatchObject({ states: ['NV'], awards: true, bls: false });
  });

  it('explains what is wrong instead of guessing', () => {
    expect(() => parseArgs([])).toThrow(/--states is required/);
    expect(() => parseArgs(['--states=Nevada'])).toThrow(/not a 2-letter state code/);
    expect(() => parseArgs(['--states=NV', '--months=0'])).toThrow(/--months must be a whole number from 1 to 120/);
    expect(() => parseArgs(['--states=NV', '--months=two'])).toThrow(/--months/);
    expect(() => parseArgs(['--states=NV', '--naics=23'])).toThrow(/6-digit NAICS/);
    expect(() => parseArgs(['--states=NV', '--bls-max-queries=0'])).toThrow(/--bls-max-queries/);
    expect(() => parseArgs(['--states=NV', '--everything'])).toThrow(/Unknown option "--everything"/);
    expect(() => parseArgs(['NV'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['--skip-awards', '--skip-bls'])).toThrow(/Nothing to do/);
  });

  it('does nothing on import, and a bad command line exits with code 2 before any database or network use', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['--months=24'])).toBe(2);
      expect(err).toHaveBeenCalledWith(expect.stringContaining('--states is required'));
    } finally {
      err.mockRestore();
    }
  });
});

describe('what a refresh prints', () => {
  let db: Db;
  let awards: FetchLike;
  let bls: FetchLike;
  beforeAll(async () => {
    db = await memoryDb();
    awards = {
      text: async () => '',
      json: async <T>(url: string) => {
        // An award's own history (the one-by-one price lookup): nothing more known in this replay.
        if (url.endsWith('/api/v2/transactions/')) return { page_metadata: { page: 1, hasNext: false }, results: [] } as T;
        return capture(url.includes('_count') ? 'usaspending-award-count-nv-238210.json' : url.includes('transaction') ? 'usaspending-transactions-clark-238210.json' : 'usaspending-awards-nv-238210.json') as T;
      },
    };
    const series = new Map(['bls-oews-electricians.json', 'bls-oews-electricians-percentiles.json', 'bls-ppi-core.json']
      .flatMap((f) => (capture(f).Results as { series: Array<{ seriesID: string }> }).series.map((s) => [s.seriesID, s] as const)));
    bls = {
      text: async () => '',
      json: async <T>(_url: string, init?: RequestInit) => {
        const ids = (JSON.parse(String(init!.body)) as { seriesid: string[] }).seriesid;
        return { status: 'REQUEST_SUCCEEDED', message: [], Results: { series: ids.map((id) => series.get(id) ?? { seriesID: id, data: [] }) } } as T;
      },
    };
    await refreshAwards(db, awards, { naics: ['238210'], states: ['NV'], months: 24, now: NOW });
    await refreshBls(db, bls, { now: NOW });
  });
  afterAll(async () => db.close());

  it('counts by state, the price-at-award range with its N, wages with their period, and index changes', async () => {
    const text = (await describeStored(db, { states: ['NV', 'CA'], months: 24, naics: ['238210', '238220'] }, NOW)).join('\n');
    expect(text).toContain('NV  238210     36 awards,    27 with a price at award   signed 2024-11-14 to 2026-09-23');
    expect(text).toContain('Price at award (Mod 0 amount), awards signed 2024-11-13 to 2026-11-13. A range needs 10 priced awards.');
    expect(text).toContain('NV 238210  n=27  min 3,380.00 · p25 27,376.93 · median 53,488.85 · p75 97,782.99 · max 2,838,934.31   (9 without a price left out)');
    expect(text).toContain('NV 238220  n=0: not enough to show a range   (0 without a price left out)');
    expect(text).toContain('CA 238210  n=0: not enough to show a range');
    expect(text).toMatch(/Nevada\s+mean \$36\.40 · median \$35\.37 · p25 \$23\.52 · p75 \$46\.42 {3}\[state, May 2025\]/);
    expect(text).toMatch(/California\s+mean \$41\.28 · median \$36\.62 · p25 \$28\.50 · p75 \$49\.52 {3}\[state, May 2025\]/);
    expect(text).toMatch(/United States\s+mean \$34\.37 · median \$30\.38 · p25 n\/a · p75 n\/a {3}\[nation, May 2025\]/);
    expect(text).toMatch(/Reno, NV\s+mean \$35\.20/);
    expect(text).toMatch(/Copper wire and cable\s+607\.705 {2}Sep 2026 \(preliminary\) {3}1 mo \+0\.8% \(from Aug 2026\) · 3 mo \+5\.3% \(from Jun 2026\) · 12 mo \+30\.8% \(from Sep 2025\)/);
    expect(text).toContain('ppi   9 series (9 with data), 297 observations');
  });

  it('the command runs both pulls, prints the run and what is stored, and exits 0', async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
    try {
      expect(await main(['--states=NV', '--months=24', '--naics=238210'], { db, http: { awards, bls }, now: NOW })).toBe(0);
    } finally {
      log.mockRestore();
    }
    const text = lines.join('\n');
    expect(text).toContain('Federal awards pulled (signed 2024-11-13 to 2026-11-13; NAICS 238210; 12 requests)');
    expect(text).toMatch(/NV {2}ok {5}count endpoint 36 · fetched 36 in 1 page\(s\) · 38 transactions in 1 page\(s\) · price at award for 27 \(0 of 9 looked up one by one\), none for 9 · new 0, updated 36/);
    // The wage series stored by the earlier pull are still fresh, so only the price indexes come back with data.
    expect(text).toContain('BLS pulled (2024–2026): 9 queries · 213 series asked (28 wage series still fresh, left alone) · 9 stored · 297 observations');
    expect(text).toContain('NV 238210  n=27  min 3,380.00');
    expect(text).toMatch(/Copper wire and cable\s+607\.705/);
    // The database handed in stays open for the caller.
    expect(await db.query('select 1 as one')).toEqual([{ one: 1 }]);
  });

  it('exits 1 and names the failure when a source is down', async () => {
    const down: FetchLike = { text: async () => '', json: async () => { throw new Error('HTTP 503 for https://api.usaspending.gov/…'); } };
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
    try {
      expect(await main(['--states=NV', '--skip-bls'], { db, http: { awards: down, bls }, now: NOW })).toBe(1);
    } finally {
      log.mockRestore();
    }
    expect(lines.join('\n')).toMatch(/NV {2}FAILED .* HTTP 503/);
    expect(lines.join('\n')).toContain('ERROR awards NV: HTTP 503');
  });
});
