/**
 * Integration (v1): the modules wired the way main() wires them — real sign-up and sessions,
 * onboarding from the trade catalog, a scan over the REAL captured pages, alerts on the bus, pushes
 * to a fake sender. Plus the seams between modules: the access-code gate, how reasons name a trade,
 * catalog edits reaching stored profiles, offline sources and the trusted-proxy setting.
 *
 * People and companies here are simulated (example.com, "TEST … (simulated)"); bids are the real
 * pages in test/fixtures unless their id starts with TEST-.
 */
import { createECDH, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateVAPIDKeys } from 'web-push';
import { scanProfiles } from '../src/app.js';
import { createAuth } from '../src/auth/index.js';
import type { Db } from '../src/db/db.js';
import { getProfile, getProfileByAccount, saveProfileForAccount } from '../src/db/repo.js';
import { buildProfile, type OnboardingAnswers } from '../src/profile/build.js';
import { loadProfile } from '../src/profiles.js';
import { createBus, type Bus, type BusEvent } from '../src/realtime/bus.js';
import { createRealtime, type Realtime } from '../src/realtime/index.js';
import type { PushMessage, PushPayload } from '../src/realtime/push.js';
import { finalizeBid, runScan, type ScanReport } from '../src/scan.js';
import { scoreBid } from '../src/score/score.js';
import { buildApp, buildServer } from '../src/server.js';
import { fixtureSources } from '../src/sources/fixtures.js';
import { ALL_SOURCES, selectSources } from '../src/sources/index.js';
import { mergeTrades, tradeNoun, TRADES, withCatalogLists } from '../src/trades/catalog.js';
import type { Alert, Bid, BidDraft, FeedItem, Profile, Source } from '../src/types.js';
import { accountsConfig, CAPTURED, fakeAuth, memoryDb, NOW, realBids, resetDb, scanCtx, seedAccount, testBid, testProfile } from './helpers.js';

/** The server's clock: the capture day, so every real bid in the fixtures is open. */
const now = () => CAPTURED;
/** How many real bids the captured pages hold (85 on the 2026-11-13 capture). */
const REAL = realBids().length;
/** Fast password hashes for tests (the real default is far heavier). */
const COST = { ln: 10, r: 8, p: 1 };
const CSRF = { 'x-bidswipe': '1' };

let db: Db;
const apps: FastifyInstance[] = [];
const track = <T extends FastifyInstance>(app: T): T => (apps.push(app), app);

beforeAll(async () => {
  db = await memoryDb();
});
afterAll(async () => {
  for (const app of apps) await app.close();
  await db.close();
});

/** A simulated company's profile, built the way PUT /api/profile builds it. */
function company(trades: string[], over: Partial<OnboardingAnswers> = {}): Profile {
  return buildProfile(`test-${trades.join('-')}`, {
    businessName: `TEST ${trades.join(' + ')} company (simulated)`, trades, zip: '89701', radiusMi: 90,
    valueRange: { min: 10_000, max: 250_000 }, ...over,
  });
}

const reasonTexts = (bid: Bid, profile: Profile): string[] => scoreBid(bid, profile, NOW).reasons.map((r) => r.text);

// ------------------------------------------------------------ access code --

describe('access code gate', () => {
  // The router decodes percent-escapes before it matches, so these all reach a real /api route.
  const DISGUISED = ['/%61pi/me', '/%61%70%69/me', '/api/%6de', '/%61pi/feed?all=1', '/%61pi/next', '/%61pi/alerts'];

  it('single mode: a percent-encoded path does not slip past the code', async () => {
    const locked = track(await buildServer({ db, profile: loadProfile('lm-electric') }, { accessCode: 'TEST-volts', adminToken: 'TEST-admin', now }));
    for (const url of ['/api/me', ...DISGUISED]) {
      const res = await locked.inject(url);
      expect(res.statusCode, url).toBe(401);
      expect(res.json(), url).toEqual({ error: 'access_code_required' });
      expect((await locked.inject({ url, headers: { 'x-access-code': 'TEST-volts' } })).statusCode, url).toBe(200);
    }
    const swipe = await locked.inject({ method: 'POST', url: '/%61pi/swipe', payload: { bidId: 'TEST-none', action: 'save' } });
    expect(swipe.json()).toEqual({ error: 'access_code_required' });
    // Still open without the code: health (however it is spelled), the app shell, and admin routes behind their own token.
    for (const url of ['/api/health', '/%61pi/health', '/']) expect((await locked.inject(url)).statusCode, url).toBe(200);
    expect((await locked.inject({ method: 'POST', url: '/%61pi/admin/scan' })).json()).toEqual({ error: 'admin_token_required' });
    // An /api path that matches no route is gated too, as it always was.
    expect((await locked.inject('/api/TEST-no-such-route')).statusCode).toBe(401);
  });

  it('accounts mode: the same, before sign-in is even looked at', async () => {
    const who = await seedAccount(db);
    const gated = track(await buildServer({ db }, { config: accountsConfig({ accessCode: 'TEST-volts' }), auth: fakeAuth(who), now }));
    for (const url of ['/api/me', '/%61pi/me', '/api/%6de']) {
      expect((await gated.inject(url)).json(), url).toEqual({ error: 'access_code_required' });
      expect((await gated.inject({ url, headers: { 'x-access-code': 'TEST-volts' } })).statusCode, url).toBe(200);
    }
  });
});

// ---------------------------------------------------------- trade wording --

describe('reasons name the company\'s own trade', () => {
  const job = (over: Partial<BidDraft>): Bid => testBid(over);

  it('every catalog trade has a short name that fits in a sentence', () => {
    expect(TRADES.map((t) => tradeNoun(t.id))).toEqual([
      'electrical', 'plumbing', 'HVAC', 'fire protection', 'low voltage', 'general building', 'roofing', 'painting',
      'concrete', 'landscaping', 'flooring', 'site work', 'fencing',
    ]);
    expect(tradeNoun('TEST-no-such-trade')).toBeNull();
  });

  it('a roofer reads "Roofing", never "Electrical"', () => {
    const roofer = company(['roofing']);
    expect(reasonTexts(job({ title: 'TEST roof replacement at city hall (synthetic)' }), roofer)[0]).toBe('Roofing scope: “roof replacement”');
    expect(reasonTexts(job({ title: 'TEST roof replacement at city hall (synthetic)', naics: '238160' }), roofer)[0])
      .toBe('Roofing scope: “roof replacement” + NAICS 238160');
    expect(reasonTexts(job({ title: 'TEST building work (synthetic)', naics: '238160' }), roofer)[0]).toBe('NAICS 238160 — roofing contractors');
    expect(reasonTexts(job({ title: 'TEST building work (synthetic)', description: 'Includes shingle work.' }), roofer)[0])
      .toBe('Roofing work mentioned: “shingle”');
    expect(reasonTexts(job({ title: 'TEST tenant improvement (synthetic)' }), roofer)).toContain('General construction — check the specs for roofing');
    expect(scoreBid(job({ title: 'TEST piano tuning (synthetic)' }), roofer, NOW).rejected).toBe('No roofing or construction scope found');
  });

  it('an acronym keeps its capitals', () => {
    const hvac = company(['hvac']);
    expect(reasonTexts(job({ title: 'TEST boiler replacement (synthetic)' }), hvac)[0]).toBe('HVAC scope: “boiler”');
    expect(reasonTexts(job({ title: 'TEST tenant improvement (synthetic)' }), hvac)).toContain('General construction — check the specs for HVAC');
    expect(scoreBid(job({ title: 'TEST piano tuning (synthetic)' }), hvac, NOW).rejected).toBe('No HVAC or construction scope found');
  });

  it('a company with several trades reads "Your trades"', () => {
    const both = company(['electrical', 'plumbing']);
    expect(reasonTexts(job({ title: 'TEST backflow preventer testing (synthetic)' }), both)[0]).toBe('Your trades: “backflow”');
    expect(reasonTexts(job({ title: 'TEST building work (synthetic)', naics: '238220' }), both)[0]).toBe('NAICS 238220 — one of your trades');
    expect(reasonTexts(job({ title: 'TEST building work (synthetic)', description: 'New lighting throughout.' }), both)[0])
      .toBe('Your trades mentioned: “lighting”');
    expect(reasonTexts(job({ title: 'TEST tenant improvement (synthetic)' }), both)).toContain('General construction — check the specs for your trades');
    expect(scoreBid(job({ title: 'TEST piano tuning (synthetic)' }), both, NOW).rejected).toBe('No work in your trades or construction scope found');
  });

  it('an electrical company from the catalog reads exactly like the pilot', () => {
    const pilot = loadProfile('lm-electric');
    const twin = company(['electrical']);
    expect(pilot.trades).toBeUndefined(); // the config profile names no trade: it is electrical by default
    for (const bid of [
      job({ title: 'TEST lighting retrofit (synthetic)' }),
      job({ title: 'TEST lighting retrofit (synthetic)', naics: '238210' }),
      job({ title: 'TEST building work (synthetic)', naics: '238210' }),
      job({ title: 'TEST building work (synthetic)', description: 'Replace the switchgear.' }),
      job({ title: 'TEST tenant improvement (synthetic)' }),
      job({ title: 'TEST piano tuning (synthetic)' }),
    ]) {
      const [a, b] = [scoreBid(bid, pilot, NOW), scoreBid(bid, twin, NOW)];
      expect(b.reasons.filter((r) => !/ mi from /.test(r.text)), bid.title).toEqual(a.reasons.filter((r) => !/ mi from /.test(r.text)));
      expect(b.rejected).toBe(a.rejected);
    }
    expect(reasonTexts(job({ title: 'TEST building work (synthetic)', naics: '238210' }), twin)[0]).toBe('NAICS 238210 — electrical contractors');
    expect(scoreBid(job({ title: 'TEST piano tuning (synthetic)' }), twin, NOW).rejected).toBe('No electrical or construction scope found');
  });

  it('on the real captured bids, no other trade is ever told its work is electrical', async () => {
    const real = (await Promise.all(fixtureSources().map((s) => s.fetch(scanCtx(CAPTURED))))).flat().map(finalizeBid);
    expect(real).toHaveLength(REAL);
    const pilotWords = /^Electrical (scope|work mentioned)|electrical contractors$|specs for electrical$|^No electrical/;
    for (const trade of TRADES.filter((t) => t.id !== 'electrical')) {
      const profile = company([trade.id]);
      for (const bid of real) {
        for (const { text } of scoreBid(bid, profile, CAPTURED).reasons) expect(text, `${trade.id}: ${bid.title}`).not.toMatch(pilotWords);
      }
    }
  });
});

// -------------------------------------------------- catalog → stored profiles --

describe('a catalog edit reaches stored profiles at the next scan', () => {
  it('withCatalogLists swaps in the current lists and leaves everything else alone', () => {
    const fresh = company(['electrical', 'roofing']);
    const stale: Profile = { ...fresh, keywords: { ...fresh.keywords, strong: ['TEST-stale-word'] }, naics: { strong: [], related: [] } };
    expect(withCatalogLists(stale)).toEqual(fresh);
    expect(stale.keywords.strong).toEqual(['TEST-stale-word']); // not changed in place
  });

  it('profiles without catalog trades are returned as they are', () => {
    const pilot = loadProfile('lm-electric');
    expect(withCatalogLists(pilot)).toBe(pilot);
    const gone = { ...company(['roofing']), trades: ['TEST-retired-trade'] };
    expect(withCatalogLists(gone)).toBe(gone);
    const none = { ...company(['roofing']), trades: [] };
    expect(withCatalogLists(none)).toBe(none);
  });

  it('the scan scores an account\'s profile with today\'s lists and does not rewrite what the account saved', async () => {
    await resetDb(db);
    const owner = await seedAccount(db);
    const built = company(['electrical'], { zip: '89410' });
    // As if saved before a catalog edit: a strong list that knows none of today's words.
    const saved = await saveProfileForAccount(db, owner.id, { ...built, keywords: { ...built.keywords, strong: ['TEST-stale-word'] } });

    const profiles = scanProfiles({ db, profile: null });
    expect(typeof profiles).toBe('function');
    const report = await runScan({ db, sources: fixtureSources(), profiles, ctx: scanCtx(CAPTURED) });
    expect(report.profiles[saved.id]!.scored).toBe(REAL);
    // The State Public Works "Fire Sprinkler System Installation and Fire Alarm" job and the cell-door
    // intercom job are great fits with today's list, and nothing is with the stale one.
    expect(report.profiles[saved.id]!.byVerdict.great).toBeGreaterThanOrEqual(1);
    const staleOnly = await runScan({ db, sources: fixtureSources(), profiles: [saved], ctx: scanCtx(CAPTURED) });
    expect(staleOnly.profiles[saved.id]!.byVerdict.great).toBe(0);

    expect((await getProfileByAccount(db, owner.id))!.keywords.strong).toEqual(['TEST-stale-word']);
    expect(mergeTrades(['electrical']).keywords.strong).not.toContain('TEST-stale-word');
  });

  it('single mode scans the config profile, untouched', () => {
    const pilot = loadProfile('lm-electric');
    expect(scanProfiles({ db, profile: pilot })).toEqual([pilot]);
  });
});

// --------------------------------------------------------- offline sources --

describe('SOURCES', () => {
  it('"fixtures" means the captured pages: four boards, no SAM.gov, no network', async () => {
    const offline = selectSources('fixtures');
    expect(offline.map((s) => s.id).sort()).toEqual(['douglascounty', 'nevadaepro', 'ngem', 'questcdn']);
    for (const s of offline) expect(s.name).toMatch(/\(snapshot\)$/);
    const drafts = (await Promise.all(offline.map((s) => s.fetch(scanCtx(CAPTURED))))).flat(); // scanCtx has no network
    expect(drafts).toHaveLength(REAL);
    expect(drafts.filter((d) => /^TEST-/.test(d.sourceId))).toEqual([]);
    expect(selectSources(' Fixtures ').map((s) => s.name)).toEqual(offline.map((s) => s.name));
  });

  it('blank means every live source and a list limits them, as before', () => {
    expect(selectSources()).toBe(ALL_SOURCES);
    expect(selectSources('')).toBe(ALL_SOURCES);
    expect(selectSources('ngem, QuestCDN').map((s) => s.id)).toEqual(['questcdn', 'ngem']);
    expect(selectSources('TEST-no-such-source')).toEqual([]);
  });
});

// ------------------------------------------------------------ trusted proxy --

describe('trustProxy (TRUST_PROXY)', () => {
  /** Eleven wrong sign-ins, each from a different caller behind one proxy at 10.0.0.5. */
  async function elevenCallers(trustProxy?: string): Promise<number[]> {
    await resetDb(db);
    const config = accountsConfig();
    const app = track(await buildServer({ db }, { config, now, auth: createAuth(db, config, { now, cost: COST }), trustProxy }));
    const codes: number[] = [];
    for (let i = 1; i <= 11; i++) {
      const res = await app.inject({
        method: 'POST', url: '/api/auth/login', remoteAddress: '10.0.0.5',
        headers: { ...CSRF, 'x-forwarded-for': `203.0.113.${i}` },
        payload: { email: `test-caller-${i}@example.com`, password: 'TEST-wrong-password' },
      });
      codes.push(res.statusCode);
    }
    return codes;
  }

  it('without it, callers behind a proxy on another machine share one sign-in allowance', async () => {
    expect(await elevenCallers()).toEqual([...Array(10).fill(401), 429]);
  });

  it('with the proxy\'s range trusted, each caller has their own', async () => {
    expect(await elevenCallers('10.0.0.0/8')).toEqual(Array(11).fill(401));
  });

  it('a proxy that is not on the list is still not believed', async () => {
    expect(await elevenCallers('192.168.0.0/16')).toEqual([...Array(10).fill(401), 429]);
  });
});

// -------------------------------------------------- accounts mode, end to end --

describe('accounts mode, end to end', () => {
  const testVapid = { ...generateVAPIDKeys(), subject: 'mailto:test@example.com' };
  const pushes: PushMessage[] = [];
  const events: BusEvent['type'][] = [];
  let app: FastifyInstance;
  let bus: Bus;
  let rt: Realtime;
  let extra: BidDraft[] = []; // synthetic bids "posted" on top of the captured pages
  let scan: () => Promise<ScanReport>;
  let cookie = '';
  let other = '';

  const draft = (sourceId: string, over: Partial<BidDraft> = {}): BidDraft => ({
    source: 'samgov', sourceId, sourceName: 'TEST source', title: 'TEST electrical panel upgrade (synthetic)', agency: 'TEST agency',
    description: null, category: null, location: { city: 'Carson City', state: 'NV' }, postedAt: null, dueAt: '2026-12-02T22:00:00.000Z',
    estValue: null, naics: null, setAside: null, url: 'https://example.com/test-bid', ...over,
  });

  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, session = cookie, headers: Record<string, string> = CSRF) =>
    app.inject({ method, url, headers: { ...headers, ...(session ? { cookie: session } : {}) }, ...(payload ? { payload } : {}) });
  const get = (url: string, session = cookie) => call('GET', url, undefined, session, {});
  const items = async (qs = '', session = cookie): Promise<FeedItem[]> => {
    const res = await get(`/api/feed${qs && `?${qs}`}`, session);
    expect(res.statusCode, `${qs} → ${res.body}`).toBe(200);
    return res.json().items as FeedItem[];
  };
  const inbox = async (session = cookie): Promise<Alert[]> => (await get('/api/alerts?limit=200', session)).json().items as Alert[];
  /** The session cookie a sign-in response sets, as a browser would send it back. */
  const sessionOf = (res: { headers: Record<string, unknown> }): string => String(res.headers['set-cookie']).split(';')[0]!;

  const ANSWERS = {
    businessName: 'TEST Owner Electric (simulated)', trades: ['electrical'], zip: '89410', radiusMi: 90,
    valueRange: { min: 10_000, max: 50_000 }, limits: { maxJobSize: 100_000 },
  };

  beforeAll(async () => {
    await resetDb(db);
    bus = createBus();
    for (const type of ['match', 'scan', 'alert'] as const) bus.on(type, (e) => void events.push(e.type));
    const config = accountsConfig({ demoMode: true, adminToken: 'TEST-admin', vapid: testVapid });
    const extraSource: Source = { id: 'samgov', name: 'TEST source', homepage: '', fetch: async () => extra };
    scan = () => runScan({ db, sources: [...fixtureSources(), extraSource], profiles: scanProfiles({ db, profile: null }), ctx: scanCtx(CAPTURED), bus });
    const built = await buildApp({ db }, { config, bus, auth: createAuth(db, config, { now, cost: COST }), scan, now });
    app = track(built.app);
    rt = createRealtime(built.ctx, { sender: async (_device, message) => (pushes.push(message), { ok: true }), tickMs: 0, coalesceMs: 0 });
    await scan(); // the boards are loaded before anyone has signed up
  });
  afterAll(() => rt.stop());

  it('signed out: the sign-in options are public, everything else answers 401', async () => {
    expect((await get('/api/auth/config', '')).json()).toEqual({ mode: 'accounts', providers: ['password'], demo: true });
    for (const url of ['/api/me', '/api/feed', '/api/next', '/api/alerts', '/api/saved']) {
      const res = await get(url, '');
      expect(res.statusCode, url).toBe(401);
      expect(res.json(), url).toEqual({ error: 'sign_in_required' });
    }
    expect((await get('/api/health', '')).json()).toMatchObject({ ok: true, profile: null });
    expect((await get('/api/trades', '')).json().trades).toHaveLength(TRADES.length);
    expect((await get('/api/geo/zip/89410', '')).json()).toMatchObject({ zip: '89410', city: 'Gardnerville', state: 'NV' });
  });

  it('sign up → a session cookie the page cannot read, and onboarding to do', async () => {
    const res = await call('POST', '/api/auth/signup', { email: 'owner@example.com', password: 'TEST-correct-horse', name: 'TEST Owner (simulated)' }, '');
    expect(res.statusCode).toBe(201);
    expect(String(res.headers['set-cookie'])).toMatch(/^bs_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    expect(res.json().account).toMatchObject({ email: 'owner@example.com', plan: 'free' });
    expect(res.body).not.toMatch(/password|hash/i);
    cookie = sessionOf(res);

    const me = (await get('/api/me')).json();
    expect(me).toMatchObject({ needsOnboarding: true, profile: null, account: { email: 'owner@example.com' } });
    // DEMO_MODE: the account row says free, the features are the pilot's.
    expect(me.features).toMatchObject({ instantPush: true, awardHistory: true, costSettings: true, awardWatch: true, priceAlerts: true });
    expect((await get('/api/feed')).json()).toEqual({ error: 'onboarding_required' });
  });

  it('a signed-in write without x-bidswipe is refused, and so is any sign-in attempt', async () => {
    const forged = await call('PUT', '/api/profile', ANSWERS, cookie, {});
    expect(forged.statusCode).toBe(403);
    expect(forged.json()).toEqual({ error: 'csrf' });
    expect((await get('/api/me')).json().needsOnboarding).toBe(true); // nothing was saved
    const login = await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'TEST-correct-horse' }, '', {});
    expect(login.statusCode).toBe(403);
  });

  it('onboarding: answers → profile → every open bid scored at once', async () => {
    const res = await call('PUT', '/api/profile', ANSWERS);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().scored).toBe(REAL);
    expect(res.json().profile).toMatchObject({
      businessName: 'TEST Owner Electric (simulated)', trades: ['electrical'], zip: '89410', base: 'Gardnerville, NV', radiusMi: 90,
      valueRange: { min: 10_000, max: 50_000 }, limits: { maxJobSize: 100_000 }, alerts: { minScore: 55 },
    });
    const me = (await get('/api/me')).json();
    expect(me).toMatchObject({ needsOnboarding: false, name: 'TEST Owner Electric (simulated)', base: 'Gardnerville, NV', maxDistanceMi: 90, notifyMinScore: 55 });
    expect(me.id).toBe(me.profile.id);
  });

  it('the feed: the deck by default, then search, distance, deadline and sort', async () => {
    const all = await items('all=1&minScore=0&limit=300');
    expect(all).toHaveLength(REAL);
    const deck = await items();
    expect(deck.length).toBeGreaterThanOrEqual(3);
    expect(deck.map((b) => b.id).sort()).toEqual(all.filter((b) => b.score >= 35).map((b) => b.id).sort());
    expect(deck.map((b) => b.score)).toEqual([...deck.map((b) => b.score)].sort((a, b) => b - a));
    expect(deck[0]!.reasons[0]!.text).toMatch(/^Electrical scope: “/);

    // The 2026-11-13 capture has one fire alarm job (State Public Works' sprinkler + fire alarm install).
    const alarm = await items('all=1&minScore=0&q=fire+alarm');
    expect(alarm.length).toBeGreaterThanOrEqual(1);
    for (const b of alarm) expect(`${b.title} ${b.description} ${b.category}`.toLowerCase()).toContain('alarm');

    const near = await items('all=1&minScore=0&maxDistance=30&sort=near');
    expect(near.length).toBeGreaterThanOrEqual(1);
    expect(near.every((b) => b.distanceMi !== null && b.distanceMi <= 30)).toBe(true);
    expect(near.map((b) => b.distanceMi)).toEqual([...near.map((b) => b.distanceMi!)].sort((a, b) => a - b));
    expect(near.map((b) => b.id).sort()).toEqual(all.filter((b) => b.distanceMi !== null && b.distanceMi <= 30).map((b) => b.id).sort());

    const soon = await items('all=1&minScore=0&dueWithinDays=7&sort=due');
    const weekOut = CAPTURED.getTime() + 7 * 86_400_000;
    expect(soon.length).toBeGreaterThanOrEqual(1);
    expect(soon.every((b) => b.dueAt !== null && Date.parse(b.dueAt) <= weekOut)).toBe(true);
    expect(soon.map((b) => b.dueAt)).toEqual([...soon.map((b) => b.dueAt!)].sort());

    expect((await get('/api/feed?sort=TEST-sideways')).json()).toMatchObject({ error: 'invalid_query' });
  });

  it('the next bid is one from the deck, with its reasons', async () => {
    const deck = await items();
    const next = (await get('/api/next')).json() as { item: FeedItem | null; why: string[] };
    expect(deck.map((b) => b.id)).toContain(next.item!.id);
    expect(next.why[0]).toMatch(/ fit — \d+ out of 100$/);
    expect(next.why.length).toBeGreaterThanOrEqual(2);
  });

  it('the inbox holds one alert per good fit; bids that were already posted do not buzz a phone', async () => {
    await rt.flush();
    const good = (await items('all=1&minScore=55&limit=300')).filter((b) => !b.overLimit);
    const alerts = await inbox();
    expect(good.length).toBeGreaterThanOrEqual(1);
    expect(alerts.map((a) => a.bidId).sort()).toEqual(good.map((b) => b.id).sort());
    for (const a of alerts) {
      expect(a.kind).toBe('match');
      expect(a.title).toMatch(/^(Great|Good) fit \(\d+\)/);
      expect(a.pushedAt).toBeNull();
    }
    expect(pushes).toEqual([]);
  });

  it('scanning the same pages again adds nothing: no new bids, no second alert', async () => {
    const before = await inbox();
    events.length = 0;
    const report = await scan();
    await rt.flush();
    expect(report).toMatchObject({ totalBids: REAL, newBids: 0 });
    expect(events.filter((e) => e === 'match')).toHaveLength(before.length); // re-announced on the bus…
    expect(events.filter((e) => e === 'alert')).toEqual([]); // …and recognised as already told
    expect(events.at(-1)).toBe('scan');
    expect((await inbox()).map((a) => a.id)).toEqual(before.map((a) => a.id));
    expect(pushes).toEqual([]);
  });

  it('a bid that is new to the boards: one alert, one push to the registered phone, never a second', async () => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const subscription = {
      endpoint: 'https://push.example.com/send/TEST-device-owner',
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
    };
    expect((await call('POST', '/api/push/subscribe', { subscription })).json()).toEqual({ ok: true, instantPush: true });

    extra = [draft('TEST-new-panel')];
    const before = (await inbox()).length;
    expect((await scan()).newBids).toBe(1);
    await rt.flush();
    const alerts = await inbox();
    expect(alerts).toHaveLength(before + 1);
    expect(alerts[0]).toMatchObject({ kind: 'match', bidId: 'samgov:TEST-new-panel' });
    expect(alerts[0]!.body).toMatch(/^TEST electrical panel upgrade \(synthetic\) — Electrical scope: “electric” · \d+ days left$/);
    expect(alerts[0]!.pushedAt).not.toBeNull();
    expect(pushes).toHaveLength(1);
    const payload = JSON.parse(pushes[0]!.payload) as PushPayload;
    expect(payload).toMatchObject({ kind: 'match', bidId: 'samgov:TEST-new-panel', alertIds: [alerts[0]!.id] });

    await scan();
    await rt.flush();
    expect(await inbox()).toHaveLength(before + 1);
    expect(pushes).toHaveLength(1);
  });

  it('a job over the spend limit: tagged in Browse, never in the deck, the next pick or an alert', async () => {
    extra = [...extra, draft('TEST-too-big', { title: 'TEST electrical service upgrade, large (synthetic)', estValue: { min: 250_000, max: 250_000 } })];
    await scan();
    await rt.flush();
    const big = (await items('all=1&minScore=0&limit=300')).find((b) => b.id === 'samgov:TEST-too-big')!;
    expect(big.overLimit).toBe(true);
    expect(big.score).toBeGreaterThanOrEqual(55); // a good fit on trade and distance: only the limit keeps it out
    expect(big.reasons.map((r) => r.text)).toContain('Est. $250K — over your $100K job limit');
    expect((await items('minScore=0&limit=300')).map((b) => b.id)).not.toContain(big.id);
    expect((await items('all=1&minScore=0&overLimit=only')).map((b) => b.id)).toEqual([big.id]);
    expect((await get('/api/next')).json().item.id).not.toBe(big.id);
    expect((await inbox()).map((a) => a.bidId)).not.toContain(big.id);
    expect(pushes).toHaveLength(1);
  });

  it('a second company sees its own feed and inbox, and nothing of the first', async () => {
    const signup = await call('POST', '/api/auth/signup', { email: 'roofer@example.com', password: 'TEST-battery-staple' }, '');
    expect(signup.statusCode).toBe(201);
    other = sessionOf(signup);
    const onboard = await call('PUT', '/api/profile', {
      businessName: 'TEST Roofer (simulated)', trades: ['roofing'], zip: '89701', radiusMi: 60, valueRange: { min: 10_000, max: 250_000 },
    }, other);
    expect(onboard.statusCode, onboard.body).toBe(200);
    expect(onboard.json().scored).toBe(REAL + 2); // the real bids and the two synthetic ones

    const roofs = await items('', other);
    expect(roofs.length).toBeGreaterThanOrEqual(3); // the three real Carson City re-roofs
    expect(roofs[0]!.reasons[0]!.text).toBe('Roofing scope: “roofing”');
    expect(roofs.map((b) => b.id)).not.toContain('samgov:TEST-new-panel'); // electrical work is not a roofer's

    const [mine, theirs] = [await inbox(), await inbox(other)];
    expect(theirs.length).toBeGreaterThanOrEqual(1);
    expect(new Set(theirs.map((a) => a.profileId)).size).toBe(1);
    expect(theirs.map((a) => a.id).filter((id) => mine.some((a) => a.id === id))).toEqual([]);
    expect(theirs[0]!.profileId).not.toBe(mine[0]!.profileId);

    // Marking everything read is per company.
    expect((await call('POST', '/api/alerts/read', { all: true }, other)).json()).toMatchObject({ ok: true, updated: theirs.length, unread: 0 });
    expect((await get('/api/alerts?unread=1&limit=200')).json().items).toHaveLength(mine.length);
    // The same bid, each company's own verdict.
    const bidId = encodeURIComponent(roofs[0]!.id);
    expect((await get(`/api/bids/${bidId}`, other)).json().score).toBe(roofs[0]!.score);
    expect((await get(`/api/bids/${bidId}`)).json().score).toBeLessThan(roofs[0]!.score);
    expect(pushes).toHaveLength(1); // the roofer registered no phone, and these bids were not new
  });

  it('the stored profiles are what each company saved', async () => {
    const me = (await get('/api/me')).json();
    const stored = (await getProfile(db, me.id))!;
    expect(stored).toMatchObject({ name: 'TEST Owner Electric (simulated)', trades: ['electrical'], zip: '89410', limits: { maxJobSize: 100_000 } });
    expect(stored.keywords).toEqual(mergeTrades(['electrical']).keywords);
  });

  it('log out ends the session; the old cookie is worth nothing', async () => {
    const out = await call('POST', '/api/auth/logout');
    expect(out.json()).toEqual({ ok: true });
    expect(String(out.headers['set-cookie'])).toMatch(/^bs_session=; .*Max-Age=0/);
    for (const url of ['/api/me', '/api/feed', '/api/alerts']) expect((await get(url)).statusCode, url).toBe(401);
    // No cookie at all: nothing to forge, so the handler answers (401), not the CSRF guard.
    expect((await call('POST', '/api/swipe', { bidId: 'samgov:TEST-new-panel', action: 'save' }, '', {})).statusCode).toBe(401);
    expect((await get('/api/me', other)).statusCode).toBe(200); // the other company is still signed in
  });

  it('signing back in works with the password and nothing else', async () => {
    expect((await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'TEST-wrong' }, '')).statusCode).toBe(401);
    const back = await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'TEST-correct-horse' }, '');
    expect(back.statusCode).toBe(200);
    expect((await get('/api/me', sessionOf(back))).json()).toMatchObject({ needsOnboarding: false, name: 'TEST Owner Electric (simulated)' });
  });

  it('the admin scan route runs the server\'s own scan and reports it', async () => {
    expect((await call('POST', '/api/admin/scan', undefined, '', {})).json()).toEqual({ error: 'admin_token_required' });
    const res = await call('POST', '/api/admin/scan', undefined, '', { 'x-admin-token': 'TEST-admin' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totalBids: REAL + 2, newBids: 0 });
    expect(Object.keys(res.json().profiles)).toHaveLength(2);
  });
});

// ------------------------------------------------------------- single mode --

describe('single mode is still the pilot', () => {
  it('scan → /api/me and /api/feed in the v0 shapes, no sign-in, no CSRF header', async () => {
    await resetDb(db);
    const pilot = loadProfile('lm-electric');
    const bus = createBus();
    await runScan({ db, sources: fixtureSources(), profiles: scanProfiles({ db, profile: pilot }), ctx: scanCtx(CAPTURED), bus });
    const app = track(await buildServer({ db, profile: pilot }, { now }));

    expect((await app.inject('/api/me')).json()).toEqual({
      id: 'lm-electric', name: 'L&M Electric', base: 'Gardnerville, NV', maxDistanceMi: 90, valueRange: { min: 10_000, max: 50_000 }, notifyMinScore: 55,
    });
    const feed = (await app.inject('/api/feed?all=1&minScore=0&limit=300')).json();
    expect(Object.keys(feed).sort()).toEqual(['items', 'lastScan']);
    expect(feed.items).toHaveLength(REAL);
    expect((feed.items as FeedItem[]).every((b) => b.overLimit === false)).toBe(true); // the pilot has set no limits
    const best = (feed.items as FeedItem[])[0]!;
    expect(best.reasons[0]!.text).toMatch(/^Electrical scope: “/);
    expect((await app.inject({ method: 'POST', url: '/api/swipe', payload: { bidId: best.id, action: 'save' } })).json()).toEqual({ ok: true });
    expect((await app.inject('/api/auth/config')).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/api/profile', payload: {} })).json()).toMatchObject({ error: 'single_profile_mode' });
  });

  it('a simulated twin of the pilot built from the catalog matches it bid for bid at the same base', () => {
    const pilot = loadProfile('lm-electric');
    const twin = testProfile('test-twin', { ...mergeTrades(['electrical']), trades: ['electrical'] });
    const bid = testBid({ title: 'TEST lighting retrofit (synthetic)' });
    expect(scoreBid(bid, twin, NOW)).toEqual(scoreBid(bid, pilot, NOW));
  });
});
