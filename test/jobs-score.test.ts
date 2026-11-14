import { describe, expect, it } from 'vitest';
import { lookupZip } from '../src/geo/zip.js';
import { DEFAULT_JOB_RULES } from '../src/jobs/config.js';
import type { JobRecord } from '../src/jobs/repo.js';
import { mirrorBid } from '../src/jobs/service.js';
import { buildProfile } from '../src/profile/build.js';
import { postedTrade, scoreBid } from '../src/score/score.js';
import { TRADES } from '../src/trades/catalog.js';

/**
 * How the scorer treats a job posted on BidSwipe (source 'local'): no NAICS code, the poster's trade labels as
 * its category. Real profiles from the trades catalog (buildProfile, the same as onboarding); the job is synthetic.
 */

const NOW = new Date('2026-11-14T18:00:00Z');
const place = lookupZip('89423')!; // Minden, NV

function job(trades: string[], over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'TEST-job-1', posterId: 'TEST-acct', title: 'Small job at my house', trades,
    description: 'Need someone to look at a few things and fix them up this week. TEST (simulated).',
    zip: place.zip, city: place.city, state: place.state, lat: place.lat, lng: place.lng, address: null, phone: null,
    budgetMaxCents: 80_000, postedAt: NOW.getTime(), closesAt: NOW.getTime() + 7 * 86_400_000, status: 'open', outcome: null,
    winnerBidId: null, winnerId: null, awardCents: null, awardedAt: null, contactDeadline: null, bidderMessagedAt: null,
    posterMessagedAt: null, posterTappedAt: null, bidderConfirmedAt: null, posterConfirmedAt: null, agreedAt: null, completedAt: null,
    endedAt: null, repostedFrom: null, removedAt: null, ...over,
  };
}

const company = (trade: string) => buildProfile(`TEST-${trade}`, {
  businessName: `TEST ${trade} (simulated)`, trades: [trade], zip: '89410', radiusMi: 90, valueRange: { min: 10_000, max: 50_000 },
});

describe('a posted job in the scorer', () => {
  it('the mirrored card: city precision from the ZIP, the budget as the estimate in dollars, the trade labels as category', () => {
    const b = mirrorBid(job(['electrical', 'low-voltage']), 'https://bidswipe.example.com');
    expect(b).toMatchObject({
      id: 'local:TEST-job-1', source: 'local', sourceName: 'Local job', naics: null, category: 'Electrical, Low voltage / security / data',
      estValue: { min: null, max: 800 }, flags: ['Local job'], url: 'https://bidswipe.example.com/?job=TEST-job-1',
      location: { city: 'Minden', state: 'NV', zip: '89423', precision: 'city', label: 'Minden, NV' },
    });
    expect(DEFAULT_JOB_RULES.maxCents).toBe(25_000_000);
  });

  it('an electrician gets a posted electrical job nearby as a good fit; a plumber does not', () => {
    const b = mirrorBid(job(['electrical']), 'https://bidswipe.example.com');
    const sparky = scoreBid(b, company('electrical'), NOW);
    expect(sparky.verdict === 'good' || sparky.verdict === 'great').toBe(true);
    expect(sparky.reasons[0]).toEqual({ kind: 'plus', text: 'Posted as Electrical work' });
    expect(sparky.rejected).toBeNull();
    expect(sparky.capped).toBeUndefined();
    const plumber = scoreBid(b, company('plumbing'), NOW);
    expect(plumber.verdict).toBe('skip');
    expect(plumber.rejected).toMatch(/No plumbing/);
  });

  it('every trade in the catalog gets a job posted under its own label as a good fit, even with a plain title', () => {
    for (const t of TRADES) {
      const s = scoreBid(mirrorBid(job([t.id]), 'https://bidswipe.example.com'), company(t.id), NOW);
      expect(s.score, t.id).toBeGreaterThanOrEqual(55);
      expect(s.reasons.some((r) => r.text === `Posted as ${t.label} work`), t.id).toBe(true);
    }
  });

  it('only local jobs are read this way: a board bid with the same category scores exactly as before', () => {
    const local = mirrorBid(job(['general-building']), 'https://bidswipe.example.com');
    const board = { ...local, id: 'ngem:TEST-1', source: 'ngem' as const, flags: [] };
    expect(postedTrade(board, company('general-building'))).toBeNull();
    expect(postedTrade(local, company('general-building'))).toBe('General building');
    expect(scoreBid(board, company('general-building'), NOW).rejected).toMatch(/No general building/);
    // a profile with no trades (someone who only hires) is never matched
    expect(postedTrade(local, { trades: [] })).toBeNull();
  });
});
