/**
 * The multi-company simulation (src/sim) on a small seed: simulated companies (SIM … (simulated),
 * @example.com) use the real server over local HTTP on the REAL captured bids, SAM.gov included.
 * The checks must hold for every company, the same seed must give the same report, and the checks must be
 * able to fail: three runs break a rule through each kind of seam (the profiles the scan scores, the bus the
 * scan publishes on, an onSend hook on an answer), and the rest are proven on mutated observations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkCoverage, checkPersona, electricalOnly, pipeOnly, type PersonaObs } from '../src/sim/checks.js';
import { PERSONAS, type Persona } from '../src/sim/personas.js';
import { capturedDrafts, pickHoldOut, runSimulation, scaleAnswers, type SimResult } from '../src/sim/run.js';
import { simTakeoff } from '../src/sim/takeoff.js';
import { finalizeBid } from '../src/scan.js';
import { mergeDrafts } from '../src/sources/dedupe.js';
import { fixtureReaders, SAMGOV_FIXTURES } from '../src/sources/fixtures.js';
import { estimate } from '../src/cost/estimate.js';
import type { FeedItem } from '../src/types.js';
import { CAPTURED, FIXTURE_DIR, realBids } from './helpers.js';

const SEED = 7;
/** Six companies that between them cover: the pilot's twin, SDVOSB, 8(a), plumbing, HVAC, free and Pro. */
const SMALL: readonly Persona[] = ['sim-01', 'sim-02', 'sim-04', 'sim-08', 'sim-11', 'sim-12'].map((k) => PERSONAS.find((p) => p.key === k)!);
const OPTS = { seed: SEED, personas: SMALL, fastHash: true, scaleProfiles: 20, scaleDb: false, speedMs: 20, fixturesDir: FIXTURE_DIR, port: 0 } as const;

let first: SimResult;
let second: SimResult;
beforeAll(async () => {
  first = await runSimulation(OPTS);
  second = await runSimulation({ ...OPTS, scaleProfiles: 0 });
}, 180_000);

describe('personas', () => {
  it('at least 14 simulated companies, every one labelled, with a reason, covering the places, trades and plans asked for', () => {
    expect(PERSONAS.length).toBeGreaterThanOrEqual(14);
    for (const p of PERSONAS) {
      expect(p.answers.businessName).toMatch(/^SIM .+ \(simulated\)$/);
      expect(p.email).toMatch(/^sim-\d{2}@example\.com$/);
      expect(p.reason.length).toBeGreaterThan(20);
    }
    const zips = new Set(PERSONAS.map((p) => p.answers.zip));
    for (const z of ['89410', '89501', '89701', '89406', '89801', '89101', '96150', '95814', '93514']) expect(zips.has(z), z).toBe(true);
    const trades = new Set(PERSONAS.flatMap((p) => p.answers.trades));
    for (const t of ['electrical', 'low-voltage', 'fire-protection', 'plumbing', 'hvac', 'general-building']) expect(trades.has(t), t).toBe(true);
    expect(PERSONAS.filter((p) => p.answers.setAsides?.includes('SDVOSBC'))).toHaveLength(1);
    expect(PERSONAS.filter((p) => p.answers.setAsides?.includes('8A'))).toHaveLength(1);
    expect(new Set(PERSONAS.map((p) => p.plan))).toEqual(new Set(['free', 'pro']));
    const twin = PERSONAS[0]!.answers;
    expect([twin.zip, twin.radiusMi, twin.valueRange.min, twin.valueRange.max, twin.trades]).toEqual(['89410', 90, 10_000, 50_000, ['electrical']]);
  });
});

describe('the captured bids', () => {
  it('fixtureReaders({ samgov: true }) adds the real SAM.gov captures; the default count is unchanged', () => {
    const plain = fixtureReaders(FIXTURE_DIR).flatMap((r) => r.read());
    expect(plain).toHaveLength(realBids().length);
    const withSam = capturedDrafts(FIXTURE_DIR);
    const sam = withSam.filter((d) => d.source === 'samgov');
    expect(SAMGOV_FIXTURES).toHaveLength(3);
    expect(sam.length).toBeGreaterThan(0);
    expect(withSam).toHaveLength(plain.length + sam.length);
    expect(sam.filter((d) => /^TEST-/.test(d.sourceId))).toEqual([]); // the real captures, never the synthetic file
  });

  it('the held-out bids are real, open, would alert someone, and depend only on the seed', () => {
    const bids = mergeDrafts(capturedDrafts(FIXTURE_DIR)).map(finalizeBid);
    const a = pickHoldOut(bids, SMALL, SEED, 3);
    expect(a).toHaveLength(3);
    expect(pickHoldOut(bids, SMALL, SEED, 3)).toEqual(a);
    for (const id of a) expect(bids.some((b) => b.id === id)).toBe(true);
  });
});

describe('the run on a small seed', () => {
  it('every check holds for every company', () => {
    expect(first.report.checks.violations).toEqual([]);
    expect(first.report.personas.map((p) => p.key)).toEqual(SMALL.map((p) => p.key));
  });

  it('Browse holds every bid the scorer calls maybe or better, for every company (the candidate filter dropped none)', () => {
    expect(first.report.checks.coverage['browse-complete']!.companies).toBe(SMALL.length);
    expect(first.report.checks.coverage['browse-complete']!.items).toBeGreaterThan(SMALL.length);
    // …while Browse is smaller than "every captured bid": out-of-reach bids are not stored at all.
    const open = mergeDrafts(capturedDrafts(FIXTURE_DIR)).map(finalizeBid).filter((b) => !b.dueAt || Date.parse(b.dueAt) > CAPTURED.getTime());
    for (const row of first.report.personas) expect(row.bidsSeen, row.key).toBeLessThan(open.length);
  });

  it('the same seed gives the same report', () => {
    expect(second.hash).toBe(first.hash);
  });

  it('free companies got 402 and no numbers; Pro companies a price or what is needed', () => {
    for (const row of first.report.personas) {
      if (row.plan === 'free') {
        expect(row.cost.status, row.key).toBe(402);
        expect(row.cost.total, row.key).toBeNull();
        expect(row.market.awards, row.key).toMatch(/^locked/);
      } else {
        expect(row.cost.status, row.key).toBe(200);
        expect(row.cost.total !== null ? row.cost.total > 0 : row.cost.needed.length > 0, row.key).toBe(true);
        expect(row.cost.quick, row.key).toMatch(/^incomplete .*needs markups\.overhead/);
      }
    }
  });

  it('the held-out bids arrive in scan 2, alert someone, and every alert is timed to the stream', () => {
    const [s1, s2, s3] = first.measurements.scans;
    expect(s2!.newBids).toBe(first.report.bids.heldOut.length);
    expect(s3!.newBids).toBe(0);
    expect(s1!.totalBids + first.report.bids.heldOut.length).toBe(s2!.totalBids);
    expect(first.measurements.latency.length).toBeGreaterThanOrEqual(1);
    for (const l of first.measurements.latency) {
      expect(l.seenToStoredMs).toBeGreaterThan(0);
      expect(l.seenToStreamMs).not.toBeNull();
      expect(l.seenToStreamMs!).toBeGreaterThanOrEqual(l.seenToStoredMs);
    }
    expect(first.measurements.scoring.pairsPerSecond).toBeGreaterThan(0);
    expect(first.measurements.scale).toMatchObject({ profiles: 20, db: null });
  });

  it('the SDVOSB company is not blocked from the Reno job reserved for it; the uncertified twin is', () => {
    const sdvosb = first.report.personas.find((p) => p.key === 'sim-02')!;
    const own = sdvosb.reservedSeen.filter((r) => r.setAside === 'SDVOSBC');
    expect(own.length).toBeGreaterThan(0);
    for (const r of own) expect(r.firstReason).not.toMatch(/^Reserved for/);
    const twin = first.report.personas.find((p) => p.key === 'sim-01')!;
    for (const r of twin.reservedSeen.filter((x) => x.setAside === 'SDVOSBC')) {
      expect(r.score).toBe(0);
      expect(r.firstReason).toMatch(/^Reserved for service-disabled veteran-owned firms|mi away/);
    }
  });

  it('the report names the coverage gaps for California', () => {
    const ca = first.report.coverage.find((c) => c.key === 'sim-08')!;
    expect(ca.boardsNeeded).toMatch(/Cal eProcure/);
    expect(first.report.findings.join('\n')).toMatch(/California: \d+ open captured bids are in California, all from SAM\.gov/);
  });
});

describe('the checks can fail: one rule broken at a time through a real seam', () => {
  // These run the whole simulation again with the rule broken; each must be caught by its own check.
  it.each([
    ['radius', 'radius'],
    ['alert-missing', 'alert-missing'],
    ['estimate-not-silent', 'estimate-not-silent'],
    ['stream-cut', 'stream-delivery'],
    ['browse-missing', 'browse-complete'],
    ['sub-alerts', 'sub-silent'],
  ] as const)('mutation %s is caught by the %s check', async (mutation, check) => {
    const r = await runSimulation({ ...OPTS, scaleProfiles: 0, mutation });
    expect(r.report.checks.violations.filter((v) => v.check === check).length).toBeGreaterThan(0);
  }, 120_000);
});

describe('the checks can fail: mutated observations', () => {
  const twin = PERSONAS[0]!; // electrical, 90 mi, job limit $100K, bonding $150K, no certification
  const plumber = PERSONAS.find((p) => p.key === 'sim-04')!;
  const item = (over: Partial<FeedItem>): FeedItem => ({
    id: 'samgov:TEST-1', source: 'samgov', sourceId: 'TEST-1', sourceName: 'TEST', title: 'TEST lighting retrofit (synthetic)', agency: null,
    description: null, category: null,
    location: { city: null, county: null, state: 'NV', zip: null, lat: null, lng: null, precision: 'city', label: 'TEST, NV' },
    postedAt: null, dueAt: '2026-12-01T22:00:00.000Z', estValue: null, naics: null, setAside: null, url: 'https://example.com/t', flags: [],
    score: 80, verdict: 'great', reasons: [{ kind: 'plus', text: 'Electrical scope: “lighting”' }], distanceMi: 20, swipe: null,
    firstSeenAt: '2026-11-13T20:00:00.000Z', overLimit: false, tier: (over.score ?? 80) >= 35 ? 'fit' : 'other', ...over,
  });
  const obs = (over: Partial<PersonaObs>, persona: Persona = twin): PersonaObs => ({
    key: persona.key, plan: persona.plan, features: { estimator: persona.plan === 'pro' }, decks: [[]], browse: [], filters: null, next: null, alerts: [],
    repeat: null, stream: null, market: null, estimate: null, ...over,
  });
  const run = (o: PersonaObs, persona: Persona = twin) => checkPersona(persona, o, new Map(o.browse.map((b) => [b.id, b])));
  const alert = (bidId: string, body: string) => ({ id: 1, profileId: 'x', kind: 'match' as const, bidId, dedupeKey: bidId, title: 'Great fit', body, data: {}, createdAt: '', pushedAt: null, readAt: null });

  it('browse-complete: a maybe-or-better bid missing from Browse is a violation; present, it passes', () => {
    const expected = [{ id: 'samgov:TEST-1', title: 'TEST lighting retrofit (synthetic)', score: 40 }];
    expect(run(obs({ browse: [item({ score: 40, verdict: 'maybe' })], expectedInBrowse: expected })).filter((v) => v.check === 'browse-complete')).toEqual([]);
    const missing = run(obs({ browse: [], expectedInBrowse: expected })).filter((v) => v.check === 'browse-complete');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.detail).toMatch(/samgov:TEST-1 .* scores 40 for this company but is not in Browse/);
  });

  it('sub-silent: sub work that alerts, is the next pick, leaves 36–50 or is not said first is a violation', () => {
    const sub = item({
      title: 'TEST library renovation (synthetic)', score: 44, verdict: 'maybe', tier: 'sub',
      reasons: [{ kind: 'info', text: 'Sub work: a general contractor bids this building job (“renovat”); electrical is usually subcontracted' }],
    });
    const subChecks = (o: PersonaObs, persona: Persona = twin) => run(o, persona).filter((v) => v.check === 'sub-silent');
    expect(subChecks(obs({ decks: [[sub]], browse: [sub] }))).toEqual([]);
    expect(subChecks(obs({ browse: [sub], alerts: [alert(sub.id, 'TEST — renovation')] }))).toHaveLength(1);
    expect(subChecks(obs({ browse: [sub], next: { item: sub, why: [] } }))).toHaveLength(1);
    expect(subChecks(obs({ browse: [{ ...sub, score: 55, verdict: 'good' }] }))).toHaveLength(1);
    expect(subChecks(obs({ browse: [{ ...sub, reasons: [{ kind: 'info', text: 'Job size not stated' }] }] }))).toHaveLength(1);
    expect(subChecks(obs({ browse: [{ ...sub, title: 'TEST switchgear replacement (synthetic)', naics: '238210' }] }))).toHaveLength(1); // its own trade
    const gc = PERSONAS.find((p) => p.answers.trades.includes('general-building'))!;
    expect(subChecks(obs({ browse: [sub] }, gc), gc)).toHaveLength(1); // the prime gets no sub tier
    expect(subChecks(obs({ browse: [item({ score: 30, verdict: 'skip', tier: 'fit' })] }))).toHaveLength(1);
    // A reserved prime is no bar to quoting its bidders: not a certification violation as sub work.
    expect(run(obs({ decks: [[{ ...sub, setAside: 'SDVOSBC' }]] })).map((v) => v.check)).toEqual([]);
  });

  it('clean observations pass', () => {
    const b = item({});
    expect(run(obs({ decks: [[b]], browse: [b], alerts: [alert(b.id, 'TEST — Electrical scope: “lighting” · 18 days left')] }))).toEqual([]);
  });
  it('a deck bid beyond the radius', () => {
    expect(run(obs({ decks: [[item({ distanceMi: 140 })]] })).map((v) => v.check)).toEqual(['radius']);
  });
  it('an over-limit bid in the deck: by the flag, and by the recomputed rule', () => {
    expect(run(obs({ decks: [[item({ overLimit: true })]] })).map((v) => v.check)).toEqual(['spend-limit']);
    expect(run(obs({ decks: [[item({ estValue: { min: 120_000, max: 150_000 } })]] })).map((v) => v.check)).toEqual(['spend-limit']);
    expect(run(obs({ decks: [[item({ estValue: { min: 120_000, max: 120_000 }, flags: ['Bid bond'] })]] })).map((v) => v.check)).toEqual(['spend-limit']);
    expect(run(obs({ decks: [[item({ estValue: { min: 80_000, max: 120_000 } })]] }))).toEqual([]); // straddles the limit: may come in under
  });
  it('a reserved job in front of an uncertified company, and a certified company blocked', () => {
    expect(run(obs({ decks: [[item({ setAside: 'SDVOSBC' })]] })).map((v) => v.check)).toEqual(['certification']);
    const vet = PERSONAS.find((p) => p.key === 'sim-02')!;
    const blocked = item({ setAside: 'SDVOSBC', score: 0, verdict: 'skip', reasons: [{ kind: 'minus', text: 'Reserved for service-disabled veteran-owned firms' }] });
    expect(run(obs({ browse: [blocked] }, vet), vet).map((v) => v.check)).toEqual(['certification']);
    expect(run(obs({ decks: [[item({ setAside: 'SBA' })]] }))).toEqual([]); // small business is not a certification program
  });
  it('an electrical-only job as a fit for a plumber, and a plumbing job for an electrician', () => {
    const wiring = item({ title: 'TEST switchgear replacement (synthetic)', naics: '238210' });
    expect(electricalOnly(wiring)).toBe(true);
    const told = [alert(wiring.id, 'TEST — Electrical scope: “lighting” · 18 days left')];
    expect(run(obs({ browse: [wiring], alerts: told }, plumber), plumber).map((v) => v.check)).toEqual(['trade']);
    const pipes = item({ title: 'TEST water heater replacement (synthetic)', verdict: 'good', score: 60 });
    expect(pipeOnly(pipes)).toBe(true);
    expect(run(obs({ browse: [pipes], alerts: [alert(pipes.id, 'TEST — Electrical scope: “lighting”')] })).map((v) => v.check)).toEqual(['trade']);
  });
  it('an alert that states no reason, and a fit that never reached the inbox', () => {
    const b = item({});
    expect(run(obs({ browse: [b], alerts: [alert(b.id, 'TEST — 18 days left')] })).map((v) => v.check)).toEqual(['alert-reason']);
    expect(run(obs({ browse: [b] })).map((v) => v.check)).toEqual(['alert-missing']);
  });
  it('a repeat scan that adds an alert; a stored alert the stream never delivered', () => {
    expect(run(obs({ repeat: { before: [1], after: [1, 2], events: 1 } })).map((v) => v.check)).toEqual(['repeat-scan']);
    expect(run(obs({ stream: { stored: [5], delivered: [] } })).map((v) => v.check)).toEqual(['stream-delivery']);
  });
  it('premium numbers on a free plan; a silent zero on Pro', () => {
    const free = PERSONAS.find((p) => p.plan === 'free')!;
    const locked = { status: 200, body: { locked: true, stats: { count: 3, median: 41_250 } } };
    const watch = { status: 200, body: { locked: true, series: [] } };
    expect(run(obs({ market: { awards: locked, area: { status: 200, body: {} }, watch } }, free), free).map((v) => v.check)).toEqual(['free-no-premium']);
    const leak = { status: 402, body: { error: 'premium_required', message: 'x', total: 100 } };
    expect(run(obs({ estimate: { full: leak, quick: { status: 402, body: { error: 'premium_required' } }, list: { status: 402, body: {} } } }, free), free).map((v) => v.check)).toEqual(['free-no-premium']);
    const zero = { status: 200, body: { status: 'complete', total: 0, needed: [], price: { bid: 0 } } };
    const fine = { status: 200, body: { status: 'incomplete', total: null, needed: [{ field: 'markups.overhead' }] } };
    expect(run(obs({ estimate: { full: zero, quick: fine, list: { status: 200, body: {} } } })).map((v) => v.check)).toEqual(['estimate-not-silent']);
    const empty = { status: 200, body: { status: 'incomplete', total: null, needed: [] } };
    expect(run(obs({ estimate: { full: fine, quick: empty, list: { status: 200, body: {} } } })).map((v) => v.check)).toEqual(['estimate-not-silent']);
  });
  it('a filter that lets through what it should not, and a next pick from outside the deck', () => {
    const far = item({ distanceMi: 70 });
    const filters = { price: { min: 10_000, max: 50_000, items: [item({ estValue: { min: 90_000, max: 95_000 } })] }, distance: { maxMi: 45, items: [far] }, due: { days: 14, now: '2026-11-13T20:00:00.000Z', items: [item({ dueAt: null })] } };
    expect(run(obs({ filters })).map((v) => v.check)).toEqual(['filters', 'filters', 'filters']);
    expect(run(obs({ next: { item: item({}), why: [] } })).map((v) => v.check)).toEqual(['next-in-deck']);
  });
  it('a next pick that is not the best of the deck (the ranking reversed)', () => {
    const asOf = '2026-11-13T20:00:00.000Z';
    const best = item({ id: 'samgov:TEST-BEST', score: 82 });
    const worst = item({ id: 'samgov:TEST-WORST', score: 40, verdict: 'maybe' });
    // An urgent bid (3 days left, +9.2) beats a slightly better-scoring one 20 days out.
    const urgent = item({ id: 'samgov:TEST-URGENT', score: 76, dueAt: '2026-11-16T20:00:00.000Z' });
    const deck = [best, worst, urgent];
    expect(run(obs({ asOf, decks: [deck], next: { item: urgent, why: [] } }))).toEqual([]);
    expect(run(obs({ asOf, decks: [deck], next: { item: worst, why: [] } })).map((v) => v.check)).toEqual(['next-rank']);
    expect(run(obs({ asOf, decks: [deck], next: { item: best, why: [] } })).map((v) => v.check)).toEqual(['next-rank']);
    const weak = item({ id: 'samgov:TEST-WEAK', score: 20, verdict: 'skip' });
    expect(run(obs({ asOf, decks: [[weak]], next: { item: weak, why: [] } })).map((v) => v.check)).toEqual(['next-rank']);
  });
  it('a check with nothing to evaluate is counted as not exercised, not as passed', () => {
    const b = item({});
    const o = obs({ decks: [[b]], browse: [b], filters: { price: { min: 1, max: 2, items: [b] }, distance: { maxMi: 45, items: [b] }, due: { days: 14, now: '2026-11-13T20:00:00.000Z', items: [b] } } });
    const cov = checkCoverage(twin, o, new Map([[b.id, b]]));
    expect(cov['spend-limit']).toBe(0); // no estimate on the bid
    expect(cov['filters (price)']).toBe(0);
    expect(cov.filters).toBe(2);
    expect(checkCoverage(twin, obs({ decks: [[item({ estValue: { min: 5, max: 9 } })]] }), new Map())['spend-limit']).toBe(1);
  });
  it('the real run reports the checks it could not exercise', () => {
    expect(first.report.checks.coverage['spend-limit']!.items).toBe(0);
    expect(first.report.checks.coverage['filters (price)']!.items).toBe(0);
    expect(first.report.checks.coverage['stream-delivery']!.items).toBeGreaterThan(0);
    expect(first.report.checks.coverage['next-rank']!.companies).toBeGreaterThan(0);
  });
});

describe('the simulated inputs', () => {
  it('a takeoff is complete for the engine, labelled simulated, and the same for the same seed', () => {
    const bid = realBids().find((b) => b.source === 'questcdn')!;
    const a = simTakeoff(SEED, 0, bid, 30_000);
    expect(simTakeoff(SEED, 0, bid, 30_000)).toEqual(a);
    expect(a.notes.join(' ')).toMatch(/simulated/);
    const r = estimate(a.request);
    expect(r.status).toBe('complete');
    expect(r.total).toBeGreaterThan(0);
    const half = estimate(simTakeoff(SEED, 0, bid, 30_000, ['markups']).request);
    expect([half.status, half.total]).toEqual(['incomplete', null]);
    expect(half.needed.map((n) => n.field)).toContain('markups.overhead');
  });

  it('the scale variations are simulated, valid, and the same for the same seed', () => {
    const v = scaleAnswers(SEED, 50);
    expect(scaleAnswers(SEED, 50)).toEqual(v);
    for (const a of v) {
      expect(a.businessName).toMatch(/^SIM .+ \(simulated\)$/);
      expect(a.valueRange.max).toBeGreaterThan(a.valueRange.min);
    }
  });
});

afterAll(() => {});
