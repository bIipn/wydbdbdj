// Sign in / create account (accounts mode). Email + password, plus Google / Apple / Microsoft
// only when GET /api/auth/config lists them (they sign in through Supabase and come back with a token).

import { api } from '../api.js';
import { bolt, h, icon, ICONS } from '../dom.js';
import { clearErrors, field, formError, showErrors, textInput } from '../form.js';
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

const ui = { tab: 'login', email: '', busy: false };
onSignedOut(() => { ui.tab = 'login'; }); // whoever comes back next is most likely signing in

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

function renderSignIn() {
  if (!state.authConfig) {
    loadAuthConfig().then(() => state.view === 'signin' && render());
  }
  const creating = ui.tab === 'signup';
  const email = textInput({ type: 'email', value: ui.email, autocomplete: 'email', inputmode: 'email', placeholder: 'you@company.com', autocapitalize: 'off', spellcheck: 'false' });
  email.addEventListener('input', () => (ui.email = email.value));
  const password = textInput({ type: 'password', autocomplete: creating ? 'new-password' : 'current-password', placeholder: creating ? '8 or more characters' : 'Your password', class: 'input has-eye' });
  const eye = h('button', { type: 'button', class: 'eye', 'aria-label': 'Show password', 'aria-pressed': 'false' }, icon(ICONS.eye));
  eye.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(show));
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    eye.replaceChildren(icon(show ? ICONS.eyeOff : ICONS.eye));
    password.focus();
  });

  const submit = h('button', { class: 'cta', type: 'submit' }, creating ? 'Create account' : 'Sign in');
  const form = h('form', { class: 'auth-form', novalidate: true },
    field({ key: 'email', label: 'Email', control: email }),
    field({ key: 'password', label: 'Password', help: creating ? 'Use 8 to 128 characters.' : null, control: h('div', { class: 'with-eye' }, password, eye) }),
    formError(),
    submit,
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
    h('div', { class: 'hero' },
      bolt('hero-bolt'),
      h('h1', {}, 'BidSwipe'),
      h('p', {}, 'Public bids that fit your trade, one swipe at a time.'),
    ),
    h('div', { class: 'panel' },
      h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Sign in or create an account' },
        tabBtn('login', 'Sign in'), tabBtn('signup', 'Create account')),
      form,
      providers.length
        ? h('div', { class: 'providers' },
          h('div', { class: 'or' }, h('span', {}, 'or')),
          providers.map((p) => h('button', { type: 'button', class: 'cta ghost provider', onclick: () => startOAuth(p.id) }, p.label)))
        : null,
    ),
    h('p', { class: 'fine' },
      creating ? 'Free to start. We never take bids — you bid on the agency’s own site.' : 'We never take bids — you bid on the agency’s own site.',
      state.authConfig?.demo ? h('span', { class: 'demo-flag' }, 'Demo mode: all features on') : null),
  );
}

registerView('signin', { chrome: 'screen', render: renderSignIn });

/** Open the sign-in screen on a given tab ('login' | 'signup'). */
export function showSignIn(tab = 'login') {
  ui.tab = tab;
  state.view = 'signin';
  render();
}
