/**
 * Mutations: each one breaks ONE marketplace rule on purpose, at a real seam of the running server, to prove
 * that the check meant for that rule notices. A check that never fails proves nothing.
 *
 * The seams:
 *   the database the server is given  (a wrapper around query(): the award write, the ledger write, the feed's
 *                                      mirror close, the settlement pass)
 *   the product's own rule table      (FEE_OUTCOMES in src/jobs/rules.ts: which endings cost a fee)
 *   the bus the routes publish on     (where an alert is addressed)
 *   an onSend hook on the answer      (what one viewer is shown)
 * Each mutation's run is its own server and its own in-memory database; the rule table is put back after.
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/db.js';
import { FEE_OUTCOMES, type JobOutcome } from '../../jobs/rules.js';
import type { Bus, BusEvent } from '../../realtime/bus.js';

export type CheckId =
  | 'rules' | 'lowest-wins' | 'tie-break' | 'sealed-bids' | 'private-details' | 'endings' | 'fee-due' | 'fee-amount'
  | 'fee-split' | 'ledger-total' | 'alerts' | 'feed' | 'settle-twice' | 'repost' | 'api-answers';

export type JobsMutationId =
  | 'award-second-lowest' | 'tie-wrong-way' | 'leak-amount' | 'address-to-loser' | 'fee-on-poster-no-show'
  | 'fee-rounded-down' | 'settle-twice-two-rows' | 'alert-wrong-account' | 'closed-in-feed';

export const JOBS_MUTATIONS: Readonly<Record<JobsMutationId, { check: CheckId; how: string }>> = {
  'award-second-lowest': { check: 'lowest-wins', how: 'the award the server stores is rewritten to the second-lowest amount (database wrapper, at the closing write)' },
  'tie-wrong-way': { check: 'tie-break', how: 'on a tie the award is rewritten to the bid placed LATER (database wrapper, at the closing write)' },
  'leak-amount': { check: 'sealed-bids', how: "the poster's view of an open job gets the ranked bid amounts added (onSend hook)" },
  'address-to-loser': { check: 'private-details', how: "a losing bidder's view of the job gets the street address and phone (onSend hook)" },
  'fee-on-poster-no-show': { check: 'fee-due', how: "'poster_no_show' is added to the product's FEE_OUTCOMES, so the winner is charged when the POSTER never answered" },
  'fee-rounded-down': { check: 'fee-amount', how: 'every fee written to the ledger has its cents rounded down instead of half up (database wrapper, at the ledger write)' },
  'settle-twice-two-rows': { check: 'settle-twice', how: "the next settlement pass re-reads the jobs the last one ended as they were before (a stale read, as in a race), and the contact-deadline write's status guard and the ledger's one-row-per-job rule are dropped, so the product settles them again (database wrapper)" },
  'alert-wrong-account': { check: 'alerts', how: "the winner's \"You won\" alert is addressed to the job's poster instead (bus wrapper)" },
  'closed-in-feed': { check: 'feed', how: "the statement that takes a closed job's card out of the feed is skipped (database wrapper)" },
};

/** Everything a mutation needs to undo when its run ends. */
export interface MutationHandle {
  db: Db;
  restore(): void;
}

const has = (sql: string, s: string) => sql.includes(s);

/** Floor instead of half up: what a careless fee calculation does. */
const floorRate = (cents: number, ppm: number) => Number((BigInt(cents) * BigInt(ppm)) / 1_000_000n);

/**
 * The database the server is given. Without a mutation it is the real one, untouched.
 */
export async function mutateDb(inner: Db, mutation: JobsMutationId | undefined): Promise<MutationHandle> {
  let restore = () => {};
  if (mutation === 'fee-on-poster-no-show') {
    // The product's own decision table: which outcomes cost the winner the no-show fee.
    const table = FEE_OUTCOMES as Set<JobOutcome>;
    table.add('poster_no_show');
    restore = () => void table.delete('poster_no_show');
    return { db: inner, restore };
  }
  if (mutation === 'settle-twice-two-rows') {
    const rows = await inner.query<{ conname: string }>(
      `select conname from pg_constraint where conrelid = 'job_fees'::regclass and contype = 'u'`,
    );
    for (const r of rows) await inner.exec(`alter table job_fees drop constraint "${r.conname.replace(/"/g, '')}"`);
  }
  if (!mutation || !['award-second-lowest', 'tie-wrong-way', 'fee-rounded-down', 'settle-twice-two-rows', 'closed-in-feed'].includes(mutation)) {
    return { db: inner, restore };
  }

  // settle-twice-two-rows: the jobs the last settlement pass ended (their rows from before), and the ones the
  // current pass is replaying.
  const endedLastPass = new Map<string, Record<string, unknown>>();
  let stale = new Map<string, Record<string, unknown>>();
  const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
    // closed-in-feed: the mirror's "closes now" never runs, so the card stays in every feed.
    if (mutation === 'closed-in-feed' && has(sql, 'update bids set due_at = least(')) return [];

    // fee-rounded-down: rewrite the fee figures in the ledger insert (kind, basis, rate, amount, share ppm, share, platform).
    if (mutation === 'fee-rounded-down' && has(sql, 'insert into job_fees')) {
      const p = [...params];
      const i = p.findIndex((v, k) => (v === 'no_show' || v === 'service') && typeof p[k + 1] === 'number');
      if (i >= 0) {
        const basis = p[i + 1] as number;
        const amount = floorRate(basis, p[i + 2] as number);
        const share = floorRate(basis, p[i + 4] as number);
        p[i + 3] = amount;
        p[i + 5] = share;
        p[i + 6] = amount - share;
      }
      return inner.query<T>(sql, p);
    }

    if (mutation === 'settle-twice-two-rows') {
      // A second settler that read the job before the first one wrote (two cron calls at once can do this):
      // the next pass is handed every job the last pass ended, as it was before it ended, and the product's own
      // code settles it again. With the status guard and the ledger's one-row rule gone, nothing stops it.
      if (has(sql, "where status = 'awarded' and contact_deadline <= $1")) {
        const res = await inner.query<{ id: string }>(sql, params);
        stale = new Map(endedLastPass);
        endedLastPass.clear();
        return [...res, ...[...stale.keys()].filter((id) => !res.some((r) => r.id === id)).map((id) => ({ id }))] as T[];
      }
      if (has(sql, 'select * from jobs where id = $1 and removed_at is null') && stale.has(params[0] as string)) {
        return [stale.get(params[0] as string)] as T[];
      }
      if (has(sql, "update jobs set status = 'unfilled', outcome = $2, ended_at = contact_deadline")) {
        const id = params[0] as string;
        const before = (await inner.query<Record<string, unknown>>('select * from jobs where id = $1', [id]))[0];
        const res = await inner.query<T>(sql.replace("and status = 'awarded' ", '').replace(/on conflict \(job_id, kind\) do nothing/g, ''), params);
        if (stale.has(id)) stale.delete(id);
        else if (res.length && before) endedLastPass.set(id, before);
        return res;
      }
    }

    const res = await inner.query<T>(sql, params);

    // The award write (src/jobs/repo.ts closeJob): rewrite the stored award right after it.
    if ((mutation === 'award-second-lowest' || mutation === 'tie-wrong-way') && has(sql, 'winner_bid_id = $2::bigint') && res.length && params[1] != null) {
      const jobId = params[0] as string;
      const bids = await inner.query<{ id: string | number; bidder_id: string; amount_cents: string | number }>(
        `select id, bidder_id, amount_cents from job_bids where job_id = $1 and status in ('won', 'lost') order by amount_cents, created_at, id`, [jobId],
      );
      const low = bids[0];
      const target = mutation === 'award-second-lowest'
        ? bids.find((b) => Number(b.amount_cents) > Number(low?.amount_cents))
        : (bids[1] && Number(bids[1].amount_cents) === Number(low?.amount_cents) ? bids[1] : undefined);
      if (target) {
        await inner.query('update jobs set winner_bid_id = $2, winner_id = $3, award_cents = $4 where id = $1', [jobId, Number(target.id), target.bidder_id, Number(target.amount_cents)]);
        await inner.query(`update job_bids set status = case when id = $2 then 'won' else 'lost' end where job_id = $1 and status in ('won', 'lost')`, [jobId, Number(target.id)]);
        return inner.query<T>('select * from jobs where id = $1', [jobId]);
      }
    }
    return res;
  };
  return { db: { kind: inner.kind, query, exec: (s) => inner.exec(s), close: () => inner.close() }, restore };
}

/** The bus the routes publish on. alert-wrong-account: "You won" goes to the job's poster. */
export function mutateBus(bus: Bus, mutation: JobsMutationId | undefined, db: Db): void {
  if (mutation !== 'alert-wrong-account') return;
  const emit = bus.emit.bind(bus);
  bus.emit = async (e: BusEvent) => {
    if (e.type === 'job' && e.kind === 'job_awarded' && e.role === 'winner') {
      const rows = await db.query<{ poster_id: string }>('select poster_id from jobs where id = $1', [e.jobId]);
      if (rows[0]) return emit({ ...e, accountId: rows[0].poster_id });
    }
    return emit(e);
  };
}

/** What one viewer is shown (GET /api/jobs/:id). */
export function mutateAnswers(app: FastifyInstance, mutation: JobsMutationId | undefined, db: Db): void {
  if (mutation !== 'leak-amount' && mutation !== 'address-to-loser') return;
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method !== 'GET' || reply.statusCode !== 200 || typeof payload !== 'string') return payload;
    const m = /^\/api\/jobs\/([^/?]+)$/.exec(req.url);
    if (!m || m[1] === 'mine' || m[1] === 'rules') return payload;
    const body = JSON.parse(payload) as { job?: Record<string, any> };
    const job = body.job;
    if (!job) return payload;
    if (mutation === 'leak-amount' && job.status === 'open' && job.my?.role === 'poster') {
      const bids = await db.query<{ amount_cents: string | number }>(
        `select amount_cents from job_bids where job_id = $1 and status = 'active' order by amount_cents, created_at, id`, [job.id],
      );
      if (!bids.length) return payload;
      job.tab = bids.map((b, i) => ({ rank: i + 1, amountCents: Number(b.amount_cents), mine: false, bidder: null }));
    } else if (mutation === 'address-to-loser' && job.my?.role === 'bidder' && job.award && !job.award.isMe) {
      const rows = await db.query<{ address: string | null; phone: string | null }>('select address, phone from jobs where id = $1', [job.id]);
      job.private = { address: rows[0]?.address ?? null, phone: rows[0]?.phone ?? null };
    } else return payload;
    return JSON.stringify(body);
  });
}
