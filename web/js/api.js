// Every call to the server goes through req(). Same-origin fetch, so the session cookie rides along.

import { store } from './dom.js';
import { state } from './state.js';

/** A non-2xx answer. `code` is the API's { error } (e.g. 'sign_in_required'), `body` the whole JSON. */
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error ?? null;
    this.body = body ?? {};
  }
}

/**
 * Which build this is: 'web' (the browser and the Microsoft Store wrapper) or 'ios' (a future App Store
 * wrapper sets this one constant). The iOS build tells the server on every request, and the server then turns
 * promo codes off for it: Apple guideline 3.1.1 bars unlocking features with our own codes (docs/PRODUCT.md §4).
 */
export const STORE_BUILD = 'web';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let onAuthLost = null;

/**
 * Called when the server says the session is gone (401 sign_in_required) or there is no profile yet
 * (409 onboarding_required). main.js routes to the sign-in or onboarding screen. The call still throws.
 */
export function setAuthHandler(fn) { onAuthLost = fn; }

export async function req(path, opts = {}) {
  const method = (opts.method ?? 'GET').toUpperCase();
  // Only claim JSON when there is a body — Fastify rejects an empty JSON body (e.g. on DELETE).
  const headers = opts.body !== undefined ? { 'content-type': 'application/json' } : {};
  if (WRITES.has(method)) headers['x-bidswipe'] = '1'; // CSRF proof in accounts mode; harmless in single mode
  if (state.accessCode) headers['x-access-code'] = state.accessCode;
  if (STORE_BUILD !== 'web') headers['x-bidswipe-store'] = STORE_BUILD;
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  let res;
  try {
    res = await fetch(path, { method, body, headers, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, { error: 'network', message: 'Can’t reach the server. Check your connection.' });
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new ApiError(res.status, json);
    if (onAuthLost && (err.code === 'sign_in_required' || err.code === 'onboarding_required') && !opts.quiet) onAuthLost(err.code);
    throw err;
  }
  return json;
}

// ------------------------------------------------------- demo swipes ---

const DEMO_KEY = 'bidswipe:demo-swipes';
export function demoSwipes() {
  try { return JSON.parse(store.get(DEMO_KEY) || '{}'); } catch { return {}; }
}
function persistDemo() {
  const map = {};
  for (const i of state.items) if (i.swipe) map[i.id] = i.swipe;
  store.set(DEMO_KEY, JSON.stringify(map));
}

// ---------------------------------------------------------- endpoints ---

export const api = {
  me: (opts) => req('api/me', opts),
  feed: () => req('api/feed?all=1&minScore=0&limit=300'),
  async swipe(id, action) {
    if (state.mode === 'demo') return persistDemo();
    await req('api/swipe', { method: 'POST', body: { bidId: id, action } });
  },
  async undo(id) {
    if (state.mode === 'demo') return persistDemo();
    await req(`api/swipe/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  // accounts mode
  authConfig: () => req('api/auth/config'),
  signUp: (email, password) => req('api/auth/signup', { method: 'POST', body: { email, password } }),
  logIn: (email, password) => req('api/auth/login', { method: 'POST', body: { email, password } }),
  oauth: (accessToken) => req('api/auth/oauth', { method: 'POST', body: { accessToken } }),
  logOut: () => req('api/auth/logout', { method: 'POST' }),
  trades: () => req('api/trades'),
  zip: (zip) => req(`api/geo/zip/${encodeURIComponent(zip)}`),
  // lat/lng already rounded to 2 decimals by the caller; the server answers the ZIP and never stores the point
  nearestZip: (lat, lng) => req(`api/geo/nearest-zip?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`),
  saveProfile: (answers) => req('api/profile', { method: 'PUT', body: answers }),
  // work profile: { workProfile, card }; PUT sends only the fields it changes. 400 { error: 'invalid_input', fields: [{ path, message }] }
  workProfile: () => req('api/work-profile'),
  saveWorkProfile: (body) => req('api/work-profile', { method: 'PUT', body }),
  // someone you dealt with on a job: { card }; 404 for anyone else
  person: (id) => req(`api/people/${encodeURIComponent(id)}`),
  // promo code → Pro (web and Microsoft Store builds; 403 not_available on iOS, 400 invalid_code, 429 too many tries)
  redeemPromo: (code) => req('api/promo/redeem', { method: 'POST', body: { code } }),

  // feed tools
  browse: (query) => req(`api/feed?${query}`),
  bid: (id) => req(`api/bids/${encodeURIComponent(id)}`),
  next: () => req('api/next'),

  // alerts inbox and phone alerts
  alerts: (opts = {}) => req(`api/alerts?limit=${opts.limit ?? 50}${opts.before ? `&before=${opts.before}` : ''}`),
  readAlerts: (ids) => req('api/alerts/read', { method: 'POST', body: ids === 'all' ? { all: true } : { ids } }),
  pushKey: () => req('api/push/key', { quiet: true }),
  pushSubscribe: (subscription) => req('api/push/subscribe', { method: 'POST', body: { subscription } }),
  pushUnsubscribe: (endpoint) => req('api/push/subscribe', { method: 'DELETE', body: { endpoint } }),

  // price check
  marketArea: (zip) => req(`api/market/area${zip ? `?zip=${encodeURIComponent(zip)}` : ''}`),
  marketAwards: (params) => req(`api/market/awards?${new URLSearchParams(params)}`),
  prevailing: (bidId) => req(`api/market/prevailing?bidId=${encodeURIComponent(bidId)}`),
  marketWatch: () => req('api/market/watch'),

  // cost check (premium: 402 premium_required on plans without the estimator)
  estimate: (body) => req('api/estimate', { method: 'POST', body }),
  estimates: (bidId) => req(`api/estimates?${bidId ? `bidId=${encodeURIComponent(bidId)}&` : ''}limit=20`),
};
