import type { Source } from '../types.js';
import { douglasCountySource } from './douglascounty.js';
import { fixtureSources } from './fixtures.js';
import { nevadaEproSource } from './nevadaepro.js';
import { ngemSource } from './ngem.js';
import { questcdnSource } from './questcdn.js';
import { samgovSource } from './samgov.js';

export const ALL_SOURCES: Source[] = [douglasCountySource, questcdnSource, ngemSource, nevadaEproSource, samgovSource];

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
