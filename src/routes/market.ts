import type { FastifyInstance, FastifyReply } from 'fastify';
import type { RouteContext } from '../context.js';
import { awardsFetchedAt, getAwardCoverage, listAwards } from '../db/market.js';
import { getBid, listProfiles } from '../db/repo.js';
import { env as processEnv } from '../env.js';
import { lookupZip as defaultLookupZip, statesWithin as defaultStatesWithin } from '../geo/zip.js';
import { isStateCode, NATION_AREA, stateInfo } from '../market/areas.js';
import {
  areaWage, BLS_DISCLAIMER, ELECTRICIANS, materialTrends, metroWagesInState, TRADE_SOC, wageForArea, type AreaWage,
} from '../market/bls.js';
import { createMarketHttp, refreshMarket, type MarketHttp } from '../market/refresh.js';
import {
  hasPriceAtAward, loadedSpan, MIN_PRICED_AWARDS, selectSimilarAwards,
  type AwardLevel, type CoverageSpan, type LadderStep, type SimilarAwards, type SimilarWhere, type ZipLookup,
} from '../market/stats.js';
import { awardWindow, NATIONWIDE, type FederalAward } from '../market/usaspending.js';
import { pacificDay, prevailingWageHint, prevailingWageTables } from '../market/prevailing.js';
import { featuresFor } from '../plans.js';
import type { Bid, Profile } from '../types.js';
import { requireAdmin } from './shared.js';

/** What the routes need from outside. Tests pass fakes; the server uses the defaults. */
export interface MarketRouteDeps {
  /** ZIP → point (+ state, and county when the table has one). Default: src/geo/zip.ts. */
  lookupZip?: (zip: string) => { lat: number; lng: number; state?: string | null; county?: string | null; city?: string | null } | null;
  /** 2-letter codes of the states a circle reaches. Default: src/geo/zip.ts. An empty list means "not known". */
  statesWithin?: (center: { lat: number; lng: number }, radiusMi: number) => string[];
  /** HTTP clients for the admin refresh. Default: polite real clients, built on first use. */
  http?: MarketHttp;
  env?: (name: string) => string | undefined;
}

export const AWARDS_SOURCE = {
  name: 'USAspending.gov',
  url: 'https://www.usaspending.gov/',
  note: 'Federal contract awards only, and only the winner\'s amount. Awards show up about 5 days after signing; Defense and Army Corps awards about 90 days.',
};
/**
 * What the dollar figure is. It is the first obligation (Mod 0), which for a contract with option
 * years is the base period only, so it is never called the contract price.
 */
export const AMOUNT_LABEL = 'Amount obligated when the award was signed (its first action). Option years and later funding are not included; orders described as a minimum guarantee are left out.';
const WAGE_NOTE = 'Published BLS wage for the area and survey period shown. It is not a prevailing wage and not a loaded rate: a public job may require prevailing wage. '
  + 'BLS also publishes metro areas; we do not match ZIP codes to them yet, so the main figure is the state\'s, or the nation\'s when we hold nothing for the state. '
  + 'BLS publishes no sample size for these figures. "employment" is its estimate of how many jobs the occupation has in the area; figures for an area with few jobs are generally less precise.';
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
  // Postgres text cannot hold a NUL byte: a lookup with one fails with a database error instead of finding nothing.
  if (v.includes('\u0000')) return bad(error, `${key} has a character that is not allowed`);
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

/** Why there is no answer for a place we could resolve: a code never pulled there, or pulls that do not reach the window. */
function notLoadedText(coverage: readonly CoverageSpan[], codes: readonly string[], state: string | null, window: { startDate: string; endDate: string }): string {
  const place = stateInfo(state)?.name ?? state ?? 'this area';
  const never = codes.filter((c) => loadedSpan(coverage, [c], state, '', NATIONWIDE) === null);
  return never.length
    ? `We have not loaded federal awards for NAICS ${never.join(', ')} in ${place} yet, so there is nothing to compare.`
    : `We have not loaded federal awards for NAICS ${codes.join(', ')} in ${place} for ${window.startDate} to ${window.endDate} yet, so there is nothing to compare.`;
}

export async function register(app: FastifyInstance, ctx: RouteContext, deps: MarketRouteDeps = {}): Promise<void> {
  const lookupZip = deps.lookupZip ?? defaultLookupZip;
  const statesWithin = deps.statesWithin ?? defaultStatesWithin;
  const env = deps.env ?? processEnv;
  const zipLookup: ZipLookup = (zip) => lookupZip(zip);
  // Read the owner-maintained tables once: a broken file stops the boot instead of reading as "none on file".
  const prevailingTables = prevailingWageTables();

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
    // What we hold for a state and ALL of these codes inside the window (null state = the nationwide pulls alone).
    const spanOf = (state: string | null): { from: string; to: string } | null => loadedSpan(coverage, codes, state, window.startDate, NATIONWIDE);

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

    // First pass: only to learn which state the place is in. No rows there can mean "none exist" or
    // "never pulled", and only the coverage table can tell the two apart.
    const placed = selectSimilarAwards(awards, where, { lookupZip: zipLookup });
    const state = placed.place.state;
    const span = spanOf(state);
    // A point with no state and no nationwide pull: we cannot tell whether its awards are loaded.
    const placedOk = placed.level !== null && (state !== null || span !== null);
    const loaded = placedOk && span !== null;
    // The window the answer covers: what was asked for, cut to what our pulls hold.
    const from = loaded && span.from > window.startDate ? span.from : window.startDate;
    const to = loaded && span.to < window.endDate ? span.to : window.endDate;
    const whole = (sp: { from: string; to: string } | null): boolean => sp !== null && sp.from <= from && sp.to >= to;
    const nationwide = loaded && whole(spanOf(null));
    const narrowed = from !== window.startDate || to !== window.endDate;
    const result = !loaded ? null : !narrowed && !nationwide ? placed : selectSimilarAwards(
      narrowed ? awards.filter((a) => a.actionDate !== null && a.actionDate >= from && a.actionDate <= to) : awards,
      { ...where, state }, { lookupZip: zipLookup, nationwide },
    );

    const stateName = (code: string | null): string => stateInfo(code)?.name ?? code ?? 'this area';
    let notes = '';
    let missingStates: string[] = [];
    let partialStates: string[] = [];
    if (result) {
      if (from !== window.startDate) notes += ` Our federal award records for ${stateName(state)} start ${from}.`;
      // A circle can reach into states we never pulled: their awards are not in the count, so name them.
      if (result.level === 'zip_radius' && !nationwide) {
        const point = where.center ?? (where.zip ? lookupZip(where.zip) : null);
        const reached = point ? [...new Set(statesWithin({ lat: point.lat, lng: point.lng }, radiusMi).map((c) => c.toUpperCase()))].filter(isStateCode).sort() : [];
        missingStates = reached.filter((c) => spanOf(c) === null);
        partialStates = reached.filter((c) => spanOf(c) !== null && !whole(spanOf(c)));
        if (missingStates.length) notes += ` Awards in ${missingStates.map(stateName).join(', ')} are not loaded, so they are left out.`;
        if (partialStates.length) notes += ` Awards in ${partialStates.map(stateName).join(', ')} are loaded for only part of this period.`;
      }
    }

    const label = result?.level ? levelLabel(result.level, result, center) : null;
    const range = result?.dateRange ? `, ${result.dateRange.from} to ${result.dateRange.to}` : '';
    const summary = !placedOk
      ? 'We could not place this location, so there are no federal awards to compare.'
      : !result
        ? notLoadedText(coverage, codes, state, window)
        : result.enough
          ? `Based on ${result.priced} federal awards ${label}${range}. ${AMOUNT_LABEL}${notes}`
          : `${result.priced} federal award${result.priced === 1 ? '' : 's'} with an amount obligated at signing ${label}${range}: not enough to show a range (we need ${result.minCount}).${notes}`;

    const scope = {
      level: result?.level ?? null,
      label,
      naics: codes,
      months: monthsBack,
      // What the count covers: starts and ends where our pulls do when that is inside what was asked for.
      window: { from, to },
      radiusMi: result?.level === 'zip_radius' ? radiusMi : null,
      coverage: {
        // States where EVERY one of these NAICS codes is loaded from the start of the window above.
        states: [...new Set(coverage.map((c) => c.scope))].filter((c) => c !== NATIONWIDE && (spanOf(c)?.from ?? '9999') <= from).sort(),
        nationwide,
        // Radius answers: states the circle reaches whose awards are not in the count, or only for part of
        // the window. Both empty when there are none, or when we could not tell which states it reaches.
        missingStates,
        partialStates,
      },
    };
    // notLoaded: we never pulled this place, code or period. That is not "zero awards", so there is no count.
    const common = {
      notLoaded: placedOk && !loaded, scope, dateRange: result?.dateRange ?? null, source: AWARDS_SOURCE, asOf: await awardsFetchedAt(ctx.db), summary,
    };
    const count = result ? result.priced : null;

    // Without award history the plan sees how many there are, nothing about what they went for.
    if (!featuresFor(id.plan).awardHistory) return { locked: true, stats: { count }, ...common };

    const s = result?.stats ?? null;
    // Not placed at all: the ladder still says why each level was skipped. Not loaded: no ladder, it would read as counts.
    const ladder = result?.ladder ?? (placed.level === null ? placed.ladder : []);
    return {
      locked: false,
      stats: { count, min: s?.min ?? null, p25: s?.p25 ?? null, median: s?.median ?? null, p75: s?.p75 ?? null, max: s?.max ?? null },
      enough: result?.enough ?? false,
      minCount: result?.minCount ?? MIN_PRICED_AWARDS,
      amountBasis: placed.amountBasis,
      amountLabel: AMOUNT_LABEL,
      excludedNoPrice: result?.excludedNoPrice ?? 0,
      ladder: ladder.map((step) => ({ ...step, skipped: step.skipped ? SKIP_TEXT[step.skipped] : undefined })),
      // inStats false: shown in the list but not in the range (no amount at signing, or a minimum-guarantee order).
      recent: (result?.awards ?? []).slice(0, RECENT_LIMIT).map((a) => ({ ...a, inStats: hasPriceAtAward(a) })),
      ...common,
    };
  });

  // ------------------------------------------------------- prevailing --
  // What to tell a contractor about prevailing wage on one bid (cautious copy, see src/market/prevailing.ts).
  // On every plan: it is a rule of the job, not price history.
  app.get('/api/market/prevailing', async (req, reply) => {
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    const bidId = single(req.query as Query, 'bidId', 'invalid_bid_id');
    if (!bidId.ok) return fail(reply, bidId);
    if (!bidId.value) return fail(reply, { error: 'bid_id_required', message: 'Give a bidId.' });
    if (bidId.value.length > 200) return fail(reply, { error: 'invalid_bid_id', message: 'bidId is too long' });
    const bid = await getBid(ctx.db, bidId.value);
    if (!bid) return fail(reply, { error: 'bid_not_found', message: 'No such bid.' }, 404);
    return { bidId: bid.id, ...prevailingWageHint(bid, prevailingTables, pacificDay(ctx.now())) };
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
