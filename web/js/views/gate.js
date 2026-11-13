// The access-code gate (ACCESS_CODE set on the server): ask once, remember it on this device.

import { bolt, h, store } from '../dom.js';
import { registerView, render, setView } from '../shell.js';
import { state } from '../state.js';

let message;
let retry = async () => {};

function renderGate() {
  const input = h('input', { type: 'password', inputmode: 'text', autocomplete: 'off', placeholder: 'Access code', 'aria-label': 'Access code' });
  const go = async () => {
    state.accessCode = input.value.trim();
    store.set('bidswipe:code', state.accessCode);
    await retry();
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  return h('div', { class: 'gate' },
    h('div', { class: 'empty' }, bolt('hero-bolt'), h('h3', {}, 'Enter your access code'), h('p', {}, message ?? 'Ask whoever set up BidSwipe for your company.')),
    input,
    h('button', { class: 'cta', type: 'button', onclick: go }, 'Continue'),
  );
}

registerView('gate', { chrome: 'screen', render: renderGate });

/** Show the gate; `again` runs after a code is entered (main.js passes boot). */
export function showGate(text, again) {
  message = text;
  retry = again;
  if (state.view === 'gate') render();
  else setView('gate');
}
