import * as cheerio from 'cheerio';
import { COUNTY_SEATS } from '../geo/places.js';
import { lookupCity } from '../geo/zip.js';
import type { BidDraft, BidLocation, FetchLike, Source, SourceContext, SourceId } from '../types.js';
import { absolutize } from '../util/http.js';
import { clean, cleanOrNull } from '../util/text.js';
import { parseUsDateTime, PACIFIC } from '../util/time.js';
import { outOfTime, stopAtBudget } from './budget.js';
import { isTradeWork } from './relevance.js';

/**
 * Periscope BuySpeed ("BSO") public bid boards: the same software, the same page, on several state hosts.
 * One parser for all of them, driven by BUYSPEED_BOARDS. NevadaEPro was the first (src/sources/nevadaepro.ts
 * keeps its old exports and goes through here).
 *
 * The open-bids list is GET https://<host>/bso/view/search/external/advancedSearchBid.xhtml?openBids=true, a
 * PrimeFaces data table of 25 rows with a paginator ("1-25 of 890"). Checked 2026-11-14 with the scanner's
 * User-Agent: oregonbuys.gov (174), www.commbuys.com (890), www.bidbuy.illinois.gov (149), www.njstart.gov (19);
 * same table id (bidSearchResultsForm:bidResultId), same column labels (NJSTART says "Contract #" where the
 * others say "Blanket #"; neither is read).
 *
 * Pages 2+ (worked out on OregonBuys, 2026-11-14, one GET + one POST through a cookie session): a PrimeFaces
 * partial POST of the results form back to the form's action, with the first GET's cookies (JSESSIONID …) and
 * its javax.faces.ViewState. The answer is a <partial-response> XML: the next 25 <tr> rows (data-ri="25"…) in an
 * <update> for the table, a new ViewState, and {"totalRecords":174}. The rows carry no labels, so they are read
 * with the first page's <thead>. See test/fixtures/buyspeed.md.
 */
export interface BuySpeedBoard {
  id: SourceId;
  host: string;
  /** Source.name, and the card's sourceName. */
  label: string;
  /** 2-letter state of the board (every row is placed there unless the row says more). */
  state: string;
  /** The board's wall clock: "Bid Opening Date" cells carry no zone. */
  timeZone: string;
  /** Card category. */
  category: string;
  /**
   * False until the BuySpeed builder has a fixture and tests for this board: fetch() then throws "not built
   * yet" (the scan report says FAILED, never a quiet 0). All five are built.
   */
  ready: boolean;
  /**
   * Leave out rows that are not contractor work (relevance.ts isTradeWork) and the board's notices that are not
   * a bid (sole-source and change-order notices, exempt-procurement reports: BUYSPEED_NOTICE). NevadaEPro: false,
   * it keeps every row as it always has (the pilot's feed, its scores and its tests are unchanged).
   */
  tradeOnly: boolean;
}

export const BUYSPEED_BOARDS: readonly BuySpeedBoard[] = [
  { id: 'nevadaepro', host: 'nevadaepro.com', label: 'NevadaEPro (State Purchasing)', state: 'NV', timeZone: PACIFIC, category: 'State purchase', ready: true, tradeOnly: false },
  { id: 'oregonbuys', host: 'oregonbuys.gov', label: 'OregonBuys (State of Oregon)', state: 'OR', timeZone: 'America/Los_Angeles', category: 'Public purchase', ready: true, tradeOnly: true },
  { id: 'commbuys', host: 'www.commbuys.com', label: 'COMMBUYS (Massachusetts)', state: 'MA', timeZone: 'America/New_York', category: 'Public purchase', ready: true, tradeOnly: true },
  { id: 'bidbuy', host: 'www.bidbuy.illinois.gov', label: 'BidBuy (State of Illinois)', state: 'IL', timeZone: 'America/Chicago', category: 'Public purchase', ready: true, tradeOnly: true },
  { id: 'njstart', host: 'www.njstart.gov', label: 'NJSTART (State of New Jersey)', state: 'NJ', timeZone: 'America/New_York', category: 'State purchase', ready: true, tradeOnly: true },
];

export function buySpeedBoard(id: SourceId): BuySpeedBoard {
  const b = BUYSPEED_BOARDS.find((x) => x.id === id);
  if (!b) throw new Error(`No BuySpeed board "${id}"`);
  return b;
}

/** The open-bids list of a board. */
export const openBidsUrl = (b: Pick<BuySpeedBoard, 'host'>): string =>
  `https://${b.host}/bso/view/search/external/advancedSearchBid.xhtml?openBids=true`;

/** What a page-2+ POST needs from the first page: the results form, its table and its page size. */
export interface BuySpeedForm {
  /** Absolute URL the form posts to. */
  action: string;
  /** The form's hidden fields in page order (bidSearchResultsForm, _csrf, openBids, javax.faces.ViewState). */
  fields: Array<[string, string]>;
  /** The data table's client id, "bidSearchResultsForm:bidResultId". */
  tableId: string;
  /** Rows per page from the DataTable widget config (rows:25), else the rows the first page holds. */
  pageSize: number;
}

/** One results page, plus what fetch() needs to tell "no open bids" from "the page changed". */
export interface BuySpeedPage {
  bids: BidDraft[];
  /** false = the results table is not in the HTML at all (layout change, error page). */
  tableFound: boolean;
  /** Data rows in the table, parsed or not. */
  rows: number;
  /** Open bids the board says it has across all pages, or null when it does not say. */
  total: number | null;
  /** The column label per cell position ('' for the hidden duplicate columns): pages 2+ are read with it. */
  headers: string[];
  /** null when the page has no results form with a ViewState (paging then stops at page 1). */
  form: BuySpeedForm | null;
}

const isHidden = (style: string | undefined): boolean => /display:\s*none/i.test(style ?? '');

/** Paginator text ("1-25 of 29") first, else the PrimeFaces widget config (rowCount:29). */
function announcedTotal($: cheerio.CheerioAPI): number | null {
  const m =
    /\bof\s+([\d,]+)/i.exec($('[id*="bidResultId_paginator"] .ui-paginator-current').first().text()) ??
    /\browCount:\s*(\d+)/.exec($('script[id$="bidResultId_s"]').text());
  return m ? Number(m[1]!.replace(/,/g, '')) : null;
}

/** How many open bids the board announces across all pages. */
export function parseBuySpeedTotal(html: string): number | null {
  return announcedTotal(cheerio.load(html));
}

/**
 * Text the board itself stored double-encoded with the bytes already lost: COMMBUYS 2026-11-14,
 * "on call Ã?Â¢Ã?Â?Ã?Â?backupÃ?Â¢Ã?Â?Ã?Â? electrical" (a curly quote, three times mangled, its bytes now "?").
 * Nothing is left to decode, so the runs are dropped: "on call backup electrical".
 */
export function dropMojibake(s: string): string {
  return clean(s.replace(/(?:Ã.Â.)+/g, ''));
}

/**
 * A listing that names its own place: "City of Salem", "Town of Barnstable", "Quincy Housing Authority" (a
 * town's own body), "Clackamas County". A city is kept only when the nationwide ZIP table knows it in the board's
 * state (never a guess); a county is passed on as named (locate() places counties it has a seat for, else the
 * state, with the county's name as the card's label). Anything else, a state department or a regional
 * authority, says only the state.
 */
const CITY_OF = /^(?:city|town|village|borough|township|municipality)\s+of\s+(?:the\s+)?(.+)$/i;
const TOWN_BODY = /^(.+?)\s+(?:housing authority|public schools|school district(?:\s+\S+)?|municipal light(?:\s+(?:plant|department))?|gas\s*(?:&|and)\s*electric|water department|police department|fire department)$/i;
const COUNTY = /^(?:county of\s+(.+)|(.+?)\s+county)$/i;

export function placeOfOrg(org: string | null | undefined, state: string): Partial<BidLocation> {
  const name = clean(org);
  const city = CITY_OF.exec(name)?.[1] ?? TOWN_BODY.exec(name)?.[1] ?? null;
  if (city) {
    const hit = lookupCity(city, state);
    return hit ? { city: hit.city, state } : { state };
  }
  const m = COUNTY.exec(name);
  if (m) {
    const county = clean(m[1] ?? m[2]);
    // locate() places a county it has a seat for (Nevada, California); any other keeps its name on the card.
    return COUNTY_SEATS[`${state}:${county.toLowerCase()}`] ? { county, state } : { county, state, label: `${county} County, ${state}` };
  }
  return { state };
}

/**
 * Notices the boards list among open bids that nobody can bid on (seen 2026-11-14): "SOLE SOURCE NOTICE …",
 * "Notice of Intent to Award a Sole-Source Contract", "NOT A BID/ OREGON FORWARD Suitability Determination",
 * "CHANGE ORDER NOTICE: …", "Emergency Final Cost …", "Emergency Extension Notice: …", "Exempt Notice - DHS Exempt
 * Procurement Report". Returns the phrase that matched, or null.
 */
const NOTICE =
  /\bsole[- ]source\b|\bnot a bid\b|\bnotice of intent to (?:award|accept)\b|\bchange order notice\b|\bemergency (?:extension notice|final cost)\b|\bexempt (?:notice|procurement report)\b|\bsuitability determination\b/i;

export function buySpeedNotice(title: string): string | null {
  return NOTICE.exec(title)?.[0].toLowerCase() ?? null;
}

/** The column labels by cell position, from the table's <thead> ('' for a hidden duplicate column). */
function readHeaders($: cheerio.CheerioAPI, tbody: ReturnType<cheerio.CheerioAPI>): string[] {
  return tbody
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
}

/** The rows of one page as bids (each bid number once, the first row wins). */
function readRows(
  $: cheerio.CheerioAPI, trs: ReturnType<cheerio.CheerioAPI>, headers: readonly string[], board: BuySpeedBoard, pageUrl: string,
): BidDraft[] {
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
    const desc = cells['Description'] ? dropMojibake(cells['Description']) : '';
    if (!bidNo || !desc || seen.has(bidNo)) return;
    seen.add(bidNo);

    const buyer = cells['Buyer'];
    const alt = cells['Alternate Id'];
    const org = cleanOrNull(cells['Organization Name']);
    bids.push({
      source: board.id,
      sourceId: bidNo,
      sourceName: board.label,
      title: desc,
      agency: org,
      description: [buyer ? `Buyer: ${buyer}` : null, alt ? `Alt ID ${alt}` : null, `Bid ${bidNo}`].filter(Boolean).join(' · '),
      category: board.category,
      location: placeOfOrg(org, board.state),
      postedAt: null,
      // "11/24/2026 5:00 PM": the board's own wall clock (BuySpeedBoard.timeZone), never the server's. Every row
      // seen carries a time; a bare date would be the end of that day on the board's clock.
      dueAt: parseUsDateTime(cells['Bid Opening Date'], { timeZone: board.timeZone, defaultTime: [23, 59] }),
      estValue: null,
      naics: null,
      setAside: null,
      url: href ?? `https://${board.host}/bso/external/bidDetail.sda?docId=${encodeURIComponent(bidNo)}&external=true&parentUrl=close`,
      flags: ['May be supply-only'],
    });
  });
  return bids;
}

/** The results form and what a page-2+ POST needs, or null when the page has none (with a ViewState). */
function readForm($: cheerio.CheerioAPI, tbody: ReturnType<cheerio.CheerioAPI>, pageUrl: string, rowsHere: number): BuySpeedForm | null {
  const form = tbody.closest('form');
  const table = tbody.closest('div.ui-datatable');
  const tableId = table.attr('id') ?? tbody.attr('id')?.replace(/_data$/, '');
  if (!form.length || !tableId) return null;
  const fields: Array<[string, string]> = [];
  form.find('input[type="hidden"]').each((_, el) => {
    const name = $(el).attr('name');
    if (name) fields.push([name, $(el).attr('value') ?? '']);
  });
  if (!fields.some(([n]) => n === 'javax.faces.ViewState')) return null;
  const action = absolutize(form.attr('action'), pageUrl);
  if (!action) return null;
  const rows = /\brows:\s*(\d+)/.exec($(`script[id="${tableId}_s"]`).text());
  return { action, fields, tableId, pageSize: rows ? Number(rows[1]) : rowsHere };
}

/**
 * The server HTML names the columns only in <thead>; the cells are bare
 * (<td role="gridcell">Department of Wildlife</td>), so each cell takes the label of the
 * header at the same position. A page saved from a browser also carries the label inside
 * every cell (<span class="ui-column-title">, added by page JavaScript) — that one wins.
 * Either way we go by label, never by a fixed index, so reordered columns still work.
 * `pageUrl` resolves the rows' relative detail links (default: the board's open-bids list).
 */
export function parseBuySpeedPage(html: string, board: BuySpeedBoard, pageUrl = openBidsUrl(board)): BuySpeedPage {
  const $ = cheerio.load(html);
  const tbody = $('tbody[id$="bidResultId_data"], table[summary="Bid search results"] > tbody').first();
  const headers = readHeaders($, tbody);
  const trs = tbody.children('tr').not('.ui-datatable-empty-message'); // PrimeFaces' "No records found." row
  return {
    bids: readRows($, trs, headers, board, pageUrl),
    tableFound: tbody.length > 0,
    rows: trs.length,
    total: announcedTotal($),
    headers,
    form: tbody.length ? readForm($, tbody, pageUrl, trs.length) : null,
  };
}

/** One page-2+ answer, read. `error` says why it cannot be used (then nothing else counts). */
export interface BuySpeedPartial {
  bids: BidDraft[];
  rows: number;
  /** data-ri of the first row: the offset the board actually answered with. */
  first: number | null;
  total: number | null;
  /** The ViewState for the next request (the board sends a new one with every answer). */
  viewState: string | null;
  error: string | null;
}

const cdata = (s: string): string => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

/** The content of <update id="…"> whose id passes `test`, or null. */
function update(xml: string, test: (id: string) => boolean): string | null {
  for (const m of xml.matchAll(/<update id="([^"]*)">([\s\S]*?)<\/update>/g)) {
    if (test(m[1]!)) return cdata(m[2]!);
  }
  return null;
}

/**
 * A PrimeFaces partial-response (the answer to a page-2+ POST) → that page's bids, read with the first
 * page's `headers`. Pure. A session that expired answers with <redirect>, a server fault with <error>; an HTML
 * page instead of XML is a challenge or error page. Each of those is an `error`, never zero bids.
 */
export function parseBuySpeedPartial(xml: string, board: BuySpeedBoard, headers: readonly string[], tableId: string, pageUrl = openBidsUrl(board)): BuySpeedPartial {
  const none = (error: string): BuySpeedPartial => ({ bids: [], rows: 0, first: null, total: null, viewState: null, error });
  if (!/<partial-response[\s>]/.test(xml)) return none('answer is not a partial-response (HTML page instead?)');
  const redirect = /<redirect\s+url="([^"]*)"/.exec(xml);
  if (redirect) return none('the board redirected the page request (session expired?)');
  const fault = /<error>[\s\S]*?<error-name>([\s\S]*?)<\/error-name>/.exec(xml);
  if (fault || /<error[\s>]/.test(xml)) return none(`the board answered with an error${fault ? ` (${clean(cdata(fault[1]!))})` : ''}`);
  const rowsHtml = update(xml, (id) => id === tableId);
  if (rowsHtml == null) return none('no table rows in the answer');

  const $ = cheerio.load(`<table><tbody>${rowsHtml}</tbody></table>`);
  const trs = $('tbody').first().children('tr').not('.ui-datatable-empty-message');
  const ri = Number(trs.first().attr('data-ri'));
  const args = /<extension ln="primefaces" type="args">([\s\S]*?)<\/extension>/.exec(xml);
  let total: number | null = null;
  if (args) {
    const decoded = cdata(args[1]!).replace(/&#34;|&quot;/g, '"');
    const t = /"totalRecords"\s*:\s*(\d+)/.exec(decoded);
    total = t ? Number(t[1]) : null;
  }
  const viewState = update(xml, (id) => id.includes('javax.faces.ViewState'));
  return {
    bids: readRows($, trs, headers, board, pageUrl),
    rows: trs.length,
    first: Number.isFinite(ri) && trs.length ? ri : null,
    total,
    viewState: viewState?.trim() || null,
    error: null,
  };
}

/** The form body of the PrimeFaces partial request for the rows from `first` (a paginator click). */
export function buySpeedPageBody(form: BuySpeedForm, viewState: string, first: number): string {
  const body = new URLSearchParams();
  for (const [name, value] of form.fields) body.append(name, name === 'javax.faces.ViewState' ? viewState : value);
  const t = form.tableId;
  body.set('javax.faces.partial.ajax', 'true');
  body.set('javax.faces.source', t);
  body.set('javax.faces.partial.execute', t);
  body.set('javax.faces.partial.render', t);
  body.set(t, t);
  body.set(`${t}_pagination`, 'true');
  body.set(`${t}_first`, String(first));
  body.set(`${t}_rows`, String(form.pageSize));
  body.set(`${t}_skipChildren`, 'true');
  body.set(`${t}_encodeFeature`, 'true');
  return body.toString();
}

/** Scan log line for a first page read alone, e.g. "nevadaepro: 25 of 29 listed (first page only)". */
export function summarizeBuySpeed(id: string, page: Pick<BuySpeedPage, 'bids' | 'rows' | 'total'>): string {
  const n = page.bids.length;
  let msg = page.total == null ? `${id}: ${n} listed (total not announced)` : `${id}: ${n} of ${page.total} listed`;
  if (page.total != null && page.total > page.rows) msg += ' (first page only)';
  if (page.rows > n) msg += `, ${page.rows - n} rows skipped`;
  return msg;
}

/** The loud failures: a page fetch() cannot read must end up FAILED in the scan report, never as "0 bids". */
export function checkBuySpeedPage(page: BuySpeedPage): void {
  if (!page.tableFound) throw new Error('results table not found (layout change or error page?)');
  if (page.bids.length === 0 && page.rows > 0) {
    throw new Error(`${page.rows} rows listed but none could be read (columns changed?)`);
  }
  if (page.bids.length === 0 && page.total) {
    throw new Error(`board announces ${page.total} open bids but the table has no rows`);
  }
}

/**
 * At most this many pages a run (1,500 bids). COMMBUYS, the biggest, listed 890 on 2026-11-14: 36 pages.
 * The per-host gap (util/http.ts, 1,000 ms) is the floor between two requests; the scan group's time budget
 * (ctx.deadline) is the real limit.
 */
export const BUYSPEED_MAX_PAGES = 60;

/** The cookie the board ties its ViewState to; a POST without it would only get an error page back. */
const SESSION_COOKIE = 'JSESSIONID';

/** Leave out what a contractor cannot bid on: notices first (they are never a bid), then isTradeWork. */
export function keepBuySpeedTradeWork(bids: readonly BidDraft[]): { kept: BidDraft[]; notices: number; notTrade: number } {
  const kept: BidDraft[] = [];
  let notices = 0;
  let notTrade = 0;
  for (const b of bids) {
    if (buySpeedNotice(b.title)) notices++;
    // The list has no category or commodity codes: the title is all there is.
    else if (!isTradeWork({ title: b.title, board: b.source }).keep) notTrade++;
    else kept.push(b);
  }
  return { kept, notices, notTrade };
}

/**
 * One POST for the rows from `first`. Returns the answer, or the reason paging has to stop. Never re-sent,
 * whatever comes back (util/http.ts does not retry a POST either).
 */
async function postForPage(
  session: FetchLike | undefined, board: BuySpeedBoard, page1: BuySpeedPage, viewState: string | null, first: number,
): Promise<BuySpeedPartial | string> {
  const form = page1.form;
  if (!session?.cookieNames) return 'no cookie session';
  if (!session.cookieNames(openBidsUrl(board)).includes(SESSION_COOKIE)) return 'session cookie missing';
  if (!form || !viewState) return 'no results form with a ViewState on page 1';
  let xml: string;
  try {
    xml = await session.text(form.action, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Faces-Request': 'partial/ajax',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/xml, text/xml, */*; q=0.01',
        Referer: openBidsUrl(board),
      },
      body: buySpeedPageBody(form, viewState, first),
    });
  } catch (err) {
    return `rows from ${first} failed (${err instanceof Error ? err.message : String(err)})`;
  }
  const next = parseBuySpeedPartial(xml, board, page1.headers, form.tableId, form.action);
  if (next.error) return `${next.error}, rows from ${first}`;
  if (next.rows === 0) return `no rows from ${first}`;
  if (next.first !== first) return `asked for rows from ${first}, got rows from ${next.first ?? '?'}`;
  if (next.bids.length === 0) return `${next.rows} rows from ${first} but none could be read`;
  return next;
}

/** Read every page a board lists (first page alone when there is no cookie session). */
async function fetchBuySpeed(board: BuySpeedBoard, ctx: SourceContext): Promise<BidDraft[]> {
  // One session for the whole read: the ViewState of the first GET belongs to its cookies.
  const session = ctx.http.session?.();
  const first = parseBuySpeedPage(await (session ?? ctx.http).text(openBidsUrl(board)), board);
  checkBuySpeedPage(first);

  const byId = new Map(first.bids.map((b) => [b.sourceId, b]));
  let total = first.total;
  let rows = first.rows;
  let pages = 1;
  let stop = '';
  let budget = false;
  const pageSize = first.form?.pageSize ?? first.rows;
  const morePages = total != null && total > first.rows && pageSize > 0;

  if (morePages && session) {
    let viewState = first.form?.fields.find(([n]) => n === 'javax.faces.ViewState')?.[1] ?? null;
    while (pages * pageSize < (total ?? 0)) {
      if (pages >= BUYSPEED_MAX_PAGES) {
        stop = `${BUYSPEED_MAX_PAGES}-page cap`;
        break;
      }
      if (outOfTime(ctx)) {
        stopAtBudget(ctx, board.id, byId.size, total);
        budget = true;
        break;
      }
      const offset = pages * pageSize;
      const next = await postForPage(session, board, first, viewState, offset);
      if (typeof next === 'string') {
        stop = next;
        break;
      }
      const before = byId.size;
      for (const b of next.bids) if (!byId.has(b.sourceId)) byId.set(b.sourceId, b);
      pages++;
      rows += next.rows;
      if (next.total != null) total = next.total;
      viewState = next.viewState ?? viewState;
      if (byId.size === before) {
        stop = `rows from ${offset} added nothing new`;
        break;
      }
    }
  }

  const read = [...byId.values()];
  const totalPages = total != null && pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : null;
  let msg: string;
  if (!session || !morePages) {
    // The old line (no session: a test fake; or everything was on page 1).
    msg = summarizeBuySpeed(board.id, { bids: read, rows, total });
  } else {
    msg = `${board.id}: ${read.length} of ${total ?? '?'} listed (pages ${pages}/${totalPages ?? '?'})`;
    if (rows > read.length) msg += `, ${rows - read.length} rows skipped`;
  }

  let out = read;
  if (board.tradeOnly) {
    const { kept, notices, notTrade } = keepBuySpeedTradeWork(read);
    out = kept;
    msg += `, ${kept.length} kept (${notTrade} not trade work, ${notices} notices that are not a bid)`;
  }
  if (stop) {
    msg += ` — stopped: ${stop}`;
    ctx.partial?.(`${board.id}: stopped: ${stop}, ${read.length} of ${total ?? '?'} read`);
  } else if (budget) {
    msg += ' — stopped at the time budget';
  }
  ctx.log(msg);
  return out;
}

/** A board as a Source. */
export function buySpeedSource(board: BuySpeedBoard, group: string): Source {
  return {
    id: board.id,
    name: board.label,
    homepage: openBidsUrl(board),
    states: [board.state],
    timeZone: board.timeZone,
    group,
    async fetch(ctx) {
      if (!board.ready) throw new Error('not built yet');
      return fetchBuySpeed(board, ctx);
    },
  };
}

/** Every board but NevadaEPro (which src/sources/nevadaepro.ts exports, in the default group). */
export const oregonBuysSource: Source = buySpeedSource(buySpeedBoard('oregonbuys'), 'west');
export const commbuysSource: Source = buySpeedSource(buySpeedBoard('commbuys'), 'east');
export const bidBuySource: Source = buySpeedSource(buySpeedBoard('bidbuy'), 'east');
export const njstartSource: Source = buySpeedSource(buySpeedBoard('njstart'), 'east');
