import { describe, expect, it } from 'vitest';
import { finalizeBid } from '../src/scan.js';
import {
  CIVICPLUS_CRAWL_DELAY_MS, CIVICPLUS_SITES, civicPlusDraft, civicPlusListUrl, civicPlusSource, fetchCivicPlusSites, parseCivicPlusBids, type CivicPlusSite,
} from '../src/sources/civicplus.js';
import { isTradeWork } from '../src/sources/relevance.js';
import type { RequestOptions, SourceContext } from '../src/types.js';
import { fx } from './helpers.js';

// Real answers of 2026-11-14 18:06 UTC (test/fixtures/civicplus.md): the Bid Postings module, whole rows dropped only.
const OPEN = fx('civicplus-citrusheights-open.html');
const EMPTY = fx('civicplus-auburn-empty.html');
const ALL = fx('civicplus-citrusheights-all.html');
const NOW = new Date('2026-11-14T18:06:26Z');
const CH = CIVICPLUS_SITES.find((s) => s.host === 'www.citrusheights.net')!;
const AUBURN = CIVICPLUS_SITES.find((s) => s.host === 'www.auburn.ca.gov')!;

// The body www.cityofwoodland.gov answered for /Bids.aspx (a 301), verbatim; and the shape of a Cloudflare challenge
// (www.tuolumnecounty.ca.gov answered one: title and noscript line as received, the script and its tokens left out).
const REDIRECT_BODY = '<html><head><title>Object moved</title></head><body>\r\n<h2>Object moved to <a href="/1710/Bid-Opportunities">here</a>.</h2>\r\n</body></html>\r\n';
const CHALLENGE = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><div class="main-wrapper" role="main"><div class="main-content"><noscript><div class="h2"><span id="challenge-error-text">Enable JavaScript and cookies to continue</span></div></noscript></div></div></body></html>';

describe('the site list', () => {
  it('holds exactly Citrus Heights and Auburn, each in Pacific time, and adds to the west group', () => {
    expect(CIVICPLUS_SITES.map((s) => s.host)).toEqual(['www.citrusheights.net', 'www.auburn.ca.gov']);
    for (const s of CIVICPLUS_SITES) expect(s).toMatchObject({ state: 'CA', timeZone: 'America/Los_Angeles' });
    expect(civicPlusSource).toMatchObject({ id: 'civicplus', group: 'west', states: ['CA'] });
    expect(civicPlusListUrl(CH)).toBe('https://www.citrusheights.net/Bids.aspx');
  });
});

describe('parseCivicPlusBids (real pages)', () => {
  it('the open list: 2 rows, Open, "Upon Contract" = no due date, the snippet without its [Read on] tail', () => {
    const { rows, unreadable } = parseCivicPlusBids(OPEN, CH);
    expect(unreadable).toBe(0);
    expect(rows).toEqual([
      {
        bidId: '234', title: '2026/2027 Pavement Management System RFP', status: 'Open',
        category: 'Public Works Projects (Maintenance & Professional Services)',
        snippet: 'The City of Citrus Heights (City) is soliciting proposals from qualified firms to provide professional services for the 2026/2027 Pavement Management System Update. The scope...',
        bidNumber: null, closes: 'Upon Contract', dueAt: null,
      },
      expect.objectContaining({ bidId: '235', title: 'San Juan Avenue Complete Streets - Phase 1B - RFP for CM Services', status: 'Open', dueAt: null }),
    ]);
    expect(rows[1]!.snippet).toBe('The City of Citrus Heights is soliciting proposals from qualified firms to provide professional services for the San Juan Avenue Complete Streets Project – Phase 1B...');
    for (const r of rows) expect(r.snippet).not.toMatch(/read on|\[|\]/i);
  });

  it('the empty state is zero rows, not a failure', () => {
    expect(parseCivicPlusBids(EMPTY, AUBURN)).toEqual({ rows: [], unreadable: 0 });
  });

  it('every status and date shape of the all-statuses page, read in Pacific time', () => {
    const { rows, unreadable } = parseCivicPlusBids(ALL, CH);
    expect(unreadable).toBe(0);
    const by = (id: string) => rows.find((r) => r.bidId === id)!;
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['Open', 'Closed', 'Awarded']));
    expect(new Set(rows.map((r) => r.category))).toEqual(new Set([
      'Professional Services', 'Public Works Projects (Construction)', 'Public Works Projects (Maintenance & Professional Services)',
    ]));
    expect(by('172')).toMatchObject({ status: 'Closed', closes: '8/17/2023 4:00 PM', dueAt: '2023-08-17T23:00:00.000Z', bidNumber: '2023-07' }); // PDT
    expect(by('157')).toMatchObject({ closes: '8/23/2022 11:59 PM', dueAt: '2022-08-24T06:59:00.000Z' });
    expect(by('175')).toMatchObject({ closes: '11/8/2023 4:00 AM', dueAt: '2023-11-08T12:00:00.000Z' }); // PST, as written (AM)
    expect(by('142')).toMatchObject({ closes: '12/15/2021 2:00 PM', dueAt: '2021-12-15T22:00:00.000Z' });
    expect(by('236')).toMatchObject({ status: 'Closed', dueAt: '2026-11-07T01:00:00.000Z' });
    expect(by('149')).toMatchObject({ status: 'Closed', closes: 'Upon Contract', dueAt: null });
    expect(by('184')).toMatchObject({ status: 'Awarded', closes: 'Upon Contract', dueAt: null, category: 'Public Works Projects (Construction)' });
    expect(by('122')!.bidNumber).toBe('28-20-001 (see addenda 1)');
  });

  it('a posting listed under two categories is read once (the first); no snippet and no [Read on] are fine', () => {
    const { rows } = parseCivicPlusBids(ALL, CH);
    expect(rows.filter((r) => r.bidId === '172')).toHaveLength(1);
    expect(rows.find((r) => r.bidId === '172')!.category).toBe('Professional Services');
    expect(rows).toHaveLength(14); // 15 row elements kept in the fixture, one of them the repeat
    expect(rows.find((r) => r.bidId === '152')!.snippet).toBeNull(); // <span></span>
    expect(rows.find((r) => r.bidId === '173')!.snippet).toBe(
      'The City of Citrus Heights offers limited one-time funding for non-profit organizations that provide services to residents of the Citrus Heights community.',
    );
  });

  it('a challenge page, a redirect body or a changed layout throws (FAILED, never a quiet 0)', () => {
    expect(() => parseCivicPlusBids(CHALLENGE, CH)).toThrow(/no Bid Postings list.*"Just a moment\.\.\."/);
    expect(() => parseCivicPlusBids(REDIRECT_BODY, CH)).toThrow(/no Bid Postings list.*"Object moved"/);
    // The list is there but the empty sentence is gone and no row is a listItemsRow (renamed classes).
    expect(() => parseCivicPlusBids(EMPTY.replace('There are no open bid postings at this time.', ''), AUBURN)).toThrow(/no rows and not/);
    expect(() => parseCivicPlusBids(OPEN.replaceAll('listItemsRow bid', 'bidRow'), CH)).toThrow(/no rows and not/);
    // Rows still there, but the title link is gone: rows nobody can read.
    expect(() => parseCivicPlusBids(OPEN.replaceAll('bids.aspx?bidID=', 'bids.aspx?id='), CH)).toThrow(/2 rows .* none readable/);
  });
});

describe('the card', () => {
  it('a posting as a card: stable id per host and bidID, the bid page link, the city placed by the geo code', () => {
    const row = parseCivicPlusBids(ALL, CH).rows.find((r) => r.bidId === '184')!;
    const d = civicPlusDraft(row, CH);
    expect(d).toMatchObject({
      source: 'civicplus', sourceId: 'www.citrusheights.net:184', sourceName: 'City of Citrus Heights (CivicPlus)', agency: 'City of Citrus Heights',
      title: '2024 Madison Avenue Retaining Wall Repair', url: 'https://www.citrusheights.net/bids.aspx?bidID=184', dueAt: null,
      category: 'Public Works Projects (Construction)', location: { city: 'Citrus Heights', state: 'CA' },
    });
    expect(d.description).toMatch(/Closes: upon contract \(no closing date set\)$/);
    expect(d.description).not.toMatch(/read on/i);
    const placed = finalizeBid(d).location;
    expect(placed).toMatchObject({ city: 'Citrus Heights', state: 'CA', precision: 'city', label: 'Citrus Heights, CA' });
    expect(placed.lat).not.toBeNull();
    expect(finalizeBid(civicPlusDraft(parseCivicPlusBids(OPEN, CH).rows[0]!, AUBURN)).location).toMatchObject({ city: 'Auburn', precision: 'city' });
  });

  it("today's two open rows are consulting RFPs: the trade-work rule leaves them out", () => {
    for (const r of parseCivicPlusBids(OPEN, CH).rows) {
      expect(isTradeWork({ title: r.title, description: r.snippet, board: 'civicplus' }).keep, r.title).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- fetch --

function ctxFor(pages: Record<string, string | Error>, deadline?: Date) {
  const asked: string[] = [];
  const options: (RequestOptions | undefined)[] = [];
  const logs: string[] = [];
  const partial: string[] = [];
  const answer = async (url: string, init?: RequestOptions): Promise<string> => {
    asked.push(url);
    options.push(init);
    const p = pages[url];
    if (p === undefined) throw new Error(`TEST: no page for ${url}`);
    if (p instanceof Error) throw p;
    return p;
  };
  const ctx: SourceContext = {
    http: { text: answer, json: async (url: string) => { asked.push(url); throw new Error('TEST: json not expected'); } },
    now: NOW, env: () => undefined, log: (m) => logs.push(m), partial: (m) => partial.push(m), deadline,
  };
  return { ctx, asked, options, logs, partial };
}

describe('fetch', () => {
  it('one GET of /Bids.aspx per site, nothing else (never /RSS.aspx), and one log line per site', async () => {
    const f = ctxFor({ 'https://www.citrusheights.net/Bids.aspx': OPEN, 'https://www.auburn.ca.gov/Bids.aspx': EMPTY });
    const bids = await civicPlusSource.fetch(f.ctx);
    expect(f.asked).toEqual(['https://www.citrusheights.net/Bids.aspx', 'https://www.auburn.ca.gov/Bids.aspx']);
    expect(f.asked.some((u) => /rss/i.test(u))).toBe(false);
    // robots.txt Crawl-delay: 10 on both: each GET carries it, so util/http.ts never retries it or follows a redirect
    expect(f.options).toEqual([{ crawlDelayMs: 10_000 }, { crawlDelayMs: 10_000 }]);
    expect(CIVICPLUS_CRAWL_DELAY_MS).toBe(10_000);
    expect(bids).toEqual([]);
    expect(f.logs).toEqual([
      'civicplus Citrus Heights: 2 listed, 0 kept, 2 left out as not trade work',
      'civicplus Auburn: 0 listed (no open bid postings)',
    ]);
    expect(f.partial).toEqual([]);
  });

  it('keeps only status Open: the all-statuses page gives its two open rows and nothing closed or awarded', async () => {
    const f = ctxFor({ 'https://www.citrusheights.net/Bids.aspx': ALL });
    const bids = await fetchCivicPlusSites(f.ctx, [CH]);
    expect(bids).toEqual([]);
    expect(f.logs).toEqual(['civicplus Citrus Heights: 14 listed, 0 kept, 12 not open, 2 left out as not trade work']);
    // Kept when the work is trade work: the same open row with a construction title (TEST edit of the real page).
    const edited = ALL.replace('>San Juan Avenue Complete Streets - Phase 1B - RFP for CM Services<', '>TEST Retaining Wall Repair<');
    const g = ctxFor({ 'https://www.citrusheights.net/Bids.aspx': edited });
    const kept = await fetchCivicPlusSites(g.ctx, [CH]);
    expect(kept.map((b) => b.sourceId)).toEqual(['www.citrusheights.net:235']);
    expect(g.logs).toEqual(['civicplus Citrus Heights: 14 listed, 1 kept, 12 not open, 1 left out as not trade work']);
  });

  it('the plain "Professional Services" group is passed to isTradeWork: banking or planning RFPs stay out when open', async () => {
    // TEST edit of the real page: rows 152 (Investment Management Services) and 157 (Professional Services group) Open
    const { rows } = parseCivicPlusBids(ALL, CH);
    const targets = rows.filter((r) => r.category === 'Professional Services' && r.status !== 'Open');
    expect(targets.length).toBeGreaterThanOrEqual(2);
    let page = ALL;
    for (const t of targets) {
      const at = page.indexOf(`bids.aspx?bidID=${t.bidId}"`);
      const statusAt = page.indexOf(`>${t.status}<`, at);
      page = `${page.slice(0, statusAt)}>Open<${page.slice(statusAt + t.status.length + 2)}`;
    }
    const f = ctxFor({ 'https://www.citrusheights.net/Bids.aspx': page });
    const kept = await fetchCivicPlusSites(f.ctx, [CH]);
    const opened = parseCivicPlusBids(page, CH).rows.filter((r) => r.status === 'Open').map((r) => r.bidId);
    for (const t of targets) expect(opened).toContain(t.bidId);
    expect(kept).toEqual([]);
    // the mixed group still says nothing either way: a construction title under it is kept (the test above)
  });

  it('one site failing is reported through ctx.partial while the other is kept', async () => {
    const f = ctxFor({ 'https://www.citrusheights.net/Bids.aspx': CHALLENGE, 'https://www.auburn.ca.gov/Bids.aspx': EMPTY });
    await expect(civicPlusSource.fetch(f.ctx)).resolves.toEqual([]);
    expect(f.partial).toHaveLength(1);
    expect(f.partial[0]).toMatch(/^civicplus Citrus Heights: failed: civicplus www\.citrusheights\.net: no Bid Postings list/);
    expect(f.logs[0]).toMatch(/^civicplus Citrus Heights: FAILED: /);
    expect(f.logs[1]).toBe('civicplus Auburn: 0 listed (no open bid postings)');
  });

  it('every site failing throws, so the scan report says FAILED', async () => {
    const f = ctxFor({ 'https://www.citrusheights.net/Bids.aspx': new Error('HTTP 403 for https://www.citrusheights.net/Bids.aspx'), 'https://www.auburn.ca.gov/Bids.aspx': REDIRECT_BODY });
    await expect(civicPlusSource.fetch(f.ctx)).rejects.toThrow(/^civicplus: every site failed \(Citrus Heights: .*HTTP 403.*; Auburn: .*Object moved/);
    expect(f.asked).toHaveLength(2); // no retry, no other page
  });

  it('honours ctx.deadline between sites: the first site is read, the rest stop loudly', async () => {
    const f = ctxFor({ 'https://www.citrusheights.net/Bids.aspx': OPEN, 'https://www.auburn.ca.gov/Bids.aspx': EMPTY }, new Date(Date.now() - 1));
    await civicPlusSource.fetch(f.ctx);
    expect(f.asked).toEqual(['https://www.citrusheights.net/Bids.aspx']);
    expect(f.partial).toEqual(['civicplus: stopped at the time budget, 1 of 2 sites read']);
  });

  it('a site added later is one line: the same reader, its own host and city', async () => {
    const extra: CivicPlusSite = { host: 'test.example.com', label: 'TEST City', agency: 'TEST City (simulated)', city: 'Auburn', state: 'CA', timeZone: 'America/Los_Angeles' };
    const f = ctxFor({ 'https://test.example.com/Bids.aspx': EMPTY });
    await fetchCivicPlusSites(f.ctx, [extra]);
    expect(f.asked).toEqual(['https://test.example.com/Bids.aspx']);
    expect(f.logs).toEqual(['civicplus TEST City: 0 listed (no open bid postings)']);
  });
});
