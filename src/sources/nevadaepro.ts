import * as cheerio from 'cheerio';
import type { BidDraft, Source } from '../types.js';
import { absolutize } from '../util/http.js';
import { clean, cleanOrNull } from '../util/text.js';
import { parseUsDateTime } from '../util/time.js';

/** State Purchasing (Periscope BSO). Public, no login needed for the open-bids list. */
export const NEVADAEPRO_OPEN_BIDS = 'https://nevadaepro.com/bso/view/search/external/advancedSearchBid.xhtml?openBids=true';

/**
 * Each <td> carries its own label in <span class="ui-column-title">, so we map
 * cells by label instead of position — that survives column reordering.
 */
export function parseNevadaEproOpenBids(html: string, pageUrl = NEVADAEPRO_OPEN_BIDS): BidDraft[] {
  const $ = cheerio.load(html);
  const rows = $('table[summary="Bid search results"] tbody tr, tbody[id$="bidResultId_data"] tr');
  const seen = new Set<string>();
  const out: BidDraft[] = [];

  rows.each((_, tr) => {
    const cells: Record<string, string> = {};
    let href: string | null = null;
    $(tr)
      .children('td')
      .each((__, td) => {
        const $td = $(td);
        if (($td.attr('style') ?? '').includes('display:none')) return; // hidden duplicate columns
        const label = clean($td.find('span.ui-column-title').first().text());
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
    out.push({
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
  return out;
}

export const nevadaEproSource: Source = {
  id: 'nevadaepro',
  name: 'NevadaEPro (State Purchasing)',
  homepage: NEVADAEPRO_OPEN_BIDS,
  async fetch(ctx) {
    // The first page lists the 25 newest open bids. Daily scans catch new ones as they appear.
    const html = await ctx.http.text(NEVADAEPRO_OPEN_BIDS);
    const bids = parseNevadaEproOpenBids(html);
    ctx.log(`nevadaepro: ${bids.length}`);
    return bids;
  },
};
