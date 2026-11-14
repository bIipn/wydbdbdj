// Onboarding: "What brings you here?" (one tap), then the steps for that answer, then PUT /api/profile.
//
//   Find work / Both: the six tap-only steps (trades, where + how far, job size, paperwork, alerts, name).
//   Get work done:    where, and a name. The profile gets no trades, so it is never alerted about work.
//
// Everything is a chip or a toggle. The only things anyone types: a 5-digit ZIP (only when "Use my location"
// can't be used) and the name — optional for a business (skipped = "My electrical shop"), asked for someone
// who posts jobs, because the people bidding see it. A single-choice step moves on by itself after the tap;
// Back always works.

import { api } from '../api.js';
import { h, icon, ICONS, showToast } from '../dom.js';
import { clearErrors, field, formError, showErrors, textInput } from '../form.js';
import {
  alertChoices, answersFrom, defaultBusinessName, emptyDraft, hireAnswersFrom, homeSection, INTENTS, jobSizeChips, loadTrades,
  paperworkSection, QUAL_KEYS, tradesSection,
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
const WORK_STEPS = [
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

/** Someone here to get work done: where, and what to call them. Nothing about trades, distance or job size. */
const HIRE_STEPS = [
  {
    title: 'Where’s the work?', sub: 'Jobs you post show your town. Your street address never shows.',
    owns: ['zip'], auto: true,
    body: (d) => homeSection(d, { onDone: autoNext, radius: false, zipLabel: 'Your ZIP code', ownPlace: 'your' }),
    check: (d) => (d.place ? null
      : { zip: d.zip.length === 5 ? `We can’t find ZIP ${d.zip}. Check the number.` : 'Tap “Use my location” or enter your 5-digit ZIP.' }),
  },
  {
    title: 'What should we call you?', sub: 'People who bid on your jobs see this name. Change it any time in Settings.',
    owns: ['businessName', 'alerts'], body: (d) => hireNameStep(d),
    check: (d) => (d.businessName.trim().length >= 2 ? null : { businessName: 'Enter your name or your business name.' }),
  },
];

const INTENT_STEP = {
  title: 'What brings you here?', sub: 'Pick one. You can change it any time in Settings.',
  owns: ['intent'], auto: true, body: (d) => intentChoices(d),
  check: (d) => (d.intentPicked ? null : { intent: 'Pick one to go on.' }),
};

/** The steps for the answer so far. Before any answer, the longest path, so the step count never jumps up. */
const steps = () => [INTENT_STEP, ...(ui.draft?.intent === 'hire' ? HIRE_STEPS : WORK_STEPS)];

const stepFor = (path) => {
  const all = steps();
  const i = all.findIndex((s) => s.owns.some((k) => path === k || path.startsWith(`${k}.`)));
  return i === -1 ? all.length - 1 : i;
};

/** Three large choices; one tap answers and moves on. */
function intentChoices(d) {
  const list = h('div', { class: 'intent-list', role: 'radiogroup', 'aria-label': 'What brings you here?' });
  const paint = () => list.replaceChildren(...INTENTS.map((c) => {
    const on = d.intentPicked && d.intent === c.id;
    const b = h('button', { type: 'button', class: `intent intent-${c.id}`, role: 'radio', 'aria-checked': String(on) },
      h('span', { class: 'intent-text' }, h('strong', {}, c.label), h('small', {}, c.help)),
      h('span', { class: 'choice-dot', 'aria-hidden': 'true' }, icon(ICONS.check)));
    b.addEventListener('click', () => {
      d.intent = c.id;
      d.intentPicked = true;
      paint();
      autoNext();
    });
    return b;
  }));
  paint();
  return h('div', { class: 'field', 'data-field': 'intent' }, list, h('p', { class: 'field-error', role: 'alert' }));
}

/** A name that is an email address stays out of the box: the name is shown to strangers. */
const accountName = () => {
  const n = state.me?.account?.name?.trim() ?? '';
  return n && !n.includes('@') ? n : '';
};

function hireNameStep(d) {
  if (!d.businessName) d.businessName = accountName();
  const input = textInput({ value: d.businessName, autocomplete: 'name', placeholder: 'e.g. Dana R. or Reyes Ranch', maxlength: 80, enterkeyhint: 'done' });
  input.addEventListener('input', () => (d.businessName = input.value));
  return field({ key: 'businessName', label: 'Your name or business name', help: 'Never your email or phone number.', control: input });
}

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
  const d = ui.draft;
  const hire = d.intent === 'hire';
  button.textContent = hire ? 'Setting you up…' : 'Finding your bids…';
  let answers;
  if (hire) answers = hireAnswersFrom(d);
  else {
    // Unanswered paperwork counts as "Not sure" — sent as such, so the cards say "check yours".
    d.quals ??= Object.fromEntries(QUAL_KEYS.map((k) => [k, 'unsure']));
    answers = answersFrom(d);
    if (!answers.businessName.trim()) answers.businessName = defaultBusinessName(d, trades);
  }
  try {
    const res = await api.saveProfile(answers);
    ui.busy = false;
    resetOnboarding();
    await enterApp();
    if (hire) return showToast('All set — post a job whenever you’re ready');
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
  const all = steps();
  const problems = all[ui.step].check(ui.draft);
  if (problems) return showErrors(form, problems);
  if (ui.step === all.length - 1) return finish(button);
  ui.step += 1;
  render();
  window.scrollTo({ top: 0 });
}

/** A one-tap step answered: move on (unless something on it still needs fixing). */
function autoNext() {
  const at = ui.step;
  setTimeout(() => {
    if (ui.step !== at || state.view !== 'onboarding' || steps()[at].check(ui.draft)) return;
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
  const all = steps();
  const step = all[ui.step];
  const total = all.length;
  const last = ui.step === total - 1;
  const finishLabel = ui.draft.intent === 'hire' ? 'Finish' : 'Finish and see my bids';
  const nextBtn = h('button', { class: 'cta', type: 'submit', disabled: ui.busy }, last ? finishLabel : 'Next');
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
        all.map((_, i) => h('span', { class: i <= ui.step ? 'on' : '' }))),
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
