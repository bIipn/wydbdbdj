import type { Source } from '../types.js';
import { douglasCountySource } from './douglascounty.js';
import { fixtureSources } from './fixtures.js';
import { nevadaEproSource } from './nevadaepro.js';
import { ngemSource } from './ngem.js';
import { questcdnSource } from './questcdn.js';
import { samgovSource } from './samgov.js';
import { bidBuySource, commbuysSource, njstartSource, oregonBuysSource } from './buyspeed.js';
import { caleprocureSource } from './caleprocure.js';
import { caltransSource } from './caltrans.js';
import { flmfmpSource } from './flmfmp.js';
import { laRampSource } from './laramp.js';
import { nycRecordSource } from './nycrecord.js';
import { openGovSource } from './opengov.js';
import { sfBidsSource } from './sfbids.js';
import { txesbdSource } from './txesbd.js';
import { usac470Source } from './usac470.js';

/**
 * Every bid board, ONE list: the scan, the feed's ?source= filter (src/routes/feed.ts) and the scan groups
 * (src/sources/groups.ts) all read it. The web client's names for them are in web/js/source-labels.js
 * (test/source-seams.test.ts keeps the two equal). Each source says which scan group it runs in (Source.group).
 */
export const ALL_SOURCES: Source[] = [
  // The default group: the original daily scan.
  douglasCountySource, questcdnSource, ngemSource, nevadaEproSource, samgovSource,
  // Wave 2 (2026-11-14): state and city boards, in their own groups.
  caleprocureSource, caltransSource, laRampSource, sfBidsSource, oregonBuysSource, usac470Source,
  // COMMBUYS last in its group: a group's sources run in this order and each gets a fair share of the time left
  // (runScan), so the last one inherits what the quick ones leave. Live 2026-11-14 it took 152.6 s for 36 pages.
  bidBuySource, njstartSource, nycRecordSource, commbuysSource,
  txesbdSource, flmfmpSource,
  openGovSource,
];

/**
 * `SOURCES=ngem,questcdn` limits a run; blank means all. `SOURCES=fixtures` is the offline mode:
 * every scan replays the real pages captured in test/fixtures and nothing touches the network.
 */
export function selectSources(list?: string): Source[] {
  if (!list) return ALL_SOURCES;
  const wanted = new Set(list.split(',').map((s) => s.trim().toLowerCase()));
  if (wanted.has('fixtures')) return fixtureSources();
  return ALL_SOURCES.filter((s) => wanted.has(s.id));
}
