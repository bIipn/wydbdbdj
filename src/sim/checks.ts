/**
 * The rules every simulated company must see hold, checked on what the HTTP API actually answered.
 * Pure: observations in, violations out. The checks use their own small tables (reserved set-aside codes,
 * a word-list trade classifier, the spend-limit rule) rather than the scorer's, so a scorer bug cannot
 * hide itself; where a rule is the scorer's own flag (overLimit), the check reads the flag AND recomputes it.
 */
import type { Alert, FeedItem } from '../types.js';
import { ELECTRICAL_SIDE, PIPE_SIDE, type Persona } from './personas.js';

export type CheckId =
  | 'radius' | 'spend-limit' | 'certification' | 'trade' | 'alert-reason' | 'alert-missing' | 'repeat-scan'
  | 'free-no-premium' | 'estimate-not-silent' | 'stream-delivery' | 'filters' | 'next-in-deck' | 'next-rank' | 'browse-complete'
  | 'determinism';

/** Every per-company check, in report order. */
export const PERSONA_CHECKS: readonly CheckId[] = [
  'radius', 'spend-limit', 'certification', 'trade', 'alert-reason', 'alert-missing', 'repeat-scan',
  'free-no-premium', 'estimate-not-silent', 'stream-delivery', 'filters', 'next-in-deck', 'next-rank', 'browse-complete',
];

export interface Violation {
  check: CheckId;
  persona: string;
  detail: string;
}

export interface FilterObs {
  price: { min: number; max: number; items: FeedItem[] };
  distance: { maxMi: number; items: FeedItem[] };
  due: { days: number; items: FeedItem[]; now: string };
}

export interface EstimateObs {
  status: number;
  body: Record<string, unknown> | null;
}

/** Everything one company saw. Feed snapshots are taken after onboarding and again after the scans. */
export interface PersonaObs {
  key: string;
  plan: 'free' | 'pro';
  features: Record<string, boolean> | null;
  decks: FeedItem[][];
  browse: FeedItem[];
  filters: FilterObs | null;
  next: { item: FeedItem | null; why: string[] } | null;
  alerts: Alert[];
  /** Alert ids before and after the repeat scan, and 'alert' events the repeat scan caused for this profile. */
  repeat: { before: number[]; after: number[]; events: number } | null;
  /** Alerts stored while the stream was open, and the ids the stream delivered. */
  stream: { stored: number[]; delivered: number[] } | null;
  market: { awards: EstimateObs; area: EstimateObs; watch: EstimateObs } | null;
  estimate: { full: EstimateObs; quick: EstimateObs; list: EstimateObs } | null;
  /** The server's clock when the deck and the next pick were read (ISO). Needed for the next-rank check. */
  asOf?: string;
  /**
   * Every open captured bid the scorer calls maybe, good or great for this company, worked out by the run itself
   * (scoreBid on every bid, no candidate filter). Browse must hold each one: the scan stores scores only for
   * candidates (src/score/candidates.ts), and this is what proves the filter never hides a bid worth a look.
   */
  expectedInBrowse?: Array<{ id: string; title: string; score: number }>;
}

// ------------------------------------------------------------------ tables --

/** Set-aside codes that reserve a job for a certification program (SAM.gov typeOfSetAside). */
const RESERVED_CODES = new Set(['8A', '8AN', 'HZC', 'HZS', 'SDVOSBC', 'SDVOSBS', 'WOSB', 'WOSBSS', 'EDWOSB', 'EDWOSBSS', 'VSA', 'VSS', 'IEE', 'ISBEE', 'BICiv']);
const PAIRS: string[][] = [['8A', '8AN'], ['HZC', 'HZS'], ['SDVOSBC', 'SDVOSBS'], ['WOSB', 'WOSBSS'], ['EDWOSB', 'EDWOSBSS'], ['VSA', 'VSS']];

export function certifiedFor(persona: Persona, code: string): boolean {
  const mine = new Set(persona.answers.setAsides ?? []);
  for (const pair of PAIRS) if (pair.some((c) => mine.has(c))) for (const c of pair) mine.add(c);
  return mine.has(code);
}

export const isReserved = (code: string | null): code is string => code !== null && RESERVED_CODES.has(code);

const ELEC = /\b(electric\w*|lighting|led|switchgear|generator|circuit breakers?|feeders?|panelboards?|wiring|streetlights?|power distribution|transformers?)\b/i;
const PIPE = /\b(plumb\w*|piping|pipes?|water heaters?|boilers?|hvac|heating|air[- ]condition\w*|heat exchangers?|chillers?|backflow|sewer|mechanical|valves?|restrooms?)\b/i;

const text = (b: Pick<FeedItem, 'title' | 'description' | 'category'>) => `${b.title} ${b.description ?? ''} ${b.category ?? ''}`;

/** An electrical-only job: electrical NAICS or electrical words in the title, and no pipe-trade word anywhere. */
export const electricalOnly = (b: FeedItem): boolean => (b.naics === '238210' || ELEC.test(b.title)) && !PIPE.test(text(b));
/** A plumbing/HVAC-only job: NAICS 238220 or pipe-trade words in the title, and no electrical word anywhere. */
export const pipeOnly = (b: FeedItem): boolean => (b.naics === '238220' || PIPE.test(b.title)) && !ELEC.test(text(b));

/** The spend-limit rule, recomputed: the low end of the estimate over the job limit, or a bond and over capacity. */
export function overLimitByRule(b: FeedItem, persona: Persona): boolean {
  const est = b.estValue;
  const lim = persona.answers.limits ?? {};
  if (!est || est.min == null) return false;
  if (typeof lim.maxJobSize === 'number' && lim.maxJobSize > 0 && est.min > lim.maxJobSize) return true;
  const bonded = b.flags.some((f) => /\bbond/i.test(f));
  return bonded && typeof lim.bondingCapacity === 'number' && lim.bondingCapacity > 0 && est.min > lim.bondingCapacity;
}

const FIT = new Set(['great', 'good']);
const PREMIUM_KEYS = new Set(['median', 'p25', 'p75', 'min', 'max', 'recent', 'total', 'price', 'bidRange', 'totals', 'cash', 'breakdown', 'series']);

/** Premium figures anywhere in a free answer: a premium key holding a number, or a non-empty list of figures. */
function premiumNumbers(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => premiumNumbers(v, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  const found: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const at = path ? `${path}.${k}` : k;
    if (PREMIUM_KEYS.has(k) && (typeof v === 'number' || (Array.isArray(v) && v.length > 0) || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0))) found.push(at);
    else found.push(...premiumNumbers(v, at));
  }
  return found;
}

const short = (b: { id: string; title: string }) => `${b.id} “${b.title.slice(0, 60)}”`;

/**
 * The "next bid" ranking, recomputed with the check's own copy of the rule (src/feed/next.ts): candidates
 * are deck bids not swiped, not over the limit, scoring 35+, not past due; rank = score + up to 10 points
 * when 2–14 days are left (10 at two days, 0 at fourteen).
 */
const NEXT_FLOOR = 35;
function nextRank(b: FeedItem, nowMs: number): number | null {
  const due = b.dueAt ? Date.parse(b.dueAt) : NaN;
  const days = Number.isFinite(due) ? (due - nowMs) / 86_400_000 : null;
  if (b.swipe || b.overLimit || b.score < NEXT_FLOOR || (days !== null && days <= 0)) return null;
  const boost = days === null || days < 2 || days >= 14 ? 0 : (10 * (14 - days)) / 12;
  return b.score + boost;
}

const hasEstimate = (b: FeedItem) => !!b.estValue && b.estValue.min != null;

/**
 * How many items each check actually evaluated for this company. A check that evaluated nothing proved
 * nothing: the report says "not exercised" for it instead of counting it as passed. 'filters (price)' is
 * kept apart from the distance and due filters because no captured bid states an estimated value.
 */
export function checkCoverage(p: Persona, o: PersonaObs, byId: ReadonlyMap<string, FeedItem>): Record<CheckId | 'filters (price)', number> {
  const alertItems = o.alerts.flatMap((a) => (a.bidId && byId.get(a.bidId) ? [byId.get(a.bidId)!] : []));
  const shown = [...o.decks.flat(), ...(o.next?.item ? [o.next.item] : []), ...alertItems];
  const fits = o.browse.filter((x) => FIT.has(x.verdict));
  return {
    radius: shown.filter((b) => b.distanceMi !== null).length,
    'spend-limit': shown.filter((b) => b.overLimit || hasEstimate(b)).length,
    certification: shown.length + o.browse.filter((b) => isReserved(b.setAside)).length,
    trade: fits.length,
    'alert-reason': alertItems.length,
    'alert-missing': o.browse.length,
    'repeat-scan': o.repeat ? 1 : 0,
    'free-no-premium': p.plan === 'free' ? (o.estimate ? 3 : 0) + (o.market ? 2 : 0) : 0,
    'estimate-not-silent': p.plan === 'pro' && o.estimate ? 2 : 0,
    'stream-delivery': o.stream?.stored.length ?? 0,
    filters: (o.filters?.distance.items.length ?? 0) + (o.filters?.due.items.length ?? 0),
    'filters (price)': o.filters?.price.items.filter(hasEstimate).length ?? 0,
    'next-in-deck': o.next?.item ? 1 : 0,
    'next-rank': o.next?.item && o.asOf ? 1 : 0,
    'browse-complete': o.expectedInBrowse?.length ?? 0,
    determinism: 0,
  };
}

// ------------------------------------------------------------------ checks --

export function checkPersona(p: Persona, o: PersonaObs, byId: ReadonlyMap<string, FeedItem>): Violation[] {
  const out: Violation[] = [];
  const v = (check: CheckId, detail: string) => out.push({ check, persona: p.key, detail });
  const radius = p.answers.radiusMi;
  const alertItems = o.alerts.map((a) => ({ a, item: a.bidId ? byId.get(a.bidId) ?? null : null }));
  const shown: Array<{ where: string; item: FeedItem }> = [
    ...o.decks.flatMap((d, i) => d.map((item) => ({ where: `deck#${i + 1}`, item }))),
    ...(o.next?.item ? [{ where: 'next', item: o.next.item }] : []),
    ...alertItems.flatMap(({ item }) => (item ? [{ where: 'alert', item }] : [])),
  ];

  // radius: nothing measured beyond the radius is in the deck, the next pick or an alert.
  for (const { where, item } of shown) {
    if (item.distanceMi !== null && item.distanceMi > radius) v('radius', `${where}: ${short(item)} is ${Math.round(item.distanceMi)} mi away (radius ${radius})`);
  }
  for (const { a, item } of alertItems) if (!item) v('radius', `alert ${a.id} names a bid the feed does not have (${a.bidId})`);

  // spend limit: no over-limit bid in the deck, the next pick or an alert (flag and recomputed rule).
  for (const { where, item } of shown) {
    if (item.overLimit) v('spend-limit', `${where}: ${short(item)} is flagged over the limit`);
    else if (overLimitByRule(item, p)) v('spend-limit', `${where}: ${short(item)} est. ${JSON.stringify(item.estValue)} is over the persona's limits`);
  }

  // certification: a reserved job the company is not certified for never reaches it; a certified one is never blocked.
  for (const { where, item } of shown) {
    if (isReserved(item.setAside) && !certifiedFor(p, item.setAside)) v('certification', `${where}: ${short(item)} is reserved (${item.setAside}) and the company is not certified`);
  }
  for (const item of o.browse) {
    if (isReserved(item.setAside) && certifiedFor(p, item.setAside) && /^(Reserved for|Sole source to)/.test(item.reasons[0]?.text ?? '')) {
      v('certification', `browse: ${short(item)} blocks a certified company: “${item.reasons[0]!.text}”`);
    }
  }

  // trade separation: a pipe-side company never gets an electrical-only job as a fit, and the reverse.
  const trades = new Set(p.answers.trades);
  const pipeCo = [...trades].every((t) => PIPE_SIDE.has(t));
  const elecCo = [...trades].every((t) => ELECTRICAL_SIDE.has(t));
  const fitById = new Map<string, FeedItem>();
  for (const b of [...o.browse.filter((x) => FIT.has(x.verdict)), ...shown.filter((s) => s.where === 'alert').map((s) => s.item)]) fitById.set(b.id, b);
  const fits = [...fitById.values()];
  for (const item of fits) {
    if (pipeCo && electricalOnly(item)) v('trade', `${short(item)} is electrical-only but is a ${item.verdict} fit (${item.score}) for a ${[...trades].join('+')} company`);
    if (elecCo && pipeOnly(item)) v('trade', `${short(item)} is plumbing/HVAC-only but is a ${item.verdict} fit (${item.score}) for a ${[...trades].join('+')} company`);
  }

  // every alert carries a reason, and its body says one of them.
  for (const { a, item } of alertItems) {
    if (!item) continue;
    const said = item.reasons.filter((r) => r.kind !== 'minus').map((r) => r.text);
    if (said.length === 0) v('alert-reason', `alert ${a.id} for ${short(item)}: the bid has no plus or info reason`);
    else if (!said.some((t) => a.body.includes(t))) v('alert-reason', `alert ${a.id} body “${a.body}” states none of the bid's reasons`);
  }

  // every bid at or above the alert score, not over a limit, is in the inbox (the scorer's own verdict on what
  // to alert is the one the company sees in Browse, so an alert that was decided but never stored shows here).
  const threshold = p.answers.alerts?.minScore ?? 55;
  const alerted = new Set(o.alerts.map((a) => a.bidId));
  for (const b of o.browse) {
    if (b.score >= threshold && !b.overLimit && !alerted.has(b.id)) v('alert-missing', `${short(b)} scores ${b.score} (alert score ${threshold}) but is not in the inbox`);
  }

  // a repeat of the same scan creates nothing.
  if (o.repeat) {
    const added = o.repeat.after.filter((id) => !o.repeat!.before.includes(id));
    if (added.length || o.repeat.events > 0) v('repeat-scan', `the identical scan added ${added.length} alert(s) and ${o.repeat.events} alert event(s)`);
  }

  // stored → streamed.
  if (o.stream) {
    for (const id of o.stream.stored) if (!o.stream.delivered.includes(id)) v('stream-delivery', `alert ${id} was stored but never reached the open stream`);
  }

  // filters return only what they ask for.
  if (o.filters) {
    const { price, distance, due } = o.filters;
    for (const b of price.items) {
      const e = b.estValue;
      if (e && ((e.max != null && e.max < price.min) || (e.min != null && e.min > price.max))) v('filters', `price ${price.min}–${price.max}: ${short(b)} est. ${JSON.stringify(e)}`);
    }
    for (const b of distance.items) if (b.distanceMi === null || b.distanceMi > distance.maxMi) v('filters', `distance ≤ ${distance.maxMi}: ${short(b)} at ${b.distanceMi}`);
    const by = Date.parse(due.now) + due.days * 86_400_000;
    for (const b of due.items) if (!b.dueAt || Date.parse(b.dueAt) > by) v('filters', `due within ${due.days} d: ${short(b)} due ${b.dueAt}`);
  }

  // the next pick is one of the deck's bids.
  const lastDeck = o.decks.at(-1) ?? [];
  if (o.next?.item && !lastDeck.some((b) => b.id === o.next!.item!.id)) v('next-in-deck', `next pick ${short(o.next.item)} is not in the deck`);

  // the next pick is the best of the deck: no candidate outranks it on score plus deadline urgency.
  if (o.next?.item && o.asOf) {
    const nowMs = Date.parse(o.asOf);
    const pick = o.next.item;
    const pickRank = nextRank(pick, nowMs);
    if (pickRank === null) v('next-rank', `next pick ${short(pick)} (score ${pick.score}) is not a candidate at all`);
    else {
      const better = lastDeck.filter((b) => b.id !== pick.id).map((b) => ({ b, r: nextRank(b, nowMs) })).filter((x) => x.r !== null && x.r > pickRank + 1e-9);
      if (better.length) v('next-rank', `next pick ${short(pick)} ranks ${pickRank.toFixed(1)} but ${short(better[0]!.b)} ranks ${better[0]!.r!.toFixed(1)}`);
    }
  }

  // Browse is complete: no bid the scorer calls maybe-or-better is missing (the candidate filter dropped nothing worth seeing).
  if (o.expectedInBrowse) {
    const inBrowse = new Set(o.browse.map((b) => b.id));
    for (const e of o.expectedInBrowse) {
      if (!inBrowse.has(e.id)) v('browse-complete', `${short(e)} scores ${e.score} for this company but is not in Browse`);
    }
  }

  // free plan: no premium numbers anywhere.
  if (p.plan === 'free') {
    if (o.features?.estimator) v('free-no-premium', 'GET /api/me says the free plan has the estimator');
    if (o.estimate) {
      for (const [name, r] of Object.entries(o.estimate)) {
        if (r.status !== 402) v('free-no-premium', `${name} estimate answered HTTP ${r.status}, not 402`);
        const keys = Object.keys(r.body ?? {}).filter((k) => k !== 'error' && k !== 'message');
        if (keys.length) v('free-no-premium', `${name} estimate 402 body carries ${keys.join(', ')}`);
      }
    }
    if (o.market) {
      const aw = o.market.awards.body ?? {};
      if (aw.locked !== true) v('free-no-premium', 'market awards are not locked on the free plan');
      for (const at of premiumNumbers(aw)) v('free-no-premium', `market awards show ${at}`);
      const watch = o.market.watch.body ?? {};
      if (watch.locked !== true) v('free-no-premium', 'market watch is not locked on the free plan');
      for (const at of premiumNumbers(watch)) v('free-no-premium', `market watch shows ${at}`);
    }
  }

  // premium estimate: a price, or a list of what is needed. Never a silent zero.
  if (p.plan === 'pro' && o.estimate) {
    for (const [name, r] of Object.entries({ full: o.estimate.full, quick: o.estimate.quick })) {
      const b = r.body ?? {};
      if (r.status !== 200) {
        v('estimate-not-silent', `${name} estimate answered HTTP ${r.status}: ${JSON.stringify(b).slice(0, 160)}`);
        continue;
      }
      const total = b.total as number | null | undefined;
      const needed = (b.needed as unknown[] | undefined) ?? [];
      if (b.status === 'complete') {
        if (typeof total !== 'number' || total <= 0) v('estimate-not-silent', `${name} estimate is "complete" with total ${total}`);
        const price = b.price as { bid?: number } | null;
        if (!price || price.bid !== total) v('estimate-not-silent', `${name} estimate total ${total} differs from price.bid ${price?.bid}`);
      } else if (b.status === 'incomplete') {
        if (needed.length === 0) v('estimate-not-silent', `${name} estimate is incomplete with an empty "needed" list`);
        if (total !== null) v('estimate-not-silent', `${name} estimate is incomplete but carries total ${total}`);
      } else v('estimate-not-silent', `${name} estimate has status ${String(b.status)}`);
    }
  }
  return out;
}
