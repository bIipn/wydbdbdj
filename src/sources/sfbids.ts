import type { BidDraft, BidLocation, Source } from '../types.js';
import { FLAGS } from './flags.js';
import { soqlDayBefore } from './laramp.js';
import { isTradeWork } from './relevance.js';
import { readSocrata, type SocrataQuery } from './socrata.js';
import { detectFlags } from '../util/flags.js';
import { findEstimate } from '../util/money.js';
import { clean, cleanOrNull } from '../util/text.js';
import { parseUsDateTime } from '../util/time.js';

/**
 * City and County of San Francisco, open bid opportunities from SF City Partner (the City's PeopleSoft supplier portal),
 * as published on its Socrata portal: dataset eshn-8t3a. data.sfgov.org answers with a 301 to data.sf.gov, which
 * ctx.http follows; the source asks data.sf.gov directly.
 *
 * COLUMNS (GET https://data.sf.gov/api/views/eshn-8t3a/columns.json, 2026-11-14): event_id text ("SFGOV~0000011726") ·
 * department text · status text (Open 48, Amended 21) · category text (Personal Services 49, Commodity 20: Public
 * Works' construction is filed under both) · type text (Seeking Bids 68, Request for Information 1) · open_date and
 * due_date calendar_date · title text ("EXT DPW | PW 887 Ptrr Tnnt Imprv & Fire": a department code, a bar, the name) ·
 * sfcitypartner_link url · data_as_of, data_loaded_at. 69 rows in all (the dataset is reloaded about weekly: data_as_of
 * 2026-11-08, so a closed event can still be listed: the parser drops it by `now`).
 *
 * TIMES: due_date is a floating timestamp in San Francisco wall clock (hours seen: 17:00, 14:00, 13:00, 12:00, 23:59, never
 * the 20:00/22:00 a UTC column shows), read as America/Los_Angeles. A due date in 2090 or later (2099-12-31, 2100-03-25:
 * standing lists such as "Airport Concessions and Leases") is a placeholder, not a deadline: dueAt null and the card says so.
 * WHAT IS KEPT: status Open or Amended, due later than `now`, type "Seeking Bids" (RFI kept with the RFI flag), not a
 * "Bid Results" posting, not "Professional Services (Non-Construction)"; then isTradeWork on the name with the board's
 * category, except for Public Works, whose construction is filed under Commodity and Personal Services: there the
 * words alone decide.
 * PLACE: San Francisco, CA (no site in the data). CARD: sfcitypartner_link.url, the event's City Partner page.
 * robots.txt (data.sf.gov, 2026-11-14): "User-agent: * / Crawl-delay: 1"; Disallow only /browse?…, /api/odata/,
 * /api/collocate* and similar: /resource/ is allowed.
 */

export const SFBIDS_HOST = 'data.sf.gov';
export const SFBIDS_DATASET = 'eshn-8t3a';
const NAME = 'SF City Partner (San Francisco)';
const ZONE = 'America/Los_Angeles';
/** A due date at or past this year is a placeholder for "open until further notice". */
const PLACEHOLDER_YEAR = 2090;

export interface SfBidsRow {
  event_id?: string;
  department?: string;
  status?: string;
  category?: string;
  type?: string;
  open_date?: string;
  due_date?: string;
  title?: string;
  sfcitypartner_link?: { url?: string } | null;
}

export function sfBidsQuery(now: Date): SocrataQuery {
  return {
    host: SFBIDS_HOST,
    dataset: SFBIDS_DATASET,
    where: `status in ('Open', 'Amended') AND due_date > '${soqlDayBefore(now)}'`,
    order: 'event_id',
  };
}

/**
 * Where an SF department works. Most work is in the City, but two departments mostly work outside it:
 *   "Airport Commission" → SFO's own ZIP 94128 (the airport sits in San Mateo County, not in the City)
 *   "Public Utilities Commission" → CA only (its Hetch Hetchy, Sunol and Peninsula water sites are far afield)
 * locate() still reads a town named in the text for the CA-only rows.
 */
export function sfPlace(department: string | null): Partial<BidLocation> {
  const d = department ?? '';
  if (/^airport commission$/i.test(d)) return { zip: '94128', state: 'CA' };
  if (/^public utilities commission$/i.test(d)) return { state: 'CA' };
  return { city: 'San Francisco', state: 'CA' };
}

/** "EXT DPW | PW 887 Ptrr Tnnt Imprv & Fire" → "PW 887 Ptrr Tnnt Imprv & Fire" (the code is the department's). */
export function sfTitle(raw: string | null | undefined): string {
  const t = clean(raw);
  const m = /^[A-Z0-9 ]{2,24}\s*\|\s*(.+)$/.exec(t);
  return m ? m[1]!.trim() : t;
}

export interface ParsedSfBids {
  bids: BidDraft[];
  read: number;
  notOpen: number;
  notTrade: number;
}

export function parseSfBids(rows: readonly SfBidsRow[], now: Date): ParsedSfBids {
  const out: ParsedSfBids = { bids: [], read: 0, notOpen: 0, notTrade: 0 };
  for (const r of rows) {
    const id = clean(r.event_id);
    const title = sfTitle(r.title);
    if (!id || !title) continue;
    out.read++;
    const status = clean(r.status).toLowerCase();
    const due = clean(r.due_date);
    const placeholder = Number(due.slice(0, 4)) >= PLACEHOLDER_YEAR;
    const dueAt = placeholder ? null : parseUsDateTime(due, { timeZone: ZONE, defaultTime: [23, 59] });
    if ((status !== 'open' && status !== 'amended') || (!placeholder && (!dueAt || Date.parse(dueAt) <= now.getTime()))
      || /\bbid results\b/i.test(title)) {
      out.notOpen++;
      continue;
    }
    const category = cleanOrNull(r.category);
    const department = cleanOrNull(r.department);
    // Public Works files its construction under Commodity or Personal Services ("PW SAN BRUNO AVE PAVE RENOV",
    // "Ingleside Police Stn Repl Trade Package"): for its listings the category says nothing, the words decide.
    const boardCategory = /^public works$/i.test(department ?? '') ? null : category;
    if (/\bnon-construction\b/i.test(title) || !isTradeWork({ title, category: boardCategory, board: 'sfbids' }).keep) { out.notTrade++; continue; }

    const type = cleanOrNull(r.type);
    const link = clean(r.sfcitypartner_link?.url);
    const number = /~0*(\d+)$/.exec(id)?.[1] ?? id;
    out.bids.push({
      source: 'sfbids',
      sourceId: id,
      sourceName: NAME,
      title,
      agency: department ? `San Francisco ${department}` : 'City and County of San Francisco',
      description: [department, category, type, status === 'amended' ? 'Amended' : null, `Event ${number}`,
        placeholder ? 'No closing date listed: an open list' : null].filter(Boolean).join(' · '),
      category,
      location: sfPlace(department),
      postedAt: parseUsDateTime(r.open_date, { timeZone: ZONE, defaultTime: [0, 0] }),
      dueAt,
      estValue: findEstimate(title),
      naics: null,
      setAside: null,
      url: /^https?:\/\//i.test(link) ? link : 'https://sfcitypartner.sfgov.org/pages/Events-BS3/event-search.aspx',
      flags: [...detectFlags(title), ...(/information/i.test(type ?? '') ? [FLAGS.rfi] : [])],
      solNumber: number,
    });
  }
  return out;
}

export const sfBidsSource: Source = {
  id: 'sfbids',
  name: NAME,
  homepage: 'https://sfcitypartner.sfgov.org/pages/Events-BS3/event-search.aspx',
  states: ['CA'],
  timeZone: ZONE,
  group: 'west',
  async fetch(ctx) {
    const { rows, pages } = await readSocrata<SfBidsRow>(ctx, 'sfbids', sfBidsQuery(ctx.now));
    if (rows.length > 0 && !rows.some((r) => clean(r.event_id) && clean(r.title))) {
      throw new Error(`sfbids: ${rows.length} rows but none with an event_id and a title (columns renamed?)`);
    }
    if (rows.length === 0) throw new Error('sfbids: no rows with status Open/Amended and a future due_date (columns or values changed?)');
    const p = parseSfBids(rows, ctx.now);
    ctx.log(`sfbids: ${p.read} listed in ${pages} page(s), ${p.bids.length} kept, ${p.notOpen} closed/results, ${p.notTrade} left out as not trade work`);
    return p.bids;
  },
};
