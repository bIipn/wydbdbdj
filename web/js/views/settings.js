// Settings (accounts mode, from the profile chip): the onboarding answers on one page, plus what only
// settings shows (cost settings, set-aside certifications, alert kinds, time zone), the plan, sign out.
// "Your paperwork" uses the same Yes / No / Not sure chips as onboarding.
// Back with unsaved edits asks first: save, discard, or keep editing.

import { api } from '../api.js';
import { h, icon, ICONS, showToast } from '../dom.js';
import { PLAN_LABEL } from '../format.js';
import { clearErrors, formError, showErrors } from '../form.js';
import {
  alertsSection, answersFrom, costsSection, draftFromSummary, jobsSection, loadSetAsides, loadTrades, nameSection,
  paperworkSection, setAsidesSection, tradesSection, whereSection,
} from '../profile-form.js';
import { promoRow } from '../promo.js';
import { applyMe, loadFeed, onSignedOut, signOut } from '../session.js';
import { registerView, render, setView } from '../shell.js';
import { features, state } from '../state.js';

const ui = { draft: null, initial: null, trades: null, setAsides: null, busy: false, confirm: false };
onSignedOut(() => { Object.assign(ui, { draft: null, initial: null, confirm: false }); });

const PLAN_TEXT = {
  free: 'Daily digest and in-app alerts. Pro adds instant phone alerts, award history, the cost check and your own cost settings.',
  pro: 'Instant phone alerts, award history, the cost check and cost settings are on.',
  pilot: 'Every feature is on for the pilot.',
};

const withCosts = () => features()?.costSettings === true;
const snapshot = () => JSON.stringify(answersFrom(ui.draft, { withCosts: withCosts() }));
const dirty = () => !!ui.draft && ui.initial !== null && snapshot() !== ui.initial;

function startEditing() {
  ui.draft = draftFromSummary(state.me.profile);
  ui.initial = snapshot();
  ui.confirm = false;
}

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
  setView('swipe');
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

async function save(form, button) {
  clearErrors(form);
  ui.busy = true;
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const res = await api.saveProfile(answersFrom(ui.draft, { withCosts: withCosts() }));
    applyMe(await api.me());
    await loadFeed();
    ui.busy = false;
    leave();
    showToast(`Saved — ${res.scored} open bid${res.scored === 1 ? '' : 's'} re-scored for you`);
  } catch (err) {
    ui.busy = false;
    ui.confirm = false;
    button.disabled = false;
    button.textContent = 'Save changes';
    const fields = err.body?.fields;
    const first = showErrors(form, fields && !Array.isArray(fields) ? fields : { form: err.message || 'That did not save. Try again.' });
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
  const d = ui.draft;
  const f = features() ?? {};
  const saveBtn = h('button', { class: 'cta', type: 'submit', disabled: ui.busy }, 'Save changes');
  const form = h('form', { class: 'settings-form', novalidate: true },
    section('Business', nameSection(d)),
    section('Trades', tradesSection(d, ui.trades)),
    section('Location', whereSection(d)),
    section('Job size and limits', jobsSection(d)),
    section('Cost settings', withCosts() ? costsSection(d) : costsLocked()),
    section('Your paperwork', paperworkSection(d)),
    section('Set-aside certifications', setAsidesSection(d, ui.setAsides)),
    section('Alerts', alertsSection(d, { kinds: true, timeZone: true, features: f })),
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
    // The Microsoft Store asks for the privacy policy inside the app too (web/privacy.html, same origin).
    h('p', { class: 'fine' }, h('a', { class: 'fine-link', href: 'privacy.html', target: '_blank', rel: 'noopener' }, 'Privacy policy')),
  );
}

registerView('settings', { chrome: 'screen', render: renderSettings });
