import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as cheerio from 'cheerio';
import { FIXTURES_CAPTURED_AT } from '../src/sources/fixtures.js';
import type { SourceContext } from '../src/types.js';

export const FIXTURE_DIR = resolve(__dirname, 'fixtures');

/** A captured response: the RAW server HTML/JSON the scanner receives, never a browser "save as". */
export const fx = (f: string) => readFileSync(resolve(FIXTURE_DIR, f), 'utf8');

/** The day the HTML fixtures were fetched (2026-11-13, noon Pacific). */
export const CAPTURED = FIXTURES_CAPTURED_AT;

/** Change a fixture in memory with cheerio and hand back the HTML. */
export function edit(html: string, change: ($: cheerio.CheerioAPI) => void): string {
  const $ = cheerio.load(html);
  change($);
  return $.html();
}

/** A scan context whose "network" answers every request with `html`; collects the log lines. */
export function fakeCtx(html: string, now = CAPTURED): { ctx: SourceContext; logs: string[] } {
  const logs: string[] = [];
  const ctx: SourceContext = {
    http: { text: async () => html, json: async () => ({}) as never },
    now,
    env: () => undefined,
    log: (msg) => logs.push(msg),
  };
  return { ctx, logs };
}

// ------------------------------------------------------------------- NGEM --

export const NGEM_GRID = 'table.rgMasterTable';

/** __doPostBack target of the pager's "Go to Page n" link (pages 1–3 are ctl05–ctl07 on the live board). */
export const ngemTarget = (n: number) => `ctl00$mainContent$rgBidList$ctl00$ctl03$ctl01$ctl0${4 + n}`;

const NGEM_COLUMNS = ['', 'colBidNumber', 'colTitle', 'colTypeTitle', 'colWorkGroupName', 'colOpenDate', 'colCloseDate'];

/**
 * An NGEM page the way a browser's "save as" leaves it (the shape of the retired 2026-11-11 fixture):
 * page JavaScript has named the header cells with aria-label, dropped the sort handlers, and turned
 * the postback pager into plain "…ChangePage=2_20" links. The rows are untouched.
 */
export function browserSavedNgem(html: string): string {
  return edit(html, ($) => {
    $(`${NGEM_GRID} thead tr`).first().children('th').each((i, th) => {
      if (NGEM_COLUMNS[i]) $(th).attr('aria-label', NGEM_COLUMNS[i]);
      $(th).find('a').removeAttr('onclick').removeAttr('href');
    });
    $(`${NGEM_GRID} .rgNumPart a`).each((_, a) => {
      const link = $(a).removeAttr('onclick');
      if (link.hasClass('rgCurrentPage')) link.removeAttr('href');
      else link.attr('href', `https://nevada.ionwave.net/SourcingEvents.aspx?SourceType=1&ctl00_mainContent_rgBidListChangePage=${link.text()}_20`);
    });
  });
}
