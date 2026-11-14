/**
 * The marketplace simulation's report: report.json (everything) and report.md (what a non-engineer reads).
 * Every figure comes from the run. Money is integer cents and is only turned into "$1,234.56" text here.
 * Nothing in the report depends on the machine or on random ids, so the same seed gives the same hash;
 * the machine's timings are kept apart (measurements).
 */
import { lookupZip } from '../../geo/zip.js';
import type { Checked, Observations } from './checks.js';
import { endingLabel } from './expect.js';
import type { JobsMeasurements } from './run.js';

export interface FeeTotals {
  count: number;
  amountCents: number;
  posterShareCents: number;
  platformCents: number;
}

export interface JobsReport {
  seed: number;
  mutation: string | null;
  simulatedFrom: string;
  simulatedTo: string;
  rules: Record<string, unknown>;
  people: Array<{
    key: string; name: string; email: string; place: string; intent: string; trades: string[];
    posted: number; bidOn: number; won: number; jobAlerts: number; matchAlerts: number;
  }>;
  totals: {
    jobs: number; originals: number; reposts: number; awarded: number; noBids: number; ties: number;
    bids: { placed: number; changed: number; withdrawn: number; cameBack: number; refusalsTried: number };
    messages: number; feedReads: number; ticks: number;
  };
  endings: Record<string, number>;
  fees: { noShow: FeeTotals; service: FeeTotals; totalCents: number; awardedCents: number; paymentsOn: boolean };
  jobs: Array<{
    key: string; poster: string; place: string; trades: string; closesInDays: number; ceilingCents: number | null;
    bids: number; lowCents: number | null; highCents: number | null; winner: string | null; ending: string; status: string;
    outcome: string | null; fees: string;
  }>;
  checks: Checked;
  findings: string[];
}

export const usd = (c: number): string => {
  const neg = c < 0;
  const a = Math.abs(c);
  return `${neg ? '-' : ''}$${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
};

/** n / d as a percentage with one decimal, from integers only. */
const pct = (n: number, d: number): string => {
  if (d === 0) return '0%';
  const tenths = Math.round((n * 1000) / d);
  return `${Math.floor(tenths / 10)}.${tenths % 10}%`;
};

const placeOf = (zip: string) => {
  const z = lookupZip(zip);
  return z ? `${z.city}, ${z.state} ${z.zip}` : zip;
};

export function buildReport(o: Observations, checked: Checked, meta: { seed: number; mutation: string | null }): JobsReport {
  const plan = o.plan;
  const exp = [...o.expect.values()];
  const final = (job: string, who: string) => o.finalViews.get(job)?.get(who) ?? null;

  // Bid statistics, from the script.
  const seen = new Map<string, { amount: number; active: boolean }>();
  let placed = 0;
  let changed = 0;
  let withdrawn = 0;
  let cameBack = 0;
  let messages = 0;
  for (const s of plan.steps) {
    const a = s.act;
    if (a.kind === 'bid') {
      const k = `${a.job} ${a.who}`;
      const cur = seen.get(k);
      if (!cur) placed++;
      else if (!cur.active) cameBack++;
      else if (cur.amount !== a.amountCents) changed++;
      seen.set(k, { amount: a.amountCents, active: true });
    } else if (a.kind === 'withdraw') {
      withdrawn++;
      const k = `${a.job} ${a.who}`;
      seen.set(k, { amount: seen.get(k)?.amount ?? 0, active: false });
    } else if (a.kind === 'message') messages++;
  }

  const endings: Record<string, number> = {};
  for (const e of exp) {
    const shown = final(e.key, e.poster);
    const label = shown ? endingLabel({ status: shown.status, outcome: shown.outcome ?? null }) : 'not posted';
    endings[label] = (endings[label] ?? 0) + 1;
  }

  const totals = (kind: string): FeeTotals => {
    const rows = o.ledger.filter((r) => r.kind === kind);
    return {
      count: rows.length, amountCents: rows.reduce((s, r) => s + r.amountCents, 0),
      posterShareCents: rows.reduce((s, r) => s + r.posterShareCents, 0), platformCents: rows.reduce((s, r) => s + r.platformCents, 0),
    };
  };
  const noShow = totals('no_show');
  const service = totals('service');
  const awardedCents = exp.reduce((s, e) => s + (e.winner?.amountCents ?? 0), 0);

  const people = o.people.map((p) => {
    const alerts = o.alerts.get(p.key) ?? [];
    return {
      key: p.key, name: p.name, email: p.email, place: placeOf(p.zip), intent: p.intent, trades: p.trades,
      posted: plan.jobs.filter((j) => j.poster === p.key).length,
      bidOn: plan.jobs.filter((j) => j.bidders.includes(p.key)).length,
      won: [...o.awardWinner.values()].filter((w) => w === p.key).length,
      jobAlerts: alerts.filter((a) => String(a.kind).startsWith('job_')).length,
      matchAlerts: alerts.filter((a) => a.kind === 'match').length,
    };
  });

  const jobs = plan.jobs.map((j) => {
    const e = o.expect.get(j.key)!;
    const shown = final(j.key, j.poster);
    const fees = ((shown?.fees ?? []) as any[]).map((f) => `${f.kind === 'no_show' ? 'no-show' : 'service'} ${usd(f.amountCents)}`).join('; ') || '—';
    const amounts = e.inAtClose.map((b) => b.amountCents);
    return {
      key: j.key, poster: j.poster, place: placeOf(j.zip), trades: j.trades.join(' + '), closesInDays: j.closesInDays, ceilingCents: j.budgetMaxCents,
      bids: e.inAtClose.length, lowCents: amounts.length ? Math.min(...amounts) : null, highCents: amounts.length ? Math.max(...amounts) : null,
      winner: o.awardWinner.get(j.key) ?? null,
      ending: shown ? endingLabel({ status: shown.status, outcome: shown.outcome ?? null }) : 'not posted',
      status: shown?.status ?? 'missing', outcome: shown?.outcome ?? null, fees,
    };
  });

  const t = {
    jobs: plan.jobs.length, originals: plan.jobs.filter((j) => !j.repostOf).length, reposts: plan.jobs.filter((j) => j.repostOf).length,
    awarded: exp.filter((e) => e.winner).length, noBids: exp.filter((e) => e.outcome === 'no_bids').length, ties: exp.filter((e) => e.tieAtLowest).length,
    bids: { placed, changed, withdrawn, cameBack, refusalsTried: o.refusals.length }, messages,
    feedReads: o.feedSnaps.length, ticks: plan.ticks.length,
  };

  const report: JobsReport = {
    seed: meta.seed, mutation: meta.mutation,
    simulatedFrom: new Date(plan.steps[0]?.t ?? plan.endAt).toISOString(), simulatedTo: new Date(plan.endAt).toISOString(),
    rules: o.rules ?? {}, people, totals: t, endings,
    fees: { noShow, service, totalCents: noShow.amountCents + service.amountCents, awardedCents, paymentsOn: o.rules?.paymentsOn === true },
    jobs, checks: checked, findings: [],
  };
  report.findings = findings(report, o);
  return report;
}

/** "What an owner should know", computed from the run. */
function findings(r: JobsReport, o: Observations): string[] {
  const f: string[] = [];
  const e = r.endings;
  const n = r.totals.jobs;
  const agreed = (e['agreed'] ?? 0) + (e['agreed and done'] ?? 0);
  const ok = (id: string) => r.checks.results.find((c) => c.id === id)?.violations === 0;
  f.push(`${n} jobs (${r.totals.originals} posted, ${r.totals.reposts} posted again): ${agreed} ended with both sides agreeing (${pct(agreed, n)}), ${e['agreed and done'] ?? 0} of them marked done; ${n - agreed - (e['cancelled while open'] ?? 0)} ended unfilled; cancelled while open: ${e['cancelled while open'] ?? 0}.`);
  const awarded = r.totals.awarded;
  const noShow = e['winner never made contact'] ?? 0;
  const backed = e['winner backed out'] ?? 0;
  f.push(`Of ${awarded} jobs that had a winner, ${noShow} winner(s) never made contact and ${backed} backed out (${pct(noShow + backed, awarded)}): each owes the ${r.rules.noShowFeePct}% no-show fee, ${r.rules.posterSharePct} points of it for the poster.`);
  f.push(`${e['poster never answered'] ?? 0} poster(s) never answered a winner who wrote, and ${e['talked, no agreement'] ?? 0} pair(s) talked without agreeing: no fee for anyone, as the rules say. ${e['poster cancelled after the award'] ?? 0} poster(s) cancelled after the award, also free.`);
  const fees = r.fees;
  f.push(`Fees recorded: ${usd(fees.totalCents)} in ${fees.noShow.count + fees.service.count} ledger rows. No-show fees ${usd(fees.noShow.amountCents)} (${fees.noShow.count}): ${usd(fees.noShow.posterShareCents)} for the posters whose time was wasted, ${usd(fees.noShow.platformCents)} for BidSwipe. Service fees ${usd(fees.service.amountCents)} (${fees.service.count}), all BidSwipe's.`);
  f.push(`Payments are off: none of this was collected (every row is "recorded"). If they were on, BidSwipe's part would be ${usd(fees.noShow.platformCents + fees.service.platformCents)}, ${pct(fees.noShow.platformCents + fees.service.platformCents, fees.awardedCents)} of the ${usd(fees.awardedCents)} awarded in the run.`);
  f.push(`${r.totals.noBids} job(s) got no bids at all (${pct(r.totals.noBids, n)}); ${r.totals.reposts} unfilled or cancelled job(s) were posted again with one tap, and ${r.jobs.filter((j) => j.key.endsWith('r') && (j.status === 'agreed' || j.status === 'completed')).length} of those found an agreement.`);
  const spreads = r.jobs.filter((j) => j.bids >= 2 && j.lowCents && j.highCents).map((j) => Math.round(((j.highCents! - j.lowCents!) * 100) / j.lowCents!)).sort((a, b) => a - b);
  if (spreads.length) f.push(`On ${spreads.length} jobs with two or more bids, the highest bid was a median ${spreads[Math.floor(spreads.length / 2)]}% above the lowest (largest gap ${spreads.at(-1)}%): sealed bids do spread out.`);
  f.push(`${r.totals.ties} job(s) had a tie at the lowest amount; ${ok('tie-break') ? 'every one went to the bid placed first' : 'NOT all went to the bid placed first (see the checks)'}. Bids changed ${r.totals.bids.changed} time(s) and were withdrawn ${r.totals.bids.withdrawn} time(s) before closing, ${r.totals.bids.cameBack} came back.`);
  const jobAlerts = r.people.reduce((s, p) => s + p.jobAlerts, 0);
  f.push(`${jobAlerts} job alerts went out (won, bids in, messages, 2 days left, job closed): ${ok('alerts') ? 'each to the right person, once' : 'SOME went wrong (see the checks)'}. ${r.people.reduce((s, p) => s + p.matchAlerts, 0)} "new job near you" match alerts went to workers, ${ok('alerts') ? 'never to the job\'s own poster' : 'see the checks'}.`);
  f.push(`${ok('sealed-bids') && ok('private-details') ? 'No amount leaked before closing and no address or phone reached anyone but the poster and the winner' : 'A PRIVACY CHECK FAILED (see the checks)'}, across ${o.amountHits.length + o.privateHits.length} places those figures appeared in answers.`);
  const worst = r.people.filter((p) => p.won > 0).length;
  f.push(`${worst} of ${r.people.filter((p) => p.trades.length).length} simulated workers won at least one job.`);
  return f;
}

export interface MutationOutcome {
  mutation: string;
  how: string;
  expects: string;
  caught: boolean;
  violations: number;
  example: string;
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function renderJobsMarkdown(r: JobsReport, m: JobsMeasurements, extra: { determinism?: { same: boolean; hashes: string[] }; mutations?: MutationOutcome[] } = {}): string {
  const L: string[] = [];
  const v = r.checks.violations;
  L.push('# BidSwipe job marketplace simulation');
  L.push('');
  L.push(`Seed ${r.seed}${r.mutation ? ` · MUTATION ${r.mutation}` : ''} · simulated time ${r.simulatedFrom.slice(0, 16)}Z to ${r.simulatedTo.slice(0, 16)}Z · ${r.people.length} simulated people · ${r.totals.jobs} simulated jobs.`);
  L.push('');
  L.push('Everything here is SIMULATED: every person is "SIM … (simulated)" at sim-…@example.com, every job title starts "SIM job", addresses are on "SIM Test Road (simulated)", phones are 555-0100 numbers, and the amounts are drawn by the seeded script. Only the ZIP codes (the public place of a job) are real. It all ran through the real server over local HTTP, in accounts mode, on a clock the simulation moved itself. Fees are recorded, never collected: payments are off.');
  L.push('');
  const unexercised = r.checks.results.filter((c) => c.items === 0).map((c) => c.id);
  L.push(`**Checks: ${v.length === 0 ? 'all passed' : `${v.length} VIOLATION(S)`}** (${r.checks.results.length} checks).${unexercised.length ? ` **Not exercised** (nothing to look at): ${unexercised.join(', ')}.` : ''}`);
  if (extra.determinism) L.push(`**Same seed, same report: ${extra.determinism.same ? 'yes' : 'NO'}** (sha256 ${extra.determinism.hashes.map((h) => h.slice(0, 12)).join(' / ')}).`);
  if (extra.mutations) L.push(`**Mutations caught: ${extra.mutations.filter((x) => x.caught).length} of ${extra.mutations.length}.**`);
  L.push('');

  L.push('## What an owner should know');
  L.push('');
  for (const f of r.findings) L.push(`- ${f}`);
  L.push('');

  L.push('## The rules the server ran with');
  L.push('');
  L.push(`No-show fee ${r.rules.noShowFeePct}% (poster's share ${r.rules.posterSharePct}%), service fee ${r.rules.serviceFeePct}%, ${r.rules.contactDays} days to make contact, bids from ${usd(Number(r.rules.minCents))} to ${usd(Number(r.rules.maxCents))}, payments ${r.rules.paymentsOn ? 'ON' : 'off'}.`);
  L.push('');

  L.push('## How the jobs ended');
  L.push('');
  L.push('| Ending | Jobs |');
  L.push('|---|--:|');
  for (const [k, n] of Object.entries(r.endings).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) L.push(`| ${k} | ${n} |`);
  L.push('');
  L.push(`Bids: ${r.totals.bids.placed} placed, ${r.totals.bids.changed} changed, ${r.totals.bids.withdrawn} withdrawn (${r.totals.bids.cameBack} came back), ${r.totals.bids.refusalsTried} tries the rules refuse. ${r.totals.ties} tie(s) at the lowest amount. ${r.totals.messages} messages. ${r.totals.ticks} daily ticks, ${r.totals.feedReads} feed reads.`);
  L.push('');

  L.push('## Fees recorded (none collected)');
  L.push('');
  L.push('| Kind | Rows | Total | To posters | To BidSwipe |');
  L.push('|---|--:|--:|--:|--:|');
  L.push(`| No-show (${r.rules.noShowFeePct}%) | ${r.fees.noShow.count} | ${usd(r.fees.noShow.amountCents)} | ${usd(r.fees.noShow.posterShareCents)} | ${usd(r.fees.noShow.platformCents)} |`);
  L.push(`| Service (${r.rules.serviceFeePct}%) | ${r.fees.service.count} | ${usd(r.fees.service.amountCents)} | ${usd(r.fees.service.posterShareCents)} | ${usd(r.fees.service.platformCents)} |`);
  L.push(`| **All** | ${r.fees.noShow.count + r.fees.service.count} | ${usd(r.fees.totalCents)} | ${usd(r.fees.noShow.posterShareCents + r.fees.service.posterShareCents)} | ${usd(r.fees.noShow.platformCents + r.fees.service.platformCents)} |`);
  L.push('');

  L.push('## The checks');
  L.push('');
  L.push('| Check | What it looked at | Items | Violations |');
  L.push('|---|---|--:|--:|');
  for (const c of r.checks.results) L.push(`| ${c.id} | ${cell(c.what)} | ${c.items} | ${c.violations} |`);
  L.push('');
  if (v.length) {
    L.push('### Violations');
    L.push('');
    for (const x of v.slice(0, 60)) L.push(`- **${x.check}**: ${cell(x.detail)}`);
    if (v.length > 60) L.push(`- … and ${v.length - 60} more (report.json has them all)`);
    L.push('');
  }
  if (extra.mutations) {
    L.push('## Mutations: each breaks one rule on purpose');
    L.push('');
    L.push('| Mutation | How the rule was broken | Check expected to catch it | Caught | Example |');
    L.push('|---|---|---|---|---|');
    for (const x of extra.mutations) L.push(`| ${x.mutation} | ${cell(x.how)} | ${x.expects} | ${x.caught ? `yes (${x.violations})` : '**NO**'} | ${cell(x.example).slice(0, 220)} |`);
    L.push('');
  }

  L.push('## The people (simulated)');
  L.push('');
  L.push('| Who | Name | Place | Here to | Trades | Posted | Bid on | Won | Job alerts | Match alerts |');
  L.push('|---|---|---|---|---|--:|--:|--:|--:|--:|');
  for (const p of r.people) L.push(`| ${p.key} | ${cell(p.name)} | ${cell(p.place)} | ${p.intent === 'hire' ? 'get work done' : p.intent === 'work' ? 'find work' : 'both'} | ${p.trades.join(' + ') || '—'} | ${p.posted} | ${p.bidOn} | ${p.won} | ${p.jobAlerts} | ${p.matchAlerts} |`);
  L.push('');

  L.push('## Every job (simulated)');
  L.push('');
  L.push('| Job | Poster | Place | Trades | Days | Ceiling | Bids at closing | Lowest | Highest | Winner | Ending | Fees |');
  L.push('|---|---|---|---|--:|--:|--:|--:|--:|---|---|---|');
  for (const j of r.jobs) {
    L.push(`| ${j.key} | ${j.poster} | ${cell(j.place)} | ${cell(j.trades)} | ${j.closesInDays} | ${j.ceilingCents === null ? '—' : usd(j.ceilingCents)} | ${j.bids} | ${j.lowCents === null ? '—' : usd(j.lowCents)} | ${j.highCents === null ? '—' : usd(j.highCents)} | ${j.winner ?? '—'} | ${j.ending} | ${j.fees} |`);
  }
  L.push('');

  L.push('## This machine (not part of the report hash)');
  L.push('');
  L.push(`Node ${m.machine.node} on ${m.machine.platform}, ${m.machine.cpus} CPUs: ${m.requests} requests in ${(m.totalMs / 1000).toFixed(1)} s of wall time.`);
  L.push('');
  L.push('| Route | Requests | Median ms | 95th pct ms |');
  L.push('|---|--:|--:|--:|');
  for (const [k, x] of Object.entries(m.routes)) L.push(`| ${cell(k)} | ${x.n} | ${x.p50} | ${x.p95} |`);
  L.push('');
  return `${L.join('\n')}\n`;
}
