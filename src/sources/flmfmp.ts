import type { BidDraft, Source } from '../types.js';
import { outOfTime, stopAtBudget } from './budget.js';
import { isTradeWork } from './relevance.js';
import { agencyPlace } from './txesbd.js';
import { detectFlags } from '../util/flags.js';
import { findEstimate } from '../util/money.js';
import { clean, cleanOrNull } from '../util/text.js';
import { parseUsDateTime } from '../util/time.js';

/**
 * MyFloridaMarketPlace (MFMP) Vendor Information Portal, bid search: State of Florida agencies, universities, water
 * management districts and a few local governments.
 *
 * One public JSON call, no login, no key (the portal's own search page makes it):
 *   POST https://vendor.myfloridamarketplace.com/mfmp/pub/search/bids
 *   Content-Type: application/json AND Accept: application/json (without Accept the host answers with the web
 *   app's HTML shell, first/florida.out), body {"status":["OPEN"],"page":1,"pageSize":100}
 *   → a JSON array (no count). Per row: advertisementId, uniqueName "AD-17462", agencyAdNumber (the agency's own
 *   number, sometimes null), type + typeId, title, status "OPEN", openDate, closeDate, publishDate, version,
 *   agency, organization { name, shortName, entity }.
 * Pages are 1-based. Page 1 (2026-11-14 05:59 UTC, first/florida-ok.out) held 100 rows, page 2 (06:41 UTC, ours)
 * 20: 120 open in all. Fixtures: test/fixtures/flmfmp-bids-page1.json, -page2.json (notes in flmfmp.md).
 *
 * TYPES (as seen on those two pages): KEPT the solicitations a contractor answers: 4 Invitation to Bid (42),
 * 5 Invitation to Negotiate (20), 6 Request for Proposals (23), 9 Request for Statement of Qualifications (8).
 * LEFT OUT: 1 Agency Decision (5: notices of an intended award, the bidding is over), 2 Grant Opportunities (4),
 * 3 Informational Notice (1: Q&A about an ITB that is listed itself), 8 Request for Information (2: no award
 * follows), 10 Single Source (15: a notice that one vendor gets it). A type never seen is kept when its name says
 * bid / proposal / quote / qualifications / negotiate, else left out, and the log names it.
 * TIMES: closeDate, openDate and publishDate are ISO instants with a zone ("2026-11-16T22:00:00.000+00:00" = 5 PM
 * Eastern) written by the API, so no wall clock is read and the Central-time panhandle needs nothing of its own
 * (Chipley's 224003 closes 20:00 UTC = 3 PM Eastern, 2 PM Central). A closeDate with no zone (never seen) would
 * be read as Eastern wall clock, the zone the portal shows its times in.
 * PLACE: a row names no site, only the agency: a town in a local government's name ("Town of Orange Park") is
 * used when the nationwide ZIP table knows it (txesbd.ts agencyPlace), else FL only. Never a city from the title.
 * CARD: https://vendor.myfloridamarketplace.com/search/bids/detail/<advertisementId>, the portal's own page.
 * robots.txt: none (vendor.myfloridamarketplace.com/robots.txt answers 404 "Cannot GET /robots.txt", 2026-11-14).
 */

export const FLMFMP_URL = 'https://vendor.myfloridamarketplace.com/mfmp/pub/search/bids';
export const FLMFMP_HOME = 'https://vendor.myfloridamarketplace.com/search/bids';
export const flmfmpDetailUrl = (advertisementId: number | string): string =>
  `https://vendor.myfloridamarketplace.com/search/bids/detail/${encodeURIComponent(String(advertisementId))}`;

const NAME = 'MyFloridaMarketPlace (State of Florida)';
const ZONE = 'America/New_York';
export const FLMFMP_PAGE_SIZE = 100;
/** More pages than this (2,000 open ads) means the list changed: read up to here and log it. */
const MAX_PAGES = 20;

export function flmfmpBody(page: number): string {
  return JSON.stringify({ status: ['OPEN'], page, pageSize: FLMFMP_PAGE_SIZE });
}

export interface FlmfmpRow {
  advertisementId?: number | null;
  uniqueName?: string | null;
  agencyAdNumber?: string | null;
  type?: string | null;
  typeId?: string | null;
  title?: string | null;
  status?: string | null;
  openDate?: string | null;
  closeDate?: string | null;
  publishDate?: string | null;
  agency?: string | null;
  organization?: { name?: string | null; shortName?: string | null } | null;
}

/** The solicitation types we keep, by the board's own names (see TYPES above). */
const KEPT_TYPES = new Set(['invitation to bid', 'invitation to negotiate', 'request for proposals', 'request for statement of qualifications']);
const LEFT_TYPES = new Set(['agency decision', 'grant opportunities', 'informational notice', 'request for information', 'single source']);
/** A type we have not seen: kept when its name says it asks for bids, proposals, quotes or qualifications. */
const SOLICITATION_WORDS = /\b(?:bids?|proposals?|quotes?|quotations?|qualifications|negotiate)\b/i;

export function isFlmfmpSolicitation(type: string | null | undefined): boolean {
  const t = clean(type).toLowerCase();
  if (KEPT_TYPES.has(t)) return true;
  if (LEFT_TYPES.has(t) || /\binformation\b|\bdecision\b|\bgrant/i.test(t)) return false;
  return SOLICITATION_WORDS.test(t);
}

/** Is this the answer we know (a JSON array of ads)? THROWS otherwise. */
export function checkFlmfmpAnswer(json: unknown, page: number): FlmfmpRow[] {
  if (!Array.isArray(json)) throw new Error(`flmfmp: page ${page} is not the JSON array of ads we know (${json === null ? 'null' : typeof json})`);
  const rows = json as FlmfmpRow[];
  if (rows.length > 0 && !rows.some((r) => r && typeof r.advertisementId === 'number' && clean(r.title))) {
    throw new Error(`flmfmp: page ${page} has ${rows.length} rows but none with an advertisementId and a title (fields renamed?)`);
  }
  return rows;
}

export interface ParsedFlmfmp {
  bids: BidDraft[];
  /** Rows with an advertisementId and a title. */
  read: number;
  /** Left out by type (decisions, grants, notices, RFIs, single source), counted per type. */
  notSolicitation: Record<string, number>;
  /** Solicitations left out as not trade work. */
  notTrade: number;
}

/** One page of ads → drafts. PURE. The type decides first, then isTradeWork on the title with the type as category. */
export function parseFlmfmp(rows: readonly FlmfmpRow[]): ParsedFlmfmp {
  const out: ParsedFlmfmp = { bids: [], read: 0, notSolicitation: {}, notTrade: 0 };
  for (const r of rows) {
    const title = clean(r.title);
    if (typeof r.advertisementId !== 'number' || !title) continue;
    if (r.status && clean(r.status).toUpperCase() !== 'OPEN') continue;
    out.read++;
    const type = clean(r.type) || 'Unknown type';
    if (!isFlmfmpSolicitation(type)) { out.notSolicitation[type] = (out.notSolicitation[type] ?? 0) + 1; continue; }
    if (!isTradeWork({ title, category: type, board: 'flmfmp' }).keep) { out.notTrade++; continue; }

    const agency = cleanOrNull(r.agency) ?? cleanOrNull(r.organization?.name);
    const adNumber = cleanOrNull(r.agencyAdNumber);
    out.bids.push({
      source: 'flmfmp',
      sourceId: String(r.advertisementId),
      sourceName: NAME,
      title,
      agency,
      description: [agency, type, adNumber ? `No. ${adNumber}` : null, cleanOrNull(r.uniqueName)].filter(Boolean).join(' · '),
      category: type,
      location: agencyPlace(agency, 'FL'),
      postedAt: parseUsDateTime(r.publishDate, { timeZone: ZONE, defaultTime: [0, 0] }),
      dueAt: parseUsDateTime(r.closeDate, { timeZone: ZONE, defaultTime: [23, 59] }),
      estValue: findEstimate(title),
      naics: null,
      setAside: null,
      url: flmfmpDetailUrl(r.advertisementId),
      flags: detectFlags(title),
      solNumber: adNumber,
    });
  }
  return out;
}

export const flmfmpSource: Source = {
  id: 'flmfmp',
  name: NAME,
  homepage: FLMFMP_HOME,
  states: ['FL'],
  timeZone: ZONE,
  group: 'south',
  async fetch(ctx) {
    const kept: BidDraft[] = [];
    const seen = new Set<string>();
    const left: Record<string, number> = {};
    let read = 0;
    let notTrade = 0;
    let pages = 0;
    for (let page = 1; ; page++) {
      if (page > 1 && outOfTime(ctx)) { stopAtBudget(ctx, 'flmfmp', read, null, 'ads'); break; }
      if (page > MAX_PAGES) {
        const msg = `flmfmp: stopped at the page cap (${MAX_PAGES} pages, ${read} ads read)`;
        ctx.log(msg);
        ctx.partial?.(msg);
        break;
      }
      // http.json sends Accept: application/json (the host answers HTML without it) and throws on HTML.
      const rows = checkFlmfmpAnswer(
        await ctx.http.json(FLMFMP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: flmfmpBody(page),
        }),
        page,
      );
      pages++;
      if (page === 1 && rows.length === 0) throw new Error('flmfmp: the first page lists no open ads (the board always has some: not the list we know)');
      // The list can shift while we page: each ad once.
      const parsed = parseFlmfmp(rows.filter((r) => {
        const id = String(r.advertisementId);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      }));
      read += parsed.read;
      notTrade += parsed.notTrade;
      for (const [t, n] of Object.entries(parsed.notSolicitation)) left[t] = (left[t] ?? 0) + n;
      kept.push(...parsed.bids);
      if (rows.length < FLMFMP_PAGE_SIZE) break;
    }
    const byType = Object.entries(left).map(([t, n]) => `${n} ${t}`).join(', ');
    const notSol = Object.values(left).reduce((a, b) => a + b, 0);
    ctx.log(
      `flmfmp: ${read} open ads read in ${pages} pages, ${kept.length} kept, ${notSol} left out by type` +
        `${byType ? ` (${byType})` : ''}, ${notTrade} left out as not trade work`,
    );
    return kept;
  },
};
