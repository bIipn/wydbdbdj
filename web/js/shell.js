// The app shell: a registry of views and the one render() that draws the current one.
//
//   registerView('saved', { chrome: 'tabs', render: () => h('div', …) });
//   setView('saved');
//
// chrome 'tabs'   = top bar + Swipe/Browse/Saved tabs + footnote around the view (the feed screens).
// chrome 'screen' = the view owns the whole page (sign-in, onboarding, settings, access gate).

import { $, $$, h } from './dom.js';
import { fmtDay, fmtTime, isOpen } from './format.js';
import { DECK_MIN_SCORE, deck, isLive, savedList, state } from './state.js';

const views = new Map();
const afterRender = [];

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
  const view = views.get(state.view) ?? views.get('swipe');
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
    $('#countSwipe').textContent = deck().length || '';
    $('#countBrowse').textContent = (state.browseIds ? state.browseIds.length : state.items.filter((i) => isOpen(i) && i.score >= DECK_MIN_SCORE).length) || '';
    // Market needs the API: the bundled demo has no market data.
    const live = isLive();
    $('#marketTab').hidden = !live;
    $('.tabs').dataset.tabs = live ? '4' : '3';
    $('#countSaved').textContent = savedList().length || '';
    const scan = state.lastScan ? `Last scan ${fmtDay.format(new Date(state.lastScan))} · ${fmtTime.format(new Date(state.lastScan))}. ` : '';
    $('#footnote').textContent =
      state.mode === 'demo'
        ? `Demo — ${state.note} Swipes stay on this device.`
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
