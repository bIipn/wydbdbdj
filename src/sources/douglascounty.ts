import * as cheerio from 'cheerio';
import type { BidDraft, Source } from '../types.js';
import { detectFlags } from '../util/flags.js';
import { absolutize } from '../util/http.js';
import { findEstimate } from '../util/money.js';
import { clean, htmlToText, humanizeSlug } from '../util/text.js';
import { findDue, pacificParts, parseUsDateTime } from '../util/time.js';

/** Douglas County, NV (Minden/Gardnerville) — county RFP & bid table, open + closed rows. */
export const DOUGLAS_URL = 'https://www.douglascountynv.gov/rfp-bids';

const OPEN = 'County bid';
const CLOSED = 'County bid (closed)';
/** Shown where the county's page has an e-mail address (we don't decode what the county chose to hide from scrapers). */
const EMAIL_HIDDEN = '(e-mail address on the county page)';

export interface DouglasOpts {
  /** "Now" for the open/closed decision. Needed for the raw page: its rows carry no status. */
  now?: Date;
  includeClosed?: boolean;
  pageUrl?: string;
}

export interface DouglasPage {
  /** false = the bid table is not in the HTML at all (layout change, error page). */
  tableFound: boolean;
  /** tr.rfp-item rows in the table, readable or not. */
  rows: number;
  /** Every readable row in page order, open and closed. */
  bids: BidDraft[];
  open: BidDraft[];
  /** Rows where the legal ad overruled the county's deadline cell — worth a log line. */
  notes: string[];
}

/** The legal ad usually starts "SOLICITATION OF BIDS / <Project Name>". Use that when the name cell is empty. */
function titleFromAd(text: string): string | null {
  const lines = text.split('\n').map((l) => clean(l)).filter(Boolean);
  const i = lines.findIndex((l) => /^(solicitation of bids|advertisement for bids|invitation to bid|request for proposals?)$/i.test(l));
  const candidate = i >= 0 ? lines[i + 1] : undefined;
  return candidate && candidate.length < 140 ? candidate : null;
}

/** Pacific calendar day of an instant as a sortable number: Nov 20, 2026 → 20261120. */
function pacificDay(at: Date): number {
  const p = pacificParts(at);
  return p.y * 10_000 + p.mo * 100 + p.d;
}

/**
 * The county's own rule. The server sends every row with an empty td.status; a script in the page fills
 * it in the browser: "Open" only while td.deadline-date is after today, "Close" from the deadline day on.
 */
function countyListsOpen(cellDue: string | null, now: Date): boolean {
  return cellDue !== null && pacificDay(new Date(cellDue)) > pacificDay(now);
}

export function parseDouglasPage(html: string, opts: DouglasOpts = {}): DouglasPage {
  const $ = cheerio.load(html);
  const pageUrl = opts.pageUrl ?? DOUGLAS_URL;
  const $rows = $('#rfp-table tbody tr.rfp-item, table.open-bid tbody tr.rfp-item');
  const page: DouglasPage = { tableFound: $('#rfp-table, table.open-bid').length > 0, rows: $rows.length, bids: [], open: [], notes: [] };

  $rows.each((_, tr) => {
    const $tr = $(tr);
    const tds = $tr.children('td');
    const href = absolutize($tr.find('a[href*="/rfp-bids/"], a[href*="r_f_p__b_i_d_s"]').last().attr('href'), pageUrl);
    if (!href) return;
    const slug = new URL(href).pathname.split('/').filter(Boolean).pop() ?? href;
    // Raw HTML: Cloudflare swaps every e-mail address for "[email protected]"; only a browser script puts it back.
    tds.eq(2).find('.__cf_email__, [data-cfemail]').replaceWith(EMAIL_HIDDEN);
    const descText = htmlToText(tds.eq(2).html());
    const deadlineCell = clean($tr.find('td.deadline-date').text());
    const cellDue = parseUsDateTime(deadlineCell);
    // The legal-ad text has the real bid-opening time; the table's "Deadline" is sometimes just the posting end date.
    // An ad without a year ("on or before 2:00 pm Thursday, June 20th") takes the year nearest the deadline cell.
    const ad = findDue(descText, { near: cellDue });
    const adDue = ad?.iso ?? null;

    const status = clean($tr.find('td.status').text()).toLowerCase();
    let isOpen: boolean;
    if ($tr.hasClass('s-open') || status === 'open') {
      isOpen = true; // page saved from a browser: the county's script already stamped the row
    } else if ($tr.hasClass('s-close') || status === 'close' || status === 'closed') {
      isOpen = false;
    } else {
      if (!opts.now) throw new Error('Douglas County rows have no Open/Close status (raw server HTML): pass opts.now');
      // Raw page: our call. A due time stated in the ad decides: open until that moment, closed after it.
      // The deadline cell alone can be early (Jobs Peak PLC: cell 7/20 = pre-bid meeting, bids due 7/30 2 PM)
      // or late (posting end), and a bid must never show as open past its real due time.
      // No time in the ad → the county's rule (closed from the due day on), on the ad's date if it gives one.
      const county = countyListsOpen(cellDue, opts.now);
      isOpen = ad?.hasTime ? Date.parse(ad.iso) > opts.now.getTime() : countyListsOpen(adDue ?? cellDue, opts.now);
      const cell = `deadline cell: ${deadlineCell || 'empty'}`;
      const adSays = ad?.hasTime ? adDue : `${adDue} (date only in the ad, 5 PM assumed)`;
      if (isOpen && !county) page.notes.push(`${slug}: open, the ad says bids are due ${adSays}; the county's page already shows it closed (${cell})`);
      if (!isOpen && county) page.notes.push(`${slug}: closed, the ad says bids were due ${adSays}; the county's page still shows it open (${cell})`);
    }

    const bid: BidDraft = {
      source: 'douglascounty',
      sourceId: slug,
      sourceName: 'Douglas County, NV',
      title: clean(tds.eq(0).text()) || titleFromAd(descText) || humanizeSlug(slug),
      agency: 'Douglas County, NV',
      description: descText || null,
      category: isOpen ? OPEN : CLOSED,
      location: { county: 'Douglas', state: 'NV' },
      postedAt: parseUsDateTime(clean($tr.find('td.posted-date').text()), { defaultTime: [8, 0] }),
      dueAt: adDue ?? cellDue,
      estValue: findEstimate(descText),
      naics: null,
      setAside: null,
      url: href,
      flags: detectFlags(descText),
    };
    page.bids.push(bid);
    if (isOpen) page.open.push(bid);
  });
  return page;
}

/** Open bids (or all rows with `includeClosed`). Pure: pass `now` instead of reading the clock. */
export function parseDouglasRfp(html: string, opts: DouglasOpts = {}): BidDraft[] {
  const page = parseDouglasPage(html, opts);
  return opts.includeClosed ? page.bids : page.open;
}

export const douglasCountySource: Source = {
  id: 'douglascounty',
  name: 'Douglas County, NV',
  homepage: DOUGLAS_URL,
  async fetch(ctx) {
    const page = parseDouglasPage(await ctx.http.text(DOUGLAS_URL), { now: ctx.now });
    // A page we can't read must show up as FAILED in the scan report, never as "0 bids". The table always
    // carries dozens of past bids, so "no rows" means the page changed. (0 open of 90 rows is a normal day.)
    if (!page.tableFound) throw new Error('bid table (#rfp-table) not found (layout change or error page?)');
    if (page.rows === 0) throw new Error('bid table has no rfp-item rows (layout change?)');
    if (page.bids.length === 0) throw new Error(`${page.rows} rows listed but none could be read (no "View Details" links?)`);
    for (const note of page.notes) ctx.log(`douglascounty: ${note}`);
    const unread = page.rows - page.bids.length;
    ctx.log(`douglascounty: ${page.open.length} open of ${page.rows} rows${unread ? ` (${unread} unreadable)` : ''}`);
    return page.open;
  },
};
