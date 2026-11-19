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

/** People a count could claim as users (store copy never counts them). */
const PEOPLE = '(?:users|members|accounts|customers|subscribers|downloads|installs|businesses|companies|firms|contractors|'
  + 'subcontractors|subs|pros|professionals|tradespeople|tradesmen|electricians|plumbers|roofers|carpenters|crews|people)';
/** A number big enough to be a user count: 100 or more, 5k / 1.2m, or anything with a "+" (a small count like "3 contractors" is not). */
const BIG_NUMBER = '(?:(?:\\d{1,3}(?:,\\d{3})+|\\d{3,}|\\d+(?:\\.\\d+)?\\s?[km])\\+?|\\d+\\s?\\+)';

/** What is not allowed, in plain words. `unless`: the same sentence makes it honest. */
const RULES: Array<{ says: string; re: RegExp; unless?: RegExp }> = [
  { says: 'a "#1" claim', re: /#\s?1\b|\bnumber\s+one\b|\bno\.?\s?1\b/i },
  { says: '"largest"', re: /\b(?:largest|biggest)\b/i },
  { says: '"real-time" (a scan runs once a day)', re: /\breal[\s-]?time\b/i },
  { says: 'a user count', re: new RegExp(`(?:^|[^\\w,.])${BIG_NUMBER}\\s*(?:of\\s+)?${PEOPLE}\\b`, 'i') },
  { says: 'a user count', re: new RegExp(`\\b(?:thousands|hundreds|millions|dozens)\\s+of\\s+${PEOPLE}\\b`, 'i') },
  {
    says: 'a user count ("used by …")',
    re: /\b(?:trusted by|used by|loved by|chosen by|relied on by|joined by|join)\s+(?:over\s+|more than\s+)?(?:\d[\d,.]*\s?[km]?\+?|thousands|hundreds|millions|dozens)\b/i,
  },
  { says: '"instant" without "once a day"', re: /\binstant\w*\b/i, unless: /\bonce a day\b/i },
];

/** Every kind of hyphen and dash reads as "-", every no-break space as a space: "Real‑time" (U+2011) is "real-time". */
const plain = (text: string): string => text.replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, '-').replace(/[\u00a0\u2007\u202f]/g, ' ');

/** Sentences: split after . ! ? and at line breaks (a "." inside a number or "No. 1" does not end one). */
const sentences = (text: string): string[] => plain(text).split(/(?<=[!?]|(?<!\bNo)\.)\s+|\n+/i).map((s) => s.trim()).filter(Boolean);

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
      // Forms a review found the first guard missed (2026-11-18):
      'Trusted by 2,000 electricians.', 'Over 1,000 subcontractors use it.', 'Join 50,000 people who find bids here.',
      'Used by thousands.', 'Thousands of electricians use BidSwipe.', 'The No. 1 bid app.', 'The No.1 bid app.',
      'Instantaneous bid alerts.', 'Real\u2011time bid alerts.', 'Real\u2010time alerts.', 'The biggest bid list.',
      'Join 50 contractors near you.', '1.2m downloads.', 'More than 500 crews.', '20+ pros nearby.',
    ]) expect(claimsIn(bad), bad).not.toEqual([]);
    for (const ok of [
      'Once a day BidSwipe reads the boards, and new fits reach your inbox instantly after that scan, once a day.',
      'The winner has 7 days to make contact.', 'Up to 10 alerts per scan.', 'Search every open bid that fits.',
      'People and businesses can post a job.',
      // A small count is not a user count (decided 2026-11-18; a "+" or 100 and up is):
      'Get bids from 3 contractors nearby.', 'Compare up to 5 companies in one place.',
      'Bids from more than 20 boards, read once a day.', 'Each card names its NAICS code 238210.', 'No phone number needed.',
    ]) expect(claimsIn(ok), ok).toEqual([]);
  });
});
