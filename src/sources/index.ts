import type { Source, SourceId } from '../types.js';
import { douglasCountySource } from './douglascounty.js';
import { nevadaEproSource } from './nevadaepro.js';
import { ngemSource } from './ngem.js';
import { questcdnSource } from './questcdn.js';
import { samgovSource } from './samgov.js';

export const ALL_SOURCES: Source[] = [douglasCountySource, questcdnSource, ngemSource, nevadaEproSource, samgovSource];

/** `SOURCES=ngem,questcdn` limits a run; blank means all. */
export function selectSources(list?: string): Source[] {
  if (!list) return ALL_SOURCES;
  const wanted = new Set(list.split(',').map((s) => s.trim().toLowerCase()) as SourceId[]);
  return ALL_SOURCES.filter((s) => wanted.has(s.id));
}
