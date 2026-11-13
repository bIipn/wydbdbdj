// The tabbed feed views: Swipe (with "Next up"), Browse (search + filters through the API), Saved.

import { fling, markOpened } from '../actions.js';
import { loadBrowse } from '../browse.js';
import { attachSwipe, card, row } from '../cards.js';
import { h, icon, ICONS, safeUrl } from '../dom.js';
import { openFilters } from '../filter-sheet.js';
import { activeChips, defaultFilters, hasPriceFilter, isFiltered, SORTS } from '../filters.js';
import { VERDICT_LABEL } from '../format.js';
import { openSheet } from '../sheet.js';
import { onAfterRender, registerView, render, setView } from '../shell.js';
import { browseList, deck, savedList, state } from '../state.js';

// ------------------------------------------------------------- swipe ---

/**
 * "Next up": the API's pick (fit + how soon it is due) with its reasons. Hidden once it is swiped, and while it
 * is the deck's top card anyway (the same bid twice only pushes the swipe buttons off a phone screen).
 */
function nextUp(topId) {
  const item = state.next?.item;
  if (!item || item.swipe || item.overLimit || item.id === topId) return null;
  return h('button', { class: `next verdict-${item.verdict}`, type: 'button', onclick: () => openSheet(item), 'aria-label': `Next up: ${item.title}` },
    h('div', { class: 'next-top' },
      h('span', { class: 'next-label' }, 'Next up'),
      h('span', { class: 'next-verdict' }, `${VERDICT_LABEL[item.verdict] ?? item.verdict} · ${item.score}`),
    ),
    h('strong', { class: 'next-title' }, item.title),
    state.next.why.length ? h('ul', { class: 'next-why' }, state.next.why.slice(1).map((w) => h('li', {}, w))) : null,
  );
}

function renderSwipe() {
  const items = deck();
  const next = nextUp(items[0]?.id);
  if (items.length === 0) {
    return h('div', { class: 'swipe-view' },
      next,
      h('div', { class: 'empty' },
        h('div', { class: 'big' }, '⚡'),
        h('h3', {}, 'You’re caught up'),
        h('p', {}, 'New bids are pulled from the county, state, and local boards every morning. Anything that fits lands here.'),
        h('button', { class: 'cta ghost', type: 'button', onclick: () => setView('browse') }, 'Browse everything'),
      ),
    );
  }
  const stack = h('div', { class: 'deck' });
  const top = items.slice(0, 3);
  [...top].reverse().forEach((item, idx, arr) => {
    const depth = arr.length - 1 - idx; // 0 = top
    const el = card(item, depth === 0 ? 'is-top' : `behind-${depth}`);
    stack.append(el);
    if (depth === 0) attachSwipe(el, item);
  });
  const current = items[0];
  return h('div', { class: `swipe-view${next ? ' has-next' : ''}` },
    next,
    stack,
    h('div', { class: 'actions' },
      h('button', { class: 'round pass', type: 'button', 'aria-label': 'Pass', onclick: () => fling(current, 'pass') }, icon(ICONS.pass)),
      h('a', {
        class: 'round open', href: safeUrl(current.url), target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open bid',
        onclick: () => markOpened(current),
      }, icon(ICONS.open)),
      h('button', { class: 'round save', type: 'button', 'aria-label': 'Save', onclick: () => fling(current, 'save') }, icon(ICONS.save)),
    ),
    h('p', { class: 'hint' }, 'Swipe right to save · left to pass'),
  );
}

// ------------------------------------------------------------ browse ---

const ui = { input: null, timer: null, hadFocus: false };

function searchInput() {
  if (!ui.input) {
    ui.input = h('input', {
      class: 'input search-input', type: 'search', placeholder: 'Search bids', 'aria-label': 'Search bids',
      enterkeyhint: 'search', autocomplete: 'off', maxlength: '200',
    });
    ui.input.addEventListener('input', () => {
      state.browse.q = ui.input.value;
      clearTimeout(ui.timer);
      ui.timer = setTimeout(loadBrowse, 300);
    });
    ui.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(ui.timer); loadBrowse(); ui.input.blur(); } });
  }
  if (ui.input.value !== state.browse.q) ui.input.value = state.browse.q;
  return ui.input;
}

// The search box is the same element on every render; give it its focus back if it had it.
onAfterRender((view) => {
  if (view === 'browse' && ui.hadFocus && ui.input) {
    ui.input.focus();
    ui.input.setSelectionRange(ui.input.value.length, ui.input.value.length);
  }
});

function refilter(change) {
  change(state.browse);
  state.browseIds = null;
  render();
  loadBrowse();
}

function sortMenu() {
  const select = h('select', { class: 'sort-select', 'aria-label': 'Sort bids' },
    SORTS.map((s) => h('option', { value: s.id, selected: state.browse.sort === s.id }, s.label)));
  select.addEventListener('change', () => refilter((f) => { f.sort = select.value; }));
  return h('label', { class: 'sort' }, h('span', {}, 'Sort'), select);
}

/** Most notices list no job value: say so, and what the price filter does with them. */
function valueNote(list) {
  const unknown = list.filter((i) => !i.estValue || (i.estValue.min == null && i.estValue.max == null)).length;
  if (!unknown) return null;
  const f = state.browse;
  const all = unknown === list.length;
  const lead = all ? `None of these ${list.length} list a job value` : `${unknown} of ${list.length} don’t list a job value`;
  if (hasPriceFilter(f)) {
    return h('p', { class: 'value-note' },
      `${lead} — most public notices don’t, so we can’t tell if they fit your price range. They’re kept so you don’t miss one. `,
      h('button', { class: 'link-btn', type: 'button', onclick: () => refilter((x) => { x.hasValue = true; }) }, 'Hide them'));
  }
  return h('p', { class: 'value-note' }, `${lead} — most public notices don’t. Read the bid documents for the size of the job.`);
}

function noResults() {
  const f = state.browse;
  const q = f.q.trim();
  // Say which choice most likely emptied the list, in the order people trip over them.
  const hint = f.hasValue ? 'Most public notices don’t list a job value, so “Value listed” leaves very few. Remove it to see the rest.'
    : q ? 'Try fewer or different words — the search looks at the title, agency, town and bid number.'
      : f.maxDistance != null ? 'Bids we couldn’t place on the map drop out when you pick a distance. Try a wider one.'
        : isFiltered(f) ? 'Remove a filter to see more.'
          : 'There are no open bids right now. New ones are pulled every morning.';
  return h('div', { class: 'empty compact' },
    h('h3', {}, q ? `No bids match “${q}”` : 'No bids match these filters'),
    h('p', {}, hint),
    isFiltered(f) ? h('button', { class: 'cta ghost', type: 'button', onclick: () => { if (ui.input) ui.input.value = ''; refilter((x) => Object.assign(x, defaultFilters())); } }, q ? 'Clear search and filters' : 'Clear filters') : null,
  );
}

/**
 * "24 bids · 18 to swipe · 3 over your limit": Browse lists swiped and over-limit bids too, Swipe does not.
 * Saying how many of these are still in the deck makes the two tab counts add up.
 */
function resultCount(list) {
  const inDeck = new Set(deck().map((i) => i.id));
  const toSwipe = list.filter((i) => inDeck.has(i.id)).length;
  const over = list.filter((i) => i.overLimit).length;
  const parts = [`${list.length} bid${list.length === 1 ? '' : 's'}`];
  if (toSwipe !== list.length) parts.push(`${toSwipe} to swipe`);
  if (over) parts.push(`${over} over your limit`);
  return parts.join(' · ');
}

function renderBrowse() {
  ui.hadFocus = !!ui.input && document.activeElement === ui.input;
  if (state.browseIds === null && !state.browseLoading) loadBrowse();
  const f = state.browse;
  const chips = activeChips(f);
  const list = browseList();
  const loading = state.browseIds === null;

  const header = h('div', { class: 'browse-head' },
    h('div', { class: 'searchbar' },
      h('label', { class: 'search' }, icon(ICONS.search), searchInput()),
      h('button', { class: `filter-btn${chips.length ? ' is-on' : ''}`, type: 'button', onclick: openFilters, 'aria-label': `Filters${chips.length ? ` (${chips.length} on)` : ''}` },
        icon(ICONS.sliders), 'Filters', chips.length ? h('span', { class: 'filter-count' }, chips.length) : null),
    ),
    chips.length ? h('div', { class: 'toolbar active-chips' },
      chips.map((c) => h('button', { class: 'chip is-on removable', type: 'button', 'aria-label': `Remove filter: ${c.label}`, onclick: () => refilter(c.clear) }, c.label, icon(ICONS.x))),
      chips.length > 1 ? h('button', { class: 'chip', type: 'button', onclick: () => refilter((x) => Object.assign(x, defaultFilters(), { q: x.q, sort: x.sort })) }, 'Clear all') : null,
    ) : null,
    h('div', { class: 'result-bar' },
      h('span', { class: 'result-count', 'aria-live': 'polite' }, loading ? 'Loading…' : resultCount(list)),
      sortMenu(),
    ),
  );

  let body;
  if (loading) body = h('div', { class: 'list' }, [0, 1, 2].map(() => h('div', { class: 'row skeleton', 'aria-hidden': 'true' })));
  else if (state.browseError) body = h('div', { class: 'empty compact' }, h('h3', {}, 'Couldn’t search'), h('p', {}, state.browseError),
    h('button', { class: 'cta ghost', type: 'button', onclick: () => { state.browseIds = null; render(); loadBrowse(); } }, 'Try again'));
  else if (!list.length) body = noResults();
  else body = h('div', {}, valueNote(list), h('div', { class: 'list' }, list.map(row)));

  return h('div', { class: 'browse' }, header, body);
}

// ------------------------------------------------------------- saved ---

function renderSaved() {
  const list = savedList();
  if (!list.length) {
    return h('div', { class: 'empty' },
      h('div', { class: 'big' }, '★'),
      h('h3', {}, 'No saved bids yet'),
      h('p', {}, 'Swipe right on anything worth a closer look. Saved bids are sorted by deadline.'),
    );
  }
  return h('div', { class: 'list' }, list.map(row));
}

registerView('swipe', { chrome: 'tabs', render: renderSwipe });
registerView('browse', { chrome: 'tabs', render: renderBrowse });
registerView('saved', { chrome: 'tabs', render: renderSaved });
