import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BidDraft, Source, SourceId } from '../types.js';
import { parseDouglasRfp } from './douglascounty.js';
import { parseNevadaEproOpenBids } from './nevadaepro.js';
import { parseNgemPage } from './ngem.js';
import { parseQuestJson, QUEST_BOARDS } from './questcdn.js';
import { parseSamResponse, type SamResponse } from './samgov.js';
import { parseSamBulk } from './samgov-bulk.js';

/**
 * The day the pages in test/fixtures were fetched: 2026-11-13, noon Pacific (the QuestCDN JSON is
 * from 11-11). A saved page is read as of that day, not today: Douglas County's open/closed call
 * depends on the date, so with the real clock its open row would turn "closed" a week later and
 * silently drop out. Live scans are not affected (they pass ctx.now). Re-captured? Update this.
 */
export const FIXTURES_CAPTURED_AT = new Date('2026-11-13T20:00:00Z');

const NGEM_PAGES = ['ngem-page1.html', 'ngem-page2.html', 'ngem-page3.html'];

export interface FixtureReader {
  id: SourceId;
  name: string;
  /** Reads and parses the saved response(s). Nothing touches the disk before this is called. */
  read(): BidDraft[];
}

/**
 * The three SAM.gov responses captured 2026-11-13 04:01 UTC (real, trimmed: named contacts and links removed).
 * Opt-in only (FixtureOptions.samgov), so every existing count of "the fixture bids" stays what it was.
 */
export const SAMGOV_FIXTURES: readonly string[] = ['samgov-nv.json', 'samgov-ca-238210.json', 'samgov-ca-236220.json'];

/**
 * Whole rows cut, byte for byte, from SAM.gov's daily bulk file of 2026-11-13 (Last-Modified 04:30:18 UTC):
 * every Nevada construction notice, California and other samples, and rows that exercise each filter.
 * Read with the same opt-in as the API captures; a notice in both becomes one card (same samgov:<sol> id).
 */
export const SAMGOV_BULK_FIXTURE = 'samgov-bulk-sample.csv';

export interface FixtureOptions {
  /**
   * Add a reader for the real SAM.gov captures (test/fixtures/samgov-*.json and the bulk-file sample
   * samgov-bulk-sample.csv). Off by default. Their
   * notices reach back 60 days, so many are already past due on FIXTURES_CAPTURED_AT: the scan stores them
   * and the feed leaves the closed ones out, exactly as with a live scan. Used by `npm run simulate`.
   */
  samgov?: boolean;
}

/**
 * The real responses captured in test/fixtures (raw server HTML/JSON, as the scanner receives them),
 * one reader per source. SAM.gov is not among them unless `opts.samgov` asks for it: its fixtures
 * (samgov-*.json) are real responses too, captured 2026-11-13, but trimmed, and they reach back 60 days, so
 * many of their notices are past due. By default they are used only by the parser and location tests.
 */
export function fixtureReaders(dir = resolve(process.cwd(), 'test/fixtures'), opts: FixtureOptions = {}): FixtureReader[] {
  const fx = (f: string) => readFileSync(resolve(dir, f), 'utf8');
  const readers: FixtureReader[] = [
    { id: 'douglascounty', name: 'Douglas County', read: () => parseDouglasRfp(fx('douglas-rfp.html'), { now: FIXTURES_CAPTURED_AT }) },
    { id: 'questcdn', name: 'QuestCDN', read: () => parseQuestJson(JSON.parse(fx('questcdn-spwd.json')), QUEST_BOARDS[0]!) },
    { id: 'ngem', name: 'NGEM', read: () => NGEM_PAGES.flatMap((f) => parseNgemPage(fx(f)).bids) },
    { id: 'nevadaepro', name: 'NevadaEPro', read: () => parseNevadaEproOpenBids(fx('nevadaepro-open-bids.html')) },
  ];
  if (opts.samgov) {
    readers.push({
      id: 'samgov', name: 'SAM.gov',
      read: () => [
        ...SAMGOV_FIXTURES.flatMap((f) => parseSamResponse(JSON.parse(fx(f)) as SamResponse)),
        // As the live fetch reads it: notices already past due on the capture day are left out.
        ...parseSamBulk(readFileSync(resolve(dir, SAMGOV_BULK_FIXTURE)), { now: FIXTURES_CAPTURED_AT }).drafts,
      ],
    });
  }
  return readers;
}

/** Offline sources: `npm run scan -- --fixtures` loads them so you can try the whole app with no network. */
export function fixtureSources(dir?: string, opts: FixtureOptions = {}): Source[] {
  return fixtureReaders(dir, opts).map(({ id, name, read }) => ({ id, name: `${name} (snapshot)`, homepage: '', fetch: async () => read() }));
}
