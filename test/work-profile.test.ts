/**
 * Work profiles and "what brings you here?" (jobs contract §5). People here are simulated: TEST- account ids,
 * example.com emails, "(simulated)" names. The bids a 'hire' profile is scored on are the REAL captured pages.
 * sharesJob() belongs to the marketplace build and answers false until it is filled in, so it is faked here.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/context.js';
import type { Db } from '../src/db/db.js';
import { getProfileByAccount } from '../src/db/repo.js';
import { getWorkProfile, saveWorkProfile } from '../src/db/work.js';
import { sharesJob } from '../src/jobs/stats.js';
import { buildProfile, HIRE_DEFAULTS, validateAnswers, type OnboardingAnswers } from '../src/profile/build.js';
import { ANONYMOUS_NAME, cardName, personCard } from '../src/profile/person.js';
import { defaultWorkProfile, readStoredWorkProfile, validateWorkProfile, WORK_LIMITS, type WorkProfile } from '../src/profile/work.js';
import { loadProfile } from '../src/profiles.js';
import { createBus, type BusEventOf } from '../src/realtime/bus.js';
import { finalizeBid, runScan } from '../src/scan.js';
import { scoreBid } from '../src/score/score.js';
import { buildApp } from '../src/server.js';
import { fixtureSources } from '../src/sources/fixtures.js';
import type { Account, Bid } from '../src/types.js';
import { accountsConfig, CAPTURED, fakeAuth, memoryDb, resetDb, scanCtx, seedAccount } from './helpers.js';

vi.mock('../src/jobs/stats.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/jobs/stats.js')>();
  return { ...actual, sharesJob: vi.fn(async () => false) };
});
const shares = vi.mocked(sharesJob);

const NOW = new Date('2026-11-14T18:00:00Z');

/** One check, one field: the error list names exactly that path. */
function failsAt(input: unknown, path: string, stored?: WorkProfile): string {
  const r = validateWorkProfile(input, NOW, stored);
  expect(r.ok, JSON.stringify(input)).toBe(false);
  if (r.ok) return '';
  const hit = r.fields.find((f) => f.path === path);
  expect(hit, `${path} in ${JSON.stringify(r.fields)}`).toBeTruthy();
  // One plain sentence: starts with a capital (or a quote), ends with a full stop.
  expect(hit!.message).toMatch(/^[A-Z“].*\.$/);
  return hit!.message;
}
function passes(input: unknown, stored?: WorkProfile): WorkProfile {
  const r = validateWorkProfile(input, NOW, stored);
  if (!r.ok) throw new Error(`should be valid: ${JSON.stringify(r.fields)}`);
  return r.value;
}

// ------------------------------------------------------------ validation --

describe('validateWorkProfile', () => {
  it('an empty body changes nothing: the defaults (or what is stored) come back', () => {
    expect(passes({})).toEqual(defaultWorkProfile());
    expect(defaultWorkProfile()).toEqual({
      intent: 'work', headline: null, about: null, yearsExperience: null, skills: [], license: null, insured: 'unsure',
      experience: [], resumeUrl: null, lookingFor: { kinds: [], availability: [] },
    });
    const stored = passes({ headline: 'TEST Journeyman electrician (simulated)', skills: ['Panels'] });
    expect(passes({ intent: 'both' }, stored)).toEqual({ ...stored, intent: 'both' });
  });

  it('refuses a body that is not one object, and any unknown field', () => {
    for (const bad of [null, [], 'x', 3]) failsAt(bad, 'form');
    expect(failsAt({ lookingfor: {} }, 'lookingfor')).toBe('Unknown field “lookingfor”.');
    failsAt({ license: { state: 'NV', number: '1', expires: '2030' } }, 'license.expires');
    failsAt({ experience: [{ title: 'Foreman', boss: 'x' }] }, 'experience.0.boss');
    failsAt({ lookingFor: { kinds: [], when: [] } }, 'lookingFor.when');
  });

  it('intent: work, hire or both', () => {
    for (const intent of ['work', 'hire', 'both'] as const) expect(passes({ intent }).intent).toBe(intent);
    for (const bad of ['Work', 'employer', '', null, 1]) failsAt({ intent: bad }, 'intent');
  });

  it('headline: up to 80 characters on one line; blank is no headline', () => {
    expect(passes({ headline: '  Licensed   electrician,\n20 yrs  ' }).headline).toBe('Licensed electrician, 20 yrs');
    expect(passes({ headline: '   ' }).headline).toBeNull();
    expect(passes({ headline: null }).headline).toBeNull();
    expect(passes({ headline: 'x'.repeat(80) }).headline).toHaveLength(80);
    expect(failsAt({ headline: 'x'.repeat(81) }, 'headline')).toBe('Headline can be at most 80 characters (it has 81).');
    failsAt({ headline: 42 }, 'headline');
  });

  it('about: up to 600 characters, keeps line breaks, drops control characters', () => {
    expect(passes({ about: ' Line one.\n\n\n\nLine  two.\u0007 ' }).about).toBe('Line one.\n\nLine two.');
    expect(passes({ about: 'a'.repeat(600) }).about).toHaveLength(600);
    failsAt({ about: 'a'.repeat(601) }, 'about');
    failsAt({ about: ['a'] }, 'about');
  });

  it('years in the trade: a whole number from 0 to 70, or none', () => {
    for (const y of [0, 2, 5, 10, 20, 70, null]) expect(passes({ yearsExperience: y }).yearsExperience).toBe(y);
    for (const bad of [-1, 71, 2.5, '5', Number.NaN]) {
      expect(failsAt({ yearsExperience: bad }, 'yearsExperience')).toBe('Years in the trade must be a whole number from 0 to 70.');
    }
  });

  it('skills: up to 12, each up to 30 characters, trimmed, the same one twice kept once', () => {
    expect(passes({ skills: [' Panel upgrades ', 'panel upgrades', '', 'EV chargers'] }).skills).toEqual(['Panel upgrades', 'EV chargers']);
    expect(passes({ skills: Array.from({ length: 12 }, (_, i) => `TEST skill ${i}`) }).skills).toHaveLength(12);
    expect(failsAt({ skills: Array.from({ length: 13 }, (_, i) => `TEST skill ${i}`) }, 'skills')).toBe('Pick up to 12 skills.');
    failsAt({ skills: ['ok', 'x'.repeat(31)] }, 'skills.1');
    failsAt({ skills: ['ok', 7] }, 'skills.1');
    failsAt({ skills: 'Panels' }, 'skills');
  });

  it('licence: a state and a number, stored as typed (not verified); both blank = none', () => {
    expect(passes({ license: { state: 'nv', number: ' 0081234 A ' } }).license).toEqual({ state: 'NV', number: '0081234 A' });
    expect(passes({ license: { state: '', number: '' } }).license).toBeNull();
    expect(passes({ license: null }).license).toBeNull();
    expect(failsAt({ license: { state: 'ZZ', number: '1' } }, 'license.state')).toBe('Pick the state that issued the licence.');
    failsAt({ license: { state: 'NV', number: '' } }, 'license.number');
    failsAt({ license: { state: 'NV', number: 'x'.repeat(WORK_LIMITS.licenseNumber + 1) } }, 'license.number');
    failsAt({ license: 'NV 123' }, 'license');
  });

  it('insured: yes, no or not sure', () => {
    for (const v of ['yes', 'no', 'unsure'] as const) expect(passes({ insured: v }).insured).toBe(v);
    for (const bad of ['maybe', true, null]) failsAt({ insured: bad }, 'insured');
  });

  it('experience: up to 10 jobs, a title each, years in order, "to" left out = present', () => {
    const job = { title: ' Foreman ', company: 'TEST Builders (simulated)', from: 2015, to: null, summary: 'Ran crews of 4.' };
    expect(passes({ experience: [job] }).experience).toEqual([{ ...job, title: 'Foreman' }]);
    expect(passes({ experience: [{ title: 'Apprentice' }] }).experience).toEqual([{ title: 'Apprentice', company: null, from: null, to: null, summary: null }]);
    expect(passes({ experience: [{ title: 'Helper', from: 2026, to: 2026 }] }).experience[0]!.to).toBe(2026);

    failsAt({ experience: Array.from({ length: 11 }, () => ({ title: 'x' })) }, 'experience');
    expect(failsAt({ experience: [{ title: '  ' }] }, 'experience.0.title')).toBe('Enter a job title.');
    failsAt({ experience: [{ title: 'x'.repeat(81) }] }, 'experience.0.title');
    expect(failsAt({ experience: [{ title: 'x', from: 2020, to: 2010 }] }, 'experience.0.to')).toBe('“To” can’t be before “From”.');
    failsAt({ experience: [{ title: 'x', from: 2027 }] }, 'experience.0.from'); // next year
    failsAt({ experience: [{ title: 'x', from: 1949 }] }, 'experience.0.from');
    failsAt({ experience: [{ title: 'x', from: '2015' }] }, 'experience.0.from');
    failsAt({ experience: [{ title: 'x', to: 'present' }] }, 'experience.0.to');
    failsAt({ experience: [{ title: 'x', summary: 's'.repeat(301) }] }, 'experience.0.summary');
    failsAt({ experience: [{ title: 'x', company: 5 }] }, 'experience.0.company');
    failsAt({ experience: ['Foreman'] }, 'experience.0');
    failsAt({ experience: {} }, 'experience');
  });

  it('résumé or website: only http or https links, never a script, a file, or a login inside the link', () => {
    expect(passes({ resumeUrl: ' https://example.com/TEST-resume.pdf ' }).resumeUrl).toBe('https://example.com/TEST-resume.pdf');
    expect(passes({ resumeUrl: 'http://example.com' }).resumeUrl).toBe('http://example.com/');
    expect(passes({ resumeUrl: '' }).resumeUrl).toBeNull();
    expect(passes({ resumeUrl: null }).resumeUrl).toBeNull();
    for (const bad of [
      'javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x',
      'file:///etc/passwd', 'ftp://example.com/x', 'mailto:test@example.com', '//example.com/x', 'www.example.com',
      'https://', 'https://localhost/x', 'https://example .com', 'https:/example.com',
    ]) expect(failsAt({ resumeUrl: bad }, 'resumeUrl'), bad).toBe('Use a full web link that starts with http:// or https://.');
    expect(failsAt({ resumeUrl: 'https://user:pass@example.com/' }, 'resumeUrl')).toBe('Take the user name and password out of the link.');
    failsAt({ resumeUrl: `https://example.com/${'a'.repeat(500)}` }, 'resumeUrl');
    failsAt({ resumeUrl: 12 }, 'resumeUrl');
  });

  it('what you are looking for: chips from two fixed lists, kept in the screen’s order', () => {
    expect(passes({ lookingFor: { kinds: ['emergency', 'side_jobs', 'side_jobs'], availability: ['weekends', 'weekdays'] } }).lookingFor)
      .toEqual({ kinds: ['side_jobs', 'emergency'], availability: ['weekdays', 'weekends'] });
    expect(passes({ lookingFor: { kinds: ['full_time'] } }).lookingFor).toEqual({ kinds: ['full_time'], availability: [] });
    failsAt({ lookingFor: { kinds: ['nights'] } }, 'lookingFor.kinds');
    failsAt({ lookingFor: { availability: ['sundays'] } }, 'lookingFor.availability');
    failsAt({ lookingFor: ['side_jobs'] }, 'lookingFor');
  });

  it('reports every bad field at once, each by its path', () => {
    const r = validateWorkProfile({ intent: 'x', yearsExperience: -1, resumeUrl: 'javascript:1', insured: 'x' }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fields.map((f) => f.path).sort()).toEqual(['insured', 'intent', 'resumeUrl', 'yearsExperience']);
  });

  it('a stored row with one odd field keeps the others', () => {
    const wp = passes({ intent: 'both', headline: 'TEST Handy (simulated)', skills: ['Drywall'] });
    expect(readStoredWorkProfile({ ...wp, resumeUrl: 'javascript:1', retired: true })).toEqual(wp);
    expect(readStoredWorkProfile('nonsense')).toEqual(defaultWorkProfile());
  });
});

// ------------------------------------------------------------ the card --

describe('person card', () => {
  it('names: the business name, else the account name, else "BidSwipe member" — never an email', () => {
    expect(cardName('TEST Sparks LLC (simulated)', 'TEST Dana (simulated)')).toBe('TEST Sparks LLC (simulated)');
    expect(cardName(null, ' TEST  Dana (simulated) ')).toBe('TEST Dana (simulated)');
    expect(cardName('  ', null)).toBe(ANONYMOUS_NAME);
    expect(cardName(null, 'test9@example.com')).toBe(ANONYMOUS_NAME);
    expect(ANONYMOUS_NAME).toBe('BidSwipe member');
  });
});

// ---------------------------------------------------------------- routes --

describe('work profile routes', () => {
  let db: Db;
  let app: FastifyInstance;
  let single: FastifyInstance;
  let who: Account | null = null;

  const get = (url: string, on: FastifyInstance = app) => on.inject({ url });
  const put = (payload: unknown, on: FastifyInstance = app) =>
    on.inject({ method: 'PUT', url: '/api/work-profile', headers: { 'x-bidswipe': '1' }, payload: payload as object });

  beforeAll(async () => {
    db = await memoryDb();
    const opts = { bus: createBus(), auth: fakeAuth(() => who), now: () => NOW };
    app = (await buildApp({ db }, { ...opts, config: accountsConfig() })).app;
    single = (await buildApp({ db, profile: loadProfile('lm-electric') }, { ...opts, config: loadConfig({}) })).app; // the pilot: AUTH_MODE=single
  });
  beforeEach(async () => {
    await resetDb(db);
    who = null;
    shares.mockReset();
    shares.mockResolvedValue(false);
  });
  afterAll(async () => {
    await app.close();
    await single.close();
    await db.close();
  });

  it('single mode has no accounts, so the routes answer 404; signed out answers 401', async () => {
    for (const url of ['/api/work-profile', '/api/people/TEST-acct-x']) expect((await get(url, single)).statusCode).toBe(404);
    expect((await put({}, single)).statusCode).toBe(404);
    expect((await get('/api/work-profile')).json()).toEqual({ error: 'sign_in_required' });
    expect((await put({ headline: 'x' })).statusCode).toBe(401);
    expect((await get('/api/people/TEST-acct-x')).statusCode).toBe(401);
  });

  it('GET before anything is saved: the defaults, and a card with the account name and no email', async () => {
    who = await seedAccount(db, { name: 'TEST Dana Reyes (simulated)' });
    const res = await get('/api/work-profile');
    expect(res.statusCode).toBe(200);
    const { workProfile, card } = res.json();
    expect(workProfile).toEqual(defaultWorkProfile());
    expect(card).toMatchObject({ id: who.id, name: 'TEST Dana Reyes (simulated)', memberSince: who.createdAt, insured: 'unsure', skills: [] });
    expect(card.stats).toEqual({ posted: 0, won: 0, agreed: 0, completed: 0, noShows: 0, backedOut: 0, posterNoShows: 0 });
    expect(JSON.stringify(card)).not.toContain('@');
  });

  it('PUT saves, answers the new card, and a later PUT changes only the fields it sends', async () => {
    who = await seedAccount(db);
    const full = {
      intent: 'both', headline: 'TEST Licensed electrician (simulated)', about: 'Small jobs, done right.', yearsExperience: 10,
      skills: ['Panel upgrades', 'EV chargers'], license: { state: 'NV', number: 'TEST-0001' }, insured: 'yes',
      experience: [{ title: 'Journeyman', company: 'TEST Sparks (simulated)', from: 2014, to: null, summary: null }],
      resumeUrl: 'https://example.com/TEST-resume', lookingFor: { kinds: ['side_jobs'], availability: ['weekends'] },
    };
    const res = await put(full);
    expect(res.statusCode).toBe(200);
    expect(res.json().workProfile).toEqual(full);
    expect(res.json().card).toMatchObject({ headline: full.headline, license: full.license, skills: full.skills, resumeUrl: full.resumeUrl });
    expect(await getWorkProfile(db, who.id)).toEqual(full);

    const again = await put({ intent: 'hire' });
    expect(again.json().workProfile).toEqual({ ...full, intent: 'hire' });
  });

  it('a bad field answers 400 invalid_input with { path, message } for each, and stores nothing', async () => {
    who = await seedAccount(db);
    const res = await put({ resumeUrl: 'javascript:alert(1)', skills: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'invalid_input',
      fields: [
        { path: 'skills', message: 'Skills must be a list.' },
        { path: 'resumeUrl', message: 'Use a full web link that starts with http:// or https://.' },
      ],
    });
    expect(await db.query('select account_id from work_profiles')).toEqual([]);
  });

  it('the card carries exactly the card fields: never an email, phone or address', async () => {
    who = await seedAccount(db, { email: 'test-private@example.com', name: 'TEST Private (simulated)' });
    await put({ headline: 'TEST (simulated)' });
    const card = (await personCard(db, who.id))!;
    expect(Object.keys(card).sort()).toEqual([
      'about', 'experience', 'headline', 'id', 'insured', 'license', 'memberSince', 'name', 'resumeUrl', 'skills', 'stats', 'yearsExperience',
    ]);
    expect(JSON.stringify(card)).not.toContain('example.com');
    expect(await personCard(db, 'TEST-no-such-account')).toBeNull();
  });

  it('the card is named by the business name from the profile once there is one', async () => {
    who = await seedAccount(db, { name: 'TEST Dana (simulated)' });
    const answers = { intent: 'hire', businessName: 'TEST Reyes Household (simulated)', zip: '89410' };
    expect((await app.inject({ method: 'PUT', url: '/api/profile', headers: { 'x-bidswipe': '1' }, payload: answers })).statusCode).toBe(200);
    expect((await get('/api/work-profile')).json().card.name).toBe('TEST Reyes Household (simulated)');
  });

  it('GET /api/people/:id: 404 unless the two have dealt with each other on a job (sharesJob)', async () => {
    const other = await seedAccount(db, { name: 'TEST Other (simulated)', email: 'test-other@example.com' });
    who = await seedAccount(db);
    await saveWorkProfile(db, other.id, { ...defaultWorkProfile(), headline: 'TEST Plumber (simulated)' }, NOW);

    const strangers = await get(`/api/people/${other.id}`);
    expect(strangers.statusCode).toBe(404);
    expect(strangers.json()).toEqual({ error: 'not_found' });
    expect(shares).toHaveBeenCalledWith(db, who.id, other.id);

    shares.mockResolvedValue(true);
    const dealt = await get(`/api/people/${other.id}`);
    expect(dealt.statusCode).toBe(200);
    expect(dealt.json().card).toMatchObject({ id: other.id, name: 'TEST Other (simulated)', headline: 'TEST Plumber (simulated)' });
    expect(JSON.stringify(dealt.json())).not.toContain('@');

    // An id that does not exist looks exactly like a stranger, even if the job check were to say yes.
    expect((await get('/api/people/TEST-no-such-account')).json()).toEqual({ error: 'not_found' });
    // Your own card is GET /api/work-profile, not this route.
    expect((await get(`/api/people/${who.id}`)).statusCode).toBe(404);
  });
});

// ------------------------------------------------------- intent: 'hire' --

describe('"what brings you here": intent in the onboarding answers', () => {
  const PILOT: OnboardingAnswers = {
    businessName: 'TEST Pilot Twin Electric (simulated)', trades: ['electrical'], zip: '89410', radiusMi: 90,
    valueRange: { min: 10_000, max: 50_000 }, setAsides: ['SBA'],
  };
  const HIRE = { intent: 'hire', businessName: 'TEST Dana Reyes (simulated)', zip: '89410' };

  let real: Bid[];
  beforeAll(async () => {
    real = (await Promise.all(fixtureSources().map((s) => s.fetch(scanCtx(CAPTURED))))).flat().map(finalizeBid);
  });

  it('absent intent changes nothing: the same answers, the same profile, the same errors as before', () => {
    const plain = validateAnswers(PILOT);
    expect(plain).toEqual({ ok: true, value: PILOT });
    for (const intent of ['work', 'both'] as const) {
      const r = validateAnswers({ ...PILOT, intent });
      expect(r).toEqual({ ok: true, value: { ...PILOT, intent } });
      if (r.ok && plain.ok) expect(buildProfile('test-x', r.value)).toEqual(buildProfile('test-x', plain.value));
    }
    const { trades: _t, ...noTrades } = PILOT;
    expect(validateAnswers(noTrades)).toEqual({ ok: false, errors: { trades: 'Pick at least one trade.' } });
    expect(validateAnswers({ ...noTrades, intent: 'work' })).toEqual({ ok: false, errors: { trades: 'Pick at least one trade.' } });
    expect(validateAnswers({ ...PILOT, intent: 'boss' })).toEqual({ ok: false, errors: { intent: 'Pick find work, get work done, or both.' } });
  });

  it("'hire' needs only a name and a ZIP: no trades, the default distance and job size, no work alerts", () => {
    const r = validateAnswers(HIRE);
    expect(r).toEqual({ ok: true, value: { ...HIRE, trades: [], radiusMi: HIRE_DEFAULTS.radiusMi, valueRange: HIRE_DEFAULTS.valueRange } });
    if (!r.ok) return;
    const p = buildProfile('test-hire', r.value);
    expect(p.trades).toEqual([]);
    expect(p.keywords).toEqual({ strong: [], related: [], general: [], otherTrades: [], exclude: [] });
    expect(p.naics).toEqual({ strong: [], related: [] });
    expect(p.maxDistanceMi).toBe(25);
    expect(p.valueRange).toEqual({ min: 0, max: 250_000 });
    expect(p.alerts).toMatchObject({ minScore: 55, kinds: { match: false } });
    // Even a form that asks for match alerts, or still sends trades, gets neither.
    const asked = validateAnswers({ ...HIRE, trades: ['electrical'], alerts: { kinds: { match: true, job_awarded: true } } });
    expect(asked.ok).toBe(true);
    if (asked.ok) expect(buildProfile('test-hire', asked.value)).toMatchObject({ trades: [], alerts: { kinds: { match: false, job_awarded: true } } });
    // A name and a place are still required, and what is sent is still checked.
    expect(validateAnswers({ intent: 'hire' })).toEqual({ ok: false, errors: { businessName: 'Enter your business name.', zip: 'Enter a 5-digit ZIP code.' } });
    expect(validateAnswers({ ...HIRE, radiusMi: 2 }).ok).toBe(false);
    expect(validateAnswers({ ...HIRE, trades: ['TEST-no-such-trade'] }).ok).toBe(false);
  });

  it("a 'hire' profile scores no real bid as a fit, so its deck and its work alerts stay empty", async () => {
    const r = validateAnswers(HIRE);
    if (!r.ok) throw new Error('valid');
    const hire = buildProfile('test-hire', r.value);
    const scores = real.map((b) => scoreBid(b, hire, CAPTURED).score);
    expect(real.length).toBeGreaterThan(50);
    expect(Math.max(...scores)).toBeLessThan(35); // under the deck's line (web/js/state.js DECK_MIN_SCORE)

    const db = await memoryDb();
    try {
      const bus = createBus();
      const matches: Array<BusEventOf<'match'>> = [];
      bus.on('match', (e) => void matches.push(e));
      await runScan({ db, sources: fixtureSources(), profiles: [hire], ctx: scanCtx(CAPTURED), bus });
      expect(matches).toEqual([]);
    } finally {
      await db.close();
    }
  });

  describe('through PUT /api/profile and GET /api/me', () => {
    let db: Db;
    let app: FastifyInstance;
    let who: Account | null = null;
    const putProfile = (payload: unknown) =>
      app.inject({ method: 'PUT', url: '/api/profile', headers: { 'x-bidswipe': '1' }, payload: payload as object });
    const me = async () => (await app.inject('/api/me')).json();

    beforeAll(async () => {
      db = await memoryDb();
      app = (await buildApp({ db }, { bus: createBus(), auth: fakeAuth(() => who), now: () => CAPTURED, config: accountsConfig() })).app;
    });
    beforeEach(async () => {
      await resetDb(db);
      who = await seedAccount(db);
    });
    afterAll(async () => {
      await app.close();
      await db.close();
    });

    it('an account with no stored intent is "work", and saving the pilot answers stores none', async () => {
      expect((await me()).intent).toBe('work');
      expect((await putProfile(PILOT)).statusCode).toBe(200);
      expect((await me()).intent).toBe('work');
      expect(await db.query('select account_id from work_profiles')).toEqual([]);
    });

    it("'hire' is stored in the work profile; later saves without an intent keep it and still need no trades", async () => {
      const res = await putProfile(HIRE);
      expect(res.statusCode).toBe(200);
      expect(res.json().profile).toMatchObject({ trades: [], radiusMi: 25, valueRange: { min: 0, max: 250_000 } });
      expect(await me()).toMatchObject({ intent: 'hire', needsOnboarding: false });
      expect((await getProfileByAccount(db, who!.id))!.alerts?.kinds?.match).toBe(false);

      const { intent: _i, ...noIntent } = HIRE;
      expect((await putProfile({ ...noIntent, businessName: 'TEST Renamed (simulated)' })).statusCode).toBe(200);
      expect((await me()).intent).toBe('hire');

      // Switching to find work needs trades again, like any other work profile.
      expect((await putProfile({ ...noIntent, intent: 'both' })).json().fields).toEqual({
        trades: 'Pick at least one trade.', radiusMi: 'Travel radius must be a number from 5 to 500 miles.',
        valueRange: 'Enter the smallest and the largest job you want.',
      });
      expect((await putProfile({ ...PILOT, intent: 'both' })).statusCode).toBe(200);
      expect((await me()).intent).toBe('both');
      expect((await getProfileByAccount(db, who!.id))!.trades).toEqual(['electrical']);
    });
  });
});
