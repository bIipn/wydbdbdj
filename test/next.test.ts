/**
 * The "next bid" pick. Unit tests use synthetic items (testBid: TEST- ids); the route tests run on
 * the 13 real NV State Public Works bids from the captured QuestCDN page.
 */
import fc from 'fast-check';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { upsertBids } from '../src/db/repo.js';
import { NEXT_MIN_SCORE, pickNext, urgencyBoost } from '../src/feed/next.js';
import { loadProfile } from '../src/profiles.js';
import { runScan, scoreProfile } from '../src/scan.js';
import { verdictFor } from '../src/score/score.js';
import { buildServer } from '../src/server.js';
import type { FeedItem } from '../src/types.js';
import { memoryDb, NOW, questSource, scanCtx, testBid, testProfile } from './helpers.js';

const DAY = 86_400_000;
const inDays = (days: number): string => new Date(NOW.getTime() + days * DAY).toISOString();

let seq = 0;
/** A feed item: a 90-point fit, 20 miles out, due in 30 days, unless overridden. */
function item(over: Partial<FeedItem> = {}): FeedItem {
  const score = over.score ?? 90;
  return {
    ...testBid({ sourceId: `TEST-next-${++seq}` }), score, verdict: verdictFor(score), reasons: [], distanceMi: 20, swipe: null,
    firstSeenAt: NOW.toISOString(), overLimit: false, dueAt: inDays(30), ...over,
  };
}
const pick = (items: FeedItem[]) => pickNext(items, NOW).item;

describe('urgencyBoost', () => {
  it('is 10 at two days out and fades to nothing at two weeks', () => {
    expect(urgencyBoost(2)).toBe(10);
    expect(urgencyBoost(8)).toBe(5);
    expect(urgencyBoost(11)).toBe(2.5);
    expect(urgencyBoost(14)).toBe(0);
    expect(urgencyBoost(60)).toBe(0);
  });

  it('gives nothing when it is too late to price the job, or there is no deadline', () => {
    expect(urgencyBoost(1.99)).toBe(0);
    expect(urgencyBoost(0.2)).toBe(0);
    expect(urgencyBoost(-3)).toBe(0);
    expect(urgencyBoost(null)).toBe(0);
  });

  it('stays within 0–10 and, from two days out, never grows as the deadline moves away', () => {
    fc.assert(
      fc.property(fc.double({ min: -30, max: 400, noNaN: true }), fc.double({ min: 0, max: 400, noNaN: true }), (d, gap) => {
        expect(urgencyBoost(d)).toBeGreaterThanOrEqual(0);
        expect(urgencyBoost(d)).toBeLessThanOrEqual(10);
        if (d >= 2) expect(urgencyBoost(d + gap)).toBeLessThanOrEqual(urgencyBoost(d));
      }),
    );
  });
});

describe('pickNext — ordering', () => {
  it('picks the best fit when the deadlines are alike', () => {
    const best = item({ score: 88 });
    expect(pick([item({ score: 60 }), best, item({ score: 87 })])).toBe(best);
  });

  it('a close but workable deadline lifts a bid over a slightly better fit that can wait', () => {
    const urgent = item({ score: 70, dueAt: inDays(3) }); // 70 + 9.2
    const canWait = item({ score: 75, dueAt: inDays(30) }); // 75 + 0
    expect(pick([canWait, urgent])).toBe(urgent);
  });

  it('urgency settles close calls only: more than 10 points better always wins', () => {
    const urgent = item({ score: 60, dueAt: inDays(2) }); // 60 + 10
    expect(pick([urgent, item({ score: 70, dueAt: inDays(30) })])).toBe(urgent); // level on rank: the sooner deadline wins
    const better = item({ score: 71, dueAt: inDays(30) });
    expect(pick([urgent, better])).toBe(better);
  });

  it('a deadline too close to work with gets no lift', () => {
    const tomorrow = item({ score: 70, dueAt: inDays(1) });
    const better = item({ score: 72, dueAt: inDays(30) });
    expect(pick([tomorrow, better])).toBe(better);
    // …but it is still a candidate while it is open, on its fit alone.
    expect(pick([tomorrow, item({ score: 69, dueAt: inDays(30) })])).toBe(tomorrow);
  });

  it('of two workable deadlines the sooner wins, score being equal', () => {
    const sooner = item({ score: 80, dueAt: inDays(4) });
    expect(pick([item({ score: 80, dueAt: inDays(9) }), sooner, item({ score: 80, dueAt: null })])).toBe(sooner);
  });

  it('a bid with no deadline can be picked, on fit alone', () => {
    const open = item({ score: 95, dueAt: null });
    expect(pick([open, item({ score: 80, dueAt: inDays(5) })])).toBe(open);
  });

  it('ties go to the sooner deadline, then the closer job, then the id', () => {
    const a = item({ score: 80, dueAt: inDays(40), distanceMi: 30 });
    const sooner = item({ score: 80, dueAt: inDays(20), distanceMi: 60 });
    expect(pick([a, sooner])).toBe(sooner);
    const closer = item({ score: 80, dueAt: inDays(40), distanceMi: 5 });
    expect(pick([a, closer, item({ score: 80, dueAt: inDays(40), distanceMi: null })])).toBe(closer);
    const first = item({ score: 80, dueAt: inDays(40), distanceMi: 30, id: 'samgov:TEST-a' });
    const second = item({ score: 80, dueAt: inDays(40), distanceMi: 30, id: 'samgov:TEST-b' });
    expect(pick([second, first])).toBe(first);
    expect(pick([first, second])).toBe(first);
  });
});

describe('pickNext — what it never picks', () => {
  const good = () => item({ score: 40 });

  it.each<[string, Partial<FeedItem>]>([
    ['a bid over the spend limit', { overLimit: true, score: 100 }],
    ['a bid already saved', { swipe: 'save', score: 100 }],
    ['a bid already passed on', { swipe: 'pass', score: 100 }],
    ['a bid already bid on', { swipe: 'bid', score: 100 }],
    ['a bid whose deadline has passed', { dueAt: inDays(-0.01), score: 100 }],
    ['a bid closing this very instant', { dueAt: NOW.toISOString(), score: 100 }],
    ['a bid under the deck\'s 35-point floor', { score: 34, dueAt: inDays(2) }],
    ['a rejected bid (score 0)', { score: 0 }],
  ])('%s', (_name, over) => {
    const excluded = item(over);
    expect(pickNext([excluded], NOW)).toEqual({ item: null, why: [] });
    const fallback = good();
    expect(pick([excluded, fallback])).toBe(fallback);
  });

  it('35 is in, as in the swipe deck', () => {
    expect(NEXT_MIN_SCORE).toBe(35);
    const edge = item({ score: 35 });
    expect(pick([edge])).toBe(edge);
  });

  it('nothing to pick from → { item: null, why: [] }', () => {
    expect(pickNext([], NOW)).toEqual({ item: null, why: [] });
  });
});

describe('pickNext — why', () => {
  const plus = (text: string) => ({ kind: 'plus' as const, text });

  it('leads with the fit, then the deadline when it helped, then the bid\'s own plus points', () => {
    const it1 = item({
      score: 82, dueAt: inDays(6.5),
      reasons: [plus('Electrical scope: “lighting”'), plus('15 mi from Gardnerville, NV'), { kind: 'minus', text: 'TEST minus' }, { kind: 'info', text: 'Prevailing wage' }],
    });
    expect(pickNext([it1], NOW).why).toEqual(['Great fit — 82 out of 100', 'Due in 6 days — soon, but still time to bid', 'Electrical scope: “lighting”']);
  });

  it('leaves the deadline out when it gave no lift', () => {
    const far = item({ score: 60, dueAt: inDays(30), reasons: [plus('Electrical scope: “panel”'), plus('30 days to bid'), plus('TEST third plus')] });
    expect(pickNext([far], NOW).why).toEqual(['Good fit — 60 out of 100', 'Electrical scope: “panel”', '30 days to bid']);
    const tight = item({ score: 40, dueAt: inDays(0.5), reasons: [{ kind: 'minus', text: 'Due within 24 hours' }] });
    expect(pickNext([tight], NOW).why).toEqual(['Maybe a fit — 40 out of 100']);
  });

  it('counts whole days left, and never gives more than three lines', () => {
    const two = item({ score: 50, dueAt: inDays(2.9), reasons: Array.from({ length: 6 }, (_, i) => plus(`TEST plus ${i}`)) });
    expect(pickNext([two], NOW).why).toEqual(['Maybe a fit — 50 out of 100', 'Due in 2 days — soon, but still time to bid', 'TEST plus 0']);
    const thirteen = item({ score: 50, dueAt: inDays(13.99) });
    expect(pickNext([thirteen], NOW).why).toEqual(['Maybe a fit — 50 out of 100', 'Due in 13 days — soon, but still time to bid']);
  });
});

describe('pickNext — properties (fast-check)', () => {
  const arbItem: fc.Arbitrary<FeedItem> = fc
    .record({
      score: fc.integer({ min: 0, max: 100 }),
      dueAt: fc.oneof(fc.constant(null), fc.double({ min: -5, max: 60, noNaN: true }).map(inDays)),
      distanceMi: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 90 })),
      swipe: fc.constantFrom(null, null, null, 'save' as const, 'pass' as const, 'bid' as const),
      overLimit: fc.boolean(),
    })
    .map((o) => item(o));
  const eligible = (i: FeedItem) => !i.swipe && !i.overLimit && i.score >= 35 && (i.dueAt === null || Date.parse(i.dueAt) > NOW.getTime());
  const rank = (i: FeedItem) => i.score + urgencyBoost(i.dueAt === null ? null : (Date.parse(i.dueAt) - NOW.getTime()) / DAY);

  it('the pick is always eligible, has the top rank, and comes with 1–3 reasons', () => {
    fc.assert(
      fc.property(fc.array(arbItem, { maxLength: 12 }), (items) => {
        const { item: picked, why } = pickNext(items, NOW);
        const pool = items.filter(eligible);
        if (pool.length === 0) {
          expect({ picked, why }).toEqual({ picked: null, why: [] });
          return;
        }
        expect(pool).toContain(picked);
        expect(rank(picked!)).toBe(Math.max(...pool.map(rank)));
        expect(why.length).toBeGreaterThanOrEqual(1);
        expect(why.length).toBeLessThanOrEqual(3);
        expect(why[0]).toMatch(/^(Great|Good|Maybe a) fit — \d+ out of 100$/);
      }),
      { numRuns: 300 },
    );
  });

  it('the order the feed arrives in does not change the pick', () => {
    fc.assert(
      fc.property(fc.array(arbItem, { minLength: 1, maxLength: 10 }), (items) => {
        const expected = pickNext(items, NOW).item?.id ?? null;
        expect(pickNext([...items].reverse(), NOW).item?.id ?? null).toBe(expected);
        expect(pickNext([...items].sort((a, b) => a.score - b.score), NOW).item?.id ?? null).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it('a better fit never loses its place: raise the pick\'s score and it is still the pick', () => {
    fc.assert(
      fc.property(fc.array(arbItem, { minLength: 1, maxLength: 10 }), fc.integer({ min: 1, max: 30 }), (items, more) => {
        const picked = pickNext(items, NOW).item;
        if (!picked) return;
        const raised = items.map((i) => (i === picked ? { ...i, score: Math.min(100, i.score + more) } : i));
        expect(pickNext(raised, NOW).item?.id).toBe(picked.id);
      }),
      { numRuns: 200 },
    );
  });

  it('never picks a bid that scores more than 10 points below another candidate', () => {
    fc.assert(
      fc.property(fc.array(arbItem, { minLength: 1, maxLength: 12 }), (items) => {
        const picked = pickNext(items, NOW).item;
        if (picked) expect(picked.score).toBeGreaterThanOrEqual(Math.max(...items.filter(eligible).map((i) => i.score)) - 10);
      }),
      { numRuns: 200 },
    );
  });
});

describe('GET /api/next', () => {
  const pilot = loadProfile('lm-electric');
  /** A simulated shop whose $20K job limit puts the synthetic $30K job out of reach. */
  const capped = testProfile('test-next-capped', { limits: { maxJobSize: 20_000 } });
  const CELL_DOORS = 'questcdn:1903611:10385980'; // 82: electrical, Carson City, due Nov 18
  const SPRINKLER = 'questcdn:1903611:10391457'; // 77: fire alarm, Yerington, due Nov 18
  // Close electrical work in the pilot's price range: the best bid in the feed unless a limit says no.
  const lighting = testBid({ sourceId: 'TEST-next-30k', title: 'TEST lighting retrofit (synthetic)', estValue: { min: 30_000, max: 30_000 } });

  let db: Db;
  let app: FastifyInstance;
  let cappedApp: FastifyInstance;
  const next = async (a: FastifyInstance = app) => (await a.inject('/api/next')).json() as { item: FeedItem | null; why: string[] };
  const swipe = (bidId: string, action: string) => app.inject({ method: 'POST', url: '/api/swipe', payload: { bidId, action } });

  beforeAll(async () => {
    db = await memoryDb();
    await runScan({ db, sources: [questSource()], profiles: [pilot, capped], ctx: scanCtx() });
    app = await buildServer({ db, profile: pilot }, { now: () => NOW });
    cappedApp = await buildServer({ db, profile: capped }, { now: () => NOW });
  });
  afterAll(async () => {
    await app.close();
    await cappedApp.close();
    await db.close();
  });

  it('picks the real great fit due in a week and says why', async () => {
    const { item: picked, why } = await next();
    expect(picked).toMatchObject({ id: CELL_DOORS, score: 82, verdict: 'great', swipe: null, overLimit: false });
    expect(why).toEqual(['Great fit — 82 out of 100', 'Due in 7 days — soon, but still time to bid', expect.any(String)]);
    expect(picked!.reasons.filter((r) => r.kind === 'plus').map((r) => r.text)).toContain(why[2]);
  });

  it('moves on once a bid is swiped, and comes back when the swipe is undone', async () => {
    await swipe(CELL_DOORS, 'pass');
    expect((await next()).item).toMatchObject({ id: SPRINKLER, score: 77 });
    await swipe(SPRINKLER, 'save');
    const third = (await next()).item!;
    expect([CELL_DOORS, SPRINKLER]).not.toContain(third.id);
    // Next best: the Army Aviation fire suppression job (40). The elevator modernizations (53 in v0)
    // score as another trade's work since config/lm-electric.json lists "elevator*" under otherTrades.
    expect(third.score).toBe(40);
    await app.inject({ method: 'DELETE', url: `/api/swipe/${encodeURIComponent(CELL_DOORS)}` });
    await app.inject({ method: 'DELETE', url: `/api/swipe/${encodeURIComponent(SPRINKLER)}` });
    expect((await next()).item!.id).toBe(CELL_DOORS);
  });

  it('never suggests a bid over the spend limit, however well it fits', async () => {
    await upsertBids(db, [lighting], NOW);
    await scoreProfile(db, pilot, NOW);
    await scoreProfile(db, capped, NOW);

    // No limits: the $30K lighting job is the pick.
    expect((await next()).item).toMatchObject({ id: lighting.id, overLimit: false });
    // $20K job limit: same fit score, but over the limit, so the pick is the next best bid.
    const stored = (await cappedApp.inject(`/api/bids/${encodeURIComponent(lighting.id)}`)).json() as FeedItem;
    expect(stored).toMatchObject({ overLimit: true, score: (await next()).item!.score });
    expect(stored.reasons).toContainEqual({ kind: 'minus', text: 'Est. $30K — over your $20K job limit' });
    expect((await next(cappedApp)).item).toMatchObject({ id: CELL_DOORS, overLimit: false });
  });

  it('answers { item: null, why: [] } when every candidate has been swiped', async () => {
    for (let i = 0; i < 20; i++) {
      const { item: picked } = await next();
      if (!picked) break;
      expect(picked.score).toBeGreaterThanOrEqual(35);
      await swipe(picked.id, 'pass');
    }
    expect(await next()).toEqual({ item: null, why: [] });
    // Another profile's swipes are its own.
    expect((await next(cappedApp)).item!.id).toBe(CELL_DOORS);
  });

  it('follows the clock: a bid stops being the pick when it closes', async () => {
    const at = async (iso: string) => {
      const later = await buildServer({ db, profile: capped }, { now: () => new Date(iso) });
      const res = (await later.inject('/api/next')).json() as { item: FeedItem | null; why: string[] };
      await later.close();
      return res;
    };
    // The cell doors job closes 2026-11-18 at 2:00 PM Pacific (22:00Z): the pick an hour before, never after.
    expect((await at('2026-11-18T21:00:00Z')).item).toMatchObject({ id: CELL_DOORS, overLimit: false });
    expect((await at('2026-11-18T22:00:01Z')).item?.id).not.toBe(CELL_DOORS);
    // A day later every Nov 18 bid has closed. What is left on this board is another trade's work (the
    // elevator modernizations score 9 since "elevator*" moved to otherTrades) or over this profile's
    // limit (the $30K TEST job): nothing to suggest, said as null rather than a closed or over-limit bid.
    expect(await at('2026-11-19T00:00:00Z')).toEqual({ item: null, why: [] });
  });
});
