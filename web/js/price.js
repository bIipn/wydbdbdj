// The price check: what similar federal jobs were awarded for, the area wage, material price trends,
// the prevailing-wage hint for a public job, and the way into the cost check.
// Shared by the bid detail sheet and the Market view. Every figure keeps its source, period and level;
// an index is never shown as a dollar price, and a BLS wage is never called a prevailing wage.

import { api } from './api.js';
import { h, icon, ICONS, safeUrl } from './dom.js';
import { money } from './format.js';
import { features } from './state.js';

const usd = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
const hourly = (v) => (v == null ? '—' : `$${Number(v).toFixed(2)}`);
const fmtDate = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
/** "2026-09-23" → "Sep 2026" (or "Sep 23, 2026" with `day`). */
const ymd = (s, day = false) => (s ? (day ? fmtDay : fmtDate).format(new Date(`${s.slice(0, 10)}T12:00:00Z`)) : '');

const sourceLink = (label, url) => h('a', { class: 'src-link', href: safeUrl(url), target: '_blank', rel: 'noopener noreferrer' }, label);

/** A titled block. `tag` is a short label on the right (e.g. "National · monthly"). */
export function block(title, tag, ...body) {
  return h('section', { class: 'pc-block' },
    h('div', { class: 'pc-head' }, h('h3', {}, title), tag ? h('span', { class: 'pc-tag' }, tag) : null),
    ...body,
  );
}

/** Data we have never pulled: said plainly, never a blank or a zero. */
export const notLoaded = (text) => h('div', { class: 'pc-empty' }, h('strong', {}, 'Not loaded yet'), h('p', {}, text));

export const loadingLine = () => h('p', { class: 'pc-loading' }, 'Loading…');

export function failed(err) {
  return h('div', { class: 'pc-empty' }, h('strong', {}, 'Couldn’t load this'), h('p', {}, err?.message || 'Check your connection and try again.'));
}

/** Fill `slot` with what `load()` returns, drawn by `draw(data)`; a load error is said in the slot. */
export async function fill(slot, load, draw) {
  slot.replaceChildren(loadingLine());
  let node;
  try {
    node = draw(await load());
  } catch (err) {
    node = failed(err);
  }
  slot.replaceChildren(node); // a slot the sheet already dropped is simply never seen
}

// ------------------------------------------------------------ awards ---

/** The p25–p75 band inside the min–max span, on a square-root scale so one huge award does not flatten it. */
function rangeBar(s) {
  const f = (v) => Math.sqrt(Math.max(0, v - s.min));
  const span = f(s.max) || 1;
  const pct = (v) => `${((f(v) / span) * 100).toFixed(1)}%`;
  const bar = h('div', { class: 'pc-bar', 'aria-hidden': 'true' },
    h('span', { class: 'pc-bar-iqr' }),
    h('span', { class: 'pc-bar-mid' }),
  );
  bar.style.setProperty('--lo', pct(s.p25));
  bar.style.setProperty('--hi', pct(s.p75));
  bar.style.setProperty('--mid', pct(s.median));
  return h('div', { class: 'pc-range' },
    bar,
    h('div', { class: 'pc-range-scale' }, h('span', {}, `Low ${money(s.min)}`), h('span', {}, `High ${money(s.max)}`)),
  );
}

function awardRow(a) {
  const amount = a.priceAtAward ?? null;
  return h('li', { class: `pc-award${a.inStats ? '' : ' out'}` },
    h('div', {},
      h('strong', {}, a.recipient ?? 'Recipient not listed'),
      h('small', {}, [a.agency, [a.city, a.state].filter(Boolean).join(', '), ymd(a.actionDate, true)].filter(Boolean).join(' · ')),
    ),
    h('div', { class: 'pc-award-amt' },
      h('strong', {}, amount != null ? money(amount) : '—'),
      h('small', {}, a.inStats ? 'at signing' : 'not in range'),
    ),
  );
}

/**
 * GET /api/market/awards. `recent` = how many of the newest awards to list (0 = none).
 * States: not loaded (no count at all), locked (count only), too few for a range, the range.
 */
export function awardsView(d, { recent = 5 } = {}) {
  const dates = d.dateRange ? `${ymd(d.dateRange.from)} – ${ymd(d.dateRange.to)}` : null;
  const naics = d.scope?.naics?.length ? `NAICS ${d.scope.naics.join(', ')}` : null;
  const src = h('p', { class: 'pc-source' },
    'Source: ', sourceLink(d.source?.name ?? 'USAspending.gov', d.source?.url),
    d.asOf ? ` · pulled ${ymd(d.asOf, true)}` : '',
    naics ? ` · ${naics}` : '',
  );
  const caveat = d.source?.note ? h('p', { class: 'pc-fine' }, d.source.note) : null;

  if (d.notLoaded || (d.stats?.count == null && !d.locked)) {
    return block('Similar federal jobs', 'Federal awards', notLoaded(d.summary), src);
  }

  if (d.locked) {
    const n = d.stats?.count ?? 0;
    return block('Similar federal jobs', 'Federal awards',
      h('p', { class: 'pc-count' }, h('b', {}, String(n)), ` federal award${n === 1 ? '' : 's'} ${d.scope?.label ?? ''}${dates ? `, ${dates}` : ''}`),
      h('div', { class: 'pc-locked' }, icon(ICONS.lock),
        h('div', {}, h('strong', {}, 'Award prices are a Pro feature'),
          h('p', {}, 'Pro shows the price range these jobs were awarded at, the median, and the newest awards. Free shows how many there are.'))),
      src,
    );
  }

  const s = d.stats;
  const body = [];
  if (d.enough && s?.median != null) {
    body.push(
      h('div', { class: 'pc-big' },
        h('div', {}, h('span', { class: 'pc-label' }, 'Median at award'), h('strong', {}, usd(s.median))),
        h('div', {}, h('span', { class: 'pc-label' }, 'Middle half'), h('strong', { class: 'pc-mid' }, `${money(s.p25)}–${money(s.p75)}`)),
      ),
      rangeBar(s),
      h('p', { class: 'pc-scope' }, `Based on ${s.count} federal awards ${d.scope?.label ?? ''}${dates ? `, signed ${dates}` : ''}.`),
    );
  } else {
    body.push(h('p', { class: 'pc-scope' }, d.summary));
  }
  body.push(h('p', { class: 'pc-fine' }, `Price at award = ${lowerFirst(d.amountLabel ?? '')}`));
  if (d.excludedNoPrice) body.push(h('p', { class: 'pc-fine' }, `${d.excludedNoPrice} award${d.excludedNoPrice === 1 ? '' : 's'} in this area had no usable amount and ${d.excludedNoPrice === 1 ? 'is' : 'are'} left out.`));
  const missing = [...(d.scope?.coverage?.missingStates ?? [])];
  if (missing.length) body.push(h('p', { class: 'pc-fine warn' }, `Not loaded for ${missing.join(', ')}: awards there are not counted.`));
  if (recent && d.recent?.length) {
    body.push(h('details', { class: 'pc-more' },
      h('summary', {}, `Newest ${Math.min(recent, d.recent.length)} awards`),
      h('ul', { class: 'pc-awards' }, d.recent.slice(0, recent).map(awardRow)),
    ));
  }
  return block('Similar federal jobs', 'Federal awards', ...body, src, caveat);
}

const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

// -------------------------------------------------------------- wage ---

const LEVEL = { metro: 'metro area', nonmetro: 'nonmetro area', state: 'state', nation: 'national' };

function wageCard(w) {
  return h('div', { class: 'pc-wage' },
    h('div', { class: 'pc-wage-head' },
      h('div', {}, h('strong', {}, w.areaName), h('small', {}, `${LEVEL[w.level] ?? w.level} · ${w.periodLabel}`)),
      h('div', { class: 'pc-wage-fig' }, h('strong', {}, `${hourly(w.median)}/hr`), h('small', {}, 'median')),
    ),
    h('p', { class: 'pc-wage-line' },
      `Middle half ${hourly(w.p25)}–${hourly(w.p75)} · mean ${hourly(w.mean)}`,
      w.employment != null ? ` · about ${Math.round(w.employment).toLocaleString('en-US')} jobs (BLS estimate)` : '',
    ),
    w.cautions?.length ? h('ul', { class: 'pc-cautions' }, w.cautions.map((c) => h('li', {}, c))) : null,
    h('p', { class: 'pc-source' }, 'Source: ', sourceLink(w.source, w.sourceUrl)),
  );
}

/** Area wage from GET /api/market/area. `others` = also list the metro and national figures. */
export function wageView(d, { others = true } = {}) {
  const wages = d.wages ?? [];
  const primary = wages.find((w) => w.primary);
  const tag = 'Published BLS wage';
  if (!primary) {
    const why = (d.missing ?? []).filter((m) => !/material/i.test(m)).join(' ') || 'No wage data has been loaded yet.';
    return block('Area wage', tag, notLoaded(why));
  }
  const rest = wages.filter((w) => !w.primary);
  const notes = (d.missing ?? []).filter((m) => !/material/i.test(m));
  return block(`Area wage · ${primary.occupation}`, tag,
    h('p', { class: 'pc-warn' }, 'Not a prevailing wage and not a loaded rate. A public job may require prevailing wage.'),
    wageCard(primary),
    ...notes.map((m) => h('p', { class: 'pc-fine warn' }, m)),
    others && rest.length ? h('details', { class: 'pc-more' }, h('summary', {}, `Other areas (${rest.length})`), rest.map(wageCard)) : null,
    d.notes?.wages ? h('details', { class: 'pc-more' }, h('summary', {}, 'About these figures'), h('p', { class: 'pc-fine' }, d.notes.wages)) : null,
  );
}

// --------------------------------------------------------- materials ---

function change(c, label) {
  if (!c) return h('span', { class: 'pc-chg none', title: `${label}: that month is not in the data` }, h('small', {}, label), '—');
  const dir = c.pct > 0 ? 'up' : c.pct < 0 ? 'down' : 'flat';
  return h('span', { class: `pc-chg ${dir}`, title: `${label}: from ${c.from.periodLabel}` }, h('small', {}, label), `${c.pct > 0 ? '+' : ''}${c.pct.toFixed(1)}%`);
}

/** Material price trends: national monthly indexes (never dollar prices). */
export function materialsView(d) {
  const tag = 'National · monthly index';
  const mats = d.materials ?? [];
  if (mats.length === 0) return block('Material prices', tag, notLoaded('No material price indexes have been loaded yet.'));
  return block('Material prices', tag,
    h('p', { class: 'pc-warn' }, 'Price indexes, not dollar prices: they show how much prices moved, not what a part costs.'),
    h('ul', { class: 'pc-mats' }, mats.map((m) => h('li', {},
      h('div', { class: 'pc-mat-name' }, h('strong', {}, m.label),
        h('small', {}, m.latest ? `Index ${m.latest.value.toFixed(1)} · ${m.latest.periodLabel}${m.latest.preliminary ? ' (preliminary)' : ''}` : (m.note ?? 'Not loaded yet'))),
      m.latest ? h('div', { class: 'pc-chgs' }, change(m.change1m, '1 mo'), change(m.change3m, '3 mo'), change(m.change12m, '12 mo')) : null,
    ))),
    h('p', { class: 'pc-source' }, 'Source: ', sourceLink(mats[0].source, mats[0].sourceUrl), ' · national, no state or metro detail'),
    d.notes?.materials ? h('p', { class: 'pc-fine' }, d.notes.materials) : null,
  );
}

/** The BLS line every BLS figure carries. */
export const blsDisclaimer = (d) => (d.disclaimer ? h('p', { class: 'pc-fine' }, d.disclaimer) : null);

// -------------------------------------------------------- prevailing ---

const APPLIES = { likely: 'Likely', normally_not: 'Normally not', depends: 'Depends', unknown: 'Unknown' };

/** GET /api/market/prevailing: the cautious hint, worded by the server; we only lay it out. */
export function prevailingView(p) {
  return block('Prevailing wage', 'Public jobs',
    h('div', { class: `pc-pw ${p.applies}` },
      h('span', { class: 'pc-pw-tag' }, APPLIES[p.applies] ?? p.applies),
      h('strong', {}, p.headline),
    ),
    p.lines?.length ? h('ul', { class: 'pc-lines' }, p.lines.map((l) => h('li', {}, l))) : null,
    p.edition ? h('p', { class: 'pc-fine' }, `Table: ${p.edition}`) : null,
    p.links?.length ? h('p', { class: 'pc-source' }, p.links.map((l, i) => [i ? ' · ' : '', sourceLink(l.label, l.url)])) : null,
  );
}

// -------------------------------------------------------- cost check ---

/**
 * The way into the cost check (views/cost.js), for a bid or (bid = null) a job that is not listed. It fires an
 * event instead of importing the view: the view opens the detail sheet again on Back, and the sheet imports this.
 * A plan without the estimator still opens it: the screen says what it does and that it is part of Pro.
 */
export function costCheckButton(bid, { card = false } = {}) {
  const pro = features()?.estimator === true;
  const open = () => window.dispatchEvent(new CustomEvent('bidswipe:cost', { detail: { bid } }));
  const what = pro
    ? (bid ? 'Your hours, wage, quotes and markups to a bid price, the cash you would carry, and your limits.'
      : 'A job that is not a listed bid: your hours, wage, quotes and markups to a bid price, the cash you would carry, and your limits.')
    : 'Part of BidSwipe Pro: a bid price from your own numbers, the cash you would carry, and your limits.';
  const button = h('button', { class: `cta${card ? ' ghost' : ''}`, type: 'button', onclick: open },
    pro ? null : icon(ICONS.lock), bid ? 'Cost check: price this bid' : (card ? 'Open the cost check' : 'Cost check: price a job'));
  if (card) {
    return h('section', { class: 'pc-block cc-entry' },
      h('div', { class: 'pc-head' }, h('h3', {}, 'Cost check: price a job'), h('span', { class: 'pc-tag' }, pro ? 'Your numbers' : 'Pro')),
      h('p', { class: 'pc-scope' }, what),
      button);
  }
  return h('div', { class: 'pc-cost' }, button, h('p', { class: 'pc-fine' }, what));
}

// ------------------------------------------------------- bid sheet ---

/** The price check section for one bid in the detail sheet. Loads its three parts in parallel. */
export function priceCheck(item, openMarket) {
  const awards = h('div', {});
  const prevailing = h('div', {});
  const wage = h('div', {});
  fill(awards, () => api.marketAwards({ bidId: item.id }), (d) => awardsView(d, { recent: 5 }));
  fill(prevailing, () => api.prevailing(item.id), prevailingView);
  const zip = /^\d{5}$/.test(item.location?.zip ?? '') ? item.location.zip : undefined;
  fill(wage, () => api.marketArea(zip), (d) => wageView(d, { others: false }));
  return h('section', { class: 'price-check' },
    h('div', { class: 'pc-title' }, h('h2', {}, 'Price check'),
      openMarket ? h('button', { class: 'text-btn', type: 'button', onclick: openMarket }, 'Market →') : null),
    h('p', { class: 'pc-intro' }, 'Real public records to sanity-check a price. None of it is a quote for this job.'),
    costCheckButton(item),
    awards, prevailing, wage,
  );
}
