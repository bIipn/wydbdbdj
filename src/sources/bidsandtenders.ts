import * as cheerio from 'cheerio';
import type { BidDraft, FetchLike, Source, SourceContext } from '../types.js';
import { outOfTime, stopAtBudget } from './budget.js';
import { isTradeWork } from './relevance.js';
import { detectFlags } from '../util/flags.js';
import { findEstimate } from '../util/money.js';
import { clean, cleanOrNull, htmlToText, truncate } from '../util/text.js';
import { PACIFIC, zonedToUtc } from '../util/time.js';

/**
 * bids&tenders (eSolutions Group), the bid platform some counties and cities use: one host per agency,
 * `<agency>.bidsandtenders.net`. Today ONE agency, Placer County, CA; adding one is one entry in
 * BIDSANDTENDERS_AGENCIES (check its robots.txt and capture its list page first).
 *
 * THE FLOW is the list page's own (its script, /Module/Tenders/Resources/scriptsV2/home/index.js, read 2026-11-14):
 *   1. GET /Module/Tenders/en through ONE ctx.http.session(): the page has no rows (a Fuel UX "repeater" loads them),
 *      but it carries the hidden inputs #Home ("/Module/Tenders/en"), #NodeId (the agency's GUID) and, inside
 *      #bidDetailAntiForgery, the __RequestVerificationToken the list call sends; the answer also sets the matching
 *      anti-forgery cookie. Both are read from the page every run, never stored.
 *   2. POST {Home}/Tender/Search/{NodeId}?status=Open&limit=100&start=0&dir=ASC&from=&to=&sort=DateClosing ASC,Id
 *      with the form fields keywords (empty) and __RequestVerificationToken, X-Requested-With: XMLHttpRequest and
 *      the list page as Referer. The answer is { success, data: [...], total }. More pages (start += rows) while
 *      start + rows < total, with the same token, as the page's own pager does.
 * A POST is never re-sent (util/http.ts gives a POST one attempt): the first one failing makes the source FAIL;
 * a later one failing keeps the pages read and says "— stopped: <reason>".
 *
 * TIMES (worked out on the 15 rows of the real all-statuses answer, 2026-11-14): DateClosing is "/Date(ms)/", and
 * ms is NEITHER the true instant NOR the wall clock written as UTC. It is the agency's wall clock read as if it were
 * the platform server's own clock, US Eastern: "Tue Nov 3, 2026 11:00 AM (PST)" comes with 1793721600000 =
 * 16:00Z = 11:00 EST; "Tue Oct 20, 2026 11:00 AM (PDT)" with 15:00Z = 11:00 EDT. Read as UTC the closing would be
 * 3 hours early. So the closing instant is read from DateClosingDisplay in the agency's zone (util/time.ts
 * zonedToUtc), checked against TimeZoneLabel ("(PST)"/"(PDT)"); /Date(ms)/ is only a fallback, its Eastern wall
 * clock re-read in the agency's zone (test/source-bidsandtenders.test.ts proves both on the real rows).
 *
 * PLACE: the agency is a county. The draft says county + state, and the town when the title or description names
 * exactly one of the agency's towns (townInText: "Roseville, CA 95678"; never a street such as "Lincoln Way");
 * locate() (src/geo/locate.ts) places a named town at the ZIP table's point, else makes the card the one-county AREA
 * "Placer County, CA (site not named)" with no point. Not a statewide board (src/sources/statewide.ts).
 * CARD: https://<host>/Module/Tenders/en/Tender/Detail/<Id> (allowed by robots.txt; never fetched).
 * robots.txt (placer.bidsandtenders.net, 2026-11-14): `User-agent: *`, no crawl-delay; disallows /Module/Tenders/API/,
 * Login, Vendor, Submission, Document, Tender/Download and the like, nothing on the list page, Tender/Search or
 * Tender/Detail.
 */

export interface BidsAndTendersAgency {
  /** Short key, the first part of every sourceId ("placer:<Id>"). */
  key: string;
  host: string;
  /** As the card names the agency. */
  name: string;
  state: string;
  /** The county the agency is (or works in), as src/geo/california.ts names it. */
  county: string;
  /** The IANA zone of its wall-clock times. */
  timeZone: string;
  /**
   * Towns and communities of that county, as the nationwide ZIP table (src/geo/zip.ts) names them: one of them named
   * in the listing places the card there (city precision, the table's point). No coordinates are typed here.
   */
  towns: readonly string[];
}

// FIRST LOAD is judged per source and state (src/scan.ts), not per agency: the first scan after an agency is added to a
// state that already has a stored bidsandtenders bid must run quietly (--quiet / ?quiet=1), or its backlog alerts.
export const BIDSANDTENDERS_AGENCIES: readonly BidsAndTendersAgency[] = [
  {
    key: 'placer', host: 'placer.bidsandtenders.net', name: 'Placer County', state: 'CA', county: 'Placer', timeZone: PACIFIC,
    // Placer County's six cities and towns (Auburn the seat), then its named communities on the ZIP table.
    towns: [
      'Auburn', 'Colfax', 'Lincoln', 'Loomis', 'Rocklin', 'Roseville',
      'Alta', 'Applegate', 'Carnelian Bay', 'Dutch Flat', 'Foresthill', 'Granite Bay', 'Homewood', 'Kings Beach',
      'Meadow Vista', 'Newcastle', 'Olympic Valley', 'Penryn', 'Sheridan', 'Tahoe City', 'Tahoe Vista',
    ],
  },
];

/** The platform server's clock, the zone a /Date(ms)/ was written in (see TIMES above). */
export const PLATFORM_CLOCK = 'America/Toronto';
/** Rows asked for per POST: the page's own largest page size. */
export const BIDSANDTENDERS_PAGE_SIZE = 100;
/** A backstop on paging; the time budget (ctx.deadline) is the real limit. */
export const BIDSANDTENDERS_MAX_PAGES = 20;

const ID = 'bidsandtenders';

export const listUrl = (a: Pick<BidsAndTendersAgency, 'host'>): string => `https://${a.host}/Module/Tenders/en`;
export const detailUrl = (a: Pick<BidsAndTendersAgency, 'host'>, id: string): string =>
  `https://${a.host}/Module/Tenders/en/Tender/Detail/${encodeURIComponent(id)}`;

/** The search call, exactly as the page builds it (status Open, closing soonest first). */
export function searchUrl(a: Pick<BidsAndTendersAgency, 'host'>, page: ListPage, start: number): string {
  return `https://${a.host}${page.home}/Tender/Search/${encodeURIComponent(page.nodeId)}`
    + `?status=Open&limit=${BIDSANDTENDERS_PAGE_SIZE}&start=${start}&dir=ASC&from=&to=&sort=DateClosing%20ASC,Id`;
}

export function searchBody(page: ListPage): string {
  return new URLSearchParams({ keywords: '', __RequestVerificationToken: page.token }).toString();
}

// ------------------------------------------------------------------ list page --

export interface ListPage {
  home: string;
  nodeId: string;
  token: string;
}

/**
 * The list page → what the search call needs. Pure. Throws when the page is not the list page (a challenge or a
 * sign-in page has no #NodeId or no token): nothing may be POSTed then.
 */
export function parseListPage(html: string): ListPage {
  const $ = cheerio.load(html);
  const home = clean($('#Home').attr('value'));
  const nodeId = clean($('#NodeId').attr('value'));
  // The script reads the first input inside #bidDetailAntiForgery (not the logout form's token).
  const token = clean($('#bidDetailAntiForgery input[name="__RequestVerificationToken"]').first().attr('value'));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nodeId)) {
    throw new Error('bidsandtenders: the list page has no #NodeId (not the list page: a challenge or a sign-in page?)');
  }
  if (!token) throw new Error('bidsandtenders: the list page has no __RequestVerificationToken in #bidDetailAntiForgery');
  if (!/^\/[\w/-]+$/.test(home)) throw new Error('bidsandtenders: the list page has no #Home path');
  return { home, nodeId, token };
}

// ------------------------------------------------------------------ the answer --

export interface BidsAndTendersRaw {
  Id?: string;
  Title?: string;
  Scope?: string | null;
  Status?: string;
  Description?: string | null;
  DateAvailable?: string | null;
  DateAvailableDisplay?: string | null;
  DateClosing?: string | null;
  DateClosingDisplay?: string | null;
  TimeZoneLabel?: string | null;
}

export interface BidsAndTendersRow {
  id: string;
  status: string;
  title: string;
  /** Description (and Scope, when it holds more than the one-word visibility "Public"), HTML stripped. */
  description: string;
  /** ISO UTC, or null when the board's closing could not be read with certainty. */
  closesAt: string | null;
  postedAt: string | null;
  /** The /Date(ms)/ read as the platform clock disagreed with the display string (see TIMES). */
  clockMismatch: boolean;
}

export interface BidsAndTendersAnswer {
  rows: BidsAndTendersRow[];
  total: number;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number }

/** "Tue Nov 3, 2026 11:00 AM" (seconds when the agency shows them) → its wall-clock parts. */
export function displayWall(display: string | null | undefined): Wall | null {
  const m = /^(?:[A-Za-z]{3},?\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP])\.?M\.?$/i
    .exec(clean(display));
  if (!m) return null;
  const mo = MONTHS[m[1]!.toLowerCase()];
  const h12 = Number(m[4]);
  if (!mo || h12 < 1 || h12 > 12) return null;
  const pm = m[7]!.toUpperCase() === 'P';
  return { y: Number(m[3]), mo, d: Number(m[2]), h: (h12 % 12) + (pm ? 12 : 0), mi: Number(m[5]), s: Number(m[6] ?? 0) };
}

/** "/Date(1793721600000)/" → its milliseconds, or null. */
export function dateMs(raw: string | null | undefined): number | null {
  const m = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(clean(raw));
  return m ? Number(m[1]) : null;
}

/** The wall clock an instant shows in `timeZone`. */
function wallIn(ms: number, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: n('year'), mo: n('month'), d: n('day'), h: n('hour'), mi: n('minute'), s: n('second') };
}

const sameWall = (a: Wall, b: Wall) => a.y === b.y && a.mo === b.mo && a.d === b.d && a.h === b.h && a.mi === b.mi && a.s === b.s;
const wallToIso = (w: Wall, timeZone: string) => zonedToUtc(w.y, w.mo, w.d, w.h, w.mi, w.s, timeZone).toISOString();

/** "PST" / "PDT" as the agency's zone names itself at that instant. */
function zoneAbbr(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(new Date(iso))
    .find((p) => p.type === 'timeZoneName')?.value ?? '';
}

/**
 * One board time → ISO UTC. The display string in the agency's zone first (what a contractor reads on the page);
 * a TimeZoneLabel that names another offset ("(PST)" on a summer date) means the agency's zone is not what we think:
 * null, never a guess. With no display string, the /Date(ms)/ re-read as the platform clock (see TIMES).
 */
export function boardTime(
  display: string | null | undefined, raw: string | null | undefined, label: string | null | undefined, timeZone: string,
): { iso: string | null; mismatch: boolean } {
  const wall = displayWall(display);
  const ms = dateMs(raw);
  const fromMs = ms != null ? wallIn(ms, PLATFORM_CLOCK) : null;
  if (!wall) return { iso: fromMs ? wallToIso(fromMs, timeZone) : null, mismatch: false };
  const iso = wallToIso(wall, timeZone);
  const named = /\(?\s*([A-Z]{2,5})\s*\)?/.exec(clean(label))?.[1] ?? null;
  if (named && /^[A-Z]{3,4}$/.test(named) && zoneAbbr(iso, timeZone) !== named) return { iso: null, mismatch: false };
  return { iso, mismatch: fromMs ? !sameWall(fromMs, wall) : false };
}

/** Description HTML → card text: tags stripped, the bid-opening Teams block (links, passcodes, dial-in numbers) cut. */
export function descriptionText(html: string | null | undefined): string {
  const lines = htmlToText(html).split('\n');
  const cut = lines.findIndex((l) => /\bmicrosoft teams\b|teams\.microsoft\.com|^_{5,}$|^\*{5,}$/i.test(l));
  const kept = cut < 0 ? lines : lines.slice(0, cut);
  while (kept.length && /^(?:bid opening|public opening(?: meeting details)?)?[\s:–-]*$/i.test(kept.at(-1)!)) kept.pop();
  return clean(kept.join(' '));
}

/**
 * The Search answer → rows. Pure. Throws (the source FAILS) when `success` is not true, there is no data array, or
 * the board counts rows it did not send. The real empty answer {"success":true,"data":[],"total":0} is no rows.
 */
export function parseBidsAndTenders(json: unknown, agency: BidsAndTendersAgency): BidsAndTendersAnswer {
  const a = json as { success?: unknown; data?: unknown; total?: unknown } | null;
  if (!a || typeof a !== 'object') throw new Error('bidsandtenders: the search answer is not an object');
  if (a.success !== true) throw new Error(`bidsandtenders ${agency.name}: the search answered success=${JSON.stringify(a.success ?? null)}`);
  if (!Array.isArray(a.data)) throw new Error(`bidsandtenders ${agency.name}: the search answer has no data array`);
  const total = typeof a.total === 'number' && Number.isFinite(a.total) ? a.total : null;
  if (total == null) throw new Error(`bidsandtenders ${agency.name}: the search answer has no total`);
  if (total > 0 && a.data.length === 0) throw new Error(`bidsandtenders ${agency.name}: total ${total} but no rows`);
  const rows: BidsAndTendersRow[] = [];
  for (const r of a.data as BidsAndTendersRaw[]) {
    const id = clean(r?.Id);
    const title = clean(r?.Title);
    if (!id || !title) continue;
    const scope = clean(r.Scope);
    const description = [descriptionText(r.Description), /\s/.test(scope) ? descriptionText(scope) : ''].filter(Boolean).join(' ');
    const closes = boardTime(r.DateClosingDisplay, r.DateClosing, r.TimeZoneLabel, agency.timeZone);
    rows.push({
      id,
      status: clean(r.Status),
      title,
      description,
      closesAt: closes.iso,
      postedAt: boardTime(r.DateAvailableDisplay, r.DateAvailable, null, agency.timeZone).iso,
      clockMismatch: closes.mismatch,
    });
  }
  if (a.data.length > 0 && rows.length === 0) {
    throw new Error(`bidsandtenders ${agency.name}: ${a.data.length} rows but none with an Id and a Title (fields renamed?)`);
  }
  return { rows, total };
}

/** "20693 - Olympic Valley Road Snow Removal" → number "20693", name "Olympic Valley Road Snow Removal". */
export function splitTitle(raw: string): { number: string | null; name: string } {
  const m = /^([A-Z0-9][A-Z0-9._/-]{0,24})\s+-\s+(.+)$/i.exec(clean(raw));
  return m && /\d/.test(m[1]!) ? { number: m[1]!, name: m[2]!.trim() } : { number: null, name: clean(raw) };
}

/** Words after a town's name that make it a street, not the place ("Lincoln Way" is in Auburn). */
const STREET = /^\s+(?:road|rd|street|st|way|avenue|ave|boulevard|blvd|drive|dr|lane|ln|parkway|pkwy|court|ct|highway|hwy)\b/i;

/**
 * The one town of the agency's county the listing names ("421 Berry Street, Roseville, CA 95678"), or null: none, a
 * street of that name only, or two different towns (then the card stays the county area).
 */
export function townInText(text: string, towns: readonly string[]): string | null {
  const found = new Set<string>();
  for (const town of towns) {
    const re = new RegExp(`\\b${town.replace(/ /g, '\\s+')}\\b`, 'gi');
    for (const m of text.matchAll(re)) {
      if (!STREET.test(text.slice(m.index! + m[0].length))) { found.add(town); break; }
    }
  }
  return found.size === 1 ? [...found][0]! : null;
}

export function rowToDraft(row: BidsAndTendersRow, agency: BidsAndTendersAgency): BidDraft {
  const { number, name } = splitTitle(row.title);
  const text = `${name} ${row.description}`;
  const town = townInText(text, agency.towns);
  return {
    source: 'bidsandtenders',
    sourceId: `${agency.key}:${row.id}`,
    sourceName: `${agency.name} (bids&tenders)`,
    title: name,
    agency: agency.name,
    description: cleanOrNull(truncate(row.description, 1500)),
    category: null,
    location: { ...(town ? { city: town } : {}), county: agency.county, state: agency.state },
    postedAt: row.postedAt,
    dueAt: row.closesAt,
    estValue: findEstimate(text),
    naics: null,
    setAside: null,
    url: detailUrl(agency, row.id),
    flags: detectFlags(text),
    solNumber: number,
  };
}

// ------------------------------------------------------------------ fetch --

/** The anti-forgery cookie the list page sets; the search call is refused without it. */
const TOKEN_COOKIE = /^__RequestVerificationToken/;

/** One search POST, parsed. Never re-sent. */
async function search(session: FetchLike, agency: BidsAndTendersAgency, page: ListPage, start: number): Promise<BidsAndTendersAnswer> {
  const body = await session.text(searchUrl(agency, page, start), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      Referer: listUrl(agency),
    },
    body: searchBody(page),
  });
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`bidsandtenders ${agency.name}: the search answered with something that is not JSON`);
  }
  return parseBidsAndTenders(json, agency);
}

/** One agency: the list page, then every page of open rows. */
export async function fetchAgency(agency: BidsAndTendersAgency, ctx: SourceContext): Promise<BidDraft[]> {
  // ONE session, opened before the first request: the token on the page belongs to the cookie that page sets.
  const session = ctx.http.session?.();
  if (!session) throw new Error('bidsandtenders: needs a cookie session (ctx.http.session)');
  const page = parseListPage(await session.text(listUrl(agency)));
  if (session.cookieNames && !session.cookieNames(listUrl(agency)).some((n) => TOKEN_COOKIE.test(n))) {
    throw new Error(`bidsandtenders ${agency.name}: the list page set no anti-forgery cookie`);
  }

  // The first POST: if it fails, the source fails (nothing was read).
  const first = await search(session, agency, page, 0);
  const byId = new Map(first.rows.map((r) => [r.id, r]));
  let total = first.total;
  let start = first.rows.length;
  let pages = 1;
  let stop = '';
  let budget = false;
  while (start < total) {
    if (pages >= BIDSANDTENDERS_MAX_PAGES) { stop = `${BIDSANDTENDERS_MAX_PAGES}-page cap`; break; }
    if (outOfTime(ctx)) { stopAtBudget(ctx, ID, byId.size, total); budget = true; break; }
    let next: BidsAndTendersAnswer;
    try {
      next = await search(session, agency, page, start);
    } catch (err) {
      stop = `rows from ${start} failed (${err instanceof Error ? err.message : String(err)})`;
      break;
    }
    pages++;
    const before = byId.size;
    for (const r of next.rows) if (!byId.has(r.id)) byId.set(r.id, r);
    if (next.rows.length === 0 || byId.size === before) { stop = `rows from ${start} added nothing new`; break; }
    start += next.rows.length;
    total = next.total;
  }

  const read = [...byId.values()];
  // Status Open only. "Planned" rows (DatePlannedIssue, no documents yet) are not biddable yet: left for later.
  const open = read.filter((r) => r.status.toLowerCase() === 'open');
  const timed = open.filter((r) => r.closesAt != null);
  const drafts = timed.map((r) => rowToDraft(r, agency));
  const kept = drafts.filter((d) => isTradeWork({ title: d.title, description: d.description, board: ID }).keep);

  // The same words as civicplus: "<id> <agency>: N of T listed, K kept, X not open, Y left out as not trade work".
  let msg = `${ID} ${agency.name}: ${read.length} of ${total} listed`;
  if (pages > 1) msg += ` (pages ${pages})`;
  if (read.length === 0) msg += ' (no open bids)';
  else {
    msg += `, ${kept.length} kept`;
    if (read.length > open.length) msg += `, ${read.length - open.length} not open`;
    if (open.length > timed.length) msg += `, ${open.length - timed.length} closing time unreadable`;
    if (drafts.length > kept.length) msg += `, ${drafts.length - kept.length} left out as not trade work`;
    const mismatches = read.filter((r) => r.clockMismatch).length;
    if (mismatches) msg += `, ${mismatches} with a /Date()/ that disagrees with the shown time`;
  }
  if (stop) {
    msg += ` — stopped: ${stop}`;
    ctx.partial?.(`${ID} ${agency.name}: stopped: ${stop}, ${read.length} of ${total} read`);
  } else if (budget) {
    msg += ' — stopped at the time budget';
  }
  ctx.log(msg);
  return kept;
}

export const bidsAndTendersSource: Source = {
  id: 'bidsandtenders',
  name: `bids&tenders (${BIDSANDTENDERS_AGENCIES.map((a) => a.name).join(', ')})`,
  homepage: listUrl(BIDSANDTENDERS_AGENCIES[0]!),
  states: [...new Set(BIDSANDTENDERS_AGENCIES.map((a) => a.state))],
  timeZone: PACIFIC,
  group: 'west',
  async fetch(ctx) {
    const out: BidDraft[] = [];
    const failed: string[] = [];
    for (const [i, agency] of BIDSANDTENDERS_AGENCIES.entries()) {
      if (i > 0 && outOfTime(ctx)) { stopAtBudget(ctx, ID, i, BIDSANDTENDERS_AGENCIES.length, 'agencies'); break; }
      try {
        out.push(...await fetchAgency(agency, ctx));
      } catch (err) {
        // One agency alone: its failure is the source's (FAILED in the report). With several, the others still count.
        if (BIDSANDTENDERS_AGENCIES.length === 1) throw err;
        const why = err instanceof Error ? err.message : String(err);
        failed.push(`${agency.name}: ${why}`);
        ctx.log(`${ID} ${agency.name}: FAILED: ${why}`);
        ctx.partial?.(`${ID} ${agency.name}: failed: ${why}`);
      }
    }
    if (failed.length === BIDSANDTENDERS_AGENCIES.length) throw new Error(`${ID}: every agency failed (${failed.join('; ')})`);
    return out;
  },
};
