import type { BidDraft, BidLocation, Source } from '../types.js';
import { FLAGS } from './flags.js';
import { isTradeWork } from './relevance.js';
import { readSocrata, type SocrataQuery } from './socrata.js';
import { detectFlags } from '../util/flags.js';
import { findEstimate } from '../util/money.js';
import { clean, cleanOrNull } from '../util/text.js';
import { parseUsDateTime } from '../util/time.js';

/**
 * Los Angeles RAMP (Regional Alliance Marketplace for Procurement), open bid opportunities, as the City publishes them on
 * its Socrata portal: data.lacity.org dataset hf3r-utnq ("RAMP Open Bid Opportunities"). City departments (Public Works,
 * Water & Power, General Services, the Port, the Housing Authority, Fire), LAUSD and Los Angeles County post there.
 *
 * COLUMNS (GET https://data.lacity.org/api/views/hf3r-utnq/columns.json, 2026-11-14): rampid text · title text ·
 * stagename text (Open 175, Amended 33) · category text (Personal Services 102, Commodity 85, Construction 19, None 2) ·
 * type text ("RFB - Request For Bid", "IFB - Invitation for Bid", "RFQ-Prequal", "RFI - Request for Information" …, or
 * "None") · bidpost calendar_date · closedate calendar_date · department text · url url ({url}). 208 rows in all.
 *
 * TIMES: closedate and bidpost are Socrata "floating" timestamps (no zone written), but they hold UTC: LA County titles
 * repeat the closing time in words, and every one matches the column read as UTC ("Closing: 12/2/2026 12:00 PM" next to
 * closedate 2026-12-02T20:00:00 = noon PST; "11/18/2026 5:00 PM" next to 2026-11-19T01:00:00). The most common hours in
 * the column are 22:00, 20:00, 19:00, 23:00 and 01:00, i.e. 2 PM, noon, 11 AM, 3 PM and 5 PM Pacific. So they are read
 * as UTC here, never as Pacific wall clock (test/source-laramp.test.ts checks the title against the column).
 *
 * WHAT IS KEPT: stagename Open or Amended, closedate in the future (the $where asks for a day of slack, the parser
 * drops anything closed by `now`), not a practice listing ("Online Bidding Practice") or a "*CANCELLED*" one; a
 * "Commodity" listing only when its title names work (NAMES_WORK below); then isTradeWork with the board's category.
 * An RFI is kept with the RFI flag.
 * PLACE: Los Angeles, CA (the dataset names no site; LA County's own listings too: its seat). Ontario International
 * Airport Authority posts here and is placed in Ontario, CA.
 * CARD: url.url, the listing's RAMP page (https://www.rampla.org/s/opportunity-details?id=…).
 * robots.txt (data.lacity.org, 2026-11-14): "User-agent: * / Crawl-delay: 1", Disallow only /browse?…, /api/odata/,
 * /api/collocate* and similar: /resource/ is allowed.
 */

export const LARAMP_HOST = 'data.lacity.org';
export const LARAMP_DATASET = 'hf3r-utnq';
const NAME = 'LA City RAMP (Los Angeles)';
const ZONE = 'America/Los_Angeles';

export interface LaRampRow {
  rampid?: string;
  title?: string;
  stagename?: string;
  category?: string;
  type?: string;
  bidpost?: string;
  closedate?: string;
  department?: string;
  url?: { url?: string } | null;
}

/** A Socrata floating timestamp a day before `now` (slack for the $where; the parser decides exactly). */
export const soqlDayBefore = (now: Date): string => new Date(now.getTime() - 86_400_000).toISOString().slice(0, 19);

/** The one query the source sends (exported for the tests and the fixture capture). */
export function laRampQuery(now: Date): SocrataQuery {
  return {
    host: LARAMP_HOST,
    dataset: LARAMP_DATASET,
    where: `stagename in ('Open', 'Amended') AND closedate > '${soqlDayBefore(now)}'`,
    order: 'rampid',
  };
}

/** A floating timestamp that holds UTC ("2026-12-02T20:00:00.000") → ISO UTC. */
function utcFloating(s: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(clean(s));
  return m ? parseUsDateTime(`${m[1]}Z`) : null;
}

/** "RFB-IS-27200321 - ATLASSIAN … - Closing: 12/2/2026 12:00 PM" → without the closing words (the card shows dueAt). */
export function laRampTitle(raw: string | null | undefined): string {
  return clean(raw).replace(/\s*-\s*Closing:.*$/i, '').trim();
}

/**
 * The board files goods under "Commodity" ("146990 FIBER OPTIC CABLE", "WIRE, CONDUIT BUSHINGS", "TRANSFORMER, PORTABLE":
 * a supply order, not a job, though the words are trade words), and a few jobs too ("ROOF REPLACEMENT - CAMP 8 MAINT
 * BUILDING - JOB WALK", "HEIGHT ADJUSTERS AND INSTALLATION", "146380 Services, Fire Protection, Nevada Facilities").
 * A Commodity listing goes on to isTradeWork only when its title names work being done. (nycrecord.ts uses it on NYC's "Goods".)
 */
export const NAMES_WORK = /\b(?:install\w*|replac\w*|repair\w*|renovat\w*|rehab\w*|construct\w*|moderniz\w*|improvements?|abatement|removal|demoli\w*|maintenance|services?|job walk|retrofit\w*|upgrades?)\b/i;

export interface ParsedLaRamp {
  bids: BidDraft[];
  read: number;
  /** Closed, cancelled or a practice listing. */
  notOpen: number;
  notTrade: number;
}

/**
 * Where a RAMP department works. RAMP carries other agencies besides the City of Los Angeles, so the city is set
 * only for the City's own departments (and LAUSD, the City's school district). Seen on 2026-11-14:
 *   "Ontario International Airport Authority" → Ontario · "Port of Long Beach" → Long Beach
 *   "Los Angeles County" → the county, no city (its sites run from Bell to Lancaster: locate() reads a town from
 *     the text if it knows one) · "Water & Power" → CA only (LADWP also lists its Nevada and Owens Valley sites)
 * BidSwipe has no LA County seat in its table, so a county row stays at state precision unless the text names a town.
 */
export function laRampPlace(department: string | null): Partial<BidLocation> {
  const d = department ?? '';
  if (/ontario international airport/i.test(d)) return { city: 'Ontario', state: 'CA' };
  if (/port of long beach/i.test(d)) return { city: 'Long Beach', state: 'CA' };
  if (/^los angeles county\b/i.test(d)) return { county: 'Los Angeles', state: 'CA' };
  if (/water\s*&\s*power/i.test(d)) return { state: 'CA' };
  return { city: 'Los Angeles', state: 'CA' };
}

/** Rows → drafts. PURE (`now` decides "still open"). */
export function parseLaRamp(rows: readonly LaRampRow[], now: Date): ParsedLaRamp {
  const out: ParsedLaRamp = { bids: [], read: 0, notOpen: 0, notTrade: 0 };
  for (const r of rows) {
    const id = clean(r.rampid);
    const title = laRampTitle(r.title);
    if (!id || !title) continue;
    out.read++;
    const stage = clean(r.stagename).toLowerCase();
    const dueAt = utcFloating(r.closedate);
    if ((stage !== 'open' && stage !== 'amended') || !dueAt || Date.parse(dueAt) <= now.getTime()
      || /\bcancel+ed\b/i.test(title) || /^online bidding practice$/i.test(title)) {
      out.notOpen++;
      continue;
    }
    const category = cleanOrNull(r.category) === 'None' ? null : cleanOrNull(r.category);
    const type = cleanOrNull(r.type) === 'None' ? null : cleanOrNull(r.type);
    const department = cleanOrNull(r.department);
    if ((category === 'Commodity' && !NAMES_WORK.test(title)) || !isTradeWork({ title, category }).keep) { out.notTrade++; continue; }

    const rfi = /\bRFI\b|request for information/i.test(`${type ?? ''} ${title}`);
    const link = clean(r.url?.url);
    out.bids.push({
      source: 'laramp',
      sourceId: id,
      sourceName: NAME,
      title,
      agency: department,
      description: [department, category, type, stage === 'amended' ? 'Amended' : null, `RAMP ${id}`].filter(Boolean).join(' · '),
      category,
      location: laRampPlace(department),
      postedAt: utcFloating(r.bidpost),
      dueAt,
      estValue: findEstimate(title),
      naics: null,
      setAside: null,
      url: /^https?:\/\//i.test(link) ? link : 'https://www.rampla.org/s/',
      flags: [...detectFlags(title), ...(rfi ? [FLAGS.rfi] : [])],
      solNumber: null,
    });
  }
  return out;
}

export const laRampSource: Source = {
  id: 'laramp',
  name: NAME,
  homepage: 'https://www.rampla.org/s/',
  states: ['CA'],
  timeZone: ZONE,
  group: 'west',
  async fetch(ctx) {
    const { rows, pages } = await readSocrata<LaRampRow>(ctx, 'laramp', laRampQuery(ctx.now));
    if (rows.length > 0 && !rows.some((r) => clean(r.rampid) && clean(r.title))) {
      throw new Error(`laramp: ${rows.length} rows but none with a rampid and a title (columns renamed?)`);
    }
    // The board always has open bids (208 on 2026-11-14): none at all means the filter no longer matches the data.
    if (rows.length === 0) throw new Error("laramp: no rows with stagename Open/Amended and a future closedate (columns or values changed?)");
    const p = parseLaRamp(rows, ctx.now);
    ctx.log(`laramp: ${p.read} listed in ${pages} page(s), ${p.bids.length} kept, ${p.notOpen} closed/cancelled/practice, ${p.notTrade} left out as not trade work`);
    return p.bids;
  },
};
