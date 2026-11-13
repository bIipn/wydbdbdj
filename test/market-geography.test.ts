/**
 * "Similar federal jobs" for the same place must not depend on how the profile was made.
 *
 * Found in a live check: an account onboarded at ZIP 89410 got "Based on 36 federal awards in Nevada" while
 * the pilot (single mode, config/lm-electric.json) got "14 federal awards within 90 mi of Gardnerville".
 * The rule that picks the level is selectSimilarAwards (src/market/stats.ts): the first rung of
 * ZIP radius → county → state → nation with at least 10 priced awards. Its radius was measured from
 * profile.base, which is a hand-placed point for the pilot (38.9413, -119.7499) and the middle of ZIP 89410
 * for the onboarded account (38.8703, -119.6115): 8.9 miles apart. Sacramento-area awards sit right on the
 * 90-mile edge (Rancho Cordova: 85.4 mi from one, 91.5 mi from the other), so the pilot's circle reached
 * enough of them and the account's did not. Now both measure from Gardnerville, NV as the gazetteer places
 * it (the middle of the town's ZIPs): the label says "within 90 mi of Gardnerville, NV", so that is the point.
 *
 * Data: the REAL Nevada capture (USAspending, 2026-11-13) plus SYNTHETIC California awards (TEST- ids,
 * "(simulated)" winners) placed in two real Sacramento-area ZIPs. Accounts are simulated.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext, loadConfig, type AppConfig } from '../src/context.js';
import type { Db } from '../src/db/db.js';
import { recordAwardCoverage, setPricesAtAward, upsertAwards } from '../src/db/market.js';
import { saveProfileForAccount } from '../src/db/repo.js';
import { lookupCity, lookupZip, milesBetween } from '../src/geo/zip.js';
import { selectSimilarAwards } from '../src/market/stats.js';
import { refreshAwards, type AwardRow } from '../src/market/usaspending.js';
import { buildProfile, profileIdFor } from '../src/profile/build.js';
import { loadProfile } from '../src/profiles.js';
import { createBus } from '../src/realtime/bus.js';
import { register } from '../src/routes/market.js';
import type { Account, Profile } from '../src/types.js';
import { accountsConfig, fakeAuth, memoryDb, NOW, seedAccount } from './helpers.js';
import { awardsReplay } from './market-watch-replay.js';

const pilot = loadProfile('lm-electric');

/** SYNTHETIC: `n` priced awards in one California ZIP, signed in 2026. */
function caAwards(zip: string, city: string, n: number): AwardRow[] {
  return Array.from({ length: n }, (_, i) => ({
    generatedInternalId: `CONT_AWD_TEST-CA-${zip}-${i}`, awardId: `TEST-CA-${zip}-${i}`, recipient: `TEST CA Electric ${i} (simulated)`,
    agency: 'TEST Agency (simulated)', subAgency: null, naics: '238210', naicsDescription: null, psc: null, pscDescription: null,
    description: 'TEST electrical work (synthetic)', awardType: 'PURCHASE ORDER', city, county: 'SACRAMENTO', countyFips: '067',
    state: 'CA', zip, actionDate: `2026-0${1 + (i % 9)}-15`, currentAmount: 20_000 + i * 1_000, lastModified: null,
  }));
}

let db: Db;
const apps: FastifyInstance[] = [];
let account: Account;
let onboarded: Profile;

async function app(config: AppConfig, profile: Profile | null, who: Account | null): Promise<FastifyInstance> {
  const a = Fastify();
  const ctx = createContext({ db, config, bus: createBus(), auth: fakeAuth(who), now: () => NOW, profile, env: () => undefined });
  await register(a, ctx, { env: () => undefined });
  apps.push(a);
  return a;
}

beforeAll(async () => {
  db = await memoryDb();
  await refreshAwards(db, awardsReplay(), { naics: ['238210'], states: ['NV'], months: 24, now: NOW });
  // Rancho Cordova (95670) is inside 90 miles of Gardnerville, NV; Carmichael (95608) just outside it.
  const rows = [...caAwards('95670', 'RANCHO CORDOVA', 10), ...caAwards('95608', 'CARMICHAEL', 10)];
  await upsertAwards(db, rows, NOW);
  await setPricesAtAward(db, new Map(rows.map((r) => [r.generatedInternalId, { amount: r.currentAmount!, actionDate: r.actionDate }])));
  await recordAwardCoverage(db, 'CA', ['238210'], '2024-11-11', '2026-11-11', NOW);

  account = await seedAccount(db, { plan: 'pro' });
  // Exactly what L&M would type into onboarding.
  onboarded = await saveProfileForAccount(db, account.id, buildProfile(profileIdFor(account.id), {
    businessName: 'TEST Owner Electric (simulated)', trades: ['electrical'], zip: '89410', radiusMi: 90, valueRange: { min: 10_000, max: 50_000 },
  }));
});
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await db.close();
});

describe('award geography: the pilot and an account at ZIP 89410 get the same answer', () => {
  it('the cause: the two profiles carry different points for Gardnerville, and the 90-mile edge runs through Sacramento', () => {
    const zipPoint = lookupZip('89410')!;
    expect(onboarded.base).toEqual({ label: 'Gardnerville, NV', lat: zipPoint.lat, lng: zipPoint.lng });
    expect(pilot.base.label).toBe('Gardnerville, NV');
    expect(milesBetween(pilot.base, zipPoint)).toBeCloseTo(8.9, 1);
    const ranchoCordova = lookupZip('95670')!;
    expect(milesBetween(pilot.base, ranchoCordova)).toBeLessThan(90);
    expect(milesBetween(zipPoint, ranchoCordova)).toBeGreaterThan(90);
    // The old rule, measured from each profile's own base, picks different levels for the same place.
    const awards = [...caAwards('95670', 'RANCHO CORDOVA', 10)].map((a) => ({ ...a, priceAtAward: a.currentAmount }));
    const from = (p: Profile) => selectSimilarAwards(awards, { center: p.base, state: 'NV', radiusMi: 90 }, { lookupZip }).level;
    expect([from(pilot), from(onboarded)]).toEqual(['zip_radius', 'state']);
  });

  it('both modes measure from the middle of Gardnerville, NV and agree on level, count, range and wording', async () => {
    const town = lookupCity('Gardnerville', 'NV')!;
    expect(milesBetween(town, lookupZip('95670')!)).toBeLessThan(90);
    expect(milesBetween(town, lookupZip('95608')!)).toBeGreaterThan(90);

    const single = (await (await app({ ...loadConfig({}) }, pilot, null)).inject('/api/market/awards')).json();
    const accounts = (await (await app(accountsConfig(), null, account)).inject('/api/market/awards')).json();
    for (const body of [single, accounts]) {
      expect(body).toMatchObject({
        locked: false, notLoaded: false, enough: true,
        scope: { level: 'zip_radius', label: 'within 90 mi of Gardnerville, NV', radiusMi: 90, coverage: { states: ['CA', 'NV'], missingStates: [] } },
        stats: { count: 10 },
      });
      expect(body.summary).toMatch(/^Based on 10 federal awards within 90 mi of Gardnerville, NV, 2026-01-15 to 2026-09-15\./);
    }
    expect(accounts.scope).toEqual(single.scope);
    expect(accounts.stats).toEqual(single.stats);
    expect(accounts.summary).toBe(single.summary);
    expect(accounts.ladder).toEqual(single.ladder);
    expect(accounts.dateRange).toEqual(single.dateRange);
  });
});
