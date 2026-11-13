/**
 * Realtime: the alert rules, the inbox, web push, the live stream and deadline reminders.
 *
 * Everything made up here is obviously synthetic (TEST- ids, example.com, "(simulated)" names).
 * Nothing talks to a push service: the sender is a fake, or a request is built and never sent.
 */
import { createECDH, randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import fc from 'fast-check';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateVAPIDKeys, WebPushError } from 'web-push';
import type { AuthService } from '../src/auth/index.js';
import { createContext, loadConfig, type AppConfig } from '../src/context.js';
import {
  alertsAfter, claimWaitingPushes, countUnread, deleteSubscription, ensureSingleOwner, getAlertTarget, insertAlert,
  latestAlertId, listAlerts, listSubscriptions, markAlertsRead, MAX_DEVICES, profilesWithWaitingPush, recordPushResult,
  releasePushClaim, savedBidsDueWithin, saveSubscription, singleOwnerId, subscriptionsForProfile,
  type NewAlert, type SavedDeadline, type StoredSubscription,
} from '../src/db/alerts.js';
import type { Db } from '../src/db/db.js';
import { recordSwipe, saveProfileForAccount, upsertBids, upsertMatch, upsertProfile } from '../src/db/repo.js';
import { profileIdFor } from '../src/profile/build.js';
import {
  deadlineStage, decideAward, decideDeadline, decideMatch, decidePrice, inQuietHours, pushDecision, timeLeft,
  type DeadlineStage, type PushDecision,
} from '../src/realtime/alerts.js';
import { createBus, type Bus, type BusEventOf } from '../src/realtime/bus.js';
import { createRealtime, startRealtime, type Realtime } from '../src/realtime/index.js';
import {
  buildPushRequest, createWebPushSender, MAX_PAYLOAD_BYTES, parseSubscription, pushMessage, toPushResult, usableVapid,
  type PushMessage, type PushPayload, type PushResult, type PushSender,
} from '../src/realtime/push.js';
import { createStreamHub, sseFrame } from '../src/realtime/stream.js';
import { register as realtimeRoutes } from '../src/routes/realtime.js';
import type { ScanReport } from '../src/scan.js';
import { buildApp } from '../src/server.js';
import type { Account, Alert, AlertSettings, Award, Bid, Plan, Profile, ScoreResult } from '../src/types.js';
import { accountsConfig, fakeAuth, memoryDb, NOW, resetDb, seedAccount, testBid, testProfile } from './helpers.js';

// ----------------------------------------------------------------- fixtures --

const at = (iso: string): Date => new Date(iso);
const HOUR = 3_600_000;

/** A score as the scan would hand it over (synthetic numbers, the real reason wording). */
const fit = (over: Partial<ScoreResult> = {}): ScoreResult => ({
  score: 82, verdict: 'great', distanceMi: 14, rejected: null, overLimit: false,
  reasons: [
    { kind: 'plus', text: 'Electrical scope: “panel”' },
    { kind: 'plus', text: '14 mi from Gardnerville' },
    { kind: 'info', text: 'Bid bond' },
  ],
  ...over,
});

const matchEvent = (profileId: string, over: Partial<BusEventOf<'match'>> = {}): BusEventOf<'match'> => ({
  type: 'match', profileId, bid: testBid(), score: fit(), isNewBid: true, ...over,
});

/** A browser subscription with real-looking keys (a fresh P-256 point and a 16-byte secret). */
function device(name: string | number): StoredSubscription {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://push.example.com/send/TEST-device-${name}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

const alertRow = (over: Partial<Alert> = {}): Alert => ({
  id: 7, profileId: 'test-push', kind: 'match', bidId: 'samgov:TEST-row', dedupeKey: 'samgov:TEST-row',
  title: 'Great fit (82) · Carson City, NV', body: 'TEST job (synthetic) — Electrical scope: “panel” · 21 days left',
  data: {}, createdAt: NOW.toISOString(), pushedAt: null, readAt: null, ...over,
});

const award = (over: Partial<Award> = {}): Award => ({
  id: 'TEST:award-1', source: 'TEST source', awardId: 'TEST-AWARD-1', solNumber: null, recipient: 'TEST Contractor LLC (simulated)',
  amount: 48_200, actionDate: '2026-10-30', naics: '238210', psc: null, agency: 'TEST agency', description: null, city: null,
  county: null, state: 'NV', zip: null, lat: null, lng: null, url: 'https://example.com/test-award', fetchedAt: NOW.toISOString(),
  ...over,
});

/** VAPID keys generated for this run: real key material, tied to nothing. */
const testVapid = { ...generateVAPIDKeys(), subject: 'mailto:test@example.com' };

const ZONES = ['America/Los_Angeles', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe', 'UTC'] as const;

// ------------------------------------------------------------- pure rules --

describe('match alerts: who is alerted (decision table)', () => {
  const profile = testProfile('test-rules'); // notify.minScore 55, no alert settings
  const bid = testBid();
  const event = (over: Partial<BusEventOf<'match'>> = {}) => matchEvent(profile.id, { bid, ...over });

  it.each<[string, Partial<ScoreResult>, AlertSettings | undefined, boolean]>([
    ['exactly at the profile threshold (notify.minScore 55)', { score: 55, verdict: 'good' }, undefined, true],
    ['one point below it', { score: 54, verdict: 'maybe' }, undefined, false],
    ['alerts.minScore raises the bar', { score: 82 }, { minScore: 90 }, false],
    ['alerts.minScore lowers the bar', { score: 40, verdict: 'maybe' }, { minScore: 40 }, true],
    ['a hard no, whatever the score', { rejected: 'Too far: 240 mi' }, undefined, false],
    ['over the spend limit', { overLimit: true }, undefined, false],
    ['match alerts switched off', {}, { kinds: { match: false } }, false],
    ['only other kinds switched off', {}, { kinds: { deadline: false, price: false } }, true],
  ])('%s', (_name, score, alerts, alerted) => {
    const decision = decideMatch(event({ score: fit(score) }), { ...profile, alerts }, 'pro', NOW);
    expect(decision !== null).toBe(alerted);
  });

  it('builds short, specific copy: title = fit + place, body = the job, the top reason and the days left', () => {
    expect(decideMatch(event(), profile, 'pro', NOW)).toEqual({
      alert: {
        kind: 'match', bidId: bid.id, dedupeKey: bid.id,
        title: 'Great fit (82) · Carson City, NV',
        body: 'TEST electrical panel upgrade (synthetic) — Electrical scope: “panel” · 21 days left',
        data: { bidId: bid.id, score: 82, url: 'https://example.com/test-bid' },
      },
      push: 'send',
    });
  });

  it('never leads with a minus, falls back to the agency for the place, and stays short', () => {
    const noPlace: Bid = { ...bid, location: { ...bid.location, label: null }, title: `TEST ${'very long title '.repeat(30)}` };
    const onlyMinus = fit({ score: 60, verdict: 'good', reasons: [{ kind: 'minus', text: 'Only 2 days to bid' }, { kind: 'info', text: 'Bid bond' }] });
    const { alert } = decideMatch(event({ bid: noPlace, score: onlyMinus }), profile, 'pro', NOW)!;
    expect(alert.title).toBe('Good fit (60) · TEST agency');
    expect(alert.body).toContain('Bid bond · 21 days left');
    expect(alert.body).not.toContain('Only 2 days');
    expect(alert.body.length).toBeLessThanOrEqual(200);
    expect(alert.body).not.toMatch(/\n/);
  });

  it.each<[string, Plan, AlertSettings | undefined, boolean, Date, PushDecision]>([
    ['free plan: inbox only', 'free', undefined, true, NOW, 'off'],
    ['pro: buzz the phone', 'pro', undefined, true, NOW, 'send'],
    ['pilot: buzz the phone', 'pilot', undefined, true, NOW, 'send'],
    ['pro, phone alerts turned off', 'pro', { push: false }, true, NOW, 'off'],
    ['pro, a bid that was already on the boards', 'pro', undefined, false, NOW, 'off'],
    ['pro, inside quiet hours (22:30 Pacific)', 'pro', { quietHours: { start: '21:00', end: '06:00' } }, true, at('2026-11-12T06:30:00Z'), 'hold'],
    ['pro, quiet hours over (06:00 Pacific)', 'pro', { quietHours: { start: '21:00', end: '06:00' } }, true, at('2026-11-12T14:00:00Z'), 'send'],
    ['free, inside quiet hours: still off, not held', 'free', { quietHours: { start: '21:00', end: '06:00' } }, true, at('2026-11-12T06:30:00Z'), 'off'],
  ])('push — %s', (_name, plan, alerts, isNewBid, now, push) => {
    // The alert itself is made either way: quiet hours and the plan only decide about the phone.
    expect(decideMatch(event({ isNewBid }), { ...profile, alerts }, plan, now)?.push).toBe(push);
  });
});

describe('quiet hours', () => {
  const night = { start: '21:00', end: '06:00' };

  it.each<[string, AlertSettings, string, boolean]>([
    ['Pacific 20:59 — a minute before', { quietHours: night }, '2026-11-12T04:59:00Z', false],
    ['Pacific 21:00 — the start minute is quiet', { quietHours: night }, '2026-11-12T05:00:00Z', true],
    ['Pacific 23:59', { quietHours: night }, '2026-11-12T07:59:00Z', true],
    ['Pacific 00:00 — across midnight', { quietHours: night }, '2026-11-12T08:00:00Z', true],
    ['Pacific 05:59', { quietHours: night }, '2026-11-12T13:59:00Z', true],
    ['Pacific 06:00 — the end minute is not quiet', { quietHours: night }, '2026-11-12T14:00:00Z', false],
    ['Pacific noon', { quietHours: night }, '2026-11-12T20:00:00Z', false],
    ['Pacific is the default zone', { quietHours: night, timeZone: 'America/Los_Angeles' }, '2026-11-12T05:00:00Z', true],
    ['an instant that is 18:30 in Pacific…', { quietHours: night }, '2026-11-12T02:30:00Z', false],
    ['…is 21:30 in New York', { quietHours: night, timeZone: 'America/New_York' }, '2026-11-12T02:30:00Z', true],
    ['03:30 Pacific is quiet…', { quietHours: night }, '2026-11-12T11:30:00Z', true],
    ['…but already 06:30 in New York', { quietHours: night, timeZone: 'America/New_York' }, '2026-11-12T11:30:00Z', false],
    ['summer: 21:30 PDT (UTC−7)', { quietHours: night }, '2026-07-02T04:30:00Z', true],
    ['summer: 06:30 PDT — would be 05:30 without daylight saving', { quietHours: night }, '2026-07-02T13:30:00Z', false],
    ['a half-hour zone: 21:59 in Kolkata', { quietHours: { start: '22:00', end: '07:00' }, timeZone: 'Asia/Kolkata' }, '2026-11-12T16:29:00Z', false],
    ['a half-hour zone: 22:00 in Kolkata', { quietHours: { start: '22:00', end: '07:00' }, timeZone: 'Asia/Kolkata' }, '2026-11-12T16:30:00Z', true],
    ['a same-day window, inside (12:30)', { quietHours: { start: '12:00', end: '13:00' } }, '2026-11-12T20:30:00Z', true],
    ['a same-day window, at its end (13:00)', { quietHours: { start: '12:00', end: '13:00' } }, '2026-11-12T21:00:00Z', false],
    ['a same-day window, before (11:59)', { quietHours: { start: '12:00', end: '13:00' } }, '2026-11-12T19:59:00Z', false],
    ['an unknown zone reads as Pacific', { quietHours: night, timeZone: 'Mars/Olympus_Mons' }, '2026-11-12T05:00:00Z', true],
    ['no window', {}, '2026-11-12T08:00:00Z', false],
    ['window set to null', { quietHours: null }, '2026-11-12T08:00:00Z', false],
    ['equal ends = off', { quietHours: { start: '21:00', end: '21:00' } }, '2026-11-12T05:00:00Z', false],
    ['a malformed time = off', { quietHours: { start: '9pm', end: '06:00' } }, '2026-11-12T08:00:00Z', false],
    ['an impossible time = off', { quietHours: { start: '25:00', end: '06:00' } }, '2026-11-12T08:00:00Z', false],
  ])('%s', (_name, alerts, instant, quiet) => {
    expect(inQuietHours(alerts, at(instant))).toBe(quiet);
  });

  it('no settings at all is never quiet', () => {
    expect(inQuietHours(undefined, NOW)).toBe(false);
  });

  const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const minuteOfDay = fc.integer({ min: 0, max: 1439 });

  it('a window and its mirror image split every instant between them, in any zone', () => {
    fc.assert(fc.property(
      minuteOfDay, minuteOfDay, fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }), fc.constantFrom(...ZONES),
      (start, end, ms, timeZone) => {
        fc.pre(start !== end);
        const inside = inQuietHours({ quietHours: { start: clock(start), end: clock(end) }, timeZone }, new Date(ms));
        const mirrored = inQuietHours({ quietHours: { start: clock(end), end: clock(start) }, timeZone }, new Date(ms));
        expect(inside).not.toBe(mirrored);
      },
    ));
  });

  it('is quiet for exactly (end − start) mod 24 h of a day', () => {
    fc.assert(fc.property(minuteOfDay, minuteOfDay, (start, end) => {
      fc.pre(start !== end);
      const alerts = { quietHours: { start: clock(start), end: clock(end) }, timeZone: 'UTC' };
      let quiet = 0;
      for (let m = 0; m < 1440; m++) if (inQuietHours(alerts, new Date(Date.UTC(2026, 10, 12, 0, m)))) quiet++;
      expect(quiet).toBe((end - start + 1440) % 1440);
    }), { numRuns: 40 });
  });

  it.each<[Plan, AlertSettings | undefined, string, PushDecision]>([
    ['free', undefined, '2026-11-12T20:00:00Z', 'off'],
    ['free', { push: true }, '2026-11-12T20:00:00Z', 'off'],
    ['pro', undefined, '2026-11-12T20:00:00Z', 'send'],
    ['pro', { push: true }, '2026-11-12T20:00:00Z', 'send'],
    ['pro', { push: false }, '2026-11-12T20:00:00Z', 'off'],
    ['pilot', { quietHours: night }, '2026-11-12T20:00:00Z', 'send'],
    ['pilot', { quietHours: night }, '2026-11-12T08:00:00Z', 'hold'],
    ['pro', { quietHours: night, timeZone: 'America/New_York' }, '2026-11-12T02:30:00Z', 'hold'],
    ['pro', { quietHours: night, push: false }, '2026-11-12T08:00:00Z', 'off'],
  ])('pushDecision(%s, %j) at %s → %s', (plan, alerts, instant, decision) => {
    expect(pushDecision(alerts, plan, at(instant))).toBe(decision);
  });
});

describe('deadline reminders: stages', () => {
  const due = at('2026-11-19T22:00:00Z'); // Thursday 2:00 PM Pacific, 5:00 PM in New York
  const before = (hours: number, minutes = 0) => new Date(due.getTime() - hours * HOUR - minutes * 60_000);

  it.each<[string, Date, string, DeadlineStage | null]>([
    ['80 h before', before(80), 'America/Los_Angeles', null],
    ['a minute too early', before(72, 1), 'America/Los_Angeles', null],
    ['exactly 72 h before', before(72), 'America/Los_Angeles', '3d'],
    ['48 h 1 min before', before(48, 1), 'America/Los_Angeles', '3d'],
    ['exactly 48 h before: the 3-day window is over', before(48), 'America/Los_Angeles', null],
    ['36 h before: between reminders', before(36), 'America/Los_Angeles', null],
    ['24 h 1 min before', before(24, 1), 'America/Los_Angeles', null],
    ['exactly 24 h before', before(24), 'America/Los_Angeles', '1d'],
    ['Wednesday 23:59 Pacific', at('2026-11-19T07:59:00Z'), 'America/Los_Angeles', '1d'],
    ['Thursday 00:00 Pacific: the due day, not morning yet', at('2026-11-19T08:00:00Z'), 'America/Los_Angeles', null],
    ['Thursday 06:59 Pacific', at('2026-11-19T14:59:00Z'), 'America/Los_Angeles', null],
    ['Thursday 07:00 Pacific: the morning of', at('2026-11-19T15:00:00Z'), 'America/Los_Angeles', 'day'],
    ['a minute before the deadline', before(0, 1), 'America/Los_Angeles', 'day'],
    ['at the deadline', due, 'America/Los_Angeles', null],
    ['after the deadline', before(-1), 'America/Los_Angeles', null],
    // The same instants read on a New York clock (three hours ahead).
    ['04:00 Pacific is 07:00 in New York: morning there', at('2026-11-19T12:00:00Z'), 'America/New_York', 'day'],
    ['…and still night in Pacific', at('2026-11-19T12:00:00Z'), 'America/Los_Angeles', null],
    ['Wednesday 21:00 Pacific is already Thursday 00:00 in New York', at('2026-11-19T05:00:00Z'), 'America/New_York', null],
    ['…and still the day before in Pacific', at('2026-11-19T05:00:00Z'), 'America/Los_Angeles', '1d'],
    ['an unknown zone reads as Pacific', at('2026-11-19T15:00:00Z'), 'Mars/Olympus_Mons', 'day'],
  ])('%s', (_name, now, zone, stage) => {
    expect(deadlineStage(due, now, zone)).toBe(stage);
  });

  it('a bid due before 07:00 has no morning-of reminder', () => {
    const early = at('2026-11-19T13:00:00Z'); // Thursday 5:00 AM Pacific
    expect(deadlineStage(early, at('2026-11-19T07:00:00Z'), 'America/Los_Angeles')).toBe('1d'); // Wednesday 23:00
    expect(deadlineStage(early, at('2026-11-19T12:00:00Z'), 'America/Los_Angeles')).toBeNull(); // Thursday 04:00
  });

  it('walking the clock toward any deadline, in any zone, the stages come once each and in order', () => {
    fc.assert(fc.property(
      fc.integer({ min: Date.UTC(2026, 0, 1) / 60_000, max: Date.UTC(2027, 11, 31) / 60_000 }), fc.constantFrom(...ZONES),
      (dueMinute, zone) => {
        const deadline = new Date(dueMinute * 60_000);
        const seen: string[] = [];
        // The job's own rhythm: every 15 minutes, from 80 hours out to the deadline.
        for (let t = deadline.getTime() - 80 * HOUR; t <= deadline.getTime(); t += 15 * 60_000) {
          const stage = deadlineStage(deadline, new Date(t), zone);
          if (stage && seen.at(-1) !== stage) seen.push(stage);
        }
        // '1d' is only missing when the whole last day is the due day itself (a 25-hour day).
        expect(['3d,1d', '3d,1d,day', '3d,day']).toContain(seen.join(','));
      },
    ));
  });

  const saved: SavedDeadline = {
    profileId: 'test-deadline', bidId: 'samgov:TEST-due', title: 'TEST switchgear replacement (synthetic)',
    dueAt: due.toISOString(), place: 'Carson City, NV', url: 'https://example.com/test-bid',
  };
  const profile = testProfile('test-deadline');

  it('says when it is due in calendar days on the profile\'s clock, and keys the alert by bid, stage and due day', () => {
    expect(decideDeadline(saved, profile, 'pro', before(71))).toEqual({
      alert: {
        kind: 'deadline', bidId: saved.bidId, dedupeKey: 'samgov:TEST-due:3d:2026-11-19',
        title: 'Due in 3 days · Thu 2:00 PM',
        body: 'TEST switchgear replacement (synthetic) — Carson City, NV',
        data: { bidId: saved.bidId, stage: '3d', dueAt: saved.dueAt, url: saved.url },
      },
      push: 'send',
    });
    // Still inside the 3-day window, but a calendar day later: the wording follows the calendar.
    expect(decideDeadline(saved, profile, 'pro', before(49))?.alert.title).toBe('Due in 2 days · Thu 2:00 PM');
    expect(decideDeadline(saved, profile, 'pro', before(23))?.alert).toMatchObject({
      title: 'Due tomorrow at 2:00 PM', dedupeKey: 'samgov:TEST-due:1d:2026-11-19',
    });
    expect(decideDeadline(saved, profile, 'pro', at('2026-11-19T15:00:00Z'))?.alert).toMatchObject({
      title: 'Due today at 2:00 PM', dedupeKey: 'samgov:TEST-due:day:2026-11-19',
    });
    expect(decideDeadline(saved, profile, 'pro', before(36))).toBeNull();
  });

  it('reads the profile\'s time zone, respects the deadline switch, and gates the push like any alert', () => {
    const eastern = { ...profile, alerts: { timeZone: 'America/New_York' } };
    expect(decideDeadline(saved, eastern, 'pro', at('2026-11-19T12:00:00Z'))?.alert.title).toBe('Due today at 5:00 PM');
    expect(decideDeadline(saved, profile, 'pro', at('2026-11-19T12:00:00Z'))).toBeNull();

    expect(decideDeadline(saved, { ...profile, alerts: { kinds: { deadline: false } } }, 'pro', before(71))).toBeNull();
    expect(decideDeadline(saved, profile, 'free', before(71))?.push).toBe('off');
    // 07:00 Pacific with quiet hours until 08:00: the reminder is made, the buzz waits.
    const sleepsIn = { ...profile, alerts: { quietHours: { start: '22:00', end: '08:00' } } };
    expect(decideDeadline(saved, sleepsIn, 'pro', at('2026-11-19T15:00:00Z'))?.push).toBe('hold');
  });
});

describe('award and price alerts', () => {
  const profile = testProfile('test-market');
  const awardEvent = (a: Award, bidId?: string): BusEventOf<'award'> => ({ type: 'award', profileId: profile.id, award: a, bidId });

  it('an award notice states only what the award record says, with its source', () => {
    const bid = testBid();
    expect(decideAward(awardEvent(award(), bid.id), profile, 'pro', NOW, bid)).toEqual({
      alert: {
        kind: 'award', bidId: bid.id, dedupeKey: 'TEST:award-1',
        title: 'Award posted: TEST electrical panel upgrade (synthetic)',
        body: 'Awarded to TEST Contractor LLC (simulated) for $48,200 on 2026-10-30 · source: TEST source',
        data: {
          awardId: 'TEST:award-1', bidId: bid.id, recipient: 'TEST Contractor LLC (simulated)', amount: 48_200,
          actionDate: '2026-10-30', source: 'TEST source', url: 'https://example.com/test-award',
        },
      },
      push: 'send',
    });
    expect(decideAward(awardEvent(award()), profile, 'pro', NOW, null)?.alert).toMatchObject({ title: 'Award posted · TEST agency', bidId: null });
    expect(decideAward(awardEvent(award({ amount: 48_200.5 })), profile, 'pro', NOW, null)?.alert.body).toContain('for $48,200.50 on');
  });

  it('an award with no amount or recipient gets no invented figure', () => {
    const bare = decideAward(awardEvent(award({ amount: null, recipient: null, actionDate: null, agency: null })), profile, 'pro', NOW, null)!;
    expect(bare.alert).toMatchObject({ title: 'Award posted', body: 'Result posted · source: TEST source' });
    expect(bare.alert.body).not.toMatch(/\$|\d/);
    expect(decideAward(awardEvent(award({ recipient: null })), profile, 'pro', NOW, null)?.alert.body).toBe('Awarded for $48,200 on 2026-10-30 · source: TEST source');
  });

  it('award notices are a Pro feature and can be switched off', () => {
    expect(decideAward(awardEvent(award()), profile, 'free', NOW, null)).toBeNull();
    expect(decideAward(awardEvent(award()), { ...profile, alerts: { kinds: { award: false } } }, 'pro', NOW, null)).toBeNull();
    expect(decideAward(awardEvent(award()), profile, 'pilot', NOW, null)).not.toBeNull();
  });

  const label = { title: 'TEST copper wire index (synthetic)', source: 'TEST source', sourceUrl: 'https://example.com/test-series' };
  const priceEvent = (changePct: number): BusEventOf<'price'> => ({ type: 'price', seriesId: 'TEST-SERIES-1', changePct, period: '2026-10' });

  it('a price alert always carries its source and period', () => {
    expect(decidePrice(priceEvent(8.24), label, profile, 'pro', NOW)).toEqual({
      alert: {
        kind: 'price', bidId: null, dedupeKey: 'TEST-SERIES-1:2026-10',
        title: 'TEST copper wire index (synthetic) up 8.2%',
        body: 'Period 2026-10 · source: TEST source. Re-check open quotes.',
        data: { seriesId: 'TEST-SERIES-1', changePct: 8.24, period: '2026-10', source: 'TEST source', sourceUrl: 'https://example.com/test-series' },
      },
      push: 'send',
    });
    expect(decidePrice(priceEvent(-3), label, profile, 'pro', NOW)?.alert.title).toBe('TEST copper wire index (synthetic) down 3%');
  });

  it('no alert for a series we cannot name, a broken number, the free plan, or a switched-off kind', () => {
    expect(decidePrice(priceEvent(8), null, profile, 'pro', NOW)).toBeNull();
    expect(decidePrice(priceEvent(Number.NaN), label, profile, 'pro', NOW)).toBeNull();
    expect(decidePrice(priceEvent(8), label, profile, 'free', NOW)).toBeNull();
    expect(decidePrice(priceEvent(8), label, { ...profile, alerts: { kinds: { price: false } } }, 'pro', NOW)).toBeNull();
  });

  it.each<[string | null, string]>([
    [null, 'no deadline listed'],
    ['2026-12-02T22:00:00Z', '21 days left'],
    ['2026-11-12T20:00:00Z', '1 day left'],
    ['2026-11-12T19:59:00Z', '23 hours left'],
    ['2026-11-11T21:00:00Z', '1 hour left'],
    ['2026-11-11T20:59:00Z', 'under 1 hour left'],
    ['2026-11-11T20:00:00Z', 'closed'],
  ])('timeLeft(%s) → %s', (dueAt, text) => {
    expect(timeLeft(dueAt, NOW)).toBe(text);
  });
});

// ------------------------------------------------------------------- push --

describe('push: subscriptions, payloads and the web-push request', () => {
  const good = device('parse');

  it('accepts what a browser gives us and keeps only the endpoint and the two keys', () => {
    expect(parseSubscription({ ...good, expirationTime: null, extra: 'TEST-ignored' })).toEqual(good);
  });

  it.each<[string, unknown]>([
    ['nothing', undefined],
    ['a string', 'https://push.example.com/x'],
    ['no keys', { endpoint: good.endpoint }],
    ['plain http', { ...good, endpoint: 'http://push.example.com/send/TEST' }],
    ['not a URL', { ...good, endpoint: 'push.example.com/send' }],
    ['an IP address', { ...good, endpoint: 'https://203.0.113.9/send/TEST' }],
    ['an IPv6 address', { ...good, endpoint: 'https://[2001:db8::1]/send/TEST' }],
    ['localhost', { ...good, endpoint: 'https://localhost/send/TEST' }],
    ['an internal name', { ...good, endpoint: 'https://push.internal/send/TEST' }],
    ['a bare host name', { ...good, endpoint: 'https://pushserver/send/TEST' }],
    ['a custom port', { ...good, endpoint: 'https://push.example.com:8443/send/TEST' }],
    ['credentials in the URL', { ...good, endpoint: 'https://user:pw@push.example.com/send/TEST' }],
    ['an endpoint longer than 2048 characters', { ...good, endpoint: `https://push.example.com/${'a'.repeat(2048)}` }],
    ['a p256dh key of the wrong length', { ...good, keys: { ...good.keys, p256dh: randomBytes(32).toString('base64url') } }],
    ['a p256dh key that is not base64url', { ...good, keys: { ...good.keys, p256dh: `${good.keys.p256dh.slice(0, -2)}+/` } }],
    ['an auth secret that is too short', { ...good, keys: { ...good.keys, auth: randomBytes(8).toString('base64url') } }],
    ['keys that are not strings', { ...good, keys: { p256dh: 65, auth: 16 } }],
  ])('rejects %s', (_name, input) => {
    expect(parseSubscription(input)).toBeNull();
  });

  it('one alert becomes one notification: its own title and body, a tag, a TTL and an urgency', () => {
    const alert = alertRow();
    const message = pushMessage([alert], 'https://app.example.com');
    expect(JSON.parse(message.payload)).toEqual({
      title: alert.title, body: alert.body, tag: 'match:samgov:TEST-row', kind: 'match', url: 'https://app.example.com/',
      bidId: 'samgov:TEST-row', alertIds: [7],
    });
    expect(message).toMatchObject({ ttl: 24 * 3600, urgency: 'high' });
    expect(message.topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // Same alert → same topic, so a retry replaces the undelivered message instead of adding one.
    expect(pushMessage([alert], 'https://app.example.com').topic).toBe(message.topic);
    expect(pushMessage([alertRow({ dedupeKey: 'samgov:TEST-other' })], 'https://app.example.com').topic).not.toBe(message.topic);
  });

  it('a reminder expires fast, a price move is not urgent', () => {
    expect(pushMessage([alertRow({ kind: 'deadline' })], 'https://app.example.com')).toMatchObject({ ttl: 4 * 3600, urgency: 'high' });
    expect(pushMessage([alertRow({ kind: 'award' })], 'https://app.example.com')).toMatchObject({ ttl: 24 * 3600, urgency: 'normal' });
    expect(pushMessage([alertRow({ kind: 'price' })], 'https://app.example.com')).toMatchObject({ ttl: 24 * 3600, urgency: 'low' });
  });

  it('several alerts are summed up in one notification', () => {
    const alerts = [1, 2, 3, 4, 5].map((id) => alertRow({ id, dedupeKey: `samgov:TEST-${id}`, title: `Great fit (8${id}) · TEST place ${id}` }));
    const message = pushMessage(alerts, 'https://app.example.com');
    expect(JSON.parse(message.payload)).toEqual({
      title: '5 new bids fit',
      body: 'Great fit (81) · TEST place 1\nGreat fit (82) · TEST place 2\nGreat fit (83) · TEST place 3\n+2 more',
      tag: 'summary:5', kind: 'summary', url: 'https://app.example.com/', bidId: null, alertIds: [1, 2, 3, 4, 5],
    });
    const mixed = pushMessage([alertRow({ id: 1 }), alertRow({ id: 2, kind: 'deadline', title: 'Due today at 2:00 PM' })], 'https://app.example.com');
    expect(JSON.parse(mixed.payload)).toMatchObject({ title: '2 new alerts', body: 'Great fit (82) · Carson City, NV\nDue today at 2:00 PM' });
    // The shortest TTL and the highest urgency of what is inside.
    expect(mixed).toMatchObject({ ttl: 4 * 3600, urgency: 'high' });
  });

  it('whatever the text, the payload is valid JSON within the size limit', () => {
    const text = fc.string({ unit: 'grapheme', maxLength: 6000 });
    fc.assert(fc.property(text, text, fc.integer({ min: 1, max: 6 }), (title, body, count) => {
      const alerts = Array.from({ length: count }, (_, i) => alertRow({ id: i + 1, title, body, dedupeKey: `TEST-${i}` }));
      const message = pushMessage(alerts, 'https://app.example.com');
      expect(Buffer.byteLength(message.payload)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
      const payload = JSON.parse(message.payload) as PushPayload;
      expect(payload.alertIds).toEqual(alerts.map((a) => a.id));
      expect(payload.url).toBe('https://app.example.com/');
    }), { numRuns: 60 });
  });

  it('builds a real web-push request under the 4096-byte limit — VAPID-signed, encrypted, never sent', () => {
    const target = device('request');
    const message = pushMessage([alertRow({ body: '🔌'.repeat(5000) })], 'https://app.example.com');
    const request = buildPushRequest(testVapid, target, message);
    expect(request.method).toBe('POST');
    expect(request.endpoint).toBe(target.endpoint);
    expect(request.headers).toMatchObject({ TTL: 24 * 3600, Urgency: 'high', Topic: message.topic, 'Content-Encoding': 'aes128gcm' });
    expect(request.headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(request.body!.length).toBeLessThanOrEqual(4096);
    // Encrypted: the notification text is not readable in the request.
    expect(request.body!.includes(Buffer.from('Great fit'))).toBe(false);
  });

  it('push is on only with usable VAPID keys, and says why when it is off — without printing a key', () => {
    const log: string[] = [];
    expect(usableVapid(loadConfig({}), (m) => log.push(m))).toBeNull();
    expect(log).toEqual([]);

    const ok = { ...loadConfig({}), vapid: testVapid };
    expect(usableVapid(ok, (m) => log.push(m))).toEqual(testVapid);
    expect(log).toEqual([]);

    // The default subject falls back to APP_URL; a plain-http one cannot sign a push.
    const fromEnv = loadConfig({ VAPID_PUBLIC_KEY: testVapid.publicKey, VAPID_PRIVATE_KEY: testVapid.privateKey });
    expect(fromEnv.vapid?.subject).toBe('http://localhost:8787');
    expect(usableVapid(fromEnv, (m) => log.push(m))).toBeNull();
    expect(usableVapid(fromEnv, (m) => log.push(m))).toBeNull(); // checked once, logged once
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^push is off: .*https: or mailto:/);

    const shortKey = { ...loadConfig({}), vapid: { ...testVapid, privateKey: testVapid.privateKey.slice(0, 20) } };
    expect(usableVapid(shortKey, (m) => log.push(m))).toBeNull();
    for (const line of log) {
      expect(line).not.toContain(testVapid.privateKey);
      expect(line).not.toContain(testVapid.privateKey.slice(0, 20));
    }
  });

  it.each<[string, unknown, PushResult]>([
    ['410 Gone', new WebPushError('Received unexpected response code', 410, {}, '', 'https://push.example.com/x'), { ok: false, gone: true, status: 410 }],
    ['404 Not Found', new WebPushError('Received unexpected response code', 404, {}, '', 'https://push.example.com/x'), { ok: false, gone: true, status: 404 }],
    ['500 from the push service', new WebPushError('Received unexpected response code', 500, {}, '', 'https://push.example.com/x'), { ok: false, gone: false, status: 500 }],
    ['429 Too Many Requests', new WebPushError('Received unexpected response code', 429, {}, '', 'https://push.example.com/x'), { ok: false, gone: false, status: 429 }],
    ['a network error', new Error('Socket timeout'), { ok: false, gone: false, status: null }],
    ['something that is not an error', 'TEST-oops', { ok: false, gone: false, status: null }],
  ])('a failed send (%s) maps to what to do about it', (_name, err, result) => {
    expect(toPushResult(err)).toEqual(result);
  });

  it('the real sender reports a failed send instead of throwing', async () => {
    // Pointed at a loopback port nothing listens on: the connection is refused at once, nothing leaves the machine.
    const target = { ...device('loopback'), endpoint: 'https://127.0.0.1:1/TEST-nothing-listens-here' };
    const result = await createWebPushSender(testVapid)(target, pushMessage([alertRow()], 'https://app.example.com'));
    expect(result).toEqual({ ok: false, gone: false, status: null });
  });
});

// ------------------------------------------------------------- stream hub --

/** Just enough of a ServerResponse for the hub: it records what was written and can "disconnect". */
function fakeResponse() {
  const written: string[] = [];
  const on = new Map<string, () => void>();
  const res = {
    destroyed: false, writableEnded: false, writableLength: 0, socket: null, status: 0, headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) {
      Object.assign(res, { status, headers });
    },
    write(chunk: string) {
      written.push(chunk);
      return true;
    },
    on(event: string, listener: () => void) {
      on.set(event, listener);
    },
    end() {
      res.writableEnded = true;
      on.get('close')?.();
    },
    destroy() {
      res.destroyed = true;
      on.get('close')?.();
    },
  };
  return { res, written, asResponse: res as unknown as ServerResponse };
}

describe('stream hub', () => {
  const who = { profileId: 'test-hub', owner: 'TEST-acct-hub' };
  const ids = (written: string[]) => written.slice(1).map((frame) => /^event: (\w+)\nid: (\d+)\n/.exec(frame)?.slice(1, 3).join('#'));

  it('frames an event on one data line, whatever the text', () => {
    expect(sseFrame('match', 42, { title: 'TEST line one\nline two', n: 1 })).toBe('event: match\nid: 42\ndata: {"title":"TEST line one\\nline two","n":1}\n\n');
  });

  it('replays what was missed, then what arrived during the replay — in order and never twice', () => {
    const hub = createStreamHub({ now: () => NOW });
    const c = fakeResponse();
    const client = hub.open(c.asResponse, who);
    expect(c.res.status).toBe(200);
    expect(c.res.headers).toMatchObject({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' });
    expect(c.written).toEqual([': connected\nretry: 5000\n\n']);

    // While the route is still reading the inbox, two alerts are stored; the replay query already saw the first.
    hub.alert(who.profileId, alertRow({ id: 12 }));
    hub.alert(who.profileId, alertRow({ id: 13, kind: 'deadline' }));
    hub.alert('test-someone-else', alertRow({ id: 14 }));
    hub.scan({ startedAt: '', finishedAt: '', sources: {}, totalBids: 0, newBids: 0, profiles: {} }); // not while replaying
    expect(c.written).toHaveLength(1);

    hub.start(client, 10, [alertRow({ id: 11 }), alertRow({ id: 12 })]);
    hub.alert(who.profileId, alertRow({ id: 15, kind: 'price' }));
    expect(ids(c.written)).toEqual(['match#11', 'match#12', 'deadline#13', 'price#15']);
    hub.close();
  });

  it('counts connections per owner, forgets one that disconnects, and drops a client that stops reading', () => {
    const hub = createStreamHub({ now: () => NOW });
    const [a, b, other] = [fakeResponse(), fakeResponse(), fakeResponse()];
    for (const c of [a, b]) hub.start(hub.open(c.asResponse, who), 0, []);
    hub.start(hub.open(other.asResponse, { profileId: 'test-hub-2', owner: 'TEST-acct-other' }), 0, []);
    expect([hub.count(who.owner), hub.count('TEST-acct-other'), hub.count('TEST-acct-nobody')]).toEqual([2, 1, 0]);

    a.res.destroy(); // the browser tab closes
    expect(hub.count(who.owner)).toBe(1);
    hub.alert(who.profileId, alertRow({ id: 21 }));
    expect([a.written.length, b.written.length, other.written.length]).toEqual([1, 2, 1]);

    b.res.writableLength = 2_000_000; // nothing has been read for a long time
    hub.alert(who.profileId, alertRow({ id: 22 }));
    expect(b.res.destroyed).toBe(true);
    expect(hub.count(who.owner)).toBe(0);

    hub.close();
    expect(other.res.writableEnded).toBe(true);
    expect(hub.count('TEST-acct-other')).toBe(0);
  });
});

// --------------------------------------------------------------- database --

let db: Db;
beforeAll(async () => {
  db = await memoryDb();
});
afterAll(async () => db.close());

/** A simulated signed-up business with its stored profile and registered devices. */
async function member(opts: { plan?: Plan; alerts?: AlertSettings; devices?: number } = {}) {
  const account = await seedAccount(db, { plan: opts.plan ?? 'pro' });
  const profile = await saveProfileForAccount(db, account.id, testProfile(profileIdFor(account.id), opts.alerts ? { alerts: opts.alerts } : {}));
  const devices: StoredSubscription[] = [];
  for (let i = 0; i < (opts.devices ?? 1); i++) {
    devices.push(device(`${account.id}-${i}`));
    await saveSubscription(db, account.id, devices[i]!, NOW);
  }
  return { account, profile, devices };
}

const draft = (key: string, over: Partial<NewAlert> = {}): NewAlert => ({
  kind: 'match', bidId: key, dedupeKey: key, title: `TEST alert ${key}`, body: 'TEST body (synthetic)', data: { bidId: key, score: 80, url: 'https://example.com/test-bid' },
  ...over,
});

describe('alerts table: inbox, de-duplication and push state', () => {
  beforeEach(async () => resetDb(db));

  it('stores an alert once per profile, kind and key', async () => {
    const { profile } = await member();
    const { profile: other } = await member();

    const first = await insertAlert(db, profile.id, draft('samgov:TEST-a'), { now: NOW });
    expect(first).toMatchObject({
      profileId: profile.id, kind: 'match', bidId: 'samgov:TEST-a', dedupeKey: 'samgov:TEST-a', title: 'TEST alert samgov:TEST-a',
      createdAt: NOW.toISOString(), pushedAt: null, readAt: null,
    });
    expect(typeof first!.id).toBe('number');
    // The same key again, even with new wording: nothing is stored and the caller is told so.
    expect(await insertAlert(db, profile.id, draft('samgov:TEST-a', { title: 'TEST reworded' }), { now: NOW })).toBeNull();
    expect((await listAlerts(db, profile.id)).map((a) => a.title)).toEqual(['TEST alert samgov:TEST-a']);
    // Another kind, or another profile, is a different alert.
    expect(await insertAlert(db, profile.id, draft('samgov:TEST-a', { kind: 'deadline' }), { now: NOW })).not.toBeNull();
    expect(await insertAlert(db, other.id, draft('samgov:TEST-a'), { now: NOW })).not.toBeNull();
    expect(await listAlerts(db, profile.id)).toHaveLength(2);
    expect(await listAlerts(db, other.id)).toHaveLength(1);
  });

  it('lists newest first with an unread filter, a limit and paging; marks read only its own', async () => {
    const { profile } = await member();
    const { profile: other } = await member();
    const mine = [];
    for (const key of ['a', 'b', 'c', 'd']) mine.push((await insertAlert(db, profile.id, draft(`samgov:TEST-${key}`), { now: NOW }))!);
    const theirs = (await insertAlert(db, other.id, draft('samgov:TEST-z'), { now: NOW }))!;
    const ids = mine.map((a) => a.id);

    expect((await listAlerts(db, profile.id)).map((a) => a.id)).toEqual([...ids].reverse());
    expect((await listAlerts(db, profile.id, { limit: 2 })).map((a) => a.id)).toEqual([ids[3], ids[2]]);
    expect((await listAlerts(db, profile.id, { before: ids[2] })).map((a) => a.id)).toEqual([ids[1], ids[0]]);
    expect(await countUnread(db, profile.id)).toBe(4);
    expect(await latestAlertId(db, profile.id)).toBe(ids[3]);
    expect(await latestAlertId(db, 'test-nobody')).toBe(0);

    const later = new Date(NOW.getTime() + HOUR);
    expect(await markAlertsRead(db, profile.id, [ids[0]!, ids[1]!, theirs.id], later)).toBe(2);
    expect(await markAlertsRead(db, profile.id, [ids[0]!], later)).toBe(0); // already read
    expect((await listAlerts(db, profile.id, { unread: true })).map((a) => a.id)).toEqual([ids[3], ids[2]]);
    expect((await listAlerts(db, profile.id)).find((a) => a.id === ids[0])?.readAt).toBe(later.toISOString());
    expect(await countUnread(db, other.id)).toBe(1);
    expect(await markAlertsRead(db, profile.id, 'all', later)).toBe(2);
    expect(await countUnread(db, profile.id)).toBe(0);
    expect(await countUnread(db, other.id)).toBe(1);

    // What a reconnecting stream missed: after an id, oldest first, capped to the newest few.
    expect((await alertsAfter(db, profile.id, ids[1]!)).map((a) => a.id)).toEqual([ids[2], ids[3]]);
    expect((await alertsAfter(db, profile.id, 0, 2)).map((a) => a.id)).toEqual([ids[2], ids[3]]);
    expect(await alertsAfter(db, profile.id, ids[3]!)).toEqual([]);
  });

  it('a waiting push can be claimed exactly once; the bookkeeping never shows in the alert', async () => {
    const { profile } = await member();
    const wanted = (await insertAlert(db, profile.id, draft('samgov:TEST-a'), { push: true, now: NOW }))!;
    const inboxOnly = (await insertAlert(db, profile.id, draft('samgov:TEST-b'), { now: NOW }))!;
    const readAlready = (await insertAlert(db, profile.id, draft('samgov:TEST-c'), { push: true, now: NOW }))!;
    const stale = (await insertAlert(db, profile.id, draft('samgov:TEST-d'), { push: true, now: new Date(NOW.getTime() - 25 * HOUR) }))!;
    await markAlertsRead(db, profile.id, [readAlready.id], NOW);

    expect(wanted.data).toEqual({ bidId: 'samgov:TEST-a', score: 80, url: 'https://example.com/test-bid' });
    expect(JSON.stringify(await listAlerts(db, profile.id))).not.toContain('_push');

    const since = new Date(NOW.getTime() - 24 * HOUR);
    expect(await profilesWithWaitingPush(db, since)).toEqual([profile.id]);
    const [a, b] = await Promise.all([claimWaitingPushes(db, profile.id, since, NOW), claimWaitingPushes(db, profile.id, since, NOW)]);
    expect([...a, ...b].map((x) => x.id)).toEqual([wanted.id]); // not the inbox-only, read or stale ones, and only once
    expect(await profilesWithWaitingPush(db, since)).toEqual([]);
    expect((await listAlerts(db, profile.id)).find((x) => x.id === wanted.id)?.pushedAt).toBe(NOW.toISOString());

    await releasePushClaim(db, [wanted.id]);
    expect((await claimWaitingPushes(db, profile.id, since, NOW)).map((x) => x.id)).toEqual([wanted.id]);
    expect([inboxOnly.id, stale.id].every((id) => id !== wanted.id)).toBe(true);
  });
});

describe('push_subscriptions table', () => {
  beforeEach(async () => resetDb(db));

  it('registers, lists and unregisters devices per account; an endpoint follows whoever signs in on it', async () => {
    const alice = await seedAccount(db);
    const bob = await seedAccount(db);
    const [phone, laptop] = [device('phone'), device('laptop')];
    await saveSubscription(db, alice.id, phone, NOW);
    await saveSubscription(db, alice.id, laptop, new Date(NOW.getTime() + 1000));
    await saveSubscription(db, alice.id, phone, NOW); // registering again changes nothing
    expect(await listSubscriptions(db, alice.id)).toEqual([phone, laptop]);
    expect(await listSubscriptions(db, bob.id)).toEqual([]);

    expect(await deleteSubscription(db, bob.id, phone.endpoint)).toBe(false); // not his
    expect(await listSubscriptions(db, alice.id)).toHaveLength(2);

    const rekeyed = { ...phone, keys: device('rekeyed').keys };
    await saveSubscription(db, bob.id, rekeyed, NOW); // bob signs in on that phone
    expect(await listSubscriptions(db, bob.id)).toEqual([rekeyed]);
    expect(await listSubscriptions(db, alice.id)).toEqual([laptop]);
    expect(await deleteSubscription(db, bob.id, phone.endpoint)).toBe(true);
    expect(await listSubscriptions(db, bob.id)).toEqual([]);
  });

  it(`keeps at most ${MAX_DEVICES} devices per account, dropping the one silent longest`, async () => {
    const alice = await seedAccount(db);
    const devices = Array.from({ length: MAX_DEVICES + 2 }, (_, i) => device(`cap-${i}`));
    for (const [i, d] of devices.entries()) await saveSubscription(db, alice.id, d, new Date(NOW.getTime() + i * 1000));
    const kept = (await listSubscriptions(db, alice.id)).map((d) => d.endpoint);
    expect(kept).toEqual(devices.slice(2).map((d) => d.endpoint));
  });

  it('records how sends went and deletes a subscription the push service says is gone', async () => {
    const alice = await seedAccount(db);
    const [phone, laptop] = [device('phone'), device('laptop')];
    await saveSubscription(db, alice.id, phone, NOW);
    await saveSubscription(db, alice.id, laptop, NOW);
    const row = async (endpoint: string) =>
      (await db.query<{ fail_count: number; last_ok_at: Date | string | null }>('select fail_count, last_ok_at from push_subscriptions where endpoint = $1', [endpoint]))[0];

    await recordPushResult(db, phone.endpoint, 'failed', NOW);
    await recordPushResult(db, phone.endpoint, 'failed', NOW);
    expect(await row(phone.endpoint)).toMatchObject({ fail_count: 2, last_ok_at: null });
    await recordPushResult(db, phone.endpoint, 'ok', NOW);
    const ok = await row(phone.endpoint);
    expect(ok?.fail_count).toBe(0);
    expect(new Date(ok!.last_ok_at!).toISOString()).toBe(NOW.toISOString());

    await recordPushResult(db, laptop.endpoint, 'gone', NOW);
    expect(await row(laptop.endpoint)).toBeUndefined();
    expect(await listSubscriptions(db, alice.id)).toEqual([phone]);
  });

  it('finds a profile\'s devices through its account, or through the single-mode owner', async () => {
    const { account, profile, devices } = await member({ devices: 2 });
    expect(await subscriptionsForProfile(db, profile.id)).toEqual(devices);
    expect(await getAlertTarget(db, profile.id)).toEqual({ profile, account });
    expect(await getAlertTarget(db, 'test-nobody')).toBeNull();

    // Single mode: a config profile with no account. Its devices hang off a system account.
    const pilot = testProfile('test-pilot');
    await upsertProfile(db, pilot);
    expect(await getAlertTarget(db, pilot.id)).toEqual({ profile: pilot, account: null });
    expect(await subscriptionsForProfile(db, pilot.id)).toEqual([]);
    const owner = await ensureSingleOwner(db, pilot);
    expect(await ensureSingleOwner(db, pilot)).toBe(owner); // idempotent
    expect(owner).toBe(singleOwnerId(pilot.id));
    const shopPhone = device('shop');
    await saveSubscription(db, owner, shopPhone, NOW);
    expect(await subscriptionsForProfile(db, pilot.id)).toEqual([shopPhone]);

    // Nobody can sign in as the system account, and the config profile is still not account-owned.
    const [system] = await db.query<{ email: string; password_hash: string | null; plan: string }>('select email, password_hash, plan from accounts where id = $1', [owner]);
    expect(system).toEqual({ email: 'test-pilot@single-mode.invalid', password_hash: null, plan: 'free' });
    expect(await db.query('select 1 from identities where account_id = $1', [owner])).toEqual([]);
    expect((await db.query<{ account_id: string | null }>('select account_id from profiles where id = $1', [pilot.id]))[0]?.account_id).toBeNull();
  });
});

// ------------------------------------------------- bus → inbox → push --

interface Sent { endpoint: string; message: PushMessage; payload: PushPayload }

/** A push service that never leaves the process. Answers 'ok' unless told otherwise per endpoint. */
function fakePush() {
  const sent: Sent[] = [];
  const answers = new Map<string, PushResult | Error>();
  const sender: PushSender = async (target, message) => {
    sent.push({ endpoint: target.endpoint, message, payload: JSON.parse(message.payload) as PushPayload });
    const answer = answers.get(target.endpoint) ?? { ok: true };
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { sent, answers, sender };
}

let clock = NOW;
const running: Realtime[] = [];

/** The realtime module on its own bus with a fake clock and a fake push service; ticks only when told. */
function engine(opts: { config?: AppConfig; profile?: Profile; coalesceMs?: number } = {}) {
  const errors: unknown[] = [];
  const logs: string[] = [];
  const announced: Alert[] = [];
  const bus = createBus((err) => void errors.push(err));
  bus.on('alert', (e) => void announced.push(e.alert));
  const push = fakePush();
  const ctx = createContext({
    db, config: opts.config ?? accountsConfig(), profile: opts.profile, bus, auth: fakeAuth(null), now: () => clock, log: (m) => void logs.push(m),
  });
  const rt = createRealtime(ctx, { sender: push.sender, tickMs: 0, coalesceMs: opts.coalesceMs ?? 0 });
  running.push(rt);
  return { bus, ctx, rt, push, errors, logs, announced };
}

describe('realtime: from a bus event to the inbox and the phone', () => {
  beforeEach(async () => {
    clock = NOW;
    await resetDb(db);
  });
  afterEach(() => {
    for (const rt of running.splice(0)) rt.stop();
  });

  it('a match is stored, announced and pushed once — the same match again does nothing', async () => {
    const { profile, devices } = await member();
    const e = engine();
    const event = matchEvent(profile.id);

    await e.bus.emit(event);
    await e.bus.emit(event); // the next scan sees the same bid
    await e.bus.emit({ ...event, score: fit({ score: 91 }) }); // …even with a better score
    await e.rt.flush();

    const inbox = await listAlerts(db, profile.id);
    expect(inbox).toHaveLength(1);
    const alert = inbox[0]!;
    expect(alert).toMatchObject({
      kind: 'match', bidId: event.bid.id, dedupeKey: event.bid.id, title: 'Great fit (82) · Carson City, NV',
      body: 'TEST electrical panel upgrade (synthetic) — Electrical scope: “panel” · 21 days left',
      createdAt: NOW.toISOString(), pushedAt: NOW.toISOString(), readAt: null,
    });
    expect(alert.data).toEqual({ bidId: event.bid.id, score: 82, url: 'https://example.com/test-bid' });
    expect(e.announced).toEqual([{ ...alert, pushedAt: null }]); // streamed at once, before the push went out

    expect(e.push.sent).toHaveLength(1);
    expect(e.push.sent[0]).toMatchObject({
      endpoint: devices[0]!.endpoint,
      message: { ttl: 24 * 3600, urgency: 'high' },
      payload: {
        title: alert.title, body: alert.body, tag: `match:${event.bid.id}`, kind: 'match', url: 'http://localhost:8787/',
        bidId: event.bid.id, alertIds: [alert.id],
      },
    });

    // Later ticks have nothing left to send.
    await e.rt.tick();
    await e.rt.flush();
    expect(e.push.sent).toHaveLength(1);
    expect(e.errors).toEqual([]);
  });

  it.each<[Plan, boolean, number]>([
    ['free', false, 0],
    ['pro', false, 1],
    ['pilot', false, 1],
    ['free', true, 1], // DEMO_MODE: every account is treated as pilot
  ])('plan %s (demo mode %s): the alert is always in the inbox, pushes sent: %i', async (plan, demoMode, pushes) => {
    const { profile } = await member({ plan });
    const e = engine({ config: accountsConfig({ demoMode }) });
    await e.bus.emit(matchEvent(profile.id));
    await e.rt.flush();
    await e.rt.tick();
    expect(await listAlerts(db, profile.id)).toHaveLength(1);
    expect(e.announced).toHaveLength(1);
    expect(e.push.sent).toHaveLength(pushes);
  });

  it('inbox only: a bid that was already on the boards, phone alerts off, or a rule that says no alert', async () => {
    const quiet = await member({ alerts: { push: false } });
    const loud = await member();
    const picky = await member({ alerts: { minScore: 90 } });
    const e = engine();

    await e.bus.emit(matchEvent(loud.profile.id, { isNewBid: false })); // first scoring after onboarding
    await e.bus.emit(matchEvent(quiet.profile.id));
    await e.bus.emit(matchEvent(picky.profile.id)); // 82 < 90
    await e.bus.emit(matchEvent(loud.profile.id, { score: fit({ overLimit: true }) }));
    await e.bus.emit(matchEvent('test-no-such-profile'));
    await e.rt.flush();
    await e.rt.tick();

    expect(await listAlerts(db, loud.profile.id)).toHaveLength(1);
    expect(await listAlerts(db, quiet.profile.id)).toHaveLength(1);
    expect(await listAlerts(db, picky.profile.id)).toHaveLength(0);
    expect(e.push.sent).toEqual([]);
    expect(e.errors).toEqual([]);
  });

  it('quiet hours hold the push, not the alert; the first tick after they end sends one summary', async () => {
    const { profile, devices } = await member({ alerts: { quietHours: { start: '21:00', end: '06:00' } } });
    const e = engine();
    clock = at('2026-11-12T06:30:00Z'); // 22:30 Pacific

    for (let i = 0; i < 3; i++) await e.bus.emit(matchEvent(profile.id, { score: fit({ score: 80 + i }) }));
    await e.rt.flush();
    const held = await listAlerts(db, profile.id);
    expect(held).toHaveLength(3);
    expect(e.announced).toHaveLength(3); // stored and streamed as usual
    expect(held.every((a) => a.pushedAt === null)).toBe(true);
    expect(e.push.sent).toEqual([]);

    clock = at('2026-11-12T13:45:00Z'); // 05:45 — still quiet
    await e.rt.tick();
    expect(e.push.sent).toEqual([]);

    // The owner opens the app early and reads one of them: no need to buzz about that one.
    const [newest, middle, oldest] = held as [Alert, Alert, Alert];
    await markAlertsRead(db, profile.id, [middle.id], clock);

    clock = at('2026-11-12T14:00:00Z'); // 06:00 — quiet hours are over
    await e.rt.tick();
    expect(e.push.sent).toHaveLength(1);
    expect(e.push.sent[0]).toMatchObject({
      endpoint: devices[0]!.endpoint,
      payload: { title: '2 new bids fit', kind: 'summary', bidId: null, alertIds: [oldest.id, newest.id], body: `${oldest.title}\n${newest.title}` },
    });
    const after = await listAlerts(db, profile.id);
    expect(after.map((a) => a.pushedAt)).toEqual([clock.toISOString(), null, clock.toISOString()]);

    await e.rt.tick();
    await e.rt.flush();
    expect(e.push.sent).toHaveLength(1);
  });

  it('quiet hours are read on each profile\'s own clock', async () => {
    const window = { start: '21:00', end: '06:00' };
    const west = await member({ alerts: { quietHours: window } });
    const east = await member({ alerts: { quietHours: window, timeZone: 'America/New_York' } });
    const e = engine();
    clock = at('2026-11-12T03:00:00Z'); // 19:00 in Pacific, 22:00 in New York

    await e.bus.emit(matchEvent(west.profile.id));
    await e.bus.emit(matchEvent(east.profile.id));
    await e.rt.flush();
    expect(e.push.sent.map((s) => s.endpoint)).toEqual([west.devices[0]!.endpoint]);

    clock = at('2026-11-12T11:00:00Z'); // 06:00 in New York, 03:00 in Pacific
    await e.rt.tick();
    expect(e.push.sent.map((s) => s.endpoint)).toEqual([west.devices[0]!.endpoint, east.devices[0]!.endpoint]);
  });

  it('a held push that nobody could receive for 24 hours is dropped; the alert stays in the inbox', async () => {
    const { account, profile } = await member({ devices: 0 });
    const late = await member({ devices: 0 });
    const e = engine();
    await e.bus.emit(matchEvent(profile.id));
    await e.bus.emit(matchEvent(late.profile.id));
    await e.rt.flush();
    expect(e.push.sent).toEqual([]);

    // A device is registered two hours later: the next tick delivers what was waiting.
    clock = new Date(NOW.getTime() + 2 * HOUR);
    const phone = device('late-phone');
    await saveSubscription(db, account.id, phone, clock);
    await e.rt.tick();
    expect(e.push.sent.map((s) => s.endpoint)).toEqual([phone.endpoint]);

    // The other account only gets a device a day later: too old to buzz about.
    clock = new Date(NOW.getTime() + 25 * HOUR);
    await saveSubscription(db, late.account.id, device('too-late'), clock);
    await e.rt.tick();
    expect(e.push.sent).toHaveLength(1);
    expect(await listAlerts(db, late.profile.id)).toHaveLength(1);
  });

  it.each([410, 404])('a %i from the push service removes that subscription; the other device still gets the push', async (status) => {
    const { account, profile, devices } = await member({ devices: 2 });
    const [dead, alive] = devices as [StoredSubscription, StoredSubscription];
    const e = engine();
    e.push.answers.set(dead.endpoint, { ok: false, gone: true, status });

    await e.bus.emit(matchEvent(profile.id));
    await e.rt.flush();

    expect(e.push.sent.map((s) => s.endpoint).sort()).toEqual([dead.endpoint, alive.endpoint].sort());
    expect(await listSubscriptions(db, account.id)).toEqual([alive]);
    expect((await listAlerts(db, profile.id))[0]?.pushedAt).toBe(NOW.toISOString());
    const line = e.logs.find((l) => l.startsWith('push:'));
    expect(line).toBe(`push: 1 alert(s) for ${profile.id}, 1 of 2 device(s) accepted, 1 expired and removed`);
    // Endpoints and keys are capabilities: they never reach a log line.
    for (const secret of [...devices.flatMap((d) => [d.endpoint, d.keys.p256dh, d.keys.auth]), 'TEST-device']) {
      expect(e.logs.join('\n')).not.toContain(secret);
    }
  });

  it('when no device accepts the push it is tried again on the next tick, and sent once', async () => {
    const { profile, devices } = await member();
    const endpoint = devices[0]!.endpoint;
    const e = engine();
    const failCount = async () => (await db.query<{ fail_count: number }>('select fail_count from push_subscriptions where endpoint = $1', [endpoint]))[0]?.fail_count;

    e.push.answers.set(endpoint, { ok: false, gone: false, status: 500 });
    await e.bus.emit(matchEvent(profile.id));
    await e.rt.flush();
    expect(e.push.sent).toHaveLength(1);
    expect((await listAlerts(db, profile.id))[0]?.pushedAt).toBeNull();
    expect(await failCount()).toBe(1);

    e.push.answers.set(endpoint, new Error('TEST socket timeout')); // a sender that throws counts as a failure too
    await e.rt.tick();
    expect(e.push.sent).toHaveLength(2);
    expect((await listAlerts(db, profile.id))[0]?.pushedAt).toBeNull();
    expect(await failCount()).toBe(2);

    e.push.answers.delete(endpoint);
    clock = new Date(NOW.getTime() + 15 * 60_000);
    await e.rt.tick();
    expect(e.push.sent).toHaveLength(3);
    expect((await listAlerts(db, profile.id))[0]?.pushedAt).toBe(clock.toISOString());
    expect(await failCount()).toBe(0);

    await e.rt.tick();
    expect(e.push.sent).toHaveLength(3);
    expect(e.errors).toEqual([]);
  });

  it('alerts that land together share one notification', async () => {
    const { profile } = await member();
    const e = engine({ coalesceMs: 60_000 }); // a window wide enough that the test, not the timer, decides when it closes
    for (let i = 0; i < 3; i++) await e.bus.emit(matchEvent(profile.id));
    expect(e.push.sent).toEqual([]); // nothing goes out inside the bus listener

    await e.rt.flush();
    expect(e.push.sent).toHaveLength(1);
    expect(e.push.sent[0]?.payload).toMatchObject({ title: '3 new bids fit', kind: 'summary' });
    expect(e.push.sent[0]?.payload.alertIds).toEqual((await listAlerts(db, profile.id)).map((a) => a.id).reverse());
    await e.rt.flush();
    await e.rt.tick();
    expect(e.push.sent).toHaveLength(1);
  });

  it('the push goes out by itself when the window closes, without holding up the bus', async () => {
    const { profile } = await member();
    const e = engine({ coalesceMs: 25 });
    await e.bus.emit(matchEvent(profile.id));
    expect(e.push.sent).toEqual([]);
    await expect.poll(() => e.push.sent.length, { timeout: 3000, interval: 10 }).toBe(1);
    await expect.poll(async () => (await listAlerts(db, profile.id))[0]?.pushedAt, { timeout: 3000, interval: 10 }).toBe(NOW.toISOString());
  });

  it('award notices: stored, announced and pushed for Pro; nothing for the free plan', async () => {
    const pro = await member();
    const free = await member({ plan: 'free' });
    const e = engine();
    const bid = testBid();
    await upsertBids(db, [bid], NOW);

    await e.bus.emit({ type: 'award', profileId: pro.profile.id, award: award(), bidId: bid.id });
    await e.bus.emit({ type: 'award', profileId: pro.profile.id, award: award(), bidId: bid.id }); // emitted again
    await e.bus.emit({ type: 'award', profileId: free.profile.id, award: award(), bidId: bid.id });
    await e.rt.flush();

    const inbox = await listAlerts(db, pro.profile.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      kind: 'award', bidId: bid.id, dedupeKey: 'TEST:award-1', title: 'Award posted: TEST electrical panel upgrade (synthetic)',
      body: 'Awarded to TEST Contractor LLC (simulated) for $48,200 on 2026-10-30 · source: TEST source',
    });
    expect(await listAlerts(db, free.profile.id)).toEqual([]);
    expect(e.push.sent).toHaveLength(1);
    expect(e.push.sent[0]).toMatchObject({ endpoint: pro.devices[0]!.endpoint, message: { urgency: 'normal' }, payload: { kind: 'award' } });
    expect(e.errors).toEqual([]);
  });

  it('a price move alerts every profile that wants it, once per series and period, with the source', async () => {
    const wants = await member();
    const off = await member({ alerts: { kinds: { price: false } } });
    const free = await member({ plan: 'free' });
    await db.query(
      `insert into market_series_meta (series_id, kind, title, source, source_url) values ($1, 'ppi', $2, $3, $4)`,
      ['TEST-SERIES-1', 'TEST copper wire index (synthetic)', 'TEST source', 'https://example.com/test-series'],
    );
    const e = engine();
    const price = (period: string, seriesId = 'TEST-SERIES-1'): BusEventOf<'price'> => ({ type: 'price', seriesId, changePct: 8.24, period });

    await e.bus.emit(price('2026-10'));
    await e.bus.emit(price('2026-10')); // the watcher runs again
    await e.bus.emit(price('2026-10', 'TEST-SERIES-UNKNOWN')); // no title or source on record: say nothing
    await e.rt.flush();

    const inbox = await listAlerts(db, wants.profile.id);
    expect(inbox.map((a) => [a.kind, a.title, a.body])).toEqual([
      ['price', 'TEST copper wire index (synthetic) up 8.2%', 'Period 2026-10 · source: TEST source. Re-check open quotes.'],
    ]);
    expect(await listAlerts(db, off.profile.id)).toEqual([]);
    expect(await listAlerts(db, free.profile.id)).toEqual([]);
    expect(e.push.sent.map((s) => s.endpoint)).toEqual([wants.devices[0]!.endpoint]);
    expect(e.logs).toContain('realtime: no alert for series TEST-SERIES-UNKNOWN: it has no title and source on record');

    await e.bus.emit(price('2026-11'));
    expect(await listAlerts(db, wants.profile.id)).toHaveLength(2);
    expect(e.errors).toEqual([]);
  });

  it('single mode (the pilot): a device registered through the API gets the push, with no sign-in', async () => {
    const pilot = testProfile('test-pilot');
    await upsertProfile(db, pilot); // the scan does this before it scores
    const config: AppConfig = { ...loadConfig({}), vapid: testVapid };
    const e = engine({ config, profile: pilot });
    const app = Fastify();
    await realtimeRoutes(app, e.ctx);
    const phone = device('pilot-phone');

    expect((await app.inject('/api/push/key')).json()).toEqual({ publicKey: testVapid.publicKey });
    const res = await app.inject({ method: 'POST', url: '/api/push/subscribe', payload: { subscription: phone } });
    expect([res.statusCode, res.json()]).toEqual([200, { ok: true, instantPush: true }]);

    await e.bus.emit(matchEvent(pilot.id));
    await e.rt.flush();
    expect(e.push.sent.map((s) => s.endpoint)).toEqual([phone.endpoint]);
    expect((await app.inject('/api/alerts')).json()).toMatchObject({ unread: 1, items: [{ kind: 'match', title: 'Great fit (82) · Carson City, NV' }] });

    const gone = await app.inject({ method: 'DELETE', url: '/api/push/subscribe', payload: { endpoint: phone.endpoint } });
    expect(gone.json()).toEqual({ ok: true });
    expect(await subscriptionsForProfile(db, pilot.id)).toEqual([]);
    await app.close();
  });

  it('stops: after stop() the bus is no longer listened to, and stopping twice is fine', async () => {
    const { profile } = await member();
    const e = engine();
    e.rt.stop();
    e.rt.stop();
    await e.bus.emit(matchEvent(profile.id));
    await e.rt.tick();
    await e.rt.flush();
    expect(await listAlerts(db, profile.id)).toEqual([]);
    expect(e.push.sent).toEqual([]);

    // startRealtime is the same thing, returning only the stop function (what main() uses).
    const bus = createBus();
    const stop = startRealtime(createContext({ db, config: accountsConfig(), bus, auth: fakeAuth(null), now: () => clock }), { tickMs: 0 });
    await bus.emit(matchEvent(profile.id));
    expect(await listAlerts(db, profile.id)).toHaveLength(1);
    stop();
    await bus.emit(matchEvent(profile.id));
    expect(await listAlerts(db, profile.id)).toHaveLength(1);
  });

  it('whatever order matches arrive in, every bid is alerted at most once and no alert is pushed twice', async () => {
    const step = fc.record({ bid: fc.integer({ min: 0, max: 4 }), score: fc.integer({ min: 40, max: 95 }), isNewBid: fc.boolean(), tick: fc.boolean() });
    await fc.assert(fc.asyncProperty(fc.array(step, { maxLength: 14 }), async (steps) => {
      await resetDb(db);
      const { profile } = await member(); // threshold 55, pro, one device
      const e = engine();
      const bids = Array.from({ length: 5 }, () => testBid());
      const first = new Map<string, boolean>(); // bid → did its first qualifying sighting want a push?
      for (const s of steps) {
        const bid = bids[s.bid]!;
        await e.bus.emit(matchEvent(profile.id, { bid, score: fit({ score: s.score }), isNewBid: s.isNewBid }));
        if (s.score >= 55 && !first.has(bid.id)) first.set(bid.id, s.isNewBid);
        if (s.tick) await e.rt.tick();
      }
      await e.rt.flush();
      await e.rt.tick();
      e.rt.stop();

      const inbox = await listAlerts(db, profile.id);
      expect(inbox.map((a) => a.bidId).sort()).toEqual([...first.keys()].sort());
      expect(e.announced.map((a) => a.id).sort()).toEqual(inbox.map((a) => a.id).sort());
      const pushed = e.push.sent.flatMap((s) => s.payload.alertIds);
      expect(new Set(pushed).size).toBe(pushed.length);
      expect([...pushed].sort()).toEqual(inbox.filter((a) => first.get(a.bidId!)).map((a) => a.id).sort());
      expect(e.errors).toEqual([]);
    }), { numRuns: 20 });
  });
});

// -------------------------------------------------------------- deadlines --

describe('deadline reminders: one alert per saved bid per stage, on a fake clock', () => {
  beforeEach(async () => {
    clock = NOW;
    await resetDb(db);
  });
  afterEach(() => {
    for (const rt of running.splice(0)) rt.stop();
  });

  const due = at('2026-11-19T22:00:00Z'); // Thursday 2:00 PM Pacific
  const before = (hours: number) => new Date(due.getTime() - hours * HOUR);

  /** Store a bid, score it for the profile and swipe it. */
  async function swipe(profile: Profile, action: 'save' | 'bid' | 'pass', over: { dueAt?: string; overLimit?: boolean } = {}): Promise<Bid> {
    const bid = testBid({ dueAt: over.dueAt ?? due.toISOString() });
    await upsertBids(db, [bid], NOW);
    await upsertMatch(db, profile.id, bid.id, fit({ overLimit: over.overLimit ?? false }));
    expect(await recordSwipe(db, profile.id, bid.id, action)).toBe(true);
    return bid;
  }

  it('fires 3 days out, 1 day out and on the morning of — once each, however often the job runs', async () => {
    const { profile, devices } = await member();
    const bid = await swipe(profile, 'save');
    const e = engine();
    const stages = async () => (await listAlerts(db, profile.id)).map((a) => [a.dedupeKey, a.title]).reverse();
    const run = async (when: Date) => {
      clock = when;
      await e.rt.tick();
      await e.rt.tick(); // the job runs every 15 minutes: a second pass must add nothing
      await e.rt.flush();
    };

    await run(before(80));
    expect(await stages()).toEqual([]);

    await run(before(71)); // Monday 3:00 PM
    expect(await stages()).toEqual([[`${bid.id}:3d:2026-11-19`, 'Due in 3 days · Thu 2:00 PM']]);

    await run(before(30)); // between reminders
    expect(await stages()).toHaveLength(1);

    await run(before(23)); // Wednesday 3:00 PM
    expect((await stages())[1]).toEqual([`${bid.id}:1d:2026-11-19`, 'Due tomorrow at 2:00 PM']);

    await run(at('2026-11-19T14:59:00Z')); // Thursday 06:59
    expect(await stages()).toHaveLength(2);

    await run(at('2026-11-19T15:00:00Z')); // Thursday 07:00
    expect((await stages())[2]).toEqual([`${bid.id}:day:2026-11-19`, 'Due today at 2:00 PM']);

    await run(new Date(due.getTime() + 60_000)); // closed
    expect(await stages()).toHaveLength(3);

    const inbox = await listAlerts(db, profile.id);
    expect(inbox.every((a) => a.kind === 'deadline' && a.bidId === bid.id)).toBe(true);
    expect(inbox[0]?.data).toEqual({ bidId: bid.id, stage: 'day', dueAt: due.toISOString(), url: 'https://example.com/test-bid' });
    expect(inbox[0]?.body).toBe('TEST electrical panel upgrade (synthetic) — Carson City, NV');
    expect(e.announced).toHaveLength(3);
    // One push per reminder, to the phone, expiring within hours.
    expect(e.push.sent.map((s) => [s.endpoint, s.payload.title, s.message.ttl, s.message.urgency])).toEqual([
      [devices[0]!.endpoint, 'Due in 3 days · Thu 2:00 PM', 4 * 3600, 'high'],
      [devices[0]!.endpoint, 'Due tomorrow at 2:00 PM', 4 * 3600, 'high'],
      [devices[0]!.endpoint, 'Due today at 2:00 PM', 4 * 3600, 'high'],
    ]);
    expect(e.errors).toEqual([]);
  });

  it('reminds about bids marked "bid" too, never about passed or over-limit ones, and respects the switch', async () => {
    const saver = await member();
    const off = await member({ alerts: { kinds: { deadline: false } } });
    const free = await member({ plan: 'free' });
    const bidOn = await swipe(saver.profile, 'bid');
    await swipe(saver.profile, 'pass');
    await swipe(saver.profile, 'save', { overLimit: true });
    await swipe(saver.profile, 'save', { dueAt: at('2026-12-19T22:00:00Z').toISOString() }); // a month away
    await swipe(off.profile, 'save');
    const freeBid = await swipe(free.profile, 'save');
    const e = engine();

    expect((await savedBidsDueWithin(db, before(71), 72)).map((s) => [s.profileId, s.bidId]).sort()).toEqual(
      [[saver.profile.id, bidOn.id], [off.profile.id, expect.any(String)], [free.profile.id, freeBid.id]].sort(),
    );

    clock = before(71);
    await e.rt.tick();
    await e.rt.flush();
    expect((await listAlerts(db, saver.profile.id)).map((a) => a.bidId)).toEqual([bidOn.id]);
    expect(await listAlerts(db, off.profile.id)).toEqual([]);
    // Free plan: the reminder is in the inbox, the phone stays quiet.
    expect((await listAlerts(db, free.profile.id)).map((a) => a.bidId)).toEqual([freeBid.id]);
    expect(e.push.sent.map((s) => s.endpoint)).toEqual([saver.devices[0]!.endpoint]);
  });

  it('uses the profile\'s time zone for the morning of, and holds the buzz through quiet hours', async () => {
    const east = await member({ alerts: { timeZone: 'America/New_York', quietHours: { start: '22:00', end: '08:00' } } });
    const west = await member();
    await swipe(east.profile, 'save');
    await swipe(west.profile, 'save');
    const e = engine();

    clock = at('2026-11-19T12:00:00Z'); // 07:00 in New York (quiet until 08:00), 04:00 in Pacific
    await e.rt.tick();
    await e.rt.flush();
    expect((await listAlerts(db, east.profile.id)).map((a) => a.title)).toEqual(['Due today at 5:00 PM']);
    expect(await listAlerts(db, west.profile.id)).toEqual([]);
    expect(e.push.sent).toEqual([]);

    clock = at('2026-11-19T13:00:00Z'); // 08:00 in New York
    await e.rt.tick();
    expect(e.push.sent.map((s) => [s.endpoint, s.payload.title])).toEqual([[east.devices[0]!.endpoint, 'Due today at 5:00 PM']]);
  });

  it('a deadline moved to another day is reminded again', async () => {
    const { profile } = await member();
    const bid = await swipe(profile, 'save');
    const e = engine();
    clock = before(71);
    await e.rt.tick();

    // An addendum pushes the deadline out a week; the next scan stores the new date.
    const moved = at('2026-11-26T22:00:00Z');
    await upsertBids(db, [{ ...bid, dueAt: moved.toISOString() }], NOW);
    clock = before(23);
    await e.rt.tick();
    clock = new Date(moved.getTime() - 71 * HOUR);
    await e.rt.tick();

    expect((await listAlerts(db, profile.id)).map((a) => a.dedupeKey).reverse()).toEqual([`${bid.id}:3d:2026-11-19`, `${bid.id}:3d:2026-11-26`]);
  });
});

// ------------------------------------------------------------------ routes --

/** "Signed in" as whichever seeded account the x-test-account header names. */
function headerAuth(accounts: Map<string, Account>): AuthService {
  return { authenticate: async (req) => accounts.get(String(req.headers['x-test-account'])) ?? null };
}

describe('inbox and push routes (accounts mode)', () => {
  const accounts = new Map<string, Account>();
  const as = (who: { account: Account }) => ({ 'x-test-account': who.account.id });
  let app: FastifyInstance;
  let plain: FastifyInstance;
  let alice: Awaited<ReturnType<typeof member>>;
  let bob: Awaited<ReturnType<typeof member>>;
  let newcomer: Account;

  beforeAll(async () => {
    await resetDb(db);
    alice = await member({ devices: 0 });
    bob = await member({ plan: 'free', devices: 0 });
    newcomer = await seedAccount(db); // signed up, not onboarded
    for (const a of [alice.account, bob.account, newcomer]) accounts.set(a.id, a);
    const auth = headerAuth(accounts);
    app = (await buildApp({ db }, { config: accountsConfig({ vapid: testVapid }), auth, now: () => NOW })).app;
    plain = (await buildApp({ db }, { config: accountsConfig(), auth, now: () => NOW })).app; // no VAPID keys
  });
  afterAll(async () => {
    await app.close();
    await plain.close();
  });

  it('GET /api/push/key hands out the public key, or 404 push_not_configured', async () => {
    expect((await app.inject('/api/push/key')).json()).toEqual({ publicKey: testVapid.publicKey });
    const off = await plain.inject('/api/push/key');
    expect([off.statusCode, off.json()]).toEqual([404, { error: 'push_not_configured' }]);
    // Keys that cannot work count as not configured.
    const broken = (await buildApp({ db }, { config: accountsConfig({ vapid: { ...testVapid, subject: 'http://localhost:8787' } }), auth: fakeAuth(null) })).app;
    expect((await broken.inject('/api/push/key')).statusCode).toBe(404);
    await broken.close();
  });

  it('POST /api/push/subscribe stores a valid device for the signed-in account', async () => {
    const phone = device('route-phone');
    const subscribe = (payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/api/push/subscribe', payload: payload as object, headers });

    const signedOut = await subscribe({ subscription: phone });
    expect([signedOut.statusCode, signedOut.json()]).toEqual([401, { error: 'sign_in_required' }]);

    for (const bad of [{}, { subscription: null }, { subscription: { ...phone, endpoint: 'http://push.example.com/send/TEST' } }, { subscription: { endpoint: phone.endpoint } }]) {
      const res = await subscribe(bad, as(alice));
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_subscription' });
    }
    expect(await listSubscriptions(db, alice.account.id)).toEqual([]);

    const ok = await subscribe({ subscription: phone }, as(alice));
    expect([ok.statusCode, ok.json()]).toEqual([200, { ok: true, instantPush: true }]);
    expect(await listSubscriptions(db, alice.account.id)).toEqual([phone]);
    // The free plan may register a device; it is told the plan does not buzz it.
    expect((await subscribe({ subscription: device('bob-phone') }, as(bob))).json()).toEqual({ ok: true, instantPush: false });
    // Before onboarding too: it needs an account, not a profile.
    expect((await subscribe({ subscription: device('new-phone') }, as({ account: newcomer }))).statusCode).toBe(200);

    const noPush = await plain.inject({ method: 'POST', url: '/api/push/subscribe', payload: { subscription: phone }, headers: as(alice) });
    expect([noPush.statusCode, noPush.json()]).toEqual([404, { error: 'push_not_configured' }]);
  });

  it('DELETE /api/push/subscribe removes only your own device', async () => {
    const phone = device('route-delete');
    await saveSubscription(db, alice.account.id, phone, NOW);
    const unsubscribe = (payload: object | undefined, headers: Record<string, string> = {}) => app.inject({ method: 'DELETE', url: '/api/push/subscribe', payload, headers });

    expect((await unsubscribe({ endpoint: phone.endpoint })).statusCode).toBe(401);
    const missing = await unsubscribe(undefined, as(alice));
    expect([missing.statusCode, missing.json().error]).toEqual([400, 'invalid_endpoint']);

    expect((await unsubscribe({ endpoint: phone.endpoint }, as(bob))).json()).toEqual({ ok: true }); // answers ok, removes nothing
    expect((await listSubscriptions(db, alice.account.id)).map((d) => d.endpoint)).toContain(phone.endpoint);
    expect((await unsubscribe({ endpoint: phone.endpoint }, as(alice))).json()).toEqual({ ok: true });
    expect((await listSubscriptions(db, alice.account.id)).map((d) => d.endpoint)).not.toContain(phone.endpoint);
  });

  it('GET /api/alerts is the profile\'s own inbox, newest first; POST /api/alerts/read marks it', async () => {
    const mine = [];
    for (const key of ['a', 'b', 'c']) mine.push((await insertAlert(db, alice.profile.id, draft(`samgov:TEST-route-${key}`), { push: true, now: NOW }))!);
    const theirs = (await insertAlert(db, bob.profile.id, draft('samgov:TEST-route-z'), { now: NOW }))!;
    const ids = mine.map((a) => a.id);
    const inbox = async (query = '', who = alice) => (await app.inject({ url: `/api/alerts${query}`, headers: as(who) })).json() as { items: Alert[]; unread: number };
    const read = (payload: object | undefined, who = alice) => app.inject({ method: 'POST', url: '/api/alerts/read', payload, headers: as(who) });

    const all = await inbox();
    expect(all.items.map((a) => a.id)).toEqual([...ids].reverse());
    expect(all.unread).toBe(3);
    expect(all.items[0]).toEqual({ ...mine[2], data: { bidId: 'samgov:TEST-route-c', score: 80, url: 'https://example.com/test-bid' } });
    expect((await inbox('?limit=1')).items.map((a) => a.id)).toEqual([ids[2]]);
    expect((await inbox(`?before=${ids[1]}`)).items.map((a) => a.id)).toEqual([ids[0]]);
    expect((await inbox('', bob)).items.map((a) => a.id)).toEqual([theirs.id]);

    // Alice cannot mark Bob's alert; unknown ids are simply not hers.
    const marked = await read({ ids: [ids[0], theirs.id, 999_999] });
    expect(marked.json()).toEqual({ ok: true, updated: 1, unread: 2 });
    expect((await inbox('?unread=1')).items.map((a) => a.id)).toEqual([ids[2], ids[1]]);
    expect((await inbox('', bob)).unread).toBe(1);

    for (const bad of [undefined, {}, { ids: 'all' }, { ids: [1.5] }, { ids: [-1] }, { ids: ['7'] }, { ids: Array.from({ length: 501 }, (_, i) => i + 1) }]) {
      const res = await read(bad);
      expect(res.statusCode, JSON.stringify(bad)?.slice(0, 40)).toBe(400);
      expect(res.json().error).toBe('invalid_ids');
    }
    expect((await read({ ids: [] })).json()).toEqual({ ok: true, updated: 0, unread: 2 });
    expect((await read({ all: true })).json()).toEqual({ ok: true, updated: 2, unread: 0 });
    expect((await inbox('?unread=1')).items).toEqual([]);
  });

  it('signed out answers 401 and not-onboarded answers 409 on the inbox and the stream', async () => {
    for (const [method, url] of [['GET', '/api/alerts'], ['POST', '/api/alerts/read'], ['GET', '/api/stream']] as const) {
      const out = await app.inject({ method, url });
      expect([out.statusCode, out.json()], url).toEqual([401, { error: 'sign_in_required' }]);
      const fresh = await app.inject({ method, url, headers: as({ account: newcomer }) });
      expect([fresh.statusCode, fresh.json()], url).toEqual([409, { error: 'onboarding_required' }]);
    }
    // A HEAD request must not open a stream that never ends.
    expect((await app.inject({ method: 'HEAD', url: '/api/stream', headers: as(alice) })).statusCode).toBe(404);
  });
});

// ------------------------------------------------- the stream, end to end --

interface Frame { comment?: string; retry?: number; event?: string; id?: number; data?: any; raw: string; at: number }

function parseFrame(block: string): Frame {
  const frame: Frame = { raw: block, at: performance.now() };
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) frame.comment = line.slice(1).trim();
    else if (line.startsWith('retry:')) frame.retry = Number(line.slice(6));
    else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
    else if (line.startsWith('id:')) frame.id = Number(line.slice(3));
    else if (line.startsWith('data:')) frame.data = JSON.parse(line.slice(5));
  }
  return frame;
}

/** A small Server-Sent Events client over fetch: the same way the app reads the stream. */
async function openStream(url: string, headers: Record<string, string> = {}) {
  const abort = new AbortController();
  const res = await fetch(url, { headers, signal: abort.signal });
  const frames: Frame[] = [];
  const waiting: Array<(frame: Frame) => void> = [];
  const pump = (async () => {
    if (res.status !== 200 || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const frame = parseFrame(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          const waiter = waiting.shift();
          if (waiter) waiter(frame);
          else frames.push(frame);
        }
      }
    } catch {
      // aborted by close()
    }
  })();
  return {
    res,
    /** The next frame, in order; rejects when none arrives in time. */
    next(ms = 5000): Promise<Frame> {
      const ready = frames.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no stream event within ${ms} ms`)), ms);
        waiting.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
    },
    async close(): Promise<void> {
      abort.abort();
      await pump;
    },
  };
}

const scanReport = (profiles: ScanReport['profiles']): ScanReport => ({
  startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), sources: {}, totalBids: 13, newBids: 2, profiles,
});
const verdicts = { great: 1, good: 2, maybe: 3, skip: 7 };

describe('GET /api/stream against a real listening server', () => {
  const accounts = new Map<string, Account>();
  const streams: Array<{ close(): Promise<void> }> = [];
  let app: FastifyInstance;
  let bus: Bus;
  let rt: Realtime;
  let url: string;
  let alice: Awaited<ReturnType<typeof member>>;
  let bob: Awaited<ReturnType<typeof member>>;

  const connect = async (who: { account: Account }, headers: Record<string, string> = {}, query = '') => {
    const stream = await openStream(`${url}${query}`, { 'x-test-account': who.account.id, ...headers });
    streams.push(stream);
    return stream;
  };

  beforeAll(async () => {
    await resetDb(db);
    alice = await member({ devices: 0 });
    bob = await member({ devices: 0 });
    for (const a of [alice.account, bob.account]) accounts.set(a.id, a);
    bus = createBus();
    const built = await buildApp({ db }, { config: accountsConfig(), bus, auth: headerAuth(accounts), now: () => NOW });
    app = built.app;
    rt = createRealtime(built.ctx, { sender: null, tickMs: 0 });
    await app.listen({ port: 0, host: '127.0.0.1' }); // an ephemeral port
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/stream`;
  });
  afterEach(async () => {
    await Promise.all(streams.splice(0).map((s) => s.close()));
  });
  afterAll(async () => {
    rt.stop();
    await app.close();
  });

  it('opens with the SSE headers and a comment, then delivers a match the moment the bus has it', async () => {
    const stream = await connect(alice);
    expect(stream.res.status).toBe(200);
    expect(stream.res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(stream.res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(stream.res.headers.get('x-accel-buffering')).toBe('no');
    expect(await stream.next()).toMatchObject({ comment: 'connected', retry: 5000 });

    const event = matchEvent(alice.profile.id);
    await bus.emit(event);
    const frame = await stream.next();
    const [stored] = await listAlerts(db, alice.profile.id);
    expect(frame).toMatchObject({ event: 'match', id: stored!.id });
    expect(frame.data).toEqual(stored); // exactly what the inbox holds
    expect(frame.data).toMatchObject({
      kind: 'match', title: 'Great fit (82) · Carson City, NV', data: { bidId: event.bid.id, score: 82, url: 'https://example.com/test-bid' },
    });

    // The same match again: nothing new on the wire. The next thing to arrive is the scan event.
    await bus.emit(event);
    await bus.emit({
      type: 'scan',
      report: scanReport({
        [alice.profile.id]: { scored: 13, byVerdict: verdicts, newGood: 1 },
        [bob.profile.id]: { scored: 0, byVerdict: verdicts, newGood: 0, error: 'TEST-internal-detail' },
      }),
    });
    const scan = await stream.next();
    expect(scan).toMatchObject({ event: 'scan', id: stored!.id }); // every event carries the id of the newest alert sent
    expect(scan.data).toEqual({
      finishedAt: NOW.toISOString(), totalBids: 13, newBids: 2, profile: { scored: 13, byVerdict: verdicts, newGood: 1 },
    });
    expect(scan.raw).not.toContain(bob.profile.id);
    expect(scan.raw).not.toContain('TEST-internal-detail');
  });

  it('only streams a profile its own alerts', async () => {
    const hers = await connect(alice);
    const his = await connect(bob);
    await hers.next();
    await his.next();

    await bus.emit(matchEvent(alice.profile.id));
    await bus.emit(matchEvent(bob.profile.id, { score: fit({ score: 61, verdict: 'good' }) }));
    expect((await hers.next()).data).toMatchObject({ profileId: alice.profile.id, title: 'Great fit (82) · Carson City, NV' });
    expect((await his.next()).data).toMatchObject({ profileId: bob.profile.id, title: 'Good fit (61) · Carson City, NV' });

    await bus.emit({ type: 'scan', report: scanReport({}) });
    expect(await hers.next()).toMatchObject({ event: 'scan', data: { profile: null } });
    expect(await his.next()).toMatchObject({ event: 'scan', data: { profile: null } });
  });

  it('a client that reconnects with Last-Event-ID gets exactly the alerts it missed, in order', async () => {
    const first = await connect(alice);
    await first.next();
    await bus.emit(matchEvent(alice.profile.id));
    const seen = await first.next();
    await first.close();

    // Two more alerts while the phone is in a tunnel.
    const [second, third] = [testBid(), testBid()];
    await bus.emit(matchEvent(alice.profile.id, { bid: second }));
    await bus.emit(matchEvent(alice.profile.id, { bid: third }));

    const again = await connect(alice, { 'last-event-id': String(seen.id) });
    expect((await again.next()).comment).toBe('connected');
    const replayed = [await again.next(), await again.next()];
    expect(replayed.map((f) => [f.event, f.data.bidId])).toEqual([['match', second.id], ['match', third.id]]);
    expect(replayed[0]!.id!).toBeGreaterThan(seen.id!);
    expect(replayed[1]!.id!).toBeGreaterThan(replayed[0]!.id!);

    // Nothing older and nothing twice: the next frame is a live one.
    const live = testBid();
    await bus.emit(matchEvent(alice.profile.id, { bid: live }));
    expect((await again.next()).data.bidId).toBe(live.id);

    // A fetch-based reader may pass the id in the query instead; a fresh connection replays nothing.
    const viaQuery = await connect(alice, {}, `?lastEventId=${replayed[0]!.id}`);
    await viaQuery.next();
    expect([(await viaQuery.next()).data.bidId, (await viaQuery.next()).data.bidId]).toEqual([third.id, live.id]);
    const fresh = await connect(alice);
    await fresh.next();
    await bus.emit({ type: 'scan', report: scanReport({}) });
    const newest = await latestAlertId(db, alice.profile.id);
    expect(await fresh.next()).toMatchObject({ event: 'scan', id: newest });

    // An id from the future (a reset database, a typo) does not stick as the cursor.
    const confused = await connect(alice, { 'last-event-id': '999999999999' });
    await confused.next();
    await bus.emit({ type: 'scan', report: scanReport({}) });
    expect(await confused.next()).toMatchObject({ event: 'scan', id: newest });
    const garbage = await connect(alice, { 'last-event-id': 'TEST-not-a-number' }); // ignored: a fresh connection
    await garbage.next();
    await bus.emit({ type: 'scan', report: scanReport({}) });
    expect(await garbage.next()).toMatchObject({ event: 'scan', id: newest });
  });

  it('measures bus emit → event arriving at the client', async () => {
    const stream = await connect(alice);
    await stream.next();
    const ms: number[] = [];
    for (let i = 0; i < 40; i++) {
      const event = matchEvent(alice.profile.id);
      const t0 = performance.now();
      const emitted = bus.emit(event);
      const frame = await stream.next();
      await emitted;
      expect(frame.data.bidId).toBe(event.bid.id);
      ms.push(frame.at - t0);
    }
    ms.sort((a, b) => a - b);
    const [median, p95, max] = [ms[Math.floor(ms.length / 2)]!, ms[Math.floor(ms.length * 0.95)]!, ms.at(-1)!];
    console.log(`[realtime] bus emit → SSE event at the client, n=${ms.length}: median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms`);
    expect(median).toBeLessThan(250);
  });
});

describe('GET /api/stream: pings, the connection cap and cleanup', () => {
  const accounts = new Map<string, Account>();
  const streams: Array<{ close(): Promise<void> }> = [];
  let app: FastifyInstance;
  let url: string;
  let alice: Awaited<ReturnType<typeof member>>;
  let bob: Awaited<ReturnType<typeof member>>;

  beforeAll(async () => {
    await resetDb(db);
    alice = await member({ devices: 0 });
    bob = await member({ devices: 0 });
    for (const a of [alice.account, bob.account]) accounts.set(a.id, a);
    const ctx = createContext({ db, config: accountsConfig(), bus: createBus(), auth: headerAuth(accounts), now: () => NOW });
    app = Fastify({ forceCloseConnections: true });
    await realtimeRoutes(app, ctx, { pingMs: 40, maxStreams: 2 }); // the real values are 25 s and 5
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/stream`;
  });
  afterEach(async () => {
    await Promise.all(streams.splice(0).map((s) => s.close()));
  });
  afterAll(async () => app.close());

  const connect = async (who: { account: Account }) => {
    const stream = await openStream(url, { 'x-test-account': who.account.id });
    streams.push(stream);
    return stream;
  };

  it('pings on a timer so the connection stays open', async () => {
    const stream = await connect(alice);
    await stream.next();
    const [one, two] = [await stream.next(), await stream.next()];
    expect(one).toMatchObject({ event: 'ping', id: 0, data: { at: NOW.toISOString() } });
    expect(two.event).toBe('ping');
    expect(two.at - one.at).toBeGreaterThan(20);
  });

  it('caps open streams per account, and frees the slot when a client disconnects', async () => {
    const [one, two] = [await connect(alice), await connect(alice)];
    expect([one.res.status, two.res.status]).toEqual([200, 200]);

    const third = await connect(alice);
    expect(third.res.status).toBe(429);
    expect(await third.res.json()).toMatchObject({ error: 'too_many_streams' });
    expect((await connect(bob)).res.status).toBe(200); // someone else's limit is their own

    // Close one: the server notices and the next connection is let in.
    await one.close();
    await expect.poll(async () => (await connect(alice)).res.status, { timeout: 3000, interval: 25 }).toBe(200);
  });
});

