/** SQL for saved estimates (table in schema.ts). Owner: the estimate builder. */
import type { Db } from './db.js';

export interface SavedEstimate {
  id: string;
  profileId: string;
  bidId: string | null;
  inputs: unknown;
  result: unknown;
  createdAt: string; // ISO-8601 UTC
}

interface Row {
  id: string;
  profile_id: string;
  bid_id: string | null;
  inputs: unknown;
  result: unknown;
  created_at: Date | string;
}

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();
const parse = (v: unknown) => (typeof v === 'string' ? (JSON.parse(v) as unknown) : v);
const toSaved = (r: Row): SavedEstimate => ({
  id: String(r.id), profileId: r.profile_id, bidId: r.bid_id, inputs: parse(r.inputs), result: parse(r.result), createdAt: iso(r.created_at),
});

/** Save one estimate (the request as sent and the engine's result). */
export async function saveEstimate(db: Db, e: { profileId: string; bidId: string | null; inputs: unknown; result: unknown }, now = new Date()): Promise<SavedEstimate> {
  const rows = await db.query<Row>(
    `insert into estimates (profile_id, bid_id, inputs, result, created_at) values ($1, $2, $3::jsonb, $4::jsonb, $5)
     returning id::text as id, profile_id, bid_id, inputs, result, created_at`,
    [e.profileId, e.bidId, JSON.stringify(e.inputs), JSON.stringify(e.result), now.toISOString()],
  );
  return toSaved(rows[0]!);
}

/** A profile's saved estimates, newest first; only those for one bid when bidId is given. */
export async function listEstimates(db: Db, profileId: string, opts: { bidId?: string; limit?: number } = {}): Promise<SavedEstimate[]> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 200);
  const rows = opts.bidId === undefined
    ? await db.query<Row>(
        'select id::text as id, profile_id, bid_id, inputs, result, created_at from estimates where profile_id = $1 order by created_at desc, id desc limit $2',
        [profileId, limit],
      )
    : await db.query<Row>(
        'select id::text as id, profile_id, bid_id, inputs, result, created_at from estimates where profile_id = $1 and bid_id = $2 order by created_at desc, id desc limit $3',
        [profileId, opts.bidId, limit],
      );
  return rows.map(toSaved);
}
