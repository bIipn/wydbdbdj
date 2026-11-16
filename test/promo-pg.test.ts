import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAttemptLimiter } from '../src/auth/ratelimit.js';
import { openDb, type Db } from '../src/db/db.js';
import { promoUses, redeemPromo } from '../src/db/promo.js';

/**
 * Promo use limits and the shared attempt counters on a REAL Postgres through node-postgres, where statements truly
 * run at the same time (a pool of 5 connections; the embedded database runs one statement after another, so it
 * cannot show a race). Only when TEST_DATABASE_URL names a throwaway database:
 *   TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/scratch npx vitest run test/promo-pg.test.ts
 * Accounts are synthetic (TEST- ids at example.com); code keys are made up (TEST-…), never a real code's sha256.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('promo codes and attempt counters on Postgres (TEST_DATABASE_URL)', () => {
  let db: Db;
  const made: string[] = [];
  const accounts = async (tag: string, n: number) => {
    const ids = Array.from({ length: n }, (_, i) => `TEST-promo-pg-${tag}-${i}`);
    await db.query('delete from accounts where id = any($1)', [ids]);
    for (const id of ids) await db.query('insert into accounts (id, email) values ($1, $2)', [id, `${id.toLowerCase()}@example.com`]);
    made.push(...ids);
    return ids;
  };

  beforeAll(async () => {
    db = await openDb({ url });
    await db.query(`delete from promo_codes where code_key like 'TEST-pg-%'`);
    await db.query(`delete from auth_attempts where key like 'test-pg:%'`);
  }, 60_000);
  afterAll(async () => {
    if (!db) return;
    await db.query('delete from accounts where id = any($1)', [made]);
    await db.query(`delete from promo_codes where code_key like 'TEST-pg-%'`);
    await db.query(`delete from auth_attempts where key like 'test-pg:%'`);
    await db.close();
  });

  it('twenty accounts redeeming a code with ONE use left at the same instant: exactly one gets it (audit sec-session-4)', async () => {
    for (const round of [1, 2, 3]) {
      const key = `TEST-pg-race-${round}-${Date.now()}`;
      // Two uses were taken before the gate row existed (a code redeemed under the old statement): 1 of 3 is left.
      const early = await accounts(`early-${round}`, 2);
      for (const id of early) await db.query(`insert into promo_redemptions (account_id, code_key, plan) values ($1, $2, 'pro')`, [id, key]);
      const ids = await accounts(`race-${round}`, 20);
      const outs = await Promise.all(ids.map((accountId) => redeemPromo(db, { accountId, codeKey: key, plan: 'pro', maxUses: 3, now: new Date() })));
      expect(outs.filter((o) => o === 'redeemed'), `round ${round}`).toHaveLength(1);
      expect(outs.filter((o) => o === 'used_up')).toHaveLength(19);
      expect(await promoUses(db, key)).toBe(3);
      const pro = await db.query<{ n: string }>(`select count(*) as n from accounts where id = any($1) and plan = 'pro'`, [ids]);
      expect(Number(pro[0]!.n)).toBe(1);
      // A repeat by the winner is 'again' and burns nothing.
      const winner = ids[outs.indexOf('redeemed')]!;
      expect(await redeemPromo(db, { accountId: winner, codeKey: key, plan: 'pro', maxUses: 3, now: new Date() })).toBe('again');
      expect((await db.query<{ uses: number }>('select uses from promo_codes where code_key = $1', [key]))[0]!.uses).toBe(3);
    }
  }, 60_000);

  it('a code with no use limit lets every account in and keeps no gate row', async () => {
    const key = `TEST-pg-open-${Date.now()}`;
    const ids = await accounts('open', 10);
    const outs = await Promise.all(ids.map((accountId) => redeemPromo(db, { accountId, codeKey: key, plan: 'pro', maxUses: null, now: new Date() })));
    expect(outs.every((o) => o === 'redeemed')).toBe(true);
    expect(await db.query('select 1 from promo_codes where code_key = $1', [key])).toEqual([]);
  }, 30_000);

  it('the attempt counter counts twenty simultaneous failures exactly, across the pool', async () => {
    const limiter = createAttemptLimiter(db, () => new Date(), () => {});
    const rule = { key: `test-pg:pair:${Date.now()}`, limit: 10, windowMs: 60_000 };
    const verdicts = await Promise.all(Array.from({ length: 20 }, () => limiter.count([rule])));
    expect(verdicts.filter((v) => v.ok)).toHaveLength(10);
    expect((await limiter.peek([rule.key])).get(rule.key)).toBe(20);
    expect((await limiter.check([rule])).ok).toBe(false);
  }, 30_000);
});
