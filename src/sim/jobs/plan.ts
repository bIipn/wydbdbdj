/**
 * The seeded script of the marketplace simulation: which simulated person posts which job when, who bids
 * what and when (changes, withdrawals, ties included), and how each awarded job ends. Everything is decided
 * here, before the server starts, from the seed alone, so the same seed always plays the same story.
 *
 * Times are whole minutes on the simulation's own clock (the server's `now` is set to each step's time).
 * Two bids on one job never share a minute: the product breaks a tie on "placed first", then on the row id,
 * and the row id is not something the simulation should have to guess.
 *
 * Endings after an award (contract rule 6), as the people in the story act them out:
 *   complete       both write, both tap "We've agreed", later the poster taps "Job done"
 *   agreed         the same, but nobody marks it done during the run
 *   no_contact     the winner never writes (sometimes the poster does: that is not the winner making contact)
 *   back_out       the winner gives the job back ("I can't take it"), sometimes after a message
 *   poster_silent  the winner writes EARLY (with time left for an answer), the poster never answers
 *   no_agreement   they talk (message, or the poster's "They contacted me" tap) but never both agree
 *   poster_cancel  the poster cancels after the award
 *   late_hello     the winner ghosts the whole window and writes once, minutes before the deadline; no answer
 *   poster_tap     they agree by phone: only the poster taps "We've agreed", nobody writes
 *   winner_tap     they agree by phone: only the winner taps "We've agreed", nobody writes
 */
import { Rng } from '../../cost/synthetic.js';
import type { SimPerson } from './people.js';
import { REGIONS } from './people.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Monday 2026-11-16, 08:00 Pacific: the simulation's first moment. */
export const SIM_START = Date.parse('2026-11-16T16:00:00Z');

export type Ending =
  | 'complete' | 'agreed' | 'no_contact' | 'back_out' | 'poster_silent' | 'no_agreement' | 'poster_cancel'
  | 'late_hello' | 'poster_tap' | 'winner_tap';
export const ENDINGS: readonly Ending[] = [
  'complete', 'agreed', 'no_contact', 'back_out', 'poster_silent', 'no_agreement', 'poster_cancel', 'late_hello', 'poster_tap', 'winner_tap',
];

export type Side = 'winner' | 'poster';

export type Act =
  | { kind: 'post'; job: string }
  | { kind: 'repost'; job: string; from: string }
  | { kind: 'bid'; job: string; who: string; amountCents: number; note: string | null }
  | { kind: 'withdraw'; job: string; who: string }
  | { kind: 'peek'; job: string; who: string; what: 'job' | 'mine' }
  | { kind: 'refuse'; job: string; who: string; why: 'own-job' | 'over-ceiling' | 'after-closing'; amountCents: number; expect: number }
  | { kind: 'cancel-open'; job: string }
  | { kind: 'award-view'; job: string }
  | { kind: 'message'; job: string; side: Side; body: string }
  | { kind: 'contacted'; job: string }
  | { kind: 'confirm'; job: string; side: Side }
  | { kind: 'back-out'; job: string }
  | { kind: 'cancel-awarded'; job: string }
  | { kind: 'complete'; job: string }
  | { kind: 'tick' };

export interface Step {
  t: number;
  /** Order of steps at the same minute (and the tie-break the model uses for "placed first"). */
  seq: number;
  act: Act;
}

export interface PlannedJob {
  /** J001 for an original, J001r for its repost. */
  key: string;
  poster: string;
  title: string;
  description: string;
  trades: string[];
  zip: string;
  region: string;
  /** Private details (fake: "SIM Test Road", a 555-0100 number): only the poster and the winner may see them. */
  address: string;
  phone: string;
  budgetMaxCents: number | null;
  closesInDays: number;
  postAt: number;
  closesAt: number;
  repostOf: string | null;
  /** Everyone the script has bid on this job (place, change or withdraw). */
  bidders: string[];
  /** The script's plan for after the award; null when nobody should be awarded (no bids, cancelled while open). */
  ending: Ending | null;
  /** The poster cancels while bids are open. */
  openCancelAt: number | null;
  /** A second bidder matches the lowest amount, later: the earlier one must win. */
  tie: boolean;
  /** The going rate the bids are drawn around (cents; a simulated figure). */
  baseCents: number;
}

export interface Plan {
  seed: number;
  contactDays: number;
  jobs: PlannedJob[];
  steps: Step[];
  /** Every tick time (daily, plus the last one). */
  ticks: number[];
  endAt: number;
}

export interface PlanSize {
  /** Original jobs (reposts come on top). */
  jobs: number;
  /** Days over which the originals are posted. */
  postingDays: number;
}

export const FULL_PLAN: PlanSize = { jobs: 100, postingDays: 6 };
export const SMALL_PLAN: PlanSize = { jobs: 16, postingDays: 2 };

const CLOSES_IN = [1, 3, 7, 14] as const;

const TASKS: Readonly<Record<string, readonly string[]>> = {
  electrical: ['add two outlets and a ceiling fan', 'replace a tripping breaker and two switches', 'wire a 240 V outlet for a dryer'],
  plumbing: ['replace a leaking kitchen faucet', 'swap a 40-gallon water heater', 'unclog and re-pipe a bathroom sink drain'],
  hvac: ['service a furnace before winter', 'replace a thermostat and clean the ducts', 'install a mini-split in a garage office'],
  'general-building': ['frame and hang a door in a garage wall', 'repair a sagging deck stair', 'patch drywall after a plumbing repair'],
  roofing: ['patch a leak around a vent pipe', 'replace twenty wind-damaged shingles', 'clean and re-seal a flat porch roof'],
  painting: ['paint a two-car garage interior', 'repaint a front door and trim', 'stain a cedar fence, both sides'],
  flooring: ['lay vinyl plank in a laundry room', 'refinish an oak hallway floor', 'replace cracked tile at a front entry'],
  landscaping: ['replace six dead shrubs and the drip line', 'spread mulch and edge the front beds', 'remove a dead tree stump and regrade'],
};

const pad3 = (n: number) => String(n).padStart(3, '0');
const dollars = (rng: Rng, lo: number, hi: number) => Math.round(Math.exp(Math.log(lo) + rng.next() * (Math.log(hi) - Math.log(lo))));

/** Weighted pick. */
function weighted<T>(rng: Rng, items: ReadonlyArray<readonly [T, number]>): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let u = rng.next() * total;
  for (const [v, w] of items) {
    u -= w;
    if (u < 0) return v;
  }
  return items[items.length - 1]![0];
}

function shuffle<T>(rng: Rng, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}

/** A whole minute in [lo, hi). */
const minuteIn = (rng: Rng, lo: number, hi: number): number => {
  const a = Math.ceil(lo / MINUTE);
  const b = Math.floor((hi - 1) / MINUTE);
  return (b < a ? a : rng.int(a, b)) * MINUTE;
};

// ------------------------------------------------------------------ the model --

/** One bid action as the model replays it. */
export interface BidAction {
  t: number;
  seq: number;
  who: string;
  kind: 'bid' | 'withdraw';
  amountCents?: number;
}

export interface ModelBid {
  who: string;
  amountCents: number;
  /** When the current amount was placed (a new amount, or a return after a withdrawal, counts as placed now). */
  placedT: number;
  placedSeq: number;
  active: boolean;
}

/**
 * Replay a job's bid actions up to (not including) `until`: each person's current bid. Contract rule 3: a bid
 * may be changed or withdrawn until closing; rule 4 breaks ties on "placed first" (the product's documented
 * reading: the moment the current amount was placed).
 */
export function replayBids(actions: readonly BidAction[], until: number = Number.POSITIVE_INFINITY): Map<string, ModelBid> {
  const out = new Map<string, ModelBid>();
  for (const a of [...actions].sort((x, y) => x.t - y.t || x.seq - y.seq)) {
    if (a.t >= until) break;
    const cur = out.get(a.who);
    if (a.kind === 'withdraw') {
      if (cur?.active) cur.active = false;
      continue;
    }
    const amount = a.amountCents!;
    if (!cur || !cur.active || cur.amountCents !== amount) out.set(a.who, { who: a.who, amountCents: amount, placedT: a.t, placedSeq: a.seq, active: true });
  }
  return out;
}

/** Lowest amount first, then placed first (the bid tab's order and the award rule). */
export const byAward = (a: ModelBid, b: ModelBid): number => a.amountCents - b.amountCents || a.placedT - b.placedT || a.placedSeq - b.placedSeq;

// --------------------------------------------------------------- the generator --

interface Builder {
  steps: Step[];
  seq: number;
  used: Set<number>;
}

const push = (b: Builder, t: number, act: Act) => b.steps.push({ t, seq: b.seq++, act });

/** An amount no other bid in the run uses (so a leak can be traced to one bid), never whole dollars. */
function uniqueAmount(b: Builder, cents: number, max: number | null): number {
  let c = Math.max(2_001, Math.round(cents));
  if (max !== null) c = Math.min(c, max - 1);
  while (c % 100 === 0 || b.used.has(c)) c = max !== null && c >= max - 1 ? c - 7 : c + 1;
  b.used.add(c);
  return c;
}

/**
 * Bid actions on one job. The minutes of one job's bids are all different (see the file comment).
 * Returns the actions (for the model) and pushes the steps.
 */
function planBids(rng: Rng, b: Builder, job: PlannedJob, bidders: string[], base: number, stopAt: number, steady = false): BidAction[] {
  const actions: BidAction[] = [];
  const minutes = new Set<number>();
  const freeMinute = (lo: number, hi: number): number | null => {
    for (let tries = 0; tries < 40; tries++) {
      const t = minuteIn(rng, lo, hi);
      if (t >= lo && t < hi && !minutes.has(t)) {
        minutes.add(t);
        return t;
      }
    }
    return null;
  };
  const latest = stopAt - 10 * MINUTE;
  const amountNear = (lo: number, hi: number) => base * (lo + rng.next() * (hi - lo));
  // On a tie job the last bidder is kept back: they match the lowest amount at the end.
  const spare = job.tie ? bidders[bidders.length - 1] ?? null : null;
  for (const who of job.tie ? bidders.slice(0, -1) : bidders) {
    const t0 = freeMinute(job.postAt + 5 * MINUTE, latest - 2 * HOUR);
    if (t0 === null) continue;
    const a0 = uniqueAmount(b, amountNear(0.72, 1.18), job.budgetMaxCents);
    const note = rng.chance(0.3) ? 'SIM note (simulated): can start next week.' : null;
    push(b, t0, { kind: 'bid', job: job.key, who, amountCents: a0, note });
    actions.push({ t: t0, seq: b.seq - 1, who, kind: 'bid', amountCents: a0 });
    if (rng.chance(0.22)) {
      // Changes the amount before closing (usually down, sometimes up).
      const t1 = freeMinute(t0 + MINUTE, latest);
      if (t1 !== null) {
        const a1 = uniqueAmount(b, a0 * (0.85 + rng.next() * 0.2), job.budgetMaxCents);
        push(b, t1, { kind: 'bid', job: job.key, who, amountCents: a1, note: null });
        actions.push({ t: t1, seq: b.seq - 1, who, kind: 'bid', amountCents: a1 });
      }
    } else if (!steady && rng.chance(0.13)) {
      // Withdraws; sometimes comes back later (with the same amount: it counts as placed again).
      const t1 = freeMinute(t0 + MINUTE, latest);
      if (t1 !== null) {
        push(b, t1, { kind: 'withdraw', job: job.key, who });
        actions.push({ t: t1, seq: b.seq - 1, who, kind: 'withdraw' });
        if (rng.chance(0.4)) {
          const t2 = freeMinute(t1 + MINUTE, latest);
          if (t2 !== null) {
            push(b, t2, { kind: 'bid', job: job.key, who, amountCents: a0, note: null });
            actions.push({ t: t2, seq: b.seq - 1, who, kind: 'bid', amountCents: a0 });
          }
        }
      }
    }
  }
  if (job.tie) {
    // Another bidder matches the lowest amount standing at the end, later: the first one placed must win.
    const standing = [...replayBids(actions).values()].filter((x) => x.active).sort(byAward);
    const low = standing[0];
    const t = low ? freeMinute(Math.max(low.placedT, ...actions.map((a) => a.t)) + MINUTE, latest) : null;
    if (low && spare && t !== null) {
      push(b, t, { kind: 'bid', job: job.key, who: spare, amountCents: low.amountCents, note: 'SIM note (simulated): same price.' });
      actions.push({ t, seq: b.seq - 1, who: spare, kind: 'bid', amountCents: low.amountCents });
    } else job.tie = false;
  }
  return actions;
}

/** The actions after the award for one ending. Hours are counted from the award (= the closing time). */
function planEnding(rng: Rng, b: Builder, job: PlannedJob, ending: Ending, contactDays: number): number {
  const A = job.closesAt;
  const window = contactDays * 24;
  const at = (h: number) => A + Math.round(Math.min(h, window - 1) * 60) * MINUTE;
  const say = (side: Side, h: number, body: string) => push(b, at(h), { kind: 'message', job: job.key, side, body });
  const W = (n: number) => `SIM message (simulated) from the winner, ${n}: when could I come and look at it?`;
  const P = (n: number) => `SIM message (simulated) from the poster, ${n}: any weekday morning works.`;
  let h = 1 + rng.int(1, 30);
  switch (ending) {
    case 'complete':
    case 'agreed': {
      say('winner', h, W(1));
      h += 1 + rng.int(0, 20);
      say('poster', h, P(1));
      const sides: Side[] = rng.chance(0.5) ? ['winner', 'poster'] : ['poster', 'winner'];
      for (const side of sides) {
        h += 1 + rng.int(1, 30);
        push(b, at(h), { kind: 'confirm', job: job.key, side });
      }
      if (ending === 'complete') {
        h += 24 + rng.int(0, 96);
        push(b, A + Math.round(h * 60) * MINUTE, { kind: 'complete', job: job.key });
        return A + Math.round(h * 60) * MINUTE;
      }
      return at(h);
    }
    case 'no_contact':
      if (rng.chance(0.4)) say('poster', h, P(1));
      return A + contactDays * DAY;
    case 'back_out':
      if (rng.chance(0.5)) say('winner', h, W(1));
      h += 2 + rng.int(0, 48);
      push(b, at(h), { kind: 'back-out', job: job.key });
      return at(h);
    case 'poster_silent': {
      // Early enough that the poster had a fair chance to answer: well before the last 48 hours (or the last
      // half of a short window). The plan only needs to stay clear of that line; the model decides the ending.
      const lastFair = window - Math.min(48, window / 2);
      const first = 1 + rng.int(0, Math.max(0, Math.floor(lastFair) - 3));
      say('winner', first, W(1));
      if (rng.chance(0.5)) say('winner', first + 1 + rng.int(0, 40), W(2));
      return A + contactDays * DAY;
    }
    case 'late_hello':
      // Silent for the whole window, then one line a few minutes to two hours before the deadline.
      push(b, A + contactDays * DAY - (1 + rng.int(0, 120)) * MINUTE, { kind: 'message', job: job.key, side: 'winner', body: 'SIM message (simulated) from the winner: hi' });
      return A + contactDays * DAY;
    case 'poster_tap':
    case 'winner_tap':
      // Worked out on the phone; one side records it in the app, the other never does.
      push(b, at(h), { kind: 'confirm', job: job.key, side: ending === 'poster_tap' ? 'poster' : 'winner' });
      return A + contactDays * DAY;
    case 'no_agreement': {
      const variant = rng.int(0, 2);
      if (variant === 2) push(b, at(h), { kind: 'contacted', job: job.key }); // they spoke on the phone
      else {
        say('winner', h, W(1));
        h += 1 + rng.int(0, 30);
        if (variant === 0) say('poster', h, P(1));
        else push(b, at(h), { kind: 'contacted', job: job.key });
      }
      if (rng.chance(0.4)) push(b, at(h + 2 + rng.int(0, 30)), { kind: 'confirm', job: job.key, side: rng.chance(0.5) ? 'winner' : 'poster' });
      return A + contactDays * DAY;
    }
    case 'poster_cancel':
      if (rng.chance(0.5)) say('winner', h, W(1));
      h += 2 + rng.int(0, 40);
      push(b, at(h), { kind: 'cancel-awarded', job: job.key });
      return at(h);
  }
}

export interface PlanInput {
  seed: number;
  people: readonly SimPerson[];
  size: PlanSize;
  contactDays: number;
}

export function makePlan(input: PlanInput): Plan {
  const { seed, people, size, contactDays } = input;
  const rng = new Rng((seed ^ 0x6a09e667) >>> 0);
  const b: Builder = { steps: [], seq: 0, used: new Set() };
  const posters = people.filter((p) => p.posts);
  const workers = people.filter((p) => p.works);
  const jobs: PlannedJob[] = [];
  let addressNo = 100;

  /** Peeks while bids are open: the poster, a stranger, a bidder (job and "my jobs"). */
  const planPeeks = (job: PlannedJob, actions: BidAction[], stopAt: number) => {
    const lo = job.postAt + MINUTE;
    const hi = stopAt - 5 * MINUTE;
    if (hi <= lo) return;
    push(b, minuteIn(rng, lo, hi), { kind: 'peek', job: job.key, who: job.poster, what: 'job' });
    push(b, minuteIn(rng, lo, hi), { kind: 'peek', job: job.key, who: job.poster, what: 'mine' });
    const strangers = people.filter((p) => p.key !== job.poster && !job.bidders.includes(p.key));
    if (strangers.length) push(b, minuteIn(rng, lo, hi), { kind: 'peek', job: job.key, who: rng.pick(strangers).key, what: 'job' });
    const bidder = actions.length ? rng.pick(actions) : null;
    if (bidder) {
      push(b, minuteIn(rng, bidder.t + MINUTE, hi + MINUTE), { kind: 'peek', job: job.key, who: bidder.who, what: 'job' });
      push(b, minuteIn(rng, bidder.t + MINUTE, hi + MINUTE), { kind: 'peek', job: job.key, who: bidder.who, what: 'mine' });
    }
  };

  /** The script for one job from its posting on. Returns when it ends (for a repost), null when it does not. */
  const planJob = (job: PlannedJob, base: number, nBids: number, force: { ending?: Ending; noBids?: boolean; openCancel?: boolean }): number | null => {
    const poster = people.find((p) => p.key === job.poster)!;
    const eligible = shuffle(rng, workers.filter((w) => w.region === poster.region && w.key !== poster.key))
      .sort((x, y) => Number(!x.trades.some((t) => job.trades.includes(t))) - Number(!y.trades.some((t) => job.trades.includes(t))));
    // A tie keeps one eligible worker back to match the lowest bid at the end: it needs two of them.
    job.tie = job.tie && !force.noBids && eligible.length >= 2;
    const want = force.noBids ? 0 : Math.min(eligible.length - (job.tie ? 1 : 0), nBids);
    const bidders = eligible.slice(0, want).map((w) => w.key);
    // A tie needs a spare bidder who has not bid yet: they go last in the list.
    if (job.tie && eligible.length > want && want > 0) bidders.push(eligible[want]!.key);
    else job.tie = false;
    job.openCancelAt = force.openCancel ? job.closesAt - Math.round(job.closesInDays * DAY * 0.3 / MINUTE) * MINUTE : null;
    const stopAt = job.openCancelAt ?? job.closesAt;
    // A job whose ending is forced keeps its bids (no withdrawals), so there is a winner to act it out.
    const actions = planBids(rng, b, job, bidders, base, stopAt, force.ending !== undefined);
    job.bidders = [...new Set(actions.map((a) => a.who))];
    planPeeks(job, actions, stopAt);

    // Refusals the rules call for: the poster bidding on their own job (403), a bid over the ceiling (400),
    // a bid after closing (409). Their amounts are registered like any other (only the bidder sees them).
    if (rng.chance(0.12)) push(b, minuteIn(rng, job.postAt + MINUTE, stopAt - 5 * MINUTE), { kind: 'refuse', job: job.key, who: job.poster, why: 'own-job', amountCents: uniqueAmount(b, base, null), expect: 403 });
    if (job.budgetMaxCents !== null && eligible[0] && rng.chance(0.15)) {
      push(b, minuteIn(rng, job.postAt + MINUTE, stopAt - 5 * MINUTE), { kind: 'refuse', job: job.key, who: eligible[0].key, why: 'over-ceiling', amountCents: uniqueAmount(b, job.budgetMaxCents + 1_337, null), expect: 400 });
    }

    if (job.openCancelAt !== null) {
      push(b, job.openCancelAt, { kind: 'cancel-open', job: job.key });
      job.ending = null;
      return job.openCancelAt;
    }
    push(b, job.closesAt + 2 * MINUTE, { kind: 'award-view', job: job.key });
    if (eligible[0] && rng.chance(0.1)) {
      push(b, job.closesAt + 7 * MINUTE, { kind: 'refuse', job: job.key, who: eligible[0].key, why: 'after-closing', amountCents: uniqueAmount(b, base, null), expect: 409 });
    }
    const standing = [...replayBids(actions).values()].filter((x) => x.active);
    if (standing.length === 0) {
      job.ending = null;
      return job.closesAt;
    }
    const ending = force.ending ?? weighted<Ending>(rng, [
      ['complete', 30], ['agreed', 6], ['no_contact', 14], ['back_out', 12], ['poster_silent', 13], ['no_agreement', 15], ['poster_cancel', 10],
      ['late_hello', 5], ['poster_tap', 4], ['winner_tap', 4],
    ]);
    job.ending = ending;
    const end = planEnding(rng, b, job, ending, contactDays);
    return ending === 'complete' || ending === 'agreed' ? null : end;
  };

  const newJob = (key: string, poster: SimPerson, postAt: number, closesInDays: number, base: number, repostOf: PlannedJob | null): PlannedJob => {
    if (repostOf) {
      return {
        ...repostOf, key, postAt, closesInDays, closesAt: postAt + closesInDays * DAY, repostOf: repostOf.key,
        bidders: [], ending: null, openCancelAt: null, tie: rng.chance(0.2), baseCents: base,
      };
    }
    const regionTrades = [...new Set(workers.filter((w) => w.region === poster.region).flatMap((w) => w.trades))];
    const pool = regionTrades.length ? regionTrades : ['general-building'];
    const trades = [rng.pick(pool)];
    if (rng.chance(0.25)) {
      const second = rng.pick(pool);
      if (!trades.includes(second)) trades.push(second);
    }
    const task = rng.pick(TASKS[trades[0]!] ?? TASKS['general-building']!);
    const zips = REGIONS[poster.region]!;
    const zip = rng.chance(0.7) ? poster.zip : rng.pick(zips);
    const ceiling = rng.chance(0.6) ? Math.round((base * (1.15 + rng.next() * 0.35)) / 1_000) * 1_000 : null;
    addressNo++;
    return {
      key, poster: poster.key, title: `${key.replace('J', 'SIM job ')}: ${task}`,
      description: `${task[0]!.toUpperCase()}${task.slice(1)}. SIM job (simulated): posted by a simulated person in BidSwipe's marketplace simulation; nobody will do this work.`,
      trades, zip, region: poster.region,
      address: `${addressNo} SIM Test Road (simulated)`, phone: `555-0100-${String(addressNo).padStart(4, '0')}`,
      budgetMaxCents: ceiling, closesInDays, postAt, closesAt: postAt + closesInDays * DAY, repostOf: null,
      bidders: [], ending: null, openCancelAt: null, tie: false, baseCents: base,
    };
  };

  // Originals, in posting order. The first ones are forced so that every ending, a tie, a job nobody bids
  // on and a cancellation while open happen in every run, however small.
  const postTimes = [...new Set(Array.from({ length: size.jobs * 3 }, () => minuteIn(rng, SIM_START + HOUR, SIM_START + size.postingDays * DAY)))]
    .slice(0, size.jobs).sort((x, y) => x - y);
  if (postTimes.length < size.jobs) throw new Error('simulate:jobs: could not find distinct posting minutes');
  const forced: Array<{ ending?: Ending; noBids?: boolean; openCancel?: boolean; tie?: boolean }> = [
    { ending: 'complete', tie: true }, { ending: 'no_contact' }, { ending: 'back_out' }, { ending: 'poster_silent', tie: true },
    { ending: 'no_agreement' }, { ending: 'poster_cancel' }, { ending: 'agreed' }, { noBids: true }, { openCancel: true },
    { ending: 'late_hello' }, { ending: 'poster_tap' }, { ending: 'winner_tap' },
  ];
  const repostQueue: Array<{ from: PlannedJob; at: number }> = [];
  for (let n = 1; n <= size.jobs; n++) {
    const key = `J${pad3(n)}`;
    // Posters take turns, so everyone posts about as often.
    const poster = posters[(n - 1) % posters.length]!;
    const force = forced[n - 1] ?? {};
    // A forced job closes after the forced posting window, with enough people around to bid.
    const closesInDays = force.ending || force.noBids || force.openCancel ? rng.pick([1, 3, 7] as const) : weighted(rng, CLOSES_IN.map((d) => [d, d === 14 ? 1 : 2] as const));
    const base = dollars(rng, 150, 24_000) * 100;
    const job = newJob(key, poster, postTimes[n - 1]!, closesInDays, base, null);
    job.tie = force.tie ?? (!force.noBids && rng.chance(0.15));
    jobs.push(job);
    push(b, job.postAt, { kind: 'post', job: key });
    const nBids = force.ending ? 2 + rng.int(1, 3) : weighted(rng, [[0, 7], [1, 15], [2, 25], [3, 25], [4, 15], [5, 8], [6, 5]] as const);
    // Now and then a poster changes their mind while bids are open.
    const end = planJob(job, base, nBids, force.ending || force.noBids || n <= forced.length ? force : { openCancel: rng.chance(0.03) });
    // Unfilled or cancelled jobs may be posted again (contract rule 7): the first two always are.
    if (end !== null && (repostQueue.length < 2 || rng.chance(0.4))) repostQueue.push({ from: job, at: end });
  }
  for (const { from, at } of repostQueue) {
    const key = `${from.key}r`;
    const postAt = minuteIn(rng, at + HOUR, at + 30 * HOUR);
    const base = from.baseCents;
    const job = newJob(key, people.find((p) => p.key === from.poster)!, postAt, rng.pick([1, 3, 7] as const), base, from);
    jobs.push(job);
    push(b, postAt, { kind: 'repost', job: key, from: from.key });
    planJob(job, base, 1 + rng.int(1, 4), {});
  }

  // Daily ticks (the host's cron), from the first day until every deadline and every "Job done" has passed.
  const lastStep = Math.max(...b.steps.map((s) => s.t), ...jobs.map((j) => j.closesAt + contactDays * DAY));
  const endAt = Math.ceil((lastStep + 6 * HOUR) / HOUR) * HOUR;
  const ticks: number[] = [];
  for (let t = SIM_START + 20 * HOUR; t < endAt; t += DAY) ticks.push(t);
  ticks.push(endAt);
  for (const t of ticks) push(b, t, { kind: 'tick' });

  const steps = b.steps.sort((x, y) => x.t - y.t || x.seq - y.seq);
  return { seed, contactDays, jobs, steps, ticks, endAt };
}
