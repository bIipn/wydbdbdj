// Formatting and small pure helpers (dates in Pacific time, money, verdict labels).

export const PT = 'America/Los_Angeles';

export const fmtDay = new Intl.DateTimeFormat('en-US', { timeZone: PT, weekday: 'short', month: 'short', day: 'numeric' });
export const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: PT, hour: 'numeric', minute: '2-digit' });

/** "10:00 AM" → "10 AM", keeps "2:30 PM". */
export const clock = (d) => fmtTime.format(d).replace(':00 ', ' ');

export function dueInfo(iso) {
  if (!iso) return { big: 'Not listed', small: 'Check the bid', urgent: false, days: Infinity };
  const d = new Date(iso);
  const ms = d.getTime() - Date.now();
  const days = ms / 864e5;
  let big;
  if (ms <= 0) big = 'Closed';
  else if (days < 1) big = ms < 36e5 ? 'Under 1 hour' : `${Math.floor(ms / 36e5)} hours left`;
  else big = `${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'} left`;
  return { big, small: `${fmtDay.format(d)} · ${clock(d)}`, urgent: days < 5, days };
}

export function money(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${v}`;
}

export function estLabel(est) {
  if (!est) return null;
  const { min, max } = est;
  if (min != null && max != null && min !== max) return `${money(min)}–${money(max)}`;
  const v = max ?? min;
  if (v == null) return null;
  return min == null ? `Under ${money(v)}` : money(v);
}

/** "50,000" / "$50k" / "1.5m" → 50000 / 50000 / 1500000; blank → null; junk → NaN. */
export function parseDollars(text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/[$,\s]/g, '');
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)([km])?$/.exec(s);
  if (!m) return NaN;
  return Math.round(Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1));
}

/** 50000 → "50,000" for an input box. */
export const dollarsText = (v) => (v == null ? '' : Number(v).toLocaleString('en-US'));

/** "NV Public Works (QuestCDN)" → "NV Public Works" for buttons. */
export const shortSource = (name) => (name ?? 'source').replace(/\s*\([^)]*\)\s*$/, '');

export const VERDICT_LABEL = { great: 'Great fit', good: 'Good fit', maybe: 'Maybe', skip: 'Not a fit' };
export const PLAN_LABEL = { free: 'Free', pro: 'Pro', pilot: 'Pilot' };

export const isOpen = (i) => !i.dueAt || Date.parse(i.dueAt) > Date.now();
export const byFit = (a, b) => b.score - a.score || (Date.parse(a.dueAt ?? '9999-01-01') - Date.parse(b.dueAt ?? '9999-01-01'));

/**
 * The tier of a bid (GET /api/feed sends it). An older answer without one reads the way the server reads a row
 * scored before tiers existed: 'fit' at the deck line (35) or above, else 'other'.
 */
export const tierOf = (i) => (i.tier === 'fit' || i.tier === 'sub' || i.tier === 'other' ? i.tier : i.score >= 35 ? 'fit' : 'other');

/**
 * Pluses first, then minuses, then notes. Sub work keeps the server's order: its first reasons say that it is
 * sub work, why, and what to do (src/score/score.ts puts them first), and they are notes ('info').
 */
export function orderedReasons(item) {
  if (tierOf(item) === 'sub') return [...item.reasons];
  const rank = { plus: 0, minus: 1, info: 2 };
  return [...item.reasons].sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/** The words for a minimum fit score (verdict bands from src/score/score.ts: 75 great, 55 good, 35 maybe). */
export function fitWords(score) {
  if (score >= 75) return 'Great fits only';
  if (score >= 55) return 'Good fits and better';
  if (score >= 35) return 'Maybes and better';
  return 'Almost everything';
}
