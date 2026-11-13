/**
 * Builds web/demo-data.json from the real bid-board pages captured in test/fixtures,
 * so the swipe app can run with no server or network (demo mode, artifact preview).
 *
 *   npm run demo:snapshot            # scores relative to right now (past-due bids drop out)
 *   npm run demo:snapshot -- --now=2026-11-13T12:00:00-08:00   # as of the capture day
 *
 * The pages themselves are always read as of the capture day (see sources/fixtures.ts).
 * The SAM.gov fixture is synthetic test data, so it is deliberately left out.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
    return { ...b, score: s.score, verdict: s.verdict, reasons: s.reasons, distanceMi: s.distanceMi, swipe: null, firstSeenAt: now.toISOString(), overLimit: s.overLimit };
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
const safeJson = JSON.stringify(out).replace(/</g, '\\u003c'); // can't close the <script> early
const html = web('index.html')
  .split('\n')
  .filter((line) => !line.includes('data-demo-strip'))
  .join('\n')
  .replace('<link rel="stylesheet" href="styles.css" />', () => `<style>\n${web('styles.css')}\n</style>`)
  .replace('<script type="module" src="app.js"></script>', () => `<script>window.BIDSWIPE_DEMO = ${safeJson};</script>\n  <script type="module">\n${web('app.js')}\n</script>`);
mkdirSync(resolve(process.cwd(), 'out'), { recursive: true });
const demoFile = resolve(process.cwd(), 'out/bidswipe-demo.html');
writeFileSync(demoFile, html);
console.log(`Wrote single-file demo ${demoFile} (${Math.round(html.length / 1024)} KB)`);
