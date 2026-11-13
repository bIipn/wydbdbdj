// The live connection: GET /api/stream (Server-Sent Events). A new match shows as a toast and joins the
// deck without a reload; the bell counts unread alerts; a finished scan refreshes the feed.
//
// EventSource reconnects by itself and sends Last-Event-ID, so the server replays what was missed.
// It cannot send headers, so with the pilot's access code on we read the same stream with fetch().
//
// Poll mode (REALTIME_MODE=poll, serverless hosts): the stream answers 404 { error: 'stream_off', pollMs }.
// Then the app asks GET /api/alerts every pollMs while the page is on screen, and every alert newer than
// the last one it knew goes through the same onAlert() as a stream event: same toast, same bell count.

import { api } from './api.js';
import { loadNext } from './browse.js';
import { showToast } from './dom.js';
import { mergeItems, state } from './state.js';
import { loadFeed, onEnteredApp, onSignedOut } from './session.js';
import { openSheet } from './sheet.js';
import { openAlerts } from './views/alerts.js';
import { render, setView } from './shell.js';

const ALERT_KINDS = ['match', 'deadline', 'award', 'price'];
const RETRY_MS = 5000;
const BUSY_RETRY_MS = 60_000; // 429: too many open connections for this account

const conn = { es: null, abort: null, timer: null, lastId: 0, seen: new Set(), on: false };
/** Poll mode: pollMs > 0 once the server said the stream is off. `known` = the first poll has set lastId. */
// lastScan: when the last scan finished, as the inbox answer says; a change means the feed has new bids.
const poll = { ms: 0, timer: null, known: false, busy: false, lastScan: null };

const setStatus = (s) => {
  if (state.live === s) return;
  state.live = s;
  const bell = document.getElementById('bell');
  if (bell) bell.dataset.live = s;
};

/** GET /api/alerts once for the unread count (the inbox loads the list when it is opened). */
export async function loadUnread() {
  try {
    const res = await api.alerts({ limit: 1 });
    state.unread = res.unread;
    render();
  } catch { /* the bell just shows no count */ }
}

// ------------------------------------------------------------ events ---

/** Alerts that arrive together (one scan) make one toast, not a row of them. */
const burst = { alerts: [], items: new Map(), timer: null, shownAt: 0 };
const KIND_LABEL = { match: 'New match', deadline: 'Deadline', award: 'Award posted', price: 'Price move' };

function toastBurst() {
  const alerts = burst.alerts.splice(0);
  burst.timer = null;
  if (!alerts.length) return;
  burst.shownAt = Date.now();
  if (alerts.length === 1) {
    const [a] = alerts;
    const item = a.bidId ? burst.items.get(a.bidId) : null;
    showToast(`${KIND_LABEL[a.kind] ?? 'Alert'}: ${a.title}`, item ? () => openSheet(item) : openAlerts, item ? 'View' : 'Open', 8000);
  } else {
    const matches = alerts.filter((a) => a.kind === 'match').length;
    showToast(matches === alerts.length ? `${matches} new bids fit you` : `${alerts.length} new alerts`, openAlerts, 'See them', 8000);
  }
  burst.items.clear();
}

async function onAlert(alert) {
  if (!alert || typeof alert.id !== 'number' || conn.seen.has(alert.id)) return;
  conn.seen.add(alert.id);
  if (alert.id > conn.lastId) conn.lastId = alert.id;
  state.unread += 1;
  if (state.alerts) state.alerts.items.unshift(alert);
  burst.alerts.push(alert);
  clearTimeout(burst.timer);
  burst.timer = setTimeout(toastBurst, 700);

  if (alert.kind === 'match' && alert.bidId) {
    try {
      burst.items.set(alert.bidId, mergeItems([await api.bid(alert.bidId)])[0]); // joins the deck at once, sorted by fit
    } catch { /* the toast still says it; the next feed load brings it */ }
    loadNext();
  }
  render();
}

async function onScan(data) {
  try {
    await loadFeed();
    render();
  } catch { return; }
  const mine = data?.profile?.newGood;
  // The matches of this scan already made their toast: do not cover it.
  if (burst.alerts.length || Date.now() - burst.shownAt < 8000) return;
  if (data?.newBids) showToast(`Scan finished — ${data.newBids} new bid${data.newBids === 1 ? '' : 's'}${mine ? `, ${mine} fit you` : ''}`);
}

function dispatch(event, raw) {
  if (event === 'ping') return;
  let data;
  try { data = JSON.parse(raw); } catch { return; }
  if (event === 'scan') onScan(data);
  else if (ALERT_KINDS.includes(event) || event === 'alert') onAlert(data);
}

// ------------------------------------------------------- EventSource ---

function openEventSource() {
  const es = new EventSource('api/stream', { withCredentials: true });
  conn.es = es;
  setStatus('connecting');
  es.onopen = () => setStatus('live');
  for (const kind of [...ALERT_KINDS, 'alert', 'scan']) es.addEventListener(kind, (e) => dispatch(kind, e.data));
  es.onerror = () => {
    // CONNECTING = it is retrying by itself. CLOSED = the server refused (401, 429, …): find out which.
    if (es.readyState === EventSource.CONNECTING) return setStatus('retrying');
    es.close();
    conn.es = null;
    setStatus('retrying');
    refused();
  };
}

// --------------------------------------------- fetch() (access code) ---

async function readWithFetch() {
  const ctrl = new AbortController();
  conn.abort = ctrl;
  setStatus('connecting');
  let wait = RETRY_MS;
  try {
    const res = await fetch(`api/stream${conn.lastId ? `?lastEventId=${conn.lastId}` : ''}`, {
      headers: { accept: 'text/event-stream', 'x-access-code': state.accessCode ?? '' }, credentials: 'same-origin', signal: ctrl.signal,
    });
    if (res.status === 401) { conn.abort = null; return refused(); }
    if (res.status === 404) {
      const off = await streamOff(res);
      if (off) { conn.abort = null; return startPolling(off); }
    }
    if (!res.ok || !res.body) { wait = BUSY_RETRY_MS; throw new Error(`HTTP ${res.status}`); }
    setStatus('live');
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value.replace(/\r\n?/g, '\n');
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        let event = 'message';
        const data = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          else if (line.startsWith('id:')) { const id = Number(line.slice(3)); if (id > conn.lastId) conn.lastId = id; }
        }
        if (data.length) dispatch(event, data.join('\n'));
      }
    }
  } catch { /* dropped, refused or aborted: retry below unless stopped */ }
  conn.abort = null;
  if (conn.on) { setStatus('retrying'); schedule(wait); }
}

// ------------------------------------------------------------- start ---

/**
 * The stream was refused. EventSource does not say why, so ask GET /api/me (not quiet): an expired session
 * answers 401 sign_in_required, and the app's auth handler stops this connection (onSignedOut) and shows
 * sign-in. Anything else (429 too many connections, a restart) is retried, slower.
 */
async function refused() {
  if (!conn.on) return;
  // Is the stream switched off on this server (poll mode)? A 404 cannot be told apart from a 401 or a
  // 429 by EventSource, so ask once with fetch(). If the stream is on after all (the server restarted),
  // that request opened one: it is cancelled at once and EventSource reconnects as before.
  const ctrl = new AbortController();
  try {
    const res = await fetch('api/stream', { headers: { accept: 'text/event-stream' }, credentials: 'same-origin', signal: ctrl.signal });
    const off = res.status === 404 ? await streamOff(res) : 0;
    ctrl.abort();
    if (off) return startPolling(off);
  } catch { ctrl.abort(); }
  if (!conn.on) return;
  try {
    await api.me();
  } catch (err) {
    if (err.code === 'sign_in_required' || err.code === 'onboarding_required' || err.code === 'access_code_required') {
      if (conn.on) stopLive(); // the auth handler normally did this already
      return;
    }
  }
  if (conn.on) schedule(BUSY_RETRY_MS);
}

// -------------------------------------------------------------- poll ---

/** The poll interval if this 404 is the server's "stream_off" answer, else 0. Never under 15 s. */
async function streamOff(res) {
  const body = await res.json().catch(() => null);
  if (body?.error !== 'stream_off') return 0;
  const ms = Number(body.pollMs);
  return Number.isFinite(ms) && ms > 0 ? Math.max(ms, 15_000) : 60_000;
}

function startPolling(ms) {
  if (!conn.on) return;
  poll.ms = ms;
  setStatus('polling');
  if (document.visibilityState === 'visible') pollNow();
}

/** Ask once now, then again every poll.ms, but only while the page is on screen. */
async function pollNow() {
  clearTimeout(poll.timer);
  poll.timer = null;
  if (!conn.on || !poll.ms || poll.busy) return;
  poll.busy = true;
  try {
    const res = await api.alerts({ limit: 50 }); // a 401 here goes to the app's sign-in handler, which stops us
    const items = Array.isArray(res?.items) ? res.items : [];
    const scanAt = typeof res?.lastScan === 'string' ? res.lastScan : null;
    if (!poll.known) {
      // The first answer is the starting point, like the stream's opening cursor: nothing old is toasted.
      poll.known = true;
      poll.lastScan = scanAt;
      for (const a of items) {
        conn.seen.add(a.id);
        if (a.id > conn.lastId) conn.lastId = a.id;
      }
    } else {
      // Newest first from the server; announce oldest first, as the stream would have.
      const fresh = items.filter((a) => typeof a.id === 'number' && a.id > conn.lastId && !conn.seen.has(a.id)).reverse();
      for (const a of fresh) await onAlert(a);
      // A scan finished since the last poll: reload the feed, as the stream's 'scan' event does. Most new fits
      // raise no alert (under the alert line, or not new), so the alerts alone would leave the deck short.
      if (scanAt && scanAt !== poll.lastScan) {
        poll.lastScan = scanAt;
        try { await loadFeed(); } catch { /* the next app open brings them */ }
      }
    }
    if (typeof res?.unread === 'number') state.unread = res.unread; // the server's count wins over our +1s
    setStatus('polling');
    render();
  } catch { /* offline or a restart: the next poll tries again */ }
  poll.busy = false;
  if (conn.on && poll.ms && document.visibilityState === 'visible') poll.timer = setTimeout(pollNow, poll.ms);
}

// Hidden tab or minimized window: stop asking. Back on screen: ask at once, then on the interval.
document.addEventListener('visibilitychange', () => {
  if (!conn.on || !poll.ms) return;
  if (document.visibilityState === 'visible') pollNow();
  else { clearTimeout(poll.timer); poll.timer = null; }
});

function schedule(ms) {
  clearTimeout(conn.timer);
  conn.timer = setTimeout(connect, ms);
}

function connect() {
  if (!conn.on) return;
  if (state.accessCode || typeof EventSource === 'undefined') readWithFetch();
  else openEventSource();
}

export function startLive() {
  if (conn.on || state.mode !== 'live') return;
  conn.on = true;
  connect();
  loadUnread();
}

export function stopLive() {
  conn.on = false;
  clearTimeout(conn.timer);
  conn.es?.close();
  conn.es = null;
  conn.abort?.abort();
  conn.seen.clear();
  conn.lastId = 0;
  clearTimeout(poll.timer);
  Object.assign(poll, { ms: 0, timer: null, known: false, lastScan: null });
  setStatus('off');
}

/**
 * App shortcuts (manifest.webmanifest "shortcuts": right-click the taskbar / Start icon on Windows, long-press
 * on Android) open ./?view=swipe|browse|alerts. Read once, when the app is entered, then dropped from the address.
 */
function openShortcut() {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  if (!view) return;
  params.delete('view');
  history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : '') + location.hash);
  if (view === 'browse' || view === 'saved') setView(view);
  else if (view === 'alerts') openAlerts();
}

onEnteredApp(startLive);
onEnteredApp(openShortcut);
onSignedOut(stopLive);
