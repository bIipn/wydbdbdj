// The Browse filter sheet: job value, distance, deadline, fit level, source and sort.
// It edits a copy; "Show bids" applies it (one API call), closing the sheet any other way drops it.

import { loadBrowse } from './browse.js';
import { h } from './dom.js';
import { defaultFilters, DISTANCES, DUE_DAYS, FITS, SORTS, SOURCES } from './filters.js';
import { dollarsText, parseDollars } from './format.js';
import { clearErrors, field, formError, moneyInput, showErrors, toggle } from './form.js';
import { closeSheet, showInSheet } from './sheet.js';
import { render } from './shell.js';
import { state } from './state.js';

let draft = null;
let text = { min: '', max: '' };

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
  state.browseIds = null;
  render();
  loadBrowse();
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
    group('Source', 'Pick none to see every board.', multi('sources', SOURCES)),
    group('Sort by', null, h('div', { class: 'chip-row' }, SORTS.map((s) => chip(s.label, draft.sort === s.id, () => { draft.sort = s.id; draw(); })))),
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
  text = { min: dollarsText(draft.minValue), max: dollarsText(draft.maxValue) };
  if (draft.fits.length === 0) draft.fits = FITS.map((f) => f.id);
  draw();
}
