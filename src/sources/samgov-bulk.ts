/**
 * SAM.gov's daily bulk file: every active federal notice in one public CSV, no key and no login.
 *
 *   GET https://sam.gov/api/prod/fileextractservices/v1/api/download/Contract%20Opportunities/datagov/
 *       ContractOpportunitiesFullCSV.csv?privacy=Public
 *   → 303 to a signed falextracts.s3.amazonaws.com URL (it expires; its query string is never logged or stored)
 *   → about 222 MB, rebuilt about once a day (2026-11-13: Last-Modified 04:30 UTC).
 *
 * Why: the API key allows 10 requests a day and expires every 90 days. The file has the whole country, so
 * every company's feed can follow where it works, not just the three queries the key can afford.
 *
 * What is in the file (checked on the full file of 2026-11-13, 222,056,693 bytes):
 *  - RFC 4180: every field quoted, "" for a quote, line breaks inside descriptions, LF between records.
 *  - Text is mostly Windows-1252 (’ is the byte 0x92: 17,419 times), but some fields hold UTF-8 (§ as C2 A7,
 *    ® as C2 AE, – as E2 80 93), sometimes both in one field. So each field is decoded on its own (decodeField):
 *    valid UTF-8 as UTF-8, otherwise UTF-8 sequences as UTF-8 and every other high byte as Windows-1252.
 *    Windows-1252 text is almost never valid UTF-8 by accident (it would need a pair like "Ã©").
 *
 * Everything here is pure (bytes in, drafts out) except fetchSamBulk at the bottom, which streams the
 * download through the parser so the 222 MB never sit in memory at once.
 */
import { TRADES } from '../trades/catalog.js';
import type { BidDraft, FetchLike, SourceContext } from '../types.js';
import { mergeDrafts } from './dedupe.js';
import { FLAGS } from './flags.js';
import { isTradePsc } from './psc.js';
import { namesNoPlace, parseSamPlace, placeAtOffice, samDraft, samOffice, type SamOffice, type SamOpportunity } from './samgov.js';

export const SAM_BULK_URL =
  'https://sam.gov/api/prod/fileextractservices/v1/api/download/Contract%20Opportunities/datagov/ContractOpportunitiesFullCSV.csv?privacy=Public';

/** The columns we read. A missing or renamed one means SAM changed the file: we stop instead of guessing. */
export const BULK_COLUMNS = [
  'NoticeId', 'Title', 'Sol#', 'Department/Ind.Agency', 'Sub-Tier', 'Office', 'PostedDate', 'Type',
  'SetASideCode', 'SetASide', 'ResponseDeadLine', 'NaicsCode', 'ClassificationCode', 'PopStreetAddress', 'PopCity',
  'PopState', 'PopZip', 'PopCountry', 'Active', 'Link', 'Description',
  // The contracting office's address (not the work site): the fallback place for a notice that names none.
  'State', 'City', 'ZipCode', 'CountryCode',
] as const;
type Column = (typeof BULK_COLUMNS)[number];

// ------------------------------------------------------------ CSV bytes --

const QUOTE = 0x22;
const COMMA = 0x2c;
const LF = 0x0a;
const CR = 0x0d;

/**
 * Splits a byte stream into CSV records, chunk by chunk (RFC 4180). A record ends at a line feed outside
 * quotes; a quote inside a quoted field is written twice. Each push returns the records it completed, as
 * lists of raw field bytes (quotes removed, "" turned into "). Bytes of an unfinished record wait for the
 * next push, and the scan position is kept, so a long description split over many chunks is read once.
 */
export class CsvSplitter {
  private buf: Uint8Array = new Uint8Array(0);
  private pos = 0; // where the search for the end of the current record carries on
  private inQuotes = false;
  /** Total bytes pushed (for messages). */
  bytes = 0;

  push(chunk: Uint8Array): Uint8Array[][] {
    this.bytes += chunk.length;
    if (this.buf.length === 0) this.buf = chunk;
    else {
      const joined = new Uint8Array(this.buf.length + chunk.length);
      joined.set(this.buf, 0);
      joined.set(chunk, this.buf.length);
      this.buf = joined;
    }
    const out: Uint8Array[][] = [];
    let start = 0;
    const b = this.buf;
    let i = this.pos;
    let nextLf = -2; // cached: the next line feed at or after i (-1 = none in the buffer)
    while (i < b.length) {
      if (this.inQuotes) {
        const q = b.indexOf(QUOTE, i);
        if (q === -1) { i = b.length; break; }
        this.inQuotes = false; // a doubled quote closes and reopens: the toggle comes out right
        i = q + 1;
        continue;
      }
      const q = b.indexOf(QUOTE, i);
      if (nextLf !== -1 && nextLf < i) nextLf = b.indexOf(LF, i);
      if (nextLf === -2) nextLf = b.indexOf(LF, i);
      if (nextLf !== -1 && (q === -1 || nextLf < q)) {
        out.push(splitFields(b.subarray(start, nextLf)));
        start = i = nextLf + 1;
        nextLf = b.indexOf(LF, i);
        continue;
      }
      if (q === -1) { i = b.length; break; }
      this.inQuotes = true;
      i = q + 1;
    }
    // Keep the unfinished record (copied, so the big chunk it came from can be freed).
    this.buf = start === 0 ? b : b.slice(start);
    this.pos = i - start;
    return out;
  }

  /** The last record when the file does not end with a line feed. Throws if the file stops inside quotes. */
  end(): Uint8Array[][] {
    if (this.inQuotes) throw new Error(`SAM.gov bulk file ends inside a quoted field after ${this.bytes} bytes (download cut off?)`);
    const rest = this.buf;
    this.buf = new Uint8Array(0);
    this.pos = 0;
    return rest.length && !(rest.length === 1 && rest[0] === CR) ? [splitFields(rest)] : [];
  }
}

/** One record's bytes (no trailing LF) → its fields' bytes. */
function splitFields(rec: Uint8Array): Uint8Array[] {
  let end = rec.length;
  if (end && rec[end - 1] === CR) end--; // CRLF line ends
  const fields: Uint8Array[] = [];
  let i = 0;
  for (;;) {
    if (rec[i] === QUOTE) {
      // Quoted: collect up to the closing quote, turning "" into ".
      const parts: Uint8Array[] = [];
      let from = i + 1;
      let j = from;
      for (;;) {
        const q = rec.indexOf(QUOTE, j);
        if (q === -1 || q >= end) { parts.push(rec.subarray(from, end)); i = end; break; } // unclosed: take the rest
        if (rec[q + 1] === QUOTE) { parts.push(rec.subarray(from, q + 1)); from = j = q + 2; continue; }
        parts.push(rec.subarray(from, q));
        i = q + 1;
        break;
      }
      fields.push(parts.length === 1 ? parts[0]! : concat(parts));
      // Anything between the closing quote and the comma is not RFC 4180; it is skipped.
      const c = rec.indexOf(COMMA, i);
      if (c === -1 || c >= end) return fields;
      i = c + 1;
    } else {
      const c = rec.indexOf(COMMA, i);
      if (c === -1 || c >= end) { fields.push(rec.subarray(i, end)); return fields; }
      fields.push(rec.subarray(i, c));
      i = c + 1;
    }
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const cp1252 = new TextDecoder('windows-1252');
/** Windows-1252 for one byte 0x80–0xFF (0x80–0x9F are its curly quotes, dashes and so on; the rest is Latin-1). */
const CP1252_HIGH = cp1252.decode(Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i));

/** Length of the valid UTF-8 sequence starting at b[i] (2–4), or 0 when the bytes there are not one. */
function utf8Run(b: Uint8Array, i: number): number {
  const c = b[i]!;
  const cont = (k: number) => i + k < b.length && (b[i + k]! & 0xc0) === 0x80;
  if (c >= 0xc2 && c <= 0xdf) return cont(1) ? 2 : 0;
  if (c >= 0xe0 && c <= 0xef) {
    const c1 = b[i + 1] ?? 0;
    if ((c === 0xe0 && c1 < 0xa0) || (c === 0xed && c1 > 0x9f)) return 0; // overlong / surrogate
    return cont(1) && cont(2) ? 3 : 0;
  }
  if (c >= 0xf0 && c <= 0xf4) {
    const c1 = b[i + 1] ?? 0;
    if ((c === 0xf0 && c1 < 0x90) || (c === 0xf4 && c1 > 0x8f)) return 0;
    return cont(1) && cont(2) && cont(3) ? 4 : 0;
  }
  return 0;
}

/**
 * A field's bytes → text. Plain ASCII as is; valid UTF-8 as UTF-8; anything else byte by byte: a valid UTF-8
 * sequence as its character, any other high byte as Windows-1252. The last case is real: one description in the
 * 2026-11-13 file has "44 U.S.C. § 3301" in UTF-8 (C2 A7) and, a line earlier, a lone C2 byte, so neither
 * decoder alone reads it right.
 */
export function decodeField(bytes: Uint8Array): string {
  let ascii = true;
  for (let k = 0; k < bytes.length; k++) if (bytes[k]! >= 0x80) { ascii = false; break; }
  if (ascii) return cp1252.decode(bytes); // identical for ASCII, and the cheapest path
  try {
    return utf8.decode(bytes);
  } catch {
    let out = '';
    let from = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i]! < 0x80) continue;
      out += cp1252.decode(bytes.subarray(from, i));
      const n = utf8Run(bytes, i);
      if (n) { out += utf8.decode(bytes.subarray(i, i + n)); i += n - 1; }
      else out += CP1252_HIGH[bytes[i]! - 0x80];
      from = i + 1;
    }
    return out + cp1252.decode(bytes.subarray(from));
  }
}

// ----------------------------------------------------------- the filter --

/**
 * NAICS codes we keep: every code a trade in the catalog uses (strong or related; some are outside 23, like
 * 561621 security systems and 561730 landscaping), plus all of sector 23, Construction.
 */
export const KEEP_NAICS: ReadonlySet<string> = new Set(TRADES.flatMap((t) => [...t.naics.strong, ...t.naics.related]));
export const isTradeNaics = (code: string): boolean => code.startsWith('23') || KEEP_NAICS.has(code);

/**
 * A notice is trade work when its NAICS says so OR its Product and Service Code does (src/sources/psc.ts): on
 * 2026-11-14 about half the open federal repair and maintenance work was filed under a NAICS outside the trades
 * (561210 facilities support, 811310 equipment repair…) with a PSC that names it (Z2AA, J061, S208…).
 */
export const isTradeNotice = (naics: string, psc: string): boolean => isTradeNaics(naics) || isTradePsc(psc);

/**
 * Notice types that become cards: the same three the API source asks for (ptype o,k,p). Award notices,
 * justifications, sources sought, special notices and sales are results or questions, not open bids.
 */
export const OPEN_TYPES: ReadonlySet<string> = new Set(['solicitation', 'combined synopsis/solicitation', 'presolicitation']);

/** Place-of-performance countries that count as the US: the file writes "USA"; a blank country with a US state is kept too. */
const US_COUNTRY = /^(?:USA|US|UNITED STATES)$/i;
/**
 * US territories the file sometimes writes as their own country code, with PopState blank (2026-11-13: six
 * rows say "VIR", one of them a live VA construction presolicitation in the Virgin Islands). They are US
 * work: the code becomes the state, which parseSamPlace already knows. Usually SAM writes "USA" + PR/GU.
 */
const TERRITORY: Readonly<Record<string, string>> = { PRI: 'PR', GUM: 'GU', VIR: 'VI', ASM: 'AS', MNP: 'MP' };
const territoryOf = (country: string): string | undefined => TERRITORY[country.toUpperCase()];
/** PopState values that mean "not given". */
const NO_STATE = /^(?:N\/?A|NONE|-)$/i;
/** "NV" goes in as a code, "Nevada" as a name: parseSamPlace reads both. */
const stateField = (v: string): { code?: string; name?: string } => (/^[A-Z]{2}$/i.test(v) ? { code: v.toUpperCase() } : { name: v });

/** A file this big is the real daily file, not a test sample (2026-11-13: 72,318 rows). */
const MIN_ROWS_FOR_SANITY = 1000;

/**
 * A notice with no deadline that was posted more than this long ago is not an open bid: it is a forgotten
 * listing (2026-11-13: 26 such cards from 2008–2021, some with a blank or mistyped ArchiveDate, so that column
 * cannot be trusted alone). Without a deadline it would never close and would sit in every feed for ever.
 */
export const STALE_AFTER_DAYS = 365;

/**
 * Fewer rows than this from a live download means the download stopped early but ended cleanly (a proxy that
 * re-chunks and closes, for example): we would otherwise show a third of the country as the whole of it.
 * The 2026-11-13 file has 72,318 rows. SAM_BULK_MIN_ROWS overrides it (tests feed an 82-row sample).
 */
export const LIVE_MIN_ROWS = 20_000;

/** Why a row or card was left out. 'naics': neither its NAICS nor its PSC is trade work (the name is historical). */
export type DropReason = 'inactive' | 'type' | 'naics' | 'country' | 'noPlace' | 'pastDue' | 'stale' | 'noId';

export interface BulkStats {
  bytes: number;
  rows: number;
  active: number;
  /** Notices that passed the row filters (active, open type, trade NAICS or PSC, not abroad). */
  kept: number;
  /** Of `kept`, the notices let in by their PSC alone (their NAICS is not a trade NAICS). */
  keptByPsc: number;
  /** Cards after notices of the same solicitation were merged and the card filters ran (no place, past due). */
  cards: number;
  /** Of `cards`, the ones no notice gave a work site for, placed at the contracting office (FLAGS.placeFromOffice). */
  placedAtOffice: number;
  /** Rows that had the wrong number of fields (skipped). */
  malformed: number;
  dropped: Record<DropReason, number>;
  /** Raw ResponseDeadLine shapes ("YYYY-MM-DDThh:mm:ss±hh:mm", "blank", …) over the kept rows, before the past-due cut. */
  deadlineShapes: Record<string, number>;
}

export interface BulkOptions {
  /** Drop notices whose deadline is already past at this moment (they would only be stored closed). */
  now?: Date;
}

/** "2026-11-19T00:00:00-05:00" → "YYYY-MM-DDThh:mm:ss±hh:mm": the shape of a value, for the stats. */
export function deadlineShape(v: string): string {
  return v ? v.replace(/\d/g, 'D').replace(/D{4}-DD-DD/, 'YYYY-MM-DD') : 'blank';
}

/**
 * Pure streaming parser: push the file's bytes in any chunking, get the kept drafts at the end.
 *
 *   const p = new SamBulkParser({ now });
 *   for await (const chunk of stream) p.push(chunk);
 *   const drafts = p.finish();
 *
 * Throws (so the scan report says FAILED) when the file is not the CSV we know: an HTML or error page,
 * a missing or renamed column, rows that never parse, or a file that ends inside a quoted field.
 */
export class SamBulkParser {
  private readonly csv = new CsvSplitter();
  private col: Record<Column, number> | null = null;
  private width = 0;
  private readonly kept: Array<{ posted: string; draft: BidDraft; zoneless?: string; office: SamOffice | null }> = [];
  /** "<Sol#>|<wall time>" → the offset another notice of the same solicitation wrote for that same time. */
  private readonly offsets = new Map<string, string>();
  readonly stats: BulkStats = {
    bytes: 0, rows: 0, active: 0, kept: 0, keptByPsc: 0, cards: 0, placedAtOffice: 0, malformed: 0,
    dropped: { inactive: 0, type: 0, naics: 0, country: 0, noPlace: 0, pastDue: 0, stale: 0, noId: 0 },
    deadlineShapes: {},
  };

  constructor(private readonly opts: BulkOptions = {}) {}

  /** Bytes read so far (stats.bytes is only filled in by finish()). */
  get bytesRead(): number {
    return this.csv.bytes;
  }

  push(chunk: Uint8Array): void {
    if (this.csv.bytes === 0) checkNotHtml(chunk);
    for (const rec of this.csv.push(chunk)) this.record(rec);
  }

  finish(): BidDraft[] {
    for (const rec of this.csv.end()) this.record(rec);
    this.stats.bytes = this.csv.bytes;
    if (!this.col) throw new Error('SAM.gov bulk file is empty (no header row)');
    if (this.stats.rows === 0) throw new Error('SAM.gov bulk file has a header but no rows');
    if (this.stats.malformed > Math.max(10, this.stats.rows * 0.01)) {
      throw new Error(`SAM.gov bulk file: ${this.stats.malformed} of ${this.stats.rows} rows have the wrong number of columns — the format changed?`);
    }
    if (this.stats.active === 0) throw new Error(`SAM.gov bulk file: ${this.stats.rows} rows but none active — the Active column changed?`);
    // The whole country never has zero open construction notices (8,840 rows passed on 2026-11-13): if a big file
    // gives none, the Type or NaicsCode values changed and we would be quietly showing nothing.
    if (this.stats.rows >= MIN_ROWS_FOR_SANITY && this.stats.kept === 0) {
      throw new Error(`SAM.gov bulk file: ${this.stats.rows} rows but not one open construction notice — the Type or NaicsCode values changed?`);
    }
    // A deadline written with no time zone: use the offset a sibling notice wrote for the same wall time, else
    // keep the Pacific reading and say so on the card (FLAGS.deadlineZoneUnstated).
    for (const k of this.kept) {
      if (!k.zoneless) continue;
      const offset = this.offsets.get(`${k.draft.sourceId}|${k.zoneless}`);
      if (offset) k.draft.dueAt = new Date(`${k.zoneless}${offset}`).toISOString();
      else k.draft.flags = [...(k.draft.flags ?? []), FLAGS.deadlineZoneUnstated];
    }
    // Older notices first, so mergeDrafts' "a full tie keeps the later draft" also means "the newer one" within a day.
    const sorted = this.kept.sort((a, b) => (a.posted < b.posted ? -1 : a.posted > b.posted ? 1 : 0));
    const ordered = sorted.map((k) => k.draft);
    // The office of the newest notice of each solicitation that names a US one (later in `sorted` = newer).
    const offices = new Map<string, SamOffice>();
    for (const k of sorted) if (k.office) offices.set(k.draft.sourceId, k.office);
    // Merge first, filter after: the newest amendment decides the deadline, and a place only an older
    // notice gave is carried over (mergeDrafts), so a card is judged on what it will actually show.
    const cards: BidDraft[] = [];
    const now = this.opts.now?.getTime();
    for (const merged of mergeDrafts(ordered)) {
      let d = merged;
      // No notice of it names a work site: place it at the contracting office when that is in the US (the card
      // says so), else leave it out — we cannot say it is in the US at all.
      if (namesNoPlace(d)) {
        const office = offices.get(d.sourceId);
        if (!office) { this.stats.dropped.noPlace++; continue; }
        d = placeAtOffice(d, office);
      }
      if (now !== undefined && d.dueAt && Date.parse(d.dueAt) <= now) { this.stats.dropped.pastDue++; continue; }
      if (now !== undefined && !d.dueAt && d.postedAt && now - Date.parse(d.postedAt) > STALE_AFTER_DAYS * 86_400_000) {
        this.stats.dropped.stale++;
        continue;
      }
      if (d.flags?.includes(FLAGS.placeFromOffice)) this.stats.placedAtOffice++;
      cards.push(d);
    }
    this.stats.cards = cards.length;
    return cards;
  }

  private record(fields: Uint8Array[]): void {
    if (!this.col) {
      this.header(fields.map(decodeField));
      return;
    }
    if (fields.length === 1 && fields[0]!.length === 0) return; // a blank line
    this.stats.rows++;
    if (fields.length !== this.width) {
      this.stats.malformed++;
      return;
    }
    const c = this.col;
    const get = (name: Column): string => decodeField(fields[c[name]]!).trim();
    // Cheapest tests first: most of the 2026-11-13 file is services and supplies, dropped before any text is decoded.
    if (get('Active').toLowerCase() !== 'yes') { this.stats.dropped.inactive++; return; }
    this.stats.active++;
    if (!OPEN_TYPES.has(get('Type').toLowerCase())) { this.stats.dropped.type++; return; }
    const naics = get('NaicsCode');
    if (!isTradeNotice(naics, get('ClassificationCode'))) { this.stats.dropped.naics++; return; }
    // Most rows leave PopCountry blank (50,384 of 72,318 on 2026-11-13). Only a named foreign country is
    // dropped here; a notice that names no place at all is judged after merging (an amendment may omit it).
    // A blank country with a foreign region code in PopState ("JP-14", "GT-GU") is abroad too.
    const country = get('PopCountry');
    const state = get('PopState');
    const foreignState = !!state && !NO_STATE.test(state) && parseSamPlace({ state: stateField(state) }).state === null;
    if ((country && !US_COUNTRY.test(country) && !territoryOf(country)) || (!country && foreignState)) { this.stats.dropped.country++; return; }
    const noticeId = get('NoticeId');
    if (!noticeId) { this.stats.dropped.noId++; return; }

    const deadline = get('ResponseDeadLine');
    const shape = deadlineShape(deadline);
    this.stats.deadlineShapes[shape] = (this.stats.deadlineShapes[shape] ?? 0) + 1;
    this.stats.kept++;
    if (!isTradeNaics(naics)) this.stats.keptByPsc++;
    const opp = rowToOpportunity(get);
    const draft = samDraft(opp);
    // Remember every offset a notice wrote, by solicitation and wall time, for its zoneless siblings (finish()).
    const zoned = ZONED.exec(deadline);
    if (zoned) this.offsets.set(`${draft.sourceId}|${withSeconds(zoned[1]!)}`, zoned[2]!);
    const zoneless = ZONELESS.test(deadline) ? withSeconds(deadline) : undefined;
    this.kept.push({ posted: get('PostedDate'), draft, office: samOffice(opp.officeAddress), ...(zoneless ? { zoneless } : {}) });
  }

  private header(names: string[]): void {
    const missing = BULK_COLUMNS.filter((n) => !names.includes(n));
    if (missing.length) {
      throw new Error(`SAM.gov bulk file: column${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(', ')} missing — SAM changed the file`);
    }
    this.col = Object.fromEntries(BULK_COLUMNS.map((n) => [n, names.indexOf(n)])) as Record<Column, number>;
    this.width = names.length;
  }
}

/** "2026-12-02T16:00:00-05:00": the wall time and its offset. */
const ZONED = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)([+-]\d{2}:\d{2}|Z)$/;
/** "2026-12-02T16:00:00": a wall time with no zone (714 rows on 2026-11-13). */
const ZONELESS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const withSeconds = (wall: string): string => (wall.length === 16 ? `${wall}:00` : wall);

/** An HTML page or a JSON error instead of the CSV: say what came back, briefly. */
function checkNotHtml(first: Uint8Array): void {
  const head = new TextDecoder('windows-1252').decode(first.subarray(0, 200)).replace(/^﻿/, '').trimStart();
  if (head.startsWith('"NoticeId"') || head.startsWith('NoticeId')) return;
  if (/^</.test(head) || /^[{[]/.test(head)) {
    throw new Error(`SAM.gov bulk file: got ${head.startsWith('<') ? 'an HTML page' : 'a JSON body'} instead of the CSV: ${head.slice(0, 80).replace(/\s+/g, ' ')}`);
  }
}

/**
 * One CSV row → the API's notice shape, so samDraft() (shared with the API source) does the mapping once.
 * The API's agency path is "DEPT.SUB-TIER.OFFICE…"; prettyAgency reads its first and last parts, which the
 * file gives as Department/Ind.Agency and Office.
 *
 * PostedDate is "2026-11-12 15:19:35" with no zone; the API sends only the date. We pass the date alone,
 * so both paths give the same postedAt (08:00 Pacific that day) and the same "newest notice wins" order.
 */
function rowToOpportunity(get: (name: Column) => string): SamOpportunity {
  const path = [get('Department/Ind.Agency'), get('Sub-Tier'), get('Office')].filter(Boolean).join('.');
  const territory = territoryOf(get('PopCountry'));
  const popState = get('PopState');
  const state = !popState && territory ? territory : popState; // "VIR" with no state → VI
  return {
    noticeId: get('NoticeId'),
    title: get('Title'),
    solicitationNumber: get('Sol#'),
    fullParentPathName: path,
    postedDate: get('PostedDate').slice(0, 10),
    type: get('Type'),
    typeOfSetAside: get('SetASideCode') || null,
    typeOfSetAsideDescription: get('SetASide') || null,
    responseDeadLine: deadlineForTime(get('ResponseDeadLine')),
    naicsCode: get('NaicsCode') || null,
    classificationCode: get('ClassificationCode') || null,
    active: 'Yes',
    description: get('Description') || null,
    placeOfPerformance: {
      streetAddress: get('PopStreetAddress'),
      city: { name: get('PopCity') },
      state: NO_STATE.test(state) ? {} : stateField(state),
      zip: get('PopZip'),
      country: { code: territory ? 'USA' : get('PopCountry') },
    },
    officeAddress: { city: get('City'), state: get('State'), zipcode: get('ZipCode'), countryCode: get('CountryCode') },
    uiLink: get('Link'),
  };
}

/** One log line: what the file held and why rows were left out. */
export function bulkSummary(s: BulkStats): string {
  const d = s.dropped;
  return `samgov (bulk file): ${s.cards} cards from ${s.kept} notices (${s.keptByPsc} by service code alone)` +
    `${s.placedAtOffice ? `, ${s.placedAtOffice} placed at the contracting office (no work site named)` : ''}` +
    ` — ${s.rows} rows, ${s.active} active; left out: ` +
    `${d.type} not open bids, ${d.naics} not construction/trades, ${d.country} abroad, ${d.noPlace} no place given, ` +
    `${d.pastDue} past due${d.stale ? `, ${d.stale} stale (no deadline, posted over a year ago)` : ''}` +
    `${s.malformed ? `, ${s.malformed} malformed rows` : ''} (${(s.bytes / 1e6).toFixed(1)} MB)`;
}

/**
 * ResponseDeadLine shapes in the 2026-11-13 file (all rows): "2026-11-19T00:00:00-05:00" (49,874), blank (8,672),
 * "2026-12-14" (11,443), "2026-11-27T10:00:00+07:00" (1,615) and "2026-12-02T16:00:00" with no offset (714).
 * All go through util/time.ts (parseUsDateTime): an offset is trusted, no offset means Pacific wall-clock time
 * like every other board, a bare date means 5 PM Pacific that day (finish() then looks for a sibling notice's
 * offset, see FLAGS.deadlineZoneUnstated). The no-offset form gets a space for its "T": parseUsDateTime used to
 * read "T10:00" as "00:00" (fixed in util/time.ts on 2026-11-13); the space keeps both versions right.
 */
export function deadlineForTime(v: string): string | null {
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(v) ? v.replace('T', ' ') : v;
}

/** Parse a whole file held in memory (tests, the fixture reader). Real scans stream it: fetchSamBulk. */
export function parseSamBulk(bytes: Uint8Array, opts: BulkOptions = {}): { drafts: BidDraft[]; stats: BulkStats } {
  const p = new SamBulkParser(opts);
  p.push(bytes);
  const drafts = p.finish();
  return { drafts, stats: p.stats };
}

// ----------------------------------------------------------------- fetch --

/** What fetchSamBulk needs from the http client: a GET whose body arrives as a stream of bytes. */
export interface StreamingHttp {
  stream(url: string): Promise<AsyncIterable<Uint8Array>>;
}

export function canStream(http: FetchLike): http is FetchLike & StreamingHttp {
  return typeof http.stream === 'function';
}

/**
 * Download and parse the bulk file in one pass. Nothing but the kept drafts stays in memory: each chunk
 * is parsed and dropped as it arrives. Notices already past due at ctx.now are left out.
 */
export async function fetchSamBulk(ctx: SourceContext): Promise<BidDraft[]> {
  if (!canStream(ctx.http)) throw new Error('SAM.gov bulk file needs an http client that can stream (util/http.ts createHttp)');
  const parser = new SamBulkParser({ now: ctx.now });
  try {
    for await (const chunk of await ctx.http.stream(SAM_BULK_URL)) parser.push(chunk);
  } catch (err) {
    // undici says only "terminated" when the connection drops mid-body: name the source and how far it got.
    const why = err instanceof Error ? err.message : String(err);
    if (parser.bytesRead === 0) throw err; // nothing arrived: the http client's own message says what happened
    throw new Error(`SAM.gov bulk file: download stopped after ${(parser.bytesRead / 1e6).toFixed(1)} MB (${why})`);
  }
  const drafts = parser.finish();
  // A download that ended cleanly but early looks like a small file: refuse it rather than show part of the
  // country as all of it (the report says FAILED, and yesterday's stored bids stay as they are).
  const minRows = Number(ctx.env('SAM_BULK_MIN_ROWS') ?? LIVE_MIN_ROWS);
  if (Number.isFinite(minRows) && parser.stats.rows < minRows) {
    throw new Error(`SAM.gov bulk file: only ${parser.stats.rows} rows (${(parser.stats.bytes / 1e6).toFixed(1)} MB) — the download ` +
      `stopped early? The daily file has about 70,000 (SAM_BULK_MIN_ROWS=${minRows})`);
  }
  ctx.log(bulkSummary(parser.stats));
  return drafts;
}
