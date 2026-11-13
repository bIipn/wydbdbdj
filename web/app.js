// BidSwipe web app — plain JavaScript, no build step.
// Talks to the Fastify API when it's there; otherwise runs on the bundled snapshot (demo mode).

const PT = 'America/Los_Angeles';
const DECK_MIN_SCORE = 35;
const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  mode: 'live', // 'live' | 'demo'
  profile: null,
  items: [],
  note: '',
  lastScan: null,
  view: 'swipe',
  filter: 'fits', // browse: fits | great | near | all
  sort: 'fit', // browse: fit | due | near
  accessCode: null,
};

// ------------------------------------------------------------ helpers --

/** Tiny element builder. Strings always become text nodes, never HTML. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Static, trusted SVG markup only (never user data). */
function icon(svg) {
  const span = document.createElement('span');
  span.innerHTML = svg;
  return span.firstElementChild;
}
const ICONS = {
  pass: '<svg viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg>',
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode / sandbox */ } },
};

const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '#');

const fmtDay = new Intl.DateTimeFormat('en-US', { timeZone: PT, weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: PT, hour: 'numeric', minute: '2-digit' });

/** "10:00 AM" → "10 AM", keeps "2:30 PM". */
const clock = (d) => fmtTime.format(d).replace(':00 ', ' ');

function dueInfo(iso) {
  if (!iso) return { big: 'Not listed', small: 'Check the bid', urgent: false, days: Infinity };
  const d = new Date(iso);
  const ms = d.getTime() - Date.now();
  const days = ms / 864e5;
  let big;
  if (ms <= 0) big = 'Closed';
  else if (days < 1) big = ms < 36e5 ? 'Under 1 hour' : `${Math.floor(ms / 36e5)} hours left`;
  else big = `${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'} left`;
  return { big, small: `${fmtDay.format(d)} · ${clock(d)}`, urgent: days < 5, days };
}

function money(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${v}`;
}
function estLabel(est) {
  if (!est) return null;
  const { min, max } = est;
  if (min != null && max != null && min !== max) return `${money(min)}–${money(max)}`;
  const v = max ?? min;
  if (v == null) return null;
  return min == null ? `Under ${money(v)}` : money(v);
}

/** "NV Public Works (QuestCDN)" → "NV Public Works" for buttons. */
const shortSource = (name) => (name ?? 'source').replace(/\s*\([^)]*\)\s*$/, '');

const VERDICT_LABEL = { great: 'Great fit', good: 'Good fit', maybe: 'Maybe', skip: 'Not a fit' };
const isOpen = (i) => !i.dueAt || Date.parse(i.dueAt) > Date.now();
const byFit = (a, b) => b.score - a.score || (Date.parse(a.dueAt ?? '9999-01-01') - Date.parse(b.dueAt ?? '9999-01-01'));

function orderedReasons(item) {
  const rank = { plus: 0, minus: 1, info: 2 };
  return [...item.reasons].sort((a, b) => rank[a.kind] - rank[b.kind]);
}

// --------------------------------------------------------------- data --

async function req(path, opts = {}) {
  // Only claim JSON when there is a body — Fastify rejects an empty JSON body (e.g. on DELETE).
  const headers = opts.body ? { 'content-type': 'application/json' } : {};
  if (state.accessCode) headers['x-access-code'] = state.accessCode;
  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  if (res.status === 401) throw Object.assign(new Error('access code required'), { code: 401 });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

const DEMO_KEY = 'bidswipe:demo-swipes';
function demoSwipes() {
  try { return JSON.parse(store.get(DEMO_KEY) || '{}'); } catch { return {}; }
}
function persistDemo() {
  const map = {};
  for (const i of state.items) if (i.swipe) map[i.id] = i.swipe;
  store.set(DEMO_KEY, JSON.stringify(map));
}

const api = {
  async load() {
    const [me, feed] = await Promise.all([req('api/me'), req('api/feed?all=1&minScore=0&limit=300')]);
    state.profile = me;
    state.items = feed.items;
    state.lastScan = feed.lastScan;
  },
  async swipe(id, action) {
    if (state.mode === 'demo') return persistDemo();
    await req('api/swipe', { method: 'POST', body: JSON.stringify({ bidId: id, action }) });
  },
  async undo(id) {
    if (state.mode === 'demo') return persistDemo();
    await req(`api/swipe/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};

function startDemo(data) {
  state.mode = 'demo';
  state.profile = data.profile;
  state.note = data.note || '';
  const saved = demoSwipes();
  state.items = data.items.map((i) => ({ ...i, swipe: saved[i.id] ?? null }));
  render();
}

// ---------------------------------------------------------- derived ---

const deck = () => state.items.filter((i) => !i.swipe && i.score >= DECK_MIN_SCORE && isOpen(i)).sort(byFit);
const savedList = () =>
  state.items.filter((i) => i.swipe === 'save' || i.swipe === 'bid').sort((a, b) => dueInfo(a.dueAt).days - dueInfo(b.dueAt).days);

function browseList() {
  let list = state.items.filter(isOpen);
  if (state.filter === 'fits') list = list.filter((i) => i.score >= DECK_MIN_SCORE);
  if (state.filter === 'great') list = list.filter((i) => i.score >= 75);
  if (state.filter === 'near') list = list.filter((i) => i.distanceMi != null && i.distanceMi <= 30 && i.score > 0);
  const sorters = {
    fit: byFit,
    due: (a, b) => dueInfo(a.dueAt).days - dueInfo(b.dueAt).days,
    near: (a, b) => (a.distanceMi ?? 1e9) - (b.distanceMi ?? 1e9),
  };
  return list.sort(sorters[state.sort]);
}

// ----------------------------------------------------------- render ---

function render() {
  $('#profileName').textContent = state.profile?.name ?? 'BidSwipe';
  $('#profileBase').textContent = state.profile?.base ?? '';
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.view === state.view;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  $('#countSwipe').textContent = deck().length || '';
  $('#countBrowse').textContent = state.items.filter((i) => isOpen(i) && i.score >= DECK_MIN_SCORE).length || '';
  $('#countSaved').textContent = savedList().length || '';

  const view = $('#view');
  view.replaceChildren(state.view === 'swipe' ? renderSwipe() : state.view === 'browse' ? renderBrowse() : renderSaved());

  const scan = state.lastScan ? `Last scan ${fmtDay.format(new Date(state.lastScan))} · ${fmtTime.format(new Date(state.lastScan))}. ` : '';
  $('#footnote').textContent =
    state.mode === 'demo'
      ? `Demo — ${state.note} Swipes stay on this device.`
      : `${scan}Scores are a first pass — always read the bid documents before you price a job.`;
}

function scoreRing(score) {
  const C = 2 * Math.PI * 24;
  const ring = icon(
    `<svg viewBox="0 0 56 56" aria-hidden="true"><circle class="track" cx="28" cy="28" r="24" fill="none" stroke-width="5"/>` +
      `<circle class="fill" cx="28" cy="28" r="24" fill="none" stroke-width="5" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>`,
  );
  const wrap = h('div', { class: 'ring', title: `Fit score ${score} of 100` }, ring, h('b', {}, score));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    ring.querySelector('.fill').style.strokeDashoffset = String(C * (1 - score / 100));
  }));
  return wrap;
}

function facts(item) {
  const due = dueInfo(item.dueAt);
  const where = item.location?.label ?? 'Location not listed';
  const dist = item.distanceMi != null ? `${item.distanceMi} mi away` : 'Distance unknown';
  return h('div', { class: 'facts' },
    h('div', { class: 'fact' }, h('span', {}, 'Where'), h('strong', {}, where), h('small', {}, dist)),
    h('div', { class: `fact${due.urgent ? ' urgent' : ''}` }, h('span', {}, 'Bids due'), h('strong', {}, due.big), h('small', {}, due.small)),
    h('div', { class: 'fact' }, h('span', {}, 'Est. value'), h('strong', {}, estLabel(item.estValue) ?? 'Not listed'), h('small', {}, 'from the bid notice')),
    h('div', { class: 'fact' }, h('span', {}, 'Type'), h('strong', {}, item.category ?? 'Bid'), h('small', {}, item.sourceName)),
  );
}

function reasonsList(item, max) {
  const rs = orderedReasons(item);
  return h('ul', { class: 'reasons' }, (max ? rs.slice(0, max) : rs).map((r) => h('li', { class: r.kind }, r.text)));
}

function bidLink(item, extraClass = '') {
  return h('a', {
    class: `cta ${extraClass}`,
    href: safeUrl(item.url),
    target: '_blank',
    rel: 'noopener noreferrer',
    onclick: () => {
      if (!item.swipe) markOpened(item);
    },
  }, `Bid on ${shortSource(item.sourceName)}`, icon(ICONS.open.replace('<svg ', '<svg width="16" height="16" stroke="currentColor" ')));
}

function card(item, layer) {
  const el = h('article', { class: `card verdict-${item.verdict} ${layer}`, 'aria-label': item.title },
    h('div', { class: 'stamp save' }, 'SAVE'),
    h('div', { class: 'stamp pass' }, 'PASS'),
    h('div', { class: 'card-head' },
      h('div', { class: 'pills' },
        h('span', { class: 'pill verdict' }, VERDICT_LABEL[item.verdict] ?? item.verdict),
        h('span', { class: 'pill' }, item.sourceName),
      ),
      scoreRing(item.score),
    ),
    h('h2', {}, item.title),
    h('p', { class: 'agency' }, item.agency ?? ''),
    facts(item),
    reasonsList(item, 4),
    bidLink(item),
    h('div', { class: 'card-foot' },
      h('span', {}, (item.description ?? '').split('\n')[0].slice(0, 70)),
      h('button', { type: 'button', onclick: () => openSheet(item) }, 'Details'),
    ),
  );
  return el;
}

function renderSwipe() {
  const items = deck();
  if (items.length === 0) {
    return h('div', { class: 'empty' },
      h('div', { class: 'big' }, '⚡'),
      h('h3', {}, "You're caught up"),
      h('p', {}, 'New bids are pulled from the county, state, and local boards every morning. Anything that fits lands here.'),
      h('button', { class: 'cta ghost', type: 'button', onclick: () => setView('browse') }, 'Browse everything'),
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
  return h('div', {},
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

function row(item) {
  const due = dueInfo(item.dueAt);
  const meta = [item.agency, item.location?.label, item.distanceMi != null ? `${item.distanceMi} mi` : null].filter(Boolean).join(' · ');
  const tag = item.swipe === 'save' || item.swipe === 'bid' ? h('span', { class: 'tag saved' }, item.swipe === 'bid' ? 'Opened' : 'Saved')
    : item.swipe === 'pass' ? h('span', { class: 'tag passed' }, 'Passed') : null;
  return h('button', { class: `row verdict-${item.verdict}`, type: 'button', onclick: () => openSheet(item) },
    h('div', { class: 'badge' }, item.score),
    h('div', {},
      h('h4', {}, item.title),
      h('p', {}, meta),
      h('p', {}, h('span', { class: `due${due.urgent ? ' urgent' : ''}` }, due.big), ` · ${due.small}`),
      tag,
    ),
  );
}

function chip(label, on, onclick) {
  return h('button', { class: `chip${on ? ' is-on' : ''}`, type: 'button', onclick }, label);
}

function renderBrowse() {
  const list = browseList();
  const sortLabel = { fit: 'Best fit', due: 'Due soonest', near: 'Closest' }[state.sort];
  const nextSort = { fit: 'due', due: 'near', near: 'fit' }[state.sort];
  return h('div', {},
    h('div', { class: 'toolbar' },
      chip('Good fits', state.filter === 'fits', () => setFilter('fits')),
      chip('Great only', state.filter === 'great', () => setFilter('great')),
      chip('Within 30 mi', state.filter === 'near', () => setFilter('near')),
      chip('Everything', state.filter === 'all', () => setFilter('all')),
      chip(`Sort: ${sortLabel}`, false, () => { state.sort = nextSort; render(); }),
    ),
    list.length
      ? h('div', { class: 'list' }, list.map(row))
      : h('div', { class: 'empty' }, h('h3', {}, 'Nothing here'), h('p', {}, 'Try "Everything" to see every open bid we found, including poor fits.')),
  );
}

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

// ------------------------------------------------------------ swiping --

function attachSwipe(el, item) {
  let startX = 0, startY = 0, dx = 0, dy = 0, t0 = 0, active = false, id = null;
  const save = $('.stamp.save', el);
  const pass = $('.stamp.pass', el);

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('a, button')) return;
    active = true; id = e.pointerId; startX = e.clientX; startY = e.clientY; t0 = performance.now(); dx = dy = 0;
    el.setPointerCapture(id);
    el.style.transition = 'none';
  });
  el.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== id) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    el.style.transform = `translate(${dx}px, ${dy * 0.2}px) rotate(${dx / 18}deg)`;
    const p = Math.min(1, Math.abs(dx) / 110);
    save.style.opacity = dx > 0 ? String(p) : '0';
    pass.style.opacity = dx < 0 ? String(p) : '0';
  });
  const end = (e) => {
    if (!active || e.pointerId !== id) return;
    active = false;
    const speed = Math.abs(dx) / Math.max(1, performance.now() - t0);
    if (Math.abs(dx) > 110 || (Math.abs(dx) > 45 && speed > 0.55)) {
      commit(item, dx > 0 ? 'save' : 'pass', el, dy);
    } else {
      el.style.transition = 'transform .28s cubic-bezier(.2,.8,.2,1)';
      el.style.transform = '';
      save.style.opacity = pass.style.opacity = '0';
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

/** Button / keyboard swipe on the current top card. */
function fling(item, action) {
  const el = $('.card.is-top');
  if (!el || !item) return;
  $(action === 'pass' ? '.stamp.pass' : '.stamp.save', el).style.opacity = '1';
  commit(item, action, el, 0);
}

function commit(item, action, el, dy) {
  const dir = action === 'pass' ? -1 : 1;
  el.style.transition = 'transform .3s ease-in, opacity .3s ease-in';
  el.style.transform = `translate(${dir * (window.innerWidth + 240)}px, ${dy * 0.2 + 30}px) rotate(${dir * 24}deg)`;
  el.style.opacity = '0';
  try { navigator.vibrate?.(8); } catch { /* not supported */ }
  setSwipe(item, action, action === 'pass' ? 'Passed' : 'Saved');
  setTimeout(render, 240);
}

function markOpened(item) {
  setSwipe(item, 'bid', 'Saved · bid page opened');
  setTimeout(render, 60);
}

async function setSwipe(item, action, message) {
  const before = item.swipe;
  item.swipe = action;
  showToast(message, async () => {
    item.swipe = before;
    render();
    try { before ? await api.swipe(item.id, before) : await api.undo(item.id); } catch { showToast("Couldn't undo — check your connection"); }
  });
  try {
    await api.swipe(item.id, action);
  } catch {
    item.swipe = before;
    render();
    showToast("Couldn't save that swipe — check your connection");
  }
}

// ------------------------------------------------------- sheet / toast --

function openSheet(item) {
  const body = $('#sheetBody');
  const actions = h('div', { class: 'sheet-actions' },
    h('button', { class: 'cta ghost', type: 'button', onclick: () => { closeSheet(); setSwipe(item, 'pass', 'Passed'); render(); } }, 'Pass'),
    h('button', { class: 'cta ghost', type: 'button', onclick: () => { closeSheet(); setSwipe(item, 'save', 'Saved'); render(); } }, item.swipe === 'save' ? 'Saved ✓' : 'Save'),
    bidLink(item, 'full'),
  );
  body.replaceChildren(
    h('div', { class: `card-head verdict-${item.verdict}` },
      h('div', { class: 'pills' },
        h('span', { class: 'pill verdict' }, VERDICT_LABEL[item.verdict] ?? item.verdict),
        h('span', { class: 'pill' }, item.sourceName),
      ),
      scoreRing(item.score),
    ),
    h('h2', { id: 'sheetTitle' }, item.title),
    h('p', { class: 'agency' }, item.agency ?? ''),
    facts(item),
    h('div', { class: `verdict-${item.verdict}` }, reasonsList(item)),
    item.description ? h('div', { class: 'desc' }, item.description) : null,
    actions,
  );
  $('#sheet').hidden = false;
  $('#sheetBackdrop').hidden = false;
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheetBackdrop').hidden = true;
}

let toastTimer;
function showToast(message, onUndo) {
  const t = $('#toast');
  t.replaceChildren(h('span', {}, message), onUndo ? h('button', { type: 'button', onclick: () => { t.hidden = true; onUndo(); } }, 'Undo') : null);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}

// --------------------------------------------------------- navigation --

function setView(v) { state.view = v; render(); window.scrollTo({ top: 0 }); }
function setFilter(f) { state.filter = f; render(); }

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
$('#sheetBackdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return closeSheet();
  if (state.view !== 'swipe' || !$('#sheet').hidden || e.target.closest?.('input')) return;
  const current = deck()[0];
  if (!current) return;
  if (e.key === 'ArrowRight') fling(current, 'save');
  if (e.key === 'ArrowLeft') fling(current, 'pass');
  if (e.key === 'ArrowUp' || (e.key === 'Enter' && !e.target.closest?.('button, a'))) openSheet(current);
});

// --------------------------------------------------------------- boot --

function renderGate(message) {
  const input = h('input', { type: 'password', inputmode: 'text', autocomplete: 'off', placeholder: 'Access code', 'aria-label': 'Access code' });
  const go = async () => {
    state.accessCode = input.value.trim();
    store.set('bidswipe:code', state.accessCode);
    await boot();
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  $('#view').replaceChildren(h('div', { class: 'gate' },
    h('div', { class: 'empty' }, h('div', { class: 'big' }, '⚡'), h('h3', {}, 'Enter your access code'), h('p', {}, message ?? 'Ask whoever set up BidSwipe for your company.')),
    input,
    h('button', { class: 'cta', type: 'button', onclick: go }, 'Continue'),
  ));
}

async function boot() {
  if (window.BIDSWIPE_DEMO) return startDemo(window.BIDSWIPE_DEMO);
  if (new URLSearchParams(location.search).has('demo')) return startDemo(await (await fetch('demo-data.json')).json());
  state.accessCode ??= store.get('bidswipe:code');
  try {
    await api.load();
    state.mode = 'live';
    render();
  } catch (err) {
    if (err.code === 401) return renderGate(state.accessCode ? 'That code didn’t work — try again.' : undefined);
    if (err.status && err.status !== 404) {
      // The API is there but broken — never paper over that with demo data.
      $('#view').replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Server error'), h('p', {}, `The bid server answered ${err.status}. Try again in a minute.`)));
      return;
    }
    try {
      // No API (static hosting or opened as a file): fall back to the bundled snapshot.
      startDemo(await (await fetch('demo-data.json')).json());
    } catch {
      $('#view').replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Can’t reach the server'), h('p', {}, 'Check your connection and reload.')));
    }
  }
}

boot();
