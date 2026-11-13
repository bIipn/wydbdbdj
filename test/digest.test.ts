/**
 * The alert email (src/notify/digest.ts) on real bids: it shows the caveats next to the positives, and it only
 * claims "within 90 mi" when every card has a known distance. Bids come from the real pages in test/fixtures,
 * scored at the capture time; the SAM.gov notice is the real J061 notice of the 2026-11-13 scan (its fields copied).
 */
import { describe, expect, it } from 'vitest';
import { buildDigest, digestHeadline, digestReasons } from '../src/notify/digest.js';
import { loadProfile } from '../src/profiles.js';
import { finalizeBid } from '../src/scan.js';
import { scoreBid } from '../src/score/score.js';
import type { Bid, FeedItem } from '../src/types.js';
import { CAPTURED, realBids } from './helpers.js';

const pilot = loadProfile('lm-electric');
const real = realBids();
const board = (title: RegExp): Bid => real.find((b) => title.test(b.title))!;

function item(b: Bid, now = CAPTURED): FeedItem {
  const s = scoreBid(b, pilot, now);
  return { ...b, score: s.score, verdict: s.verdict, reasons: s.reasons, distanceMi: s.distanceMi, overLimit: s.overLimit, swipe: null, firstSeenAt: now.toISOString() };
}

const CELL_DOORS = item(board(/^Replace Cell Doors, Locks, Intercoms/));
const SPRINKLER = item(board(/^Fire Sprinkler System Installation and Fire Alarm/));
const GENERATOR = item(board(/^Generator$/)); // NevadaEPro: no site listed, no distance
const SCAN = new Date('2026-11-13T04:02:14.145Z');
const J061 = item(finalizeBid({
  source: 'samgov', sourceId: '0219242e57b54ac1bf223aaa8c9edc6c', sourceName: 'SAM.gov (federal)', title: 'J061--Triennial Circuit Breaker and Feeder Testing',
  agency: null, description: null, category: 'Solicitation', location: { city: 'Reno', state: 'NV', zip: '89502' }, postedAt: null,
  dueAt: '2026-11-20T20:00:00.000Z', estValue: null, naics: '238210', setAside: 'SDVOSBC', url: 'https://sam.gov/opp/0219242e57b54ac1bf223aaa8c9edc6c/view', flags: [],
}), SCAN);

describe('alert email', () => {
  it('shows the caveats, not only the ticks: the SPWD and prevailing-wage lines of the top real card', () => {
    const { html, text } = buildDigest(pilot, [CELL_DOORS], 'https://example.com/app', CAPTURED);
    for (const line of ['Electrical scope: “intercom”', 'SPWD bidder qualification', 'Prevailing wage likely', 'Job size not stated']) {
      expect(html).toContain(line);
      expect(text).toContain(line);
    }
  });

  it('a supply-board purchase shows why it may not be a job, and that no site is listed', () => {
    const { html } = buildDigest(pilot, [GENERATOR], 'https://example.com/app', CAPTURED);
    expect(html).toContain('No work named in the title — may be a purchase, not a job');
    expect(html).toContain('Work location not listed — check the bid');
  });

  it('an ineligible set-aside is never hidden (J061, 58 and emailed before, is no longer an alert at all)', () => {
    expect(J061.score).toBeLessThan(pilot.notify.minScore);
    const { html } = buildDigest(pilot, [J061], 'https://example.com/app', SCAN);
    expect(html).toContain('Reserved for service-disabled veteran-owned firms');
  });

  it('keeps 3 ticks, then every minus, then every note', () => {
    const r = digestReasons([
      { kind: 'info', text: 'i1' }, { kind: 'plus', text: 'p1' }, { kind: 'minus', text: 'm1' }, { kind: 'plus', text: 'p2' },
      { kind: 'plus', text: 'p3' }, { kind: 'plus', text: 'p4' }, { kind: 'minus', text: 'm2' }, { kind: 'info', text: 'i2' },
    ]);
    expect(r.map((x) => x.text)).toEqual(['p1', 'p2', 'p3', 'm1', 'm2', 'i1', 'i2']);
  });

  it('says "within 90 mi" only when every card has a known distance', () => {
    expect(CELL_DOORS.distanceMi).not.toBeNull();
    expect(SPRINKLER.distanceMi).not.toBeNull();
    expect(digestHeadline(pilot, [CELL_DOORS, SPRINKLER])).toBe('2 new matches within 90 mi of Gardnerville, NV');
    expect(digestHeadline(pilot, [CELL_DOORS, SPRINKLER, GENERATOR])).toBe('3 new matches (1 with no known distance)');
    expect(digestHeadline(pilot, [GENERATOR])).toBe('1 new match (distance not known)');
    const { html, text } = buildDigest(pilot, [CELL_DOORS, GENERATOR], 'https://example.com/app', CAPTURED);
    expect(html).not.toContain('within 90 mi');
    expect(text).toContain('2 new matches (1 with no known distance)');
  });

  it('escapes what the boards wrote', () => {
    const { html } = buildDigest(pilot, [{ ...CELL_DOORS, reasons: [{ kind: 'minus', text: '<b>TEST</b> & co' }] }], 'https://example.com/app', CAPTURED);
    expect(html).toContain('&lt;b&gt;TEST&lt;/b&gt; &amp; co');
    expect(html).not.toContain('<b>TEST</b>');
  });
});
