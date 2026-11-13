// Onboarding: five short steps, then PUT /api/profile and straight into the feed.

import { api } from '../api.js';
import { h, icon, ICONS, showToast } from '../dom.js';
import { parseDollars } from '../format.js';
import { clearErrors, formError, showErrors } from '../form.js';
import {
  alertsSection, answersFrom, emptyDraft, jobsSection, loadTrades, nameSection, tradesSection, whereSection,
} from '../profile-form.js';
import { enterApp, onSignedOut, signOut } from '../session.js';
import { onAfterRender, registerView, render } from '../shell.js';
import { deck, state } from '../state.js';

let trades = null;
const ui = { step: 0, draft: null, busy: false, pending: null };

/** Each step: its title, the API fields it owns (for routing a 400 back to it), its body, and a quick check. */
const STEPS = [
  {
    title: 'What’s your business called?', sub: 'Two quick minutes and your first bids are waiting.',
    owns: ['businessName'], body: (d) => nameSection(d),
    check: (d) => (d.businessName.trim() ? null : { businessName: 'Enter your business name.' }),
  },
  {
    title: 'What work do you do?', sub: 'Pick the trades you bid. We match bids by their scope of work.',
    owns: ['trades', 'setAsides'], body: (d) => tradesSection(d, trades),
    check: (d) => (d.trades.length ? null : { trades: 'Pick at least one trade.' }),
  },
  {
    title: 'Where’s your shop?', sub: 'We measure every bid’s distance from here.',
    owns: ['zip', 'radiusMi'], body: (d) => whereSection(d),
    check: (d) => {
      if (d.place) return null;
      const digits = /^\s*(\d{5})\s*$/.exec(d.zip)?.[1];
      return { zip: digits ? `We can’t find ZIP ${digits}. Check the number.` : 'Enter a 5-digit ZIP code.' };
    },
  },
  {
    title: 'What size jobs fit you?', sub: 'Estimated contract value, from the bid notice.',
    owns: ['valueRange', 'limits', 'costs'], body: (d) => jobsSection(d),
    check: (d) => (parseDollars(d.max) == null ? { 'valueRange.max': 'Enter the largest job you want.' } : null),
  },
  {
    title: 'When should we ping you?', sub: 'Good fits show up in your alerts as soon as we find them.',
    owns: ['alerts'], body: (d) => alertsSection(d),
    check: () => null,
  },
];

const stepFor = (path) => {
  const i = STEPS.findIndex((s) => s.owns.some((k) => path === k || path.startsWith(`${k}.`)));
  return i === -1 ? STEPS.length - 1 : i;
};

/** Start over (a new account, or after sign-out). */
function resetOnboarding() {
  ui.step = 0;
  ui.draft = null;
  ui.pending = null;
}
onSignedOut(resetOnboarding);

async function finish(button) {
  ui.busy = true;
  button.disabled = true;
  button.textContent = 'Finding your bids…';
  try {
    const res = await api.saveProfile(answersFrom(ui.draft));
    ui.busy = false;
    resetOnboarding();
    await enterApp();
    const fits = deck().length;
    showToast(fits ? `All set — ${fits} bid${fits === 1 ? '' : 's'} fit you right now`
      : res.scored ? `All set — none of the ${res.scored} open bids fit yet` : 'All set — new bids arrive with the morning scan');
  } catch (err) {
    ui.busy = false;
    const fields = err.body?.fields ?? { form: err.message || 'That did not save. Try again.' };
    ui.step = Math.min(...Object.keys(fields).map(stepFor));
    ui.pending = fields;
    render();
  }
}

function next(button, form) {
  clearErrors(form);
  const step = STEPS[ui.step];
  const problems = step.check(ui.draft);
  if (problems) return showErrors(form, problems);
  if (ui.step === STEPS.length - 1) return finish(button);
  ui.step += 1;
  render();
}

function renderOnboarding() {
  ui.draft ??= emptyDraft();
  if (!trades) {
    loadTrades().then((t) => { trades = t; if (state.view === 'onboarding') render(); })
      .catch(() => showToast('Couldn’t load the trade list — check your connection'));
    return h('div', { class: 'screen' }, h('div', { class: 'empty' }, h('p', {}, 'Loading…')));
  }
  const step = STEPS[ui.step];
  const total = STEPS.length;
  const last = ui.step === total - 1;
  const nextBtn = h('button', { class: 'cta', type: 'submit', disabled: ui.busy }, last ? 'Finish and see my bids' : 'Next');
  const form = h('form', { class: 'step-form', novalidate: true },
    step.body(ui.draft),
    formError(),
    h('div', { class: 'step-foot' }, nextBtn),
  );
  form.addEventListener('submit', (e) => { e.preventDefault(); if (!ui.busy) next(nextBtn, form); });

  return h('div', { class: 'screen onboarding' },
    h('header', { class: 'step-head' },
      ui.step > 0
        ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', onclick: () => { ui.step -= 1; render(); } }, icon(ICONS.back))
        : h('span', { class: 'icon-btn ghost', 'aria-hidden': 'true' }),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 1, 'aria-valuemax': total, 'aria-valuenow': ui.step + 1, 'aria-label': `Step ${ui.step + 1} of ${total}` },
        STEPS.map((_, i) => h('span', { class: i <= ui.step ? 'on' : '' }))),
      h('button', { type: 'button', class: 'text-btn', onclick: signOut }, 'Sign out'),
    ),
    h('p', { class: 'step-count' }, `Step ${ui.step + 1} of ${total}`),
    h('h1', { class: 'step-title' }, step.title),
    h('p', { class: 'step-sub' }, step.sub),
    form,
  );
}

registerView('onboarding', { chrome: 'screen', render: renderOnboarding });

onAfterRender((view) => {
  if (view !== 'onboarding' || !ui.pending) return;
  const form = document.querySelector('.step-form');
  if (form) showErrors(form, ui.pending)?.scrollIntoView({ block: 'center' });
  ui.pending = null;
});
