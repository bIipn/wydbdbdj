// Formatting and small pure helpers (dates in Pacific time, money, verdict labels).

export const PT = 'America/Los_Angeles';

export const fmtDay = new Intl.DateTimeFormat('en-US', { timeZone: PT, weekday: 'short', month: 'short', day: 'numeric' });
export const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: PT, hour: 'numeric', minute: '2-digit' });

/** "10:00 AM" → "10 AM", keeps "2:30 PM". */
export const clock = (d) => fmtTime.format(d).replace(':00 ', ' ');

/** "Tue, Nov 17" in one time zone (one formatter per zone, kept). A zone this browser does not know reads as Pacific. */
const dayFormats = new Map([[PT, fmtDay]]);
function dayIn(d, timeZone) {
  const zone = timeZone || PT;
  let f = dayFormats.get(zone);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' }); } catch { f = fmtDay; }
    dayFormats.set(zone, f);
  }
  return f.format(d);
}

/**
 * How fresh a bid with no due date is (docs/PLAN.md R5): the day a scan last found it on its board (GET /api/feed
 * `lastSeenAt`), in the user's time zone. null when there is no usable date.
 *   long  'Seen on the board Tue, Nov 17'  where a line has room (Search and Saved rows; a tile's title)
 *   short 'Seen Tue, Nov 17'               a half-width fact tile (card and sheet) and Home's one-line chip: the
 *                                          long one needs two lines in a tile at 390 px (173 px of text in 148),
 *                                          and a second line there would push "Bid on …" down
 */
export function seenOnBoard(iso, timeZone) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return null;
  const day = dayIn(new Date(t), timeZone);
  return { long: `Seen on the board ${day}`, short: `Seen ${day}` };
}

/**
 * The due date in words. `seen` ({ at: lastSeenAt, timeZone }) is how a bid with no due date says how fresh it is.
 *   big 'No due date' · small 'Seen Tue, Nov 17' (a tile) · detail 'Seen on the board Tue, Nov 17' (a row)
 *   line = big · detail: 'No due date · Seen on the board Tue, Nov 17'
 * With a due date, small and detail are both 'Tue, Nov 24 · 10 AM'.
 */
export function dueInfo(iso, seen) {
  if (!iso) {
    const s = seenOnBoard(seen?.at, seen?.timeZone);
    // Without a date (an older answer) the card still says what to do, never a made-up day.
    const small = s?.short ?? 'Check the bid';
    const detail = s?.long ?? 'Check the bid';
    return { big: 'No due date', small, detail, line: `No due date · ${detail}`, urgent: false, days: Infinity };
  }
  const d = new Date(iso);
  const ms = d.getTime() - Date.now();
  const days = ms / 864e5;
  let big;
  if (ms <= 0) big = 'Closed';
  else if (days < 1) {
    const hours = Math.floor(ms / 36e5);
    big = hours < 1 ? 'Under 1 hour' : `${hours} hour${hours === 1 ? '' : 's'} left`; // never "1 hours left"
  }
  else big = `${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'} left`;
  const small = `${fmtDay.format(d)} · ${clock(d)}`;
  return { big, small, detail: small, line: `${big} · ${small}`, urgent: days < 5, days };
}

/**
 * The detail sheet's distance (docs/PLAN.md R3): miles are measured on a straight line from the base to the job,
 * not by road, and the sheet says so. "41 mi, straight line".
 */
export const straightMiles = (mi) => `${num(mi)}\u00a0mi, straight line`;

/** Settings' help under "How far you’ll travel" (the onboarding says the same: "From your shop, straight-line miles."). */
export const RADIUS_HELP = 'Straight-line miles from your shop, not road miles. Bids farther than this are left out.';

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

/** 1234 → "1,234": every count a person reads. */
export const num = (n) => Number(n).toLocaleString('en-US');

export const VERDICT_LABEL = { great: 'Great fit', good: 'Good fit', maybe: 'Maybe', skip: 'Not a fit' };
export const PLAN_LABEL = { free: 'Free', pro: 'Pro', pilot: 'Pilot' };

export const isOpen = (i) => !i.dueAt || Date.parse(i.dueAt) > Date.now();
export const byFit = (a, b) => b.score - a.score || (Date.parse(a.dueAt ?? '9999-01-01') - Date.parse(b.dueAt ?? '9999-01-01'));

/**
 * The line under "Bid on …" in a public bid's detail sheet. BidSwipe does not read addenda, and says so. The
 * day-before and due-day reminders carry the same words (src/realtime/alerts.ts ADDENDA_LINE; test/realtime.test.ts
 * keeps the two equal).
 */
export const ADDENDA_LINE = 'Check the agency’s page for addenda (amendments) before you bid. BidSwipe doesn’t read them.';

/** ADDENDA_LINE for a public bid; null for a local job (`local:<jobId>`: bid in the app, no agency page). */
export const addendaLine = (item) => (item?.source === 'local' || String(item?.id ?? '').startsWith('local:') ? null : ADDENDA_LINE);

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
