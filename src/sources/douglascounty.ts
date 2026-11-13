import * as cheerio from 'cheerio';
import type { BidDraft, Source } from '../types.js';
import { detectFlags } from '../util/flags.js';
import { absolutize } from '../util/http.js';
import { findEstimate } from '../util/money.js';
import { clean, htmlToText, humanizeSlug } from '../util/text.js';
import { findDueInText, parseUsDateTime } from '../util/time.js';

/** Douglas County, NV (Minden/Gardnerville) — county RFP & bid table, open + closed rows. */
export const DOUGLAS_URL = 'https://www.douglascountynv.gov/rfp-bids';

/** The legal ad usually starts "SOLICITATION OF BIDS / <Project Name>". Use that when the name cell is empty. */
function titleFromAd(text: string): string | null {
  const lines = text.split('\n').map((l) => clean(l)).filter(Boolean);
  const i = lines.findIndex((l) => /^(solicitation of bids|advertisement for bids|invitation to bid|request for proposals?)$/i.test(l));
  const candidate = i >= 0 ? lines[i + 1] : undefined;
  return candidate && candidate.length < 140 ? candidate : null;
}

export function parseDouglasRfp(html: string, opts: { includeClosed?: boolean; pageUrl?: string } = {}): BidDraft[] {
  const $ = cheerio.load(html);
  const pageUrl = opts.pageUrl ?? DOUGLAS_URL;
  const out: BidDraft[] = [];

  $('#rfp-table tbody tr.rfp-item, table.open-bid tbody tr.rfp-item').each((_, tr) => {
    const $tr = $(tr);
    const status = clean($tr.find('td.status').text()).toLowerCase();
    const isOpen = $tr.hasClass('s-open') || status === 'open';
    if (!isOpen && !opts.includeClosed) return;

    const tds = $tr.children('td');
    const href = absolutize($tr.find('a[href*="/rfp-bids/"], a[href*="r_f_p__b_i_d_s"]').last().attr('href'), pageUrl);
    if (!href) return;
    const slug = new URL(href).pathname.split('/').filter(Boolean).pop() ?? href;
    const descText = htmlToText(tds.eq(2).html());

    const title = clean(tds.eq(0).text()) || titleFromAd(descText) || humanizeSlug(slug);
    const deadlineCell = clean($tr.find('td.deadline-date').text());

    out.push({
      source: 'douglascounty',
      sourceId: slug,
      sourceName: 'Douglas County, NV',
      title,
      agency: 'Douglas County, NV',
      description: descText || null,
      category: isOpen ? 'County bid' : 'County bid (closed)',
      location: { county: 'Douglas', state: 'NV' },
      postedAt: parseUsDateTime(clean($tr.find('td.posted-date').text()), { defaultTime: [8, 0] }),
      // The legal-ad text has the real bid-opening time; the table's "Deadline" is sometimes just the posting end date.
      dueAt: findDueInText(descText) ?? parseUsDateTime(deadlineCell),
      estValue: findEstimate(descText),
      naics: null,
      setAside: null,
      url: href,
      flags: detectFlags(descText),
    });
  });
  return out;
}

export const douglasCountySource: Source = {
  id: 'douglascounty',
  name: 'Douglas County, NV',
  homepage: DOUGLAS_URL,
  async fetch(ctx) {
    const bids = parseDouglasRfp(await ctx.http.text(DOUGLAS_URL));
    ctx.log(`douglascounty: ${bids.length} open`);
    return bids;
  },
};
