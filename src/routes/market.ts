import type { FastifyInstance, FastifyReply } from 'fastify';
import type { RouteContext } from '../context.js';
import { awardsFetchedAt, getAwardCoverage, listAwards } from '../db/market.js';
import { getBid, listProfiles } from '../db/repo.js';
import { env as processEnv } from '../env.js';
import { lookupZip as defaultLookupZip } from '../geo/zip.js';
import { isStateCode, NATION_AREA, stateInfo } from '../market/areas.js';
import {
  areaWage, BLS_DISCLAIMER, ELECTRICIANS, materialTrends, metroWagesInState, TRADE_SOC, wageForArea, type AreaWage,
} from '../market/bls.js';
import { createMarketHttp, refreshMarket, type MarketHttp } from '../market/refresh.js';
import { selectSimilarAwards, type AwardLevel, type LadderStep, type SimilarAwards, type SimilarWhere, type ZipLookup } from '../market/stats.js';
import { awardWindow, NATIONWIDE, type FederalAward } from '../market/usaspending.js';
import { featuresFor } from '../plans.js';
import type { Bid, Profile } from '../types.js';
import { requireAdmin } from './shared.js';

/** What the routes need from outside. Tests pass fakes; the server uses the defaults. */
export interface MarketRouteDeps {
  /** ZIP → point (+ state, and county when the table has one). Default: src/geo/zip.ts. */
  lookupZip?: (zip: string) => { lat: number; lng: number; state?: string | null; county?: string | null; city?: string | null } | null;
  /** HTTP clients for the admin refresh. Default: polite real clients, built on first use. */
  http?: MarketHttp;
  env?: (name: string) => string | undefined;
}

export const AWARDS_SOURCE = {
  name: 'USAspending.gov',
  url: 'https://www.usaspending.gov/',
  note: 'Federal contract awards only, and only the winner\'s amount. Awards show up about 5 days after signing; Defense and Army Corps awards about 90 days.',
};
export const AMOUNT_LABEL = 'Price at award: the first signed amount, before any modification.';
const WAGE_NOTE = 'Published BLS wage for the area and survey period shown. It is not a prevailing wage and not a loaded rate: a public job may require prevailing wage. '
  + 'BLS also publishes metro areas; we do not match ZIP codes to them yet, so the main figure is the state\'s, or the nation\'s when we hold nothing for the state.';
const MATERIAL_NOTE = 'National price indexes, not dollar prices. Updated monthly; the newest months are preliminary and get revised.';
const RECENT_LIMIT = 10;

type Query = Record<string, unknown>;
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; message: string };
const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = (error: string, message: string): Parsed<never> => ({ ok: false, error, message });

/** A query value that was given at most once, trimmed. "" and absent are both undefined. */
function single(q: Query, key: string, error: string): Parsed<string | undefined> {
  const v = q[key];
  if (v === undefined) return ok(undefined);
  if (typeof v !== 'string') return bad(error, `${key} must be given once`);
  return ok(v.trim() === '' ? undefined : v.trim());
}

function zipParam(q: Query): Parsed<string | undefined> {
  const v = single(q, 'zip', 'invalid_zip');
  if (!v.ok || v.value === undefined) return v;
  return /^\d{5}$/.test(v.value) ? v : bad('invalid_zip', 'zip must be a 5-digit ZIP code');
}

function intParam(q: Query, key: string, error: string, min: number, max: number): Parsed<number | undefined> {
  const v = single(q, key, error);
  if (!v.ok || v.value === undefined) return v as Parsed<undefined>;
  const n = Number(v.value);
  if (!/^\d+$/.test(v.value) || !Number.isInteger(n) || n < min || n > max) {
    return bad(error, `${key} must be a whole number from ${min} to ${max}`);
  }
  return ok(n);
}

function naicsParam(q: Query): Parsed<string[] | undefined> {
  const v = single(q, 'naics', 'invalid_naics');
  if (!v.ok || v.value === undefined) return v as Parsed<undefined>;
  const codes = [...new Set(v.value.split(',').map((s) => s.trim()).filter(Boolean))];
  if (codes.length === 0 || codes.length > 10 || !codes.every((c) => /^\d{6}$/.test(c))) {
    return bad('invalid_naics', 'naics must be one to ten 6-digit NAICS codes separated by commas');
  }
  return ok(codes);
}

const fail = (reply: FastifyReply, p: { error: string; message: string }, status = 400): FastifyReply =>
  reply.code(status).send({ error: p.error, message: p.message });

/** The profile's home state: the "…, NV" at the end of its base label, else the first state it works in. */
function homeState(profile: Profile): string | null {
  const fromLabel = /,\s*([A-Za-z]{2})$/.exec(profile.base.label)?.[1]?.toUpperCase();
  if (fromLabel && isStateCode(fromLabel)) return fromLabel;
  return profile.states.map((s) => s.toUpperCase()).find(isStateCode) ?? null;
}

/** The occupation whose wage a profile sees: from its trades, else electricians when it bids electrical NAICS. */
function socFor(profile: Profile): string | null {
  for (const trade of profile.trades ?? []) if (TRADE_SOC[trade]) return TRADE_SOC[trade];
  return profile.naics.strong.includes('238210') ? ELECTRICIANS : null;
}

const day = (isoTime: string): string => isoTime.slice(0, 10);

function levelLabel(level: AwardLevel, r: SimilarAwards<FederalAward>, center: string): string {
  const state = r.place.state;
  if (level === 'zip_radius') return `within ${r.place.radiusMi} mi of ${center}`;
  if (level === 'county') {
    const county = r.awards.find((a) => a.county)?.county ?? r.place.county ?? '';
    return `in ${titleCase(county)}, ${state} (county)`;
  }
  if (level === 'state') return `in ${stateInfo(state)?.name ?? state}`;
  return 'in the United States';
}

const titleCase = (s: string): string => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

const SKIP_TEXT: Record<NonNullable<LadderStep['skipped']>, string> = {
  no_location: 'no location to measure from',
  no_county: 'county not known',
  no_state: 'state not known',
  not_loaded: 'nationwide awards are not loaded',
};

export async function register(app: FastifyInstance, ctx: RouteContext, deps: MarketRouteDeps = {}): Promise<void> {
  const lookupZip = deps.lookupZip ?? defaultLookupZip;
  const env = deps.env ?? processEnv;
  const zipLookup: ZipLookup = (zip) => lookupZip(zip);

  // ------------------------------------------------------------ area --
  // Wages for the area (with the level and survey period used) and national material price trends.
  app.get('/api/market/area', async (req, reply) => {
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    const zip = zipParam(req.query as Query);
    if (!zip.ok) return fail(reply, zip);

    let area: { zip: string | null; city: string | null; state: string; stateName: string; label: string };
    const askedZip = zip.value ?? id.profile.zip ?? null;
    const place = askedZip && /^\d{5}$/.test(askedZip) ? lookupZip(askedZip) : null;
    const placeState = stateInfo(place?.state);
    if (zip.value && !placeState) return fail(reply, { error: 'zip_not_found', message: 'We do not know that ZIP code.' }, 404);
    if (place && placeState) {
      area = { zip: askedZip, city: place.city ?? null, state: placeState.code, stateName: placeState.name, label: `${place.city ? `${place.city}, ` : ''}${placeState.code} ${askedZip}` };
    } else {
      const home = stateInfo(homeState(id.profile));
      if (!home) return fail(reply, { error: 'zip_required', message: 'Give a 5-digit ZIP code: this profile has no home ZIP or state.' });
      area = { zip: null, city: null, state: home.code, stateName: home.name, label: id.profile.base.label };
    }

    const missing: string[] = [];
    const wages: Array<AreaWage & { primary: boolean }> = [];
    const soc = socFor(id.profile);
    if (!soc) {
      missing.push('We have no wage series for this trade yet.');
    } else {
      const primary = await areaWage(ctx.db, { state: area.state }, soc);
      if (!primary) {
        missing.push('No wage data has been loaded yet.');
      } else {
        // The main figure (state, else nation), then the metro areas BLS publishes inside the state, then the nation to compare.
        const { tried: _levelsTried, ...wage } = primary;
        wages.push({ ...wage, primary: true });
        if (primary.level !== 'state') missing.push(`No ${area.stateName} wage is stored, so this is the national figure.`);
        for (const w of await metroWagesInState(ctx.db, area.state, soc)) wages.push({ ...w, primary: false });
        if (primary.level !== 'nation') {
          const nation = await wageForArea(ctx.db, NATION_AREA, soc);
          if (nation) wages.push({ ...nation, primary: false });
        }
      }
    }

    const materials = await materialTrends(ctx.db);
    if (materials.length === 0) missing.push('No material price indexes have been loaded yet.');
    const accessed = [...wages.map((w) => w.fetchedAt), ...materials.flatMap((m) => m.fetchedAt ?? [])].sort().at(-1) ?? null;

    return {
      area,
      wages,
      materials,
      notes: { wages: WAGE_NOTE, materials: MATERIAL_NOTE },
      missing,
      disclaimer: accessed ? `${BLS_DISCLAIMER} Data retrieved from BLS.gov on ${day(accessed)}.` : BLS_DISCLAIMER,
      accessed: accessed ? day(accessed) : null,
    };
  });

  // ---------------------------------------------------------- awards --
  // What similar federal jobs were awarded for: ?bidId=  or  ?naics=&zip=&radiusMi=&months=
  app.get('/api/market/awards', async (req, reply) => {
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    const q = req.query as Query;
    const bidId = single(q, 'bidId', 'invalid_bid_id');
    if (!bidId.ok) return fail(reply, bidId);
    if (bidId.value && bidId.value.length > 200) return fail(reply, { error: 'invalid_bid_id', message: 'bidId is too long' });
    const zip = zipParam(q);
    if (!zip.ok) return fail(reply, zip);
    const naics = naicsParam(q);
    if (!naics.ok) return fail(reply, naics);
    const radius = intParam(q, 'radiusMi', 'invalid_radius', 1, 500);
    if (!radius.ok) return fail(reply, radius);
    const months = intParam(q, 'months', 'invalid_months', 1, 120);
    if (!months.ok) return fail(reply, months);

    let bid: Bid | null = null;
    if (bidId.value) {
      bid = await getBid(ctx.db, bidId.value);
      if (!bid) return fail(reply, { error: 'bid_not_found', message: 'No such bid.' }, 404);
    }

    const profile = id.profile;
    const bidNaics = bid?.naics && /^\d{6}$/.test(bid.naics) ? [bid.naics] : null;
    const codes = naics.value ?? bidNaics ?? profile.naics.strong.filter((c) => /^\d{6}$/.test(c));
    if (codes.length === 0) return fail(reply, { error: 'naics_required', message: 'Give at least one 6-digit NAICS code.' });
    const monthsBack = months.value ?? 24;
    const radiusMi = radius.value ?? Math.min(500, Math.max(1, Math.round(profile.maxDistanceMi)));
    const window = awardWindow(ctx.now(), monthsBack);

    const awards = await listAwards(ctx.db, { naics: codes, since: window.startDate });
    const coverage = await getAwardCoverage(ctx.db);
    const nationwide = codes.every((c) => coverage.some((cov) => cov.scope === NATIONWIDE && cov.naics === c && cov.fromDate <= window.startDate));

    // Where the job is: the bid's own place, else the ZIP asked for, else the profile's base.
    let where: SimilarWhere;
    let center: string;
    if (bid) {
      const { lat, lng, precision, zip: bidZip, county, state, label } = bid.location;
      const pinned = lat !== null && lng !== null && (precision === 'exact' || precision === 'city' || precision === 'county');
      where = { center: pinned ? { lat, lng } : null, zip: bidZip, county, state, radiusMi };
      center = label ?? bidZip ?? 'the bid';
    } else if (zip.value) {
      if (!lookupZip(zip.value) && !awards.some((a) => a.zip === zip.value)) {
        return fail(reply, { error: 'zip_not_found', message: 'We do not know that ZIP code.' }, 404);
      }
      where = { zip: zip.value, radiusMi };
      center = `ZIP ${zip.value}`;
    } else {
      where = { center: { lat: profile.base.lat, lng: profile.base.lng }, zip: profile.zip ?? null, state: homeState(profile), radiusMi };
      center = profile.base.label;
    }

    const result = selectSimilarAwards(awards, where, { lookupZip: zipLookup, nationwide });
    const label = result.level ? levelLabel(result.level, result, center) : null;
    const range = result.dateRange ? `, ${result.dateRange.from} to ${result.dateRange.to}` : '';
    const summary = !result.level
      ? 'We could not place this location, so there are no federal awards to compare.'
      : result.enough
        ? `Based on ${result.priced} federal awards ${label}${range}. ${AMOUNT_LABEL}`
        : `${result.priced} federal award${result.priced === 1 ? '' : 's'} with a price at award ${label}${range}: not enough to show a range (we need ${result.minCount}).`;

    const scope = {
      level: result.level,
      label,
      naics: codes,
      months: monthsBack,
      window: { from: window.startDate, to: window.endDate },
      radiusMi: result.level === 'zip_radius' ? radiusMi : null,
      // Which states' awards are loaded for these NAICS codes: a radius that crosses into a state not listed undercounts.
      coverage: {
        states: [...new Set(coverage.filter((c) => c.scope !== NATIONWIDE && codes.includes(c.naics)).map((c) => c.scope))].sort(),
        nationwide,
      },
    };
    const common = { scope, dateRange: result.dateRange, source: AWARDS_SOURCE, asOf: await awardsFetchedAt(ctx.db), summary };

    // Without award history the plan sees how many there are, nothing about what they went for.
    if (!featuresFor(id.plan).awardHistory) return { locked: true, stats: { count: result.priced }, ...common };

    const s = result.stats;
    return {
      locked: false,
      stats: { count: result.priced, min: s?.min ?? null, p25: s?.p25 ?? null, median: s?.median ?? null, p75: s?.p75 ?? null, max: s?.max ?? null },
      enough: result.enough,
      minCount: result.minCount,
      amountBasis: result.amountBasis,
      amountLabel: AMOUNT_LABEL,
      excludedNoPrice: result.excludedNoPrice,
      ladder: result.ladder.map((step) => ({ ...step, skipped: step.skipped ? SKIP_TEXT[step.skipped] : undefined })),
      recent: result.awards.slice(0, RECENT_LIMIT),
      ...common,
    };
  });

  // ----------------------------------------------------------- admin --
  // Pull fresh market data now. Body (all optional): { states, months, naics, awards, bls, details }.
  let running = false;
  let http = deps.http;
  app.post('/api/admin/market/refresh', async (req, reply) => {
    if (!requireAdmin(ctx, req, reply)) return reply;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) return fail(reply, { error: 'invalid_body', message: 'Send a JSON object.' });

    const wantAwards = body.awards === undefined ? true : body.awards;
    const wantBls = body.bls === undefined ? true : body.bls;
    if (typeof wantAwards !== 'boolean' || typeof wantBls !== 'boolean') return fail(reply, { error: 'invalid_body', message: 'awards and bls must be true or false.' });
    if (!wantAwards && !wantBls) return fail(reply, { error: 'invalid_body', message: 'Nothing to refresh: awards and bls are both false.' });

    let states: string[] | undefined;
    if (body.states !== undefined) {
      const list = Array.isArray(body.states) ? body.states.map((s) => (typeof s === 'string' ? s.trim().toUpperCase() : '')) : null;
      if (!list || list.length === 0 || list.length > 60 || !list.every((s) => s === NATIONWIDE || isStateCode(s))) {
        return fail(reply, { error: 'invalid_states', message: `states must be a list of 2-letter state codes (or "${NATIONWIDE}" for nationwide).` });
      }
      states = [...new Set(list)];
    }
    let naics: string[] | undefined;
    if (body.naics !== undefined) {
      if (!Array.isArray(body.naics) || body.naics.length === 0 || body.naics.length > 10 || !body.naics.every((c) => typeof c === 'string' && /^\d{6}$/.test(c))) {
        return fail(reply, { error: 'invalid_naics', message: 'naics must be a list of one to ten 6-digit NAICS codes.' });
      }
      naics = body.naics as string[];
    }
    const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
    if (body.months !== undefined && !whole(body.months, 1, 120)) return fail(reply, { error: 'invalid_months', message: 'months must be a whole number from 1 to 120.' });
    if (body.details !== undefined && !whole(body.details, 0, 200)) return fail(reply, { error: 'invalid_details', message: 'details must be a whole number from 0 to 200.' });

    if (!states) {
      // Default: every state a stored or configured profile works in.
      const profiles = [(await ctx.identify(req)).profile, ...(await listProfiles(ctx.db))].flatMap((p) => p ?? []);
      states = [...new Set(profiles.flatMap((p) => p.states.map((s) => s.toUpperCase())).filter(isStateCode))];
      if (wantAwards && states.length === 0) return fail(reply, { error: 'states_required', message: 'No profile has a state yet: send states, e.g. ["NV","CA"].' });
    }

    if (running) return fail(reply, { error: 'refresh_running', message: 'A market refresh is already running.' }, 409);
    running = true;
    try {
      const contact = env('CONTACT_EMAIL');
      http ??= createMarketHttp(`BidSwipe/1.0 (market data refresh${contact ? `; contact ${contact}` : ''})`);
      const maxQueries = Number(env('BLS_MAX_QUERIES'));
      return await refreshMarket(ctx.db, http, {
        states, naics, months: body.months as number | undefined, details: body.details as number | undefined,
        awards: wantAwards, bls: wantBls, blsApiKey: env('BLS_API_KEY'),
        blsMaxQueries: Number.isInteger(maxQueries) && maxQueries > 0 ? maxQueries : undefined,
        now: ctx.now(), log: ctx.log,
      });
    } finally {
      running = false;
    }
  });
}
