/**
 * Builds web/demo-data.json from the real bid-board pages captured in test/fixtures,
 * so the swipe app can run with no server or network (demo mode, artifact preview).
 *
 *   npm run demo:snapshot            # scores relative to right now (past-due bids drop out)
 *   npm run demo:snapshot -- --now=2026-11-13T12:00:00-08:00   # as of the capture day
 *
 * The pages themselves are always read as of the capture day (see sources/fixtures.ts).
 * SAM.gov is left out: its fixtures (test/fixtures/samgov-*.json) are real but trimmed responses, used by tests.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { loadProfile } from '../profiles.js';
import { finalizeBid } from '../scan.js';
import { scoreBid } from '../score/score.js';
import { FIXTURES_CAPTURED_AT, fixtureReaders } from '../sources/fixtures.js';
import type { BidDraft, FeedItem } from '../types.js';

const nowArg = process.argv.find((a) => a.startsWith('--now='))?.slice(6);
const now = nowArg ? new Date(nowArg) : new Date();
const profile = loadProfile(process.env.PROFILE_ID ?? 'lm-electric');

const drafts: BidDraft[] = fixtureReaders().flatMap((f) => f.read());
const capturedAt = FIXTURES_CAPTURED_AT.toISOString().slice(0, 10);

const items: FeedItem[] = drafts
  .map(finalizeBid)
  .filter((b) => !b.dueAt || Date.parse(b.dueAt) > now.getTime())
  .map((b) => {
    const s = scoreBid(b, profile, now);
    return { ...b, score: s.score, verdict: s.verdict, reasons: s.reasons, distanceMi: s.distanceMi, swipe: null, firstSeenAt: now.toISOString(), overLimit: s.overLimit, tier: s.tier };
  })
  .sort((a, b) => b.score - a.score || (Date.parse(a.dueAt ?? '9999') - Date.parse(b.dueAt ?? '9999')));

const out = {
  generatedAt: now.toISOString(),
  capturedAt,
  note: `Real public bid listings captured from Douglas County NV, NGEM and NevadaEPro on ${capturedAt}, and from NV State Public Works (QuestCDN) on 2026-11-11. A saved snapshot, not a live feed.`,
  profile: { id: profile.id, name: profile.name, base: profile.base.label, maxDistanceMi: profile.maxDistanceMi, valueRange: profile.valueRange, notifyMinScore: profile.notify.minScore },
  items,
};
const file = resolve(process.cwd(), 'web/demo-data.json');
writeFileSync(file, JSON.stringify(out, null, 2));
const byV = items.reduce<Record<string, number>>((acc, i) => ((acc[i.verdict] = (acc[i.verdict] ?? 0) + 1), acc), {});
console.log(`Wrote ${items.length} bids to ${file}`, byV);
for (const i of items.slice(0, 12)) console.log(`${String(i.score).padStart(3)} ${i.verdict.padEnd(5)} ${i.title.slice(0, 70)} — ${i.distanceMi ?? '?'} mi`);

// ---- single-file demo page (for sharing a link / phone preview) ----
// Inlines CSS + JS + data so it runs anywhere with no server.
const web = (f: string) => readFileSync(resolve(process.cwd(), 'web', f), 'utf8');

/**
 * The app is plain ES modules under web/js/ (entry js/main.js). A single file cannot import siblings, so
 * this joins them into one script: each module becomes a function scope that returns its exports, in
 * dependency order. It understands only what web/js uses — `import { a, b as c } from './x.js'`,
 * `import './x.js'`, and `export function|async function|const|class` — and throws on anything else
 * (export default / export { } / import cycles), so a new pattern fails here instead of in the browser.
 */
function bundleWeb(entry: string): string {
  const order: string[] = [];
  const seen = new Map<string, 'visiting' | 'done'>();
  const code = new Map<string, string>();
  const ident = (file: string) => `__m_${file.replace(/[^A-Za-z0-9]/g, '_')}`;
  const visit = (file: string) => {
    if (seen.get(file) === 'done') return;
    if (seen.get(file) === 'visiting') throw new Error(`bundleWeb: import cycle through web/${file}`);
    seen.set(file, 'visiting');
    const exports: string[] = [];
    const body = web(file)
      // import { a, b as c } from './x.js';  (may span lines)   ·   import './x.js';
      .replace(/^import\s+(?:\{([^}]*)\}\s+from\s+)?'(\.{1,2}\/[^']+)';[ \t]*$/gm, (_m, names: string | undefined, spec: string) => {
        const dep = posix.normalize(posix.join(posix.dirname(file), spec));
        visit(dep);
        if (!names) return '';
        const list = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': '));
        return `const { ${list.join(', ')} } = ${ident(dep)};`;
      })
      .replace(/^export\s+((?:async\s+)?function\*?|const|class)\s+([A-Za-z_$][\w$]*)/gm, (_m, kind: string, name: string) => {
        exports.push(name);
        return `${kind} ${name}`;
      });
    const odd = /^\s*(?:import\b|export\b).*$/m.exec(body);
    if (odd) throw new Error(`bundleWeb: web/${file} uses an import/export form the demo bundler does not handle: ${odd[0].trim()}`);
    code.set(file, `const ${ident(file)} = (() => {\n${body}\nreturn { ${exports.join(', ')} };\n})();`);
    seen.set(file, 'done');
    order.push(file);
  };
  visit(entry);
  return order.map((f) => `// ---- web/${f}\n${code.get(f)}`).join('\n');
}
const safeJson = JSON.stringify(out).replace(/</g, '\\u003c'); // can't close the <script> early
const html = web('index.html')
  .split('\n')
  .filter((line) => !line.includes('data-demo-strip'))
  .join('\n')
  .replace('<link rel="stylesheet" href="styles.css" />', () => `<style>\n${web('styles.css')}\n</style>`)
  .replace('<script type="module" src="js/main.js"></script>', () => `<script>window.BIDSWIPE_DEMO = ${safeJson};</script>\n  <script type="module">\n${bundleWeb('js/main.js').replace(/<\/script/gi, '<\\/script')}\n</script>`);
if (!html.includes('window.BIDSWIPE_DEMO')) throw new Error('snapshot: web/index.html no longer loads js/main.js — update the demo builder');
mkdirSync(resolve(process.cwd(), 'out'), { recursive: true });
const demoFile = resolve(process.cwd(), 'out/bidswipe-demo.html');
writeFileSync(demoFile, html);
console.log(`Wrote single-file demo ${demoFile} (${Math.round(html.length / 1024)} KB)`);
