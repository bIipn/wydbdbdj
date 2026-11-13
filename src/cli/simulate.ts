/**
 * Multi-company simulation:  npm run simulate -- --seed 20261113 --out <dir>
 *
 * Simulated companies (src/sim/personas.ts) use the real server end to end on the REAL captured bids (every
 * board in test/fixtures, SAM.gov included), the checks run on what the API answered, the same seed is run
 * twice to prove the report repeats, and each mutation breaks one rule to prove its check catches it.
 * Writes report.md and report.json to --out. No network: every bid comes from the captured pages.
 *
 *   --seed N        (default 20261113)
 *   --out DIR       (default ./out/sim)
 *   --port N        first run's port (default 8796; later runs take any free port)
 *   --scale N       profile variations in the scale pass (default 1000, 0 = skip)
 *   --no-scale-db   scale pass without the database scan
 *   --no-mutations  skip the mutation runs
 *
 * Exit code 1 when a check fails, the report does not repeat, or a mutation is not caught.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderMarkdown, type MutationOutcome } from '../sim/report.js';
import { MUTATIONS, runSimulation, type MutationId, type SimOptions } from '../sim/run.js';

export interface SimulateArgs {
  seed: number;
  out: string;
  port: number;
  scale: number;
  scaleDb: boolean;
  mutations: boolean;
}

export function parseArgs(argv: string[]): SimulateArgs {
  const args: SimulateArgs = { seed: 20261113, out: resolve(process.cwd(), 'out/sim'), port: 8796, scale: 1000, scaleDb: true, mutations: true };
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
    else if (flag === '--scale') args.scale = whole(value(), '--scale');
    else if (flag === '--no-scale-db') args.scaleDb = false;
    else if (flag === '--no-mutations') args.mutations = false;
    else throw new Error(`unknown option ${a}`);
  }
  return args;
}

/** Runs every mutation once (twice for "nondeterministic") and reports whether its check caught it. */
export async function runMutations(base: SimOptions, progress: (m: string) => void = () => {}): Promise<MutationOutcome[]> {
  const out: MutationOutcome[] = [];
  for (const id of Object.keys(MUTATIONS) as MutationId[]) {
    const { check, how, selfTest } = MUTATIONS[id];
    progress(`mutation "${id}"`);
    const opts: SimOptions = { ...base, log: () => {}, mutation: id, scaleProfiles: 0, speedMs: 20, port: 0 };
    if (id === 'nondeterministic') {
      const a = await runSimulation(opts);
      const b = await runSimulation(opts);
      const caught = a.hash !== b.hash;
      out.push({ mutation: id, how, expects: check, caught, violations: caught ? 1 : 0, example: `report sha256 ${a.hash.slice(0, 12)} vs ${b.hash.slice(0, 12)}` });
      continue;
    }
    const r = await runSimulation(opts);
    const hits = r.report.checks.violations.filter((v) => v.check === check);
    out.push({
      mutation: id, how, expects: check, caught: hits.length > 0, violations: hits.length,
      example: hits[0] ? `${hits[0].persona}: ${hits[0].detail}` : 'not caught', ...(selfTest ? { selfTest: true } : {}),
    });
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const log = (m: string) => console.log(`  ${m}`);
  const base: SimOptions = { seed: args.seed, log };

  console.log(`simulation, seed ${args.seed}: main run`);
  const first = await runSimulation({ ...base, port: args.port, scaleProfiles: args.scale, scaleDb: args.scaleDb });
  console.log('simulation: second run with the same seed (determinism)');
  const second = await runSimulation({ ...base, log: () => {}, port: 0, scaleProfiles: 0, speedMs: 20 });
  const determinism = { same: first.hash === second.hash, hashes: [first.hash, second.hash] };
  const mutations = args.mutations ? await runMutations(base, (m) => console.log(`simulation: ${m}`)) : [];

  mkdirSync(args.out, { recursive: true });
  const md = renderMarkdown(first.report, first.measurements, { determinism, ...(args.mutations ? { mutations } : {}) });
  writeFileSync(resolve(args.out, 'report.md'), md);
  const json = { report: first.report, measurements: first.measurements, hash: first.hash, determinism, mutations };
  writeFileSync(resolve(args.out, 'report.json'), `${JSON.stringify(json, null, 2)}\n`);

  const v = first.report.checks.violations;
  console.log(`\nchecks: ${v.length === 0 ? 'all passed' : `${v.length} violation(s)`}`);
  for (const x of v.slice(0, 20)) console.log(`  ! ${x.check} ${x.persona}: ${x.detail}`);
  console.log(`same seed, same report: ${determinism.same ? 'yes' : 'NO'} (${first.hash.slice(0, 16)})`);
  if (args.mutations) {
    const real = mutations.filter((m) => !m.selfTest);
    const self = mutations.filter((m) => m.selfTest);
    console.log(`mutations caught: ${real.filter((m) => m.caught).length} of ${real.length}${self.length ? ` (plus ${self.length} checker self-test(s), caught: ${self.filter((m) => m.caught).length})` : ''}`);
  }
  const unexercised = Object.entries(first.report.checks.coverage).filter(([k, c]) => k !== 'determinism' && c.items === 0).map(([k]) => k);
  if (unexercised.length) console.log(`checks not exercised by this data: ${unexercised.join(', ')}`);
  console.log(`wrote ${resolve(args.out, 'report.md')} and report.json`);
  return v.length === 0 && determinism.same && mutations.every((m) => m.caught) ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => process.exit(code), (err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
