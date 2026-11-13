/**
 * The words the parsers write and the scorer reads. One copy, so a parser and score.ts can never drift apart:
 * the flag strings, the program-contract terms and the SAM.gov set-aside codes all live here.
 * (test/federal-chain.test.ts runs real SAM notices through parser → locate → scoreBid against this table.)
 */

/** Flag strings on `Bid.flags` that change the score. */
export const FLAGS = {
  /** SAM.gov advance notice: the bid package is not out yet. Never biddable, never alerts. */
  presolicitation: 'Presolicitation',
  /** A multi-year vehicle (IDIQ, JOC, MATOC, BPA, OTA…) that hands out task orders, not one job. A hard no. */
  programContract: 'Program contract',
  /** NGEM request for information: no bid is taken. Never alerts. */
  rfi: 'RFI — info only, not a bid',
  /**
   * SAM.gov bulk file: a deadline written without a time zone, and no other notice of the same solicitation
   * gave one. It is read as Pacific like every board, but the office may be on the East Coast (3 hours
   * earlier), so the card says to check. Shown as a plain info line; no points change.
   */
  deadlineZoneUnstated: 'Deadline time zone not stated — check the notice',
} as const;

/**
 * Requirement flags: what the notice (or the whole board) asks of a bidder. Written by src/util/flags.ts
 * (detectFlags, from notice text) and src/sources/questcdn.ts (the SPWD board); read by score.ts (the
 * paperwork answers) and src/market/prevailing.ts. One copy, so a reader never matches by a loose pattern.
 */
export const REQUIREMENT_FLAGS = {
  /** NV State Public Works Division board: bidders must be SPWD-qualified (NRS 338.1375/338.1379). */
  spwd: 'SPWD bidder qualification',
  /** The same board: state public works pay prevailing wage, though the notice may not say it. */
  prevailingLikely: 'Prevailing wage likely',
  bidBond: 'Bid bond',
  perfBond: 'Performance/payment bond',
  prevailing: 'Prevailing wage',
  certifiedPayroll: 'Certified payroll',
} as const;

/** Flags that mean "not open for bids yet", with the line the card shows. */
export const NOT_OPEN_FLAGS: ReadonlyArray<{ flag: string; text: string }> = [
  { flag: FLAGS.presolicitation, text: 'Presolicitation — not open for bids yet' },
  { flag: FLAGS.rfi, text: FLAGS.rfi },
];

/**
 * Contract-vehicle terms, whole words, any case. Group 1 is the term as written ("IDIQ", "job order contract").
 * Used on SAM titles and descriptions by the parser and on every board's title by the scorer.
 */
export const PROGRAM_CONTRACT_TERMS =
  /(?<![a-z0-9])(IDIQ|ID\/IQ|JOC|MATOC|SATOC|MACC|BPA|OTA|indefinite[- ]delivery|indefinite[- ]quantity|job order contract|multiple[- ]award (?:task order|construction|contract)|single[- ]award task order|blanket purchase agreement|other transaction (?:authority|agreement))s?(?![a-z0-9])/i;

/** The acronyms among those terms (shown in capitals). */
export const PROGRAM_ACRONYMS = new Set(['idiq', 'id/iq', 'joc', 'matoc', 'satoc', 'macc', 'bpa', 'ota']);

export interface SetAsideInfo {
  /** Short name for the card ("HUBZone"). */
  label: string;
  /** Only a certified firm can win: the hard-no reason. null = a size standard, "check you qualify". */
  reserved: string | null;
}

/** Every SAM.gov `typeOfSetAside` code (SAM's published list), and every code `setAsideFromText` returns. */
export const SET_ASIDES: Readonly<Record<string, SetAsideInfo>> = {
  SBA: { label: 'Small business', reserved: null },
  SBP: { label: 'Partial small business', reserved: null },
  '8A': { label: '8(a)', reserved: 'Reserved for 8(a) firms' },
  '8AN': { label: '8(a) sole source', reserved: 'Sole source to an 8(a) firm' },
  HZC: { label: 'HUBZone', reserved: 'Reserved for HUBZone firms' },
  HZS: { label: 'HUBZone sole source', reserved: 'Sole source to a HUBZone firm' },
  SDVOSBC: { label: 'Service-disabled veteran', reserved: 'Reserved for service-disabled veteran-owned firms' },
  SDVOSBS: { label: 'SDVOSB sole source', reserved: 'Sole source to a service-disabled veteran-owned firm' },
  WOSB: { label: 'Women-owned', reserved: 'Reserved for women-owned small businesses' },
  WOSBSS: { label: 'WOSB sole source', reserved: 'Sole source to a women-owned small business' },
  EDWOSB: { label: 'Economically disadvantaged WOSB', reserved: 'Reserved for economically disadvantaged women-owned small businesses' },
  EDWOSBSS: { label: 'EDWOSB sole source', reserved: 'Sole source to an economically disadvantaged women-owned small business' },
  VSA: { label: 'Veteran-owned', reserved: 'Reserved for veteran-owned small businesses' },
  VSS: { label: 'Veteran-owned sole source', reserved: 'Sole source to a veteran-owned small business' },
  ISBEE: { label: 'Indian small business', reserved: 'Reserved for Indian small business economic enterprises' },
  IEE: { label: 'Indian economic enterprise', reserved: 'Reserved for Indian economic enterprises' },
  BICiv: { label: 'Buy Indian', reserved: 'Reserved for Indian-owned firms (Buy Indian)' },
  LAS: { label: 'Local-area', reserved: null }, // disaster-area firms (Stafford Act): location, not a certification
};
