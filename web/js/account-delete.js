// "Delete my account", at the bottom of Settings (accounts mode).
//
// A quiet link opens a panel that says, for THIS account, what deleting ends (GET /api/account/deletion counts
// it: the jobs taken down, the people told, the jobs handed back, the fee lines that stay), asks for the password
// again, and only then sends DELETE /api/account. Nothing is deleted before the server has checked the password.
// An account with no password (Google / Apple / Microsoft sign-in) signs in again and types its email instead.
// Afterwards the app is signed out and says the account was deleted.

import { api } from './api.js';
import { h, showToast } from './dom.js';
import { clearErrors, field, formError, showErrors, textInput } from './form.js';
import { dollars } from './job-words.js';
import { usd } from './money.js';
import { onSignedOut, signedOut } from './session.js';
import { render } from './shell.js';
import { showSignIn } from './views/signin.js';

const fresh = () => ({ open: false, info: null, error: null, loading: false, busy: false, typed: '' });
let ui = fresh();
onSignedOut(() => { ui = fresh(); });

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the server says this deletion would end, one plain line each. Lines that do not apply are left out. */
function endsList(ends) {
  const lines = ['Your profile, saved and passed bids, alerts, cost checks, work profile and phone-alert devices are deleted.'];
  if (ends.jobsPosted) {
    const told = ends.bidsOnOpenPosted ? ` The ${count(ends.bidsOnOpenPosted, 'person', 'people')} with a sealed bid on ${ends.openPosted === 1 ? 'your open job' : 'your open jobs'} ${ends.bidsOnOpenPosted === 1 ? 'is' : 'are'} told.` : '';
    lines.push(`The ${count(ends.jobsPosted, 'job')} you posted ${ends.jobsPosted === 1 ? 'is' : 'are'} removed, with ${ends.jobsPosted === 1 ? 'its' : 'their'} bids and messages.${told}`);
  }
  for (const j of ends.livePosted) lines.push(`“${j.title}” ends for its winner, who is told and owes nothing.`);
  for (const j of ends.liveWon) {
    lines.push(`“${j.title}”${j.awardCents != null ? ` (your bid ${dollars(j.awardCents)})` : ''} goes back to its poster, who is told. No fee is recorded for it.`);
  }
  if (ends.activeBids) lines.push(`Your ${count(ends.activeBids, 'sealed bid')} on open jobs ${ends.activeBids === 1 ? 'is' : 'are'} withdrawn.`);
  if (ends.feeLines) {
    lines.push(`${count(ends.feeLines, 'fee line')} recorded for you (${usd(ends.feeCents)}, not collected) ${ends.feeLines === 1 ? 'stays' : 'stay'} in BidSwipe’s records with the name on your account, without your email.`);
  }
  return h('ul', { class: 'delete-list' }, lines.map((l) => h('li', {}, l)));
}

function close() {
  ui = fresh();
  render();
}

async function load() {
  ui.loading = true;
  try {
    ui.info = await api.accountDeletion();
    ui.error = null;
  } catch (err) {
    ui.error = err.message || 'Couldn’t load this. Check your connection and try again.';
  }
  ui.loading = false;
  render();
}

function panel() {
  const head = [
    h('h2', { id: 'deleteTitle' }, 'Delete your account?'),
    h('p', {}, 'This removes your account and everything tied to it, for good. It can’t be undone.'),
  ];
  const keep = h('button', { class: 'cta ghost', type: 'button', onclick: close }, 'Keep my account');
  if (!ui.info) {
    if (!ui.loading && !ui.error) load();
    return h('section', { class: 'panel delete-panel', role: 'alertdialog', 'aria-labelledby': 'deleteTitle' }, head,
      h('p', { class: ui.error ? 'field-error' : 'field-help' }, ui.error ?? 'Checking what this would end…'),
      h('div', { class: 'delete-actions' },
        ui.error ? h('button', { class: 'cta ghost', type: 'button', onclick: () => { ui.error = null; render(); } }, 'Try again') : null, keep));
  }

  const byPassword = ui.info.confirmWith === 'password';
  const input = byPassword
    ? textInput({ type: 'password', autocomplete: 'current-password', placeholder: 'Your password', value: ui.typed })
    : textInput({ type: 'email', autocomplete: 'off', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', placeholder: ui.info.email, value: ui.typed });
  input.addEventListener('input', () => { ui.typed = input.value; });
  const submit = h('button', { class: 'cta danger', type: 'submit', disabled: ui.busy }, ui.busy ? 'Deleting…' : 'Delete my account');
  const form = h('form', { class: 'delete-form', novalidate: true },
    byPassword
      ? field({ key: 'password', label: 'Your password, to confirm it’s you', control: input })
      : field({
        key: 'confirm', label: 'Your email address, to confirm', control: input,
        help: 'This account has no password (it signs in with Google, Apple or Microsoft). Sign out, sign in again, then delete it here within 10 minutes.',
      }),
    formError(),
    h('div', { class: 'delete-actions' }, submit, keep),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ui.busy) return;
    clearErrors(form);
    if (!ui.typed) return void showErrors(form, { [byPassword ? 'password' : 'confirm']: byPassword ? 'Type your password to confirm.' : 'Type your email address to confirm.' });
    ui.busy = true;
    submit.disabled = true;
    submit.textContent = 'Deleting…';
    try {
      await api.deleteAccount(byPassword ? { password: ui.typed } : { confirm: ui.typed.trim() });
    } catch (err) {
      ui.busy = false;
      submit.disabled = false;
      submit.textContent = 'Delete my account';
      const where = { wrong_password: 'password', confirm_mismatch: 'confirm' }[err.code] ?? 'form';
      return void showErrors(form, { [where]: err.message || 'That did not work. Your account was not deleted.' });
    }
    // Gone on the server: this device is signed out, and says so. The sign-in box starts empty.
    signedOut();
    showSignIn('login', { blank: true });
    window.scrollTo({ top: 0 });
    showToast('Your account was deleted.', null, '', 8000);
  });

  return h('section', { class: 'panel delete-panel', role: 'alertdialog', 'aria-labelledby': 'deleteTitle' },
    head, endsList(ui.info.ends), form,
    h('p', { class: 'field-help delete-more' }, 'What is deleted and what is kept: ',
      h('a', { class: 'fine-link', href: 'privacy.html#delete', target: '_blank', rel: 'noopener' }, 'Privacy policy'), '.'),
  );
}

/** The quiet link under Sign out, or the open panel. */
export function deleteAccountSection() {
  if (ui.open) return panel();
  return h('button', { type: 'button', class: 'text-btn danger delete-link', onclick: () => { ui.open = true; render(); } }, 'Delete my account');
}
