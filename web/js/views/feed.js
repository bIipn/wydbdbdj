// The tabbed feed views: Swipe (with "Next up"), Browse (search + filters through the API), Saved.

import { fling, markOpened } from '../actions.js';
import { loadBrowse } from '../browse.js';
import { attachSwipe, card, row } from '../cards.js';
import { h, icon, ICONS, safeUrl } from '../dom.js';
import { openFilters } from '../filter-sheet.js';
import { activeChips, defaultFilters, hasPriceFilter, isFiltered, SORTS, TIERS } from '../filters.js';
import { fmtDay, fmtTime, VERDICT_LABEL } from '../format.js';
import { jobIdOf, openJob } from '../jobs-data.js';
import { openSheet } from '../sheet.js';
import { onAfterRender, registerView, render, setView } from '../shell.js';
import { browseList, deck, feedCounts, hasSubTier, savedList, state, subWorkShown } from '../state.js';
import { openSettingsAt } from './settings.js';

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

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Open Browse on one tier, every other filter back to its default (the search words and sort kept). */
function browseTier(tier) {
  Object.assign(state.browse, defaultFilters(), { q: state.browse.q, sort: state.browse.sort, tier });
  state.browseIds = null;
  setView('browse');
}

/** "Wed, Nov 18 · 6:02 AM" for the last scan; scans run once a day, so the next one is about a day later. */
function scanLine() {
  if (!state.lastScan) return 'New bids are pulled from the boards once a day.';
  const last = new Date(state.lastScan);
  // Only what is known: the client is not told when the next scan runs, so it never guesses one.
  return `New bids are pulled from the boards once a day. The last scan was ${fmtDay.format(last)} · ${fmtTime.format(last)}.`;
}

/**
 * The finished deck: never a dead end. With the real counts (feedCounts), offer the next thing in one tap: the
 * sub work the deck leaves out, everything open in Browse, or a wider reach in Settings. Nothing left at
 * all: say so, and when new bids come.
 */
function deckDone() {
  const c = feedCounts();
  const total = c.fit + c.sub + c.other;
  const canWiden = state.mode === 'live' && state.auth === 'accounts' && !!state.me?.profile;
  const widen = canWiden ? h('button', { class: 'cta ghost', type: 'button', onclick: () => openSettingsAt('radiusMi') }, 'Widen your reach') : null;
  if (total === 0) {
    return h('div', { class: 'empty deck-done' },
      h('div', { class: 'big' }, '⚡'),
      h('h3', {}, 'No open bids for you right now'),
      h('p', {}, scanLine()),
      h('div', { class: 'next-steps' }, widen),
    );
  }
  const subHidden = hasSubTier() && !subWorkShown() && c.sub > 0;
  return h('div', { class: 'empty deck-done' },
    h('div', { class: 'big' }, '⚡'),
    h('h3', {}, 'You’re caught up'),
    h('p', {}, `Nothing left to swipe. ${plural(total, 'open bid')} for you ${total === 1 ? 'is' : 'are'} still unswiped.`),
    h('div', { class: 'next-steps' },
      subHidden ? h('button', { class: 'cta', type: 'button', onclick: () => browseTier('sub') }, `See ${plural(c.sub, 'sub-work job')}`) : null,
      h('button', { class: subHidden ? 'cta ghost' : 'cta', type: 'button', onclick: () => browseTier('all') }, `Browse all ${total}`),
      widen,
    ),
    h('p', { class: 'deck-done-note' }, scanLine()),
  );
}

function renderSwipe() {
  const items = deck();
  const next = nextUp(items[0]?.id);
  if (items.length === 0) return h('div', { class: 'swipe-view' }, next, deckDone());
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
      // A local job opens its page in the app (where the sealed bid is placed); a public bid opens the agency's site.
      jobIdOf(current)
        ? h('button', { class: 'round open', type: 'button', 'aria-label': 'See job and bid', onclick: () => openJob(jobIdOf(current)) }, icon(ICONS.open))
        : h('a', {
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
  const lead = all ? (list.length === 1 ? 'This one doesn’t list a job value' : `None of these ${list.length} list a job value`)
    : `${unknown} of ${list.length} don’t list a job value`;
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
  // A tier with nothing in it: say so in its own words, and offer Everything (with its real count, if sent).
  if (f.tier !== 'all') {
    const c = state.browseCounts;
    const all = c ? c.fit + c.sub + c.other : null;
    return h('div', { class: 'empty compact' },
      h('h3', {}, f.tier === 'sub' ? 'No sub work matches right now' : 'No fits match right now'),
      h('p', {}, f.tier === 'sub'
        ? 'Sub work is a building or facility job a general contractor bids, where your trade is usually subcontracted. None is open for you under these filters.'
        : 'Nothing open matches your trade under these filters.'),
      all ? h('button', { class: 'cta ghost', type: 'button', onclick: () => refilter((x) => { x.tier = 'all'; }) }, `Show everything (${all})`) : null,
    );
  }
  // Say which choice most likely emptied the list, in the order people trip over them.
  const hint = f.hasValue ? 'Most public notices don’t list a job value, so “Value listed” leaves very few. Remove it to see the rest.'
    : q ? 'Try fewer or different words — the search looks at the title, agency, town and bid number.'
      : f.maxDistance != null ? 'Bids we couldn’t place on the map drop out when you pick a distance. Try a wider one.'
        : isFiltered(f) ? 'Remove a filter to see more.'
          : 'There are no open bids right now. New ones are pulled every morning.';
  return h('div', { class: 'empty compact' },
    h('h3', {}, q ? `No bids match “${q}”` : 'No bids match these filters'),
    h('p', {}, hint),
    isFiltered(f) ? h('button', { class: 'cta ghost', type: 'button', onclick: () => { if (ui.input) ui.input.value = ''; refilter((x) => Object.assign(x, defaultFilters(), { tier: x.tier })); } }, q ? 'Clear search and filters' : 'Clear filters') : null,
  );
}

const SORT_WORDS = { fit: 'best fits first', due: 'due soonest first', near: 'nearest first', new: 'newest first', value: 'biggest value first' };
const TIER_NOUN = { all: ['open bid', 'open bids'], fit: ['fit', 'fits'], sub: ['sub-work job', 'sub-work jobs'] };

/**
 * "138 open bids for you, best fits first" (then "· 6 swiped · 3 over your limit"). Browse lists swiped and
 * over-limit bids too. The three-way filter counts only bids not yet swiped, so "6 swiped" makes 138 and its
 * "Everything 132" add up.
 */
function resultCount(list) {
  const f = state.browse;
  const [one, many] = TIER_NOUN[f.tier] ?? TIER_NOUN.all;
  const n = list.length;
  const where = isFiltered(f) ? 'match your filters' : 'for you';
  const lead = `${n} ${n === 1 ? one : many} ${n === 1 && where === 'match your filters' ? 'matches your filters' : where}${n > 1 ? `, ${SORT_WORDS[f.sort] ?? SORT_WORDS.fit}` : ''}`;
  const swiped = list.filter((i) => i.swipe).length;
  const over = list.filter((i) => i.overLimit).length;
  const parts = [lead];
  if (swiped) parts.push(`${swiped} swiped`);
  if (over) parts.push(`${over} over your limit`);
  return parts.join(' · ');
}

/**
 * Fits · Sub work · Everything, each with how many open, unswiped bids it holds under the other filters (the
 * API's `counts`). No counts from the server: the labels alone. A general contractor gets no Sub work choice.
 */
function tierFilter() {
  const c = state.browseCounts;
  const shown = TIERS.filter((t) => t.id !== 'sub' || hasSubTier());
  const count = (id) => (!c ? null : id === 'all' ? c.fit + c.sub + c.other : c[id]);
  return h('div', { class: 'tier-filter', role: 'radiogroup', 'aria-label': 'Show', 'data-n': String(shown.length) },
    shown.map((t) => {
      const on = state.browse.tier === t.id;
      const n = count(t.id);
      return h('button', {
        class: `tier-opt tier-${t.id}${on ? ' is-on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(on),
        'aria-label': n == null ? t.label : `${t.label}: ${n} not yet swiped`,
        onclick: () => { if (!on) refilter((x) => { x.tier = t.id; }); },
      }, h('span', {}, t.label), n == null ? null : h('b', {}, n));
    }));
}

/** Sub work, said once above its list: what it is and what to do with it. */
const subIntro = () => h('p', { class: 'value-note sub-intro' },
  'Sub work: a general contractor bids these to the agency, and trades like yours are usually subcontracted. Quote the bidders, not the agency. These never send alerts.');

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
      chips.length > 1 ? h('button', { class: 'chip', type: 'button', onclick: () => refilter((x) => Object.assign(x, defaultFilters(), { q: x.q, sort: x.sort, tier: x.tier })) }, 'Clear all') : null,
    ) : null,
    tierFilter(),
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
  else body = h('div', {}, f.tier === 'sub' ? subIntro() : null, valueNote(list), h('div', { class: 'list' }, list.map(row)));

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
