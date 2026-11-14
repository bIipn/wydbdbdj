import type { BidDraft, Source } from '../types.js';
import {
  buySpeedBoard, buySpeedSource, openBidsUrl, parseBuySpeedPage, parseBuySpeedTotal, type BuySpeedPage,
} from './buyspeed.js';
import { DEFAULT_GROUP } from './scan-groups.js';

/**
 * State Purchasing (Periscope BSO). Public, no login needed for the open-bids list. The parser is the shared
 * BuySpeed one (src/sources/buyspeed.ts, board 'nevadaepro'); these names stay for the tests, the fixtures
 * and the demo snapshot.
 */
const BOARD = buySpeedBoard('nevadaepro');

export const NEVADAEPRO_OPEN_BIDS = openBidsUrl(BOARD);

/** One results page, plus what fetch() needs to tell "no open bids" from "the page changed". */
export type NevadaEproPage = BuySpeedPage;

/** How many open bids the board announces across all pages. */
export function parseNevadaEproTotal(html: string): number | null {
  return parseBuySpeedTotal(html);
}

/** See parseBuySpeedPage: cells mapped by their header label, never by position. */
export function parseNevadaEproPage(html: string, pageUrl = NEVADAEPRO_OPEN_BIDS): NevadaEproPage {
  return parseBuySpeedPage(html, BOARD, pageUrl);
}

/** Just the bids of one page — what the offline fixtures and the demo snapshot use. */
export function parseNevadaEproOpenBids(html: string, pageUrl = NEVADAEPRO_OPEN_BIDS): BidDraft[] {
  return parseNevadaEproPage(html, pageUrl).bids;
}

// Every page, through one cookie session (the shared BuySpeed paging); every row kept, as before (the board's
// tradeOnly is false). Logs e.g. "nevadaepro: 29 of 29 listed (pages 2/2)"; without a session (a test fake)
// the first page only, "nevadaepro: 25 of 29 listed (first page only)".
export const nevadaEproSource: Source = buySpeedSource(BOARD, DEFAULT_GROUP);
