// Form building blocks: labelled fields with an error line, $ inputs, toggles, and API field errors.
//
// Every field wrapper carries data-field="<API field path>" (e.g. "valueRange.max"), so the
// { fields: { path: message } } object from a 400 lands under the right box via showErrors().

import { $$, h } from './dom.js';
import { dollarsText } from './format.js';

let uid = 0;
export const nextId = (prefix) => `${prefix}-${++uid}`;

/**
 * A labelled field: label, the control, one line of plain help, and an (empty) error line.
 * `control` is an input/select/node; its id is wired to the label.
 */
export function field({ key, label, help, control, optional = false }) {
  const target = control.matches?.('input, select, textarea') ? control : control.querySelector?.('input, select, textarea');
  const id = target ? (target.id ||= nextId('f')) : (control.id ||= nextId('f'));
  const err = h('p', { class: 'field-error', id: `${id}-err`, role: 'alert' });
  if (target) target.setAttribute('aria-describedby', `${id}-err`);
  return h('div', { class: 'field', 'data-field': key },
    h('label', { class: 'field-label', for: id }, label, optional ? h('span', { class: 'optional' }, 'optional') : null),
    control,
    help ? h('p', { class: 'field-help' }, help) : null,
    err,
  );
}

export function textInput(props) {
  return h('input', { class: 'input', type: 'text', ...props });
}

/** A dollar amount box with a "$" in front. `text` is what the box shows; the caller parses it (parseDollars). */
export function moneyInput({ text, placeholder, oninput, label }) {
  const input = h('input', {
    class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: placeholder ?? '', 'aria-label': label,
    value: text ?? '', id: nextId('m'),
  });
  input.addEventListener('input', () => oninput(input.value));
  input.addEventListener('blur', () => {
    const n = Number(input.value.replace(/[$,\s]/g, ''));
    if (input.value.trim() && Number.isFinite(n)) input.value = dollarsText(n);
  });
  return h('div', { class: 'money' }, h('span', { class: 'money-sign', 'aria-hidden': 'true' }, '$'), input);
}

/** An on/off switch (a real checkbox underneath). */
export function toggle({ checked, label, onchange }) {
  const box = h('input', { type: 'checkbox', role: 'switch', checked: !!checked, id: nextId('t') });
  box.addEventListener('change', () => onchange(box.checked));
  return h('label', { class: 'switch', for: box.id }, h('span', {}, label), box, h('span', { class: 'switch-track', 'aria-hidden': 'true' }));
}

/** Clear every error line under `root`. */
export function clearErrors(root) {
  for (const f of $$('[data-field].has-error', root)) f.classList.remove('has-error');
  for (const p of $$('.field-error', root)) p.textContent = '';
}

/**
 * Show { path: message } under the matching fields. A path with no field of its own falls back to its
 * parent ("alerts.kinds.match" → "alerts"), then to the form-level line (data-field="form").
 * Returns the first field element that got an error, to scroll to.
 */
export function showErrors(root, fields) {
  clearErrors(root);
  let first = null;
  for (const [path, message] of Object.entries(fields ?? {})) {
    let key = path;
    let el = null;
    while (key) {
      el = root.querySelector(`[data-field="${CSS.escape(key)}"]`);
      if (el) break;
      key = key.includes('.') ? key.slice(0, key.lastIndexOf('.')) : '';
    }
    el ??= root.querySelector('[data-field="form"]');
    if (!el) continue;
    el.classList.add('has-error');
    const line = el.querySelector(':scope > .field-error') ?? el.querySelector('.field-error');
    if (line) line.textContent = line.textContent ? `${line.textContent} ${message}` : message;
    if (el.dataset.field !== 'form') {
      // The error goes as soon as the person starts fixing that field.
      const fixed = (e) => {
        if (e.type === 'click' && !e.target.closest('button')) return;
        el.classList.remove('has-error');
        if (line) line.textContent = '';
        el.removeEventListener('input', fixed);
        el.removeEventListener('click', fixed);
      };
      el.addEventListener('input', fixed);
      el.addEventListener('click', fixed);
    }
    first ??= el;
  }
  return first;
}

/** A form-level error line (data-field="form"). */
export const formError = () => h('div', { class: 'form-error-box', 'data-field': 'form' }, h('p', { class: 'field-error', role: 'alert' }));
