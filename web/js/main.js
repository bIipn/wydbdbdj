// BidSwipe web app entry: plain ES modules, no build step.
// Talks to the Fastify API when it's there; otherwise runs on the bundled snapshot (demo mode).
//
// Boot order: demo snapshot → GET /api/me →
//   single mode (the pilot): the v0 swipe app, as before
//   accounts mode: sign-in (401) → onboarding (needsOnboarding) → the feed
//   401 access_code_required: the access-code gate

import { api, setAuthHandler } from './api.js';
import { $, $$, store } from './dom.js';
import { enterApp, signedOut, startDemo } from './session.js';
import { setView, showMessage } from './shell.js';
import { fling } from './actions.js';
import { closeSheet, openSheet, sheetOpen } from './sheet.js';
import { deck, state } from './state.js';
import './live.js';
import { openAlerts, openBidById } from './views/alerts.js';
import './views/cost.js';
import './views/feed.js';
import { showGate } from './views/gate.js';
import './views/market.js';
import './views/onboarding.js';
import { openSettings } from './views/settings.js';
import { showSignIn } from './views/signin.js';

// The session ended or there is no profile yet, wherever the call came from.
setAuthHandler((code) => {
  closeSheet();
  if (code === 'sign_in_required') {
    signedOut();
    showSignIn('login');
  } else if (state.view !== 'onboarding') {
    setView('onboarding');
  }
});

$$('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
$('#profileChip').addEventListener('click', openSettings);
$('#bell').addEventListener('click', openAlerts);

// A tapped phone notification: the service worker focuses this tab and names the bid.
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'open-bid' && typeof e.data.bidId === 'string' && state.me) openBidById(e.data.bidId);
});

/** Opened from a notification (…/?bid=<id>): show that bid once the feed is in. */
function openLinkedBid() {
  const params = new URLSearchParams(location.search);
  const id = params.get('bid');
  if (!id) return;
  params.delete('bid');
  history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : '') + location.hash);
  if (state.me && !state.me.needsOnboarding) openBidById(id);
}
$('#sheetBackdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return closeSheet();
  if (state.view !== 'swipe' || sheetOpen() || e.target.closest?.('input, textarea, select')) return;
  const current = deck()[0];
  if (!current) return;
  if (e.key === 'ArrowRight') fling(current, 'save');
  if (e.key === 'ArrowLeft') fling(current, 'pass');
  if (e.key === 'ArrowUp' || (e.key === 'Enter' && !e.target.closest?.('button, a'))) openSheet(current);
});

/** Back from a Google / Apple / Microsoft sign-in: Supabase puts the access token in the URL fragment. */
async function finishOAuth() {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('access_token');
  if (!token) return;
  history.replaceState(null, '', location.pathname + location.search); // never leave a token in the address bar
  try { await api.oauth(token); } catch { /* the sign-in screen comes up and says nothing went through */ }
}

async function fallBackToDemo() {
  try {
    // No API (static hosting or opened as a file): fall back to the bundled snapshot.
    startDemo(await (await fetch('demo-data.json')).json());
  } catch {
    showMessage('Can’t reach the server', 'Check your connection and reload.');
  }
}

async function boot() {
  if (window.BIDSWIPE_DEMO) return startDemo(window.BIDSWIPE_DEMO);
  if (new URLSearchParams(location.search).has('demo')) return startDemo(await (await fetch('demo-data.json')).json());
  state.accessCode ??= store.get('bidswipe:code');
  await finishOAuth();
  try {
    state.mode = 'live';
    await enterApp(await api.me({ quiet: true }));
    openLinkedBid();
  } catch (err) {
    if (err.code === 'access_code_required') {
      return showGate(state.accessCode ? 'That code didn’t work — try again.' : undefined, boot);
    }
    if (err.code === 'sign_in_required') {
      signedOut();
      return showSignIn('login');
    }
    if (err.status === 0 || err.status === 404) return fallBackToDemo();
    // The API is there but broken — never paper over that with demo data.
    showMessage('Server error', `The bid server answered ${err.status}. Try again in a minute.`);
  }
}

boot();
