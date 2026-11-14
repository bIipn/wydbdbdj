import type { SliceSpec, Source, SourceSlice } from '../types.js';
import { fixtureSources } from './fixtures.js';
import { ALL_SOURCES, selectSources } from './index.js';
import { DEFAULT_GROUP, getGroup, SCAN_GROUPS } from './scan-groups.js';

export { cronPath, DEFAULT_GROUP, FETCH_BUDGET_MS, getGroup, SCAN_GROUPS, type ScanGroup } from './scan-groups.js';

/** A source's slices, as declared (Source.slices), each turned into what the source sees at run time. */
export function resolveSlices(source: Pick<Source, 'slices'>): Array<{ group: string; slice: SourceSlice }> {
  const specs: readonly SliceSpec[] = source.slices ?? [];
  const listed = new Set(specs.flatMap((s) => (s.states === 'rest' ? [] : s.states.map((x) => x.toUpperCase()))));
  return specs.map((spec) => {
    const states = spec.states === 'rest' ? null : spec.states.map((x) => x.toUpperCase());
    const mine = states ? new Set(states) : null;
    return {
      group: spec.group,
      slice: {
        name: spec.group,
        states,
        // 'rest' takes every state no other slice lists, and records with no state at all.
        has: (state) => {
          const st = (state ?? '').trim().toUpperCase();
          return mine ? mine.has(st) : !listed.has(st);
        },
      },
    };
  });
}

/** The same source, with `slice` on every context it is handed. Same id, so the report keys stay the source's. */
export function withSlice(source: Source, slice: SourceSlice): Source {
  return { ...source, fetch: (ctx) => source.fetch({ ...ctx, slice }) };
}

/** The group a plain (unsliced) source runs in. */
export const groupOf = (source: Pick<Source, 'group'>): string => source.group ?? DEFAULT_GROUP;

/**
 * The sources one group runs, in ALL_SOURCES order: plain sources whose group it is, and each sliced source
 * once with its slice for that group. Null for a group that does not exist.
 */
export function sourcesForGroup(name: string, all: readonly Source[] = ALL_SOURCES): Source[] | null {
  const group = getGroup(name);
  if (!group) return null;
  const out: Source[] = [];
  for (const source of all) {
    if (source.slices?.length) {
      for (const { group: g, slice } of resolveSlices(source)) if (g === group.name) out.push(withSlice(source, slice));
    } else if (groupOf(source) === group.name) {
      out.push(source);
    }
  }
  return out;
}

/**
 * What one scan reads, for the CLI and the server.
 *  - no group: every source (or the SOURCES / --source list), unsliced, no budget: a local full scan;
 *  - a group: that group's sources, cut down to the list when one is given (Vercel previews set SOURCES=samgov).
 * `list` = the SOURCES setting or --source. 'fixtures' (offline) replays the saved pages: in the default group
 * only, since every saved page is from a default-group board.
 */
export function scanSources(opts: { group?: string | null; list?: string | null }, all: readonly Source[] = ALL_SOURCES): Source[] {
  const list = opts.list?.trim() || undefined;
  if (!opts.group) return selectSources(list);
  const inGroup = sourcesForGroup(opts.group, all);
  if (!inGroup) throw new Error(`Unknown scan group "${opts.group}" (groups: ${SCAN_GROUPS.map((g) => g.name).join(', ')})`);
  if (!list) return inGroup;
  const wanted = new Set(list.split(',').map((s) => s.trim().toLowerCase()));
  if (wanted.has('fixtures')) return getGroup(opts.group)!.name === DEFAULT_GROUP ? fixtureSources() : [];
  return inGroup.filter((s) => wanted.has(s.id));
}
