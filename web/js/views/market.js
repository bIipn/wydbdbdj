// Market: price context around the company (or another ZIP): federal awards for similar jobs, the area
// wage, and national material price trends; the price watch; and the way into the cost check for a job
// that is not a listed bid. Every figure says where it is from and what it is not.

import { api } from '../api.js';
import { h, icon, ICONS, safeUrl } from '../dom.js';
import { clock, fmtDay } from '../format.js';
import { awardsView, blsDisclaimer, block, costCheckButton, failed, loadingLine, materialsView, notLoaded, wageView } from '../price.js';
import { onFeedLoaded, onSignedOut } from '../session.js';
import { registerView, render } from '../shell.js';
import { features, state } from '../state.js';

const ui = { zip: '', area: null, awards: null, areaErr: null, awardsErr: null, loadedFor: null, zipError: '', watch: null, watchErr: null, watchAsked: false };
const reset = () => Object.assign(ui, { zip: '', area: null, awards: null, areaErr: null, awardsErr: null, loadedFor: null, zipError: '', watch: null, watchErr: null, watchAsked: false });
onSignedOut(reset);
onFeedLoaded(() => { ui.loadedFor = null; }); // a settings save can move the base: load again next time

async function load() {
  const zip = ui.zip;
  ui.loadedFor = zip;
  Object.assign(ui, { area: null, awards: null, areaErr: null, awardsErr: null });
  const [area, awards] = await Promise.allSettled([api.marketArea(zip || undefined), api.marketAwards(zip ? { zip } : {})]);
  if (ui.loadedFor !== zip) return; // another ZIP was asked for meanwhile
  if (area.status === 'fulfilled') ui.area = area.value; else ui.areaErr = area.reason;
  if (awards.status === 'fulfilled') ui.awards = awards.value; else ui.awardsErr = awards.reason;
  if (state.view === 'market') render();
}

function zipForm() {
  const input = h('input', {
    class: 'input zip', type: 'text', inputmode: 'numeric', maxlength: '5', placeholder: 'ZIP', 'aria-label': 'Another ZIP code',
    value: ui.zip, autocomplete: 'postal-code',
  });
  const form = h('form', { class: 'market-zip', novalidate: true },
    input,
    h('button', { class: 'chip', type: 'submit' }, 'Look up'),
    ui.zip ? h('button', { class: 'chip', type: 'button', onclick: () => { ui.zip = ''; ui.zipError = ''; load(); render(); } }, 'My area') : null,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!/^\d{5}$/.test(v)) { ui.zipError = 'Type a 5-digit ZIP code.'; return render(); }
    ui.zipError = '';
    ui.zip = v;
    load();
    render();
  });
  return form;
}

// ---------------------------------------------------------- price watch ---

async function loadWatch() {
  ui.watchAsked = true;
  try {
    ui.watch = await api.marketWatch();
  } catch (err) {
    ui.watchErr = err;
  }
  if (state.view === 'market') render();
}

const when = (iso) => { const d = new Date(iso); return `${fmtDay.format(d)} · ${clock(d)}`; };
const TAG = 'Daily check';

/** GET /api/market/watch: what the daily price watch looks at, and when it last ran and runs next. */
function priceWatch() {
  if (features()?.priceAlerts !== true || ui.watchErr?.status === 402 || ui.watch?.locked) {
    return block('Price watch', TAG,
      h('div', { class: 'pc-locked' }, icon(ICONS.lock),
        h('div', {}, h('strong', {}, 'Price watch is part of BidSwipe Pro'),
          h('p', {}, 'It checks material price indexes and federal award results once a day and tells you when they move.'))));
  }
  if (!ui.watchAsked) loadWatch();
  if (ui.watchErr?.status === 404) return block('Price watch', TAG, h('div', { class: 'pc-empty' }, h('strong', {}, 'Off on this server'), h('p', {}, 'This server does not run the daily price watch yet.')));
  if (ui.watchErr) return block('Price watch', TAG, failed(ui.watchErr));
  if (!ui.watch) return block('Price watch', TAG, loadingLine());
  const w = ui.watch;
  const times = h('p', { class: 'pc-fine' },
    w.lastRefreshAt ? `Last checked ${when(w.lastRefreshAt)}` : 'Not checked yet',
    w.nextRefreshAt ? ` · next ${when(w.nextRefreshAt)}` : '',
    w.lastCheckOk === false ? ' · the last check did not finish; alerts resume with the next one' : '');
  if (!w.enabled) {
    return block('Price watch', TAG,
      h('div', { class: 'pc-empty' }, h('strong', {}, 'Price watch is not scheduled'),
        h('p', {}, 'This server has no daily market check set up, so no price or award alerts are sent yet.')),
      times);
  }
  const series = w.series ?? [];
  const saved = w.savedBids ?? 0;
  const matched = w.awardsWatched ?? 0;
  return block('Price watch', TAG,
    h('p', { class: 'pc-scope' }, `Watching ${series.length} price series, checked once a day. When a new figure comes out and has moved enough to matter, you get an alert.`),
    series.length ? h('ul', { class: 'pc-mats' }, series.map((s) => h('li', {},
      h('div', { class: 'pc-mat-name' },
        h('strong', {}, s.title),
        h('small', {},
          s.periodLabel ? `${s.periodLabel}${s.preliminary ? ' (preliminary)' : ''}${s.previousPeriod ? ` vs ${s.previousPeriod}` : ''} · ` : 'No figure stored yet · ',
          s.sourceUrl ? h('a', { class: 'src-link', href: safeUrl(s.sourceUrl), target: '_blank', rel: 'noopener noreferrer' }, s.source) : s.source)),
      s.changePct == null
        ? h('span', { class: 'pc-chg none' }, h('small', {}, 'change'), '—')
        : h('span', { class: `pc-chg ${s.changePct > 0 ? 'up' : s.changePct < 0 ? 'down' : 'flat'}` }, h('small', {}, 'change'), `${s.changePct > 0 ? '+' : ''}${Number(s.changePct).toFixed(1)}%`),
    ))) : notLoaded('No price figures are stored yet; they arrive with the first daily check.'),
    h('p', { class: 'pc-scope' }, saved
      ? `Award results: ${matched} of your ${saved} saved bid${saved === 1 ? '' : 's'} can be matched to a federal award (only SAM.gov notices carry the solicitation number the award record uses).`
      : 'Award results: save a federal (SAM.gov) bid and you get its award result here when it is posted.'),
    w.nearby ? h('p', { class: 'pc-fine' }, `Also watched: new federal awards in your main trade codes within ${w.nearby.radiusMi} mi. Award notices come after the opening; bids are sealed until then.`) : null,
    times,
  );
}

function renderMarket() {
  if (ui.loadedFor === null || ui.loadedFor !== ui.zip) load();
  const label = ui.area?.area?.label ?? (ui.zip ? `ZIP ${ui.zip}` : state.profile?.base ?? 'your area');
  const zipErr = ui.areaErr?.code === 'zip_not_found' ? 'We don’t know that ZIP code.' : ui.zipError;

  const awards = ui.awardsErr ? block('Similar federal jobs', 'Federal awards', failed(ui.awardsErr))
    : ui.awards ? awardsView(ui.awards, { recent: 10 }) : block('Similar federal jobs', 'Federal awards', loadingLine());
  const wage = ui.areaErr ? block('Area wage', 'Published BLS wage', failed(ui.areaErr))
    : ui.area ? wageView(ui.area) : block('Area wage', 'Published BLS wage', loadingLine());
  const mats = ui.areaErr ? null : ui.area ? materialsView(ui.area) : block('Material prices', 'National · monthly index', loadingLine());

  return h('div', { class: 'market' },
    h('div', { class: 'market-head' },
      h('div', {}, h('p', { class: 'eyebrow' }, 'Prices around'), h('h2', {}, label)),
      zipForm(),
      zipErr ? h('p', { class: 'field-error' }, zipErr) : null,
    ),
    costCheckButton(null, { card: true }),
    h('p', { class: 'pc-intro' }, 'Public records to sanity-check your numbers: what similar federal jobs were awarded at, what the trade earns here, and which way material prices are moving.'),
    h('div', { class: 'price-check market-blocks' },
      awards,
      wage,
      mats,
      block('Prevailing wage', 'Public jobs', h('p', { class: 'pc-scope' }, 'Whether prevailing wage applies depends on the job: open a bid and see its Price check. The wage determination in the bid documents controls.')),
      priceWatch(),
      ui.area ? blsDisclaimer(ui.area) : null,
    ),
  );
}

registerView('market', { chrome: 'tabs', render: renderMarket });
