/**
 * "Your paperwork" (Profile.qualifications) through validation, the profile build, the summary and the routes,
 * plus "Use my location" (nearest ZIP). Companies are simulated ("TEST … (simulated)"); bids are the REAL
 * NV State Public Works pages in test/fixtures.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { getProfileByAccount } from '../src/db/repo.js';
import { nearestZip, round2 } from '../src/geo/nearest.js';
import { buildProfile, summarize, validateAnswers, type OnboardingAnswers } from '../src/profile/build.js';
import { createBus } from '../src/realtime/bus.js';
import { runScan } from '../src/scan.js';
import { BELOW_ALERT_CAP } from '../src/score/score.js';
import { buildApp } from '../src/server.js';
import type { Account, FeedItem } from '../src/types.js';
import { accountsConfig, CAPTURED, fakeAuth, memoryDb, questSource, resetDb, scanCtx, seedAccount } from './helpers.js';

const BASE: OnboardingAnswers = {
  businessName: 'TEST Paperwork Electric (simulated)', trades: ['electrical'], zip: '89410', radiusMi: 90,
  valueRange: { min: 10_000, max: 50_000 },
};

describe('qualifications: validation and build', () => {
  it('is optional: no key in, no key out (answers, profile and summary)', () => {
    const r = validateAnswers(BASE);
    expect(r).toEqual({ ok: true, value: BASE });
    const p = buildProfile('test-q', BASE);
    expect('qualifications' in p).toBe(false);
    expect('qualifications' in summarize(p)).toBe(false);
    expect(validateAnswers({ ...BASE, qualifications: null })).toEqual({ ok: true, value: BASE });
  });

  it('keeps the four answers, and a missing one counts as unsure', () => {
    const r = validateAnswers({ ...BASE, qualifications: { statePublicWorks: 'yes', bonding: 'no' } });
    expect(r.ok && r.value.qualifications).toEqual({ statePublicWorks: 'yes', samRegistered: 'unsure', bonding: 'no', prevailingWage: 'unsure' });
    const p = buildProfile('test-q', (r as { value: OnboardingAnswers }).value);
    expect(p.qualifications).toEqual({ statePublicWorks: 'yes', samRegistered: 'unsure', bonding: 'no', prevailingWage: 'unsure' });
    // a settings save of the summary builds the same profile
    const { id: _i, base: _b, ...back } = summarize(p);
    const again = validateAnswers(back);
    expect(again.ok && buildProfile('test-q', again.value)).toEqual(p);
  });

  it('refuses unknown answers and unknown keys, one message per field', () => {
    const r = validateAnswers({ ...BASE, qualifications: { bonding: 'maybe', samRegistred: 'yes' } });
    expect(r).toEqual({
      ok: false,
      errors: { 'qualifications.samRegistred': 'Unknown field “qualifications.samRegistred”.', 'qualifications.bonding': 'Bonding must be yes, no or unsure.' },
    });
    expect(validateAnswers({ ...BASE, qualifications: 'yes' })).toMatchObject({ ok: false, errors: { qualifications: expect.any(String) } });
  });
});

describe('nearest ZIP ("Use my location")', () => {
  it('finds the ZIP around a point, from rounded coordinates', () => {
    expect(round2(38.94167)).toBe(38.94);
    expect(nearestZip(38.87, -119.61)).toMatchObject({ zip: '89410', city: 'Gardnerville', state: 'NV' });
    expect(nearestZip(40.75, -73.99)?.state).toBe('NY');
    expect(nearestZip(61.22, -149.9)?.state).toBe('AK');
  });
  it('answers null out at sea, off the map, or for a point that is not a point', () => {
    expect(nearestZip(30, -40)).toBeNull(); // mid-Atlantic
    expect(nearestZip(Number.NaN, 0)).toBeNull();
    expect(nearestZip(91, 0)).toBeNull();
  });
});

describe('qualifications: routes', () => {
  let db: Db;
  let app: FastifyInstance;
  let who: Account | null = null;
  const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/profile', headers: { 'x-bidswipe': '1' }, payload: payload as object });

  beforeAll(async () => {
    db = await memoryDb();
    app = (await buildApp({ db }, { bus: createBus(), auth: fakeAuth(() => who), now: () => CAPTURED, config: accountsConfig() })).app;
  });
  beforeEach(async () => {
    await resetDb(db);
    await runScan({ db, sources: [questSource()], profiles: [], ctx: scanCtx(CAPTURED) });
    who = null;
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('GET /api/geo/nearest-zip: the ZIP and its town, 400 on a bad point, 404 far from any ZIP', async () => {
    expect((await app.inject('/api/geo/nearest-zip?lat=38.87&lng=-119.61')).json()).toEqual({ zip: '89410', city: 'Gardnerville', state: 'NV' });
    expect((await app.inject('/api/geo/nearest-zip?lat=abc&lng=1')).statusCode).toBe(400);
    expect((await app.inject('/api/geo/nearest-zip?lat=38.94')).statusCode).toBe(400);
    // empty values are a bad point, not the point 0,0
    expect((await app.inject('/api/geo/nearest-zip?lat=&lng=')).json()).toMatchObject({ error: 'bad_point' });
    expect((await app.inject('/api/geo/nearest-zip?lat=%20&lng=-119.61')).statusCode).toBe(400);
    expect((await app.inject('/api/geo/nearest-zip?lat=30&lng=-40')).statusCode).toBe(404);
  });

  it('PUT stores the answers, GET /api/profile and /api/me return them, and the feed adapts', async () => {
    who = await seedAccount(db);
    expect((await app.inject('/api/profile')).statusCode).toBe(409);
    const quals = { statePublicWorks: 'no', samRegistered: 'unsure', bonding: 'yes', prevailingWage: 'yes' };
    const res = await put({ ...BASE, qualifications: quals });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.qualifications).toEqual(quals);
    expect((await app.inject('/api/profile')).json().profile.qualifications).toEqual(quals);
    expect((await app.inject('/api/me')).json().profile.qualifications).toEqual(quals);
    expect((await getProfileByAccount(db, who.id))!.qualifications).toEqual(quals);

    // Every SPWD bid stays in the feed, none above the alert line, each saying why.
    const items = (await app.inject('/api/feed?minScore=0&limit=300')).json().items as FeedItem[];
    expect(items).toHaveLength(13);
    for (const i of items) {
      expect(i.score, i.title).toBeLessThanOrEqual(BELOW_ALERT_CAP);
      if (i.score > 0) expect(i.reasons.map((r) => r.text)).toContain('Needs SPWD bidder qualification — you said you don’t have it yet');
    }

    // Saying "yes" later brings the good fits back.
    await put({ ...BASE, qualifications: { ...quals, statePublicWorks: 'yes' } });
    const after = (await app.inject('/api/feed?minScore=0&limit=300')).json().items as FeedItem[];
    expect(Math.max(...after.map((i) => i.score))).toBe(82);
  });

  it('GET /api/profile signed out: 401', async () => {
    expect((await app.inject('/api/profile')).statusCode).toBe(401);
  });
});
