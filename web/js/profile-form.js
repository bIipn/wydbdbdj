// The profile questions, shared by onboarding (one section per step) and settings (all on one page).
//
// A "draft" holds what the person typed; answersFrom(draft) turns it into the PUT /api/profile body.
// Validation lives on the server (src/profile/build.ts); the few checks here only stop an empty step.

import { api } from './api.js';
import { h, icon, ICONS } from './dom.js';
import { dollarsText, fitWords, parseDollars } from './format.js';
import { field, moneyInput, textInput, toggle } from './form.js';

export const RADIUS = { min: 10, max: 300, step: 5 };
const DEFAULT_QUIET = { start: '21:00', end: '06:00' };

let tradesCache = null;
/** GET /api/trades, once. */
export async function loadTrades() {
  tradesCache ??= (await api.trades()).trades;
  return tradesCache;
}

export function emptyDraft() {
  return {
    businessName: '', trades: [], zip: '', place: null, radiusMi: 60,
    min: '', max: '', limits: { maxJobSize: '', maxUpfront: '', bondingCapacity: '' },
    minScore: 55, quietOn: false, quiet: { ...DEFAULT_QUIET },
    keep: {}, // settings the form does not show, sent back unchanged (costs, set-asides, push, alert kinds)
  };
}

/** A saved profile (ProfileSummary from /api/me) → a draft to edit. */
export function draftFromSummary(p) {
  const d = emptyDraft();
  d.businessName = p.businessName ?? '';
  d.trades = [...(p.trades ?? [])];
  d.zip = p.zip ?? '';
  d.place = p.zip ? { zip: p.zip, label: p.base } : null;
  d.radiusMi = p.radiusMi ?? 60;
  d.min = dollarsText(p.valueRange?.min);
  d.max = dollarsText(p.valueRange?.max);
  for (const k of Object.keys(d.limits)) d.limits[k] = dollarsText(p.limits?.[k]);
  d.minScore = p.alerts?.minScore ?? 55;
  d.quietOn = !!p.alerts?.quietHours;
  d.quiet = { ...(p.alerts?.quietHours ?? DEFAULT_QUIET) };
  const { push, kinds, timeZone } = p.alerts ?? {};
  d.keep = {
    costs: Object.values(p.costs ?? {}).some((v) => v != null) ? p.costs : undefined,
    setAsides: p.setAsides?.length ? p.setAsides : undefined,
    push, kinds, timeZone,
  };
  return d;
}

/** "50,000" → 50000; blank → null; anything else is sent as typed so the server names the problem. */
const amount = (text) => {
  const n = parseDollars(text);
  return Number.isNaN(n) ? String(text) : n;
};

function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}

/** The PUT /api/profile body. */
export function answersFrom(d) {
  const limits = {};
  for (const [k, v] of Object.entries(d.limits)) limits[k] = amount(v);
  const alerts = {
    minScore: d.minScore,
    quietHours: d.quietOn ? { start: d.quiet.start, end: d.quiet.end } : null,
  };
  const tz = d.keep.timeZone ?? browserTimeZone();
  if (tz) alerts.timeZone = tz;
  if (d.keep.push !== undefined) alerts.push = d.keep.push;
  if (d.keep.kinds) alerts.kinds = d.keep.kinds;
  const body = {
    businessName: d.businessName,
    trades: d.trades,
    zip: d.zip.trim(),
    radiusMi: d.radiusMi,
    valueRange: { min: amount(d.min) ?? 0, max: amount(d.max) },
    limits,
    alerts,
  };
  if (d.keep.costs) body.costs = d.keep.costs;
  if (d.keep.setAsides) body.setAsides = d.keep.setAsides;
  return body;
}

// ------------------------------------------------------------- sections --

export function nameSection(d) {
  const input = textInput({ value: d.businessName, autocomplete: 'organization', placeholder: 'e.g. Carson Valley Electric', maxlength: 80, enterkeyhint: 'next' });
  input.addEventListener('input', () => (d.businessName = input.value));
  return field({ key: 'businessName', label: 'Business name', help: 'How your company shows up in BidSwipe.', control: input });
}

export function tradesSection(d, trades) {
  const picked = () => new Set(d.trades);
  const blurb = h('p', { class: 'field-help' });
  const showBlurb = () => {
    const names = trades.filter((t) => d.trades.includes(t.id));
    blurb.textContent = names.length
      ? names.map((t) => t.blurb).join(' · ')
      : 'Pick up to 4. We look for bids with this kind of scope.';
  };
  const chips = trades.map((t) => {
    const b = h('button', { type: 'button', class: 'trade-chip', 'aria-pressed': String(picked().has(t.id)) },
      h('span', { class: 'tick', 'aria-hidden': 'true' }, icon(ICONS.check)), t.label);
    b.addEventListener('click', () => {
      const on = picked().has(t.id);
      if (!on && d.trades.length >= 4) {
        blurb.textContent = 'Up to 4 trades. Tap one you picked to remove it first.';
        return;
      }
      d.trades = on ? d.trades.filter((x) => x !== t.id) : [...d.trades, t.id];
      b.setAttribute('aria-pressed', String(!on));
      showBlurb();
    });
    return b;
  });
  showBlurb();
  const group = h('div', { class: 'trade-chips', role: 'group', 'aria-label': 'Trades' }, chips);
  const wrap = h('div', { class: 'field', 'data-field': 'trades' },
    h('p', { class: 'field-label' }, 'Your trades'),
    group, blurb, h('p', { class: 'field-error', role: 'alert' }));
  return wrap;
}

/** ZIP with a live lookup ("Gardnerville, NV"), and the travel radius. */
export function whereSection(d) {
  const zip = textInput({ value: d.zip, inputmode: 'numeric', autocomplete: 'postal-code', maxlength: 10, placeholder: '89410', class: 'input zip' });
  const place = h('p', { class: 'place-line', 'aria-live': 'polite' });
  let ticket = 0;
  const showPlace = (state, text) => {
    place.className = `place-line ${state}`;
    place.replaceChildren(...(state === 'ok' ? [icon(ICONS.pin)] : []), h('span', {}, text));
  };
  const look = async () => {
    const digits = /^\s*(\d{5})/.exec(zip.value)?.[1];
    d.zip = zip.value;
    if (!digits) {
      d.place = null;
      return showPlace('idle', zip.value.trim() ? 'Enter all 5 digits.' : 'Bids are measured from the middle of your ZIP.');
    }
    if (d.place?.zip === digits) return showPlace('ok', d.place.label);
    const mine = ++ticket;
    showPlace('busy', 'Looking up…');
    try {
      const p = await api.zip(digits);
      if (mine !== ticket) return;
      d.place = { zip: p.zip, label: `${p.city}, ${p.state}` };
      showPlace('ok', d.place.label);
    } catch (err) {
      if (mine !== ticket) return;
      d.place = null;
      showPlace('bad', err.status === 404 ? `We can’t find ZIP ${digits}. Check the number.` : 'Couldn’t look that up right now.');
    }
  };
  zip.addEventListener('input', look);
  look();

  const readout = h('output', { class: 'range-value' });
  const range = h('input', { type: 'range', class: 'range', id: 'radius', min: RADIUS.min, max: RADIUS.max, step: RADIUS.step, value: d.radiusMi });
  const paint = () => {
    readout.textContent = `${d.radiusMi} mi`;
    range.style.setProperty('--pct', `${((d.radiusMi - RADIUS.min) / (RADIUS.max - RADIUS.min)) * 100}%`);
  };
  range.addEventListener('input', () => { d.radiusMi = Number(range.value); paint(); });
  paint();

  return h('div', { class: 'stack' },
    field({ key: 'zip', label: 'Shop ZIP code', control: zip }),
    place,
    h('div', { class: 'field', 'data-field': 'radiusMi' },
      h('div', { class: 'range-head' }, h('label', { class: 'field-label', for: 'radius' }, 'How far you’ll travel'), readout),
      range,
      h('div', { class: 'range-scale', 'aria-hidden': 'true' }, h('span', {}, `${RADIUS.min} mi`), h('span', {}, `${RADIUS.max} mi`)),
      h('p', { class: 'field-help' }, 'Bids farther than this are left out.'),
      h('p', { class: 'field-error', role: 'alert' }),
    ),
  );
}

export function jobsSection(d) {
  return h('div', { class: 'stack' },
    h('div', { class: 'subhead first' }, h('h3', {}, 'Jobs you want')),
    h('div', { class: 'pair' },
      field({ key: 'valueRange.min', label: 'From', control: moneyInput({ text: d.min, placeholder: '10,000', label: 'Smallest job you want', oninput: (v) => (d.min = v) }) }),
      field({ key: 'valueRange.max', label: 'Up to', control: moneyInput({ text: d.max, placeholder: '50,000', label: 'Largest job you want', oninput: (v) => (d.max = v) }) }),
    ),
    h('p', { class: 'field-help tight' }, 'Bids in this range score higher. You still see the rest in Browse.'),
    h('div', { class: 'subhead' }, h('h3', {}, 'Spend limits'), h('span', { class: 'optional' }, 'each optional')),
    limitField(d, 'maxJobSize', 'Largest job you can carry', 'Bigger bids stay out of your deck and get an “Over your limit” tag.'),
    limitField(d, 'maxUpfront', 'Most cash you can front', 'What you can pay out before the first payment comes in.'),
    limitField(d, 'bondingCapacity', 'Bonding capacity', 'Your single-job bonding limit, for bids that require a bond.'),
  );
}

function limitField(d, key, label, help) {
  return field({
    key: `limits.${key}`, label, help,
    control: moneyInput({ text: d.limits[key], placeholder: 'No limit', label, oninput: (v) => (d.limits[key] = v) }),
  });
}

export function alertsSection(d) {
  const readout = h('output', { class: 'range-value' });
  const words = h('p', { class: 'field-help' });
  const range = h('input', { type: 'range', class: 'range', min: 35, max: 95, step: 5, value: d.minScore, id: 'minfit' });
  const paint = () => {
    readout.textContent = String(d.minScore);
    words.textContent = `${fitWords(d.minScore)} — we only alert you when a bid scores ${d.minScore} or more out of 100.`;
    range.style.setProperty('--pct', `${((d.minScore - 35) / 60) * 100}%`);
  };
  range.addEventListener('input', () => { d.minScore = Number(range.value); paint(); });
  paint();

  const start = h('input', { type: 'time', class: 'input', value: d.quiet.start, 'aria-label': 'Quiet from' });
  const end = h('input', { type: 'time', class: 'input', value: d.quiet.end, 'aria-label': 'Quiet until' });
  start.addEventListener('input', () => (d.quiet.start = start.value));
  end.addEventListener('input', () => (d.quiet.end = end.value));
  const times = h('div', { class: 'pair times' },
    h('label', { class: 'mini' }, h('span', {}, 'From'), start),
    h('label', { class: 'mini' }, h('span', {}, 'Until'), end));
  times.hidden = !d.quietOn;

  return h('div', { class: 'stack' },
    h('div', { class: 'field', 'data-field': 'alerts.minScore' },
      h('div', { class: 'range-head' }, h('label', { class: 'field-label', for: 'minfit' }, 'Minimum fit to alert me'), readout),
      range, words, h('p', { class: 'field-error', role: 'alert' })),
    h('div', { class: 'field', 'data-field': 'alerts.quietHours' },
      toggle({ checked: d.quietOn, label: 'Quiet hours', onchange: (on) => { d.quietOn = on; times.hidden = !on; } }),
      times,
      h('p', { class: 'field-help' }, 'No alerts in these hours. The bids wait in your deck.'),
      h('p', { class: 'field-error', role: 'alert' })),
    h('div', { 'data-field': 'alerts' }, h('p', { class: 'field-error', role: 'alert' })),
  );
}
