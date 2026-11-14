import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUYSPEED_BOARDS, openBidsUrl } from '../src/sources/buyspeed.js';
import { cronPath, DEFAULT_GROUP, getGroup, groupOf, resolveSlices, SCAN_GROUPS, sourcesForGroup } from '../src/sources/groups.js';
import { ALL_SOURCES } from '../src/sources/index.js';
import { NEVADAEPRO_OPEN_BIDS, nevadaEproSource } from '../src/sources/nevadaepro.js';
import type { SourceId } from '../src/types.js';

// The one-list rule: a board is added in src/types.ts (SourceId), src/sources/<id>.ts, ALL_SOURCES, and one line in
// web/js/source-labels.js. Everything else (the feed's ?source= filter, Browse's chips, the scan groups, the cron
// entries) is driven from those lists, and these checks keep them in step.

const modulePath = '../web/js/source-labels.js'; // plain JS, no type declarations: a computed path keeps tsc quiet
const { SOURCE_LABELS, OWNER_FROM_SOURCE } = (await import(modulePath)) as {
  SOURCE_LABELS: Array<{ id: string; label: string; state: string; owner?: string }>;
  OWNER_FROM_SOURCE: Record<string, string>;
};

const WAVE2: SourceId[] = [
  'caleprocure', 'opengov', 'caltrans', 'oregonbuys', 'commbuys', 'bidbuy', 'njstart', 'txesbd', 'flmfmp', 'laramp',
  'sfbids', 'nycrecord', 'usac470',
];

const IANA = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

describe('sources: one list', () => {
  it('ALL_SOURCES holds every board once, the wave-2 boards included', () => {
    const ids = ALL_SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of WAVE2) expect(ids).toContain(id);
    expect(ids).not.toContain('local');
  });

  it('the web label table names exactly the same boards', () => {
    expect(SOURCE_LABELS.map((s) => s.id).sort()).toEqual(ALL_SOURCES.map((s) => s.id).sort());
    for (const s of SOURCE_LABELS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.state).toMatch(/^(US|[A-Z]{2})$/);
    }
    // The cost check's owner prefill keeps the two boards it had, from the same table.
    expect(OWNER_FROM_SOURCE).toMatchObject({ douglascounty: 'nv_local', samgov: 'federal' });
  });

  it('every source has a name, an https homepage, and well-formed states / time zone when it gives them', () => {
    for (const s of ALL_SOURCES) {
      expect(s.name, s.id).toMatch(/\S/);
      expect(s.homepage, s.id).toMatch(/^https:\/\//);
      if (s.states !== undefined && s.states !== 'US') for (const st of s.states) expect(st, s.id).toMatch(/^[A-Z]{2}$/);
      if (s.timeZone !== undefined) expect(IANA(s.timeZone), `${s.id}: ${s.timeZone}`).toBe(true);
    }
    for (const id of WAVE2) expect(ALL_SOURCES.find((s) => s.id === id)!.states, id).toBeDefined();
  });

  it('a source not built yet throws "not built yet" before any request (FAILED in the report, never a quiet 0)', async () => {
    for (const id of WAVE2) {
      let calls = 0;
      const no = async (): Promise<never> => { calls++; throw new Error('TEST: offline'); };
      const ctx = { http: { text: no, json: no }, now: new Date(), env: () => undefined, log: () => {} };
      const err = await ALL_SOURCES.find((x) => x.id === id)!.fetch(ctx).then(() => null, (e: Error) => e.message);
      if (err === 'not built yet') expect(calls, id).toBe(0);
    }
  });
});

describe('scan groups', () => {
  it('every source runs in a group that exists, exactly once per group', () => {
    const names = new Set(SCAN_GROUPS.map((g) => g.name));
    for (const s of ALL_SOURCES) {
      if (s.slices?.length) for (const sl of s.slices) expect(names.has(sl.group), `${s.id} slice ${sl.group}`).toBe(true);
      else expect(names.has(groupOf(s)), `${s.id} group ${groupOf(s)}`).toBe(true);
    }
    for (const g of SCAN_GROUPS) {
      const ids = sourcesForGroup(g.name)!.map((s) => s.id);
      expect(ids.length, g.name).toBeGreaterThan(0);
      expect(new Set(ids).size, `${g.name} lists a source twice`).toBe(ids.length);
    }
  });

  it("the default group is today's scan: the five original sources", () => {
    expect(sourcesForGroup(DEFAULT_GROUP)!.map((s) => s.id)).toEqual(['douglascounty', 'questcdn', 'ngem', 'nevadaepro', 'samgov']);
  });

  it('a sliced source has every state in at most one slice, and one "rest" slice', () => {
    for (const s of ALL_SOURCES.filter((x) => x.slices?.length)) {
      const listed = s.slices!.flatMap((sl) => (sl.states === 'rest' ? [] : [...sl.states]));
      expect(new Set(listed).size, s.id).toBe(listed.length);
      expect(s.slices!.filter((sl) => sl.states === 'rest'), s.id).toHaveLength(1);
      // Every state (and "no state") lands in exactly one slice.
      const slices = resolveSlices(s);
      for (const st of ['CA', 'FL', 'TX', 'WA', 'ZZ', null]) expect(slices.filter((x) => x.slice.has(st)), `${s.id} ${st}`).toHaveLength(1);
    }
  });

  it('vercel.json has one cron entry per group, at the group schedule, and keeps the other jobs', () => {
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as { crons: Array<{ path: string; schedule: string }> };
    const scans = vercel.crons.filter((c) => c.path.startsWith('/api/cron/scan'));
    expect(scans).toEqual(SCAN_GROUPS.map((g) => ({ path: cronPath(g), schedule: g.cron })));
    expect(vercel.crons.map((c) => c.path)).toEqual(expect.arrayContaining(['/api/cron/market', '/api/cron/scan', '/api/cron/tick']));
    expect(cronPath({ name: DEFAULT_GROUP })).toBe('/api/cron/scan'); // the original entry, unchanged
  });

  it('group schedules run in order from 13:20, at least five minutes apart, the default group last, before the 14:50 tick', () => {
    const minutes = SCAN_GROUPS.map((g) => {
      const [m, h] = g.cron.split(' ').map(Number);
      return h! * 60 + m!;
    });
    expect(minutes[0]).toBe(13 * 60 + 20);
    expect(SCAN_GROUPS.at(-1)!.name).toBe(DEFAULT_GROUP); // the digest and the day's re-score see every group's finds
    for (let i = 1; i < minutes.length; i++) expect(minutes[i]! - minutes[i - 1]!, SCAN_GROUPS[i]!.name).toBeGreaterThanOrEqual(5);
    expect(minutes.at(-1)!).toBeLessThan(14 * 60 + 50 - 5);
  });

  it('getGroup is exact apart from case and spaces', () => {
    expect(getGroup(' West ')?.name).toBe('west');
    expect(getGroup('nope')).toBeNull();
    expect(getGroup(undefined)).toBeNull();
  });
});

describe('BuySpeed board table', () => {
  it('NevadaEPro is one of its boards and keeps its old URL', () => {
    expect(NEVADAEPRO_OPEN_BIDS).toBe('https://nevadaepro.com/bso/view/search/external/advancedSearchBid.xhtml?openBids=true');
    expect(nevadaEproSource).toMatchObject({ id: 'nevadaepro', name: 'NevadaEPro (State Purchasing)', homepage: NEVADAEPRO_OPEN_BIDS, states: ['NV'] });
    expect(groupOf(nevadaEproSource)).toBe(DEFAULT_GROUP);
  });

  it('every board is a source in ALL_SOURCES, with its host, state and zone', () => {
    for (const b of BUYSPEED_BOARDS) {
      const s = ALL_SOURCES.find((x) => x.id === b.id)!;
      expect(s, b.id).toBeDefined();
      expect(s.homepage).toBe(openBidsUrl(b));
      expect(s.states).toEqual([b.state]);
      expect(s.timeZone).toBe(b.timeZone);
    }
  });
});
