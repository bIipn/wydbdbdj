// Market: price context around the company (or another ZIP): federal awards for similar jobs, the area
// wage, and national material price trends. Every figure says where it is from and what it is not.

import { api } from '../api.js';
import { h } from '../dom.js';
import { awardsView, blsDisclaimer, block, costCheckStub, failed, loadingLine, materialsView, wageView } from '../price.js';
import { onFeedLoaded, onSignedOut } from '../session.js';
import { registerView, render } from '../shell.js';
import { state } from '../state.js';

const ui = { zip: '', area: null, awards: null, areaErr: null, awardsErr: null, loadedFor: null, zipError: '' };
const reset = () => Object.assign(ui, { zip: '', area: null, awards: null, areaErr: null, awardsErr: null, loadedFor: null, zipError: '' });
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
    h('p', { class: 'pc-intro' }, 'Public records to sanity-check your numbers: what similar federal jobs were awarded at, what the trade earns here, and which way material prices are moving.'),
    h('div', { class: 'price-check market-blocks' },
      awards,
      wage,
      mats,
      block('Prevailing wage', 'Public jobs', h('p', { class: 'pc-scope' }, 'Whether prevailing wage applies depends on the job: open a bid and see its Price check. The wage determination in the bid documents controls.')),
      costCheckStub(),
      ui.area ? blsDisclaimer(ui.area) : null,
    ),
  );
}

registerView('market', { chrome: 'tabs', render: renderMarket });
