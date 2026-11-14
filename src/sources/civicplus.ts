import * as cheerio from 'cheerio';
import type { BidDraft, Source, SourceContext } from '../types.js';
import { outOfTime, stopAtBudget } from './budget.js';
import { isTradeWork } from './relevance.js';
import { detectFlags } from '../util/flags.js';
import { findEstimate } from '../util/money.js';
import { clean } from '../util/text.js';
import { parseUsDateTime } from '../util/time.js';

/**
 * CivicPlus CivicEngage "Bid Postings" module: the /Bids.aspx page many city and county sites run. ONE reader, a
 * site list: adding a city is one line in CIVICPLUS_SITES.
 *
 * PAGE (raw answers of 2026-11-14 18:06 UTC, test/fixtures/civicplus.md): server-rendered HTML. Inside
 * `div.bidItems.listItems`, a `div.bidsHeader` names each group (its first span is the category, the second "2 Bids"),
 * then one `div.listItemsRow.bid` per posting: `div.bidTitle` holds the title link `bids.aspx?bidID=<n>`, sometimes a
 * "Bid No." span, and a snippet ending "... [Read on: <title>]"; `div.bidStatus` holds the labels "Status:" /
 * "Closes:" in one div and their values in the next ("Open" / "Upon Contract", "Closed" / "8/17/2023 4:00 PM").
 * Statuses seen: Open, Closed, Awarded. "Upon Contract" = no closing date set. A posting filed under two categories
 * is listed twice: it is read once (the first). With no open posting the list holds one sentence: "There are no open
 * bid postings at this time." That is a real zero. Anything else (no list, rows nobody can read) throws: FAILED.
 *
 * FETCH: one GET of /Bids.aspx per site per scan (the page's default: Open bids, by category). Nothing else: no RSS,
 * no search, no detail page. robots.txt (both sites, 2026-11-14) disallows /RSS.aspx, /rss.aspx, /Search, /search.aspx
 * and more, NOT /Bids.aspx, and sets Crawl-delay: 10. So the GET goes out with crawlDelayMs (util/http.ts): ONE
 * attempt, never retried after a 429/5xx/network error, no redirect followed, and no second request to that host
 * within 10 s. One request per host per scan, so the delay is never slept inside the group's time budget.
 * KEPT: status Open, then isTradeWork on the title, the snippet and the group's category (the mixed group
 * "Public Works Projects (Maintenance & Professional Services)" says nothing either way: the words decide). A posting
 * in a group named just "Professional Services" is left out whatever its words: in Citrus Heights' 47 real ones every
 * row is a consultant's, a program's or a vendor's (banking, catering, A&E design for a "… Center Remodel", loan
 * program administration); the city files construction under "Public Works Projects (Construction)".
 * PLACE: the site's own city. CARD: https://<host>/bids.aspx?bidID=<n>.
 */

export interface CivicPlusSite {
  /** The site's host, as its robots.txt was read. */
  host: string;
  /** Short name for the log line ("civicplus Citrus Heights: …"). */
  label: string;
  /** The government: the card's agency. */
  agency: string;
  /** Where its work is: the site's own city, placed by the geo code (src/geo/locate.ts). */
  city: string;
  state: string;
  /** IANA zone of its wall-clock times. */
  timeZone: string;
}

/**
 * The CivicPlus sites read. A site is added ONLY after its robots.txt was read (and /Bids.aspx is not disallowed
 * for every client) and one GET of /Bids.aspx answered the list or its empty-state sentence.
 * Checked and OUT (2026-11-14): Woodland (www.cityofwoodland.gov: /Bids.aspx 301s to a page whose list is a Public
 * Purchase iframe) and Tuolumne County (www.tuolumnecounty.ca.gov: /Bids.aspx answers a Cloudflare bot challenge).
 */
// FIRST LOAD is judged per source and state (src/scan.ts), not per site: the first scan after a site is added to a
// state that already has a stored civicplus bid must run quietly (--quiet / ?quiet=1), or its backlog alerts.
export const CIVICPLUS_SITES: readonly CivicPlusSite[] = [
  { host: 'www.citrusheights.net', label: 'Citrus Heights', agency: 'City of Citrus Heights', city: 'Citrus Heights', state: 'CA', timeZone: 'America/Los_Angeles' },
  { host: 'www.auburn.ca.gov', label: 'Auburn', agency: 'City of Auburn', city: 'Auburn', state: 'CA', timeZone: 'America/Los_Angeles' },
];

/** robots.txt of every CivicPlus site read so far: `Crawl-delay: 10` for `User-agent: *`. */
export const CIVICPLUS_CRAWL_DELAY_MS = 10_000;

export const civicPlusListUrl = (site: Pick<CivicPlusSite, 'host'>): string => `https://${site.host}/Bids.aspx`;
export const civicPlusBidUrl = (site: Pick<CivicPlusSite, 'host'>, bidId: string): string => `https://${site.host}/bids.aspx?bidID=${bidId}`;

const EMPTY = /There are no open bid postings at this time\./i;
const UPON_CONTRACT = /^upon contract$/i;

/** One posting as the page writes it. */
export interface CivicPlusRow {
  bidId: string;
  title: string;
  /** As written: "Open", "Closed", "Awarded" … */
  status: string;
  /** The group header it is listed under. */
  category: string | null;
  /** The snippet without its "[Read on: …]" tail; null when the page gives none. */
  snippet: string | null;
  /** The "Bid No." line, when there is one. */
  bidNumber: string | null;
  /** The "Closes:" value as written ("Upon Contract", "8/17/2023 4:00 PM"). */
  closes: string;
  /** ISO UTC; null for "Upon Contract" (or a value that is not a date). */
  dueAt: string | null;
}

export interface CivicPlusList {
  rows: CivicPlusRow[];
  /** Row elements that had no bidID link, title or status (logged; all of them unreadable throws). */
  unreadable: number;
}

/**
 * The page's list, every status. PURE: string in, rows out. Throws when the page is not a Bid Postings list (a
 * challenge page, a redirect body, a changed layout); the empty-state sentence is zero rows, not an error.
 */
export function parseCivicPlusBids(html: string, site: Pick<CivicPlusSite, 'host' | 'timeZone'>): CivicPlusList {
  const $ = cheerio.load(html);
  const list = $('div.bidItems.listItems').first();
  if (list.length === 0) {
    const title = clean($('title').first().text());
    throw new Error(`civicplus ${site.host}: no Bid Postings list on the page${title ? ` (page title "${title}")` : ''}: a challenge, a redirect or a changed layout`);
  }
  const out: CivicPlusList = { rows: [], unreadable: 0 };
  const seen = new Set<string>();
  let category: string | null = null;
  let rowCount = 0;
  list.children().each((_, el) => {
    const node = $(el);
    if (node.is('div.bidsHeader')) {
      category = clean(node.children('span').first().text()) || null;
      return;
    }
    if (!node.is('div.listItemsRow.bid')) return;
    rowCount++;
    const row = readRow($, node, category, site.timeZone);
    if (!row) { out.unreadable++; return; }
    if (seen.has(row.bidId)) return; // listed under a second category
    seen.add(row.bidId);
    out.rows.push(row);
  });
  if (rowCount === 0 && !EMPTY.test(list.text())) {
    throw new Error(`civicplus ${site.host}: the Bid Postings list has no rows and not the "no open bid postings" sentence (layout changed?)`);
  }
  if (rowCount > 0 && out.rows.length === 0) {
    throw new Error(`civicplus ${site.host}: ${rowCount} rows on the Bid Postings list but none readable (layout changed?)`);
  }
  return out;
}

function readRow($: cheerio.CheerioAPI, node: cheerio.Cheerio<any>, category: string | null, timeZone: string): CivicPlusRow | null {
  const titleBox = node.children('div.bidTitle').first();
  const link = titleBox.find('a[href*="bidID="]').first();
  const bidId = /bidID=(\d+)/i.exec(link.attr('href') ?? '')?.[1];
  const title = clean(link.text());
  // "Status:" / "Closes:" labels in one div, their values in the next, read by label.
  const [labels, values] = node.find('div.bidStatus').first().children('div').toArray().map((d) => $(d).children('span').toArray().map((s) => clean($(s).text())));
  const value = (label: RegExp): string => {
    const i = (labels ?? []).findIndex((l) => label.test(l));
    return i >= 0 ? values?.[i] ?? '' : '';
  };
  const status = value(/^status:?$/i);
  if (!bidId || !title || !status) return null;
  const closes = value(/^closes:?$/i);

  let bidNumber: string | null = null;
  let snippet: string | null = null;
  titleBox.children('span').each((i, s) => {
    const span = $(s);
    if (span.find('a[href*="bidID="]').length && i === 0) return; // the title
    if (/^bid no\.?$/i.test(clean(span.children('strong').first().text()))) {
      bidNumber = clean(span.text().replace(/^\s*bid no\.?/i, '')) || null;
      return;
    }
    const copy = span.clone();
    copy.find('a').filter((_, a) => /^read on/i.test(clean($(a).text()))).remove();
    const text = clean(copy.text().replace(/\[\s*\]\s*$/, ''));
    if (text) snippet = text;
  });

  return {
    bidId, title, status, category, snippet, bidNumber, closes,
    dueAt: !closes || UPON_CONTRACT.test(closes) ? null : parseUsDateTime(closes, { timeZone }),
  };
}

/** A posting as a card. */
export function civicPlusDraft(row: CivicPlusRow, site: CivicPlusSite): BidDraft {
  const words = [row.title, row.snippet].filter(Boolean).join(' \n ');
  return {
    source: 'civicplus',
    sourceId: `${site.host}:${row.bidId}`,
    sourceName: `${site.agency} (CivicPlus)`,
    title: row.title,
    agency: site.agency,
    description: [row.category, row.snippet, row.bidNumber ? `Bid No. ${row.bidNumber}` : null,
      UPON_CONTRACT.test(row.closes) ? 'Closes: upon contract (no closing date set)' : null].filter(Boolean).join(' · ') || null,
    category: row.category,
    location: { city: site.city, state: site.state },
    postedAt: null,
    dueAt: row.dueAt,
    estValue: findEstimate(words),
    naics: null,
    setAside: null,
    url: civicPlusBidUrl(site, row.bidId),
    flags: detectFlags(words),
    solNumber: row.bidNumber,
  };
}

/**
 * The one group header that names professional services NEXT TO trade work says nothing either way ("Public Works
 * Projects (Maintenance & Professional Services)"). A plain "Professional Services" group is a real signal.
 */
const MIXED_CATEGORY = /maintenance\s*(?:&|and)\s*professional services/i;
/** A group of professional services alone: never a contractor's job (see KEPT above). */
const PROFESSIONAL_ONLY = /^professional services$/i;

/** Is an open posting trade work? The board's group first, then the shared word rules (src/sources/relevance.ts). */
export function civicPlusTradeWork(row: Pick<CivicPlusRow, 'title' | 'snippet' | 'category'>): boolean {
  if (PROFESSIONAL_ONLY.test(row.category ?? '')) return false;
  return isTradeWork({
    title: row.title, description: row.snippet, category: row.category && !MIXED_CATEGORY.test(row.category) ? row.category : null, board: 'civicplus',
  }).keep;
}

/** One GET per site; one site failing is reported (ctx.partial) and the others kept; every site failing throws. */
export async function fetchCivicPlusSites(ctx: SourceContext, sites: readonly CivicPlusSite[]): Promise<BidDraft[]> {
  const out: BidDraft[] = [];
  const failed: string[] = [];
  let tried = 0;
  for (const site of sites) {
    if (tried > 0 && outOfTime(ctx)) { stopAtBudget(ctx, 'civicplus', tried, sites.length, 'sites'); break; }
    tried++;
    try {
      const html = await ctx.http.text(civicPlusListUrl(site), { crawlDelayMs: CIVICPLUS_CRAWL_DELAY_MS });
      const { rows, unreadable } = parseCivicPlusBids(html, site);
      const open = rows.filter((r) => /^open$/i.test(r.status));
      const kept = open.filter(civicPlusTradeWork);
      const left = open.length - kept.length;
      const notOpen = rows.length - open.length;
      // The same words as bidsandtenders: "<id> <site>: N listed, K kept, X not open, Y left out as not trade work".
      ctx.log(rows.length === 0
        ? `civicplus ${site.label}: 0 listed (no open bid postings)`
        : `civicplus ${site.label}: ${rows.length} listed, ${kept.length} kept`
          + (notOpen ? `, ${notOpen} not open` : '')
          + (left ? `, ${left} left out as not trade work` : '')
          + (unreadable ? `, ${unreadable} rows unreadable` : ''));
      out.push(...kept.map((r) => civicPlusDraft(r, site)));
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      ctx.log(`civicplus ${site.label}: FAILED: ${why}`);
      ctx.partial?.(`civicplus ${site.label}: failed: ${why}`);
      failed.push(`${site.label}: ${why}`);
    }
  }
  if (tried > 0 && failed.length === tried) throw new Error(`civicplus: every site failed (${failed.join('; ')})`);
  return out;
}

export const civicPlusSource: Source = {
  id: 'civicplus',
  name: `CivicPlus (${CIVICPLUS_SITES.map((s) => s.label).join(', ')})`,
  homepage: civicPlusListUrl(CIVICPLUS_SITES[0]!),
  states: [...new Set(CIVICPLUS_SITES.map((s) => s.state))],
  timeZone: 'America/Los_Angeles',
  group: 'west',
  fetch: (ctx) => fetchCivicPlusSites(ctx, CIVICPLUS_SITES),
};
