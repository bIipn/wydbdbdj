import type { BidDraft, Source } from '../types.js';
import { parseUsDateTime, samDate } from '../util/time.js';
import { clean, cleanOrNull, titleCaseIfShouting } from '../util/text.js';
import { mergeDrafts, samKey } from './dedupe.js';
import { FLAGS, PROGRAM_CONTRACT_TERMS } from './flags.js';

/** Official SAM.gov Get Opportunities API v2 — https://open.gsa.gov/api/get-opportunities-public-api/ */
export const SAM_API = 'https://api.sam.gov/opportunities/v2/search';

/** SAM sends each part of the place of performance as an object, or leaves it out, or sends it empty. */
export interface SamPlace {
  streetAddress?: string;
  streetAddress2?: string;
  city?: { code?: string; name?: string };
  state?: { code?: string; name?: string };
  zip?: string;
  country?: { code?: string; name?: string };
}

export interface SamOpportunity {
  noticeId: string;
  title?: string;
  solicitationNumber?: string;
  fullParentPathName?: string;
  postedDate?: string;
  type?: string;
  baseType?: string;
  typeOfSetAside?: string | null;
  typeOfSetAsideDescription?: string | null;
  responseDeadLine?: string | null;
  naicsCode?: string | null;
  active?: string;
  description?: string | null;
  placeOfPerformance?: SamPlace;
  uiLink?: string;
}

export interface SamResponse {
  totalRecords?: number;
  opportunitiesData?: SamOpportunity[];
}

/**
 * A personal SAM.gov key can be limited to very few calls per day, so we keep
 * this to 3 calls: everything in Nevada, plus electrical and building
 * construction in California (Tahoe side). Scoring filters the rest.
 */
export const SAM_QUERIES: Array<{ state: string; ncode?: string }> = [
  { state: 'NV' },
  { state: 'CA', ncode: '238210' },
  { state: 'CA', ncode: '236220' },
];

/** The exact flag strings the scorer acts on (one copy, in flags.ts). */
export const SAM_FLAGS = {
  /** An advance notice: the bid package is not out yet (or SAM still lists the notice that announced it). */
  presolicitation: FLAGS.presolicitation,
  /** A multi-year vehicle (IDIQ, JOC, MATOC, BPA, OTA…) that hands out task orders, not one job. */
  programContract: FLAGS.programContract,
} as const;

export function buildSamUrl(p: { apiKey: string; state: string; ncode?: string; from: Date; to: Date; limit?: number }): string {
  const u = new URL(SAM_API);
  u.searchParams.set('api_key', p.apiKey);
  u.searchParams.set('postedFrom', samDate(p.from));
  u.searchParams.set('postedTo', samDate(p.to));
  u.searchParams.set('ptype', 'o,k,p'); // solicitations, combined synopsis/solicitation, presolicitation
  u.searchParams.set('state', p.state);
  if (p.ncode) u.searchParams.set('ncode', p.ncode);
  u.searchParams.set('limit', String(p.limit ?? 1000));
  u.searchParams.set('offset', '0');
  return u.toString();
}

/** "GENERAL SERVICES ADMINISTRATION.PUBLIC BUILDINGS SERVICE.PBS R9" → "General Services Administration · PBS R9" */
export function prettyAgency(path: string | undefined): string | null {
  if (!path) return null;
  const parts = path.split('.').map((s) => titleCaseIfShouting(s.trim())).filter(Boolean);
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : `${parts[0]} · ${parts[parts.length - 1]}`;
}

// ------------------------------------------------------------- place --

/** Full names → codes: every state, DC and the inhabited territories (SAM sometimes sends only the name). */
const STATE_CODES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE',
  nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'puerto rico': 'PR', guam: 'GU',
  'virgin islands': 'VI', 'american samoa': 'AS', 'northern mariana islands': 'MP',
};
const CODES = new Set(Object.values(STATE_CODES));
// Longest first, so "West Virginia" is read before "Virginia" and "New Mexico" is never split.
const STATE_NAME_RES = Object.entries(STATE_CODES)
  .sort(([a], [b]) => b.length - a.length)
  .map(([name, code]) => ({ re: new RegExp(`\\b${name}\\b`, 'gi'), code }));
/** Names that contain a state but are not one: "VA Sierra Nevada Health Care System" is in Reno, not "Nevada". */
const NOT_A_STATE = /\bsierra nevada\b|\bgeorge washington\b|\bwashington (?:st(?:reet)?|ave(?:nue)?|blvd|boulevard|road|rd)\b/gi;

/** Every state a free-text address names: full names, plus a ", CA 95814" code before a ZIP. */
export function statesInText(text: string): string[] {
  let t = text.replace(NOT_A_STATE, ' ');
  const out = new Set<string>();
  for (const { re, code } of STATE_NAME_RES) {
    t = t.replace(re, () => (out.add(code), ' '));
  }
  for (const m of t.matchAll(/,\s*([A-Z]{2})\.?\s+\d{5}\b/g)) if (CODES.has(m[1]!)) out.add(m[1]!);
  return [...out].sort();
}

function stateCode(s: { code?: string; name?: string } | undefined): string | null {
  for (const v of [s?.code, s?.name]) {
    const c = clean(v).toUpperCase();
    if (/^[A-Z]{2}$/.test(c) && CODES.has(c)) return c;
  }
  return STATE_CODES[clean(s?.name).toLowerCase()] ?? null;
}

const SEVERAL = /\b(?:various|multiple|several)\b|\bother locations\b|\barea of responsibility\b|\bAOR\b/i;

export interface SamPlaceParsed {
  city: string | null;
  state: string | null;
  zip: string | null;
  /** The street-address text SAM gave, if any (whitespace tidied). */
  text: string | null;
  /** No city and no ZIP, and the text lists several sites or names more than one state. */
  multiSite: boolean;
}

/**
 * Read every place-of-performance shape SAM.gov sends (all seen in the 2026-11-13 capture):
 * city/state/zip objects; a street address + ZIP with no city or state objects; a city of "0";
 * a state given by name only ("Hawaii", or "CA" in the name field); and an empty object.
 */
export function parseSamPlace(pop: SamPlace | undefined): SamPlaceParsed {
  const p = pop ?? {};
  const name = clean(p.city?.name);
  const city = /[a-z]/i.test(name) ? name : null; // "0" and "" are SAM placeholders
  const zip = /^\d{5}(?:-?\d{4})?$/.test(clean(p.zip)) ? clean(p.zip) : null; // ZIP+4 kept as given; "" → null
  const text = cleanOrNull([p.streetAddress, p.streetAddress2].map((s) => clean(s)).filter(Boolean).join(', '));
  const named = text ? statesInText(text) : [];
  const state = stateCode(p.state) ?? (named.length === 1 ? named[0]! : null);
  const multiSite = !city && !zip && !!text && (SEVERAL.test(text) || named.length > 1);
  return { city, state, zip, text, multiSite };
}

/** What the card says when we cannot put a point on the map: what SAM said, kept short. */
function placeLabel(p: SamPlaceParsed): string | null {
  if (p.multiSite) {
    const states = p.text ? statesInText(p.text) : [];
    return `Several sites${states.length ? ` in ${states.join(', ')}` : ''} — see the bid`;
  }
  if (!p.text) return null;
  return p.text.length > 80 ? `${p.text.slice(0, 79).trimEnd()}…` : p.text;
}

// ----------------------------------------------------------- signals --

/**
 * The SAM set-aside code a title or description names, for notices whose code field is empty.
 * Never guesses on a notice that says it is open to everyone. "8(a)" must have its brackets:
 * a bare "8A" is a part number in real titles ("PS-8A Rehabilitation").
 */
export function setAsideFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  if (/\bunrestricted\b|\bfull\s*(?:and|&)\s*open\b|evaluation\s+preference/i.test(text)) return null;
  if (/\b8\s?\(a\)/i.test(text)) return '8A';
  if (/\bSDVOSB\b|service[- ]disabled[- ]veteran/i.test(text)) return 'SDVOSBC';
  if (/\bHUB\s?Zone\b/i.test(text)) return 'HZC';
  if (/\bEDWOSB\b|economically disadvantaged wom[ae]n/i.test(text)) return 'EDWOSB';
  if (/\bWOSB\b|wom[ae]n[- ]owned/i.test(text)) return 'WOSB';
  if (/\bVOSB\b|veteran[- ]owned/i.test(text)) return 'VSA';
  if (/\bsmall[- ]business\b[^.;]{0,20}\bset[- ]aside\b|\bset[- ]aside\b[^.;]{0,20}\bsmall[- ]business\b/i.test(text)) {
    return /\bpartial\b/i.test(text) ? 'SBP' : 'SBA';
  }
  return null;
}

/** Contract vehicles: one award that hands out task orders for years. Whole words only (shared with score.ts). */
export function isProgramContract(text: string | null | undefined): boolean {
  return !!text && PROGRAM_CONTRACT_TERMS.test(text);
}

/** The notice is an advance notice, not the bid package (SAM's own type, or a title that says so). */
export function isPresolicitation(o: Pick<SamOpportunity, 'type' | 'title'>): boolean {
  return clean(o.type).toLowerCase() === 'presolicitation' || /^\s*(?:pre-?solicitation|sources? sought|request for information)\b/i.test(o.title ?? '');
}

const EMPTY_CODE = /^(?:|none|n\/a|null)$/i;

/**
 * One draft per solicitation: every notice in the response is read, then notices of the same
 * solicitation (amendments, the presolicitation that announced it) are merged — the newest wins and
 * a place or set-aside only an older notice carries is kept. The card id is the solicitation number
 * (samKey), so it stays the same when SAM posts the next amendment.
 */
export function parseSamResponse(json: SamResponse): BidDraft[] {
  const drafts = (json.opportunitiesData ?? [])
    .filter((o) => o.noticeId && o.active !== 'No')
    .map((o): BidDraft => {
      const place = parseSamPlace(o.placeOfPerformance);
      const sol = cleanOrNull(o.solicitationNumber);
      const title = cleanOrNull(o.title) ?? `Federal opportunity ${sol ?? o.noticeId}`;
      const ownText = o.description && !/^https?:\/\//i.test(o.description.trim()) ? o.description : null; // usually a link
      const code = clean(o.typeOfSetAside);
      const setAside = EMPTY_CODE.test(code) ? setAsideFromText([title, ownText].filter(Boolean).join(' · ')) : code;
      const extra = [o.type, o.typeOfSetAsideDescription].filter(Boolean).join(' · ');
      const flags: string[] = [];
      if (isPresolicitation(o)) flags.push(SAM_FLAGS.presolicitation);
      if (isProgramContract(title) || isProgramContract(ownText)) flags.push(SAM_FLAGS.programContract);
      return {
        source: 'samgov',
        sourceId: samKey(sol, o.noticeId),
        sourceName: 'SAM.gov (federal)',
        title,
        agency: prettyAgency(o.fullParentPathName),
        description: extra ? `${extra}${sol ? ` · Sol. ${sol}` : ''}` : sol ? `Sol. ${sol}` : null,
        category: cleanOrNull(o.type),
        location: { city: place.city, state: place.state, zip: place.zip, label: placeLabel(place) },
        postedAt: parseUsDateTime(o.postedDate, { defaultTime: [8, 0] }),
        dueAt: parseUsDateTime(o.responseDeadLine ?? null),
        estValue: null,
        naics: cleanOrNull(o.naicsCode),
        setAside: setAside || null,
        url: o.uiLink && o.uiLink.startsWith('http') ? o.uiLink : `https://sam.gov/opp/${o.noticeId}/view`,
        flags,
        solNumber: sol,
      };
    });
  return mergeDrafts(drafts);
}

export const samgovSource: Source = {
  id: 'samgov',
  name: 'SAM.gov (federal)',
  homepage: 'https://sam.gov/search/?index=opp',
  disabledReason: (ctx) =>
    ctx.env('SAM_API_KEY') ? null : 'SAM_API_KEY not set (free: sam.gov → Account Details → Public API Key)',
  async fetch(ctx) {
    const apiKey = ctx.env('SAM_API_KEY')!;
    // Overlap a few days. The same solicitation can come back from two queries or two scans: runScan
    // merges drafts by id (mergeDrafts) and with the stored bid, so it stays one card.
    const from = new Date(ctx.now.getTime() - 3 * 86_400_000);
    const out: BidDraft[] = [];
    for (const q of SAM_QUERIES) {
      const json = await ctx.http.json<SamResponse>(buildSamUrl({ apiKey, ...q, from, to: ctx.now }));
      const bids = parseSamResponse(json);
      ctx.log(`samgov ${q.state}${q.ncode ? `/${q.ncode}` : ''}: ${bids.length}`);
      out.push(...bids);
    }
    return out;
  },
};
