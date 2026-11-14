// Loading Browse results and "Next up" from the API (or, in the demo, from the bundled snapshot).
//
// Browse pages through the server: the first PAGE_SIZE rows, then "Show more" asks for the next page of the same
// query (offset). The answer's `total` says how many rows match every filter (tier included). A server that
// sends no `total` does not page either: then Browse asks once for its largest page and says it shows the first N.

import { api } from './api.js';
import { localCounts, localFilter, PAGE_SIZE, toQuery } from './filters.js';
import { onFeedLoaded } from './session.js';
import { paintTabCounts, render } from './shell.js';
import { intent, isLive, mergeItems, state } from './state.js';

/** The server's largest page (GET /api/feed limit 1-300). */
const MAX_PAGE = 300;
let seq = 0;
/** false once a server answered without `total`: it cannot page, so ask for its largest page straight away. */
let serverPages = true;

const isTotal = (n) => Number.isInteger(n) && n >= 0;

/** Ask GET /api/feed with the current search and filters, first page. Only the newest answer is kept. */
export async function loadBrowse() {
  const mine = ++seq;
  state.browseLoading = true;
  state.browseError = null;
  state.browseMore = null;
  try {
    let items;
    let counts = null;
    let total = null;
    if (state.mode === 'demo') {
      items = localFilter(state.items, state.browse);
      counts = localCounts(state.items, state.browse);
      total = items.length; // the snapshot is small: every row at once
    } else {
      let res = await api.browse(toQuery(state.browse, { limit: serverPages ? PAGE_SIZE : MAX_PAGE }));
      if (mine !== seq) return;
      if (isTotal(res.total)) serverPages = true;
      else if (serverPages && res.items.length >= PAGE_SIZE) {
        // No `total`: this server ignores offset too, so a "Show more" would only repeat rows. Take its largest page.
        serverPages = false;
        res = await api.browse(toQuery(state.browse, { limit: MAX_PAGE }));
        if (mine !== seq) return;
      }
      items = mergeItems(res.items);
      counts = res.counts ?? null; // the three-way filter shows no numbers rather than made-up ones
      total = isTotal(res.total) ? res.total : null;
      state.browseSources = sourcesFrom(res);
    }
    if (mine !== seq) return;
    state.browseIds = items.map((i) => i.id);
    state.browseCounts = counts;
    // A total below the rows in hand would be a stale answer: never claim fewer than are shown.
    state.browseTotal = total == null ? null : Math.max(total, items.length);
    state.browseCut = total == null && state.mode !== 'demo' && items.length >= (serverPages ? PAGE_SIZE : MAX_PAGE);
  } catch (err) {
    if (mine !== seq) return;
    // 400 invalid_query carries the API's own message; anything else is a connection problem.
    state.browseError = err.code === 'invalid_query' ? err.message : 'Couldn’t load bids — check your connection.';
    state.browseIds = [];
    state.browseCounts = null;
    state.browseTotal = null;
    state.browseCut = false;
  } finally {
    if (mine === seq) state.browseLoading = false;
  }
  if (mine === seq) redraw();
}

/** Browse on screen: draw it. Another screen: only its tab numbers change (no redraw under the deck). */
function redraw() {
  if (state.view === 'browse') render();
  else paintTabCounts();
}

/** More rows to fetch? Only when the server pages (it sent `total`) and fewer rows are loaded than it counted. */
export const canShowMore = () => !!state.browseIds && state.browseTotal != null && state.browseIds.length < state.browseTotal;

/**
 * "Show more": the next page of the same query, appended. The rows already on screen stay where they are (the
 * list only grows below them), so the scroll position holds. A page that brings nothing new ends the paging.
 */
export async function loadMore() {
  if (!canShowMore() || state.browseMore === 'loading' || state.browseLoading) return;
  const mine = seq;
  const offset = state.browseIds.length;
  state.browseMore = 'loading';
  render();
  try {
    const res = await api.browse(toQuery(state.browse, { offset }));
    if (mine !== seq) return; // the filters changed meanwhile: that answer belongs to an old list
    const have = new Set(state.browseIds);
    const fresh = mergeItems(res.items).filter((i) => !have.has(i.id));
    state.browseIds = [...state.browseIds, ...fresh.map((i) => i.id)];
    if (res.counts) state.browseCounts = res.counts;
    if (isTotal(res.total)) state.browseTotal = Math.max(res.total, state.browseIds.length);
    // Nothing new (the list changed under us, or the server ignored offset): stop offering more.
    if (!fresh.length) state.browseTotal = state.browseIds.length;
    state.browseMore = null;
    state.browseFocus = fresh[0]?.id ?? null;
  } catch {
    if (mine !== seq) return;
    state.browseMore = 'error';
  }
  if (state.view === 'browse') render();
}

/** An optional per-board count the server may send ({ samgov: 12, … } or [{ id, n }]); null when not sent. */
function sourcesFrom(res) {
  const s = res.sources;
  if (!s || typeof s !== 'object') return null;
  const out = {};
  for (const [k, v] of Array.isArray(s) ? s.map((x) => [x?.id ?? x?.source, x?.n ?? x?.count]) : Object.entries(s)) {
    if (typeof k === 'string' && Number.isInteger(v) && v >= 0) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** GET /api/next: the one bid to look at next, with why. Live mode only. */
export async function loadNext() {
  if (!isLive()) return;
  try {
    const next = await api.next();
    state.next = { item: next.item ? mergeItems([next.item])[0] : null, why: next.why ?? [] };
  } catch {
    state.next = null; // "Next up" is a nicety: the deck works without it
  }
  if (state.view === 'swipe') render();
}

/**
 * After a swipe or an Undo, the counts move (they count bids not yet swiped); the Browse list does not (it lists
 * swiped bids too). Ask the server for the new counts with a one-row query, a moment after the last swipe, so a
 * run of quick swipes costs one request. The rows on screen and the scroll position stay as they are.
 */
let countsTimer = null;
function refreshCounts() {
  clearTimeout(countsTimer);
  countsTimer = setTimeout(async () => {
    if (!isLive()) return;
    const mine = seq;
    try {
      const whole = await api.browse('all=1&minScore=0&limit=1');
      if (whole.counts) state.counts = whole.counts;
      if (state.browseIds && state.browseCounts) {
        const res = await api.browse(toQuery(state.browse, { limit: 1 }));
        if (mine === seq && res.counts) state.browseCounts = res.counts;
      }
    } catch { /* the numbers catch up on the next load */ }
    // The finished deck says how many are left: it is the one other screen that shows these numbers.
    if (state.view === 'swipe' && !document.querySelector('.card')) render();
    else redraw();
  }, 400);
}

window.addEventListener('bidswipe:swiped', () => { refreshCounts(); loadNext(); });
// A new feed (boot, settings saved, a scan finished) can change everything: Browse loads again, in the background,
// so its tab number is the server's count from the start.
onFeedLoaded(() => { loadNext(); if (isLive() && intent() !== 'hire') loadBrowse(); });
