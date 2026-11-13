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
}
