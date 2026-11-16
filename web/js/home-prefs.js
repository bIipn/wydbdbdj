// Home's "Your preferences": the profile as the app knows it, as short chips. Pure (test/home-prefs.test.ts);
// home-extras.js draws them and, where the profile can be edited (accounts mode), makes each one open Settings
// at its own field.

import { money } from './format.js';

/** The general-building trade is the prime: no sub-work tier (state.js PRIME_TRADE). */
const PRIME_TRADE = 'general-building';

/** "Up to $250K" / "$25K–$500K", from whole dollars (the profile's valueRange), the app's own money() wording. */
export function sizeText(range) {
  const min = range?.min;
  const max = range?.max;
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return null;
  if (typeof min !== 'number' || !Number.isFinite(min) || min <= 0) return `Jobs up to ${money(max)}`;
  return `Jobs ${money(min)}–${money(max)}`;
}

/**
 * facts: {
 *   intent, base (the header's "Town, ST"),
 *   profile: GET /api/me profile summary (accounts mode) or null,
 *   legacy: the single-mode / demo fields { maxDistanceMi, valueRange } or null,
 *   tradeLabels: Map id → label (null while the catalog is loading)
 * }
 * → null (no profile at all, or here only to hire) | [{ id, text, field }] (empty = nothing to show yet).
 * field = the Settings field the chip opens (data-field in the settings form).
 */
export function prefsChips(f) {
  if (!f || f.intent === 'hire') return null;
  const p = f.profile;
  const legacy = f.legacy;
  if (!p && !legacy) return null;
  const chips = [];

  for (const id of p?.trades ?? []) {
    const label = f.tradeLabels?.get(id);
    if (label) chips.push({ id: `trade:${id}`, text: label, field: 'trades' });
  }

  const radius = p?.radiusMi ?? legacy?.maxDistanceMi;
  const town = String(p?.base ?? f.base ?? '').trim();
  if (Number.isFinite(radius) && radius > 0 && town) chips.push({ id: 'radius', text: `${radius} mi from ${town}`, field: 'radiusMi' });

  const size = sizeText(p?.valueRange ?? legacy?.valueRange);
  if (size) chips.push({ id: 'size', text: size, field: 'valueRange.min' });

  // Sub work: only a company that can get it (not the prime). The pilot and the demo have it on.
  const trades = p?.trades ?? [];
  if (!trades.includes(PRIME_TRADE)) {
    const on = p ? p.showSubWork !== false : true;
    chips.push({ id: 'sub', text: on ? 'Sub work shown' : 'Sub work hidden', field: 'showSubWork' });
  }
  // A profile that has nothing above yet (no trades, no place) is said as one "add" row, not a lone sub-work chip.
  return chips.some((c) => c.id !== 'sub') ? chips : [];
}
