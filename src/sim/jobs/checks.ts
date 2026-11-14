/**
 * The marketplace simulation's checks. Each one reads what the API answered (or, for the ledger and the
 * settle-twice snapshot, what the database holds) and compares it with expect.ts, which works the answer out
 * from the contract without the product's code. Every violation names the job (J001…) and the person
 * (P01/W07/B02…), never a random id, so the report repeats for the same seed.
 */
import { endingLabel, expectedFee, openAt, type ExpectedAlert, type JobExpect, alertKey } from './expect.js';
import type { CheckId } from './mutations.js';
import type { SimPerson } from './people.js';
import type { Plan } from './plan.js';

export interface Violation {
  check: CheckId;
  detail: string;
}

export interface LedgerRow {
  job: string;
  kind: string;
  payer: string;
  basisCents: number;
  ratePpm: number;
  amountCents: number;
  posterSharePpm: number;
  posterShareCents: number;
  platformCents: number;
  status: string;
}

export interface Observations {
  people: SimPerson[];
  plan: Plan;
  expect: Map<string, JobExpect>;
  rules: any;
  accountOf: Map<string, string>;
  personOfAccount: Map<string, string>;
  jobId: Map<string, string>;
  jobKeyOf: Map<string, string>;
  jobsPosted: string[];
  apiProblems: Array<{ t: number; where: string; detail: string }>;
  /** Every bid amount the script sent, with the job and the people who sent it. */
  amountOwners: Map<number, { job: string; owners: Set<string> }>;
  /** Registered amounts found in an answer: who received it, when, from which route. */
  amountHits: Array<{ n: number; who: string; t: number; path: string }>;
  /** Private details (street number / phone serial) found in an answer. */
  privateHits: Array<{ n: number; who: string; t: number; path: string }>;
  /** The winner the API showed the poster right after closing (null: no award shown). */
  awardWinner: Map<string, string | null>;
  awardViews: Map<string, Map<string, any>>;
  finalViews: Map<string, Map<string, any>>;
  mine: Map<string, any>;
  feedSnaps: Array<{ t: number; who: string; jobs: string[] }>;
  settles: Array<{ t: number; same: boolean }>;
  reposts: Array<{ job: string; from: string; fromId: string; t: number; days: number; before: any; after: any; created: any }>;
  alerts: Map<string, any[]>;
  ledger: LedgerRow[];
  refusals: Array<{ job: string; who: string; why: string; expect: number; got: number }>;
}

export interface CheckResult {
  id: CheckId;
  what: string;
  /** How many things it looked at (a check that looked at nothing proves nothing). */
  items: number;
  violations: number;
}

export interface Checked {
  results: CheckResult[];
  violations: Violation[];
}

export const CHECKS: ReadonlyArray<{ id: CheckId; what: string }> = [
  { id: 'rules', what: 'GET /api/jobs/rules: fees inside the contract limits (no-show 0-10%, poster share at most the no-show fee, service 0-3%) and payments off' },
  { id: 'lowest-wins', what: 'every awarded job went to the lowest bid standing at closing (amount, and the person when there is no tie); the bid tab lists exactly the bids that were in, lowest first' },
  { id: 'tie-break', what: 'on a tie at the lowest amount the bid placed first won' },
  { id: 'sealed-bids', what: 'no answer to anyone but the bidder held a bid amount before closing (raw JSON searched); after closing only the poster and the people whose bid was in' },
  { id: 'private-details', what: 'the street address and phone reached only the poster, and the winner after the award (raw JSON searched)' },
  { id: 'endings', what: "every job's final status and outcome, re-derived from what the people did and the contact deadline" },
  { id: 'fee-due', what: 'a no-show fee exactly when the winner never made contact or backed out, a service fee exactly when both agreed, nothing otherwise' },
  { id: 'fee-amount', what: "each fee's cents (and the poster's share) re-computed here: cents x rate, BigInt, rounded half up once; the poster and the payer see it, status recorded" },
  { id: 'fee-split', what: "in the ledger, poster's share + BidSwipe's part = the fee, to the cent, nothing negative" },
  { id: 'ledger-total', what: 'the ledger total equals the sum of the fees shown on the jobs and the sum worked out here' },
  { id: 'alerts', what: 'every job alert (awarded, closed, message, 2-days-left) reached the right account, once, and nobody else; no "match" alert to a job\'s own poster or twice' },
  { id: 'feed', what: 'in every daily read of every feed, a local job shown is open, and never to its own poster' },
  { id: 'settle-twice', what: 'a second settlement at the same moment changed nothing; at most one fee row per job and kind' },
  { id: 'repost', what: 'a repost is a new open job (new id, repostedFrom, new closing time) and the old job reads the same before and after' },
  { id: 'api-answers', what: 'every step of the script got the answer it should (refusals included: own job 403, over the ceiling 400, after closing 409)' },
];

const usd = (c: number) => `$${Math.floor(c / 100).toLocaleString('en-US')}.${String(c % 100).padStart(2, '0')}`;
const iso = (t: number) => new Date(t).toISOString().replace(':00.000Z', 'Z');

export function runChecks(o: Observations): Checked {
  const violations: Violation[] = [];
  const items: Record<string, number> = {};
  const look = (id: CheckId, n = 1) => void (items[id] = (items[id] ?? 0) + n);
  const fail = (check: CheckId, detail: string) => violations.push({ check, detail });
  const posted = new Set(o.jobsPosted);
  const final = (job: string, who: string) => o.finalViews.get(job)?.get(who) ?? null;

  // ---- rules
  look('rules');
  const r = o.rules ?? {};
  if (!(r.noShowFeePct >= 0 && r.noShowFeePct <= 10)) fail('rules', `no-show fee ${r.noShowFeePct}% is outside 0-10%`);
  if (!(r.posterSharePct >= 0 && r.posterSharePct <= r.noShowFeePct)) fail('rules', `poster share ${r.posterSharePct}% is more than the no-show fee`);
  if (!(r.serviceFeePct >= 0 && r.serviceFeePct <= 3)) fail('rules', `service fee ${r.serviceFeePct}% is outside 0-3%`);
  if (r.paymentsOn !== false) fail('rules', 'paymentsOn is not false');

  for (const [key, e] of o.expect) {
    if (!posted.has(key)) {
      fail('api-answers', `${key} was never posted`);
      continue;
    }
    const pv = final(key, e.poster);
    if (!pv) {
      fail('api-answers', `${key}: the poster could not read the job at the end`);
      continue;
    }

    // ---- the award
    if (e.winner) {
      look('lowest-wins');
      const award = o.awardViews.get(key)?.get(e.poster)?.award ?? pv.award;
      const shownWinner = o.awardWinner.get(key) ?? null;
      if (!award) fail('lowest-wins', `${key}: no award shown, expected ${e.winner.who} at ${usd(e.winner.amountCents)}`);
      else {
        if (award.amountCents !== e.winner.amountCents) {
          fail('lowest-wins', `${key}: awarded at ${usd(award.amountCents)} to ${shownWinner}, but the lowest bid standing at closing was ${usd(e.winner.amountCents)} (${e.winner.who})`);
        } else if (!e.tieAtLowest && shownWinner !== e.winner.who) {
          fail('lowest-wins', `${key}: awarded to ${shownWinner}, the lowest bid was ${e.winner.who}'s`);
        }
        const tab: number[] = (pv.tab ?? []).map((x: any) => x.amountCents);
        const want = e.inAtClose.map((b) => b.amountCents);
        if (tab.join(',') !== want.join(',')) fail('lowest-wins', `${key}: the bid tab reads ${tab.map(usd).join(', ') || 'nothing'}, expected ${want.map(usd).join(', ')}`);
      }
      if (e.tieAtLowest) {
        look('tie-break');
        if (shownWinner !== e.winner.who) {
          const tied = e.inAtClose.filter((b) => b.amountCents === e.winner!.amountCents).map((b) => `${b.who} at ${iso(b.placedT)}`).join(', ');
          fail('tie-break', `${key}: tie at ${usd(e.winner.amountCents)} (${tied}); awarded to ${shownWinner}, the first placed was ${e.winner.who}`);
        }
      }
    } else if (e.status !== 'cancelled') {
      look('lowest-wins');
      if (pv.award) fail('lowest-wins', `${key}: nobody's bid was standing at closing, yet an award of ${usd(pv.award.amountCents)} is shown`);
    }

    // ---- the ending
    look('endings');
    if (pv.status !== e.status || (pv.outcome ?? null) !== e.outcome) {
      fail('endings', `${key}: ended ${pv.status}${pv.outcome ? `/${pv.outcome}` : ''}, expected ${e.status}${e.outcome ? `/${e.outcome}` : ''} (${endingLabel(e)})`);
    }

    // ---- fees on the job (what the poster and the payer see)
    look('fee-due');
    const shown: any[] = pv.fees ?? [];
    const kindsShown = shown.map((f) => f.kind).sort().join(',') || 'none';
    const kindsWant = e.fees.map((f) => f.kind).sort().join(',') || 'none';
    if (kindsShown !== kindsWant) fail('fee-due', `${key} (${endingLabel(e)}): fees shown ${kindsShown}, expected ${kindsWant}`);
    for (const f of e.fees) {
      look('fee-amount');
      const s = shown.find((x) => x.kind === f.kind);
      if (!s) continue; // fee-due says so
      if (s.amountCents !== f.amountCents || s.posterShareCents !== f.posterShareCents) {
        fail('fee-amount', `${key}: ${f.kind} fee shown ${usd(s.amountCents)} (poster's share ${usd(s.posterShareCents)}), worked out here ${usd(f.amountCents)} (${usd(f.posterShareCents)}) on ${usd(f.basisCents)}`);
      }
      if (s.status !== 'recorded') fail('fee-amount', `${key}: ${f.kind} fee status ${s.status}, expected recorded (payments are off)`);
      const payerView = final(key, f.payer);
      const mine = (payerView?.fees ?? []).find((x: any) => x.kind === f.kind);
      if (!mine || mine.owedByMe !== true || mine.amountCents !== s.amountCents) fail('fee-amount', `${key}: the payer ${f.payer} does not see the ${f.kind} fee as owed by them`);
    }
  }

  // ---- the ledger
  const expectedFees = [...o.expect.values()].flatMap((e) => e.fees.map((f) => ({ ...f, job: e.key })));
  for (const row of o.ledger) {
    look('fee-split');
    if (row.posterShareCents + row.platformCents !== row.amountCents) fail('fee-split', `${row.job}: ${row.kind} fee ${usd(row.amountCents)} but share ${usd(row.posterShareCents)} + BidSwipe ${usd(row.platformCents)}`);
    if (row.posterShareCents < 0 || row.platformCents < 0 || row.amountCents < 0) fail('fee-split', `${row.job}: a negative part in the ${row.kind} fee`);
    const want = expectedFees.find((f) => f.job === row.job && f.kind === row.kind);
    if (want) {
      look('fee-amount');
      const again = expectedFee(want.kind, row.basisCents, want.payer, { noShow: row.ratePpm, posterShare: row.posterSharePpm, service: row.ratePpm });
      if (row.basisCents !== want.basisCents || row.amountCents !== want.amountCents || row.posterShareCents !== want.posterShareCents || row.payer !== want.payer) {
        fail('fee-amount', `${row.job}: ledger ${row.kind} ${usd(row.amountCents)} on ${usd(row.basisCents)} from ${row.payer}, expected ${usd(want.amountCents)} on ${usd(want.basisCents)} from ${want.payer}`);
      } else if (again.amountCents !== row.amountCents) {
        fail('fee-amount', `${row.job}: the ledger's own rate (${row.ratePpm} ppm) does not give ${usd(row.amountCents)}`);
      }
    }
  }
  look('ledger-total');
  const ledgerTotal = o.ledger.reduce((s, x) => s + x.amountCents, 0);
  const shownTotal = [...o.expect.keys()].reduce((s, k) => s + ((final(k, o.expect.get(k)!.poster)?.fees ?? []) as any[]).reduce((t, f) => t + f.amountCents, 0), 0);
  const wantTotal = expectedFees.reduce((s, f) => s + f.amountCents, 0);
  if (ledgerTotal !== shownTotal || ledgerTotal !== wantTotal) {
    fail('ledger-total', `ledger total ${usd(ledgerTotal)} (${o.ledger.length} rows), fees shown on the jobs ${usd(shownTotal)}, worked out here ${usd(wantTotal)} (${expectedFees.length} fees)`);
  }

  // ---- settle twice
  for (const s of o.settles) {
    look('settle-twice');
    if (!s.same) fail('settle-twice', `the second settlement at ${iso(s.t)} changed jobs, bids, fees or alerts`);
  }
  const perJobKind = new Map<string, number>();
  for (const row of o.ledger) perJobKind.set(`${row.job} ${row.kind}`, (perJobKind.get(`${row.job} ${row.kind}`) ?? 0) + 1);
  for (const [k, n] of perJobKind) if (n > 1) fail('settle-twice', `${k} fee: ${n} rows in the ledger`);

  // ---- sealed bids
  const expectByKey = o.expect;
  for (const h of o.amountHits) {
    look('sealed-bids');
    const info = o.amountOwners.get(h.n)!;
    if (info.owners.has(h.who)) continue;
    const e = expectByKey.get(info.job);
    const opened = e && e.cancelledOpenAt === null && h.t >= e.closesAt;
    if (opened && e!.inAtClose.some((b) => b.amountCents === h.n) && e!.tabPeople.has(h.who)) continue;
    fail('sealed-bids', `${h.who} received ${usd(h.n)} (${[...info.owners].join('/')}'s bid on ${info.job}) at ${iso(h.t)}${e && h.t < e.closesAt ? ', before closing' : ''}, in ${h.path}`);
  }

  // ---- private details
  const carriers = new Map<number, JobExpect[]>();
  for (const j of o.plan.jobs) {
    const n = Number(/^(\d+)/.exec(j.address)![1]);
    carriers.set(n, [...(carriers.get(n) ?? []), o.expect.get(j.key)!]);
  }
  for (const h of o.privateHits) {
    look('private-details');
    const jobs = carriers.get(h.n) ?? [];
    const ok = jobs.some((e) => e.poster === h.who || (e.winner?.who === h.who && h.t >= e.closesAt));
    if (!ok) fail('private-details', `${h.who} received the address/phone of ${jobs.map((e) => e.key).join('/') || `#${h.n}`} at ${iso(h.t)}, in ${h.path}`);
  }

  // ---- alerts
  const want = new Map<string, number>();
  for (const e of o.expect.values()) for (const a of e.alerts) want.set(alertKey(a), (want.get(alertKey(a)) ?? 0) + 1);
  const got = new Map<string, number>();
  const matchSeen = new Map<string, number>();
  for (const [who, list] of o.alerts) {
    for (const a of list) {
      if (typeof a.kind === 'string' && a.kind.startsWith('job_')) {
        const k = alertKey({ who, kind: a.kind as ExpectedAlert['kind'], job: o.jobKeyOf.get(String(a.data?.jobId)) ?? 'unknown-job', role: a.data?.role, status: a.data?.status, outcome: a.data?.outcome ?? null });
        got.set(k, (got.get(k) ?? 0) + 1);
      } else if (a.kind === 'match' && typeof a.bidId === 'string' && a.bidId.startsWith('local:')) {
        const job = o.jobKeyOf.get(a.bidId.slice(6)) ?? 'unknown-job';
        look('alerts');
        if (o.expect.get(job)?.poster === who) fail('alerts', `${who} got a "match" alert for their own job ${job}`);
        matchSeen.set(`${who} ${job}`, (matchSeen.get(`${who} ${job}`) ?? 0) + 1);
      }
    }
  }
  for (const [k, n] of matchSeen) if (n > 1) fail('alerts', `${k}: ${n} "match" alerts for one job`);
  for (const k of new Set([...want.keys(), ...got.keys()])) {
    look('alerts');
    const w = want.get(k) ?? 0;
    const g = got.get(k) ?? 0;
    if (w !== g) {
      const [who, kind, job, role, status, outcome] = k.split('|');
      fail('alerts', `${who} got ${g} "${kind}" alert(s) for ${job} (as ${role}, ${status}${outcome !== '-' ? `/${outcome}` : ''}), expected ${w}`);
    }
  }

  // ---- feeds
  for (const s of o.feedSnaps) {
    for (const job of s.jobs) {
      look('feed');
      const e = o.expect.get(job);
      if (!e) {
        fail('feed', `${s.who}'s feed at ${iso(s.t)} holds a local job the simulation did not post`);
        continue;
      }
      if (e.poster === s.who) fail('feed', `${s.who}'s feed at ${iso(s.t)} holds their own job ${job}`);
      if (!openAt(e, s.t)) fail('feed', `${s.who}'s feed at ${iso(s.t)} holds ${job}, which closed at ${iso(e.openUntil)}`);
    }
  }

  // ---- reposts
  const strip = (v: any) => {
    if (!v) return v;
    const { poster: _p, rules: _r, ...rest } = v;
    return rest;
  };
  for (const rp of o.reposts) {
    look('repost');
    const c = rp.created;
    if (!c) {
      fail('repost', `${rp.job}: the repost of ${rp.from} was refused`);
      continue;
    }
    if (c.id === rp.fromId) fail('repost', `${rp.job}: the repost kept the old id`);
    if (c.repostedFrom !== rp.fromId) fail('repost', `${rp.job}: repostedFrom is ${o.jobKeyOf.get(c.repostedFrom) ?? c.repostedFrom}, expected ${rp.from}`);
    if (c.status !== 'open') fail('repost', `${rp.job}: the repost is ${c.status}, expected open`);
    if (c.closesAt !== new Date(rp.t + rp.days * 86_400_000).toISOString()) fail('repost', `${rp.job}: closes ${c.closesAt}, expected ${rp.days} days after ${iso(rp.t)}`);
    if (JSON.stringify(strip(rp.before)) !== JSON.stringify(strip(rp.after))) fail('repost', `${rp.from} changed when it was reposted as ${rp.job}`);
  }

  // ---- the answers the script got
  for (const p of o.apiProblems) fail('api-answers', `${p.where} at ${iso(p.t)}: ${p.detail}`);
  for (const rf of o.refusals) {
    look('api-answers');
    if (rf.got !== rf.expect) fail('api-answers', `${rf.who} bidding on ${rf.job} (${rf.why}) answered ${rf.got}, expected ${rf.expect}`);
  }
  look('api-answers', o.plan.steps.length);

  const counts = new Map<string, number>();
  for (const v of violations) counts.set(v.check, (counts.get(v.check) ?? 0) + 1);
  return {
    results: CHECKS.map((c) => ({ id: c.id, what: c.what, items: items[c.id] ?? 0, violations: counts.get(c.id) ?? 0 })),
    violations,
  };
}
