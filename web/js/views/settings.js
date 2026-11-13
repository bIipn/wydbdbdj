// Settings (accounts mode, from the profile chip): the onboarding answers on one page, the plan, sign out.

import { api } from '../api.js';
import { h, icon, ICONS, showToast } from '../dom.js';
import { PLAN_LABEL } from '../format.js';
import { clearErrors, formError, showErrors } from '../form.js';
import {
  alertsSection, answersFrom, draftFromSummary, jobsSection, loadTrades, nameSection, tradesSection, whereSection,
} from '../profile-form.js';
import { applyMe, loadFeed, onSignedOut, signOut } from '../session.js';
import { registerView, render, setView } from '../shell.js';
import { state } from '../state.js';

const ui = { draft: null, trades: null, busy: false };
onSignedOut(() => { ui.draft = null; });

const PLAN_TEXT = {
  free: 'Daily digest and in-app alerts. Pro adds instant phone alerts, award history and your own cost settings.',
  pro: 'Instant phone alerts, award history and cost settings are on.',
  pilot: 'Every feature is on for the pilot.',
};

/** The profile chip: open settings with a fresh copy of the saved answers. */
export function openSettings() {
  if (state.mode !== 'live' || state.auth !== 'accounts' || !state.me?.profile) return;
  ui.draft = draftFromSummary(state.me.profile);
  setView('settings');
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
    h('p', { class: 'plan-text' }, demo ? 'Demo mode: all features on. Nothing is billed.' : PLAN_TEXT[plan]),
  );
}

const section = (title, ...body) => h('section', { class: 'panel' }, h('h2', { class: 'panel-title' }, title), ...body);

async function save(form, button) {
  clearErrors(form);
  ui.busy = true;
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const res = await api.saveProfile(answersFrom(ui.draft));
    applyMe(await api.me());
    await loadFeed();
    ui.busy = false;
    ui.draft = null;
    setView('swipe');
    showToast(`Saved — ${res.scored} open bid${res.scored === 1 ? '' : 's'} re-scored for you`);
  } catch (err) {
    ui.busy = false;
    button.disabled = false;
    button.textContent = 'Save changes';
    const first = showErrors(form, err.body?.fields ?? { form: err.message || 'That did not save. Try again.' });
    first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function renderSettings() {
  if (!state.me?.profile) return h('div', { class: 'screen' }, h('div', { class: 'empty' }, h('p', {}, 'Loading…')));
  ui.draft ??= draftFromSummary(state.me.profile);
  if (!ui.trades) {
    loadTrades().then((t) => { ui.trades = t; if (state.view === 'settings') render(); })
      .catch(() => showToast('Couldn’t load the trade list — check your connection'));
    return h('div', { class: 'screen' }, h('div', { class: 'empty' }, h('p', {}, 'Loading…')));
  }
  const d = ui.draft;
  const saveBtn = h('button', { class: 'cta', type: 'submit', disabled: ui.busy }, 'Save changes');
  const form = h('form', { class: 'settings-form', novalidate: true },
    section('Business', nameSection(d)),
    section('Trades', tradesSection(d, ui.trades)),
    section('Location', whereSection(d)),
    section('Job size and limits', jobsSection(d)),
    section('Alerts', alertsSection(d)),
    formError(),
    h('div', { class: 'save-bar' }, saveBtn),
  );
  form.addEventListener('submit', (e) => { e.preventDefault(); if (!ui.busy) save(form, saveBtn); });

  return h('div', { class: 'screen settings' },
    h('header', { class: 'screen-head' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back to bids', onclick: () => { ui.draft = null; setView('swipe'); } }, icon(ICONS.back)),
      h('h1', {}, 'Settings'),
      h('span', { class: 'icon-btn ghost', 'aria-hidden': 'true' }),
    ),
    planCard(),
    form,
    h('button', { type: 'button', class: 'cta ghost signout', onclick: signOut }, 'Sign out'),
  );
}

registerView('settings', { chrome: 'screen', render: renderSettings });
