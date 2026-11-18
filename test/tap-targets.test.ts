/**
 * Tap targets of 44 x 44 CSS px or more (docs/PLAN.md R3, N9: WCAG 2.2 AAA, for gloved hands).
 *
 * There is no harness for the web JS, so this reads the stylesheets: every control below must DECLARE a 44 px box
 * (height / min-height, width / min-width) or a ::before hit area that makes it 44 px (a control that must look
 * smaller keeps its look and grows its hit area: the tape's play button, a toggle row, the sub-work note's close).
 * Each is checked with web/styles.css alone and under every @media of styles.css and desktop.css that touches it, so
 * a narrow-phone or a desk rule cannot shrink it again. A browser measure of the real screens is
 * scripts/measure-taps.mjs (run by hand against a local server; it walks Home, Search, Saved, the sheet, Settings,
 * Jobs, a job page, Messages and the bell and lists every hit box under 44 x 44).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIN = 44;
const web = (name: string) => readFileSync(fileURLToPath(new URL(`../web/${name}`, import.meta.url)), 'utf8');

interface Rule { file: string; media: string; selectors: string[]; decls: Map<string, string> }

/** Split on `sep` outside quotes and brackets (a data: URL holds both). */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = '', cur = '';
  for (const c of s) {
    if (quote) { if (c === quote) quote = ''; cur += c; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Plain rules and @media blocks (nested media conditions joined with " and "); @keyframes are skipped. */
function parseCss(css: string, file: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const media: string[] = [];
  let i = 0, head = '';
  while (i < src.length) {
    const c = src[i]!;
    if (c === '}') { media.pop(); head = ''; i++; continue; }
    if (c !== '{') { head += c; i++; continue; }
    const h = head.trim();
    head = '';
    if (h.startsWith('@media')) { media.push(h.slice('@media'.length).trim()); i++; continue; }
    if (h.startsWith('@')) { // @keyframes and the like: skip the whole block
      let depth = 0;
      do { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; } while (depth > 0 && i < src.length);
      continue;
    }
    const end = src.indexOf('}', i);
    const decls = new Map<string, string>();
    for (const d of splitTop(src.slice(i + 1, end), ';')) {
      const at = d.indexOf(':');
      if (at > 0) decls.set(d.slice(0, at).trim().toLowerCase(), d.slice(at + 1).replace(/!important/, '').trim());
    }
    rules.push({ file, media: media.join(' and '), selectors: splitTop(h, ',').map((s) => s.trim().replace(/\s+/g, ' ')), decls });
    i = end + 1;
  }
  return rules;
}

const RULES = [...parseCss(web('styles.css'), 'styles.css'), ...parseCss(web('desktop.css'), 'desktop.css')];
const MEDIA = [...new Set(RULES.map((r) => r.media).filter(Boolean))];

/** The declarations for exactly `sel` with no @media, then those inside `media` (source order: the cascade). */
function declsFor(sel: string, media: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of RULES) {
    if (r.media && r.media !== media) continue;
    if (!r.selectors.includes(sel)) continue;
    for (const [k, v] of r.decls) out.set(k, v);
  }
  return out;
}
const px = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  if (v === '0') return 0;
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v.trim());
  return m ? Number(m[1]) : null;
};
/** "a", "a b", "a b c", "a b c d" → [top, right, bottom, left]. */
function sides(v: string | undefined): [number, number, number, number] | null {
  if (v === undefined) return null;
  const p = v.trim().split(/\s+/).map(px);
  if (p.some((x) => x === null)) return null;
  const [t, r = t, b = t, l = r] = p as number[];
  return [t!, r!, b!, l!];
}
/** The border widths a rule set gives (shorthand, then border-width). */
function borders(d: Map<string, string>): [number, number, number, number] {
  let out: [number, number, number, number] = [0, 0, 0, 0];
  const short = d.get('border');
  if (short !== undefined) {
    if (/^(0|none)$/.test(short.trim())) out = [0, 0, 0, 0];
    else { const w = short.split(/\s+/).map(px).find((x) => x !== null); out = [w ?? 0, w ?? 0, w ?? 0, w ?? 0]; }
  }
  return sides(d.get('border-width')) ?? out;
}

type Axis = 'h' | 'w';
/**
 * What `sel` takes a tap over along one axis under `media`: the larger of its declared box and its ::before hit
 * area (absolutely placed over the padding box: the box less its borders, plus how far a negative inset reaches).
 * `base` stands in for a box the content sets (a toggle row is as tall as its 28 px track).
 */
function hit(sel: string, axis: Axis, media: string, base: number | null = null): number {
  const d = declsFor(sel, media);
  const box = Math.max(base ?? 0, ...(axis === 'h' ? ['height', 'min-height'] : ['width', 'min-width']).map((k) => px(d.get(k)) ?? 0));
  const before = declsFor(`${sel}::before`, media);
  if (!before.has('content') || before.get('position') !== 'absolute') return box;
  const inset = sides(before.get('inset')) ?? [0, 0, 0, 0];
  const [bt, br, bb, bl] = borders(d);
  const area = axis === 'h' ? box - bt - bb - Math.min(0, inset[0]) - Math.min(0, inset[2]) : box - bl - br - Math.min(0, inset[1]) - Math.min(0, inset[3]);
  return Math.max(box, area);
}

interface Control { sel: string; what: string; w?: boolean; base?: () => number | null }
/** Every control on the main screens, with what it is; `w` = its width is guarded too (it can be short). */
const CONTROLS: Control[] = [
  // The ones docs/PLAN.md R3 named as small (2026-11-18), and those the screen measure found.
  { sel: '.chip', what: 'filter chips, "Travel 50 mi", Market lookups (a 34px pill, 44 to the touch)', w: true },
  { sel: '.trade-chip', what: 'trade, size, skill and day chips (a 38px pill)', w: true },
  { sel: '.seg3-btn', what: 'Yes / No / Not sure (paperwork)' },
  { sel: '.row-remove', what: 'remove a cost line (34px to the eye)', w: true },
  { sel: '.range', what: 'the radius and minimum-fit sliders' },
  { sel: '.tape-toggle', what: 'the price tape pause / play (36 x 40, 32 wide on a narrow phone)', w: true },
  { sel: '.switch', what: 'a toggle row (as tall as its track)', base: () => px(declsFor('.switch-track', '').get('height')) },
  { sel: '.tier-opt', what: 'Fits · Sub work · Everything' },
  { sel: '.seg-btn', what: 'Sign in · Create account' },
  { sel: '.sort-select', what: 'the Search sort pill (30px to the eye)' },
  { sel: '.check', what: 'a checkbox row, "I agree to these rules"' },
  { sel: '.text-btn', what: 'Reset, Read all, Market →, Edit, Card …', w: true },
  { sel: '.link-btn.report-link', what: '"Report this job" on a line of its own' },
  { sel: '.link-btn.more-boards', what: '"More boards" in Filters' },
  { sel: '.card-foot button', what: 'the swipe card\'s "Details"', w: true },
  { sel: '.sub-note-x', what: 'close the sub-work note (26px to the eye)', w: true },
  { sel: '.toast button', what: 'Undo' },
  { sel: '.eye', what: 'show / hide the password', w: true },
  { sel: '.input', what: 'every text, number, time and select box' },
  { sel: '.cta', what: 'every main button' },
  { sel: '.pcard-link', what: 'a link on a member\'s card' },
  { sel: '.job-private a', what: 'the poster\'s phone, for the winner' },
  { sel: '.pc-more summary', what: '"Newest 5 awards" and the other price-check openers' },
  { sel: '.cc-sources > summary', what: '"Where these numbers come from"' },
  // Already 44 or more: kept that way.
  { sel: '.tab', what: 'the tab bar' },
  { sel: '.bell', what: 'the bell', w: true },
  { sel: '.avatar', what: 'the profile button', w: true },
  { sel: '.top-back', what: 'Back from Market', w: true },
  { sel: '.icon-btn', what: 'Back / close on a screen', w: true },
  { sel: '.sheet-close', what: 'close a sheet', w: true },
  { sel: '.mode-opt', what: 'Scroll | Swipe', w: true },
  { sel: '.mc-btn', what: 'Save / Pass on a match card', w: true },
  { sel: '.round', what: 'Pass / Save under the swipe deck', w: true },
  { sel: '.round.open', what: 'open the bid under the swipe deck', w: true },
  { sel: '.hx-btn', what: 'a Home task\'s button' },
  { sel: '.hx-arrow', what: 'the Home task pager', w: true },
  { sel: '.hx-chip', what: 'a Home preference chip' },
  { sel: '.hx-tasks-head', what: '"Finish setting up"' },
  { sel: '.hx-add', what: 'add a preference' },
  { sel: '.mx-row', what: 'a conversation in Messages' },
  { sel: '.mx-head-job', what: 'the job link in a conversation' },
  { sel: '.report > .report-link', what: '"Report this conversation"' },
  { sel: '.report-reason', what: 'a report reason' },
  { sel: '.delete-job', what: 'a job in the delete-account list' },
  { sel: '.intent', what: 'what brings you here (onboarding)' },
];

describe('tap targets: 44 x 44 CSS px (docs/PLAN.md R3)', () => {
  it('reads both stylesheets (a parser that read nothing would pass everything)', () => {
    expect(RULES.filter((r) => r.file === 'styles.css').length).toBeGreaterThan(500);
    expect(RULES.filter((r) => r.file === 'desktop.css').length).toBeGreaterThan(30);
    expect(MEDIA).toContain('(min-width: 900px)');
    expect(MEDIA).toContain('(max-width: 400px)');
    expect(declsFor('.tape-toggle', '(max-width: 400px)').get('width')).toBe('32px');
  });

  for (const c of CONTROLS) {
    it(`${c.sel}: ${c.what}`, () => {
      expect(RULES.some((r) => r.selectors.includes(c.sel)), `no rule for ${c.sel}`).toBe(true);
      // Base, then every @media (either file) with a rule for it or its ::before.
      const contexts = ['', ...MEDIA.filter((m) => RULES.some((r) => r.media === m && (r.selectors.includes(c.sel) || r.selectors.includes(`${c.sel}::before`))))];
      for (const m of contexts) {
        const where = m ? `@media ${m}` : 'no @media';
        expect(hit(c.sel, 'h', m, c.base?.() ?? null), `${c.sel} height, ${where}`).toBeGreaterThanOrEqual(MIN);
        if (c.w) expect(hit(c.sel, 'w', m), `${c.sel} width, ${where}`).toBeGreaterThanOrEqual(MIN);
      }
    });
  }

  it('no rule anywhere shrinks a guarded control under 44 px (a narrower selector, a variant, a @media)', () => {
    /** The classes of a selector's last compound (".chip.is-on:hover" → chip, is-on; "input" → none). */
    const classes = (sel: string) => [...sel.split(/[\s>+~]+/).pop()!.replace(/:[a-z-]+(\([^)]*\))?/g, '').matchAll(/\.([\w-]+)/g)].map((m) => m[1]!);
    const guarded = CONTROLS.map((c) => ({ c, need: classes(c.sel) })).filter((g) => g.need.length > 0);
    const bad: string[] = [];
    for (const r of RULES) {
      for (const s of r.selectors) {
        if (s.includes('::')) continue;
        const have = new Set(classes(s));
        for (const { c, need } of guarded) {
          if (!need.every((k) => have.has(k))) continue;
          const props = c.w ? ['height', 'min-height', 'max-height', 'width', 'min-width', 'max-width'] : ['height', 'min-height', 'max-height'];
          for (const p of props) {
            const v = px(r.decls.get(p));
            // The exact selector with a ::before hit area is checked by the table above, per @media.
            if (v !== null && v < MIN && !(s === c.sel && declsFor(`${c.sel}::before`, r.media).has('content'))) bad.push(`${r.file} ${r.media ? `@media ${r.media} ` : ''}${s} { ${p}: ${v}px }`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('a chip\'s clear border stays clear: the pill is the padding box, never a coloured 44 px block', () => {
    // .chip, .trade-chip and the sort pill take taps on a transparent border. A rule that set the background
    // shorthand without padding-box, or coloured the border, would draw the whole 44 px box.
    const bad: string[] = [];
    for (const r of RULES) {
      for (const s of r.selectors) {
        const last = s.split(/[\s>+~]+/).pop()!;
        if (!/\.(chip|trade-chip|sort-select)(?![\w-])/.test(last) || s.includes('::')) continue;
        const bg = r.decls.get('background');
        if (bg !== undefined && !/padding-box/.test(bg)) bad.push(`${s} { background: ${bg} }`);
        const bc = r.decls.get('border-color');
        if (bc !== undefined && bc !== 'transparent') bad.push(`${s} { border-color: ${bc} }`);
        const b = r.decls.get('border');
        if (b !== undefined && !/transparent|^0$|^none$/.test(b)) bad.push(`${s} { border: ${b} }`);
      }
    }
    expect(bad).toEqual([]);
    for (const sel of ['.chip', '.trade-chip', '.sort-select']) {
      const d = declsFor(sel, '');
      expect(d.get('background') ?? '', sel).toMatch(/padding-box/);
      expect(d.get('box-shadow') ?? '', sel).toMatch(/^inset/); // the hairline round the pill
    }
  });

  it('the hit areas that grow past a control are real overlays: content and position: absolute', () => {
    for (const sel of ['.tape-toggle', '.switch', '.tier-opt', '.seg-btn', '.row-remove', '.sub-note-x', '.toast button']) {
      const d = declsFor(sel, '');
      const b = declsFor(`${sel}::before`, '');
      expect(d.get('position'), `${sel} is the overlay's containing block`).toMatch(/relative|absolute/);
      expect(b.get('content'), sel).toBe("''");
      expect(b.get('position'), sel).toBe('absolute');
    }
  });
});
