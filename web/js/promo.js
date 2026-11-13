// Promo codes that unlock BidSwipe Pro (POST /api/promo/redeem).
//
// Two ways in:
//   1. Settings → Plan card → "Have a promo code?" → one box and Apply (promoRow below).
//   2. A link: …/?promo=CODE ("A%26Btest" is "A&Btest"; an unencoded "?promo=A&Btest" works too, see
//      promo-link.js). The code is read once when the app loads, taken out of the address bar at once,
//      remembered through sign-up and onboarding, and applied the moment the app is entered with a profile
//      (right after onboarding, or at once when already signed in).
//
// Apple guideline 3.1.1: the iOS App Store build must never show a code box. That build sets STORE_BUILD
// to 'ios' (api.js); the server then answers promo: false, and this module never captures or shows a code.
// The web app and the Microsoft Store build may.

import { api, STORE_BUILD } from './api.js';
import { h, showToast } from './dom.js';
import { takePromoFromSearch } from './promo-link.js';
import { applyMe, loadFeed, onEnteredApp, onSignedOut } from './session.js';
import { render } from './shell.js';
import { state } from './state.js';

const KEY = 'bidswipe:promo';
const CODE_MAX = 64; // the server refuses anything longer anyway

/**
 * The remembered link code. sessionStorage keeps it across the sign-up page and an OAuth round-trip in the
 * same tab; it can throw (private mode, sandboxed previews), so a plain variable backs it up.
 */
let memory = null;
const remembered = {
  get() { try { return sessionStorage.getItem(KEY) ?? memory; } catch { return memory; } },
  set(v) { memory = v; try { sessionStorage.setItem(KEY, v); } catch { /* memory only */ } },
  clear() { memory = null; try { sessionStorage.removeItem(KEY); } catch { /* memory only */ } },
};

/** Read ?promo= once, at load, and take it out of the address bar (nobody should copy a link with it by accident). */
function captureFromUrl() {
  // takePromoFromSearch, not URLSearchParams: a code with an unencoded '&' (…?promo=A&Btest) stays whole.
  const found = takePromoFromSearch(location.search);
  if (!found) return;
  const code = found.code.trim().slice(0, CODE_MAX);
  history.replaceState(null, '', location.pathname + found.rest + location.hash);
  if (code && STORE_BUILD !== 'ios') remembered.set(code);
}
captureFromUrl();

/** A code from a ?promo= link is waiting to be applied after sign-up (the sign-in screen says so). */
export const promoWaiting = () => STORE_BUILD !== 'ios' && !!remembered.get();

/** May this build, on this server, show the code box? (The server already says false for iOS and demo mode.) */
export const promoAvailable = () => STORE_BUILD !== 'ios' && state.authConfig?.promo === true;

const isFree = () => (state.me?.account?.plan ?? 'free') === 'free';

/**
 * Redeem a code, then reload who-am-I so every Pro feature shows at once, without a page reload.
 * Throws the ApiError (its message is the server's one plain sentence) when the code is refused.
 */
async function redeem(code) {
  const res = await api.redeemPromo(code);
  applyMe(await api.me());
  // Reload the feed too: every screen that cached a "locked" Pro answer (the Market price watch) drops it on
  // a feed load, so Pro shows everywhere at once. A failed reload is no reason to say the code failed.
  try { await loadFeed(); } catch { /* the next app open reloads it */ }
  return res;
}

// ------------------------------------------------- the link (?promo=) ---

/** After onboarding or on entering the app: apply the remembered link code once, whatever happens. */
async function applyRemembered() {
  const code = remembered.get();
  if (!code || state.auth !== 'accounts') return;
  remembered.clear(); // one try only: a failure is said once and never again
  if (!isFree()) return; // already Pro (or the pilot): nothing to unlock, nothing to say
  if (!promoAvailable()) return showToast('Promo codes aren’t available here, so that link’s code wasn’t applied');
  try {
    await redeem(code);
    render();
    showToast('BidSwipe Pro unlocked — every feature is on');
  } catch (err) {
    showToast(`That promo link didn’t work: ${err.message || 'try again later.'}`);
  }
}
onEnteredApp(() => { applyRemembered(); });

// ------------------------------------------- Settings: the code box ---

const ui = { open: false, value: '', error: '', busy: false };
onSignedOut(() => Object.assign(ui, { open: false, value: '', error: '', busy: false }));

/**
 * The quiet "Have a promo code?" row for the Plan card, or null when there is nothing to offer (not free,
 * no codes on this server, iOS). `onUnlocked` runs after a successful redeem, before the screen redraws.
 */
export function promoRow({ onUnlocked } = {}) {
  if (!isFree() || !promoAvailable()) return null;
  if (!ui.open) {
    return h('button', { type: 'button', class: 'text-btn promo-toggle', onclick: () => { ui.open = true; render(); focusBox(); } }, 'Have a promo code?');
  }

  const input = h('input', {
    class: 'input', type: 'text', id: 'promoCode', name: 'promo', value: ui.value, maxlength: CODE_MAX,
    autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go',
    'aria-describedby': 'promoErr', 'aria-invalid': ui.error ? 'true' : null,
  });
  const button = h('button', { class: 'cta promo-apply', type: 'submit', disabled: ui.busy }, ui.busy ? 'Checking…' : 'Apply');
  const error = h('p', { class: 'field-error', id: 'promoErr', role: 'alert' }, ui.error);
  input.addEventListener('input', () => { ui.value = input.value; });

  const form = h('form', { class: `promo-form${ui.error ? ' has-error' : ''}`, novalidate: true },
    h('label', { class: 'field-label', for: 'promoCode' }, 'Promo code'),
    h('div', { class: 'promo-line' }, input, button),
    error,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ui.busy) return;
    const code = input.value.trim();
    if (!code) return showError('Type the code first.');
    ui.busy = true;
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      await redeem(code);
      Object.assign(ui, { open: false, value: '', error: '', busy: false });
      onUnlocked?.();
      render();
      showToast('Pro unlocked');
    } catch (err) {
      ui.busy = false;
      button.disabled = false;
      button.textContent = 'Apply';
      showError(err.message || 'That didn’t go through. Try again.');
    }
  });

  /** Say what went wrong under the box, keep what was typed, and leave the cursor in it. */
  function showError(message) {
    ui.error = message;
    error.textContent = message;
    form.classList.add('has-error');
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }
  return form;
}

function focusBox() {
  requestAnimationFrame(() => document.getElementById('promoCode')?.focus());
}
