// Sign in / create account (accounts mode). Email + password, plus Google / Apple / Microsoft
// only when GET /api/auth/config lists them (they sign in through Supabase and come back with a token).
//
// "Forgot password?" (ui.tab 'forgot'): when the server can send email (authConfig.passwordReset) it asks for the
// address and says one thing whatever the address is; when it cannot, it says plainly that reset by email is not
// available yet and offers no form. 'reset' is where the emailed link lands (main.js reads #reset=<token>).

import { api } from '../api.js';
import { bolt, h, icon, ICONS, showToast } from '../dom.js';
import { clearErrors, field, formError, showErrors, textInput } from '../form.js';
import { promoWaiting } from '../promo.js';
import { enterApp, loadAuthConfig, onSignedOut } from '../session.js';
import { registerView, render } from '../shell.js';
import { state } from '../state.js';

const PROVIDERS = [
  { id: 'google', label: 'Continue with Google' },
  { id: 'apple', label: 'Continue with Apple' },
  { id: 'azure', label: 'Continue with Microsoft' },
];

/** API error → which box it belongs under. */
const ERROR_FIELD = { invalid_email: 'email', invalid_password: 'password' };

// sent: the server's answer to a reset request (shown instead of the form). token: the emailed link's, kept in
// memory only (main.js took it out of the address bar). stale: that link was refused.
const ui = { tab: 'login', email: '', busy: false, sent: null, token: null, stale: false };
onSignedOut(() => { if (ui.tab !== 'reset') ui.tab = 'login'; }); // whoever comes back next is most likely signing in

/** Send the browser to Supabase's sign-in page for one provider; it comes back to this page with #access_token=… */
function startOAuth(provider) {
  const { supabase } = state.authConfig ?? {};
  if (!supabase?.url) return;
  const back = `${location.origin}${location.pathname}`;
  location.assign(`${supabase.url.replace(/\/+$/, '')}/auth/v1/authorize?provider=${encodeURIComponent(provider)}&redirect_to=${encodeURIComponent(back)}`);
}

function messageFor(err) {
  if (err.code === 'too_many_attempts') return 'Too many tries. Wait a few minutes, then try again.';
  if (err.code === 'csrf') return 'Your session is out of date. Reload the page and try again.';
  return err.message || 'That did not work. Try again.';
}

/** A password box with its show / hide eye. */
function passwordBox(props) {
  const password = textInput({ type: 'password', class: 'input has-eye', ...props });
  const eye = h('button', { type: 'button', class: 'eye', 'aria-label': 'Show password', 'aria-pressed': 'false' }, icon(ICONS.eye));
  eye.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(show));
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    eye.replaceChildren(icon(show ? ICONS.eyeOff : ICONS.eye));
    password.focus();
  });
  return { password, control: h('div', { class: 'with-eye' }, password, eye) };
}

const hero = () => h('div', { class: 'hero' }, bolt('hero-bolt'), h('h1', {}, 'BidSwipe'), h('p', {}, 'Public bids that fit your trade, one swipe at a time.'));
const backToSignIn = (label = 'Back to sign in') =>
  h('button', { type: 'button', class: 'text-btn auth-back', onclick: () => { Object.assign(ui, { tab: 'login', sent: null, busy: false }); render(); } }, label);

/** "Forgot password?": ask for the address, or say plainly that this server cannot email a link yet. */
function forgotPanel() {
  if (!state.authConfig) return h('div', { class: 'panel auth-note' }, h('p', {}, 'Loading…'));
  const title = h('h2', { class: 'auth-title' }, 'Forgot your password?');
  if (!state.authConfig.passwordReset) {
    return h('div', { class: 'panel auth-note' }, title,
      h('p', { class: 'auth-plain' }, 'Password reset by email is not available yet.'),
      h('p', {}, 'BidSwipe can’t send you a reset link right now, so nothing was sent. If you remember your password later, sign in as usual.'),
      backToSignIn());
  }
  if (ui.sent) {
    return h('div', { class: 'panel auth-note' }, h('h2', { class: 'auth-title' }, 'Check your email'),
      h('p', {}, ui.sent),
      h('p', {}, 'No email after a few minutes? Check the address and your spam folder. If you signed up with Google, Apple or Microsoft, there is no password to reset: use that button to sign in.'),
      backToSignIn());
  }
  const email = textInput({ type: 'email', value: ui.email, autocomplete: 'email', inputmode: 'email', placeholder: 'you@company.com', autocapitalize: 'off', spellcheck: 'false' });
  email.addEventListener('input', () => (ui.email = email.value));
  const submit = h('button', { class: 'cta', type: 'submit' }, 'Email me a reset link');
  const form = h('form', { class: 'auth-form', novalidate: true },
    field({ key: 'email', label: 'Email', help: 'The address you signed up with.', control: email }),
    formError(),
    submit,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ui.busy) return;
    clearErrors(form);
    ui.busy = true;
    submit.disabled = true;
    submit.textContent = 'Sending…';
    try {
      const res = await api.forgotPassword(email.value.trim());
      ui.busy = false;
      ui.sent = res.message;
      render();
    } catch (err) {
      ui.busy = false;
      submit.disabled = false;
      submit.textContent = 'Email me a reset link';
      // 503 reset_unavailable, 502 email_failed and 429 each carry their own plain sentence: nothing was sent.
      showErrors(form, { [ERROR_FIELD[err.code] ?? 'form']: err.message || 'That did not work. Nothing was sent. Try again.' });
    }
  });
  return h('div', { class: 'panel' }, title,
    h('p', { class: 'auth-lead' }, 'We’ll email you a link to choose a new one. It works once, for an hour.'),
    form, backToSignIn());
}

/** Where the emailed link lands: choose the new password. The token never leaves memory. */
function resetPanel() {
  const title = h('h2', { class: 'auth-title' }, 'Choose a new password');
  if (ui.stale || !ui.token) {
    return h('div', { class: 'panel auth-note' }, title,
      h('p', { class: 'auth-plain' }, 'That reset link is no longer valid.'),
      h('p', {}, 'A link works once, for an hour, and a newer link replaces an older one. Your password was not changed.'),
      h('button', { type: 'button', class: 'cta', onclick: () => { Object.assign(ui, { tab: 'forgot', token: null, stale: false, sent: null }); render(); } }, 'Ask for a new link'),
      h('button', { type: 'button', class: 'text-btn auth-back', onclick: leaveReset }, 'Back to BidSwipe'));
  }
  const { password, control } = passwordBox({ autocomplete: 'new-password', placeholder: '8 or more characters' });
  const submit = h('button', { class: 'cta', type: 'submit' }, 'Save new password');
  const form = h('form', { class: 'auth-form', novalidate: true },
    field({ key: 'password', label: 'New password', help: 'Use 8 to 128 characters. Saving signs you out on your other devices.', control }),
    formError(),
    submit,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ui.busy) return;
    clearErrors(form);
    ui.busy = true;
    submit.disabled = true;
    submit.textContent = 'Saving…';
    try {
      await api.resetPassword(ui.token, password.value);
      Object.assign(ui, { busy: false, token: null, tab: 'login' });
      await enterApp();
      showToast('Password changed. You’re signed in.');
    } catch (err) {
      ui.busy = false;
      if (err.code === 'reset_link_invalid') {
        ui.stale = true;
        return render();
      }
      submit.disabled = false;
      submit.textContent = 'Save new password';
      showErrors(form, { [ERROR_FIELD[err.code] ?? 'form']: messageFor(err) });
    }
  });
  return h('div', { class: 'panel' }, title, form,
    h('button', { type: 'button', class: 'text-btn auth-back', onclick: leaveReset }, 'Cancel'));
}

/** Leave the reset screen without using the link: start the app the normal way (signed in or not). */
function leaveReset() {
  Object.assign(ui, { tab: 'login', token: null, stale: false });
  location.reload(); // the token is already out of the address, so this is a plain start of the app
}

function renderSignIn() {
  if (!state.authConfig) {
    loadAuthConfig().then(() => state.view === 'signin' && render());
  }
  if (ui.tab === 'forgot' || ui.tab === 'reset') {
    return h('div', { class: 'screen auth' }, hero(), ui.tab === 'forgot' ? forgotPanel() : resetPanel(),
      h('p', { class: 'fine' }, h('a', { class: 'fine-link', href: 'privacy.html', target: '_blank', rel: 'noopener' }, 'Privacy policy'),
        ' · ', h('a', { class: 'fine-link', href: 'terms.html', target: '_blank', rel: 'noopener' }, 'Terms')));
  }
  const creating = ui.tab === 'signup';
  const email = textInput({ type: 'email', value: ui.email, autocomplete: 'email', inputmode: 'email', placeholder: 'you@company.com', autocapitalize: 'off', spellcheck: 'false' });
  email.addEventListener('input', () => (ui.email = email.value));
  const { password, control: passwordControl } = passwordBox({ autocomplete: creating ? 'new-password' : 'current-password', placeholder: creating ? '8 or more characters' : 'Your password' });

  const submit = h('button', { class: 'cta', type: 'submit' }, creating ? 'Create account' : 'Sign in');
  const form = h('form', { class: 'auth-form', novalidate: true },
    field({ key: 'email', label: 'Email', control: email }),
    field({ key: 'password', label: 'Password', help: creating ? 'Use 8 to 128 characters.' : null, control: passwordControl }),
    formError(),
    submit,
    creating ? null : h('button', { type: 'button', class: 'text-btn auth-forgot', onclick: () => { Object.assign(ui, { tab: 'forgot', sent: null }); render(); } }, 'Forgot password?'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ui.busy) return;
    clearErrors(form);
    ui.busy = true;
    submit.disabled = true;
    submit.textContent = creating ? 'Creating account…' : 'Signing in…';
    try {
      if (creating) await api.signUp(email.value.trim(), password.value);
      else await api.logIn(email.value.trim(), password.value);
      ui.busy = false;
      await enterApp();
    } catch (err) {
      ui.busy = false;
      submit.disabled = false;
      submit.textContent = creating ? 'Create account' : 'Sign in';
      showErrors(form, { [ERROR_FIELD[err.code] ?? 'form']: messageFor(err) });
    }
  });

  const providers = PROVIDERS.filter((p) => state.authConfig?.providers?.includes(p.id) && state.authConfig?.supabase?.url);
  const tabBtn = (id, label) => h('button', {
    type: 'button', role: 'tab', class: `seg-btn${ui.tab === id ? ' is-on' : ''}`, 'aria-selected': String(ui.tab === id),
    onclick: () => { ui.tab = id; render(); },
  }, label);

  return h('div', { class: 'screen auth' },
    hero(),
    h('div', { class: 'panel' },
      h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Sign in or create an account' },
        tabBtn('login', 'Sign in'), tabBtn('signup', 'Create account')),
      // Came from a ?promo= link: the code is kept and applied once setup is done; say so before the password.
      promoWaiting() ? h('p', { class: 'promo-waiting' }, 'Your promo code is saved — it’s applied when you finish setting up.') : null,
      form,
      providers.length
        ? h('div', { class: 'providers' },
          h('div', { class: 'or' }, h('span', {}, 'or')),
          providers.map((p) => h('button', { type: 'button', class: 'cta ghost provider', onclick: () => startOAuth(p.id) }, p.label)))
        : null,
    ),
    h('p', { class: 'fine' },
      creating ? 'Free to start. We never take bids — you bid on the agency’s own site.' : 'We never take bids — you bid on the agency’s own site.',
      state.authConfig?.demo ? h('span', { class: 'demo-flag' }, 'Demo mode: all features on') : null,
      h('br'), h('a', { class: 'fine-link', href: 'privacy.html', target: '_blank', rel: 'noopener' }, 'Privacy policy'),
      ' · ', h('a', { class: 'fine-link', href: 'terms.html', target: '_blank', rel: 'noopener' }, 'Terms')),
  );
}

registerView('signin', { chrome: 'screen', render: renderSignIn });

/**
 * Open the sign-in screen on a given tab ('login' | 'signup'). `blank`: forget the address typed before (after
 * an account was deleted, its email has no business sitting in the box).
 */
export function showSignIn(tab = 'login', { blank = false } = {}) {
  Object.assign(ui, { tab, sent: null, ...(blank ? { email: '' } : {}) });
  state.view = 'signin';
  render();
}

/** Opened from a password reset email (main.js): the "choose a new password" screen for that link's token. */
export function showResetPassword(token) {
  Object.assign(ui, { tab: 'reset', token, stale: false, busy: false });
  state.view = 'signin';
  render();
}
