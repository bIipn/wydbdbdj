import * as cheerio from 'cheerio';
import type { BidDraft, Source } from '../types.js';
import { detectFlags } from '../util/flags.js';
import { clean, cleanOrNull } from '../util/text.js';
import { parseUsDateTime } from '../util/time.js';
import { FLAGS } from './flags.js';
import { keepTradeWork } from './relevance.js';

/**
 * California State Contracts Register: every state department's open events (Cal eProcure).
 *
 * The list: GET CALEPROCURE_GRID_URL (below) with Referer CALEPROCURE_REFERER, cookies kept. The PeopleSoft server
 * answers the bare URL with a 302 to the same URL plus "&" and sets its session cookies; the 200 behind it is a
 * 1.18 MB "Response Bid Inquiry" page whose grid holds every posted event at once ("1-376 of 376" on 2026-11-14,
 * no paging). caleprocure.ca.gov itself answers 403 to the scanner's host (any User-Agent, robots.txt included),
 * so we read the list from suppliers.fiscal.ca.gov (no robots.txt there: /robots.txt is a 404) and the cards
 * link to the public event page on caleprocure.ca.gov: https://caleprocure.ca.gov/event/<dept>/<event id>.
 *
 * Cells are found by their PeopleSoft element ids, one per row index i (the same ids on every row):
 *   RESP_INQA1_WK_BUSINESS_UNIT$i     department code ("6530")
 *   BUS_UNIT_TBL_FS_DESCR$201$$i      department name ("UCLA")
 *   AUC_ID_COL$i                      event id ("0000040760"), the link that opens the event
 *   RESP_INQA1_WK_ZZ_AUC_NAME$i       event name
 *   RESP_INQA1_WK_AUC_FORMAT_BIDBER$i format: "Sell" (369 of 376 on 2026-11-14) or "RFI" (7; not all info-only)
 *   RESP_INQA1_WK_AUC_TYPE$i          type: "RFx"
 *   RESP_INQA1_WK_AUC_DTTM_FINISH$i   end date, e.g. "11/16/2026 10:00AM PST" (the zone is written: trusted)
 *   ZZ_DERIVED_DESCR254$i             status: "Posted"
 * Fixture: test/fixtures/caleprocure-grid.html (+ .md).
 *
 * The list has no site, county, licence class or description, only the department. A card is placed by what the
 * event NAME states (locate()'s town-in-text step) or else in California only. The event detail (counties, UNSPSC
 * codes, licence) is behind a PeopleSoft postback per event on this host (no GET link in the page) and behind the
 * 403 on caleprocure.ca.gov: not read for now.
 */
export const CALEPROCURE_GRID_URL =
  'https://suppliers.fiscal.ca.gov/psc/psfpd1/SUPPLIER/ERP/c/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?Page=AUC_RESP_INQ_AUC&Action=U';
export const CALEPROCURE_REFERER = 'https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx';
const ZONE = 'America/Los_Angeles';
const NAME = 'Cal eProcure (State of California)';

/** The public event page a contractor reads and bids from. */
export const caleprocureEventUrl = (dept: string, eventId: string): string =>
  `https://caleprocure.ca.gov/event/${encodeURIComponent(dept)}/${encodeURIComponent(eventId)}`;

export interface CaleprocurePage {
  bids: BidDraft[];
  /** Grid rows found (an AUC_ID_COL link), read or not. */
  rows: number;
  /** "1-376 of 376" → 376; null when the counter is missing. */
  total: number | null;
  /** The PeopleSoft sign-in page (a lapsed or refused session) instead of the grid. */
  signIn: boolean;
}

/** Offsets of the zone names the grid writes. */
const ZONE_OFFSETS: Record<string, string> = { PST: '-08:00', PDT: '-07:00' };

/**
 * "11/16/2026 10:00AM PST" → ISO UTC, by the zone it names. With no zone name (never seen), the board's own
 * wall clock (Pacific) through util/time.ts. No time at all (never seen) → the end of that day, 11:59 PM Pacific
 * (the board does not say otherwise, so the rule for a bare date applies).
 */
export function parseCaleprocureEnd(raw: string | null | undefined): string | null {
  const s = clean(raw);
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP])M\s*(PST|PDT)$/i.exec(s);
  if (m) {
    const [mo, d, y, mi] = [m[1]!, m[2]!, m[3]!, m[5]!];
    const h12 = Number(m[4]);
    const pm = m[6]!.toUpperCase() === 'P';
    const h = h12 === 12 ? (pm ? 12 : 0) : pm ? h12 + 12 : h12;
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${String(h).padStart(2, '0')}:${mi}:00${ZONE_OFFSETS[m[7]!.toUpperCase()]}`;
    return parseUsDateTime(iso);
  }
  return parseUsDateTime(s.replace(/\b(PST|PDT|PT)\b/i, ''), { timeZone: ZONE, defaultTime: [23, 59] });
}

/** Pure: the grid HTML → one draft per event (every row, trade work or not: fetch() filters). */
export function parseCaleprocurePage(html: string): CaleprocurePage {
  const $ = cheerio.load(html);
  const cell = (name: string, i: string): string => clean($(`[id="${name}$${i}"]`).first().text());

  const links = $('a[id^="AUC_ID_COL$"]').toArray();
  const seen = new Set<string>();
  const bids: BidDraft[] = [];
  for (const a of links) {
    const i = /^AUC_ID_COL\$(\d+)$/.exec($(a).attr('id') ?? '')?.[1];
    if (i == null) continue;
    const eventId = clean($(a).text());
    const dept = cell('RESP_INQA1_WK_BUSINESS_UNIT', i);
    const title = cell('RESP_INQA1_WK_ZZ_AUC_NAME', i);
    if (!eventId || !dept || !title) continue;
    // One event, one card: the id is the department's, so the pair is the key (stays the same across addenda).
    const sourceId = `${dept}-${eventId}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const deptName = cleanOrNull(cell('BUS_UNIT_TBL_FS_DESCR$201$', i));
    const format = cell('RESP_INQA1_WK_AUC_FORMAT_BIDBER', i);
    const type = cell('RESP_INQA1_WK_AUC_TYPE', i);
    const status = cell('ZZ_DERIVED_DESCR254', i);
    // Format "RFI" is not always information only: UCLA posts "Fire Sprinkler Retrofit … No. 906032" and UC Santa
    // Cruz "RFQ - 3742 Oakes College Housing Capital Improvements" in it. So the "info only, not a bid" flag goes
    // only on an RFI-format event whose name also says it asks for information.
    const rfi = /^rfi$/i.test(format) && /\bRFI\b|request for (?:qualifications and )?information/i.test(title);
    const flags = detectFlags(title);
    if (rfi) flags.push(FLAGS.rfi);

    bids.push({
      source: 'caleprocure',
      sourceId,
      sourceName: NAME,
      title,
      agency: deptName,
      description: [
        deptName ? `${deptName} (department ${dept})` : `Department ${dept}`,
        `Event ${eventId}`,
        [type, format && !/^sell$/i.test(format) ? format : null].filter(Boolean).join(' ') || null,
        status && !/^posted$/i.test(status) ? `Status: ${status}` : null,
      ].filter(Boolean).join(' · '),
      category: rfi ? 'State request for information' : 'State solicitation',
      location: { state: 'CA' },
      postedAt: null,
      dueAt: parseCaleprocureEnd(cell('RESP_INQA1_WK_AUC_DTTM_FINISH', i)),
      estValue: null,
      naics: null,
      setAside: null,
      url: caleprocureEventUrl(dept, eventId),
      flags,
      solNumber: eventId,
    });
  }

  const counter = /\b\d+-\d+\s+of\s+([\d,]+)/.exec($('.PSGRIDCOUNTER').first().text());
  const signIn = $('input[name="pwd"], form[name="login"]').length > 0 || /sign[- ]?in/i.test($('title').text());
  return { bids, rows: links.length, total: counter ? Number(counter[1]!.replace(/,/g, '')) : null, signIn };
}

/** The loud failures: a page we cannot read is FAILED in the scan report, never "0 bids". */
export function checkCaleprocurePage(page: CaleprocurePage): void {
  if (page.signIn) throw new Error('got the PeopleSoft sign-in page instead of the event list (session refused?)');
  if (page.rows === 0) throw new Error('no event rows (AUC_ID_COL) in the page (layout change, error or challenge page?)');
  if (page.bids.length === 0) throw new Error(`${page.rows} event rows but none could be read (ids changed?)`);
  if (page.total != null && page.total > page.rows) {
    throw new Error(`the board announces ${page.total} events but the page holds ${page.rows} rows (paging appeared?)`);
  }
}

export const caleprocureSource: Source = {
  id: 'caleprocure',
  name: NAME,
  homepage: CALEPROCURE_REFERER,
  states: ['CA'],
  timeZone: ZONE,
  group: 'west',
  async fetch(ctx) {
    // One session: the 302 sets the PeopleSoft cookies and the 200 behind it needs them.
    const http = ctx.http.session?.() ?? ctx.http;
    const html = await http.text(CALEPROCURE_GRID_URL, { headers: { Referer: CALEPROCURE_REFERER } });
    const page = parseCaleprocurePage(html);
    checkCaleprocurePage(page);
    const { kept, left } = keepTradeWork(page.bids, (b) => ({ title: b.title, description: b.description, category: b.category }));
    ctx.log(
      `caleprocure: ${page.bids.length} events read${page.total != null ? ` (board lists ${page.total})` : ''}, ` +
        `${kept.length} kept, ${left} left out as not trade work`,
    );
    return kept;
  },
};
