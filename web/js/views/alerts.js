// The alert inbox (the bell): new matches, deadline reminders, award and price notices, newest first.
// Also the "Turn on phone alerts" control.

import { api } from '../api.js';
import { h, icon, ICONS, showToast } from '../dom.js';
import { fmtDay, clock } from '../format.js';
import { jobsOn, openJob } from '../jobs-data.js';
import { devicePush, sendTestPush, standalone, testResultLine, turnOffPush, turnOnPush } from '../push.js';
import { homeView, onSignedOut } from '../session.js';
import { openSheet } from '../sheet.js';
import { registerView, render, setView } from '../shell.js';
import { features, intent, mergeItems, state } from '../state.js';

const ui = { back: 'home', loading: false, error: null, push: 'checking', pushNote: '', testing: false, testLine: '' };
onSignedOut(() => { Object.assign(ui, { push: 'checking', testing: false, testLine: '' }); });

const KIND = {
  match: 'New match', deadline: 'Deadline', award: 'Award', price: 'Price move',
  // local jobs (src/realtime/alerts.ts decideJob): the title says what happened, the tag says it is a local job
  job_awarded: 'Local job', job_message: 'Message or tap', job_deadline: 'Contact reminder', job_closed: 'Local job',
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
  const { state: s, key } = await devicePush(!!features()?.instantPush);
  ui.pushKey = key;
  return s;
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
  ui.testLine = '';
  render();
  try { await turnOffPush(); ui.push = 'off'; } catch { ui.push = 'error'; }
  render();
}

/** "Send a test alert": the server pushes one to this account's devices, the same way as a real alert. */
async function tapTest() {
  if (ui.testing) return;
  ui.testing = true;
  ui.testLine = '';
  render();
  ui.testLine = testResultLine(await sendTestPush());
  ui.testing = false;
  if (state.view === 'alerts') render();
}

/**
 * Whose inbox this is, for the copy: 'bids' = the pilot (single mode), bids only, as it always read; 'jobs' = an
 * account here only to get work done ('hire': no trades, so only alerts about the jobs it posts); 'both' = any
 * other account (it gets bid matches, and any account may post a job or bid on one).
 */
const audience = () => (state.auth !== 'accounts' ? 'bids' : intent() === 'hire' ? 'jobs' : 'both');

/** The lines that change with the audience. Jobs settle when a request finds them due, so no "the moment" there. */
const COPY = {
  bids: {
    empty: 'When a scan finds a bid that fits you, it shows up here. Saved bids get deadline reminders too.',
    live: 'Live — new matches appear here the moment a scan finds them.',
    off: 'Get a notification the moment a bid that fits you is posted. Your phone asks for permission first.',
    on: 'This device gets a notification the moment a new bid fits you. Quiet hours in Settings hold them until morning.',
    locked: 'Instant phone alerts are a Pro feature. On Free you get this inbox and the daily email.',
    not_configured: 'Phone alerts aren’t set up on this server yet, so it can’t send them. New matches still show here and pop up while the app is open.',
  },
  jobs: {
    empty: 'When bidding closes on a job you posted, the lowest bid and the contact deadline show up here. So do messages from the winner and how the job ended.',
    live: 'Live — news on your jobs appears here as soon as BidSwipe records it.',
    off: 'Get a notification when bidding closes on your job or the winner sends a message. Your phone asks for permission first.',
    on: 'This device gets a notification when bidding closes on your job or a message comes in. Quiet hours in Settings hold them until morning.',
    locked: 'Instant phone alerts are a Pro feature. On Free, news on your jobs shows up in this inbox.',
    not_configured: 'Phone alerts aren’t set up on this server yet, so it can’t send them. News on your jobs still shows here and pops up while the app is open.',
  },
  both: {
    empty: 'When a scan finds a bid that fits you, it shows up here, and saved bids get deadline reminders. Jobs you post or bid on show up too: the result when bidding closes, the contact deadline and messages.',
    live: 'Live — new matches appear the moment a scan finds them, news on your jobs as soon as BidSwipe records it.',
    off: 'Get a notification when a scan finds a bid that fits you, or when there’s news on a job you posted or bid on. Your phone asks for permission first.',
    on: 'This device gets a notification for new bids that fit you and for news on your jobs. Quiet hours in Settings hold them until morning.',
    locked: 'Instant phone alerts are a Pro feature. On Free you get this inbox and the daily email.',
    not_configured: 'Phone alerts aren’t set up on this server yet, so it can’t send them. New matches and news on your jobs still show here and pop up while the app is open.',
  },
};

const PUSH_TEXT = {
  checking: 'Checking this device…',
  busy: 'One moment…',
  unsupported: 'This browser can’t show phone alerts. They work in Chrome, Edge, Firefox and Safari; on an iPhone or iPad, add BidSwipe to your Home Screen first and open it from there.',
  // Opened from the Home Screen icon, but this iOS has no web push (before 16.4): adding it again changes nothing.
  old_ios: 'Phone alerts on an iPhone or iPad need iOS 16.4 or later, and this one is older. Update it in the Settings app → General → Software Update, then open BidSwipe from its icon again.',
  insecure: 'Phone alerts need a secure (https) address.',
  denied: 'Notifications are blocked for this site. Allow them in your browser’s site settings, then come back.',
  error: 'That didn’t work. Try again in a minute.',
};

/** Installed on an iPhone or iPad (navigator.standalone === true): the switch is in iOS Settings, per app. */
const IOS_DENIED = 'Notifications are off for BidSwipe. Open the Settings app → Notifications → BidSwipe, turn on Allow Notifications, then come back here.';
/** WebKit: Home Screen web apps "integrate with Focus". */
const IOS_FOCUS = 'A Focus on your iPhone can hold these: allow BidSwipe in Settings → Focus if you need them right away.';

/**
 * A Safari tab on an iPhone or iPad (navigator.standalone === false): the exact steps to the Home Screen app.
 * Current iOS puts Share under the ••• menu and asks whether the icon opens "as Web App": without that, the icon
 * opens Safari again and web push can never work there (Apple Support, "Turn a website into an app in Safari").
 * The Home Screen app does not share Safari's sign-in (WebKit bug 181849).
 */
export const IOS_STEPS = [
  'In Safari, tap Share (on newer iPhones it is in the ••• menu first).',
  'Scroll down and tap Add to Home Screen. Not in the list? Tap Edit Actions and add it.',
  'Keep Open as Web App on, then tap Add.',
  'Open BidSwipe from the new icon, sign in again, then tap the bell and Turn on phone alerts.',
];
/** Step 4 where there is no sign-in (single mode, the pilot): at most the access code is asked again (review rs-5). */
const IOS_LAST_STEP_SINGLE = 'Open BidSwipe from the new icon (enter the access code again if it asks), then tap the bell and Turn on phone alerts.';

function iosSteps() {
  return [
    h('p', { class: 'plan-text' }, 'iPhone and iPad show phone alerts only from BidSwipe on the Home Screen:'),
    h('ol', { class: 'push-steps' }, IOS_STEPS.map((step, i) =>
      h('li', {}, i === IOS_STEPS.length - 1 && state.auth === 'single' ? IOS_LAST_STEP_SINGLE : step))),
    h('p', { class: 'pc-fine' }, 'Needs iOS 16.4 or later.'),
  ];
}

function pushText(s) {
  if (s === 'denied' && standalone() === true) return IOS_DENIED;
  return COPY[audience()][s] ?? PUSH_TEXT[s] ?? '';
}

function pushPanel() {
  const s = ui.push;
  const button = s === 'off' ? h('button', { class: 'cta', type: 'button', onclick: tapTurnOn }, 'Turn on phone alerts')
    : s === 'on' ? h('button', { class: 'cta ghost', type: 'button', onclick: tapTurnOff }, 'Turn off on this device')
      : s === 'error' ? h('button', { class: 'cta ghost', type: 'button', onclick: refreshPush }, 'Try again')
        : null;
  const status = s === 'on' ? 'On' : s === 'locked' ? 'Pro' : s === 'off' ? 'Off' : s === 'not_configured' ? 'Not set up' : null;
  const ios = s === 'unsupported' && standalone() === false;
  return h('section', { class: `panel push-panel push-${s}` },
    h('div', { class: 'push-head' },
      h('h2', { class: 'panel-title' }, 'Phone alerts'),
      status ? h('span', { class: `push-status ${s}` }, s === 'locked' ? icon(ICONS.lock) : null, status) : null,
    ),
    ios ? iosSteps() : h('p', { class: 'plan-text' }, pushText(s)),
    s === 'on' && standalone() === true ? h('p', { class: 'pc-fine' }, IOS_FOCUS) : null,
    s === 'error' && ui.pushNote ? h('p', { class: 'pc-fine' }, ui.pushNote) : null,
    s === 'on'
      ? h('div', { class: 'push-actions' },
        h('button', { class: 'cta ghost push-test', type: 'button', disabled: ui.testing, onclick: tapTest }, ui.testing ? 'Sending…' : 'Send a test alert'),
        button)
      : button,
    s === 'on' && ui.testLine ? h('p', { class: 'push-test-line', role: 'status' }, ui.testLine) : null,
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
      h('p', {}, COPY[audience()].empty));
  } else list = h('ul', { class: 'alert-list' }, items.map(alertRow));

  return h('div', { class: 'screen alerts' },
    h('header', { class: 'screen-head' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', onclick: () => setView(ui.back) }, icon(ICONS.back)),
      h('h1', {}, 'Alerts'),
      state.unread ? h('button', { type: 'button', class: 'text-btn', onclick: () => markRead('all') }, 'Read all') : h('span', { class: 'icon-btn ghost', 'aria-hidden': 'true' }),
    ),
    h('p', { class: `live-line ${state.live}` }, h('span', { class: 'live-dot', 'aria-hidden': 'true' }),
      (state.live === 'live' ? COPY[audience()].live : LIVE_TEXT[state.live]) ?? ''),
    pushPanel(),
    h('h2', { class: 'section-title' }, state.unread ? `${state.unread} unread` : 'Recent'),
    list,
  );
}

/**
 * The bell. back: 'settings' = Settings' "Phone alerts on this device" row (Back returns there, its edits kept:
 * setView, not openSettings); anything else returns to the screen it came from.
 */
export function openAlerts(opts = {}) {
  if (state.view !== 'alerts') ui.back = opts.back === 'settings' && state.view === 'settings' ? 'settings' : state.view === 'settings' ? homeView() : state.view;
  state.alerts = null;
  ui.push = 'checking';
  ui.testLine = '';
  setView('alerts');
  refreshPush();
}

registerView('alerts', { chrome: 'screen', render: renderAlerts });
