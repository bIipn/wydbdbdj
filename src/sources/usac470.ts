import type { BidDraft, Source } from '../types.js';
import { ERATE_470_FLAG } from './flags.js';
import { isTradeWork } from './relevance.js';
import { readSocrata, type SocrataQuery } from './socrata.js';
import { detectFlags } from '../util/flags.js';
import { clean, cleanOrNull, truncate } from '../util/text.js';
import { findDueInText, zonedToUtc } from '../util/time.js';

/**
 * USAC E-Rate, FCC Form 470 (opendata.usac.org dataset jt8s-3q52, "E-Rate Request for Discount on Services: FCC Form 470
 * Tool"): a school, school district or library posts a Form 470 to ask for quotes on E-Rate services, waits at least 28
 * days (the "allowable contract date"), then picks the most cost-effective offer. This is NOT a sealed public-works bid
 * (no public opening, no bid bond): the card says so with its own flag (flags.ts ERATE_470_FLAG).
 *
 * Only Category 2 "Internal Connections" is contractor work: structured cabling, wireless access points, antennas and
 * connectors, racks, UPS, switches, installed in the buildings (low-voltage electricians do this). Category 1 (internet
 * access, data transmission), Managed Internal Broadband Services and Basic Maintenance of Internal Connections are
 * services a carrier or an IT firm sells, and are not asked for.
 *
 * COLUMNS (GET https://opendata.usac.org/api/views/jt8s-3q52/columns.json, 2026-11-14), one row per SERVICE REQUEST line
 * and per attached RFP document (the same line repeats once for each document): application_number · form_nickname ·
 * form_pdf url · service_request_id · rfp_documents url · form_version (Original, Current: an amended form has its
 * rows under Current) · funding_year text · fcc_form_470_status (Certified, Canceled) · allowable_contract_date
 * calendar_date (midnight) · certified_date_time · billed_entity_name/city/state/zip · applicant_type ·
 * number_of_eligible_entities · category_two_description · service_category · service_type · function · quantity ·
 * unit · installation_initial checkbox · manufacturer. On 2026-11-14, rows with an allowable contract date from that day on
 * were all funding year 2027: Internal Connections 4,007 rows (about 600 forms, every state), Basic Maintenance 2,425,
 * Category 1 2,220, Managed Internal Broadband 708. The contact columns (names, phones, e-mails) are never selected.
 *
 * WHAT IS KEPT: certified, Internal Connections, funding year this calendar year or later, allowable contract date not
 * passed; ONE card per form (rows grouped by application_number; an amended form's Current rows win over its
 * Original ones). A form is kept when it asks for cabling (installation by nature) or for installed BUILDING work: a
 * line for wireless access points, antennas and connectors, racks or UPS with installation_initial (PHYSICAL below). Left
 * out: a form that only buys equipment (no installation: a reseller's sale) and one whose installed lines are network
 * gear only (switches, firewalls, routers, controllers, caching: an IT firm's job), and one isTradeWork() says no to.
 * DATES: allowable_contract_date is a date (midnight, no zone): the FIRST day the applicant may sign a contract. It
 * is NOT a quote deadline: form 270000261 (Washington Unified) may sign from 2026-11-27 and its own text says "Bid
 * response due electronically by 4:00 PM PST on December 2, 2026". So dueAt comes only from a due date the form's
 * own text names (findDueInText on category_two_description, in the applicant's state zone: STATE_ZONE below, the
 * zone most of the state keeps; nationwide, so there is no Source.timeZone). A form whose text names none has
 * dueAt null and the card says the RFP sets the deadline. Open: a text due date not passed, or (no text date) the
 * allowable contract date not passed, as the query asks (once it passes, the form is no longer read).
 * PLACE: the billed entity's city, state and ZIP (the district office: its schools are nearby, not at that address).
 * CARD: the certified Form 470 PDF (form_pdf), else the first RFP document of the form.
 * robots.txt (opendata.usac.org, 2026-11-14): "User-agent: * / Crawl-delay: 1"; Disallow only /browse?…, /api/odata/,
 * /api/collocate* and similar: /resource/ is allowed.
 */

export const USAC_HOST = 'opendata.usac.org';
export const USAC_DATASET = 'jt8s-3q52';
const NAME = 'USAC E-Rate (FCC Form 470)';

/** The zone most of each state keeps (for a date-only deadline, the hour only matters near midnight). */
export const STATE_ZONE: Readonly<Record<string, string>> = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago', CA: 'America/Los_Angeles',
  CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York',
  GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York',
  NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago',
  OH: 'America/New_York', OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver',
  VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York', WI: 'America/Chicago',
  WY: 'America/Denver', PR: 'America/Puerto_Rico', VI: 'America/St_Thomas', GU: 'Pacific/Guam', AS: 'Pacific/Pago_Pago',
  MP: 'Pacific/Saipan',
};

export interface UsacRow {
  application_number?: string;
  form_nickname?: string;
  form_pdf?: { url?: string } | null;
  service_request_id?: string;
  rfp_documents?: { url?: string } | null;
  form_version?: string;
  funding_year?: string;
  fcc_form_470_status?: string;
  allowable_contract_date?: string;
  certified_date_time?: string;
  billed_entity_name?: string;
  billed_entity_city?: string;
  billed_entity_state?: string;
  billed_entity_zip?: string;
  applicant_type?: string;
  number_of_eligible_entities?: string;
  category_two_description?: string;
  service_category?: string;
  service_type?: string;
  function?: string;
  quantity?: string;
  unit?: string;
  installation_initial?: boolean;
  manufacturer?: string;
}

const SELECT = [
  'application_number', 'form_nickname', 'form_pdf', 'service_request_id', 'rfp_documents', 'form_version', 'funding_year',
  'fcc_form_470_status', 'allowable_contract_date', 'certified_date_time', 'billed_entity_name', 'billed_entity_city',
  'billed_entity_state', 'billed_entity_zip', 'applicant_type', 'number_of_eligible_entities', 'category_two_description',
  'service_category', 'service_type', 'function', 'quantity', 'unit', 'installation_initial', 'manufacturer',
].join(', ');

/**
 * The one query (nationwide). `states` narrows it (the fixture capture used CA and NV). Funding year: this calendar
 * year or later (forms filed in late 2026 are for funding year 2027); the date has a day of slack, the parser decides.
 */
export function usacQuery(now: Date, states?: readonly string[]): SocrataQuery {
  const day = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const where = [
    "service_type = 'Internal Connections'",
    "fcc_form_470_status = 'Certified'",
    `funding_year >= '${now.getUTCFullYear()}'`,
    `allowable_contract_date >= '${day}T00:00:00'`,
    ...(states?.length ? [`billed_entity_state in (${states.map((s) => `'${s}'`).join(', ')})`] : []),
  ].join(' AND ');
  return { host: USAC_HOST, dataset: USAC_DATASET, select: SELECT, where, order: ':id' };
}

/** Function names as USAC writes them → short words for the card. */
const FUNCTION_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/^cabling/i, 'cabling'],
  [/^wireless access points/i, 'wireless access points'],
  [/^wireless controllers/i, 'wireless controllers'],
  [/^antennas, connectors/i, 'antennas and connectors'],
  [/^racks/i, 'racks'],
  [/^uninterruptable power supply|^uninterruptible power supply/i, 'UPS / battery backup'],
  [/^switches/i, 'switches'],
  [/^routers/i, 'routers'],
  [/^firewall/i, 'firewall'],
  [/^caching/i, 'caching'],
];
/** The functions that are building work when installed (cabling counts installed or not). */
const PHYSICAL = new Set(['cabling', 'wireless access points', 'antennas and connectors', 'racks', 'UPS / battery backup']);
const functionWord = (f: string): string => FUNCTION_WORDS.find(([re]) => re.test(f))?.[1] ?? f.toLowerCase();

/** School-name abbreviations USAC writes in capitals ("REDLANDS UNIFIED SCHOOL DIST", "Yucaipa-calimesa JT Unif S D"). */
const KEEP_CAPS = new Set(['USD', 'ISD', 'CISD', 'UFSD', 'CSD', 'ESD', 'HSD', 'UHSD', 'SD', 'BOCES', 'JT', 'SCH', 'ELEM', 'CO', 'II', 'III', 'IV']);

/**
 * "LOS ANGELES UNIFIED SCHOOL DISTRICT" → "Los Angeles Unified School District"; a name with lower case letters is kept
 * as written ("Cristo Rey St. Viator Las Vegas College Preparatory, Inc."), and so are the abbreviations above.
 */
export function entityName(raw: string | null | undefined): string {
  const s = clean(raw);
  if (s !== s.toUpperCase()) return s;
  return s.replace(/[A-Z][A-Z']*/g, (w) => (KEEP_CAPS.has(w) ? (w === 'ELEM' ? 'Elem' : w) : w.charAt(0) + w.slice(1).toLowerCase()));
}

const DATE_WORDS = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });

export interface ParsedUsac {
  bids: BidDraft[];
  /** Forms (application numbers) read. */
  forms: number;
  /** Forms whose allowable contract date has passed (or has none). */
  notOpen: number;
  /** Equipment-only forms (no installation, no cabling) and forms isTradeWork turned down. */
  notTrade: number;
}

/** Service-request rows → one draft per form. PURE (`now` decides "allowable contract date not passed"). */
export function parseUsac470(rows: readonly UsacRow[], now: Date): ParsedUsac {
  const byForm = new Map<string, UsacRow[]>();
  for (const r of rows) {
    const app = clean(r.application_number);
    if (!app || clean(r.service_type) !== 'Internal Connections' || clean(r.fcc_form_470_status) !== 'Certified') continue;
    let list = byForm.get(app);
    if (!list) byForm.set(app, (list = []));
    list.push(r);
  }
  const out: ParsedUsac = { bids: [], forms: byForm.size, notOpen: 0, notTrade: 0 };
  for (const [app, all] of byForm) {
    const current = all.filter((r) => clean(r.form_version) === 'Current');
    const form = current.length ? current : all;
    const head = form[0]!;
    const state = clean(head.billed_entity_state).toUpperCase() || null;
    const zone = (state && STATE_ZONE[state]) || 'America/New_York';
    const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(clean(head.allowable_contract_date));
    const allowable = dayStart(head.allowable_contract_date, zone);
    if (!allowable) { out.notOpen++; continue; }
    // The quote deadline only when the form's own text names one ("…due … by 4:00 PM PST on December 2, 2026").
    const dueAt = findDueInText(head.category_two_description, { timeZone: zone, near: allowable });
    const openUntil = dueAt ?? allowable;
    if (Date.parse(openUntil) <= now.getTime()) { out.notOpen++; continue; }

    // One line per service request (the rows repeat it once per RFP document).
    const lines = new Map<string, UsacRow>();
    for (const r of form) lines.set(clean(r.service_request_id) || String(lines.size), r);
    const install = [...lines.values()].some((r) => r.installation_initial === true);
    const building = [...lines.values()].some((r) => {
      const w = functionWord(clean(r.function));
      return w === 'cabling' || (r.installation_initial === true && PHYSICAL.has(w));
    });
    const words: string[] = [];
    for (const r of lines.values()) {
      const w = functionWord(clean(r.function));
      if (w && !words.includes(w)) words.push(w);
    }
    const what = words.join(', ') || 'internal connections';
    const scope = install ? `${what}, installed` : what;
    const entity = entityName(head.billed_entity_name) || `E-Rate applicant ${app}`;
    const extra = clean(head.category_two_description);
    if (!building || !isTradeWork({ title: scope, description: extra, category: 'Internal Connections' }).keep) {
      out.notTrade++;
      continue;
    }

    const qty = [...lines.values()]
      .map((r) => {
        const n = Number(clean(r.quantity));
        const unit = clean(r.unit).toLowerCase();
        return Number.isFinite(n) && n > 0 && unit ? `${functionWord(clean(r.function))}: ${n.toLocaleString('en-US')} ${unit}` : null;
      })
      .filter((s): s is string => s != null);
    const docs = [...new Set(form.map((r) => clean(r.rfp_documents?.url)).filter((u) => /^https?:\/\//i.test(u)))];
    const pdf = clean(head.form_pdf?.url);
    const sites = Number(clean(head.number_of_eligible_entities));
    const type = cleanOrNull(head.applicant_type);
    const dateWords = DATE_WORDS.format(new Date(`${day![1]}-${day![2]}-${day![3]}T12:00:00Z`));
    const fy = cleanOrNull(head.funding_year);
    out.bids.push({
      source: 'usac470',
      sourceId: app,
      sourceName: NAME,
      title: `${entity}: E-Rate ${scope}`,
      agency: entity,
      description: [
        `E-Rate Form 470: ${entity}${type ? ` (${type.toLowerCase()}${sites > 1 ? `, ${sites} sites` : ''})` : ''} is taking quotes for ` +
          `${scope}. A contract may be signed from ${dateWords}; ` +
          `${dueAt ? `the form says quotes are due ${dueWords(dueAt, zone)}` : 'the RFP says when quotes are due'}. ` +
          `Quotes, not a sealed public-works bid.`,
        `Form ${app}${cleanOrNull(head.form_nickname) ? ` (${clean(head.form_nickname)})` : ''}${fy ? `, funding year ${fy}` : ''}` +
          `${docs.length ? `, ${docs.length} RFP document${docs.length > 1 ? 's' : ''}` : ', no RFP document attached'}.`,
        qty.length ? `Requested: ${qty.join('; ')}.` : null,
        extra ? truncate(extra, 600) : null,
      ].filter(Boolean).join('\n'),
      category: 'E-Rate Category 2 (internal connections)',
      location: {
        city: cleanOrNull(head.billed_entity_city) ? entityName(head.billed_entity_city) : null,
        state,
        zip: /^\d{5}/.exec(clean(head.billed_entity_zip))?.[0] ?? null,
      },
      postedAt: dayStart(head.certified_date_time, zone),
      dueAt,
      estValue: null,
      naics: null,
      setAside: null,
      url: /^https?:\/\//i.test(pdf) ? pdf : docs[0] ?? 'https://opendata.usac.org/E-rate/E-Rate-Request-for-Discount-on-Services-FCC-Form-/jt8s-3q52',
      flags: [ERATE_470_FLAG, ...detectFlags(extra)],
      solNumber: app,
    });
  }
  return out;
}

/** "2026-12-03T00:00:00.000Z" in America/Los_Angeles → "December 2, 2026, 4:00 PM" (the applicant's wall clock). */
function dueWords(iso: string, zone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso));
}

/**
 * "2026-11-27T00:00:00.000" → the start of that DAY in `zone` (ISO UTC). Used for the allowable contract date (a date)
 * and for postedAt from certified_date_time, whose clock USAC does not state: only its day is used.
 */
function dayStart(s: string | null | undefined, zone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(clean(s));
  return m ? zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0, zone).toISOString() : null;
}

export const usac470Source: Source = {
  id: 'usac470',
  name: NAME,
  homepage: 'https://opendata.usac.org/E-rate/E-Rate-Request-for-Discount-on-Services-FCC-Form-/jt8s-3q52',
  states: 'US',
  group: 'west',
  async fetch(ctx) {
    const { rows, pages, truncated } = await readSocrata<UsacRow>(ctx, 'usac470', usacQuery(ctx.now));
    if (rows.length > 0 && !rows.some((r) => clean(r.application_number) && clean(r.allowable_contract_date))) {
      throw new Error(`usac470: ${rows.length} rows but none with an application_number and an allowable_contract_date (columns renamed?)`);
    }
    // Forms for the next funding year are filed from about July to March (4,007 rows on 2026-11-14). From August to
    // February an empty answer means the query no longer matches the data: FAILED. From March to July it can be true.
    if (rows.length === 0) {
      const month = ctx.now.getUTCMonth() + 1;
      if (month >= 8 || month <= 2) throw new Error('usac470: no Internal Connections rows with a future allowable contract date in filing season (columns or values changed?)');
      ctx.log('usac470: no Internal Connections rows with a future allowable contract date (between filing seasons)');
    }
    const p = parseUsac470(rows, ctx.now);
    ctx.log(
      `usac470: ${rows.length} service rows in ${pages} page(s)${truncated ? ' (stopped early)' : ''}, ${p.forms} forms, ${p.bids.length} kept, ` +
        `${p.notOpen} past their quote deadline or contract date, ${p.notTrade} left out as equipment only / not trade work`,
    );
    return p.bids;
  },
};
