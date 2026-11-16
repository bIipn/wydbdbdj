// The market tape's items, from GET /api/market/area. Pure: no DOM, no state, no network (test/tape-items.test.ts).
//
// What an item may say is fixed by the Market screen (web/js/price.js), and nothing else:
//   - a material price INDEX: its name, its one-month change as the Market screen rounds it (toFixed(1), "+" when
//     above zero, the direction from the unrounded sign), and the month of the latest figure ("(prelim.)" when BLS
//     marks it preliminary). Never a dollar price: an index only says how much prices moved.
//   - the main area wage (the one the Market screen leads with): the trade, the area, the published median per hour
//     (toFixed(2), like price.js) and its survey period. Never called a prevailing wage.
// A material with no latest figure, or a wage with no median, gives no item: never a placeholder number.

/** The fixed words at the tape's left end: what the strip is and how often it changes. Never "live". */
export const TAPE_LABEL = 'Prices · monthly';

/** "+0.8%" / "-1.2%" / "0.0%", exactly as price.js change() writes it. */
export const signedPct = (pct) => `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;

/** 'up' | 'down' | 'flat' from the unrounded change (price.js does the same); 'none' when there is no change figure. */
export const direction = (c) => (!c || typeof c.pct !== 'number' || !Number.isFinite(c.pct) ? 'none' : c.pct > 0 ? 'up' : c.pct < 0 ? 'down' : 'flat');

const MARK = { up: '▲', down: '▼', flat: '▬', none: '' };
const SAID = { up: 'up', down: 'down' };

/** $36.62, as price.js hourly(). */
const hourly = (v) => `$${Number(v).toFixed(2)}`;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * GET /api/market/area → the tape's items, materials first (in the server's order), then the main wage.
 * Each item: { key, kind, name, mark, dir, change, month, prelim, detail, spoken }.
 *   material: change = "+0.8%" (null when the one-month change is not in the data), month = "Sep 2026".
 *   wage:     detail = "California", change = "$36.62/hr median", month = "May 2025".
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
    out.push({
      key: `m:${m.seriesId ?? m.label}`,
      kind: 'material',
      name: m.label,
      mark: MARK[dir],
      dir,
      change,
      month,
      prelim,
      detail: null,
      spoken: c
        ? `${m.label} price index ${dir === 'flat' ? 'unchanged' : `${SAID[dir]} ${change.replace(/^[+-]/, '')}`} in one month, ${month}${prelim ? ', preliminary' : ''}`
        : `${m.label} price index, ${month}${prelim ? ', preliminary' : ''}, no one-month change in the data`,
    });
  }
  const wage = (Array.isArray(area?.wages) ? area.wages : []).find((w) => w?.primary);
  if (wage && isNum(wage.median) && wage.occupation && wage.areaName && wage.periodLabel) {
    const figure = `${hourly(wage.median)}/hr median`;
    out.push({
      key: `w:${wage.soc ?? wage.occupation}:${wage.areaCode ?? wage.areaName}`,
      kind: 'wage',
      name: wage.occupation,
      mark: '',
      dir: 'none',
      change: figure,
      month: wage.periodLabel,
      prelim: false,
      detail: wage.areaName,
      spoken: `${wage.occupation}, ${wage.areaName}: published BLS wage ${hourly(wage.median)} an hour, median, ${wage.periodLabel}`,
    });
  }
  return out;
}

/** The one spoken label for the whole tape: what it is, each item once, and where a tap goes. */
export function tapeSpoken(items) {
  if (!items.length) return '';
  return `Material price indexes and area wage, monthly figures: ${items.map((i) => i.spoken).join('; ')}. Opens Market.`;
}

/** A fingerprint of what the tape shows: the strip is rebuilt only when this changes (never on a plain re-render). */
export const tapeKey = (items) => items.map((i) => [i.key, i.change, i.month, i.prelim, i.detail].join('|')).join('\n');

/** The words of the still strip (no figure yet, or none at all): it still names what it opens. */
export const TAPE_STILL_TEXT = 'Market prices';
export const TAPE_STILL_SPOKEN = 'Market prices, monthly figures. Opens Market.';

/** The tab screens the tape runs across (shell.js TABS). Never Market itself, never a full-page screen. */
export const TAPE_VIEWS = new Set(['home', 'browse', 'saved', 'jobs', 'messages']);

/**
 * What the tape is on this screen: 'scroll' (the items move), 'still' (the fixed label, "Market prices" and a chevron:
 * no number while loading, after a failed request or with no price data stored) or 'hidden'.
 *   view       the view the shell is drawing        chrome   its chrome ('tabs' | 'screen')
 *   hasMarket  this person has a Market (live, not here only to hire; the bundled demo has none)
 *   items      tapeItems() of the answer in hand ([] when there is none)
 */
export function tapeMode({ view, chrome, hasMarket = false, items = [] } = {}) {
  if (!hasMarket || chrome !== 'tabs' || !TAPE_VIEWS.has(view)) return 'hidden';
  return Array.isArray(items) && items.length > 0 ? 'scroll' : 'still';
}
