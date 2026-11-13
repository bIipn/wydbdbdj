/**
 * Market routes: area wages + material trends, award history (plan gated), and the admin refresh.
 * The database is filled from REAL captured pages (USAspending, BLS, the NV State Public Works bid
 * board); ZIP points are real ones from the `zipcodes` package. Accounts are simulated (TEST ids).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import zipcodes from 'zipcodes';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthService } from '../src/auth/index.js';
import { createContext, loadConfig, type AppConfig } from '../src/context.js';
import type { Db } from '../src/db/db.js';
import { recordAwardCoverage } from '../src/db/market.js';
import { saveProfileForAccount } from '../src/db/repo.js';
import { refreshBls } from '../src/market/bls.js';
import type { MarketHttp, MarketRefreshReport } from '../src/market/refresh.js';
import { refreshAwards } from '../src/market/usaspending.js';
import { profileIdFor } from '../src/profile/build.js';
import { loadProfile } from '../src/profiles.js';
import { createBus } from '../src/realtime/bus.js';
import { AMOUNT_LABEL as AMOUNT, register, type MarketRouteDeps } from '../src/routes/market.js';
import { runScan } from '../src/scan.js';
import { buildServer } from '../src/server.js';
import type { Account, FetchLike, Profile } from '../src/types.js';
import { accountsConfig, fakeAuth, fx, memoryDb, NOW, questSource, scanCtx, seedAccount, testProfile } from './helpers.js';

const pilot = loadProfile('lm-electric');
const capture = (file: string) => JSON.parse(fx(file)) as { response: Record<string, unknown> };
const AWARDS = capture('usaspending-awards-nv-238210.json').response;
const TRANSACTIONS = capture('usaspending-transactions-clark-238210.json').response;
const COUNT = capture('usaspending-award-count-nv-238210.json').response;
type RawSeries = { seriesID: string; data: unknown[] };
const BLS_SERIES = new Map<string, RawSeries>(
  ['bls-oews-electricians.json', 'bls-oews-electricians-percentiles.json', 'bls-ppi-core.json']
    .flatMap((f) => (capture(f).response.Results as { series: RawSeries[] }).series.map((s) => [s.seriesID, s] as const)),
);

/** Replays the captured USAspending pages. */
function awardsHttp(hold?: Promise<void>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    text: async () => '',
    json: async <T>(url: string) => {
      calls.push(url);
      await hold;
      if (url.endsWith('/spending_by_award_count/')) return COUNT as T;
      if (url.endsWith('/spending_by_award/')) return AWARDS as T;
      if (url.endsWith('/spending_by_transaction/')) return TRANSACTIONS as T;
      // One award's own history (the price lookup for awards without a Mod 0 row): nothing more known here.
      if (url.endsWith('/api/v2/transactions/')) return { page_metadata: { page: 1, hasNext: false }, results: [] } as T;
      throw new Error(`unexpected request ${url}`);
    },
  };
}

/** Replays the captured BLS series; anything else gets BLS's own "no data" wording. */
function blsHttp(): FetchLike & { calls: number; asked: string[][] } {
  const http = {
    calls: 0,
    asked: [] as string[][],
    text: async () => '',
    json: async <T>(_url: string, init?: RequestInit) => {
      http.calls++;
      const body = JSON.parse(String(init!.body)) as { seriesid: string[]; endyear: string };
      http.asked.push(body.seriesid);
      const message = body.seriesid.filter((id) => !BLS_SERIES.has(id)).map((id) => `No Data Available for Series ${id} Year: ${body.endyear}`);
      return { status: 'REQUEST_SUCCEEDED', message, Results: { series: body.seriesid.map((id) => BLS_SERIES.get(id) ?? { seriesID: id, data: [] }) } } as T;
    },
  };
  return http;
}

const realZip: NonNullable<MarketRouteDeps['lookupZip']> = (zip) => {
  const z = zipcodes.lookup(zip);
  return z ? { lat: z.latitude, lng: z.longitude, state: z.state, city: z.city } : null;
};

let db: Db;
const apps: FastifyInstance[] = [];

async function build(opts: { config?: AppConfig; auth?: AuthService; profile?: Profile | null; deps?: MarketRouteDeps; db?: Db; now?: Date } = {}): Promise<FastifyInstance> {
  const config = opts.config ?? { ...loadConfig({}), adminToken: 'TEST-admin' };
  const app = Fastify();
  const ctx = createContext({
    db: opts.db ?? db, config, bus: createBus(), auth: opts.auth ?? fakeAuth(null), now: () => opts.now ?? NOW,
    profile: config.authMode === 'single' ? (opts.profile ?? pilot) : null,
  });
  await register(app, ctx, { lookupZip: realZip, env: () => undefined, ...opts.deps });
  apps.push(app);
  return app;
}

beforeAll(async () => {
  db = await memoryDb();
  await runScan({ db, sources: [questSource()], profiles: [pilot], ctx: scanCtx() });
  await refreshAwards(db, awardsHttp(), { naics: ['238210'], states: ['NV'], months: 24, now: NOW });
  await refreshBls(db, blsHttp(), { now: NOW });
});
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await db.close();
});

describe('GET /api/market/awards', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await build();
  });

  it('the pilot (no parameters): the range with level, N, dates, source, and what the amount is', async () => {
    const res = await app.inject('/api/market/awards');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Reno's five awards are inside 90 miles of Gardnerville but carry no price at award in the capture,
    // the county is not known without a ZIP, so the answer is statewide.
    expect(body).toMatchObject({
      locked: false, notLoaded: false,
      scope: {
        level: 'state', label: 'in Nevada', naics: ['238210'], months: 24, window: { from: '2024-11-11', to: '2026-11-11' }, radiusMi: null,
        coverage: { states: ['NV'], nationwide: false, missingStates: [], partialStates: [] },
      },
      stats: { count: 27, min: 3380, median: 53488.85, max: 2838934.31 },
      enough: true, minCount: 10, amountBasis: 'price_at_award', excludedNoPrice: 9,
      dateRange: { from: '2025-03-18', to: '2026-08-21' },
      source: { name: 'USAspending.gov', url: 'https://www.usaspending.gov/' },
      asOf: NOW.toISOString(),
      // The figure is the first obligation, not the contract price: the label says so and never calls it a price.
      amountLabel: AMOUNT,
      summary: `Based on 27 federal awards in Nevada, 2025-03-18 to 2026-08-21. ${AMOUNT}`,
    });
    expect(AMOUNT).toBe('Amount obligated when the award was signed (its first action). Option years and later funding are not included; orders described as a minimum guarantee are left out.');
    expect(body.summary).not.toMatch(/price/i);
    expect(body.stats.p25).toBeCloseTo(27376.93, 2);
    expect(body.stats.p75).toBeCloseTo(97782.985, 3);
    expect(body.source.note).toMatch(/Federal contract awards only/);
    expect(body.ladder).toEqual([
      { level: 'zip_radius', priced: 0, excludedNoPrice: 5 },
      { level: 'county', priced: 0, excludedNoPrice: 0, skipped: 'county not known' },
      { level: 'state', priced: 27, excludedNoPrice: 9 },
    ]);
    // Recent awards: newest first, the two amounts side by side and labelled.
    expect(body.recent).toHaveLength(10);
    expect(body.recent[0]).toMatchObject({ source: 'usaspending', actionDate: '2026-09-23', state: 'NV', naics: '238210' });
    expect(body.recent.map((a: { actionDate: string }) => a.actionDate)).toEqual([...body.recent.map((a: { actionDate: string }) => a.actionDate)].sort().reverse());
    const priced = body.recent.find((a: { priceAtAward: number | null }) => a.priceAtAward !== null);
    expect(priced).toMatchObject({ amount: priced.priceAtAward, county: 'CLARK' });
    expect(typeof priced.currentAmount).toBe('number');
    expect(body.recent.some((a: { priceAtAward: number | null; currentAmount: number | null }) => a.priceAtAward === null && a.currentAmount !== null)).toBe(true);
    // Every listed award says whether it is in the range.
    for (const a of body.recent as Array<{ priceAtAward: number | null; inStats: boolean }>) expect(a.inStats).toBe(a.priceAtAward !== null);
  });

  it('by ZIP and radius: uses the radius when it holds enough priced awards', async () => {
    const body = (await app.inject('/api/market/awards?naics=238210&zip=89191&radiusMi=50&months=24')).json();
    expect(body).toMatchObject({
      scope: { level: 'zip_radius', label: 'within 50 mi of ZIP 89191', radiusMi: 50, months: 24 },
      stats: { count: 27, median: 53488.85 }, excludedNoPrice: 0, enough: true,
      summary: `Based on 27 federal awards within 50 mi of ZIP 89191, 2025-03-18 to 2026-08-21. ${AMOUNT}`,
    });
    expect(body.ladder).toEqual([{ level: 'zip_radius', priced: 27, excludedNoPrice: 0 }]);
  });

  it('a short window leaves too few awards: the count, no range, and it says so', async () => {
    const body = (await app.inject('/api/market/awards?zip=89191&radiusMi=50&months=4')).json();
    expect(body.scope).toMatchObject({ level: 'state', months: 4, window: { from: '2026-07-11', to: '2026-11-11' } });
    // One Clark County award was signed in those four months (2026-08-21).
    expect(body.stats).toEqual({ count: 1, min: null, p25: null, median: null, p75: null, max: null });
    expect(body.enough).toBe(false);
    expect(body.dateRange).toEqual({ from: '2026-08-21', to: '2026-08-21' });
    expect(body.summary).toBe('1 federal award with an amount obligated at signing in Nevada, 2026-08-21 to 2026-08-21: not enough to show a range (we need 10).');
    expect(body.ladder.at(-1)).toEqual({ level: 'nation', priced: 0, excludedNoPrice: 0, skipped: 'nationwide awards are not loaded' });
    expect(body.recent.length).toBeGreaterThan(0);
    // A real zero: Nevada is loaded for this window and nothing in it was signed in the last month. It keeps its count.
    const month = (await app.inject('/api/market/awards?months=1')).json();
    expect(month).toMatchObject({ notLoaded: false, stats: { count: 0 }, scope: { level: 'state', window: { from: '2026-10-11', to: '2026-11-11' } } });
    expect(month.summary).toBe('0 federal awards with an amount obligated at signing in Nevada: not enough to show a range (we need 10).');
  });

  // Only Nevada and only NAICS 238210 were pulled into this database (beforeAll), from 2024-11-11.
  const NOT_LOADED = {
    notLoaded: true, stats: { count: null, min: null, p25: null, median: null, p75: null, max: null }, enough: false,
    excludedNoPrice: 0, recent: [], ladder: [], dateRange: null,
  };

  it('a NAICS code we never pulled: "not loaded" and no count, never "0 awards"', async () => {
    const body = (await app.inject('/api/market/awards?naics=238220')).json();
    expect(body).toMatchObject({
      locked: false, ...NOT_LOADED,
      scope: { level: null, label: null, radiusMi: null, naics: ['238220'], coverage: { states: [], nationwide: false } },
    });
    expect(body.summary).toBe('We have not loaded federal awards for NAICS 238220 in Nevada yet, so there is nothing to compare.');
    // One code pulled, one not: still no answer (27 of the pair would be a short count), and Nevada is not listed as covered for the pair.
    const mixed = (await app.inject('/api/market/awards?naics=238210,238220')).json();
    expect(mixed).toMatchObject({ ...NOT_LOADED, scope: { level: null, naics: ['238210', '238220'], coverage: { states: [] } } });
    expect(mixed.summary).toBe('We have not loaded federal awards for NAICS 238220 in Nevada yet, so there is nothing to compare.');
  });

  it('a state we never pulled: "not loaded", never "0 federal awards in Oregon"', async () => {
    for (const [zip, state] of [['97201', 'Oregon'], ['85001', 'Arizona'], ['10001', 'New York']] as const) {
      const res = await app.inject(`/api/market/awards?zip=${zip}&radiusMi=50`);
      expect(res.statusCode, zip).toBe(200);
      const body = res.json();
      expect(body, zip).toMatchObject({ locked: false, ...NOT_LOADED, scope: { level: null, label: null, coverage: { states: ['NV'], nationwide: false } } });
      expect(body.summary, zip).toBe(`We have not loaded federal awards for NAICS 238210 in ${state} yet, so there is nothing to compare.`);
      expect(res.body, zip).not.toMatch(/\b0 federal awards|"count":0/);
    }
  });

  it('a bid whose own NAICS code was never pulled is told so', async () => {
    await db.exec("update bids set naics = '237130' where id = 'questcdn:1903611:10393520'");
    try {
      const body = (await app.inject('/api/market/awards?bidId=questcdn%3A1903611%3A10393520')).json();
      expect(body).toMatchObject({ ...NOT_LOADED, scope: { level: null, naics: ['237130'] } });
      expect(body.summary).toBe('We have not loaded federal awards for NAICS 237130 in Nevada yet, so there is nothing to compare.');
    } finally {
      await db.exec("update bids set naics = null where id = 'questcdn:1903611:10393520'");
    }
  });

  it('asking further back than our pulls go: the window and the summary say where the records start', async () => {
    const body = (await app.inject('/api/market/awards?zip=89191&radiusMi=50&months=120')).json();
    expect(body.scope).toMatchObject({ level: 'zip_radius', months: 120, window: { from: '2024-11-11', to: '2026-11-11' }, coverage: { states: ['NV'] } });
    expect(body.stats.count).toBe(27);
    expect(body.summary).toBe(`Based on 27 federal awards within 50 mi of ZIP 89191, 2025-03-18 to 2026-08-21. ${AMOUNT} Our federal award records for Nevada start 2024-11-11.`);
  });

  it('a window our pulls stop short of: the window ends where they do; one they never reach: "not loaded"', async () => {
    // Seven months on and nothing refreshed since 2026-11-11.
    const later = await build({ now: new Date('2027-06-11T20:00:00Z') });
    const stale = (await later.inject('/api/market/awards?zip=89191&radiusMi=50')).json();
    expect(stale.scope).toMatchObject({ level: 'zip_radius', months: 24, window: { from: '2025-06-11', to: '2026-11-11' } });
    // 24 of the 27 priced awards were signed on or after 2025-06-11.
    expect(stale).toMatchObject({ notLoaded: false, asOf: NOW.toISOString(), stats: { count: 24 }, dateRange: { from: '2025-06-26', to: '2026-08-21' } });

    const never = (await later.inject('/api/market/awards?zip=89191&radiusMi=50&months=4')).json();
    expect(never).toMatchObject({ ...NOT_LOADED, scope: { level: null, window: { from: '2027-02-11', to: '2027-06-11' } } });
    expect(never.summary).toBe('We have not loaded federal awards for NAICS 238210 in Nevada for 2027-02-11 to 2027-06-11 yet, so there is nothing to compare.');
  });

  it('a radius that reaches into states we never pulled names them', async () => {
    // Which states a circle reaches comes from src/geo/zip.ts; here a stand-in answers for Las Vegas + 120 mi.
    const wide = await build({ deps: { statesWithin: () => ['nv', 'AZ', 'UT', 'CA', 'BC'] } });
    await recordAwardCoverage(db, 'CA', ['238210'], '2026-07-11', '2026-11-11', NOW);
    try {
      const body = (await wide.inject('/api/market/awards?zip=89191&radiusMi=120')).json();
      expect(body.scope).toMatchObject({
        level: 'zip_radius', radiusMi: 120,
        coverage: { states: ['NV'], nationwide: false, missingStates: ['AZ', 'UT'], partialStates: ['CA'] },
      });
      expect(body.stats.count).toBe(27);
      expect(body.summary).toBe(`Based on 27 federal awards within 120 mi of ZIP 89191, 2025-03-18 to 2026-08-21. ${AMOUNT}`
        + ' Awards in Arizona, Utah are not loaded, so they are left out. Awards in California are loaded for only part of this period.');
    } finally {
      await db.exec("delete from award_coverage where scope = 'CA'");
    }
    // The default seam answers an empty list in this build ("not known"): nothing is claimed either way.
    const plain = (await app.inject('/api/market/awards?zip=89191&radiusMi=120')).json();
    expect(plain.scope.coverage).toEqual({ states: ['NV'], nationwide: false, missingStates: [], partialStates: [] });
    expect(plain.summary).toBe(`Based on 27 federal awards within 120 mi of ZIP 89191, 2025-03-18 to 2026-08-21. ${AMOUNT}`);
  });

  it('a nationwide pull loads every state, and only then is "in the United States" used', async () => {
    // A separate database where the replayed Nevada pages stand in for a nationwide pull (scope "US").
    const national = await memoryDb();
    try {
      await refreshAwards(national, awardsHttp(), { naics: ['238210'], states: ['US'], months: 24, now: NOW });
      const us = await build({ db: national });
      const oregon = (await us.inject('/api/market/awards?zip=97201&radiusMi=50')).json();
      expect(oregon).toMatchObject({ notLoaded: false, scope: { level: 'nation', label: 'in the United States', coverage: { states: [], nationwide: true } }, stats: { count: 27 } });
      // Asking further back than the nationwide pull goes cuts the window for every level alike.
      const far = (await us.inject('/api/market/awards?zip=97201&radiusMi=50&months=60')).json();
      expect(far.scope).toMatchObject({ level: 'nation', window: { from: '2024-11-11', to: '2026-11-11' }, coverage: { nationwide: true } });
      expect(far.summary).toMatch(/ Our federal award records for Oregon start 2024-11-11\.$/);
    } finally {
      await national.close();
    }
  });

  it('for a bid: measures from the bid\'s own place', async () => {
    const boulder = (await app.inject('/api/market/awards?bidId=questcdn%3A1903611%3A10393520')).json();
    expect(boulder).toMatchObject({ scope: { level: 'zip_radius', label: 'within 90 mi of Boulder City, NV', radiusMi: 90, naics: ['238210'] }, stats: { count: 27 } });

    const carson = (await app.inject('/api/market/awards?bidId=questcdn%3A1903611%3A10393527')).json();
    expect(carson.scope).toMatchObject({ level: 'state', label: 'in Nevada' });
    expect(carson.ladder.slice(0, 2)).toEqual([{ level: 'zip_radius', priced: 0, excludedNoPrice: 5 }, { level: 'county', priced: 0, excludedNoPrice: 0 }]);

    // "Nevada (location not listed)": no point to measure from, so straight to the state.
    const vague = (await app.inject('/api/market/awards?bidId=questcdn%3A1903611%3A10434923&radiusMi=25')).json();
    expect(vague.ladder[0]).toEqual({ level: 'zip_radius', priced: 0, excludedNoPrice: 0, skipped: 'no location to measure from' });
    expect(vague.scope.level).toBe('state');
  });

  it('answers 400 with a message for every bad parameter, never 500', async () => {
    const cases: Array<[string, string]> = [
      ['zip=8919', 'invalid_zip'], ['zip=abcde', 'invalid_zip'], ['zip=891911', 'invalid_zip'], ['zip=89191&zip=89115', 'invalid_zip'],
      ['months=0', 'invalid_months'], ['months=121', 'invalid_months'], ['months=two', 'invalid_months'], ['months=2.5', 'invalid_months'], ['months=-3', 'invalid_months'],
      ['radiusMi=0', 'invalid_radius'], ['radiusMi=501', 'invalid_radius'], ['radiusMi=1e2', 'invalid_radius'], ['radiusMi=10&radiusMi=20', 'invalid_radius'],
      ['naics=23', 'invalid_naics'], ['naics=electrical', 'invalid_naics'], ['naics=238210,23822', 'invalid_naics'], ['naics=238210;drop', 'invalid_naics'],
      [`naics=${Array.from({ length: 11 }, (_, i) => 238200 + i).join(',')}`, 'invalid_naics'],
      [`bidId=${'x'.repeat(201)}`, 'invalid_bid_id'], ['bidId=a&bidId=b', 'invalid_bid_id'],
      // A NUL byte cannot be stored in the database: asking it to look one up used to answer 500 with its error text.
      ['bidId=%00', 'invalid_bid_id'], ['bidId=abc%00def', 'invalid_bid_id'], ['bidId=samgov%3Aabc%00', 'invalid_bid_id'], ['bidId=%20%00%20', 'invalid_bid_id'],
      ['zip=%00', 'invalid_zip'], ['naics=%00', 'invalid_naics'], ['months=%00', 'invalid_months'], ['radiusMi=%00', 'invalid_radius'],
    ];
    for (const [query, error] of cases) {
      const res = await app.inject(`/api/market/awards?${query}`);
      expect(res.statusCode, query).toBe(400);
      expect(res.json().error, query).toBe(error);
      expect(res.json().message, query).toBeTruthy();
    }
    const missingBid = await app.inject('/api/market/awards?bidId=samgov:TEST-missing');
    expect(missingBid.statusCode).toBe(404);
    expect(missingBid.json()).toEqual({ error: 'bid_not_found', message: 'No such bid.' });
    // Other odd bytes are harmless: they reach the lookup and find nothing.
    for (const odd of ['%01', 'a%0Ab', '%7F', '%ED%A0%80']) expect((await app.inject(`/api/market/awards?bidId=${odd}`)).statusCode, odd).toBe(404);
    const unknownZip = await app.inject('/api/market/awards?zip=00000');
    expect(unknownZip.statusCode).toBe(404);
    expect(unknownZip.json().error).toBe('zip_not_found');
    // Blank values count as absent.
    expect((await app.inject('/api/market/awards?zip=&months=&naics=')).statusCode).toBe(200);
  });
});

describe('GET /api/market/awards: plans', () => {
  let app: FastifyInstance;
  let who: Account | null = null;
  let free: Account;
  let pro: Account;
  beforeAll(async () => {
    app = await build({ config: accountsConfig(), auth: fakeAuth(() => who) });
    free = await seedAccount(db);
    pro = await seedAccount(db, { plan: 'pro' });
    for (const a of [free, pro]) await saveProfileForAccount(db, a.id, testProfile(profileIdFor(a.id), { trades: ['electrical'], zip: '89410' }));
  });

  it('a plan without award history gets the count and locked: true, nothing about prices', async () => {
    who = free;
    const res = await app.inject('/api/market/awards?zip=89191&radiusMi=50');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      locked: true, notLoaded: false,
      stats: { count: 27 },
      scope: {
        level: 'zip_radius', label: 'within 50 mi of ZIP 89191', naics: ['238210'], months: 24, window: { from: '2024-11-11', to: '2026-11-11' }, radiusMi: 50,
        coverage: { states: ['NV'], nationwide: false, missingStates: [], partialStates: [] },
      },
      dateRange: { from: '2025-03-18', to: '2026-08-21' },
      source: expect.objectContaining({ name: 'USAspending.gov' }),
      asOf: NOW.toISOString(),
      summary: expect.stringContaining('27 federal awards'),
    });
    // No amount of any kind leaves the server: not a statistic, not an award, not a recipient.
    expect(res.body).not.toMatch(/53488|2838934|priceAtAward|currentAmount|recipient|median|recent/);
  });

  it('a state we never pulled: the free plan gets "not loaded" and no count, not locked with 0', async () => {
    who = free;
    const body = (await app.inject('/api/market/awards?zip=97201&radiusMi=50')).json();
    expect(body).toEqual({
      locked: true, notLoaded: true,
      stats: { count: null },
      scope: {
        level: null, label: null, naics: ['238210'], months: 24, window: { from: '2024-11-11', to: '2026-11-11' }, radiusMi: null,
        coverage: { states: ['NV'], nationwide: false, missingStates: [], partialStates: [] },
      },
      dateRange: null,
      source: expect.objectContaining({ name: 'USAspending.gov' }),
      asOf: NOW.toISOString(),
      summary: 'We have not loaded federal awards for NAICS 238210 in Oregon yet, so there is nothing to compare.',
    });
  });

  it('a plan with award history gets the range and the awards', async () => {
    who = pro;
    const body = (await app.inject('/api/market/awards?zip=89191&radiusMi=50')).json();
    expect(body).toMatchObject({ locked: false, stats: { count: 27, median: 53488.85 } });
    expect(body.recent).toHaveLength(10);
    // The profile's own ZIP and radius are the default place.
    const own = (await app.inject('/api/market/awards')).json();
    expect(own.scope).toMatchObject({ level: 'state', label: 'in Nevada' });
    expect(own.ladder[0]).toEqual({ level: 'zip_radius', priced: 0, excludedNoPrice: 5 });
  });

  it('demo mode unlocks it for a free account', async () => {
    who = free;
    const demo = await build({ config: accountsConfig({ demoMode: true }), auth: fakeAuth(() => who) });
    expect((await demo.inject('/api/market/awards?zip=89191&radiusMi=50')).json()).toMatchObject({ locked: false, stats: { count: 27, median: 53488.85 } });
  });

  it('needs a signed-in, onboarded account; parameters are checked only after that', async () => {
    who = null;
    for (const url of ['/api/market/awards', '/api/market/awards?zip=bad', '/api/market/area', '/api/market/area?zip=bad']) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(401);
      expect(res.json(), url).toEqual({ error: 'sign_in_required' });
    }
    who = await seedAccount(db);
    for (const url of ['/api/market/awards', '/api/market/area']) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(409);
      expect(res.json(), url).toEqual({ error: 'onboarding_required' });
    }
  });
});

describe('GET /api/market/area', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await build();
  });

  it('wages with the level and survey period, every figure with its source', async () => {
    const res = await app.inject('/api/market/area?zip=89410');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.area).toEqual({ zip: '89410', city: 'Gardnerville', state: 'NV', stateName: 'Nevada', label: 'Gardnerville, NV 89410' });
    expect(body.wages[0]).toEqual({
      primary: true, soc: '472111', occupation: 'Electricians', level: 'state', areaCode: '3200000', areaName: 'Nevada',
      period: '2025-A01', periodLabel: 'May 2025', mean: 36.4, median: 35.37, p25: 23.52, p75: 46.42, p90: 58.27, unit: 'USD per hour',
      // Nevada's employment figure is not in the capture, and the row says so.
      employment: null, cautions: ['No BLS employment estimate is stored for this area, so we cannot say how many jobs these figures rest on.'],
      source: 'BLS Occupational Employment and Wage Statistics (OEWS)', sourceUrl: 'https://www.bls.gov/oes/', fetchedAt: NOW.toISOString(),
    });
    // What each figure rests on: BLS's employment estimate where we hold it (the nation: 757,220 jobs)…
    const nation = body.wages.find((w: { level: string }) => w.level === 'nation');
    expect(nation).toMatchObject({ employment: 757220, p90: null, cautions: [] });
    // …and Carson City's 75th percentile is not shown at face value: it is the same figure as its 90th.
    const carson = body.wages.find((w: { areaName: string }) => w.areaName === 'Carson City, NV');
    expect(carson).toMatchObject({ p25: 27.65, p75: 59.5, p90: 59.5, employment: null });
    expect(carson.cautions[0]).toBe('The 75th and 90th percentile are the same figure ($59.50).');
    expect(body.wages.find((w: { areaName: string }) => w.areaName === 'Reno, NV')).toMatchObject({ p75: 41.12, p90: 49.16 });
    expect(body.notes.wages).toMatch(/BLS publishes no sample size for these figures\. "employment" is its estimate of how many jobs/);
    expect(body.wages.map((w: { areaName: string; level: string; primary: boolean; mean: number }) => [w.areaName, w.level, w.primary, w.mean])).toEqual([
      ['Nevada', 'state', true, 36.4],
      ['Reno, NV', 'metro', false, 35.2],
      ['Las Vegas-Henderson-North Las Vegas, NV', 'metro', false, 36.16],
      ['Carson City, NV', 'metro', false, 40.86],
      ['Balance of Nevada nonmetropolitan area', 'nonmetro', false, 38.81],
      ['United States', 'nation', false, 34.37],
    ]);
    for (const w of body.wages) expect(w).toMatchObject({ periodLabel: 'May 2025', source: expect.stringContaining('BLS'), unit: 'USD per hour' });
    expect(body.notes.wages).toMatch(/not a prevailing wage and not a loaded rate/);
    expect(body.notes.wages).toMatch(/prevailing wage/);
    expect(body.missing).toEqual([]);
  });

  it('material trends: national indexes with period, preliminary flag and the 1, 3 and 12 month change', async () => {
    const body = (await app.inject('/api/market/area')).json();
    expect(body.materials).toHaveLength(9);
    expect(body.materials[0]).toMatchObject({
      seriesId: 'WPU10260314', label: 'Copper wire and cable', latest: { period: '2026-M09', periodLabel: 'Sep 2026', value: 607.705, preliminary: true },
      change1m: { pct: 0.8 }, change3m: { pct: 5.3 }, change12m: { pct: 30.8, from: { periodLabel: 'Sep 2025', value: 464.522 } },
      unit: 'index', geography: 'national', source: 'BLS Producer Price Index (PPI)',
    });
    expect(body.notes.materials).toBe('National price indexes, not dollar prices. Updated monthly; the newest months are preliminary and get revised.');
    expect(body.disclaimer).toBe('BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov. Data retrieved from BLS.gov on 2026-11-11.');
    expect(body.accessed).toBe('2026-11-11');
    // No ZIP given and none on the pilot's profile: its home state, from "Gardnerville, NV".
    expect(body.area).toEqual({ zip: null, city: null, state: 'NV', stateName: 'Nevada', label: 'Gardnerville, NV' });
    expect(body.wages[0]).toMatchObject({ level: 'state', areaName: 'Nevada', primary: true });
  });

  it('another state: its own figures; a state we hold nothing for: the national figure, said plainly', async () => {
    const ca = (await app.inject('/api/market/area?zip=95814')).json();
    expect(ca.area).toMatchObject({ state: 'CA', city: 'Sacramento' });
    expect(ca.wages.map((w: { areaName: string; mean: number }) => [w.areaName, w.mean])).toEqual([['California', 41.28], ['Sacramento-Roseville-Folsom, CA', 38.4], ['United States', 34.37]]);

    const or = (await app.inject('/api/market/area?zip=97201')).json();
    expect(or.area).toMatchObject({ state: 'OR', stateName: 'Oregon' });
    expect(or.wages).toHaveLength(1);
    expect(or.wages[0]).toMatchObject({ primary: true, level: 'nation', areaName: 'United States', mean: 34.37, median: 30.38, p25: null, p75: null });
    expect(or.missing).toEqual(['No Oregon wage is stored, so this is the national figure.']);
  });

  it('validates the ZIP: 400 for a malformed one, 404 for one that does not exist', async () => {
    for (const zip of ['8941', 'abcde', '894100', '89410-1234']) {
      const res = await app.inject(`/api/market/area?zip=${zip}`);
      expect(res.statusCode, zip).toBe(400);
      expect(res.json(), zip).toEqual({ error: 'invalid_zip', message: 'zip must be a 5-digit ZIP code' });
    }
    expect((await app.inject('/api/market/area?zip=89410&zip=89411')).statusCode).toBe(400);
    const missing = await app.inject('/api/market/area?zip=00000');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'zip_not_found', message: 'We do not know that ZIP code.' });
  });

  it('says what is missing when nothing has been loaded, and still carries the disclaimer', async () => {
    const empty = await memoryDb();
    try {
      const app2 = Fastify();
      apps.push(app2);
      const ctx = createContext({ db: empty, config: loadConfig({}), bus: createBus(), auth: fakeAuth(null), profile: pilot, now: () => NOW });
      await register(app2, ctx, { lookupZip: realZip });
      const body = (await app2.inject('/api/market/area?zip=89410')).json();
      expect(body).toMatchObject({ wages: [], materials: [], accessed: null, missing: ['No wage data has been loaded yet.', 'No material price indexes have been loaded yet.'] });
      expect(body.disclaimer).toBe('BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov.');
      // No awards pulled yet is "not loaded", not "0 federal awards in Nevada".
      const awards = (await app2.inject('/api/market/awards')).json();
      expect(awards).toMatchObject({ locked: false, notLoaded: true, stats: { count: null, median: null }, enough: false, recent: [], ladder: [], asOf: null, scope: { level: null, coverage: { states: [] } } });
      expect(awards.summary).toBe('We have not loaded federal awards for NAICS 238210 in Nevada yet, so there is nothing to compare.');
    } finally {
      await empty.close();
    }
  });

  it('a profile in a trade we have no wage series for is told so', async () => {
    const other = await build({ profile: { ...testProfile('test-market-other-trade'), naics: { strong: ['238220'], related: [] } } });
    const body = (await other.inject('/api/market/area')).json();
    expect(body.wages).toEqual([]);
    expect(body.missing).toEqual(['We have no wage series for this trade yet.']);
    expect(body.materials).toHaveLength(9);
  });
});

describe('POST /api/admin/market/refresh', () => {
  const admin = { 'x-admin-token': 'TEST-admin' };
  const post = (app: FastifyInstance, payload?: unknown, headers: Record<string, string> = admin) =>
    app.inject({ method: 'POST', url: '/api/admin/market/refresh', headers, payload: payload as never });

  it('needs the admin token and sends nothing without it', async () => {
    const http: MarketHttp = { awards: awardsHttp(), bls: blsHttp() };
    const app = await build({ deps: { http } });
    for (const headers of [{}, { 'x-admin-token': 'wrong' }] as Array<Record<string, string>>) {
      const res = await post(app, { states: ['NV'] }, headers);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'admin_token_required' });
    }
    expect((http.awards as ReturnType<typeof awardsHttp>).calls).toEqual([]);
    expect((http.bls as ReturnType<typeof blsHttp>).calls).toBe(0);
  });

  it('runs the refresh in-process and answers with the report', async () => {
    const awards = awardsHttp();
    const bls = blsHttp();
    const app = await build({ deps: { http: { awards, bls } } });
    const res = await post(app, { states: ['nv'], months: 24, naics: ['238210'] });
    expect(res.statusCode).toBe(200);
    const report = res.json() as MarketRefreshReport;
    // 3 search requests, then one history lookup for each of the 9 awards without a Mod 0 row.
    // BLS: 357 series are planned (9 price indexes, then 6 per area: four wage figures, employment and the 90th percentile).
    // The 35 stored a moment ago are left alone, the other 322 take 13 queries.
    expect(report).toMatchObject({
      ok: true, errors: [],
      awards: { startDate: '2024-11-11', endDate: '2026-11-11', naics: ['238210'], requests: 12, totals: { fetched: 36, inserted: 0, updated: 36, withPriceAtAward: 27, withoutPriceAtAward: 9 } },
      bls: { queries: 13, seriesPlanned: 357, skippedFresh: 35, seriesAsked: 322, error: null },
    });
    expect(report.awards!.scopes[0]!.priceLookups).toEqual({ asked: 9, filled: 0 });
    expect(awards.calls).toHaveLength(12);
    expect(bls.calls).toBe(13);
    // First in line at BLS: the price indexes, what is missing for the nation (25th, 75th and 90th percentile; its
    // employment is stored), then for the state asked for and its metro areas: their employment, and everything
    // the capture lacks for Balance of Nevada.
    expect(bls.asked[0]!.slice(0, 9)).toEqual(['WPU10260314', 'WPU11710216', 'WPU117522', 'PCU3353133353133', 'WPU108303', 'WPU1174', 'WPU1171', 'WPUIP2312001', 'PCU23821X23821X']);
    expect(bls.asked[0]!.slice(9, 20)).toEqual([
      'OEUN000000000000047211107', 'OEUN000000000000047211109', 'OEUN000000000000047211110',
      'OEUS320000000000047211101', 'OEUM003990000000047211101', 'OEUM002982000000047211101', 'OEUM001618000000047211101',
      'OEUM320000600000047211107', 'OEUM320000600000047211109', 'OEUM320000600000047211101', 'OEUM320000600000047211110',
    ]);
    expect(bls.asked.flat()).not.toContain('OEUN000000000000047211101');
    expect(bls.asked.flat()).not.toContain('OEUS320000000000047211103');
  });

  it('parts can be switched off, and the states default to the ones profiles work in', async () => {
    const awards = awardsHttp();
    const bls = blsHttp();
    const app = await build({ deps: { http: { awards, bls } } });
    const onlyBls = (await post(app, { awards: false })).json() as MarketRefreshReport;
    expect(onlyBls).toMatchObject({ ok: true, awards: null, bls: { queries: 13 } });
    expect(awards.calls).toEqual([]);

    // The pilot works in NV and CA: both are pulled (the replay answers the same pages for each).
    const onlyAwards = (await post(app, { bls: false, months: 24 })).json() as MarketRefreshReport;
    expect(onlyAwards.bls).toBeNull();
    expect(onlyAwards.awards!.scopes.map((s) => s.scope)).toEqual(['NV', 'CA']);
    expect(onlyAwards.awards!.naics).toEqual(['238210', '238220', '236220']);
    expect(bls.calls).toBe(13);
    // No body at all is fine too.
    expect((await post(app)).statusCode).toBe(200);
  });

  it('passes the BLS key and query budget from the environment, and never echoes the key', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const bls: FetchLike = {
      text: async () => '',
      json: async <T>(_url: string, init?: RequestInit) => {
        seen.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
        return { status: 'REQUEST_NOT_PROCESSED', message: ['TEST threshold for TEST-BLS-KEY'], Results: {} } as T;
      },
    };
    const app = await build({ deps: { http: { awards: awardsHttp(), bls }, env: (name) => ({ BLS_API_KEY: 'TEST-BLS-KEY', BLS_MAX_QUERIES: '2' })[name] } });
    const res = await post(app, { awards: false });
    expect(res.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ registrationkey: 'TEST-BLS-KEY' });
    expect((seen[0]!.seriesid as string[]).length).toBe(50);
    expect(res.json()).toMatchObject({ ok: false, errors: ['bls: BLS answered REQUEST_NOT_PROCESSED: TEST threshold for ***'] });
    expect(res.body).not.toContain('TEST-BLS-KEY');
  });

  it('answers 400 for a bad body, and sends nothing', async () => {
    const awards = awardsHttp();
    const app = await build({ deps: { http: { awards, bls: blsHttp() } } });
    const cases: Array<[unknown, string]> = [
      [{ states: ['Nevada'] }, 'invalid_states'], [{ states: 'NV' }, 'invalid_states'], [{ states: [] }, 'invalid_states'], [{ states: ['NV', 7] }, 'invalid_states'],
      [{ states: ['NV'], months: 0 }, 'invalid_months'], [{ states: ['NV'], months: '24' }, 'invalid_months'], [{ states: ['NV'], months: 1.5 }, 'invalid_months'],
      [{ states: ['NV'], naics: ['23'] }, 'invalid_naics'], [{ states: ['NV'], naics: '238210' }, 'invalid_naics'], [{ states: ['NV'], naics: [] }, 'invalid_naics'],
      [{ states: ['NV'], details: -1 }, 'invalid_details'], [{ states: ['NV'], details: 500 }, 'invalid_details'],
      [{ awards: 'yes' }, 'invalid_body'], [{ awards: false, bls: false }, 'invalid_body'], [['NV'], 'invalid_body'],
    ];
    for (const [payload, error] of cases) {
      const res = await post(app, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error, JSON.stringify(payload)).toBe(error);
      expect(res.json().message).toBeTruthy();
    }
    expect(awards.calls).toEqual([]);
  });

  it('asks for states when no profile has any', async () => {
    const app = await build({ config: { ...accountsConfig(), adminToken: 'TEST-admin' }, deps: { http: { awards: awardsHttp(), bls: blsHttp() } } });
    await db.exec("update profiles set prefs = jsonb_set(prefs, '{states}', '[]'::jsonb)");
    try {
      const res = await post(app, { bls: false });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('states_required');
    } finally {
      await db.exec(`update profiles set prefs = jsonb_set(prefs, '{states}', '["NV","CA"]'::jsonb)`);
    }
  });

  it('refuses a second refresh while one is running', async () => {
    let release = (): void => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const app = await build({ deps: { http: { awards: awardsHttp(hold), bls: blsHttp() } } });
    const first = post(app, { states: ['NV'], bls: false, months: 24 });
    await new Promise((r) => setTimeout(r, 30));
    const second = await post(app, { states: ['NV'], bls: false });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'refresh_running', message: 'A market refresh is already running.' });
    release();
    expect((await first).statusCode).toBe(200);
    // And it is free again afterwards.
    expect((await post(app, { states: ['NV'], bls: false, months: 24 })).statusCode).toBe(200);
  });
});

describe('through the real server (default wiring)', () => {
  it('serves the market routes in single mode, behind the access code like the rest of the API', async () => {
    const app = await buildServer({ db, profile: pilot }, { now: () => NOW, accessCode: 'TEST-volts' });
    apps.push(app);
    expect((await app.inject('/api/market/awards')).json()).toEqual({ error: 'access_code_required' });
    const headers = { 'x-access-code': 'TEST-volts' };

    const awards = await app.inject({ url: '/api/market/awards', headers });
    expect(awards.statusCode).toBe(200);
    expect(awards.json()).toMatchObject({ locked: false, scope: { level: 'state', label: 'in Nevada' }, stats: { count: 27, median: 53488.85 }, amountBasis: 'price_at_award' });

    const area = await app.inject({ url: '/api/market/area', headers });
    expect(area.statusCode).toBe(200);
    expect(area.json()).toMatchObject({ area: { state: 'NV' }, accessed: '2026-11-11' });
    expect(area.json().wages[0]).toMatchObject({ level: 'state', areaName: 'Nevada', mean: 36.4, periodLabel: 'May 2025' });
    expect(area.json().materials).toHaveLength(9);

    expect((await app.inject({ url: '/api/market/awards?zip=00000', headers })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/market/area?zip=abc', headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/admin/market/refresh', headers })).statusCode).toBe(401);
  });
});
