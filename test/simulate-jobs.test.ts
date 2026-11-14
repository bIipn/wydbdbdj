/**
 * The job marketplace simulation (src/sim/jobs) on a small seed: simulated people (SIM … (simulated),
 * sim-…@example.com) post, bid, win, write, agree, back out and go silent through the real server over local
 * HTTP, on a clock the simulation moves itself. Every check must hold, the same seed must give the same report,
 * and the checks must be able to fail: three runs break a rule at a real seam (an onSend hook, the database
 * wrapper, twice), the bus seam runs too, and the other mutations are proven on altered copies of what the run saw
 * (the full set of real-seam mutations runs in `npm run simulate:jobs`).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { parseJobsArgs } from '../src/cli/simulate-jobs.js';
import { runChecks, type Observations } from '../src/sim/jobs/checks.js';
import { halfUp } from '../src/sim/jobs/expect.js';
import { buildCast, FULL_CAST, SMALL_CAST } from '../src/sim/jobs/people.js';
import { makePlan, type PlanSize } from '../src/sim/jobs/plan.js';
import { numbersIn, privateIn, runJobsSimulation, type JobsSimResult } from '../src/sim/jobs/run.js';

const SEED = 7;
/** Small enough for the normal suite: 4 posting people, 8 working people, 12 jobs plus reposts (every forced ending). */
const TINY: PlanSize = { jobs: 12, postingDays: 1 };
const OPTS = { seed: SEED, cast: SMALL_CAST, size: TINY, fastHash: true, port: 0 } as const;

let first: JobsSimResult;
let second: JobsSimResult;
let leak: JobsSimResult;
let rounding: JobsSimResult;
let settleAgain: JobsSimResult;
let oldRule: JobsSimResult;
beforeAll(async () => {
  first = await runJobsSimulation(OPTS);
  second = await runJobsSimulation(OPTS);
  leak = await runJobsSimulation({ ...OPTS, mutation: 'leak-amount' });
  rounding = await runJobsSimulation({ ...OPTS, mutation: 'fee-rounded-down' });
  settleAgain = await runJobsSimulation({ ...OPTS, mutation: 'settle-twice-two-rows' });
  oldRule = await runJobsSimulation({ ...OPTS, mutation: 'late-message-marks-poster' });
}, 180_000);

/** A deep copy of a run's observations to break one thing in. */
const copy = (o: Observations): Observations => structuredClone(o);
const caughtBy = (o: Observations, check: string) => runChecks(o).violations.filter((v) => v.check === check);

describe('the simulated people and jobs', () => {
  it('about 12 posters and 30 workers in the full cast, some doing both, every one labelled as simulated', () => {
    const cast = buildCast(FULL_CAST);
    expect(cast.filter((p) => p.posts)).toHaveLength(12);
    expect(cast.filter((p) => p.works)).toHaveLength(30);
    expect(cast.filter((p) => p.posts && p.works).length).toBeGreaterThan(0);
    for (const p of cast) {
      expect(p.name).toMatch(/^SIM .+ \(simulated\)$/);
      expect(p.email).toMatch(/^sim-[pwb]\d{2}@example\.com$/);
    }
    expect(new Set(cast.map((p) => p.zip.slice(0, 2))).size).toBeGreaterThanOrEqual(5); // several states
    expect(new Set(cast.flatMap((p) => p.trades)).size).toBeGreaterThanOrEqual(6);
  });

  it('the seeded script repeats, and only the seed changes it', () => {
    const people = buildCast(SMALL_CAST);
    const a = makePlan({ seed: 1, people, size: TINY, contactDays: 7 });
    expect(makePlan({ seed: 1, people, size: TINY, contactDays: 7 })).toEqual(a);
    expect(makePlan({ seed: 2, people, size: TINY, contactDays: 7 }).steps).not.toEqual(a.steps);
    for (const j of a.jobs) {
      expect(j.title).toMatch(/^SIM job /);
      expect(j.address).toMatch(/SIM Test Road \(simulated\)$/);
      expect(j.phone).toMatch(/^555-0100-/);
    }
  });

  it('fee arithmetic: cents x ppm, rounded half up once (5% of $395.00 = $19.75; $123.45 → $6.17; $123.50 → $6.18)', () => {
    expect(halfUp(39_500, 50_000)).toBe(1_975);
    expect(halfUp(12_345, 50_000)).toBe(617);
    expect(halfUp(12_350, 50_000)).toBe(618);
    expect(halfUp(0, 50_000)).toBe(0);
    expect(halfUp(25_000_000, 100_000)).toBe(2_500_000);
  });

  it('the answer scanners find amounts in JSON numbers and dollar text, but not under id keys', () => {
    expect([...numbersIn('{"id":12345,"amountCents":12345,"x":[777]} Lowest bid: $1,234.56')].sort()).toEqual([12345, 123456, 777].sort());
    expect([...numbersIn('{"jobId":55555}')]).toEqual([]);
    expect([...privateIn('"address":"117 SIM Test Road (simulated)","phone":"555-0100-0117"')]).toEqual([117]);
  });

  it('the CLI options', () => {
    expect(parseJobsArgs(['--seed', '9', '--small', '--no-mutations', '--port=0'])).toMatchObject({ seed: 9, small: true, mutations: false, port: 0 });
    expect(() => parseJobsArgs(['--seed', 'x'])).toThrow(/whole number/);
  });
});

describe('the run on a small seed', () => {
  it('every check holds, and every check looked at something', () => {
    expect(first.report.checks.violations).toEqual([]);
    for (const c of first.report.checks.results) expect(c.items, c.id).toBeGreaterThan(0);
  });

  it('every ending the rules allow happened, and fees were recorded only where they are due', () => {
    for (const label of ['agreed and done', 'agreed', 'winner never made contact', 'winner backed out', 'poster never answered', 'talked, no agreement', 'poster cancelled after the award', 'no bids', 'cancelled while open']) {
      expect(first.report.endings[label] ?? 0, label).toBeGreaterThan(0);
    }
    expect(first.report.totals.ties).toBeGreaterThan(0);
    expect(first.report.totals.reposts).toBeGreaterThan(0);
    expect(first.report.fees.noShow.count).toBeGreaterThan(0);
    expect(first.report.fees.service.count).toBeGreaterThan(0);
    expect(first.report.fees.paymentsOn).toBe(false);
    expect(first.report.fees.totalCents).toBe(first.observations.ledger.reduce((s, r) => s + r.amountCents, 0));
  });

  it('the fair-contact scenarios ran and ended as the changed rule says', () => {
    const endingOf = (ending: string) => first.observations.plan.jobs.filter((j) => j.ending === ending && first.observations.expect.get(j.key)?.winner);
    for (const ending of ['late_hello', 'poster_tap', 'winner_tap']) {
      const jobs = endingOf(ending);
      expect(jobs.length, ending).toBeGreaterThan(0);
      for (const j of jobs) {
        expect(first.observations.expect.get(j.key)!.outcome, `${ending} ${j.key}`).toBe('no_agreement');
        expect(first.observations.expect.get(j.key)!.fees, `${ending} ${j.key}`).toEqual([]);
      }
    }
    const silent = endingOf('poster_silent');
    expect(silent.length).toBeGreaterThan(0);
    for (const j of silent) expect(first.observations.expect.get(j.key)!.outcome).toBe('poster_no_show');
  });

  it('the same seed gives the same report hash', () => {
    expect(second.hash).toBe(first.hash);
  });

  it('the report says, in plain words, what an owner should know', () => {
    expect(first.report.findings.length).toBeGreaterThanOrEqual(8);
    expect(first.report.findings.join(' ')).toMatch(/Payments are off/);
    expect(JSON.stringify(first.report)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/); // no random ids
  });
});

describe('the checks can fail', () => {
  it('a real seam: an amount shown to the poster before closing is caught by sealed-bids', () => {
    expect(leak.report.checks.violations.filter((v) => v.check === 'sealed-bids').length).toBeGreaterThan(0);
  });

  it('a real seam: fees rounded down in the ledger are caught by fee-amount', () => {
    expect(rounding.report.checks.violations.filter((v) => v.check === 'fee-amount').length).toBeGreaterThan(0);
  });

  it('a real seam: the old contact rule put back (a last-minute "hi" marks the poster) is caught by endings', () => {
    expect(oldRule.report.checks.violations.filter((v) => v.check === 'endings').length).toBeGreaterThan(0);
  });

  it('a real seam: the product settling a job a second time (stale read, guards gone) is caught by settle-twice', () => {
    expect(settleAgain.report.checks.violations.filter((v) => v.check === 'settle-twice').length).toBeGreaterThan(0);
  });

  it('the second-lowest bid awarded → lowest-wins', () => {
    const o = copy(first.observations);
    const e = [...o.expect.values()].find((x) => x.winner && !x.tieAtLowest && x.inAtClose.length > 1)!;
    o.awardViews.get(e.key)!.get(e.poster).award.amountCents = e.inAtClose[1]!.amountCents;
    expect(caughtBy(o, 'lowest-wins').length).toBeGreaterThan(0);
  });

  it('a tie broken the wrong way → tie-break', () => {
    const o = copy(first.observations);
    const e = [...o.expect.values()].find((x) => x.tieAtLowest)!;
    o.awardWinner.set(e.key, e.inAtClose[1]!.who);
    expect(caughtBy(o, 'tie-break').length).toBeGreaterThan(0);
  });

  it("the address shown to a losing bidder → private-details", () => {
    const o = copy(first.observations);
    const e = [...o.expect.values()].find((x) => x.winner && x.inAtClose.length > 1)!;
    const job = o.plan.jobs.find((j) => j.key === e.key)!;
    o.privateHits.push({ n: Number(/^(\d+)/.exec(job.address)![1]), who: e.inAtClose[1]!.who, t: e.closesAt + 60_000, path: `/api/jobs/${e.key}` });
    expect(caughtBy(o, 'private-details').length).toBeGreaterThan(0);
  });

  it('a no-show fee when the POSTER never answered → fee-due', () => {
    const o = copy(first.observations);
    const e = [...o.expect.values()].find((x) => x.outcome === 'poster_no_show')!;
    o.finalViews.get(e.key)!.get(e.poster).fees.push({ kind: 'no_show', amountCents: 100, posterShareCents: 40, status: 'recorded', owedByMe: false });
    expect(caughtBy(o, 'fee-due').length).toBeGreaterThan(0);
  });

  it('a job settled twice into two fee rows → settle-twice', () => {
    const o = copy(first.observations);
    o.ledger.push({ ...o.ledger[0]! });
    expect(caughtBy(o, 'settle-twice').length).toBeGreaterThan(0);
  });

  it('an alert to the wrong account → alerts', () => {
    const o = copy(first.observations);
    const [from, list] = [...o.alerts.entries()].find(([, l]) => l.some((a) => a.kind === 'job_awarded'))!;
    const moved = list.find((a) => a.kind === 'job_awarded');
    o.alerts.set(from, list.filter((a) => a !== moved));
    const to = o.people.find((p) => p.key !== from)!.key;
    o.alerts.set(to, [...(o.alerts.get(to) ?? []), moved]);
    expect(caughtBy(o, 'alerts').length).toBeGreaterThanOrEqual(2);
  });

  it('a closed job left in a feed → feed', () => {
    const o = copy(first.observations);
    const e = [...o.expect.values()].find((x) => x.winner)!;
    const who = o.people.find((p) => p.key !== e.poster)!.key;
    o.feedSnaps.push({ t: e.closesAt + 3_600_000, who, jobs: [e.key] });
    expect(caughtBy(o, 'feed').length).toBeGreaterThan(0);
  });
});
