// The one shared state object, plus the lists every view derives from it.
// Mutate fields in place (state.items = …); never reassign `state` itself.

import { defaultFilters } from './filters.js';
import { byFit, dueInfo, isOpen, tierOf } from './format.js';

export const DECK_MIN_SCORE = 35;

export const state = {
  /** 'live' = the API (single mode or accounts mode), 'demo' = the bundled snapshot. */
  mode: 'live',
  /** 'single' (the pilot: one profile from config) | 'accounts' (sign-in, onboarding, settings). */
  auth: 'single',
  /** GET /api/me. Single mode: { id, name, base, … }. Accounts: also { account, profile, features, needsOnboarding }. */
  me: null,
  /** GET /api/auth/config in accounts mode: { mode, providers, demo, promo, supabase? }. promo: show the code box. */
  authConfig: null,
  /** The header chip: { name, base }. */
  profile: null,
  items: [],
  /** GET /api/feed `counts` for the whole feed ({ fit, sub, other }: open, unswiped candidates), null if not sent. */
  counts: null,
  /** The same counts for Browse's current search and filters (any tier), null if not sent. */
  browseCounts: null,
  note: '',
  lastScan: null,
  view: 'swipe',
  /** Browse: the search and filters, sent to GET /api/feed as query parameters (see filters.js). */
  browse: defaultFilters(),
  /** Browse results: ids in the order the API sorted them (null = not loaded yet), and a load error. */
  browseIds: null,
  browseError: null,
  browseLoading: false,
  /** GET /api/next: { item, why } (null = not loaded, or demo mode). */
  next: null,
  /** The alert inbox: unread count, and the list once the inbox has been opened. */
  unread: 0,
  alerts: null,
  /** Live stream status: 'off' | 'connecting' | 'live' | 'retrying'. */
  live: 'off',
  accessCode: null,
};

const ALL_ON = { instantPush: true, awardHistory: true, costSettings: true, awardWatch: true, priceAlerts: true, estimator: true };

/** What the plan unlocks. Single mode (the pilot) has every feature; demo mode (no server) has none of the live ones. */
export function features() {
  if (state.mode !== 'live') return null;
  return state.me?.features ?? (state.auth === 'single' ? ALL_ON : null);
}

/**
 * "What brings you here": 'work' (bids and local jobs), 'hire' (post jobs) or 'both'. From GET /api/me; the pilot,
 * the demo and any account that never answered are 'work', so everything that existed behaves as before.
 */
export const intent = () => state.me?.intent ?? 'work';

/** Live features (Next up, alerts, market) need the API; the bundled demo has none. */
export const isLive = () => state.mode === 'live' && !!state.me;

/** The general-building trade (src/trades/catalog.ts): a company with it IS the prime, so it never gets sub work. */
export const PRIME_TRADE = 'general-building';

/** Does this company get a sub-work tier at all? Not a general contractor; the pilot (single mode) and the demo do. */
export const hasSubTier = () => !(state.me?.profile?.trades ?? []).includes(PRIME_TRADE);

/** Settings' "Show sub work" switch (missing = on). Off keeps sub work out of the deck; Browse still lists it. */
export const subWorkShown = () => hasSubTier() && state.me?.profile?.showSubWork !== false;

/** Own-trade fits before sub work, each best first: a sub card never sits above a real fit. */
const deckOrder = (a, b) => (tierOf(a) === 'sub') - (tierOf(b) === 'sub') || byFit(a, b);

/**
 * The swipe deck: open, unswiped, at the deck line, and never a bid over the company's spend limits. Sub work is
 * in it (36–50 on its own scale) unless "Show sub work" is off.
 */
export const deck = () => state.items.filter((i) => !i.swipe && !i.overLimit && i.score >= DECK_MIN_SCORE && isOpen(i)
  && (subWorkShown() || tierOf(i) !== 'sub')).sort(deckOrder);

/**
 * { fit, sub, other }: the open bids in reach not yet swiped. Counted from the loaded list (so a swipe shows at
 * once); the server's counts win when the list was cut off at its limit. null = nothing loaded.
 */
export function feedCounts() {
  const out = { fit: 0, sub: 0, other: 0 };
  for (const i of state.items) if (!i.swipe && isOpen(i)) out[tierOf(i)] += 1;
  const server = state.counts;
  if (server && server.fit + server.sub + server.other > out.fit + out.sub + out.other && state.items.length >= 300) return { ...server };
  return out;
}

export const savedList = () =>
  state.items.filter((i) => i.swipe === 'save' || i.swipe === 'bid').sort((a, b) => dueInfo(a.dueAt).days - dueInfo(b.dueAt).days);

/** Browse: the API's results in its order, read from state.items so a swipe shows everywhere at once. */
export function browseList() {
  if (!state.browseIds) return [];
  const byId = new Map(state.items.map((i) => [i.id, i]));
  return state.browseIds.map((id) => byId.get(id)).filter(Boolean);
}

/** Put API items into state.items: the same object per bid (updated in place), new bids added. Returns them. */
export function mergeItems(fresh) {
  const byId = new Map(state.items.map((i) => [i.id, i]));
  return fresh.map((f) => {
    const have = byId.get(f.id);
    if (have) return Object.assign(have, f);
    state.items.push(f);
    byId.set(f.id, f);
    return f;
  });
}
