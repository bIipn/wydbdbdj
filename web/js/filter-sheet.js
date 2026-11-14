// The Browse filter sheet: job value, distance, deadline, fit level, source and sort.
// It edits a copy; "Show bids" applies it (one API call), closing the sheet any other way drops it.

import { loadBrowse } from './browse.js';
import { h } from './dom.js';
import { defaultFilters, DISTANCES, DUE_DAYS, FITS, SORTS, SOURCES } from './filters.js';
import { SOURCE_LABELS } from './source-labels.js';
import { dollarsText, parseDollars } from './format.js';
import { clearErrors, field, formError, moneyInput, showErrors, toggle } from './form.js';
import { closeSheet, showInSheet } from './sheet.js';
import { render } from './shell.js';
import { forgetBrowse, state } from './state.js';

let draft = null;
let text = { min: '', max: '' };
/** "More boards" opened in this sheet. */
let moreBoards = false;

function chip(label, on, onclick) {
  return h('button', { class: `chip${on ? ' is-on' : ''}`, type: 'button', 'aria-pressed': String(on), onclick }, label);
}

/** One choice of several (null = "Any"). */
function single(key, options, unit) {
  return h('div', { class: 'chip-row' },
    chip('Any', draft[key] == null, () => { draft[key] = null; draw(); }),
    options.map((v) => chip(`${v} ${unit}`, draft[key] === v, () => { draft[key] = v; draw(); })),
  );
}

/** Any number of choices; at least one stays on. */
function multi(key, options) {
  return h('div', { class: 'chip-row' }, options.map((o) => {
    const on = draft[key].includes(o.id);
    return chip(o.label, on, () => {
      draft[key] = on ? draft[key].filter((x) => x !== o.id) : [...draft[key], o.id];
      draw();
    });
  }));
}

/** The company's home state: the two letters at the end of its base ("River Pines, CA" → "CA"). */
const homeState = () => /,\s*([A-Z]{2})\s*$/.exec(state.profile?.base ?? '')?.[1] ?? null;

/**
 * The Source choices. 18 boards are too many to scan, so the sheet leads with the boards that matter here:
 * when the server says which boards have bids for this account (`sources`), only those. Otherwise the home
 * state's boards, the nationwide ones and any board already seen in this account's bids, the rest behind
 * "More boards", each with its state. A board that is picked always shows.
 */
function sourceChoices() {
  const counts = state.browseSources;
  const seen = new Set(state.items.map((i) => i.source));
  const home = homeState();
  const picked = (id) => draft.sources.includes(id);
  const lead = (b) => picked(b.id) || (counts ? (counts[b.id] ?? 0) > 0 : b.state === home || b.state === 'US' || seen.has(b.id));
  const rank = (b) => (b.state === home ? 0 : b.state === 'US' ? 1 : 2); // home state, nationwide, then others seen
  const first = SOURCE_LABELS.filter(lead).sort((a, b) => rank(a) - rank(b));
  const rest = counts ? [] : SOURCE_LABELS.filter((b) => !lead(b)).sort((a, b) => a.state.localeCompare(b.state));
  const boardChip = (b, withState) => {
    const on = picked(b.id);
    const n = counts?.[b.id];
    return chip([b.label, withState ? h('small', { class: 'chip-state' }, b.state === 'US' ? 'US' : b.state) : null,
      n != null ? h('small', { class: 'chip-state' }, n.toLocaleString('en-US')) : null], on, () => {
      draft.sources = on ? draft.sources.filter((x) => x !== b.id) : [...draft.sources, b.id];
      draw();
    });
  };
  return [
    h('div', { class: 'chip-row' }, first.map((b) => boardChip(b, false))),
    rest.length ? h('button', {
      class: 'link-btn more-boards', type: 'button', 'aria-expanded': String(moreBoards),
      onclick: () => { moreBoards = !moreBoards; draw(); },
    }, moreBoards ? 'Fewer boards' : `More boards (${rest.length}, other states)`) : null,
    rest.length && moreBoards ? h('div', { class: 'chip-row' }, rest.map((b) => boardChip(b, true))) : null,
  ];
}

const group = (title, help, ...body) => h('section', { class: 'fs-group' },
  h('h3', {}, title), help ? h('p', { class: 'field-help' }, help) : null, ...body);

function apply(form) {
  clearErrors(form);
  const min = parseDollars(text.min);
  const max = parseDollars(text.max);
  const errors = {};
  if (Number.isNaN(min)) errors.minValue = 'Type a dollar amount, like 10,000 or 10k.';
  if (Number.isNaN(max)) errors.maxValue = 'Type a dollar amount, like 50,000 or 50k.';
  if (!errors.minValue && !errors.maxValue && min != null && max != null && min > max) errors.maxValue = 'The most should be more than the least.';
  if (Object.keys(errors).length) return showErrors(form, errors);
  draft.minValue = min;
  draft.maxValue = max;
  if (draft.sources.length === SOURCES.length) draft.sources = []; // every board = no filter
  state.browse = draft;
  draft = null;
  closeSheet();
  forgetBrowse();
  loadBrowse(); // first: it marks the list as loading, so the render below does not ask a second time
  render();
}

function draw() {
  const base = state.profile?.base ? ` (${state.profile.base})` : '';
  const form = h('form', { class: 'filter-sheet', novalidate: true },
    h('div', { class: 'fs-head' },
      h('h2', { id: 'filterTitle' }, 'Filters'),
      h('button', { class: 'text-btn', type: 'button', onclick: () => { const q = draft.q; draft = { ...defaultFilters(), q }; text = { min: '', max: '' }; draw(); } }, 'Reset'),
    ),
    group('Job value', 'Most public notices don’t list a value. Those bids stay in unless you switch on “Only bids that list a value”.',
      h('div', { class: 'pair' },
        field({ key: 'minValue', label: 'At least', control: moneyInput({ text: text.min, placeholder: 'Any', label: 'At least', oninput: (v) => { text.min = v; } }) }),
        field({ key: 'maxValue', label: 'At most', control: moneyInput({ text: text.max, placeholder: 'Any', label: 'At most', oninput: (v) => { text.max = v; } }) }),
      ),
      toggle({ checked: draft.hasValue, label: 'Only bids that list a value', onchange: (on) => { draft.hasValue = on; } }),
    ),
    group('Distance', `Straight-line miles from your base${base}. Bids we couldn’t place are left out when you pick a distance.`, single('maxDistance', DISTANCES, 'mi')),
    group('Bids due within', null, single('dueWithinDays', DUE_DAYS, 'days')),
    group('Fit level', null, multi('fits', FITS)),
    group('Source', state.browseSources ? 'Boards with bids for you. Pick none to see every board.' : 'Pick none to see every board.', ...sourceChoices()),
    group('Sort by', draft.sort === 'near' ? 'Bids with no distance (no site we can place) come last.' : null, h('div', { class: 'chip-row' }, SORTS.map((s) => chip(s.label, draft.sort === s.id, () => { draft.sort = s.id; draw(); })))),
    formError(),
    h('div', { class: 'fs-foot' },
      h('button', { class: 'cta ghost', type: 'button', onclick: () => { draft = null; closeSheet(); } }, 'Cancel'),
      h('button', { class: 'cta', type: 'submit' }, 'Show bids'),
    ),
  );
  form.addEventListener('submit', (e) => { e.preventDefault(); apply(form); });
  const scroll = document.getElementById('sheet')?.scrollTop ?? 0;
  showInSheet([form], 'filterTitle');
  document.getElementById('sheet').scrollTop = scroll; // a chip tap keeps your place
}

/** The Filters button. */
export function openFilters() {
  draft = structuredClone(state.browse);
  moreBoards = false;
  text = { min: dollarsText(draft.minValue), max: dollarsText(draft.maxValue) };
  if (draft.fits.length === 0) draft.fits = FITS.map((f) => f.id);
  draw();
}
