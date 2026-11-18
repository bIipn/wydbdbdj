/**
 * A call to artists (an art commission): artists answer it and a panel picks the artwork, whatever trade or building
 * its title names. Never trade work: dropped at the source by every board that filters (src/sources/relevance.ts),
 * never sub work (src/score/subwork.ts) and never a fit (src/score/score.ts, which covers NGEM: a Nevada board keeps
 * every row). A job posted on BidSwipe itself is the poster's own words and is not read here.
 *
 * Real titles behind it, read from production on 2026-11-18:
 *   NGEM "Permanent Public Art at Reno-Tahoe International Airport New Gen A&B Concourses - 2-D Digital Restroom Artwork"
 *     (stored as Sub work on "restroom") and its "... - Ceiling-Based Artwork" sibling;
 *   OpenGov (Flagstaff) "Request for Informal Proposals - Call to Artists - Artwork for a Traffic Signal Cabinet"
 *     (kept on "traffic signal": 87 "great" for an electrician).
 * The other wordings are the ones such calls go by (review of 2026-11-18): "Call to Artist", "Call for Art", "Artist
 * Call", "Percent-for-Art", "1% for Art", "Art in Public Places", "Art Commission", "RFQ Sculpture Commission",
 * "RFQ - Public Art for …", "Utility Box Art Wraps", "Request for Qualifications: Artist for …".
 *
 * A call is a phrase that is one by itself (CALL_PHRASES), or an art word (ART_WORDS) with a call word (CALL_WORDS) or a
 * second, different art word. One art word alone is a name, not a call: "Mural Hall Renovation", "Public Art Center
 * Restroom Remodel" and "Artwork Storage Building Renovation" are building jobs, and the Notice to Contractors
 * "SMF Pedestrian Walkway - Riparian Public Art Installation Project" (Sacramento, OpenGov) is construction. "Art" on
 * its own is never read ("Art Museum Renovation", "Performing Arts Center", "BART", "Smart Meter"), and neither is
 * "Arts Commission" (an agency's name, not a commission).
 */

/** Words joined by spaces or hyphens ("Percent-for-Art"), never inside another word. */
const J = '[\\s\\-–]+';
const ART = `public${J}art|artworks?|artists?|murals?|sculptures?|mosaics?`;
const phrase = (body: string, flags = 'i'): RegExp => new RegExp(`(?<![a-z0-9])(?:${body})(?![a-z0-9])`, flags);

/** Each is a call to artists by itself. */
const CALL_PHRASES: readonly RegExp[] = [
  phrase(`calls?${J}(?:to|for)${J}(?:public${J})?(?:art|artists?|artworks?)`), // Call to Artists, Call for Art
  phrase(`artists?${J}calls?`), // Artist Call
  phrase(`art${J}in${J}public${J}places?`),
  /(?:(?<![a-z0-9])percent|%)[\s\-–]+for[\s\-–]+(?:the[\s\-–]+)?arts?(?![a-z0-9])/i, // Percent-for-Art, 1% for Art
  phrase(`(?:art|artist)${J}commissions?|commissioned${J}(?:art|artworks?)`), // never "Arts Commission", an agency
  phrase(`(?:art|box)${J}wraps?`), // Utility Box Art Wraps, Traffic Signal Box Wraps
  // RFQ - Public Art for Traffic Signal Boxes; Request for Qualifications: Artist for Restroom Renovation
  phrase(`(?:rfq|rfp|request${J}for${J}(?:qualifications|proposals))[\\s\\-–:]*(?:for${J})?(?:an?${J})?(${ART})`),
];

/** Art words: a call only with a call word or a second, different art word. */
const ART_WORDS = phrase(ART, 'gi');
/** What makes an art word a call: it is commissioned, selected, called for. */
const CALL_WORDS = phrase(`calls?|commissions?|commissioned|selection`);

const said = (m: string): string => m.toLowerCase().replace(/[\s\-–]+/g, ' ').replace(/^%/, 'percent').trim();

/** The words that make this title a call to artists ("call to artists", "public art"), or null. */
export function artCall(title: string | null | undefined): string | null {
  if (!title) return null;
  for (const re of CALL_PHRASES) {
    const m = re.exec(title);
    if (m) return said(m[1] ?? m[0]); // the RFQ phrase names its art word (group 1)
  }
  const words = [...title.matchAll(ART_WORDS)].map((m) => said(m[0]));
  if (words.length === 0) return null;
  const kinds = new Set(words.map((w) => w.replace(/s$/, '')));
  return kinds.size > 1 || CALL_WORDS.test(title) ? words[0]! : null;
}
