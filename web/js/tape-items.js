// The market tape's items, from GET /api/market/area, and the tape's pure decisions (what it is on a screen, which
// control it carries, which item comes next). No DOM, no state, no network (test/tape-items.test.ts).
//
// What an item may say is fixed by the Market screen (web/js/price.js), and nothing else:
//   - a material price INDEX: its name, its index level exactly as the Market screen prints it ("Index 607.7":
//     toFixed(1), never a dollar sign or a unit: an index is not a price), its one-month change as the Market
//     screen rounds it (toFixed(1), "+" above zero, the direction from the unrounded sign), and the month of the
//     latest figure (preliminary when BLS marks it so).
//   - the main area wage (the one the Market screen leads with): the trade and the area, the published median per
//     hour as price.js prints it ("$36.62/hr") and its survey period. Never called a prevailing wage.
// A material with no latest figure, or a wage with no median, gives no item: never a placeholder number.

/** What the pill's small icon says (its title; the spoken label says it too). Never "live". */
export const TAPE_ICON_LABEL = 'Monthly price indexes';

/** "+0.8%" / "-1.2%" / "0.0%", exactly as price.js change() writes it. */
export const signedPct = (pct) => `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;

/** 'up' | 'down' | 'flat' from the unrounded change (price.js does the same); 'none' when there is no change figure. */
export const direction = (c) => (!c || typeof c.pct !== 'number' || !Number.isFinite(c.pct) ? 'none' : c.pct > 0 ? 'up' : c.pct < 0 ? 'down' : 'flat');

/**
 * Short names for a phone-width pill (the full name went to "Copper wire an…" at 390 px, and the two "Electric…"
 * items looked alike). Keyed by the BLS series id (src/market/bls.ts PPI_SERIES); the full name stays in the spoken
 * label, on wider screens and on the Market screen. A series not listed here shows its full name.
 */
export const SHORT_NAMES = {
  WPU10260314: 'Copper wire',
  WPU11710216: 'Conduit',
  WPU117522: 'Switchgear',
  PCU3353133353133: 'Panelboards',
  WPU108303: 'Lighting',
  WPU1174: 'Transformers',
  WPU1171: 'Wiring devices',
  WPUIP2312001: 'Constr. inputs',
  PCU23821X23821X: 'Electrical subs',
};

/** "Sep 2026" → "Sep ’26" (the narrow pill); anything else as it is. */
export const shortMonth = (label) => String(label ?? '').replace(/^([A-Z][a-z]{2}) (?:19|20)(\d\d)$/, '$1 \u2019$2');

const MARK = { up: '▲', down: '▼', flat: '▬', none: '' };
const SAID = { up: 'up', down: 'down' };

/** $36.62, as price.js hourly(). */
const hourly = (v) => `$${Number(v).toFixed(2)}`;
/** 607.7, as price.js materialsView() prints a latest index level ("Index 607.7"). */
export const indexLevel = (v) => Number(v).toFixed(1);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * GET /api/market/area → the tape's items, materials first (in the server's order), then the main wage.
 * Each item: { key, kind, name, short, figure, change, mark, dir, note, month, monthShort, prelim, spoken }.
 *   material: figure = "607.7" (the index level), change = "+0.8%" (null when the one-month change is not in the
 *             data), month = "Sep 2026".
 *   wage:     name = "Electricians, California", figure = "$36.62/hr", note = "median", month = "May 2025".
 * Any other shape (null, an error body, a partial answer) gives the items it can and never throws.
 */
export function tapeItems(area) {
  const out = [];
  const mats = Array.isArray(area?.materials) ? area.materials : [];
  for (const m of mats) {
    const latest = m?.latest;
    if (!m?.label || !latest?.periodLabel || !isNum(latest.value)) continue;
    const c = m.change1m && isNum(m.change1m.pct) ? m.change1m : null;
    const dir = direction(c);
    const change = c ? signedPct(c.pct) : null;
    const prelim = latest.preliminary === true;
    const month = latest.periodLabel;
    const figure = indexLevel(latest.value);
    const moved = c ? (dir === 'flat' ? 'unchanged in one month' : `${SAID[dir]} ${change.replace(/^[+-]/, '')} in one month`) : 'no one-month change in the data';
    out.push({
      key: `m:${m.seriesId ?? m.label}`,
      kind: 'material',
      name: m.label,
      short: SHORT_NAMES[m.seriesId] ?? m.label,
      figure,
      change,
      mark: MARK[dir],
      dir,
      note: null,
      month,
      monthShort: shortMonth(month),
      prelim,
      spoken: `${m.label}, index ${figure}, ${moved}, ${month}${prelim ? ', preliminary' : ''}`,
    });
  }
  const wage = (Array.isArray(area?.wages) ? area.wages : []).find((w) => w?.primary);
  if (wage && isNum(wage.median) && wage.occupation && wage.areaName && wage.periodLabel) {
    out.push({
      key: `w:${wage.soc ?? wage.occupation}:${wage.areaCode ?? wage.areaName}`,
      kind: 'wage',
      name: `${wage.occupation}, ${wage.areaName}`,
      short: wage.occupation,
      figure: `${hourly(wage.median)}/hr`,
      change: null,
      mark: '',
      dir: 'none',
      note: 'median',
      month: wage.periodLabel,
      monthShort: shortMonth(wage.periodLabel),
      prelim: false,
      spoken: `${wage.occupation}, ${wage.areaName}: published BLS wage ${hourly(wage.median)} an hour, median, ${wage.periodLabel}`,
    });
  }
  return out;
}

/** The one spoken label for the whole pill: what it is, each item once, and where a tap goes. */
export function tapeSpoken(items) {
  if (!items.length) return '';
  const wage = items.some((i) => i.kind === 'wage');
  const mats = items.some((i) => i.kind === 'material');
  const what = mats && wage ? 'Monthly price indexes and the area wage' : mats ? 'Monthly price indexes' : 'Area wage';
  return `${what}: ${items.map((i) => i.spoken).join('; ')}. Opens Market.`;
}

/** A fingerprint of what the tape shows: the pill is rebuilt only when this changes (never on a plain re-render). */
export const tapeKey = (items) => items.map((i) => [i.key, i.figure, i.change, i.month, i.prelim, i.name, i.short].join('|')).join('\n');

/** The words of the still pill (no figure yet, or none at all): it still names what it opens. */
export const TAPE_STILL_TEXT = 'Market prices';
export const TAPE_STILL_SPOKEN = 'Market prices: monthly price indexes and the area wage. Opens Market.';

/** The tab screens the tape runs across (home-model.js TABS). Never Market itself, never a full-page screen. */
export const TAPE_VIEWS = new Set(['home', 'browse', 'saved', 'jobs', 'messages']);

/**
 * What the tape is on this screen: 'rotate' (one item at a time; it moves only when there are two or more),
 * 'still' (the fixed pill, "Market prices" and a chevron: no number while loading, after a failed request or with
 * no price data stored) or 'hidden'.
 *   view       the view the shell is drawing        chrome   its chrome ('tabs' | 'screen')
 *   hasMarket  this person has a Market (live, not here only to hire; the bundled demo has none)
 *   items      tapeItems() of the answer in hand ([] when there is none)
 */
export function tapeMode({ view, chrome, hasMarket = false, items = [] } = {}) {
  if (!hasMarket || chrome !== 'tabs' || !TAPE_VIEWS.has(view)) return 'hidden';
  return Array.isArray(items) && items.length > 0 ? 'rotate' : 'still';
}

/** How long one item stays on show before the next slides up into its place. */
export const TAPE_HOLD_MS = 4000;

/**
 * The control at the pill's right end:
 *   'none'   one item (nothing moves) or the still pill
 *   'pause'  it moves by itself and is playing     'play'  it moves by itself and the person paused it
 *   'next'   prefers-reduced-motion: nothing changes by itself, the person steps through the items with it
 * label = what a screen reader says for the button.
 */
export function tapeControl({ count = 0, reduced = false, paused = false } = {}) {
  if (count < 2) return { kind: 'none', label: '' };
  if (reduced) return { kind: 'next', label: 'Show the next price' };
  return paused ? { kind: 'play', label: 'Play the market prices' } : { kind: 'pause', label: 'Pause the market prices' };
}

/** The item after `i` in a loop of `n` (0 when there is none). */
export const nextIndex = (i, n) => (n > 0 ? ((Number.isInteger(i) && i >= 0 ? i : -1) + 1) % n : 0);

/**
 * After new data arrives: keep showing the same item where it is still there (no jump), else the first.
 * prevKey = the key of the item on show; items = the new list.
 */
export function keepIndex(prevKey, items) {
  const at = items.findIndex((i) => i.key === prevKey);
  return at >= 0 ? at : 0;
}
