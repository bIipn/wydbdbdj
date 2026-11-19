/**
 * "Add to calendar" (docs/PLAN.md N10): src/feed/calendar.ts (the .ics text, RFC 5545) and GET /api/bids/:id/calendar.
 * Every bid here is synthetic (TEST- ids, example.com links, "(synthetic)" titles).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { getItem, saveProfileForAccount, upsertBids, upsertMatches, upsertProfile } from '../src/db/repo.js';
import {
  bidCalendar, CALENDAR_LINE, CALENDAR_NOT_FOUND, CALENDAR_SUB_LINE, calendarFileName, calendarUid, escapeText, foldLine, icsTime, NO_CALENDAR,
  noCalendar,
} from '../src/feed/calendar.js';
import { scoreBid } from '../src/score/score.js';
import { buildServer } from '../src/server.js';
import type { Account, Bid, FeedItem } from '../src/types.js';
import { accountsConfig, fakeAuth, memoryDb, seedAccount, testBid, testProfile } from './helpers.js';

const NOW = new Date('2026-11-18T20:00:00Z');
const octets = (s: string) => Buffer.byteLength(s, 'utf8');

/** RFC 5545 §3.1 backwards: lines split on CRLF, a line that starts with one space continues the one before. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n /g, '').split('\r\n').filter((l) => l !== '');
}
/** The value of the first `NAME:` line after unfolding (inside the alarm when `inAlarm`). */
function prop(ics: string, name: string, inAlarm = false): string | undefined {
  const lines = unfold(ics);
  const start = inAlarm ? lines.indexOf('BEGIN:VALARM') : 0;
  const end = inAlarm ? lines.indexOf('END:VALARM') : lines.indexOf('BEGIN:VALARM');
  return lines.slice(start, end < 0 ? undefined : end).find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1);
}
/** TEXT unescaped (§3.3.11). */
const unescape = (v: string) => v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

function item(over: Partial<FeedItem> = {}): FeedItem {
  return {
    ...testBid({ sourceId: 'TEST-cal', title: 'TEST panel upgrade (synthetic)', url: 'https://example.com/bids/TEST-cal?x=1&y=2' }),
    score: 70, verdict: 'good', reasons: [], distanceMi: 12, swipe: null, firstSeenAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(),
    overLimit: false, tier: 'fit', dueAt: '2026-11-24T18:00:00.000Z', ...over,
  } as FeedItem;
}

describe('the .ics text (RFC 5545)', () => {
  it('escapes backslash, semicolon, comma and line breaks; other control characters become spaces', () => {
    expect(escapeText('a\\b;c,d\ne\r\nf\rg')).toBe('a\\\\b\\;c\\,d\\ne\\nf\\ng');
    expect(escapeText('tab\there\u0007bell\u007fdel')).toBe('tab here bell del');
    expect(escapeText('Colons: stay as they are')).toBe('Colons: stay as they are');
  });

  it('folds at 75 octets, continuation lines start with one space, and a UTF-8 character is never split', () => {
    expect(foldLine('x'.repeat(75))).toBe('x'.repeat(75));
    const long = `SUMMARY:${'é'.repeat(100)}`; // 2 octets each
    const parts = foldLine(long).split('\r\n');
    expect(parts.length).toBeGreaterThan(2);
    for (const [i, p] of parts.entries()) {
      expect(octets(p), `line ${i}`).toBeLessThanOrEqual(75);
      if (i > 0) expect(p.startsWith(' ') && !p.startsWith('  ')).toBe(true);
      expect(p.includes('�')).toBe(false);
    }
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(long);
    // A 4-octet character at the edge moves to the next line whole.
    const edge = foldLine(`${'x'.repeat(73)}\u{1F527}y`).split('\r\n');
    expect(edge[0]).toBe('x'.repeat(73));
    expect(edge[1]).toBe(' \u{1F527}y');
  });

  it('UTC times in the basic form, and a UID that is the same for the same bid every time', () => {
    expect(icsTime(new Date('2026-11-24T18:00:00.000Z'))).toBe('20261124T180000Z');
    expect(calendarUid('questcdn:1903611:10385980')).toBe(calendarUid('questcdn:1903611:10385980'));
    expect(calendarUid('questcdn:1903611:10385980')).not.toBe(calendarUid('questcdn:1903611:10385981'));
    expect(calendarUid('questcdn:1903611:10385980')).toMatch(/^[0-9a-f]{32}@bidswipe$/);
  });

  it('one VEVENT that ends at the due time, with the agency link, the addenda line and an alarm the day before', () => {
    const ics = bidCalendar(item(), NOW);
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/); // CRLF only, never a bare CR or LF
    for (const line of ics.split('\r\n')) expect(octets(line), line).toBeLessThanOrEqual(75);
    const lines = unfold(ics);
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(lines.slice(0, 2)).toEqual(['BEGIN:VCALENDAR', 'VERSION:2.0']);
    // A plain event to add, not an iTIP message: no METHOD (it would need the same method in the Content-Type and an
    // ORGANIZER: RFC 5545 §3.7.2, RFC 5546 §3.2.1).
    expect(lines.some((l) => l.startsWith('METHOD') || l.startsWith('ORGANIZER'))).toBe(false);
    expect(lines.at(-1)).toBe('END:VCALENDAR');
    expect(prop(ics, 'UID')).toBe(calendarUid(item().id));
    expect(prop(ics, 'DTSTAMP')).toBe('20261118T200000Z');
    // No DTEND: an event with a DATE-TIME start and no end ends where it starts (RFC 5545 §3.6.1), at the due time.
    expect(prop(ics, 'DTSTART')).toBe('20261124T180000Z');
    expect(lines.some((l) => l.startsWith('DTEND') || l.startsWith('DURATION'))).toBe(false);
    expect(unescape(prop(ics, 'SUMMARY')!)).toBe('Bids due: TEST panel upgrade (synthetic)');
    expect(prop(ics, 'URL')).toBe('https://example.com/bids/TEST-cal?x=1&y=2');
    expect(unescape(prop(ics, 'DESCRIPTION')!)).toBe(`https://example.com/bids/TEST-cal?x=1&y=2\n${CALENDAR_LINE}`);
    expect(CALENDAR_LINE).toBe("Bid on the agency's site; check it for addenda.");
    expect(prop(ics, 'TRIGGER', true)).toBe('-P1D');
    expect(prop(ics, 'ACTION', true)).toBe('DISPLAY');
    expect(unescape(prop(ics, 'DESCRIPTION', true)!)).toBe('Bids due tomorrow: TEST panel upgrade (synthetic)');
    // The same bid at another moment: the same event (UID), a new stamp.
    const later = bidCalendar(item(), new Date('2026-11-19T08:00:00Z'));
    expect(prop(later, 'UID')).toBe(prop(ics, 'UID'));
    expect(prop(later, 'DTSTAMP')).toBe('20261119T080000Z');
  });

  it('a title with commas, semicolons, a backslash and a line break comes back whole; a long one is folded', () => {
    const title = 'TEST Fire alarm, panel; and\\or lighting\nphase 2 — Ñandú Élan Hall 💡 (synthetic) '.repeat(3).trim();
    const ics = bidCalendar(item({ title }), NOW);
    for (const line of ics.split('\r\n')) expect(octets(line)).toBeLessThanOrEqual(75);
    expect(unescape(prop(ics, 'SUMMARY')!)).toBe(`Bids due: ${title}`);
  });

  it('sub work says to quote the bidders; a link that is not http(s) is left out', () => {
    const sub = bidCalendar(item({ tier: 'sub' }), NOW);
    expect(unescape(prop(sub, 'DESCRIPTION')!)).toBe(`https://example.com/bids/TEST-cal?x=1&y=2\n${CALENDAR_SUB_LINE}`);
    const odd = bidCalendar(item({ url: 'javascript:alert(1)' }), NOW);
    expect(prop(odd, 'URL')).toBeUndefined();
    expect(unescape(prop(odd, 'DESCRIPTION')!)).toBe(CALENDAR_LINE);
  });

  it('no file for a bid with no due time, a due time already past or a local job, with a sentence for each', () => {
    expect(noCalendar(item(), NOW)).toBeNull();
    expect(noCalendar(item({ dueAt: null }), NOW)).toBe('no_due_time');
    expect(noCalendar(item({ dueAt: 'not a date' }), NOW)).toBe('no_due_time');
    expect(noCalendar(item({ id: 'local:00000000-0000-4000-8000-000000000001', source: 'local' }), NOW)).toBe('local_job');
    // A past event with a past alarm is no use: the due time at or before now is closed (the app hides the link too).
    expect(noCalendar(item({ dueAt: NOW.toISOString() }), NOW)).toBe('closed');
    expect(noCalendar(item({ dueAt: '2026-11-10T18:00:00.000Z' }), NOW)).toBe('closed');
    expect(noCalendar(item({ dueAt: new Date(NOW.getTime() + 1000).toISOString() }), NOW)).toBeNull();
    expect(NO_CALENDAR.no_due_time).toMatch(/no due time/);
    expect(NO_CALENDAR.closed).toMatch(/has passed/);
    expect(() => bidCalendar(item({ dueAt: null }), NOW)).toThrow(/no due time/);
  });

  it('a file name that is safe in a header and on a disk', () => {
    expect(calendarFileName('OTAG Water Heater Replacement')).toBe('bids-due-otag-water-heater-replacement.ics');
    expect(calendarFileName('Élan "Hall"; rm -rf /\r\nX: y')).toBe('bids-due-elan-hall-rm-rf-x-y.ics');
    expect(calendarFileName('💡💡')).toBe('bids-due-bid.ics');
    const long = calendarFileName('CR25-319742.FMD.DataCenterEmergencyGenerator and a great deal more text after it');
    expect(long).toMatch(/^bids-due-[a-z0-9]+(?:-[a-z0-9]+)*\.ics$/);
    expect(long.length).toBeLessThanOrEqual('bids-due-'.length + 60 + '.ics'.length);
  });
});

// ------------------------------------------------------------------------------------------------ the route --

describe('GET /api/bids/:id/calendar', () => {
  let db: Db;
  let app: FastifyInstance;
  let single: FastifyInstance;
  let me: Account;
  let current: Account | null = null;
  const profile = testProfile('TEST-cal-profile');
  const withDue: Bid = testBid({ source: 'questcdn', sourceId: '1903611:TEST-10385980', title: 'TEST Hall lighting, phase 2 (synthetic)', dueAt: '2026-11-24T18:00:00.000Z' });
  const noDue: Bid = testBid({ sourceId: 'TEST-nodue', title: 'TEST open-ended service (synthetic)', dueAt: null });
  const unseen: Bid = testBid({ sourceId: 'TEST-unseen', title: 'TEST not in this profile (synthetic)' });
  const local: Bid = testBid({ source: 'local', sourceId: '00000000-0000-4000-8000-0000000000c1', title: 'TEST local job (synthetic)' } as Partial<Bid>);
  const closed: Bid = testBid({ sourceId: 'TEST-closed', title: 'TEST closed (synthetic)', dueAt: '2026-11-10T18:00:00.000Z' });

  beforeAll(async () => {
    db = await memoryDb();
    me = await seedAccount(db);
    await saveProfileForAccount(db, me.id, profile);
    await upsertBids(db, [withDue, noDue, unseen, local, closed], NOW);
    await upsertMatches(db, profile.id, [withDue, noDue, local, closed].map((b) => ({ bidId: b.id, score: scoreBid(b, profile, NOW) })));
    app = await buildServer({ db }, { config: accountsConfig(), auth: fakeAuth(() => current), now: () => NOW });
    // Single mode (the pilot): the config profile, no sign-in.
    await upsertProfile(db, testProfile('TEST-cal-single'));
    await upsertMatches(db, 'TEST-cal-single', [{ bidId: withDue.id, score: scoreBid(withDue, testProfile('TEST-cal-single'), NOW) }]);
    single = await buildServer({ db, profile: testProfile('TEST-cal-single') }, { now: () => NOW });
  });
  afterAll(async () => {
    await app?.close();
    await single?.close();
    await db?.close();
  });

  const get = (id: string, a: FastifyInstance = app) => a.inject({ method: 'GET', url: `/api/bids/${id}/calendar` });

  it('answers the .ics file for a bid this profile sees, the id percent-encoded (questcdn:1903611:…)', async () => {
    current = me;
    expect(withDue.id).toBe('questcdn:1903611:TEST-10385980');
    const res = await get(encodeURIComponent(withDue.id));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="bids-due-test-hall-lighting-phase-2-synthetic.ics"');
    const seen = (await getItem(db, profile.id, withDue.id))!;
    expect(res.body).toBe(bidCalendar(seen, NOW));
    expect(unescape(prop(res.body, 'SUMMARY')!)).toBe('Bids due: TEST Hall lighting, phase 2 (synthetic)');
    // The colons may also come as they are.
    expect((await get(withDue.id)).body).toBe(res.body);
  });

  it('changes nothing: no swipe, no alert, the same file twice', async () => {
    current = me;
    const before = await db.query<{ n: number }>('select (select count(*) from swipes)::int + (select count(*) from alerts)::int as n');
    const a = await get(encodeURIComponent(withDue.id));
    const b = await get(encodeURIComponent(withDue.id));
    expect(a.body).toBe(b.body);
    const after = await db.query<{ n: number }>('select (select count(*) from swipes)::int + (select count(*) from alerts)::int as n');
    expect(after[0]!.n).toBe(before[0]!.n);
    expect((await getItem(db, profile.id, withDue.id))!.swipe).toBeNull();
  });

  it('404 with a sentence for a bid with no due time, a closed bid, a local job, a bid this profile does not see, an unknown id', async () => {
    current = me;
    const noDueRes = await get(encodeURIComponent(noDue.id));
    expect([noDueRes.statusCode, noDueRes.json()]).toEqual([404, { error: 'no_due_time', message: NO_CALENDAR.no_due_time }]);
    const localRes = await get(encodeURIComponent(local.id));
    expect([localRes.statusCode, localRes.json()]).toEqual([404, { error: 'local_job', message: NO_CALENDAR.local_job }]);
    const closedRes = await get(encodeURIComponent(closed.id));
    expect([closedRes.statusCode, closedRes.json()]).toEqual([404, { error: 'closed', message: NO_CALENDAR.closed }]);
    for (const id of [unseen.id, 'questcdn:0:0']) {
      const res = await get(encodeURIComponent(id));
      expect([res.statusCode, res.json()], id).toEqual([404, { error: 'not_found', message: CALENDAR_NOT_FOUND }]);
    }
    expect((await get('x'.repeat(201))).statusCode).toBe(404); // the router's own 404 (a path id is at most 100 characters)
  });

  it('refuses control characters in the id; signed out is 401; only GET', async () => {
    current = me;
    for (const raw of ['%00', 'a%07b', 'samgov%3ATEST%0A1', '%7F']) {
      const res = await get(raw);
      expect(res.statusCode, raw).toBe(400);
      expect(res.json().error).toBe('invalid_input');
    }
    current = null;
    expect((await get(encodeURIComponent(withDue.id))).statusCode).toBe(401);
    current = me;
    const post = await app.inject({ method: 'POST', url: `/api/bids/${encodeURIComponent(withDue.id)}/calendar`, headers: { 'x-bidswipe': '1' } });
    expect(post.statusCode).toBe(404);
  });

  it('single mode (the pilot): the config profile gets its file too', async () => {
    const res = await get(encodeURIComponent(withDue.id), single);
    expect(res.statusCode).toBe(200);
    expect(prop(res.body, 'DTSTART')).toBe('20261124T180000Z');
  });
});
