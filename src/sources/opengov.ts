import type { BidDraft, Source, SourceContext, SourceSlice } from '../types.js';
import { outOfTime, stopAtBudget } from './budget.js';
import { isTradeWork } from './relevance.js';
import { detectFlags } from '../util/flags.js';
import { findEstimate } from '../util/money.js';
import { clean, cleanOrNull, htmlToText, truncate } from '../util/text.js';

/**
 * OpenGov Procurement public portals: 562 active governments on one API host (128 in California: County of
 * Sacramento, Rancho Cordova, West Sacramento, SACOG, SHRA, Sac Metro Fire, San Joaquin RTD, Stockton USD …).
 *
 * Two public JSON calls, no login, no key (the portal at procurement.opengov.com makes the same ones):
 *  1. GET  https://api.procurement.opengov.com/api/v1/government
 *     → array of every government on the platform (first response 2026-11-14 05:59 UTC: 588 entries, 562 active
 *       and not deleted). Per entry: name, city, state, zipCode, timezone (IANA), isActive, isInternal, deleted_at,
 *       government { id, code }. Fixture: test/fixtures/opengov-governments.json (13 whole entries).
 *  2. POST https://api.procurement.opengov.com/api/v1/government/<code>/project/public
 *     body {"filters":[{"type":"status","value":"open"}],"quickSearchQuery":null,"limit":100,"page":1}
 *     → { count, rows[] }. Per row: id, title, financialId (the board's own number), status, summary (HTML),
 *       releaseProjectDate, proposalDeadline, isPrivate, isPaused, comingSoon, department { name }, template { title },
 *       addendums [ { id } ], government { code, organization { name, city, state, zipCode, timezone } }.
 *     First made by us for County of Sacramento on 2026-11-14 06:26 UTC: count 11
 *     (test/fixtures/opengov-projects-saccounty.json); City of San Marino 06:27 UTC: count 0 (…-empty.json);
 *     City of Lakeport 06:27 UTC: count 1 (…-lakeport.json). No address or location field on a project.
 * Card: https://procurement.opengov.com/portal/<code>/projects/<id> (the portal's own project page).
 *
 * TIMES: proposalDeadline and releaseProjectDate are ISO instants WITH a zone ("2026-11-20T20:00:00.000Z" =
 * noon in Sacramento), written by the API, not wall-clock board text: they are stored as they are (toISOString).
 * The government's own `timezone` is therefore not needed to read them; it is kept on OpenGovGovernment for the
 * log and for a future field that comes without a zone. Nothing here guesses a zone.
 * PLACE: a project names no site, so it is placed at the government's seat (city + state from the government;
 * a fair place for a city's or a county's job). locate() (src/geo) does the rest; an unknown city stays unplaced
 * except for the state.
 *
 * Too big for one scan group (one POST per government, 1,000 ms apart): it runs in SLICES by state, one per group
 * (src/sources/scan-groups.ts, Source.slices below). ctx.slice absent = every government (a local full scan).
 */

export const OPENGOV_API = 'https://api.procurement.opengov.com/api/v1';
export const OPENGOV_GOVERNMENTS_URL = `${OPENGOV_API}/government`;
export const openGovProjectsUrl = (code: string): string => `${OPENGOV_API}/government/${encodeURIComponent(code)}/project/public`;
export const openGovProjectPage = (code: string, id: number | string): string =>
  `https://procurement.opengov.com/portal/${encodeURIComponent(code)}/projects/${encodeURIComponent(String(id))}`;

/** One page of a government's open projects (the API's maximum page we ask for). */
export const OPENGOV_PAGE_SIZE = 100;
/** A government with more open projects than this many pages is read up to here and logged. */
const MAX_PAGES = 10;
/** This many governments failing one after another means the API changed (or refuses us): the source FAILS. */
export const MAX_FAILURES_IN_A_ROW = 10;
/** Fewer governments than this in the list means it is not the list we know (588 on 2026-11-14). */
const MIN_GOVERNMENTS = 100;
/** Cards keep this much of the summary; flags and the estimate read all of it. */
const DESCRIPTION_MAX = 900;

export function openGovBody(page: number): string {
  return JSON.stringify({ filters: [{ type: 'status', value: 'open' }], quickSearchQuery: null, limit: OPENGOV_PAGE_SIZE, page });
}

// --------------------------------------------------------------------- the list --

/** The fields of a government-list entry we read (the API sends ~40 more). */
export interface OpenGovGovernmentRow {
  name?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  timezone?: string | null;
  isActive?: boolean | null;
  isInternal?: boolean | null;
  deleted_at?: string | null;
  government?: { id?: number | null; code?: string | null } | null;
}

/** A government whose open projects we read. */
export interface OpenGovGovernment {
  code: string;
  name: string;
  city: string | null;
  state: string | null;
  timezone: string | null;
}

export interface GovernmentList {
  governments: OpenGovGovernment[];
  /** Entries the list had in all, and why the rest were left out. */
  listed: number;
  inactive: number;
  internal: number;
  noState: number;
  otherSlices: number;
}

/**
 * The governments to read, in a stable order (by code). Left out: inactive or deleted (the portal shows them no
 * more), OpenGov's own internal portals (isInternal: demos, training, QA; their projects are not real bids), and
 * entries with no state (every one of the 5 on 2026-11-14 is a test portal: "cityofshenanigans", "tfprodemo" …).
 * With a slice, only the governments whose state the slice has. THROWS when the answer is not the list we know
 * (not an array, under `minGovernments` entries, over a tenth of them without a code, or under half of them
 * active with a state, so a renamed field never turns into a quiet 0). Tests that replay the
 * trimmed fixture (13 entries) pass a lower minimum.
 */
export function parseOpenGovGovernments(
  json: unknown, slice?: Pick<SourceSlice, 'has'>, minGovernments = MIN_GOVERNMENTS,
): GovernmentList {
  if (!Array.isArray(json)) throw new Error(`opengov: the government list is not a JSON array (${typeof json})`);
  const rows = json as OpenGovGovernmentRow[];
  const withCode = rows.filter((g) => g && typeof g === 'object' && typeof g.government?.code === 'string' && g.government.code);
  if (rows.length < minGovernments || withCode.length < rows.length * 0.9) {
    throw new Error(`opengov: the government list has ${rows.length} entries, ${withCode.length} with a code — not the list we know`);
  }
  // The list must still hold usable governments as a WHOLE, before the slice is applied: a renamed `state`
  // field or a changed `isActive` would otherwise filter every government out and the scan would say "0 bids"
  // with no error. (An empty slice of a healthy list is fine: that slice has no governments today.)
  const usable = withCode.filter((g) => g.isActive === true && !g.deleted_at && g.isInternal !== true && cleanOrNull(g.state)).length;
  if (usable < Math.max(minGovernments / 2, withCode.length / 2)) {
    throw new Error(`opengov: only ${usable} of ${rows.length} governments are active with a state — the list changed shape`);
  }
  const out: GovernmentList = { governments: [], listed: rows.length, inactive: 0, internal: 0, noState: 0, otherSlices: 0 };
  for (const g of withCode) {
    if (g.isActive !== true || g.deleted_at) { out.inactive++; continue; }
    if (g.isInternal === true) { out.internal++; continue; }
    const state = cleanOrNull(g.state)?.toUpperCase() ?? null;
    if (!state) { out.noState++; continue; }
    if (slice && !slice.has(state)) { out.otherSlices++; continue; }
    out.governments.push({
      code: g.government!.code!,
      name: clean(g.name) || g.government!.code!,
      city: cleanOrNull(g.city),
      state,
      timezone: cleanOrNull(g.timezone),
    });
  }
  out.governments.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return out;
}

// ----------------------------------------------------------------- the projects --

export interface OpenGovProjectRow {
  id?: number | null;
  title?: string | null;
  financialId?: string | null;
  status?: string | null;
  summary?: string | null;
  releaseProjectDate?: string | null;
  proposalDeadline?: string | null;
  isPrivate?: boolean | null;
  isPaused?: boolean | null;
  comingSoon?: boolean | null;
  department?: { name?: string | null } | null;
  template?: { title?: string | null } | null;
  government?: {
    code?: string | null;
    organization?: { name?: string | null; city?: string | null; state?: string | null; timezone?: string | null } | null;
  } | null;
}

export interface OpenGovProjectsAnswer {
  count: number;
  rows: OpenGovProjectRow[];
}

/** Is this the answer we know ({ count, rows[] })? A login page, an HTML error or a changed shape is not. */
export function checkOpenGovAnswer(json: unknown): OpenGovProjectsAnswer {
  const a = json as Partial<OpenGovProjectsAnswer> | null;
  if (!a || typeof a !== 'object' || Array.isArray(a) || !Array.isArray(a.rows) || typeof a.count !== 'number') {
    throw new Error('not the { count, rows } answer we know');
  }
  if (a.count > 0 && a.rows.length === 0) throw new Error(`it announces ${a.count} open projects but lists none`);
  return a as OpenGovProjectsAnswer;
}

/** An ISO instant from the API ("2026-11-20T20:00:00.000Z") → ISO UTC, or null. Only instants WITH a zone. */
function instant(v: string | null | undefined): string | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export interface ParsedProjects {
  /** Trade work, as drafts. */
  bids: BidDraft[];
  /** Open projects listed (rows with an id and a title). */
  open: number;
  /** Left out as not trade work (isTradeWork). */
  notTrade: number;
  /** Left out because nobody can bid on them through the public page yet: private, paused or "coming soon". */
  notBiddable: number;
}

/**
 * One government's open projects → drafts. PURE. Only status 'open', public, not paused and not "coming soon";
 * then isTradeWork on the title, the summary and the department, with the template ("Notice to Contractors -
 * CUPCCAA", "Request for Bid (Goods/Services)") as the board's category.
 */
export function parseOpenGovProjects(json: OpenGovProjectsAnswer, gov: OpenGovGovernment): ParsedProjects {
  const out: ParsedProjects = { bids: [], open: 0, notTrade: 0, notBiddable: 0 };
  for (const r of json.rows) {
    const title = clean(r.title);
    if (typeof r.id !== 'number' || !title) continue;
    if ((r.status ?? 'open') !== 'open') continue;
    out.open++;
    if (r.isPrivate === true || r.isPaused === true || r.comingSoon === true) { out.notBiddable++; continue; }

    const summary = htmlToText(r.summary);
    const department = cleanOrNull(r.department?.name);
    const template = cleanOrNull(r.template?.title);
    const verdict = isTradeWork({ title, description: [department, summary].filter(Boolean).join('\n'), category: template });
    if (!verdict.keep) { out.notTrade++; continue; }

    // The row carries the government's organisation too; the list entry is the fallback.
    const org = r.government?.organization ?? null;
    const city = cleanOrNull(org?.city) ?? gov.city;
    const state = cleanOrNull(org?.state)?.toUpperCase() ?? gov.state;
    const agency = cleanOrNull(org?.name) ?? gov.name;
    const number = cleanOrNull(r.financialId);
    const head = [department, template].filter(Boolean).join(' · ');

    out.bids.push({
      source: 'opengov',
      // The project id stays the same through addenda (the row lists them under `addendums`).
      sourceId: `${gov.code}:${r.id}`,
      sourceName: 'OpenGov Procurement',
      title,
      agency,
      description: [head, truncate(summary, DESCRIPTION_MAX)].filter(Boolean).join('\n') || null,
      category: template,
      location: { city, state },
      postedAt: instant(r.releaseProjectDate),
      dueAt: instant(r.proposalDeadline),
      estValue: findEstimate(summary),
      naics: null,
      setAside: null,
      url: openGovProjectPage(gov.code, r.id),
      flags: detectFlags(summary),
      solNumber: number,
    });
  }
  return out;
}

// ---------------------------------------------------------------------- fetch --

/** A day number, to start each day's walk at a different government (a budget stop then never skips the same ones). */
const dayNumber = (d: Date): number => Math.floor(d.getTime() / 86_400_000);

async function readGovernment(
  ctx: SourceContext, gov: OpenGovGovernment,
): Promise<{ answer: OpenGovProjectsAnswer; pages: number }> {
  const rows: OpenGovProjectRow[] = [];
  const seen = new Set<number>();
  let count = 0;
  let pages = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1 && outOfTime(ctx)) break; // keep what this government gave; the outer loop says it stopped
    const json = await ctx.http.json<unknown>(openGovProjectsUrl(gov.code), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: openGovBody(page),
    });
    const answer = checkOpenGovAnswer(json);
    pages++;
    count = answer.count;
    const fresh = answer.rows.filter((r) => typeof r.id === 'number' && !seen.has(r.id));
    for (const r of fresh) seen.add(r.id as number);
    rows.push(...fresh);
    // Done: a short page, everything the count announced, or a page that repeats the last one.
    if (answer.rows.length < OPENGOV_PAGE_SIZE || rows.length >= count || fresh.length === 0) break;
    if (page === MAX_PAGES) ctx.log(`opengov ${gov.code}: ${count} open projects, read the first ${rows.length} (${MAX_PAGES} pages)`);
  }
  return { answer: { count, rows }, pages };
}

/** The source; `minGovernments` is lowered only by tests replaying the trimmed government list. */
export function createOpenGovSource(opts: { minGovernments?: number } = {}): Source {
  return {
    id: 'opengov',
    name: 'OpenGov Procurement',
    homepage: 'https://procurement.opengov.com/portal',
    states: 'US',
    // No Source.timeZone: the API writes instants with a zone, and each government has its own `timezone`.
    slices: [
      { group: 'opengov-1', states: ['CA'] },
      { group: 'opengov-2', states: ['FL', 'NJ'] },
      { group: 'opengov-3', states: ['AZ', 'TX', 'NM', 'OK', 'LA', 'AR'] },
      { group: 'opengov-4', states: ['SC', 'MD', 'VA', 'PA', 'CT', 'MA', 'GA', 'KY', 'NY', 'TN', 'NC', 'NH', 'AL', 'ME', 'RI', 'DC', 'WV', 'MS', 'DE', 'VT'] },
      { group: 'opengov-5', states: 'rest' },
    ],
    async fetch(ctx) {
      const list = parseOpenGovGovernments(await ctx.http.json<unknown>(OPENGOV_GOVERNMENTS_URL), ctx.slice, opts.minGovernments);
      const govs = list.governments;
      const where = ctx.slice ? `slice ${ctx.slice.name}` : 'all states';
      ctx.log(
        `opengov: ${govs.length} governments to read (${where}; of ${list.listed} listed: ${list.inactive} inactive/deleted, ` +
          `${list.internal} OpenGov internal, ${list.noState} with no state, ${list.otherSlices} in other slices)`,
      );
      if (govs.length === 0) return [];

      // Start at a different government each day (stable within a day), so a budget stop moves around.
      const start = dayNumber(ctx.now) % govs.length;
      const order = [...govs.slice(start), ...govs.slice(0, start)];

      const bids: BidDraft[] = [];
      let read = 0;
      let failed = 0;
      let inARow = 0;
      let open = 0;
      let notTrade = 0;
      let notBiddable = 0;
      let withOpen = 0;
      const failedCodes: string[] = [];
      let budgetStop: string | null = null;
      // One partial note for the report: the budget stop and the governments that failed, both kept.
      const tell = ctx.partial;
      const quiet = { ...ctx, partial: (why: string) => { budgetStop = why; } };
      for (const gov of order) {
        if (read + failed > 0 && outOfTime(ctx)) {
          stopAtBudget(quiet, 'opengov', read + failed, govs.length, 'governments');
          break;
        }
        try {
          const { answer } = await readGovernment(ctx, gov);
          const parsed = parseOpenGovProjects(answer, gov);
          read++;
          inARow = 0;
          open += parsed.open;
          notTrade += parsed.notTrade;
          notBiddable += parsed.notBiddable;
          if (parsed.open > 0) withOpen++;
          bids.push(...parsed.bids);
        } catch (err) {
          failed++;
          inARow++;
          failedCodes.push(gov.code);
          ctx.log(`opengov ${gov.code} (${gov.name}): skipped — ${(err as Error).message}`);
          if (inARow >= MAX_FAILURES_IN_A_ROW) {
            throw new Error(`opengov: ${inARow} governments in a row failed (last: ${gov.code}) — the API changed or refuses us`);
          }
        }
      }
      if (read === 0 && failed > 0) throw new Error(`opengov: every government failed (${failed})`);
      const failedNote = failed
        ? `opengov: ${failed} of ${read + failed} governments failed (${failedCodes.slice(0, 5).join(', ')}${failedCodes.length > 5 ? ', …' : ''})`
        : null;
      const note = [budgetStop, failedNote].filter(Boolean).join('; ');
      if (note) tell?.(note);
      ctx.log(
        `opengov: ${read} governments read${failed ? `, ${failed} failed` : ''}; ${open} open projects at ${withOpen} of them; ` +
          `${bids.length} kept, ${notTrade} left out as not trade work, ${notBiddable} private/paused/coming soon`,
      );
      return bids;
    },
  };
}

export const openGovSource: Source = createOpenGovSource();
