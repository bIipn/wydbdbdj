import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/context.js';
import type { Db } from '../src/db/db.js';
import { loadProfile } from '../src/profiles.js';
import { runScan, shareDeadline, type ScanReport } from '../src/scan.js';
import { createScanRunner, scanEveryGroup, buildServer } from '../src/server.js';
import { outOfTime, stopAtBudget, timeLeftMs } from '../src/sources/budget.js';
import { DEFAULT_GROUP, FETCH_BUDGET_MS, SCAN_GROUPS, scanSources, sourcesForGroup } from '../src/sources/groups.js';
import { ALL_SOURCES } from '../src/sources/index.js';
import type { BidDraft, Source, SourceContext, SourceSlice } from '../src/types.js';
import { CAPTURED, memoryDb, resetDb, scanCtx } from './helpers.js';

// Scan groups and the per-source time budget: which sources a group runs, how a sliced source learns its
// slice, how a paging source stops at its deadline (and says so), and the routes that start a group.
// No network: the "boards" are fakes with synthetic TEST- drafts.

let seq = 0;
const draft = (source: BidDraft['source'], n = ++seq): BidDraft => ({
  source, sourceId: `TEST-${n}`, sourceName: 'TEST board (synthetic)', title: `TEST roof replacement ${n} (synthetic)`, agency: 'TEST agency',
  description: null, category: null, location: { state: 'CA' }, postedAt: null, dueAt: '2026-12-20T22:00:00.000Z', estValue: null,
  naics: null, setAside: null, url: 'https://example.com/test-bid',
});

/** A board of `pages` pages of 2 drafts that checks the budget between pages, the way a real pager must. */
function pager(id: BidDraft['source'], pages: number, group = 'east'): Source {
  return {
    id, name: `TEST ${id}`, homepage: 'https://example.com/', group,
    async fetch(ctx) {
      const out: BidDraft[] = [];
      for (let p = 1; p <= pages; p++) {
        if (p > 1 && outOfTime(ctx)) {
          stopAtBudget(ctx, id, out.length, pages * 2);
          break;
        }
        out.push(draft(id), draft(id));
      }
      return out;
    },
  };
}

describe('budget helpers', () => {
  it('no deadline = endless; a past deadline is out of time', () => {
    expect(timeLeftMs({})).toBe(Number.POSITIVE_INFINITY);
    expect(outOfTime({})).toBe(false);
    expect(outOfTime({ deadline: new Date(Date.now() - 1) })).toBe(true);
    expect(outOfTime({ deadline: new Date(Date.now() + 60_000) })).toBe(false);
    expect(outOfTime({ deadline: new Date(Date.now() + 60_000) }, 120_000)).toBe(true); // margin for one slow request
  });

  it('stopAtBudget logs the sentence and reports it', () => {
    const logs: string[] = [];
    const partial: string[] = [];
    expect(stopAtBudget({ log: (m) => logs.push(m), partial: (m) => partial.push(m) }, 'opengov', 40, 128, 'governments'))
      .toBe('opengov: stopped at the time budget, 40 of 128 governments read');
    expect(stopAtBudget({ log: (m) => logs.push(m) }, 'commbuys', 300, null)).toBe('commbuys: stopped at the time budget, 300 of ? read');
    expect(logs).toHaveLength(2);
    expect(partial).toEqual(['opengov: stopped at the time budget, 40 of 128 governments read']);
  });

  it('shareDeadline: an equal share of what is left, never in the past', () => {
    const now = 1_000_000;
    expect(shareDeadline(now + 200_000, 4, now).getTime()).toBe(now + 50_000);
    expect(shareDeadline(now + 200_000, 1, now).getTime()).toBe(now + 200_000);
    expect(shareDeadline(now - 5, 2, now).getTime()).toBe(now); // run already over: now, not earlier
    expect(shareDeadline(now + 100, 0, now).getTime()).toBe(now + 100);
  });
});

describe('which sources a group runs', () => {
  const plain = (id: BidDraft['source'], group?: string): Source => ({ id, name: id, homepage: 'https://example.com/', ...(group ? { group } : {}), fetch: async () => [] });
  const seen: Array<SourceSlice | undefined> = [];
  const sliced: Source = {
    id: 'opengov', name: 'TEST opengov', homepage: 'https://example.com/',
    slices: [{ group: 'opengov-1', states: ['CA'] }, { group: 'opengov-2', states: ['fl', 'NJ'] }, { group: 'opengov-5', states: 'rest' }],
    fetch: async (ctx) => { seen.push(ctx.slice); return []; },
  };
  const all = [plain('samgov'), plain('caleprocure', 'west'), plain('commbuys', 'east'), sliced];

  it('plain sources by their group (none = default); unknown group = null', () => {
    expect(sourcesForGroup('default', all)!.map((s) => s.id)).toEqual(['samgov']);
    expect(sourcesForGroup('west', all)!.map((s) => s.id)).toEqual(['caleprocure']);
    expect(sourcesForGroup('south', all)).toEqual([]);
    expect(sourcesForGroup('nope', all)).toBeNull();
  });

  it('a sliced source runs in each slice group, handed its slice on the context', async () => {
    const [one] = sourcesForGroup('opengov-1', all)!;
    const [two] = sourcesForGroup('opengov-2', all)!;
    const [rest] = sourcesForGroup('opengov-5', all)!;
    for (const s of [one, two, rest]) await s!.fetch(scanCtx());
    expect(seen.map((s) => s?.name)).toEqual(['opengov-1', 'opengov-2', 'opengov-5']);
    expect(seen[0]!.states).toEqual(['CA']);
    expect(seen[0]!.has('ca')).toBe(true);
    expect(seen[0]!.has('FL')).toBe(false);
    expect(seen[1]!.states).toEqual(['FL', 'NJ']);
    expect(seen[2]!.states).toBeNull(); // the rest
    expect([seen[2]!.has('WA'), seen[2]!.has(null), seen[2]!.has(''), seen[2]!.has('CA'), seen[2]!.has('nj')]).toEqual([true, true, true, false, false]);
    // Without a group the source runs whole: no slice.
    seen.length = 0;
    await sliced.fetch(scanCtx());
    expect(seen).toEqual([undefined]);
  });

  it('the real OpenGov source is in the five opengov groups and nowhere else', () => {
    const where = SCAN_GROUPS.filter((g) => sourcesForGroup(g.name)!.some((s) => s.id === 'opengov')).map((g) => g.name);
    expect(where).toEqual(['opengov-1', 'opengov-2', 'opengov-3', 'opengov-4', 'opengov-5']);
  });

  it('scanSources: no group = every source (or the list); a group cut down to the list; fixtures only in default', () => {
    expect(scanSources({})).toBe(ALL_SOURCES);
    expect(scanSources({ list: 'ngem' }).map((s) => s.id)).toEqual(['ngem']);
    expect(scanSources({ group: 'east' }).map((s) => s.id)).toEqual(['bidbuy', 'njstart', 'nycrecord', 'commbuys']);
    expect(scanSources({ group: 'default', list: 'samgov' }).map((s) => s.id)).toEqual(['samgov']); // a Vercel preview
    expect(scanSources({ group: 'west', list: 'samgov' })).toEqual([]);
    expect(scanSources({ group: 'default', list: 'fixtures' }).map((s) => s.id).sort()).toEqual(['douglascounty', 'nevadaepro', 'ngem', 'questcdn']);
    expect(scanSources({ group: 'east', list: 'fixtures' })).toEqual([]);
    expect(() => scanSources({ group: 'nope' })).toThrow('Unknown scan group "nope"');
  });
});

describe('runScan with a time budget', () => {
  let db: Db;
  beforeAll(async () => {
    db = await memoryDb();
  });
  beforeEach(async () => {
    await resetDb(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it('a pager past its deadline keeps its first page, stops, says so in the log and the report', async () => {
    const logs: string[] = [];
    const report = await runScan({
      db, sources: [pager('commbuys', 4)], profiles: [], ctx: scanCtx(CAPTURED, (m) => logs.push(m)), group: 'east', budgetMs: 0,
    });
    expect(report.group).toBe('east');
    expect(report.sources.commbuys).toMatchObject({ ok: true, fetched: 2, stopped: 'commbuys: stopped at the time budget, 2 of 8 read' });
    expect(logs).toContain('commbuys: stopped at the time budget, 2 of 8 read');
    expect(report.totalBids).toBe(2);
  });

  it('with time to spare every page is read, and nothing says "stopped"', async () => {
    const report = await runScan({ db, sources: [pager('bidbuy', 4)], profiles: [], ctx: scanCtx(), budgetMs: FETCH_BUDGET_MS });
    expect(report.sources.bidbuy).toEqual({ ok: true, fetched: 8, ms: expect.any(Number) });
  });

  it('no budget = no deadline on the context (a local full scan)', async () => {
    const deadlines: Array<Date | undefined> = [];
    const spy: Source = { id: 'njstart', name: 'TEST', homepage: 'https://example.com/', fetch: async (ctx) => { deadlines.push(ctx.deadline); return []; } };
    const report = await runScan({ db, sources: [spy], profiles: [], ctx: scanCtx() });
    expect(deadlines).toEqual([undefined]);
    expect(report.group).toBeUndefined();
  });

  it('each source gets a fair share of what is left; a broken source still never stops the scan', async () => {
    const got: Array<{ id: string; left: number }> = [];
    const spy = (id: BidDraft['source'], fail = false): Source => ({
      id, name: 'TEST', homepage: 'https://example.com/',
      fetch: async (ctx: SourceContext) => {
        got.push({ id, left: ctx.deadline!.getTime() - Date.now() });
        if (fail) throw new Error('TEST: board down');
        return [draft(id)];
      },
    });
    const report = await runScan({
      db, sources: [spy('caleprocure', true), spy('caltrans'), spy('laramp')], profiles: [], ctx: scanCtx(), budgetMs: 90_000,
    });
    expect(report.sources.caleprocure).toMatchObject({ ok: false, error: 'TEST: board down' });
    expect(report.sources.laramp).toMatchObject({ ok: true, fetched: 1 });
    // ~30 s, ~45 s (half of what is left), ~90 s (all of it); a little slack for the clock.
    expect(got.map((g) => g.id)).toEqual(['caleprocure', 'caltrans', 'laramp']);
    expect(got[0]!.left).toBeGreaterThan(29_000);
    expect(got[0]!.left).toBeLessThanOrEqual(30_000);
    expect(got[1]!.left).toBeGreaterThan(44_000);
    expect(got[2]!.left).toBeGreaterThan(89_000);
  });
});

describe('the scan runner and the routes', () => {
  const fakeReport = (group: string): ScanReport => ({ group, startedAt: 'a', finishedAt: 'b', sources: {}, totalBids: 0, newBids: 0, profiles: {} });

  it('runs one group at a time: the same group shares a run, another waits its turn', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const scan = (async ({ group }: { group?: string }) => {
      order.push(`start ${group}`);
      if (group === 'east') await gate;
      order.push(`end ${group}`);
      return fakeReport(group!);
    }) as unknown as typeof runScan;
    const deps = { db: null as never, profile: null, sourcesFor: () => [], makeCtx: () => scanCtx() };
    const run = createScanRunner(deps, { appUrl: '' }, undefined, scan);
    const a = run({ group: 'east' });
    const b = run({ group: 'EAST' });
    const c = run({ group: 'west' });
    const d = run(); // default
    await Promise.resolve();
    expect(order).toEqual(['start east']);
    release();
    const [ra, rb, rc, rd] = await Promise.all([a, b, c, d]);
    expect(ra).toBe(rb);
    expect([ra.group, rc.group, rd.group]).toEqual(['east', 'west', DEFAULT_GROUP]);
    expect(order).toEqual(['start east', 'end east', 'start west', 'end west', 'start default', 'end default']);
    await expect(run({ group: 'nope' })).rejects.toThrow('Unknown scan group "nope"');
  });

  it('a failed run does not block the next one', async () => {
    let n = 0;
    const scan = (async () => { if (n++ === 0) throw new Error('TEST: db down'); return fakeReport('default'); }) as unknown as typeof runScan;
    const run = createScanRunner({ db: null as never, profile: null, sourcesFor: () => [], makeCtx: () => scanCtx() }, { appUrl: '' }, undefined, scan);
    await expect(run()).rejects.toThrow('TEST: db down');
    await expect(run()).resolves.toMatchObject({ group: 'default' });
  });

  it('the daily schedule scans every group, the default last, and goes on past a failed one', async () => {
    const asked: string[] = [];
    const errors: string[] = [];
    await scanEveryGroup(async ({ group } = {}) => {
      asked.push(group!);
      if (group === 'south') throw new Error('TEST: south down');
      return fakeReport(group!);
    }, (m) => errors.push(m));
    expect(asked).toEqual([...SCAN_GROUPS.map((g) => g.name).filter((g) => g !== DEFAULT_GROUP), DEFAULT_GROUP]);
    expect(errors).toEqual(['[scan] group south failed: TEST: south down']);
  });

  describe('routes', () => {
    let db: Db;
    let app: FastifyInstance;
    const asked: Array<{ group?: string } | undefined> = [];
    const SECRET = 'TEST-cron-secret';
    beforeAll(async () => {
      db = await memoryDb();
      const scan = async (req?: { group?: string }) => { asked.push(req); return fakeReport(req?.group ?? 'default'); };
      app = await buildServer({ db, profile: loadProfile('lm-electric') }, { config: loadConfig({ CRON_SECRET: SECRET, ADMIN_TOKEN: 'TEST-admin' }), scan });
    });
    afterAll(async () => {
      await app.close();
      await db.close();
    });
    beforeEach(() => { asked.length = 0; });
    const auth = { authorization: `Bearer ${SECRET}` };

    it('GET /api/cron/scan?group=<name> scans that group; no group = the default, as before', async () => {
      expect((await app.inject({ url: '/api/cron/scan?group=opengov-3', headers: auth })).json()).toMatchObject({ group: 'opengov-3' });
      expect((await app.inject({ url: '/api/cron/scan?group=West', headers: auth })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/cron/scan', headers: auth })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/cron/scan?group=', headers: auth })).statusCode).toBe(200);
      expect(asked).toEqual([{ group: 'opengov-3' }, { group: 'west' }, {}, {}]);
    });

    it('an unknown group is a 400 that lists the groups, and nothing runs; the secret is still checked first', async () => {
      const res = await app.inject({ url: '/api/cron/scan?group=everything', headers: auth });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'unknown_group', groups: SCAN_GROUPS.map((g) => g.name) });
      expect((await app.inject({ url: '/api/cron/scan?group=west' })).statusCode).toBe(401);
      expect(asked).toEqual([]);
    });

    it('POST /api/admin/scan takes the same ?group=', async () => {
      const headers = { 'x-admin-token': 'TEST-admin', 'x-bidswipe': '1' };
      expect((await app.inject({ method: 'POST', url: '/api/admin/scan?group=south', headers })).json()).toMatchObject({ group: 'south' });
      expect((await app.inject({ method: 'POST', url: '/api/admin/scan?group=nope', headers })).statusCode).toBe(400);
      expect(asked).toEqual([{ group: 'south' }]);
    });
  });
});
