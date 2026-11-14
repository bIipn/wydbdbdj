// Settings (accounts mode, from the profile chip): the onboarding answers on one page, plus what only
// settings shows (cost settings, set-aside certifications, alert kinds, time zone), the plan, sign out, and
// "Delete my account" (web/js/account-delete.js: what it ends, the password again, then it is gone).
// "Your paperwork" uses the same Yes / No / Not sure chips as onboarding.
// Back with unsaved edits asks first: save, discard, or keep editing.
// "What brings you here" sits on top and decides which sections show: someone here only to get work done sees
// no trades, job sizes, cost settings or paperwork. "Your work profile" (web/js/work-profile.js) is saved with
// the same button, through its own API (PUT /api/work-profile).

import { deleteAccountSection } from '../account-delete.js';
import { api } from '../api.js';
import { h, icon, ICONS, showToast } from '../dom.js';
import { PLAN_LABEL } from '../format.js';
import { clearErrors, formError, showErrors } from '../form.js';
import {
  alertsSection, answersFrom, costsSection, draftFromSummary, INTENTS, jobsSection, loadSetAsides, loadTrades, nameSection,
  paperworkSection, setAsidesSection, tradesSection, whereSection,
} from '../profile-form.js';
import { promoRow } from '../promo.js';
import { applyMe, homeView, loadFeed, onSignedOut, signOut } from '../session.js';
import { registerView, render, setView } from '../shell.js';
import { features, intent, state } from '../state.js';
import { fieldsObject, workBodyFrom, workDraftFrom, workProfileSection } from '../work-profile.js';

// work: the work-profile draft and the saved card (GET /api/work-profile), loaded when Settings opens.
const ui = { draft: null, initial: null, trades: null, setAsides: null, busy: false, confirm: false, work: null, workInitial: null, card: null, workLoading: false };
onSignedOut(() => { Object.assign(ui, { draft: null, initial: null, confirm: false, work: null, workInitial: null, card: null }); });

const PLAN_TEXT = {
  free: 'Daily digest and in-app alerts. Pro adds instant phone alerts, award history, the cost check and your own cost settings.',
  pro: 'Instant phone alerts, award history, the cost check and cost settings are on.',
  pilot: 'Every feature is on for the pilot.',
};

const withCosts = () => features()?.costSettings === true;
const snapshot = () => JSON.stringify(answersFrom(ui.draft, { withCosts: withCosts() }));
const workSnapshot = () => (ui.work ? JSON.stringify(workBodyFrom(ui.work)) : null);
const workDirty = () => !!ui.work && workSnapshot() !== ui.workInitial;
const dirty = () => (!!ui.draft && ui.initial !== null && snapshot() !== ui.initial) || workDirty();

function startEditing() {
  ui.draft = draftFromSummary(state.me.profile, intent());
  ui.initial = snapshot();
  ui.confirm = false;
}

/** The saved work profile and card, once per visit to Settings. A failure leaves the section saying so. */
function loadWork() {
  if (ui.workLoading) return;
  ui.workLoading = true;
  api.workProfile().then(({ workProfile, card }) => {
    ui.work = workDraftFrom(workProfile);
    ui.workInitial = workSnapshot();
    ui.card = card;
  }).catch(() => { ui.card = false; })
    .finally(() => { ui.workLoading = false; if (state.view === 'settings') render(); });
}

/**
 * "What brings you here": three chips. The sections below follow the pick at once (nothing is saved until
 * Save). Leaving "get work done" turns new-bid alerts back on: a profile here only to hire had them off.
 */
function intentSection(d) {
  const list = h('div', { class: 'intent-list compact', role: 'radiogroup', 'aria-label': 'What brings you here?' },
    INTENTS.map((c) => {
      const b = h('button', { type: 'button', class: `intent intent-${c.id}`, role: 'radio', 'aria-checked': String(d.intent === c.id) },
        h('span', { class: 'intent-text' }, h('strong', {}, c.label), h('small', {}, c.help)),
        h('span', { class: 'choice-dot', 'aria-hidden': 'true' }, icon(ICONS.check)));
      b.addEventListener('click', () => {
        if (d.intent === c.id) return;
        if (d.intent === 'hire') d.kinds.match = true;
        d.intent = c.id;
        render();
      });
      return b;
    }));
  return h('div', { class: 'field', 'data-field': 'intent' }, list, h('p', { class: 'field-error', role: 'alert' }));
}

/** Alert kinds someone here only to hire can get: the local-job ones. Bids never alert them. */
const HIRE_KINDS = ['job_awarded', 'job_message', 'job_deadline', 'job_closed'];

/** The profile chip: open settings with a fresh copy of the saved answers. */
export function openSettings() {
  if (state.mode !== 'live' || state.auth !== 'accounts' || !state.me?.profile) return;
  startEditing();
  setView('settings');
}

function leave() {
  ui.draft = null;
  ui.initial = null;
  ui.confirm = false;
  ui.work = null;
  ui.workInitial = null;
  ui.card = null;
  setView(homeView());
}

function back() {
  if (dirty()) {
    ui.confirm = true;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else leave();
}

const PLAN_NAME = { free: 'Free', pro: 'BidSwipe Pro', pilot: 'BidSwipe Pro · pilot' };

/**
 * A promo code just turned the plan into Pro: cost settings are part of the form now. With nothing edited,
 * start over from the saved answers; with edits, keep them and only re-take the "saved" snapshot, so Back
 * still asks about the person's own changes and never about the new section.
 */
function planChanged() {
  if (!ui.draft) return;
  if (!dirty()) return startEditing();
  const keep = ui.draft;
  startEditing();
  keep.costs = ui.draft.costs; // the saved cost settings, now visible: never overwrite them with blanks
  ui.draft = keep;
}

function planCard() {
  const demo = !!state.authConfig?.demo;
  const plan = demo ? 'pilot' : (state.me?.account?.plan ?? 'free');
  return h('section', { class: 'panel plan' },
    h('div', { class: 'plan-row' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Signed in as'),
        h('p', { class: 'email' }, state.me?.account?.email ?? ''),
      ),
      h('span', { class: `plan-badge plan-${plan}` }, PLAN_LABEL[plan] ?? plan),
    ),
    h('div', { class: 'plan-name-row' },
      h('p', { class: 'eyebrow' }, 'Plan'),
      h('p', { class: 'plan-name' }, PLAN_NAME[plan] ?? plan),
    ),
    h('p', { class: 'plan-text' }, demo ? 'Demo mode: all features on. Nothing is billed.' : PLAN_TEXT[plan]),
    demo ? null : promoRow({ onUnlocked: planChanged }),
  );
}

const section = (title, ...body) => h('section', { class: 'panel' }, h('h2', { class: 'panel-title' }, title), ...body);

/** A plan without cost settings sees what they are, and that they are part of Pro. Nothing to type. */
const costsLocked = () => h('div', { class: 'pc-locked' }, icon(ICONS.lock),
  h('div', {}, h('strong', {}, 'Cost settings are part of BidSwipe Pro'),
    h('p', {}, 'Save your labor rate, burden, overhead and profit once, and the cost check fills them in for every job.')));

/**
 * Save: the profile answers (PUT /api/profile), then the work profile when it changed (PUT /api/work-profile).
 * Two calls: if the second is refused (a bad link), the first is already saved. Its errors show under its boxes,
 * the page stays open, and Save sends both again (the first one changes nothing the second time).
 */
async function save(form, button) {
  clearErrors(form);
  ui.busy = true;
  button.disabled = true;
  button.textContent = 'Saving…';
  const hire = ui.draft.intent === 'hire';
  try {
    const res = await api.saveProfile(answersFrom(ui.draft, { withCosts: withCosts() }));
    if (workDirty()) await api.saveWorkProfile({ intent: ui.draft.intent, ...workBodyFrom(ui.work) });
    applyMe(await api.me());
    await loadFeed();
    ui.busy = false;
    leave();
    showToast(hire ? 'Saved' : `Saved — ${res.scored} open bid${res.scored === 1 ? '' : 's'} re-scored for you`);
  } catch (err) {
    ui.busy = false;
    ui.confirm = false;
    button.disabled = false;
    button.textContent = 'Save changes';
    // PUT /api/profile answers { fields: { path: message } }; PUT /api/work-profile answers { fields: [{ path, message }] }.
    const fields = err.body?.fields;
    const shown = Array.isArray(fields) ? fieldsObject(fields) : fields;
    const first = showErrors(form, shown && Object.keys(shown).length ? shown : { form: err.message || 'That did not save. Try again.' });
    first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function confirmBar(onSave) {
  return h('section', { class: 'panel unsaved', role: 'alertdialog', 'aria-labelledby': 'unsavedTitle' },
    h('h2', { id: 'unsavedTitle' }, 'You have unsaved changes'),
    h('p', {}, 'Save them before you go back, or leave without saving.'),
    h('div', { class: 'unsaved-actions' },
      h('button', { class: 'cta', type: 'button', onclick: onSave }, 'Save changes'),
      h('button', { class: 'cta ghost', type: 'button', onclick: leave }, 'Discard'),
      h('button', { class: 'text-btn', type: 'button', onclick: () => { ui.confirm = false; render(); } }, 'Keep editing'),
    ),
  );
}

function renderSettings() {
  if (!state.me?.profile) return h('div', { class: 'screen' }, h('div', { class: 'empty' }, h('p', {}, 'Loading…')));
  if (!ui.draft) startEditing();
  if (!ui.trades || !ui.setAsides) {
    Promise.all([loadTrades(), loadSetAsides()]).then(([t, s]) => { ui.trades = t; ui.setAsides = s; if (state.view === 'settings') render(); })
      .catch(() => showToast('Couldn’t load the trade list — check your connection'));
    return h('div', { class: 'screen' }, h('div', { class: 'empty' }, h('p', {}, 'Loading…')));
  }
  if (!ui.work && ui.card !== false) loadWork();
  const d = ui.draft;
  const f = features() ?? {};
  const hire = d.intent === 'hire';
  const saveBtn = h('button', { class: 'cta', type: 'submit', disabled: ui.busy }, 'Save changes');
  const work = ui.work && ui.card ? workProfileSection(ui.work, { card: ui.card, trades: ui.trades }) : null;
  const workBody = work ? work.form
    : h('p', { class: 'field-help' }, ui.card === false ? 'Couldn’t load your work profile. Check your connection and open Settings again.' : 'Loading…');
  const form = h('form', { class: 'settings-form', novalidate: true },
    section('What brings you here', intentSection(d)),
    section(hire ? 'Your name' : 'Business', nameSection(d, hire ? { label: 'Your name or business name', help: 'People who bid on your jobs see this name.' } : {})),
    hire ? null : section('Trades', tradesSection(d, ui.trades)),
    section('Location', whereSection(d, hire ? { radius: false } : {})),
    hire ? null : section('Job size and limits', jobsSection(d)),
    hire ? null : section('Cost settings', withCosts() ? costsSection(d) : costsLocked()),
    hire ? null : section('Your paperwork', paperworkSection(d)),
    hire ? null : section('Set-aside certifications', setAsidesSection(d, ui.setAsides)),
    section('Your work profile', h('p', { class: 'field-help wp-intro' }, 'What people you deal with on a job see about you. Everything here is optional.'), workBody),
    work ? section('How others see you', work.preview, h('p', { class: 'field-help' }, 'Shown only to people you deal with on a job. Never your email, phone or address.')) : null,
    section('Alerts', alertsSection(d, hire ? { kinds: true, kindIds: HIRE_KINDS, minScore: false, timeZone: true, features: f } : { kinds: true, timeZone: true, features: f })),
    formError(),
    h('div', { class: 'save-bar' }, saveBtn),
  );
  form.addEventListener('submit', (e) => { e.preventDefault(); if (!ui.busy) save(form, saveBtn); });

  return h('div', { class: 'screen settings' },
    h('header', { class: 'screen-head' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back to bids', onclick: back }, icon(ICONS.back)),
      h('h1', {}, 'Settings'),
      h('span', { class: 'icon-btn ghost', 'aria-hidden': 'true' }),
    ),
    ui.confirm ? confirmBar(() => { if (!ui.busy) save(form, saveBtn); }) : null,
    planCard(),
    form,
    h('button', { type: 'button', class: 'cta ghost signout', onclick: () => { ui.draft = null; signOut(); } }, 'Sign out'),
    deleteAccountSection(),
    // The Microsoft Store asks for the privacy policy inside the app too (web/privacy.html, same origin).
    h('p', { class: 'fine' }, h('a', { class: 'fine-link', href: 'privacy.html', target: '_blank', rel: 'noopener' }, 'Privacy policy'),
      ' · ', h('a', { class: 'fine-link', href: 'terms.html', target: '_blank', rel: 'noopener' }, 'Terms')),
  );
}

registerView('settings', { chrome: 'screen', render: renderSettings });
