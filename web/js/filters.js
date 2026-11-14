// Browse search and filters: one plain object, turned into GET /api/feed query parameters.
// The demo (no server) applies the same filters here, in the browser (localFilter).

import { dueInfo, money, tierOf } from './format.js';

/** The boards a bid can come from (src/sources/index.ts ids). */
export const SOURCES = [
  { id: 'nevadaepro', label: 'NevadaEPro' },
  { id: 'ngem', label: 'NGEM' },
  { id: 'questcdn', label: 'QuestCDN' },
  { id: 'douglascounty', label: 'Douglas County' },
  { id: 'samgov', label: 'SAM.gov' },
];

/**
 * Fit levels = the verdict bands of src/score/score.ts. All four are on by default: Browse's three-way filter
 * (TIERS below) is what narrows the list now, and "Everything" has to mean every open bid in reach.
 */
export const FITS = [
  { id: 'great', label: 'Great' },
  { id: 'good', label: 'Good' },
  { id: 'maybe', label: 'Maybe' },
  { id: 'skip', label: 'Not a fit' },
];
const DEFAULT_FITS = FITS.map((f) => f.id);

/**
 * Browse's three-way filter (GET /api/feed tier=…). 'fit' = the company's own trade work at the deck line or
 * above; 'sub' = a prime contract where its trade is usually a subcontract (src/score/subwork.ts); 'all' = every
 * open candidate, 'other' included. Kept in state.browse while the app is open.
 */
export const TIERS = [
  { id: 'fit', label: 'Fits' },
  { id: 'sub', label: 'Sub work' },
  { id: 'all', label: 'Everything' },
];

export const SORTS = [
  { id: 'fit', label: 'Best fit' },
  { id: 'due', label: 'Due soonest' },
  { id: 'near', label: 'Nearest' },
  { id: 'new', label: 'Newest' },
  { id: 'value', label: 'Biggest value' },
];

export const DISTANCES = [25, 50, 90, 150];
export const DUE_DAYS = [3, 7, 14, 30];

export function defaultFilters() {
  return {
    q: '', minValue: null, maxValue: null, hasValue: false, maxDistance: null, dueWithinDays: null,
    sources: [], fits: [...DEFAULT_FITS], sort: 'fit', tier: 'all',
  };
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/** The query string for GET /api/feed (Browse: swiped bids too, over-limit ones kept and tagged). */
export function toQuery(f) {
  const p = new URLSearchParams({ all: '1', minScore: '0', limit: '300' });
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.minValue != null) p.set('minValue', String(f.minValue));
  if (f.maxValue != null) p.set('maxValue', String(f.maxValue));
  if (f.hasValue) p.set('hasValue', '1');
  if (f.maxDistance != null) p.set('maxDistance', String(f.maxDistance));
  if (f.dueWithinDays != null) p.set('dueWithinDays', String(f.dueWithinDays));
  if (f.sources.length) p.set('source', f.sources.join(','));
  if (f.fits.length && f.fits.length < FITS.length) p.set('verdict', f.fits.join(','));
  if (f.sort !== 'fit') p.set('sort', f.sort);
  if (f.tier && f.tier !== 'all') p.set('tier', f.tier);
  return p.toString();
}

export const hasPriceFilter = (f) => f.minValue != null || f.maxValue != null;

function priceLabel(f) {
  if (f.minValue != null && f.maxValue != null) return `${money(f.minValue)}–${money(f.maxValue)}`;
  return f.minValue != null ? `${money(f.minValue)}+` : `Up to ${money(f.maxValue)}`;
}

/**
 * The filters that differ from the defaults, as removable chips: [{ key, label, clear(f) }].
 * The search words and the sort are shown elsewhere (the search box, the sort menu).
 */
export function activeChips(f) {
  const chips = [];
  if (hasPriceFilter(f)) chips.push({ key: 'price', label: priceLabel(f), clear: (x) => { x.minValue = null; x.maxValue = null; } });
  if (f.hasValue) chips.push({ key: 'hasValue', label: 'Value listed', clear: (x) => { x.hasValue = false; } });
  if (f.maxDistance != null) chips.push({ key: 'distance', label: `Within ${f.maxDistance} mi`, clear: (x) => { x.maxDistance = null; } });
  if (f.dueWithinDays != null) chips.push({ key: 'due', label: `Due in ${f.dueWithinDays} days`, clear: (x) => { x.dueWithinDays = null; } });
  for (const id of f.sources) {
    chips.push({ key: `source:${id}`, label: SOURCES.find((s) => s.id === id)?.label ?? id, clear: (x) => { x.sources = x.sources.filter((s) => s !== id); } });
  }
  if (!sameSet(f.fits, DEFAULT_FITS)) {
    const label = f.fits.length === FITS.length || f.fits.length === 0 ? 'Any fit' : `Fit: ${f.fits.map((v) => FITS.find((x) => x.id === v)?.label).join(', ')}`;
    chips.push({ key: 'fits', label, clear: (x) => { x.fits = [...DEFAULT_FITS]; } });
  }
  return chips;
}

/** Anything narrowed down beyond the defaults (search words included)? The tier is not counted: it has its own control. */
export const isFiltered = (f) => !!f.q.trim() || activeChips(f).length > 0;

// ------------------------------------------------- demo (no server) ---

const VERDICT_OF = (score) => (score >= 75 ? 'great' : score >= 55 ? 'good' : score >= 35 ? 'maybe' : 'skip');

/** The same filters on the bundled snapshot. Mirrors src/db/repo.ts getFeed closely enough for a demo. */
export function localFilter(items, f, { ignoreTier = false } = {}) {
  const words = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const now = Date.now();
  const list = items.filter((i) => {
    if (i.dueAt && Date.parse(i.dueAt) <= now) return false;
    const text = [i.title, i.agency, i.description, i.category, i.location?.label, i.solNumber, i.sourceId].join(' ').toLowerCase();
    if (!words.every((w) => text.includes(w))) return false;
    const lo = i.estValue?.min ?? null;
    const hi = i.estValue?.max ?? null;
    if (lo == null && hi == null) { if (f.hasValue) return false; } else {
      if (f.minValue != null && hi != null && hi < f.minValue) return false;
      if (f.maxValue != null && lo != null && lo > f.maxValue) return false;
    }
    if (f.maxDistance != null && (i.distanceMi == null || i.distanceMi > f.maxDistance)) return false;
    if (f.dueWithinDays != null && (!i.dueAt || Date.parse(i.dueAt) > now + f.dueWithinDays * 864e5)) return false;
    if (f.sources.length && !f.sources.includes(i.source)) return false;
    if (f.fits.length && !f.fits.includes(i.verdict ?? VERDICT_OF(i.score))) return false;
    if (!ignoreTier && f.tier && f.tier !== 'all' && tierOf(i) !== f.tier) return false;
    return true;
  });
  const val = (i) => i.estValue?.max ?? i.estValue?.min ?? -1;
  const sorters = {
    fit: (a, b) => b.score - a.score || dueInfo(a.dueAt).days - dueInfo(b.dueAt).days,
    due: (a, b) => dueInfo(a.dueAt).days - dueInfo(b.dueAt).days || b.score - a.score,
    near: (a, b) => (a.distanceMi ?? 1e9) - (b.distanceMi ?? 1e9) || b.score - a.score,
    new: (a, b) => Date.parse(b.postedAt ?? b.firstSeenAt ?? 0) - Date.parse(a.postedAt ?? a.firstSeenAt ?? 0) || b.score - a.score,
    value: (a, b) => val(b) - val(a) || b.score - a.score,
  };
  return list.sort(sorters[f.sort] ?? sorters.fit);
}

/** The demo's tier counts (the server sends `counts`): unswiped bids under the same filters, any tier. */
export function localCounts(items, f) {
  const out = { fit: 0, sub: 0, other: 0 };
  for (const i of localFilter(items, f, { ignoreTier: true })) if (!i.swipe) out[tierOf(i)] += 1;
  return out;
}
