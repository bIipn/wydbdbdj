import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// web/js/format.js: how a card says when bids are due, how fresh a bid with no due date is (docs/PLAN.md R5, N4) and
// how its miles were measured (R3, N6). Pure functions; the dates and ids below are synthetic.
// web/js is plain JavaScript with no type declarations; a computed path keeps tsc from asking for them.
const modulePath = '../web/js/format.js';
type Due = { big: string; small: string; detail: string; line: string; urgent: boolean; days: number };
const f = (await import(modulePath)) as {
  dueInfo: (iso: string | null, seen?: { at?: string | null; timeZone?: string }) => Due;
  seenOnBoard: (iso: string | null | undefined, timeZone?: string) => { long: string; short: string } | null;
  straightMiles: (mi: number) => string;
  RADIUS_HELP: string;
};

const NV = 'America/Los_Angeles';
const SEEN = '2026-11-17T21:46:00.000Z'; // a scan on Tue, Nov 17 (1:46 PM Pacific)

describe('a bid with no due date says how fresh it is (N4)', () => {
  it('"No due date · Seen on the board Tue, Nov 17": the day a scan last found it on its board', () => {
    const due = f.dueInfo(null, { at: SEEN, timeZone: NV });
    expect(due.big).toBe('No due date');
    expect(due.detail).toBe('Seen on the board Tue, Nov 17'); // a list row: "No due date · Seen on the board Tue, Nov 17"
    expect(due.line).toBe('No due date · Seen on the board Tue, Nov 17');
    // A half-width fact tile (the card, the sheet): the short form, one line at 390 px.
    expect(due.small).toBe('Seen Tue, Nov 17');
    expect(due).toMatchObject({ urgent: false, days: Infinity }); // sorts last, never "urgent"
  });

  it('the day is the user\'s: 06:30 UTC on the 18th is the 17th in Nevada and the 18th in New York', () => {
    const at = '2026-11-18T06:30:00.000Z';
    expect(f.dueInfo(null, { at, timeZone: NV }).line).toBe('No due date · Seen on the board Tue, Nov 17');
    expect(f.dueInfo(null, { at, timeZone: 'America/New_York' }).line).toBe('No due date · Seen on the board Wed, Nov 18');
    expect(f.dueInfo(null, { at, timeZone: 'Pacific/Honolulu' }).small).toBe('Seen Tue, Nov 17');
  });

  it('a zone the browser does not know, or none, reads as Pacific (every other date in the app is Pacific)', () => {
    const at = '2026-11-18T06:30:00.000Z';
    expect(f.seenOnBoard(at, 'Not/A_Zone')?.long).toBe('Seen on the board Tue, Nov 17');
    expect(f.seenOnBoard(at)?.long).toBe('Seen on the board Tue, Nov 17');
  });

  it('no date in the answer (an older server) or a broken one: what to do, never a made-up day', () => {
    for (const at of [undefined, null, '', 'not a date']) {
      expect(f.dueInfo(null, { at, timeZone: NV })).toMatchObject({ big: 'No due date', small: 'Check the bid', line: 'No due date · Check the bid' });
    }
    expect(f.dueInfo(null).line).toBe('No due date · Check the bid');
    expect(f.seenOnBoard('not a date', NV)).toBeNull();
  });

  it('every card with a due date keeps it: the seen day never replaces a deadline', () => {
    const dueAt = new Date(Date.now() + 9.5 * 864e5).toISOString();
    const due = f.dueInfo(dueAt, { at: SEEN, timeZone: NV });
    expect(due.big).toBe('9 days left');
    expect(due.small).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2} · \d{1,2}(:\d{2})? [AP]M$/);
    expect(due.detail).toBe(due.small);
    expect(due.line).toBe(`9 days left · ${due.small}`);
    expect(due.line).not.toContain('Seen');
    expect(f.dueInfo(new Date(Date.now() - 1000).toISOString(), { at: SEEN, timeZone: NV }).big).toBe('Closed');
  });
});

describe('miles are straight-line, and the screens say so (N6)', () => {
  it('the detail sheet: "41 mi, straight line" (a non-breaking space keeps "41 mi" together)', () => {
    expect(f.straightMiles(41)).toBe('41 mi, straight line');
    expect(f.straightMiles(1234)).toBe('1,234 mi, straight line');
  });

  it('the sheet uses it only where there is a distance; an area or an unplaced card keeps its own words', () => {
    const parts = readFileSync(new URL('../web/js/parts.js', import.meta.url), 'utf8');
    expect(parts).toMatch(/item\.distanceMi == null \? 'No distance: site not named'\s*: sheet \? straightMiles\(item\.distanceMi\)/);
    expect(readFileSync(new URL('../web/js/sheet.js', import.meta.url), 'utf8')).toContain('facts(item, { sheet: true })');
  });

  it('Settings\' radius help says straight-line miles, as the onboarding does', () => {
    expect(f.RADIUS_HELP).toMatch(/^Straight-line miles from your shop/);
    const form = readFileSync(new URL('../web/js/profile-form.js', import.meta.url), 'utf8');
    expect(form).toContain("h('p', { class: 'field-help' }, RADIUS_HELP)"); // whereSection (Settings → Location)
    expect(form).toContain('straight-line miles'); // homeSection (the onboarding)
  });
});
