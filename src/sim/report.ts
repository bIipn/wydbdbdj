/**
 * report.md for `npm run simulate`: the per-company table, what an owner should know, the checks and the
 * mutations that prove them, and the measurements of this machine (labelled as such).
 */
import type { SimMeasurements, SimReport } from './run.js';

export interface MutationOutcome {
  mutation: string;
  how: string;
  expects: string;
  caught: boolean;
  violations: number;
  example: string;
  /** Answer rewritten for the checker (no real data can exercise the rule): not counted as a caught mutation. */
  selfTest?: boolean;
}

const money = (n: number | null): string => (n === null ? '—' : `$${n.toLocaleString('en-US')}`);
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function renderMarkdown(r: SimReport, m: SimMeasurements, extra: { determinism?: { same: boolean; hashes: string[] }; mutations?: MutationOutcome[] } = {}): string {
  const L: string[] = [];
  L.push('# BidSwipe multi-company simulation');
  L.push('');
  L.push(`Seed ${r.seed} · bids captured ${r.capturedAt} (every board read as of that moment) · ${r.personas.length} simulated companies.`);
  L.push('');
  L.push('Every company here is SIMULATED: names start with "SIM" and end with "(simulated)", emails are @example.com, and their value ranges, spend limits, bonding capacity and cost-check takeoffs are made-up persona inputs. The bids are REAL notices captured from the boards on 2026-11-13 (Douglas County, QuestCDN/NV State Public Works, NGEM, NevadaEPro, SAM.gov).');
  L.push('');
  const notExercised = Object.entries(r.checks.coverage).filter(([k, c]) => k !== 'determinism' && c.items === 0).map(([k]) => k);
  L.push(`**Checks: ${r.checks.violations.length === 0 ? 'all passed' : `${r.checks.violations.length} VIOLATION(S)`}** (${r.checks.total} check runs, a check on a company, that evaluated at least one item).${notExercised.length ? ` **Not exercised by this data** (nothing to evaluate, so they prove nothing here): ${notExercised.join(', ')}.` : ''}`);
  if (extra.determinism) L.push(`**Same seed, same report: ${extra.determinism.same ? 'yes' : 'NO'}** (sha256 ${extra.determinism.hashes.map((h) => h.slice(0, 12)).join(' / ')}).`);
  if (extra.mutations) {
    const real = extra.mutations.filter((x) => !x.selfTest);
    const self = extra.mutations.filter((x) => x.selfTest);
    L.push(`**Mutations caught: ${real.filter((x) => x.caught).length} of ${real.length}.**${self.length ? ` Plus ${self.length} checker self-test(s) (answer rewritten, not the product rule): ${self.filter((x) => x.caught).length} caught.` : ''}`);
  }
  L.push('');

  L.push('## What a real owner should know');
  L.push('');
  for (const f of r.findings) L.push(`- ${f}`);
  L.push('');

  L.push('## Per company');
  L.push('');
  L.push('Bids seen = open bids scored for the company (Browse). Great/good/maybe/skip = verdicts. Deck = the swipe deck after all scans. Alerts = inbox. Over limit = Browse bids flagged over the spend limit. Value ranges and limits are simulated.');
  L.push('');
  L.push('| Company | Place | Plan | Trades | Radius | Range (sim.) | Seen | Great | Good | Maybe | Skip | Deck | Alerts | Over limit | Next bid |');
  L.push('|---|---|---|---|--:|---|--:|--:|--:|--:|--:|--:|--:|--:|---|');
  for (const p of r.personas) {
    const next = p.next ? `${p.next.score} — ${p.next.title.slice(0, 50)}` : 'none';
    L.push(`| ${cell(p.name)} | ${cell(p.town)} | ${p.plan} | ${p.trades.join(' + ')} | ${p.radiusMi} mi | ${money(p.valueRange.min)}–${money(p.valueRange.max)} | ${p.bidsSeen} | ${p.verdicts.great} | ${p.verdicts.good} | ${p.verdicts.maybe} | ${p.verdicts.skip} | ${p.deck} | ${p.alerts} | ${p.overLimit} | ${cell(next)} |`);
  }
  L.push('');
  for (const p of r.personas) {
    L.push(`### ${p.key} · ${p.name}`);
    L.push('');
    L.push(`${p.reason}`);
    L.push('');
    L.push(`- ${p.town}, ${p.plan}, ${p.trades.join(' + ')}, radius ${p.radiusMi} mi, jobs ${money(p.valueRange.min)}–${money(p.valueRange.max)} (simulated); limits (simulated): job ${money(p.limits.maxJobSize)}, bonding ${money(p.limits.bondingCapacity)}; set-asides ticked: ${p.setAsides.join(', ') || 'none'}.`);
    L.push(`- Seen ${p.bidsSeen}: ${p.withinRadius} measured inside the radius, ${p.unknownDistance} with no distance for this company, ${p.noEstimate} with no estimated value. Deck ${p.deck}, alerts ${p.alerts} (${p.alertsFromScan2} from the held-out bids of scan 2).`);
    if (p.next) L.push(`- Next bid: **${p.next.title}** (${p.next.id}), ${p.next.why.join(' · ')}.`);
    else L.push('- Next bid: none (nothing in the deck).');
    if (p.topFits.length) L.push(`- Top fits: ${p.topFits.map((t) => `${t.score} ${t.verdict} “${t.title.slice(0, 60)}”${t.place ? ` (${t.place}${t.distanceMi !== null ? `, ${t.distanceMi} mi` : ''})` : ''}`).join('; ')}.`);
    if (p.reservedSeen.length) L.push(`- Reserved federal notices: ${p.reservedSeen.map((x) => `${x.setAside} ${x.score} (${x.firstReason})`).join('; ')}.`);
    L.push(`- Cost check: ${p.cost.verdict}${p.cost.bidId ? ` on ${p.cost.bidId}` : ''}. Quick form: ${p.cost.quick}.`);
    if (p.cost.notes.length) L.push(`  - Simulated takeoff: ${p.cost.notes.join('; ')}.`);
    L.push(`- Market: awards ${p.market.awards} · area: ${p.market.area || '—'} · watch: ${p.market.watch}.`);
    L.push('');
  }

  L.push('## Coverage: where the bids are not');
  L.push('');
  L.push('| Company | Place | Open bids scored | Inside radius | Deck | Owners whose notices are not read (to check) |');
  L.push('|---|---|--:|--:|--:|---|');
  for (const c of r.coverage) L.push(`| ${c.key} | ${cell(c.town)} | ${c.open} | ${c.inRadius} | ${c.deck} | ${cell(c.boardsNeeded)} |`);
  L.push('');

  L.push('## The bids');
  L.push('');
  L.push(`${r.bids.total} captured bids, ${r.bids.open} open at the capture time.`);
  L.push('');
  L.push('| Source | Captured | Open |');
  L.push('|---|--:|--:|');
  for (const [s, v] of Object.entries(r.bids.bySource)) L.push(`| ${s} | ${v.total} | ${v.open} |`);
  L.push('');
  L.push(`Held out of scan 1 and brought in by scan 2: ${r.bids.heldOut.map((h) => `${h.id} “${h.title.slice(0, 60)}”`).join('; ')}.`);
  L.push('');

  L.push('## Checks');
  L.push('');
  L.push('Asserted for every company on what the API answered: nothing beyond the radius in the deck, the next pick or an alert; nothing over a spend limit there (flag and recomputed rule); a job reserved for a certification the company lacks is never shown in the deck or alerted, and a certified company is not blocked from its own program; plumbing/HVAC companies never get an electrical-only job as a good or great fit, and the reverse; every alert states one of the bid\'s reasons; the identical repeat scan creates no alert; every alert scan 2 stored (read from the inbox, not from the bus) reaches the open stream, and every held-out bid alerts someone; filters return only what they ask for; the next pick is in the deck and no deck bid outranks it (score plus deadline urgency, recomputed); the free plan sees no premium figure (402 on the cost engine, locked market answers); every Pro estimate is a price or a list of what is needed, never a silent zero.');
  L.push('');
  L.push('What each check actually evaluated (companies with at least one item / items). A check with 0 items passed only because there was nothing to look at:');
  L.push('');
  L.push('| Check | Companies | Items |');
  L.push('|---|--:|--:|');
  for (const [k, c] of Object.entries(r.checks.coverage)) if (k !== 'determinism') L.push(`| ${k}${c.items === 0 ? ' (not exercised)' : ''} | ${c.companies} | ${c.items} |`);
  L.push('');
  if (r.checks.violations.length) {
    L.push('| Check | Company | Detail |');
    L.push('|---|---|---|');
    for (const v of r.checks.violations.slice(0, 200)) L.push(`| ${v.check} | ${v.persona} | ${cell(v.detail)} |`);
  } else L.push('No violations.');
  L.push('');

  if (extra.mutations) {
    L.push('## Proving the checks can fail');
    L.push('');
    L.push('Each run below breaks ONE rule through a seam and must be caught by the named check.');
    L.push('');
    L.push('| Mutation | How the rule was broken | Expected check | Caught | Violations | Example |');
    L.push('|---|---|---|---|--:|---|');
    for (const x of extra.mutations) L.push(`| ${x.mutation}${x.selfTest ? ' (checker self-test: answer rewritten)' : ''} | ${cell(x.how)} | ${x.expects} | ${x.caught ? 'yes' : 'NO'} | ${x.violations} | ${cell(x.example.slice(0, 160))} |`);
    L.push('');
  }

  L.push('## Measurements (this machine, this run)');
  L.push('');
  L.push(`Machine: ${m.machine.cpuModel}, ${m.machine.cpus} CPUs, ${m.machine.platform}, Node ${m.machine.node}. In-memory embedded Postgres (PGlite), server and simulated clients in one process over local HTTP. These are measurements of this machine, not promises for production.`);
  L.push('');
  L.push('| Scan | ms | Bids | New |');
  L.push('|---|--:|--:|--:|');
  for (const s of m.scans) L.push(`| ${s.name} | ${s.ms} | ${s.totalBids} | ${s.newBids} |`);
  L.push('');
  L.push(`Live reaction (scan 2), ${m.latencySummary.alerts} alerts. Time from the scan's source returning the bid to the alert being stored: p50 ${m.latencySummary.storedMs.p50} ms, p95 ${m.latencySummary.storedMs.p95} ms, max ${m.latencySummary.storedMs.max} ms. To the open stream delivering it: ${m.latencySummary.streamMs ? `p50 ${m.latencySummary.streamMs.p50} ms, p95 ${m.latencySummary.streamMs.p95} ms, max ${m.latencySummary.streamMs.max} ms` : 'none delivered'}. The scan ended (its 'scan' event) ${m.latencySummary.seenToScanEndMs ?? '—'} ms after it saw the bids; the streams heard that end after ${m.latencySummary.seenToScanFrameMs ? `p50 ${m.latencySummary.seenToScanFrameMs.p50} ms` : '—'}.`);
  L.push('');
  L.push('How to read this: these times run from the moment the scan reads the bid from its board. A bid posted on a board is only read at the next scheduled scan (once a day by default, SCAN_DAILY_AT), so the delay from a bid being posted to the alert is up to a day plus these times. An alert is stored when the scan reaches that company (it stores every bid, then scores companies one after another), so "stored" grows with the number of companies scored before it.');
  const gaps = m.latency.flatMap((l) => (l.seenToStreamMs === null ? [] : [l.seenToStreamMs - l.seenToStoredMs])).sort((a, b) => a - b);
  if (gaps.length) {
    const med = gaps[Math.floor((gaps.length - 1) / 2)]!;
    L.push('');
    L.push(`From stored to delivered on the open stream: median ${Math.round(med * 100) / 100} ms, max ${Math.round(gaps.at(-1)! * 100) / 100} ms in this run. The scan yields to the event loop once after each alert it publishes (src/scan.ts); without that yield every stream frame waited for the end of the scan, because the embedded database and the scan share the server thread. A separate database server (pg) was not measured.`);
  }
  L.push('');
  if (m.latency.length) {
    L.push('| Company | Bid | Seen → stored (ms) | Seen → stream (ms) |');
    L.push('|---|---|--:|--:|');
    for (const l of m.latency) L.push(`| ${l.persona} | ${l.bidId} | ${l.seenToStoredMs} | ${l.seenToStreamMs ?? '—'} |`);
    L.push('');
  }
  L.push(`Scoring speed (pure, no database): ${m.scoring.pairs.toLocaleString('en-US')} profile-bid pairs in ${m.scoring.ms} ms = ${m.scoring.pairsPerSecond.toLocaleString('en-US')} pairs/s.`);
  L.push('');
  if (m.scale) {
    const s = m.scale;
    L.push(`Scale pass: ${s.profiles.toLocaleString('en-US')} generated profile variations (simulated) × ${s.bids} open bids = ${s.pairs.toLocaleString('en-US')} pairs.`);
    L.push(`- Pure scoring: ${s.pure.ms} ms (${s.pure.pairsPerSecond.toLocaleString('en-US')} pairs/s), heap +${s.pure.heapDeltaMb} MB holding the scores.`);
    if (s.db) {
      L.push(`- Through the database (runScan: store every bid, score and store every match): ${s.db.ms.toLocaleString('en-US')} ms for ${s.db.matchesStored.toLocaleString('en-US')} matches = ${Math.round(s.db.matchesStored / (s.db.ms / 1000)).toLocaleString('en-US')} matches/s; process RSS ${s.db.rssBeforeMb} MB before, peak ${s.db.peakRssMb} MB.`);
      L.push(`- Arithmetic only, not a forecast: at that rate one daily scan for ${s.profiles.toLocaleString('en-US')} companies takes ${(s.db.ms / 1000).toFixed(1)} s; ${s.pure.ms} ms of it is scoring, the rest is storing.`);
    }
    L.push('');
  }
  L.push('| Request | n | p50 ms | p95 ms | max ms |');
  L.push('|---|--:|--:|--:|--:|');
  for (const [k, d] of Object.entries(m.requests)) L.push(`| ${k} | ${d.n} | ${d.p50} | ${d.p95} | ${d.max} |`);
  L.push('');
  L.push(`Whole run: ${(m.totalMs / 1000).toFixed(1)} s.`);
  L.push('');
  return L.join('\n');
}
