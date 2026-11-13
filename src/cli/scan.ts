/**
 * Manual scan:  npm run scan            (scan + digest)
 *               npm run scan -- --no-notify --source=ngem,questcdn
 *               npm run scan -- --fixtures   (offline: load the pages captured in test/fixtures)
 *
 * With the embedded database, stop the server first (only one process can open it),
 * or call POST /api/admin/scan on the running server instead.
 */
import { buildDeps } from '../app.js';
import { env, loadEnv } from '../env.js';
import { getFeed } from '../db/repo.js';
import { sendDigest } from '../notify/send.js';
import { runScan } from '../scan.js';
import { fixtureSources } from '../sources/fixtures.js';
import { selectSources } from '../sources/index.js';

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
  const sources = args.has('fixtures') ? fixtureSources() : args.has('source') ? selectSources(args.get('source')) : deps.sources;
  const report = await runScan({ db: deps.db, sources, profiles: [deps.profile], ctx: deps.makeCtx() });

  console.log('\nSources');
  for (const [id, r] of Object.entries(report.sources)) {
    const status = r.skipped ? `skipped — ${r.skipped}` : r.ok ? `${r.fetched} bids in ${r.ms} ms` : `FAILED — ${r.error}`;
    console.log(`  ${id.padEnd(14)} ${status}`);
  }
  const p = report.profiles[deps.profile.id];
  console.log(`\n${report.totalBids} open bids (${report.newBids} new).`);
  if (p) console.log(`${deps.profile.name}: great ${p.byVerdict.great} · good ${p.byVerdict.good} · maybe ${p.byVerdict.maybe} · skip ${p.byVerdict.skip}`);

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
      appUrl: env('APP_URL') ?? 'http://localhost:8787',
    });
  }
  if (args.has('json')) console.log(JSON.stringify(report, null, 2));
} finally {
  await deps.db.close();
}
