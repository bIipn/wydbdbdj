/**
 * Cost-engine simulation (spec 10.0 L6, 10.10):  npm run simulate:cost -- --companies 5000 --seed 20261113
 *
 * Generates N SIMULATED companies (src/cost/synthetic.ts; never real firms), prices three jobs for each with
 * the engine, runs the cash ledger, stress cases and limits check, checks every applicable spec section 10
 * invariant on every result, and prints a summary. Pure computation: no network, no database, no .env.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  buildBid,
  grossUp,
  priceBasedCharge,
  rCmp,
  type BidBreakdown,
  type BidInput,
  type Cents,
  type Ppm,
} from '../cost/index.js';
import { cashLedger, financingCost, peakFloat, stressCases } from '../cost/cash.js';
import { limitsCheck } from '../cost/limits.js';
import { bondTriggered, cashJobFor, simCompany, simJob, type SimJob } from '../cost/synthetic.js';

export interface SimulationOptions {
  readonly companies: number;
  readonly seed: number;
  readonly jobsPerCompany?: number;
  /** Index of the first company (default 0): lets a test re-run one company from a large run. */
  readonly firstCompany?: number;
}

export interface Dist {
  n: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  max: number;
}
export interface SimulationSummary {
  seed: number;
  companies: number;
  jobs: number;
  priced: number;
  refused: Record<string, number>;
  byState: Record<string, number>;
  byOwner: Record<string, number>;
  byRegime: Record<string, number>;
  byOverheadMethod: Record<string, number>;
  bonded: number;
  financed: number;
  headcount: Dist;
  priceToCost: Dist; // P_bid / TJC
  peakFloatShareOfPrice: Dist; // F* / P_bid
  financingShareOfCost: Dist; // FIN / TJC
  limits: Record<string, { stop: number; warn: number; ok: number; unknown: number; info: number; shortfallDollars: Dist | null }>;
  anyStressStop: number;
  invariantChecks: number;
  violations: Record<string, number>;
  violationTotal: number;
  violationExamples: string[];
  sha256: string;
}

function dist(xs: number[]): Dist {
  const s = [...xs].sort((a, b) => a - b);
  const at = (k: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(k * (s.length - 1)))]! : NaN);
  return { n: s.length, p5: at(0.05), p25: at(0.25), p50: at(0.5), p75: at(0.75), p95: at(0.95), max: s.length ? s[s.length - 1]! : NaN };
}
const inc = (m: Record<string, number>, k: string, by = 1) => (m[k] = (m[k] ?? 0) + by);

const safeNN = (x: number) => Number.isSafeInteger(x) && x >= 0;

/** Raise one input a little (invariant 46: never lowers P). Deterministic in the job id. */
function bumped(inp: BidInput, which: number): BidInput {
  const cl = inp.labor.classes;
  switch (which % 5) {
    case 0:
      return { ...inp, labor: { ...inp.labor, classes: cl.map((c, i) => (i === 0 ? { ...c, h10: (c.h10 + 100) as typeof c.h10 } : c)) } };
    case 1:
      return { ...inp, labor: { ...inp.labor, classes: cl.map((c, i) => (i === 0 ? { ...c, wBasic: (c.wBasic + 1) as Cents } : c)) } };
    case 2:
      return { ...inp, materials: { ...inp.materials, lines: inp.materials.lines.map((l, i) => (i === 0 ? { ...l, quantity: (l.quantity + 1000) as typeof l.quantity } : l)) } };
    case 3:
      return { ...inp, subcontracts: [...inp.subcontracts, { id: 'bump', amount: 100 as Cents }] };
    default:
      return { ...inp, materials: { ...inp.materials, salesTaxPpm: Math.min(150_000, inp.materials.salesTaxPpm + 1) as Ppm } };
  }
}

export function runSimulation(opts: SimulationOptions): SimulationSummary {
  const perCo = opts.jobsPerCompany ?? 3;
  const v: Record<string, number> = {};
  const examples: string[] = [];
  let checks = 0;
  const check = (inv: string, ok: boolean, job: SimJob, detail = '') => {
    checks++;
    if (!ok) {
      inc(v, inv);
      if (examples.length < 20) examples.push(`${inv} ${job.id} ${detail}`);
    }
  };
  const S: SimulationSummary = {
    seed: opts.seed, companies: opts.companies, jobs: 0, priced: 0, refused: {}, byState: {}, byOwner: {}, byRegime: {}, byOverheadMethod: {},
    bonded: 0, financed: 0, headcount: dist([]), priceToCost: dist([]), peakFloatShareOfPrice: dist([]), financingShareOfCost: dist([]),
    limits: {}, anyStressStop: 0, invariantChecks: 0, violations: v, violationTotal: 0, violationExamples: examples, sha256: '',
  };
  const heads: number[] = [], p2c: number[] = [], fShare: number[] = [], finShare: number[] = [];
  const shortfalls: Record<string, number[]> = {};
  const hash = createHash('sha256');
  const first = opts.firstCompany ?? 0;
  for (let ci = first; ci < first + opts.companies; ci++) {
    const co = simCompany(opts.seed, ci);
    heads.push(co.headcount);
    for (let j = 0; j < perCo; j++) {
      const job = simJob(opts.seed, co, j);
      S.jobs++;
      inc(S.byState, job.state);
      inc(S.byOwner, job.owner);
      inc(S.byRegime, job.regime);
      inc(S.byOverheadMethod, job.bid.overhead.method);
      let b0: BidBreakdown, b: BidBreakdown;
      try {
        b0 = buildBid(job.bid);
        const t0 = b0.totals;
        const parts = { L: t0.L, MAT: t0.MAT, E: t0.E, SUB: t0.SUB, other: t0.ST + t0.JOOH + t0.ESC_L + t0.CONT, q: 0 };
        // spec 2.12 / 5.6: FIN from the cash model at the price without FIN (one pass, A-20)
        b = buildBid({
          ...job.bid,
          financing: {
            include: true,
            compute: (S0, P0) => financingCost(cashLedger(cashJobFor(job, { ...parts, q: P0 - S0 }, P0)), co.creditRatePpm as Ppm, 365).FIN,
          },
        });
      } catch (err) {
        inc(S.refused, (err as { code?: string }).code ?? (err as Error).name);
        check('10 refusal is a RangeError', err instanceof RangeError, job, String(err));
        continue;
      }
      S.priced++;
      S.financed++;
      const t = b.totals;
      if (b.bondApplied) S.bonded++;
      // ---- 12, 45: conservation; every total is the sum of its lines, all non-negative safe integers
      const parts = [t.L, t.ST, t.MAT, t.E, t.SUB, t.JOOH, t.ESC_L, t.CONT];
      check('12 safe non-negative integers', [...parts, t.TJC, t.OH, t.PR, t.FIN, t.S, t.q, t.P, t.Pbid].every(safeNN), job);
      check('45 TJC = L+ST+MAT+E+SUB+JOOH+ESC_L+CONT', t.TJC === parts.reduce((a, x) => a + x, 0), job);
      check('45 S = TJC+OH+PR+FIN', t.S === t.TJC + t.OH + t.PR + t.FIN, job);
      check('45 P = S + q(P)', t.P === t.S + t.q, job);
      check('12 L = sum of class L', t.L === b.labor.classes.reduce((a, k) => a + k.L, 0), job);
      check(
        '12 class L = sum of its lines',
        b.labor.classes.every((k) => k.L === k.wages.G + k.SS + k.MED + k.FUTA + k.SUTA + k.MBT + k.FLAT + k.WC + k.GLp + k.FR + k.TR + k.OTH),
        job,
      );
      const m = b.materials;
      check('12 MAT = M + ESC_M + TAX + FRT', t.MAT === m.M + m.ESC_M + m.TAX + m.FRT, job);
      // ---- 19: gross-up exact and smallest
      const ch = b.bondApplied ? job.bid.charges : { ...job.bid.charges, tiers: [] };
      const chNoAuto = { tiers: ch.tiers, mDurPpm: ch.mDurPpm, fees: ch.fees };
      check('19 P - q(P) = S', t.P - priceBasedCharge(t.P, chNoAuto) === t.S, job);
      check('19 P - 1 fails', t.P === 0 || t.P - 1 - priceBasedCharge((t.P - 1) as Cents, chNoAuto) < t.S, job);
      // ---- 46: ordering, and raising one input never lowers P
      check('46 P >= S >= BE >= TJC', t.P >= t.S && t.S >= t.BE && t.BE >= t.TJC, job);
      try {
        const up = buildBid(bumped(job.bid, ci + j)).totals;
        check('46 raising an input never lowers P', up.P >= b0.totals.P && up.Pbid >= b0.totals.Pbid, job, `${b0.totals.P} -> ${up.P}`);
      } catch {
        /* a bump that crosses a guard is a refusal, not a price */
      }
      // ---- 58, 57
      const unit = job.bid.bidRoundingUnit ?? 1;
      check('58 0 <= P_bid - P < unit', t.Pbid - t.P >= 0 && t.Pbid - t.P < unit, job);
      check('58 rounding difference appears in profit and charges', t.roundingToProfit + t.roundingToCharges === t.Pbid - t.P, job);
      // ---- 61: the bond applies exactly when the no-bond contract price exceeds the owner's trigger (spec 2.13, 4.2)
      if (job.bonded === 'auto') {
        // the contract price as bid (spec 2.14): the no-bond price rounded up to the bid unit
        const noBondP = grossUp(t.S, { tiers: [], mDurPpm: ch.mDurPpm, fees: ch.fees }).P;
        const noBond = Math.ceil(noBondP / unit) * unit;
        check('61 bond applied iff the no-bond price exceeds the legal trigger', b.bondApplied === bondTriggered(job.owner, noBond, job.federalOfficerChoiceMeansBond), job, `noBond ${noBond}, applied ${b.bondApplied}`);
      }
      // ---- cash (spec 5) at the bid price; C_cash = TJC + q(P_bid)
      const cj = cashJobFor(job, { L: t.L, MAT: t.MAT, E: t.E, SUB: t.SUB, other: t.ST + t.JOOH + t.ESC_L + t.CONT, q: t.qBid }, t.Pbid);
      const L = cashLedger(cj);
      const pk = peakFloat(L);
      const fin = financingCost(L, co.creditRatePpm as Ppm, 365);
      const sum = (xs: readonly number[]) => xs.reduce((a, x) => a + x, 0);
      check('70 sum OUT = C_cash', sum(L.OUT) === L.Ccash && L.Ccash === t.TJC + t.qBid, job);
      check('70 sum IN = P', sum(L.IN) === t.Pbid, job);
      check('70 N(H) = P - C_cash', L.N[L.N.length - 1] === t.Pbid - L.Ccash, job);
      check('72 0 <= F*_rf <= F* <= C_cash', 0 <= pk.Frf && pk.Frf <= pk.F && pk.F <= L.Ccash, job);
      const first = L.IN.findIndex((x) => x > 0);
      check('73 F* >= cash paid through the first receipt', first < 0 || pk.F >= sum(L.OUT.slice(0, first + 1)), job);
      check('82 financed final cash = P - C_cash - FIN', fin.financedFinalCash === t.Pbid - L.Ccash - fin.FIN, job);
      check('82 interest >= simple approximation', rCmp(fin.FINexact, fin.simpleApprox) >= 0, job);
      check('82 financed peak >= unfinanced peak', fin.financedPeak >= pk.F, job);
      check('83 pay applications sum to P', sum(L.payApps.map((a) => a.gross)) === t.Pbid, job);
      check('83 billed to date never exceeds P', L.billedToDate.every((x) => x <= t.Pbid), job);
      const rr = L.retainage;
      const rmax = Math.max(cj.retainage.rho1Ppm, cj.retainage.rho2Ppm);
      check('62 0 <= W_j <= max(rho) B_j (+1 cent)', rr.rows.every((r) => r.W >= 0 && r.W <= (rmax * r.B) / 1_000_000 + 1), job);
      check('63 net + held + released = gross', rr.rows.every((r, i) => sum(rr.rows.slice(0, i + 1).map((x) => x.pay)) + r.R + sum(rr.rows.slice(0, i + 1).map((x) => x.Rel)) === sum(rr.rows.slice(0, i + 1).map((x) => x.B))), job);
      check('65 gross withheld never exceeds the cap', rr.capTotal === null || rr.rows.every((r) => r.grossWithheld <= rr.capTotal!), job);
      check('66 retainage held never negative', rr.rows.every((r) => r.R >= 0), job);
      // ---- limits (spec 5.8) with stress cases; 86: more cash never turns fits into short
      const st = stressCases(cj, { codKinds: ['material', 'equipment'], laborIncreasePpm: 200_000 as Ppm }); // spec 5.8: labor +20% at fixed price
      const lim = limitsCheck({ price: t.Pbid, peak: pk, limits: co.limits, bondRequired: b.bondApplied, stress: st.cases });
      const more = limitsCheck({ price: t.Pbid, peak: pk, limits: { ...co.limits, cashForJob: (co.limits.cashForJob + 1_000_000) as Cents }, bondRequired: b.bondApplied });
      const pf = (x: typeof lim) => x.checks.find((k) => k.id === 'peak_float')!.verdict;
      const rank = { ok: 0, warn: 1, stop: 2 } as Record<string, number>;
      check('86 more cash never turns fits into short', rank[pf(more)]! <= rank[pf(lim)]!, job);
      check('86 headroom linear in funds', more.headroom - lim.headroom === 1_000_000, job);
      check('12.1 rule 3: rule-of-thumb checks never pass or fail', lim.checks.every((k) => !k.ruleOfThumb || !['ok', 'warn', 'stop'].includes(k.verdict)), job);
      for (const k of lim.checks) {
        const e = (S.limits[k.id] ??= { stop: 0, warn: 0, ok: 0, unknown: 0, info: 0, shortfallDollars: null });
        e[k.verdict]++;
        let short = 0;
        if (k.verdict === 'stop' || k.verdict === 'warn') {
          if (k.id === 'job_size') short = t.Pbid - (co.limits.maxJobSize ?? t.Pbid);
          else if (k.id === 'up_front_cash') short = pk.upFront - (co.limits.maxUpFrontCash ?? pk.upFront);
          else if (k.id === 'peak_float') short = Math.max(0, -lim.headroom);
          else if (k.id === 'bonding' && co.limits.suretyLetter)
            short = Math.max(t.Pbid - co.limits.suretyLetter.singleLimit, co.limits.suretyLetter.backlogRemaining + t.Pbid - co.limits.suretyLetter.aggregateLimit);
          (shortfalls[k.id] ??= []).push(short / 100);
        }
      }
      if (lim.stress.some((s) => s.verdict === 'stop')) S.anyStressStop++;
      p2c.push(t.Pbid / t.TJC);
      fShare.push(pk.F / t.Pbid);
      finShare.push(t.FIN / t.TJC);
      hash.update(`${job.id}|${t.TJC}|${t.FIN}|${t.P}|${t.Pbid}|${pk.F}|${pk.tStar}|${fin.FIN}|${lim.checks.map((k) => k.verdict).join(',')}\n`);
    }
  }
  S.headcount = dist(heads);
  S.priceToCost = dist(p2c);
  S.peakFloatShareOfPrice = dist(fShare);
  S.financingShareOfCost = dist(finShare);
  for (const [k, xs] of Object.entries(shortfalls)) if (S.limits[k]) S.limits[k]!.shortfallDollars = dist(xs);
  S.invariantChecks = checks;
  S.violationTotal = Object.values(v).reduce((a, x) => a + x, 0);
  S.sha256 = hash.digest('hex');
  return S;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
export function formatSummary(s: SimulationSummary): string {
  const L: string[] = [];
  const kv = (m: Record<string, number>) => Object.entries(m).sort().map(([k, n]) => `${k} ${n}`).join(', ');
  L.push(`Cost-engine simulation  seed ${s.seed}  (SIMULATED companies SIM-0001.. — never real firms)`);
  L.push(`Companies ${s.companies}  jobs ${s.jobs}  priced ${s.priced}  refused ${kv(s.refused) || 0}  bonded ${s.bonded}  financed ${s.financed}`);
  L.push(`Headcount        p5 ${s.headcount.p5}  p50 ${s.headcount.p50}  p95 ${s.headcount.p95}  max ${s.headcount.max}`);
  L.push(`By state         ${kv(s.byState)}`);
  L.push(`By owner         ${kv(s.byOwner)}`);
  L.push(`By regime        ${kv(s.byRegime)}`);
  L.push(`By OH method     ${kv(s.byOverheadMethod)}`);
  const d = (x: Dist, f: (n: number) => string) => `p5 ${f(x.p5)}  p25 ${f(x.p25)}  p50 ${f(x.p50)}  p75 ${f(x.p75)}  p95 ${f(x.p95)}  max ${f(x.max)}`;
  L.push(`Bid price / TJC  ${d(s.priceToCost, (n) => n.toFixed(3))}`);
  L.push(`Peak float / P   ${d(s.peakFloatShareOfPrice, pct)}`);
  L.push(`FIN / TJC        ${d(s.financingShareOfCost, (n) => (n * 100).toFixed(2) + '%')}`);
  L.push('Limits (verdict counts; shortfall when stop/warn):');
  for (const [k, e] of Object.entries(s.limits).sort()) {
    const sf = e.shortfallDollars ? `  shortfall p50 ${usd(e.shortfallDollars.p50)}  p95 ${usd(e.shortfallDollars.p95)}  max ${usd(e.shortfallDollars.max)}` : '';
    L.push(`  ${k.padEnd(26)} stop ${e.stop}  warn ${e.warn}  ok ${e.ok}  unknown ${e.unknown}  info ${e.info}${sf}`);
  }
  L.push(`Jobs with a stress case that does not fit: ${s.anyStressStop}`);
  L.push(`Invariant checks ${s.invariantChecks}  violations ${s.violationTotal}${s.violationTotal ? ': ' + kv(s.violations) : ''}`);
  for (const e of s.violationExamples) L.push(`  ${e}`);
  L.push(`sha256 ${s.sha256}`);
  return L.join('\n');
}

function arg(name: string, dflt: number): number {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === `--${name}`) return Number(a[i + 1]);
    if (a[i]!.startsWith(`--${name}=`)) return Number(a[i]!.split('=')[1]);
  }
  return dflt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const companies = arg('companies', 100), seed = arg('seed', 20261113);
  if (!Number.isInteger(companies) || companies < 1 || !Number.isInteger(seed)) {
    console.error('usage: npm run simulate:cost -- --companies N --seed S');
    process.exit(2);
  }
  const t0 = performance.now();
  const s = runSimulation({ companies, seed });
  console.log(formatSummary(s));
  console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  process.exitCode = s.violationTotal === 0 ? 0 : 1;
}
