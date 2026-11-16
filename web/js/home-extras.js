// Home's two cards above the matches: "Finish setting up N" and "Your preferences". The home view calls
// both on every render; null = draw nothing. What a task is and which chips show is decided by the pure modules
// home-tasks.js and home-prefs.js; this file gathers what the app knows (some of it loaded once, in the
// background: the phone-alert state of this device, the work profile, the trade names) and draws the cards.
//
// Also answers the market tape's tap ('bidswipe:open-market' → Market): tape.js sits below shell.js and cannot
// import it (see there).

import { api } from './api.js';
import { h, icon, store } from './dom.js';
import { homeTasks } from './home-tasks.js';
import { prefsChips } from './home-prefs.js';
import { jobsOn } from './jobs-data.js';
import { loadTrades } from './profile-form.js';
import { devicePush, standalone } from './push.js';
import { onFeedLoaded, onSignedOut } from './session.js';
import { render, setView } from './shell.js';
import { features, intent, isLive, state } from './state.js';
import { openAlerts } from './views/alerts.js';
import { openSettings, openSettingsAt } from './views/settings.js';

window.addEventListener('bidswipe:open-market', () => { if (isLive()) setView('market'); });

const COLLAPSE_KEY = 'bidswipe:tasks-collapsed';

/** What is loaded in the background, per account. null = not asked yet; a failure leaves it null (no task from it). */
const bg = { account: null, push: null, pushAsked: false, work: null, workAsked: false, trades: null, tradesAsked: false };
/** The task shown (by id, so a task done elsewhere does not shift the card to another one by surprise). */
const ui = { taskId: null };

const reset = () => Object.assign(bg, { account: null, push: null, pushAsked: false, work: null, workAsked: false });
onSignedOut(() => { reset(); ui.taskId = null; });
// A settings save reloads the feed: the work profile may have changed, and the device's push state with the plan.
onFeedLoaded(() => Object.assign(bg, { work: null, workAsked: false, push: null, pushAsked: false }));

const redraw = () => { if (state.view === 'home') render(); };
const accountId = () => state.me?.account?.id ?? null;

/** Ask, once per account, for what the cards need that /api/me does not carry. */
function gather() {
  const id = accountId();
  if (!id || !isLive() || state.auth !== 'accounts') return;
  if (bg.account !== id) { reset(); bg.account = id; }
  if (!bg.pushAsked) {
    bg.pushAsked = true;
    // The same answer the alert inbox's push panel reaches (push.js devicePush), without asking for anything.
    devicePush(!!features()?.instantPush).then(({ state: s }) => { if (bg.account === id) { bg.push = s; redraw(); } }).catch(() => {});
  }
  if (!bg.workAsked && jobsOn() && intent() !== 'hire') {
    bg.workAsked = true;
    api.workProfile().then(({ workProfile }) => { if (bg.account === id) { bg.work = workProfile ?? null; redraw(); } }).catch(() => {});
  }
  if (!bg.tradesAsked && (state.me?.profile?.trades ?? []).length) {
    bg.tradesAsked = true;
    loadTrades().then((list) => { bg.trades = new Map(list.map((t) => [t.id, t.label])); redraw(); }).catch(() => { bg.tradesAsked = false; });
  }
}

function go(target) {
  if (target.to === 'alerts') return openAlerts();
  if (target.to === 'settings') return target.field ? openSettingsAt(target.field) : openSettings();
  return undefined;
}

const CHEVRON = (up) => h('span', { class: `hx-chevron${up ? ' is-up' : ''}`, 'aria-hidden': 'true' });
const ARROW_PREV = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>';
const ARROW_NEXT = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

function arrowButton(svg, label, onclick, disabled) {
  return h('button', { type: 'button', class: 'hx-arrow', 'aria-label': label, disabled, onclick }, icon(svg));
}

/** The "Finish setting up N" card, or null when there is nothing true and doable to ask for. */
export function tasksCard() {
  gather();
  const tasks = homeTasks({
    live: isLive(),
    auth: state.auth,
    intent: intent(),
    profile: state.me?.profile ?? null,
    features: features(),
    push: bg.push,
    standalone: standalone(),
    jobsOn: jobsOn(),
    workProfile: bg.work,
  });
  if (!tasks.length) return null;

  let index = Math.max(0, tasks.findIndex((t) => t.id === ui.taskId));
  ui.taskId = tasks[index].id;
  const collapsed = store.get(COLLAPSE_KEY) === '1';
  const n = tasks.length;

  const show = (i) => {
    ui.taskId = tasks[(i + n) % n].id;
    render();
    // Keep the keyboard where it was: the same arrow after the redraw.
    requestAnimationFrame(() => document.querySelector(`.hx-tasks .hx-arrow[aria-label="${i < index ? 'Previous task' : 'Next task'}"]`)?.focus());
  };

  const head = h('button', {
    type: 'button', class: 'hx-tasks-head', 'aria-expanded': String(!collapsed), 'aria-controls': 'hxTaskBody',
    onclick: () => { store.set(COLLAPSE_KEY, collapsed ? '0' : '1'); render(); requestAnimationFrame(() => document.querySelector('.hx-tasks-head')?.focus()); },
  },
  // Our own words, not the layout reference's: what is left of setting this account up.
  h('span', { class: 'hx-tasks-title' }, 'Finish setting up ', h('span', { class: 'hx-count' }, String(n)),
    h('span', { class: 'sr-only' }, ` thing${n === 1 ? '' : 's'} left`)),
  CHEVRON(!collapsed));

  if (collapsed) return h('section', { class: 'hx-tasks is-collapsed', 'aria-label': 'Tasks' }, head);

  const t = tasks[index];
  const body = h('div', { class: 'hx-task-wrap', id: 'hxTaskBody' },
    h('article', { class: 'hx-task', 'aria-roledescription': 'task', 'aria-label': `Task ${index + 1} of ${n}` },
      h('h3', { class: 'hx-task-title' }, t.title),
      h('p', { class: 'hx-task-text' }, t.text),
      h('div', { class: 'hx-task-actions' },
        t.actions.map((a, i) => h('button', { type: 'button', class: `hx-btn${i ? ' ghost' : ''}`, onclick: () => go(a.go) }, a.label))),
    ),
    n > 1 ? h('div', { class: 'hx-pager' },
      h('span', { class: 'hx-pos', 'aria-live': 'polite' }, `${index + 1}/${n}`),
      h('span', { class: 'hx-arrows' },
        arrowButton(ARROW_PREV, 'Previous task', () => show(index - 1)),
        arrowButton(ARROW_NEXT, 'Next task', () => show(index + 1))),
    ) : null,
  );
  return h('section', { class: 'hx-tasks', 'aria-label': 'Tasks' }, head, body);
}

/** The "Your preferences" card, or null when there is no profile to show. */
export function prefsCard() {
  gather();
  const editable = isLive() && state.auth === 'accounts' && !!state.me?.profile;
  const chips = prefsChips({
    intent: intent(),
    base: state.profile?.base ?? '',
    profile: state.me?.profile ?? null,
    // The pilot (single mode) answers maxDistanceMi + valueRange on /api/me; the demo carries them in its profile.
    legacy: state.me?.profile ? null : (state.me?.maxDistanceMi != null ? state.me : state.profile?.maxDistanceMi != null ? state.profile : null),
    tradeLabels: bg.trades,
  });
  if (chips == null) return null;

  const title = h('h2', { class: 'hx-prefs-title', id: 'hxPrefsTitle' }, 'Your preferences');
  if (!chips.length) {
    return h('section', { class: 'hx-prefs', 'aria-labelledby': 'hxPrefsTitle' }, title,
      editable
        ? h('button', { type: 'button', class: 'hx-add', onclick: () => openSettings() }, h('span', { class: 'hx-plus', 'aria-hidden': 'true' }, '+'), 'Add your preferences')
        : h('p', { class: 'hx-add is-plain' }, 'No preferences set'));
  }
  return h('section', { class: 'hx-prefs', 'aria-labelledby': 'hxPrefsTitle' }, title,
    h('ul', { class: 'hx-chips' }, chips.map((c) => h('li', {},
      editable
        ? h('button', { type: 'button', class: `hx-chip is-${c.id.split(':')[0]}`, 'aria-label': `${c.text}. Change in Settings`, onclick: () => openSettingsAt(c.field) }, c.text)
        : h('span', { class: `hx-chip is-plain is-${c.id.split(':')[0]}` }, c.text)))),
  );
}
