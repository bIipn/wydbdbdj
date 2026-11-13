import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Source } from '../types.js';
import { parseDouglasRfp } from './douglascounty.js';
import { parseNevadaEproOpenBids } from './nevadaepro.js';
import { parseNgemPage } from './ngem.js';
import { parseQuestJson, QUEST_BOARDS } from './questcdn.js';

/**
 * Offline sources backed by the real pages captured in test/fixtures (Nov 11, 2026).
 * `npm run scan -- --fixtures` loads them so you can try the whole app with no network.
 * (The SAM.gov fixture is synthetic test data, so it isn't included.)
 */
export function fixtureSources(dir = resolve(process.cwd(), 'test/fixtures')): Source[] {
  const fx = (f: string) => readFileSync(resolve(dir, f), 'utf8');
  return [
    { id: 'douglascounty', name: 'Douglas County (snapshot)', homepage: '', fetch: async () => parseDouglasRfp(fx('douglas-rfp.html')) },
    { id: 'questcdn', name: 'QuestCDN (snapshot)', homepage: '', fetch: async () => parseQuestJson(JSON.parse(fx('questcdn-spwd.json')), QUEST_BOARDS[0]!) },
    { id: 'ngem', name: 'NGEM (snapshot)', homepage: '', fetch: async () => parseNgemPage(fx('ngem-page1.html')).bids },
    { id: 'nevadaepro', name: 'NevadaEPro (snapshot)', homepage: '', fetch: async () => parseNevadaEproOpenBids(fx('nevadaepro-open-bids.html')) },
  ];
}
