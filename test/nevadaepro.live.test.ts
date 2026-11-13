import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { nevadaEproSource, parseNevadaEproOpenBids, parseNevadaEproPage, parseNevadaEproTotal } from '../src/sources/nevadaepro.js';
import type { SourceContext } from '../src/types.js';

/** RAW server HTML (what the scanner really gets), captured 2026-11-13 — not a browser-saved page. */
const raw = readFileSync(resolve(__dirname, 'fixtures', 'nevadaepro-open-bids.raw.html'), 'utf8');

/** A scan context whose "network" returns `html`; collects the log lines. */
function fakeCtx(html: string): { ctx: SourceContext; logs: string[] } {
  const logs: string[] = [];
  const ctx: SourceContext = {
    http: { text: async () => html, json: async () => ({}) as never },
    now: new Date('2026-11-13T20:00:00Z'),
    env: () => undefined,
    log: (msg) => logs.push(msg),
  };
  return { ctx, logs };
}

describe('NevadaEPro (raw server HTML)', () => {
  const page = parseNevadaEproPage(raw);
  const bids = page.bids;
  const byId = (id: string) => bids.find((b) => b.sourceId === id)!;

  it('parses every row of the first page', () => {
    expect(page).toMatchObject({ tableFound: true, rows: 25, total: 29 });
    expect(bids).toHaveLength(25);
    expect(new Set(bids.map((b) => b.sourceId)).size).toBe(25);
    expect(bids[0]!.sourceId).toBe('72DOW-S4085'); // newest first
    expect(bids[24]!.sourceId).toBe('41NHA-S4031');
    expect(bids.every((b) => b.title && b.agency && b.dueAt)).toBe(true);
    expect(parseNevadaEproOpenBids(raw)).toEqual(bids);
  });

  it('names bare cells by the header at the same position', () => {
    expect(byId('55AGR-S4066')).toMatchObject({
      source: 'nevadaepro',
      title: 'Generator',
      agency: 'Department of Agriculture',
      description: 'Buyer: Christian Armas · Bid 55AGR-S4066',
      dueAt: '2026-11-25T01:00:00.000Z', // 11/24/2026 5:00 PM PST
      location: { state: 'NV' },
      flags: ['May be supply-only'],
    });
    // "Alternate Id" is the last column; most rows leave it empty.
    expect(byId('80DOT-S4076')).toMatchObject({
      title: '35 TON DETACHABLE GOOSENECK TRAILER',
      agency: 'Department of Transportation',
      description: 'Buyer: Heather Moon · Alt ID NDEQ027423 · Bid 80DOT-S4076',
    });
    expect(bids[0]!.title).toBe('Roof Decking for Habitat Structures'); // double space on the board
  });

  it('converts Pacific wall-clock due times to UTC', () => {
    expect(byId('80DOT-S4076').dueAt).toBe('2026-12-02T20:00:00.000Z'); // 12/02/2026 12:00 PM PST
    expect(byId('43ADG-S4069').dueAt).toBe('2026-12-05T00:59:00.000Z'); // 12/04/2026 4:59 PM PST → next day in UTC
    expect(byId('65DPS-S4063').dueAt).toBe('2026-12-02T17:00:00.000Z'); // 12/02/2026 9:00 AM PST
  });

  it('makes the relative detail link absolute', () => {
    expect(byId('55AGR-S4066').url).toBe('https://nevadaepro.com/bso/external/bidDetail.sda?docId=55AGR-S4066&external=true&parentUrl=close');
    expect(bids.every((b) => b.url === `https://nevadaepro.com/bso/external/bidDetail.sda?docId=${b.sourceId}&external=true&parentUrl=close`)).toBe(true);
  });

  it('ignores the hidden duplicate columns', () => {
    // Scramble only the hidden cells (in memory): nothing may change.
    const scrambled = raw.replace(/(<td role="gridcell" style="display:none">)[^<]*/g, '$1HIDDEN');
    expect(scrambled).not.toBe(raw);
    expect(parseNevadaEproOpenBids(scrambled)).toEqual(bids);
  });

  it('survives reordered columns', () => {
    // Move the last column (Alternate Id) to the front, in the header and in every row.
    const $ = cheerio.load(raw);
    $('thead tr, tbody tr').each((_, tr) => {
      $(tr).prepend($(tr).children().last());
    });
    expect($('thead th').first().text()).toBe('Alternate Id');
    expect(parseNevadaEproOpenBids($.html())).toEqual(bids);
  });

  it('takes header labels from aria-label when the title span is missing', () => {
    const $ = cheerio.load(raw);
    $('thead span.ui-column-title').remove();
    expect(parseNevadaEproOpenBids($.html())).toEqual(bids);
  });

  it('still reads the browser-saved shape: label inside each cell, no header needed', () => {
    const $ = cheerio.load(raw);
    const labels = $('thead th').toArray().map((th) => $(th).find('span.ui-column-title').text());
    $('tbody tr').each((_, tr) => {
      $(tr).children('td').each((i, td) => {
        $(td).prepend($('<span class="ui-column-title"></span>').text(labels[i]!));
      });
    });
    $('thead').remove();
    expect(parseNevadaEproOpenBids($.html())).toEqual(bids);
  });
});

describe('NevadaEPro announced total', () => {
  it('reads the paginator text ("1-25 of 29")', () => {
    expect(parseNevadaEproTotal(raw)).toBe(29);
  });

  it('falls back to the widget config (rowCount:29)', () => {
    const $ = cheerio.load(raw);
    $('.ui-paginator-current').remove();
    expect(parseNevadaEproTotal($.html())).toBe(29);
  });

  it('is null when the page does not say', () => {
    const $ = cheerio.load(raw);
    $('.ui-paginator-current, script').remove();
    expect(parseNevadaEproTotal($.html())).toBeNull();
    expect(parseNevadaEproOpenBids($.html())).toHaveLength(25); // the rows are still read
  });
});

describe('NevadaEPro fetch() is loud', () => {
  it('logs how many of the announced bids were listed', async () => {
    const { ctx, logs } = fakeCtx(raw);
    expect(await nevadaEproSource.fetch(ctx)).toHaveLength(25);
    expect(logs).toEqual(['nevadaepro: 25 of 29 listed (first page only)']);
  });

  it('throws when the results table is missing', async () => {
    const { ctx } = fakeCtx('<html><body><h1>An error has occurred</h1></body></html>');
    await expect(nevadaEproSource.fetch(ctx)).rejects.toThrow('results table not found');
  });

  it('throws when there are rows but none can be parsed', async () => {
    // Same real rows, but the header (the only place the raw HTML names its columns) is gone.
    const $ = cheerio.load(raw);
    $('thead').remove();
    const { ctx } = fakeCtx($.html());
    await expect(nevadaEproSource.fetch(ctx)).rejects.toThrow('25 rows listed but none could be parsed');
  });

  it('throws when the board announces bids but the table is empty', async () => {
    const $ = cheerio.load(raw);
    $('tbody tr').remove();
    const { ctx } = fakeCtx($.html());
    await expect(nevadaEproSource.fetch(ctx)).rejects.toThrow('board announces 29 open bids but the table has no rows');
  });

  it('accepts an empty board', async () => {
    // PrimeFaces' stock "no rows" markup — not captured from the board (it has never been empty).
    const $ = cheerio.load(raw);
    $('tbody').html('<tr class="ui-widget-content ui-datatable-empty-message"><td colspan="11">No records found.</td></tr>');
    $('.ui-paginator-current, script').remove();
    const { ctx, logs } = fakeCtx($.html());
    expect(await nevadaEproSource.fetch(ctx)).toEqual([]);
    expect(logs).toEqual(['nevadaepro: 0 listed (total not announced)']);
  });
});
