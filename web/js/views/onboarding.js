// Onboarding: six tap-only steps, then PUT /api/profile and straight into the feed.
//
// Everything is a chip or a toggle. The only things anyone types: a 5-digit ZIP (only when "Use my location"
// can't be used) and, on the last step, the business name — optional, skipped = "My electrical shop".
// A single-choice step (how far, alerts) moves on by itself after the tap; Back always works.

import { api } from '../api.js';
import { h, icon, ICONS, showToast } from '../dom.js';
import { clearErrors, field, formError, showErrors, textInput } from '../form.js';
import {
  alertChoices, answersFrom, defaultBusinessName, emptyDraft, homeSection, jobSizeChips, loadTrades, paperworkSection,
  QUAL_KEYS, tradesSection,
} from '../profile-form.js';
import { enterApp, onSignedOut, signOut } from '../session.js';
import { onAfterRender, registerView, render } from '../shell.js';
import { deck, state } from '../state.js';

let trades = null;
const ui = { step: 0, draft: null, busy: false, pending: null };

/** The pause after a single-choice tap, so the person sees the chip light up before the screen moves on. */
const AUTO_NEXT_MS = 220;

/**
 * Each step: its title, the API fields it owns (for routing a 400 back to it), its body, a quick check, and
 * `auto` when one tap answers it (no Next button: the tap moves on).
 */
const STEPS = [
  {
    title: 'What work do you do?', sub: 'Pick the trades you bid. We match bids by their scope of work.',
    owns: ['trades'], body: (d) => tradesSection(d, trades),
    check: (d) => (d.trades.length ? null : { trades: 'Pick at least one trade.' }),
  },
  {
    title: 'Where’s your shop?', sub: 'We measure every bid’s distance from here.',
    owns: ['zip', 'radiusMi'], auto: true, body: (d) => homeSection(d, { onDone: autoNext }),
    check: (d) => {
      if (!d.place) return { zip: d.zip.length === 5 ? `We can’t find ZIP ${d.zip}. Check the number.` : 'Tap “Use my location” or enter your 5-digit ZIP.' };
      return d.radiusPicked ? null : { radiusMi: 'Pick how far you’ll travel.' };
    },
  },
  {
    title: 'What size jobs fit you?', sub: 'Estimated contract value, from the bid notice.',
    owns: ['valueRange', 'limits'], body: (d) => jobSizeChips(d),
    check: (d) => (d.sizes.length ? null : { valueRange: 'Pick at least one size.' }),
  },
  {
    title: 'Your paperwork', sub: 'Have it or not, you’ll see every bid. We just tell you what each one needs.',
    owns: ['qualifications', 'setAsides'], body: (d) => paperworkSection(d, { certs: true }),
    check: () => null,
  },
  {
    title: 'When should we ping you?', sub: 'Good fits land in your alerts as soon as we find them.',
    owns: ['alerts', 'costs'], auto: true, body: (d) => alertChoices(d, { onPick: autoNext }),
    check: () => null,
  },
  {
    title: 'What’s your business called?', sub: 'Optional. Skip it and change it any time in Settings.',
    owns: ['businessName'], body: (d) => nameStep(d),
    check: () => null,
  },
];

const stepFor = (path) => {
  const i = STEPS.findIndex((s) => s.owns.some((k) => path === k || path.startsWith(`${k}.`)));
  return i === -1 ? STEPS.length - 1 : i;
};

function nameStep(d) {
  const input = textInput({ value: d.businessName, autocomplete: 'organization', placeholder: defaultBusinessName(d, trades), maxlength: 80, enterkeyhint: 'done' });
  input.addEventListener('input', () => (d.businessName = input.value));
  return field({ key: 'businessName', label: 'Business name', help: `Leave it empty and we’ll call you “${defaultBusinessName(d, trades)}”.`, control: input });
}

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
  const d = ui.draft;
  // Unanswered paperwork counts as "Not sure" — sent as such, so the cards say "check yours".
  d.quals ??= Object.fromEntries(QUAL_KEYS.map((k) => [k, 'unsure']));
  const answers = answersFrom(d);
  if (!answers.businessName.trim()) answers.businessName = defaultBusinessName(d, trades);
  try {
    const res = await api.saveProfile(answers);
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
  const problems = STEPS[ui.step].check(ui.draft);
  if (problems) return showErrors(form, problems);
  if (ui.step === STEPS.length - 1) return finish(button);
  ui.step += 1;
  render();
  window.scrollTo({ top: 0 });
}

/** A one-tap step answered: move on (unless something on it still needs fixing). */
function autoNext() {
  const at = ui.step;
  setTimeout(() => {
    if (ui.step !== at || state.view !== 'onboarding' || STEPS[at].check(ui.draft)) return;
    ui.step += 1;
    render();
    window.scrollTo({ top: 0 });
  }, AUTO_NEXT_MS);
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
    // A one-tap step has no Next; the hidden button still lets Enter in the ZIP box submit the step.
    h('div', { class: `step-foot${step.auto ? ' is-auto' : ''}` }, nextBtn),
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
