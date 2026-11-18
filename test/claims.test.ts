import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The copy guard (docs/PLAN.md R6 and §6, N7): what a store or an install prompt shows about BidSwipe never claims to
 * be the best or the biggest, never says "real-time" (a scan runs once a day), never counts its users, and never says
 * "instant" unless the same sentence says "once a day". It reads:
 *   web/manifest.webmanifest   name, short_name, description, each shortcut's words, each screenshot's label
 *   web/*.html                 <meta name="description">
 *   docs/MICROSOFT-STORE.md    the listing text to paste (the fenced blocks under "Store listing") and its captions
 *   docs/store/captions.md     the screenshot captions
 * Fix a sentence it catches honestly, keeping the meaning: never by spelling a word around the guard.
 */

/** What is not allowed, in plain words. `unless`: the same sentence makes it honest. */
const RULES: Array<{ says: string; re: RegExp; unless?: RegExp }> = [
  { says: 'a "#1" claim', re: /#\s?1\b|\bnumber one\b/i },
  { says: '"largest"', re: /\blargest\b/i },
  { says: '"real-time" (a scan runs once a day)', re: /\breal[\s-]?time\b/i },
  {
    says: 'a user count',
    re: /\b(?:\d[\d,.]*\s*[km]?\+?|thousands|hundreds|millions|tens of thousands)\s+(?:of\s+)?(?:users|contractors|members|businesses|companies|customers|subscribers|pros|downloads)\b/i,
  },
  { says: '"instant" without "once a day"', re: /\binstant(?:ly)?\b/i, unless: /\bonce a day\b/i },
];

/** Sentences: split after . ! ? and at line breaks. */
const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

/** Every broken rule in `text`, as "<rule>: <sentence>". */
function claimsIn(text: string): string[] {
  const out: string[] = [];
  for (const s of sentences(text)) {
    for (const r of RULES) if (r.re.test(s) && !(r.unless && r.unless.test(s))) out.push(`${r.says}: ${s}`);
  }
  return out;
}

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** Each place's text, keyed by where it comes from (so a failure names the file and field). */
function storeTexts(): Record<string, string> {
  const out: Record<string, string> = {};
  const m = JSON.parse(read('web/manifest.webmanifest')) as {
    name: string; short_name: string; description: string;
    shortcuts?: Array<{ name: string; short_name?: string; description?: string }>;
    screenshots?: Array<{ label?: string }>;
  };
  out['manifest name'] = m.name;
  out['manifest short_name'] = m.short_name;
  out['manifest description'] = m.description;
  (m.shortcuts ?? []).forEach((s, i) => { out[`manifest shortcut ${i + 1}`] = [s.name, s.short_name, s.description].filter(Boolean).join('\n'); });
  (m.screenshots ?? []).forEach((s, i) => { if (s.label) out[`manifest screenshot ${i + 1}`] = s.label; });

  for (const file of readdirSync(new URL('../web/', import.meta.url)).filter((f) => f.endsWith('.html'))) {
    const meta = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(read(`web/${file}`));
    if (meta) out[`web/${file} meta description`] = meta[1]!;
  }

  // The Store listing: from its heading to the next "### " heading, the blocks to paste and the captions table.
  const store = read('docs/MICROSOFT-STORE.md');
  const start = store.indexOf('### Store listing');
  const listing = store.slice(start, store.indexOf('\n### ', start + 1));
  [...listing.matchAll(/```\n([\s\S]*?)```/g)].forEach((b, i) => { out[`MICROSOFT-STORE.md listing block ${i + 1}`] = b[1]!; });
  out['MICROSOFT-STORE.md captions table'] = listing.split('\n').filter((l) => /^\| `\d\d-/.test(l)).map((l) => l.split('|')[2]!.trim()).join('\n');

  // The captions: every paragraph under a screenshot's heading, up to "How these were taken".
  const captions = read('docs/store/captions.md');
  const body = captions.slice(captions.indexOf('\n## '), captions.indexOf('## How these were taken'));
  out['docs/store/captions.md'] = body.split('\n').filter((l) => l.trim() && !l.startsWith('#')).join('\n');
  return out;
}

describe('store and app-description copy makes no claims we cannot back (N7)', () => {
  const texts = storeTexts();

  it('reads every place it guards (none came back empty)', () => {
    const keys = Object.keys(texts);
    for (const want of ['manifest name', 'manifest description', 'manifest shortcut 1', 'web/index.html meta description',
      'MICROSOFT-STORE.md listing block 1', 'MICROSOFT-STORE.md captions table', 'docs/store/captions.md']) {
      expect(keys).toContain(want);
    }
    for (const [where, text] of Object.entries(texts)) expect(text.trim(), where).not.toBe('');
    expect(Object.keys(texts).filter((k) => k.startsWith('MICROSOFT-STORE.md listing block')).length).toBeGreaterThanOrEqual(4);
    expect(texts['docs/store/captions.md']!.split('\n').length).toBe(8); // one caption per screenshot
  });

  it('no "#1", "largest", "real-time", user counts, or "instant" without "once a day"', () => {
    const found = Object.entries(texts).flatMap(([where, text]) => claimsIn(text).map((c) => `${where}: ${c}`));
    expect(found).toEqual([]);
  });

  it('the guard itself catches each kind (synthetic sentences)', () => {
    for (const bad of [
      'The #1 app for contractors.', 'BidSwipe is the number one bid finder.', 'The largest database of public bids.',
      'Real-time bid alerts.', 'Bids in realtime.', 'Bids in real time.', 'Trusted by thousands of contractors.',
      'Join 10,000+ contractors.', 'Used by 5k users.', 'Instant alerts for new bids.', 'Bids are scored instantly.',
    ]) expect(claimsIn(bad), bad).not.toEqual([]);
    for (const ok of [
      'Once a day BidSwipe reads the boards, and new fits reach your inbox instantly after that scan, once a day.',
      'The winner has 7 days to make contact.', 'Up to 10 alerts per scan.', 'Search every open bid that fits.',
      'People and businesses can post a job.',
    ]) expect(claimsIn(ok), ok).toEqual([]);
  });
});
