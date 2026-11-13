import * as cheerio from 'cheerio';
import type { BidDraft, Source } from '../types.js';
import { absolutize } from '../util/http.js';
import { clean, cleanOrNull, slugify } from '../util/text.js';
import { parseUsDateTime } from '../util/time.js';

/**
 * Nevada Government eMarketplace (NGEM), hosted on IonWave. One public list covers
 * Carson City, Washoe/Reno agencies, UNR/TMCC (BCN Purchasing), Clark County, etc.
 */
export const NGEM_URL = 'https://nevada.ionwave.net/SourcingEvents.aspx?SourceType=1';

const COLS = ['colBidNumber', 'colTitle', 'colTypeTitle', 'colWorkGroupName', 'colOpenDate', 'colCloseDate'] as const;
const FALLBACK_INDEX: Record<(typeof COLS)[number], number> = {
  colBidNumber: 1, colTitle: 2, colTypeTitle: 3, colWorkGroupName: 4, colOpenDate: 5, colCloseDate: 6,
};

export function parseNgemPage(html: string, pageUrl = NGEM_URL): { bids: BidDraft[]; pageUrls: string[] } {
  const $ = cheerio.load(html);
  const table = $('table.rgMasterTable').first();

  // Map columns by their aria-label so a layout change doesn't silently shift fields.
  const index: Record<string, number> = { ...FALLBACK_INDEX };
  table.find('thead tr').first().children('th').each((i, th) => {
    const key = $(th).attr('aria-label');
    if (key && (COLS as readonly string[]).includes(key)) index[key] = i;
  });

  const bids: BidDraft[] = [];
  table.find('tbody > tr.rgRow, tbody > tr.rgAltRow').each((_, tr) => {
    const tds = $(tr).children('td');
    const cell = (k: (typeof COLS)[number]) => clean(tds.eq(index[k] ?? FALLBACK_INDEX[k]).text());
    const rawNumber = cell('colBidNumber');
    if (!rawNumber) return;
    const org = cell('colWorkGroupName');
    const type = cell('colTypeTitle');
    const addendum = /\baddendum\s+(\d+)\s*$/i.exec(rawNumber);
    const bidNumber = addendum ? rawNumber.slice(0, addendum.index).trim() : rawNumber;
    const title = cell('colTitle') || bidNumber; // a few rows have a blank title

    const link = $(tr).find('a[href*="SourceEvent"], a[href*="Event.aspx"]').first().attr('href');
    const flags: string[] = [];
    if (addendum) flags.push(`Addendum ${addendum[1]} posted`);
    if (/^rfi\b/i.test(type)) flags.push('RFI — info only, not a bid');

    bids.push({
      source: 'ngem',
      // Bid numbers repeat across agencies, and addenda change the number text, so key on org + base number.
      sourceId: `${slugify(org)}:${slugify(bidNumber)}`,
      sourceName: 'NGEM (local agencies)',
      title,
      agency: cleanOrNull(org),
      description: `${type || 'Solicitation'} · ${rawNumber}`,
      category: cleanOrNull(type),
      location: { state: 'NV' },
      postedAt: parseUsDateTime(cell('colOpenDate'), { defaultTime: [8, 0] }),
      dueAt: parseUsDateTime(cell('colCloseDate')),
      estValue: null,
      naics: null,
      setAside: null,
      url: absolutize(link, pageUrl) ?? NGEM_URL,
      flags,
    });
  });

  const pageUrls = new Set<string>();
  table.find('tfoot a[href*="rgBidListChangePage="]').each((_, a) => {
    const abs = absolutize($(a).attr('href'), pageUrl);
    if (abs) pageUrls.add(abs);
  });
  return { bids, pageUrls: [...pageUrls] };
}

export const ngemSource: Source = {
  id: 'ngem',
  name: 'NGEM (local agencies)',
  homepage: NGEM_URL,
  async fetch(ctx) {
    const first = parseNgemPage(await ctx.http.text(NGEM_URL));
    const all = [...first.bids];
    // Pager links are plain GET URLs (Telerik "SEO paging"). Cap pages so a layout change can't loop us.
    for (const url of first.pageUrls.slice(0, 8)) {
      const page = parseNgemPage(await ctx.http.text(url), url);
      all.push(...page.bids);
    }
    const unique = [...new Map(all.map((b) => [b.sourceId, b])).values()];
    ctx.log(`ngem: ${unique.length} (from ${1 + Math.min(first.pageUrls.length, 8)} pages)`);
    return unique;
  },
};
