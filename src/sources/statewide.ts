import type { SourceId } from '../types.js';

/**
 * Boards that list a whole state's (or a big city's) purchases with no site on the list itself. A card from one of
 * them that could not be placed is not "near you, location not listed" (what an unplaced Nevada board card means
 * for a Nevada company: those boards are small and local): it could be anywhere in the state. So score.ts
 * (the distance section) makes it a capped "maybe" for a company based in that state, with STATEWIDE_SITE_REASON,
 * and holds it under the deck line (Browse only) for a company based elsewhere.
 *
 * ONE table. The Nevada boards (nevadaepro, ngem, questcdn, douglascounty) are never in it: their rules stay as
 * they are (test/score-audit.test.ts). Cities' boards (laramp, sfbids, nycrecord) are here too: an LA RAMP or SF
 * listing with no site may be a department's work anywhere in the state (SFPUC runs Hetch Hetchy in Tuolumne).
 */
export const STATEWIDE_BOARDS: Readonly<Partial<Record<SourceId, { state: string; name: string }>>> = {
  caleprocure: { state: 'CA', name: 'California' },
  oregonbuys: { state: 'OR', name: 'Oregon' },
  commbuys: { state: 'MA', name: 'Massachusetts' },
  bidbuy: { state: 'IL', name: 'Illinois' },
  njstart: { state: 'NJ', name: 'New Jersey' },
  flmfmp: { state: 'FL', name: 'Florida' },
  txesbd: { state: 'TX', name: 'Texas' },
  laramp: { state: 'CA', name: 'California' },
  sfbids: { state: 'CA', name: 'California' },
  nycrecord: { state: 'NY', name: 'New York' },
};

/** The board's table row, or null for every other source (the Nevada boards, SAM.gov, OpenGov, E-Rate …). */
export function statewideBoard(source: string): { state: string; name: string } | null {
  return (STATEWIDE_BOARDS as Record<string, { state: string; name: string } | undefined>)[source] ?? null;
}

/** The reason on such a card for a company based in that state. */
export const statewideSiteReason = (stateName: string): string =>
  `Site not named on the board's list — could be anywhere in ${stateName}; open the listing to see where`;

/** …and for a company based in another state (the card is held at 34, Browse only). */
export const statewideElsewhereReason = (stateName: string): string =>
  `Site not named on the board's list — could be anywhere in ${stateName}`;
