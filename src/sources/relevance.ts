import { compileKeywords } from '../score/score.js';
import { allTradeWords } from '../trades/catalog.js';

/**
 * Is this listing work a contractor could do? State and city boards list everything they buy: software,
 * consulting, vehicles, food, grants, parts. A source calls this on each row and leaves out the "no"s (logging
 * how many: `<id>: N listed, M left out as not trade work`).
 *
 * The order decides, first match wins (every list below has real titles behind it, test/relevance.test.ts):
 *   0. a board's own id rule: a Caltrans construction contract (Cal eProcure, department 2660, district id)  → keep
 *   1. design, advice or IT in the TITLE (DESIGN_IT: A&E, construction management, cyber, software …)        → drop
 *      ("A&E Electrical Retainer", "Cyber Assets … Bulk Electric System" carry trade words)
 *   2. the board's own category or commodity code says construction / building work                       → keep
 *   3. a service, sale or lease that is never a contractor's, in the TITLE (NEVER_CONTRACTOR)               → drop
 *      ("Street Sweeping Services", "Sandhill Road … Timber Sale" carry trade words, "street", "road")
 *   4. a PURCHASE: the title names goods (parts, supplies, materials, equipment, a vehicle, a rental …) and no
 *      work on them (WORK: install, replace, repair, build, maintain …)                                      → drop
 *      ("Traffic Signal Parts", "DISTRIBUTION TRANSFORMERS", "Portable Restroom … Rental Services")
 *   5. a trade word in the TITLE (every trade's strong and related words, src/trades/catalog.ts)            → keep
 *   6. a non-trade phrase in the TITLE (NON_TRADE)                                                            → drop
 *   7. a work or construction word in the TITLE (CONSTRUCTION)                                               → keep
 *   8. a trade word, then a construction word, in the description                                           → keep
 *   9. the board's category, or every commodity code it gives, is clearly non-trade                         → drop
 *  10. otherwise "unclear": the board's policy (UNCLEAR_DROPPED below). Statewide purchasing lists drop it
 *      (what is left there is tuna, trash bags and software); boards whose leftovers are still mostly jobs keep it.
 * Titles are matched with their run-together words split ("FMD.RollUpDoorMaintenance" reads as "FMD Roll Up
 * Door Maintenance"); the title itself is never changed.
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
  /** The source id ('caleprocure', 'commbuys' …): picks the board's id rule and its policy for unclear rows. */
  board?: string | null;
  /** The row's id on that board (Cal eProcure: "<department>-<event id>"). */
  sourceId?: string | null;
}

export interface TradeWorkAnswer {
  keep: boolean;
  /** Short and specific, for the scan log and tests: "trade word: hvac", "not trade work: janitorial". */
  why: string;
}

// ------------------------------------------------------------------ boards --

/**
 * Boards whose rows the word rules leave unclear are DROPPED, not kept. Read on the stored rows of the live test
 * scan of 2026-11-14 (scratchpad w3/relevance, 40 seeded rows per board plus every unclear row):
 *   caleprocure  132 unclear of 314: forklifts, canned tuna, plastic trash bags, AI systems, voting systems, crane
 *                rentals, interpreting; the terse real jobs are caught first by the Caltrans id rule ("Structural
 *                Conc, bar Reinf steel …") and the split run-together words ("25-316173.FMD.BASMaintenance").
 *   commbuys     444 unclear of 721: oncology data, artist residencies, clinical services, encyclopedias, school
 *                buses, cancer screenings; its jobs say what they do ("Resurfacing and Related Work on Route 131").
 *   oregonbuys, bidbuy, njstart, flmfmp: the same kind of list (job placement, DNA kits, farm leases, rice).
 *   laramp, nycrecord: the unclear rows left are an ERP selection, a "POWER" RFI, a vCISO, commissary operations.
 *   opengov      about 250 unclear of 1,185 (every one read): banking, polygraphs, vaccines, ballots, shelters, laptops;
 *                the six jobs among them are caught by words now ("2657ITB - LPGA Boulevard & Jimmy Ann Drive
 *                Intersection", "McKay Bay Expansion Joint 111226BB", "Heat Exchanger and Condenser Services").
 * Kept (the default) everywhere else: the Nevada boards are as they were (QuestCDN included), and Texas ESBD, SF and
 * E-Rate rows reach this step through the board's own codes or gates.
 */
const UNCLEAR_DROPPED: ReadonlySet<string> = new Set([
  'caleprocure', 'commbuys', 'oregonbuys', 'bidbuy', 'njstart', 'flmfmp', 'laramp', 'nycrecord', 'opengov',
]);

/**
 * Cal eProcure: every Caltrans (department 2660) event whose id is a district number and a six-character EA
 * ("2660-03-1N7504", "2660-10-1H0204") is a highway construction contract; their names are terse bid-item lists
 * ("Structural Conc, bar Reinf steel, Str Exc, and partially grouted RSP."). All 46 of 2026-11-14 were. The
 * district's service contracts ("2660-05A3057" Scrap Metal Recycling) go through the word rules.
 */
const CALTRANS_CONTRACT = /^2660-(0[1-9]|1[0-2])-[0-9A-Z]{6}$/;

// ------------------------------------------------------------------ categories --

/**
 * Board categories that are construction or building work (LA RAMP "Construction", SF "Construction" …). CUPCCAA
 * (California's Uniform Public Construction Cost Accounting Act) templates are public works by law (OpenGov
 * "Informal Bid - CUPCCAA", "CUPCCAA BID $75k-$220k").
 */
const TRADE_CATEGORY = compileKeywords([
  'construction', 'public works', 'building maintenance', 'facilities maintenance', 'facility maintenance',
  'building repair*', 'maintenance and repair', 'maintenance & repair', 'cupccaa',
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
 * holds 91027 "Garbage and Trash Removal" and 91059 "Pest Control" (the words decide those).
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
 * Used only when EVERY code a listing carries is in this set (step 9), and never before the words.
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
 * Design, advice and IT: never a contractor's job, whatever trade or category the row names. Checked first.
 * "Construction management" is the owner's adviser; "Construction Manager at Risk" (CMAR) and "CM/GC" are
 * contractors and do not match (step 1 skips "construction management at risk").
 */
const DESIGN_IT = compileKeywords([
  // design and engineering (Cal eProcure "CR25-302073.FMD.A&E Electrical Retainer", OpenGov "Architectural and
  // Engineering (A&E) Services for a Recreation Center Lighting Upgrade", UC Davis "RFQ for Design Professional …")
  'a&e', 'a/e', 'a & e', 'architect', 'architects', 'architecture', 'architectural services', 'architectural and engineering',
  'architectural & engineering', 'architectural/engineering', 'architectural & building related professional engineering',
  'engineering services', 'engineering support', 'professional engineering', 'engineering design', 'design and engineering',
  'construction engineering', 'design services', 'design professional*', 'design consultant*', 'professional services',
  // advice, management, estimates, studies (Cal eProcure "CONSTRUCTION MANAGEMENT SERVICES-POTRERO FIRE STATION",
  // "Progressive Design-Build Independent Cost Estimator Services", SF "NextGen Power & Fiber Backbone Assmt")
  'construction management', 'program management', 'project management', 'cost estimat*', 'independent cost',
  'plan review', 'plan check', 'special inspection*', 'materials testing', 'consulting', 'consultant*', 'advisory',
  'feasibility', 'study', 'studies', 'assessment', 'assmt', 'appraisal', 'master plan', 'master planning',
  'technical assistance', 'on-call professional', 'on call engineering', 'on-call engineering', 'designer*',
  // audits are advice, whatever they audit ("MMIS Controls Audit", Cal eProcure 2026-11-14: "controls" is a trade word)
  'audit', 'audits', 'auditing',
]);

/**
 * IT and cyber, checked with DESIGN_IT (LA RAMP "RFQ - Procurement of Cyber Assets/Services Supporting the Bulk Electric
 * System", Cal eProcure "Homeless Data Integration System - Maintenance and Operations", LA "… Online Activities
 * Registration System"), except in a title that builds something (OregonBuys "27-2005 Design/Build Temporary Cyber Site").
 */
const IT = compileKeywords([
  'cyber*', 'software', 'saas', 'information technology', 'it services', 'artificial intelligence', 'data integration',
  'integration system', 'information management', 'information security', 'web-based',
  'web based', 'website', 'online', 'erp', 'database*', 'point of sale', 'digital certificate', 'registration system',
  // "Palo Alto Firewall & Panorama Maintenance Renewal", "Cloud-Hosted Phone System (UCaaS)" (2026-11-14)
  'firewall*', 'ucaas', 'cloud-hosted', 'cloud hosted', 'iru', 'dark fiber',
]);

/** Building work strong enough to beat a NEVER_CONTRACTOR phrase that names the place, not the job. */
const STRONG_WORK = compileKeywords(['construct*', 'install*', 'rehab*', 'renovat*', 'repair*', 'replac*', 'design-build', 'design build']);

/** A title that builds something: an IT word in it names what is built, not the job. */
const BUILDS = compileKeywords(['design build', 'design-build', 'design/build', 'construct*', 'install*']);

/** "Construction Management at Risk" and NYC's "Construction Management - Build" are construction contracts (the CM
 * holds the trade contracts and builds): not advice. */
const CM_AT_RISK = /construction\s+manage(?:ment|r)\s+(?:at|@)[\s-]*risk|construction\s+management\s*[-–]\s*build|construction\s+management\s*\/\s*general\s+contract/i;

/**
 * Services, sales and leases that are never a contractor's job, checked before the trade words because their
 * titles carry them ("Street Sweeping Services", "Janitorial Services For Parks", "Rodent Pest Control Services for
 * Grizzly Creek Redwoods State Park", "Queensboro Bridge Ramps Transfer of Development Rights").
 */
const NEVER_CONTRACTOR = compileKeywords([
  'trash collection', 'garbage collection', 'refuse removal', 'refuse collection', 'refuse services', 'waste collection',
  'dumpsters', 'waste disposal', 'waste services', 'waste removal', 'hazardous waste', 'organic waste', 'disposal services',
  'sludge removal', 'pick-up and disposal', 'pickup and disposal', 'recycling', 'sweeping', 'janitorial', 'custodial',
  'pest control', 'rodent', 'helicopter', 'security services', 'security guard*', 'guard services', 'towing', 'tow and storage',
  'impound', 'fireworks', 'provider network', 'evaluator network', 'funding opportunit*', 'notice of funding',
  'funding availability', 'gap funding', 'funding application*', 'broadband funding', 'development rights', 'capacity building',
  'mural', 'call for artists', 'percent for art', 'scrap metal', 'salvage',
  // sales and leases, not work: "Sandhill Road 26/27 Timber Sale" names a road but is a timber sale (MFMP 2026-11-14)
  'timber sale', 'grazing lease', 'cattle grazing', 'farm lease', 'surplus', 'auction', 'sale of', 'real estate',
  'brokerage', 'concession*',
  // services named "on-call" that are not a trade ("On-Call Utility Billing Assistance Services", "On-Call Labor
  // Compliance Services", "Airport Security Coordinator (ASC) On-Call Services", 2026-11-14)
  'utility billing', 'billing services', 'billing assistance', 'labor compliance', 'security coordinator',
]);

/**
 * Goods: a title that names one of these and no WORK is a purchase. Real rows behind each group: "Traffic Signal
 * Parts", "HVAC and Refrigeration Parts", "DISTRIBUTION TRANSFORMERS", "Conventional Pole Mount Transformers",
 * "1PA5A008833.02 HUU Diesel Generator Set", "HSR26-28 Invitation for Bids for Copper Conductors", "Asphalt Concrete
 * Plant Mix, Delivered", "Thermoplastic Traffic Striping Material and Paint", "DCR 903 Roadway Patch Materials",
 * "FDOT Purchase of New Skid-Mounted Sewer Jetter", "Trailer-Mounted Sewer Jetter", "HVAC Filters", "Brass Fittings
 * Annual Contract", "… Reach Truck … Forklifts", "42871QR27 FABRICATION AND DELIVERY OF ALUMINUM WALKWAYS".
 */
const GOODS = compileKeywords([
  'parts', 'spare parts', 'supplies', 'materials', 'material', 'equipment', 'components', 'kits', 'kit',
  'generator set', 'generator sets', 'transformers', 'conductors', 'fittings', 'filters', 'cartridges', 'chemicals',
  'delivered', 'delivery', 'purchase', 'purchasing', 'procurement of', 'manufacturing', 'trailer-mounted',
  'trailer mounted', 'skid-mounted', 'vehicle', 'vehicles', 'truck', 'trucks', 'forklift*', 'tractor*', 'utv', 'suvs',
  'mower*', 'trash bags', 'towels', 'water heaters', 'blasters', 'lockers', 'products',
  // "Golf Course Merchandise", "Gate Valves", "Traffic Marking Paint" (2026-11-14): goods, whatever trade word they carry
  'merchandise', 'valves', 'marking paint', 'boots',
]);

/** A rental or lease is not a job unless the title also names building work ("… Installation and Rental Services"). */
const RENTAL = compileKeywords(['rental*', 'rent', 'lease', 'leases', 'leasing']);

/** Work done on the goods a title names: these turn a goods title back into a job ("Installation and Services of 2
 * Uninterrupted Power Supply Units", "Floor Care Equipment Preventative Maintenance and Repair Services"). */
const WORK = compileKeywords([
  'install*', 'replac*', 'repair*', 'construct*', 'build', 'rebuild*', 'renovat*', 'rehab*', 'remodel*', 'retrofit*',
  'refurbish*', 'restor*', 'upgrade*', 'modif*', 'maintenance', 'maintain*', 'overhaul*', 'painting', 'paving',
  'demolition', 'abatement', 'removal', 'improvement*', 'furnish and install', 'm&r', 'planting',
]);

/**
 * Not contractor work, by its own name; checked AFTER the trade words ("Electrical maintenance services" stays).
 * Phrases rather than single words where a word alone could be a job ("cleaning" could be duct cleaning; "survey"
 * stays here, a land survey is not contractor work either). Each group has titles from the first responses of
 * 2026-11-14 behind it (test/relevance.test.ts).
 */
const NON_TRADE = compileKeywords([
  // services that are not a trade
  'cleaning services', 'laundry', 'linen', 'bed bug*', 'courier', 'small package delivery', 'mail receipt', 'mailroom',
  'catering', 'vending', 'meals', 'food service*', 'translation', 'interpreter*', 'interpreting', 'interpretation',
  'staffing', 'recruitment', 'legal services', 'outside counsel', 'hearings officer', 'service of process', 'audit',
  'audits', 'auditing', 'accounting services', 'actuarial', 'insurance', 'employee benefits', 'pharmacy',
  'pharmaceutical*', 'naloxone', 'medication', 'medical services', 'treatment services', 'residential treatment',
  'counseling', 'case management', 'early intervention', 'suicide prevention', 'shelter services', 'preschool',
  'marketing', 'advertising', 'printing services', 'data entry', 'records administration', 'customer service',
  'call center', 'escrow', 'analytical testing', 'laboratory analysis', 'deceased animals', 'dead animals',
  // vehicles and machines are not buildings (Cal eProcure "IFB Small Engine Repair Services, Orange County",
  // "IFB Locomotive Overhaul Services in Oakland, CA", NYC "Auto Body and Chassis Repair Services for Queens East")
  'boot repair', 'shoe repair', 'small engine', 'locomotive', 'auto body', 'chassis', 'motor vehicle', 'vehicle inspection', 'fleet maintenance', 'heavy equipment', 'diver',
  '3rd party testing', 'third party testing', 'protective ensembles', 'ladder inspection', 'calibration', 'emissions measurement', 'pems', 'legionella',
  // software and IT
  'information system*', 'platform', 'application support', 'application maintenance', 'data hosting', 'learning management',
  'documentation tool', 'annotation tool',
  // studies, plans, training
  'strategic plan*', 'planning services', 'evaluation', 'curriculum', 'tutoring', 'course development',
  'certification training', 'training services', 'training', 'conference', 'venue', 'environmental planning',
  'surveying', 'survey',
  // goods that are not built
  'furniture', 'uniform*', 'apparel', 'clothing', 'office supplies', 'medical supplies', 'food products',
  'groceries', 'produce', 'meat', 'turkey', 'chicken', 'deli', 'salads', 'dairy', 'bread', 'milk',
  'bottled water', 'bucket truck', 'dump truck*', 'pickup truck*', 'tires', 'gasoline',
  'diesel fuel', 'fuel pellets', 'ammunition', 'munitions', 'firearm*', 'copier*', 'computers', 'laptops',
  'keyboards', 'workstation*', 'microscope', 'textbook*', 'tickets', 'body cams', 'horse testing', 'canned', 'tuna',
  // not a purchase a contractor makes
  'grant program', 'grant', 'unit lease', 'wanted to lease', 'auctioneer', 'flour', 'stock trailer',
  // more goods and services seen kept as "unclear" on the live boards of 2026-11-14 (test/relevance.test.ts)
  'vegetables', 'pork', 'bacon', 'pasta', 'sugar', 'catfish', 'frozen fish', 'juice', 'mayonnaise', 'tomato paste',
  'rifle*', 'glock*', 'dental', 'endodontic', 'psychiatr*', 'breastfeeding', 'debt collection',
  'third party administrator', 'third-party administrator', 'salesforce', 'opioid', 'investment advisory',
  "workers' comp*", 'workers comp*',
  'ambulance', 'transportation services', 'special education transportation', 'school transportation',
  'bus service*', 'charter bus',
]);

/** Construction and work words with no trade of their own: weaker than a trade word, so they come after NON_TRADE. */
const CONSTRUCTION = compileKeywords([
  'construction', 'construct', 'renovation*', 'remodel*', 'rehabilitation', 'refurbish*', 'demolition', 'design build',
  'design-build', 'design/build', 'retrofit*', 'tenant improvement*', 'repairs', 'repair', 'replacement*', 'replace',
  'installation', 'install', 'improvement project', 'improvements', 'structure*', 'building', 'facility repair*',
  'maintenance and repair', 'trade contractor*', 'contracting services', 'upgrade*', 'restoration',
  'resurfacing', 'conversion', 'drilling', 'maintenance', 'cupccaa', 'minor b', 'evse', 'egress stair*', 'bid package',
  'infrastructure', 'traffic control', 'window film', 'grey water', 'gray water', 'greywater',
  // COMMBUYS rows the unclear rule would lose ("2027 Tree Work: Line Clearing and Tree Removals", "Route 3A Force Main
  // Extension Project", "IIFB 2026-27 UNITS MODERNIZATION", "Mold Remediation at the Town Hall", "PA-425 Plymouth Harbor Boat Ramp")
  'tree work', 'tree trim*', 'tree thinning', 'tree removals', 'line clearing', 'fuel reduction', 'subcontractor*',
  'specialty trades', 'soda blasting', 'modernization', 'improvement project*', 'capital improvement*', 'fit-out', 'fit out',
  'remediation', 'boat ramp', 'force main', 'storage tank*',
  // abbreviations and terse titles (BidBuy "Emergency Notice-UPS Elect Rep G1306 DuQuoin", "In Shop Overhead Crane Maint
  // Contract", "I-26-2060_PlzaImprvmnts_…", SF "PW 887 Ptrr Tnnt Imprv & Fire", OregonBuys "NW 26th & 101 RRFB",
  // "ODVA Roseburg Veterans Home CM/GC", "SCI Fire & Life Safety Corrections", "DMH IFB CMHC Closet Doors")
  'elect', 'maint', 'imprv', 'imprvmnt*', 'roadwork', 'rooftop', 'walkway*', 'door', 'doors', 'cm/gc', 'cmgc', 'geothermal',
  'rrfb', 'modification*', 'life safety', 'intersection', 'expansion joint*', 'heat exchanger*', 'condenser*',
  'scaffolding', 'main cleaning',
  // DGS Facilities Management Division contracts (Cal eProcure "25-310414.FMD.FLS", "25-293464.FMD.GreyWaterSystem")
  'fmd',
  // lifts and conveyors are building work (SF "As-Needed Airport Conveyance Maintenance", category Personal Services)
  'conveyance', 'conveyor*', 'escalator*', 'elevator*',
]);

/**
 * The title as the matchers read it: run-together words split at a case change or a dot/underscore between
 * letters ("25-316173.FMD.BASMaintenance" → "25-316173.FMD BAS Maintenance", "CR25-302477.FMD.A&ERetainer" →
 * "… A&E Retainer", "Rdwy_Bridge_Rehab" → "Rdwy Bridge Rehab"). ALL-CAPS and ordinary titles are unchanged.
 */
export function matchText(title: string): string {
  return title
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])[._]+(?=[A-Za-z])/g, '$1 ');
}

// ---------------------------------------------------------------------- decide --

export function isTradeWork(input: TradeWorkInput): TradeWorkAnswer {
  const title = matchText(input.title ?? '');
  const description = input.description ?? '';
  const category = input.category ?? '';
  const board = input.board ?? '';
  const nigp = (input.codes?.nigp ?? []).map(leadingDigits).filter(Boolean).map((d) => d.slice(0, 3));
  const unspsc = (input.codes?.unspsc ?? []).map(leadingDigits).filter(Boolean).map((d) => d.slice(0, 2));

  // 0. A board's own id says so.
  const caltrans = board === 'caleprocure' ? CALTRANS_CONTRACT.exec(input.sourceId ?? '') : null;
  if (caltrans) return { keep: true, why: `Caltrans construction contract (district ${Number(caltrans[1])})` };

  // 1. Design, advice, IT.
  const design = DESIGN_IT.test(title);
  // An audit that comes with the work it finds stays ("Energy Audit and Lighting Retrofit Installation").
  const auditWithWork = /^audit/.test(design ?? '') && STRONG_WORK.test(title);
  if (design && !auditWithWork && !(design === 'construction management' && CM_AT_RISK.test(title))) {
    return { keep: false, why: `not contractor work: ${design}` };
  }
  const it = IT.test(title);
  if (it && !BUILDS.test(title)) return { keep: false, why: `not contractor work: ${it}` };

  // 2. The board says so.
  if (TRADE_CATEGORY.test(category)) return { keep: true, why: `board category: ${category.trim()}` };
  const nigpTrade = nigp.find((c) => NIGP_TRADE_CLASSES.has(c));
  if (nigpTrade) return { keep: true, why: `NIGP class ${nigpTrade} (construction)` };
  const unspscTrade = unspsc.find((c) => UNSPSC_TRADE_SEGMENTS.has(c));
  if (unspscTrade) return { keep: true, why: `UNSPSC segment ${unspscTrade} (building and facility construction)` };

  // 3–4. Never a contractor's: a service, a sale, a purchase, a rental.
  const never = NEVER_CONTRACTOR.test(title);
  // … unless the title builds or repairs something there ("Escambia County Waste Services Transfer Station Floor
  // Rehabilitation", "Design and Construction of Power Distribution Center at the County Solid Waste Disposal Complex").
  if (never && !STRONG_WORK.test(title)) return { keep: false, why: `not contractor work: ${never}` };
  // "Replacement Parts" names parts, not a replacement.
  const work = WORK.test(title.replace(/\b(?:replacement|repair|spare)\s+parts\b/gi, 'parts'));
  const rental = RENTAL.test(title);
  if (rental && !work) return { keep: false, why: `a rental, not work: ${rental}` };
  // Illinois' "Small Purchase" is a procurement method ("DMH Small Purchase CMHC Thermal Insulation REBID").
  const goods = GOODS.test(title.replace(/\bsmall\s+purchase\b/gi, ''));
  if (goods && !work) return { keep: false, why: `a purchase, not work: ${goods}` };

  // 5–8. The words.
  const inTitle = TRADE_WORDS.test(title);
  if (inTitle) return { keep: true, why: `trade word: ${inTitle}` };
  // A training tower or centre is a building ("FIRE STATION 13 TRAINING TOWER REPAIR (CIP2303)", OpenGov).
  const not = NON_TRADE.test(title.replace(/\btraining\s+(?:tower|facilit(?:y|ies)|center|centre|grounds?)\b/gi, 'site'));
  if (not) return { keep: false, why: `not trade work: ${not}` };
  const built = CONSTRUCTION.test(title);
  if (built) return { keep: true, why: `construction word: ${built}` };
  const inDescription = TRADE_WORDS.test(description);
  if (inDescription) return { keep: true, why: `trade word in the description: ${inDescription}` };
  const builtDescription = CONSTRUCTION.test(description);
  if (builtDescription) return { keep: true, why: `construction word in the description: ${builtDescription}` };

  // 9. The board's category or codes say it is not.
  const nonTradeCategory = NON_TRADE_CATEGORY.test(category);
  if (nonTradeCategory) return { keep: false, why: `board category: ${category.trim()}` };
  const codes = [...nigp.map((c) => ({ c, bad: NIGP_NON_TRADE_CLASSES.has(c) })), ...unspsc.map((c) => ({ c, bad: UNSPSC_NON_TRADE_SEGMENTS.has(c) }))];
  if (codes.length > 0 && codes.every((x) => x.bad)) return { keep: false, why: `commodity codes: ${[...new Set(codes.map((x) => x.c))].join(', ')}` };

  // 10. Unclear: the board's policy.
  if (UNCLEAR_DROPPED.has(board)) return { keep: false, why: `unclear: dropped (${board} lists everything it buys)` };
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
