/**
 * How the marketplace's two busiest requests hold up with many users:
 *
 *   npm run bench:jobs -- --profiles 3000 --jobs 300 --out out/bench-jobs.json
 *
 * It fills an in-memory database with SIMULATED people (real ZIP codes, a third of them in one home region,
 * the rest across the country; workers of every trade, people who only hire, and the pilot's config profile)
 * and SIMULATED jobs in every stage (open, awarded, agreed, done, unfilled, with their bids and fee rows), then
 * measures, through the real server in accounts mode (app.inject, no network):
 *
 *   POST /api/jobs       the new job is scored for everyone it could fit before the poster gets an answer:
 *                        wall time and database statements per request, once with the alert rules listening
 *                        (as in production: each good fit also gets an inbox alert) and once without
 *   GET  /api/jobs/mine  for a person with many jobs, and for the worker who bid on the most jobs
 *
 * and prints three sha256 digests of what those requests produced (every stored score, every alert in the order
 * it was raised, the "my jobs" answers). Run it on two versions of the code: the same digests mean the same
 * behaviour, and the numbers show what changed. Same seed, same data, same digests.
 *
 * Nothing here is real: BENCH people at example.com, BENCH jobs on "BENCH Test Road", 555-0100 phone numbers.
 * It holds no SQL of its own: everything goes through the repo files and the service, like the server does.
 *
 *   --profiles N   accounts with a profile (default 3000)
 *   --jobs N       jobs seeded before measuring (default 300; 40% posted by the person "my jobs" is read for)
 *   --posts N      measured POST /api/jobs per phase (default 24)
 *   --reads N      measured GET /api/jobs/mine per person (default 15)
 *   --seed N       (default 20261114)
 *   --out FILE     also write the result as JSON
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import type { AuthService } from '../auth/index.js';
import { loadConfig } from '../context.js';
import { createAccount } from '../db/accounts.js';
import { openDb, type Db } from '../db/db.js';
import { getFeed, saveProfileForAccount, upsertBids, upsertProfile } from '../db/repo.js';
import { saveWorkProfile } from '../db/work.js';
import { lookupZip } from '../geo/zip.js';
import { loadJobRules } from '../jobs/config.js';
import { getJob, insertJob, placeBid } from '../jobs/repo.js';
import { completeJob, confirmAgreement, markContacted, mirrorBid, sendMessage, settleDue, type JobsDeps } from '../jobs/service.js';
import { buildProfile, HIRE_DEFAULTS, profileIdFor } from '../profile/build.js';
import { defaultWorkProfile } from '../profile/work.js';
import { loadProfile } from '../profiles.js';
import { createRealtime } from '../realtime/index.js';
import { buildApp } from '../server.js';
import { TRADES } from '../trades/catalog.js';
import type { Account } from '../types.js';

export interface BenchArgs {
  profiles: number;
  jobs: number;
  posts: number;
  reads: number;
  seed: number;
  out: string | null;
}

export function parseBenchArgs(argv: string[]): BenchArgs {
  const args: BenchArgs = { profiles: 3000, jobs: 300, posts: 24, reads: 15, seed: 20261114, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf('=');
    const flag = eq === -1 ? a : a.slice(0, eq);
    const value = eq === -1 ? argv[++i] ?? '' : a.slice(eq + 1);
    const whole = (min: number): number => {
      if (!/^\d+$/.test(value) || Number(value) < min) throw new Error(`${flag} must be a whole number of at least ${min}, got "${value}"`);
      return Number(value);
    };
    if (flag === '--profiles') args.profiles = whole(50);
    else if (flag === '--jobs') args.jobs = whole(10);
    else if (flag === '--posts') args.posts = whole(1);
    else if (flag === '--reads') args.reads = whole(1);
    else if (flag === '--seed') args.seed = whole(0);
    else if (flag === '--out') args.out = resolve(process.cwd(), value);
    else throw new Error(`unknown option ${a}`);
  }
  return args;
}

// ------------------------------------------------------------- the data --

/** Real ZIPs. The home region is where the measured jobs are posted (the pilot's: Carson Valley, Reno, Tahoe). */
const HOME_ZIPS = ['89410', '89423', '89460', '89701', '89703', '89706', '89501', '89502', '89511', '89431', '96150', '89449'];
/** Close enough that a wide travel radius reaches the home region from another state. */
const NEAR_ZIPS = ['95814', '95816', '95608', '95630', '95603', '96161'];
const FAR_ZIPS = [
  '89101', '89123', '89014', '85004', '85281', '84101', '84601', '83702', '97201', '97005', '98101', '99201', '59101', '82001',
  '80202', '80903', '87102', '79901', '78701', '77002', '75201', '73102', '67202', '64106', '68102', '55401', '50309', '63101',
  '60601', '53202', '46204', '48226', '43215', '44113', '40202', '37203', '38103', '35203', '70112', '72201', '39201', '30303',
  '32202', '33101', '33602', '29201', '28202', '27601', '23219', '20001', '21201', '19103', '15222', '07102', '10001', '11201',
  '14202', '06103', '02108', '02903', '03101', '04101', '05401', '90012', '92101', '94103', '95113', '93721', '96813', '99501',
];
const RADII_MI = [25, 40, 60, 90, 150, 250];
const T0 = Date.parse('2026-11-01T18:00:00Z');
const MINUTE = 60_000;
const DAY = 86_400_000;
const APP_URL = 'https://bidswipe.example.com';

/** mulberry32: a small seeded generator, so the same seed makes the same people and jobs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Person {
  account: Account;
  home: boolean;
  works: boolean;
}

interface Seeded {
  people: Person[];
  /** The person "my jobs" is read for: posted 40% of the jobs and bid on 30% of the rest. */
  heavy: Person;
  /** The worker with the most bids who posted nothing: the usual "my jobs". */
  worker: Person;
  /** People in the home region who only hire: they post the measured jobs. */
  posters: Person[];
  now: number;
  counts: Record<string, number>;
}

async function seed(db: Db, args: BenchArgs): Promise<Seeded> {
  const rand = rng(args.seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const known = (zips: string[]) => zips.filter((z) => lookupZip(z));
  const [homeZips, nearZips, farZips] = [known(HOME_ZIPS), known(NEAR_ZIPS), known(FAR_ZIPS)];
  if (!homeZips.length || !farZips.length) throw new Error('bench: the ZIP table knows none of the ZIPs');
  const pad = (n: number, w = 5) => String(n).padStart(w, '0');

  // ---- people: an account, a scoring profile, and for every third one a work profile
  const people: Person[] = [];
  for (let i = 1; i <= args.profiles; i++) {
    const id = `bench-${pad(i)}`;
    const account = await createAccount(db, { id, email: `${id}@example.com`, name: `BENCH Person ${pad(i)} (simulated)`, passwordHash: null }, new Date(T0 - DAY));
    if (!account) throw new Error(`bench: account ${id} already exists`);
    const where = rand();
    const home = i <= 40 || where < 0.35; // the first 40 are always local: the heavy person and the posters
    const zip = home ? pick(homeZips) : where < 0.45 && nearZips.length ? pick(nearZips) : pick(farZips);
    // Accounts 2 to 9 only hire (they post the measured jobs); 15% of everyone else does too.
    const hire = (i >= 2 && i <= 9) || (i > 40 && rand() < 0.15);
    const trades = i === 1 ? ['electrical'] : [...new Set([pick(TRADES).id, ...(rand() < 0.25 ? [pick(TRADES).id] : [])])];
    const name = `BENCH Shop ${pad(i)} (simulated)`;
    await saveProfileForAccount(db, account.id, buildProfile(profileIdFor(account.id), hire
      ? { intent: 'hire', businessName: name, trades: [], zip, ...HIRE_DEFAULTS, valueRange: { ...HIRE_DEFAULTS.valueRange } }
      : { businessName: name, trades, zip, radiusMi: pick(RADII_MI), valueRange: { min: 0, max: 50_000 } }));
    if (i % 3 === 0) {
      await saveWorkProfile(db, account.id, {
        ...defaultWorkProfile(), intent: hire ? 'hire' : 'both', headline: `BENCH headline ${pad(i)} (simulated)`,
        yearsExperience: i % 30, skills: trades.map((t) => `BENCH ${t}`), insured: i % 2 ? 'yes' : 'unsure',
      }, new Date(T0 - DAY));
    }
    people.push({ account, home, works: !hire });
  }
  // The pilot's profile the way single mode stores it: no account, so it must never be handed a local job.
  await upsertProfile(db, { ...loadProfile('lm-electric'), id: 'bench-config-profile', name: 'BENCH config profile (simulated)' });

  const heavy = people[0]!;
  const posters = people.slice(1, 9);
  const localWorkers = people.filter((p) => p.home && p.works && p !== heavy);
  const localPosters = people.filter((p) => p.home && p !== heavy);

  // ---- jobs, with bids, in every stage. No scores are stored for them: only the measured posts are scored.
  const deps: JobsDeps = { db, rules: loadJobRules(() => undefined), appUrl: APP_URL };
  const counts: Record<string, number> = { jobs: 0, bids: 0 };
  const bidsBy = new Map<Person, number>();
  const postedBy = new Set<Person>();
  const ids: string[] = [];
  let amount = 30_001;
  for (let i = 1; i <= args.jobs; i++) {
    const postedByHeavy = i <= args.jobs * 0.4;
    const heavyBids = !postedByHeavy && i <= args.jobs * 0.7;
    const poster = postedByHeavy ? heavy : pick(localPosters);
    const place = lookupZip(pick(homeZips))!;
    const postedAt = T0 + i * MINUTE;
    const trade = TRADES[i % TRADES.length]!;
    const job = await insertJob(db, {
      id: `bench-job-${pad(i, 4)}`, posterId: poster.account.id, title: `BENCH seeded job ${pad(i, 4)}: ${trade.label} work (simulated)`,
      description: `A BENCH job for the benchmark, number ${i}. Nothing here is real (simulated).`, trades: [trade.id],
      zip: place.zip, city: place.city, state: place.state, lat: place.lat, lng: place.lng,
      address: i % 2 ? `${i} BENCH Test Road (simulated)` : null, phone: i % 2 ? `555-0100-${pad(i, 4)}` : null,
      budgetMaxCents: i % 5 === 0 ? 900_000 : null, postedAt, closesAt: postedAt + [1, 2, 12][i % 3]! * DAY, repostedFrom: null,
    });
    if (!job) throw new Error(`bench: job ${i} was not stored`);
    await upsertBids(db, [mirrorBid(job, APP_URL)], new Date(postedAt));
    ids.push(job.id);
    postedBy.add(poster);
    counts.jobs!++;
    const bidders = new Set<Person>(heavyBids ? [heavy] : []);
    const want = i % 11 === 0 ? 0 : 2 + Math.floor(rand() * 9);
    while (bidders.size < want + (heavyBids ? 1 : 0)) {
      const b = pick(localWorkers);
      if (b !== poster) bidders.add(b);
    }
    let k = 0;
    for (const b of bidders) {
      if (b === poster) continue;
      amount += 2 + Math.floor(rand() * 400) * 2; // odd cents, never the same twice
      const placed = await placeBid(db, { jobId: job.id, bidderId: b.account.id, amountCents: amount, note: k % 3 ? null : 'BENCH note (simulated)' }, postedAt + ++k * MINUTE);
      if (!placed) continue;
      counts.bids!++;
      bidsBy.set(b, (bidsBy.get(b) ?? 0) + 1);
    }
  }

  // ---- day 2.5: the 1- and 2-day jobs close. Then the winners and posters do different things.
  const t1 = T0 + 2.5 * DAY;
  await settleDue(deps, t1);
  let n = 0;
  for (const id of ids) {
    const job = await getJob(db, id);
    if (!job || job.status !== 'awarded' || !job.winnerId) continue;
    const act = n++ % 5;
    if (act === 0 || act === 1) {
      await sendMessage(deps, job.winnerId, id, { body: 'BENCH message: when can I come by? (simulated)' }, t1 + MINUTE);
      await confirmAgreement(deps, job.winnerId, id, t1 + 2 * MINUTE);
      await confirmAgreement(deps, job.posterId, id, t1 + 3 * MINUTE);
      if (act === 1) await completeJob(deps, job.posterId, id, t1 + DAY);
    } else if (act === 2) await sendMessage(deps, job.winnerId, id, { body: 'BENCH message: hello? (simulated)' }, t1 + MINUTE);
    else if (act === 3) await markContacted(deps, job.posterId, id, t1 + MINUTE);
    // act 4: nobody does anything, so the deadline ends it as the winner's no-show (a fee row)
  }
  // ---- day 10.5: every contact window of those jobs has run out; the 12-day jobs are still open.
  const now = T0 + 10.5 * DAY;
  await settleDue(deps, now);
  for (const id of ids) {
    const job = await getJob(db, id);
    const key = job ? `${job.status}${job.outcome ? `/${job.outcome}` : ''}` : 'gone';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const worker = localWorkers.filter((p) => !postedBy.has(p)).sort((a, b) => (bidsBy.get(b) ?? 0) - (bidsBy.get(a) ?? 0))[0];
  if (!worker || !bidsBy.get(worker)) throw new Error('bench: no worker placed a bid');
  return { people, heavy, worker, posters, now, counts };
}

// ------------------------------------------------------------ measuring --

export interface Stat {
  n: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  /** Database statements per request (median, and the most any one request made). */
  medianQueries: number;
  maxQueries: number;
}

function stat(samples: Array<{ ms: number; queries: number }>): Stat {
  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
  const q = (xs: number[], p: number) => sorted(xs)[Math.min(xs.length - 1, Math.floor(p * (xs.length - 1) + 0.5))]!;
  const r = (x: number) => Math.round(x * 10) / 10;
  const ms = samples.map((s) => s.ms);
  const qs = samples.map((s) => s.queries);
  return { n: samples.length, medianMs: r(q(ms, 0.5)), p95Ms: r(q(ms, 0.95)), minMs: r(Math.min(...ms)), maxMs: r(Math.max(...ms)), medianQueries: q(qs, 0.5), maxQueries: Math.max(...qs) };
}

export interface BenchResult {
  machine: { node: string; cpus: number };
  args: BenchArgs;
  seedMs: number;
  seeded: Record<string, number>;
  /** Stored scores and alerts the measured posts produced. */
  produced: { posts: number; scoresPerPost: number; alertsPerPostWithAlerts: number };
  routes: Record<string, Stat & { bytes?: number }>;
  digests: { scores: string; alerts: string; mine: string };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export async function runBench(args: BenchArgs, log: (m: string) => void = () => {}): Promise<BenchResult> {
  const inner = await openDb({ dataDir: 'memory://' });
  let queries = 0;
  const db: Db = { kind: inner.kind, query: (sql, params) => (queries++, inner.query(sql, params)), exec: (sql) => inner.exec(sql), close: () => inner.close() };
  const t0 = performance.now();
  log(`seeding ${args.profiles} profiles and ${args.jobs} jobs (seed ${args.seed})`);
  const world = await seed(inner, args);
  const seedMs = Math.round(performance.now() - t0);
  log(`seeded in ${(seedMs / 1000).toFixed(1)} s: ${Object.entries(world.counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);

  let current: Account | null = null;
  const auth: AuthService = { authenticate: async () => current };
  const clock = world.now;
  const { app, ctx } = await buildApp({ db }, { config: loadConfig({ AUTH_MODE: 'accounts', APP_URL }), auth, now: () => new Date(clock) });
  // As on the serverless host: no timers, routes flush the pushes they raised. No devices, so nothing is sent.
  const realtime = createRealtime(ctx, { sender: null, tickMs: 0 });
  ctx.realtime = realtime;
  const alerts: unknown[] = [];
  ctx.bus.on('alert', (e) => void alerts.push([e.profileId, e.alert.kind, e.alert.title, e.alert.body]));

  const call = async (who: Account, method: 'GET' | 'POST', url: string, body?: unknown) => {
    current = who;
    const before = queries;
    const start = performance.now();
    const res = await app.inject({
      method, url, headers: { 'x-bidswipe': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    return { status: res.statusCode, text: res.body, ms: performance.now() - start, queries: queries - before };
  };

  try {
    await call(world.heavy.account, 'GET', '/api/jobs/rules'); // warm-up: routes, the trade catalog, the ZIP table
    const routes: BenchResult['routes'] = {};
    const titles = new Map<string, string>();
    let posted = 0;
    const postPhase = async (label: string): Promise<void> => {
      const samples: Array<{ ms: number; queries: number }> = [];
      for (let i = 0; i < args.posts; i++, posted++) {
        const poster = world.posters[Math.floor(posted / 8) % world.posters.length]!; // 8 each: the limit is 10 an hour
        const trade = TRADES[posted % TRADES.length]!;
        const title = `BENCH job ${String(posted + 1).padStart(3, '0')}: ${trade.label} work (simulated)`;
        const res = await call(poster.account, 'POST', '/api/jobs', {
          title, description: 'A BENCH job posted while measuring. Nothing here is real (simulated).', trades: [trade.id],
          zip: HOME_ZIPS[posted % HOME_ZIPS.length], closesInDays: 7,
        });
        if (res.status !== 201) throw new Error(`bench: POST /api/jobs answered ${res.status}: ${res.text.slice(0, 200)}`);
        titles.set((JSON.parse(res.text) as { job: { id: string } }).job.id, title);
        samples.push(res);
      }
      routes[label] = stat(samples);
      log(`${label}: median ${routes[label]!.medianMs} ms, ${routes[label]!.medianQueries} statements`);
    };
    if (args.posts > world.posters.length * 4) throw new Error(`bench: --posts may be at most ${world.posters.length * 4}`);
    await postPhase('POST /api/jobs (alerts on)');
    const alertsOn = alerts.length;
    realtime.stop(); // the alert rules stop listening: what is left is the scoring alone
    await postPhase('POST /api/jobs (alerts off)');

    const mine: string[] = [];
    const readPhase = async (label: string, who: Account): Promise<void> => {
      const samples: Array<{ ms: number; queries: number }> = [];
      let text = '';
      for (let i = 0; i < args.reads; i++) {
        const res = await call(who, 'GET', '/api/jobs/mine');
        if (res.status !== 200) throw new Error(`bench: GET /api/jobs/mine answered ${res.status}`);
        text = res.text;
        samples.push(res);
      }
      const body = JSON.parse(text) as { posted: unknown[]; bidding: unknown[] };
      routes[label] = { ...stat(samples), bytes: text.length };
      mine.push(text);
      log(`${label}: ${body.posted.length} posted + ${body.bidding.length} bid on, median ${routes[label]!.medianMs} ms, ${routes[label]!.medianQueries} statements`);
    };
    await readPhase('GET /api/jobs/mine (many jobs)', world.heavy.account);
    await readPhase('GET /api/jobs/mine (a worker)', world.worker.account);

    // ---- what the posts produced, for comparing two versions of the code
    log('reading every stored score back for the digest');
    const scores: unknown[] = [];
    const perJob = new Map<string, number>();
    for (const p of [...world.people.map((x) => profileIdFor(x.account.id)), 'bench-config-profile']) {
      const items = await getFeed(inner, p, { minScore: 0, includeSwiped: true, limit: 100_000, sources: ['local'], now: new Date(clock) });
      for (const it of items.sort((a, b) => (a.title < b.title ? -1 : 1))) {
        scores.push([p, it.title, it.score, it.verdict, it.reasons, it.distanceMi, it.overLimit, it.tier]);
        perJob.set(it.title, (perJob.get(it.title) ?? 0) + 1);
      }
    }
    const label = (s: string) => s.replace(UUID, (id) => titles.get(id) ?? 'unknown-job');
    return {
      machine: { node: process.version, cpus: cpus().length },
      args, seedMs, seeded: { profiles: args.profiles + 1, ...world.counts },
      produced: {
        posts: posted, scoresPerPost: Math.round(scores.length / Math.max(1, posted)),
        alertsPerPostWithAlerts: Math.round(alertsOn / Math.max(1, args.posts)),
      },
      routes,
      digests: { scores: sha(scores), alerts: sha(alerts), mine: sha(mine.map(label)) },
    };
  } finally {
    realtime.stop();
    await app.close();
    await inner.close();
  }
}

export function renderBench(r: BenchResult): string {
  const lines = [
    `machine: Node ${r.machine.node}, ${r.machine.cpus} CPUs; embedded database in memory`,
    `data: ${Object.entries(r.seeded).map(([k, v]) => `${v} ${k}`).join(', ')}`,
    `each measured post was scored for about ${r.produced.scoresPerPost} profiles and raised about ${r.produced.alertsPerPostWithAlerts} alerts`,
    '',
    `${'request'.padEnd(34)} ${'n'.padStart(3)} ${'median ms'.padStart(10)} ${'p95 ms'.padStart(9)} ${'statements'.padStart(11)} ${'most'.padStart(6)}`,
  ];
  for (const [name, s] of Object.entries(r.routes)) {
    lines.push(`${name.padEnd(34)} ${String(s.n).padStart(3)} ${s.medianMs.toFixed(1).padStart(10)} ${s.p95Ms.toFixed(1).padStart(9)} ${String(s.medianQueries).padStart(11)} ${String(s.maxQueries).padStart(6)}`);
  }
  lines.push('', `digest of every stored score:  ${r.digests.scores}`, `digest of every alert, in order: ${r.digests.alerts}`, `digest of the "my jobs" answers: ${r.digests.mine}`);
  return lines.join('\n');
}

async function main(): Promise<number> {
  const args = parseBenchArgs(process.argv.slice(2));
  const result = await runBench(args, (m) => console.log(`  ${m}`));
  console.log(`\n${renderBench(result)}`);
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nwrote ${args.out}`);
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => process.exit(code), (err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
