import * as cheerio from 'cheerio';
import type { BidDraft, Source } from '../types.js';
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
}

export const QUEST_BOARDS: QuestBoard[] = [
  {
    group: '1903611',
    provider: '1903611',
    label: 'NV Public Works (QuestCDN)',
    owner: 'Nevada State Public Works Division',
    // publicworks.nv.gov: bidders must be SPWD-qualified and NV-licensed before bid opening.
    flags: ['SPWD bidder qualification', 'Prevailing wage likely'],
  },
  // Add more boards here (Douglas County Public Works also posts bid documents on QuestCDN).
];

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
      postedAt: parseUsDateTime(r.render_post_date, { defaultTime: [8, 0] }),
      dueAt: parseUsDateTime(r.bid_date_str),
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

export const questcdnSource: Source = {
  id: 'questcdn',
  name: 'QuestCDN boards',
  homepage: questBoardUrl(QUEST_BOARDS[0]!),
  async fetch(ctx) {
    const out: BidDraft[] = [];
    for (const board of QUEST_BOARDS) {
      const json = await ctx.http.json<QuestResponse>(questApiUrl(board), {
        headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: questBoardUrl(board) },
      });
      if (json.result && json.result !== 'ok') throw new Error(`QuestCDN board ${board.group} answered result=${json.result}`);
      const bids = parseQuestJson(json, board);
      ctx.log(`questcdn ${board.label}: ${bids.length}/${json.recordsTotal ?? '?'}`);
      out.push(...bids);
    }
    return out;
  },
};
