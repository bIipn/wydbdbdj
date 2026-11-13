/**
 * Refresh market data into the local database and print what was stored:
 *
 *   npm run market:refresh -- --states=NV,CA --months=24
 *   npm run market:refresh -- --states=NV --months=4 --naics=238210 --details=25
 *   npm run market:refresh -- --skip-awards            (BLS wages + price indexes only)
 *   npm run market:refresh -- --states=NV,CA --skip-bls
 *
 *   --states   2-letter codes, comma separated ("US" = nationwide). Needed unless --skip-awards.
 *   --months   how far back to pull awards signed (default 4; use 24 for a first load)
 *   --naics    NAICS codes (default 238210,238220,236220)
 *   --details  look up solicitation id + offers received for this many of the newest awards (default 0)
 *   --bls-max-queries  stop after this many BLS queries (no key = 25 a day in total)
 *   --json     also print the full report
 *
 * BLS_API_KEY (optional) raises the BLS allowance. With the embedded database, stop the server
 * first (one process at a time) or use POST /api/admin/market/refresh on the running server.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type Db } from '../db/db.js';
import { awardCounts, listAwards, seriesCounts } from '../db/market.js';
import { env, loadEnv } from '../env.js';
import { isStateCode, NATION_AREA, stateArea } from '../market/areas.js';
import { ELECTRICIANS, materialTrends, metroWagesInState, wageForArea, type AreaWage, type TrendChange } from '../market/bls.js';
import { createMarketHttp, DEFAULT_AWARD_NAICS, DEFAULT_REFRESH_MONTHS, refreshMarket, type MarketHttp, type MarketRefreshReport } from '../market/refresh.js';
import { hasPriceAtAward, MIN_PRICED_AWARDS, priceStats } from '../market/stats.js';
import { awardWindow, NATIONWIDE } from '../market/usaspending.js';

export interface MarketCliArgs {
  states: string[];
  months: number;
  naics: string[];
  awards: boolean;
  bls: boolean;
  details: number;
  blsMaxQueries?: number;
  userAgent?: string;
  json: boolean;
}

/** Parse the command line. Throws with a plain message on anything it does not understand. */
export function parseArgs(argv: readonly string[]): MarketCliArgs {
  const known = new Set(['states', 'months', 'naics', 'skip-awards', 'skip-bls', 'details', 'bls-max-queries', 'user-agent', 'json']);
  const args = new Map<string, string>();
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m || !known.has(m[1]!)) throw new Error(`Unknown option "${a}". Options: ${[...known].map((k) => `--${k}`).join(' ')}`);
    args.set(m[1]!, m[2] ?? 'true');
  }
  const list = (key: string): string[] => (args.get(key) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const whole = (key: string, fallback: number, min: number, max: number): number => {
    if (!args.has(key)) return fallback;
    const raw = args.get(key)!;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < min || n > max) throw new Error(`--${key} must be a whole number from ${min} to ${max}`);
    return n;
  };

  const awards = !args.has('skip-awards');
  const bls = !args.has('skip-bls');
  if (!awards && !bls) throw new Error('Nothing to do: both --skip-awards and --skip-bls were given');
  const states = [...new Set(list('states').map((s) => s.toUpperCase()))];
  for (const s of states) if (s !== NATIONWIDE && !isStateCode(s)) throw new Error(`--states: "${s}" is not a 2-letter state code (or ${NATIONWIDE})`);
  if (awards && states.length === 0) throw new Error('--states is required, e.g. --states=NV,CA (or pass --skip-awards)');
  const naics = list('naics');
  for (const c of naics) if (!/^\d{6}$/.test(c)) throw new Error(`--naics: "${c}" is not a 6-digit NAICS code`);

  return {
    states,
    months: whole('months', DEFAULT_REFRESH_MONTHS, 1, 120),
    naics: naics.length ? naics : [...DEFAULT_AWARD_NAICS],
    awards,
    bls,
    details: whole('details', 0, 0, 200),
    blsMaxQueries: args.has('bls-max-queries') ? whole('bls-max-queries', 0, 1, 500) : undefined,
    userAgent: args.get('user-agent'),
    json: args.has('json'),
  };
}

const money = (v: number): string => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (c: TrendChange | null): string => (c ? `${c.pct > 0 ? '+' : ''}${c.pct.toFixed(1)}% (from ${c.from.periodLabel})` : 'n/a');
const dollars = (v: number | null): string => (v === null ? 'n/a' : `$${v.toFixed(2)}`);
const wageLine = (w: AreaWage): string =>
  `  ${w.areaName.padEnd(42)} mean ${dollars(w.mean)} · median ${dollars(w.median)} · p25 ${dollars(w.p25)} · p75 ${dollars(w.p75)}   [${w.level}, ${w.periodLabel}]`;

/** Everything a refresh stored, as text: counts, price-at-award ranges, wages, index trends. */
export async function describeStored(db: Db, args: Pick<MarketCliArgs, 'states' | 'months' | 'naics'>, now: Date): Promise<string[]> {
  const out: string[] = [];
  const counts = await awardCounts(db);
  out.push('', 'Stored federal awards by state and NAICS (source: USAspending.gov, place of performance)');
  if (counts.length === 0) out.push('  none');
  for (const c of counts) {
    out.push(`  ${(c.state ?? '??').padEnd(3)} ${c.naics ?? '??????'}  ${String(c.awards).padStart(5)} awards, ${String(c.priced).padStart(5)} with a price at award   signed ${c.oldest ?? '?'} to ${c.newest ?? '?'}`);
  }

  const window = awardWindow(now, args.months);
  out.push('', `Price at award (Mod 0 amount), awards signed ${window.startDate} to ${window.endDate}. A range needs ${MIN_PRICED_AWARDS} priced awards.`);
  const states = args.states.filter((s) => s !== NATIONWIDE);
  for (const state of states.length ? states : [...new Set(counts.flatMap((c) => c.state ?? []))]) {
    for (const naics of args.naics) {
      const rows = await listAwards(db, { naics: [naics], since: window.startDate, states: [state] });
      const priced = rows.filter(hasPriceAtAward);
      const s = priced.length >= MIN_PRICED_AWARDS ? priceStats(priced.map((a) => a.priceAtAward!)) : null;
      out.push(s
        ? `  ${state} ${naics}  n=${s.count}  min ${money(s.min)} · p25 ${money(s.p25)} · median ${money(s.median)} · p75 ${money(s.p75)} · max ${money(s.max)}   (${rows.length - priced.length} without a price left out)`
        : `  ${state} ${naics}  n=${priced.length}: not enough to show a range   (${rows.length - priced.length} without a price left out)`);
    }
  }

  out.push('', 'Stored BLS series');
  const series = await seriesCounts(db);
  if (series.length === 0) out.push('  none');
  for (const s of series) out.push(`  ${s.kind.padEnd(5)} ${s.series} series (${s.withData} with data), ${s.observations} observations`);

  out.push('', 'Electricians (SOC 47-2111), hourly wage (source: BLS OEWS)');
  const wageAreas = [NATION_AREA, ...states.flatMap((s) => stateArea(s) ?? [])];
  let wages = 0;
  for (const area of wageAreas) {
    const w = await wageForArea(db, area, ELECTRICIANS);
    if (w) out.push(wageLine(w));
    wages += w ? 1 : 0;
    if (area.state) for (const metro of await metroWagesInState(db, area.state, ELECTRICIANS)) out.push(wageLine(metro));
  }
  if (wages === 0) out.push('  none stored');

  out.push('', 'Material price indexes (source: BLS PPI; national indexes, not dollar prices)');
  const trends = await materialTrends(db);
  if (trends.length === 0) out.push('  none stored');
  for (const t of trends) {
    out.push(t.latest
      ? `  ${t.label.padEnd(62)} ${String(t.latest.value).padStart(8)}  ${t.latest.periodLabel}${t.latest.preliminary ? ' (preliminary)' : ''}   1 mo ${pct(t.change1m)} · 3 mo ${pct(t.change3m)} · 12 mo ${pct(t.change12m)}`
      : `  ${t.label.padEnd(62)} ${t.note}`);
  }
  return out;
}

function describeRun(report: MarketRefreshReport): string[] {
  const out: string[] = [];
  const a = report.awards;
  if (a) {
    out.push('', `Federal awards pulled (signed ${a.startDate} to ${a.endDate}; NAICS ${a.naics.join(', ')}; ${a.requests} requests)`);
    for (const s of a.scopes) {
      const lookups = s.priceLookups.asked ? ` (${s.priceLookups.filled} of ${s.priceLookups.asked} looked up one by one)` : '';
      out.push(`  ${s.scope.padEnd(3)} ${s.ok ? 'ok    ' : 'FAILED'} count endpoint ${s.expected ?? '?'} · fetched ${s.fetched} in ${s.awardPages} page(s) · ${s.transactionRows} transactions in ${s.transactionPages} page(s) · price at award for ${s.withPriceAtAward}${lookups}, none for ${s.withoutPriceAtAward} · new ${s.inserted}, updated ${s.updated}${s.error ? ` · ${s.error}` : ''}`);
    }
    if (a.details.asked) out.push(`  detail lookups: ${a.details.filled} filled, ${a.details.failed} failed`);
  }
  const b = report.bls;
  if (b) {
    out.push('', `BLS pulled (${b.startYear}–${b.endYear}): ${b.queries} queries · ${b.seriesAsked} series asked (${b.skippedFresh} wage series still fresh, left alone) · ${b.seriesStored} stored · ${b.observationsStored} observations`);
    for (const f of b.failed) out.push(`  no data: ${f.seriesId} — ${f.message}`);
    if (b.notFetched.length) out.push(`  not fetched: ${b.notFetched.length} series (the next refresh picks them up)`);
    for (const m of b.otherMessages) out.push(`  BLS says: ${m}`);
  }
  for (const e of report.errors) out.push(`  ERROR ${e}`);
  return out;
}

/** Stand-ins for the real database and HTTP clients (tests). The command itself passes none. */
export interface MarketCliDeps {
  db?: Db;
  http?: MarketHttp;
  now?: Date;
}

/** Run the command. Returns the exit code: 0 ok, 1 something failed (the printout says what), 2 bad arguments. */
export async function main(argv: readonly string[] = process.argv.slice(2), deps: MarketCliDeps = {}): Promise<number> {
  let args: MarketCliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  loadEnv();

  const db = deps.db ?? await openDb({ url: env('DATABASE_URL'), sslNoVerify: env('PG_SSL_NO_VERIFY') === '1' }).catch((err: Error) => {
    if (/lock|already in use|EBUSY/i.test(err.message)) {
      console.error('The database is open in another process (is the server running?). Use POST /api/admin/market/refresh instead.');
    }
    throw err;
  });
  try {
    const contact = env('CONTACT_EMAIL');
    const http = deps.http ?? createMarketHttp(args.userAgent ?? `BidSwipe/1.0 (market data refresh${contact ? `; contact ${contact}` : ''})`);
    const now = deps.now ?? new Date();
    const report = await refreshMarket(db, http, {
      states: args.states, months: args.months, naics: args.naics, awards: args.awards, bls: args.bls, details: args.details,
      blsApiKey: env('BLS_API_KEY'), blsMaxQueries: args.blsMaxQueries, now, log: (m) => console.log(m),
    });
    for (const line of [...describeRun(report), ...(await describeStored(db, args, now))]) console.log(line);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  } finally {
    if (!deps.db) await db.close();
  }
}

// Run only as a script (npm run market:refresh), never on import.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err);
    process.exit(1);
  });
}
