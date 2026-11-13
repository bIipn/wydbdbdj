import * as cheerio from 'cheerio';
import type { BidDraft, FetchLike, Source } from '../types.js';
import { absolutize } from '../util/http.js';
import { clean, cleanOrNull, slugify } from '../util/text.js';
import { parseUsDateTime } from '../util/time.js';

/**
 * Nevada Government eMarketplace (NGEM), hosted on IonWave. One public list covers
 * Carson City, Washoe/Reno agencies, UNR/TMCC (BCN Purchasing), Clark County, etc.
 */
export const NGEM_URL = 'https://nevada.ionwave.net/SourcingEvents.aspx?SourceType=1';

/** Never walk more pages than this, whatever the pager claims. */
const MAX_PAGES = 8;

/**
 * Cookies the first GET sets and every postback must carry. A postback without them gets the
 * "An error has occurred" page AND files an error report with the board's administrators.
 */
const SESSION_COOKIES = ['ASP.NET_SessionId', '__AntiXsrfToken'];

const COLS = ['colBidNumber', 'colTitle', 'colTypeTitle', 'colWorkGroupName', 'colOpenDate', 'colCloseDate'] as const;
type Col = (typeof COLS)[number];
const FALLBACK_INDEX: Record<Col, number> = {
  colBidNumber: 1, colTitle: 2, colTypeTitle: 3, colWorkGroupName: 4, colOpenDate: 5, colCloseDate: 6,
};
/** Visible header text — the last clue before the fixed positions. */
const LABELS: Record<string, Col> = {
  'bid number': 'colBidNumber', 'bid title': 'colTitle', 'bid type': 'colTypeTitle',
  organization: 'colWorkGroupName', 'bid issue date': 'colOpenDate', 'bid close date/time': 'colCloseDate',
};
const isCol = (s: string | undefined): s is Col => (COLS as readonly string[]).includes(s ?? '');

export interface NgemPager {
  /** Page the grid is showing (1-based); null when there is no pager. */
  current: number | null;
  totalPages: number | null;
  /** "46 items in 3 pages" → 46. */
  totalItems: number | null;
  /** Page number → the __doPostBack target of its pager link. Empty on a browser-saved page. */
  targets: Record<number, string>;
}

export interface NgemPage {
  bids: BidDraft[];
  pager: NgemPager;
  /** false = no bid grid in the HTML at all (layout change, error page). */
  tableFound: boolean;
  /** Data rows in the grid, parsed or not. */
  rows: number;
  /** Columns the header did not name; they were read from their usual position instead. */
  guessedColumns: string[];
  /** IonWave's "An error has occurred" page. It arrives with HTTP 200, so the status can't tell. */
  errorPage: boolean;
}

const grid = ($: cheerio.CheerioAPI) => $('table.rgMasterTable').first();

/**
 * Which column a header cell is. The browser adds aria-label="colBidNumber"; the raw server HTML
 * only has the sort link — Grid.Sort(…, 'BidNumber') — and the visible label.
 */
function columnOf(ariaLabel: string | undefined, onclick: string | undefined, label: string): Col | undefined {
  const sort = /Grid\.Sort\(.*,\s*'(\w+)'\s*\)/.exec(onclick ?? '')?.[1];
  return [ariaLabel, sort && `col${sort}`, LABELS[clean(label).toLowerCase()]].find(isCol);
}

function readPager($: cheerio.CheerioAPI): NgemPager {
  const row = grid($).find('tr.rgPager').first();
  const pager: NgemPager = { current: null, totalPages: null, totalItems: null, targets: {} };
  row.find('.rgNumPart a').each((_, a) => {
    const n = Number(/^Go to Page (\d+)$/i.exec($(a).attr('title') ?? '')?.[1] ?? clean($(a).text()));
    if (!Number.isInteger(n) || n < 1) return; // the "..." links of a long pager
    if ($(a).hasClass('rgCurrentPage')) pager.current = n;
    const target = /__doPostBack\('([^']+)'/.exec($(a).attr('href') ?? '')?.[1];
    if (target) pager.targets[n] = target;
  });
  const info = /([\d,]+)\s+items?\s+in\s+([\d,]+)\s+pages?/i.exec(clean(row.find('.rgInfoPart').text()));
  if (info) {
    pager.totalItems = Number(info[1]!.replace(/,/g, ''));
    pager.totalPages = Number(info[2]!.replace(/,/g, ''));
  }
  return pager;
}

const readErrorPage = ($: cheerio.CheerioAPI): boolean =>
  /error has occurred/i.test($('title').text()) || /(^|\/)Error\.aspx/i.test($('form').first().attr('action') ?? '');

/** Where the grid is in its paging: current page, totals, and the postback target of each page link. */
export function parseNgemPager(html: string): NgemPager {
  return readPager(cheerio.load(html));
}

/** True for IonWave's error page (what a postback gets when the server does not like it). */
export function isNgemErrorPage(html: string): boolean {
  return readErrorPage(cheerio.load(html));
}

/**
 * The form body that asks the grid for another page: every hidden field of the page's form
 * (__VIEWSTATE and friends) plus the pager link's target. null when the page has no such form.
 */
export function buildNgemPostback(html: string, target: string): string | null {
  const $ = cheerio.load(html);
  const body = new URLSearchParams();
  $('form').first().find('input[type="hidden"]').each((_, el) => {
    const name = $(el).attr('name');
    if (name) body.append(name, $(el).attr('value') ?? '');
  });
  if (!body.has('__VIEWSTATE')) return null;
  body.set('__EVENTTARGET', target);
  body.set('__EVENTARGUMENT', '');
  return body.toString();
}

export function parseNgemPage(html: string, pageUrl = NGEM_URL): NgemPage {
  const $ = cheerio.load(html);
  const table = grid($);

  // Map columns from the header so a layout change doesn't silently shift fields.
  const index: Record<Col, number> = { ...FALLBACK_INDEX };
  const named = new Set<Col>();
  table.find('thead tr').first().children('th').each((i, th) => {
    const link = $(th).find('a').first();
    const key = columnOf($(th).attr('aria-label'), link.attr('onclick'), link.text() || $(th).text());
    if (!key || named.has(key)) return;
    index[key] = i;
    named.add(key);
  });

  const trs = table.find('tbody > tr.rgRow, tbody > tr.rgAltRow');
  const bids: BidDraft[] = [];
  trs.each((_, tr) => {
    const tds = $(tr).children('td');
    const cell = (k: Col) => clean(tds.eq(index[k]).text());
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

  return {
    bids,
    pager: readPager($),
    tableFound: table.length > 0,
    rows: trs.length,
    guessedColumns: COLS.filter((c) => !named.has(c)),
    errorPage: readErrorPage($),
  };
}

/**
 * One POST for page `want`, built from the page before it. Returns the answer, or the reason
 * paging has to stop. Never re-sent, whatever comes back (the http helper does not retry a POST either).
 */
async function postForPage(
  session: FetchLike | undefined,
  prevHtml: string,
  prev: NgemPager,
  want: number,
): Promise<{ html: string; page: NgemPage } | string> {
  if (want > MAX_PAGES) return `${MAX_PAGES}-page cap`;
  if (!session?.cookieNames) return 'no cookie session';
  const held = session.cookieNames(NGEM_URL);
  if (!SESSION_COOKIES.every((c) => held.includes(c))) return 'session cookies missing';
  const target = prev.targets[want];
  const body = target ? buildNgemPostback(prevHtml, target) : null;
  if (!body) return `no postback link for page ${want}`;

  let html: string;
  try {
    html = await session.text(NGEM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    return `page ${want} failed (${err instanceof Error ? err.message : String(err)})`;
  }
  const page = parseNgemPage(html);
  if (page.errorPage) return `error page instead of page ${want}`;
  if (!page.tableFound) return `no bid grid in the answer for page ${want}`;
  if (page.pager.current !== want) return `asked for page ${want}, got page ${page.pager.current ?? '?'}`;
  return { html, page };
}

export const ngemSource: Source = {
  id: 'ngem',
  name: 'NGEM (local agencies)',
  homepage: NGEM_URL,
  async fetch(ctx) {
    // The grid pages by ASP.NET postback: a POST of the page's hidden fields, tied to the cookies
    // of the first GET. (The "…ChangePage=2_20" links a browser shows just return page 1 again.)
    const session = ctx.http.session?.();
    let html = await (session ?? ctx.http).text(NGEM_URL);
    const first = parseNgemPage(html);

    // A page we can't read must show up as FAILED in the scan report, never as "0 bids".
    if (first.errorPage) throw new Error('the board answered with its "An error has occurred" page');
    if (!first.tableFound) throw new Error('bid grid not found (layout change or error page?)');
    if (first.rows === 0) throw new Error('bid grid has no rows');
    if (first.bids.length === 0) throw new Error(`${first.rows} rows listed on page 1 but none could be read`);
    if (!first.bids.some((b) => b.dueAt)) throw new Error('no close date could be read (columns moved?)');
    if (first.guessedColumns.length) ctx.log(`ngem: header does not name ${first.guessedColumns.join(', ')} — read by position`);

    const byId = new Map(first.bids.map((b) => [b.sourceId, b]));
    let pager = first.pager;
    let rows = first.rows;
    let pagesRead = 1;
    let stop = pager.totalPages ? '' : 'pager not found';

    // Pages 2..N: stop at the first thing that looks wrong and keep what we have.
    while (pagesRead < (pager.totalPages ?? 1)) {
      const want = pagesRead + 1;
      const next = await postForPage(session, html, pager, want);
      if (typeof next === 'string') {
        stop = next;
        break;
      }
      const before = byId.size;
      for (const b of next.page.bids) byId.set(b.sourceId, b);
      if (byId.size === before) {
        stop = `page ${want} added nothing new`;
        break;
      }
      html = next.html;
      pager = next.page.pager;
      rows += next.page.rows;
      pagesRead = want;
    }

    ctx.log(
      `ngem: ${byId.size} of ${pager.totalItems ?? '?'} listed (pages ${pagesRead}/${pager.totalPages ?? '?'})` +
        (rows !== byId.size ? `, ${rows} rows read` : '') +
        (stop ? ` — stopped: ${stop}` : ''),
    );
    return [...byId.values()];
  },
};
