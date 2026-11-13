// The live connection: GET /api/stream (Server-Sent Events). A new match shows as a toast and joins the
// deck without a reload; the bell counts unread alerts; a finished scan refreshes the feed.
//
// EventSource reconnects by itself and sends Last-Event-ID, so the server replays what was missed.
// It cannot send headers, so with the pilot's access code on we read the same stream with fetch().

import { api } from './api.js';
import { loadNext } from './browse.js';
import { showToast } from './dom.js';
import { mergeItems, state } from './state.js';
import { loadFeed, onEnteredApp, onSignedOut } from './session.js';
import { openSheet } from './sheet.js';
import { openAlerts } from './views/alerts.js';
import { render } from './shell.js';

const ALERT_KINDS = ['match', 'deadline', 'award', 'price'];
const RETRY_MS = 5000;
const BUSY_RETRY_MS = 60_000; // 429: too many open connections for this account

const conn = { es: null, abort: null, timer: null, lastId: 0, seen: new Set(), on: false };

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
    // CONNECTING = it is retrying by itself. CLOSED = the server refused (401, 429, …): we retry, slower.
    if (es.readyState === EventSource.CONNECTING) return setStatus('retrying');
    es.close();
    conn.es = null;
    setStatus('retrying');
    schedule(BUSY_RETRY_MS);
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
  setStatus('off');
}

onEnteredApp(startLive);
onSignedOut(stopLive);
