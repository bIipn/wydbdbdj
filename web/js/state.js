// The one shared state object, plus the lists every view derives from it.
// Mutate fields in place (state.items = …); never reassign `state` itself.

import { defaultFilters } from './filters.js';
import { byFit, dueInfo, isOpen } from './format.js';

export const DECK_MIN_SCORE = 35;

export const state = {
  /** 'live' = the API (single mode or accounts mode), 'demo' = the bundled snapshot. */
  mode: 'live',
  /** 'single' (the pilot: one profile from config) | 'accounts' (sign-in, onboarding, settings). */
  auth: 'single',
  /** GET /api/me. Single mode: { id, name, base, … }. Accounts: also { account, profile, features, needsOnboarding }. */
  me: null,
  /** GET /api/auth/config in accounts mode: { mode, providers, demo, supabase? }. */
  authConfig: null,
  /** The header chip: { name, base }. */
  profile: null,
  items: [],
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

/** Live features (Next up, alerts, market) need the API; the bundled demo has none. */
export const isLive = () => state.mode === 'live' && !!state.me;

/** The swipe deck: open, unswiped, a fit, and never a bid over the company's spend limits. */
export const deck = () => state.items.filter((i) => !i.swipe && !i.overLimit && i.score >= DECK_MIN_SCORE && isOpen(i)).sort(byFit);

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
