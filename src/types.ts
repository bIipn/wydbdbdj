/** Every place we pull bids from. */
export type SourceId = 'samgov' | 'nevadaepro' | 'ngem' | 'questcdn' | 'douglascounty';

export type LocationPrecision = 'exact' | 'city' | 'county' | 'region' | 'agency' | 'state' | 'unknown';

export interface BidLocation {
  city: string | null;
  county: string | null;
  state: string | null; // 2-letter
  zip: string | null;
  lat: number | null;
  lng: number | null;
  precision: LocationPrecision;
  label: string | null; // what we show on the card, e.g. "Carson City, NV"
}

/** One opportunity, normalized from any source. */
export interface Bid {
  id: string; // `${source}:${sourceId}` — stable across scans
  source: SourceId;
  sourceId: string;
  sourceName: string; // human label for the card badge
  title: string;
  agency: string | null;
  description: string | null;
  category: string | null;
  location: BidLocation;
  postedAt: string | null; // ISO-8601 (UTC)
  dueAt: string | null; // ISO-8601 (UTC)
  estValue: { min: number | null; max: number | null } | null;
  naics: string | null;
  setAside: string | null; // SAM.gov set-aside code, e.g. "SBA", "SDVOSBC"
  url: string; // where the contractor goes to bid (the source platform)
  flags: string[]; // e.g. "Bid bond", "Prevailing wage", "Mandatory pre-bid"
  solNumber?: string | null; // solicitation / bid number when the source has one
}

/** What a source hands back before location resolution fills in lat/lng. */
export type BidDraft = Omit<Bid, 'id' | 'location' | 'flags'> & {
  location?: Partial<BidLocation>;
  flags?: string[];
};

export interface FetchLike {
  text(url: string, init?: RequestInit): Promise<string>;
  json<T = unknown>(url: string, init?: RequestInit): Promise<T>;
  /**
   * Opt-in: a new cookie session for boards that page by form postback. Same pacing, timeout and
   * User-Agent; cookies from Set-Cookie are kept in memory and sent back only to the host that set
   * them, for as long as the returned object lives. Test fakes may leave it out.
   */
  session?(): FetchLike;
  /** Sessions only: the names (never the values) of the cookies held for this URL's host. */
  cookieNames?(url: string): string[];
}

export interface SourceContext {
  http: FetchLike;
  now: Date;
  env: (name: string) => string | undefined;
  log: (msg: string) => void;
}

export interface Source {
  id: SourceId;
  name: string;
  homepage: string;
  /** Return a reason string if the source can't run (e.g. missing API key). */
  disabledReason?(ctx: SourceContext): string | null;
  fetch(ctx: SourceContext): Promise<BidDraft[]>;
}

// ---------------------------------------------------------------- scoring --

export interface Profile {
  id: string;
  name: string;
  base: { label: string; lat: number; lng: number };
  states: string[];
  maxDistanceMi: number;
  valueRange: { min: number; max: number };
  minDaysToBid: number;
  /**
   * Keyword lists. A plain word/phrase matches whole words ("led" won't match "installed");
   * a trailing * matches any ending ("electric*" → electrical, electrician).
   *  strong      = core trade (electrical)
   *  related     = adjacent work that often includes electrical
   *  general     = generic construction words ("renovation", "upgrade") — weak signal
   *  otherTrades = mostly another trade's job → points off
   *  exclude     = not construction at all → hard no (unless a strong keyword is also in the title)
   */
  keywords: { strong: string[]; related: string[]; general: string[]; otherTrades: string[]; exclude: string[] };
  naics: { strong: string[]; related: string[] };
  /** SAM.gov set-aside codes this business qualifies for. Others get a penalty. */
  setAsidesEligible: string[];
  notify: { minScore: number };
  // ---- v1 (all optional, so config/<id>.json profiles stay valid) ----
  /** Trade ids from src/trades/catalog.ts, e.g. ['electrical']. */
  trades?: string[];
  /** Home ZIP the base was resolved from. */
  zip?: string;
  limits?: SpendLimits;
  costs?: CostSettings;
  alerts?: AlertSettings;
}

/** "Never chase work you can't carry." Dollars; null/absent = no limit set. */
export interface SpendLimits {
  maxJobSize?: number | null; // est. value above this = over limit
  maxUpfront?: number | null; // what they can float before the first pay app (used by the estimator)
  bondingCapacity?: number | null; // single-job bonding limit (applies when a bond is required)
}

/** The contractor's own numbers. We never invent these. */
export interface CostSettings {
  laborRate?: number | null; // $/hr they pay or charge out, before burden
  burdenPct?: number | null; // payroll burden %
  overheadPct?: number | null;
  profitPct?: number | null;
}

export interface AlertSettings {
  minScore?: number; // default: profile.notify.minScore
  push?: boolean; // wants phone push
  quietHours?: { start: string; end: string } | null; // "21:00".."06:00" in timeZone
  timeZone?: string; // IANA, default America/Los_Angeles
  kinds?: { match?: boolean; deadline?: boolean; award?: boolean; price?: boolean };
}

export type ReasonKind = 'plus' | 'minus' | 'info';
export interface Reason {
  kind: ReasonKind;
  text: string;
}

export type Verdict = 'great' | 'good' | 'maybe' | 'skip';

export interface ScoreResult {
  score: number; // 0–100
  verdict: Verdict;
  reasons: Reason[];
  distanceMi: number | null;
  rejected: string | null; // set when the bid is a hard "no" (too far, past due, not our trade)
  /** Over the profile's spend limits (job size or bonding). False when no limits are set. */
  overLimit: boolean;
}

export type SwipeAction = 'save' | 'pass' | 'bid';

/** A bid as the app sees it: the bid + how well it fits this profile. */
export interface FeedItem extends Bid {
  score: number;
  verdict: Verdict;
  reasons: Reason[];
  distanceMi: number | null;
  swipe: SwipeAction | null;
  firstSeenAt: string;
  /** Never alerted, never in the deck or "next bid"; Browse shows it with an "Over your limit" tag. */
  overLimit: boolean;
}

// --------------------------------------------------------------- accounts --

export type Plan = 'free' | 'pro' | 'pilot';

export interface Account {
  id: string;
  email: string;
  name: string | null;
  plan: Plan;
  createdAt: string; // ISO-8601 (UTC)
}

// ----------------------------------------------------------------- alerts --

export type AlertKind = 'match' | 'deadline' | 'award' | 'price';

/** One row of the in-app inbox (table `alerts`). Unique on (profileId, kind, dedupeKey). */
export interface Alert {
  id: number;
  profileId: string;
  kind: AlertKind;
  bidId: string | null;
  dedupeKey: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  createdAt: string;
  pushedAt: string | null;
  readAt: string | null;
}

// ----------------------------------------------------------------- market --

/** A real awarded contract (table `awards`). Values are stored verbatim from the source. */
export interface Award {
  id: string; // `${source}:${awardId}`
  source: string; // e.g. "usaspending"
  awardId: string | null;
  solNumber: string | null;
  recipient: string | null;
  amount: number | null;
  actionDate: string | null; // YYYY-MM-DD
  naics: string | null;
  psc: string | null;
  agency: string | null;
  description: string | null;
  city: string | null;
  county: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  url: string | null;
  fetchedAt: string;
}
