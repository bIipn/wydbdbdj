import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BidDraft, Source, SourceId } from '../types.js';
import { parseDouglasRfp } from './douglascounty.js';
import { parseNevadaEproOpenBids } from './nevadaepro.js';
import { parseNgemPage } from './ngem.js';
import { parseQuestJson, QUEST_BOARDS } from './questcdn.js';

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
 * The real responses captured in test/fixtures (raw server HTML/JSON, as the scanner receives them),
 * one reader per source. SAM.gov is not among them yet: its fixtures (samgov-*.json) are real responses too,
 * captured 2026-11-13, but trimmed, and they reach back 60 days, so most of their notices are past due. They
 * are used by the parser and location tests.
 */
export function fixtureReaders(dir = resolve(process.cwd(), 'test/fixtures')): FixtureReader[] {
  const fx = (f: string) => readFileSync(resolve(dir, f), 'utf8');
  return [
    { id: 'douglascounty', name: 'Douglas County', read: () => parseDouglasRfp(fx('douglas-rfp.html'), { now: FIXTURES_CAPTURED_AT }) },
    { id: 'questcdn', name: 'QuestCDN', read: () => parseQuestJson(JSON.parse(fx('questcdn-spwd.json')), QUEST_BOARDS[0]!) },
    { id: 'ngem', name: 'NGEM', read: () => NGEM_PAGES.flatMap((f) => parseNgemPage(fx(f)).bids) },
    { id: 'nevadaepro', name: 'NevadaEPro', read: () => parseNevadaEproOpenBids(fx('nevadaepro-open-bids.html')) },
  ];
}

/** Offline sources: `npm run scan -- --fixtures` loads them so you can try the whole app with no network. */
export function fixtureSources(dir?: string): Source[] {
  return fixtureReaders(dir).map(({ id, name, read }) => ({ id, name: `${name} (snapshot)`, homepage: '', fetch: async () => read() }));
}
