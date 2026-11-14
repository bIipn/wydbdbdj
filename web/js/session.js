// Getting into the app: who am I, which screen comes first, and loading the feed.

import { api, demoSwipes } from './api.js';
import { defaultFilters } from './filters.js';
import { setView } from './shell.js';
import { intent, state } from './state.js';

/** Take GET /api/me. Single mode answers the v0 fields only; accounts mode adds { account, profile, features }. */
export function applyMe(me) {
  state.me = me;
  state.auth = me && me.account ? 'accounts' : 'single';
  state.profile = me ? { name: me.name ?? me.profile?.businessName ?? 'BidSwipe', base: me.base ?? me.profile?.base ?? '' } : null;
}

const feedHooks = [];
const enterHooks = [];
/** Runs after every feed load (boot, settings save, a finished scan): e.g. refresh "Next up" and Browse. */
export function onFeedLoaded(fn) { feedHooks.push(fn); }
/** Runs once the app is entered with a profile (live mode): e.g. connect the live stream. */
export function onEnteredApp(fn) { enterHooks.push(fn); }

export async function loadFeed() {
  const feed = await api.feed();
  state.items = feed.items;
  state.counts = feed.counts ?? null; // an older server sends none: the screens then count the list itself
  state.lastScan = feed.lastScan;
  state.browseIds = null; // Browse asks the API again with its filters
  for (const fn of feedHooks) fn();
}

/** Accounts mode: the sign-in options and whether DEMO_MODE is on. Loaded once, never fatal. */
export async function loadAuthConfig() {
  if (state.authConfig) return state.authConfig;
  try {
    state.authConfig = await api.authConfig();
  } catch {
    state.authConfig = { mode: 'accounts', providers: ['password'], demo: false };
  }
  return state.authConfig;
}

/**
 * Where someone who is here only to get work done ('hire') lands: the Jobs screen once a module registers it
 * (setHireLanding('jobs')), the deck until then. Everyone else lands on the deck as always.
 */
let hireLanding = 'swipe';
export function setHireLanding(view) { hireLanding = view; }
/** The first screen for this account: the deck, or the hire landing for someone here only to post jobs. */
export const homeView = () => (intent() === 'hire' ? hireLanding : 'swipe');

/** After boot, sign-in or onboarding: onboarding if there is no profile yet, else the feed. */
export async function enterApp(me) {
  applyMe(me ?? (await api.me({ quiet: true })));
  if (state.auth === 'accounts') await loadAuthConfig();
  if (state.me.needsOnboarding) return setView('onboarding');
  await loadFeed();
  setView(homeView());
  for (const fn of enterHooks) fn();
}

const signOutHooks = [];
/** A module that keeps its own per-account state (a half-done onboarding) clears it here. */
export function onSignedOut(fn) { signOutHooks.push(fn); }

/** Back to a signed-out app (sign-out, or the session expired). Does not change the view. */
export function signedOut() {
  for (const fn of signOutHooks) fn();
  state.auth = 'accounts';
  state.me = null;
  state.profile = null;
  state.items = [];
  state.counts = null;
  state.browseCounts = null;
  state.lastScan = null;
  state.browse = defaultFilters();
  state.browseIds = null;
  state.browseError = null;
  state.next = null;
  state.unread = 0;
  state.alerts = null;
}

export function startDemo(data) {
  state.mode = 'demo';
  state.auth = 'single';
  state.profile = data.profile;
  state.note = data.note || '';
  const saved = demoSwipes();
  state.items = data.items.map((i) => ({ ...i, swipe: saved[i.id] ?? null }));
  setView('swipe');
}

/** The Sign out button: end the session on the server, then the sign-in screen. */
export async function signOut() {
  try { await api.logOut(); } catch { /* the cookie is cleared or already gone; sign-in is next either way */ }
  signedOut();
  setView('signin');
}
