import type { BidDraft, BidLocation, Source, SourceContext } from '../types.js';
import { outOfTime, stopAtBudget } from './budget.js';
import { isTradeWork } from './relevance.js';
import { lookupCity } from '../geo/zip.js';
import { detectFlags } from '../util/flags.js';
import { findEstimate } from '../util/money.js';
import { clean, cleanOrNull } from '../util/text.js';
import { parseUsDateTime } from '../util/time.js';

/**
 * Texas Electronic State Business Daily (ESBD): every Texas state agency, university and many local governments.
 *
 * One public JSON call, no login, no key (the ESBD page at www.txsmartbuy.gov/esbd makes the same one):
 *   POST https://www.txsmartbuy.gov/app/extensions/CPA/CPAMain/1.0.0/services/ESBD.Service.ss
 *   Content-Type: application/json; charset=UTF-8, Referer: https://www.txsmartbuy.gov/esbd
 *   body {"lines":[],"page":1,"urlRoot":"esbd","status":"1"}
 *   → { agencies[413], lines[24], page, recordsPerPage: 24, totalRecordsFound: 501 }
 * First response 2026-11-14 05:59 UTC (first/texas.out; fixture test/fixtures/txesbd-page1.json, notes in txesbd.md).
 * Per line: internalid, title, solicitationId, responseDue "11/20/2026", responseTime "10:30 PM", agencyNumber,
 * agencyName "Health & Human Services Commission - 529", status "1"|"6", statusName "Posted"|"Addendum Posted",
 * postingDate "11/5/2026", nigpCodes "95405-Laundry and Linen Service, …;\n…", url (the agency's own bidding site,
 * absolute, or "").
 * The status "1" list already held 14 "Addendum Posted" (status 6) lines on its first page, so status "6" may be a
 * subset of it: we read "1" first, then "6", keep each solicitationId once, and stop "6" at the first page that
 * brings nothing new (NOT CONFIRMED live: see ROBOTS below).
 *
 * TIMES: responseDue + responseTime are wall-clock text with no zone. Read as Central (America/Chicago), the zone
 * of Austin, where the ESBD is run; El Paso-area agencies keep Mountain time and the board does not say which a
 * row uses (NOT CONFIRMED). A due date with no time = the end of that day (23:59) Central. postingDate = the start
 * of that day Central.
 * PLACE: a line names no site, only the agency. A local government's name places it ("City of Austin", "Hays
 * County", "Abilene ISD", "University Of Texas At San Antonio"), and only when the town is in the nationwide ZIP
 * table (src/geo/zip.ts lookupCity): never a guessed city. State agencies work statewide: TX only.
 * CARD: https://www.txsmartbuy.gov/esbddetails/view/<solicitationId>, the ESBD's own solicitation page (the path is
 * the one the ESBD web app links to; NOT fetched by us).
 *
 * ROBOTS: www.txsmartbuy.gov/robots.txt (read once, 2026-11-14 06:40 UTC) is "User-agent: * / Disallow: /". The
 * board asks every automated client to stay out, so the source is built and tested but switched OFF
 * (disabledReason below): turning it on is the owner's decision, not the scanner's.
 */

export const TXESBD_URL = 'https://www.txsmartbuy.gov/app/extensions/CPA/CPAMain/1.0.0/services/ESBD.Service.ss';
export const TXESBD_REFERER = 'https://www.txsmartbuy.gov/esbd';
export const txesbdDetailUrl = (solicitationId: string): string =>
  `https://www.txsmartbuy.gov/esbddetails/view/${encodeURIComponent(solicitationId)}`;

const NAME = 'Texas ESBD (State Business Daily)';
const ZONE = 'America/Chicago';
/** The statuses we read, in order: "Posted", then "Addendum Posted". */
export const TXESBD_STATUSES = ['1', '6'] as const;
/** A status list longer than this many pages is read up to here and logged (501 rows = 21 pages on 2026-11-14). */
const MAX_PAGES = 40;

export const TXESBD_ROBOTS =
  'www.txsmartbuy.gov/robots.txt says "User-agent: * Disallow: /" (read 2026-11-14): off until the owner decides';

export function txesbdBody(page: number, status: string): string {
  return JSON.stringify({ lines: [], page, urlRoot: 'esbd', status });
}

export interface TxesbdLine {
  internalid?: string | null;
  title?: string | null;
  solicitationId?: string | null;
  responseDue?: string | null;
  responseTime?: string | null;
  agencyNumber?: string | null;
  agencyName?: string | null;
  status?: string | null;
  statusName?: string | null;
  postingDate?: string | null;
  nigpCodes?: string | null;
  url?: string | null;
}

export interface TxesbdAnswer {
  lines: TxesbdLine[];
  page?: number;
  recordsPerPage?: number;
  totalRecordsFound: number;
}

/** Is this the answer we know? HTML, an error object or a changed shape is not: THROWS. */
export function checkTxesbdAnswer(json: unknown): TxesbdAnswer {
  const a = json as Partial<TxesbdAnswer> | null;
  if (!a || typeof a !== 'object' || Array.isArray(a) || !Array.isArray(a.lines) || typeof a.totalRecordsFound !== 'number') {
    throw new Error('txesbd: not the { lines, totalRecordsFound } answer we know');
  }
  return a as TxesbdAnswer;
}

/** "Health & Human Services Commission - 529" → "Health & Human Services Commission" (the ESBD's agency number goes). */
export function txAgencyName(raw: string | null | undefined): string | null {
  return cleanOrNull(clean(raw).replace(/\s*-\s*[A-Z]?\d{2,6}[A-Z]?$/, ''));
}

/** "20448-*Keyboards;\n20496-*Workstations…" → ["20448-Keyboards", "20496-Workstations…"]. */
export function splitNigp(raw: string | null | undefined): string[] {
  return (raw ?? '').split(/;|\n/).map((c) => clean(c).replace(/^(\d+)-\*?/, '$1-')).filter((c) => /^\d{3,}/.test(c));
}

/**
 * Where a government's own name puts it, for the local governments a state board also lists. Only names that SAY
 * where they are: "City/Town/Village of X" and a campus "… at X". The town goes to the nationwide ZIP table and is
 * used ONLY when that table knows it in this state. A district or college name is NOT a place: "Alamo Community
 * College District" is in San Antonio and "London ISD" near Corpus Christi, not in the towns Alamo or London, TX,
 * so "X ISD", "X College" and "University of X" give the state alone (no guess).
 * A county gives its name (there is no nationwide county table: the card says "Hays County, TX", unplaced).
 * Anything else (a state agency, "Alamo Area Council Of Governments") gives the state alone.
 */
export function agencyPlace(agency: string | null, state: string): Partial<BidLocation> {
  const a = clean(agency);
  const town = (name: string | undefined): Partial<BidLocation> | null => {
    const n = clean(name);
    return n && lookupCity(n, state) ? { city: n, state } : null;
  };
  const m =
    /^(?:City|Town|Village)\s+of\s+(.+)$/i.exec(a) ??
    /\b(?:University|Univ\.?|College)\b.*?\s(?:at|At|AT)\s+(.+)$/.exec(a);
  const hit = m ? town(m[1]) : null;
  if (hit) return hit;
  const county = /^(.+?)\s+County$/i.exec(a);
  if (county) return { county: clean(county[1]), state, label: `${clean(county[1])} County, ${state}` };
  return { state };
}

export interface ParsedTxesbd {
  bids: BidDraft[];
  /** Lines with a solicitation id and a title. */
  read: number;
  /** Lines left out as not trade work. */
  notTrade: number;
}

/** One page of lines → drafts. PURE. isTradeWork reads the title and the NIGP codes (the board's own commodity codes). */
export function parseTxesbd(json: TxesbdAnswer): ParsedTxesbd {
  const out: ParsedTxesbd = { bids: [], read: 0, notTrade: 0 };
  for (const l of json.lines) {
    const sol = clean(l.solicitationId);
    const title = clean(l.title);
    if (!sol || !title) continue;
    out.read++;
    const nigp = splitNigp(l.nigpCodes);
    if (!isTradeWork({ title, codes: { nigp } }).keep) { out.notTrade++; continue; }

    const agency = txAgencyName(l.agencyName);
    const due = clean(l.responseDue);
    const time = clean(l.responseTime);
    const site = /^https?:\/\//i.test(clean(l.url)) ? clean(l.url) : null;
    let siteHost: string | null = null;
    try { siteHost = site ? new URL(site).host : null; } catch { siteHost = null; }
    const status = clean(l.statusName);
    out.bids.push({
      source: 'txesbd',
      sourceId: sol,
      sourceName: NAME,
      title,
      agency,
      description: [
        agency,
        `Solicitation ${sol}`,
        status && !/^posted$/i.test(status) ? status : null,
        nigp.length ? `NIGP ${nigp.slice(0, 4).join('; ')}${nigp.length > 4 ? ` (+${nigp.length - 4} more)` : ''}` : null,
        siteHost ? `Responses through the agency's site: ${siteHost}` : null,
      ].filter(Boolean).join(' · '),
      category: nigp[0]?.replace(/^\d+-/, '') ?? 'State solicitation',
      location: agencyPlace(agency, 'TX'),
      postedAt: parseUsDateTime(l.postingDate, { timeZone: ZONE, defaultTime: [0, 0] }),
      // A date with no time: the end of that day, Central.
      dueAt: due ? parseUsDateTime(`${due} ${time}`.trim(), { timeZone: ZONE, defaultTime: [23, 59] }) : null,
      estValue: findEstimate(title),
      naics: null,
      setAside: null,
      url: txesbdDetailUrl(sol),
      flags: detectFlags(title),
      solNumber: sol,
    });
  }
  return out;
}

async function postPage(ctx: SourceContext, page: number, status: string): Promise<TxesbdAnswer> {
  const body = await ctx.http.text(TXESBD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', Accept: 'application/json', Referer: TXESBD_REFERER },
    body: txesbdBody(page, status),
  });
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`txesbd: expected JSON for status ${status} page ${page}, got ${/^\s*</.test(body) ? 'an HTML page' : 'something else'}`);
  }
  return checkTxesbdAnswer(json);
}

export const txesbdSource: Source = {
  id: 'txesbd',
  name: NAME,
  homepage: TXESBD_REFERER,
  states: ['TX'],
  timeZone: ZONE,
  group: 'south',
  disabledReason: () => TXESBD_ROBOTS,
  async fetch(ctx) {
    const seen = new Set<string>();
    const kept: BidDraft[] = [];
    let read = 0;
    let notTrade = 0;
    let requests = 0;
    let total = 0;
    stop: for (const status of TXESBD_STATUSES) {
      let announced = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (requests > 0 && outOfTime(ctx)) { stopAtBudget(ctx, 'txesbd', read, total || null); break stop; }
        const answer = await postPage(ctx, page, status);
        requests++;
        if (page === 1) {
          announced = answer.totalRecordsFound;
          total += announced;
          if (announced > 0 && answer.lines.length === 0) throw new Error(`txesbd: status ${status} announces ${announced} lines but lists none`);
        }
        if (answer.lines.length > 0 && !answer.lines.some((l) => clean(l.solicitationId) && clean(l.title))) {
          throw new Error(`txesbd: ${answer.lines.length} lines but none has a solicitation id and a title (fields renamed?)`);
        }
        // Each solicitation once: status "6" repeats lines status "1" already listed.
        const lines = answer.lines.filter((l) => {
          const sol = clean(l.solicitationId);
          if (!sol || seen.has(sol)) return false;
          seen.add(sol);
          return true;
        });
        const parsed = parseTxesbd({ ...answer, lines });
        read += parsed.read;
        notTrade += parsed.notTrade;
        kept.push(...parsed.bids);
        const per = answer.recordsPerPage ?? answer.lines.length;
        if (answer.lines.length === 0) break;
        if (status !== TXESBD_STATUSES[0] && lines.length === 0) {
          ctx.log(`txesbd: status ${status} page ${page} held nothing new, stopped (status ${TXESBD_STATUSES[0]} already lists them)`);
          break;
        }
        if (answer.lines.length < per || page * per >= announced) break;
        if (page === MAX_PAGES) {
          const msg = `txesbd: status ${status} stopped at the page cap (${MAX_PAGES} pages, ${announced} announced)`;
          ctx.log(msg);
          ctx.partial?.(msg);
        }
      }
    }
    ctx.log(`txesbd: ${read} solicitations read in ${requests} requests, ${kept.length} kept, ${notTrade} left out as not trade work`);
    return kept;
  },
};
