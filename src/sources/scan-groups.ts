/*
 * The scan groups' table, with no imports, so a source file can name its group (DEFAULT_GROUP …) without an
 * import cycle (src/sources/groups.ts, which picks a group's sources, imports ALL_SOURCES).
 */

/**
 * Scan groups: the serverless host gives one function call at most 300 seconds, and every request to one host
 * waits 1,000 ms after the last (util/http.ts), so all boards cannot be read in one call. Each group is read by
 * its own cron call, GET /api/cron/scan?group=<name> (vercel.json; test/source-seams.test.ts keeps the two
 * equal). A group's sources run one after another (runScan), so a group's time is the SUM of its sources'
 * requests, whatever their hosts. Sized so the fetching ends well inside FETCH_BUDGET_MS, which leaves the rest
 * of the 300 s for storing and scoring.
 *
 * Request counts behind the split (first responses of 2026-11-14; ~1–1.5 s per request with the pacing):
 *   default   today's sources: SAM.gov bulk file (one ~222 MB download, 8.2 s live), NevadaEPro 1 page,
 *             NGEM ~3, QuestCDN 1 per board, Douglas County 1
 *   west      caleprocure 1 GET (1.18 MB) · caltrans 1–2 · laramp, sfbids a page or two (Socrata) ·
 *             oregonbuys 7 pages (174 bids / 25) · usac470 a few 1,000-row pages          ≈ 15–25 requests
 *   east      commbuys 36 pages (890 / 25) · bidbuy 6 (149) · njstart 1 (19) · nycrecord a page or two
 *                                                                                           ≈ 45 requests
 *   south     txesbd 21 POSTs (501 / 24) · flmfmp a few 100-row pages                       ≈ 25 requests
 *   opengov-N one POST per government (more for one with over 100 open projects): 562 active governments on
 *             api.procurement.opengov.com, sliced by state below to ≤ ~128 each              ≈ 110–130 requests
 *
 * The time budget is the backstop, not the plan: a paging source checks ctx.deadline between requests and stops
 * with "<id>: stopped at the time budget, N of M read" (src/sources/budget.ts).
 */

/** How long a group's sources may fetch, all together. runScan shares it out (see runScan's budgetMs). */
export const FETCH_BUDGET_MS = 200_000;

export const DEFAULT_GROUP = 'default';

export interface ScanGroup {
  name: string;
  /** vercel.json schedule, UTC. The default group keeps the original path (no ?group=) and runs last, at 14:08. */
  cron: string;
  about: string;
}

/**
 * Spaced six minutes apart so one call ends before the next starts (each may run up to 300 s). Note: on the
 * Hobby plan Vercel fires a daily cron at some point within its hour, not at the minute, so groups can overlap
 * there; two scans at once are safe (every write is an upsert, alerts are unique per key), only slower.
 */
export const SCAN_GROUPS: readonly ScanGroup[] = [
  { name: 'west', cron: '20 13 * * *', about: 'California and Oregon state and city boards, USAC E-Rate' },
  { name: 'east', cron: '26 13 * * *', about: 'Massachusetts, Illinois, New Jersey state boards, NYC City Record' },
  { name: 'south', cron: '32 13 * * *', about: 'Texas ESBD and MyFloridaMarketPlace' },
  { name: 'opengov-1', cron: '38 13 * * *', about: 'OpenGov portals: California (128 governments)' },
  { name: 'opengov-2', cron: '44 13 * * *', about: 'OpenGov portals: Florida, New Jersey (117)' },
  { name: 'opengov-3', cron: '50 13 * * *', about: 'OpenGov portals: Arizona, Texas, New Mexico, Oklahoma, Louisiana, Arkansas (112)' },
  { name: 'opengov-4', cron: '56 13 * * *', about: 'OpenGov portals: the East Coast and the South-East (124)' },
  { name: 'opengov-5', cron: '2 14 * * *', about: 'OpenGov portals: every other state, and governments with none (81)' },
  // LAST, as scanEveryGroup (src/server.ts) runs it: the pilot's digest and the day's re-score of every open bid
  // (src/scan.ts) then include what the other groups found that morning.
  { name: DEFAULT_GROUP, cron: '8 14 * * *', about: 'SAM.gov and the Nevada boards (the original daily scan)' },
];

/** The cron path of a group: the default group keeps the original path. */
export const cronPath = (g: Pick<ScanGroup, 'name'>): string =>
  g.name === DEFAULT_GROUP ? '/api/cron/scan' : `/api/cron/scan?group=${encodeURIComponent(g.name)}`;

export function getGroup(name: string | null | undefined): ScanGroup | null {
  const want = (name ?? '').trim().toLowerCase();
  return SCAN_GROUPS.find((g) => g.name === want) ?? null;
}

