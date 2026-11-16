// The market tape: the strip of price moves across the top of every tab screen (index.html #tape, outside #view so a
// re-render or a change of tab never restarts it). It is the way into Market (Market is not a tab). The shell calls
// paintTape({ view, chrome }) on every render; tape-items.js tapeMode() decides: scrolling, still, or hidden.
// Still = no figure in hand (loading, a failed request, no price data stored): the fixed label, "Market prices" and a
// chevron, never a number or a placeholder figure; it opens Market all the same.
//
// What it says comes from tape-items.js (the Market screen's own figures and rounding, each with its month). It never
// says "live": a fixed label names it as monthly figures. Tapping it opens Market, where the sources and the BLS
// line are. It moves right to left in a seamless loop (the second copy is aria-hidden like the rest: the control's
// one spoken label reads every item once), pauses under a pointer, a finger or keyboard focus, has a pause button
// (remembered on this device), and with prefers-reduced-motion it stands still as a strip to scroll by hand.
//
// Imports stay below the shell (dom, state, api, tape-items): shell.js imports this file, and the demo bundler
// (src/cli/snapshot.ts) refuses an import cycle. So a tap does not call setView here: it fires
// 'bidswipe:open-market', which home-extras.js answers with setView('market').

import { req } from './api.js';
import { $, h, icon, store } from './dom.js';
import { intent, isLive, state } from './state.js';
import { TAPE_LABEL, TAPE_STILL_SPOKEN, TAPE_STILL_TEXT, tapeItems, tapeKey, tapeMode, tapeSpoken } from './tape-items.js';

const PAUSE_KEY = 'bidswipe:tape-paused';
/** Calm and readable: about 40 px a second, whatever the width of the items. */
const PX_PER_SECOND = 40;

const tape = {
  /** The account/profile the data was asked for, the items it gave, and what the strip shows now. */
  askedFor: null,
  loading: false,
  items: [],
  builtKey: null,
  /** The screen the shell is drawing: { view, chrome }. */
  on: { view: null, chrome: null },
};

const PAUSE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';

/** Someone here only to get work done sees no bid screens, so no price strip either (shell.js hireOnly). */
const hireOnly = () => state.auth === 'accounts' && intent() === 'hire';

/** Whose market answer this is: the account and the profile's place and trades (a settings save can change them). */
function askKey() {
  const me = state.me;
  if (!me) return null;
  const p = me.profile;
  return JSON.stringify([me.account?.id ?? me.id ?? '', p?.zip ?? me.base ?? '', p?.trades ?? []]);
}

const paused = () => store.get(PAUSE_KEY) === '1';

function load() {
  const key = askKey();
  if (!key || tape.loading || tape.askedFor === key) return;
  tape.loading = true;
  tape.askedFor = key;
  // quiet: a lost session is the feed's business; the strip just stays hidden.
  req('api/market/area', { quiet: true })
    .then((area) => { if (askKey() === key) tape.items = tapeItems(area); })
    .catch(() => { if (askKey() === key) tape.items = []; })
    .finally(() => {
      tape.loading = false;
      if (askKey() !== tape.askedFor) { tape.items = []; load(); }
      paint();
    });
}

function itemNode(i) {
  return h('span', { class: `tape-item is-${i.kind} dir-${i.dir}` },
    h('b', { class: 'tape-name' }, i.name),
    i.detail ? h('span', { class: 'tape-detail' }, i.detail) : null,
    i.change ? h('span', { class: 'tape-chg' }, i.mark ? h('span', { class: 'tape-mark' }, i.mark) : null, i.change)
      : h('span', { class: 'tape-chg' }, '—'),
    h('span', { class: 'tape-month' }, `${i.month}${i.prelim ? ' (prelim.)' : ''}`),
  );
}

/** One copy of the items; `times` copies inside it when one is narrower than the strip (a wide screen). */
const run = (items, times) => h('span', { class: 'tape-run' }, Array.from({ length: times }, () => items.map(itemNode)));

function toggleButton() {
  const on = paused();
  return h('button', {
    type: 'button', class: 'tape-toggle', 'aria-pressed': String(on),
    'aria-label': on ? 'Play the price strip' : 'Pause the price strip',
    title: on ? 'Play' : 'Pause',
    onclick: (e) => {
      e.stopPropagation();
      store.set(PAUSE_KEY, paused() ? '0' : '1');
      const el = $('#tape');
      el.classList.toggle('is-paused', paused());
      e.currentTarget.replaceWith(toggleButton());
      $('#tape .tape-toggle')?.focus();
    },
  }, icon(on ? PLAY_SVG : PAUSE_SVG));
}

const openMarket = () => window.dispatchEvent(new CustomEvent('bidswipe:open-market'));
const goKeys = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMarket(); } };

const STILL_KEY = 'still';
const CHEVRON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';

/** The still strip: what it is and where it goes, no figure. */
function buildStill(el) {
  el.replaceChildren(h('div', { class: 'tape-go is-still', role: 'link', tabindex: '0', 'aria-label': TAPE_STILL_SPOKEN, onclick: openMarket, onkeydown: goKeys },
    h('span', { class: 'tape-label', 'aria-hidden': 'true' }, TAPE_LABEL),
    h('span', { class: 'tape-still', 'aria-hidden': 'true' }, h('span', { class: 'tape-still-text' }, TAPE_STILL_TEXT), icon(CHEVRON_SVG))));
  el.classList.remove('is-paused');
  el.classList.add('is-still');
  tape.builtKey = STILL_KEY;
}

/** Build the strip from tape.items (only when they changed), then size its loop. */
function build(el) {
  const items = tape.items;
  const go = h('div', {
    class: 'tape-go', role: 'link', tabindex: '0', 'aria-label': tapeSpoken(items),
    onclick: openMarket,
    onkeydown: goKeys,
  },
  h('span', { class: 'tape-label', 'aria-hidden': 'true' }, TAPE_LABEL),
  h('span', { class: 'tape-window', 'aria-hidden': 'true' },
    h('span', { class: 'tape-track' }, run(items, 1), run(items, 1))));
  el.replaceChildren(go, toggleButton());
  el.classList.remove('is-still');
  el.classList.toggle('is-paused', paused());
  tape.builtKey = tapeKey(items);
  requestAnimationFrame(() => fit(el));
}

/**
 * Make the loop seamless at any width: each copy at least as wide as the window (repeat the items inside it when
 * not), and the speed the same whatever the length (duration from the copy's width).
 */
function fit(el) {
  const win = el.querySelector('.tape-window');
  const track = el.querySelector('.tape-track');
  const first = track?.firstElementChild;
  if (!win || !first || !first.offsetWidth || !tape.items.length) return; // hidden or still: sized when it scrolls
  const one = first.offsetWidth / first.childElementCount * tape.items.length; // the width of one set of items
  const times = Math.max(1, Math.ceil(win.clientWidth / one));
  if (times !== first.childElementCount / tape.items.length) track.replaceChildren(run(tape.items, times), run(tape.items, times));
  track.style.setProperty('--tape-dur', `${Math.round((one * times) / PX_PER_SECOND)}s`);
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { const el = $('#tape'); if (el && !el.hidden) fit(el); }, 200);
});

/** Hold the strip still while a finger is on it (hover and keyboard focus are CSS: :hover, :focus-within). */
function holdOnTouch(el) {
  if (el.dataset.touchHold) return;
  el.dataset.touchHold = '1';
  const off = () => el.classList.remove('is-touched');
  el.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') el.classList.add('is-touched'); });
  el.addEventListener('pointerup', off);
  el.addEventListener('pointercancel', off);
  el.addEventListener('pointerleave', off);
}

/** This person has a Market: the API is there (the bundled demo has none) and they look for work. */
const hasMarket = () => isLive() && !hireOnly();

function paint() {
  const el = $('#tape');
  if (!el) return;
  // An answer asked for another account or profile is not this one's: still until this one's arrives.
  const items = askKey() === tape.askedFor ? tape.items : [];
  const mode = tapeMode({ ...tape.on, hasMarket: hasMarket(), items });
  if (mode === 'scroll' && tape.builtKey !== tapeKey(items)) build(el);
  if (mode === 'still' && tape.builtKey !== STILL_KEY) buildStill(el);
  const wasHidden = el.hidden;
  el.hidden = mode === 'hidden';
  el.dataset.mode = mode;
  if (mode === 'scroll') {
    holdOnTouch(el);
    if (wasHidden) requestAnimationFrame(() => fit(el));
  }
}

/**
 * Show, still or hide the tape for the screen the shell is drawing, and keep its content current. Never throws.
 * on = { view, chrome } (true/false is read as "Home or nothing", the first round's call).
 */
export function paintTape(on) {
  try {
    tape.on = typeof on === 'object' && on ? { view: on.view, chrome: on.chrome } : { view: on ? 'home' : null, chrome: 'tabs' };
    if (hasMarket()) load();
    paint();
  } catch {
    const el = document.getElementById('tape');
    if (el) el.hidden = true;
  }
}
