import type { BidDraft, Source } from '../types.js';
import { parseUsDateTime, samDate } from '../util/time.js';
import { cleanOrNull, titleCaseIfShouting } from '../util/text.js';

/** Official SAM.gov Get Opportunities API v2 — https://open.gsa.gov/api/get-opportunities-public-api/ */
export const SAM_API = 'https://api.sam.gov/opportunities/v2/search';

interface SamOpportunity {
  noticeId: string;
  title?: string;
  solicitationNumber?: string;
  fullParentPathName?: string;
  postedDate?: string;
  type?: string;
  typeOfSetAside?: string | null;
  typeOfSetAsideDescription?: string | null;
  responseDeadLine?: string | null;
  naicsCode?: string | null;
  active?: string;
  placeOfPerformance?: {
    city?: { code?: string; name?: string };
    state?: { code?: string; name?: string };
    zip?: string;
  };
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

export function parseSamResponse(json: SamResponse): BidDraft[] {
  return (json.opportunitiesData ?? [])
    .filter((o) => o.noticeId && o.active !== 'No')
    .map((o): BidDraft => {
      const pop = o.placeOfPerformance ?? {};
      const extra = [o.type, o.typeOfSetAsideDescription].filter(Boolean).join(' · ');
      return {
        source: 'samgov',
        sourceId: o.noticeId,
        sourceName: 'SAM.gov (federal)',
        title: cleanOrNull(o.title) ?? `Federal opportunity ${o.solicitationNumber ?? o.noticeId}`,
        agency: prettyAgency(o.fullParentPathName),
        description: extra ? `${extra}${o.solicitationNumber ? ` · Sol. ${o.solicitationNumber}` : ''}` : null,
        category: o.type ?? null,
        location: {
          city: pop.city?.name ?? null,
          state: pop.state?.code ?? null,
          zip: pop.zip ?? null,
        },
        postedAt: parseUsDateTime(o.postedDate, { defaultTime: [8, 0] }),
        dueAt: parseUsDateTime(o.responseDeadLine ?? null),
        estValue: null,
        naics: o.naicsCode ?? null,
        setAside: o.typeOfSetAside ?? null,
        url: o.uiLink && o.uiLink.startsWith('http') ? o.uiLink : `https://sam.gov/opp/${o.noticeId}/view`,
      };
    });
}

export const samgovSource: Source = {
  id: 'samgov',
  name: 'SAM.gov (federal)',
  homepage: 'https://sam.gov/search/?index=opp',
  disabledReason: (ctx) =>
    ctx.env('SAM_API_KEY') ? null : 'SAM_API_KEY not set (free: sam.gov → Account Details → Public API Key)',
  async fetch(ctx) {
    const apiKey = ctx.env('SAM_API_KEY')!;
    const from = new Date(ctx.now.getTime() - 3 * 86_400_000); // overlap a few days; dedupe handles repeats
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
