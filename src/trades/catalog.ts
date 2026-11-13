import type { Profile } from '../types.js';

/**
 * Trade templates: pick your trade(s) at sign-up and get the keywords + NAICS codes the scorer needs,
 * so nobody has to write a config file. buildProfile() (src/profile/build.ts) calls mergeTrades().
 *
 * Keyword rules (same format as config/<id>.json; a trailing * matches any ending):
 *  - strong  = words that put a job squarely in the trade. A strong word in the title beats the exclude
 *              list, so anything ambiguous ("camera", "paint", "mechanical", "gate") goes in related.
 *  - related = adjacent work that often carries some of the trade's scope.
 * The electrical lists are the pilot's (config/lm-electric.json), word for word and in the same order.
 */
export interface Trade {
  id: string; // lowercase slug, stored in Profile.trades
  label: string; // shown in the picker
  blurb: string; // one line under the label
  /** strong = this trade's own code(s); related = broader codes its work is also filed under. */
  naics: { strong: string[]; related: string[] };
  /** The lists a company with only this trade is scored with (= mergeTrades([id]).keywords). */
  keywords: Profile['keywords'];
}

/** What a trade brings to the mix; the other three keyword lists are worked out in mergeTrades(). */
interface TradeSpec extends Omit<Trade, 'keywords'> {
  strong: string[];
  related: string[];
}

/**
 * Official 2022 NAICS titles (U.S. Census Bureau, 2022 NAICS Manual) for every code used below.
 * Fence installation and driveway / parking-lot paving have no code of their own: they sit in 238990.
 * Fire sprinkler installation is part of 238220; fire and security alarm installation is 238210.
 */
export const NAICS_TITLES: Readonly<Record<string, string>> = {
  '236118': 'Residential Remodelers',
  '236210': 'Industrial Building Construction',
  '236220': 'Commercial and Institutional Building Construction',
  '237110': 'Water and Sewer Line and Related Structures Construction',
  '237130': 'Power and Communication Line and Related Structures Construction',
  '237310': 'Highway, Street, and Bridge Construction',
  '237990': 'Other Heavy and Civil Engineering Construction',
  '238110': 'Poured Concrete Foundation and Structure Contractors',
  '238140': 'Masonry Contractors',
  '238160': 'Roofing Contractors',
  '238210': 'Electrical Contractors and Other Wiring Installation Contractors',
  '238220': 'Plumbing, Heating, and Air-Conditioning Contractors',
  '238310': 'Drywall and Insulation Contractors',
  '238320': 'Painting and Wall Covering Contractors',
  '238330': 'Flooring Contractors',
  '238340': 'Tile and Terrazzo Contractors',
  '238910': 'Site Preparation Contractors',
  '238990': 'All Other Specialty Trade Contractors',
  '561621': 'Security Systems Services (except Locksmiths)',
  '561730': 'Landscaping Services',
};

const SPECS: TradeSpec[] = [
  {
    id: 'electrical',
    label: 'Electrical',
    blurb: 'Power, lighting, fire alarm, low voltage, controls',
    naics: { strong: ['238210'], related: ['238220', '236220', '236210', '237130', '238990', '561621'] },
    strong: [
      'electric*', 'lighting', 'light fixture*', 'led', 'led conversion', 'wiring', 'rewir*', 'switchgear',
      'switchboard*', 'panelboard*', 'electrical panel*', 'transformer*', 'generator*', 'standby power',
      'ev charg*', 'charging station*', 'fire alarm*', 'low voltage', 'plc', 'scada', 'motor control*', 'conduit',
      'service upgrade', 'power distribution', 'solar', 'photovoltaic', 'street light*', 'traffic signal*',
      'intercom*', 'sports lighting', 'field lighting', 'emergency power',
    ],
    related: [
      'hvac', 'controls', 'pump station*', 'lift station*', 'well repair', 'booster pump*', 'boiler*', 'chiller*',
      'elevator*', 'camera*', 'cctv', 'surveillance', 'access control', 'pa system', 'public address',
      'data cabling', 'cabling', 'fiber', 'metering', 'water heater*', 'fire protection', 'fire detection',
      'security system*', 'door operator*',
    ],
  },
  {
    id: 'plumbing',
    label: 'Plumbing',
    blurb: 'Piping, fixtures, water heaters, backflow, drains',
    naics: { strong: ['238220'], related: ['236220', '237110'] },
    strong: [
      'plumbing', 'plumber*', 'water heater*', 'backflow', 'piping', 'repipe*', 're-pipe*', 'domestic water',
      'hot water system*', 'plumbing fixture*', 'restroom fixture*', 'drinking fountain*', 'bottle fill*',
      'sewer lateral*', 'water service line*', 'drain line*', 'gas line*', 'gas piping', 'grease trap*',
      'grease interceptor*', 'sump pump*', 'water softener*',
    ],
    related: [
      'hvac', 'boiler*', 'chiller*', 'mechanical', 'hydronic', 'restroom*', 'water line*', 'water main', 'sewer',
      'septic', 'storm drain*', 'irrigation', 'pump station*', 'lift station*', 'booster pump*', 'well repair',
      'fire sprinkler*', 'fire protection',
    ],
  },
  {
    id: 'hvac',
    label: 'HVAC / mechanical',
    blurb: 'Heating, cooling, ventilation, boilers, chillers, controls',
    naics: { strong: ['238220'], related: ['236220'] },
    strong: [
      'hvac', 'air condition*', 'ventilation', 'boiler*', 'chiller*', 'cooling tower*', 'air handler*',
      'air handling', 'rooftop unit*', 'rtu', 'furnace*', 'heat pump*', 'ductwork', 'duct cleaning',
      'refrigeration', 'evaporative cooler*', 'swamp cooler*', 'exhaust fan*', 'unit heater*', 'condensing unit*',
      'split system*', 'mini split*', 'mini-split*', 'hydronic', 'building automation', 'hvac control*',
      'heating system*', 'heating and cooling', 'mechanical system*', 'mechanical upgrade*', 'mechanical equipment',
    ],
    related: [
      'heating', 'cooling', 'mechanical', 'controls', 'energy management', 'energy efficiency', 'thermostat*',
      'water heater*', 'hot water', 'plumbing', 'piping', 'kitchen hood*', 'sheet metal',
    ],
  },
  {
    id: 'fire-protection',
    label: 'Fire protection',
    blurb: 'Fire sprinklers, suppression systems, alarms, extinguishers',
    naics: { strong: ['238220'], related: ['238210', '561621', '236220'] },
    strong: [
      'fire sprinkler*', 'fire suppression', 'fire protection', 'fire alarm*', 'fire detection', 'fire pump*',
      'standpipe*', 'fire extinguisher*', 'hood suppression', 'clean agent', 'fire system*', 'life safety system*',
      'fire and life safety',
    ],
    related: [
      'sprinkler*', 'backflow', 'fire hydrant*', 'fire door*', 'fire damper*', 'smoke detector*', 'smoke control',
      'emergency lighting', 'exit sign*', 'alarm system*', 'security system*', 'kitchen hood*', 'firestop*',
      'fireproofing',
    ],
  },
  {
    id: 'low-voltage',
    label: 'Low voltage / security / data',
    blurb: 'Cameras, access control, alarms, data cabling, fiber, audio-visual',
    naics: { strong: ['238210', '561621'], related: ['237130', '236220'] },
    strong: [
      'low voltage', 'low-voltage', 'cctv', 'video surveillance', 'security camera*', 'camera system*',
      'access control', 'card reader*', 'intrusion detection', 'intrusion alarm*', 'burglar alarm*',
      'security system*', 'alarm system*', 'structured cabling', 'data cabling', 'network cabling', 'cabling',
      'fiber optic*', 'intercom*', 'paging system*', 'pa system', 'public address', 'audio visual', 'audiovisual',
      'audio/visual', 'av system*', 'sound system*', 'nurse call', 'distributed antenna', 'video wall*',
      'security electronics', 'detention electronics', 'gate operator*', 'door operator*',
    ],
    related: [
      'camera*', 'surveillance', 'fiber', 'fire alarm*', 'electric*', 'telecommunication*', 'telephone system*',
      'phone system*', 'network', 'wireless', 'wifi', 'wi-fi', 'broadband', 'scada', 'controls', 'lighting control*',
      'door hardware', 'locks', 'conduit', 'radio system*', 'data center', 'server room',
    ],
  },
  {
    id: 'general-building',
    label: 'General building',
    blurb: 'Remodels, tenant improvements, repairs, small new builds',
    naics: { strong: ['236220'], related: ['236210', '236118'] },
    strong: [
      'remodel*', 'renovation*', 'tenant improvement*', 'building addition*', 'building repair*',
      'building improvement*', 'building rehabilitation', 'buildings rehabilitation', 'building upgrade*',
      'facility improvement*', 'new building', 'new construction', 'general contractor*', 'general construction',
      'design-build', 'design build', 'cmar', 'construction manager at risk', 'job order contract*',
      'modular building*', 'carpentry', 'drywall', 'casework', 'millwork', 'building envelope', 'weatherization',
      'ada upgrade*', 'ada improvement*', 'accessibility upgrade*', 'accessibility improvement*', 'door replacement',
      'window replacement', 'doors and windows', 'storefront', 'siding',
    ],
    related: [
      'roofing', 'reroof*', 'roof replacement', 'hvac', 'electric*', 'lighting', 'plumbing', 'painting', 'flooring',
      'carpet', 'concrete', 'masonry', 'fire alarm*', 'fire sprinkler*', 'elevator*', 'restroom*', 'kitchen',
      'insulation', 'abatement', 'demolition', 'fence', 'fencing', 'sidewalk*', 'ada site', 'site improvement*',
      'canopy', 'shade structure*', 'door hardware', 'window repair*', 'glazing', 'framing',
    ],
  },
  {
    id: 'roofing',
    label: 'Roofing',
    blurb: 'Re-roofs, repairs, coatings, gutters, sheet metal',
    naics: { strong: ['238160'], related: ['236220'] },
    strong: [
      'roofing', 'reroof*', 're-roof*', 'roof replacement', 'roof repair*', 'roof coating*', 'roof restoration',
      'roof recover*', 'roof rehabilitation', 'roof membrane', 'roof system*', 'roof maintenance', 'roof leak*',
      'roof improvement*', 'roof upgrade*', 'roof renovation*', 'shingle*', 'tpo', 'epdm', 'built-up roof*',
      'metal roof*', 'standing seam', 'rain gutter*', 'downspout*', 'roof drain*',
    ],
    related: [
      'roof', 'roofs', 'waterproofing', 'weatherproofing', 'building envelope', 'sheet metal', 'skylight*',
      'siding', 'fascia', 'soffit*', 'insulation', 'canopy', 'leak repair*',
    ],
  },
  {
    id: 'painting',
    label: 'Painting',
    blurb: 'Interior and exterior painting, coatings, wall covering',
    naics: { strong: ['238320'], related: ['236220', '238310'] },
    strong: [
      'painting', 'repaint*', 're-paint*', 'painter*', 'exterior paint*', 'interior paint*', 'protective coating*',
      'wall covering*', 'wallcovering*', 'tank coating*', 'tank recoating', 'graffiti removal',
      'graffiti abatement', 'sandblast*', 'abrasive blast*',
    ],
    related: [
      'paint', 'coating*', 'recoat*', 'striping', 'pressure wash*', 'power wash*', 'drywall', 'plaster*', 'stucco',
      'caulking', 'sealant*', 'waterproofing', 'staining', 'refinish*', 'epoxy', 'lead paint', 'surface preparation',
      'facade',
    ],
  },
  {
    id: 'concrete-paving',
    label: 'Concrete / paving',
    blurb: 'Flatwork, sidewalks, curbs, asphalt, striping, sealing',
    naics: { strong: ['238110', '237310'], related: ['238990', '238140'] },
    strong: [
      'paving', 'pavement', 'repav*', 'asphalt', 'concrete', 'seal coat*', 'sealcoat*', 'slurry seal', 'chip seal',
      'cape seal', 'fog seal', 'crack seal*', 'striping', 'restriping', 'pavement marking*', 'sidewalk*', 'curb',
      'curbs', 'curb and gutter', 'flatwork', 'mill and overlay', 'asphalt overlay', 'pavement overlay',
      'microsurfacing', 'micro surfacing', 'pothole*', 'curb ramp*', 'ada ramp*', 'pedestrian ramp*', 'driveway*',
      'roadway', 'road rehabilitation', 'road improvement*', 'street rehabilitation', 'street improvement*',
    ],
    related: [
      'parking lot*', 'road', 'roads', 'street', 'streets', 'retaining wall*', 'masonry', 'drainage', 'storm drain*',
      'grading', 'excavation', 'site improvement*', 'site work', 'sitework', 'ada site', 'trail', 'pathway*',
      'bike path*', 'tennis court*', 'basketball court*', 'pickleball court*', 'bridge*',
    ],
  },
  {
    id: 'landscaping',
    label: 'Landscaping / grounds',
    blurb: 'Planting, irrigation, tree work, mowing, weed control',
    naics: { strong: ['561730'], related: ['237990'] },
    strong: [
      'landscap*', 'irrigation', 'tree trimming', 'tree removal', 'tree service*', 'tree pruning', 'tree planting',
      'tree maintenance', 'hazard tree*', 'arborist*', 'mowing', 'lawn care', 'lawn maintenance',
      'grounds maintenance', 'groundskeeping', 'turf', 'sod', 'weed control', 'weed abatement',
      'vegetation management', 'vegetation removal', 'brush removal', 'brush clearing', 'hydroseed*', 'xeriscap*',
      'planting', 'mulch*', 'revegetation', 'fuels reduction', 'defensible space', 'park maintenance',
      'median maintenance',
    ],
    related: [
      'grounds', 'park', 'parks', 'park improvement*', 'playground*', 'athletic field*', 'ball field*', 'ballfield*',
      'sports field*', 'cemetery', 'golf course', 'streetscape', 'erosion control', 'retaining wall*', 'trail',
      'snow removal', 'herbicide*', 'fence', 'fencing', 'site improvement*', 'drainage', 'grading',
    ],
  },
  {
    id: 'flooring',
    label: 'Flooring',
    blurb: 'Carpet, resilient, tile, wood and gym floors',
    naics: { strong: ['238330'], related: ['238340', '236220'] },
    strong: [
      'flooring', 'carpeting', 'carpet replacement', 'carpet installation', 'carpet tile*', 'floor covering*',
      'vinyl tile', 'lvt', 'vct', 'sheet vinyl', 'linoleum', 'resilient floor*', 'rubber floor*', 'hardwood floor*',
      'wood floor*', 'laminate floor*', 'gym floor*', 'gymnasium floor*', 'sports floor*', 'floor replacement',
      'floor refinish*', 'floor installation', 'floor coating*', 'epoxy floor*', 'tile floor*', 'floor tile*',
      'ceramic tile', 'terrazzo', 'polished concrete',
    ],
    related: [
      'carpet', 'floor', 'floors', 'tile', 'tiling', 'epoxy', 'subfloor*', 'baseboard*', 'stair tread*', 'refinish*',
      'interior renovation*', 'interior finish*', 'restroom renovation*', 'concrete polishing',
    ],
  },
  {
    id: 'sitework',
    label: 'Site work / utilities',
    blurb: 'Excavation, grading, demolition, water, sewer, storm drain',
    naics: { strong: ['238910', '237110'], related: ['237310', '237990'] },
    strong: [
      'excavat*', 'grading', 'earthwork', 'site work', 'sitework', 'site preparation', 'demolition', 'trenching',
      'sewer', 'water main', 'water line*', 'waterline*', 'storm drain*', 'drainage', 'culvert*', 'pipeline',
      'manhole*', 'underground utilit*', 'site utilit*', 'utility installation', 'septic', 'lift station*',
      'detention basin*', 'retention basin*', 'rip rap', 'riprap', 'erosion control', 'clearing and grubbing',
      'land clearing', 'hydrant*', 'cipp', 'pipe bursting', 'pipe lining', 'directional drill*', 'dredg*',
    ],
    related: [
      'paving', 'pavement', 'asphalt', 'concrete', 'sidewalk*', 'road', 'roads', 'street', 'streets', 'trail',
      'retaining wall*', 'pump station*', 'booster pump*', 'water well*', 'well drilling', 'reservoir*', 'spillway',
      'dam', 'dams', 'levee*', 'flood control', 'stream restoration', 'site improvement*', 'ada site', 'landscap*',
      'fence', 'fencing', 'debris removal', 'hauling', 'bridge*',
    ],
  },
  {
    id: 'fencing',
    label: 'Fencing',
    blurb: 'Chain link, security and ornamental fence, gates, guardrail',
    naics: { strong: [], related: ['238990'] },
    strong: [
      'fence', 'fences', 'fencing', 'chain link', 'chain-link', 'chainlink', 'guardrail*', 'guard rail*',
      'handrail*', 'railing*', 'bollard*', 'backstop*', 'ornamental iron', 'wrought iron', 'cattle guard*',
      'barbed wire', 'gate operator*', 'automatic gate*', 'slide gate*', 'swing gate*', 'vehicle gate*',
      'security gate*', 'entry gate*',
    ],
    related: [
      'gate', 'gates', 'barrier*', 'perimeter security', 'enclosure*', 'dugout*', 'ball field*', 'ballfield*',
      'playground*', 'dog park*', 'corral*', 'windscreen*', 'netting', 'welding', 'metal fabrication',
      'site improvement*', 'park improvement*',
    ],
  },
];

/** Generic construction words: a weak signal for any trade ("check the specs"). */
const GENERAL = [
  'upgrade*', 'renovation*', 'remodel*', 'improvement*', 'replacement', 'repair*', 'installation', 'modernization',
  'tenant improvement*', 'rehabilitation', 'retrofit*', 'construction',
];

/**
 * Words that put a job in someone else's trade → points off. Each is tagged with the trade it belongs to;
 * untagged words are civil work no trade here does. The first 26 are the pilot's list, in its order.
 * The rest mark the building-systems trades, so a roofer or a paver is not sent "HVAC replacement".
 */
const OTHER_TRADE_WORDS: ReadonlyArray<readonly [word: string, trade?: string]> = [
  ['roofing', 'roofing'], ['reroof*', 'roofing'], ['roof replacement', 'roofing'],
  ['paving', 'concrete-paving'], ['pavement', 'concrete-paving'], ['seal coat*', 'concrete-paving'],
  ['slurry seal', 'concrete-paving'], ['striping', 'concrete-paving'], ['asphalt', 'concrete-paving'],
  ['concrete', 'concrete-paving'],
  ['flooring', 'flooring'], ['carpet', 'flooring'],
  ['painting', 'painting'],
  ['landscap*', 'landscaping'],
  ['fence', 'fencing'], ['fencing', 'fencing'],
  ['sewer', 'sitework'], ['water main', 'sitework'], ['drainage', 'sitework'],
  ['rip rap'], ['trail'],
  ['sidewalk*', 'concrete-paving'],
  ['ada site'], ['spillway'],
  ['pipeline', 'sitework'], ['culvert', 'sitework'],
  ['electric*', 'electrical'], ['lighting', 'electrical'], ['wiring', 'electrical'], ['generator*', 'electrical'],
  ['switchgear', 'electrical'], ['transformer*', 'electrical'], ['fire alarm*', 'electrical'],
  ['street light*', 'electrical'], ['traffic signal*', 'electrical'],
  ['plumbing', 'plumbing'], ['water heater*', 'plumbing'], ['backflow', 'plumbing'],
  ['hvac', 'hvac'], ['boiler*', 'hvac'], ['chiller*', 'hvac'], ['air condition*', 'hvac'], ['cooling tower*', 'hvac'],
  ['fire sprinkler*', 'fire-protection'], ['fire suppression', 'fire-protection'],
  ['cctv', 'low-voltage'], ['access control', 'low-voltage'], ['security system*', 'low-voltage'],
  ['data cabling', 'low-voltage'], ['structured cabling', 'low-voltage'],
];

/**
 * Not construction at all → a hard "not your trade" unless a strong word is in the title.
 * Service and supply phrases only. No words for what a building is used for ("medical", "food", "training",
 * "laundry") and no prefix that swallows one ("audit*" hits "auditorium"): a chiller job at a medical center
 * is still a chiller job.
 */
const EXCLUDE = [
  // services
  'janitorial', 'custodial', 'cleaning services', 'carpet cleaning', 'window cleaning', 'laundry services',
  'linen services', 'pest control', 'security guard*', 'security officer*', 'guard service*', 'courier', 'towing',
  'catering', 'vending', 'meals', 'concessionaire*', 'translation services', 'interpreter*', 'staffing services',
  'temporary staffing', 'recruitment', 'consulting', 'consultant*', 'legal services', 'audit', 'audits', 'auditing',
  'auditor', 'auditors', 'lobbying', 'grant writing', 'insurance', 'actuarial', 'banking services', 'marketing',
  'advertising', 'printing services', 'medical services', 'dental services', 'pharmacy services',
  'veterinary services', 'ambulance services', 'counseling services', 'tutoring', 'curriculum', 'training services',
  'software', 'saas', 'website', 'internet service*', 'telephone service*', 'study', 'feasibility',
  'strategic plan*', 'master plan*', 'surveying', 'architectural services', 'engineering services',
  'design services', 'exhibit design', 'technical assistance', 'traffic control services', 'mowing', 'weed control',
  'snow removal', 'trash collection', 'waste collection', 'scale calibration',
  // goods
  'furniture', 'uniform*', 'apparel', 'clothing', 'office supplies', 'medical supplies', 'pharmaceutical*',
  'food products', 'food supplies', 'groceries', 'meat', 'dairy products', 'produce', 'bread', 'milk',
  'bottled water', 'vehicles', 'vehicle purchase*', 'vehicle lease*', 'trucks', 'dump truck*', 'pickup truck*',
  'trailers', 'utility trailer*', 'tires', 'gasoline', 'diesel fuel', 'heating oil', 'fuel delivery',
  'propane delivery', 'chemicals', 'chemical supply', 'fertilizer', 'ammunition', 'firearm*', 'copier*',
  'computers', 'laptops', 'textbook*', 'surplus', 'auction',
];

const unique = <T>(items: T[]): T[] => [...new Set(items)];

/** A company's trades merged into one set of scoring lists. */
export interface TradeMix {
  /** The chosen trade ids, de-duplicated, in catalog order (so the same picks always give the same profile). */
  trades: string[];
  keywords: Profile['keywords'];
  naics: { strong: string[]; related: string[] };
}

/**
 * Merge trades for a company that does several:
 *  - strong / related / NAICS = the union (a word or code that is strong for one trade is never just related);
 *  - otherTrades = the usual other-trade words, minus the company's own strong and related words, and minus
 *    the words of "kin" trades — trades whose own NAICS code the company lists as its own or related.
 *    (The pilot lists 238220 as related, so "plumbing" and "HVAC" are not other trades to an electrician.)
 *  - exclude = the generic list minus the company's own words (a landscaper keeps "mowing").
 * Throws on an id that is not in the catalog.
 */
export function mergeTrades(ids: readonly string[]): TradeMix {
  const unknown = ids.find((id) => !SPECS.some((s) => s.id === id));
  if (unknown !== undefined) throw new Error(`Unknown trade "${unknown}"`);
  const picked = SPECS.filter((s) => ids.includes(s.id));

  const strong = unique(picked.flatMap((s) => s.strong));
  const related = unique(picked.flatMap((s) => s.related)).filter((w) => !strong.includes(w));
  const naicsStrong = unique(picked.flatMap((s) => s.naics.strong));
  const naicsRelated = unique(picked.flatMap((s) => s.naics.related)).filter((c) => !naicsStrong.includes(c));

  const own = new Set([...strong, ...related]);
  const codes = new Set([...naicsStrong, ...naicsRelated]);
  const kin = new Set(SPECS.filter((s) => s.naics.strong.some((c) => codes.has(c))).map((s) => s.id));

  return {
    trades: picked.map((s) => s.id),
    keywords: {
      strong,
      related,
      general: [...GENERAL],
      otherTrades: OTHER_TRADE_WORDS.filter(([w, trade]) => !own.has(w) && !(trade && kin.has(trade))).map(([w]) => w),
      exclude: EXCLUDE.filter((w) => !own.has(w)),
    },
    naics: { strong: naicsStrong, related: naicsRelated },
  };
}

/** Electrical first: it is the trade the product was built and tuned on. */
export const TRADES: Trade[] = SPECS.map((s) => ({
  id: s.id,
  label: s.label,
  blurb: s.blurb,
  naics: { strong: [...s.naics.strong], related: [...s.naics.related] },
  keywords: mergeTrades([s.id]).keywords,
}));

export function getTrade(id: string): Trade | null {
  return TRADES.find((t) => t.id === id) ?? null;
}

/**
 * A trade's name inside a sentence — "electrical", "HVAC", "low voltage": its label up to the first
 * slash, starting small unless it is an acronym. The scorer's reasons use it ("Roofing scope: …").
 */
export function tradeNoun(id: string): string | null {
  const head = getTrade(id)?.label.split('/')[0]!.trim();
  if (!head) return null;
  return /^[A-Z][a-z]/.test(head) ? head[0]!.toLowerCase() + head.slice(1) : head;
}

/**
 * The profile with the catalog's current keyword and NAICS lists for its trades. A stored account
 * profile carries a copy of those lists from the day it was saved; the scan scores with this, so a
 * catalog edit reaches every account at the next scan. Profiles with no trades (config profiles, the
 * pilot) or with a trade the catalog no longer has are returned as they are.
 */
export function withCatalogLists<P extends Pick<Profile, 'trades' | 'keywords' | 'naics'>>(profile: P): P {
  const ids = profile.trades ?? [];
  if (ids.length === 0 || ids.some((id) => !getTrade(id))) return profile;
  const { keywords, naics } = mergeTrades(ids);
  return { ...profile, keywords, naics };
}
