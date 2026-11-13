// The cost check (premium): a bid price from the contractor's own numbers, the cash they would carry, whether
// it fits their limits, and every public figure behind it. Opened from a bid's detail sheet or from Market
// ("price a job" that is not a listed bid). Plans without the estimator, and the server-less demo, get a
// card that says what it does and that it is part of BidSwipe Pro: no numbers, no code box.

import { api } from '../api.js';
import { $, h, icon, ICONS, safeUrl } from '../dom.js';
import { clearErrors, formError, showErrors } from '../form.js';
import { holds, jobCard, newDraft, question, quickCard, requestFrom, SECTIONS, sectionBody, sectionFor } from '../cost-form.js';
import { fmtSaved, resultView } from '../cost-result.js';
import { usd } from '../money.js';
import { onSignedOut } from '../session.js';
import { closeSheet, openSheet } from '../sheet.js';
import { onAfterRender, registerView, render, setView } from '../shell.js';
import { features, isLive, state } from '../state.js';

const ui = {
  ctx: null, // { bid, back }
  drafts: new Map(), // per bid id ('' = a job that is not a listed bid): typing survives going back
  result: null, savedAt: null, busy: false, errors: null, formError: '', open: new Set(),
  saved: null, savedErr: null, hints: {}, locked: false, scrollTo: null,
};
onSignedOut(() => Object.assign(ui, { ctx: null, drafts: new Map(), result: null, savedAt: null, errors: null, formError: '', open: new Set(), saved: null, savedErr: null, hints: {}, locked: false }));

const draftKey = () => ui.ctx?.bid?.id ?? '';
const draft = () => ui.drafts.get(draftKey());

/** Open the cost check for a bid (from its sheet) or for a job that is not listed (bid = null, from Market). */
export function openCostCheck(bid, back = state.view) {
  ui.ctx = { bid, back };
  Object.assign(ui, { result: null, savedAt: null, errors: null, formError: '', saved: null, savedErr: null, hints: {}, scrollTo: null, open: new Set() });
  ui.locked = !allowed();
  if (!ui.locked && !ui.drafts.has(draftKey())) ui.drafts.set(draftKey(), newDraft({ profile: state.me?.profile ?? null, bid }));
  setView('cost');
  if (!ui.locked) { loadSaved(); loadHints(); }
}

/** The plan includes the estimator, and there is a server to run it. */
const allowed = () => isLive() && features()?.estimator === true;

// ------------------------------------------------------------- loading --

async function loadSaved() {
  const bidId = ui.ctx?.bid?.id ?? null;
  try {
    const res = await api.estimates(bidId);
    if ((ui.ctx?.bid?.id ?? null) !== bidId) return;
    ui.saved = res.items.filter((e) => (bidId ? e.bidId === bidId : e.bidId == null));
  } catch (err) {
    if (err.status === 402) ui.locked = true;
    else ui.savedErr = err.message || 'Couldn’t load saved checks.';
  }
  if (state.view === 'cost') render();
}

const fmtMonth = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const month = (s) => (s ? fmtMonth.format(new Date(`${s.slice(0, 10)}T12:00:00Z`)) : '');
const dollars = (v) => `$${Math.round(v).toLocaleString('en-US')}`; // public figures in whole dollars, display only
const APPLIES = { likely: 'Likely', normally_not: 'Normally not', depends: 'Depends', unknown: 'Unknown' };

/** Reference figures from public data, shown beside the inputs (never typed into them). */
async function loadHints() {
  const bid = ui.ctx?.bid ?? null;
  const zip = /^\d{5}$/.test(bid?.location?.zip ?? '') ? bid.location.zip : undefined;
  const mine = ui.ctx;
  const [area, awards, pw] = await Promise.allSettled([
    api.marketArea(zip),
    api.marketAwards(bid ? { bidId: bid.id } : {}),
    bid ? api.prevailing(bid.id) : Promise.resolve(null),
  ]);
  if (ui.ctx !== mine) return;
  const hints = {};
  const w = area.status === 'fulfilled' ? area.value.wages?.find((x) => x.primary) : null;
  if (w?.median != null) {
    hints.wage = { tag: 'Published wage', text: `${w.occupation}: median $${Number(w.median).toFixed(2)}/hr, ${w.areaName}, ${w.periodLabel}. Not a prevailing wage.`, source: w.source, url: w.sourceUrl };
  }
  const a = awards.status === 'fulfilled' ? awards.value : null;
  if (a && !a.notLoaded) {
    const dates = a.dateRange ? `${month(a.dateRange.from)} – ${month(a.dateRange.to)}` : '';
    const src = a.source?.name ?? 'USAspending.gov';
    if (a.locked) {
      const n = a.stats?.count ?? 0;
      hints.awards = { tag: 'Federal awards', text: `${n} similar federal award${n === 1 ? '' : 's'} on record${dates ? `, ${dates}` : ''}. Their prices are part of BidSwipe Pro.`, source: src, url: a.source?.url };
    } else if (a.enough && a.stats?.median != null) {
      hints.awards = { tag: 'Federal awards', text: `Similar federal jobs: median ${dollars(a.stats.median)}, middle half ${dollars(a.stats.p25)}–${dollars(a.stats.p75)} (${a.stats.count} awards${dates ? `, ${dates}` : ''}). Not a quote for this job.`, source: src, url: a.source?.url };
    }
  }
  const p = pw.status === 'fulfilled' ? pw.value : null;
  if (p?.headline) {
    const link = p.links?.[0];
    hints.prevailing = { tag: `Prevailing wage: ${APPLIES[p.applies] ?? p.applies}`, text: `${p.headline}${p.edition ? ` (${p.edition})` : ''}`, source: link?.label, url: link?.url };
  }
  ui.hints = hints;
  if (state.view === 'cost') render();
}

function hintNode(x) {
  if (!x) return null;
  return h('div', { class: 'ref-hint' },
    h('span', { class: 'ref-tag' }, x.tag),
    h('p', {}, x.text),
    x.source ? h('p', { class: 'ref-src' }, 'Source: ', x.url ? h('a', { class: 'src-link', href: safeUrl(x.url), target: '_blank', rel: 'noopener noreferrer' }, x.source) : x.source) : null);
}

// ----------------------------------------------------------------- run --

/** The API's [{ path, message }] → { path: "message message" } for showErrors(). */
function fieldMap(list) {
  const out = {};
  for (const f of list ?? []) out[f.path] = out[f.path] ? `${out[f.path]} ${f.message}` : f.message;
  return out;
}

async function run() {
  if (ui.busy) return;
  const d = draft();
  ui.busy = true;
  ui.formError = '';
  ui.errors = null;
  render();
  try {
    const res = await api.estimate(requestFrom(d));
    ui.result = res;
    ui.savedAt = res.savedAt;
    for (const n of res.needed ?? []) ui.open.add(sectionFor(n.field, d));
    ui.saved = [{ id: res.id, bidId: res.bidId, createdAt: res.savedAt, result: res }, ...(ui.saved ?? [])];
    ui.scrollTo = '#ccResult';
  } catch (err) {
    if (err.status === 402) ui.locked = true;
    else if (err.status === 400 && err.body?.fields?.length) {
      ui.errors = fieldMap(err.body.fields);
      for (const p of Object.keys(ui.errors)) ui.open.add(sectionFor(p, d));
      ui.scrollTo = 'error';
    } else {
      // Engine refusals name internal variables and units: never show them raw to a contractor.
      ui.formError = err.status === 400
        ? (err.body?.code === 'OUT_OF_RANGE'
          ? 'One of the numbers is larger than the cost check can handle. Check the labor hours and the amounts.'
          : 'The cost check could not use these numbers. Check the amounts and dates, then try again.')
        : (err.message || 'That did not run. Try again.');
      ui.scrollTo = 'error';
    }
  }
  ui.busy = false;
  render();
}

/** From a "needed" question: open its section and bring its field into view. */
function jump(sec, path) {
  if (sec !== 'job' && sec !== 'quick' && sec !== 'range') ui.open.add(sec);
  ui.scrollTo = { sec, path };
  render();
}

// -------------------------------------------------------------- render --

function header(title) {
  const back = () => {
    const bid = ui.ctx?.bid;
    setView(ui.ctx?.back && ui.ctx.back !== 'cost' ? ui.ctx.back : 'swipe');
    if (bid) openSheet(bid);
  };
  return h('header', { class: 'screen-head' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': ui.ctx?.bid ? 'Back to the bid' : 'Back to Market', onclick: back }, icon(ICONS.back)),
    h('h1', {}, title),
    h('span', { class: 'icon-btn ghost', 'aria-hidden': 'true' }),
  );
}

function lockedCard() {
  const demo = state.mode !== 'live';
  return h('section', { class: 'panel cc-lock' },
    h('div', { class: 'cc-lock-head' }, icon(ICONS.lock), h('h2', {}, 'Cost check')),
    h('p', {}, 'Turn your crew hours, wage, supplier quotes and markups into a bid price. It shows how the price builds up, the cash you would carry before the owner pays, whether the job fits your limits, and every public figure behind the number.'),
    h('p', {}, 'It never guesses: anything it needs and does not have, it asks for.'),
    h('p', { class: 'cc-lock-pro' }, 'The cost check is part of BidSwipe Pro.'),
    demo ? h('p', { class: 'pc-fine' }, 'This demo runs without a server, so it cannot run a cost check.') : null,
  );
}

/** "needed" entries for one section, as questions at the top of it. */
function asksFor(sec, d) {
  const needed = (ui.result?.needed ?? []).filter((n) => sectionFor(n.field, d) === sec);
  if (!needed.length) return null;
  return h('ul', { class: 'cc-asks' }, needed.map((n) => h('li', {},
    h('span', {}, question(n, d)), h('span', { class: `cc-holds for-${n.for}` }, holds(n.for)))));
}

/** Mark the boxes the engine is waiting for. */
function markNeeded(root, d) {
  for (const n of ui.result?.needed ?? []) {
    let key = n.field;
    while (key) {
      const el = root.querySelector(`[data-field="${CSS.escape(key)}"]`);
      if (el) { el.classList.add('is-needed'); break; }
      key = key.includes('.') ? key.slice(0, key.lastIndexOf('.')) : '';
    }
  }
}

function savedList() {
  if (ui.savedErr) return h('p', { class: 'pc-fine warn' }, ui.savedErr);
  if (!ui.saved) return h('p', { class: 'pc-loading' }, 'Loading saved checks…');
  if (!ui.saved.length) return h('p', { class: 'field-help' }, ui.ctx?.bid ? 'No saved checks for this bid yet. Each run is saved here.' : 'No saved checks yet. Each run is saved here.');
  return h('ul', { class: 'cc-saved' }, ui.saved.map((e) => {
    const on = ui.savedAt === e.createdAt && ui.result?.id === e.id;
    const n = e.result?.needed?.length ?? 0;
    return h('li', {}, h('button', {
      type: 'button', class: `cc-saved-row${on ? ' is-on' : ''}`, 'aria-pressed': String(on),
      onclick: () => { ui.result = { ...e.result, id: e.id }; ui.savedAt = e.createdAt; ui.scrollTo = '#ccResult'; render(); },
    },
    h('span', {}, h('strong', {}, fmtSaved(e.createdAt)), h('small', {}, e.result?.total != null ? (n ? `${n} answer${n === 1 ? '' : 's'} still open` : 'Complete') : `No price · ${n} answer${n === 1 ? '' : 's'} needed`)),
    h('span', { class: 'cc-amt' }, e.result?.total != null ? usd(e.result.total) : '—')));
  }));
}

function renderCost() {
  const bid = ui.ctx?.bid ?? null;
  if (ui.locked || !allowed()) {
    return h('div', { class: 'screen cost' }, header('Cost check'), bid ? h('p', { class: 'cc-for' }, bid.title) : null, lockedCard());
  }
  const d = draft();
  if (!d) return h('div', { class: 'screen cost' }, header('Cost check'), h('div', { class: 'empty' }, h('p', {}, 'Open a bid and tap Cost check.')));

  const rerender = () => render();
  const runBtn = h('button', { class: 'cta', type: 'submit', disabled: ui.busy }, ui.busy ? 'Pricing…' : ui.result ? 'Price it again' : 'Price it');
  const panel = (sec, title, body, sub) => h('section', { class: 'panel cc-panel' },
    h('div', { class: 'cc-panel-head' }, h('h2', { class: 'panel-title' }, title), sub ? h('span', { class: 'cc-panel-sub' }, sub) : null),
    asksFor(sec, d), body);

  const sections = SECTIONS.map((s) => {
    const count = (ui.result?.needed ?? []).filter((n) => sectionFor(n.field, d) === s.id).length;
    const det = h('details', { class: 'panel cc-sec', 'data-sec': s.id, open: ui.open.has(s.id) },
      h('summary', {},
        h('span', { class: 'cc-sec-text' }, h('strong', {}, s.title), h('small', {}, s.blurb)),
        count ? h('span', { class: 'cc-sec-badge' }, `${count} to answer`) : h('span', { class: 'optional' }, 'optional')),
      h('div', { class: 'cc-sec-body' }, asksFor(s.id, d), sectionBody(s.id, d, { bid, rerender, profile: state.me?.profile ?? null, result: ui.result })));
    det.addEventListener('toggle', () => { if (det.open) ui.open.add(s.id); else ui.open.delete(s.id); });
    return det;
  });

  const form = h('form', { class: 'cc-form', novalidate: true },
    panel('job', 'The job', jobCard(d, { bid, hints: { prevailing: hintNode(ui.hints.prevailing), awards: hintNode(ui.hints.awards) }, rerender })),
    panel('quick', 'Quick price', quickCard(d, { hints: { wage: hintNode(ui.hints.wage) }, rerender }), 'one tap'),
    h('p', { class: 'section-title' }, 'More detail'),
    ...sections,
    formError(),
    h('div', { class: 'save-bar' }, runBtn),
  );
  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  markNeeded(form, d);
  if (ui.errors) showErrors(form, ui.errors);
  else clearErrors(form);
  if (ui.formError) showErrors(form, { form: ui.formError });

  return h('div', { class: 'screen cost' },
    header('Cost check'),
    h('div', { class: 'cc-intro' },
      h('p', { class: 'eyebrow' }, bid ? 'Pricing this bid' : 'Pricing a job that is not listed'),
      h('p', { class: 'cc-for' }, bid ? bid.title : 'Your own job: type its numbers below.'),
      h('p', { class: 'pc-fine' }, 'Your numbers, the dated public tables, and nothing guessed. Bids are sealed: nobody sees a competitor’s price before the opening.'),
    ),
    form,
    ui.result ? resultView(ui.result, d, { jump, savedAt: ui.savedAt }) : null,
    h('section', { class: 'cc-saved-wrap' }, h('h2', { class: 'section-title' }, bid ? 'Saved checks for this bid' : 'Saved checks'), savedList()),
  );
}

registerView('cost', { chrome: 'screen', render: renderCost });

// The buttons in the bid sheet and on Market (price.js) ask for the screen with this event.
window.addEventListener('bidswipe:cost', (e) => {
  closeSheet();
  openCostCheck(e.detail?.bid ?? null, state.view === 'cost' ? 'swipe' : state.view);
});

// Scroll after the page is drawn: to the result, to the first error, or to a field a question points at.
onAfterRender((view) => {
  if (view !== 'cost' || !ui.scrollTo) return;
  const target = ui.scrollTo;
  ui.scrollTo = null;
  requestAnimationFrame(() => {
    let el = null;
    if (target === 'error') el = $('#view .has-error');
    else if (typeof target === 'string') el = $(target);
    else {
      let key = target.path;
      while (key && !el) {
        el = $(`#view [data-field="${CSS.escape(key)}"]`);
        key = key.includes('.') ? key.slice(0, key.lastIndexOf('.')) : '';
      }
      el ??= $(`#view [data-sec="${target.sec}"]`) ?? $('#view .cc-form');
    }
    el?.scrollIntoView({ block: el.id === 'ccResult' ? 'start' : 'center', behavior: 'smooth' });
    const input = el?.matches?.('.field, [data-field]') ? el.querySelector('input, select') : null;
    input?.focus({ preventScroll: true });
  });
});
