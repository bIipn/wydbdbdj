// Home: the landing screen. Top to bottom: the market tape (#tape, outside the view: web/js/tape.js), the header
// (shell.js), the tasks card and the preferences card (web/js/home-extras.js), then "Matches your preferences"
// with a two-way switch, remembered on this device:
//   Scroll  a list of match cards (title, fit ring, agency, place, chips; save and pass at the right edge)
//   Swipe   the card stack with its three round buttons (views/feed.js swipeView)
// Both show the same bids in the same order: the deck (state.js deck(): fits first, then sub work). Save and pass
// on a list card go through the same code as a swipe (actions.js commit), with the same Undo.

import { commit } from '../actions.js';
import { $, h, icon, ICONS, store } from '../dom.js';
import { num } from '../format.js';
import { prefsCard, tasksCard } from '../home-extras.js';
import { agencyLine, HOME_PAGE, homeModeOf, matchChips, placeLine } from '../home-model.js';
import { onFeedLoaded } from '../session.js';
import { openSheet } from '../sheet.js';
import { onAfterRender, registerAlias, registerView, render, tabNumber } from '../shell.js';
import { deck, state } from '../state.js';
import { deckDone, nextUp, swipeView } from './feed.js';

const MODE_KEY = 'bidswipe:homeMode';
const ui = { mode: homeModeOf(store.get(MODE_KEY)), shown: HOME_PAGE, focusId: null, restore: null, toMatches: false };

/** 'scroll' | 'swipe'. main.js asks, so the arrow keys swipe only in Swipe mode. */
export const homeMode = () => ui.mode;

export function setHomeMode(mode) {
  ui.mode = homeModeOf(mode);
  store.set(MODE_KEY, ui.mode);
}

// The old 'swipe' view: a link, a Back button or a module that still names it opens Home in Swipe mode.
registerAlias('swipe', () => { setHomeMode('swipe'); return 'home'; });

// A new feed (sign-in, a settings save, a scan) starts the list at its first page again.
onFeedLoaded(() => { ui.shown = HOME_PAGE; });

// Our own icons (static markup, never data).
const BOOKMARK = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M7 3.5h10a1 1 0 0 1 1 1V20.5l-6-4-6 4V4.5a1 1 0 0 1 1-1z"/></svg>';
const THUMB_DOWN = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 14V4"/><path d="M16.5 14l-3.8 6.3a1.7 1.7 0 0 1-3.1-1.2l.8-4.1H5.3a1.8 1.8 0 0 1-1.8-2.1l1.2-6.6A2 2 0 0 1 6.7 4h9.8"/><path d="M16.5 4h2.8a1.2 1.2 0 0 1 1.2 1.2v7.6a1.2 1.2 0 0 1-1.2 1.2h-2.8"/></svg>';

/** The fit score as a small ring: the card's round badge (never a logo we don't have). Numbers only in the markup. */
function miniRing(score) {
  const s = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  const C = 2 * Math.PI * 17;
  const svg = icon(`<svg viewBox="0 0 40 40" aria-hidden="true"><circle class="track" cx="20" cy="20" r="17" fill="none" stroke-width="3.5"/>`
    + `<circle class="fill" cx="20" cy="20" r="17" fill="none" stroke-width="3.5" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${(C * (1 - s / 100)).toFixed(2)}"/></svg>`);
  return h('div', { class: 'mring', title: `Fit score ${s} of 100` }, svg, h('b', {}, String(s)));
}

/** A finger on a card: a live redraw waits until it is lifted (shell.js render), so a tap is never swallowed. */
function holdWhileTouched(el) {
  let timer = null;
  const off = () => { delete el.dataset.touching; clearTimeout(timer); };
  el.addEventListener('pointerdown', () => {
    el.dataset.touching = '1';
    clearTimeout(timer);
    timer = setTimeout(off, 4000); // a lost pointerup never freezes the screen
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(t, off);
}

/** Save or pass from a list card: the card flies off as a swiped card does, then the list closes up. */
function act(item, action, el, list) {
  if (el.dataset.gone) return;
  el.dataset.gone = '1';
  const i = list.indexOf(item);
  ui.focusId = (list[i + 1] ?? list[i - 1])?.id ?? null;
  if (action === 'save') $('.mc-save', el)?.setAttribute('aria-pressed', 'true');
  delete el.dataset.touching;
  commit(item, action, el, 0);
}

/** One match card, in the reference's anatomy, with our own fields. */
function matchCard(item, list) {
  const place = placeLine(item);
  const saved = item.swipe === 'save' || item.swipe === 'bid';
  const el = h('article', { class: `mcard verdict-${item.verdict}`, 'data-id': item.id },
    h('div', { class: 'mc-main' },
      h('h3', { class: 'mc-title' },
        // The title is the card's one link: its hit area covers the whole card (styles.css .mc-open::after).
        h('button', { class: 'mc-open', type: 'button', onclick: () => openSheet(item) }, item.title)),
      h('div', { class: 'mc-who' },
        miniRing(item.score),
        h('div', { class: 'mc-who-text' },
          h('p', { class: 'mc-agency' }, agencyLine(item)),
          h('p', { class: `mc-place${place.miles ? '' : ' no-dist'}` }, icon(ICONS.pin),
            place.miles ? h('span', { class: 'mc-miles' }, place.miles) : null,
            place.miles ? ' · ' : null,
            h('span', {}, place.label)),
          // Why there are no miles, on its own line: a long area label is cut at two lines, this never is.
          place.note ? h('p', { class: 'mc-note' }, place.note) : null,
        ),
      ),
      h('ul', { class: 'mc-chips', 'aria-label': 'About this bid' },
        matchChips(item).map((c) => h('li', { class: `mc-chip ${c.kind}${c.urgent ? ' urgent' : ''}${c.unknown ? ' unknown' : ''}` }, c.text))),
    ),
    h('div', { class: 'mc-side' },
      h('button', {
        class: 'mc-btn mc-save', type: 'button', 'aria-pressed': String(saved), 'aria-label': `Save: ${item.title}`, title: 'Save',
        onclick: () => act(item, 'save', el, list),
      }, icon(BOOKMARK)),
      h('button', {
        class: 'mc-btn mc-pass', type: 'button', 'aria-label': `Pass: ${item.title}`, title: 'Pass',
        onclick: () => act(item, 'pass', el, list),
      }, icon(THUMB_DOWN)),
    ),
  );
  holdWhileTouched(el);
  return el;
}

const MODES = ['scroll', 'swipe'];
const pickMode = (id) => { if (ui.mode !== id) { setHomeMode(id); ui.toMatches = true; render(); } };

/** A radio group as a keyboard expects it: one Tab stop (the checked option), the arrow keys move the choice. */
function modeSwitch() {
  const opt = (id, label) => h('button', {
    class: `mode-opt${ui.mode === id ? ' is-on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(ui.mode === id),
    tabindex: ui.mode === id ? '0' : '-1',
    onclick: () => pickMode(id),
  }, label);
  const group = h('div', { class: 'mode-switch', role: 'radiogroup', 'aria-label': 'Show matches as' }, opt('scroll', 'Scroll'), opt('swipe', 'Swipe'));
  group.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (!step) return;
    e.preventDefault();
    e.stopPropagation(); // main.js must not take the arrow as a swipe
    pickMode(MODES[(MODES.indexOf(ui.mode) + step + MODES.length) % MODES.length]);
  });
  return group;
}

function scrollList(items, next) {
  if (!items.length) return [next, deckDone()];
  const shown = items.slice(0, Math.max(HOME_PAGE, ui.shown));
  const rest = items.length - shown.length;
  return [
    next,
    h('div', { class: 'mlist' }, shown.map((i) => matchCard(i, items))),
    rest > 0
      ? h('div', { class: 'more-bar' },
        h('p', { class: 'more-count' }, `Showing ${num(shown.length)} of ${num(items.length)}`),
        h('button', {
          class: 'cta ghost more-btn', type: 'button',
          onclick: () => { ui.focusId = items[shown.length].id; ui.shown = shown.length + HOME_PAGE; render(); },
        }, `Show ${num(Math.min(HOME_PAGE, rest))} more`))
      : null,
  ];
}

function renderHome() {
  // A redraw (Next up arrived, new counts) replaces the cards: keep keyboard focus on the same card and button.
  const active = document.activeElement;
  const was = active?.closest?.('.mcard');
  if (was && !ui.focusId) ui.restore = { id: was.dataset.id, cls: ['mc-save', 'mc-pass'].find((c) => active.classList.contains(c)) ?? 'mc-open' };
  const items = deck();
  const next = nextUp(items[0]?.id);
  let top = null;
  try {
    const cards = [tasksCard(), prefsCard()].filter(Boolean);
    if (cards.length) top = h('div', { class: 'home-top' }, cards);
  } catch { /* the cards above the matches are extras: the matches always draw */ }
  return h('div', { class: `home mode-${ui.mode}` },
    top,
    h('section', { class: 'matches', 'aria-labelledby': 'matchesTitle' },
      h('div', { class: 'matches-head' },
        h('h2', { class: 'matches-title', id: 'matchesTitle' }, 'Matches your preferences',
          h('span', { class: 'match-count', id: 'matchCount', 'aria-label': `${num(items.length)} bid${items.length === 1 ? '' : 's'} left to look at` }, tabNumber(items.length))),
        modeSwitch(),
      ),
      ui.mode === 'swipe' ? swipeView(items, next) : scrollList(items, next),
    ),
  );
}

// After a save, a pass or "Show more": keyboard focus goes to the card that took the place (no jump in the page).
onAfterRender((view) => {
  if (view !== 'home') return;
  // A new mode was picked: bring the matches up (the cards above them would leave the deck under the fold).
  if (ui.toMatches) {
    ui.toMatches = false;
    const head = document.querySelector('.matches');
    const top = head ? head.getBoundingClientRect().top + window.scrollY - 12 : 0;
    if (head && head.getBoundingClientRect().top > 80) window.scrollTo({ top });
    document.querySelector('.mode-opt.is-on')?.focus({ preventScroll: true });
  }
  const want = ui.focusId ? { id: ui.focusId, cls: 'mc-open' } : ui.restore;
  ui.focusId = null;
  ui.restore = null;
  if (!want || ui.mode !== 'scroll') return;
  const card = [...document.querySelectorAll('.mcard')].find((c) => c.dataset.id === want.id);
  card?.querySelector(`.${want.cls}`)?.focus({ preventScroll: true });
});

// Undo (the toast's button, gone with the toast): focus goes back to the card that returned, never to the page.
window.addEventListener('bidswipe:undone', (e) => {
  if (state.view !== 'home') return;
  const target = ui.mode === 'swipe'
    ? document.querySelector('.swipe-view .round.save')
    : [...document.querySelectorAll('.mcard')].find((c) => c.dataset.id === e.detail?.id)?.querySelector('.mc-open');
  target?.focus({ preventScroll: true });
});

registerView('home', { chrome: 'tabs', render: renderHome });
