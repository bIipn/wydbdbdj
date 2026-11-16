import { describe, expect, it } from 'vitest';
import { fx } from './helpers.js';

// The market tape (web/js/tape-items.js): its items and its pure decisions. The "real answer" is GET
// /api/market/area exactly as this app's server sent it for ZIP 95675 (an electrician's profile), after loading the
// REAL BLS captures in test/fixtures (bls-oews-*.json, bls-ppi-core.json, 2026-11-13) through refreshBls, the replay
// test/market-routes.test.ts uses. Anything else here is synthetic (TEST- labels).
// web/js is plain JavaScript with no type declarations; a computed path keeps tsc from asking for them.
const modulePath = '../web/js/tape-items.js';
type Item = {
  key: string; kind: string; name: string; figure: string; mark: string; dir: string; change: string | null;
  note: string | null; month: string; prelim: boolean; spoken: string; short: string; monthShort: string;
};
const t = (await import(modulePath)) as {
  TAPE_ICON_LABEL: string;
  TAPE_STILL_TEXT: string;
  TAPE_STILL_SPOKEN: string;
  TAPE_HOLD_MS: number;
  signedPct: (pct: number) => string;
  direction: (c: unknown) => string;
  indexLevel: (v: number) => string;
  tapeItems: (area: unknown) => Item[];
  tapeSpoken: (items: Item[]) => string;
  tapeKey: (items: Item[]) => string;
  tapeMode: (o: { view?: string; chrome?: string; hasMarket?: boolean; items?: unknown[] }) => string;
  tapeControl: (o: { count?: number; reduced?: boolean; paused?: boolean }) => { kind: string; label: string };
  nextIndex: (i: number, n: number) => number;
  keepIndex: (key: string | null, items: Item[]) => number;
  shortMonth: (label: string) => string;
};

type Mat = { seriesId: string; label: string; latest: { periodLabel: string; value: number; preliminary: boolean } | null; change1m: { pct: number } | null };
type Wage = { occupation: string; areaName: string; periodLabel: string; median: number | null; primary: boolean };
const AREA = JSON.parse(fx('api-market-area-95675.json')) as { materials: Mat[]; wages: Wage[] };
/** The text one item shows, the way tape.js lays it out on one line (on a narrow phone the mark and "prelim." hide). */
const shown = (i: Item) => [i.name, i.figure, i.kind === 'wage' ? i.note : `${i.mark}${i.change ?? '—'}`, `${i.month}${i.prelim ? ' prelim.' : ''}`].join(' ');

describe('tape items from a real GET /api/market/area answer', () => {
  const items = t.tapeItems(AREA);

  it('a phone-width pill gets a short name for each; the full name stays in the spoken label', () => {
    expect(items.map((i) => i.short)).toEqual([
      'Copper wire', 'Conduit', 'Switchgear', 'Panelboards', 'Lighting', 'Transformers', 'Wiring devices',
      'Constr. inputs', 'Electrical subs', 'Electricians',
    ]);
    for (const i of items) expect(i.spoken.startsWith(i.name)).toBe(true);
    expect(items[0]!.monthShort).toBe('Sep \u201926');
    expect(t.shortMonth('May 2025')).toBe('May \u201925');
    expect(t.shortMonth('2025 annual')).toBe('2025 annual'); // anything else unchanged
  });

  it('gives every material with a latest figure, in the server order, then the main wage', () => {
    const mats = AREA.materials.filter((m) => m.latest);
    expect(items.map((i) => i.name)).toEqual([...mats.map((m) => m.label), 'Electricians, California']);
    expect(items.at(-1)!.kind).toBe('wage');
  });

  it('rounds each one-month change exactly as the Market screen does (price.js: toFixed(1), "+" above zero)', () => {
    for (const m of AREA.materials) {
      const item = items.find((i) => i.name === m.label)!;
      const c = m.change1m!;
      expect(item.change).toBe(`${c.pct > 0 ? '+' : ''}${c.pct.toFixed(1)}%`);
      expect(item.dir).toBe(c.pct > 0 ? 'up' : c.pct < 0 ? 'down' : 'flat');
      expect(item.month).toBe(m.latest!.periodLabel);
      expect(item.prelim).toBe(m.latest!.preliminary);
    }
  });

  it('the figure of a material is its index level as the Market screen prints it ("Index 607.7"), never a price', () => {
    for (const m of AREA.materials) {
      const item = items.find((i) => i.name === m.label)!;
      expect(item.figure).toBe(m.latest!.value.toFixed(1));
      expect(item.figure).toMatch(/^\d+\.\d$/);
      expect(item.spoken).toContain(`index ${m.latest!.value.toFixed(1)}`);
    }
    expect(t.indexLevel(607.705)).toBe('607.7');
  });

  it('reads as the pill shows it (the real 2026-11-13 figures)', () => {
    expect(items.map(shown)).toEqual([
      'Copper wire and cable 607.7 ▲+0.8% Sep 2026 prelim.',
      'Conduit and conduit fittings 221.2 ▲+0.5% Sep 2026 prelim.',
      'Switchgear and switchboard apparatus 259.2 ▲+0.5% Sep 2026 prelim.',
      'Low-voltage panelboards 318.1 ▲+0.5% Sep 2026 prelim.',
      'Commercial and industrial lighting fixtures 274.6 ▲+1.9% Sep 2026 prelim.',
      'Transformers and power regulators 434.5 ▬0.0% Sep 2026 prelim.',
      'Wiring devices 400.4 ▲+0.3% Sep 2026 prelim.',
      'Inputs to nonresidential construction, goods 184.9 ▲+2.3% Sep 2026 prelim.',
      'Electrical contractors, nonresidential work (what subs charge) 180.7 ▬0.0% Sep 2026 prelim.',
      'Electricians, California $36.62/hr median May 2025',
    ]);
  });

  it('the wage is the primary one, its median to the cent, with its survey period, and never called prevailing', () => {
    const w = AREA.wages.find((x) => x.primary)!;
    const item = items.at(-1)!;
    expect(item.figure).toBe(`$${w.median!.toFixed(2)}/hr`);
    expect(item.note).toBe('median');
    expect(item.name).toBe(`${w.occupation}, ${w.areaName}`);
    expect(item.month).toBe(w.periodLabel);
    expect(item.spoken).toContain('published BLS wage');
    expect(items.map((i) => i.spoken).join(' ')).not.toMatch(/prevailing/i);
  });

  it('never says live or real time, and never shows a dollar sign on an index', () => {
    const all = [t.TAPE_ICON_LABEL, t.TAPE_STILL_TEXT, t.TAPE_STILL_SPOKEN, t.tapeSpoken(items), ...items.map(shown)].join(' ');
    expect(all).not.toMatch(/\blive\b|real[ -]?time/i);
    for (const i of items.filter((x) => x.kind === 'material')) expect(shown(i)).not.toContain('$');
    expect(t.TAPE_ICON_LABEL).toMatch(/monthly price indexes/i);
    expect(t.tapeSpoken(items)).toMatch(/^Monthly price indexes/);
  });

  it('the spoken label names each item once and says where a tap goes', () => {
    const said = t.tapeSpoken(items);
    for (const i of items) expect(said.split(i.spoken).length - 1).toBe(1);
    expect(said.split('Copper wire').length - 1).toBe(1);
    expect(said).toMatch(/Opens Market\.$/);
  });

  it('the fingerprint changes when a figure changes and not otherwise', () => {
    const again = t.tapeItems(JSON.parse(JSON.stringify(AREA)));
    expect(t.tapeKey(again)).toBe(t.tapeKey(items));
    const moved = JSON.parse(JSON.stringify(AREA)) as typeof AREA;
    moved.materials[0]!.change1m!.pct = -1.24;
    const after = t.tapeItems(moved);
    expect(after[0]!.change).toBe('-1.2%');
    expect(after[0]!.dir).toBe('down');
    expect(t.tapeKey(after)).not.toBe(t.tapeKey(items));
    const level = JSON.parse(JSON.stringify(AREA)) as typeof AREA;
    level.materials[0]!.latest!.value = 610.04;
    expect(t.tapeKey(t.tapeItems(level))).not.toBe(t.tapeKey(items));
  });
});

describe('tape items from empty and partial answers', () => {
  it('nothing loaded, an error body or garbage: no items (the pill stays still), never a throw', () => {
    for (const a of [null, undefined, {}, { error: 'zip_required' }, { materials: [], wages: [] }, { materials: 'x', wages: 5 }]) {
      expect(t.tapeItems(a)).toEqual([]);
    }
    expect(t.tapeSpoken([])).toBe('');
  });

  it('a material with no latest figure is left out; one with no one-month change shows a dash, not a number', () => {
    const items = t.tapeItems({
      materials: [
        { seriesId: 'TEST-A', label: 'TEST not loaded', latest: null, change1m: null, note: 'Not loaded yet' },
        { seriesId: 'TEST-B', label: 'TEST one month only', latest: { periodLabel: 'Sep 2026', value: 100.1, preliminary: false }, change1m: null },
      ],
      wages: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.change).toBeNull();
    expect(items[0]!.figure).toBe('100.1');
    expect(items[0]!.dir).toBe('none');
    expect(items[0]!.spoken).toContain('no one-month change');
  });

  it('a wage with no median, or only non-primary wages, gives no wage item', () => {
    const w = { occupation: 'TEST trade', areaName: 'TEST area', periodLabel: 'May 2025', soc: '000000', areaCode: '0' };
    expect(t.tapeItems({ materials: [], wages: [{ ...w, median: null, primary: true }] })).toEqual([]);
    expect(t.tapeItems({ materials: [], wages: [{ ...w, median: 30, primary: false }] })).toEqual([]);
    expect(t.tapeItems({ materials: [], wages: [{ ...w, median: 30, primary: true }] }).map((i) => i.figure)).toEqual(['$30.00/hr']);
  });

  it('signs and directions match price.js for the edges', () => {
    expect(t.signedPct(0)).toBe('0.0%');
    expect(t.signedPct(0.04)).toBe('+0.0%');
    expect(t.signedPct(-0.04)).toBe('-0.0%');
    expect(t.direction({ pct: 0 })).toBe('flat');
    expect(t.direction(null)).toBe('none');
    expect(t.direction({ pct: Number.NaN })).toBe('none');
  });
});

describe('what the tape is, screen by screen (tapeMode)', () => {
  const items = t.tapeItems(AREA);
  it('rotates on every tab screen for someone with a Market and figures in hand', () => {
    for (const view of ['home', 'browse', 'saved', 'jobs', 'messages']) expect(t.tapeMode({ view, chrome: 'tabs', hasMarket: true, items })).toBe('rotate');
  });
  it('is still ("Market prices", no number) with no figure: loading, a failed request, nothing stored', () => {
    expect(t.tapeMode({ view: 'home', chrome: 'tabs', hasMarket: true, items: [] })).toBe('still');
    expect(t.tapeMode({ view: 'saved', chrome: 'tabs', hasMarket: true })).toBe('still');
    expect(t.TAPE_STILL_TEXT).not.toMatch(/\d/);
    expect(t.TAPE_STILL_SPOKEN).toMatch(/Opens Market\.$/);
  });
  it('is hidden on Market itself, on full-page screens, and without a Market (the demo, a hire account)', () => {
    expect(t.tapeMode({ view: 'market', chrome: 'tabs', hasMarket: true, items })).toBe('hidden');
    for (const view of ['settings', 'signin', 'onboarding', 'alerts', 'cost', 'job', 'conversation']) {
      expect(t.tapeMode({ view, chrome: 'screen', hasMarket: true, items })).toBe('hidden');
    }
    expect(t.tapeMode({ view: 'home', chrome: 'tabs', hasMarket: false, items })).toBe('hidden');
  });
});

describe('the rotation (tapeControl, nextIndex, keepIndex)', () => {
  it('one item: nothing moves and there is no control; the still pill has none either', () => {
    expect(t.tapeControl({ count: 1 }).kind).toBe('none');
    expect(t.tapeControl({ count: 0, reduced: true }).kind).toBe('none');
  });
  it('two or more: pause while playing, play while paused, each with a label', () => {
    expect(t.tapeControl({ count: 10 })).toEqual({ kind: 'pause', label: 'Pause the market prices' });
    expect(t.tapeControl({ count: 10, paused: true })).toEqual({ kind: 'play', label: 'Play the market prices' });
  });
  it('reduced motion: nothing changes by itself; the control steps to the next item', () => {
    expect(t.tapeControl({ count: 10, reduced: true }).kind).toBe('next');
    expect(t.tapeControl({ count: 10, reduced: true, paused: true }).kind).toBe('next');
  });
  it('loops through every item once before it repeats, about every 4 seconds', () => {
    const seen = [0];
    for (let k = 0; k < 9; k++) seen.push(t.nextIndex(seen.at(-1)!, 10));
    expect(new Set(seen).size).toBe(10);
    expect(t.nextIndex(9, 10)).toBe(0);
    expect(t.nextIndex(0, 1)).toBe(0);
    expect(t.nextIndex(3, 0)).toBe(0);
    expect(t.TAPE_HOLD_MS).toBe(4000);
  });
  it('new data keeps the item on show where it still is (no jump), else starts at the first', () => {
    const items = t.tapeItems(AREA);
    expect(t.keepIndex(items[4]!.key, items)).toBe(4);
    expect(t.keepIndex('m:TEST-gone', items)).toBe(0);
    expect(t.keepIndex(null, items)).toBe(0);
  });
});
