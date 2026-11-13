import { describe, expect, it } from 'vitest';
import { detectFlags } from '../src/util/flags.js';
import { findEstimate, formatRange } from '../src/util/money.js';
import { humanizeSlug, untruncate } from '../src/util/text.js';
import { findDueInText, parseUsDateTime, zonedToUtc } from '../src/util/time.js';
import { nextDailyRun } from '../src/scheduler.js';
import { HttpError, redactUrl } from '../src/util/http.js';
import { buildSamUrl } from '../src/sources/samgov.js';

describe('secrets never reach logs', () => {
  const url = buildSamUrl({ apiKey: 'SAM-not-a-real-key', state: 'NV', from: new Date('2026-11-10'), to: new Date('2026-11-13') });
  it('redacts the SAM.gov key from URLs', () => {
    expect(url).toContain('SAM-not-a-real-key');
    expect(redactUrl(url)).not.toContain('SAM-not-a-real-key');
    expect(redactUrl(url)).toContain('api_key=***&postedFrom=');
  });
  it('redacts it from HTTP errors (these end up in the scan report)', () => {
    const err = new HttpError(403, url);
    expect(err.message).not.toContain('SAM-not-a-real-key');
    expect(err.url).not.toContain('SAM-not-a-real-key');
  });
});

describe('time', () => {
  it('handles PST vs PDT', () => {
    expect(zonedToUtc(2026, 11, 18, 14, 0).toISOString()).toBe('2026-11-18T22:00:00.000Z'); // PST, UTC-8
    expect(zonedToUtc(2026, 7, 30, 14, 0).toISOString()).toBe('2026-07-30T21:00:00.000Z'); // PDT, UTC-7
  });

  it('parses every board format', () => {
    expect(parseUsDateTime('12/08/2026 2:00 PM')).toBe('2026-12-08T22:00:00.000Z'); // NevadaEPro
    expect(parseUsDateTime('11/12/2026 11:00:00 AM (PT)')).toBe('2026-11-12T19:00:00.000Z'); // NGEM
    expect(parseUsDateTime('11/17/2026 10:30 AM PST')).toBe('2026-11-17T18:30:00.000Z'); // QuestCDN
    expect(parseUsDateTime('12/02/2026 12:00 PM')).toBe('2026-12-02T20:00:00.000Z'); // noon is 12 PM
    expect(parseUsDateTime('2026/11/20')).toBe('2026-11-21T01:00:00.000Z'); // date only → 5 PM PT
    expect(parseUsDateTime('2026-12-01T14:00:00-08:00')).toBe('2026-12-01T22:00:00.000Z'); // SAM ISO
    expect(parseUsDateTime('not a date')).toBeNull();
  });

  it('finds the deadline inside a legal ad', () => {
    const ad = 'Sealed bids ... will be received ... until 2:00 p.m. local time on Thursday, July 30, 2026, at which time';
    expect(findDueInText(ad)).toBe('2026-07-30T21:00:00.000Z');
    expect(findDueInText('Bid end date: August 5, 2025 at 10:00am')).toBe('2025-08-05T17:00:00.000Z');
    expect(findDueInText('Nothing useful here')).toBeNull();
  });

  it('schedules the next daily run in Pacific time', () => {
    const from = new Date('2026-11-11T20:00:00Z'); // 12:00 PST
    expect(nextDailyRun('06:15', from).toISOString()).toBe('2026-11-12T14:15:00.000Z');
    expect(nextDailyRun('18:30', from).toISOString()).toBe('2026-11-12T02:30:00.000Z'); // later today
    // across the March DST jump: 6:15 PDT = 13:15 UTC
    expect(nextDailyRun('06:15', new Date('2027-03-14T20:00:00Z')).toISOString()).toBe('2027-03-15T13:15:00.000Z');
  });
});

describe('money', () => {
  it('reads estimates tied to an estimate cue', () => {
    expect(findEstimate("The Engineer's estimate for this work is $81,000.00.")).toEqual({ min: 81000, max: 81000 });
    expect(findEstimate('Estimated value of $500K-$800K for the project')).toEqual({ min: 500000, max: 800000 });
    expect(findEstimate('Estimate: <$100,000')).toEqual({ min: null, max: 100000 });
    expect(findEstimate('Liquidated Damages: $350.00 per day.')).toBeNull();
  });
  it('formats ranges', () => {
    expect(formatRange({ min: 81000, max: 81000 })).toBe('$81K');
    expect(formatRange({ min: 500000, max: 1500000 })).toBe('$500K–$1.5M');
  });
});

describe('text + flags', () => {
  it('humanizes CivicLive slugs', () => {
    expect(humanizeSlug('jobs_peak_w_t_p_p_l_c_replacement_project')).toBe('Jobs Peak WTPPLC Replacement Project');
    expect(humanizeSlug('library_strategic_plan')).toBe('Library Strategic Plan');
  });
  it('untruncates', () => {
    expect(untruncate(' Carson Cit...')).toEqual({ text: 'Carson Cit', truncated: true });
  });
  it('detects contractor requirements', () => {
    const f = detectFlags('accompanied by a bid security in the form of a Bid Bond ... The Prevailing Wage Rate ... mandatory pre-bid meeting');
    expect(f).toEqual(['Bid bond', 'Prevailing wage', 'Mandatory pre-bid']);
  });
});
