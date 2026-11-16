import { describe, expect, it } from 'vitest';
import { fx } from './helpers.js';

// The market tape's items (web/js/tape-items.js). The "real answer" is GET /api/market/area exactly as this app's
// server sent it for ZIP 95675 (an electrician's profile), after loading the REAL BLS captures in test/fixtures
// (bls-oews-*.json, bls-ppi-core.json, 2026-11-13) through refreshBls, the replay test/market-routes.test.ts uses.
// web/js is plain JavaScript with no type declarations; a computed path keeps tsc from asking for them.
const modulePath = '../web/js/tape-items.js';
type Item = { key: string; kind: string; name: string; mark: string; dir: string; change: string | null; month: string; prelim: boolean; detail: string | null; spoken: string };
const t = (await import(modulePath)) as {
  TAPE_LABEL: string;
  signedPct: (pct: number) => string;
  direction: (c: unknown) => string;
  tapeItems: (area: unknown) => Item[];
  tapeSpoken: (items: Item[]) => string;
  tapeKey: (items: Item[]) => string;
};

type Mat = { seriesId: string; label: string; latest: { periodLabel: string; value: number; preliminary: boolean } | null; change1m: { pct: number } | null };
type Wage = { occupation: string; areaName: string; periodLabel: string; median: number | null; primary: boolean };
const AREA = JSON.parse(fx('api-market-area-95675.json')) as { materials: Mat[]; wages: Wage[] };
/** The text one item shows, the way tape.js lays it out. */
const shown = (i: Item) => [i.name, i.detail, `${i.mark}${i.change ?? '—'}`, `${i.month}${i.prelim ? ' (prelim.)' : ''}`].filter(Boolean).join(' ');

describe('tape items from a real GET /api/market/area answer', () => {
  const items = t.tapeItems(AREA);

  it('gives every material with a latest figure, in the server order, then the main wage', () => {
    const mats = AREA.materials.filter((m) => m.latest);
    expect(items.map((i) => i.name)).toEqual([...mats.map((m) => m.label), 'Electricians']);
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

  it('reads as the strip shows it (the real 2026-11-13 figures)', () => {
    expect(items.map(shown)).toEqual([
      'Copper wire and cable ▲+0.8% Sep 2026 (prelim.)',
      'Conduit and conduit fittings ▲+0.5% Sep 2026 (prelim.)',
      'Switchgear and switchboard apparatus ▲+0.5% Sep 2026 (prelim.)',
      'Low-voltage panelboards ▲+0.5% Sep 2026 (prelim.)',
      'Commercial and industrial lighting fixtures ▲+1.9% Sep 2026 (prelim.)',
      'Transformers and power regulators ▬0.0% Sep 2026 (prelim.)',
      'Wiring devices ▲+0.3% Sep 2026 (prelim.)',
      'Inputs to nonresidential construction, goods ▲+2.3% Sep 2026 (prelim.)',
      'Electrical contractors, nonresidential work (what subs charge) ▬0.0% Sep 2026 (prelim.)',
      'Electricians California $36.62/hr median May 2025',
    ]);
  });

  it('the wage is the primary one, its median to the cent, with its survey period, and never called prevailing', () => {
    const w = AREA.wages.find((x) => x.primary)!;
    const item = items.at(-1)!;
    expect(item.change).toBe(`$${w.median!.toFixed(2)}/hr median`);
    expect(item.detail).toBe(w.areaName);
    expect(item.month).toBe(w.periodLabel);
    expect(item.spoken).toContain('published BLS wage');
    expect(items.map((i) => i.spoken).join(' ')).not.toMatch(/prevailing/i);
  });

  it('never says live or real time, and never shows a dollar price for an index', () => {
    const all = [t.TAPE_LABEL, t.tapeSpoken(items), ...items.map(shown)].join(' ');
    expect(all).not.toMatch(/\blive\b|real[ -]?time/i);
    for (const i of items.filter((x) => x.kind === 'material')) expect(shown(i)).not.toContain('$');
    expect(t.TAPE_LABEL).toMatch(/monthly/i);
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
  });
});

describe('tape items from empty and partial answers', () => {
  it('nothing loaded, an error body or garbage: no items (the strip stays hidden), never a throw', () => {
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
    expect(items[0]!.dir).toBe('none');
    expect(items[0]!.spoken).toContain('no one-month change');
  });

  it('a wage with no median, or only non-primary wages, gives no wage item', () => {
    const w = { occupation: 'TEST trade', areaName: 'TEST area', periodLabel: 'May 2025', soc: '000000', areaCode: '0' };
    expect(t.tapeItems({ materials: [], wages: [{ ...w, median: null, primary: true }] })).toEqual([]);
    expect(t.tapeItems({ materials: [], wages: [{ ...w, median: 30, primary: false }] })).toEqual([]);
    expect(t.tapeItems({ materials: [], wages: [{ ...w, median: 30, primary: true }] }).map((i) => i.change)).toEqual(['$30.00/hr median']);
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
