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
/** GET /api/trades, once: the trades and the set-aside programs (codes with their plain labels). */
async function catalog() {
  tradesCache ??= await api.trades();
  return tradesCache;
}
export const loadTrades = async () => (await catalog()).trades;
export const loadSetAsides = async () => (await catalog()).setAsides ?? [];

export const ALERT_KINDS = [
  { id: 'match', label: 'New bids that fit', help: 'A new bid scores at or above your minimum.', feature: null },
  { id: 'deadline', label: 'Deadline reminders', help: 'Bids you saved, before they close.', feature: null },
  { id: 'award', label: 'Award and result notices', help: 'Who won bids you saved or bid on, after the opening.', feature: 'awardWatch' },
  { id: 'price', label: 'Price moves', help: 'Material price indexes and wages that moved.', feature: 'priceAlerts' },
];

export const TIME_ZONES = [
  { id: 'America/Los_Angeles', label: 'Pacific' },
  { id: 'America/Denver', label: 'Mountain' },
  { id: 'America/Phoenix', label: 'Arizona' },
  { id: 'America/Chicago', label: 'Central' },
  { id: 'America/New_York', label: 'Eastern' },
  { id: 'America/Anchorage', label: 'Alaska' },
  { id: 'Pacific/Honolulu', label: 'Hawaii' },
];

export function emptyDraft() {
  return {
    businessName: '', trades: [], zip: '', place: null, radiusMi: 60,
    min: '', max: '', limits: { maxJobSize: '', maxUpfront: '', bondingCapacity: '' },
    minScore: 55, quietOn: false, quiet: { ...DEFAULT_QUIET },
    costs: { laborRate: '', burdenPct: '', overheadPct: '', profitPct: '' },
    setAsides: [],
    kinds: { match: true, deadline: true, award: true, price: true },
    timeZone: '',
    keep: {}, // settings the form does not show, sent back unchanged (phone push on/off)
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
  for (const k of Object.keys(d.costs)) {
    const v = p.costs?.[k];
    d.costs[k] = v == null ? '' : k === 'laborRate' && !Number.isInteger(v) ? v.toFixed(2) : String(v); // $42.50, not $42.5
  }
  d.setAsides = [...(p.setAsides ?? [])];
  for (const k of Object.keys(d.kinds)) d.kinds[k] = kinds?.[k] !== false;
  d.timeZone = timeZone ?? '';
  d.keep = { push };
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

/** "45.50" → 45.5; blank → null; anything else is sent as typed so the server names the problem. */
const decimal = (text) => {
  const s = String(text ?? '').trim().replace(/[$,%\s]/g, '');
  if (!s) return null;
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : String(text);
};

/**
 * The PUT /api/profile body. `withCosts`: send the four cost settings (only a plan that has them; otherwise
 * the server keeps whatever is stored).
 */
export function answersFrom(d, { withCosts = false } = {}) {
  const limits = {};
  for (const [k, v] of Object.entries(d.limits)) limits[k] = amount(v);
  const alerts = {
    minScore: d.minScore,
    quietHours: d.quietOn ? { start: d.quiet.start, end: d.quiet.end } : null,
  };
  const tz = d.timeZone || browserTimeZone();
  if (tz) alerts.timeZone = tz;
  if (d.keep.push !== undefined) alerts.push = d.keep.push;
  alerts.kinds = { ...d.kinds };
  const body = {
    businessName: d.businessName,
    trades: d.trades,
    zip: d.zip.trim(),
    radiusMi: d.radiusMi,
    valueRange: { min: amount(d.min) ?? 0, max: amount(d.max) },
    limits,
    alerts,
  };
  if (withCosts) body.costs = Object.fromEntries(Object.entries(d.costs).map(([k, v]) => [k, decimal(v)]));
  body.setAsides = [...d.setAsides];
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

/** Minimum fit and quiet hours; settings also shows the alert kinds and the time zone (`opts`). */
export function alertsSection(d, opts = {}) {
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

  const kinds = opts.kinds ? h('div', { class: 'field', 'data-field': 'alerts.kinds' },
    h('p', { class: 'field-label' }, 'What to alert me about'),
    h('div', { class: 'kind-list' }, ALERT_KINDS.map((k) => h('div', { class: 'kind' },
      toggle({ checked: d.kinds[k.id], label: k.label, onchange: (on) => { d.kinds[k.id] = on; } }),
      h('p', { class: 'field-help' }, k.help, k.feature && opts.features?.[k.feature] !== true ? h('span', { class: 'pro-note' }, ' Part of BidSwipe Pro.') : null)))),
    h('p', { class: 'field-error', role: 'alert' })) : null;
  const zones = TIME_ZONES.some((z) => z.id === (d.timeZone || browserTimeZone())) ? TIME_ZONES : [...TIME_ZONES, { id: d.timeZone || browserTimeZone(), label: d.timeZone || browserTimeZone() }];
  const tzSelect = h('select', { class: 'input select', id: 'tz' }, zones.map((z) => h('option', { value: z.id, selected: z.id === (d.timeZone || browserTimeZone() || 'America/Los_Angeles') }, z.label)));
  tzSelect.addEventListener('change', () => { d.timeZone = tzSelect.value; });
  const tz = opts.timeZone ? field({ key: 'alerts.timeZone', label: 'Time zone', help: 'Quiet hours and deadline reminders use this clock.', control: tzSelect }) : null;

  return h('div', { class: 'stack' },
    kinds,
    h('div', { class: 'field', 'data-field': 'alerts.minScore' },
      h('div', { class: 'range-head' }, h('label', { class: 'field-label', for: 'minfit' }, 'Minimum fit to alert me'), readout),
      range, words, h('p', { class: 'field-error', role: 'alert' })),
    h('div', { class: 'field', 'data-field': 'alerts.quietHours' },
      toggle({ checked: d.quietOn, label: 'Quiet hours', onchange: (on) => { d.quietOn = on; times.hidden = !on; } }),
      times,
      h('p', { class: 'field-help' }, 'No alerts in these hours. The bids wait in your deck.'),
      h('p', { class: 'field-error', role: 'alert' })),
    tz,
    h('div', { 'data-field': 'alerts' }, h('p', { class: 'field-error', role: 'alert' })),
  );
}

/** Your own numbers for the cost check: labor rate, burden, overhead, profit. */
export function costsSection(d) {
  const pctField = (key, label, help) => {
    const input = h('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: d.costs[key], placeholder: 'Not set', 'aria-label': label });
    input.addEventListener('input', () => { d.costs[key] = input.value; });
    return field({ key: `costs.${key}`, label, help, control: h('div', { class: 'affix' }, input, h('span', { class: 'affix-unit', 'aria-hidden': 'true' }, '%')) });
  };
  return h('div', { class: 'stack' },
    h('p', { class: 'field-help' }, 'The cost check fills these in. Leave a box empty and it asks each time.'),
    field({ key: 'costs.laborRate', label: 'Labor rate per hour', help: 'The cash wage you pay, before burden.', control: moneyInput({ text: d.costs.laborRate, placeholder: 'Not set', label: 'Labor rate per hour', oninput: (v) => (d.costs.laborRate = v) }) }),
    pctField('burdenPct', 'Burden', 'One percentage on wages: an approximation of payroll taxes and comp.'),
    h('div', { class: 'pair' },
      pctField('overheadPct', 'Overhead', 'On job cost.'),
      pctField('profitPct', 'Profit', 'On cost + overhead.')),
  );
}

/** The set-aside programs the business is certified for (SAM.gov codes, plain labels from GET /api/trades). */
export function setAsidesSection(d, list) {
  // A program's two codes (SBA/SBP, 8A/8AN…) are saved together, so they tick and untick together:
  // the screen always shows what the server will keep.
  const picked = new Set(d.setAsides);
  for (const s of list) if (s.pair && picked.has(s.code)) picked.add(s.pair);
  d.setAsides = list.map((x) => x.code).filter((c) => picked.has(c));
  const boxes = new Map();
  return h('div', { class: 'field', 'data-field': 'setAsides' },
    h('p', { class: 'field-help' }, 'Tick the programs you are certified in. A program’s two codes (for example total and partial, or competitive and sole source) go together. Federal bids set aside for a program you are not in score lower.'),
    h('div', { class: 'checks' }, list.map((s) => {
      const box = h('input', { type: 'checkbox', checked: picked.has(s.code), id: `sa-${s.code}` });
      boxes.set(s.code, box);
      box.addEventListener('change', () => {
        for (const c of [s.code, s.pair].filter(Boolean)) {
          if (box.checked) picked.add(c); else picked.delete(c);
          const other = boxes.get(c);
          if (other) other.checked = box.checked;
        }
        d.setAsides = list.map((x) => x.code).filter((c) => picked.has(c));
      });
      return h('label', { class: 'check', for: box.id }, box, h('span', { class: 'check-box', 'aria-hidden': 'true' }, icon(ICONS.check)), h('span', { class: 'check-text' }, s.label, h('small', {}, s.code)));
    })),
    h('p', { class: 'field-error', role: 'alert' }),
  );
}
