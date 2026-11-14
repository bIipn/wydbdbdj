/**
 * Manual scan:  npm run scan            (scan + digest)
 *               npm run scan -- --no-notify --source=ngem,questcdn
 *               npm run scan -- --fixtures   (offline: load the pages captured in test/fixtures)
 *               npm run scan -- --no-notify --group=east            (one scan group, with its time budget)
 *               npm run scan -- --no-notify --group=opengov-1 --source=opengov   (one source's slice)
 *
 * --source alone runs those sources whole (no slice, no time budget); --group runs that group the way the
 * cron call does (src/sources/groups.ts). Both together: the group's sources cut down to the list.
 *
 * With the embedded database, stop the server first (only one process can open it),
 * or call POST /api/admin/scan on the running server instead.
 */
import { buildDeps, scanProfiles } from '../app.js';
import { env, loadEnv } from '../env.js';
import { getFeed } from '../db/repo.js';
import { sendDigest } from '../notify/send.js';
import { runScan } from '../scan.js';
import { fixtureSources } from '../sources/fixtures.js';
import { FETCH_BUDGET_MS, scanSources } from '../sources/groups.js';

loadEnv();
const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k!, v ?? 'true'] as const;
  }),
);

const deps = await buildDeps().catch((err: Error) => {
  if (/lock|already in use|EBUSY/i.test(err.message)) {
    console.error('The database is open in another process (is the server running?). Use POST /api/admin/scan instead.');
  }
  throw err;
});

try {
  const group = args.get('group');
  const sources = args.has('fixtures')
    ? fixtureSources()
    : group || args.has('source') ? scanSources({ group, list: args.get('source') }) : deps.sources;
  const report = await runScan({
    db: deps.db, sources, profiles: scanProfiles(deps), ctx: deps.makeCtx(),
    ...(group ? { group, budgetMs: FETCH_BUDGET_MS } : {}),
  });

  console.log('\nSources');
  for (const [id, r] of Object.entries(report.sources)) {
    const status = r.skipped ? `skipped — ${r.skipped}` : r.ok ? `${r.fetched} bids in ${r.ms} ms${r.stopped ? ` (${r.stopped})` : ''}` : `FAILED — ${r.error}`;
    console.log(`  ${id.padEnd(14)} ${status}`);
  }
  console.log(`\n${report.totalBids} open bids (${report.newBids} new).`);
  for (const [id, p] of Object.entries(report.profiles)) {
    const name = id === deps.profile?.id ? deps.profile.name : id;
    console.log(p.error
      ? `${name}: FAILED — ${p.error}`
      : `${name}: great ${p.byVerdict.great} · good ${p.byVerdict.good} · maybe ${p.byVerdict.maybe} · skip ${p.byVerdict.skip}`);
  }

  // Top matches and the emailed digest are the pilot's (single mode); accounts read theirs in the app.
  if (deps.profile) {
    const top = await getFeed(deps.db, deps.profile.id, { minScore: 35, limit: 10 });
    if (top.length) {
      console.log('\nTop matches');
      for (const b of top) {
        console.log(`  ${String(b.score).padStart(3)}  ${b.title.slice(0, 64).padEnd(64)}  ${b.distanceMi ?? '?'} mi`);
      }
    }

    if (!args.has('no-notify')) {
      await sendDigest(deps.db, deps.profile, {
        resendApiKey: env('RESEND_API_KEY'), from: env('DIGEST_FROM'),
        to: (env('DIGEST_TO') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        appUrl: deps.config.appUrl,
      });
    }
  }
  if (args.has('json')) console.log(JSON.stringify(report, null, 2));
} finally {
  await deps.db.close();
}
