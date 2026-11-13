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
    // "Your paperwork": null = never asked (an older account), so nothing is sent and scoring stays as it was.
    quals: null,
    sizes: [], // onboarding's job-size chips (ids from JOB_SIZES); settings edits min/max directly
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
  d.quals = p.qualifications ? { ...p.qualifications } : null;
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
  if (d.quals) body.qualifications = { ...d.quals };
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

// ------------------------------------------------------ tap-only pieces --
// Onboarding asks everything with chips. The only things anyone types are a ZIP (when "Use my location"
// can't be used) and, optionally, the business name.

/** A tappable chip with a tick, pressed or not. `onTap` gets the click; the caller re-paints. */
export function chip(label, pressed, onTap, extra = {}) {
  const b = h('button', { type: 'button', class: 'trade-chip', 'aria-pressed': String(!!pressed), ...extra },
    h('span', { class: 'tick', 'aria-hidden': 'true' }, icon(ICONS.check)), label);
  b.addEventListener('click', onTap);
  return b;
}

/** How far you travel, as chips. Any value the server accepts can still be set in Settings with the slider. */
export const RADIUS_CHOICES = [25, 50, 100, 150, 250];

/**
 * Job-size bands. Several can be picked; the range saved is the lowest bound to the highest. "Over $2M" has no
 * top on the screen; we save $100M as its ceiling (the server needs a number, and no small contractor's
 * public bid is bigger). Settings shows the saved range as two dollar boxes for exact edits.
 */
export const JOB_SIZES = [
  { id: 'u25', label: 'Under $25K', min: 0, max: 25_000 },
  { id: '25-100', label: '$25K–$100K', min: 25_000, max: 100_000 },
  { id: '100-500', label: '$100K–$500K', min: 100_000, max: 500_000 },
  { id: '500-2m', label: '$500K–$2M', min: 500_000, max: 2_000_000 },
  { id: 'o2m', label: 'Over $2M', min: 2_000_000, max: 100_000_000 },
];

/** The draft's min/max (the strings answersFrom reads) from the picked bands. */
function applySizes(d) {
  const picked = JOB_SIZES.filter((s) => d.sizes.includes(s.id));
  d.min = picked.length ? dollarsText(Math.min(...picked.map((s) => s.min))) : '';
  d.max = picked.length ? dollarsText(Math.max(...picked.map((s) => s.max))) : '';
}

export function jobSizeChips(d) {
  const group = h('div', { class: 'trade-chips', role: 'group', 'aria-label': 'Job sizes' });
  const paint = () => group.replaceChildren(...JOB_SIZES.map((s) => chip(s.label, d.sizes.includes(s.id), () => {
    d.sizes = d.sizes.includes(s.id) ? d.sizes.filter((x) => x !== s.id) : [...d.sizes, s.id];
    applySizes(d);
    paint();
  })));
  paint();
  return h('div', { class: 'field', 'data-field': 'valueRange' },
    group,
    h('p', { class: 'field-help' }, 'Pick one or more. Bids in this range score higher; you still see the rest in Browse.'),
    h('p', { class: 'field-error', role: 'alert' }));
}

/** The 2-letter home state from the place line ("Gardnerville, NV" → "NV"). */
export const homeStateOf = (d) => /,\s*([A-Z]{2})\s*$/.exec(d.place?.label ?? '')?.[1] ?? null;

/**
 * Where's the shop: "Use my location" (browser location → nearest ZIP), or a 5-digit ZIP; then how far, as chips.
 * `onDone` runs when both are known after a tap on a distance (onboarding moves on by itself).
 */
export function homeSection(d, { onDone } = {}) {
  const place = h('p', { class: 'place-line', 'aria-live': 'polite' });
  const showPlace = (state, text) => {
    place.className = `place-line ${state}`;
    place.replaceChildren(...(state === 'ok' ? [icon(ICONS.pin)] : []), h('span', {}, text));
  };
  const zip = textInput({ value: d.zip, inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'postal-code', maxlength: 5, placeholder: 'ZIP', class: 'input zip', 'aria-label': 'Shop ZIP code' });
  let ticket = 0;
  const lookZip = async () => {
    zip.value = zip.value.replace(/\D/g, '').slice(0, 5);
    d.zip = zip.value;
    if (zip.value.length < 5) { d.place = null; return showPlace('idle', zip.value ? 'Enter all 5 digits.' : ''); }
    if (d.place?.zip === zip.value) return showPlace('ok', d.place.label);
    const mine = ++ticket;
    showPlace('busy', 'Looking up…');
    try {
      const p = await api.zip(zip.value);
      if (mine !== ticket) return;
      d.place = { zip: p.zip, label: `${p.city}, ${p.state}` };
      showPlace('ok', d.place.label);
      if (d.radiusPicked && onDone) onDone();
    } catch (err) {
      if (mine !== ticket) return;
      d.place = null;
      showPlace('bad', err.status === 404 ? `We can’t find ZIP ${zip.value}. Check the number.` : 'Couldn’t look that up right now.');
    }
  };
  zip.addEventListener('input', lookZip);

  const locate = h('button', { type: 'button', class: 'cta ghost locate' }, icon(ICONS.pin), h('span', {}, 'Use my location'));
  locate.addEventListener('click', () => {
    if (!navigator.geolocation) { showPlace('idle', 'Enter your shop’s ZIP instead.'); zip.focus(); return; }
    locate.disabled = true;
    showPlace('busy', 'Finding you…');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      // Two decimals (about 1 km) is all a ZIP needs: that is all that leaves the phone, and the server keeps
      // only the ZIP the person saves, never the point.
      const lat = Math.round(pos.coords.latitude * 100) / 100;
      const lng = Math.round(pos.coords.longitude * 100) / 100;
      try {
        const p = await api.nearestZip(lat, lng);
        d.zip = p.zip;
        zip.value = p.zip;
        d.place = { zip: p.zip, label: `${p.city}, ${p.state}` };
        showPlace('ok', d.place.label);
        if (d.radiusMi && d.radiusPicked && onDone) onDone();
      } catch {
        showPlace('idle', 'No US ZIP near you. Enter your shop’s ZIP instead.');
        zip.focus();
      } finally { locate.disabled = false; }
    }, () => {
      // Refused, or no location on this device: the ZIP box is right there. No error drama.
      locate.disabled = false;
      showPlace('idle', 'Enter your shop’s ZIP instead.');
      zip.focus();
    }, { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 });
  });
  if (d.place) showPlace('ok', d.place.label);

  const radius = h('div', { class: 'trade-chips', role: 'group', 'aria-label': 'How far you travel' });
  const paint = () => radius.replaceChildren(...RADIUS_CHOICES.map((mi) => chip(`${mi} mi`, d.radiusPicked && d.radiusMi === mi, () => {
    d.radiusMi = mi;
    d.radiusPicked = true;
    paint();
    if (d.place && onDone) onDone();
  })));
  paint();

  return h('div', { class: 'stack' },
    h('div', { class: 'field', 'data-field': 'zip' },
      h('div', { class: 'locate-row' }, locate, h('span', { class: 'or-word' }, 'or'), zip),
      place,
      h('p', { class: 'field-error', role: 'alert' })),
    h('div', { class: 'field', 'data-field': 'radiusMi' },
      h('p', { class: 'field-label' }, 'How far you’ll travel'),
      radius,
      h('p', { class: 'field-help' }, 'From your shop, straight-line miles. Farther bids are left out.'),
      h('p', { class: 'field-error', role: 'alert' })),
  );
}

/** How picky alerts are: three chips onto the existing minimum score. */
export const ALERT_CHOICES = [
  { score: 75, label: 'Only great fits', help: '75 or more out of 100' },
  { score: 55, label: 'Good fits', help: '55 or more — recommended' },
  { score: 35, label: 'Anything worth a look', help: '35 or more' },
];

export function alertChoices(d, { onPick } = {}) {
  const list = h('div', { class: 'choice-list', role: 'radiogroup', 'aria-label': 'When to alert you' });
  const paint = () => list.replaceChildren(...ALERT_CHOICES.map((c) => {
    const on = d.minScore === c.score;
    const b = h('button', { type: 'button', class: 'choice', role: 'radio', 'aria-checked': String(on) },
      h('span', { class: 'choice-text' }, h('strong', {}, c.label), h('small', {}, c.help)),
      h('span', { class: 'choice-dot', 'aria-hidden': 'true' }, icon(ICONS.check)));
    b.addEventListener('click', () => { d.minScore = c.score; paint(); onPick?.(); });
    return b;
  }));
  paint();
  return h('div', { class: 'field', 'data-field': 'alerts' }, list,
    h('p', { class: 'field-help' }, 'Quiet hours and which alerts you get are in Settings.'),
    h('p', { class: 'field-error', role: 'alert' }));
}

// --------------------------------------------------------- your paperwork --

export const QUAL_KEYS = ['statePublicWorks', 'samRegistered', 'bonding', 'prevailingWage'];
const ANSWERS = [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }, { id: 'unsure', label: 'Not sure' }];

/**
 * The state public-works question follows the home state. Nevada: SPWD bidder qualification (NRS 338.1379);
 * California: DIR public-works contractor registration (Labor Code 1725.5); anywhere else a plain question.
 * paperworkSection only shows it for Nevada today (see there); the other wordings wait for a board that
 * marks those requirements.
 */
export function statePublicWorksQuestion(state) {
  if (state === 'NV') return 'Qualified to bid Nevada State Public Works (SPWD) jobs?';
  if (state === 'CA') return 'Registered with California DIR as a public works contractor?';
  return 'Prequalified with your state’s public works agency?';
}

const QUESTIONS = {
  statePublicWorks: statePublicWorksQuestion,
  samRegistered: () => 'Registered in SAM.gov? Needed to win federal work.',
  bonding: () => 'Can you get bid and performance bonds?',
  prevailingWage: () => 'Do you take prevailing-wage jobs (certified payroll)?',
};

/**
 * Federal certifications as chips, onto the set-aside codes (src/profile/build.ts). A program's two codes are
 * saved together by the server, so one chip stands for both.
 */
export const CERTS = [
  { code: 'SBA', label: 'Small business' },
  { code: '8A', label: '8(a)' },
  { code: 'HZC', label: 'HUBZone' },
  { code: 'SDVOSBC', label: 'Service-disabled veteran-owned' },
  { code: 'WOSB', label: 'Woman-owned' },
  { code: 'EDWOSB', label: 'Economically disadvantaged woman-owned' },
];
const PAIR = { SBA: 'SBP', '8A': '8AN', HZC: 'HZS', SDVOSBC: 'SDVOSBS', WOSB: 'WOSBSS', EDWOSB: 'EDWOSBSS' };

/** Yes / No / Not sure for each question. Unanswered counts as Not sure; nothing here ever hides a bid. */
export function paperworkSection(d, { state = homeStateOf(d), certs = false } = {}) {
  // Created on the first tap, not on render: an older account that never answers sends nothing new.
  const answer = (key) => d.quals?.[key] ?? 'unsure';
  // The state public-works question is only asked where it is scored: SPWD, for a Nevada home base
  // (src/score/score.ts answerFor). No board marks a California DIR or other-state requirement yet, so asking
  // there would store an answer that changes nothing. Unasked counts as Not sure on the server.
  const rows = QUAL_KEYS.filter((key) => key !== 'statePublicWorks' || state === 'NV').map((key) => {
    const seg = h('div', { class: 'seg3', role: 'radiogroup', 'aria-label': QUESTIONS[key](state) });
    const paint = () => seg.replaceChildren(...ANSWERS.map((a) => {
      const b = h('button', { type: 'button', role: 'radio', class: `seg3-btn is-${a.id}`, 'aria-checked': String(answer(key) === a.id) }, a.label);
      b.addEventListener('click', () => {
        d.quals ??= Object.fromEntries(QUAL_KEYS.map((k) => [k, 'unsure']));
        d.quals[key] = a.id;
        paint();
      });
      return b;
    }));
    paint();
    return h('div', { class: 'qa', 'data-field': `qualifications.${key}` },
      h('p', { class: 'qa-q' }, QUESTIONS[key](state)), seg, h('p', { class: 'field-error', role: 'alert' }));
  });

  let certBlock = null;
  if (certs) {
    const group = h('div', { class: 'trade-chips', role: 'group', 'aria-label': 'Federal certifications' });
    const has = (c) => d.setAsides.includes(c);
    const paint = () => group.replaceChildren(
      ...CERTS.map((c) => chip(c.label, has(c.code), () => {
        const both = [c.code, PAIR[c.code]];
        d.setAsides = has(c.code) ? d.setAsides.filter((x) => !both.includes(x)) : [...d.setAsides, ...both];
        d.certsNone = false;
        paint();
      })),
      chip('None of these', d.setAsides.length === 0 && d.certsNone, () => { d.setAsides = []; d.certsNone = true; paint(); }),
    );
    paint();
    certBlock = h('div', { class: 'field', 'data-field': 'setAsides' },
      h('p', { class: 'field-label' }, 'Federal certifications'),
      group,
      h('p', { class: 'field-help' }, 'Federal bids set aside for a program you’re not in are marked as reserved.'),
      h('p', { class: 'field-error', role: 'alert' }));
  }

  return h('div', { class: 'stack' },
    h('div', { class: 'qa-list', 'data-field': 'qualifications' }, rows, h('p', { class: 'field-error', role: 'alert' })),
    h('p', { class: 'field-help' }, 'No wrong answers. You still see every bid; we tell you what each one asks for.'),
    certBlock);
}

/** "My electrical shop": the name used when the business-name step is skipped. Editable in Settings. */
export function defaultBusinessName(d, trades) {
  const label = trades?.find((t) => t.id === d.trades[0])?.label;
  const head = label ? label.split('/')[0].trim() : '';
  const noun = /^[A-Z][a-z]/.test(head) ? head[0].toLowerCase() + head.slice(1) : head;
  return noun ? `My ${noun} shop` : 'My shop';
}
