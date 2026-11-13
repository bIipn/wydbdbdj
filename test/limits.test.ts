/**
 * Spend limits in the scorer. Real bids come from the captured Douglas County and QuestCDN pages;
 * every other bid is built by testBid() and is obviously synthetic (TEST- ids, example.com links).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadProfile } from '../src/profiles.js';
import { finalizeBid } from '../src/scan.js';
import { BOND_NOTE, parseBidBondPct, scoreBid, scoreFit } from '../src/score/score.js';
import { parseDouglasRfp } from '../src/sources/douglascounty.js';
import { parseQuestJson, QUEST_BOARDS } from '../src/sources/questcdn.js';
import type { Bid, Profile, Reason, SpendLimits } from '../src/types.js';
import { CAPTURED, fx, NOW, testBid, testProfile } from './helpers.js';

const pilot = loadProfile('lm-electric'); // has no limits
const withLimits = (limits: SpendLimits | undefined): Profile => testProfile('test-limits', { limits });
const score = (bid: Bid, limits: SpendLimits | undefined) => scoreBid(bid, withLimits(limits), NOW);

const point = (v: number) => ({ min: v, max: v });
const texts = (reasons: Reason[]) => reasons.map((r) => r.text);
/** What the limits added on top of the fit. */
const added = (bid: Bid, limits: SpendLimits | undefined): Reason[] => {
  const fit = texts(scoreFit(bid, withLimits(limits), NOW).reasons);
  return score(bid, limits).reasons.filter((r) => !fit.includes(r.text));
};

const FIVE_PCT = 'TEST notice (synthetic). Each bid must come with a bid bond in the amount of five percent (5%) of the total bid.';
const NO_PCT = 'TEST notice (synthetic). A bid bond is required with each bid.';

describe('job size limit', () => {
  const limits = { maxJobSize: 100_000 };
  const cases: Array<[name: string, est: Bid['estValue'], overLimit: boolean, reason: string | null]> = [
    ['under the limit', point(81_000), false, null],
    ['exactly at the limit', point(100_000), false, null],
    ['over the limit', point(180_000), true, 'Est. $180K — over your $100K job limit'],
    ['a dollar over (spelled out, so it does not read "$100K over $100K")', point(100_001), true, 'Est. $100,001 — over your $100K job limit'],
    ['no estimate', null, false, null],
    ['an estimate with neither end', { min: null, max: null }, false, null],
    ['a range wholly over', { min: 150_000, max: 250_000 }, true, 'Est. $150K–$250K — over your $100K job limit'],
    ['a range that straddles the limit', { min: 80_000, max: 120_000 }, false, 'Est. $80K–$120K — may run over your $100K job limit'],
    ['a range wholly under', { min: 20_000, max: 90_000 }, false, null],
    ['"under $250K": the ceiling is over, the job may not be', { min: null, max: 250_000 }, false, 'Est. under $250K — may run over your $100K job limit'],
    ['"under $90K"', { min: null, max: 90_000 }, false, null],
    ['a floor with no ceiling, over', { min: 300_000, max: null }, true, 'Est. $300K — over your $100K job limit'],
  ];

  it.each(cases)('%s', (_name, estValue, overLimit, reason) => {
    const bid = testBid({ estValue });
    const s = score(bid, limits);
    expect(s.overLimit).toBe(overLimit);
    expect(added(bid, limits)).toEqual(reason ? [{ kind: 'minus', text: reason }] : []);
  });

  it('an over-limit bid keeps its fit score, verdict and every fit reason', () => {
    const bid = testBid({ estValue: point(180_000) });
    const fit = scoreFit(bid, pilot, NOW);
    const s = score(bid, limits);
    expect(fit.score).toBeGreaterThanOrEqual(75); // close electrical work: a great fit that is simply too big
    expect(s).toMatchObject({ score: fit.score, verdict: fit.verdict, rejected: null, distanceMi: fit.distanceMi, overLimit: true });
    expect(texts(s.reasons)).toEqual(expect.arrayContaining(texts(fit.reasons)));
  });

  it('puts the limit reason after the pluses and ahead of the other minuses', () => {
    const s = score(testBid({ estValue: point(180_000), dueAt: '2026-11-14T22:00:00.000Z' }), limits);
    const kinds = s.reasons.map((r) => r.kind);
    const at = texts(s.reasons).indexOf('Est. $180K — over your $100K job limit');
    expect(kinds.slice(0, at).every((k) => k === 'plus')).toBe(true);
    expect(kinds.slice(at)).not.toContain('plus');
    expect(texts(s.reasons).slice(at + 1)).toEqual(expect.arrayContaining(['Est. $180K — large job; sub to the GC?', 'Only 3 days to bid']));
  });

  it('a rejected bid still leads with why it was rejected', () => {
    const s = score(testBid({ title: 'TEST janitorial services (synthetic)', estValue: point(180_000) }), limits);
    expect(s.reasons[0]).toEqual({ kind: 'minus', text: 'Not your trade (“janitorial”)' });
    expect(s).toMatchObject({ score: 0, overLimit: true });
    expect(texts(s.reasons)).toContain('Est. $180K — over your $100K job limit');
  });

  it('shows the contractor\'s own figure exactly', () => {
    const reason = (maxJobSize: number) => added(testBid({ estValue: point(9_000_000) }), { maxJobSize })[0]!.text;
    expect(reason(75_500)).toBe('Est. $9M — over your $75,500 job limit');
    expect(reason(1_500_000)).toBe('Est. $9M — over your $1.5M job limit');
    expect(reason(1_250_000)).toBe('Est. $9M — over your $1,250,000 job limit');
    expect(reason(2_000_000)).toBe('Est. $9M — over your $2M job limit');
    expect(reason(900)).toBe('Est. $9M — over your $900 job limit');
    expect(reason(999_500)).toBe('Est. $9M — over your $999,500 job limit');
    const big = (maxJobSize: number) => added(testBid({ estValue: point(90_000_000) }), { maxJobSize })[0]!.text;
    expect(big(12_000_000)).toBe('Est. $90M — over your $12M job limit');
    expect(big(12_500_000)).toBe('Est. $90M — over your $12,500,000 job limit');
  });

  it.each([undefined, {}, { maxJobSize: null }, { maxJobSize: 0 }, { maxJobSize: -1 }, { maxJobSize: Number.NaN }, { maxJobSize: null, maxUpfront: null, bondingCapacity: null }])(
    'limits %j count as "none set"',
    (none) => {
      const bid = testBid({ estValue: point(5_000_000), flags: ['Bid bond'], description: FIVE_PCT });
      expect(score(bid, none)).toEqual(scoreFit(bid, withLimits(none), NOW));
    },
  );

  it('maxUpfront is the estimator\'s business: on its own it never hides a bid', () => {
    expect(score(testBid({ estValue: point(5_000_000) }), { maxUpfront: 1 }).overLimit).toBe(false);
  });
});

describe('bonding capacity', () => {
  const limits = { bondingCapacity: 150_000 };

  it.each(['Bid bond', 'Performance/payment bond'])('%s required and the estimate is over capacity → over limit', (flag) => {
    const bid = testBid({ estValue: point(200_000), flags: [flag] });
    expect(score(bid, limits).overLimit).toBe(true);
    expect(added(bid, limits)).toEqual([{ kind: 'minus', text: 'Bond required — est. $200K is over your $150K bonding capacity' }]);
  });

  it('capacity only matters when a bond is required', () => {
    const bid = testBid({ estValue: point(200_000), flags: ['Prevailing wage'] });
    expect(score(bid, limits).overLimit).toBe(false);
    expect(added(bid, limits)).toEqual([]);
  });

  it('within capacity, at capacity, and a range that straddles it', () => {
    expect(score(testBid({ estValue: point(120_000), flags: ['Performance/payment bond'] }), limits).overLimit).toBe(false);
    expect(score(testBid({ estValue: point(150_000), flags: ['Performance/payment bond'] }), limits).overLimit).toBe(false);
    const straddle = testBid({ estValue: { min: 100_000, max: 200_000 }, flags: ['Performance/payment bond'] });
    expect(score(straddle, limits).overLimit).toBe(false);
    expect(added(straddle, limits)).toEqual([{ kind: 'minus', text: 'Bond required — est. $100K–$200K may run over your $150K bonding capacity' }]);
  });

  it('no estimate → nothing to compare, nothing said', () => {
    const bid = testBid({ flags: ['Bid bond', 'Performance/payment bond'], description: FIVE_PCT });
    expect(score(bid, limits)).toEqual(scoreFit(bid, pilot, NOW));
  });

  it('job size and bonding are checked separately and both say so', () => {
    const both = { maxJobSize: 100_000, bondingCapacity: 150_000 };
    const bid = testBid({ estValue: point(180_000), flags: ['Bid bond'] });
    expect(score(bid, both).overLimit).toBe(true);
    expect(texts(added(bid, both))).toEqual([
      'Est. $180K — over your $100K job limit',
      'Bond required — est. $180K is over your $150K bonding capacity',
    ]);
    // Under the bonding capacity but over the job limit: only the job limit speaks.
    expect(texts(added(testBid({ estValue: point(120_000), flags: ['Bid bond'] }), both))).toEqual(['Est. $120K — over your $100K job limit']);
  });
});

describe('bond note', () => {
  const limits = { maxJobSize: 500_000 };

  it('uses the percentage the notice states', () => {
    const bid = testBid({ estValue: point(81_000), flags: ['Bid bond'], description: FIVE_PCT });
    expect(added(bid, limits)).toEqual([{ kind: 'info', text: '5% bid bond ≈ $4,050 (est. $81K)' }]);
  });

  it('gives the bond for both ends of a range, and "up to" for a ceiling', () => {
    const range = testBid({ estValue: { min: 80_000, max: 120_000 }, flags: ['Bid bond'], description: FIVE_PCT });
    expect(texts(added(range, limits))).toEqual(['5% bid bond ≈ $4,000–$6,000 (est. $80K–$120K)']);
    const under = testBid({ estValue: { min: null, max: 250_000 }, flags: ['Bid bond'], description: FIVE_PCT });
    expect(texts(added(under, limits))).toEqual(['5% bid bond ≈ up to $12,500 (est. under $250K)']);
  });

  it('no percentage in the notice → the general note and no dollar figure', () => {
    for (const description of [NO_PCT, null]) {
      const bid = testBid({ estValue: point(81_000), flags: ['Bid bond'], description });
      expect(added(bid, limits)).toEqual([{ kind: 'info', text: BOND_NOTE }]);
      expect(texts(score(bid, limits).reasons).join(' ')).not.toMatch(/≈|\$4,050/);
    }
    expect(BOND_NOTE).toBe('Bid bond is often 5–10% of the bid — check the notice');
  });

  it('says nothing without a bid-bond flag, without an estimate, or when the bid is over the limit', () => {
    expect(added(testBid({ estValue: point(81_000), description: FIVE_PCT }), limits)).toEqual([]);
    expect(added(testBid({ estValue: point(81_000), flags: ['Performance/payment bond'], description: FIVE_PCT }), limits)).toEqual([]);
    expect(added(testBid({ flags: ['Bid bond'], description: FIVE_PCT }), limits)).toEqual([]);
    expect(texts(added(testBid({ estValue: point(900_000), flags: ['Bid bond'], description: FIVE_PCT }), limits))).toEqual([
      'Est. $900K — over your $500K job limit',
    ]);
  });

  it('any spend limit switches it on — the up-front limit too; a profile with none never sees it', () => {
    const bid = testBid({ estValue: point(81_000), flags: ['Bid bond'], description: FIVE_PCT });
    for (const some of [{ maxUpfront: 10_000 }, { bondingCapacity: 500_000 }, { maxJobSize: 81_000 }]) {
      expect(texts(added(bid, some)), JSON.stringify(some)).toEqual(['5% bid bond ≈ $4,050 (est. $81K)']);
    }
    expect(added(bid, undefined)).toEqual([]);
    expect(added(bid, { maxUpfront: null })).toEqual([]);
  });

  it('comes last, with the other notes', () => {
    const s = score(testBid({ estValue: point(81_000), flags: ['Bid bond', 'Prevailing wage'], description: FIVE_PCT }), limits);
    expect(s.reasons.at(-1)).toEqual({ kind: 'info', text: '5% bid bond ≈ $4,050 (est. $81K)' });
  });
});

describe('parseBidBondPct', () => {
  it.each([
    ['bid bond in the amount of five percent (5%)', 5],
    ['Bid security in an amount not less than ten percent (10%) of the bid is required.', 10],
    ['accompanied by a bid bond, cashier\'s check or certified check in the amount of 5% of the bid', 5],
    ['A bid guarantee of 20 percent of the bid price is required.', 20],
    ['The bid bond shall be equal to 7.5% of the total.', 7.5],
    ['Bid Bond: 5%', 5],
    ['A 5% bid bond is required.', 5],
    ['Five percent (5%) bid security must accompany each bid.', 5],
    ['Bid\n   bond in the   amount of 5 %', 5], // line breaks and stray spaces from the page
    ['A bid bond of 5% is required. Bid security of 5% may be a cashier\'s check.', 5], // two mentions that agree
    ['Bid bond of 5% and a performance bond of 100% are required.', 5],
  ])('reads %j as %d', (text, pct) => {
    expect(parseBidBondPct(text)).toBe(pct);
  });

  it.each([
    [null],
    [''],
    ['A bid bond is required.'],
    ['A bid bond is required and 10% retention will be withheld.'], // the figure is the retention
    ['A bid bond is required, and retention of 10% will be withheld.'],
    ['Bid bond is required. Retention is 5%.'], // another sentence
    ['A bid bond is required and a contingency of 10% is included.'],
    ['Performance bond in the amount of 100% of the contract.'],
    ['A bid bond and a payment bond of 50% are required.'], // the figure is the payment bond\'s
    ['Bid bond of 5% for schedule A; bid security of 10% for schedule B.'], // two figures: do not pick one
    ['Bid bond in the amount of 50% of the bid.'], // not a believable bid bond
    ['Bid bond in the amount of 0% of the bid.'],
    ['A bid bond in the amount of $5,000 is required.'],
    ['Bid bond in the amount of five percent of the bid.'], // words only: not parsed, and that is fine
  ])('does not guess from %j', (text) => {
    expect(parseBidBondPct(text)).toBeNull();
  });
});

describe('real notices (Douglas County, captured 2026-11-13)', () => {
  // The raw page has no Open/Close stamps, so the parser needs the capture day to tell them apart.
  const bids = parseDouglasRfp(fx('douglas-rfp.html'), { includeClosed: true, now: CAPTURED }).map(finalizeBid);
  const plc = bids.find((b) => b.id === 'douglascounty:jobs_peak_w_t_p_p_l_c_replacement_project')!;
  // These three are closed, so score them the week their ads ran.
  const then = new Date('2026-07-01T20:00:00Z');

  it('reads the 5% bid bond out of the real legal ads, and guesses nothing from a bare "Bid Bond" form', () => {
    const bonded = bids.filter((b) => b.flags.includes('Bid bond'));
    expect(bonded).toHaveLength(5);
    // Two ads state the figure (the Jobs Peak PLC job and the Walley's / Genoa Lakes electrical work)…
    const stated = bonded.filter((b) => /Bid Bond in an amount not less than five percent \(5%\) of the bid/.test(b.description ?? ''));
    expect(stated.map((b) => b.id)).toEqual([
      'douglascounty:jobs_peak_w_t_p_p_l_c_replacement_project',
      'douglascounty:electrical_improvements_at_walley_s___genoa_lakes',
    ]);
    for (const b of stated) expect(parseBidBondPct(b.description), b.title).toBe(5);
    // …the other three only list a "Bid Bond.doc" among the bid documents: no percentage to read.
    for (const b of bonded.filter((x) => !stated.includes(x))) {
      expect(b.description, b.title).toMatch(/Bid Bond\.(doc|pdf)/);
      expect(parseBidBondPct(b.description), b.title).toBeNull();
    }
  });

  it('the $81,000 PLC replacement: bond math under a $100K limit, over the limit at $50K', () => {
    expect(plc.estValue).toEqual(point(81_000));
    const under = scoreBid(plc, testProfile('test-limits', { limits: { maxJobSize: 100_000 } }), then);
    expect(under.overLimit).toBe(false);
    expect(under.reasons).toContainEqual({ kind: 'info', text: '5% bid bond ≈ $4,050 (est. $81K)' });

    const over = scoreBid(plc, testProfile('test-limits', { limits: { maxJobSize: 50_000 } }), then);
    expect(over.overLimit).toBe(true);
    expect(over.reasons).toContainEqual({ kind: 'minus', text: 'Est. $81K — over your $50K job limit' });
    expect(texts(over.reasons).join(' ')).not.toContain('≈');
    expect(over.score).toBe(under.score);

    const bonding = scoreBid(plc, testProfile('test-limits', { limits: { bondingCapacity: 50_000 } }), then);
    expect(bonding.overLimit).toBe(true);
    expect(bonding.reasons).toContainEqual({ kind: 'minus', text: 'Bond required — est. $81K is over your $50K bonding capacity' });
  });

  it('the pilot profile, which sets no limits, scores every real bid exactly as the fit alone', () => {
    const quest = parseQuestJson(JSON.parse(fx('questcdn-spwd.json')), QUEST_BOARDS[0]!).map(finalizeBid);
    expect(pilot.limits).toBeUndefined();
    for (const b of [...quest, ...bids]) expect(scoreBid(b, pilot, NOW), b.id).toEqual(scoreFit(b, pilot, NOW));
    // The v0 scores for the 13 State Public Works bids, in board order, on the day that JSON was captured
    // (2026-11-11 = NOW; it is the one fixture the 2026-11-13 re-capture did not replace).
    expect(quest.map((b) => scoreBid(b, pilot, NOW).score)).toEqual([7, 7, 7, 77, 40, 82, 27, 2, 53, 53, 0, 0, 7]);
    // No estimates on that board, so even a $1 limit changes nothing there.
    const strict = testProfile('lm-electric', { limits: { maxJobSize: 1, bondingCapacity: 1 } });
    for (const b of quest) expect(scoreBid(b, strict, NOW), b.id).toEqual(scoreFit(b, pilot, NOW));
  });
});

// ------------------------------------------------------------ properties --

const TITLE_WORDS = [
  'Electrical', 'Lighting', 'Panel', 'Generator', 'Fire Alarm', 'Roofing', 'Janitorial', 'HVAC', 'Paving', 'Upgrade',
  'Renovation', 'Replacement', 'Services', 'School', 'Museum', 'Plumbing', 'Conduit', 'Improvements',
];
const money = fc.integer({ min: 500, max: 6_000_000 });
const arbEstimate: fc.Arbitrary<Bid['estValue']> = fc.oneof(
  fc.constant(null),
  money.map(point),
  fc.tuple(money, money).map(([a, b]) => ({ min: Math.min(a, b), max: Math.max(a, b) })),
  money.map((v) => ({ min: null, max: v })),
  money.map((v) => ({ min: v, max: null })),
);

/** Any bid the scorer might meet: every trade, place, deadline, estimate shape and flag. All synthetic. */
const arbBid: fc.Arbitrary<Bid> = fc
  .record({
    title: fc.array(fc.constantFrom(...TITLE_WORDS), { minLength: 1, maxLength: 4 }).map((w) => `TEST ${w.join(' ')} (synthetic)`),
    category: fc.constantFrom(null, 'Electrical Installation', 'Roofing', 'Miscellaneous'),
    description: fc.constantFrom(null, FIVE_PCT, NO_PCT, 'TEST notice (synthetic). Bid bond of 5% for schedule A; bid security of 10% for schedule B.'),
    location: fc.constantFrom<Bid['location'] | object>(
      { city: 'Carson City', state: 'NV' }, { city: 'Minden', state: 'NV' }, { city: 'Reno', state: 'NV' },
      { city: 'North Las Vegas', state: 'NV' }, { county: 'Lyon', state: 'NV' }, { state: 'NV' }, { state: 'TX' }, {},
    ),
    dueAt: fc.oneof(fc.constant(null), fc.integer({ min: -120, max: 1440 }).map((h) => new Date(NOW.getTime() + h * 3_600_000).toISOString())),
    estValue: arbEstimate,
    naics: fc.constantFrom(null, '238210', '236220', '561720'),
    setAside: fc.constantFrom(null, 'SBA', 'SDVOSBC', '8A'),
    flags: fc.subarray(['Bid bond', 'Performance/payment bond', 'Prevailing wage', 'Mandatory pre-bid', 'May be supply-only']),
  })
  .map((d) => testBid(d));

const arbLimit = fc.oneof(fc.constant(undefined), fc.constant(null), fc.integer({ min: 1, max: 7_000_000 }));
const arbLimits: fc.Arbitrary<SpendLimits> = fc.record({ maxJobSize: arbLimit, maxUpfront: arbLimit, bondingCapacity: arbLimit });
const arbNoLimits = fc.constantFrom<SpendLimits | undefined>(
  undefined, {}, { maxJobSize: null }, { maxJobSize: null, maxUpfront: null, bondingCapacity: null }, { maxJobSize: 0, bondingCapacity: 0 },
);

const OVER = /— over your \$[\d,.]+[KM]? job limit$|is over your \$[\d,.]+[KM]? bonding capacity$/;

describe('properties (fast-check)', () => {
  it('adding limits never raises a score — it never changes the score, verdict, rejection or distance at all', () => {
    fc.assert(
      fc.property(arbBid, arbLimits, (bid, limits) => {
        const before = scoreBid(bid, pilot, NOW);
        const after = score(bid, limits);
        expect(after.score).toBeLessThanOrEqual(before.score);
        expect({ ...after, reasons: [], overLimit: false }).toEqual({ ...before, reasons: [] });
      }),
      { numRuns: 500 },
    );
  });

  it('a profile with no limits gets exactly the fit, for any bid', () => {
    fc.assert(
      fc.property(arbBid, arbNoLimits, (bid, none) => {
        const s = score(bid, none);
        expect(s).toEqual(scoreFit(bid, pilot, NOW));
        expect(s.overLimit).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it('overLimit always comes with a reason that says which limit, and never without one', () => {
    fc.assert(
      fc.property(arbBid, arbLimits, (bid, limits) => {
        const s = score(bid, limits);
        const said = s.reasons.filter((r) => OVER.test(r.text));
        expect(said.length > 0).toBe(s.overLimit);
        expect(said.every((r) => r.kind === 'minus')).toBe(true);
        if (s.overLimit) expect(bid.estValue?.min ?? bid.estValue?.max).toEqual(expect.any(Number));
      }),
      { numRuns: 500 },
    );
  });

  it('limits only add reasons: the fit\'s reasons all stay, in order', () => {
    fc.assert(
      fc.property(arbBid, arbLimits, (bid, limits) => {
        const fit = texts(scoreFit(bid, pilot, NOW).reasons);
        const all = texts(score(bid, limits).reasons);
        expect(all.filter((t) => fit.includes(t))).toEqual(fit);
        expect(all.length - fit.length).toBeLessThanOrEqual(3); // job limit, bonding, bond note
      }),
      { numRuns: 300 },
    );
  });

  it('a tighter limit never brings a bid back: over at $L means over at every smaller limit', () => {
    fc.assert(
      fc.property(arbBid, fc.integer({ min: 2, max: 7_000_000 }), fc.integer({ min: 1, max: 7_000_000 }), (bid, a, b) => {
        const [tight, loose] = a < b ? [a, b] : [b, a];
        for (const key of ['maxJobSize', 'bondingCapacity'] as const) {
          if (score(bid, { [key]: loose }).overLimit) expect(score(bid, { [key]: tight }).overLimit).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a dollar figure for the bond appears only when the notice states one percentage', () => {
    fc.assert(
      fc.property(arbBid, arbLimits, (bid, limits) => {
        const all = texts(score(bid, limits).reasons);
        const math = all.filter((t) => t.includes('bid bond ≈'));
        if (math.length > 0) {
          expect(parseBidBondPct(bid.description)).not.toBeNull();
          expect(bid.flags).toContain('Bid bond');
          expect(all).not.toContain(BOND_NOTE);
        }
        expect(math.length).toBeLessThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });
});
