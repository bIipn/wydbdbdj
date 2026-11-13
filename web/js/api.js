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
  saveProfile: (answers) => req('api/profile', { method: 'PUT', body: answers }),

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
};
