/**
 * The marketplace simulation (`npm run simulate:jobs`): simulated posters and workers use the REAL server over
 * local HTTP, in accounts mode, on a clock the simulation moves itself (the server's `now`), so a 14-day job,
 * its award and its 7-day contact window play out in seconds.
 *
 *   1. An in-memory database, AUTH_MODE=accounts, alerts on (no push devices), a cron secret so the
 *      simulation can be the host's scheduler (GET /api/cron/tick), the server on a local port.
 *   2. Everybody signs up and onboards (PUT /api/profile with "What brings you here?").
 *   3. The seeded script (plan.ts) is played step by step: posts, bids, changes, withdrawals, peeks, refusals,
 *      the award, the contact window, reposts, and a daily tick that settles twice and reads every feed.
 *   4. Everybody looks at everything at the end: every job, "my jobs", the alert inbox. The fee ledger is
 *      read from the database.
 *   5. The checks (checks.ts) compare what the API answered with what the contract says (expect.ts).
 *
 * Nothing here is real: SIM people at example.com, SIM jobs on "SIM Test Road", 555-0100 phone numbers.
 */
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { AddressInfo } from 'node:net';
import { cpus as osCpus, platform as osPlatform } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createAuth } from '../../auth/index.js';
import { loadConfig, type AppConfig } from '../../context.js';
import { openDb, type Db } from '../../db/db.js';
import { SCHEMA_SQL } from '../../db/schema.js';
import { createBus } from '../../realtime/bus.js';
import { createRealtime } from '../../realtime/index.js';
import { buildApp } from '../../server.js';
import { runChecks, type Observations, type Violation } from './checks.js';
import { Phone, type Received } from './client.js';
import { expectJobs, pctToPpmSim, type RatesPpm } from './expect.js';
import { JOBS_MUTATIONS, mutateAnswers, mutateBus, mutateDb, type JobsMutationId } from './mutations.js';
import { buildCast, FULL_CAST, onboardingAnswers, type CastSize, type SimPerson } from './people.js';
import { FULL_PLAN, makePlan, MINUTE, SIM_START, type Plan, type PlanSize } from './plan.js';
import { buildReport, type JobsReport } from './report.js';

export interface JobsSimOptions {
  seed: number;
  cast?: CastSize;
  size?: PlanSize;
  /** 0 = any free port. */
  port?: number;
  mutation?: JobsMutationId;
  /** Lighter password hashing (tests). The default is the server's real cost. */
  fastHash?: boolean;
  log?: (msg: string) => void;
}

export interface JobsMeasurements {
  machine: { node: string; platform: string; cpus: number };
  requests: number;
  totalMs: number;
  /** Per route: count, median and 95th percentile wall time on this machine. */
  routes: Record<string, { n: number; p50: number; p95: number }>;
}

export interface JobsSimResult {
  report: JobsReport;
  measurements: JobsMeasurements;
  /** sha256 of the report (never the measurements). Same seed, same hash. */
  hash: string;
  /** What the checks read (for tests of the checks themselves). Not part of the hash. */
  observations: Observations;
}

const ADMIN_TOKEN = 'SIM-admin-token-not-a-secret';
const CRON_SECRET = 'SIM-cron-secret-not-a-secret';
const APP_URL = 'https://bidswipe.example.com';

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const jobsReportHash = (r: JobsReport): string => createHash('sha256').update(canonical(r)).digest('hex');

/**
 * Starting an empty embedded database runs initdb (about 2 s); cloning one from a dump takes a fraction of
 * that. The first run of this process makes the dump; every later run (the same-seed rerun, the mutations)
 * starts from it. In memory only: nothing is written to disk.
 */
let emptyDump: Promise<Blob | null> | null = null;
async function freshDb(): Promise<Db> {
  emptyDump ??= (async () => {
    try {
      const pg = new PGlite('memory://');
      await pg.exec(SCHEMA_SQL);
      const dump = await pg.dumpDataDir('gzip');
      await pg.close();
      return dump;
    } catch {
      return null;
    }
  })();
  const dump = await emptyDump;
  if (dump) {
    try {
      return await openDb({ dataDir: 'memory://', loadDataDir: dump });
    } catch {
      // an unreadable dump: start the slow way
    }
  }
  return openDb({ dataDir: 'memory://' });
}

// -------------------------------------------------------------- scanning answers --

/** JSON numbers in an answer (except under an "id"-like key) and dollar figures in its text, as cents. */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/"([A-Za-z_]+)"\s*:\s*(\d+)(?=\s*[,}\]])/g)) {
    if (!/^id$|Id$/.test(m[1]!)) out.add(Number(m[2]));
  }
  for (const m of text.matchAll(/[[,]\s*(\d+)(?=\s*[,\]])/g)) out.add(Number(m[1]));
  for (const m of text.matchAll(/\$(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?/g)) out.add(Number(m[1]!.replace(/,/g, '')) * 100 + Number(m[2] ?? 0));
  return out;
}

/** The street numbers of "<n> SIM Test Road (simulated)" and the serials of "555-0100-<nnnn>" in an answer. */
export function privateIn(text: string): Set<number> {
  const out = new Set<number>();
  if (!text.includes('SIM Test Road') && !text.includes('555-0100-')) return out;
  for (const m of text.matchAll(/(\d+) SIM Test Road \(simulated\)/g)) out.add(Number(m[1]));
  for (const m of text.matchAll(/555-0100-(\d{4})/g)) out.add(Number(m[1]));
  return out;
}

// ----------------------------------------------------------------------- the run --

export async function runJobsSimulation(opts: JobsSimOptions): Promise<JobsSimResult> {
  const t0 = performance.now();
  const log = opts.log ?? (() => {});
  const people = buildCast(opts.cast ?? FULL_CAST);
  const mutation = opts.mutation;

  // ---- the server, on the simulation's clock
  let clock = SIM_START;
  const now = () => new Date(clock);
  const realDb = await freshDb();
  const handle = await mutateDb(realDb, mutation);
  const db = handle.db;
  const bus = createBus((err, event) => log(`! bus listener failed on ${event.type}: ${err instanceof Error ? err.message : String(err)}`));
  mutateBus(bus, mutation, realDb);
  const config: AppConfig = {
    ...loadConfig({ AUTH_MODE: 'accounts', APP_URL, CRON_SECRET }), demoMode: false, adminToken: ADMIN_TOKEN, cronSecret: CRON_SECRET,
  };
  const received: Received[] = [];
  const obs: Observations = {
    people, plan: null as unknown as Plan, expect: new Map(), rules: null, accountOf: new Map(), personOfAccount: new Map(),
    jobId: new Map(), jobKeyOf: new Map(), apiProblems: [], amountOwners: new Map(), amountHits: [], privateHits: [],
    awardWinner: new Map(), awardViews: new Map(), finalViews: new Map(), mine: new Map(), feedSnaps: [], settles: [], reposts: [],
    alerts: new Map(), ledger: [], refusals: [], jobsPosted: [],
  };
  const sink = (r: Received) => {
    received.push({ ...r, text: '' }); // keep the timing, not the bytes
    if (r.who === 'operator' || r.who === 'cron') return;
    for (const n of numbersIn(r.text)) if (obs.amountOwners.has(n)) obs.amountHits.push({ n, who: r.who, t: r.t, path: label(r.path) });
    for (const n of privateIn(r.text)) obs.privateHits.push({ n, who: r.who, t: r.t, path: label(r.path) });
  };
  /** Job ids → J001 in anything that lands in the report (ids are random; the report must repeat). */
  const label = (s: string) => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => obs.jobKeyOf.get(id) ?? 'unknown-job');

  const { app, ctx } = await buildApp({ db }, {
    config, bus, now,
    auth: createAuth(db, config, { now, ...(opts.fastHash ? { cost: { ln: 10, r: 8, p: 1 } } : {}) }),
  });
  mutateAnswers(app, mutation, realDb);
  const realtime = createRealtime(ctx, { sender: null, tickMs: 0 });
  ctx.realtime = realtime;
  await app.listen({ port: opts.port ?? 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  log(`server on 127.0.0.1:${port} (accounts mode, simulated clock from ${new Date(SIM_START).toISOString()})${mutation ? `, mutation ${mutation}` : ''}`);

  const tClock = () => clock;
  const cron = new Phone(port, 'cron', '198.51.100.251', tClock, sink, { authorization: `Bearer ${CRON_SECRET}` });
  const phones = new Map<string, Phone>();
  const problem = (where: string, detail: string) => obs.apiProblems.push({ t: clock, where, detail: label(detail) });
  const expectStatus = (where: string, res: { status: number; text: string }, want: number): boolean => {
    if (res.status === want) return true;
    problem(where, `answered ${res.status} (expected ${want}): ${res.text.slice(0, 160)}`);
    return false;
  };

  try {
    // ---- the rules (public), then everybody signs up and onboards
    const rulesRes = await cron.get('/api/jobs/rules');
    obs.rules = rulesRes.body?.rules ?? null;
    if (!obs.rules) throw new Error(`GET /api/jobs/rules answered ${rulesRes.status}`);
    const rates: RatesPpm = { noShow: pctToPpmSim(obs.rules.noShowFeePct), posterShare: pctToPpmSim(obs.rules.posterSharePct), service: pctToPpmSim(obs.rules.serviceFeePct) };
    const plan = makePlan({ seed: opts.seed, people, size: opts.size ?? FULL_PLAN, contactDays: obs.rules.contactDays });
    obs.plan = plan;
    obs.expect = expectJobs(plan, rates);
    log(`plan: ${plan.jobs.length} jobs, ${plan.steps.length} steps, ${plan.ticks.length} daily ticks, ends ${new Date(plan.endAt).toISOString()}`);

    for (const [i, p] of people.entries()) {
      const phone = new Phone(port, p.key, `203.0.113.${i + 1}`, tClock, sink);
      phones.set(p.key, phone);
      const up = await phone.call('POST', '/api/auth/signup', { email: p.email, password: p.password, name: p.name });
      if (up.status !== 201) throw new Error(`${p.key}: sign-up answered ${up.status}: ${up.text}`);
      obs.accountOf.set(p.key, up.body.account.id as string);
      obs.personOfAccount.set(up.body.account.id as string, p.key);
      const on = await phone.call('PUT', '/api/profile', onboardingAnswers(p));
      if (on.status !== 200) throw new Error(`${p.key}: onboarding answered ${on.status}: ${on.text}`);
    }
    const phone = (key: string) => phones.get(key)!;
    const planned = new Map(plan.jobs.map((j) => [j.key, j] as const));
    const idOf = (key: string) => obs.jobId.get(key) ?? 'not-posted';
    const stranger = (job: { poster: string; bidders: string[] }): SimPerson | undefined =>
      people.find((p) => p.key !== job.poster && !job.bidders.includes(p.key));
    const register = (n: number, job: string, who: string) => {
      const cur = obs.amountOwners.get(n);
      if (cur && cur.job !== job) throw new Error(`simulate:jobs: amount ${n} used on two jobs (${cur.job}, ${job})`);
      obs.amountOwners.set(n, { job, owners: new Set([...(cur?.owners ?? []), who]) });
    };
    const winnerOf = (job: string): Phone | null => {
      const w = obs.awardWinner.get(job);
      return w ? phone(w) : null;
    };

    // ---- the script
    for (const step of plan.steps) {
      clock = step.t;
      const a = step.act;
      const where = `${a.kind}${'job' in a ? ` ${a.job}` : ''}`;
      switch (a.kind) {
        case 'post': {
          const j = planned.get(a.job)!;
          const res = await phone(j.poster).call('POST', '/api/jobs', {
            title: j.title, description: j.description, trades: j.trades, zip: j.zip, address: j.address, phone: j.phone,
            ...(j.budgetMaxCents === null ? {} : { budgetMaxCents: j.budgetMaxCents }), closesInDays: j.closesInDays,
          });
          if (!expectStatus(where, res, 201)) break;
          obs.jobId.set(a.job, res.body.job.id);
          obs.jobKeyOf.set(res.body.job.id, a.job);
          obs.jobsPosted.push(a.job);
          if (res.body.job.closesAt !== new Date(j.closesAt).toISOString()) problem(where, `closesAt ${res.body.job.closesAt}, expected ${new Date(j.closesAt).toISOString()}`);
          break;
        }
        case 'repost': {
          const j = planned.get(a.job)!;
          const p = phone(j.poster);
          const before = await p.get(`/api/jobs/${idOf(a.from)}`);
          const res = await p.call('POST', `/api/jobs/${idOf(a.from)}/repost`, { closesInDays: j.closesInDays });
          const after = await p.get(`/api/jobs/${idOf(a.from)}`);
          if (expectStatus(where, res, 201)) {
            obs.jobId.set(a.job, res.body.job.id);
            obs.jobKeyOf.set(res.body.job.id, a.job);
            obs.jobsPosted.push(a.job);
          }
          obs.reposts.push({ job: a.job, from: a.from, t: clock, days: j.closesInDays, fromId: idOf(a.from), before: before.body?.job ?? null, after: after.body?.job ?? null, created: res.status === 201 ? res.body.job : null });
          break;
        }
        case 'bid': {
          register(a.amountCents, a.job, a.who);
          const res = await phone(a.who).call('POST', `/api/jobs/${idOf(a.job)}/bid`, { amountCents: a.amountCents, ...(a.note ? { note: a.note } : {}), agree: true });
          if (expectStatus(where, res, 200) && res.body.job?.my?.bid?.amountCents !== a.amountCents) problem(where, `${a.who}'s bid shows ${res.body.job?.my?.bid?.amountCents}, sent ${a.amountCents}`);
          break;
        }
        case 'withdraw':
          expectStatus(where, await phone(a.who).call('DELETE', `/api/jobs/${idOf(a.job)}/bid`), 200);
          break;
        case 'peek':
          expectStatus(where, await phone(a.who).get(a.what === 'job' ? `/api/jobs/${idOf(a.job)}` : '/api/jobs/mine'), 200);
          break;
        case 'refuse': {
          register(a.amountCents, a.job, a.who);
          const res = await phone(a.who).call('POST', `/api/jobs/${idOf(a.job)}/bid`, { amountCents: a.amountCents, agree: true });
          obs.refusals.push({ job: a.job, who: a.who, why: a.why, expect: a.expect, got: res.status });
          break;
        }
        case 'cancel-open': {
          const j = planned.get(a.job)!;
          expectStatus(where, await phone(j.poster).call('POST', `/api/jobs/${idOf(a.job)}/cancel`), 200);
          // Its closing time has not come, so only the product taking the card out keeps it out of the feeds:
          // read them all now, not at the next daily tick.
          await readFeeds(clock);
          break;
        }
        case 'award-view': {
          const j = planned.get(a.job)!;
          const pv = await phone(j.poster).get(`/api/jobs/${idOf(a.job)}`);
          const view = pv.body?.job ?? null;
          const winnerId: string | null = view?.award?.winner?.id ?? null;
          obs.awardWinner.set(a.job, winnerId ? obs.personOfAccount.get(winnerId) ?? `unknown account` : null);
          const views = new Map<string, any>([[j.poster, view]]);
          for (const who of j.bidders) views.set(who, (await phone(who).get(`/api/jobs/${idOf(a.job)}`)).body?.job ?? null);
          const s = stranger(j);
          if (s) views.set(s.key, (await phone(s.key).get(`/api/jobs/${idOf(a.job)}`)).body?.job ?? null);
          obs.awardViews.set(a.job, views);
          break;
        }
        case 'message': {
          const j = planned.get(a.job)!;
          const actor = a.side === 'poster' ? phone(j.poster) : winnerOf(a.job);
          if (!actor) {
            problem(where, 'no winner to act for (the award view showed none)');
            break;
          }
          expectStatus(where, await actor.call('POST', `/api/jobs/${idOf(a.job)}/messages`, { body: a.body }), 200);
          break;
        }
        case 'contacted':
        case 'complete':
        case 'cancel-awarded': {
          const j = planned.get(a.job)!;
          const path = a.kind === 'contacted' ? 'contacted' : a.kind === 'complete' ? 'complete' : 'cancel';
          expectStatus(where, await phone(j.poster).call('POST', `/api/jobs/${idOf(a.job)}/${path}`), 200);
          break;
        }
        case 'confirm':
        case 'back-out': {
          const j = planned.get(a.job)!;
          const actor = a.kind === 'confirm' && a.side === 'poster' ? phone(j.poster) : winnerOf(a.job);
          if (!actor) {
            problem(where, 'no winner to act for (the award view showed none)');
            break;
          }
          expectStatus(where, await actor.call('POST', `/api/jobs/${idOf(a.job)}/${a.kind}`), 200);
          break;
        }
        case 'tick':
          await tick(clock);
          break;
      }
    }

    // ---- everybody looks at everything at the end
    clock = plan.endAt + 10 * MINUTE;
    for (const j of plan.jobs) {
      if (!obs.jobId.has(j.key)) continue;
      const views = new Map<string, any>();
      const who = [j.poster, ...j.bidders, ...(stranger(j) ? [stranger(j)!.key] : [])];
      for (const k of who) views.set(k, (await phone(k).get(`/api/jobs/${idOf(j.key)}`)).body?.job ?? null);
      obs.finalViews.set(j.key, views);
    }
    for (const p of people) {
      const mine = await phone(p.key).get('/api/jobs/mine');
      expectStatus(`mine ${p.key}`, mine, 200);
      obs.mine.set(p.key, mine.body ?? null);
      const items: any[] = [];
      let before = '';
      for (let page = 0; page < 50; page++) {
        const res = await phone(p.key).get(`/api/alerts?limit=200${before}`);
        const got: any[] = res.body?.items ?? [];
        items.push(...got);
        if (got.length < 200) break;
        before = `&before=${Math.min(...got.map((x) => Number(x.id)))}`;
      }
      obs.alerts.set(p.key, items);
    }
    obs.ledger = (await realDb.query<Record<string, unknown>>(
      `select id, job_id, kind, payer_id, basis_cents, rate_ppm, amount_cents, poster_share_ppm, poster_share_cents, platform_cents, status
       from job_fees order by id`,
    )).map((r) => ({
      job: obs.jobKeyOf.get(String(r.job_id)) ?? 'unknown-job', kind: String(r.kind), payer: obs.personOfAccount.get(String(r.payer_id)) ?? 'unknown',
      basisCents: Number(r.basis_cents), ratePpm: Number(r.rate_ppm), amountCents: Number(r.amount_cents), posterSharePpm: Number(r.poster_share_ppm),
      posterShareCents: Number(r.poster_share_cents), platformCents: Number(r.platform_cents), status: String(r.status),
    }));

    // ---- the checks and the report
    const checked = runChecks(obs);
    const report = buildReport(obs, checked, { seed: opts.seed, mutation: mutation ?? null });
    const measurements = measure(received, performance.now() - t0);
    return { report, measurements, hash: jobsReportHash(report), observations: obs };
  } finally {
    realtime.stop();
    await app.close();
    await realDb.close();
    handle.restore();
  }

  /** The host's cron: settle twice at the same moment (the second must change nothing), then read every feed. */
  async function tick(at: number): Promise<void> {
    const snap = async () => JSON.stringify(await Promise.all([
      realDb.query(`select id, status, outcome, winner_bid_id::text as w, award_cents::text as a, ended_at, contact_deadline from jobs order by id`),
      realDb.query(`select id::text as id, status, amount_cents::text as a, created_at from job_bids order by id`),
      realDb.query(`select id::text as id, job_id, kind, amount_cents::text as a, status from job_fees order by id`),
      realDb.query(`select count(*)::int as n from alerts`),
    ]));
    const first = await cron.get('/api/cron/tick');
    if (first.status !== 200) problem('tick', `GET /api/cron/tick answered ${first.status}`);
    const a = await snap();
    const second = await cron.get('/api/cron/tick');
    if (second.status !== 200) problem('tick', `GET /api/cron/tick answered ${second.status}`);
    const b = await snap();
    obs.settles.push({ t: at, same: a === b });
    await readFeeds(at);
  }

  /** Every person's feed (Browse, local jobs only), as their phone would show it now. */
  async function readFeeds(at: number): Promise<void> {
    for (const p of people) {
      const res = await phones.get(p.key)!.get('/api/feed?all=1&minScore=0&limit=300&source=local');
      if (res.status !== 200) {
        problem(`feed ${p.key}`, `answered ${res.status}`);
        continue;
      }
      const items: any[] = res.body.items ?? [];
      obs.feedSnaps.push({ t: at, who: p.key, jobs: items.map((x) => (typeof x.id === 'string' && x.id.startsWith('local:') ? obs.jobKeyOf.get(x.id.slice(6)) ?? 'unknown-job' : null)).filter((x): x is string => x !== null) });
    }
  }
}

function measure(received: Received[], totalMs: number): JobsMeasurements {
  const byRoute = new Map<string, number[]>();
  for (const r of received) {
    const route = `${r.method} ${r.path.replace(/\?.*$/, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')}`;
    byRoute.set(route, [...(byRoute.get(route) ?? []), r.ms]);
  }
  const q = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]! * 100) / 100;
  };
  const routes: JobsMeasurements['routes'] = {};
  for (const [k, xs] of [...byRoute.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) routes[k] = { n: xs.length, p50: q(xs, 0.5), p95: q(xs, 0.95) };
  return { machine: { node: process.version, platform: osPlatform(), cpus: osCpus().length }, requests: received.length, totalMs: Math.round(totalMs), routes };
}

export { JOBS_MUTATIONS, type JobsMutationId, type Violation };
