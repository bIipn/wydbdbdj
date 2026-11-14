import type { BidDraft, BidLocation, Source } from '../types.js';
import { FLAGS } from './flags.js';
import { NAMES_WORK, soqlDayBefore } from './laramp.js';
import { isTradeWork } from './relevance.js';
import { readSocrata, type SocrataQuery } from './socrata.js';
import { detectFlags } from '../util/flags.js';
import { findEstimate } from '../util/money.js';
import { clean, cleanOrNull, htmlToText, slugify, truncate } from '../util/text.js';
import { parseUsDateTime } from '../util/time.js';

/**
 * The City Record Online (NYC's official journal of procurement notices), as the City publishes it on its Socrata portal:
 * data.cityofnewyork.us dataset dg92-zbpx. 1.1 million rows, almost all personnel changes: only section_name
 * 'Procurement' with type_of_notice_description 'Solicitation' is a bid a contractor can answer.
 *
 * COLUMNS (GET https://data.cityofnewyork.us/api/views/dg92-zbpx/columns.json, 2026-11-14), the ones read here:
 * request_id number (the notice) · start_date, end_date calendar_date (when the notice runs in the paper) · agency_name ·
 * type_of_notice_description (Award, Solicitation, Public Hearings, Notice, Intent to Award, Meeting …) ·
 * category_description (Goods; Services (other than human services); Human Services/Client Services;
 * Construction/Construction Services; Goods and Services; Construction Related Services) · short_title ·
 * selection_method_description (Competitive Sealed Bids, Request for Qualifications, Request for Information …) ·
 * section_name (Changes in Personnel 966,909; Procurement 105,693; …) · pin (the agency's procurement number: the same
 * across re-publications) · due_date calendar_date · additional_description_1 (HTML) · document_links url.
 * On 2026-11-14 the Procurement rows with a due date after that day: 198 Solicitation, 5 Intent to Award.
 *
 * TIMES: due_date is a floating timestamp in New York wall clock (hours seen: 16:00, 17:00, 14:00, 10:00, 11:00, 23:59),
 * read as America/New_York. A due date in 2090 or later (2999-12-31, 2099-12-31: a pre-qualified list that takes
 * applications at any time) is a placeholder: dueAt null and the card says "open list".
 * WHAT IS KEPT: Solicitation notices (an RFI kept with the RFI flag), not a cancellation, not an open list whose notice
 * is more than 18 months old (DDC's 2015 roofing lists due "2999" were re-issued as PQL000123 …), not Human
 * Services/Client Services (the board's
 * own category: social services, never trade work), "Goods" only when the title names work (laramp.ts NAMES_WORK: a
 * purchase of "Air Conditioners (Window & In-Wall)" is not a job), then isTradeWork on the title with the board's category. One card
 * per agency + PIN: the newest notice wins (the Parks site-work PQL is re-published every year under a new request_id).
 * PLACE: New York, NY, unless the notice text gives the work site with a ZIP after a "LOCATION:" label (NYC Health +
 * Hospitals: "LOCATION: Jacobi Medical Center, 1400 Pelham Parkway South, Bronx, NY 10461") — then that ZIP and its
 * borough. Never the agency's office address (address_to_request), which is where documents are picked up.
 * CARD: https://a856-cityrecord.nyc.gov/RequestDetail/<request_id>, the notice on City Record Online. PATTERN, NOT
 * FETCHED: that host refuses this machine's proxy (CONNECT 403, 2026-11-14); the dataset's own document_links point
 * at the same host (https://a856-cityrecord.nyc.gov/Search/GetFile?…&RequestID=<request_id>&…).
 * robots.txt (data.cityofnewyork.us, 2026-11-14): "User-agent: * / Crawl-delay: 1"; Disallow only /browse?…,
 * /api/odata/, /api/collocate* and similar: /resource/ is allowed.
 */

export const NYC_HOST = 'data.cityofnewyork.us';
export const NYC_DATASET = 'dg92-zbpx';
const NAME = 'NYC City Record';
const ZONE = 'America/New_York';
const PLACEHOLDER_YEAR = 2090;
/** An open list (placeholder due date) whose notice is older than this is stale: DDC's 2015 lists were re-issued as PQLs. */
const OPEN_LIST_MAX_AGE_MS = 548 * 86_400_000; // 18 months

export const nycNoticeUrl = (requestId: string): string =>
  `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(requestId)}`;

export interface NycRow {
  request_id?: string;
  start_date?: string;
  end_date?: string;
  agency_name?: string;
  type_of_notice_description?: string;
  category_description?: string;
  short_title?: string;
  selection_method_description?: string;
  section_name?: string;
  pin?: string;
  due_date?: string;
  additional_description_1?: string;
}

/** E-mail addresses and US phone numbers out of a notice text (the notice itself, linked from the card, keeps them). */
export function stripContacts(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[e-mail in the notice]')
    .replace(/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}\b/g, '[phone in the notice]');
}

/**
 * Only the columns the parser reads: the contact columns (names, phones, e-mails) are never selected. The notice
 * TEXT (additional_description_1) can still name a contact person ("…please contact <a name> at (718) …",
 * "…<name>@parks.nyc.gov"): stripContacts() takes the e-mail addresses and phone numbers out of what we store; the
 * card links to the notice, which has them.
 */
const SELECT = [
  'request_id', 'start_date', 'end_date', 'agency_name', 'type_of_notice_description', 'category_description',
  'short_title', 'selection_method_description', 'section_name', 'pin', 'due_date', 'additional_description_1',
].join(', ');

export function nycQuery(now: Date): SocrataQuery {
  return {
    host: NYC_HOST,
    dataset: NYC_DATASET,
    select: SELECT,
    where: `section_name = 'Procurement' AND type_of_notice_description = 'Solicitation' AND due_date > '${soqlDayBefore(now)}'`,
    order: 'request_id',
  };
}

/** City Record text carries 0x1A where an apostrophe or a dash was ("PQL\x1As", "PROPOSAL \x1A SCHOOL"). */
export function nycText(s: string | null | undefined): string {
  return clean((s ?? '').replace(/ \x1A /g, ' – ').replace(/\x1A/g, "'"));
}

/** A PIN that names a procurement ("82627B0019", "PQL000154"), not "N/A", "NoPINFound" or "Emergency Solicitati". */
export function nycPin(pin: string | null | undefined): string | null {
  const p = clean(pin).replace(/[.,;:]+$/, '');
  return /^[A-Za-z0-9][A-Za-z0-9_.\-/#]{3,}$/.test(p) && /\d/.test(p) && !/^nopinfound$/i.test(p) ? p : null;
}

/** "Bid Extension: Jacobi …" → title "Jacobi …", note "Bid extension" (also Correction, Cancellation). */
export function nycTitle(raw: string | null | undefined): { title: string; note: string | null } {
  const t = nycText(raw);
  const m = /^(bid extension|extension|correction|bid cancellation|cancellation)\s*:\s*(.+)$/i.exec(t);
  if (!m) return { title: t, note: null };
  const word = m[1]!.toLowerCase();
  return { title: m[2]!.trim(), note: word.charAt(0).toUpperCase() + word.slice(1) };
}

const BOROUGHS = /\b(Bronx|Brooklyn|Queens|Staten Island|Manhattan|New York|Long Island City|Flushing|Jamaica|Astoria)\b/i;

/** The work site, only when the notice labels it "LOCATION:" and gives a NYC ZIP. */
export function nycSite(text: string): Partial<BidLocation> {
  const m = /\blocation\s*:\s*([^\n]{0,200}?)\b(1[01]\d{3})\b/i.exec(text);
  if (m) {
    const boro = BOROUGHS.exec(m[1]!)?.[1];
    return { zip: m[2]!, state: 'NY', city: boro ? clean(boro) : null };
  }
  return { city: 'New York', state: 'NY' };
}

export interface ParsedNyc {
  bids: BidDraft[];
  read: number;
  notOpen: number;
  notTrade: number;
  /** Older notices of a PIN that has a newer one. */
  replaced: number;
}

export function parseNycRecord(rows: readonly NycRow[], now: Date): ParsedNyc {
  const out: ParsedNyc = { bids: [], read: 0, notOpen: 0, notTrade: 0, replaced: 0 };
  const byKey = new Map<string, { draft: BidDraft; request: number }>();
  for (const r of rows) {
    const requestId = clean(r.request_id);
    const { title, note } = nycTitle(r.short_title);
    if (!requestId || !title) continue;
    out.read++;
    const due = clean(r.due_date);
    const placeholder = Number(due.slice(0, 4)) >= PLACEHOLDER_YEAR;
    const dueAt = placeholder ? null : parseUsDateTime(due, { timeZone: ZONE, defaultTime: [23, 59] });
    const postedAt = parseUsDateTime(r.start_date, { timeZone: ZONE, defaultTime: [0, 0] });
    if (clean(r.section_name) !== 'Procurement' || clean(r.type_of_notice_description) !== 'Solicitation'
      || (!placeholder && (!dueAt || Date.parse(dueAt) <= now.getTime()))
      || (placeholder && (!postedAt || now.getTime() - Date.parse(postedAt) > OPEN_LIST_MAX_AGE_MS))
      || /\bcancel+ation\b|\bcancel+ed\b/i.test(`${note ?? ''} ${title}`)) {
      out.notOpen++;
      continue;
    }
    const category = cleanOrNull(r.category_description);
    const text = nycText(htmlToText(r.additional_description_1));
    // The title and the board's category decide; the notice text is boilerplate-heavy ("released through PASSPort…").
    if (/^human services/i.test(category ?? '') || (category === 'Goods' && !NAMES_WORK.test(title))
      || !isTradeWork({ title, category }).keep) {
      out.notTrade++;
      continue;
    }
    const agency = cleanOrNull(r.agency_name);
    const method = cleanOrNull(r.selection_method_description);
    const pin = nycPin(r.pin);
    const draft: BidDraft = {
      source: 'nycrecord',
      sourceId: pin ? `${slugify(agency ?? 'nyc')}-${pin}` : requestId,
      sourceName: NAME,
      title,
      agency: !agency ? 'City of New York' : /^(nyc|new york)\b/i.test(agency) ? agency : `NYC ${agency}`,
      description: [
        [note, agency, category, method, pin ? `PIN ${pin}` : null, placeholder ? 'No closing date listed: an open list' : null]
          .filter(Boolean).join(' · '),
        text ? truncate(stripContacts(text), 700) : null,
      ].filter(Boolean).join('\n'),
      category,
      location: nycSite(text),
      postedAt,
      dueAt,
      estValue: findEstimate(`${title} ${text}`),
      naics: null,
      setAside: null,
      url: nycNoticeUrl(requestId),
      flags: [...detectFlags(`${title} ${text}`), ...(/request for information/i.test(method ?? '') ? [FLAGS.rfi] : [])],
      solNumber: pin,
    };
    const request = Number(requestId);
    const prev = byKey.get(draft.sourceId);
    if (prev) out.replaced++;
    if (!prev || request > prev.request) byKey.set(draft.sourceId, { draft, request });
  }
  out.bids = [...byKey.values()].map((v) => v.draft);
  return out;
}

export const nycRecordSource: Source = {
  id: 'nycrecord',
  name: NAME,
  homepage: 'https://a856-cityrecord.nyc.gov/',
  states: ['NY'],
  timeZone: ZONE,
  group: 'east',
  async fetch(ctx) {
    const { rows, pages } = await readSocrata<NycRow>(ctx, 'nycrecord', nycQuery(ctx.now));
    if (rows.length > 0 && !rows.some((r) => clean(r.request_id) && clean(r.short_title))) {
      throw new Error(`nycrecord: ${rows.length} rows but none with a request_id and a short_title (columns renamed?)`);
    }
    // ~200 open solicitations on 2026-11-14 (and dozens of standing pre-qualified lists): none means the filter broke.
    if (rows.length === 0) throw new Error("nycrecord: no Procurement 'Solicitation' rows with a future due_date (columns or values changed?)");
    const p = parseNycRecord(rows, ctx.now);
    ctx.log(
      `nycrecord: ${p.read} solicitations listed in ${pages} page(s), ${p.bids.length} kept, ${p.replaced} older notices of the same PIN, ` +
        `${p.notOpen} closed, ${p.notTrade} left out as not trade work`,
    );
    return p.bids;
  },
};
