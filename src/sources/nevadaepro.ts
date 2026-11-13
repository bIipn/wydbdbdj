import * as cheerio from 'cheerio';
import type { BidDraft, Source } from '../types.js';
import { absolutize } from '../util/http.js';
import { clean, cleanOrNull } from '../util/text.js';
import { parseUsDateTime } from '../util/time.js';

/** State Purchasing (Periscope BSO). Public, no login needed for the open-bids list. */
export const NEVADAEPRO_OPEN_BIDS = 'https://nevadaepro.com/bso/view/search/external/advancedSearchBid.xhtml?openBids=true';

/** One results page, plus what fetch() needs to tell "no open bids" from "the page changed". */
export interface NevadaEproPage {
  bids: BidDraft[];
  /** false = the results table is not in the HTML at all (layout change, error page). */
  tableFound: boolean;
  /** Data rows in the table, parsed or not. */
  rows: number;
  /** Open bids the board says it has across all pages, or null when it does not say. */
  total: number | null;
}

const isHidden = (style: string | undefined): boolean => /display:\s*none/i.test(style ?? '');

/** Paginator text ("1-25 of 29") first, else the PrimeFaces widget config (rowCount:29). */
function announcedTotal($: cheerio.CheerioAPI): number | null {
  const m =
    /\bof\s+([\d,]+)/i.exec($('[id*="bidResultId_paginator"] .ui-paginator-current').first().text()) ??
    /\browCount:\s*(\d+)/.exec($('script[id$="bidResultId_s"]').text());
  return m ? Number(m[1]!.replace(/,/g, '')) : null;
}

/** How many open bids the board announces across all pages (we only read the first). */
export function parseNevadaEproTotal(html: string): number | null {
  return announcedTotal(cheerio.load(html));
}

/**
 * The server HTML names the columns only in <thead>; the cells are bare
 * (<td role="gridcell">Department of Wildlife</td>), so each cell takes the label of the
 * header at the same position. A page saved from a browser also carries the label inside
 * every cell (<span class="ui-column-title">, added by page JavaScript) — that one wins.
 * Either way we go by label, never by a fixed index, so reordered columns still work.
 */
export function parseNevadaEproPage(html: string, pageUrl = NEVADAEPRO_OPEN_BIDS): NevadaEproPage {
  const $ = cheerio.load(html);
  const tbody = $('tbody[id$="bidResultId_data"], table[summary="Bid search results"] > tbody').first();

  // Label per column position; '' for the hidden duplicate columns.
  const headers = tbody
    .closest('table')
    .find('thead tr')
    .first()
    .children('th')
    .toArray()
    .map((th) => {
      const $th = $(th);
      if (isHidden($th.attr('style'))) return '';
      return clean($th.find('span.ui-column-title').first().text()) || clean($th.attr('aria-label'));
    });

  const trs = tbody.children('tr').not('.ui-datatable-empty-message'); // PrimeFaces' "No records found." row
  const seen = new Set<string>();
  const bids: BidDraft[] = [];

  trs.each((_, tr) => {
    const tds = $(tr).children('td');
    const byPosition = tds.length === headers.length; // otherwise the header can't be trusted for this row
    const cells: Record<string, string> = {};
    let href: string | null = null;
    tds.each((i, td) => {
      const $td = $(td);
      if (isHidden($td.attr('style'))) return; // hidden duplicate columns
      const label = clean($td.find('span.ui-column-title').first().text()) || (byPosition ? headers[i] : '');
      const a = $td.find('a[href*="bidDetail"]').first();
      if (a.length) href = absolutize(a.attr('href'), pageUrl);
      const copy = $td.clone();
      copy.find('span.ui-column-title').remove();
      if (label) cells[label] = clean(copy.text());
    });

    const bidNo = cells['Bid Solicitation #'];
    const desc = cells['Description'];
    if (!bidNo || !desc || seen.has(bidNo)) return;
    seen.add(bidNo);

    const buyer = cells['Buyer'];
    const alt = cells['Alternate Id'];
    bids.push({
      source: 'nevadaepro',
      sourceId: bidNo,
      sourceName: 'NevadaEPro (State Purchasing)',
      title: desc,
      agency: cleanOrNull(cells['Organization Name']),
      description: [buyer ? `Buyer: ${buyer}` : null, alt ? `Alt ID ${alt}` : null, `Bid ${bidNo}`].filter(Boolean).join(' · '),
      category: 'State purchase',
      location: { state: 'NV' },
      postedAt: null,
      dueAt: parseUsDateTime(cells['Bid Opening Date']),
      estValue: null,
      naics: null,
      setAside: null,
      url: href ?? `https://nevadaepro.com/bso/external/bidDetail.sda?docId=${encodeURIComponent(bidNo)}&external=true&parentUrl=close`,
      flags: ['May be supply-only'],
    });
  });

  return { bids, tableFound: tbody.length > 0, rows: trs.length, total: announcedTotal($) };
}

/** Just the bids of one page — what the offline fixtures and the demo snapshot use. */
export function parseNevadaEproOpenBids(html: string, pageUrl = NEVADAEPRO_OPEN_BIDS): BidDraft[] {
  return parseNevadaEproPage(html, pageUrl).bids;
}

/** Scan log line, e.g. "nevadaepro: 25 of 29 listed (first page only)". */
function summarize(page: NevadaEproPage): string {
  const n = page.bids.length;
  let msg = page.total == null ? `nevadaepro: ${n} listed (total not announced)` : `nevadaepro: ${n} of ${page.total} listed`;
  if (page.total != null && page.total > page.rows) msg += ' (first page only)';
  if (page.rows > n) msg += `, ${page.rows - n} rows skipped`;
  return msg;
}

export const nevadaEproSource: Source = {
  id: 'nevadaepro',
  name: 'NevadaEPro (State Purchasing)',
  homepage: NEVADAEPRO_OPEN_BIDS,
  async fetch(ctx) {
    // First page only = the 25 newest open bids. Paging is a JSF POST (not implemented); daily scans catch new ones.
    const page = parseNevadaEproPage(await ctx.http.text(NEVADAEPRO_OPEN_BIDS));
    // A page we can't read must show up as FAILED in the scan report, never as "0 bids".
    if (!page.tableFound) throw new Error('results table not found (layout change or error page?)');
    if (page.bids.length === 0 && page.rows > 0) {
      throw new Error(`${page.rows} rows listed but none could be read (columns changed?)`);
    }
    if (page.bids.length === 0 && page.total) {
      throw new Error(`board announces ${page.total} open bids but the table has no rows`);
    }
    ctx.log(summarize(page));
    return page.bids;
  },
};
