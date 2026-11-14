import {
  BUILDING_PRIME_NAICS, BUILDING_PSC, CIVIL_PRIME, getTrade, NAICS_TITLES, PRIME_TRADE, SUB_WORK, TRADES, tradeNoun, type CivilKind,
} from '../trades/catalog.js';
import { pscTitle } from '../sources/psc.js';
import type { Bid } from '../types.js';
import { compileKeywords, type Matcher } from './keywords.js';

/**
 * Sub work: a PRIME contract a general contractor bids to the agency, where this company's trade is
 * ordinarily a subcontract. The company does not bid it; it quotes the bidders. Two kinds:
 *
 *   building  a building job (new, or a renovation / remodel / addition) for a trade that sits inside one
 *             (src/trades/catalog.ts SUB_WORK). Evidence, both required:
 *               - the kind of prime: a federal notice filed under a building NAICS code (236220 / 236210) or a
 *                 building PSC class (Y1/Z1/Z2 + A C D E F H J); a board notice (no code) only by its title;
 *               - the title names whole-building work ("renovation", "remodel", "construct"…), not one
 *                 trade's job: "Replace Roof at Building 347" (236220) names a roof, not a building job.
 *   civil     a road or utility job, ONLY for a trade that sits in one, and only when the notice's own text
 *             (category / description) names that trade's scope: "traffic signal" in a road job's text.
 *
 * Never sub work: a profile with the general-building trade (it is the prime), a job posted on BidSwipe
 * itself, a title that names the company's own or a related trade (that is a fit, scored as today), a title
 * that names another trade's work, a likely purchase, or civil words in a building title. When in doubt the
 * answer is null: a wrong SUB WORK label is worse than a missing one.
 */

/** What the scorer already knows about the bid's trade, from its own matchers. */
export interface TradeHits {
  /** A strong or related word of the company's trades in the TITLE, its own NAICS code, its PSC, a posted trade. */
  fitInTitle: boolean;
  /** Another trade's word in the title (the profile's otherTrades list). */
  otherInTitle: string | null;
  /** A likely purchase: a supply board's title that names no work. */
  supplyOnly: boolean;
  /** A program contract (IDIQ, JOC, MATOC…): a seat on many jobs, not one job anyone quotes. */
  program: boolean;
}

export interface SubWork {
  kind: 'building' | CivilKind;
  /** The company's trades this is sub work for, in catalog order. */
  trades: string[];
  /** The first reason: plainly sub work, and why. */
  why: string;
  /** "Filed as NAICS 236220 — Commercial and Institutional Building Construction" (code evidence only). */
  filed: string | null;
  /** What to do: quote the bidders, and where the list of them is. */
  action: string;
}

// Whole-building work. With a building CODE the notice is known to be a building job, so any of these say it is
// the whole job; on a board (no code) only words that cannot be a road or a pipe count.
const NEW_WITH_CODE = compileKeywords([
  'construct', 'construction', 'constructing', 'new building*', 'new facilit*', 'new construction', 'building addition*',
  'addition', 'additions', 'replacement facility', 'design-build', 'design build', 'design-bid-build',
]);
const RENO_WITH_CODE = compileKeywords([
  'renovat*', 'remodel*', 'tenant improvement*', 'moderniz*', 'rehabilitat*', 'alteration*', 'restroom*',
  'expansion', 'expand*', 'building improvement*', 'facility improvement*', 'interior improvement*', 'building upgrade*',
  'repair and alteration*', 'reconfigur*', 'build-out', 'buildout', 'fit-out', 'fitout',
]);
const NEW_ON_BOARD = compileKeywords([
  'new building*', 'new facilit*', 'building addition*', 'classroom addition*', 'new fire station*', 'new school*',
  'new library', 'new community center',
]);
const RENO_ON_BOARD = compileKeywords([
  'renovat*', 'remodel*', 'tenant improvement*', 'restroom*', 'building improvement*', 'building upgrade*',
  'building rehabilitation', 'facility improvement*', 'interior improvement*', 'building addition*',
]);

/**
 * A teardown or clean-up, a rental or a study: not a building job with trades inside it ("IFB 7CA08060 - Portable
 * Restroom and Handwash Station Rental Services" names a restroom but rents them; "Public Safety Building Space Needs
 * Assessment and Renovations" is a design study first).
 */
const NOT_A_BUILD = compileKeywords([
  'decommission*', 'demolition', 'demolish*', 'demo', 'abatement', 'remediat*', 'removal', 'disposal', 'cleanup', 'clean-up',
  'rental*', 'rent', 'lease', 'leasing', 'portable restroom*', 'portable toilet*', 'assessment', 'study', 'master plan*',
]);

/** Words that put a title outside a building, whatever its code says. */
const CIVIL_IN_TITLE = compileKeywords([
  'road', 'roads', 'roadway*', 'street', 'streets', 'highway*', 'boulevard', 'bridge*', 'parking lot*', 'parking garage*',
  'trail*', 'sewer*', 'water main*', 'waterline*', 'water line*', 'pipeline*', 'dam', 'dams', 'levee*', 'channel*',
  'dredg*', 'canal*', 'culvert*', 'runway*', 'taxiway*', 'apron', 'airfield', 'reservoir*', 'storm drain*', 'stormwater',
  'seawall', 'shoreline', 'breakwater', 'jetty', 'pier', 'wharf', 'dock*', 'fence', 'fencing', 'campground*', 'pump', 'pumps',
  'fishway*', 'stadium*', 'field', 'fields', 'court', 'courts', 'athletic complex', 'golf course*', 'ballfield*',
]);
/**
 * The civil thing itself being renovated, whatever building the title also names: "Polk Street Community Center Parking
 * Lot Renovation Project", "26190 - Tennis & Basketball Court Renovation IDQ FY27".
 */
const CIVIL_WORKED_ON = /\b(?:parking\s+lots?|(?<!food\s)courts?|fields?|trails?|roads?|streets?|bridges?|playgrounds?)\s+(?:renovat|remodel|improvement|rehab|replacement|upgrade|resurfac|repair)/i;
/** A building named in the title: civil words beside one are a place name ("Englebright Dam and Lake HQ Building"). */
const BUILDING_NOUN = compileKeywords([
  'building', 'buildings', 'bldg*', 'facility', 'facilities', 'headquarters', 'barracks', 'dormitor*', 'school*',
  'clinic*', 'hospital*', 'office building*', 'administration building*', 'library', 'courthouse', 'fire station*',
  'visitor center*', 'community center*', 'health center*', 'medical center*', 'imaging center*', 'warehouse*', 'hangar*',
  'clubhouse*',
]);
/** What a code-only building job must name: a facility, not a component. */
const FACILITY_NOUN = compileKeywords([
  'building*', 'bldg*', 'facility', 'facilities', 'center', 'centre', 'complex', 'barracks', 'dormitor*', 'dorm', 'school',
  'clinic', 'hospital', 'hangar', 'office', 'offices', 'headquarters', 'lab', 'laboratory', 'chapel', 'shop', 'quarters',
  'housing', 'apartment*', 'duplex', 'port of entry', 'lpoe', 'courthouse', 'barn', 'warehouse', 'library', 'greenhouse*',
]);
/** A shell with no plumbing or HVAC in it ("Y1DA--NRM-CONST | 528A4-27-202 Salt Barn Batavia | FY27 NRM"). */
const SHELL_ONLY = compileKeywords(['salt barn*', 'salt shed*', 'salt dome*', 'pole barn*', 'storage shed*', 'pavilion*', 'canop*', 'bus shelter*']);
const NEEDS_MEP: ReadonlySet<string> = new Set(['plumbing', 'hvac']);

/** How a job is bought, not what it is. */
const GENERIC_NEW: ReadonlySet<string> = new Set(['construct', 'construction', 'constructing', 'design-build', 'design build', 'design-bid-build']);
/** Work inside an existing building: no roof, no site work, no planting in it. */
const INSIDE_WORK = compileKeywords([
  'interior*', 'upgrade*', 'site prep', 'infrastructure', 'improvement*', 'kitchen*', 'finish*', 'retrofit*', 'repair*',
  'maintenance', 'refresh', 'floor', 'floors', 'suite', 'wing', 'ward', 'wards', 'room', 'rooms',
]);
/** A title about one system or one repair, whatever building it is in. */
const ONE_SYSTEM = compileKeywords(['system', 'systems', 'repair*', 'replace', 'pad', 'amendment']);

/** Y1 + a building letter: the code itself says "construction of" a building (a new building or a major addition). */
const BUILDING_CONSTRUCTION_PSC = /^Y1[ACDEFHJ]/;

/** A board's road or utility job, by its title (no code to go on). */
const CIVIL_BOARD: Readonly<Record<CivilKind, Matcher>> = {
  road: compileKeywords(['road', 'roads', 'roadway*', 'street', 'streets', 'highway*', 'boulevard', 'intersection*', 'bridge*']),
  utility: compileKeywords([
    'water main*', 'waterline*', 'water line*', 'sewer*', 'pipeline*', 'treatment plant*', 'wastewater', 'wrf', 'water reclamation',
    'water well*', 'storage tank*', 'lift station*', 'pump station*',
  ]),
};
/**
 * On a board a road word can be an address: "Fifth Street Parking Garage Security Project" is work in a garage, "DEP SRF
 * Harbor Road WRF Expansion" and "Water Well Rehabilitation: Willow Bank and Eldridge Road" are utility jobs.
 */
const NOT_A_ROAD_ON_BOARD = compileKeywords(['garage*', 'parking structure*', 'security']);

/**
 * "PSC Z2DA — Repair or alteration of hospitals and infirmaries": the code and the PSC Manual's own title
 * (src/sources/psc.ts, verbatim there, in sentence case here). Just "PSC Z2DA" for a code with no title there.
 */
export function pscLabel(psc: string): string {
  const title = pscTitle(psc);
  return title ? `PSC ${psc} — ${title[0]}${title.slice(1).toLowerCase()}` : `PSC ${psc}`;
}

const otherCache = new Map<string, Matcher>();
/**
 * Every OTHER catalog trade's strong words (not the general-building trade's, which are the GC's own words): a
 * title naming one ("Remove and Replace Roof", "Modernize Nurse Call") is that trade's job, not a GC's building job.
 */
function otherTradesOf(tradeIds: readonly string[]): Matcher {
  const key = [...tradeIds].sort().join(',');
  let m = otherCache.get(key);
  if (!m) {
    const own = new Set(tradeIds.flatMap((id) => [...(getTrade(id)?.keywords.strong ?? []), ...(getTrade(id)?.keywords.related ?? [])]));
    const words = TRADES.filter((t) => t.id !== PRIME_TRADE && !tradeIds.includes(t.id)).flatMap((t) => t.keywords.strong).filter((w) => !own.has(w));
    otherCache.set(key, (m = compileKeywords([...new Set(words)])));
  }
  return m;
}

const strongCache = new Map<string, Matcher>();
/** A trade's own strong words (the catalog's), for "the notice's text names this trade's scope". */
function strongOf(id: string): Matcher {
  let m = strongCache.get(id);
  if (!m) strongCache.set(id, (m = compileKeywords(getTrade(id)?.keywords.strong ?? [])));
  return m;
}

/** The action line: quote the bidders, and where a list of them is. */
export function quoteAction(source: Bid['source']): string {
  if (source === 'samgov') return 'Quote the bidders: check the interested vendors list on SAM.gov';
  if (source === 'questcdn') return 'Quote the bidders: the plan holders list is on the project’s QuestCDN page';
  return 'Quote the bidders: ask the agency who took out plans';
}

function nounsOf(ids: readonly string[]): string {
  const nouns = ids.map((id) => tradeNoun(id) ?? id).slice(0, 2);
  return nouns.join(' and ');
}

/**
 * Is this bid sub work for a company with these trades? `tradeIds` are the profile's catalog trades; a config
 * profile with none (the pilot) passes ['electrical']. Pure.
 */
const DIRECT_TRADE_CALL = /\btrade\s+packages?\b|\bfiled\s+sub-?bids?\b/i;

export function subWorkFor(
  bid: Pick<Bid, 'source' | 'title' | 'category' | 'description' | 'naics' | 'psc' | 'location'>, tradeIds: readonly string[], hits: TradeHits,
): SubWork | null {
  if (tradeIds.length === 0 || tradeIds.includes(PRIME_TRADE) || bid.source === 'local') return null;
  // Reach must be checkable: a notice with neither a map point nor a state (a base abroad, a blank place) could be
  // anywhere, and quoting a GC on it is no option at all.
  if (bid.location.lat == null && !bid.location.state) return null;
  if (hits.fitInTitle || hits.otherInTitle || hits.supplyOnly || hits.program) return null;
  // A call for trade packages or filed sub-bids is bid by the trade contractors themselves, to the owner: not a GC's
  // job to quote ("TRC1909 RFQ for Fifteen (15) Trade Packages for Renovation/Stabilization of Lynn Courthouse", COMMBUYS).
  if (DIRECT_TRADE_CALL.test(bid.title)) return null;
  const title = bid.title;
  const naics = bid.naics ?? null;
  const psc = bid.psc ? bid.psc.toUpperCase() : null;
  const action = quoteAction(bid.source);

  // ---- building --------------------------------------------------------
  // A specialty-trade NAICS (238…) says the prime IS that trade (a roofer, a demolition firm), not a GC: then a
  // building PSC does not make it a GC's building job.
  // Heavy civil (237…) the same: a fishway or a stadium filed under a building PSC is a civil prime's job.
  const tradeOrCivil = naics !== null && (naics.startsWith('238') || naics.startsWith('237'));
  const codeSaysBuilding = (naics !== null && BUILDING_PRIME_NAICS.includes(naics)) || (!tradeOrCivil && psc !== null && BUILDING_PSC.test(psc));
  const hasCode = naics !== null || psc !== null;
  // A federal notice is only a building job when its code says so; a board (no code) only by its title.
  if ((codeSaysBuilding || !hasCode) && (!CIVIL_IN_TITLE.test(title) || BUILDING_NOUN.test(title)) && !CIVIL_WORKED_ON.test(title)
    && !NOT_A_BUILD.test(title) && !otherTradesOf(tradeIds).test(title)) {
    // Code only (no work word): a "Construction of …" building PSC, a building NAICS, and a building named in the
    // title, not one system or one repair ("Replace Pneumatic Tube System", "Lightning Protection System").
    const builds = psc !== null && BUILDING_CONSTRUCTION_PSC.test(psc) && naics !== null && BUILDING_PRIME_NAICS.includes(naics)
      && FACILITY_NOUN.test(title) !== null && !ONE_SYSTEM.test(title);
    const found = codeSaysBuilding ? NEW_WITH_CODE.test(title) : NEW_ON_BOARD.test(title);
    // "Construction" and "design-build" say how a job is bought, not what it is: they count only beside a facility.
    const newWord = found !== null && (!GENERIC_NEW.has(found) || FACILITY_NOUN.test(title) !== null) ? found : null;
    const renoWord = codeSaysBuilding ? RENO_WITH_CODE.test(title) : RENO_ON_BOARD.test(title);
    // A new building (for the trades that are only in new ones): a new-work word and nothing that says the job is
    // inside an existing building; or, with no word, a "Construction of …" PSC on a title that says new / replacement.
    const inside = renoWord !== null || INSIDE_WORK.test(title) !== null;
    // A Z1 (maintenance) or Z2 (repair or alteration) code is work on an existing building, whatever the title says.
    const existing = psc !== null && /^Z[12]/.test(psc);
    const isNew = !inside && !existing && (newWord !== null || (builds && /\b(?:new|replacement)\b/i.test(title)));
    // No word, but the PSC is "Construction of …" a building: the code is the evidence, and the reason says so.
    const word = newWord ?? renoWord;
    const shell = SHELL_ONLY.test(title) !== null;
    const trades = tradeIds.filter((id) => {
      if (shell && NEEDS_MEP.has(id)) return false;
      const spec = SUB_WORK[id]?.building;
      return spec === 'all' ? builds || word !== null : spec === 'new' ? isNew : false;
    });
    if ((word || builds) && trades.length) {
      const nouns = nounsOf(trades);
      const filed = naics !== null && BUILDING_PRIME_NAICS.includes(naics)
        ? `Filed as NAICS ${naics} — ${NAICS_TITLES[naics]}`
        : psc !== null && BUILDING_PSC.test(psc) ? `Filed as ${pscLabel(psc)}` : null;
      return {
        kind: 'building', trades, filed, action,
        why: `Sub work: a general contractor bids this ${word ? `building job (“${word}”)` : 'building construction job'}; ${nouns} ${trades.length > 1 ? 'are' : 'is'} usually subcontracted`,
      };
    }
  }

  // ---- civil: only when the notice's own text names the trade's scope ----
  const text = [bid.category, bid.description].filter(Boolean).join(' · ');
  if (!text) return null;
  for (const kind of ['road', 'utility'] as const) {
    const prime = CIVIL_PRIME[kind];
    const byCode = (naics !== null && prime.naics.includes(naics)) || (psc !== null && prime.psc.test(psc));
    const isKind = byCode || (!hasCode && CIVIL_BOARD[kind].test(title) !== null
      && (kind !== 'road' || (!CIVIL_BOARD.utility.test(title) && !BUILDING_NOUN.test(title) && !NOT_A_ROAD_ON_BOARD.test(title))));
    if (!isKind) continue;
    const named = tradeIds
      .filter((id) => SUB_WORK[id]?.civil.includes(kind))
      .map((id) => ({ id, word: strongOf(id).test(text) }))
      .filter((x): x is { id: string; word: string } => x.word !== null);
    if (!named.length) continue;
    const trades = named.map((x) => x.id);
    const filed = naics !== null && prime.naics.includes(naics) ? `Filed as NAICS ${naics} — ${NAICS_TITLES[naics]}`
      : psc !== null && prime.psc.test(psc) ? `Filed as ${pscLabel(psc)}` : null;
    return {
      kind, trades, filed, action,
      why: `Sub work: a general contractor bids this ${prime.label} job; the notice names ${nounsOf(trades)} scope (“${named[0]!.word}”)`,
    };
  }
  return null;
}
