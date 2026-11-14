import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { saveSubscription } from '../src/db/alerts.js';
import { saveProfileForAccount, upsertBids, upsertProfile } from '../src/db/repo.js';
import { lookupZip } from '../src/geo/zip.js';
import type { JobRecord } from '../src/jobs/repo.js';
import { mirrorBid } from '../src/jobs/service.js';
import { buildProfile, profileIdFor } from '../src/profile/build.js';
import { createRealtime } from '../src/realtime/index.js';
import { scoreNewBid, scoreProfile, seesLocalJobs } from '../src/scan.js';
import { buildApp } from '../src/server.js';
import type { Account } from '../src/types.js';
import { accountsConfig, fakeAuth, memoryDb, seedAccount, testProfile } from './helpers.js';

/**
 * Who a local job reaches, and how fast. Synthetic people (TEST- accounts at example.com, example.com push
 * endpoints); the job is synthetic too.
 *
 *  - Only a profile an account owns, and that does some work, is shown local jobs: not the pilot's config
 *    profile (single mode has nobody to bid as) and not a "Get work done" profile (no trades: its work feed
 *    stays empty, jobs contract section 5).
 *  - A job request sends the pushes it raised before it answers (a serverless function freezes after that).
 *  - The alert poll settles closed jobs, so a winner hears "You won" at the next poll.
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-14T18:00:00Z');
const place = lookupZip('89423')!; // Minden, NV

function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'TEST-reach-1', posterId: 'TEST-nobody', title: 'Swap a porch light (TEST)', trades: ['electrical'],
    description: 'One porch light fixture to replace. TEST job (simulated).',
    zip: place.zip, city: place.city, state: place.state, lat: place.lat, lng: place.lng, address: null, phone: null,
    budgetMaxCents: null, postedAt: NOW, closesAt: NOW + 3 * DAY, status: 'open', outcome: null,
    winnerBidId: null, winnerId: null, awardCents: null, awardedAt: null, contactDeadline: null, bidderMessagedAt: null,
    posterMessagedAt: null, posterTappedAt: null, bidderConfirmedAt: null, posterConfirmedAt: null, agreedAt: null, completedAt: null,
    endedAt: null, repostedFrom: null, removedAt: null, ...over,
  };
}

/** The answers a 'hire' onboarding stores (HIRE_DEFAULTS in src/profile/build.ts). */
const HIRE = { trades: [] as string[], radiusMi: 25, valueRange: { min: 0, max: 250_000 } };

const electrician = (id: string) => buildProfile(id, {
  businessName: `TEST ${id} (simulated)`, trades: ['electrical'], zip: '89410', radiusMi: 90, valueRange: { min: 10_000, max: 50_000 },
});

describe('who is shown a local job', () => {
  it('seesLocalJobs: an account that does work, yes; a config profile or a hire-only profile, no', () => {
    expect(seesLocalJobs(electrician('TEST-a'), true)).toBe(true);
    expect(seesLocalJobs(electrician('TEST-a'), false)).toBe(false); // a config profile (no account)
    const hire = buildProfile('TEST-h', { intent: 'hire', businessName: 'TEST Dana (simulated)', zip: '89410', ...HIRE });
    expect(hire.trades).toEqual([]);
    expect(seesLocalJobs(hire, true)).toBe(false);
  });

  let db: Db;
  beforeAll(async () => { db = await memoryDb(); });
  afterAll(async () => { await db.close(); });

  it('a new job is scored for the electrician account only: never the config profile, never the hire account', async () => {
    const worker = await seedAccount(db, { name: 'TEST Worker (simulated)' });
    const hirer = await seedAccount(db, { name: 'TEST Hirer (simulated)' });
    await saveProfileForAccount(db, worker.id, electrician(profileIdFor(worker.id)));
    await saveProfileForAccount(db, hirer.id, buildProfile(profileIdFor(hirer.id), { intent: 'hire', businessName: 'TEST Hirer (simulated)', zip: '89410', ...HIRE }));
    // The pilot's profile, stored the way single mode stores it: no account.
    await upsertProfile(db, testProfile('TEST-config'));

    const bid = mirrorBid(job(), 'https://bidswipe.example.com');
    await upsertBids(db, [bid], new Date(NOW));
    expect(await scoreNewBid(db, bid, new Date(NOW))).toBe(1);
    const rows = await db.query<{ profile_id: string }>('select profile_id from matches where bid_id = $1', [bid.id]);
    expect(rows.map((r) => r.profile_id)).toEqual([profileIdFor(worker.id)]);

    // A re-score of every open bid (onboarding, a scan) keeps it that way.
    await scoreProfile(db, testProfile('TEST-config'), new Date(NOW));
    expect(await db.query('select 1 from matches where bid_id = $1 and profile_id = $2', [bid.id, 'TEST-config'])).toHaveLength(0);
  });
});

describe('pushes and settling on the serverless host', () => {
  let db: Db;
  let clock = NOW;
  let current: Account | null = null;
  const pushes: string[] = [];
  let built: Awaited<ReturnType<typeof buildApp>>;
  let rt: ReturnType<typeof createRealtime>;
  let poster: Account;
  let a: Account;
  let b: Account;

  beforeAll(async () => {
    db = await memoryDb();
    poster = await seedAccount(db, { name: 'TEST Poster R (simulated)' });
    a = await seedAccount(db, { name: 'TEST Bidder RA (simulated)', plan: 'pro' });
    b = await seedAccount(db, { name: 'TEST Bidder RB (simulated)', plan: 'pro' });
    for (const x of [poster, a, b]) {
      await saveProfileForAccount(db, x.id, electrician(profileIdFor(x.id)));
      await saveSubscription(db, x.id, { endpoint: `https://push.example.com/TEST-${x.id}`, keys: { p256dh: 'TEST', auth: 'TEST' } } as never, new Date(clock));
    }
    built = await buildApp({ db }, { config: accountsConfig({ appUrl: 'https://bidswipe.example.com' }), auth: fakeAuth(() => current), now: () => new Date(clock) });
    // As on Vercel (src/server.ts serverless()): no timers, and ctx.realtime set so routes can flush.
    rt = createRealtime(built.ctx, { tickMs: 0, sender: async (device) => { pushes.push(device.endpoint); return { ok: true } as never; } });
    built.ctx.realtime = rt;
  });
  afterAll(async () => {
    rt.stop();
    await built.app.close();
    await db.close();
  });

  async function call(who: Account | null, method: 'GET' | 'POST', url: string, body?: unknown) {
    current = who;
    const res = await built.app.inject({
      method, url, headers: { 'x-bidswipe': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    return { status: res.statusCode, json: res.body ? res.json() : null };
  }
  const kinds = async (x: Account) =>
    (await db.query<{ kind: string }>('select kind from alerts where profile_id = $1 order by id', [profileIdFor(x.id)])).map((r) => r.kind);

  let id = '';
  it('posting a job sends the match pushes before the answer is out', async () => {
    const res = await call(poster, 'POST', '/api/jobs', {
      title: 'Swap a TEST porch light', description: 'One porch light fixture to replace. TEST job (simulated).',
      trades: ['electrical'], zip: '89423', closesInDays: 1,
    });
    expect(res.status).toBe(201);
    id = res.json.job.id;
    // Without the flush these were still on the 1.5 s coalescing timer when the reply went out.
    expect(pushes.filter((e) => e.endsWith(a.id) || e.endsWith(b.id)).length).toBe(2);
    expect(pushes.some((e) => e.endsWith(poster.id))).toBe(false);
  });

  it('after closing, the winner’s alert poll settles the job and tells them they won', async () => {
    expect((await call(a, 'POST', `/api/jobs/${id}/bid`, { amountCents: 30_011, agree: true })).status).toBe(200);
    expect((await call(b, 'POST', `/api/jobs/${id}/bid`, { amountCents: 40_013, agree: true })).status).toBe(200);
    clock += DAY + 60_000;
    const before = pushes.length;
    const poll = await call(a, 'GET', '/api/alerts');
    expect(poll.status).toBe(200);
    expect((await db.query<{ status: string }>('select status from jobs where id = $1', [id]))[0]!.status).toBe('awarded');
    expect(await kinds(a)).toContain('job_awarded');
    expect(poll.json.items.map((x: { kind: string }) => x.kind)).toContain('job_awarded');
    expect(pushes.length).toBeGreaterThan(before); // sent before the poll answered
  });
});
