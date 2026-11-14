import { compileKeywords } from '../score/score.js';
import { allTradeWords } from '../trades/catalog.js';

/**
 * Is this listing work a contractor could do? State and city boards list everything they buy: software,
 * consulting, vehicles, food, grants. A source calls this on each row and leaves out the clear "no"s
 * (logging how many: `<id>: N listed, M left out as not trade work`).
 *
 * Conservative on both sides: clear trade work is kept, clear non-trade work is dropped, and ANYTHING UNCLEAR
 * IS KEPT (the scorer sorts it out per company). The order decides, first match wins:
 *   1. the board's own category or commodity code says construction / building work  → keep
 *   1b. a paid-advice, waste-hauling or sale/lease phrase in the TITLE (NEVER_CONTRACTOR below) → drop
 *       ("Dam Safety Engineering Services", "Trash Collection, Hauling…" and "Sandhill Road … Timber Sale" carry
 *       trade words, "dam", "hauling", "road")
 *   2. a trade word in the TITLE (every trade's strong and related words, src/trades/catalog.ts) → keep
 *   3. a non-trade phrase in the TITLE (NON_TRADE below)                               → drop
 *   4. a trade word in the description                                                 → keep
 *   5. a construction word (CONSTRUCTION below) in the title or description            → keep
 *   6. the board's category, or every commodity code it gives, is clearly non-trade   → drop
 *   7. otherwise                                                                        → keep ("unclear")
 * So "Electrical maintenance services" is kept (2 before 3), "Janitorial services for a maintenance complex" is
 * dropped (3), and "146861 MOTOR, 150HP, 720RPM" under LA's category "Commodity" is dropped (6).
 */

export interface TradeWorkInput {
  title: string;
  description?: string | null;
  /** The board's own category or type ("Construction", "Commodity", "Personal Services"). */
  category?: string | null;
  /**
   * Commodity codes as the board gives them; only the leading digits are read ("95405-Laundry and Linen…" →
   * 95405, NIGP class 954; "72101500" → UNSPSC segment 72).
   */
  codes?: { nigp?: readonly string[] | null; unspsc?: readonly string[] | null } | null;
}

export interface TradeWorkAnswer {
  keep: boolean;
  /** Short and specific, for the scan log and tests: "trade word: hvac", "not trade work: janitorial". */
  why: string;
}

// ------------------------------------------------------------------ categories --

/** Board categories that are construction or building work (LA RAMP "Construction", SF "Construction" …). */
const TRADE_CATEGORY = compileKeywords([
  'construction', 'public works', 'building maintenance', 'facilities maintenance', 'facility maintenance',
  'building repair*', 'maintenance and repair', 'maintenance & repair',
]);

/**
 * Board categories that are not contractor work. Seen on 2026-11-14: LA RAMP "Commodity", SF "Personal
 * Services", NYC City Record "Changes in Personnel", MyFloridaMarketPlace "Grant Opportunities".
 */
const NON_TRADE_CATEGORY = compileKeywords([
  'commodity', 'commodities', 'goods', 'supplies', 'personal services', 'professional services',
  'information technology', 'technology', 'software', 'grant*', 'personnel', 'food',
]);

// ------------------------------------------------------------------------ codes --

/**
 * NIGP commodity/services CLASS numbers (the first 3 digits of a 5-digit NIGP code) that are construction work.
 * The titles below are as Texas ESBD prints them in its nigpCodes field (first response, 2026-11-14):
 *   909 "Building Construction Services, New (Incl. Maintenance And Repair Services)" (90900, 90925, 90927)
 *   913 "Construction, Water System/Plants, Main And Service Line" (91360)
 *   914 "Construction Services, Trade (New Construction)" (91400; 91450 "Heating, Ventilating And Air Conditioning")
 * Not seen in our captures, kept from the NIGP class list as the task brief names them: 912 (construction
 * services, general) and 968 (public works and related services). 910 is NOT here: in the same Texas data it
 * holds 91027 "Garbage and Trash Removal" and 91059 "Pest Control" (step 3 decides those by their words).
 */
const NIGP_TRADE_CLASSES = new Set(['909', '912', '913', '914', '968']);

/**
 * NIGP classes that are clearly not contractor work, each seen in Texas ESBD's nigpCodes on 2026-11-14:
 *   071, 073 vehicles and trailers (07120 personal mobility devices, 07347 "Trailers, Utility, Gooseneck")
 *   204, 208 computer hardware and software (20448 "Keyboards", 20811 "Application Software")
 *   860 "Tickets, Coupon Books" · 915 communications and advertising (91501 "Advertising Agency Services")
 *   918 consulting (91832 "Consulting Services", 91871 "IT Consulting") · 920 data processing and software
 *   services (92045 "Software Maintenance and Support…") · 924 educational services (92416 "Course
 *   Development Services") · 954 laundry and linen (95405) · 961 marketing (96153) · 975 vehicle rental and
 *   lease (97514, 97550).
 * Used only when EVERY code a listing carries is in this set (step 6), and never before the words.
 */
const NIGP_NON_TRADE_CLASSES = new Set(['071', '073', '204', '208', '860', '915', '918', '920', '924', '954', '961', '975']);

/** UNSPSC segment 72 = "Building and Facility Construction and Maintenance Services" (UNSPSC segment list). */
const UNSPSC_TRADE_SEGMENTS = new Set(['72']);

/**
 * UNSPSC segments that are not contractor work (UNSPSC segment titles): 25 vehicles, 43 information technology
 * and telecommunications, 44 office equipment and supplies, 50 food and beverage, 53 apparel, 80 management and
 * business professional services, 85 healthcare services, 86 education and training, 90 travel, food, lodging.
 */
const UNSPSC_NON_TRADE_SEGMENTS = new Set(['25', '43', '44', '50', '53', '80', '85', '86', '90']);

const leadingDigits = (code: string): string => /^\s*(\d+)/.exec(code)?.[1] ?? '';

// ------------------------------------------------------------------------ words --

/** Every trade's own words (strong + related, all trades). A catalog edit reaches this list. */
const TRADE_WORDS = compileKeywords(allTradeWords());

/**
 * Not contractor work, by its own name. Phrases rather than single words where a word alone could be a job
 * ("cleaning" could be duct cleaning; "survey" stays, a land survey is not contractor work either). Each group
 * has titles from the first responses of 2026-11-14 behind it (test/relevance.test.ts).
 */
const NON_TRADE = compileKeywords([
  // services that are not a trade
  'janitorial', 'custodial', 'cleaning services', 'laundry', 'linen', 'pest control', 'bed bug*', 'security guard*',
  'guard services', 'guard and security', 'courier', 'small package delivery', 'mail receipt', 'mailroom',
  'catering', 'vending', 'meals', 'food service*', 'translation', 'interpreter*', 'interpreting', 'staffing',
  'recruitment', 'consulting', 'consultant*', 'legal services', 'outside counsel', 'hearings officer',
  'service of process', 'audit', 'audits', 'auditing', 'accounting services', 'actuarial', 'insurance',
  'employee benefits', 'pharmacy', 'pharmaceutical*', 'naloxone', 'medication', 'medical services',
  'treatment services', 'residential treatment', 'counseling', 'case management', 'early intervention',
  'suicide prevention', 'shelter services', 'preschool', 'marketing', 'advertising', 'printing services',
  'data entry', 'records administration', 'customer service', 'call center', 'escrow', 'analytical testing',
  'laboratory analysis', 'trash collection', 'refuse removal', 'dumpsters', 'deceased animals', 'dead animals',
  // software and IT
  'software', 'saas', 'application support', 'application maintenance', 'platform', 'web-based', 'website',
  'data hosting', 'learning management', 'documentation tool', 'annotation tool', 'it services',
  // studies, plans, design, training
  'study', 'feasibility', 'strategic plan*', 'planning services', 'evaluation', 'curriculum', 'tutoring',
  'course development', 'certification training', 'training services', 'conference', 'venue',
  'architectural services', 'architectural/engineering', 'architectural & building related professional engineering',
  'engineering services', 'design services', 'environmental planning', 'surveying', 'survey',
  // goods that are not built
  'furniture', 'uniform*', 'apparel', 'clothing', 'office supplies', 'medical supplies', 'food products',
  'groceries', 'produce', 'meat', 'turkey', 'chicken', 'deli', 'salads', 'dairy', 'bread', 'milk',
  'bottled water', 'vehicle', 'vehicles', 'bucket truck', 'dump truck*', 'pickup truck*', 'tires', 'gasoline',
  'diesel fuel', 'fuel pellets', 'ammunition', 'munitions', 'firearm*', 'copier*', 'computers', 'laptops',
  'keyboards', 'workstation*', 'microscope', 'textbook*', 'tickets', 'body cams', 'horse testing',
  // not a purchase a contractor makes
  'grant program', 'grant', 'unit lease', 'wanted to lease', 'auctioneer', 'flour', 'stock trailer',
  // more goods and services seen kept as "unclear" on the live boards of 2026-11-14 (test/relevance.test.ts)
  'vegetables', 'pork', 'bacon', 'pasta', 'sugar', 'catfish', 'frozen fish', 'juice', 'mayonnaise', 'tomato paste',
  'rifle*', 'glock*', 'dental', 'endodontic', 'psychiatr*', 'breastfeeding', 'debt collection',
  'third party administrator', 'third-party administrator', 'salesforce', 'opioid', 'investment advisory',
  "workers' comp*", 'workers comp*',
  'ambulance', 'transportation services', 'special education transportation',
]);

/**
 * Work that is never a contractor's, whatever trade it names: engineering and design advice, studies, waste
 * hauling. Checked before the trade words ("Electrical engineering services" is a design job, not an install).
 */
const NEVER_CONTRACTOR = compileKeywords([
  'engineering services', 'professional engineering', 'architectural services', 'architectural/engineering',
  'a/e services', 'a&e services', 'architectural and engineering', 'design services', 'consulting', 'consultant*', 'feasibility', 'study',
  'trash collection', 'garbage collection', 'refuse removal', 'refuse collection', 'waste collection', 'dumpsters',
  // sales and leases, not work: "Sandhill Road 26/27 Timber Sale" names a road but is a timber sale (MFMP 2026-11-14)
  'timber sale', 'grazing lease', 'cattle grazing', 'surplus', 'auction',
]);

/** Construction words with no trade of their own: weaker than a trade word, so they come after the non-trade list. */
const CONSTRUCTION = compileKeywords([
  'construction', 'construct', 'renovation*', 'remodel*', 'rehabilitation', 'refurbish*', 'demolition', 'design build',
  'design-build', 'retrofit*', 'tenant improvement*', 'repairs', 'replacement*', 'installation', 'install',
  'improvement project', 'improvements', 'structure*', 'building', 'facility repair*', 'maintenance and repair',
  'trade contractor*', 'contracting services', 'on call', 'on-call',
  // lifts and conveyors are building work (SF "As-Needed Airport Conveyance Maintenance", category Personal Services)
  'conveyance', 'conveyor*', 'escalator*', 'elevator*',
]);

// ---------------------------------------------------------------------- decide --

export function isTradeWork(input: TradeWorkInput): TradeWorkAnswer {
  const title = input.title ?? '';
  const description = input.description ?? '';
  const category = input.category ?? '';
  const nigp = (input.codes?.nigp ?? []).map(leadingDigits).filter(Boolean).map((d) => d.slice(0, 3));
  const unspsc = (input.codes?.unspsc ?? []).map(leadingDigits).filter(Boolean).map((d) => d.slice(0, 2));

  // 1. The board says so.
  const tradeCategory = TRADE_CATEGORY.test(category);
  if (tradeCategory) return { keep: true, why: `board category: ${category.trim()}` };
  const nigpTrade = nigp.find((c) => NIGP_TRADE_CLASSES.has(c));
  if (nigpTrade) return { keep: true, why: `NIGP class ${nigpTrade} (construction)` };
  const unspscTrade = unspsc.find((c) => UNSPSC_TRADE_SEGMENTS.has(c));
  if (unspscTrade) return { keep: true, why: `UNSPSC segment ${unspscTrade} (building and facility construction)` };

  // 1b–5. The words.
  const never = NEVER_CONTRACTOR.test(title);
  if (never) return { keep: false, why: `not contractor work: ${never}` };
  const inTitle = TRADE_WORDS.test(title);
  if (inTitle) return { keep: true, why: `trade word: ${inTitle}` };
  const not = NON_TRADE.test(title);
  if (not) return { keep: false, why: `not trade work: ${not}` };
  const inDescription = TRADE_WORDS.test(description);
  if (inDescription) return { keep: true, why: `trade word in the description: ${inDescription}` };
  const built = CONSTRUCTION.test(title) ?? CONSTRUCTION.test(description);
  if (built) return { keep: true, why: `construction word: ${built}` };

  // 6. The board's category or codes say it is not.
  const nonTradeCategory = NON_TRADE_CATEGORY.test(category);
  if (nonTradeCategory) return { keep: false, why: `board category: ${category.trim()}` };
  const codes = [...nigp.map((c) => ({ c, bad: NIGP_NON_TRADE_CLASSES.has(c) })), ...unspsc.map((c) => ({ c, bad: UNSPSC_NON_TRADE_SEGMENTS.has(c) }))];
  if (codes.length > 0 && codes.every((x) => x.bad)) return { keep: false, why: `commodity codes: ${[...new Set(codes.map((x) => x.c))].join(', ')}` };

  // 7. Unclear: kept, the scorer decides per company.
  return { keep: true, why: 'unclear: kept' };
}

/**
 * Filter a list and count what was left out, for the source's log line. `pick` reads the fields of one row.
 *   const { kept, left } = keepTradeWork(rows, (r) => ({ title: r.title, category: r.category }));
 *   ctx.log(`laramp: ${kept.length} kept, ${left} left out as not trade work`);
 */
export function keepTradeWork<T>(rows: readonly T[], pick: (row: T) => TradeWorkInput): { kept: T[]; left: number } {
  const kept = rows.filter((r) => isTradeWork(pick(r)).keep);
  return { kept, left: rows.length - kept.length };
}
