/**
 * Search, filters and sorts on GET /api/feed, against an in-memory database holding the 13 real
 * NV State Public Works bids (captured QuestCDN page) plus six synthetic TEST- bids: the real board
 * lists no estimates, so the value ranges have to come from made-up, clearly labelled ones.
 *
 * Expected results are worked out here in plain JavaScript over the unfiltered list, never by
 * asking the SQL under test.
 */
import fc from 'fast-check';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { getFeed, recordSwipe, undoSwipe, upsertBids } from '../src/db/repo.js';
import { parseFeedQuery } from '../src/routes/feed.js';
import { runScan, scoreProfile } from '../src/scan.js';
import { buildServer } from '../src/server.js';
import type { Bid, FeedItem } from '../src/types.js';
import { accountsConfig, fakeAuth, memoryDb, NOW, questSource, scanCtx, testBid, testProfile } from './helpers.js';

/** A simulated shop with a $500K job limit, so one TEST bid lands over it. */
const profile = testProfile('test-feed-filters', { limits: { maxJobSize: 500_000 } });

const point = (v: number) => ({ min: v, max: v });
const EXTRA = {
  v30k: testBid({ sourceId: 'TEST-v-30k', estValue: point(30_000) }),
  vRange: testBid({ sourceId: 'TEST-v-range', estValue: { min: 80_000, max: 120_000 } }),
  vUnder: testBid({ sourceId: 'TEST-v-under', estValue: { min: null, max: 250_000 } }),
  vBig: testBid({ sourceId: 'TEST-v-big', estValue: point(1_200_000) }), // over the $500K limit
  numbered: testBid({
    source: 'ngem', sourceId: 'TEST-ngem-1', solNumber: 'TEST-SOL-777', agency: 'TEST Water District (synthetic)',
    description: 'TEST notice (synthetic): replace the switchgear at pump station 4.',
    location: { city: 'Minden', state: 'NV' }, postedAt: '2026-11-10T16:00:00.000Z', dueAt: null,
  }),
  wild: testBid({
    sourceId: 'TEST-wild', title: 'TEST 100% LED conduit_run upgrade (synthetic)',
    location: { city: 'Reno', state: 'NV' }, dueAt: '2026-11-13T22:00:00.000Z',
  }),
} satisfies Record<string, Bid>;

let db: Db;
let app: FastifyInstance;
let all: FeedItem[]; // every open bid for the profile, unfiltered

beforeAll(async () => {
  db = await memoryDb();
  await runScan({ db, sources: [questSource()], profiles: [profile], ctx: scanCtx() });
  await upsertBids(db, Object.values(EXTRA), NOW);
  await scoreProfile(db, profile, NOW);
  app = await buildServer({ db, profile }, { now: () => NOW });
  all = await getFeed(db, profile.id, { minScore: 0, limit: 300, includeSwiped: true, now: NOW });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const url = (qs: string) => `/api/feed?${qs}`;
/** Browse view (all=1, every score) with extra parameters. Must answer 200. */
async function browse(qs = ''): Promise<FeedItem[]> {
  const res = await app.inject(url(`all=1&minScore=0&limit=300${qs && `&${qs}`}`));
  expect(res.statusCode, `${qs} → ${res.body}`).toBe(200);
  return res.json().items as FeedItem[];
}
const ids = (items: FeedItem[]) => items.map((b) => b.id);
const sorted = (list: string[]) => [...list].sort();
/** The filter under test gives exactly the bids this plain-JS test picks. */
async function expectFilter(qs: string, keep: (b: FeedItem) => boolean): Promise<FeedItem[]> {
  const got = await browse(qs);
  expect(sorted(ids(got)), qs).toEqual(sorted(ids(all.filter(keep))));
  return got;
}
const top = (b: FeedItem) => b.estValue?.max ?? b.estValue?.min ?? null;
const hasValue = (b: FeedItem) => top(b) !== null;
const isTest = (b: FeedItem) => b.sourceId.startsWith('TEST-');

describe('the seeded feed', () => {
  it('holds the 13 real bids and the 6 synthetic ones, one of them over the limit', () => {
    expect(all).toHaveLength(19);
    expect(all.filter((b) => b.source === 'questcdn')).toHaveLength(13);
    expect(all.filter(isTest)).toHaveLength(6);
    expect(all.filter(hasValue).map((b) => b.id).sort()).toEqual([EXTRA.v30k.id, EXTRA.vBig.id, EXTRA.vRange.id, EXTRA.vUnder.id].sort());
    expect(all.filter((b) => b.overLimit).map((b) => b.id)).toEqual([EXTRA.vBig.id]);
  });

  it('with no parameters it is still the swipe deck: unswiped, score ≥ 35, under the limits, best fit first', async () => {
    const res = await app.inject('/api/feed');
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(['counts', 'items', 'lastScan', 'total']);
    const deck = res.json().items as FeedItem[];
    expect(res.json().total).toBe(deck.length); // one page holds the whole deck here
    expect(sorted(ids(deck))).toEqual(sorted(ids(all.filter((b) => b.score >= 35 && !b.overLimit))));
    expect(deck.length).toBeGreaterThanOrEqual(5);
    expect(deck.map((b) => b.score)).toEqual(deck.map((b) => b.score).sort((a, b) => b - a));
    expect(Date.parse(res.json().lastScan)).not.toBeNaN();
  });

  it('blank parameters mean "not given"', async () => {
    const plain = (await app.inject('/api/feed')).json().items as FeedItem[];
    const blank = await app.inject(url('q=&minValue=&maxValue=&hasValue=&maxDistance=&dueWithinDays=&source=&verdict=&sort=&overLimit=&minScore=&limit=&all='));
    expect(blank.statusCode).toBe(200);
    expect(ids(blank.json().items)).toEqual(ids(plain));
  });
});

describe('q — search', () => {
  it('finds words in the title, in any case', async () => {
    const got = await expectFilter('q=ROOFING', (b) => /roofing/i.test(b.title));
    expect(got).toHaveLength(4); // the four real roofing replacements
    expect(ids(await browse('q=rOoFiNg'))).toEqual(ids(got));
  });

  it('finds words in the agency', async () => {
    expect(await expectFilter('q=public+works', (b) => b.agency === 'Nevada State Public Works Division')).toHaveLength(13);
    expect(ids(await browse('q=water+district'))).toEqual([EXTRA.numbered.id]);
  });

  it('finds words in the description', async () => {
    const got = await browse('q=JP+Engineering');
    expect(got.map((b) => b.id)).toEqual(['questcdn:1903611:10391457']); // the Yerington fire sprinkler job
    expect(got[0]!.title).not.toMatch(/JP Engineering/i);
    expect(ids(await browse('q=switchgear'))).toEqual([EXTRA.numbered.id]);
  });

  it('finds a bid by its number: the solicitation number, or the board\'s own number', async () => {
    expect(ids(await browse('q=test-sol-777'))).toEqual([EXTRA.numbered.id]);
    expect(ids(await browse('q=10385980'))).toEqual(['questcdn:1903611:10385980']);
    expect(ids(await browse('q=TEST-v-range'))).toEqual([EXTRA.vRange.id]);
  });

  it('finds a bid by its town or its category, even when the title names neither', async () => {
    const inSparks = await expectFilter('q=sparks', (b) => b.location.label === 'Sparks, NV');
    expect(inSparks).toHaveLength(1);
    expect(inSparks[0]!.title).toMatch(/^Building 8 Exiting Upgrade/);
    expect(inSparks[0]!.title).not.toMatch(/sparks/i);
    // The board files the cell-door job under "Electrical Installation/Construction"; its title never says electrical.
    const filed = await browse('q=electrical+installation');
    expect(filed).toHaveLength(1);
    expect(filed[0]!.title).toMatch(/^Replace Cell Doors/);
    expect(filed[0]!.category).toMatch(/^Electrical Installation/);
    expect(await expectFilter('q=carson+city', (b) => b.location.label === 'Carson City, NV' || /carson city/i.test(b.title))).not.toHaveLength(0);
  });

  it('every word has to match, in any field and any order', async () => {
    const got = await browse('q=museum+roofing');
    expect(got).toHaveLength(1);
    expect(got[0]!.title).toMatch(/^Roofing Replacement, State Museum/);
    expect(ids(await browse('q=switchgear+water'))).toEqual([EXTRA.numbered.id]); // description + agency
    expect(await browse('q=roofing+switchgear')).toEqual([]);
    expect(await browse('q=TEST-no-such-word')).toEqual([]);
  });

  it('treats % _ and \\ as plain characters, not wildcards', async () => {
    expect(ids(await browse(`q=${encodeURIComponent('100%')}`))).toEqual([EXTRA.wild.id]);
    expect(ids(await browse(`q=${encodeURIComponent('%')}`))).toEqual([EXTRA.wild.id]);
    expect(ids(await browse('q=conduit_run'))).toEqual([EXTRA.wild.id]);
    expect(ids(await browse('q=_'))).toEqual([EXTRA.wild.id]); // "_" would match every bid as a wildcard
    expect(await browse('q=conduit_ru_')).toEqual([]);
    expect(await browse(`q=${encodeURIComponent('\\')}`)).toEqual([]);
    expect(await browse(`q=${encodeURIComponent('r%f')}`)).toEqual([]); // not "roofing"
  });

  it('search text is only ever data', async () => {
    for (const hostile of ["'; drop table bids; --", "' or '1'='1", '") or true --', '{a,b}', '"quoted"', 'a,b', '$1', '\u0000roofing', '🔌']) {
      const got = await browse(`q=${encodeURIComponent(hostile)}`);
      expect(got.length, hostile).toBeLessThan(all.length);
    }
    expect(await browse()).toHaveLength(19); // the table is still there
    expect(await browse(`q=${encodeURIComponent('\u0000roofing')}`)).toHaveLength(4); // control characters are dropped
  });

  it('agrees with a plain-JS search for any words', async () => {
    const haystack = (b: FeedItem) =>
      [b.title, b.agency, b.description, b.category, b.location.label, b.solNumber, b.sourceId].filter((s) => s != null).join(' ').toLowerCase();
    const word = fc.oneof(
      fc.constantFrom('roofing', 'Museum', 'TEST', 'synthetic', 'carson', 'fire', 'Quest', '104', 'design:', 'e', 'upgrade', '(25', '%', '_', '&'),
      fc.string({ minLength: 1, maxLength: 4 }).filter((s) => !/[\s\u0000-\u001f\u007f]/.test(s)),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(word, { minLength: 1, maxLength: 3 }), async (words) => {
        const got = await browse(`q=${encodeURIComponent(words.join(' '))}`);
        const want = all.filter((b) => words.every((w) => haystack(b).includes(w.toLowerCase())));
        expect(sorted(ids(got))).toEqual(sorted(ids(want)));
      }),
      { numRuns: 60 },
    );
  });
});

describe('minValue / maxValue / hasValue', () => {
  const { v30k, vRange, vUnder, vBig } = EXTRA;
  const valued = async (qs: string) => sorted(ids((await browse(qs)).filter(hasValue)));
  const unknown = (items: FeedItem[]) => items.filter((b) => !hasValue(b));

  it('keeps bids whose estimate range overlaps the asked range', async () => {
    expect(await valued('minValue=50000')).toEqual(sorted([vRange.id, vUnder.id, vBig.id]));
    expect(await valued('maxValue=50000')).toEqual(sorted([v30k.id, vUnder.id])); // "under $250K" may be under $50K
    expect(await valued('minValue=90000&maxValue=110000')).toEqual(sorted([vRange.id, vUnder.id])); // inside $80K–$120K
    expect(await valued('minValue=130000&maxValue=200000')).toEqual([vUnder.id]);
    expect(await valued('minValue=300000')).toEqual([vBig.id]);
    expect(await valued('minValue=2000000')).toEqual([]);
    expect(await valued('minValue=10000&maxValue=50000')).toEqual(sorted([v30k.id, vUnder.id]));
  });

  it('both ends are inclusive', async () => {
    expect(await valued('minValue=120000&maxValue=125000')).toEqual(sorted([vRange.id, vUnder.id]));
    expect(await valued('minValue=120001&maxValue=125000')).toEqual([vUnder.id]);
    expect(await valued('maxValue=30000')).toEqual(sorted([v30k.id, vUnder.id]));
    expect(await valued('maxValue=29999')).toEqual([vUnder.id]);
    expect(await valued('minValue=250000&maxValue=250000')).toEqual([vUnder.id]);
    expect(await valued('minValue=250001')).toEqual([vBig.id]);
  });

  it('bids with no estimate are kept unless hasValue=1', async () => {
    const fifteen = unknown(all);
    expect(fifteen).toHaveLength(15);
    for (const qs of ['minValue=50000', 'maxValue=50000', 'minValue=90000&maxValue=110000', 'minValue=2000000', 'hasValue=0']) {
      expect(sorted(ids(unknown(await browse(qs)))), qs).toEqual(sorted(ids(fifteen)));
    }
    expect(sorted(ids(await browse('hasValue=1')))).toEqual(sorted([v30k.id, vRange.id, vUnder.id, vBig.id]));
    expect(sorted(ids(await browse('hasValue=1&minValue=50000')))).toEqual(sorted([vRange.id, vUnder.id, vBig.id]));
    expect(await browse('hasValue=1&minValue=2000000')).toEqual([]);
  });

  it('agrees with a plain-JS overlap test for any range', async () => {
    const dollars = fc.integer({ min: 0, max: 1_500_000 });
    await fc.assert(
      fc.asyncProperty(fc.option(dollars, { nil: undefined }), fc.option(dollars, { nil: undefined }), fc.boolean(), async (a, b, only) => {
        const [lo, hi] = a !== undefined && b !== undefined && a > b ? [b, a] : [a, b];
        const qs = [lo !== undefined && `minValue=${lo}`, hi !== undefined && `maxValue=${hi}`, only && 'hasValue=1'].filter(Boolean).join('&');
        await expectFilter(qs, (bid) => {
          if (!hasValue(bid)) return !only;
          const est = bid.estValue!;
          return (lo === undefined || (est.max ?? Infinity) >= lo) && (hi === undefined || (est.min ?? 0) <= hi);
        });
      }),
      { numRuns: 50 },
    );
  });
});

describe('maxDistance', () => {
  it('keeps bids within that many miles and drops the ones with no known distance', async () => {
    const near = await expectFilter('maxDistance=20', (b) => b.distanceMi !== null && b.distanceMi <= 20);
    expect(near.length).toBeGreaterThanOrEqual(8); // Carson City (15 mi) and Minden
    expect(near.every((b) => b.distanceMi !== null)).toBe(true);
    const unknown = all.filter((b) => b.distanceMi === null);
    expect(unknown.map((b) => b.title)).toEqual([expect.stringMatching(/Lahontan State Park/)]); // real bid, no town on the board
    await expectFilter('maxDistance=41', (b) => b.distanceMi !== null && b.distanceMi <= 41); // inclusive: Reno is 41 mi
    await expectFilter('maxDistance=40.5', (b) => b.distanceMi !== null && b.distanceMi <= 40.5);
    await expectFilter('maxDistance=10000', (b) => b.distanceMi !== null);
    const closest = Math.min(...all.flatMap((b) => (b.distanceMi === null ? [] : [b.distanceMi])));
    await expectFilter(`maxDistance=${closest}`, (b) => b.distanceMi === closest);
    expect(await browse('maxDistance=0')).toEqual([]);
  });
});

describe('dueWithinDays', () => {
  const dueWithin = (days: number) => (b: FeedItem) => b.dueAt !== null && Date.parse(b.dueAt) <= NOW.getTime() + days * 86_400_000;

  it('keeps bids due by then and drops the ones with no deadline', async () => {
    const week = await expectFilter('dueWithinDays=7', dueWithin(7));
    // Real board: three due Nov 17 and two on Nov 18 before noon Pacific; the 2 PM one misses a 7-day cut by two hours.
    expect(week.filter((b) => b.source === 'questcdn')).toHaveLength(5);
    expect(ids(week)).toContain(EXTRA.wild.id);
    expect(ids(week)).not.toContain('questcdn:1903611:10385980');
    expect(ids(week)).not.toContain(EXTRA.numbered.id); // no deadline
    await expectFilter('dueWithinDays=7.1', dueWithin(7.1));
    expect(ids(await browse('dueWithinDays=7.1'))).toContain('questcdn:1903611:10385980');
    await expectFilter('dueWithinDays=2.5', dueWithin(2.5));
    await expectFilter('dueWithinDays=3650', (b) => b.dueAt !== null);
    expect(await browse('dueWithinDays=0')).toEqual([]);
  });
});

describe('source and verdict', () => {
  it('source takes one id or a comma list', async () => {
    expect(await expectFilter('source=questcdn', (b) => b.source === 'questcdn')).toHaveLength(13);
    expect(ids(await browse('source=ngem'))).toEqual([EXTRA.numbered.id]);
    expect(await expectFilter('source=ngem,samgov', isTest)).toHaveLength(6);
    expect(await expectFilter('source=NGEM,+samgov+,', isTest)).toHaveLength(6); // case, spaces and a stray comma
    expect(await expectFilter('source=ngem&source=samgov', isTest)).toHaveLength(6); // repeated works too
    expect(await browse('source=douglascounty')).toEqual([]);
  });

  it('verdict takes one or a comma list', async () => {
    const great = await expectFilter('verdict=great', (b) => b.verdict === 'great');
    expect(great.length).toBeGreaterThanOrEqual(2);
    expect(great.every((b) => b.score >= 75)).toBe(true);
    await expectFilter('verdict=great,good', (b) => b.verdict === 'great' || b.verdict === 'good');
    await expectFilter('verdict=maybe', (b) => b.verdict === 'maybe');
    const skip = await expectFilter('verdict=skip', (b) => b.verdict === 'skip');
    expect(skip.length).toBeGreaterThanOrEqual(5);
    expect(await expectFilter('verdict=great,good,maybe,skip', () => true)).toHaveLength(19);
  });
});

describe('sort', () => {
  /** A list is ordered when no item should come before the one ahead of it. */
  const expectOrdered = <T>(items: T[], before: (a: T, b: T) => number) => {
    for (let i = 1; i < items.length; i++) expect(before(items[i - 1]!, items[i]!), `items ${i - 1} and ${i}`).toBeLessThanOrEqual(0);
  };
  const last = Number.MAX_SAFE_INTEGER;
  const due = (b: FeedItem) => (b.dueAt ? Date.parse(b.dueAt) : last);

  it('every sort returns the same 19 bids', async () => {
    for (const sort of ['fit', 'due', 'near', 'new', 'value']) expect(sorted(ids(await browse(`sort=${sort}`))), sort).toEqual(sorted(ids(all)));
  });

  it('fit (the default): best score first, then the sooner deadline', async () => {
    const items = await browse('sort=fit');
    expectOrdered(items, (a, b) => b.score - a.score || due(a) - due(b));
    expect(ids(await browse())).toEqual(ids(items));
    expect(items[0]!.score).toBe(Math.max(...all.map((b) => b.score)));
  });

  it('due: soonest deadline first, "no deadline" last', async () => {
    const items = await browse('sort=due');
    expectOrdered(items, (a, b) => due(a) - due(b) || b.score - a.score);
    expect(items[0]!.id).toBe(EXTRA.wild.id); // due in two days
    expect(items.at(-1)!.id).toBe(EXTRA.numbered.id); // no deadline
  });

  it('near: closest first, unknown distance last', async () => {
    const items = await browse('sort=near');
    expectOrdered(items, (a, b) => (a.distanceMi ?? last) - (b.distanceMi ?? last) || b.score - a.score);
    expect(items.at(-1)!.distanceMi).toBeNull();
    expect(items[0]!.distanceMi).toBe(Math.min(...all.flatMap((b) => (b.distanceMi === null ? [] : [b.distanceMi]))));
  });

  it('new: newest posting first; a bid with no posting date goes by when we first saw it', async () => {
    const items = await browse('sort=new');
    const posted = (b: FeedItem) => Date.parse(b.postedAt ?? b.firstSeenAt);
    // (First-sighting times differ by microseconds the API rounds away, so only the dates are compared here.)
    expectOrdered(items, (a, b) => posted(b) - posted(a));
    // The synthetic bids without a posting date were first seen just now, so they lead; the one posted Nov 10 follows.
    expect(items.slice(0, 5).every((b) => b.postedAt === null && isTest(b))).toBe(true);
    expect(items[5]!.id).toBe(EXTRA.numbered.id);
    // Among the real bids the board's own dates decide (Nov 5 first, Aug 20 last), then the better fit.
    const quest = items.filter((b) => b.source === 'questcdn');
    expect(quest[0]!.postedAt).toBe('2026-11-05T16:00:00.000Z');
    expect(quest.at(-1)!.postedAt).toBe('2026-08-20T15:00:00.000Z');
    expectOrdered(quest, (a, b) => posted(b) - posted(a) || b.score - a.score);
    expect(quest.filter((b) => b.postedAt === '2026-09-29T15:00:00.000Z')).toHaveLength(3); // so the tie-break is exercised
  });

  it('value: biggest estimate first, "not listed" last', async () => {
    const items = await browse('sort=value');
    expect(ids(items.slice(0, 4))).toEqual([EXTRA.vBig.id, EXTRA.vUnder.id, EXTRA.vRange.id, EXTRA.v30k.id]);
    expect(items.slice(4).every((b) => !hasValue(b))).toBe(true);
    expectOrdered(items, (a, b) => (top(b) ?? -1) - (top(a) ?? -1) || b.score - a.score);
  });

  it('the limit cuts after sorting, and the same query gives the same order every time', async () => {
    const two = (await app.inject(url('all=1&minScore=0&sort=value&limit=2'))).json().items as FeedItem[];
    expect(ids(two)).toEqual([EXTRA.vBig.id, EXTRA.vUnder.id]);
    for (const sort of ['fit', 'due', 'near', 'new', 'value']) {
      expect(ids(await browse(`sort=${sort}`)), sort).toEqual(ids(await browse(`sort=${sort}`)));
    }
  });
});

describe('overLimit', () => {
  const over = EXTRA.vBig.id;

  it('the deck never has over-limit bids; Browse keeps them, tagged', async () => {
    const deck = (await app.inject(url('minScore=0&limit=300'))).json().items as FeedItem[];
    expect(deck).toHaveLength(18);
    expect(ids(deck)).not.toContain(over);
    expect((await browse()).find((b) => b.id === over)).toMatchObject({ overLimit: true, score: expect.any(Number) });
    expect((await browse()).find((b) => b.id === over)!.reasons).toContainEqual({ kind: 'minus', text: 'Est. $1.2M — over your $500K job limit' });
  });

  it('overLimit=only lists just them; overLimit=exclude drops them from Browse', async () => {
    expect(ids(await browse('overLimit=only'))).toEqual([over]);
    await expectFilter('overLimit=exclude', (b) => !b.overLimit);
    expect(await browse('overLimit=exclude')).toHaveLength(18);
    // Without all=1 the same two values work on the unswiped bids.
    expect(ids((await app.inject(url('minScore=0&overLimit=only'))).json().items)).toEqual([over]);
    expect((await app.inject(url('minScore=0&limit=300&overLimit=exclude'))).json().items).toHaveLength(18);
  });

  it('in the repo, overLimit wins over the older hideOverLimit switch', async () => {
    const q = { minScore: 0, limit: 300, now: NOW };
    expect(await getFeed(db, profile.id, { ...q, hideOverLimit: true })).toHaveLength(18);
    expect(await getFeed(db, profile.id, { ...q })).toHaveLength(19);
    expect(ids(await getFeed(db, profile.id, { ...q, hideOverLimit: true, overLimit: 'only' }))).toEqual([over]);
    expect(await getFeed(db, profile.id, { ...q, hideOverLimit: true, overLimit: 'include' })).toHaveLength(19);
  });
});

describe('filters together', () => {
  it('every filter narrows the others', async () => {
    const got = await expectFilter(
      // The elevator modernizations score as another trade's work (config/lm-electric.json lists "elevator*"
      // under otherTrades), so they are "skip" bids: asking for great + skip still finds both.
      'source=questcdn&verdict=great,skip&maxDistance=20&dueWithinDays=30&q=elevator',
      (b) => b.source === 'questcdn' && (b.verdict === 'great' || b.verdict === 'skip') && b.distanceMi !== null && b.distanceMi <= 20 &&
        b.dueAt !== null && Date.parse(b.dueAt) <= NOW.getTime() + 30 * 86_400_000 && /elevator/i.test(b.title),
    );
    expect(got.map((b) => b.title)).toEqual([expect.stringMatching(/^Elevator Modernization/), expect.stringMatching(/^Elevator Modernization/)]);
    await expectFilter('hasValue=1&maxValue=200000&overLimit=exclude&source=samgov', (b) => hasValue(b) && !b.overLimit && (b.estValue!.min ?? 0) <= 200_000);
    expect(await browse('source=questcdn&hasValue=1')).toEqual([]);
  });

  it('swiped bids leave the deck but stay in Browse, with the filters applied either way', async () => {
    await recordSwipe(db, profile.id, EXTRA.v30k.id, 'pass');
    try {
      const deck = (await app.inject(url('minScore=0&hasValue=1'))).json().items as FeedItem[];
      expect(sorted(ids(deck))).toEqual(sorted([EXTRA.vRange.id, EXTRA.vUnder.id]));
      expect(sorted(ids(await browse('hasValue=1&overLimit=exclude')))).toEqual(sorted([EXTRA.v30k.id, EXTRA.vRange.id, EXTRA.vUnder.id]));
      expect((await browse('q=TEST-v-30k'))[0]).toMatchObject({ swipe: 'pass' });
    } finally {
      await undoSwipe(db, profile.id, EXTRA.v30k.id);
    }
  });

  it('closed bids never show, whatever is asked', async () => {
    const later = await buildServer({ db, profile }, { now: () => new Date('2026-11-20T00:00:00Z') });
    const items = (await later.inject(url('all=1&minScore=0&limit=300&sort=due'))).json().items as FeedItem[];
    await later.close();
    expect(items.length).toBeLessThan(19);
    expect(items.every((b) => b.dueAt === null || b.dueAt > '2026-11-20')).toBe(true);
  });
});

describe('parameter checking', () => {
  const bad: Array<[qs: string, message: RegExp]> = [
    ['minScore=abc', /^minScore must be a number$/],
    ['minScore=1e2', /^minScore must be a number$/],
    ['limit=ten', /^limit must be a number$/],
    ['limit=0x10', /^limit must be a number$/],
    ['minValue=50k', /^minValue must be a number$/],
    [`maxValue=${encodeURIComponent('$5,000')}`, /^maxValue must be a number$/],
    ['maxValue=Infinity', /^maxValue must be a number$/],
    ['minValue=200&maxValue=100', /^minValue is more than maxValue$/],
    ['maxDistance=near', /^maxDistance must be a number$/],
    ['dueWithinDays=soon', /^dueWithinDays must be a number$/],
    ['dueWithinDays=NaN', /^dueWithinDays must be a number$/],
    ['source=craigslist', /^source: "craigslist" is not one of .*questcdn/],
    ['source=questcdn,craigslist', /^source: "craigslist" is not one of/],
    ['verdict=amazing', /^verdict: "amazing" is not one of great, good, maybe, skip$/],
    ['sort=price', /^sort: "price" is not one of fit, due, near, new, value$/],
    ['sort=fit&sort=due', /^sort was given more than once$/],
    ['overLimit=include', /^overLimit: "include" is not one of exclude, only$/],
    ['all=yes', /^all must be 1 or 0$/],
    ['hasValue=maybe', /^hasValue must be 1 or 0$/],
    ['q=a&q=b', /^q was given more than once$/],
    [`q=${'x'.repeat(201)}`, /^q is too long \(200 characters at most\)$/],
    ['minScore=1&minScore=2', /^minScore was given more than once$/],
  ];

  it.each(bad)('%s → 400 with a message', async (qs, message) => {
    const res = await app.inject(url(qs));
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; message: string };
    expect(Object.keys(body).sort()).toEqual(['error', 'message']);
    expect(body.error).toBe('invalid_query');
    expect(body.message).toMatch(message);
  });

  it('an unknown value is quoted back at most 40 characters long', async () => {
    const res = await app.inject(url(`sort=${'z'.repeat(500)}`));
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe(`sort: "${'z'.repeat(40)}" is not one of fit, due, near, new, value`);
  });

  it('numbers out of range are pulled into range instead of refused', async () => {
    const n = async (qs: string) => {
      const res = await app.inject(url(`all=1&${qs}`));
      expect(res.statusCode, qs).toBe(200);
      return (res.json().items as FeedItem[]).length;
    };
    expect(await n('minScore=-3&limit=300')).toBe(19); // → 0
    expect(await n('minScore=500&limit=300')).toBe(all.filter((b) => b.score >= 100).length); // → 100
    expect(await n('minScore=76.5&limit=300')).toBe(all.filter((b) => b.score >= 77).length); // scores are whole numbers
    expect(await n('minScore=0&limit=99999')).toBe(19); // → 300
    expect(await n('minScore=0&limit=2.9')).toBe(2);
    expect(await n('minScore=0&limit=0.4')).toBe(1);
    expect(await n('minScore=0&limit=-5')).toBe(19); // 0 or less → the default of 100, as before
    expect(await n('minScore=0&limit=0')).toBe(19);
    expect(await n('minScore=0&limit=300&minValue=-50&hasValue=1')).toBe(4);
    expect(await n(`minScore=0&limit=300&maxValue=${'9'.repeat(400)}&hasValue=1`)).toBe(4);
    expect(await n('minScore=0&limit=300&maxDistance=99999999')).toBe(18);
    expect(await n('minScore=0&limit=300&dueWithinDays=-1')).toBe(0);
    expect(await n('minScore=0&limit=300&dueWithinDays=99999')).toBe(18);
    expect(await n('minScore=+10&limit=300')).toBe(all.filter((b) => b.score >= 10).length); // "+10" decodes to " 10"
  });

  it('1/0 and true/false both work for the switches; unknown parameters are ignored', async () => {
    expect((await app.inject(url('all=true&minScore=0&limit=300'))).json().items).toHaveLength(19);
    expect((await app.inject(url('all=0&minScore=0&limit=300'))).json().items).toHaveLength(18);
    expect((await app.inject(url('all=1&minScore=0&hasValue=TRUE'))).json().items).toHaveLength(4);
    expect((await app.inject(url('all=1&minScore=0&limit=300&TEST-unknown=1&_=123'))).json().items).toHaveLength(19);
  });

  it('parseFeedQuery turns a full query string into a FeedQuery', () => {
    const parsed = parseFeedQuery({
      all: '1', minScore: '40', limit: '25', q: '  LED   retrofit ', minValue: '10000', maxValue: '50000', hasValue: '1',
      maxDistance: '30', dueWithinDays: '14', source: 'ngem, questcdn,ngem', verdict: ['great', 'good'], sort: 'DUE', overLimit: 'exclude',
    });
    expect(parsed).toEqual({
      ok: true,
      query: {
        minScore: 40, limit: 25, includeSwiped: true, overLimit: 'exclude', q: 'LED   retrofit', minValue: 10_000, maxValue: 50_000,
        hasValue: true, maxDistance: 30, dueWithinDays: 14, sources: ['ngem', 'questcdn'], verdicts: ['great', 'good'], sort: 'due',
      },
    });
    expect(parseFeedQuery({})).toEqual({
      ok: true,
      query: {
        minScore: 35, limit: 100, includeSwiped: false, overLimit: 'exclude', q: undefined, minValue: undefined, maxValue: undefined,
        hasValue: undefined, maxDistance: undefined, dueWithinDays: undefined, sources: undefined, verdicts: undefined, sort: undefined,
      },
    });
    expect(parseFeedQuery({ all: '1' })).toMatchObject({ ok: true, query: { includeSwiped: true, overLimit: 'include' } });
    expect(parseFeedQuery({ sort: 'price' })).toEqual({ ok: false, message: 'sort: "price" is not one of fit, due, near, new, value' });
  });

  it('whatever the query string, the answer is 200 or 400 — never a 500', async () => {
    const names = ['minScore', 'limit', 'offset', 'all', 'q', 'minValue', 'maxValue', 'hasValue', 'maxDistance', 'dueWithinDays', 'source', 'verdict', 'sort', 'overLimit'];
    const value = fc.oneof(
      fc.string({ maxLength: 12 }),
      fc.integer({ min: -1000, max: 5_000_000 }).map(String),
      fc.double({ noNaN: false }).map(String),
      fc.constantFrom('1', '0', 'true', '', ' ', 'fit', 'value', 'great,skip', 'questcdn', 'only', "';--", '%', '\\', '\u0000', '{}', '[]', '1e308', '-0', '0.0000001', '١٢٣'),
    );
    const pair = fc.tuple(fc.constantFrom(...names), value).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
    await fc.assert(
      fc.asyncProperty(fc.array(pair, { maxLength: 6 }), async (pairs) => {
        const res = await app.inject(url(pairs.join('&')));
        expect([200, 400], `${pairs.join('&')} → ${res.statusCode} ${res.body.slice(0, 200)}`).toContain(res.statusCode);
        if (res.statusCode === 400) expect(res.json()).toMatchObject({ error: 'invalid_query', message: expect.any(String) });
        else expect(Array.isArray(res.json().items)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('who you are is checked before what you asked: signed out gets 401 even with a bad query', async () => {
    const accounts = await buildServer({ db }, { config: accountsConfig(), auth: fakeAuth(null), now: () => NOW });
    const res = await accounts.inject(url('sort=price'));
    await accounts.close();
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'sign_in_required' });
  });
});
