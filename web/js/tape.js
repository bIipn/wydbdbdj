// The market tape: one rounded pill across the top of every tab screen (index.html #tape, outside #view so a
// re-render or a change of tab never restarts it). It is the way into Market (Market is not a tab). The shell calls
// paintTape({ view, chrome }) on every render; tape-items.js tapeMode() decides: rotating, still, or hidden.
//
// Rotating: ONE item on one line (name, figure, signed one-month change, month). About every 4 s the item on show
// slides up and out while the next slides up from below into its place, in a loop; with one item nothing moves. It
// holds while a pointer is over it, while it is touched and while it has keyboard focus, and its right end has a
// pause/play button (remembered on this device). With prefers-reduced-motion nothing slides and nothing changes by
// itself: that button becomes "next" and the person steps through the items.
// Still = no figure in hand (loading, a failed request, no price data stored): "Market prices" and a chevron, never a
// number or a placeholder figure; it opens Market all the same.
//
// What it says comes from tape-items.js (the Market screen's own figures and rounding, each with its month). It never
// says "live". Screen readers get one label naming every item once (tapeSpoken); the moving row is aria-hidden, so a
// change of item is never announced.
//
// Imports stay below the shell (dom, state, api, tape-items): shell.js imports this file, and the demo bundler
// (src/cli/snapshot.ts) refuses an import cycle. So a tap does not call setView here: it fires
// 'bidswipe:open-market', which home-extras.js answers with setView('market').

import { req } from './api.js';
import { $, h, icon, store } from './dom.js';
import { intent, isLive, state } from './state.js';
import {
  keepIndex, nextIndex, TAPE_HOLD_MS, TAPE_ICON_LABEL, TAPE_STILL_SPOKEN, TAPE_STILL_TEXT,
  tapeControl, tapeItems, tapeKey, tapeMode, tapeSpoken,
} from './tape-items.js';

const PAUSE_KEY = 'bidswipe:tape-paused';
/** How long the slide takes (styles.css .tape-row transition is the same): the old row is removed after it. */
const SLIDE_MS = 450;

const tape = {
  /** The account/profile the data was asked for, the items it gave, and what the pill shows now. */
  askedFor: null,
  loading: false,
  items: [],
  builtKey: null,
  /** The item on show, and the timer that brings the next one. */
  index: 0,
  shownKey: null,
  timer: null,
  /** What holds it still for the moment (pointer over it, a finger on it, keyboard focus in it). */
  hover: false,
  touch: false,
  focus: false,
  /** The screen the shell is drawing: { view, chrome }. */
  on: { view: null, chrome: null },
};

const ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5h16"/><path d="M5 15l4.2-4.6 3.4 2.8L19 6.5"/><path d="M15 6.5h4v4"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
// "Next": a skip-forward mark (an up arrow beside "+0.8%" read as "rising").
const NEXT_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6 5.5v13l9.5-6.5z"/><rect x="16.5" y="5.5" width="2.6" height="13" rx="1"/></svg>';
const CHEVRON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';

/** Someone here only to get work done sees no bid screens, so no market pill either (shell.js hireOnly). */
const hireOnly = () => state.auth === 'accounts' && intent() === 'hire';
/** This person has a Market: the API is there (the bundled demo has none) and they look for work. */
const hasMarket = () => isLive() && !hireOnly();

/** Whose market answer this is: the account and the profile's place and trades (a settings save can change them). */
function askKey() {
  const me = state.me;
  if (!me) return null;
  const p = me.profile;
  return JSON.stringify([me.account?.id ?? me.id ?? '', p?.zip ?? me.base ?? '', p?.trades ?? []]);
}

const paused = () => store.get(PAUSE_KEY) === '1';
const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const reduced = () => !!motionQuery?.matches;

function load() {
  const key = askKey();
  if (!key || tape.loading || tape.askedFor === key) return;
  tape.loading = true;
  tape.askedFor = key;
  // quiet: a lost session is the feed's business; the pill just stays still.
  req('api/market/area', { quiet: true })
    .then((area) => { if (askKey() === key) tape.items = tapeItems(area); })
    .catch(() => { if (askKey() === key) tape.items = []; })
    .finally(() => {
      tape.loading = false;
      if (askKey() !== tape.askedFor) { tape.items = []; load(); }
      paint();
    });
}

/** One item on one line: the name gives way (ellipsis), the figure, the change and the month never do. */
function rowNode(i) {
  return h('span', { class: `tape-row is-${i.kind} dir-${i.dir}` },
    // Both names are drawn; styles.css shows the short one on a narrow pill. "index" is said on the pill itself:
    // a bare 607.7 next to a $/hr wage could read as a price.
    h('span', { class: 'tape-name' }, h('span', { class: 'tape-full' }, i.name), h('span', { class: 'tape-short' }, i.short ?? i.name)),
    i.kind === 'material' ? h('span', { class: 'tape-idx' }, 'index') : null,
    h('span', { class: 'tape-fig' }, i.figure),
    i.kind === 'wage'
      ? h('span', { class: 'tape-note' }, i.note)
      : h('span', { class: 'tape-chg' }, i.change ? [i.mark ? h('span', { class: 'tape-mark' }, i.mark) : null, i.change] : '—'),
    h('span', { class: 'tape-month' }, h('span', { class: 'tape-full' }, i.month), h('span', { class: 'tape-short' }, i.monthShort ?? i.month),
      i.prelim ? h('span', { class: 'tape-prelim' }, ' prelim.') : null),
  );
}

const openMarket = () => window.dispatchEvent(new CustomEvent('bidswipe:open-market'));
const goKeys = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMarket(); } };

/** The control at the right end (tape-items.js tapeControl): pause/play, "next" with reduced motion, or none. */
function controlNode() {
  const c = tapeControl({ count: tape.items.length, reduced: reduced(), paused: paused() });
  if (c.kind === 'none') return null;
  const svg = { pause: PAUSE_SVG, play: PLAY_SVG, next: NEXT_SVG }[c.kind];
  return h('button', {
    type: 'button', class: `tape-toggle is-${c.kind}`, 'aria-label': c.label, title: c.label,
    // The label says what a press does ("Pause…" / "Play…"); no aria-pressed on top of it (that read as "Play, pressed").
    onclick: (e) => {
      e.stopPropagation();
      if (c.kind === 'next') { show(nextIndex(tape.index, tape.items.length), false); return; }
      store.set(PAUSE_KEY, paused() ? '0' : '1');
      refreshControl(true);
      schedule();
    },
  }, icon(svg));
}

/** Swap the control for the current one (after pause/play, or a change of the reduced-motion setting). */
function refreshControl(keepFocus = false) {
  const el = $('#tape');
  if (!el || el.dataset.mode !== 'rotate') return;
  const old = el.querySelector('.tape-toggle');
  const next = controlNode();
  if (old && next) old.replaceWith(next);
  else if (old) old.remove();
  else if (next) el.append(next);
  el.classList.toggle('is-paused', paused());
  if (keepFocus) el.querySelector('.tape-toggle')?.focus();
}

/** Show item i: slide (the old one up and out, the new one up from below) or, without motion, a plain swap. */
function show(i, slide) {
  const win = $('#tape .tape-window');
  const item = tape.items[i];
  if (!win || !item) return;
  tape.index = i;
  tape.shownKey = item.key;
  const row = rowNode(item);
  const cur = win.querySelector('.tape-row:not(.is-out)');
  if (!slide || !cur) { win.replaceChildren(row); return; }
  win.querySelectorAll('.tape-row.is-out').forEach((r) => r.remove());
  row.classList.add('is-in');
  win.append(row);
  void row.offsetHeight; // start the new row below the window before it moves
  cur.classList.add('is-out');
  row.classList.remove('is-in');
  setTimeout(() => cur.remove(), SLIDE_MS + 50);
}

/** May the next item come by itself now? */
function canMove() {
  const el = $('#tape');
  return !!el && !el.hidden && el.dataset.mode === 'rotate' && tape.items.length > 1 && !reduced() && !paused()
    && !tape.hover && !tape.touch && !tape.focus && document.visibilityState !== 'hidden';
}

/** (Re)start the wait for the next item, or stop it when something holds the pill. A release waits the full 4 s. */
function schedule() {
  clearTimeout(tape.timer);
  tape.timer = null;
  if (!canMove()) return;
  tape.timer = setTimeout(() => {
    tape.timer = null;
    if (!canMove()) return;
    show(nextIndex(tape.index, tape.items.length), true);
    schedule();
  }, TAPE_HOLD_MS);
}

/** The rotating pill, from tape.items (only when they changed); it keeps the item on show when that is still there. */
function build(el) {
  const items = tape.items;
  tape.index = keepIndex(tape.shownKey, items);
  tape.shownKey = items[tape.index]?.key ?? null;
  const go = h('div', { class: 'tape-go', role: 'link', tabindex: '0', 'aria-label': tapeSpoken(items), onclick: openMarket, onkeydown: goKeys },
    h('span', { class: 'tape-icon', 'aria-hidden': 'true', title: TAPE_ICON_LABEL }, icon(ICON_SVG)),
    h('span', { class: 'tape-window', 'aria-hidden': 'true' }, rowNode(items[tape.index])));
  const control = controlNode();
  el.replaceChildren(...(control ? [go, control] : [go]));
  el.classList.remove('is-still');
  el.classList.toggle('is-paused', paused());
  el.classList.toggle('is-single', items.length < 2);
  tape.builtKey = tapeKey(items);
}

/** The still pill: what it is and where it goes, no figure. */
function buildStill(el) {
  el.replaceChildren(h('div', { class: 'tape-go', role: 'link', tabindex: '0', 'aria-label': TAPE_STILL_SPOKEN, onclick: openMarket, onkeydown: goKeys },
    h('span', { class: 'tape-icon', 'aria-hidden': 'true', title: TAPE_ICON_LABEL }, icon(ICON_SVG)),
    h('span', { class: 'tape-still', 'aria-hidden': 'true' }, TAPE_STILL_TEXT),
    h('span', { class: 'tape-chev', 'aria-hidden': 'true' }, icon(CHEVRON_SVG))));
  el.classList.remove('is-paused', 'is-single');
  el.classList.add('is-still');
  tape.builtKey = 'still';
}

/** Hold still under a pointer, a finger or keyboard focus (listeners added once, on the persistent #tape). */
function wire(el) {
  if (el.dataset.wired) return;
  el.dataset.wired = '1';
  const set = (k, v) => { if (tape[k] !== v) { tape[k] = v; schedule(); } };
  el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') set('hover', true); });
  el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') set('hover', false); else set('touch', false); });
  el.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') set('touch', true); });
  el.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') set('touch', false); });
  el.addEventListener('pointercancel', () => set('touch', false));
  el.addEventListener('focusin', () => set('focus', true));
  el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) set('focus', false); });
}
document.addEventListener('visibilitychange', () => schedule());
motionQuery?.addEventListener?.('change', () => { refreshControl(); schedule(); });

function paint() {
  const el = $('#tape');
  if (!el) return;
  wire(el);
  // An answer asked for another account or profile is not this one's: still until this one's arrives.
  const items = askKey() === tape.askedFor ? tape.items : [];
  const mode = tapeMode({ ...tape.on, hasMarket: hasMarket(), items });
  if (mode === 'rotate' && tape.builtKey !== tapeKey(items)) build(el);
  if (mode === 'still' && tape.builtKey !== 'still') buildStill(el);
  if (mode === 'hidden' && el.contains(document.activeElement)) document.activeElement.blur();
  el.hidden = mode === 'hidden';
  el.dataset.mode = mode;
  // Hidden (Market, a full page): the wait stops and the same item is there when it shows again; a plain re-render
  // that changes nothing leaves a running wait alone, so the item never jumps or skips.
  if (!canMove()) schedule();
  else if (!tape.timer) schedule();
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
