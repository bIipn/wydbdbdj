// Pure pieces of the app chrome and the Home view: which tabs an account sees, the screen titles, and what a match
// card says (its place line and its chips). No DOM and no state here, so test/home-model.test.ts can import it.

import { dueInfo, estLabel, num, shortSource, tierOf, VERDICT_LABEL } from './format.js';

/**
 * The bottom tab bar, left to right. 'browse' is the Search tab (its view id predates the name). Market is not a tab:
 * the market tape across the top of every tab screen opens it (web/js/tape.js), and its Back returns to the tab.
 */
export const TABS = [
  { view: 'home', label: 'Home' },
  { view: 'browse', label: 'Search' },
  { view: 'saved', label: 'Saved' },
  { view: 'jobs', label: 'Jobs' },
  { view: 'messages', label: 'Messages' },
];

/** Screens that sit between the tabs (the bar stays, no tab is lit) and have a Back to the tab they were opened from. */
export const SCREEN_TITLES = { market: 'Market' };

/** The views that only make sense for someone who looks for work (bids). An account here only to hire never sees them. */
export const BID_VIEWS = new Set(['home', 'browse', 'market', 'saved']);

/** The tabs that exist only where local jobs exist (accounts mode). Their module says so (shell.js registerTabCount). */
export const JOB_TABS = new Set(['jobs', 'messages']);

/** Old names a link, a Back button or a module may still use → the view that replaced it. */
export const VIEW_ALIASES = { swipe: 'home' };

/**
 * The tabs this person sees, in order.
 *   hireOnly    an account here only to get work done: Jobs and Messages alone (when they are on)
 *   jobsOn      local jobs are on (accounts mode): the Jobs tab
 *   messagesOn  the Messages tab's module says it is on (it is only ever on where local jobs are)
 * Single mode and the bundled demo: Home · Search · Saved. A tab whose module never said "on" stays hidden.
 */
export function visibleTabs({ hireOnly = false, jobsOn = false, messagesOn = false } = {}) {
  const on = { jobs: jobsOn, messages: jobsOn && messagesOn };
  return TABS.map((t) => t.view).filter((v) => {
    if (JOB_TABS.has(v)) return on[v];
    return !(hireOnly && jobsOn);
  });
}

/** The header's title for a tab screen. Home says hello; the others say where you are. */
export function screenTitle(view) {
  if (view === 'home') return 'Welcome';
  return TABS.find((t) => t.view === view)?.label ?? SCREEN_TITLES[view] ?? 'BidSwipe';
}

/** Home's small second line: "L&M Electric · Minden, NV" (either part may be missing). */
export const homeSubtitle = (profile) => [profile?.name, profile?.base].filter(Boolean).join(' · ');

/** "LM" for "L&M Electric", "B" for "BidSwipe": letters only, never a made-up logo. */
export function monogram(name) {
  const words = String(name ?? '').match(/[A-Za-z0-9]+/g) ?? [];
  if (!words.length) return '';
  if (words.length === 1) return words[0][0].toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** A local job posted on BidSwipe (mirrored into the feed as local:<jobId>). */
export const isLocalJob = (item) => item?.source === 'local' || String(item?.id ?? '').startsWith('local:');

/**
 * The line under a bid's title that says who put it out: the agency of a public bid; for a local job, that it was
 * posted here (a person posted it in the app; the feed row is shared, so never their name). One copy for Home's
 * cards, the swipe card, the Search and Saved rows and the detail sheet.
 */
export function agencyLine(item) {
  if (isLocalJob(item)) return 'Posted on BidSwipe';
  return String(item?.agency ?? '').trim() || 'Agency not listed';
}

/**
 * Where the job is, in one line. Miles only when the server measured them to the job itself; otherwise the
 * server's own label and, in words, why there are no miles (never "? mi").
 *   { miles: '41 mi' | null, label: 'Sacramento, CA', note: null | 'No distance: site not named', text }
 */
export function placeLine(item) {
  const label = item?.location?.label || 'Location not listed';
  const miles = item?.distanceMi != null && Number.isFinite(Number(item.distanceMi)) ? `${num(Math.round(Number(item.distanceMi)))} mi` : null;
  // An AREA (several counties, a Caltrans district: precision 'region') has no one site to measure to.
  const note = miles ? null : item?.location?.precision === 'region' ? 'Area: no single distance' : 'No distance: site not named';
  return { miles, label, note, text: miles ? `${miles} · ${label}` : `${label} · ${note}` };
}

/**
 * The grey chips under a match card, in reading order: time left, the job value, where it comes from, the verdict.
 * kind: 'due' (urgent: under 5 days) · 'value' (unknown: no value listed) · 'board' | 'sub' | 'local' · 'verdict'.
 * A bid with no due date says how fresh it is instead: "No due date · Still listed Tue, Nov 17" (lastSeenAt, in
 * `timeZone`, the user's: state.js userTimeZone). A chip is one line: "… Seen on the board …" would be cut off at 390 px.
 */
export function matchChips(item, timeZone) {
  const due = dueInfo(item.dueAt, { at: item.lastSeenAt, timeZone });
  const value = estLabel(item.estValue);
  const tier = tierOf(item);
  const from = tier === 'sub' ? { text: 'Sub work', kind: 'sub' }
    : isLocalJob(item) ? { text: 'Local job', kind: 'local' }
      : { text: shortSource(item.sourceName), kind: 'board' };
  return [
    { text: due.days === Infinity ? `${due.big} · ${due.small}` : due.big, kind: 'due', urgent: due.urgent && due.days !== Infinity },
    { text: value ?? 'Value not listed', kind: 'value', unknown: !value },
    from,
    { text: VERDICT_LABEL[item.verdict] ?? String(item.verdict ?? ''), kind: 'verdict' },
  ].filter((c) => c.text);
}

/** Home's two ways to look at the matches. Anything else read from the device falls back to the list. */
export const HOME_MODES = ['scroll', 'swipe'];
export const homeModeOf = (stored) => (stored === 'swipe' ? 'swipe' : 'scroll');

/** How many match cards Home shows at first, and how many more each "Show more" adds. */
export const HOME_PAGE = 20;
