// The app shell: a registry of views and the one render() that draws the current one.
//
//   registerView('saved', { chrome: 'tabs', render: () => h('div', …) });
//   setView('saved');
//
// chrome 'tabs'   = top bar + Swipe/Browse/Saved/Market/Jobs tabs + footnote around the view (the feed screens).
//                  An account here only to get work done sees the Jobs tab alone (hireOnly() below).
// chrome 'screen' = the view owns the whole page (sign-in, onboarding, settings, access gate).

import { $, $$, h } from './dom.js';
import { fmtDay, fmtTime, isOpen } from './format.js';
import { deck, intent, isLive, savedList, state } from './state.js';

const views = new Map();
const afterRender = [];
/** Extra tabs that count something of their own (Jobs): view name → () => { show, count, label }. */
const tabCounts = new Map();

/** A tab whose button and count belong to another module (index.html has the button, hidden by default). */
export function registerTabCount(view, fn) { tabCounts.set(view, fn); }

/**
 * The bid tabs. An account that picked "Get work done" (intent 'hire', accounts mode) has no trades, so these
 * stay empty for it forever: the shell hides them, and a link, a shortcut or a Back button that names one
 * lands on Jobs instead. 'work', 'both', the pilot (single mode) and the demo keep every tab.
 */
const BID_TABS = new Set(['swipe', 'browse', 'saved', 'market']);
export const hireOnly = () => isLive() && state.auth === 'accounts' && intent() === 'hire';
const hiddenFor = (name) => BID_TABS.has(name) && hireOnly() && views.has('jobs');

export function registerView(name, view) {
  if (views.has(name)) throw new Error(`view "${name}" registered twice`);
  views.set(name, { chrome: 'tabs', ...view });
}

/** Runs after every render (e.g. a view that needs focus once it is in the page). */
export function onAfterRender(fn) { afterRender.push(fn); }

let deferred = null;
export function render() {
  // Never redraw under a finger: a live update while a card is being dragged waits until it is let go.
  if (document.querySelector('.card.is-top[data-dragging]')) {
    deferred ??= setTimeout(() => { deferred = null; render(); }, 250);
    return;
  }
  if (hiddenFor(state.view)) state.view = 'jobs';
  const view = views.get(state.view) ?? views.get(hireOnly() ? 'jobs' : 'swipe');
  const app = $('#app');
  app.dataset.chrome = view.chrome;
  app.dataset.view = state.view;

  if (view.chrome === 'tabs') {
    $('#profileName').textContent = state.profile?.name ?? 'BidSwipe';
    $('#profileBase').textContent = state.profile?.base ?? '';
    const chip = $('#profileChip');
    const canEdit = state.mode === 'live' && state.auth === 'accounts';
    chip.classList.toggle('is-link', canEdit);
    chip.disabled = !canEdit;
    chip.setAttribute('aria-label', canEdit ? 'Profile and settings' : 'Profile');
    $$('.tab').forEach((t) => {
      const on = t.dataset.view === state.view;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    paintTabCounts();
    // Market needs the API: the bundled demo has no market data. The bid tabs are hidden for 'hire' (BID_TABS).
    const live = isLive();
    for (const name of BID_TABS) $(`.tab[data-view="${name}"]`).hidden = hiddenFor(name) || (name === 'market' && !live);
    for (const [name, fn] of tabCounts) {
      const t = $(`.tab[data-view="${name}"]`);
      const c = fn();
      t.hidden = !c.show;
      $('.count', t).textContent = c.count || '';
      tabLabel(`.tab[data-view="${name}"]`, c.label);
    }
    // How many tabs show: five on a 360 px phone need tighter tabs (styles.css .tabs[data-tabs='5']); one (Jobs,
    // for 'hire') is drawn as the screen's title bar (.tabs[data-tabs='1']).
    $('.tabs').dataset.tabs = String($$('.tab').filter((t) => !t.hidden).length);
    $('#countSaved').textContent = savedList().length || '';
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
 * The Swipe and Browse tab numbers, without redrawing the view (a Browse load in the background, new counts after
 * a swipe). They count different things, so each tab says what its number is: Swipe = bids left to swipe (never
 * over the spend limits), Browse = open bids that match the filters (swiped and over-limit ones included).
 */
export function paintTabCounts() {
  if (!$('#countSwipe')) return;
  const toSwipe = deck().length;
  // Browse: the server's total for the current filters. A server that sends none: the rows it sent ("300+" when it
  // filled its largest page). Not loaded yet: the open bids in hand, unless that list is the feed's cut-off 300.
  let browseN = null;
  let more = false;
  if (state.browseTotal != null) browseN = state.browseTotal;
  else if (state.browseIds) { browseN = state.browseIds.length; more = state.browseCut; }
  else if ((state.feedLen ?? state.items.length) < 300) browseN = state.items.filter(isOpen).length;
  $('#countSwipe').textContent = tabNumber(toSwipe);
  $('#countBrowse').textContent = browseN ? `${tabNumber(browseN)}${more ? '+' : ''}` : '';
  tabLabel('.tab[data-view="swipe"]', `Swipe: ${toSwipe.toLocaleString('en-US')} bid${toSwipe === 1 ? '' : 's'} left to swipe`);
  tabLabel('.tab[data-view="browse"]', browseN == null ? 'Browse'
    : `Browse: ${more ? 'more than ' : ''}${browseN.toLocaleString('en-US')} open bid${browseN === 1 ? '' : 's'} match your filters, swiped and over-limit ones included`);
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
