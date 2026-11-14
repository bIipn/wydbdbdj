// BidSwipe web app entry: plain ES modules, no build step.
// Talks to the Fastify API when it's there; otherwise runs on the bundled snapshot (demo mode).
//
// Boot order: demo snapshot → GET /api/me →
//   single mode (the pilot): the v0 swipe app, as before
//   accounts mode: sign-in (401) → onboarding (needsOnboarding) → the feed
//   401 access_code_required: the access-code gate

import { api, setAuthHandler } from './api.js';
import { $, $$, store } from './dom.js';
import { enterApp, onEnteredApp, signedOut, startDemo } from './session.js';
import { setView, showMessage } from './shell.js';
import { fling } from './actions.js';
import { closeSheet, openSheet, sheetOpen } from './sheet.js';
import { deck, state } from './state.js';
import './live.js';
// Reads ?promo=CODE at load (before boot) and applies it once the app is entered: src/auth/promo.ts.
import './promo.js';
import { openAlerts, openBidById } from './views/alerts.js';
import './views/cost.js';
import './views/feed.js';
import './views/job.js';
import './views/job-post.js';
import './views/jobs.js';
import { jobsOn, openJob } from './jobs-data.js';
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
  if (e.data?.type === 'open-job' && typeof e.data.jobId === 'string' && jobsOn()) openJob(e.data.jobId, 'jobs');
});

/**
 * Opened from a notification or a shared link: …/?bid=<id> shows that bid once the feed is in, …/?job=<id> opens
 * that local job's page (accounts mode). The parameter is taken out of the address so a reload does not reopen it.
 */
function openLinked() {
  const params = new URLSearchParams(location.search);
  const bid = params.get('bid');
  const job = params.get('job');
  if (!bid && !job) return;
  params.delete('bid');
  params.delete('job');
  history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : '') + location.hash);
  if (!state.me || state.me.needsOnboarding) return;
  if (job && jobsOn()) openJob(job, 'jobs');
  else if (bid) openBidById(bid);
}
// After every way in (boot, sign-in, the end of onboarding): a link opened while signed out still lands.
onEnteredApp(openLinked);
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
