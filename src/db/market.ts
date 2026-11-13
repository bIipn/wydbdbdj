/** SQL for awards, award_coverage, market_series and market_series_meta (tables in schema.ts). Owner: the market builder. */
import type { AwardDetail, AwardRow, FederalAward, PriceAtAward } from '../market/usaspending.js';
import type { Db } from './db.js';

const iso = (v: Date | string | null): string | null => (v == null ? null : new Date(v).toISOString());
const num = (v: string | number | null): number | null => (v == null ? null : Number(v));
const chunks = <T>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

// ----------------------------------------------------------------- awards --

const SOURCE = 'usaspending';
const awardId = (generatedInternalId: string): string => `${SOURCE}:${generatedInternalId}`;

/**
 * Insert new awards, refresh existing ones (key: generated_internal_id). Touches only what the awards
 * search knows: the price at award and the detail fields (solicitation, offers) are never overwritten here.
 */
export async function upsertAwards(db: Db, rows: readonly AwardRow[], fetchedAt: Date = new Date()): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;
  // One statement cannot update the same row twice, so a repeated award keeps its last copy.
  const unique = [...new Map(rows.map((a) => [a.generatedInternalId, a])).values()];
  for (const part of chunks(unique, 200)) {
    const payload = part.map((a) => ({
      id: awardId(a.generatedInternalId), generated_internal_id: a.generatedInternalId, award_id: a.awardId, recipient: a.recipient,
      agency: a.agency, sub_agency: a.subAgency, naics: a.naics, naics_description: a.naicsDescription, psc: a.psc,
      psc_description: a.pscDescription, description: a.description, award_type: a.awardType, city: a.city, county: a.county,
      county_fips: a.countyFips, state: a.state, zip: a.zip, action_date: a.actionDate, current_amount: a.currentAmount,
      last_modified: a.lastModified,
    }));
    const res = await db.query<{ inserted: boolean }>(
      `insert into awards (id, source, generated_internal_id, award_id, recipient, agency, sub_agency, naics, naics_description,
         psc, psc_description, description, award_type, city, county, county_fips, state, zip, action_date, current_amount,
         last_modified, fetched_at)
       select v.id, $2, v.generated_internal_id, v.award_id, v.recipient, v.agency, v.sub_agency, v.naics, v.naics_description,
         v.psc, v.psc_description, v.description, v.award_type, v.city, v.county, v.county_fips, v.state, v.zip, v.action_date,
         v.current_amount, v.last_modified, $3::timestamptz
       from jsonb_to_recordset($1::jsonb) as v(id text, generated_internal_id text, award_id text, recipient text, agency text,
         sub_agency text, naics text, naics_description text, psc text, psc_description text, description text, award_type text,
         city text, county text, county_fips text, state text, zip text, action_date date, current_amount numeric, last_modified text)
       on conflict (id) do update set
         award_id = excluded.award_id, recipient = excluded.recipient, agency = excluded.agency, sub_agency = excluded.sub_agency,
         naics = excluded.naics, naics_description = excluded.naics_description, psc = excluded.psc,
         psc_description = excluded.psc_description, description = excluded.description, award_type = excluded.award_type,
         city = excluded.city, county = excluded.county, county_fips = excluded.county_fips, state = excluded.state,
         zip = excluded.zip, action_date = excluded.action_date, current_amount = excluded.current_amount,
         last_modified = excluded.last_modified, fetched_at = excluded.fetched_at
       returning (xmax = 0) as inserted`,
      [JSON.stringify(payload), SOURCE, fetchedAt.toISOString()],
    );
    const fresh = res.filter((r) => r.inserted).length;
    inserted += fresh;
    updated += res.length - fresh;
  }
  return { inserted, updated };
}

/**
 * Record the price each award was signed at (its Mod 0 transaction). `amount` mirrors it: it is the
 * figure the app-wide Award type exposes. Returns how many stored awards were touched.
 */
export async function setPricesAtAward(db: Db, prices: ReadonlyMap<string, PriceAtAward>): Promise<number> {
  let touched = 0;
  for (const part of chunks([...prices], 500)) {
    const payload = part.map(([generatedInternalId, p]) => ({ id: awardId(generatedInternalId), amount: p.amount }));
    const res = await db.query(
      `update awards a set price_at_award = v.amount, amount = v.amount
       from jsonb_to_recordset($1::jsonb) as v(id text, amount numeric)
       where a.id = v.id
       returning a.id`,
      [JSON.stringify(payload)],
    );
    touched += res.length;
  }
  return touched;
}

/** Of these awards (generated_internal_ids), the ones stored without a price at award, newest first. */
export async function awardsWithoutPrice(db: Db, generatedInternalIds: readonly string[]): Promise<string[]> {
  if (generatedInternalIds.length === 0) return [];
  const rows = await db.query<{ generated_internal_id: string }>(
    `select generated_internal_id from awards
     where price_at_award is null and id in (select jsonb_array_elements_text($1::jsonb))
     order by action_date desc nulls last, id`,
    [JSON.stringify(generatedInternalIds.map(awardId))],
  );
  return rows.map((r) => r.generated_internal_id);
}

/**
 * Of these awards, up to `limit` that have no price at award and whose own transaction history has
 * never been asked for one. Each award is looked up once: if its history has no Mod 0 row either, asking again will not help.
 */
export async function awardsNeedingPriceLookup(db: Db, generatedInternalIds: readonly string[], limit: number): Promise<string[]> {
  if (generatedInternalIds.length === 0 || limit <= 0) return [];
  const rows = await db.query<{ generated_internal_id: string }>(
    `select generated_internal_id from awards
     where price_at_award is null and price_checked_at is null and id in (select jsonb_array_elements_text($1::jsonb))
     order by action_date desc nulls last, id
     limit $2`,
    [JSON.stringify(generatedInternalIds.map(awardId)), Math.floor(limit)],
  );
  return rows.map((r) => r.generated_internal_id);
}

/** Note that an award's own transaction history was read (whether or not it held a Mod 0 row). */
export async function markPriceChecked(db: Db, generatedInternalId: string, at: Date = new Date()): Promise<void> {
  await db.query('update awards set price_checked_at = $2::timestamptz where id = $1', [awardId(generatedInternalId), at.toISOString()]);
}

/** generated_internal_ids of the newest awards whose detail record has never been fetched. */
export async function awardsMissingDetail(db: Db, limit: number): Promise<string[]> {
  const rows = await db.query<{ generated_internal_id: string }>(
    `select generated_internal_id from awards
     where source = $1 and detail_fetched_at is null and generated_internal_id is not null
     order by action_date desc nulls last, id
     limit $2`,
    [SOURCE, Math.max(0, Math.floor(limit))],
  );
  return rows.map((r) => r.generated_internal_id);
}

/** Store what the detail endpoint said. A null solicitation id is a real answer ("none recorded"), so the row is still marked as looked up. */
export async function saveAwardDetail(db: Db, generatedInternalId: string, d: AwardDetail, fetchedAt: Date = new Date()): Promise<void> {
  await db.query(
    `update awards set sol_number = $2, offers_received = $3, date_signed = $4::date, detail_fetched_at = $5::timestamptz where id = $1`,
    [awardId(generatedInternalId), d.solicitationId, d.offersReceived, d.dateSigned, fetchedAt.toISOString()],
  );
}

interface AwardDbRow {
  id: string; source: string; generated_internal_id: string; award_id: string | null; sol_number: string | null;
  recipient: string | null; agency: string | null; sub_agency: string | null; naics: string | null;
  naics_description: string | null; psc: string | null; psc_description: string | null; description: string | null;
  award_type: string | null; city: string | null; county: string | null; county_fips: string | null; state: string | null;
  zip: string | null; lat: number | null; lng: number | null; url: string | null; action_date: string | null;
  date_signed: string | null; current_amount: string | number | null; price_at_award: string | number | null;
  last_modified: string | null; offers_received: number | null; fetched_at: Date | string; detail_fetched_at: Date | string | null;
}

// Dates leave the database as 'YYYY-MM-DD' text, so no driver turns them into a local-time Date.
const AWARD_SELECT = `
  select id, source, generated_internal_id, award_id, sol_number, recipient, agency, sub_agency, naics, naics_description,
    psc, psc_description, description, award_type, city, county, county_fips, state, zip, lat, lng, url,
    to_char(action_date, 'YYYY-MM-DD') as action_date, to_char(date_signed, 'YYYY-MM-DD') as date_signed,
    current_amount, price_at_award, last_modified, offers_received, fetched_at, detail_fetched_at
  from awards`;

function toAward(r: AwardDbRow): FederalAward {
  const priceAtAward = num(r.price_at_award);
  return {
    id: r.id, source: r.source, generatedInternalId: r.generated_internal_id, awardId: r.award_id, solNumber: r.sol_number,
    recipient: r.recipient, agency: r.agency, subAgency: r.sub_agency, naics: r.naics, naicsDescription: r.naics_description,
    psc: r.psc, pscDescription: r.psc_description, description: r.description, awardType: r.award_type,
    city: r.city, county: r.county, countyFips: r.county_fips, state: r.state, zip: r.zip,
    lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng), url: r.url,
    actionDate: r.action_date, dateSigned: r.date_signed,
    amount: priceAtAward, priceAtAward, currentAmount: num(r.current_amount),
    lastModified: r.last_modified, offersReceived: r.offers_received == null ? null : Number(r.offers_received),
    fetchedAt: iso(r.fetched_at)!, detailFetchedAt: iso(r.detail_fetched_at),
  };
}

export interface AwardFilter {
  /** Exact NAICS codes. */
  naics: readonly string[];
  /** Awards signed on or after this date (YYYY-MM-DD). */
  since: string;
  /** Awards signed on or before this date (YYYY-MM-DD). */
  until?: string;
  /** Only these states (2-letter). Absent = every state held. */
  states?: readonly string[];
}

/** Stored federal awards for these NAICS codes signed in the window, newest first. */
export async function listAwards(db: Db, f: AwardFilter): Promise<FederalAward[]> {
  const rows = await db.query<AwardDbRow>(
    `${AWARD_SELECT}
     where source = $1
       and naics in (select jsonb_array_elements_text($2::jsonb))
       and action_date >= $3::date
       and ($4::date is null or action_date <= $4::date)
       and ($5::jsonb is null or state in (select jsonb_array_elements_text($5::jsonb)))
     order by action_date desc, id`,
    [SOURCE, JSON.stringify(f.naics), f.since, f.until ?? null, f.states ? JSON.stringify(f.states) : null],
  );
  return rows.map(toAward);
}

export async function getAward(db: Db, id: string): Promise<FederalAward | null> {
  const rows = await db.query<AwardDbRow>(`${AWARD_SELECT} where id = $1`, [id]);
  return rows[0] ? toAward(rows[0]) : null;
}

/** When award data was last pulled (ISO), or null when the table is empty. */
export async function awardsFetchedAt(db: Db): Promise<string | null> {
  const rows = await db.query<{ at: Date | string | null }>('select max(fetched_at) as at from awards where source = $1', [SOURCE]);
  return iso(rows[0]?.at ?? null);
}

export interface AwardCount {
  state: string | null;
  naics: string | null;
  awards: number;
  /** Awards with a price at award above zero. */
  priced: number;
  oldest: string | null;
  newest: string | null;
}

/** How many awards are stored per state and NAICS code (what a refresh prints). */
export async function awardCounts(db: Db): Promise<AwardCount[]> {
  const rows = await db.query<{ state: string | null; naics: string | null; awards: string | number; priced: string | number; oldest: string | null; newest: string | null }>(
    `select state, naics, count(*) as awards, count(*) filter (where price_at_award > 0) as priced,
       to_char(min(action_date), 'YYYY-MM-DD') as oldest, to_char(max(action_date), 'YYYY-MM-DD') as newest
     from awards where source = $1 group by state, naics order by state, naics`,
    [SOURCE],
  );
  return rows.map((r) => ({ state: r.state, naics: r.naics, awards: Number(r.awards), priced: Number(r.priced), oldest: r.oldest, newest: r.newest }));
}

// --------------------------------------------------------------- coverage --

export interface AwardCoverage {
  /** State code, or "US" for a nationwide pull. */
  scope: string;
  naics: string;
  fromDate: string;
  toDate: string;
  refreshedAt: string;
}

/**
 * Note that a complete pull covered this place and these NAICS codes for the window.
 *
 * A row is ONE unbroken stretch of dates, so "loaded from X" never hides a hole. A pull that
 * overlaps or touches the stored stretch grows it. A pull that starts after a gap replaces it (the
 * newest stretch is the one answers are built on). A pull that ends before the stored stretch
 * starts, with a gap between, changes nothing.
 */
export async function recordAwardCoverage(db: Db, scope: string, naics: readonly string[], fromDate: string, toDate: string, at: Date = new Date()): Promise<void> {
  for (const code of naics) {
    await db.query(
      `insert into award_coverage (scope, naics, from_date, to_date, refreshed_at) values ($1, $2, $3::date, $4::date, $5::timestamptz)
       on conflict (scope, naics) do update set
         from_date = case
           when excluded.from_date > award_coverage.to_date + 1 then excluded.from_date
           when excluded.to_date < award_coverage.from_date - 1 then award_coverage.from_date
           else least(award_coverage.from_date, excluded.from_date) end,
         to_date = greatest(award_coverage.to_date, excluded.to_date),
         refreshed_at = case
           when excluded.to_date < award_coverage.from_date - 1 then award_coverage.refreshed_at
           else excluded.refreshed_at end`,
      [scope, code, fromDate, toDate, at.toISOString()],
    );
  }
}

export async function getAwardCoverage(db: Db): Promise<AwardCoverage[]> {
  const rows = await db.query<{ scope: string; naics: string; from_date: string; to_date: string; refreshed_at: Date | string }>(
    `select scope, naics, to_char(from_date, 'YYYY-MM-DD') as from_date, to_char(to_date, 'YYYY-MM-DD') as to_date, refreshed_at
     from award_coverage order by scope, naics`,
  );
  return rows.map((r) => ({ scope: r.scope, naics: r.naics, fromDate: r.from_date, toDate: r.to_date, refreshedAt: iso(r.refreshed_at)! }));
}

// ----------------------------------------------------------------- series --

export interface SeriesMeta {
  seriesId: string;
  /** "ppi" (price index) | "oews" (wage). */
  kind: string;
  title: string;
  /** Area name, e.g. "Nevada" or "United States". */
  area: string | null;
  /** "index" | "USD per hour". */
  unit: string | null;
  source: string;
  sourceUrl: string | null;
}

export interface StoredSeriesMeta extends SeriesMeta {
  /** "ok", or why the last refresh got nothing: "not_found" | "no_data". */
  status: string;
  note: string | null;
  /** When data for this series was last retrieved (ISO). */
  fetchedAt: string;
}

export interface Observation {
  /** "<year>-<BLS period>", e.g. "2026-M09" (September 2026) or "2025-A01" (annual). Sorts in time order. */
  period: string;
  /** The value as published. A string keeps every digit on the way into a numeric column. */
  value: number | string;
  /** Still subject to revision by the publisher. */
  preliminary: boolean;
}

export interface StoredObservation extends Observation {
  value: number;
}

const META_UPSERT = `
  insert into market_series_meta (series_id, kind, title, area, unit, source, source_url, fetched_at, status, note)
  values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10)`;

const metaParams = (m: SeriesMeta, at: Date, status: string, note: string | null): unknown[] =>
  [m.seriesId, m.kind, m.title, m.area, m.unit, m.source, m.sourceUrl, at.toISOString(), status, note];

/**
 * Store a series that came back with data: its description and its observations. An observation
 * that already exists is overwritten, so a preliminary value is replaced by its revision.
 */
export async function saveSeries(db: Db, meta: SeriesMeta, observations: readonly Observation[], fetchedAt: Date = new Date()): Promise<void> {
  await db.query(
    `${META_UPSERT}
     on conflict (series_id) do update set kind = excluded.kind, title = excluded.title, area = excluded.area, unit = excluded.unit,
       source = excluded.source, source_url = excluded.source_url, fetched_at = excluded.fetched_at, status = excluded.status, note = excluded.note`,
    metaParams(meta, fetchedAt, 'ok', null),
  );
  for (const part of chunks(observations, 500)) {
    await db.query(
      `insert into market_series (series_id, period, value, preliminary)
       select $1, v.period, v.value::numeric, v.preliminary from jsonb_to_recordset($2::jsonb) as v(period text, value text, preliminary boolean)
       on conflict (series_id, period) do update set value = excluded.value, preliminary = excluded.preliminary`,
      [meta.seriesId, JSON.stringify(part.map((o) => ({ period: o.period, value: String(o.value), preliminary: o.preliminary })))],
    );
  }
}

/**
 * Note that a refresh got nothing for a series ("not_found", "no_data"). Observations already
 * stored stay, and so does the date they were retrieved.
 */
export async function markSeriesFailed(db: Db, meta: SeriesMeta, status: string, note: string | null, at: Date = new Date()): Promise<void> {
  await db.query(`${META_UPSERT} on conflict (series_id) do update set status = excluded.status, note = excluded.note`, metaParams(meta, at, status, note));
}

interface MetaDbRow {
  series_id: string; kind: string; title: string; area: string | null; unit: string | null; source: string;
  source_url: string | null; status: string; note: string | null; fetched_at: Date | string;
}
const toMeta = (r: MetaDbRow): StoredSeriesMeta => ({
  seriesId: r.series_id, kind: r.kind, title: r.title, area: r.area, unit: r.unit, source: r.source, sourceUrl: r.source_url,
  status: r.status, note: r.note, fetchedAt: iso(r.fetched_at)!,
});

/** Descriptions of every stored series of a kind ("ppi" | "oews"). */
export async function listSeriesMeta(db: Db, kind: string): Promise<StoredSeriesMeta[]> {
  const rows = await db.query<MetaDbRow>('select * from market_series_meta where kind = $1 order by series_id', [kind]);
  return rows.map(toMeta);
}

export interface StoredSeries {
  meta: StoredSeriesMeta;
  /** Oldest first. */
  observations: StoredObservation[];
}

/** The stored series for these ids, keyed by series id. Ids we hold nothing for are simply absent. */
export async function getSeries(db: Db, seriesIds: readonly string[]): Promise<Map<string, StoredSeries>> {
  const out = new Map<string, StoredSeries>();
  if (seriesIds.length === 0) return out;
  const ids = JSON.stringify([...new Set(seriesIds)]);
  const metas = await db.query<MetaDbRow>('select * from market_series_meta where series_id in (select jsonb_array_elements_text($1::jsonb))', [ids]);
  for (const m of metas) out.set(m.series_id, { meta: toMeta(m), observations: [] });
  const obs = await db.query<{ series_id: string; period: string; value: string | number; preliminary: boolean }>(
    `select series_id, period, value, preliminary from market_series
     where series_id in (select jsonb_array_elements_text($1::jsonb)) order by series_id, period`,
    [ids],
  );
  for (const o of obs) out.get(o.series_id)?.observations.push({ period: o.period, value: Number(o.value), preliminary: o.preliminary });
  return out;
}

/** How many series and observations are stored, per kind (what a refresh prints). */
export async function seriesCounts(db: Db): Promise<Array<{ kind: string; series: number; withData: number; observations: number }>> {
  const rows = await db.query<{ kind: string; series: string | number; with_data: string | number; observations: string | number }>(
    `select m.kind, count(*) as series, count(*) filter (where o.n > 0) as with_data, coalesce(sum(o.n), 0) as observations
     from market_series_meta m
     left join (select series_id, count(*) as n from market_series group by series_id) o on o.series_id = m.series_id
     group by m.kind order by m.kind`,
  );
  return rows.map((r) => ({ kind: r.kind, series: Number(r.series), withData: Number(r.with_data), observations: Number(r.observations) }));
}

// ------------------------------------------------------------------ watch --
// What the price and award watcher (src/market/watcher.ts) reads before and after a refresh.

/** Every stored award: its id and the solicitation number known for it now (null = none yet). */
export async function awardSolicitations(db: Db): Promise<Map<string, string | null>> {
  const rows = await db.query<{ id: string; sol_number: string | null }>('select id, sol_number from awards where source = $1', [SOURCE]);
  return new Map(rows.map((r) => [r.id, r.sol_number]));
}

/** Stored awards by id (ids we hold nothing for are left out), newest first. */
export async function awardsByIds(db: Db, ids: readonly string[]): Promise<FederalAward[]> {
  const out: FederalAward[] = [];
  for (const part of chunks(ids, 500)) {
    const rows = await db.query<AwardDbRow>(
      `${AWARD_SELECT} where id in (select jsonb_array_elements_text($1::jsonb)) order by action_date desc nulls last, id`,
      [JSON.stringify(part)],
    );
    out.push(...rows.map(toAward));
  }
  return out;
}

/** Every stored series of these kinds with its observations (oldest first), keyed by series id. */
export async function seriesOfKinds(db: Db, kinds: readonly string[]): Promise<Map<string, StoredSeries>> {
  const metas = (await Promise.all(kinds.map((k) => listSeriesMeta(db, k)))).flat();
  return getSeries(db, metas.map((m) => m.seriesId));
}

/** When any market data was last retrieved (ISO): awards, award coverage or a series. null = never. */
export async function marketFetchedAt(db: Db): Promise<string | null> {
  const rows = await db.query<{ at: Date | string | null }>(
    `select greatest(
       (select max(fetched_at) from awards),
       (select max(refreshed_at) from award_coverage),
       (select max(fetched_at) from market_series_meta)) as at`,
  );
  return iso(rows[0]?.at ?? null);
}
