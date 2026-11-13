import type { Db } from './db/db.js';
import { recordScan, upsertBids, upsertMatch, upsertProfile } from './db/repo.js';
import { locate } from './geo/locate.js';
import { scoreBid } from './score/score.js';
import type { Bid, BidDraft, Profile, Source, SourceContext, SourceId, Verdict } from './types.js';

export interface SourceReport {
  ok: boolean;
  skipped?: string;
  error?: string;
  fetched: number;
  ms: number;
}

export interface ScanReport {
  startedAt: string;
  finishedAt: string;
  sources: Partial<Record<SourceId, SourceReport>>;
  totalBids: number;
  newBids: number;
  profiles: Record<string, { scored: number; byVerdict: Record<Verdict, number>; newGood: number }>;
}

/** Draft from a source → full Bid (stable id, resolved location, flags array). */
export function finalizeBid(d: BidDraft): Bid {
  return {
    ...d,
    id: `${d.source}:${d.sourceId}`,
    location: locate(d),
    flags: [...new Set(d.flags ?? [])],
  };
}

export interface ScanDeps {
  db: Db;
  sources: Source[];
  profiles: Profile[];
  ctx: SourceContext;
}

/**
 * One scan: pull every source (a broken source never stops the others),
 * normalize + dedupe, store, then score each bid for each profile.
 */
export async function runScan({ db, sources, profiles, ctx }: ScanDeps): Promise<ScanReport> {
  const started = new Date();
  const report: ScanReport = {
    startedAt: started.toISOString(), finishedAt: '', sources: {}, totalBids: 0, newBids: 0, profiles: {},
  };

  const byId = new Map<string, Bid>();
  for (const source of sources) {
    const t0 = Date.now();
    const skip = source.disabledReason?.(ctx) ?? null;
    if (skip) {
      report.sources[source.id] = { ok: true, skipped: skip, fetched: 0, ms: 0 };
      ctx.log(`- ${source.id}: skipped (${skip})`);
      continue;
    }
    try {
      const drafts = await source.fetch(ctx);
      for (const d of drafts) {
        const bid = finalizeBid(d);
        byId.set(bid.id, bid);
      }
      report.sources[source.id] = { ok: true, fetched: drafts.length, ms: Date.now() - t0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.sources[source.id] = { ok: false, error: msg, fetched: 0, ms: Date.now() - t0 };
      ctx.log(`! ${source.id} failed: ${msg}`);
    }
  }

  const bids = [...byId.values()];
  const fresh = await upsertBids(db, bids, ctx.now);
  report.totalBids = bids.length;
  report.newBids = fresh.size;

  for (const profile of profiles) {
    await upsertProfile(db, profile);
    const byVerdict: Record<Verdict, number> = { great: 0, good: 0, maybe: 0, skip: 0 };
    let newGood = 0;
    for (const bid of bids) {
      const s = scoreBid(bid, profile, ctx.now);
      await upsertMatch(db, profile.id, bid.id, s);
      byVerdict[s.verdict]++;
      if (fresh.has(bid.id) && s.score >= profile.notify.minScore) newGood++;
    }
    report.profiles[profile.id] = { scored: bids.length, byVerdict, newGood };
  }

  report.finishedAt = new Date().toISOString();
  await recordScan(db, started, report);
  return report;
}
