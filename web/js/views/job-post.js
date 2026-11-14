// Post a job (full screen). Title, what needs doing, trades, where, the private address and phone, how long
// bidding stays open, an optional ceiling, the licence notice, then a review card that shows exactly what
// bidders will see and the rules in three lines. "Post job" sends POST /api/jobs; its field errors land under
// their boxes (form.js showErrors).
//
// The form is built once per visit and kept: a live alert redraws the app, and rebuilding the boxes then would
// drop the cursor in the middle of a sentence. render() hands back the same element and puts the focus back.

import { api } from '../api.js';
import { h, icon, ICONS, showToast } from '../dom.js';
import { clearErrors, field, formError, moneyInput, showErrors, textInput } from '../form.js';
import { dollars, licenceLine, parseCents, whenShort } from '../job-words.js';
import { jobs, loadMine, loadRules, openJob } from '../jobs-data.js';
import { chip, homeSection, homeStateOf, loadTrades } from '../profile-form.js';
import { onSignedOut } from '../session.js';
import { onAfterRender, registerView, render, setView } from '../shell.js';
import { state } from '../state.js';
import { fieldsObject } from '../work-profile.js';

export const CLOSES_IN = [1, 3, 7, 14];
const CEILINGS = [null, 25_000, 50_000, 100_000, 250_000, 500_000];
const LIMITS = { title: { min: 8, max: 100 }, description: { min: 20, max: 2000 }, trades: 4, address: 200, phone: 20 };

const ui = { el: null, focus: null, busy: false, trades: null, back: 'jobs' };
onSignedOut(() => Object.assign(ui, { el: null, focus: null, busy: false }));

function newDraft() {
  const p = state.me?.profile;
  return {
    title: '', description: '', trades: [],
    zip: p?.zip ?? '', place: p?.zip ? { zip: p.zip, label: p.base } : null,
    address: '', phone: '', closesInDays: 7,
    ceiling: null, ceilingText: '', // ceiling: cents from a chip or the box; ceilingText: what the box shows
  };
}

/** Open the form, empty except the ZIP from the person's profile. */
export function openPostJob() {
  ui.back = state.view === 'job-post' ? ui.back : state.view;
  ui.el = null;
  ui.draft = newDraft();
  setView('job-post');
}

/** The POST /api/jobs body. A typed ceiling that is not a dollar amount is caught before sending. */
function bodyFrom(d) {
  const ceiling = d.ceilingText.trim() ? parseCents(d.ceilingText) : d.ceiling;
  return {
    title: d.title.trim(), description: d.description.trim(), trades: d.trades, zip: d.zip.trim(),
    address: d.address.trim() || null, phone: d.phone.trim() || null,
    budgetMaxCents: ceiling, closesInDays: d.closesInDays,
  };
}

/** A box with a character count on the label line. */
function counted(input, max) {
  const n = h('span', { class: 'wp-count' });
  const paint = () => { n.textContent = `${input.value.length} / ${max.toLocaleString('en-US')}`; };
  input.addEventListener('input', paint);
  paint();
  return n;
}

function build(d, trades, rules) {
  const review = h('div', { class: 'jp-review-body' });

  // ---- title and description
  const title = textInput({ value: d.title, maxlength: LIMITS.title.max, placeholder: 'e.g. Replace 6 outlets and a ceiling fan', enterkeyhint: 'next' });
  title.addEventListener('input', () => { d.title = title.value; });
  const desc = h('textarea', { class: 'input textarea', rows: 5, maxlength: LIMITS.description.max, placeholder: 'What needs doing, how big it is, and when you’d like it done.' }, d.description);
  desc.addEventListener('input', () => { d.description = desc.value; });
  const titleField = field({ key: 'title', label: 'Title', control: title });
  titleField.querySelector('.field-label').append(counted(title, LIMITS.title.max));
  const descField = field({
    key: 'description', label: 'What needs doing', control: desc,
    help: 'Good posts say what, how many, how big and when: “6 outlets, 1 fan, kitchen, any weekday”.',
  });
  descField.querySelector('.field-label').append(counted(desc, LIMITS.description.max));

  // ---- trades (up to 4)
  const tradeHelp = h('p', { class: 'field-help' }, 'Pick up to 4. People in these trades get an alert if it fits them.');
  const tradeChips = h('div', { class: 'trade-chips', role: 'group', 'aria-label': 'Trades' });
  const paintTrades = () => tradeChips.replaceChildren(...trades.map((t) => chip(t.label, d.trades.includes(t.id), () => {
    const on = d.trades.includes(t.id);
    if (!on && d.trades.length >= LIMITS.trades) { tradeHelp.textContent = 'Up to 4 trades. Tap one you picked to remove it first.'; return; }
    d.trades = on ? d.trades.filter((x) => x !== t.id) : [...d.trades, t.id];
    paintTrades();
  })));
  paintTrades();
  const tradesField = h('div', { class: 'field', 'data-field': 'trades' },
    h('p', { class: 'field-label' }, 'Trade'), tradeChips, tradeHelp, h('p', { class: 'field-error', role: 'alert' }));

  // ---- where (the ZIP box carries data-field="zip"), and the licence line for that state
  const licence = h('p', { class: 'jp-licence' });
  const paintLicence = () => { licence.textContent = licenceLine(homeStateOf(d)); };
  const where = homeSection(d, { radius: false, zipLabel: 'Job ZIP code', ownPlace: 'the job’s', onDone: () => { paintLicence(); paintReview(); } });
  paintLicence();
  where.addEventListener('input', () => { paintLicence(); paintReview(); });

  // ---- private: street address and phone
  const PRIVATE = 'Only the winner sees this, after the job is awarded.';
  const address = textInput({ value: d.address, maxlength: LIMITS.address, autocomplete: 'street-address', placeholder: '123 Main St' });
  address.addEventListener('input', () => { d.address = address.value; });
  const phone = textInput({ value: d.phone, type: 'tel', inputmode: 'tel', maxlength: LIMITS.phone, autocomplete: 'tel', placeholder: '(775) 555-0123' });
  phone.addEventListener('input', () => { d.phone = phone.value; });

  // ---- bidding closes in
  const closes = h('div', { class: 'trade-chips', role: 'group', 'aria-label': 'Bidding closes in' });
  const paintCloses = () => closes.replaceChildren(...CLOSES_IN.map((n) => chip(`${n} day${n === 1 ? '' : 's'}`, d.closesInDays === n, () => {
    d.closesInDays = n; paintCloses(); paintReview();
  })));
  paintCloses();
  const closesHelp = h('p', { class: 'field-help' });

  // ---- ceiling: chips or a typed amount
  const ceilChips = h('div', { class: 'trade-chips', role: 'group', 'aria-label': 'Budget ceiling' });
  const ceilBox = moneyInput({
    text: d.ceilingText, placeholder: 'Or type an amount', label: 'Budget ceiling in dollars',
    oninput: (v) => { d.ceilingText = v; paintCeil(); paintReview(); },
  });
  const paintCeil = () => {
    const typed = d.ceilingText.trim() !== '';
    ceilChips.replaceChildren(...CEILINGS.map((c) => chip(c === null ? 'No ceiling' : dollars(c), !typed && d.ceiling === c, () => {
      d.ceiling = c; d.ceilingText = ''; ceilBox.querySelector('input').value = ''; paintCeil(); paintReview();
    })));
  };
  paintCeil();

  // ---- the review card: exactly what bidders see, and the rules
  function paintReview() {
    const b = bodyFrom(d);
    const labels = trades.filter((t) => d.trades.includes(t.id)).map((t) => t.label);
    const closesAt = new Date(Date.now() + d.closesInDays * 864e5).toISOString();
    closesHelp.textContent = `Bidding would close ${whenShort(closesAt)}.`;
    const ceiling = Number.isSafeInteger(b.budgetMaxCents) ? `Ceiling ${dollars(b.budgetMaxCents)}` : Number.isNaN(b.budgetMaxCents) ? 'Ceiling: check the amount' : 'No ceiling';
    review.replaceChildren(
      h('div', { class: 'pills' }, h('span', { class: 'pill local' }, 'Local job'), labels.map((l) => h('span', { class: 'pill' }, l))),
      h('h3', { class: 'jp-review-title' }, b.title || 'Your title'),
      h('p', { class: 'jp-review-meta' }, icon(ICONS.pin), d.place ? `${d.place.label} ${d.zip}` : 'Where: add a ZIP'),
      h('p', { class: 'jp-review-meta' }, `Closes ${whenShort(closesAt)} · ${ceiling}`),
      h('p', { class: 'jp-review-desc' }, b.description || 'What needs doing shows here.'),
      h('p', { class: 'jp-review-private' }, icon(ICONS.lock), b.address || b.phone ? 'Address and phone: hidden until the award, then shown to the winner only.' : 'No address or phone added. You can share them in messages after the award.'),
    );
  }
  paintReview();
  for (const el of [title, desc]) el.addEventListener('input', paintReview);

  const contact = rules ? rules.contactDays : null;
  const ruleLines = h('ul', { class: 'jp-rules' },
    h('li', {}, 'Bids are sealed. You see how many there are, not the amounts, until bidding closes.'),
    h('li', {}, 'The lowest bid wins automatically when bidding closes.'),
    h('li', {}, contact ? `The winner has ${contact} days to contact you and work it out. You never owe a fee.` : 'The winner then has a few days to contact you and work it out.'),
  );

  const postBtn = h('button', { class: 'cta', type: 'submit' }, 'Post job');
  const form = h('form', { class: 'jp-form', novalidate: true },
    h('section', { class: 'panel' }, h('h2', { class: 'panel-title' }, 'The job'), h('div', { class: 'stack' }, titleField, descField, tradesField)),
    h('section', { class: 'panel' }, h('h2', { class: 'panel-title' }, 'Where'),
      h('div', { class: 'stack' },
        where,
        field({ key: 'address', label: 'Street address', optional: true, help: PRIVATE, control: address }),
        field({ key: 'phone', label: 'Phone', optional: true, help: PRIVATE, control: phone }))),
    h('section', { class: 'panel' }, h('h2', { class: 'panel-title' }, 'Bidding'),
      h('div', { class: 'stack' },
        h('div', { class: 'field', 'data-field': 'closesInDays' }, h('p', { class: 'field-label' }, 'Bidding closes in'), closes, closesHelp, h('p', { class: 'field-error', role: 'alert' })),
        h('div', { class: 'field', 'data-field': 'budgetMaxCents' },
          h('p', { class: 'field-label' }, 'Most you’d pay', h('span', { class: 'optional' }, 'optional')),
          ceilChips, ceilBox,
          h('p', { class: 'field-help' }, 'A bid above this is refused. Leave it at “No ceiling” if you’re not sure.'),
          h('p', { class: 'field-error', role: 'alert' })),
        licence)),
    h('section', { class: 'panel jp-review' }, h('h2', { class: 'panel-title' }, 'What bidders see'), review, ruleLines,
      h('p', { class: 'fine jp-fine' }, 'By posting you agree to the ', h('a', { class: 'fine-link', href: 'terms.html', target: '_blank', rel: 'noopener' }, 'Terms'), '.')),
    formError(),
    h('div', { class: 'save-bar' }, postBtn),
  );
  form.addEventListener('submit', (e) => { e.preventDefault(); if (!ui.busy) submit(form, postBtn); });
  return form;
}

async function submit(form, button) {
  clearErrors(form);
  const body = bodyFrom(ui.draft);
  if (Number.isNaN(body.budgetMaxCents)) {
    showErrors(form, { budgetMaxCents: 'Type the ceiling in dollars, like 750, or pick “No ceiling”.' })?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  ui.busy = true;
  button.disabled = true;
  button.textContent = 'Posting…';
  try {
    const { job } = await api.postJob(body);
    ui.busy = false;
    ui.el = null;
    loadMine();
    openJob(job.id, 'jobs');
    showToast('Posted. People nearby who fit get an alert.');
  } catch (err) {
    ui.busy = false;
    button.disabled = false;
    button.textContent = 'Post job';
    const fields = Array.isArray(err.body?.fields) ? fieldsObject(err.body.fields) : null;
    const shown = fields && Object.keys(fields).length ? fields
      : { form: err.code === 'too_many_attempts' ? 'You’ve posted a lot in the last hour. Try again later.' : err.message || 'That didn’t post. Try again.' };
    showErrors(form, shown)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function header() {
  return h('header', { class: 'screen-head' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', onclick: () => { ui.el = null; setView(ui.back === 'job-post' ? 'jobs' : ui.back); } }, icon(ICONS.back)),
    h('h1', {}, 'Post a job'),
    h('span', { class: 'icon-btn ghost', 'aria-hidden': 'true' }));
}

function renderPost() {
  if (ui.el) {
    const a = document.activeElement;
    ui.focus = a && ui.el.contains(a) ? a : null;
    return ui.el;
  }
  ui.draft ??= newDraft();
  if (!ui.trades || !jobs.rules) {
    Promise.all([loadTrades(), loadRules()]).then(([t]) => { ui.trades = t; if (state.view === 'job-post') render(); })
      .catch(() => showToast('Couldn’t load the trade list — check your connection'));
    return h('div', { class: 'screen' }, header(), h('div', { class: 'empty' }, h('p', {}, 'Loading…')));
  }
  ui.el = h('div', { class: 'screen job-post' }, header(), build(ui.draft, ui.trades, jobs.rules));
  return ui.el;
}

onAfterRender((view) => {
  if (view === 'job-post' && ui.focus && ui.el?.contains(ui.focus)) ui.focus.focus({ preventScroll: true });
  ui.focus = null;
});

registerView('job-post', { chrome: 'screen', render: renderPost });
