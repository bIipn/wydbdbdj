import { describe, expect, it } from 'vitest';
import { detectFlags } from '../src/util/flags.js';
import { findEstimate, formatRange } from '../src/util/money.js';
import { humanizeSlug, untruncate } from '../src/util/text.js';
import { findDue, findDueInText, parseUsDateTime, zonedToUtc } from '../src/util/time.js';
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

  it('reads the due time from every wording on the Douglas County page (2026-11-13)', () => {
    // Each phrase is verbatim from an ad on the page; before, all of these fell back to 5:00 PM.
    const wordings: Array<[string, string]> = [
      ['Electronic proposals must be received by November 9, 2026 no later than 2:00pm PST.', '2026-11-09T22:00:00.000Z'],
      ['Bids need to be turned in by 9AM April 18, 2025 at 1329 Waterloo Ln', '2025-04-18T16:00:00.000Z'],
      ['Due Date and Time: April 04, 2024, at 4:00 pm local', '2024-04-04T23:00:00.000Z'],
      ['Bids are due by 9AM, March 21, 2024', '2024-03-21T16:00:00.000Z'],
      ['Due June 27, 2023 no later than 2PM', '2023-06-27T21:00:00.000Z'],
      ['Due May 9,2023 no later than 2PM', '2023-05-09T21:00:00.000Z'],
      ['Due: On or before 2PM PST of March 13, 2023', '2023-03-13T21:00:00.000Z'],
      ['DUE: On or Before March 16,2023 By 2:00PM', '2023-03-16T21:00:00.000Z'],
      ['Bid Due Date: 10AM Thursday September1, 2022', '2022-09-01T17:00:00.000Z'],
      ['Bid Due Date: 2PM Thursday August 25, 2022', '2022-08-25T21:00:00.000Z'],
      ['Bid due date: 02/17/2022 at 2PM', '2022-02-17T22:00:00.000Z'],
      // The label gives the date only; the sentence after it has the time.
      ['RFP End Date: April 23, 2021 RFP Submission: Sealed Request for Proposal for Chemical Sales, Douglas County Weed Control will be received by Douglas County at the Douglas County Community Center at 1329 Waterloo, Gardnerville, Nevada 89410 until April, 23 2021 at 10:00 AM', '2021-04-23T17:00:00.000Z'],
      // 5 PM really is what these two say.
      ['indicated above by 5:00 p.m., October 29, 2026.', '2026-10-30T00:00:00.000Z'],
      ['Due Date and Time: May 2, 2025 at 5 p.m.', '2025-05-03T00:00:00.000Z'],
    ];
    for (const [ad, iso] of wordings) expect(findDue(ad), ad).toEqual({ iso, hasTime: true });
  });

  it('says when the ad gave a date but no time', () => {
    // Both real: the 5 PM is our default, so the caller must not treat it as the ad's due time.
    expect(findDue('Deadline 9/23/2021 Contact:')).toEqual({ iso: '2021-09-24T00:00:00.000Z', hasTime: false });
    expect(findDue('RFP End Date: April 23, 2021 RFP Submission:')).toEqual({ iso: '2021-04-24T00:00:00.000Z', hasTime: false });
    expect(findDueInText('Deadline 9/23/2021 Contact:')).toBe('2021-09-24T00:00:00.000Z');
    expect(findDue('The contract runs until June 30, 2027.')).toBeNull(); // "until <date>" without a time is not a deadline
  });

  it('takes the year from a nearby date when the ad leaves it out', () => {
    // Herbig Park (real): deadline cell 2024/06/21, the ad says Thursday the 20th at 2 PM.
    const herbig = 'The bids shall be received on or before 2:00 pm Thursday, June 20th. Click on the documents below';
    expect(findDue(herbig, { near: '2024-06-22T00:00:00.000Z' })).toEqual({ iso: '2024-06-20T21:00:00.000Z', hasTime: true });
    expect(findDue(herbig)).toBeNull(); // no year, nothing to go by
    // Same wording across New Year (made-up dates): the nearest January, not the January of the cell's year.
    expect(findDueInText('on or before 2:00 pm Thursday, January 7th.', { near: '2026-12-31T01:00:00.000Z' })).toBe('2027-01-07T22:00:00.000Z');
    expect(findDueInText('on or before 2:00 pm Thursday, December 17th.', { near: '2027-01-05T01:00:00.000Z' })).toBe('2026-12-17T22:00:00.000Z');
  });

  it('schedules the next daily run in Pacific time', () => {
    const from = new Date('2026-11-11T20:00:00Z'); // 12:00 PST
    expect(nextDailyRun('06:15', from).toISOString()).toBe('2026-11-12T14:15:00.000Z');
    expect(nextDailyRun('18:30', from).toISOString()).toBe('2026-11-12T02:30:00.000Z'); // later today
    // across the March DST jump: 6:15 PDT = 13:15 UTC
    expect(nextDailyRun('06:15', new Date('2027-03-14T20:00:00Z')).toISOString()).toBe('2027-03-15T13:15:00.000Z');
  });

  // The scheduler re-arms a few seconds after each run: every re-arm must land on the next calendar day.
  const rearm = (hhmm: string, first: Date, n: number) => {
    const runs: string[] = [];
    let at = nextDailyRun(hhmm, first);
    for (let i = 0; i < n; i++) {
      runs.push(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at));
      at = nextDailyRun(hhmm, new Date(at.getTime() + 5_000));
    }
    return runs;
  };

  it('runs late-evening and midnight schedules every day, not every other day', () => {
    expect(rearm('23:30', new Date('2026-11-12T20:00:00Z'), 4)).toEqual([
      '2026-11-12, 23:30', '2026-11-13, 23:30', '2026-11-14, 23:30', '2026-11-15, 23:30',
    ]);
    expect(rearm('23:59', new Date('2026-11-12T20:00:00Z'), 3)).toEqual(['2026-11-12, 23:59', '2026-11-13, 23:59', '2026-11-14, 23:59']);
    expect(rearm('00:00', new Date('2026-11-12T20:00:00Z'), 3)).toEqual(['2026-11-13, 00:00', '2026-11-14, 00:00', '2026-11-15, 00:00']);
  });

  it('keeps one run a day across both DST change days', () => {
    // fall back (2026-11-01) and spring forward (2027-03-14) at 23:30
    expect(rearm('23:30', new Date('2026-10-30T20:00:00Z'), 4)).toEqual([
      '2026-10-30, 23:30', '2026-10-31, 23:30', '2026-11-01, 23:30', '2026-11-02, 23:30',
    ]);
    expect(rearm('23:30', new Date('2027-03-12T20:00:00Z'), 4)).toEqual([
      '2027-03-12, 23:30', '2027-03-13, 23:30', '2027-03-14, 23:30', '2027-03-15, 23:30',
    ]);
    // 01:30 on the fall-back day runs once
    expect(rearm('01:30', new Date('2026-10-31T12:00:00Z'), 3)).toEqual(['2026-11-01, 01:30', '2026-11-02, 01:30', '2026-11-03, 01:30']);
  });

  it('runs a time inside the spring-forward gap at the same minutes one hour later, not an hour early', () => {
    // 02:30 does not exist on 2027-03-14: run at 03:30 PDT (10:30Z), never 01:30 PST (09:30Z)
    expect(nextDailyRun('02:30', new Date('2027-03-13T12:00:00Z')).toISOString()).toBe('2027-03-14T10:30:00.000Z');
    expect(nextDailyRun('02:30', new Date('2027-03-14T10:31:00Z')).toISOString()).toBe('2027-03-15T09:30:00.000Z');
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
  it('does not call a pre-bid mandatory when the ad says it is not', () => {
    // Douglas County's standard sentences, verbatim: 6 ads on the 2026-11-13 page were flagged by them.
    expect(detectFlags('Attendance at the pre-bid conference is highly encouraged but is not mandatory.')).toEqual([]);
    expect(detectFlags('Attendance at the prebid conference is highly encouraged but is not mandatory.')).toEqual([]);
    expect(detectFlags('Attendance at the pre-bid is highly encouraged but NOT mandatory.')).toEqual([]);
    expect(detectFlags('A non-mandatory pre-bid conference will be held')).toEqual([]);
    expect(detectFlags('Attendance at the pre-bid conference is mandatory.')).toEqual(['Mandatory pre-bid']);
  });
});
