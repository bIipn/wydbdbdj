// Loading Browse results and "Next up" from the API (or, in the demo, from the bundled snapshot).

import { api } from './api.js';
import { localCounts, localFilter, toQuery } from './filters.js';
import { onFeedLoaded } from './session.js';
import { render } from './shell.js';
import { isLive, mergeItems, state } from './state.js';

let seq = 0;

/** Ask GET /api/feed with the current search and filters. Only the newest answer is kept. */
export async function loadBrowse() {
  const mine = ++seq;
  state.browseLoading = true;
  state.browseError = null;
  try {
    let items;
    let counts = null;
    if (state.mode === 'demo') {
      items = localFilter(state.items, state.browse);
      counts = localCounts(state.items, state.browse);
    } else {
      const res = await api.browse(toQuery(state.browse));
      items = mergeItems(res.items);
      counts = res.counts ?? null; // the three-way filter shows no numbers rather than made-up ones
    }
    if (mine !== seq) return;
    state.browseIds = items.map((i) => i.id);
    state.browseCounts = counts;
  } catch (err) {
    if (mine !== seq) return;
    // 400 invalid_query carries the API's own message; anything else is a connection problem.
    state.browseError = err.code === 'invalid_query' ? err.message : 'Couldn’t load bids — check your connection.';
    state.browseIds = [];
    state.browseCounts = null;
  } finally {
    if (mine === seq) state.browseLoading = false;
  }
  if (mine === seq && state.view === 'browse') render();
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

// A swipe can take the pick away (or an Undo bring it back), and a new feed can change it: ask again.
// A swipe changes what Browse would show and count: the next visit reloads the list and its tier counts.
window.addEventListener('bidswipe:swiped', () => { state.browseIds = null; state.browseCounts = null; loadNext(); });
onFeedLoaded(() => { loadNext(); });
