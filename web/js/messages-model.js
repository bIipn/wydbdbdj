// Messages: the pure part (no DOM, no fetch), so it can be tested on its own (test/messages-model.test.ts).
// A conversation is the thread between a local job's poster and its winning bidder, after the award
// (src/jobs/view.ts inThread). The server sends each one as GET /api/jobs/conversations describes:
//   { jobId, title, role: 'poster' | 'winner', status, outcome, contactDeadline, other: { id, name, … },
//     canWrite, messageCount, last: null | { preview, at, mine, removed }, unread, activityAt }

import { PT } from './format.js';

/** Newest activity first (the last message, else the award); ties by job id so the order never flickers. */
export function sortConversations(list) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) =>
    (Date.parse(b.activityAt) || 0) - (Date.parse(a.activityAt) || 0) || String(a.jobId).localeCompare(String(b.jobId)));
}

/** How many conversations have something unread: the Messages tab's badge. */
export const unreadCount = (list) => (Array.isArray(list) ? list.filter((c) => c?.unread === true).length : 0);

/** The tab's spoken label. */
export function tabLabel(n) {
  return n ? `Messages: ${n} conversation${n === 1 ? '' : 's'} with something new` : 'Messages';
}

/** The other side's name as the server sent it (a PersonCard name: never an email, a phone or an address). */
export const otherName = (c) => (typeof c?.other?.name === 'string' && c.other.name.trim() ? c.other.name.trim() : 'BidSwipe member');

/** The list's one line: the last message on one line, "You: " in front of the viewer's own; or that none was sent. */
export function previewLine(c) {
  if (!c?.last) return 'No messages yet';
  // An operator removed it: the server sends no text (src/jobs/repo.ts MESSAGE_REMOVED).
  if (c.last.removed) return 'Message removed by BidSwipe';
  const text = String(c.last.preview ?? '').replace(/\s+/g, ' ').trim();
  return `${c.last.mine ? 'You: ' : ''}${text}`;
}

const fmtClock = new Intl.DateTimeFormat('en-US', { timeZone: PT, hour: 'numeric', minute: '2-digit' });
const fmtWeekday = new Intl.DateTimeFormat('en-US', { timeZone: PT, weekday: 'short' });
const fmtShort = new Intl.DateTimeFormat('en-US', { timeZone: PT, month: 'short', day: 'numeric' });
const fmtLong = new Intl.DateTimeFormat('en-US', { timeZone: PT, month: 'short', day: 'numeric', year: 'numeric' });
const fmtFull = new Intl.DateTimeFormat('en-US', { timeZone: PT, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: PT, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Calendar days between two instants, on the Pacific calendar like every other date in the app. */
function daysApart(a, b) {
  const d = (t) => Date.parse(`${dayKey.format(t)}T00:00:00Z`);
  return Math.round((d(b) - d(a)) / 86_400_000);
}

/** The list's time: "3:41 PM" today, "Yesterday", "Tue" this week, "Nov 3" this year, else "Nov 3, 2025". */
export function listTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const days = daysApart(t, now);
  if (days <= 0) return fmtClock.format(t);
  if (days === 1) return 'Yesterday';
  if (days < 7) return fmtWeekday.format(t);
  if (dayKey.format(t).slice(0, 4) === dayKey.format(now).slice(0, 4)) return fmtShort.format(t);
  return fmtLong.format(t);
}

/** The same time in full, for a screen reader or a tooltip: "Monday, November 16, 3:41 PM". */
export const fullTime = (iso) => (Number.isFinite(Date.parse(iso)) ? fmtFull.format(Date.parse(iso)) : '');

/**
 * Where the composer would be, when the server no longer takes messages (canWrite false): one plain sentence.
 * null while writing is allowed. The rule itself is the server's (repo.insertMessage); this only words it.
 */
export function cannotWriteSentence(c, now = Date.now()) {
  if (!c || c.canWrite) return null;
  if (c.status === 'completed') return 'This job is done. The messages stay here to read; no new ones can be sent.';
  if (c.status === 'cancelled') return 'This job was cancelled. The messages stay here to read; no new ones can be sent.';
  const deadline = Date.parse(c.contactDeadline ?? '');
  if (c.status === 'unfilled' || (c.status === 'awarded' && Number.isFinite(deadline) && deadline <= now)) {
    return Number.isFinite(deadline)
      ? `The contact window closed on ${fmtShort.format(deadline)}. No new messages can be sent.`
      : 'The contact window has closed. No new messages can be sent.';
  }
  return 'This job has ended. No new messages can be sent.';
}

/** The line in an empty conversation: who can write first, and what it counts for (CLAUDE.md: "made contact"). */
export function emptyThreadLine(c) {
  if (!c?.canWrite) return 'No messages were sent on this job.';
  return c.role === 'winner'
    ? 'No messages yet. Say hello and when you could come look: your first message counts as making contact.'
    : 'No messages yet. The winner writes first, or you can.';
}

/** The newest message id in a thread (what POST …/read is told the screen showed); 0 when there is none. */
export function newestId(messages) {
  let max = 0;
  for (const m of Array.isArray(messages) ? messages : []) if (Number.isSafeInteger(m?.id) && m.id > max) max = m.id;
  return max;
}

/** The newest id among the OTHER side's messages (0 when none): only those can make a thread unread. */
export function newestFromOther(messages) {
  let max = 0;
  for (const m of Array.isArray(messages) ? messages : []) if (m && m.mine === false && Number.isSafeInteger(m.id) && m.id > max) max = m.id;
  return max;
}

/**
 * Must the screen tell the server it read up to here? `fresh` = the conversation as the server answered it
 * with these very messages (its `unread` is current); `seen` = the highest id this device already marked read.
 * The cached list is NOT asked: it can be older than the messages on screen (a reply that came in while the
 * list was still loading would stay unread for good).
 */
export function mustMarkRead(messages, fresh, seen = 0) {
  if (fresh && typeof fresh.unread === 'boolean' && !fresh.unread) return false;
  return newestFromOther(messages) > seen;
}

/** The list after this viewer opened one conversation: that one is read, nothing else changes. */
export const markedRead = (list, jobId) => (Array.isArray(list) ? list.map((c) => (c.jobId === jobId ? { ...c, unread: false } : c)) : list);

/** One line for the empty Messages tab: when a conversation appears, honestly. */
export const EMPTY_LINE = 'Conversations appear here when a local job you posted is awarded, or when you win one you bid on. They are only between the poster and the winner.';
