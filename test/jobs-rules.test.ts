import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_JOB_RULES, JobConfigError, loadJobRules, pctToPpm, publicRules } from '../src/jobs/config.js';
import {
  applyRate, compareBids, contactDeadlineFor, DAY_MS, endOfContact, FEE_OUTCOMES, feeLine, formatUsd, pickWinner, settle,
  type BidState, type JobRules, type JobState,
} from '../src/jobs/rules.js';

/**
 * The marketplace's pure rules (src/jobs/rules.ts) and its settings (src/jobs/config.ts).
 * The properties run on generated bids and jobs; every person and amount in them is synthetic.
 */

const RULES: JobRules = DEFAULT_JOB_RULES;
const T0 = Date.parse('2026-11-14T18:00:00Z');

const bidArb = fc.record({
  id: fc.integer({ min: 1, max: 10_000 }),
  bidderId: fc.constantFrom('TEST-a', 'TEST-b', 'TEST-c', 'TEST-d'),
  amountCents: fc.integer({ min: 2_000, max: 25_000_000 }),
  createdAt: fc.integer({ min: T0 - 14 * DAY_MS, max: T0 }),
  status: fc.constantFrom('active', 'active', 'active', 'withdrawn') as fc.Arbitrary<BidState['status']>,
});
/** Bids with distinct ids (the database's bigserial). Amounts and times collide often, on purpose: that is the tie-break. */
const bidsArb = fc.uniqueArray(bidArb, { selector: (b) => b.id, maxLength: 12 }).map((bs) =>
  bs.map((b, i) => (i % 3 === 0 && bs[0] ? { ...b, amountCents: bs[0].amountCents } : b)));

const openJob = (closesAt: number): JobState => ({
  status: 'open', outcome: null, closesAt, winnerBidId: null, winnerId: null, awardCents: null, awardedAt: null, contactDeadline: null,
  bidderMessagedAt: null, posterMessagedAt: null, posterTappedAt: null, bidderConfirmedAt: null, posterConfirmedAt: null, endedAt: null,
});

describe('who wins', () => {
  it('the winner is a lowest active bid, and the earliest placed (then lowest id) of the lowest', () => {
    fc.assert(fc.property(bidsArb, (bids) => {
      const w = pickWinner(bids);
      const active = bids.filter((b) => b.status === 'active');
      if (active.length === 0) {
        expect(w).toBeNull();
        return;
      }
      const low = Math.min(...active.map((b) => b.amountCents));
      expect(w!.amountCents).toBe(low);
      expect(w!.status).toBe('active');
      for (const b of active) {
        if (b.amountCents !== low) continue;
        expect(b.createdAt > w!.createdAt || (b.createdAt === w!.createdAt && b.id >= w!.id)).toBe(true);
      }
    }));
  });

  it('a withdrawn bid never wins, however low', () => {
    const bids: BidState[] = [
      { id: 1, bidderId: 'TEST-a', amountCents: 2_000, createdAt: T0, status: 'withdrawn' },
      { id: 2, bidderId: 'TEST-b', amountCents: 9_000, createdAt: T0, status: 'active' },
    ];
    expect(pickWinner(bids)?.id).toBe(2);
  });

  it('a tie goes to the bid placed first, then the lower id', () => {
    const a: BidState = { id: 9, bidderId: 'TEST-a', amountCents: 5_000, createdAt: T0 - 1000, status: 'active' };
    const b: BidState = { id: 3, bidderId: 'TEST-b', amountCents: 5_000, createdAt: T0, status: 'active' };
    const c: BidState = { id: 2, bidderId: 'TEST-c', amountCents: 5_000, createdAt: T0, status: 'active' };
    expect(pickWinner([b, c, a])?.id).toBe(9);
    expect(pickWinner([b, c])?.id).toBe(2);
    expect([b, a, c].sort(compareBids).map((x) => x.id)).toEqual([9, 2, 3]);
  });
});

describe('fees', () => {
  const ruleArb = fc.integer({ min: 0, max: 100_000 }).chain((noShow) => fc.record({
    noShowFeePpm: fc.constant(noShow),
    posterSharePpm: fc.integer({ min: 0, max: noShow }),
    serviceFeePpm: fc.integer({ min: 0, max: 30_000 }),
  }));

  it('fee = the bid × rate, rounded half up once; poster share + platform share = fee exactly; nothing negative', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), ruleArb, fc.constantFrom('no_show', 'service') as fc.Arbitrary<'no_show' | 'service'>,
      (basis, r, kind) => {
        const f = feeLine(kind, basis, r);
        const rate = kind === 'no_show' ? r.noShowFeePpm : r.serviceFeePpm;
        // the reference: exact rational, rounded half up (BigInt so no float can creep in)
        const exact = BigInt(basis) * BigInt(rate);
        const q = exact / 1_000_000n;
        const ref = Number(exact - q * 1_000_000n >= 500_000n ? q + 1n : q);
        expect(f.amountCents).toBe(ref);
        expect(f.posterShareCents + f.platformCents).toBe(f.amountCents);
        for (const v of [f.amountCents, f.posterShareCents, f.platformCents]) expect(v).toBeGreaterThanOrEqual(0);
        if (kind === 'service') expect(f.posterShareCents).toBe(0);
        expect(Number.isSafeInteger(f.amountCents)).toBe(true);
      }));
  });

  it('at the defaults: 5% no-show fee, 2% of the bid to the poster, 3% kept; 1% service fee', () => {
    const f = feeLine('no_show', 123_456, RULES); // $1,234.56
    expect(f).toMatchObject({ amountCents: 6_173, posterShareCents: 2_469, platformCents: 3_704, ratePpm: 50_000, posterSharePpm: 20_000 });
    expect(feeLine('service', 123_456, RULES)).toMatchObject({ amountCents: 1_235, posterShareCents: 0, platformCents: 1_235 });
    expect(applyRate(10, 50_000)).toBe(1); // 0.5 cents rounds up
    expect(applyRate(9, 50_000)).toBe(0); // 0.45 rounds down
  });

  it('formats cents without floats', () => {
    expect(formatUsd(2_000)).toBe('$20');
    expect(formatUsd(123_456)).toBe('$1,234.56');
    expect(formatUsd(25_000_000)).toBe('$250,000');
    expect(formatUsd(5)).toBe('$0.05');
  });
});

describe('the contact window', () => {
  const t = (n: number | null) => n;
  it('no contact = bidder no-show (fee); contact but no answer = poster no-show; both talked = no agreement', () => {
    const none = { bidderMessagedAt: null, posterMessagedAt: null, posterTappedAt: null, posterConfirmedAt: null };
    expect(endOfContact(none)).toBe('bidder_no_show');
    expect(endOfContact({ ...none, posterMessagedAt: t(T0) })).toBe('bidder_no_show'); // the poster wrote; the winner never did
    expect(endOfContact({ ...none, bidderMessagedAt: t(T0) })).toBe('poster_no_show');
    expect(endOfContact({ ...none, posterTappedAt: t(T0) })).toBe('no_agreement'); // "They contacted me" is both: contact and an answer
    expect(endOfContact({ ...none, bidderMessagedAt: t(T0), posterMessagedAt: t(T0) })).toBe('no_agreement');
    expect(FEE_OUTCOMES.has('bidder_no_show') && FEE_OUTCOMES.has('bidder_backed_out')).toBe(true);
    for (const o of ['poster_no_show', 'no_agreement', 'poster_cancelled', 'no_bids'] as const) expect(FEE_OUTCOMES.has(o)).toBe(false);
  });

  it('the deadline is counted from the closing time, not from when the settlement happened to run', () => {
    expect(contactDeadlineFor(T0, 7)).toBe(T0 + 7 * DAY_MS);
    const bids: BidState[] = [{ id: 1, bidderId: 'TEST-a', amountCents: 5_000, createdAt: T0 - DAY_MS, status: 'active' }];
    const late = settle(openJob(T0), bids, T0 + 3 * DAY_MS, RULES);
    expect(late.job.contactDeadline).toBe(T0 + 7 * DAY_MS);
    expect(late.job.awardedAt).toBe(T0);
  });
});

describe('settle', () => {
  const contactArb = fc.record({
    bidderMessagedAt: fc.option(fc.constant(T0 + DAY_MS), { nil: null }),
    posterMessagedAt: fc.option(fc.constant(T0 + DAY_MS), { nil: null }),
    posterTappedAt: fc.option(fc.constant(T0 + DAY_MS), { nil: null }),
  });

  it('settling twice is the same as settling once (at any time, with any bids and contact)', () => {
    fc.assert(fc.property(bidsArb, contactArb, fc.integer({ min: -2 * DAY_MS, max: 20 * DAY_MS }), (bids, contact, offset) => {
      const now = T0 + offset;
      const once = settle(openJob(T0), bids, now, RULES);
      // contact happens inside the window (before `now`), then a second settlement at the same time
      const twice = settle(once.job, once.bids, now, RULES);
      expect(twice.job).toEqual(once.job);
      expect(twice.bids).toEqual(once.bids);
      expect(twice.fees).toEqual([]);
      expect(twice.changed).toBe(false);
      // and with contact facts added before the deadline: settle → settle is still stable
      const talked = once.job.status === 'awarded' ? { ...once.job, ...contact } : once.job;
      const a = settle(talked, once.bids, now + 10 * DAY_MS, RULES);
      const b = settle(a.job, a.bids, now + 10 * DAY_MS, RULES);
      expect(b.job).toEqual(a.job);
      expect(b.fees).toEqual([]);
    }));
  });

  it('no fee for a no-bids job, a poster no-show or no agreement; the no-show fee only when the winner made no contact', () => {
    fc.assert(fc.property(bidsArb, contactArb, (bids, contact) => {
      const awarded = settle(openJob(T0), bids, T0, RULES);
      if (awarded.job.status === 'unfilled') {
        expect(awarded.job.outcome).toBe('no_bids');
        expect(awarded.fees).toEqual([]);
        return;
      }
      const end = settle({ ...awarded.job, ...contact }, awarded.bids, T0 + 8 * DAY_MS, RULES);
      expect(end.job.status).toBe('unfilled');
      if (end.job.outcome === 'bidder_no_show') {
        expect(end.fees).toHaveLength(1);
        expect(end.fees[0]!.basisCents).toBe(awarded.job.awardCents);
        expect(end.bids.find((b) => b.id === end.job.winnerBidId)?.status).toBe('defaulted');
      } else {
        expect(['poster_no_show', 'no_agreement']).toContain(end.job.outcome);
        expect(end.fees).toEqual([]);
      }
    }));
  });

  it('before closing nothing changes; at closing every active bid is won or lost', () => {
    fc.assert(fc.property(bidsArb, (bids) => {
      expect(settle(openJob(T0), bids, T0 - 1, RULES).changed).toBe(false);
      const s = settle(openJob(T0), bids, T0, RULES);
      expect(s.bids.filter((b) => b.status === 'active')).toEqual([]);
      expect(s.bids.filter((b) => b.status === 'won').length).toBe(bids.some((b) => b.status === 'active') ? 1 : 0);
      expect(s.bids.filter((b) => b.status === 'withdrawn').length).toBe(bids.filter((b) => b.status === 'withdrawn').length);
    }));
  });
});

describe('settings (JOB_* environment)', () => {
  const load = (vars: Record<string, string>) => loadJobRules((name) => vars[name]);

  it('defaults: 5% no-show, 2% to the poster, 1% service, 7 days, $20 to $250,000; payments off', () => {
    expect(load({})).toEqual(RULES);
    expect(publicRules(load({}))).toEqual({
      noShowFeePct: 5, posterSharePct: 2, serviceFeePct: 1, contactDays: 7, minCents: 2_000, maxCents: 25_000_000, paymentsOn: false,
    });
    expect(pctToPpm('2.5')).toBe(25_000);
    expect(load({ JOB_NO_SHOW_FEE_PCT: '7.5', JOB_POSTER_SHARE_PCT: '2.25' })).toMatchObject({ noShowFeePpm: 75_000, posterSharePpm: 22_500 });
  });

  it('a value out of its limits stops the boot with a plain sentence', () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ JOB_NO_SHOW_FEE_PCT: '11' }, /JOB_NO_SHOW_FEE_PCT is 11%, which is above the 10% limit/],
      [{ JOB_NO_SHOW_FEE_PCT: '-1' }, /JOB_NO_SHOW_FEE_PCT is -1%, which is below 0/],
      [{ JOB_NO_SHOW_FEE_PCT: 'five' }, /must be a percentage/],
      [{ JOB_POSTER_SHARE_PCT: '6' }, /JOB_POSTER_SHARE_PCT is 6%, which is above the no-show fee \(5%\)/],
      [{ JOB_SERVICE_FEE_PCT: '3.5' }, /above the 3% limit/],
      [{ JOB_CONTACT_DAYS: '0' }, /JOB_CONTACT_DAYS must be from 1 to 30/],
      [{ JOB_MAX_CENTS: '100' }, /JOB_MAX_CENTS must be from 2000/],
    ];
    for (const [vars, message] of cases) {
      expect(() => load(vars)).toThrow(JobConfigError);
      expect(() => load(vars)).toThrow(message);
    }
  });
});
