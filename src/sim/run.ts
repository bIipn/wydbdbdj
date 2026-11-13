/**
 * The multi-company simulation (`npm run simulate`): simulated companies use the real server end to end on
 * the REAL captured bids, and the run measures how fast it reacts.
 *
 *   1. An in-memory database, AUTH_MODE=accounts WITHOUT demo mode (plan gates are real; Pro is granted
 *      with the admin route), the server listening on a local port, alerts on (push off: no devices).
 *   2. Scan 1: every captured board, SAM.gov included, at the capture clock, minus a few real bids held back.
 *   3. Every company signs up, is made Pro when its persona is, onboards with PUT /api/profile, looks at its
 *      deck and opens its live stream (GET /api/stream).
 *   4. Scan 2 brings the held-back bids in: each resulting alert is timed from the moment the scan's source
 *      returned the bid to the alert being stored and to the stream delivering it.
 *   5. Scan 3 repeats scan 2 exactly: it must create nothing.
 *   6. Every company reads its deck, Browse, three filters, the next bid, its inbox, market awards / area /
 *      watch, and runs a cost check on its best bid (a simulated takeoff); free plans must get 402.
 *   7. The checks (src/sim/checks.ts) run on what the API answered. Then scoring speed and a scale pass.
 *
 * `mutation` breaks one rule on purpose through a seam (the profiles the scan scores, the bus the scan
 * publishes on, or an onSend hook on the answer) to prove the matching check catches it.
 */
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { cpus as osCpus, platform as osPlatform, release as osRelease } from 'node:os';
import { performance } from 'node:perf_hooks';
import { scanProfiles } from '../app.js';
import { createAuth } from '../auth/index.js';
import { loadConfig, type AppConfig } from '../context.js';
import { openDb, type Db } from '../db/db.js';
import { awardCounts, seriesCounts } from '../db/market.js';
import { getProfile } from '../db/repo.js';
import { buildProfile, profileIdFor, type OnboardingAnswers } from '../profile/build.js';
import { createBus, type Bus, type BusEvent } from '../realtime/bus.js';
import { createRealtime } from '../realtime/index.js';
import { finalizeBid, runScan, type ScanReport } from '../scan.js';
import { isCandidate } from '../score/candidates.js';
import { scoreBid } from '../score/score.js';
import { buildApp } from '../server.js';
import { mergeDrafts } from '../sources/dedupe.js';
import { fixtureReaders, FIXTURES_CAPTURED_AT } from '../sources/fixtures.js';
import { mergeTrades } from '../trades/catalog.js';
import type { Alert, Bid, BidDraft, FeedItem, Profile, Source, SourceContext, SourceId } from '../types.js';
import { Rng } from '../cost/synthetic.js';
import { checkCoverage, checkPersona, electricalOnly, isReserved, PERSONA_CHECKS, pipeOnly, type CheckId, type PersonaObs, type Violation } from './checks.js';
import { clockMs, openStreams, SimClient, type StreamReaders } from './http.js';
import { PERSONAS, type Persona } from './personas.js';
import { simTakeoff, targetDollars } from './takeoff.js';

export type MutationId =
  | 'radius' | 'spend-limit' | 'certification' | 'trade' | 'alert-reason' | 'alert-missing' | 'repeat-scan'
  | 'free-no-premium' | 'estimate-not-silent' | 'stream-cut' | 'browse-missing' | 'nondeterministic';

/** Which check each mutation must trip. */
/**
 * selfTest: the mutation rewrites the answer the checker reads because no real bid can exercise the product
 * rule (no captured bid states an estimated value). It proves the checker reads the flag, not that the
 * product's rule is tested, so the report counts it apart from the mutations caught.
 */
export const MUTATIONS: Readonly<Record<MutationId, { check: CheckId; how: string; selfTest?: true }>> = {
  radius: { check: 'radius', how: 'the scan scores every profile with a 3,000-mile radius' },
  'spend-limit': { check: 'spend-limit', how: 'the deck answer marks its first bid over the spend limit (no captured bid carries an estimate, so a scan-side mutation could not produce one)', selfTest: true },
  certification: { check: 'certification', how: 'the scan scores every profile as if it held every set-aside certification' },
  trade: { check: 'trade', how: 'the scan gives plumbing/HVAC profiles the electrical word lists, and electrical profiles the plumbing and HVAC lists' },
  'alert-reason': { check: 'alert-reason', how: 'the scan publishes its matches with the reasons stripped' },
  'alert-missing': { check: 'alert-missing', how: 'scans 2 and 3 publish no matches at all (the alert path is cut)' },
  'repeat-scan': { check: 'repeat-scan', how: 'the repeat scan publishes its matches under a changed bid id (de-duplication bypassed)' },
  'free-no-premium': { check: 'free-no-premium', how: 'the locked market-awards answer gets a median price added' },
  'estimate-not-silent': { check: 'estimate-not-silent', how: 'the estimate answer is turned into a "complete" estimate with a total of 0' },
  'stream-cut': { check: 'stream-delivery', how: "the bus drops every 'alert' event, so stored alerts never reach an open stream" },
  'browse-missing': { check: 'browse-complete', how: 'the scan\'s candidate filter uses a quarter of each radius and no home states, so it drops bids worth a look' },
  nondeterministic: { check: 'determinism', how: 'the takeoff seed takes the clock as well as --seed' },
};

export interface SimOptions {
  seed: number;
  /** 0 = any free port. */
  port?: number;
  personas?: readonly Persona[];
  /** Real bids held out of scan 1 and brought in by scan 2 (default 4). */
  holdOut?: number;
  /** Profile variations in the scale pass (default 1000; 0 = skip). */
  scaleProfiles?: number;
  /** Also run the scale pass through the database (runScan with every variation). Default true. */
  scaleDb?: boolean;
  /** Minimum milliseconds for the scoring-speed loop (default 1000). */
  speedMs?: number;
  mutation?: MutationId;
  /** Lighter password hashing (tests). The default is the server's real cost. */
  fastHash?: boolean;
  fixturesDir?: string;
  log?: (msg: string) => void;
}

const ADMIN_TOKEN = 'SIM-admin-token-not-a-secret';
const CAPTURED = FIXTURES_CAPTURED_AT;

// ------------------------------------------------------------- the report --

export interface PersonaRow {
  key: string;
  name: string;
  email: string;
  town: string;
  plan: 'free' | 'pro';
  trades: string[];
  radiusMi: number;
  /** Simulated settings the persona typed. */
  valueRange: { min: number; max: number };
  limits: { maxJobSize: number | null; bondingCapacity: number | null };
  setAsides: string[];
  reason: string;
  bidsSeen: number;
  verdicts: { great: number; good: number; maybe: number; skip: number };
  deck: number;
  alerts: number;
  alertsFromScan2: number;
  overLimit: number;
  noEstimate: number;
  unknownDistance: number;
  withinRadius: number;
  next: { id: string; title: string; score: number; why: string[] } | null;
  topFits: Array<{ id: string; title: string; score: number; verdict: string; place: string | null; distanceMi: number | null }>;
  reservedSeen: Array<{ id: string; setAside: string; score: number; verdict: string; firstReason: string }>;
  cost: { bidId: string | null; verdict: string; status: number; total: number | null; needed: string[]; quick: string; sizedTo: number | null; notes: string[] };
  market: { awards: string; area: string; watch: string };
}

export interface SimReport {
  seed: number;
  mutation: MutationId | null;
  capturedAt: string;
  bids: { total: number; open: number; bySource: Record<string, { total: number; open: number }>; heldOut: Array<{ id: string; title: string }> };
  personas: PersonaRow[];
  /** total = check runs (check × company) that evaluated at least one item; coverage = per check, companies and items evaluated. */
  checks: { total: number; violations: Violation[]; byCheck: Record<string, number>; coverage: Record<string, { companies: number; items: number }> };
  findings: string[];
  coverage: Array<{ key: string; town: string; open: number; inRadius: number; deck: number; boardsNeeded: string }>;
}

export interface SimMeasurements {
  machine: { node: string; platform: string; cpus: number; cpuModel: string };
  scans: Array<{ name: string; ms: number; totalBids: number; newBids: number }>;
  latency: Array<{ persona: string; bidId: string; seenToStoredMs: number; seenToStreamMs: number | null }>;
  latencySummary: {
    alerts: number; storedMs: Dist; streamMs: Dist | null;
    /** From the held-out bids being seen to scan 2 publishing its 'scan' event (the end of the scan), and to the stream's 'scan' frame. */
    seenToScanEndMs: number | null; seenToScanFrameMs: Dist | null;
  };
  requests: Record<string, Dist & { n: number }>;
  scoring: { pairs: number; ms: number; pairsPerSecond: number };
  scale: null | {
    profiles: number; bids: number; pairs: number;
    pure: { ms: number; pairsPerSecond: number; heapDeltaMb: number };
    db: null | { ms: number; matchesStored: number; peakRssMb: number; rssBeforeMb: number; heapAfterMb: number };
  };
  totalMs: number;
}

export interface Dist { min: number; p50: number; p95: number; max: number }

export interface SimResult {
  report: SimReport;
  measurements: SimMeasurements;
  /** sha256 of the report (everything but the measurements). Same seed → same hash. */
  hash: string;
}

const dist = (xs: number[]): Dist => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]! : 0);
  const r = (n: number) => Math.round(n * 100) / 100;
  return { min: r(s[0] ?? 0), p50: r(q(0.5)), p95: r(q(0.95)), max: r(s.at(-1) ?? 0) };
};

/** Canonical JSON (sorted keys) for the hash. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const reportHash = (r: SimReport): string => createHash('sha256').update(canonical(r)).digest('hex');

// --------------------------------------------------------------- the world --

/** Every real captured bid, merged by id the way the scan merges them. */
export function capturedDrafts(dir?: string): BidDraft[] {
  return fixtureReaders(dir, { samgov: true }).flatMap((r) => r.read());
}

const isOpen = (b: Pick<Bid, 'dueAt'>, now: Date) => !b.dueAt || Date.parse(b.dueAt) > now.getTime();

/** The real bids to hold out of scan 1: ones that should alert at least one company, picked by the seed. */
export function pickHoldOut(bids: Bid[], personas: readonly Persona[], seed: number, n: number): string[] {
  const profiles = personas.map((p) => buildProfile(`hold-${p.key}`, p.answers));
  const alerting = bids
    .filter((b) => isOpen(b, CAPTURED))
    .filter((b) => profiles.some((pr) => {
      const s = scoreBid(b, pr, CAPTURED);
      return s.score >= (pr.alerts?.minScore ?? pr.notify.minScore) && !s.rejected && !s.overLimit && !s.capped;
    }))
    .map((b) => b.id)
    .sort();
  const g = new Rng((seed ^ 0x5bd1e995) >>> 0);
  const picked: string[] = [];
  while (picked.length < Math.min(n, alerting.length)) {
    const id = alerting[g.int(0, alerting.length - 1)]!;
    if (!picked.includes(id)) picked.push(id);
  }
  return picked.sort();
}

/** Real companies' profiles as the scan would score them under a mutation (the seam for scan-side rules). */
function mutateProfile(p: Profile, mutation: MutationId | undefined): Profile {
  if (mutation === 'radius') return { ...p, maxDistanceMi: 3000 };
  if (mutation === 'certification') return { ...p, setAsidesEligible: ['SBA', 'SBP', '8A', '8AN', 'HZC', 'HZS', 'SDVOSBC', 'SDVOSBS', 'WOSB', 'WOSBSS', 'EDWOSB', 'EDWOSBSS', 'VSA', 'VSS', 'IEE', 'ISBEE', 'BICiv'] };
  if (mutation === 'trade') {
    const trades = p.trades ?? [];
    const pipe = trades.length > 0 && trades.every((t) => t === 'plumbing' || t === 'hvac');
    const elec = trades.length > 0 && trades.every((t) => t === 'electrical' || t === 'low-voltage');
    if (pipe || elec) {
      const mix = mergeTrades(pipe ? [...trades, 'electrical'] : [...trades, 'plumbing', 'hvac']);
      return { ...p, keywords: mix.keywords, naics: mix.naics };
    }
  }
  return p;
}

/** A bus the scan publishes on: forwards to the real one, changing 'match' events under a mutation. */
function scanBus(real: Bus, mutation: MutationId | undefined, phase: () => string): Bus {
  if (mutation !== 'alert-reason' && mutation !== 'repeat-scan' && mutation !== 'alert-missing') return real;
  return {
    on: real.on, off: real.off,
    emit: (e: BusEvent) => {
      if (e.type === 'match' && mutation === 'alert-missing' && phase() !== 'first') return Promise.resolve();
      if (e.type === 'match' && mutation === 'alert-reason') return real.emit({ ...e, score: { ...e.score, reasons: [] } });
      if (e.type === 'match' && mutation === 'repeat-scan' && phase() === 'repeat') return real.emit({ ...e, bid: { ...e.bid, id: `${e.bid.id}#again` } });
      return real.emit(e);
    },
  };
}

// --------------------------------------------------------------- the run --

export async function runSimulation(opts: SimOptions): Promise<SimResult> {
  const t0 = performance.now();
  const log = opts.log ?? (() => {});
  const personas = opts.personas ?? PERSONAS;
  const mutation = opts.mutation;
  const seed = opts.seed;
  const takeoffSeed = mutation === 'nondeterministic' ? (seed ^ Number(process.hrtime.bigint() & 0xffffn)) >>> 0 : seed;

  // ---- the captured bids
  const drafts = capturedDrafts(opts.fixturesDir);
  const merged = mergeDrafts(drafts).map(finalizeBid);
  const heldOut = new Set(pickHoldOut(merged, personas, seed, opts.holdOut ?? 4));
  let phase: 'first' | 'second' | 'repeat' = 'first';
  const seenAt = new Map<string, number>();
  const bySource = new Map<SourceId, BidDraft[]>();
  for (const d of drafts) bySource.set(d.source, [...(bySource.get(d.source) ?? []), d]);
  const sources: Source[] = [...bySource.entries()].map(([id, list]) => ({
    id, name: `${id} (captured 2026-11-13)`, homepage: '',
    fetch: async () => {
      const out = phase === 'first' ? list.filter((d) => !heldOut.has(`${d.source}:${d.sourceId}`)) : list;
      const at = clockMs();
      if (phase === 'second') for (const d of out) if (heldOut.has(`${d.source}:${d.sourceId}`)) seenAt.set(`${d.source}:${d.sourceId}`, at);
      return out;
    },
  }));

  // ---- the server
  const db: Db = await openDb({ dataDir: 'memory://' });
  const bus = createBus((err, event) => log(`! bus listener failed on ${event.type}: ${err instanceof Error ? err.message : String(err)}`));
  if (mutation === 'stream-cut') {
    // The seam: stored alerts are never announced on the bus, so the open streams never hear of them.
    const emit = bus.emit.bind(bus);
    bus.emit = async (event) => (event.type === 'alert' ? undefined : emit(event));
  }
  const config: AppConfig = { ...loadConfig({ AUTH_MODE: 'accounts' }), demoMode: false, adminToken: ADMIN_TOKEN };
  const sourceCtx: SourceContext = { http: { text: async () => '', json: async () => ({}) as never }, now: CAPTURED, env: () => undefined, log };
  const baseProfiles = scanProfiles({ db, profile: null });
  const profilesForScan = async (): Promise<Profile[]> => {
    const list = typeof baseProfiles === 'function' ? await baseProfiles() : baseProfiles;
    return list.map((p) => mutateProfile(p, mutation));
  };
  const busForScan = scanBus(bus, mutation, () => phase);
  // The 'browse-missing' seam: a candidate filter that is far too tight (it stores fewer bids than it must).
  const candidate = mutation === 'browse-missing'
    ? (p: Profile, b: Bid) => isCandidate({ ...p, maxDistanceMi: Math.round(p.maxDistanceMi / 4), states: [] }, b)
    : undefined;
  const scan = (): Promise<ScanReport> => runScan({ db, sources, profiles: profilesForScan, ctx: sourceCtx, bus: busForScan, ...(candidate ? { candidate } : {}) });
  const { app, ctx } = await buildApp({ db }, {
    config, bus, scan, now: () => CAPTURED,
    auth: createAuth(db, config, { now: () => CAPTURED, ...(opts.fastHash ? { cost: { ln: 10, r: 8, p: 1 } } : {}) }),
  });
  installResponseMutation(app, mutation);
  const realtime = createRealtime(ctx, { sender: null, tickMs: 0 });
  await app.listen({ port: opts.port ?? 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  log(`server on 127.0.0.1:${port} (accounts mode, demo off, clock ${CAPTURED.toISOString()})`);

  const requestTimes = new Map<string, number[]>();
  const timed = async <T>(label: string, work: Promise<{ ms: number } & T>): Promise<T & { ms: number }> => {
    const r = await work;
    requestTimes.set(label, [...(requestTimes.get(label) ?? []), r.ms]);
    return r;
  };
  const admin = new SimClient(port, '198.51.100.250', { 'x-admin-token': ADMIN_TOKEN });
  const scans: SimMeasurements['scans'] = [];
  const runAdminScan = async (name: string) => {
    const r = await timed('POST /api/admin/scan', admin.call<ScanReport>('POST', '/api/admin/scan'));
    if (r.status !== 200) throw new Error(`admin scan answered ${r.status}: ${JSON.stringify(r.body)}`);
    scans.push({ name, ms: Math.round(r.ms), totalBids: r.body.totalBids, newBids: r.body.newBids });
    return r.body;
  };

  let streams: StreamReaders | null = null;
  try {
    // ---- scan 1: the boards, before anyone signs up
    await runAdminScan('scan 1 (held-out bids missing)');
    log(`scan 1: ${scans[0]!.totalBids} bids, ${heldOut.size} held out`);

    // ---- every company signs up and onboards
    const obs = new Map<string, PersonaObs>();
    const clients = new Map<string, SimClient>();
    const profileIds = new Map<string, string>();
    for (const [i, p] of personas.entries()) {
      const xff = `203.0.113.${i + 1}`;
      const c = new SimClient(port, xff);
      clients.set(p.key, c);
      const signup = await timed('POST /api/auth/signup', c.call('POST', '/api/auth/signup', { email: p.email, password: p.password, name: `SIM owner of ${p.key} (simulated)` }));
      if (signup.status !== 201) throw new Error(`${p.key}: sign-up answered ${signup.status}: ${JSON.stringify(signup.body)}`);
      if (p.plan === 'pro') {
        const plan = await timed('POST /api/admin/plan', admin.call('POST', '/api/admin/plan', { email: p.email, plan: 'pro' }));
        if (plan.status !== 200) throw new Error(`${p.key}: plan answered ${plan.status}`);
      }
      const onboard = await timed('PUT /api/profile', c.call('PUT', '/api/profile', p.answers));
      if (onboard.status !== 200) throw new Error(`${p.key}: onboarding answered ${onboard.status}: ${JSON.stringify(onboard.body)}`);
      const me = await timed('GET /api/me', c.get('/api/me'));
      profileIds.set(p.key, me.body.profile.id as string);
      const firstDeck = await timed('GET /api/feed (deck)', c.get('/api/feed'));
      obs.set(p.key, {
        key: p.key, plan: p.plan, features: me.body.features ?? null, decks: [firstDeck.body.items as FeedItem[]], browse: [],
        filters: null, next: null, alerts: [], repeat: null, stream: null, market: null, estimate: null,
      });
      log(`${p.key} onboarded: ${onboard.body.scored} bids scored, deck ${firstDeck.body.items.length}`);
    }

    // ---- live streams, then scan 2 brings the held-out bids in
    const storedAt = new Map<number, { at: number; profileId: string; bidId: string | null }>();
    const offStored = bus.on('alert', (e) => void storedAt.set(e.alert.id, { at: clockMs(), profileId: e.profileId, bidId: e.alert.bidId }));
    streams = openStreams(port, personas.map((p, i) => ({ key: p.key, cookie: clients.get(p.key)!.session, forwardedFor: `203.0.113.${i + 1}` })));
    await streams.ready;
    const keyOf = new Map([...profileIds.entries()].map(([k, id]) => [id, k] as const));
    const framesFor = (profileId: string) => streams!.frames.get(keyOf.get(profileId) ?? '') ?? [];
    // What scan 2 stored is read from the database (GET /api/alerts), not from the bus: the bus 'alert' event
    // is what the stream itself listens to, so a check built on it could not see alerts that never reach it.
    // The bus listener above only stamps WHEN each alert was stored.
    const maxBefore2 = new Map<string, number>();
    for (const p of personas) {
      const ids = ((await clients.get(p.key)!.get('/api/alerts?limit=200')).body.items as Alert[]).map((a) => a.id);
      maxBefore2.set(p.key, ids.length ? Math.max(...ids) : 0);
    }
    phase = 'second';
    let scanEndAt: number | null = null;
    const offScanEnd = bus.on('scan', () => void (scanEndAt ??= clockMs()));
    await runAdminScan('scan 2 (held-out bids arrive)');
    offScanEnd();
    await realtime.flush();
    const scan2Alerts: Array<[number, { at: number | null; profileId: string; bidId: string | null }]> = [];
    for (const p of personas) {
      const pid = profileIds.get(p.key)!;
      for (const a of (await clients.get(p.key)!.get('/api/alerts?limit=200')).body.items as Alert[]) {
        if (a.id > maxBefore2.get(p.key)!) scan2Alerts.push([a.id, { at: storedAt.get(a.id)?.at ?? null, profileId: pid, bidId: a.bidId }]);
      }
    }
    scan2Alerts.sort((a, b) => a[0] - b[0]);
    // Wait (at most 5 s) until every alert stored by scan 2 has come down its stream.
    const deadline = performance.now() + 5_000;
    const delivered = () => scan2Alerts.every(([id, s]) => framesFor(s.profileId).some((f) => f.id === id && f.event !== 'scan'));
    while (!delivered() && performance.now() < deadline) await new Promise((r) => setTimeout(r, 10));

    // ---- scan 3: the same pages again
    const alertsBefore = new Map<string, number[]>();
    for (const p of personas) alertsBefore.set(p.key, ((await clients.get(p.key)!.get('/api/alerts?limit=200')).body.items as Alert[]).map((a) => a.id));
    const repeatEvents = new Map<string, number>();
    const offRepeat = bus.on('alert', (e) => void repeatEvents.set(e.profileId, (repeatEvents.get(e.profileId) ?? 0) + 1));
    phase = 'repeat';
    await runAdminScan('scan 3 (identical repeat)');
    await realtime.flush();
    offRepeat();
    offStored();

    // ---- every company looks at everything
    const latency: SimMeasurements['latency'] = [];
    const firstSeen = seenAt.size ? Math.min(...seenAt.values()) : null;
    // The first 'scan' frame each stream got after the held-out bids were seen (scan 2's end, as the app hears it).
    const scanFrames = new Map<string, number>();
    for (const p of personas) {
      const f = (streams.frames.get(p.key) ?? []).find((x) => x.event === 'scan' && firstSeen !== null && x.at >= firstSeen);
      if (f) scanFrames.set(p.key, f.at);
    }
    for (const [i, p] of personas.entries()) {
      const c = clients.get(p.key)!;
      const o = obs.get(p.key)!;
      const pid = profileIds.get(p.key)!;
      const frames = streams.frames.get(p.key) ?? [];
      const mine = scan2Alerts.filter(([, s]) => s.profileId === pid);
      o.stream = { stored: mine.map(([id]) => id), delivered: frames.filter((f) => f.event !== 'scan' && f.event !== 'ping').map((f) => f.id) };
      for (const [id, s] of mine) {
        const seen = s.bidId ? seenAt.get(s.bidId) : undefined;
        const frame = frames.find((f) => f.id === id && f.event !== 'scan');
        if (seen !== undefined && s.at !== null) latency.push({ persona: p.key, bidId: s.bidId!, seenToStoredMs: round2(s.at - seen), seenToStreamMs: frame ? round2(frame.at - seen) : null });
      }
      const deck = await timed('GET /api/feed (deck)', c.get('/api/feed'));
      o.decks.push(deck.body.items as FeedItem[]);
      o.browse = (await timed('GET /api/feed (browse)', c.get('/api/feed?all=1&minScore=0&limit=300'))).body.items as FeedItem[];
      const { min, max } = p.answers.valueRange;
      const maxMi = Math.max(5, Math.round(p.answers.radiusMi / 2));
      o.filters = {
        price: { min, max, items: (await timed('GET /api/feed (filters)', c.get(`/api/feed?all=1&minScore=0&limit=300&minValue=${min}&maxValue=${max}`))).body.items },
        distance: { maxMi, items: (await timed('GET /api/feed (filters)', c.get(`/api/feed?all=1&minScore=0&limit=300&maxDistance=${maxMi}&sort=near`))).body.items },
        due: { days: 14, now: CAPTURED.toISOString(), items: (await timed('GET /api/feed (filters)', c.get('/api/feed?all=1&minScore=0&limit=300&dueWithinDays=14&sort=due'))).body.items },
      };
      // What Browse must hold: the scorer's own verdict on every open captured bid, with no candidate filter,
      // for the profile exactly as the scan scored it (mutations included).
      const scored = mutateProfile((await getProfile(db, pid))!, mutation);
      o.expectedInBrowse = merged
        .filter((b) => isOpen(b, CAPTURED))
        .map((b) => ({ b, s: scoreBid(b, scored, CAPTURED) }))
        .filter(({ s }) => s.verdict !== 'skip')
        .map(({ b, s }) => ({ id: b.id, title: b.title, score: s.score }))
        .sort((x, y) => (x.id < y.id ? -1 : 1));
      o.next = (await timed('GET /api/next', c.get('/api/next'))).body;
      o.asOf = CAPTURED.toISOString();
      o.alerts = (await timed('GET /api/alerts', c.get('/api/alerts?limit=200'))).body.items as Alert[];
      o.repeat = { before: alertsBefore.get(p.key)!, after: o.alerts.map((a) => a.id), events: repeatEvents.get(pid) ?? 0 };
      const ans = async (label: string, w: Promise<{ status: number; body: unknown; ms: number }>) => {
        const r = await timed(label, w);
        return { status: r.status, body: (r.body ?? null) as Record<string, unknown> | null };
      };
      o.market = {
        awards: await ans('GET /api/market/awards', c.get('/api/market/awards')),
        area: await ans('GET /api/market/area', c.get('/api/market/area')),
        watch: await ans('GET /api/market/watch', c.get('/api/market/watch')),
      };
      const best = o.next?.item ?? o.decks.at(-1)![0] ?? o.browse[0] ?? null;
      const dollars = targetDollars(p.answers.valueRange);
      const full = best ? simTakeoff(takeoffSeed, i, best, dollars) : null;
      const quick = best ? simTakeoff(takeoffSeed, i, best, dollars, ['markups']) : null;
      o.estimate = {
        full: await ans('POST /api/estimate', c.call('POST', '/api/estimate', { bidId: best?.id ?? null, ...(full?.request ?? {}) })),
        quick: await ans('POST /api/estimate', c.call('POST', '/api/estimate', { bidId: best?.id ?? null, ...(quick?.request ?? {}) })),
        list: await ans('GET /api/estimates', c.get(`/api/estimates${best ? `?bidId=${encodeURIComponent(best.id)}` : ''}`)),
      };
      (o as PersonaObs & { takeoff?: typeof full }).takeoff = full;
    }

    // ---- the checks
    const violations: Violation[] = [];
    const coverage: Record<string, { companies: number; items: number }> = {};
    for (const p of personas) {
      const o = obs.get(p.key)!;
      const byId = new Map(o.browse.map((b) => [b.id, b] as const));
      violations.push(...checkPersona(p, o, byId));
      const cov = checkCoverage(p, o, byId);
      for (const [k, n] of Object.entries(cov)) coverage[k] = { companies: (coverage[k]?.companies ?? 0) + (n > 0 ? 1 : 0), items: (coverage[k]?.items ?? 0) + n };
    }
    // Run level: every held-out bid was chosen because it alerts someone, so scan 2 must store an alert for it.
    for (const id of heldOut) {
      if (!scan2Alerts.some(([, s]) => s.bidId === id)) violations.push({ check: 'stream-delivery', persona: 'all', detail: `held-out bid ${id} should alert someone, but scan 2 stored no alert for it` });
    }
    // Check runs that evaluated at least one item (a check that saw nothing is reported as not exercised).
    const checksRun = PERSONA_CHECKS.reduce((n, k) => n + (coverage[k]?.companies ?? 0), 0);
    const marketLoaded = (await awardCounts(db)).length > 0 || (await seriesCounts(db)).some((c) => c.observations > 0);

    // ---- the report
    const report = buildReport({ seed, mutation: mutation ?? null, merged, heldOut, personas, obs, violations, checksRun, coverage, marketLoaded, profileIds, scan2Alerts });

    // ---- measurements
    await streams.close();
    streams = null;
    const scoring = scoringSpeed(personas, merged.filter((b) => isOpen(b, CAPTURED)), opts.speedMs ?? 1000);
    const scale = (opts.scaleProfiles ?? 1000) > 0 ? await scalePass(seed, merged, drafts, opts.scaleProfiles ?? 1000, opts.scaleDb ?? true, log) : null;
    const requests: SimMeasurements['requests'] = {};
    for (const [k, xs] of [...requestTimes.entries()].sort()) requests[k] = { n: xs.length, ...dist(xs) };
    const measurements: SimMeasurements = {
      machine: machine(),
      scans, latency,
      latencySummary: {
        alerts: latency.length,
        storedMs: dist(latency.map((l) => l.seenToStoredMs)),
        seenToScanEndMs: scanEndAt !== null && firstSeen !== null ? round2(scanEndAt - firstSeen) : null,
        seenToScanFrameMs: firstSeen === null ? null : dist(personas.flatMap((p) => {
          const f = scanFrames.get(p.key);
          return f === undefined ? [] : [f - firstSeen!];
        })),
        streamMs: latency.some((l) => l.seenToStreamMs !== null) ? dist(latency.flatMap((l) => (l.seenToStreamMs === null ? [] : [l.seenToStreamMs]))) : null,
      },
      requests, scoring, scale, totalMs: 0,
    };
    measurements.totalMs = Math.round(performance.now() - t0);
    return { report, measurements, hash: reportHash(report) };
  } finally {
    await streams?.close();
    realtime.stop();
    await app.close();
    await db.close();
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function machine(): SimMeasurements['machine'] {
  const cpus = osCpus();
  return { node: process.version, platform: `${osPlatform()} ${osRelease()}`, cpus: cpus.length, cpuModel: cpus[0]?.model ?? 'unknown' };
}

/** onSend seams for the answer-side mutations. */
function installResponseMutation(app: import('fastify').FastifyInstance, mutation: MutationId | undefined): void {
  if (mutation !== 'spend-limit' && mutation !== 'free-no-premium' && mutation !== 'estimate-not-silent') return;
  app.addHook('onSend', async (req, reply, payload) => {
    if (typeof payload !== 'string' || !payload.startsWith('{')) return payload;
    const url = req.url;
    const body = JSON.parse(payload) as Record<string, any>;
    if (mutation === 'spend-limit' && req.method === 'GET' && url.startsWith('/api/feed') && !url.includes('all=1') && body.items?.length) {
      body.items[0].overLimit = true;
    } else if (mutation === 'free-no-premium' && url.startsWith('/api/market/awards') && body.locked === true) {
      body.stats = { ...body.stats, median: 1 };
    } else if (mutation === 'estimate-not-silent' && req.method === 'POST' && url.startsWith('/api/estimate') && reply.statusCode === 200) {
      Object.assign(body, { status: 'complete', total: 0, needed: [], price: { ...(body.price ?? {}), bid: 0 } });
    } else return payload;
    return JSON.stringify(body);
  });
}

// ------------------------------------------------------------ report body --

interface ReportInput {
  seed: number;
  mutation: MutationId | null;
  merged: Bid[];
  heldOut: Set<string>;
  personas: readonly Persona[];
  obs: Map<string, PersonaObs>;
  violations: Violation[];
  checksRun: number;
  coverage: Record<string, { companies: number; items: number }>;
  marketLoaded: boolean;
  profileIds: Map<string, string>;
  scan2Alerts: Array<[number, { profileId: string; bidId: string | null }]>;
}

/**
 * Owners in each market whose notices no source reads today, for the owner to look into. Which board or site
 * each of them posts on was NOT verified by this run: it is a list of places to check, not a claim.
 */
const OWNERS_TO_CHECK: Array<{ match: RegExp; text: string }> = [
  { match: /Las Vegas/, text: 'NGEM is read in full (every page its pager lists, up to 8) and NevadaEPro only its 25 newest; check where the Las Vegas Valley Water District, Clark County School District, the RTC of Southern Nevada and NDOT post' },
  { match: /Sacramento/, text: 'no California state or local board is read: Cal eProcure (State of California), the City and County of Sacramento, SMUD, Sacramento Regional Transit and the school districts; only SAM.gov federal notices reach Sacramento today' },
  { match: /South Lake Tahoe/, text: 'California side not read: the City of South Lake Tahoe, El Dorado County, Cal eProcure; the Nevada side (Douglas County, NV state boards) is read' },
  { match: /Bishop/, text: 'nothing local is read: Inyo County, the City of Bishop, the Los Angeles Department of Water and Power (a large Owens Valley owner) and Cal eProcure' },
  { match: /Elko/, text: 'Elko County, the City of Elko and the Elko County School District are not read; state jobs there come only through the NV state boards' },
  { match: /Fallon/, text: 'Churchill County and the City of Fallon are not read; Naval Air Station Fallon posts on SAM.gov, which is read for Nevada' },
  { match: /Reno|Carson|Gardnerville|Minden/, text: 'Washoe County and the Cities of Reno and Sparks are not read as their own boards (some of their work appears on NGEM); Douglas County and the NV state boards are read' },
];

function buildReport(inp: ReportInput): SimReport {
  const { merged, personas, obs, violations } = inp;
  const open = merged.filter((b) => isOpen(b, CAPTURED));
  const bySource: Record<string, { total: number; open: number }> = {};
  for (const b of merged) {
    const s = (bySource[b.source] ??= { total: 0, open: 0 });
    s.total++;
    if (isOpen(b, CAPTURED)) s.open++;
  }
  const rows: PersonaRow[] = [];
  for (const p of personas) {
    const o = obs.get(p.key)!;
    const pid = inp.profileIds.get(p.key)!;
    const verdicts = { great: 0, good: 0, maybe: 0, skip: 0 };
    for (const b of o.browse) verdicts[b.verdict]++;
    const deck = o.decks.at(-1) ?? [];
    const full = o.estimate?.full;
    const quick = o.estimate?.quick;
    const fb = (full?.body ?? {}) as Record<string, any>;
    const qb = (quick?.body ?? {}) as Record<string, any>;
    const takeoff = (o as PersonaObs & { takeoff?: { sizedTo: number; notes: string[] } | null }).takeoff ?? null;
    const costVerdict = !full ? 'no request'
      : full.status === 402 ? `402 ${fb.error} — “${fb.message}”`
        : full.status !== 200 ? `HTTP ${full.status}`
          : fb.status === 'complete' ? `complete: bid price ${money(fb.total)} on a simulated takeoff sized to ${money((takeoff?.sizedTo ?? 0) * 100)}`
            : `incomplete: needs ${(fb.needed as Array<{ field: string }>).map((n) => n.field).join(', ')}`;
    const quickVerdict = !quick ? 'no request'
      : quick.status === 402 ? '402 premium_required'
        : qb.status === 'incomplete' ? `incomplete (overhead and profit left out): needs ${(qb.needed as Array<{ field: string; for: string }>).map((n) => `${n.field} (${n.for})`).join(', ')}`
          : `${qb.status} total ${qb.total}`;
    const aw = (o.market?.awards.body ?? {}) as Record<string, any>;
    const area = (o.market?.area.body ?? {}) as Record<string, any>;
    const watch = (o.market?.watch.body ?? {}) as Record<string, any>;
    rows.push({
      key: p.key, name: p.answers.businessName, email: p.email, town: p.town, plan: p.plan, trades: p.answers.trades,
      radiusMi: p.answers.radiusMi, valueRange: p.answers.valueRange,
      limits: { maxJobSize: p.answers.limits?.maxJobSize ?? null, bondingCapacity: p.answers.limits?.bondingCapacity ?? null },
      setAsides: p.answers.setAsides ?? [], reason: p.reason,
      bidsSeen: o.browse.length, verdicts, deck: deck.length, alerts: o.alerts.length,
      alertsFromScan2: inp.scan2Alerts.filter(([, s]) => s.profileId === pid).length,
      overLimit: o.browse.filter((b) => b.overLimit).length,
      noEstimate: o.browse.filter((b) => !b.estValue || (b.estValue.min == null && b.estValue.max == null)).length,
      unknownDistance: o.browse.filter((b) => b.distanceMi === null).length,
      withinRadius: o.browse.filter((b) => b.distanceMi !== null && b.distanceMi <= p.answers.radiusMi).length,
      next: o.next?.item ? { id: o.next.item.id, title: o.next.item.title, score: o.next.item.score, why: o.next.why } : null,
      topFits: o.browse.filter((b) => b.verdict === 'great' || b.verdict === 'good').slice(0, 5)
        .map((b) => ({ id: b.id, title: b.title, score: b.score, verdict: b.verdict, place: b.location.label, distanceMi: b.distanceMi === null ? null : Math.round(b.distanceMi) })),
      reservedSeen: o.browse.filter((b) => isReserved(b.setAside))
        .map((b) => ({ id: b.id, setAside: b.setAside!, score: b.score, verdict: b.verdict, firstReason: b.reasons[0]?.text ?? '' })),
      cost: {
        bidId: o.next?.item?.id ?? deck[0]?.id ?? o.browse[0]?.id ?? null, verdict: costVerdict, status: full?.status ?? 0,
        total: typeof fb.total === 'number' ? fb.total : null,
        needed: Array.isArray(fb.needed) ? (fb.needed as Array<{ field: string }>).map((n) => n.field) : [],
        quick: quickVerdict, sizedTo: takeoff?.sizedTo ?? null, notes: takeoff?.notes ?? [],
      },
      market: {
        awards: `${aw.locked ? 'locked (count only)' : 'open'} — ${aw.summary ?? aw.error ?? ''}`.trim(),
        area: area.missing ? (area.missing as string[]).join(' ') || `${(area.wages ?? []).length} wage figures, ${(area.materials ?? []).length} material indexes` : String(area.error ?? ''),
        watch: watch.locked ? 'locked: part of BidSwipe Pro' : `open — ${(watch.series ?? []).length} series watched, enabled ${watch.enabled}`,
      },
    });
  }

  const byCheck: Record<string, number> = {};
  for (const v of violations) byCheck[v.check] = (byCheck[v.check] ?? 0) + 1;

  const coverage = rows.map((r) => {
    const owners = OWNERS_TO_CHECK.find((b) => b.match.test(r.town));
    return { key: r.key, town: r.town, open: r.bidsSeen, inRadius: r.withinRadius, deck: r.deck, boardsNeeded: owners?.text ?? '' };
  });

  return {
    seed: inp.seed, mutation: inp.mutation, capturedAt: CAPTURED.toISOString(),
    bids: {
      total: merged.length, open: open.length, bySource,
      heldOut: [...inp.heldOut].map((id) => ({ id, title: merged.find((b) => b.id === id)?.title ?? '' })),
    },
    personas: rows,
    checks: { total: inp.checksRun, violations, byCheck, coverage: inp.coverage },
    findings: findings(rows, merged, obs, personas, violations, inp.marketLoaded),
    coverage,
  };
}

/** Whole cents → "$1,234". */
function money(cents: unknown): string {
  if (typeof cents !== 'number') return '—';
  const dollars = Math.round(cents / 100);
  return `$${dollars.toLocaleString('en-US')}`;
}

/** Cross-company findings in plain words, computed from what the companies saw. */
function findings(rows: PersonaRow[], merged: Bid[], obs: Map<string, PersonaObs>, personas: readonly Persona[], violations: Violation[], marketLoaded: boolean): string[] {
  const out: string[] = [];
  const open = merged.filter((b) => isOpen(b, CAPTURED));
  const withValue = merged.filter((b) => b.estValue && (b.estValue.min != null || b.estValue.max != null)).length;
  out.push(`${withValue} of the ${merged.length} captured bids state an estimated value. Every spend limit and bonding capacity the companies set was therefore never tested against a real bid: the limit can only stop a job whose notice gives a dollar figure.`);
  const empty = rows.filter((r) => r.deck === 0);
  if (empty.length) out.push(`${empty.length} of ${rows.length} companies ${empty.length === 1 ? 'has' : 'have'} an empty swipe deck: ${empty.map((r) => `${r.key} (${r.town}, ${r.trades.join('+')})`).join('; ')}.`);
  const thin = rows.filter((r) => r.deck > 0 && r.deck <= 2);
  if (thin.length) out.push(`${thin.length} more see only one or two bids in the deck: ${thin.map((r) => `${r.key} (${r.town}, ${r.deck})`).join('; ')}.`);
  const ca = rows.filter((r) => /, CA /.test(r.town));
  const caOpen = open.filter((b) => b.location.state === 'CA');
  const caSources = [...new Set(caOpen.map((b) => b.source))].sort();
  const caFederalOnly = caSources.length === 1 && caSources[0] === 'samgov';
  out.push(caFederalOnly
    ? `California: ${caOpen.length} open captured bids are in California, all from SAM.gov (federal). The ${ca.length} California companies (${ca.map((r) => r.key).join(', ')}) see no state, county or city work at all.`
    : `California: ${caOpen.length} open captured bids are in California, from ${caSources.join(', ') || 'no source'}.`);
  const lv = rows.filter((r) => /Las Vegas/.test(r.town));
  for (const r of lv) out.push(`${r.key} (${r.town}, ${r.trades.join('+')}): ${r.withinRadius} bids measured inside ${r.radiusMi} mi, ${r.verdicts.great + r.verdicts.good} good or great fits, deck ${r.deck}.`);
  const unknown = open.filter((b) => b.location.precision === 'state' || b.location.precision === 'unknown' || b.location.precision === 'region');
  const unknownBySource = new Map<string, number>();
  for (const b of unknown) unknownBySource.set(b.source, (unknownBySource.get(b.source) ?? 0) + 1);
  const bySrc = [...unknownBySource.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([src, n]) => `${src} ${n}`).join(', ');
  out.push(`${unknown.length} open bids have only a state, region or unknown place (by source: ${bySrc || 'none'}). With no distance they never alert anyone and score without distance points. (Each company's "no distance" count below is per company, so it can differ by a bid or two.)`);
  const supply = open.filter((b) => b.flags.includes('May be supply-only')).length;
  out.push(`${supply} open bids carry "May be supply-only" (NevadaEPro lists purchases and installs together): they lose points so a contractor is not chased with vehicle or food purchases.`);
  const reserved = open.filter((b) => isReserved(b.setAside));
  const certViolations = violations.filter((v) => v.check === 'certification').length;
  out.push(`${reserved.length} open federal notices are reserved for a certification program (${[...new Set(reserved.map((b) => b.setAside))].join(', ')}). Certification check: ${certViolations === 0 ? 'no uncertified company was shown or alerted one, and no certified company was blocked by its own program' : `${certViolations} violation(s)`}.`);
  for (const r of rows.filter((x) => x.setAsides.some((c) => c !== 'SBA'))) {
    const own = r.reservedSeen.filter((x) => r.setAsides.includes(x.setAside));
    out.push(`${r.key} (${r.setAsides.filter((c) => c !== 'SBA').join(', ')}): ${own.length ? own.map((x) => `${x.id} scores ${x.score} (${x.verdict}), first reason “${x.firstReason}”`).join('; ') : 'no open notice is reserved for its program'}.`);
  }
  // trade separation, seen across companies
  const elecOnly = open.filter((b) => electricalOnly(b as FeedItem)).length;
  const pipe = open.filter((b) => pipeOnly(b as FeedItem)).length;
  const tradeViolations = violations.filter((v) => v.check === 'trade').length;
  out.push(`Trade separation: ${elecOnly} open bids read as electrical-only and ${pipe} as plumbing/HVAC-only (word list in src/sim/checks.ts). ${tradeViolations === 0 ? 'No plumbing or HVAC company got an electrical-only job as a good or great fit, and no electrical company got a plumbing/HVAC-only one.' : `${tradeViolations} cross-trade fit(s) found: see the violations.`}`);
  // the same bid, different verdicts
  const shared = new Map<string, string[]>();
  for (const p of personas) for (const b of obs.get(p.key)!.browse) if (b.verdict === 'great' || b.verdict === 'good') shared.set(b.id, [...(shared.get(b.id) ?? []), p.key]);
  const popular = [...shared.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, 3);
  for (const [id, keys] of popular) out.push(`Most shared fit: ${id} “${merged.find((b) => b.id === id)?.title.slice(0, 70)}” is a good or great fit for ${keys.length} companies (${keys.join(', ')}).`);
  const weakNext = rows.filter((r) => r.next && r.next.score < 55);
  if (weakNext.length) out.push(`Looks wrong in a feed: for ${weakNext.length} companies the "next bid" is only a maybe (under 55): ${weakNext.map((r) => `${r.key} gets ${r.next!.score} “${r.next!.title.slice(0, 60)}”`).join('; ')}. The pick takes the best of the deck (floor 35), so a thin deck hands out weak picks; the app should say "nothing strong today" instead.`);
  const supplyNext = rows.filter((r) => r.next && merged.find((b) => b.id === r.next!.id)?.flags.includes('May be supply-only'));
  if (supplyNext.length) out.push(`${supplyNext.map((r) => `${r.key}'s next bid “${r.next!.title}”`).join('; ')} carries "May be supply-only": likely a purchase, not a job.`);
  const freeRows = rows.filter((r) => r.plan === 'free');
  const gated = freeRows.filter((r) => r.cost.status === 402 && r.market.awards.startsWith('locked')).length;
  const proRows = rows.filter((r) => r.plan === 'pro');
  const priced = proRows.filter((r) => r.cost.total !== null && r.cost.total > 0).length;
  out.push(`Plan gates: ${gated} of ${freeRows.length} free companies got HTTP 402 premium_required on the cost check and a locked market-awards answer (count only). Of ${proRows.length} Pro companies, ${priced} got a bid price on their simulated takeoff and ${proRows.length - priced} a list of what is needed.`);
  if (!marketLoaded) out.push('Market data: no federal awards, BLS wages or price indexes were loaded in this run\'s database (it never refreshes market data). The market answers say "not loaded" rather than zero, which is the honest answer; with the daily market refresh the Pro companies would see award ranges here.');
  return out;
}

// ---------------------------------------------------------- measurements --

function scoringSpeed(personas: readonly Persona[], bids: Bid[], minMs: number): SimMeasurements['scoring'] {
  const profiles = personas.map((p) => buildProfile(profileIdFor(p.key), p.answers));
  let pairs = 0;
  const start = performance.now();
  let sink = 0;
  do {
    for (const pr of profiles) for (const b of bids) {
      sink += scoreBid(b, pr, CAPTURED).score;
      pairs++;
    }
  } while (performance.now() - start < minMs);
  const ms = performance.now() - start;
  if (sink < 0) throw new Error('unreachable');
  return { pairs, ms: Math.round(ms), pairsPerSecond: Math.round((pairs / ms) * 1000) };
}

/** Real ZIPs the scale pass places its variations at (all resolve in src/geo/zip.ts). */
const SCALE_ZIPS = ['89410', '89423', '89501', '89502', '89521', '89701', '89703', '89406', '89801', '89101', '89052', '89301', '89445', '96150', '95814', '93514', '96130', '89048'];
const SCALE_TRADES = [['electrical'], ['electrical', 'low-voltage'], ['plumbing'], ['hvac'], ['fire-protection'], ['general-building'], ['roofing'], ['concrete-paving'], ['plumbing', 'hvac'], ['general-building', 'electrical']];

/** 1,000 (or n) seeded variations of a company: real ZIP, trade mix, radius, size, limits. Simulated. */
export function scaleAnswers(seed: number, n: number): OnboardingAnswers[] {
  const g = new Rng((seed ^ 0x27d4eb2d) >>> 0);
  return Array.from({ length: n }, (_, i) => {
    const min = g.pick([0, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000]);
    const max = min + g.pick([20_000, 50_000, 150_000, 500_000, 2_000_000]);
    const tight = g.chance(0.5);
    return {
      businessName: `SIM scale company ${i + 1} (simulated)`, trades: g.pick(SCALE_TRADES), zip: g.pick(SCALE_ZIPS),
      radiusMi: g.int(25, 300), valueRange: { min, max },
      limits: { maxJobSize: tight ? max : max * 3, bondingCapacity: tight ? 0 : max * 2 },
      setAsides: g.chance(0.9) ? ['SBA'] : g.chance(0.5) ? ['SBA', 'SDVOSBC'] : ['SBA', '8A'],
    };
  });
}

async function scalePass(seed: number, merged: Bid[], drafts: BidDraft[], n: number, withDb: boolean, log: (m: string) => void): Promise<NonNullable<SimMeasurements['scale']>> {
  const answers = scaleAnswers(seed, n);
  const profiles = answers.map((a, i) => buildProfile(`sim-scale-${String(i + 1).padStart(4, '0')}`, a));
  const open = merged.filter((b) => isOpen(b, CAPTURED));
  globalThis.gc?.();
  const heap0 = process.memoryUsage().heapUsed;
  const t = performance.now();
  let pairs = 0;
  const kept: number[] = [];
  for (const pr of profiles) for (const b of open) {
    kept.push(scoreBid(b, pr, CAPTURED).score);
    pairs++;
  }
  const ms = performance.now() - t;
  const heapDeltaMb = round2((process.memoryUsage().heapUsed - heap0) / 1_048_576);
  const pure = { ms: Math.round(ms), pairsPerSecond: Math.round((pairs / ms) * 1000), heapDeltaMb };
  log(`scale pass (pure scoring): ${n} profiles × ${open.length} open bids = ${pairs} pairs in ${pure.ms} ms`);

  let dbPart: NonNullable<SimMeasurements['scale']>['db'] = null;
  if (withDb) {
    const db = await openDb({ dataDir: 'memory://' });
    try {
      const rssBefore = process.memoryUsage().rss;
      let peak = rssBefore;
      const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
      const t1 = performance.now();
      const ctx: SourceContext = { http: { text: async () => '', json: async () => ({}) as never }, now: CAPTURED, env: () => undefined, log: () => {} };
      const source: Source = { id: 'samgov', name: 'all captured boards', homepage: '', fetch: async () => drafts };
      const report = await runScan({ db, sources: [source], profiles, ctx });
      clearInterval(sampler);
      peak = Math.max(peak, process.memoryUsage().rss);
      const stored = Object.values(report.profiles).reduce((a, r) => a + r.scored, 0);
      dbPart = {
        ms: Math.round(performance.now() - t1), matchesStored: stored, peakRssMb: round2(peak / 1_048_576),
        rssBeforeMb: round2(rssBefore / 1_048_576), heapAfterMb: round2(process.memoryUsage().heapUsed / 1_048_576),
      };
      log(`scale pass (database scan): ${stored} matches stored in ${dbPart.ms} ms`);
    } finally {
      await db.close();
    }
  }
  return { profiles: n, bids: open.length, pairs, pure, db: dbPart };
}
