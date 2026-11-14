import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/db.js';
import {
  CANDIDATE_QUERY_SLACK_MI, candidateProfilesFor, listProfiles, MATCH_BATCH, saveProfileForAccount, upsertBids, upsertProfile,
} from '../src/db/repo.js';
import { milesBetween } from '../src/geo/locate.js';
import { lookupZip } from '../src/geo/zip.js';
import { loadJobRules } from '../src/jobs/config.js';
import { accountProfileIds, insertJob, placeBid as placeBidRow, type JobRecord } from '../src/jobs/repo.js';
import { confirmAgreement, mirrorBid, settleDue, type JobsDeps } from '../src/jobs/service.js';
import type { JobView } from '../src/jobs/view.js';
import { buildProfile, profileIdFor } from '../src/profile/build.js';
import { createBus, type BusEventOf } from '../src/realtime/bus.js';
import { alertThreshold, mayAnnounce, scoreNewBid, seesLocalJobs } from '../src/scan.js';
import { CANDIDATE_REACH, candidateLimitMi, isCandidate } from '../src/score/candidates.js';
import { buildApp } from '../src/server.js';
import type { Account, Bid, Profile } from '../src/types.js';
import { accountsConfig, fakeAuth, memoryDb, scoreOneByOne, seedAccount, testProfile } from './helpers.js';

/**
 * The marketplace's two busiest requests must cost a few database statements however many people use the app:
 *
 *   POST /api/jobs       scores the new job for everyone it could fit (scoreNewBid) before the poster gets an answer
 *   GET  /api/jobs/mine  builds a view of every job someone posted or bid on
 *
 * Both used to make statements per row (one upsert per candidate profile; bids, fees and three card reads per
 * person per job). Here every statement goes through a counting wrapper around the database, and the count must
 * be the same for a little data as for a lot. The rest checks that the set-based code decides exactly what the
 * one-by-one code decided: the same people, the same scores, the same alerts, nothing more shown to a viewer.
 *
 * Synthetic people and jobs throughout (TEST- accounts at example.com, "(simulated)" names).
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-14T18:00:00Z');
const APP_URL = 'https://bidswipe.example.com';
const MINDEN = lookupZip('89423')!; // Minden, NV: where the jobs are

/** A database that counts (and remembers) every statement sent through it. `after` runs once a statement has answered. */
function counting(inner: Db, after: (sql: string, nth: number) => Promise<void> | void = () => {}) {
  const sql: string[] = [];
  const db: Db = {
    kind: inner.kind,
    async query<T>(text: string, params?: unknown[]) {
      const nth = sql.push(text);
      const rows = await inner.query<T>(text, params);
      await after(text, nth);
      return rows;
    },
    exec: (text) => inner.exec(text),
    close: () => inner.close(),
  };
  return { db, sql, count: () => sql.length, reset: () => void (sql.length = 0) };
}

function jobRow(id: string, posterId: string, over: Partial<JobRecord> = {}): JobRecord {
  return {
    id, posterId, title: `Swap a porch light ${id} (TEST)`, trades: ['electrical'],
    description: 'One porch light fixture to replace. TEST job (simulated).',
    zip: MINDEN.zip, city: MINDEN.city, state: MINDEN.state, lat: MINDEN.lat, lng: MINDEN.lng, address: null, phone: null,
    budgetMaxCents: null, postedAt: NOW, closesAt: NOW + 3 * DAY, status: 'open', outcome: null,
    winnerBidId: null, winnerId: null, awardCents: null, awardedAt: null, contactDeadline: null, bidderMessagedAt: null,
    posterMessagedAt: null, posterTappedAt: null, bidderConfirmedAt: null, posterConfirmedAt: null, agreedAt: null, completedAt: null,
    endedAt: null, repostedFrom: null, removedAt: null, ...over,
  };
}

const worker = (id: string, name: string, trades: string[], zip: string, radiusMi: number): Profile =>
  buildProfile(id, { businessName: `TEST ${name} (simulated)`, trades, zip, radiusMi, valueRange: { min: 0, max: 50_000 } });

/** An account with a work profile: an electrician in Gardnerville (12 mi from the jobs) unless told otherwise. */
async function seedWorker(db: Db, name: string, trades = ['electrical'], zip = '89410', radiusMi = 90): Promise<Account> {
  const a = await seedAccount(db, { name: `TEST ${name} (simulated)` });
  await saveProfileForAccount(db, a.id, worker(profileIdFor(a.id), name, trades, zip, radiusMi));
  return a;
}

interface MatchRow { profile_id: string; score: number; verdict: string; reasons: unknown; distance_mi: number | null; over_limit: boolean; tier: string | null }

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The scores stored for one bid, by profile id (sorted here, so the database's collation does not matter). */
const matchesOf = async (db: Db, bidId: string): Promise<MatchRow[]> =>
  (await db.query<MatchRow>('select profile_id, score, verdict, reasons, distance_mi, over_limit, tier from matches where bid_id = $1', [bidId]))
    .map((r) => ({ ...r, reasons: typeof r.reasons === 'string' ? JSON.parse(r.reasons) : r.reasons, distance_mi: r.distance_mi == null ? null : Number(r.distance_mi) }))
    .sort((a, b) => byId(a.profile_id, b.profile_id));

// ------------------------------------------------------------------------------------------------------------

describe('scoring a newly posted job: statements do not grow with the number of profiles', () => {
  let db: Db;
  let c: ReturnType<typeof counting>;
  let app: FastifyInstance;
  let poster: Account;
  const body = (n: number) => ({
    title: `Swap TEST porch light number ${n}`, description: 'One porch light fixture to replace. TEST job (simulated).',
    trades: ['electrical'], zip: MINDEN.zip, closesInDays: 3,
  });

  beforeAll(async () => {
    db = await memoryDb();
    c = counting(db);
    // The real server on the counting database, signed in as the poster. No alert rules listen here: what is
    // counted is the request itself (settlement, sign-in, the insert, the scoring, the answer).
    app = (await buildApp({ db: c.db }, { config: accountsConfig({ appUrl: APP_URL }), auth: fakeAuth(() => poster), now: () => new Date(NOW) })).app;
    poster = await seedWorker(db, 'Scale Poster'); // an electrician too: must never be handed their own job
    // People the job must not reach: too far away, here only to hire, and the pilot's profile (no account).
    for (let i = 0; i < 4; i++) await seedWorker(db, `Far ${i}`, ['electrical'], '10001', 25);
    const hirer = await seedAccount(db, { name: 'TEST Hirer (simulated)' });
    await saveProfileForAccount(db, hirer.id, buildProfile(profileIdFor(hirer.id), {
      intent: 'hire', businessName: 'TEST Hirer (simulated)', trades: [], zip: '89410', radiusMi: 25, valueRange: { min: 0, max: 250_000 },
    }));
    await upsertProfile(db, testProfile('TEST-scale-config'));
    for (let i = 0; i < 12; i++) await seedWorker(db, `Near ${i}`);
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('POST /api/jobs: the same statements for 12 candidates as for 112, and every candidate still gets a score', async () => {
    /** One post through the route. Returns the mirrored bid's id and how many statements the request made. */
    const post = async (n: number): Promise<{ bidId: string; statements: number }> => {
      c.reset();
      const res = await app.inject({ method: 'POST', url: '/api/jobs', headers: { 'x-bidswipe': '1', 'content-type': 'application/json' }, payload: JSON.stringify(body(n)) });
      expect(res.statusCode, res.body).toBe(201);
      return { bidId: `local:${res.json().job.id}`, statements: c.count() };
    };

    const few = await post(1);
    expect(await matchesOf(db, few.bidId)).toHaveLength(12);

    for (let i = 12; i < 112; i++) await seedWorker(db, `Near ${i}`);
    const many = await post(2);
    expect(await matchesOf(db, many.bidId)).toHaveLength(112);
    // One statement per candidate (what this replaced) would be 100 more here.
    expect(many.statements).toBe(few.statements);
    expect(few.statements).toBeLessThanOrEqual(15);
    expect(c.sql.filter((q) => /insert into matches/.test(q))).toHaveLength(1);
  });

  it('scoreNewBid: one read and one write up to MATCH_BATCH profiles, one more write per batch after that', async () => {
    c.reset();
    const post = async (id: string): Promise<Bid> => {
      const bid = mirrorBid(jobRow(id, poster.id), APP_URL);
      await upsertBids(db, [bid], new Date(NOW));
      return bid;
    };
    const except = profileIdFor(poster.id);

    const a = await post('TEST-scale-a');
    expect(await scoreNewBid(c.db, a, new Date(NOW), undefined, { exceptProfileId: except })).toBe(112);
    expect(c.sql).toHaveLength(2);
    expect(c.sql[0]).toMatch(/from profiles/);
    expect(c.sql[1]).toMatch(/insert into matches/);

    for (let i = 112; i < MATCH_BATCH + 1; i++) await seedWorker(db, `Near ${i}`);
    c.reset();
    const b = await post('TEST-scale-b');
    expect(await scoreNewBid(c.db, b, new Date(NOW), undefined, { exceptProfileId: except })).toBe(MATCH_BATCH + 1);
    expect(c.sql).toHaveLength(3); // the read, then 500 rows, then 1 row
    expect(await matchesOf(db, b.id)).toHaveLength(MATCH_BATCH + 1);
  });
});

// ------------------------------------------------------------------------------------------------------------

describe('scoring a newly posted job: the same people, scores and alerts as asking the rules one profile at a time', () => {
  let db: Db;
  let poster: Account;

  /** A point `miles` due north of Minden (on a meridian the great-circle distance is exactly the latitude difference). */
  const north = (miles: number) => ({ label: 'TEST point (simulated)', lat: MINDEN.lat + (miles / CANDIDATE_REACH.earthRadiusMi) * (180 / Math.PI), lng: MINDEN.lng });

  beforeAll(async () => {
    db = await memoryDb();
    poster = await seedWorker(db, 'Parity Poster');
    // Workers of several trades around the country, with small and large travel radii.
    const zips = ['89410', '89423', '89701', '89501', '96150', '95814', '95630', '89101', '85004', '84101', '83702', '97201', '98101', '80202', '77002', '60601', '10001', '33101'];
    const trades = ['electrical', 'plumbing', 'hvac', 'roofing', 'general-building', 'low-voltage'];
    let n = 0;
    for (const zip of zips) {
      for (const radiusMi of [25, 90, 250, 500]) await seedWorker(db, `Parity ${n}`, [trades[n++ % trades.length]!], zip, radiusMi);
    }
    // Here only to hire, next door to the job: no trades, so never shown one.
    for (const zip of ['89410', '89423']) {
      const h = await seedAccount(db, { name: 'TEST Parity Hirer (simulated)' });
      await saveProfileForAccount(db, h.id, buildProfile(profileIdFor(h.id), {
        intent: 'hire', businessName: 'TEST Parity Hirer (simulated)', trades: [], zip, radiusMi: 25, valueRange: { min: 0, max: 250_000 },
      }));
    }
    // The pilot's config profile (no account): a candidate for board bids, never for a local job.
    await upsertProfile(db, testProfile('TEST-parity-config'));
  });
  afterAll(async () => { await db.close(); });

  /** Bids of every shape isCandidate() tells apart: state and point, state only, point only, neither. */
  function bidsToTry(): Bid[] {
    const local = (id: string, zip: string): Bid => {
      const place = lookupZip(zip)!;
      return mirrorBid(jobRow(id, poster.id, { zip: place.zip, city: place.city, state: place.state, lat: place.lat, lng: place.lng }), APP_URL);
    };
    const board = (id: string, location: Partial<Bid['location']>): Bid => ({
      ...local(id, '89423'), id: `ngem:${id}`, source: 'ngem', sourceId: id, sourceName: 'TEST board', flags: [],
      title: 'TEST electrical panel upgrade (synthetic)', category: null,
      location: { city: null, county: null, state: null, zip: null, lat: null, lng: null, precision: 'unknown', label: null, ...location },
    });
    return [
      local('TEST-parity-minden', '89423'),
      local('TEST-parity-sacramento', '95814'),
      local('TEST-parity-new-york', '10001'),
      local('TEST-parity-houston', '77002'),
      board('TEST-parity-state-only', { state: 'NV', precision: 'state' }),
      board('TEST-parity-point-only', { lat: MINDEN.lat, lng: MINDEN.lng, precision: 'city' }),
      board('TEST-parity-nowhere', {}),
      board('TEST-parity-far-state', { state: 'ME', lat: 43.66, lng: -70.25, precision: 'city' }),
    ];
  }

  it('every kind of bid: the stored scores and the match events are the ones the one-by-one loop gives', async () => {
    const now = new Date(NOW);
    const except = profileIdFor(poster.id);
    let reached = 0;
    for (const bid of bidsToTry()) {
      await upsertBids(db, [bid], now);
      const want = await scoreOneByOne(db, bid, now, except);

      const bus = createBus();
      const events: Array<BusEventOf<'match'>> = [];
      bus.on('match', (e) => void events.push(e));
      expect(await scoreNewBid(db, bid, now, bus, { exceptProfileId: except }), bid.id).toBe(want.size);

      expect(await matchesOf(db, bid.id), bid.id).toEqual([...want.entries()].sort(([a], [b]) => byId(a, b)).map(([profile_id, { score: s }]) => ({
        profile_id, score: s.score, verdict: s.verdict, reasons: s.reasons, distance_mi: s.distanceMi, over_limit: s.overLimit, tier: s.tier,
      })));
      // The alerts: the matches the scan's own rule announces (mayAnnounce: a good fit, never sub work, never a
      // capped, rejected or over-limit bid), in profile-id order, each carrying the stored score.
      const alerted = [...want.values()].filter(({ profile, score: s }) => mayAnnounce(s, alertThreshold(profile)));
      expect(events.map((e) => [e.profileId, e.score.score, e.isNewBid]), bid.id).toEqual(alerted.map(({ profile, score: s }) => [profile.id, s.score, true]));
      reached += want.size;
    }
    expect(reached).toBeGreaterThan(40); // the cases above are not all empty
    // The poster, the hire-only accounts and the config profile never got a local job.
    const local = await db.query<{ profile_id: string }>(`select distinct profile_id from matches where bid_id like 'local:%'`);
    const ids = new Set(local.map((r) => r.profile_id));
    expect(ids.has(except)).toBe(false);
    expect(ids.has('TEST-parity-config')).toBe(false);
    const hireOnly = (await listProfiles(db)).filter((p) => (p.trades ?? []).length === 0 && p.id !== 'TEST-parity-config');
    expect(hireOnly).toHaveLength(2);
    for (const p of hireOnly) expect(ids.has(p.id)).toBe(false);
  });

  it('the query is the rule with a mile of slack: it may return a profile too many, never one too few', async () => {
    for (const bid of bidsToTry()) {
      const localJob = bid.source === 'local';
      const got = new Set((await candidateProfilesFor(db, bid.location, CANDIDATE_REACH, { accountsThatWork: localJob })).map((c) => c.profile.id));
      const withAccount = await accountProfileIds(db);
      for (const p of await listProfiles(db)) {
        const wanted = isCandidate(p, bid) && (!localJob || seesLocalJobs(p, withAccount.has(p.id)));
        if (wanted) expect(got.has(p.id), `${bid.id} must reach ${p.id}`).toBe(true);
        else if (got.has(p.id)) {
          // Only the slack band may come back without being a candidate.
          const miles = milesBetween(p.base, { lat: bid.location.lat!, lng: bid.location.lng! });
          expect(miles).toBeGreaterThan(candidateLimitMi(p));
          expect(miles).toBeLessThanOrEqual(candidateLimitMi(p) + CANDIDATE_QUERY_SLACK_MI + 0.001);
        }
      }
    }
  });

  it('a profile just inside the limit is scored; one inside the slack is read and dropped; one past it is never read', async () => {
    // Out of state on purpose (states: []), so only the distance decides. Radius 90 → candidate limit 190 mi.
    const edge = async (name: string, miles: number): Promise<string> => {
      const a = await seedAccount(db, { name: `TEST ${name} (simulated)` });
      const p = { ...worker(profileIdFor(a.id), name, ['electrical'], '89410', 90), base: north(miles), states: [] as string[] };
      expect(candidateLimitMi(p)).toBe(190);
      await saveProfileForAccount(db, a.id, p);
      return p.id;
    };
    const inside = await edge('Edge inside', 189.5);
    const slack = await edge('Edge slack', 190.5);
    const outside = await edge('Edge outside', 192);

    const bid = mirrorBid(jobRow('TEST-parity-edge', poster.id), APP_URL);
    await upsertBids(db, [bid], new Date(NOW));
    const read = new Set((await candidateProfilesFor(db, bid.location, CANDIDATE_REACH, { accountsThatWork: true })).map((c) => c.profile.id));
    expect([read.has(inside), read.has(slack), read.has(outside)]).toEqual([true, true, false]);

    await scoreNewBid(db, bid, new Date(NOW), undefined, { exceptProfileId: profileIdFor(poster.id) });
    const stored = new Set((await matchesOf(db, bid.id)).map((r) => r.profile_id));
    expect([stored.has(inside), stored.has(slack), stored.has(outside)]).toEqual([true, false, false]);
  });

  it('a profile that vanishes between the read and the write loses its own row only', async () => {
    const doomed = await seedWorker(db, 'Doomed');
    const doomedProfile = profileIdFor(doomed.id);
    const bid = mirrorBid(jobRow('TEST-parity-vanish', poster.id), APP_URL);
    await upsertBids(db, [bid], new Date(NOW));
    const want = await scoreOneByOne(db, bid, new Date(NOW), profileIdFor(poster.id));
    expect(want.has(doomedProfile)).toBe(true);

    // The account is deleted right after scoreNewBid has read its candidates (its first statement).
    const c = counting(db, async (_sql, nth) => {
      if (nth === 1) await db.query('delete from accounts where id = $1', [doomed.id]);
    });
    const bus = createBus();
    const told: string[] = [];
    bus.on('match', (e) => void told.push(e.profileId));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await scoreNewBid(c.db, bid, new Date(NOW), bus, { exceptProfileId: profileIdFor(poster.id) })).toBe(want.size - 1);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]![0])).toContain(doomedProfile);
    } finally {
      errors.mockRestore();
    }
    const stored = (await matchesOf(db, bid.id)).map((r) => r.profile_id);
    expect(stored).toEqual([...want.keys()].filter((id) => id !== doomedProfile).sort(byId));
    expect(told).not.toContain(doomedProfile);
  });

  it('a profile whose stored settings are broken is skipped: it cannot stop the query or the others', async () => {
    // Stored the way no screen can store it: text where numbers belong, no keyword lists. In NV, so the rule keeps it.
    const broken = { id: 'TEST-parity-broken', name: 'TEST broken (simulated)', base: { label: 'x', lat: 'north', lng: null }, states: ['NV'], maxDistanceMi: 'far' };
    await upsertProfile(db, broken as unknown as Profile);
    const bid: Bid = { ...mirrorBid(jobRow('TEST-parity-broken-bid', poster.id), APP_URL), id: 'ngem:TEST-parity-broken-bid', source: 'ngem', flags: [], category: null };
    await upsertBids(db, [bid], new Date(NOW));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await scoreNewBid(db, bid, new Date(NOW))).toBeGreaterThan(10);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]![0])).toContain('for TEST-parity-broken failed');
    } finally {
      errors.mockRestore();
    }
    expect((await matchesOf(db, bid.id)).some((r) => r.profile_id === 'TEST-parity-broken')).toBe(false);
    await db.query('delete from profiles where id = $1', ['TEST-parity-broken']);
  });
});

// ------------------------------------------------------------------------------------------------------------

describe('GET /api/jobs/mine: statements do not grow with the jobs or the people on them', () => {
  let inner: Db;
  let c: ReturnType<typeof counting>;
  let app: FastifyInstance;
  let clock = NOW;
  let current: Account | null = null;
  let deps: JobsDeps;

  let me: Account; // posts jobs and bids on other people's
  let rival: Account; // bids on my jobs AND on a job I bid on: their card must not cross over
  const others: Account[] = [];
  let seq = 0;
  let cents = 40_001;

  /** A job straight into the tables (the API would do the same writes, ten posts an hour at most). Closes in a day. */
  async function seedJob(poster: Account, bidders: Account[], over: { address?: string; phone?: string } = {}): Promise<string> {
    const id = `TEST-mine-${++seq}`;
    const job = await insertJob(inner, {
      id, posterId: poster.id, title: `Fix TEST thing number ${seq}`, description: 'A TEST job for the statement count (simulated).',
      trades: ['electrical'], zip: MINDEN.zip, city: MINDEN.city, state: MINDEN.state, lat: MINDEN.lat, lng: MINDEN.lng,
      address: over.address ?? null, phone: over.phone ?? null, budgetMaxCents: null, postedAt: clock, closesAt: clock + DAY, repostedFrom: null,
    });
    await upsertBids(inner, [mirrorBid(job!, APP_URL)], new Date(clock));
    for (const [i, b] of bidders.entries()) {
      cents += 222; // every amount is different, and odd
      expect(await placeBidRow(inner, { jobId: id, bidderId: b.id, amountCents: cents, note: null }, clock + (i + 1) * 60_000)).not.toBeNull();
    }
    return id;
  }

  async function get(who: Account, url: string) {
    current = who;
    c.reset();
    const res = await app.inject({ method: 'GET', url, headers: { 'x-bidswipe': '1' } });
    expect(res.statusCode).toBe(200);
    return { json: res.json(), text: res.body, statements: c.count() };
  }

  beforeAll(async () => {
    inner = await memoryDb();
    c = counting(inner);
    me = await seedWorker(inner, 'Mine Me');
    rival = await seedWorker(inner, 'Mine Rival');
    for (let i = 0; i < 24; i++) others.push(await seedWorker(inner, `Mine Other ${i}`));
    deps = { db: inner, rules: loadJobRules(() => undefined), appUrl: APP_URL };
    const built = await buildApp({ db: c.db }, { config: accountsConfig({ appUrl: APP_URL }), auth: fakeAuth(() => current), now: () => new Date(clock) });
    app = built.app;
  });
  afterAll(async () => {
    await app.close();
    await inner.close();
  });

  let fewStatements = 0;
  let mineJob = '';
  let theirJob = '';

  it('3 jobs, then 25 jobs with up to 20 bidders each: the same statements', async () => {
    mineJob = await seedJob(me, [rival, others[0]!], { address: '7 TEST Lane (simulated)', phone: '775-555-0107' });
    await seedJob(me, [others[1]!, others[2]!]);
    theirJob = await seedJob(others[3]!, [rival, me, others[4]!], { address: '9 TEST Lane (simulated)', phone: '775-555-0109' }); // rival bids lower: wins
    clock += DAY + 60_000;
    await settleDue(deps, clock); // all three are awarded; nothing is left for the request itself to settle

    const few = await get(me, '/api/jobs/mine');
    expect([few.json.posted.length, few.json.bidding.length]).toEqual([2, 1]);
    fewStatements = few.statements;

    for (let i = 0; i < 12; i++) await seedJob(me, others.slice(i % 4, (i % 4) + 20));
    for (let i = 0; i < 10; i++) await seedJob(others[i]!, [me, ...others.slice(10, 16)]);
    clock += DAY + 60_000;
    await settleDue(deps, clock);
    // Some of them agreed: fee rows, another table the view reads.
    for (const id of [mineJob, theirJob]) {
      const row = (await inner.query<{ poster_id: string; winner_id: string }>('select poster_id, winner_id from jobs where id = $1', [id]))[0]!;
      expect(row.winner_id).toBe(rival.id);
      expect((await confirmAgreement(deps, row.winner_id, id, clock)).ok).toBe(true);
      expect((await confirmAgreement(deps, row.poster_id, id, clock + 60_000)).ok).toBe(true);
    }

    const many = await get(me, '/api/jobs/mine');
    expect([many.json.posted.length, many.json.bidding.length]).toEqual([14, 11]);
    // Before: 2 + 3 per person per job, here more than a thousand. Now it does not move.
    expect(many.statements).toBe(fewStatements);
    expect(fewStatements).toBeLessThanOrEqual(12);
  });

  it('one job: the same statements for the poster with 2 bidders as with 20', async () => {
    const small = await get(me, `/api/jobs/${mineJob}`);
    expect(small.json.job.tab).toHaveLength(2);
    const bigId = (await get(me, '/api/jobs/mine')).json.posted.find((j: JobView) => j.bidCount === 20).id as string;
    const big = await get(me, `/api/jobs/${bigId}`);
    expect(big.json.job.tab).toHaveLength(20);
    expect(big.json.job.tab.every((row: { bidder: { name: string } | null }) => row.bidder?.name.startsWith('TEST '))).toBe(true);
    expect(big.statements).toBe(small.statements);
  });

  it('every job in "my jobs" is exactly the view the job page gives, with every field there', async () => {
    const mine = (await get(me, '/api/jobs/mine')).json as { posted: JobView[]; bidding: JobView[] };
    const keys = ['award', 'bidCount', 'budgetMaxCents', 'closesAt', 'description', 'fees', 'id', 'my', 'outcome', 'place', 'postedAt', 'poster',
      'private', 'repostedFrom', 'rules', 'status', 'tab', 'title', 'tradeLabels', 'trades'];
    for (const view of [...mine.posted, ...mine.bidding]) {
      expect(Object.keys(view).sort(), view.id).toEqual(keys); // hidden = null or [], never left out
      expect((await get(me, `/api/jobs/${view.id}`)).json.job, view.id).toEqual(view);
    }
  });

  it('cards read for my own jobs never show up on a job I only bid on', async () => {
    const mine = await get(me, '/api/jobs/mine');
    // On my job the rival is a bidder (and the winner): as the poster I see their card, with the service fee they owe.
    const own = mine.json.posted.find((j: JobView) => j.id === mineJob) as JobView;
    expect(own.my.role).toBe('poster');
    expect(own.award?.winner).toMatchObject({ id: rival.id, name: 'TEST Mine Rival (simulated)' });
    expect(own.tab!.map((r) => r.bidder?.id)).toContain(rival.id);
    expect(own.private).toEqual({ address: '7 TEST Lane (simulated)', phone: '775-555-0107' });
    expect(own.fees).toEqual([{ kind: 'service', amountCents: expect.any(Number), posterShareCents: 0, status: 'recorded', owedByMe: false }]);

    // On their job the rival won too, and their card was read for THIS request (for my job above). I only bid
    // there: no names on the tab, no winner card, no address or phone, no fee rows.
    const lost = mine.json.bidding.find((j: JobView) => j.id === theirJob) as JobView;
    expect(lost.my.role).toBe('bidder');
    expect(lost.award).not.toBeNull();
    expect(lost.award!.isMe).toBe(false);
    expect(lost.award!.winner).toBeNull();
    expect(lost.tab).toHaveLength(3);
    expect(lost.tab!.every((r) => r.bidder === null)).toBe(true);
    expect(lost.private).toBeNull();
    expect(lost.fees).toEqual([]);
    expect(lost.poster).toEqual({ id: others[3]!.id, name: expect.stringMatching(/^TEST /), memberSince: expect.any(String), stats: expect.any(Object) });
    for (const secret of ['9 TEST Lane', '775-555-0109', 'example.com']) expect(mine.text).not.toContain(secret);

    // The rival, the winner there, does get the address; the poster of that job sees the rival's card.
    const asRival = await get(rival, '/api/jobs/mine');
    const won = asRival.json.bidding.find((j: JobView) => j.id === theirJob) as JobView;
    expect(won.award!.isMe).toBe(true);
    expect(won.private).toEqual({ address: '9 TEST Lane (simulated)', phone: '775-555-0109' });
    expect(won.fees).toEqual([{ kind: 'service', amountCents: expect.any(Number), posterShareCents: 0, status: 'recorded', owedByMe: true }]);
    expect(won.award!.winner).toBeNull(); // a card is for the poster; the winner knows who they are

    // Someone who lost on my job sees neither my address nor who else bid.
    const asLoser = await get(others[0]!, '/api/jobs/mine');
    const theirs = asLoser.json.bidding.find((j: JobView) => j.id === mineJob) as JobView;
    expect(theirs.tab!.every((r) => r.bidder === null)).toBe(true);
    expect(theirs.private).toBeNull();
    for (const secret of ['7 TEST Lane', '775-555-0107', 'Mine Rival']) expect(asLoser.text).not.toContain(secret);
  });
});
