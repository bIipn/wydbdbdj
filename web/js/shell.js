// The app shell: a registry of views and the one render() that draws the current one.
//
//   registerView('saved', { chrome: 'tabs', render: () => h('div', …) });
//   setView('saved');
//
// chrome 'tabs'   = the header (title, bell, profile) + the bottom tab bar (Home · Search · Market · Saved · Jobs)
//                  + the footnote around the view. An account here only to get work done sees Jobs alone
//                  (hireOnly() below): no tab bar then, the header says "Jobs".
// chrome 'screen' = the view owns the whole page (sign-in, onboarding, settings, access gate).
// tape: true      = the market tape (web/js/tape.js, #tape above the header) shows on this view (Home).
//
// An old view name (VIEW_ALIASES in home-model.js: 'swipe') still works: registerAlias() says what it opens.

import { $, $$, h } from './dom.js';
import { fmtDay, fmtTime, isOpen, num } from './format.js';
import { BID_VIEWS, homeSubtitle, monogram, screenTitle, visibleTabs } from './home-model.js';
import { deck, intent, isLive, savedList, state } from './state.js';
import { paintTape } from './tape.js';

const views = new Map();
const aliases = new Map();
const afterRender = [];
/** Extra tabs that count something of their own (Jobs): view name → () => { show, count, label }. */
const tabCounts = new Map();

/** A tab whose button and count belong to another module (index.html has the button, hidden by default). */
export function registerTabCount(view, fn) { tabCounts.set(view, fn); }

/** An old view name: `open()` runs when something asks for it (e.g. sets Home's mode) and returns the real view. */
export function registerAlias(name, open) { aliases.set(name, open); }

/**
 * The bid tabs. An account that picked "Get work done" (intent 'hire', accounts mode) has no trades, so these
 * stay empty for it forever: the shell hides them, and a link, a shortcut or a Back button that names one
 * lands on Jobs instead. 'work', 'both', the pilot (single mode) and the demo keep every tab.
 */
export const hireOnly = () => isLive() && state.auth === 'accounts' && intent() === 'hire';
const hiddenFor = (name) => BID_VIEWS.has(name) && hireOnly() && views.has('jobs');

export function registerView(name, view) {
  if (views.has(name)) throw new Error(`view "${name}" registered twice`);
  views.set(name, { chrome: 'tabs', ...view });
}

/** Runs after every render (e.g. a view that needs focus once it is in the page). */
export function onAfterRender(fn) { afterRender.push(fn); }

let deferred = null;
export function render() {
  // Never redraw under a finger: a live update while a card is being dragged waits until it is let go.
  // A finger on a list card (data-touching, views/home.js) waits the same way: a redraw would swallow the tap.
  if (document.querySelector('.card.is-top[data-dragging], [data-touching]')) {
    deferred ??= setTimeout(() => { deferred = null; render(); }, 250);
    return;
  }
  const alias = aliases.get(state.view);
  if (alias) state.view = alias();
  if (hiddenFor(state.view)) state.view = 'jobs';
  if (!views.has(state.view)) state.view = hireOnly() && views.has('jobs') ? 'jobs' : 'home';
  const view = views.get(state.view);
  const app = $('#app');
  app.dataset.chrome = view.chrome;
  app.dataset.view = state.view;

  if (view.chrome === 'tabs') {
    const home = state.view === 'home';
    $('#screenTitle').textContent = screenTitle(state.view);
    const sub = home ? homeSubtitle(state.profile) : '';
    $('#screenSub').textContent = sub;
    $('#screenSub').hidden = !sub;
    // The round profile button: Settings where Settings exists (accounts mode, live); elsewhere it only shows whose
    // feed this is (the pilot's config profile, the demo), as the old chip did.
    const chip = $('#profileChip');
    const canEdit = state.mode === 'live' && state.auth === 'accounts';
    const who = state.profile?.name ?? '';
    chip.classList.toggle('is-link', canEdit);
    chip.disabled = !canEdit;
    chip.dataset.initials = monogram(who);
    chip.setAttribute('aria-label', canEdit ? `Profile and settings${who ? `: ${who}` : ''}` : `Profile${who ? `: ${who}` : ''}`);
    chip.title = who;
    $$('.tab').forEach((t) => {
      const on = t.dataset.view === state.view;
      t.classList.toggle('is-active', on);
      if (on) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
    paintTabCounts();
    // Which tabs show (home-model.js visibleTabs): Market needs the API (the bundled demo has no market data), Jobs
    // needs accounts mode (jobs-data.js says), and an account here only to hire sees Jobs alone.
    const counts = new Map([...tabCounts].map(([name, fn]) => [name, fn()]));
    const shownTabs = new Set(visibleTabs({ live: isLive(), hireOnly: hireOnly() && views.has('jobs'), jobsOn: !!counts.get('jobs')?.show }));
    $$('.tab').forEach((t) => { t.hidden = !shownTabs.has(t.dataset.view); });
    for (const [name, c] of counts) {
      const t = $(`.tab[data-view="${name}"]`);
      $('.count', t).textContent = c.count ? tabNumber(c.count) : '';
      tabLabel(`.tab[data-view="${name}"]`, c.label);
    }
    // One tab left (Jobs, for 'hire') is no choice at all: no bar, and the header already says "Jobs".
    const shown = $$('.tab').filter((t) => !t.hidden).length;
    $('#tabbar').hidden = shown < 2;
    app.dataset.tabs = String(shown < 2 ? 0 : shown);
    const saved = savedList().length;
    $('#countSaved').textContent = tabNumber(saved);
    tabLabel('.tab[data-view="saved"]', saved ? `Saved: ${num(saved)} bid${saved === 1 ? '' : 's'}` : 'Saved');
    const scan = state.lastScan ? `Last scan ${fmtDay.format(new Date(state.lastScan))} · ${fmtTime.format(new Date(state.lastScan))}. ` : '';
    $('#footnote').textContent =
      state.mode === 'demo'
        ? `Demo — ${state.note} Swipes stay on this device.`
        // The Jobs tab is about local jobs, not scored public bids: its own honest line.
        : state.view === 'jobs'
          ? 'Local jobs: bids are sealed until closing. Licences are as typed, not checked by BidSwipe.'
          : `${scan}Scores are a first pass — always read the bid documents before you price a job.`;
  }

  // The bell (unread count + live dot) is kept current on every screen, shown or not.
  const bell = $('#bell');
  bell.hidden = !isLive();
  $('#bellCount').textContent = state.unread > 99 ? '99+' : state.unread ? String(state.unread) : '';
  bell.setAttribute('aria-label', state.unread ? `Alerts, ${state.unread} unread` : 'Alerts');
  bell.dataset.live = state.live;

  // The tape lives outside #view, so its scroll keeps running across redraws; it only shows where a view asks.
  try { paintTape(view.chrome === 'tabs' && view.tape === true); } catch { /* the tape is a nicety: never break a screen */ }
  $('#view').replaceChildren(view.render());
  for (const fn of afterRender) fn(state.view);
}

const tabLabel = (sel, text) => { const t = $(sel); t.setAttribute('aria-label', text); t.title = text; };

/** A tab number that stays narrow: 787, 1.2k, 12k (the exact number is in the tab's label). */
export function tabNumber(n) {
  if (!n) return '';
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
}

/**
 * The numbers the old Swipe and Browse tabs carried, without redrawing the view (a Search load in the background,
 * new counts after a swipe). They count different things, so each place says what its number is: Home's
 * "Matches your preferences" (#matchCount) = bids left in the deck (never over the spend limits); the Search tab's
 * label = open bids that match the filters (swiped and over-limit ones included; the result line on Search shows it).
 */
export function paintTabCounts() {
  const toSwipe = deck().length;
  const matchCount = $('#matchCount');
  if (matchCount) {
    matchCount.textContent = tabNumber(toSwipe);
    matchCount.setAttribute('aria-label', `${num(toSwipe)} bid${toSwipe === 1 ? '' : 's'} left to look at`);
  }
  // Search: the server's total for the current filters. A server that sends none: the rows it sent ("more than"
  // when it filled its largest page). Not loaded yet: the open bids in hand, unless that list is the feed's cut-off 300.
  let browseN = null;
  let more = false;
  if (state.browseTotal != null) browseN = state.browseTotal;
  else if (state.browseIds) { browseN = state.browseIds.length; more = state.browseCut; }
  else if ((state.feedLen ?? state.items.length) < 300) browseN = state.items.filter(isOpen).length;
  if ($('.tab[data-view="browse"]')) {
    tabLabel('.tab[data-view="browse"]', browseN == null ? 'Search'
      : `Search: ${more ? 'more than ' : ''}${num(browseN)} open bid${browseN === 1 ? '' : 's'} match your filters`);
  }
}

export function setView(name) {
  state.view = name;
  render();
  window.scrollTo({ top: 0 });
}

/** A full-page message (server down, server error). */
const message = { title: '', text: '' };
export function showMessage(title, text) {
  Object.assign(message, { title, text });
  setView('message');
}
registerView('message', {
  chrome: 'screen',
  render: () => h('div', { class: 'empty' }, h('h3', {}, message.title), h('p', {}, message.text)),
});
