import { describe, expect, it } from 'vitest';
import { finalizeBid } from '../src/scan.js';
import { resolveSlices } from '../src/sources/groups.js';
import {
  checkOpenGovAnswer, createOpenGovSource, MAX_FAILURES_IN_A_ROW, OPENGOV_GOVERNMENTS_URL, openGovBody, openGovProjectsUrl,
  openGovSource, parseOpenGovGovernments, parseOpenGovProjects, type OpenGovGovernment, type OpenGovProjectsAnswer,
} from '../src/sources/opengov.js';
import type { SourceContext, SourceSlice } from '../src/types.js';
import { fx } from './helpers.js';

// OpenGov Procurement, against REAL answers of api.procurement.opengov.com (test/fixtures/opengov.md):
//   opengov-governments.json         13 whole entries of GET /api/v1/government (2026-11-14 05:59 UTC)
//   opengov-projects-saccounty.json  POST …/government/saccounty/project/public, 11 open projects (06:26 UTC)
//   opengov-projects-lakeport.json   the same for cityoflakeport, 1 open project (06:27 UTC)
//   opengov-projects-empty.json      the same for cityofsanmarino, count 0 (06:27 UTC)
// Anything synthetic below says so (TEST- titles, ids from 900000).

const GOVS = JSON.parse(fx('opengov-governments.json')) as unknown[];
const SAC = JSON.parse(fx('opengov-projects-saccounty.json')) as OpenGovProjectsAnswer;
const LAKEPORT = JSON.parse(fx('opengov-projects-lakeport.json')) as OpenGovProjectsAnswer;
const EMPTY = JSON.parse(fx('opengov-projects-empty.json')) as OpenGovProjectsAnswer;

const SACRAMENTO: OpenGovGovernment = { code: 'saccounty', name: 'County of Sacramento', city: 'Sacramento', state: 'CA', timezone: 'America/Los_Angeles' };
const CA_SLICE: SourceSlice = resolveSlices(openGovSource).find((s) => s.group === 'opengov-1')!.slice;
const REST_SLICE: SourceSlice = resolveSlices(openGovSource).find((s) => s.group === 'opengov-5')!.slice;
const CA_CODES = ['cityoflakeport', 'cityofranchocordova', 'cityofsanmarino', 'cityofwestsacramento', 'gd-pud', 'saccounty', 'sjrtd'];

describe('parseOpenGovGovernments', () => {
  it('keeps active, real, placed governments, sorted by code', () => {
    const list = parseOpenGovGovernments(GOVS, undefined, 1);
    expect(list).toMatchObject({ listed: 13, inactive: 1, internal: 1, noState: 1, otherSlices: 0 });
    expect(list.governments.map((g) => g.code)).toEqual(['1gpa', 'alachuacounty', 'brazos-valley-tx', ...CA_CODES].sort());
    expect(list.governments.find((g) => g.code === 'saccounty')).toEqual(SACRAMENTO);
    expect(list.governments.find((g) => g.code === '1gpa')).toMatchObject({ city: 'Phoenix', state: 'AZ', timezone: 'America/Phoenix' });
  });

  it('leaves out an inactive government (a2trans), OpenGov\'s own demo portal and a test portal with no state', () => {
    const codes = parseOpenGovGovernments(GOVS, undefined, 1).governments.map((g) => g.code);
    expect(codes).not.toContain('a2trans');
    expect(codes).not.toContain('opengovdemo');
    expect(codes).not.toContain('cityofshenanigans-d94e72436019');
  });

  it('takes only its slice: California, or the "rest" (here none of AZ/FL/TX/CA)', () => {
    const ca = parseOpenGovGovernments(GOVS, CA_SLICE, 1);
    expect(ca.governments.map((g) => g.code)).toEqual(CA_CODES);
    expect(ca.otherSlices).toBe(3);
    expect(parseOpenGovGovernments(GOVS, REST_SLICE, 1).governments).toEqual([]);
  });

  it('throws on anything that is not the list we know', () => {
    expect(() => parseOpenGovGovernments(GOVS)).toThrow(/13 entries.*not the list we know/); // the trimmed fixture is too short
    expect(() => parseOpenGovGovernments({ error: 'x' })).toThrow(/not a JSON array/);
    expect(() => parseOpenGovGovernments('<html>Just a moment…</html>')).toThrow(/not a JSON array/);
    expect(() => parseOpenGovGovernments(GOVS.map(() => ({ name: 'x' })), undefined, 1)).toThrow(/0 with a code/);
  });

  it('a list that changed shape THROWS instead of filtering every government out (no quiet 0)', () => {
    // SYNTHETIC variations of the real 13 entries: the field renamed, or isActive written as 1
    const renamed = (GOVS as Array<Record<string, unknown>>).map(({ state, ...g }) => ({ ...g, stateCode: state }));
    expect(() => parseOpenGovGovernments(renamed, undefined, 1)).toThrow(/only 0 of 13 governments are active with a state/);
    const numeric = (GOVS as Array<Record<string, unknown>>).map((g) => ({ ...g, isActive: 1 }));
    expect(() => parseOpenGovGovernments(numeric, undefined, 1)).toThrow(/the list changed shape/);
    // a healthy list whose slice is empty is fine
    expect(parseOpenGovGovernments(GOVS, { has: () => false }, 1).governments).toEqual([]);
  });
});

describe('parseOpenGovProjects (County of Sacramento, 11 open projects)', () => {
  const parsed = parseOpenGovProjects(SAC, SACRAMENTO);

  it('counts what it saw, kept and left out', () => {
    expect(parsed).toMatchObject({ open: 11, notTrade: 4, notBiddable: 0 });
    expect(parsed.bids).toHaveLength(7);
    // Left out: a records notification system (template "Request for Bid (Goods/Services)"), psychiatry and
    // breastfeeding support services, and a cattle grazing land lease (relevance.ts).
    for (const t of ['County Clerk Recorder Notification System', 'Breastfeeding Support Services',
      "Psychiatry Services at Sacramento County's Youth Detention Facility Open Enrollment",
      'Cattle Grazing Land Lease within the Lower Dry Creek Floodplain']) {
      expect(parsed.bids.map((b) => b.title)).not.toContain(t);
    }
    expect(parsed.bids.map((b) => b.title)).toEqual(expect.arrayContaining([
      'SMF Pedestrian Walkway - Riparian Public Art Installation Project',
      'CNG Fueling Station Maintenance and Repair Services',
      'HVAC and Refrigeration Parts',
      'Construction Manager at Risk Services for Sacramento International Airport Airfield Maintenance Facility Project',
    ]));
  });

  it('one bid in full: the SMF walkway (Notice to Contractors)', () => {
    const b = parsed.bids.find((x) => x.sourceId === 'saccounty:282418')!;
    expect(b).toMatchObject({
      source: 'opengov',
      sourceName: 'OpenGov Procurement',
      title: 'SMF Pedestrian Walkway - Riparian Public Art Installation Project',
      agency: 'County of Sacramento',
      category: 'Notice to Contractors - CUPCCAA',
      location: { city: 'Sacramento', state: 'CA' },
      postedAt: '2026-10-26T07:00:00.000Z', // midnight in Sacramento (PDT)
      dueAt: '2026-11-19T22:00:00.000Z', // 2 pm in Sacramento (PST)
      url: 'https://procurement.opengov.com/portal/saccounty/projects/282418',
      solNumber: '41016',
      naics: null,
      setAside: null,
    });
    expect(b.description).toMatch(/^Airports · Notice to Contractors - CUPCCAA\nThe Project includes, without limitation, furnishing all necessary labor/);
    // Placed at the government's seat by locate().
    expect(finalizeBid(b).location).toMatchObject({ city: 'Sacramento', state: 'CA', precision: 'city' });
  });

  it('times are the API\'s instants, stored as ISO UTC (no zone guessing)', () => {
    const cmar = parsed.bids.find((x) => x.sourceId === 'saccounty:280915')!;
    expect(cmar.dueAt).toBe('2026-12-18T22:00:00.000Z');
    const cng = parsed.bids.find((x) => x.sourceId === 'saccounty:133656')!;
    expect(cng.dueAt).toBe('2026-12-03T23:00:42.408Z'); // the board's own odd seconds, kept
    for (const b of parsed.bids) {
      expect(b.dueAt).toMatch(/Z$/);
      expect(b.postedAt).toMatch(/Z$/);
    }
  });

  it('sourceId is <government>:<project id>, stable through addenda (the CNG RFP has three)', () => {
    const row = SAC.rows.find((r) => r.id === 133656)!;
    expect((row as { addendums?: unknown[] }).addendums).toHaveLength(3);
    expect(parsed.bids.filter((b) => b.sourceId === 'saccounty:133656')).toHaveLength(1);
  });

  it('a long summary is cut for the card (900 characters after the department · template line)', () => {
    for (const b of parsed.bids) expect(b.description!.split('\n').slice(1).join('\n').length).toBeLessThanOrEqual(900);
  });
});

describe('parseOpenGovProjects: the other answers and the quirks', () => {
  it('an empty answer (City of San Marino) gives nothing', () => {
    expect(EMPTY).toEqual({ count: 0, rows: [] });
    expect(parseOpenGovProjects(checkOpenGovAnswer(EMPTY), { ...SACRAMENTO, code: 'cityofsanmarino' })).toEqual({ bids: [], open: 0, notTrade: 0, notBiddable: 0 });
  });

  it('Lakeport: the row\'s own organisation places it', () => {
    const gov: OpenGovGovernment = { code: 'cityoflakeport', name: 'City of Lakeport', city: 'Lakeport', state: 'CA', timezone: 'America/Los_Angeles' };
    const p = parseOpenGovProjects(LAKEPORT, gov);
    expect(p.open).toBe(1);
    expect(p.bids.length + p.notTrade).toBe(1);
    for (const b of p.bids) expect(b).toMatchObject({ location: { city: 'Lakeport', state: 'CA' }, url: 'https://procurement.opengov.com/portal/cityoflakeport/projects/319871' });
  });

  it('private, paused and "coming soon" projects are left out (real row, flag flipped)', () => {
    const base = SAC.rows.find((r) => r.id === 282418)!;
    for (const flip of [{ isPrivate: true }, { isPaused: true }, { comingSoon: true }]) {
      const p = parseOpenGovProjects({ count: 1, rows: [{ ...base, ...flip }] }, SACRAMENTO);
      expect(p).toMatchObject({ open: 1, notBiddable: 1, bids: [] });
    }
  });

  it('a deadline that is not an instant with a zone is not guessed', () => {
    const base = SAC.rows.find((r) => r.id === 282418)!;
    const p = parseOpenGovProjects({ count: 1, rows: [{ ...base, proposalDeadline: '11/19/2026 2:00 PM' }, { ...base, id: 900001, proposalDeadline: null }] }, SACRAMENTO);
    expect(p.bids.map((b) => b.dueAt)).toEqual([null, null]);
  });
});

describe('checkOpenGovAnswer', () => {
  it('accepts the real answers', () => {
    expect(checkOpenGovAnswer(SAC).count).toBe(11);
    expect(checkOpenGovAnswer(EMPTY).rows).toEqual([]);
  });
  it('refuses anything else', () => {
    expect(() => checkOpenGovAnswer('<!DOCTYPE html><title>Just a moment...</title>')).toThrow(/not the \{ count, rows \} answer/);
    expect(() => checkOpenGovAnswer([])).toThrow(/not the \{ count, rows \}/);
    expect(() => checkOpenGovAnswer({ rows: [] })).toThrow(/not the \{ count, rows \}/);
    expect(() => checkOpenGovAnswer({ count: 4, rows: [] })).toThrow(/announces 4 open projects but lists none/);
  });
});

// ---------------------------------------------------------------- fetch --

interface Call { url: string; method: string; body: string | null; headers: Record<string, string> }

/** A fake http: the real government list, and per government code an answer (or an error to throw). */
function fake(answers: Record<string, unknown | Error>, opts: { deadline?: Date; slice?: SourceSlice; list?: unknown } = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const partial: string[] = [];
  const ctx: SourceContext = {
    now: new Date('2026-11-14T06:30:00Z'),
    env: () => undefined,
    log: (m) => logs.push(m),
    partial: (m) => partial.push(m),
    ...(opts.deadline ? { deadline: opts.deadline } : {}),
    ...(opts.slice ? { slice: opts.slice } : {}),
    http: {
      text: async () => { throw new Error('text() not expected'); },
      json: async <T>(url: string, init: RequestInit = {}) => {
        calls.push({ url, method: init.method ?? 'GET', body: (init.body as string) ?? null, headers: (init.headers ?? {}) as Record<string, string> });
        if (url === OPENGOV_GOVERNMENTS_URL) return (opts.list ?? GOVS) as T;
        const code = decodeURIComponent(/\/government\/([^/]+)\/project\/public$/.exec(url)![1]!);
        const a = code in answers ? answers[code] : EMPTY; // TEST: a government not named answers like San Marino did
        if (a instanceof Error) throw a;
        return (typeof a === 'function' ? (a as (b: string) => unknown)((init.body as string) ?? '') : a) as T;
      },
    },
  };
  return { ctx, calls, logs, partial };
}

const source = createOpenGovSource({ minGovernments: 1 });

describe('openGovSource.fetch', () => {
  it('California slice: one GET of the list, then one POST per California government', async () => {
    const { ctx, calls, logs } = fake({ saccounty: SAC, cityoflakeport: LAKEPORT }, { slice: CA_SLICE });
    const bids = await source.fetch(ctx);
    expect(calls[0]).toMatchObject({ url: OPENGOV_GOVERNMENTS_URL, method: 'GET' });
    const posts = calls.slice(1);
    expect(posts).toHaveLength(7);
    expect(posts.map((c) => c.url).sort()).toEqual(CA_CODES.map(openGovProjectsUrl).sort());
    for (const c of posts) {
      expect(c.method).toBe('POST');
      expect(c.headers).toMatchObject({ 'Content-Type': 'application/json', Accept: 'application/json' });
      expect(JSON.parse(c.body!)).toEqual({ filters: [{ type: 'status', value: 'open' }], quickSearchQuery: null, limit: 100, page: 1 });
    }
    const lakeport = parseOpenGovProjects(LAKEPORT, { ...SACRAMENTO, code: 'cityoflakeport' }).bids.length;
    expect(bids).toHaveLength(7 + lakeport);
    expect(logs[0]).toBe('opengov: 7 governments to read (slice opengov-1; of 13 listed: 1 inactive/deleted, 1 OpenGov internal, 1 with no state, 3 in other slices)');
    expect(logs.at(-1)).toBe(`opengov: 7 governments read; 12 open projects at 2 of them; ${7 + lakeport} kept, ${4 + (1 - lakeport)} left out as not trade work, 0 private/paused/coming soon`);
  });

  it('a government that answers an error is logged and skipped; the rest go on', async () => {
    const { ctx, logs, partial } = fake({ saccounty: SAC, sjrtd: new Error('HTTP 500 for https://api.procurement.opengov.com/…') }, { slice: CA_SLICE });
    const bids = await source.fetch(ctx);
    expect(bids.filter((b) => b.sourceId.startsWith('saccounty:'))).toHaveLength(7);
    // and the scan report says so (report.sources.opengov.stopped), not only the log
    expect(partial).toEqual(['opengov: 1 of 7 governments failed (sjrtd)']);
    expect(logs).toContain('opengov sjrtd (San Joaquin Regional Transit District): skipped — HTTP 500 for https://api.procurement.opengov.com/…');
    expect(logs.at(-1)).toMatch(/^opengov: 6 governments read, 1 failed;/);
  });

  it('an answer that is not { count, rows } (a challenge page) is a failure for that government', async () => {
    const { ctx, logs } = fake({ 'gd-pud': '<html>Access denied</html>' }, { slice: CA_SLICE });
    await source.fetch(ctx);
    expect(logs).toContain('opengov gd-pud (Georgetown Divide Public Utility District): skipped — not the { count, rows } answer we know');
  });

  it(`${MAX_FAILURES_IN_A_ROW} governments failing in a row = the API changed: the source FAILS`, async () => {
    const all = parseOpenGovGovernments(GOVS, undefined, 1).governments.map((g) => g.code);
    expect(all).toHaveLength(MAX_FAILURES_IN_A_ROW);
    const { ctx } = fake(Object.fromEntries(all.map((c) => [c, new Error('HTTP 404')])));
    await expect(source.fetch(ctx)).rejects.toThrow(/10 governments in a row failed .* the API changed or refuses us/);
  });

  it('fewer failures than that, but every one failing, still FAILS (never a quiet 0)', async () => {
    const { ctx } = fake(Object.fromEntries(CA_CODES.map((c) => [c, new Error('HTTP 403')])), { slice: CA_SLICE });
    await expect(source.fetch(ctx)).rejects.toThrow(/every government failed \(7\)/);
  });

  it('a list that is not the list FAILS before any POST', async () => {
    const { ctx, calls } = fake({}, { list: '<html>maintenance</html>' });
    await expect(source.fetch(ctx)).rejects.toThrow(/not a JSON array/);
    expect(calls).toHaveLength(1);
    // The real source asks for at least 100 governments: the trimmed fixture is refused.
    const strict = fake({});
    await expect(openGovSource.fetch(strict.ctx)).rejects.toThrow(/not the list we know/);
  });

  it('at the time budget it stops between governments, keeps what it read and says so', async () => {
    const { ctx, calls, partial } = fake({ saccounty: SAC }, { slice: CA_SLICE, deadline: new Date(Date.now() - 1) });
    await source.fetch(ctx);
    expect(calls).toHaveLength(2); // the list + the first government (never stop before the first request)
    expect(partial).toEqual(['opengov: stopped at the time budget, 1 of 7 governments read']);
  });

  it('a government with more than 100 open projects is read page by page (synthetic TEST rows)', async () => {
    const base = SAC.rows.find((r) => r.id === 282418)!;
    const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ ...base, id: 900000 + from + i, title: `TEST roof replacement ${from + i} (synthetic)` }));
    const pages: Record<number, OpenGovProjectsAnswer> = { 1: { count: 130, rows: rows(0, 100) }, 2: { count: 130, rows: rows(100, 30) } };
    const { ctx, calls } = fake({ saccounty: (body: string) => pages[JSON.parse(body).page as number] }, { slice: CA_SLICE });
    const bids = await source.fetch(ctx);
    const sac = calls.filter((c) => c.url === openGovProjectsUrl('saccounty'));
    expect(sac.map((c) => JSON.parse(c.body!).page)).toEqual([1, 2]);
    expect(bids.filter((b) => b.sourceId.startsWith('saccounty:'))).toHaveLength(130);
  });

  it('openGovBody is the body the portal sends', () => {
    expect(JSON.parse(openGovBody(3))).toEqual({ filters: [{ type: 'status', value: 'open' }], quickSearchQuery: null, limit: 100, page: 3 });
  });
});
