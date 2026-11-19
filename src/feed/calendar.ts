import { createHash } from 'node:crypto';
import type { FeedItem } from '../types.js';

/**
 * "Add to calendar" (docs/PLAN.md N10): one bid's due time as an iCalendar file (RFC 5545), for
 * GET /api/bids/:id/calendar. Pure: the same bid and clock give the same text.
 *
 * One VEVENT at the due time. DTSTART is the due time and there is no DTEND: RFC 5545 §3.6.1 says such an event
 * ends where it starts, so it ends at the due time. A DTEND equal to DTSTART is not allowed (§3.8.2.2: it must be
 * later), and a block that starts before the due time would make the phone's reminder name the wrong time.
 * TRANSP:TRANSPARENT: a deadline is not a meeting, so it never marks the day busy. No LOCATION: the bid is placed on
 * the agency's site, and a place would make some phones offer travel times. No METHOD: this is a plain event to add,
 * not an iTIP scheduling message (RFC 5545 §3.7.2 would then want the same method in the Content-Type, and RFC 5546
 * §3.2.1 an ORGANIZER).
 *
 * Text values are escaped (backslash, semicolon, comma, newline), other control characters become spaces, every line
 * is folded at 75 octets without splitting a character, and lines end in CRLF.
 */

/** The line under the agency's link in DESCRIPTION. Sub work quotes the bidders (src/score/subwork.ts). */
export const CALENDAR_LINE = "Bid on the agency's site; check it for addenda.";
export const CALENDAR_SUB_LINE = "Sub work: quote the bidders before this; check the agency's site for addenda.";

/** Why a bid has no calendar file. The route answers 404 with this message (the app shows no button then). */
export type NoCalendar = 'no_due_time' | 'local_job' | 'closed';
export const NO_CALENDAR: Record<NoCalendar, string> = {
  no_due_time: 'This bid has no due time, so there is nothing to put in a calendar.',
  local_job: 'A local job is bid on here in the app, so it has no calendar file.',
  closed: 'The due time we have for this bid has passed, so there is nothing to put in a calendar.',
};
/** The route's 404 for a bid this profile does not see (or an unknown id). */
export const CALENDAR_NOT_FOUND = 'That bid is not one of your matches, or it is gone.';

/** Why `bid` gets no file at `now`, or null when it gets one. A due time at or before now is closed. */
export function noCalendar(bid: Pick<FeedItem, 'id' | 'source' | 'dueAt'>, now: Date): NoCalendar | null {
  if (bid.source === 'local' || bid.id.startsWith('local:')) return 'local_job';
  const due = bid.dueAt ? Date.parse(bid.dueAt) : Number.NaN;
  if (!Number.isFinite(due)) return 'no_due_time';
  if (due <= now.getTime()) return 'closed';
  return null;
}

/** TEXT (RFC 5545 §3.3.11): \ ; , escaped, a line break as \n, any other control character a space. */
export function escapeText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .replace(/[\\;,]/g, (c) => `\\${c}`)
    .replace(/\n/g, '\\n');
}

/**
 * One content line folded to 75 octets (RFC 5545 §3.1): each continuation starts with one space, which counts in its
 * line's 75. A UTF-8 character is never split. No CRLF inside the result's lines; the caller joins with CRLF.
 */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    const limit = out.length === 0 ? 75 : 74; // a continuation line spends one octet on its leading space
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.map((part, i) => (i === 0 ? part : ` ${part}`)).join('\r\n');
}

/** "2026-11-24T18:00:00.000Z" → "20261124T180000Z" (UTC). */
export function icsTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/** The same UID for the same bid every time, so a second download updates the event instead of adding one. */
export function calendarUid(bidId: string): string {
  return `${createHash('sha256').update(bidId).digest('hex').slice(0, 32)}@bidswipe`;
}

/** A URI value for URL and DESCRIPTION: only http(s), no spaces or control characters (as safeUrl in web/js/dom.js). */
function agencyUrl(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https?:\/\/[^\s\u0000-\u001f\u007f]+$/i.test(url) ? url : null;
}

/** The .ics text for a bid that has a due time (check noCalendar first). Lines end in CRLF, the file too. */
export function bidCalendar(bid: Pick<FeedItem, 'id' | 'title' | 'dueAt' | 'url' | 'tier'>, now: Date): string {
  const due = new Date(Date.parse(bid.dueAt ?? ''));
  if (!Number.isFinite(due.getTime())) throw new Error('bidCalendar: the bid has no due time (check noCalendar first)');
  const title = bid.title.trim() || 'a public bid';
  const url = agencyUrl(bid.url);
  const line = bid.tier === 'sub' ? CALENDAR_SUB_LINE : CALENDAR_LINE;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BidSwipe//Bid due time//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${calendarUid(bid.id)}`,
    `DTSTAMP:${icsTime(now)}`,
    `DTSTART:${icsTime(due)}`,
    `SUMMARY:${escapeText(`Bids due: ${title}`)}`,
    ...(url ? [`URL:${url}`] : []),
    `DESCRIPTION:${escapeText(url ? `${url}\n${line}` : line)}`,
    'TRANSP:TRANSPARENT',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(`Bids due tomorrow: ${title}`)}`,
    'TRIGGER:-P1D',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/**
 * A file name that is safe in any header and on any disk: "bids-due-otag-water-heater-replacement.ics". Letters
 * lose their accents, everything else that is not a-z or 0-9 becomes one hyphen, at most 60 characters of title.
 */
export function calendarFileName(title: string): string {
  const slug = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return `bids-due-${slug || 'bid'}.ics`;
}
