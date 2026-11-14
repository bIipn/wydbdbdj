import * as cheerio from 'cheerio';
import type { BidDraft, Source, SourceContext } from '../types.js';
import { REQUIREMENT_FLAGS } from './flags.js';
import { keepTradeWork } from './relevance.js';
import { clean, cleanOrNull, untruncate } from '../util/text.js';
import { parseUsDateTime } from '../util/time.js';

/**
 * QuestCDN hosts bid boards for many agencies. Each board has a group/provider id.
 * The board page loads its rows from a JSON endpoint, which we call directly.
 */
export interface QuestBoard {
  group: string;
  provider: string;
  label: string; // badge on the card
  owner: string; // full owner name (the JSON truncates it)
  flags?: string[]; // requirements that apply to every project on this board
  /** The board's IANA zone, used when a bid time carries no zone of its own. Absent = Pacific. */
  timeZone?: string;
}

export const QUEST_BOARDS: QuestBoard[] = [
  {
    group: '1903611',
    provider: '1903611',
    label: 'NV Public Works (QuestCDN)',
    owner: 'Nevada State Public Works Division',
    // publicworks.nv.gov: bidders must be SPWD-qualified and NV-licensed before bid opening.
    flags: [REQUIREMENT_FLAGS.spwd, REQUIREMENT_FLAGS.prevailingLikely],
  },
];

/**
 * Why the boards below are not read. qcpi.questcdn.com/robots.txt answers 302 to www.questcdn.com/robots.txt/,
 * and that file (read 2026-11-14 with the scanner's own User-Agent) says, for every client:
 *
 *     User-agent: *
 *     Disallow: /quest/
 *     Disallow: /questcdn/
 *     Disallow: /
 *
 * (then Allow lines for /about, /solicitors, /bidders, /online-bidding and /news only). The host asks automated
 * clients to stay out, so no board is ADDED on it. The NV Public Works board above was already running for the
 * pilot before the file was read; whether it stays on is the owner's decision (docs/DATA-SOURCES.md §7).
 */
export const QUEST_OFF_REASON =
  "www.questcdn.com/robots.txt says Disallow: / for every client (read 2026-11-14): not read until the owner decides";

/**
 * Boards the parser reads (tests: test/fixtures/questcdn-*.json, one raw answer each from 2026-11-14 07:01 UTC,
 * before the robots file could be opened) but the scan never asks for. Moving one into QUEST_BOARDS turns it on:
 * the owner's call, never a workaround.
 */
export const QUEST_BOARDS_OFF: QuestBoard[] = [
  {
    group: '8011805',
    provider: '8011805',
    label: 'NV State Parks (QuestCDN)',
    owner: 'State of Nevada - Nevada Division of State Parks',
  },
  { group: '7484192', provider: '7484192', label: 'Lake County, CA (QuestCDN)', owner: 'Lake County, CA' },
  { group: '5618062', provider: '5618062', label: 'City of Campbell, CA (QuestCDN)', owner: 'City of Campbell' },
  { group: '5645931', provider: '5645931', label: 'City of Glendora, CA (QuestCDN)', owner: 'Glendora CA, City of' },
  // Checked 2026-11-14 and never listed (0 open projects that day): Roseville CA 7637, Dixon CA 7259977,
  // City of Orange CA 5653602, San Gabriel CA 6229169, Denver 842700, Boulder County 814582.
];

/**
 * QuestCDN prints the zone after a bid time ("11/17/2026 10:30 AM PST"). parseUsDateTime reads wall-clock
 * time in a named zone, so the abbreviation picks the zone; a time without one uses the board's zone.
 */
const ZONE_ABBR: Record<string, string> = {
  PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles', PT: 'America/Los_Angeles',
  MST: 'America/Denver', MDT: 'America/Denver', MT: 'America/Denver',
  CST: 'America/Chicago', CDT: 'America/Chicago', CT: 'America/Chicago',
  EST: 'America/New_York', EDT: 'America/New_York', ET: 'America/New_York',
};
export function questZone(text: string | null | undefined, board: QuestBoard): string {
  const abbr = /\b([PMCE][SD]?T)\b/.exec(text ?? '')?.[1];
  return (abbr && ZONE_ABBR[abbr]) || board.timeZone || 'America/Los_Angeles';
}

export const questBoardUrl = (b: QuestBoard) => `https://qcpi.questcdn.com/cdn/posting/?group=${b.group}&provider=${b.provider}`;

export function questApiUrl(b: QuestBoard, start = 0, length = 100): string {
  return (
    `https://qcpi.questcdn.com/cdn/browse_posting/?group=${b.group}&provider=${b.provider}` +
    `&search_id=&postings_since_last_login=&draw=1&start=${start}&length=${length}`
  );
}

interface QuestRow {
  project_id?: string;
  render_project_id?: string;
  render_post_date?: string;
  render_category_search_string?: string;
  render_name?: string;
  bid_date_str?: string;
  render_city?: string;
  render_county?: string;
  state_code?: string;
  render_owner?: string;
  render_solicitor?: string;
  posting_type?: string;
}
export interface QuestResponse {
  recordsTotal?: number;
  data?: QuestRow[];
  result?: string;
}

/** Fields may come back as plain text or as HTML with the full value in a title="" tooltip. */
function field(v: string | undefined): { text: string; truncated: boolean } {
  if (!v) return { text: '', truncated: false };
  if (v.includes('<')) {
    const $ = cheerio.load(`<div>${v}</div>`);
    const title = $('[title]').first().attr('title');
    if (title) return { text: clean(title), truncated: false };
    return untruncate($('div').first().text());
  }
  return untruncate(v);
}

export function parseQuestJson(json: QuestResponse, board: QuestBoard): BidDraft[] {
  const out: BidDraft[] = [];
  for (const r of json.data ?? []) {
    const id = clean(r.project_id ?? r.render_project_id);
    if (!id) continue;
    const name = field(r.render_name);
    const category = field(r.render_category_search_string);
    const city = field(r.render_city);
    const county = field(r.render_county);
    const solicitor = field(r.render_solicitor);
    const owner = field(r.render_owner);
    out.push({
      source: 'questcdn',
      sourceId: `${board.group}:${id}`,
      sourceName: board.label,
      title: name.truncated ? `${name.text}…` : name.text || `Quest project ${id}`,
      agency: owner.truncated && board.owner.toLowerCase().startsWith(owner.text.toLowerCase()) ? board.owner : owner.text || board.owner,
      description: [`Quest #${id}`, solicitor.text ? `Design: ${solicitor.text}${solicitor.truncated ? '…' : ''}` : null, r.posting_type]
        .filter(Boolean)
        .join(' · '),
      category: category.text ? `${category.text}${category.truncated ? '…' : ''}` : null,
      location: {
        city: city.text && city.text.toLowerCase() !== 'various' ? city.text : null,
        county: county.text && !/united states|various/i.test(county.text) ? county.text : null,
        state: cleanOrNull(r.state_code),
      },
      // The post date has no time: 8 AM in the board's zone (as before). The bid time names its zone.
      postedAt: parseUsDateTime(r.render_post_date, { defaultTime: [8, 0], timeZone: questZone(null, board) }),
      // a bid date with no time (never seen: every row has one) is the end of that day on the board's clock
      dueAt: parseUsDateTime(r.bid_date_str, { timeZone: questZone(r.bid_date_str, board), defaultTime: [23, 59] }),
      estValue: null,
      naics: null,
      setAside: null,
      // QuestCDN detail pages open via JavaScript, so we link the board; the card shows the Quest #.
      url: questBoardUrl(board),
      flags: [...(board.flags ?? [])],
    });
  }
  return out;
}

/**
 * One request per board. A board that fails is logged and reported (ctx.partial) while the others are kept;
 * only when EVERY board fails does it throw (so the report says FAILED, never a quiet 0).
 */
export async function fetchQuestBoards(ctx: SourceContext, boards: QuestBoard[]): Promise<BidDraft[]> {
  const out: BidDraft[] = [];
  const failed: string[] = [];
  let left = 0;
  for (const board of boards) {
    try {
      const json = await ctx.http.json<QuestResponse>(questApiUrl(board), {
        headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: questBoardUrl(board) },
      });
      checkQuestJson(json, board);
      const all = parseQuestJson(json, board);
      // posting_type ("Construction Project") is the board's own category; the parser keeps it in description.
      const rows = json.data ?? [];
      const typeOf = new Map(rows.map((r) => [`${board.group}:${clean(r.project_id ?? r.render_project_id)}`, r.posting_type ?? null]));
      const { kept, left: out1 } = keepTradeWork(all, (b) => ({ title: b.title, category: typeOf.get(b.sourceId) ?? b.category, board: 'questcdn' }));
      left += out1;
      ctx.log(`questcdn ${board.label}: ${kept.length}/${json.recordsTotal ?? '?'}${out1 ? `, ${out1} left out as not trade work` : ''}`);
      out.push(...kept);
    } catch (err) {
      const msg = `${board.label} (group ${board.group}): ${(err as Error).message}`;
      ctx.log(`questcdn ${msg}`);
      failed.push(msg);
    }
  }
  if (failed.length === boards.length) throw new Error(`every QuestCDN board failed: ${failed.join('; ')}`);
  if (failed.length) ctx.partial?.(`questcdn: ${failed.length} of ${boards.length} boards failed: ${failed.join('; ')}`);
  if (left) ctx.log(`questcdn: ${left} left out as not trade work`);
  return out;
}

export const questcdnSource: Source = {
  id: 'questcdn',
  name: 'QuestCDN boards',
  homepage: questBoardUrl(QUEST_BOARDS[0]!),
  // The states of the boards in QUEST_BOARDS (add a state here with a board there). Times: Pacific unless a
  // bid time names another zone (questZone).
  states: ['NV'],
  timeZone: 'America/Los_Angeles',
  fetch: (ctx) => fetchQuestBoards(ctx, QUEST_BOARDS),
};

/** The answer must be QuestCDN's browse_posting JSON: result "ok" and a data array (an HTML page is not). */
export function checkQuestJson(json: unknown, board: QuestBoard): asserts json is QuestResponse {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`QuestCDN board ${board.group} did not answer JSON`);
  const j = json as QuestResponse;
  if (j.result && j.result !== 'ok') throw new Error(`QuestCDN board ${board.group} answered result=${j.result}`);
  if (!Array.isArray(j.data)) throw new Error(`QuestCDN board ${board.group}: no data array in the answer`);
  if ((j.recordsTotal ?? 0) > 0 && j.data.length === 0) throw new Error(`QuestCDN board ${board.group} announces ${j.recordsTotal} but sent no rows`);
}
