/**
 * The job marketplace simulation:  npm run simulate:jobs -- --seed 20261114 --out out/sim-jobs
 *
 * About 12 simulated posters and 30 simulated workers (some do both) post about 100 jobs (plus reposts), bid,
 * win, write, agree, back out and go silent, through the real server over local HTTP in accounts mode, on a
 * clock the simulation moves itself. The checks (src/sim/jobs/checks.ts) run on what the API answered; the
 * same seed is run twice to prove the report repeats; each mutation breaks one rule at a real seam to prove
 * its check catches it. Writes report.md and report.json to --out. No network beyond 127.0.0.1.
 *
 *   --seed N        (default 20261114)
 *   --out DIR       (default ./out/sim-jobs)
 *   --port N        the main run's port (default 0 = any free port; later runs always take any free port)
 *   --small         the small cast and plan (what the test suite runs)
 *   --no-mutations  skip the mutation runs
 *
 * Exit code 1 when a check fails, the report does not repeat, or a mutation is not caught.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FULL_CAST, SMALL_CAST } from '../sim/jobs/people.js';
import { FULL_PLAN, SMALL_PLAN } from '../sim/jobs/plan.js';
import { renderJobsMarkdown, type MutationOutcome } from '../sim/jobs/report.js';
import { JOBS_MUTATIONS, runJobsSimulation, type JobsMutationId, type JobsSimOptions } from '../sim/jobs/run.js';

export interface SimulateJobsArgs {
  seed: number;
  out: string;
  port: number;
  small: boolean;
  mutations: boolean;
}

export function parseJobsArgs(argv: string[]): SimulateJobsArgs {
  const args: SimulateJobsArgs = { seed: 20261114, out: resolve(process.cwd(), 'out/sim-jobs'), port: 0, small: false, mutations: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf('=');
    const flag = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);
    const value = () => inline ?? argv[++i] ?? '';
    const whole = (v: string, name: string) => {
      if (!/^\d+$/.test(v)) throw new Error(`${name} must be a whole number, got "${v}"`);
      return Number(v);
    };
    if (flag === '--seed') args.seed = whole(value(), '--seed');
    else if (flag === '--out') args.out = resolve(process.cwd(), value());
    else if (flag === '--port') args.port = whole(value(), '--port');
    else if (flag === '--small') args.small = true;
    else if (flag === '--no-mutations') args.mutations = false;
    else throw new Error(`unknown option ${a}`);
  }
  return args;
}

/** Runs every mutation once and reports whether the check meant for it caught it. */
export async function runJobsMutations(base: JobsSimOptions, progress: (m: string) => void = () => {}): Promise<MutationOutcome[]> {
  const out: MutationOutcome[] = [];
  for (const id of Object.keys(JOBS_MUTATIONS) as JobsMutationId[]) {
    const { check, how } = JOBS_MUTATIONS[id];
    progress(`mutation "${id}"`);
    const r = await runJobsSimulation({ ...base, log: () => {}, mutation: id, port: 0 });
    const hits = r.report.checks.violations.filter((v) => v.check === check);
    out.push({ mutation: id, how, expects: check, caught: hits.length > 0, violations: hits.length, example: hits[0]?.detail ?? 'not caught' });
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseJobsArgs(process.argv.slice(2));
  const log = (m: string) => console.log(`  ${m}`);
  const base: JobsSimOptions = { seed: args.seed, ...(args.small ? { cast: SMALL_CAST, size: SMALL_PLAN } : { cast: FULL_CAST, size: FULL_PLAN }) };

  console.log(`marketplace simulation, seed ${args.seed}: main run`);
  const first = await runJobsSimulation({ ...base, log, port: args.port });
  console.log('marketplace simulation: second run with the same seed (determinism)');
  // The rerun and the mutations use light password hashing: sign-up speed is not what they test, and the
  // report does not depend on it (the main run keeps the server's real cost).
  const second = await runJobsSimulation({ ...base, port: 0, fastHash: true });
  const determinism = { same: first.hash === second.hash, hashes: [first.hash, second.hash] };
  const mutations = args.mutations ? await runJobsMutations({ ...base, fastHash: true }, (m) => console.log(`marketplace simulation: ${m}`)) : [];

  mkdirSync(args.out, { recursive: true });
  writeFileSync(resolve(args.out, 'report.md'), renderJobsMarkdown(first.report, first.measurements, { determinism, ...(args.mutations ? { mutations } : {}) }));
  writeFileSync(resolve(args.out, 'report.json'), `${JSON.stringify({ report: first.report, measurements: first.measurements, hash: first.hash, determinism, mutations }, null, 2)}\n`);

  const v = first.report.checks.violations;
  console.log(`\nchecks: ${v.length === 0 ? 'all passed' : `${v.length} violation(s)`}`);
  for (const x of v.slice(0, 20)) console.log(`  ! ${x.check}: ${x.detail}`);
  for (const c of first.report.checks.results) console.log(`  ${c.violations === 0 ? 'ok' : 'FAIL'}  ${c.id.padEnd(16)} ${String(c.items).padStart(6)} looked at, ${c.violations} violation(s)`);
  console.log(`same seed, same report: ${determinism.same ? 'yes' : 'NO'} (${first.hash.slice(0, 16)})`);
  if (args.mutations) {
    console.log(`mutations caught: ${mutations.filter((m) => m.caught).length} of ${mutations.length}`);
    for (const m of mutations) console.log(`  ${m.caught ? 'caught' : 'MISSED'}  ${m.mutation} → ${m.expects}${m.caught ? ` (${m.violations})` : ''}`);
  }
  const unexercised = first.report.checks.results.filter((c) => c.items === 0).map((c) => c.id);
  if (unexercised.length) console.log(`checks not exercised by this run: ${unexercised.join(', ')}`);
  console.log(`wrote ${resolve(args.out, 'report.md')} and report.json`);
  return v.length === 0 && determinism.same && mutations.every((m) => m.caught) ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => process.exit(code), (err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
