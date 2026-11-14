// The alert inbox (the bell): new matches, deadline reminders, award and price notices, newest first.
// Also the "Turn on phone alerts" control.

import { api } from '../api.js';
import { h, icon, ICONS, showToast } from '../dom.js';
import { fmtDay, clock } from '../format.js';
import { jobsOn, openJob } from '../jobs-data.js';
import { currentSubscription, pushKey, pushSupport, turnOffPush, turnOnPush } from '../push.js';
import { onSignedOut } from '../session.js';
import { openSheet } from '../sheet.js';
import { registerView, render, setView } from '../shell.js';
import { features, mergeItems, state } from '../state.js';

const ui = { back: 'swipe', loading: false, error: null, push: 'checking', pushNote: '' };
onSignedOut(() => { ui.push = 'checking'; });

const KIND = {
  match: 'New match', deadline: 'Deadline', award: 'Award', price: 'Price move',
  // local jobs (src/realtime/alerts.ts decideJob): the title says what happened, the tag says it is a local job
  job_awarded: 'Local job', job_message: 'Message', job_deadline: 'Contact reminder', job_closed: 'Local job',
};

/** Open one bid's detail sheet by id (an alert, a notification tap). */
export async function openBidById(id) {
  let item = state.items.find((i) => i.id === id);
  if (!item) {
    try { item = mergeItems([await api.bid(id)])[0]; } catch { return showToast('That bid is no longer in your feed'); }
  }
  openSheet(item);
}

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  const d = new Date(iso);
  return `${fmtDay.format(d)} · ${clock(d)}`;
}

async function loadInbox() {
  ui.loading = true;
  ui.error = null;
  try {
    const res = await api.alerts({ limit: 50 });
    state.alerts = { items: res.items };
    state.unread = res.unread;
  } catch (err) {
    ui.error = err.message || 'Couldn’t load your alerts.';
  }
  ui.loading = false;
  if (state.view === 'alerts') render();
}

async function markRead(ids) {
  try {
    const res = await api.readAlerts(ids);
    state.unread = res.unread;
    const now = new Date().toISOString();
    for (const a of state.alerts?.items ?? []) if (ids === 'all' || ids.includes(a.id)) a.readAt ??= now;
    render();
  } catch {
    showToast('Couldn’t mark that read — check your connection');
  }
}

// --------------------------------------------------------- push panel ---

async function checkPush() {
  const support = pushSupport();
  if (support !== 'ok') return support;
  const key = await pushKey();
  if (!key.ok) { ui.pushKey = null; return key.reason === 'not_configured' ? 'not_configured' : 'error'; }
  ui.pushKey = key.key;
  if (!features()?.instantPush) return 'locked';
  if (await currentSubscription()) return 'on';
  return Notification.permission === 'denied' ? 'denied' : 'off';
}

async function refreshPush() {
  ui.push = await checkPush();
  if (state.view === 'alerts') render();
}

async function tapTurnOn() {
  ui.push = 'busy';
  render();
  const res = await turnOnPush(ui.pushKey);
  if (res.ok) {
    ui.push = 'on';
    showToast('Phone alerts are on for this device');
  } else {
    ui.push = res.reason === 'denied' ? 'denied' : 'error';
    ui.pushNote = res.message ?? '';
  }
  render();
}

async function tapTurnOff() {
  ui.push = 'busy';
  render();
  try { await turnOffPush(); ui.push = 'off'; } catch { ui.push = 'error'; }
  render();
}

const PUSH_TEXT = {
  checking: 'Checking this device…',
  busy: 'One moment…',
  unsupported: 'This browser can’t show phone alerts. On an iPhone, add BidSwipe to your Home Screen first (Share → Add to Home Screen), then turn them on there.',
  insecure: 'Phone alerts need a secure (https) address.',
  not_configured: 'Phone alerts aren’t set up on this server yet, so it can’t send them. New matches still show here and pop up while the app is open.',
  locked: 'Instant phone alerts are a Pro feature. On Free you get this inbox and the daily email.',
  off: 'Get a notification the moment a bid that fits you is posted. Your phone asks for permission first.',
  on: 'This device gets a notification the moment a new bid fits you. Quiet hours in Settings hold them until morning.',
  denied: 'Notifications are blocked for this site. Allow them in your browser’s site settings, then come back.',
  error: 'That didn’t work. Try again in a minute.',
};

function pushPanel() {
  const s = ui.push;
  const button = s === 'off' ? h('button', { class: 'cta', type: 'button', onclick: tapTurnOn }, 'Turn on phone alerts')
    : s === 'on' ? h('button', { class: 'cta ghost', type: 'button', onclick: tapTurnOff }, 'Turn off on this device')
      : s === 'error' ? h('button', { class: 'cta ghost', type: 'button', onclick: refreshPush }, 'Try again')
        : null;
  const status = s === 'on' ? 'On' : s === 'locked' ? 'Pro' : s === 'off' ? 'Off' : s === 'not_configured' ? 'Not set up' : null;
  return h('section', { class: `panel push-panel push-${s}` },
    h('div', { class: 'push-head' },
      h('h2', { class: 'panel-title' }, 'Phone alerts'),
      status ? h('span', { class: `push-status ${s}` }, s === 'locked' ? icon(ICONS.lock) : null, status) : null,
    ),
    h('p', { class: 'plan-text' }, PUSH_TEXT[s] ?? ''),
    s === 'error' && ui.pushNote ? h('p', { class: 'pc-fine' }, ui.pushNote) : null,
    button,
  );
}

// -------------------------------------------------------------- view ---

function alertRow(a) {
  const unread = !a.readAt;
  return h('li', {},
    h('button', {
      class: `alert-row${unread ? ' unread' : ''} kind-${a.kind}`, type: 'button',
      onclick: () => {
        if (unread) markRead([a.id]);
        const jobId = String(a.kind).startsWith('job_') ? a.data?.jobId : null;
        if (typeof jobId === 'string' && jobsOn()) openJob(jobId, 'alerts');
        else if (a.bidId) openBidById(a.bidId);
      },
    },
    h('span', { class: 'alert-dot', 'aria-hidden': 'true' }),
    h('div', { class: 'alert-text' },
      h('div', { class: 'alert-meta' }, h('span', { class: 'alert-kind' }, KIND[a.kind] ?? a.kind), h('span', {}, ago(a.createdAt))),
      h('strong', {}, a.title),
      a.body ? h('p', {}, a.body) : null,
    )),
  );
}

const LIVE_TEXT = {
  live: 'Live — new matches appear here the moment a scan finds them.',
  // Poll mode (serverless hosts): not "live"; the app asks the inbox on a timer while it is on screen.
  polling: 'On — checks for new alerts about once a minute while BidSwipe is open.',
  connecting: 'Connecting…',
  retrying: 'Reconnecting… (alerts you miss are caught up when it’s back)',
  off: 'Not connected.',
};

function renderAlerts() {
  if (!state.alerts && !ui.loading && !ui.error) loadInbox();
  const items = state.alerts?.items ?? [];
  let list;
  if (ui.error) list = h('div', { class: 'empty compact' }, h('h3', {}, 'Couldn’t load alerts'), h('p', {}, ui.error), h('button', { class: 'cta ghost', type: 'button', onclick: loadInbox }, 'Try again'));
  else if (!state.alerts) list = h('p', { class: 'pc-loading' }, 'Loading…');
  else if (!items.length) {
    list = h('div', { class: 'empty compact' }, h('div', { class: 'big' }, '🔔'), h('h3', {}, 'No alerts yet'),
      h('p', {}, 'When a scan finds a bid that fits you, it shows up here. Saved bids get deadline reminders too.'));
  } else list = h('ul', { class: 'alert-list' }, items.map(alertRow));

  return h('div', { class: 'screen alerts' },
    h('header', { class: 'screen-head' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', onclick: () => setView(ui.back) }, icon(ICONS.back)),
      h('h1', {}, 'Alerts'),
      state.unread ? h('button', { type: 'button', class: 'text-btn', onclick: () => markRead('all') }, 'Read all') : h('span', { class: 'icon-btn ghost', 'aria-hidden': 'true' }),
    ),
    h('p', { class: `live-line ${state.live}` }, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), LIVE_TEXT[state.live] ?? ''),
    pushPanel(),
    h('h2', { class: 'section-title' }, state.unread ? `${state.unread} unread` : 'Recent'),
    list,
  );
}

/** The bell. */
export function openAlerts() {
  if (state.view !== 'alerts') ui.back = state.view === 'settings' ? 'swipe' : state.view;
  state.alerts = null;
  ui.push = 'checking';
  setView('alerts');
  refreshPush();
}

registerView('alerts', { chrome: 'screen', render: renderAlerts });
