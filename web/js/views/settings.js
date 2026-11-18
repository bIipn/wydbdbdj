// Settings (accounts mode, from the profile chip): the onboarding answers on one page, plus what only
// settings shows (cost settings, set-aside certifications, alert kinds, time zone), the plan, sign out.
// "Your paperwork" uses the same Yes / No / Not sure chips as onboarding.
// Back with unsaved edits asks first: save, discard, or keep editing.
// "What brings you here" sits on top and decides which sections show: someone here only to get work done sees
// no trades, job sizes, cost settings or paperwork. "Your work profile" (web/js/work-profile.js) is saved with
// the same button, through its own API (PUT /api/work-profile).

import { api } from '../api.js';
import { h, icon, ICONS, showToast } from '../dom.js';
import { PLAN_LABEL } from '../format.js';
import { clearErrors, field, formError, showErrors, textInput, toggle } from '../form.js';
import { openJob } from '../jobs-data.js';
import {
  alertsSection, answersFrom, costsSection, draftFromSummary, INTENTS, jobsSection, loadSetAsides, loadTrades, nameSection,
  paperworkSection, setAsidesSection, tradesSection, whereSection,
} from '../profile-form.js';
import { promoRow } from '../promo.js';
import { devicePush, releaseDevice, standalone } from '../push.js';
import { applyMe, loadFeed, onSignedOut, signedOut, signOut } from '../session.js';
import { goBack, onAfterRender, registerView, render, setView } from '../shell.js';
import { features, intent, phoneAlerts, PRIME_TRADE, state } from '../state.js';
import { openAlerts } from './alerts.js';
import { fieldsObject, workBodyFrom, workDraftFrom, workProfileSection } from '../work-profile.js';

// work: the work-profile draft and the saved card (GET /api/work-profile), loaded when Settings opens.
const ui = { draft: null, initial: null, trades: null, setAsides: null, busy: false, confirm: false, work: null, workInitial: null, card: null, workLoading: false, push: null };
onSignedOut(() => { Object.assign(ui, { draft: null, initial: null, confirm: false, work: null, workInitial: null, card: null, push: null }); });

// "Delete account": closed (a plain danger button under Sign out) or open (the confirm form in place). `proof` is what
// the server asks for: the password, or the email address for an account that signs in with a provider and has none.
const DELETE_CLOSED = { open: false, busy: false, proof: 'password', value: '', error: null, jobs: [], focus: false };
const del = { ...DELETE_CLOSED };
const closeDelete = () => Object.assign(del, DELETE_CLOSED, { jobs: [] });
onSignedOut(closeDelete);

const PLAN_TEXT = {
  // Local jobs buzz on every plan (src/realtime/alerts.ts); only new public bids' phone alerts are Pro.
  free: 'In-app alerts, and phone alerts for your local jobs. Pro adds phone alerts for new public bids, award history, the cost check and your own cost settings.',
  // Phone alerts are per device (the bell turns them on), so the plan line never says they are on here.
  pro: 'Instant phone alerts, award history, the cost check and cost settings are part of your plan. Phone alerts are turned on for each device from the bell.',
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
  ui.push = null; // this device's phone-alert state, read again on each visit (pushRow)
}

/** How the row names this device's phone-alert state (push.js devicePush). Absent = no row. */
const PUSH_WORD = {
  on: 'On', off: 'Off', denied: 'Blocked', unsupported: 'Not in this browser', old_ios: 'Needs iOS 16.4 or later',
  insecure: 'Needs https', error: 'Couldn’t check', ios_tab: 'Needs the Home Screen',
};

/**
 * "Phone alerts on this device": what the bell's panel would say, in one word, and a button there (the switch, the
 * steps and the test live in one place). Wherever phone alerts can buzz at all (state.js phoneAlerts: every account,
 * for its local jobs), and only once the state is known.
 */
function pushRow() {
  if (!phoneAlerts()) return null;
  if (ui.push === null) {
    ui.push = 'checking';
    devicePush(true).then(({ state: s }) => { ui.push = s; if (state.view === 'settings') render(); }).catch(() => { ui.push = 'error'; });
  }
  const shown = ui.push === 'unsupported' && standalone() === false ? 'ios_tab' : ui.push;
  const word = PUSH_WORD[shown];
  if (!word) return null;
  // "Set up" only where there is something to set up; a state the bell can only explain gets "Details" (review rs-6).
  const action = shown === 'on' ? 'Manage' : ['off', 'denied', 'ios_tab'].includes(shown) ? 'Set up' : 'Details';
  return h('div', { class: 'field push-row' },
    h('div', { class: 'push-row-text' }, h('span', { class: 'push-row-label' }, 'Phone alerts on this device'), h('strong', { class: `push-row-state is-${ui.push}` }, word)),
    h('button', { type: 'button', class: 'cta ghost push-row-open', onclick: () => { ui.push = null; openAlerts({ back: 'settings' }); } }, action));
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

/** "Widen your reach" (the finished deck): Settings, scrolled to one field (e.g. 'radiusMi'). */
let focusField = null;
export function openSettingsAt(field) {
  focusField = field;
  openSettings();
}
onAfterRender((view) => {
  if (view !== 'settings' || !focusField) return;
  const el = document.querySelector(`.settings-form [data-field="${focusField}"]`);
  if (!el) return; // still loading: the next render tries again
  focusField = null;
  // After setView's own scroll to the top, which runs once this render is done.
  setTimeout(() => {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // The keyboard lands there too (a task's button pointed at this field), not back at the top of the page.
    el.querySelector('input, select, textarea, button, [tabindex]:not([tabindex="-1"])')?.focus({ preventScroll: true });
    el.classList.add('is-pointed');
    setTimeout(() => el.classList.remove('is-pointed'), 1800);
  }, 0);
});

/**
 * "Show sub work": prime contracts a general contractor bids, where this trade is usually subcontracted. Off keeps
 * them out of the deck (Browse still lists them). A company with the general-building trade is the prime: no switch.
 */
function subWorkSection(d) {
  if (d.trades.includes(PRIME_TRADE)) return null;
  return h('div', { class: 'field sub-switch', 'data-field': 'showSubWork' },
    toggle({ checked: d.showSubWork !== false, label: 'Show sub work', onchange: (on) => { d.showSubWork = on; } }),
    h('p', { class: 'field-help' }, 'Building and facility jobs a general contractor bids, where your trade is usually subcontracted: you’d quote the bidders. They sit in your deck below your own fits and never send alerts.'),
    h('p', { class: 'field-error', role: 'alert' }));
}

function leave() {
  ui.draft = null;
  ui.initial = null;
  ui.confirm = false;
  ui.work = null;
  ui.workInitial = null;
  ui.card = null;
  closeDelete();
  goBack(); // the tab the profile button was pressed on (Home when that is not known)
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

/** What goes, said once before the password (src/db/accounts.ts deleteAccount; web/privacy.html says the same). */
const DELETE_TEXT = 'This deletes your account at once: your company profile and preferences, saved and passed bids, alerts and '
  + 'phone-alert devices, your work profile, your bids and messages, and the jobs you posted with their bids and messages, '
  + 'which also disappear for the person who won them. Recorded fees go too. It can’t be undone.';

/**
 * The confirm form, in place under Sign out. Nothing is deleted until "Delete my account" with the password; a job
 * still in progress (409) is listed under the form, each one a way to open it. On success the account is gone on the
 * server (its devices too), so this browser only drops its own push subscription, and the sign-in screen follows.
 */
function deleteAccountSection() {
  if (!del.open) {
    return h('button', {
      type: 'button', class: 'text-btn danger delete-open',
      onclick: () => { del.open = true; del.focus = true; render(); },
    }, 'Delete account');
  }
  const byEmail = del.proof === 'email';
  const input = textInput({
    id: 'deleteProof', value: del.value, ...(byEmail
      ? { type: 'email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', placeholder: 'you@company.com' }
      : { type: 'password', autocomplete: 'current-password', placeholder: 'Your password' }),
  });
  input.addEventListener('input', () => { del.value = input.value; });
  const submit = h('button', { class: 'cta danger', type: 'submit', disabled: del.busy }, del.busy ? 'Deleting…' : 'Delete my account');
  const form = h('form', { class: 'delete-form', novalidate: true },
    field({ key: 'proof', label: byEmail ? 'Your email address' : 'Your password', control: input,
      help: byEmail ? 'You sign in with Google, Apple or Microsoft, so type your email address to confirm.' : 'Type it to confirm.' }),
    formError(),
    del.jobs.length
      ? h('ul', { class: 'delete-jobs', 'aria-label': 'Jobs that aren’t finished' }, del.jobs.map((j) => h('li', {},
        h('button', {
          type: 'button', class: 'delete-job',
          // Leaving for the job: the typed password and the refusal are not kept for the way back (review rs-4).
          onclick: () => { Object.assign(del, { value: '', error: null, jobs: [] }); openJob(j.id, 'settings'); },
        }, j.title || 'Your job'))))
      : null,
    h('div', { class: 'delete-actions' },
      submit,
      h('button', { class: 'cta ghost', type: 'button', disabled: del.busy, onclick: () => { closeDelete(); render(); } }, 'Keep my account')),
  );
  if (del.error) showErrors(form, { [del.error.field]: del.error.message });
  form.addEventListener('submit', (e) => { e.preventDefault(); deleteAccount(form, submit); });
  return h('section', { class: 'panel delete-account', 'aria-labelledby': 'deleteTitle' },
    h('h2', { class: 'delete-title', id: 'deleteTitle' }, 'Delete your account'),
    h('p', { class: 'delete-text' }, DELETE_TEXT),
    form);
}

async function deleteAccount(form, submit) {
  if (del.busy) return;
  clearErrors(form);
  del.error = null;
  const byEmail = del.proof === 'email';
  if (!(byEmail ? del.value.trim() : del.value)) {
    del.error = { field: 'proof', message: byEmail ? 'Type your email address.' : 'Type your password.' };
    showErrors(form, { proof: del.error.message });
    return;
  }
  del.busy = true;
  submit.disabled = true;
  submit.textContent = 'Deleting…';
  const keep = form.querySelector('.delete-actions .cta.ghost');
  if (keep) keep.disabled = true;
  try {
    await api.deleteAccount(byEmail ? { email: del.value } : { password: del.value });
  } catch (err) {
    del.busy = false;
    // The session ended meanwhile: api.js has already gone to the sign-in screen.
    if (err.code === 'sign_in_required') return;
    if (err.code === 'email_required' || err.code === 'password_required') {
      // The account proves itself the other way (no password: its email). Ask for that one instead.
      del.proof = err.code === 'email_required' ? 'email' : 'password';
      del.value = '';
      del.focus = true;
    }
    if (err.code === 'job_in_progress') del.jobs = Array.isArray(err.body?.jobs) ? err.body.jobs : [];
    const onField = err.code === 'wrong_password' || err.code === 'wrong_email';
    // The keyboard stays where the answer is (the redraw would drop it on the page): the box after a wrong answer,
    // the first unfinished job after a refusal (review rs-3).
    if (!del.focus) del.focus = del.jobs.length ? 'job' : onField ? 'retry' : true;
    del.error = { field: onField ? 'proof' : 'form', message: err.message || 'That didn’t go through. Try again.' };
    render();
    return;
  }
  // Deleted. The server dropped this account's devices with it; the browser lets go of its subscription too.
  await releaseDevice(undefined, { server: false });
  signedOut();
  ui.draft = null;
  setView('signin');
  showToast('Your account is deleted.');
}

// The confirm form's box gets the keyboard when it opens, again when it asks for the email address instead, and after a
// refusal: a wrong answer selects what was typed (retype at once), a job in progress focuses the first listed job.
onAfterRender((view) => {
  if (view !== 'settings' || !del.focus) return;
  const box = document.getElementById('deleteProof');
  if (!box) return;
  const want = del.focus;
  del.focus = false;
  const job = want === 'job' ? document.querySelector('.delete-account .delete-job') : null;
  (job ?? box).closest('.delete-account')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  (job ?? box).focus({ preventScroll: true });
  if (!job && want === 'retry') box.select();
});

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
    hire ? null : section('Trades', tradesSection(d, ui.trades), subWorkSection(d)),
    section('Location', whereSection(d, hire ? { radius: false } : {})),
    hire ? null : section('Job size and limits', jobsSection(d)),
    hire ? null : section('Cost settings', withCosts() ? costsSection(d) : costsLocked()),
    hire ? null : section('Your paperwork', paperworkSection(d)),
    hire ? null : section('Set-aside certifications', setAsidesSection(d, ui.setAsides)),
    section('Your work profile', h('p', { class: 'field-help wp-intro' }, 'What people you deal with on a job see about you. Everything here is optional.'), workBody),
    work ? section('How others see you', work.preview, h('p', { class: 'field-help' }, 'Shown only to people you deal with on a job. Never your email, phone or address.')) : null,
    section('Alerts', pushRow(), alertsSection(d, hire ? { kinds: true, kindIds: HIRE_KINDS, minScore: false, timeZone: true, features: f } : { kinds: true, timeZone: true, features: f })),
    formError(),
    h('div', { class: 'save-bar' }, saveBtn),
  );
  form.addEventListener('submit', (e) => { e.preventDefault(); if (!ui.busy) save(form, saveBtn); });

  return h('div', { class: 'screen settings' },
    h('header', { class: 'screen-head' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', onclick: back }, icon(ICONS.back)),
      h('h1', {}, 'Settings'),
      h('span', { class: 'icon-btn ghost', 'aria-hidden': 'true' }),
    ),
    ui.confirm ? confirmBar(() => { if (!ui.busy) save(form, saveBtn); }) : null,
    planCard(),
    form,
    h('button', { type: 'button', class: 'cta ghost signout', onclick: () => { ui.draft = null; signOut(); } }, 'Sign out'),
    // Apple and Google ask for account deletion inside the app: here, under Sign out (src/routes/account.ts).
    deleteAccountSection(),
    // The Microsoft Store asks for the privacy policy inside the app too (web/privacy.html, same origin).
    h('p', { class: 'fine' }, h('a', { class: 'fine-link', href: 'privacy.html', target: '_blank', rel: 'noopener' }, 'Privacy policy'),
      ' · ', h('a', { class: 'fine-link', href: 'terms.html', target: '_blank', rel: 'noopener' }, 'Terms')),
  );
}

registerView('settings', { chrome: 'screen', render: renderSettings });
