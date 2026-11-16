import { describe, expect, it } from 'vitest';

// Home's "Finish setting up" tasks (web/js/home-tasks.js) and "Your preferences" chips (web/js/home-prefs.js).
// Everything here is synthetic (TEST names, example profiles): it checks the rules, not real accounts.
// web/js is plain JavaScript with no type declarations; computed paths keep tsc from asking for them.
type Task = { id: string; title: string; text: string; actions: Array<{ label: string; go: { to: string; field?: string } }> };
const tasksPath = '../web/js/home-tasks.js';
const prefsPath = '../web/js/home-prefs.js';
const t = (await import(tasksPath)) as {
  homeTasks: (f: object) => Task[];
  paperworkOpen: (p: object) => string[];
  workProfileEmpty: (wp: object | null) => boolean;
  isDefaultName: (n: string) => boolean;
  homeStateOf: (base: string) => string | null;
};
const p = (await import(prefsPath)) as {
  prefsChips: (f: object) => Array<{ id: string; text: string; field: string }> | null;
  sizeText: (r: object) => string | null;
};

const ANSWERED = { statePublicWorks: 'yes', samRegistered: 'no', bonding: 'yes', prevailingWage: 'no' };
const profile = (over: object = {}) => ({
  businessName: 'TEST Electric', trades: ['electrical'], zip: '95675', base: 'River Pines, CA', radiusMi: 100,
  valueRange: { min: 25000, max: 500000 }, qualifications: { ...ANSWERED }, showSubWork: true, ...over,
});
const EMPTY_WP = { headline: null, about: null, yearsExperience: null, skills: [], license: null, insured: 'unsure', experience: [], resumeUrl: null, lookingFor: { kinds: [], availability: [] } };
const facts = (over: object = {}) => ({
  live: true, auth: 'accounts', intent: 'work', profile: profile(), features: { instantPush: false },
  push: null, jobsOn: true, workProfile: { ...EMPTY_WP, headline: 'TEST headline' }, ...over,
});
const ids = (f: object) => t.homeTasks(f).map((x) => x.id);

describe('home tasks', () => {
  it('an account that has done everything has none', () => {
    expect(t.homeTasks(facts())).toEqual([]);
  });

  it('the pilot (single mode), the demo, no profile and a hire-only account never get a task', () => {
    const open = { profile: profile({ qualifications: undefined, businessName: 'My electrical shop' }), workProfile: EMPTY_WP };
    expect(ids(facts({ ...open, auth: 'single' }))).toEqual([]);
    expect(ids(facts({ ...open, live: false }))).toEqual([]);
    expect(ids(facts({ ...open, profile: null }))).toEqual([]);
    expect(ids(facts({ ...open, intent: 'hire' }))).toEqual([]);
  });

  it('paperwork: only the questions left at Not sure or never answered, naming exactly those', () => {
    const one = t.homeTasks(facts({ profile: profile({ qualifications: { ...ANSWERED, bonding: 'unsure' } }) }));
    expect(one.map((x) => x.id)).toEqual(['paperwork']);
    expect(one[0]!.title).toBe('One paperwork question is open');
    expect(one[0]!.text).toBe('Bonding: until you answer Yes or No, bid cards that ask for it tell you to check.');
    expect(one[0]!.actions).toEqual([{ label: 'Answer it', go: { to: 'settings', field: 'qualifications' } }]);

    const never = t.homeTasks(facts({ profile: profile({ qualifications: undefined }) }))[0]!;
    // California base: the Nevada SPWD question is not asked there (profile-form.js paperworkSection), so not counted.
    expect(never.title).toBe('3 paperwork questions are open');
    expect(never.text).toMatch(/^SAM\.gov registration, bonding and prevailing wage:/);
  });

  it('paperwork: a Nevada base counts the state public-works question too', () => {
    const nv = t.homeTasks(facts({ profile: profile({ base: 'Gardnerville, NV', qualifications: undefined }) }))[0]!;
    expect(nv.title).toBe('4 paperwork questions are open');
    expect(nv.text).toMatch(/^Nevada public works qualification, SAM\.gov registration, bonding and prevailing wage:/);
    expect(t.paperworkOpen(profile({ base: 'Gardnerville, NV', qualifications: { ...ANSWERED, statePublicWorks: 'unsure' } }))).toEqual(['statePublicWorks']);
  });

  it('phone alerts: only when the plan has them AND this device is off (never locked, unsupported, denied or not set up)', () => {
    expect(ids(facts({ features: { instantPush: true }, push: 'off' }))).toEqual(['push']);
    for (const push of ['on', 'locked', 'denied', 'unsupported', 'insecure', 'not_configured', 'error', null]) {
      expect(ids(facts({ features: { instantPush: true }, push }))).toEqual([]);
    }
    // The Premium rule: a plan without instant push never gets it as a task, whatever the device says.
    expect(ids(facts({ features: { instantPush: false }, push: 'off' }))).toEqual([]);
    expect(t.homeTasks(facts({ features: { instantPush: true }, push: 'off' }))[0]!.actions[0]!.go).toEqual({ to: 'alerts' });
  });

  it('work profile: only when local jobs are on and it is really empty (not while it loads)', () => {
    expect(ids(facts({ workProfile: EMPTY_WP }))).toEqual(['work-profile']);
    expect(ids(facts({ workProfile: EMPTY_WP, jobsOn: false }))).toEqual([]);
    expect(ids(facts({ workProfile: null }))).toEqual([]);
    expect(t.workProfileEmpty({ ...EMPTY_WP, skills: ['TEST wiring'] })).toBe(false);
    expect(t.workProfileEmpty({ ...EMPTY_WP, insured: 'yes' })).toBe(false);
    expect(t.workProfileEmpty({ ...EMPTY_WP, lookingFor: { kinds: ['side_jobs'], availability: [] } })).toBe(false);
    expect(t.homeTasks(facts({ workProfile: EMPTY_WP }))[0]!.actions[0]!.go).toEqual({ to: 'settings', field: 'headline' });
  });

  it('business name: only the name onboarding gives a skipped step', () => {
    expect(ids(facts({ profile: profile({ businessName: 'My electrical shop' }) }))).toEqual(['name']);
    expect(ids(facts({ profile: profile({ businessName: 'My HVAC shop' }) }))).toEqual(['name']); // "HVAC / mechanical" keeps its capitals
    expect(t.isDefaultName('My shop')).toBe(true);
    expect(t.isDefaultName('My low voltage shop')).toBe(true);
    expect(t.isDefaultName('Carson Valley Electric')).toBe(false);
  });

  it('every task in order, each with a button that names where it goes; no figure we do not have', () => {
    const all = t.homeTasks(facts({
      profile: profile({ qualifications: undefined, businessName: 'My electrical shop' }),
      features: { instantPush: true }, push: 'off', workProfile: EMPTY_WP,
    }));
    expect(all.map((x) => x.id)).toEqual(['paperwork', 'push', 'work-profile', 'name']);
    for (const task of all) {
      expect(task.actions.length).toBeGreaterThanOrEqual(1);
      expect(`${task.title} ${task.text}`).not.toMatch(/\d+\s*%|more likely|guarantee/i);
    }
  });

  it('reads the home state off a base label', () => {
    expect(t.homeStateOf('Gardnerville, NV')).toBe('NV');
    expect(t.homeStateOf('River Pines, CA 95675')).toBe('CA');
    expect(t.homeStateOf('')).toBeNull();
  });
});

describe('preference chips', () => {
  const labels = new Map([['electrical', 'Electrical'], ['general-building', 'General building']]);
  const f = (over: object = {}) => ({ intent: 'work', base: 'River Pines, CA', profile: profile(), legacy: null, tradeLabels: labels, ...over });

  it('an account: trades by their catalog labels, the reach, the job size and sub work, each with its Settings field', () => {
    expect(p.prefsChips(f())).toEqual([
      { id: 'trade:electrical', text: 'Electrical', field: 'trades' },
      { id: 'radius', text: '100 mi from River Pines, CA', field: 'radiusMi' },
      { id: 'size', text: 'Jobs $25K–$500K', field: 'valueRange.min' },
      { id: 'sub', text: 'Sub work shown', field: 'showSubWork' },
    ]);
  });

  it('sub work: hidden when switched off, absent for the general-building prime', () => {
    expect(p.prefsChips(f({ profile: profile({ showSubWork: false }) }))!.at(-1)!.text).toBe('Sub work hidden');
    const gc = p.prefsChips(f({ profile: profile({ trades: ['general-building'] }) }))!;
    expect(gc.map((c) => c.id)).toEqual(['trade:general-building', 'radius', 'size']);
  });

  it('trade names wait for the catalog instead of showing an id', () => {
    expect(p.prefsChips(f({ tradeLabels: null }))!.map((c) => c.id)).toEqual(['radius', 'size', 'sub']);
  });

  it('the pilot and the demo: their reach and size from the single-mode fields', () => {
    const chips = p.prefsChips(f({ profile: null, base: 'Gardnerville, NV', legacy: { maxDistanceMi: 90, valueRange: { min: 10000, max: 50000 } } }))!;
    expect(chips.map((c) => c.text)).toEqual(['90 mi from Gardnerville, NV', 'Jobs $10K–$50K', 'Sub work shown']);
  });

  it('no profile at all, or here only to hire: no card; nothing to show yet: an empty list (the "add" row)', () => {
    expect(p.prefsChips(f({ profile: null, legacy: null }))).toBeNull();
    expect(p.prefsChips(f({ intent: 'hire' }))).toBeNull();
    expect(p.prefsChips(f({ profile: profile({ trades: [], radiusMi: null, valueRange: null }), base: '' }))).toEqual([]);
  });

  it('job sizes in the app’s money wording', () => {
    expect(p.sizeText({ min: 0, max: 250000 })).toBe('Jobs up to $250K');
    expect(p.sizeText({ min: 500000, max: 2000000 })).toBe('Jobs $500K–$2M');
    expect(p.sizeText({ min: 0, max: 0 })).toBeNull();
  });
});
