/**
 * Onboarding: form answers → validated → a scoring Profile → stored and scored through PUT /api/profile.
 * Companies here are simulated ("TEST … (simulated)"); the bids they are scored on are the REAL pages in
 * test/fixtures. Sign-in is a fake AuthService, so nothing here depends on the auth module.
 */
import fc from 'fast-check';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { getProfileByAccount } from '../src/db/repo.js';
import { lookupZip } from '../src/geo/zip.js';
import { buildProfile, profileIdFor, SET_ASIDES, summarize, validateAnswers, type OnboardingAnswers } from '../src/profile/build.js';
import { loadProfile, validateProfile } from '../src/profiles.js';
import { createBus, type BusEventOf } from '../src/realtime/bus.js';
import { finalizeBid, runScan } from '../src/scan.js';
import { scoreBid, verdictFor } from '../src/score/score.js';
import { buildApp, buildServer } from '../src/server.js';
import { fixtureSources } from '../src/sources/fixtures.js';
import { mergeTrades, TRADES } from '../src/trades/catalog.js';
import type { Account, Bid, FeedItem, Profile } from '../src/types.js';
import { accountsConfig, CAPTURED, fakeAuth, memoryDb, questSource, resetDb, scanCtx, seedAccount } from './helpers.js';

const pilot = loadProfile('lm-electric');
const TRADE_IDS = TRADES.map((t) => t.id);
const CODES = SET_ASIDES.map((s) => s.code);

/** What L&M would type into the form: electrical, ZIP 89410, 90 miles, $10K to $50K, small business. */
const PILOT_ANSWERS: OnboardingAnswers = {
  businessName: 'TEST Pilot Twin Electric (simulated)',
  trades: ['electrical'],
  zip: '89410',
  radiusMi: 90,
  valueRange: { min: 10_000, max: 50_000 },
  setAsides: ['SBA'],
};

/** The answers a settings form would send back from a summary: the same fields, minus what it cannot edit. */
function answersFrom(profile: Profile): Record<string, unknown> {
  const { id: _id, base: _base, ...answers } = summarize(profile);
  return answers;
}

function built(answers: unknown, id = 'test-company'): Profile {
  const r = validateAnswers(answers);
  if (!r.ok) throw new Error(`answers should be valid: ${JSON.stringify(r.errors)}`);
  return buildProfile(id, r.value);
}

let real: Bid[]; // the real bids captured on 2026-11-13; every test here scores them as of that day (CAPTURED)
beforeAll(async () => {
  real = (await Promise.all(fixtureSources().map((s) => s.fetch(scanCtx(CAPTURED))))).flat().map(finalizeBid);
});

// ------------------------------------------------------------ validation --

describe('validateAnswers', () => {
  it('accepts the smallest valid form and returns it normalized', () => {
    expect(validateAnswers(PILOT_ANSWERS)).toEqual({ ok: true, value: PILOT_ANSWERS });
  });

  it('accepts every optional group, and keeps exactly what was sent', () => {
    const full = {
      ...PILOT_ANSWERS,
      limits: { maxJobSize: 75_000, maxUpfront: null, bondingCapacity: 250_000 },
      costs: { laborRate: 62.5, burdenPct: 38, overheadPct: 12, profitPct: 10 },
      alerts: {
        minScore: 70, push: true, quietHours: { start: '21:00', end: '06:00' }, timeZone: 'America/Los_Angeles',
        kinds: { match: true, deadline: true, award: false, price: false },
      },
      setAsides: ['SBA', 'SDVOSBC'],
    };
    expect(validateAnswers(full)).toEqual({ ok: true, value: full });
  });

  it('normalizes: trims the name, takes the 5-digit ZIP, orders trades as the catalog does, fixes set-aside case', () => {
    const r = validateAnswers({
      ...PILOT_ANSWERS,
      businessName: '  TEST   Messy  Name (simulated) ',
      zip: ' 89410-1234 ',
      trades: ['roofing', 'electrical', 'roofing'],
      setAsides: ['sba', ' wosb ', 'SBA', 'biciv'],
      limits: null,
      alerts: null,
    });
    expect(r).toEqual({
      ok: true,
      value: {
        ...PILOT_ANSWERS, businessName: 'TEST Messy Name (simulated)', zip: '89410', trades: ['electrical', 'roofing'],
        setAsides: ['SBA', 'WOSB', 'BICiv'],
      },
    });
  });

  it('accepts the edges of every range', () => {
    const edges: unknown[] = [
      { ...PILOT_ANSWERS, businessName: 'AB' },
      { ...PILOT_ANSWERS, businessName: 'T'.repeat(80) },
      { ...PILOT_ANSWERS, radiusMi: 5 },
      { ...PILOT_ANSWERS, radiusMi: 500 },
      { ...PILOT_ANSWERS, radiusMi: 37.5 },
      { ...PILOT_ANSWERS, valueRange: { min: 0, max: 1 } },
      { ...PILOT_ANSWERS, trades: TRADE_IDS.slice(0, 4) },
      { ...PILOT_ANSWERS, limits: { maxJobSize: 0 } },
      { ...PILOT_ANSWERS, limits: {} },
      { ...PILOT_ANSWERS, costs: { laborRate: 0, burdenPct: null } },
      { ...PILOT_ANSWERS, alerts: { minScore: 0 } },
      { ...PILOT_ANSWERS, alerts: { minScore: 100, quietHours: null } },
      { ...PILOT_ANSWERS, alerts: { quietHours: { start: '00:00', end: '23:59' } } },
      { ...PILOT_ANSWERS, alerts: { timeZone: 'America/New_York', kinds: {} } },
      { ...PILOT_ANSWERS, setAsides: [] },
      { ...PILOT_ANSWERS, setAsides: CODES },
    ];
    for (const input of edges) expect(validateAnswers(input), JSON.stringify(input)).toMatchObject({ ok: true });
  });

  // [what is wrong, the bad input, the one field the error is filed under, what the message says]
  const bad: Array<[string, unknown, string, RegExp]> = [
    ['no business name', { ...PILOT_ANSWERS, businessName: undefined }, 'businessName', /^Enter your business name\.$/],
    ['blank business name', { ...PILOT_ANSWERS, businessName: '   ' }, 'businessName', /^Enter your business name\.$/],
    ['business name is not text', { ...PILOT_ANSWERS, businessName: 12345 }, 'businessName', /^Enter your business name\.$/],
    ['1-character name', { ...PILOT_ANSWERS, businessName: ' A ' }, 'businessName', /at least 2 characters/],
    ['81-character name', { ...PILOT_ANSWERS, businessName: 'T'.repeat(81) }, 'businessName', /at most 80 characters/],
    ['no trades', { ...PILOT_ANSWERS, trades: undefined }, 'trades', /^Pick at least one trade\.$/],
    ['empty trades', { ...PILOT_ANSWERS, trades: [] }, 'trades', /^Pick at least one trade\.$/],
    ['trades is not a list', { ...PILOT_ANSWERS, trades: 'electrical' }, 'trades', /^Pick at least one trade\.$/],
    ['unknown trade', { ...PILOT_ANSWERS, trades: ['electrical', 'TEST-no-such-trade'] }, 'trades', /^Unknown trade “TEST-no-such-trade”\.$/],
    ['a trade that is not text', { ...PILOT_ANSWERS, trades: [null] }, 'trades', /^Unknown trade “null”\.$/],
    ['five trades', { ...PILOT_ANSWERS, trades: TRADE_IDS.slice(0, 5) }, 'trades', /^Pick up to 4 trades\.$/],
    ['no ZIP', { ...PILOT_ANSWERS, zip: undefined }, 'zip', /^Enter a 5-digit ZIP code\.$/],
    ['4-digit ZIP', { ...PILOT_ANSWERS, zip: '8941' }, 'zip', /^Enter a 5-digit ZIP code\.$/],
    ['ZIP as a number', { ...PILOT_ANSWERS, zip: 89410 }, 'zip', /^Enter a 5-digit ZIP code\.$/],
    ['a Canadian postal code', { ...PILOT_ANSWERS, zip: 'K1A 0B1' }, 'zip', /^Enter a 5-digit ZIP code\.$/],
    ['a ZIP that does not exist', { ...PILOT_ANSWERS, zip: '00000' }, 'zip', /^We can’t find ZIP 00000\. Check the number\.$/],
    ['no radius', { ...PILOT_ANSWERS, radiusMi: undefined }, 'radiusMi', /from 5 to 500 miles/],
    ['radius under 5', { ...PILOT_ANSWERS, radiusMi: 4.9 }, 'radiusMi', /from 5 to 500 miles/],
    ['radius over 500', { ...PILOT_ANSWERS, radiusMi: 501 }, 'radiusMi', /from 5 to 500 miles/],
    ['radius as text', { ...PILOT_ANSWERS, radiusMi: '90' }, 'radiusMi', /from 5 to 500 miles/],
    ['radius not a number', { ...PILOT_ANSWERS, radiusMi: Number.NaN }, 'radiusMi', /from 5 to 500 miles/],
    ['endless radius', { ...PILOT_ANSWERS, radiusMi: Number.POSITIVE_INFINITY }, 'radiusMi', /from 5 to 500 miles/],
    ['no job sizes', { ...PILOT_ANSWERS, valueRange: undefined }, 'valueRange', /smallest and the largest job/],
    ['job sizes as a list', { ...PILOT_ANSWERS, valueRange: [10_000, 50_000] }, 'valueRange', /smallest and the largest job/],
    ['negative smallest job', { ...PILOT_ANSWERS, valueRange: { min: -1, max: 10 } }, 'valueRange.min', /0 or more/],
    ['no largest job', { ...PILOT_ANSWERS, valueRange: { min: 0 } }, 'valueRange.max', /must be a dollar amount/],
    ['endless largest job', { ...PILOT_ANSWERS, valueRange: { min: 0, max: Number.POSITIVE_INFINITY } }, 'valueRange.max', /must be a dollar amount/],
    ['smallest equals largest', { ...PILOT_ANSWERS, valueRange: { min: 5000, max: 5000 } }, 'valueRange.max', /more than the smallest job/],
    ['smallest above largest', { ...PILOT_ANSWERS, valueRange: { min: 9, max: 5 } }, 'valueRange.max', /more than the smallest job/],
    ['extra key in job sizes', { ...PILOT_ANSWERS, valueRange: { min: 0, max: 1, typical: 3 } }, 'valueRange.typical', /^Unknown field “valueRange\.typical”\.$/],
    ['limits is not a group', { ...PILOT_ANSWERS, limits: 'none' }, 'limits', /must be a group of settings/],
    ['negative max job size', { ...PILOT_ANSWERS, limits: { maxJobSize: -1 } }, 'limits.maxJobSize', /^Max job size must be a number, 0 or more/],
    ['up-front cost as text', { ...PILOT_ANSWERS, limits: { maxUpfront: '20000' } }, 'limits.maxUpfront', /^Max up-front cost must be a number/],
    ['endless bonding capacity', { ...PILOT_ANSWERS, limits: { bondingCapacity: Number.POSITIVE_INFINITY } }, 'limits.bondingCapacity', /^Bonding capacity must be a number/],
    ['misspelled limit', { ...PILOT_ANSWERS, limits: { maxJobsize: 50_000 } }, 'limits.maxJobsize', /^Unknown field “limits\.maxJobsize”\.$/],
    ['negative labor rate', { ...PILOT_ANSWERS, costs: { laborRate: -5 } }, 'costs.laborRate', /^Labor rate must be a number, 0 or more/],
    ['burden is not a number', { ...PILOT_ANSWERS, costs: { burdenPct: Number.NaN } }, 'costs.burdenPct', /^Burden % must be a number/],
    ['overhead as text', { ...PILOT_ANSWERS, costs: { overheadPct: '12%' } }, 'costs.overheadPct', /^Overhead % must be a number/],
    ['negative profit', { ...PILOT_ANSWERS, costs: { profitPct: -0.5 } }, 'costs.profitPct', /^Profit % must be a number/],
    ['unknown cost setting', { ...PILOT_ANSWERS, costs: { markup: 10 } }, 'costs.markup', /^Unknown field “costs\.markup”\.$/],
    ['alert score over 100', { ...PILOT_ANSWERS, alerts: { minScore: 101 } }, 'alerts.minScore', /from 0 to 100/],
    ['alert score under 0', { ...PILOT_ANSWERS, alerts: { minScore: -1 } }, 'alerts.minScore', /from 0 to 100/],
    ['alert score as text', { ...PILOT_ANSWERS, alerts: { minScore: '70' } }, 'alerts.minScore', /from 0 to 100/],
    ['push is not yes/no', { ...PILOT_ANSWERS, alerts: { push: 'yes' } }, 'alerts.push', /on \(true\) or off \(false\)/],
    ['quiet hours on a 12-hour clock', { ...PILOT_ANSWERS, alerts: { quietHours: { start: '9pm', end: '06:00' } } }, 'alerts.quietHours', /like 21:00 and 06:00/],
    ['quiet hours at 24:00', { ...PILOT_ANSWERS, alerts: { quietHours: { start: '24:00', end: '06:00' } } }, 'alerts.quietHours', /like 21:00 and 06:00/],
    ['quiet hours at 21:60', { ...PILOT_ANSWERS, alerts: { quietHours: { start: '21:60', end: '06:00' } } }, 'alerts.quietHours', /like 21:00 and 06:00/],
    ['quiet hours without an end', { ...PILOT_ANSWERS, alerts: { quietHours: { start: '21:00' } } }, 'alerts.quietHours', /like 21:00 and 06:00/],
    ['quiet hours as text', { ...PILOT_ANSWERS, alerts: { quietHours: '21:00-06:00' } }, 'alerts.quietHours', /like 21:00 and 06:00/],
    ['quiet hours of no length', { ...PILOT_ANSWERS, alerts: { quietHours: { start: '21:00', end: '21:00' } } }, 'alerts.quietHours', /different start and end times/],
    ['extra key in quiet hours', { ...PILOT_ANSWERS, alerts: { quietHours: { start: '21:00', end: '06:00', days: ['sat'] } } }, 'alerts.quietHours.days', /^Unknown field “alerts\.quietHours\.days”\.$/],
    ['made-up time zone', { ...PILOT_ANSWERS, alerts: { timeZone: 'Mars/Olympus_Mons' } }, 'alerts.timeZone', /^Unknown time zone “Mars\/Olympus_Mons”\.$/],
    ['time zone is not text', { ...PILOT_ANSWERS, alerts: { timeZone: -8 } }, 'alerts.timeZone', /^Unknown time zone/],
    ['alert kinds is not a group', { ...PILOT_ANSWERS, alerts: { kinds: true } }, 'alerts.kinds', /must be a group of settings/],
    ['an alert kind is not yes/no', { ...PILOT_ANSWERS, alerts: { kinds: { match: 'on' } } }, 'alerts.kinds.match', /on \(true\) or off \(false\)/],
    ['unknown alert kind', { ...PILOT_ANSWERS, alerts: { kinds: { sms: true } } }, 'alerts.kinds.sms', /^Unknown field “alerts\.kinds\.sms”\.$/],
    ['unknown alert setting', { ...PILOT_ANSWERS, alerts: { sound: true } }, 'alerts.sound', /^Unknown field “alerts\.sound”\.$/],
    ['set-asides is not a list', { ...PILOT_ANSWERS, setAsides: 'SBA' }, 'setAsides', /must be a list of codes/],
    ['unknown set-aside code', { ...PILOT_ANSWERS, setAsides: ['SBA', 'TEST-XX'] }, 'setAsides', /^Unknown set-aside code “TEST-XX”\.$/],
    ['two unknown set-aside codes (the first is the one named)', { ...PILOT_ANSWERS, setAsides: ['TEST-A', 'TEST-B'] }, 'setAsides', /“TEST-A”/],
    ['trying to pick a profile id', { ...PILOT_ANSWERS, id: 'lm-electric' }, 'id', /^Unknown field “id”\.$/],
    ['trying to send keyword lists', { ...PILOT_ANSWERS, keywords: pilot.keywords }, 'keywords', /^Unknown field “keywords”\.$/],
    ['a "__proto__" key', JSON.parse(`{"__proto__":{"plan":"pro"},${JSON.stringify(PILOT_ANSWERS).slice(1)}`), '__proto__', /^Unknown field “__proto__”\.$/],
    ['nothing at all', undefined, 'form', /one JSON object/],
    ['null', null, 'form', /one JSON object/],
    ['a list', [PILOT_ANSWERS], 'form', /one JSON object/],
    ['text', JSON.stringify(PILOT_ANSWERS), 'form', /one JSON object/],
  ];
  it.each(bad)('rejects %s', (_what, input, field, message) => {
    const r = validateAnswers(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors)).toEqual([field]); // exactly one problem, filed under the field it belongs to
    expect(r.errors[field]).toMatch(message);
  });

  it('reports every field that is wrong in one go, each with a full sentence', () => {
    const r = validateAnswers({ businessName: '', trades: [], zip: 'x', radiusMi: 0, valueRange: { min: 2, max: 1 }, limits: { maxJobSize: -1 }, extra: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(['businessName', 'extra', 'limits.maxJobSize', 'radiusMi', 'trades', 'valueRange.max', 'zip']);
    for (const message of Object.values(r.errors)) expect(message).toMatch(/^[A-Z“].*\.$/);
  });

  it('never lets a long or multi-line value into a message', () => {
    const r = validateAnswers({ ...PILOT_ANSWERS, setAsides: [`TEST\n${'x'.repeat(500)}`] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.setAsides!.length).toBeLessThan(80);
    expect(r.errors.setAsides).not.toMatch(/\n/);
  });
});

// --------------------------------------------------------------- building --

describe('buildProfile', () => {
  it('turns the pilot\'s answers into a full profile that passes validateProfile', () => {
    const p = built(PILOT_ANSWERS, 'test-pilot-twin');
    expect(() => validateProfile(p)).not.toThrow();
    const home = lookupZip('89410')!;
    expect(p).toEqual({
      id: 'test-pilot-twin',
      name: 'TEST Pilot Twin Electric (simulated)',
      base: { label: 'Gardnerville, NV', lat: home.lat, lng: home.lng },
      states: ['NV', 'CA'], // home state first
      maxDistanceMi: 90,
      valueRange: { min: 10_000, max: 50_000 },
      minDaysToBid: 5,
      keywords: mergeTrades(['electrical']).keywords,
      naics: pilot.naics,
      setAsidesEligible: ['SBA', 'SBP'],
      notify: { minScore: 55 },
      trades: ['electrical'],
      zip: '89410',
      limits: {},
      costs: {},
      alerts: { minScore: 55 },
    });
    // The same things the pilot's hand-written config says.
    for (const key of ['states', 'maxDistanceMi', 'valueRange', 'minDaysToBid', 'naics', 'setAsidesEligible', 'notify'] as const) {
      expect(p[key], key).toEqual(pilot[key]);
    }
    for (const list of ['strong', 'related', 'general', 'otherTrades'] as const) expect(p.keywords[list], list).toEqual(pilot.keywords[list]);
    expect(p.base.label).toBe(pilot.base.label);
  });

  it('with the pilot\'s home base, scores every real bid exactly as the pilot profile does', () => {
    const twin = { ...built(PILOT_ANSWERS), base: pilot.base };
    const differentWording: string[] = [];
    for (const b of real) {
      const mine = scoreBid(b, twin, CAPTURED);
      const theirs = scoreBid(b, pilot, CAPTURED);
      expect({ score: mine.score, verdict: mine.verdict, distanceMi: mine.distanceMi, overLimit: mine.overLimit }, b.title)
        .toEqual({ score: theirs.score, verdict: theirs.verdict, distanceMi: theirs.distanceMi, overLimit: theirs.overLimit });
      expect(!!mine.rejected, b.title).toBe(!!theirs.rejected);
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) differentWording.push(b.title);
    }
    // config/lm-electric.json and the electrical trade template now carry the same keyword lists, exclude
    // list included (the pilot's sample-tuned words such as "kiosk" and "customer portal" were replaced by
    // the shared list), so every bid, rejected ones too, is worded the same way.
    expect(twin.keywords).toEqual(pilot.keywords);
    expect(differentWording).toEqual([]);
  });

  it('from ZIP 89410 itself, scores a real bid the same as the pilot whenever it lands in the same distance band', () => {
    // The ZIP's centre is a few miles from the point in the pilot's config, so distances shift a little.
    const twin = built(PILOT_ANSWERS);
    const band = (mi: number | null) => (mi === null ? 'none' : mi > 90 ? 'out' : mi <= 25 ? '25' : mi <= 50 ? '50' : mi <= 75 ? '75' : '90');
    let sameBand = 0;
    for (const b of real) {
      const mine = scoreBid(b, twin, CAPTURED);
      const theirs = scoreBid(b, pilot, CAPTURED);
      if (band(mine.distanceMi) !== band(theirs.distanceMi)) continue;
      sameBand++;
      expect(mine.score, b.title).toBe(theirs.score);
      expect(mine.verdict, b.title).toBe(theirs.verdict);
    }
    expect(sameBand).toBeGreaterThanOrEqual(28);
    // Named examples, straight off the real pages.
    const score = (title: RegExp, p: Profile) => scoreBid(real.find((b) => title.test(b.title))!, p, CAPTURED).score;
    for (const title of [/^Generator$/, /^Replace Cell Doors, Locks, Intercoms/, /^Elevator Modernization \(Bryan/, /^Water Well Repair$/, /^Roofing Replacement, State Museum/]) {
      expect(score(title, twin), String(title)).toBe(score(title, pilot));
    }
    // 40, not v0's 60: a NevadaEPro title that names no work ("Generator") is likely a purchase (-25).
    expect(score(/^Generator$/, twin)).toBe(40);
    expect(score(/^Replace Cell Doors, Locks, Intercoms/, twin)).toBe(82);
  });

  it('carries limits, costs and alert settings through, and fills in the defaults', () => {
    const p = built({
      ...PILOT_ANSWERS,
      limits: { maxJobSize: 75_000, bondingCapacity: null },
      costs: { laborRate: 62.5, burdenPct: 38 },
      alerts: { minScore: 70, push: true, quietHours: { start: '21:00', end: '06:00' } },
    });
    expect(p.limits).toEqual({ maxJobSize: 75_000, bondingCapacity: null });
    expect(p.costs).toEqual({ laborRate: 62.5, burdenPct: 38 });
    expect(p.alerts).toEqual({ minScore: 70, push: true, quietHours: { start: '21:00', end: '06:00' } });
    expect(p.notify).toEqual({ minScore: 55 }); // the digest line does not move with the alert line
    expect(p.minDaysToBid).toBe(5);
  });

  it('claims no set-aside unless told, and treats both codes of one program as one', () => {
    const { setAsides: _none, ...unsaid } = PILOT_ANSWERS;
    expect(built(unsaid).setAsidesEligible).toEqual([]);
    expect(built({ ...PILOT_ANSWERS, setAsides: [] }).setAsidesEligible).toEqual([]);
    expect(built({ ...PILOT_ANSWERS, setAsides: ['SBP'] }).setAsidesEligible).toEqual(['SBA', 'SBP']);
    expect(built({ ...PILOT_ANSWERS, setAsides: ['SDVOSBC', '8AN', 'LAS'] }).setAsidesEligible).toEqual(['8A', '8AN', 'SDVOSBC', 'SDVOSBS', 'LAS']);
    expect(built({ ...PILOT_ANSWERS, setAsides: CODES }).setAsidesEligible).toEqual(CODES);
  });

  it('merges several trades and sets the home base from any US ZIP', () => {
    const p = built({ ...PILOT_ANSWERS, trades: ['roofing', 'electrical'], zip: '96150', radiusMi: 40 });
    expect(p.trades).toEqual(['electrical', 'roofing']);
    expect(p.keywords).toEqual(mergeTrades(['electrical', 'roofing']).keywords);
    expect(p.naics.strong).toEqual(['238210', '238160']);
    expect(p.base.label).toBe('South Lake Tahoe, CA');
    expect(p.states.slice(0, 1)).toEqual(['CA']);
    expect(p.states).toContain('NV'); // the state line is a few miles away
    expect(p.zip).toBe('96150');
    expect(() => validateProfile(p)).not.toThrow();
  });

  it('throws on answers that skipped validation', () => {
    expect(() => buildProfile('test-x', { ...PILOT_ANSWERS, zip: '00000' })).toThrow(/unknown ZIP "00000"/);
    expect(() => buildProfile('test-x', { ...PILOT_ANSWERS, trades: ['TEST-no-such-trade'] })).toThrow(/Unknown trade/);
  });

  it('saving a summary back as answers builds the very same profile', () => {
    const first = built({
      ...PILOT_ANSWERS, trades: ['hvac', 'plumbing'], limits: { maxJobSize: 120_000 }, costs: { laborRate: 55 },
      alerts: { minScore: 65, kinds: { price: false } }, setAsides: ['WOSB'],
    });
    expect(built(answersFrom(first))).toEqual(first);
    expect(built(answersFrom(built(PILOT_ANSWERS)))).toEqual(built(PILOT_ANSWERS));
  });
});

// ------------------------------------------- simulated companies (random) --

/** Real ZIPs across the country, so the simulated companies sit in real places. */
const ZIPS = ['89410', '89701', '89502', '96150', '95814', '10001', '60601', '78701', '99501', '96813', '00601', '04101', '33101', '98101'];
const clock = fc.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
  .map(([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
const dollars = fc.option(fc.integer({ min: 0, max: 5_000_000 }), { nil: null });
const pct = fc.option(fc.double({ min: 0, max: 200, noNaN: true }), { nil: null });

/** A made-up but realistic company's answers. Trades come out in catalog order (subarray keeps order). */
const simulatedCompany: fc.Arbitrary<OnboardingAnswers> = fc.record(
  {
    businessName: fc.tuple(fc.stringMatching(/^[A-Z][a-z]{2,9}$/), fc.constantFrom('Electric', 'Mechanical', 'Roofing', 'Builders', 'Services'))
      .map(([word, kind]) => `TEST ${word} ${kind} (simulated)`),
    trades: fc.subarray(TRADE_IDS, { minLength: 1, maxLength: 4 }),
    zip: fc.constantFrom(...ZIPS),
    radiusMi: fc.integer({ min: 5, max: 500 }),
    valueRange: fc.tuple(fc.integer({ min: 0, max: 500_000 }), fc.integer({ min: 1, max: 5_000_000 })).map(([min, more]) => ({ min, max: min + more })),
    limits: fc.record({ maxJobSize: dollars, maxUpfront: dollars, bondingCapacity: dollars }, { requiredKeys: [] }),
    costs: fc.record({ laborRate: pct, burdenPct: pct, overheadPct: pct, profitPct: pct }, { requiredKeys: [] }),
    alerts: fc.record(
      {
        minScore: fc.integer({ min: 0, max: 100 }),
        push: fc.boolean(),
        quietHours: fc.option(fc.tuple(clock, clock).filter(([a, b]) => a !== b).map(([start, end]) => ({ start, end })), { nil: null }),
        timeZone: fc.constantFrom('America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Anchorage', 'Pacific/Honolulu'),
        kinds: fc.record({ match: fc.boolean(), deadline: fc.boolean(), award: fc.boolean(), price: fc.boolean() }, { requiredKeys: [] }),
      },
      { requiredKeys: [] },
    ),
    setAsides: fc.subarray(CODES),
  },
  { requiredKeys: ['businessName', 'trades', 'zip', 'radiusMi', 'valueRange'] },
);

describe('simulated companies', () => {
  it('uses real ZIPs', () => {
    for (const zip of ZIPS) expect(lookupZip(zip), zip).toMatchObject({ zip });
  });

  it('ANY well-formed answers validate unchanged (also after a trip through JSON) and build a valid profile', () => {
    fc.assert(
      fc.property(simulatedCompany, (answers) => {
        const sent = JSON.parse(JSON.stringify(answers)) as unknown;
        const r = validateAnswers(sent);
        expect(r).toEqual({ ok: true, value: sent });
        if (!r.ok) return;
        const p = buildProfile('test-company', r.value);
        expect(() => validateProfile(p)).not.toThrow();

        const home = lookupZip(answers.zip)!;
        expect(p.base).toEqual({ label: `${home.city}, ${home.state}`, lat: home.lat, lng: home.lng });
        expect(p.states[0]).toBe(home.state);
        expect(new Set(p.states).size).toBe(p.states.length);
        expect(p.maxDistanceMi).toBe(answers.radiusMi);
        expect(p.valueRange).toEqual(answers.valueRange);
        expect(p.trades).toEqual(answers.trades);
        expect({ keywords: p.keywords, naics: p.naics }).toEqual({ keywords: mergeTrades(answers.trades).keywords, naics: mergeTrades(answers.trades).naics });
        expect(p.alerts!.minScore).toBe(answers.alerts?.minScore ?? 55);
        for (const code of answers.setAsides ?? []) expect(p.setAsidesEligible).toContain(code);
        for (const code of p.setAsidesEligible) expect(CODES).toContain(code);
      }),
    );
  });

  it('for ANY company, saving its summary back builds the same profile (a settings save changes nothing by itself)', () => {
    fc.assert(
      fc.property(simulatedCompany, (answers) => {
        const first = built(answers);
        const again = built(JSON.parse(JSON.stringify(answersFrom(first))));
        expect(again).toEqual(first);
      }),
    );
  });

  it('ANY extra top-level key is refused, whatever it is called', () => {
    const known = ['businessName', 'trades', 'zip', 'radiusMi', 'valueRange', 'limits', 'costs', 'alerts', 'setAsides'];
    const anyKey = fc.oneof(fc.string({ minLength: 1, maxLength: 12 }), fc.constantFrom('__proto__', 'constructor', 'toString', 'id', 'plan', 'keywords'));
    fc.assert(
      fc.property(simulatedCompany, anyKey, fc.jsonValue(), (answers, key, value) => {
        fc.pre(!known.includes(key));
        const sent = JSON.parse(JSON.stringify(answers)) as Record<string, unknown>;
        Object.defineProperty(sent, key, { value, enumerable: true });
        const r = validateAnswers(sent);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(Object.keys(r.errors)).toEqual([key]);
      }),
    );
  });

  it('for ANY company on the real bids: scores are whole numbers 0 to 100, out-of-range bids are rejected, and a wider radius never loses a bid', () => {
    fc.assert(
      fc.property(simulatedCompany, fc.integer({ min: 0, max: 400 }), (answers, extraMiles) => {
        // Spend limits are scored elsewhere (test/score.test.ts); leave them out so only this module is under test.
        const { limits: _limits, ...noLimits } = answers;
        const near = built(noLimits);
        const far = built({ ...noLimits, radiusMi: Math.min(500, answers.radiusMi + extraMiles) });
        expect(far.states).toEqual(expect.arrayContaining(near.states));
        for (const b of real) {
          const r = scoreBid(b, near, CAPTURED);
          expect(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100, `${b.title}: ${r.score}`).toBe(true);
          expect(r.verdict).toBe(verdictFor(r.score));
          if (r.distanceMi !== null && r.distanceMi > near.maxDistanceMi) expect(r.rejected, b.title).toBeTruthy();
          if (r.rejected) expect(r.score).toBe(0);
          else expect(scoreBid(b, far, CAPTURED).score, b.title).toBe(r.score);
        }
      }),
      { numRuns: 50 },
    );
  });
});

// ----------------------------------------------------------------- routes --

describe('profile routes', () => {
  let db: Db;
  let app: FastifyInstance;
  let demo: FastifyInstance;
  let who: Account | null = null;
  const bus = createBus();
  const matches: Array<BusEventOf<'match'>> = [];
  bus.on('match', (e) => void matches.push(e));

  const put = (payload?: unknown, on: FastifyInstance = app) =>
    on.inject({ method: 'PUT', url: '/api/profile', headers: { 'x-bidswipe': '1' }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const me = async (on: FastifyInstance = app) => (await on.inject('/api/me')).json();
  const feed = async () => (await app.inject('/api/feed?minScore=0&limit=300')).json().items as FeedItem[];

  beforeAll(async () => {
    db = await memoryDb();
    const opts = { bus, auth: fakeAuth(() => who), now: () => CAPTURED };
    app = (await buildApp({ db }, { ...opts, config: accountsConfig() })).app;
    demo = await buildServer({ db }, { ...opts, config: accountsConfig({ demoMode: true }) });
  });
  beforeEach(async () => {
    await resetDb(db);
    // 13 real open bids (NV State Public Works), no profiles yet.
    await runScan({ db, sources: [questSource()], profiles: [], ctx: scanCtx(CAPTURED) });
    matches.length = 0;
    who = null;
  });
  afterAll(async () => {
    await app.close();
    await demo.close();
    await db.close();
  });

  it('signed out: PUT /api/profile answers 401 and stores nothing', async () => {
    const res = await put(PILOT_ANSWERS);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'sign_in_required' });
    expect(await db.query('select id from profiles')).toEqual([]);
  });

  it('a new company answers the form and has a scored, personal feed at once', async () => {
    who = await seedAccount(db);
    expect(await me()).toMatchObject({ profile: null, needsOnboarding: true });
    expect((await app.inject('/api/feed')).json()).toEqual({ error: 'onboarding_required' });

    const res = await put(PILOT_ANSWERS);
    expect(res.statusCode).toBe(200);
    const summary = {
      id: profileIdFor(who.id), businessName: 'TEST Pilot Twin Electric (simulated)', trades: ['electrical'], zip: '89410',
      base: 'Gardnerville, NV', radiusMi: 90, valueRange: { min: 10_000, max: 50_000 }, limits: {}, costs: {},
      alerts: { minScore: 55 }, setAsides: ['SBA', 'SBP'],
    };
    expect(res.json()).toEqual({ profile: summary, scored: 13 });

    expect(await me()).toMatchObject({
      account: { id: who.id, plan: 'free' }, needsOnboarding: false, profile: summary,
      // the fields the v0 client reads
      id: summary.id, name: summary.businessName, base: 'Gardnerville, NV', maxDistanceMi: 90, valueRange: summary.valueRange, notifyMinScore: 55,
    });

    // The feed is this profile's own scoring of the 13 real bids, best first.
    const stored = (await getProfileByAccount(db, who.id))!;
    expect(stored).toEqual(built(PILOT_ANSWERS, summary.id));
    const items = await feed();
    expect(items).toHaveLength(13);
    for (const item of items) expect(item.score, item.title).toBe(scoreBid(item, stored, CAPTURED).score);
    expect(items.map((b) => b.score)).toEqual(items.map((b) => b.score).sort((x, y) => y - x));
    expect(items.find((b) => b.title.startsWith('Replace Cell Doors, Locks, Intercoms'))).toMatchObject({ score: 82, verdict: 'great' });
    expect(items[0]!.score).toBe(82);
  });

  it('publishes a match for each bid at or above the alert line, marked as not new', async () => {
    who = await seedAccount(db);
    await put({ ...PILOT_ANSWERS, alerts: { minScore: 80 } });
    const good = (await feed()).filter((b) => b.score >= 80);
    expect(good.length).toBeGreaterThan(0);
    expect(matches.map((e) => e.bid.id).sort()).toEqual(good.map((b) => b.id).sort());
    for (const e of matches) expect(e).toMatchObject({ type: 'match', profileId: profileIdFor(who.id), isNewBid: false });
  });

  it('bad answers: 400 with one message per field, and nothing is stored', async () => {
    who = await seedAccount(db);
    const res = await put({ ...PILOT_ANSWERS, zip: '00000', radiusMi: 9000, id: 'lm-electric' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'invalid_profile',
      message: 'Some answers need fixing.',
      fields: {
        id: 'Unknown field “id”.',
        zip: 'We can’t find ZIP 00000. Check the number.',
        radiusMi: 'Travel radius must be a number from 5 to 500 miles.',
      },
    });
    expect((await put()).json()).toMatchObject({ error: 'invalid_profile', fields: { form: expect.any(String) } });
    expect((await put([])).statusCode).toBe(400);
    expect(await me()).toMatchObject({ needsOnboarding: true });
    expect(matches).toEqual([]);
  });

  it('a later save replaces the settings, keeps the profile id and what was saved, and re-scores', async () => {
    who = await seedAccount(db);
    const first = (await put(PILOT_ANSWERS)).json().profile;
    const roofs = (await feed()).filter((b) => b.title.startsWith('Roofing Replacement'));
    expect(roofs).toHaveLength(4);
    for (const b of roofs) expect(b.score).toBeLessThan(35); // not an electrician's job
    await app.inject({ method: 'POST', url: '/api/swipe', headers: { 'x-bidswipe': '1' }, payload: { bidId: roofs[0]!.id, action: 'save' } });

    // A limit far above any of these jobs: stored and shown, without putting a bid over it.
    const res = await put({ ...PILOT_ANSWERS, businessName: 'TEST Pilot Twin Roofing (simulated)', trades: ['roofing'], radiusMi: 60, limits: { maxJobSize: 90_000_000 } });
    expect(res.json()).toMatchObject({
      scored: 13,
      profile: { id: first.id, businessName: 'TEST Pilot Twin Roofing (simulated)', trades: ['roofing'], radiusMi: 60, limits: { maxJobSize: 90_000_000 } },
    });
    expect(await db.query('select id from profiles')).toEqual([{ id: first.id }]);

    const again = (await app.inject('/api/feed?minScore=0&limit=300&all=1')).json().items as FeedItem[];
    const nearRoofs = again.filter((x) => x.title.startsWith('Roofing Replacement') && x.distanceMi !== null);
    expect(nearRoofs).toHaveLength(3); // the fourth lists no location
    for (const b of nearRoofs) expect(b.score, b.title).toBeGreaterThanOrEqual(55);
    expect(((await app.inject('/api/saved')).json().items as FeedItem[]).map((b) => b.id)).toEqual([roofs[0]!.id]);
  });

  it('each account gets its own profile; one company\'s save never touches another\'s', async () => {
    const a = await seedAccount(db);
    const b = await seedAccount(db);
    who = a;
    await put(PILOT_ANSWERS);
    who = b;
    await put({ ...PILOT_ANSWERS, businessName: 'TEST Other Plumbing (simulated)', trades: ['plumbing'], zip: '89701' });
    expect(await me()).toMatchObject({ id: profileIdFor(b.id), profile: { trades: ['plumbing'], base: 'Carson City, NV' } });
    who = a;
    expect(await me()).toMatchObject({ id: profileIdFor(a.id), profile: { trades: ['electrical'], base: 'Gardnerville, NV' } });
    expect((await db.query<{ id: string }>('select id from profiles order by id')).map((r) => r.id)).toEqual([profileIdFor(a.id), profileIdFor(b.id)].sort());
  });

  it('cost settings are stored for any plan but only shown once the plan includes them', async () => {
    const account = await seedAccount(db); // free
    who = account;
    const costs = { laborRate: 62.5, burdenPct: 38, overheadPct: 12, profitPct: 10 };

    const res = await put({ ...PILOT_ANSWERS, costs });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.costs).toEqual({});
    expect((await me()).profile.costs).toEqual({});
    expect((await getProfileByAccount(db, account.id))!.costs).toEqual(costs);

    // The free form is never shown the numbers, so it saves without them (or sends back the empty group): they stay.
    await put({ ...PILOT_ANSWERS, radiusMi: 120 });
    await put({ ...PILOT_ANSWERS, radiusMi: 120, costs: {} });
    expect((await getProfileByAccount(db, account.id))!).toMatchObject({ maxDistanceMi: 120, costs });
    // Numbers it does send replace the stored ones, still without being shown.
    expect((await put({ ...PILOT_ANSWERS, costs: { laborRate: 80 } })).json().profile.costs).toEqual({});
    expect((await getProfileByAccount(db, account.id))!.costs).toEqual({ laborRate: 80 });
    await put({ ...PILOT_ANSWERS, costs });

    // Same account on Pro (or any account in demo mode): the numbers are there.
    who = { ...account, plan: 'pro' };
    expect(await me()).toMatchObject({ features: { costSettings: true }, profile: { costs } });
    who = account;
    expect(await me(demo)).toMatchObject({ features: { costSettings: true }, profile: { costs } });

    // A plan that shows them can change and clear them.
    who = { ...account, plan: 'pro' };
    expect((await put({ ...PILOT_ANSWERS, costs: { laborRate: 70 } })).json().profile.costs).toEqual({ laborRate: 70 });
    expect((await put(PILOT_ANSWERS)).json().profile.costs).toEqual({});
    expect((await getProfileByAccount(db, account.id))!.costs).toEqual({});
  });

  it('GET /api/trades lists every trade in catalog order plus the set-aside codes, signed in or not', async () => {
    const body = (await app.inject('/api/trades')).json() as {
      trades: Array<{ id: string; label: string; blurb: string; naics: string[] }>;
      setAsides: Array<{ code: string; label: string; pair: string | null }>;
    };
    expect(body.trades.map((t) => t.id)).toEqual(TRADE_IDS);
    for (const t of body.trades) expect(Object.keys(t).sort(), t.id).toEqual(['blurb', 'id', 'label', 'naics']);
    expect(body.trades[0]).toEqual({ id: 'electrical', label: 'Electrical', blurb: 'Power, lighting, fire alarm, low voltage, controls', naics: ['238210'] });
    expect(body.setAsides.map(({ pair: _pair, ...s }) => s)).toEqual(SET_ASIDES);
    // Each code names its program partner, so the form ticks both: saving one stores both anyway.
    const pairOf = Object.fromEntries(body.setAsides.map((s) => [s.code, s.pair]));
    expect([pairOf.SBA, pairOf.SBP, pairOf['8A'], pairOf['8AN'], pairOf.HZC, pairOf.ISBEE]).toEqual(['SBP', 'SBA', '8AN', '8A', 'HZS', null]);
    for (const s of body.setAsides) if (s.pair) expect(pairOf[s.pair], s.code).toBe(s.code);
    expect(body.setAsides.map((s) => s.code)).toEqual(expect.arrayContaining(['SBA', 'SBP', '8A', 'HZC', 'SDVOSBC', 'WOSB', 'EDWOSB']));
    // Every id and code the form can offer is one the save accepts.
    who = await seedAccount(db);
    const res = await put({ ...PILOT_ANSWERS, trades: body.trades.slice(-4).map((t) => t.id), setAsides: body.setAsides.map((s) => s.code) });
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/geo/zip/:zip previews the home base the profile will get', async () => {
    const res = await app.inject('/api/geo/zip/89410');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ zip: '89410', city: 'Gardnerville', state: 'NV', lat: expect.any(Number), lng: expect.any(Number) });
    for (const zip of ['00000', 'abc', '8941']) {
      const miss = await app.inject(`/api/geo/zip/${zip}`);
      expect(miss.statusCode, zip).toBe(404);
      expect(miss.json(), zip).toEqual({ error: 'zip_not_found' });
    }
  });

  it('single mode (the pilot): PUT /api/profile answers 409, and /api/me keeps its v0 shape', async () => {
    const single = await buildServer({ db, profile: pilot }, { now: () => CAPTURED });
    try {
      const res = await single.inject({ method: 'PUT', url: '/api/profile', payload: PILOT_ANSWERS });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'single_profile_mode' });
      expect((await single.inject({ method: 'PUT', url: '/api/profile' })).statusCode).toBe(409);
      expect(await db.query('select id from profiles')).toEqual([]);
      expect((await single.inject('/api/me')).json()).toEqual({
        id: 'lm-electric', name: 'L&M Electric', base: 'Gardnerville, NV', maxDistanceMi: 90, valueRange: { min: 10000, max: 50000 }, notifyMinScore: 55,
      });
      expect(((await single.inject('/api/trades')).json().trades as unknown[]).length).toBe(TRADE_IDS.length);
    } finally {
      await single.close();
    }
  });
});
