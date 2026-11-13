// POST /api/estimate and GET /api/estimates (v1 contract 4): validation (400 with field-level messages,
// never 500 on bad input), plan gating (402 premium_required, no numbers for free plans), bid facts,
// and persistence on PGlite memory (src/db/estimates.ts).
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { listEstimates, saveEstimate } from '../src/db/estimates.js';
import { saveProfileForAccount, upsertBids } from '../src/db/repo.js';
import { featuresFor } from '../src/plans.js';
import { profileIdFor } from '../src/profile/build.js';
import { loadProfile } from '../src/profiles.js';
import { buildApp, buildServer } from '../src/server.js';
import type { Account } from '../src/types.js';
import { accountsConfig, fakeAuth, memoryDb, NOW, seedAccount, testBid, testProfile } from './helpers.js';

const now = () => NOW;
const CSRF = { 'x-bidswipe': '1' };

/** A complete request (spec 11.2 I-1 inputs, made up; a test vector, not a real job). */
const I1 = {
  job: { ownerType: 'nv_local', prevailingWage: 'none', bidDate: '2026-11-20', startDate: '2026-12-01', endDate: '2026-12-31', estimatedCost: '60000' },
  labor: {
    classes: [
      { label: 'Journeyman', hours: '160', overtimeHours: '8', wage: '45.00', planFringe: '4.00', healthPlan: '4.00', annualWages: '90000', workersCompPer100: '2.50' },
      { label: 'Apprentice', hours: '120', wage: '24.00', planFringe: '4.00', healthPlan: '4.00', annualWages: '48000', workersCompPer100: '2.50' },
    ],
    mbt: { mode: 'marginal', quarterlyGrossWages: '120000', quarterlyHealthDeduction: '10000' },
    workersComp: { experienceMod: '1.00', policyEffectiveDate: '2026-10-15' },
  },
  materials: {
    lines: [
      { label: 'Wire', quantity: '2400', unitPrice: '1.85', wastePercent: '5', quotedOn: '2026-10-05', purchaseDate: '2026-12-05' },
      { label: 'Conduit', quantity: '600', unitPrice: '3.40', wastePercent: '3' },
      { label: 'Gear package', quantity: 1, unitPrice: '6800' },
      { label: 'Fixtures', quantity: 24, unitPrice: '185' },
    ],
    freight: '350', freightTaxable: false, salesTaxPercent: '7.1', forwardRatePercent: '6',
  },
  equipment: [{ label: 'Lift rental', amount: '650' }],
  subcontracts: [{ label: 'Trenching', amount: '3200' }],
  jobOverhead: [{ label: 'Permit', amount: '420' }, { label: 'Supervision', hours: '12', rate: '65' }, { label: 'Mobilization', amount: '300' }, { label: 'Cleanup', amount: '150' }],
  markups: { smallToolsPercent: '2', contingencyPercent: '0', overhead: { method: 'on_cost', percent: '15' }, profitPercent: '10' },
  insurance: { generalLiability: { basis: 'receipts', per1000: '6.00' } },
  financing: { include: false },
  payment: { billingCycleDays: 30, retainageReleaseDays: 60 },
  limits: { cashForJob: '15000', unusedCreditLine: '10000' },
};

let db: Db;
const apps: FastifyInstance[] = [];
beforeAll(async () => {
  db = await memoryDb();
});
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await db.close();
});

describe('plan gating (src/plans.ts)', () => {
  it('the cost engine is premium: free has estimator false, pro and pilot true', () => {
    expect(featuresFor('free').estimator).toBe(false);
    expect(featuresFor('pro').estimator).toBe(true);
    expect(featuresFor('pilot').estimator).toBe(true);
  });
});

describe('accounts mode', () => {
  let app: FastifyInstance;
  let who: Account | null = null;
  let free: Account, pro: Account, other: Account;
  const bid = testBid({ title: 'TEST lighting retrofit (synthetic)', estValue: { min: 60_000, max: 60_000 }, location: { city: 'Carson City', state: 'NV' } });

  beforeAll(async () => {
    app = (await buildApp({ db }, { config: accountsConfig(), auth: fakeAuth(() => who), now })).app;
    apps.push(app);
    free = await seedAccount(db);
    pro = await seedAccount(db, { plan: 'pro' });
    other = await seedAccount(db, { plan: 'pro' });
    for (const a of [free, pro, other]) await saveProfileForAccount(db, a.id, testProfile(profileIdFor(a.id), { trades: ['electrical'], zip: '89410' }));
    await upsertBids(db, [bid], NOW);
  });
  const post = (payload: unknown, headers: Record<string, string> = CSRF) /* x-bidswipe: the contract's CSRF header */ => app.inject({ method: 'POST', url: '/api/estimate', payload: payload as object, headers });

  it('signed out: 401 sign_in_required', async () => {
    who = null;
    const res = await post(I1);
    expect([res.statusCode, res.json()]).toEqual([401, { error: 'sign_in_required' }]);
  });

  it('free plan: 402 premium_required on both routes, and no numbers at all', async () => {
    who = free;
    for (const res of [await post(I1), await app.inject('/api/estimates')]) {
      expect(res.statusCode).toBe(402);
      const body = res.json();
      expect(body.error).toBe('premium_required');
      expect(Object.keys(body).sort()).toEqual(['error', 'message']);
      expect(JSON.stringify(body)).not.toMatch(/\d{3,}/);
    }
    expect(await listEstimates(db, profileIdFor(free.id))).toEqual([]); // nothing was computed or saved
  });

  it('pro plan: 200 with the contract fields (breakdown, total, checks, sources) plus the full result, saved', async () => {
    who = pro;
    const res = await post(I1);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(4_912_575); // spec 11.2 I-1
    expect(body.status).toBe('complete');
    for (const k of ['breakdown', 'total', 'checks', 'sources', 'assumptions', 'warnings', 'needed', 'cash', 'limits', 'bidRange']) expect(body, k).toHaveProperty(k);
    expect(body.checks.every((c: { level: string }) => ['ok', 'warn', 'stop'].includes(c.level))).toBe(true);
    expect(body.sources.some((s: { id: string; urls: string[] }) => s.id === 'D-2' && s.urls[0]!.startsWith('https://'))).toBe(true);
    expect(body.id).toMatch(/^\d+$/);
    expect(body.savedAt).toBe(NOW.toISOString());
  });

  it('bad input: 400 invalid_input with field-level messages (never 500)', async () => {
    who = pro;
    const wage = structuredClone(I1);
    (wage.labor.classes[0] as { wage: string }).wage = '45.555';
    const cases: [unknown, string][] = [
      [wage, 'labor.classes[0].wage'],
      [{ ...I1, job: { ...I1.job, endDate: 'tomorrow' } }, 'job.endDate'],
      [{ ...I1, surprise: true }, 'surprise'],
      [{ ...I1, markups: { ...I1.markups, overhead: { method: 'on_sales', percent: '70', profitPercent: '40' } } }, 'markups.overhead'],
      [[1, 2, 3], 'body'],
      [{ ...I1, bidId: 42 }, 'bidId'],
      [{ ...I1, labor: { ...I1.labor, classes: 'many' } }, 'labor.classes'],
    ];
    for (const [payload, path] of cases) {
      const res = await post(payload);
      expect(res.statusCode, path).toBe(400);
      const body = res.json();
      expect(body.error).toBe('invalid_input');
      expect(body.fields.map((f: { path: string }) => f.path), path).toContain(path);
    }
    // an engine refusal (a bond schedule whose marginal rate reaches 100%) is a 400 too, with its code
    const res = await post({ ...I1, bond: { required: 'yes', tiers: [{ upTo: null, ratePer1000: '1000' }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_input', code: expect.any(String) });
  });

  it('missing inputs: 200 with status incomplete, the needed list, and no price', async () => {
    who = pro;
    const res = await post({ job: { ownerType: 'nv_local' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect([body.status, body.total, body.price]).toEqual(['incomplete', null, null]);
    expect(body.needed.map((n: { field: string }) => n.field)).toEqual(expect.arrayContaining(['job.startDate', 'markups.overhead', 'insurance.generalLiability']));
  });

  it('the contract quick form is accepted and asks for what it lacks', async () => {
    who = pro;
    const res = await post({ laborHours: 40, laborRate: 45, materials: 1200, overheadPct: 15, profitPct: 10 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'incomplete', total: null });
  });

  it('with a bidId: the bid\'s facts are used and listed; unknown bid -> 404', async () => {
    who = pro;
    const req = structuredClone(I1) as Record<string, unknown> & typeof I1;
    delete (req.job as Partial<typeof I1.job>).estimatedCost;
    delete (req.job as Partial<typeof I1.job>).bidDate;
    req.job.startDate = '2026-12-07'; // the bid is due 2026-12-02: work cannot start before it
    const res = await post({ ...req, bidId: bid.id });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bidId).toBe(bid.id);
    expect(body.bidFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ fact: 'estimate', used: true }),
      expect.objectContaining({ fact: 'due date', value: '2026-12-02', used: true }), // 22:00Z on Dec 2 is 14:00 Pacific
    ]));
    const missing = await post({ ...I1, bidId: 'samgov:TEST-missing' });
    expect([missing.statusCode, missing.json()]).toEqual([404, { error: 'bid_not_found' }]);
  });

  it('GET /api/estimates lists this profile\'s saved estimates, newest first, filtered by bidId', async () => {
    who = pro;
    const all = (await app.inject('/api/estimates')).json().items;
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.every((e: { profileId: string }) => e.profileId === profileIdFor(pro.id))).toBe(true);
    const forBid = (await app.inject(`/api/estimates?bidId=${encodeURIComponent(bid.id)}`)).json().items;
    expect(forBid).toHaveLength(1);
    expect(forBid[0]).toMatchObject({ bidId: bid.id, result: { status: 'complete' }, inputs: { job: { ownerType: 'nv_local' } } });
    const bad = await app.inject('/api/estimates?limit=0');
    expect(bad.statusCode).toBe(400);
    who = other; // another customer never sees them
    expect((await app.inject('/api/estimates')).json().items).toEqual([]);
  });

});

describe('single mode (the pilot): plan pilot has the cost engine', () => {
  it('POST /api/estimate works and saves under the pilot profile', async () => {
    const profile = loadProfile('lm-electric');
    const app = await buildServer({ db, profile }, { now });
    apps.push(app);
    const res = await app.inject({ method: 'POST', url: '/api/estimate', payload: I1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(4_912_575);
    const items = (await app.inject('/api/estimates')).json().items;
    expect(items[0].profileId).toBe('lm-electric');
  });
});

describe('src/db/estimates.ts on PGlite memory', () => {
  it('saves and lists by profile and bid, newest first; jsonb round-trips', async () => {
    const acct = await seedAccount(db, { plan: 'pro' });
    const pid = profileIdFor(acct.id);
    await saveProfileForAccount(db, acct.id, testProfile(pid));
    const a = await saveEstimate(db, { profileId: pid, bidId: null, inputs: { a: 1 }, result: { total: 1 } }, new Date('2026-11-12T00:00:00Z'));
    const b = await saveEstimate(db, { profileId: pid, bidId: 'samgov:TEST-x', inputs: { b: [1, 2] }, result: { total: 2, nested: { ok: true } } }, new Date('2026-11-13T00:00:00Z'));
    expect((await listEstimates(db, pid)).map((e) => e.id)).toEqual([b.id, a.id]);
    expect(await listEstimates(db, pid, { bidId: 'samgov:TEST-x' })).toEqual([b]);
    expect(b).toMatchObject({ profileId: pid, bidId: 'samgov:TEST-x', inputs: { b: [1, 2] }, result: { total: 2, nested: { ok: true } }, createdAt: '2026-11-13T00:00:00.000Z' });
    expect(await listEstimates(db, pid, { limit: 1 })).toHaveLength(1);
  });
});
