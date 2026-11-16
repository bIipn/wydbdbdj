import { describe, expect, it } from 'vitest';

// web/js is plain JavaScript with no type declarations; a computed path keeps tsc from asking for them.
// Everything here is synthetic (TEST- ids, made-up titles): it checks wording and rules, not real bids.
const modulePath = '../web/js/home-model.js';
const m = (await import(modulePath)) as {
  TABS: Array<{ view: string; label: string }>;
  VIEW_ALIASES: Record<string, string>;
  visibleTabs: (o: { live?: boolean; hireOnly?: boolean; jobsOn?: boolean }) => string[];
  screenTitle: (view: string) => string;
  homeSubtitle: (p: { name?: string; base?: string } | null) => string;
  monogram: (name: string | null | undefined) => string;
  placeLine: (item: object) => { miles: string | null; label: string; note: string | null; text: string };
  matchChips: (item: object) => Array<{ text: string; kind: string; urgent?: boolean; unknown?: boolean }>;
  homeModeOf: (stored: string | null) => 'scroll' | 'swipe';
};

const DAY = 864e5;
const bid = (over: object = {}) => ({
  id: 'TEST-1', title: 'TEST Replace lighting (simulated)', agency: 'Example County', verdict: 'good', score: 61, tier: 'fit',
  sourceName: 'Example Board (example.com)', dueAt: new Date(Date.now() + 9.5 * DAY).toISOString(),
  estValue: { min: 20000, max: 40000 }, location: { label: 'Sacramento, CA' }, distanceMi: 41.2, ...over,
});

describe('the tab bar (web/js/home-model.js visibleTabs)', () => {
  it('names the five tabs in order: Home · Search · Market · Saved · Jobs; Search is the old Browse view', () => {
    expect(m.TABS.map((t) => t.label)).toEqual(['Home', 'Search', 'Market', 'Saved', 'Jobs']);
    expect(m.TABS.find((t) => t.label === 'Search')?.view).toBe('browse');
  });
  it('accounts mode, work or both: all five', () => {
    expect(m.visibleTabs({ live: true, jobsOn: true })).toEqual(['home', 'browse', 'market', 'saved', 'jobs']);
  });
  it('single mode (the pilot): no Jobs', () => {
    expect(m.visibleTabs({ live: true, jobsOn: false })).toEqual(['home', 'browse', 'market', 'saved']);
  });
  it('the bundled demo: no Market (no server), no Jobs', () => {
    expect(m.visibleTabs({ live: false })).toEqual(['home', 'browse', 'saved']);
  });
  it('an account here only to get work done: Jobs alone (the shell then hides the bar)', () => {
    expect(m.visibleTabs({ live: true, hireOnly: true, jobsOn: true })).toEqual(['jobs']);
  });
  it('the old view name "swipe" opens Home', () => {
    expect(m.VIEW_ALIASES.swipe).toBe('home');
  });
});

describe('the header', () => {
  it('Home says Welcome; other tabs say their name', () => {
    expect(m.screenTitle('home')).toBe('Welcome');
    expect(m.screenTitle('browse')).toBe('Search');
    expect(m.screenTitle('jobs')).toBe('Jobs');
  });
  it('the second line is the business and its town, either may be missing', () => {
    expect(m.homeSubtitle({ name: 'TEST Electric', base: 'Minden, NV' })).toBe('TEST Electric · Minden, NV');
    expect(m.homeSubtitle({ name: 'TEST Electric' })).toBe('TEST Electric');
    expect(m.homeSubtitle(null)).toBe('');
  });
  it('the profile button shows letters from the name, never a logo', () => {
    expect(m.monogram('L&M Electric')).toBe('LM');
    expect(m.monogram('BidSwipe')).toBe('B');
    expect(m.monogram('')).toBe('');
    expect(m.monogram(undefined)).toBe('');
  });
});

describe('a match card (placeLine, matchChips)', () => {
  it('miles only when the server measured them, rounded', () => {
    expect(m.placeLine(bid()).text).toBe('41 mi · Sacramento, CA');
  });
  it('no miles: the server label and the reason in words, never "? mi"', () => {
    const p = m.placeLine(bid({ distanceMi: null, location: { label: 'Humboldt, Shasta' } }));
    expect(p.miles).toBeNull();
    expect(p.text).toBe('Humboldt, Shasta · No distance: site not named');
    expect(p.text).not.toContain('?');
    expect(m.placeLine(bid({ distanceMi: undefined, location: null })).label).toBe('Location not listed');
  });
  it('chips: time left, value, board, verdict', () => {
    expect(m.matchChips(bid()).map((c) => c.text)).toEqual(['9 days left', '$20K–$40K', 'Example Board', 'Good fit']);
  });
  it('a missing value says so; a missing due date says so', () => {
    const chips = m.matchChips(bid({ estValue: null, dueAt: null }));
    expect(chips[0]).toMatchObject({ text: 'Due date not listed', urgent: false });
    expect(chips[1]).toMatchObject({ text: 'Value not listed', unknown: true });
  });
  it('under five days is urgent', () => {
    expect(m.matchChips(bid({ dueAt: new Date(Date.now() + 2.5 * DAY).toISOString() }))[0]).toMatchObject({ text: '2 days left', urgent: true });
  });
  it('sub work and local jobs say so in place of the board', () => {
    expect(m.matchChips(bid({ tier: 'sub' }))[2]).toEqual({ text: 'Sub work', kind: 'sub' });
    expect(m.matchChips(bid({ id: 'local:TEST-9', source: 'local' }))[2]).toEqual({ text: 'Local job', kind: 'local' });
  });
});

describe('Home mode (remembered on the device)', () => {
  it('Swipe when stored, Scroll for anything else', () => {
    expect(m.homeModeOf('swipe')).toBe('swipe');
    expect(m.homeModeOf('scroll')).toBe('scroll');
    expect(m.homeModeOf(null)).toBe('scroll');
    expect(m.homeModeOf('junk')).toBe('scroll');
  });
});
