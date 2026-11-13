import type { Db } from './db/db.js';
import { getOpenBids, recordScan, upsertBids, upsertMatch, upsertProfile } from './db/repo.js';
import { locate } from './geo/locate.js';
import type { Bus } from './realtime/bus.js';
import { scoreBid } from './score/score.js';
import type { Bid, BidDraft, Profile, Source, SourceContext, SourceId, Verdict } from './types.js';

export interface SourceReport {
  ok: boolean;
  skipped?: string;
  error?: string;
  fetched: number;
  ms: number;
}

export interface ProfileReport {
  scored: number;
  byVerdict: Record<Verdict, number>;
  newGood: number;
  /** Set when scoring this profile failed; the other profiles were still scored. */
  error?: string;
}

export interface ScanReport {
  startedAt: string;
  finishedAt: string;
  sources: Partial<Record<SourceId, SourceReport>>;
  totalBids: number;
  newBids: number;
  profiles: Record<string, ProfileReport>;
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

/** The score a match needs before this profile is alerted about it. */
export function alertThreshold(profile: Profile): number {
  return profile.alerts?.minScore ?? profile.notify.minScore;
}

const noVerdicts = (): Record<Verdict, number> => ({ great: 0, good: 0, maybe: 0, skip: 0 });

/**
 * Score `bids` for one profile and store the matches. With a bus, every match worth an alert
 * (at or above the threshold, not rejected, not over the spend limit) is published as a 'match'
 * event — on every scan, so listeners de-duplicate.
 */
async function scoreBids(db: Db, profile: Profile, bids: Bid[], now: Date, fresh: ReadonlySet<string>, bus?: Bus): Promise<ProfileReport> {
  const byVerdict = noVerdicts();
  const threshold = alertThreshold(profile);
  let newGood = 0;
  for (const bid of bids) {
    const s = scoreBid(bid, profile, now);
    await upsertMatch(db, profile.id, bid.id, s);
    byVerdict[s.verdict]++;
    const isNewBid = fresh.has(bid.id);
    if (isNewBid && s.score >= profile.notify.minScore && !s.overLimit) newGood++;
    if (bus && s.score >= threshold && !s.rejected && !s.overLimit) {
      await bus.emit({ type: 'match', profileId: profile.id, bid, score: s, isNewBid });
    }
  }
  return { scored: bids.length, byVerdict, newGood };
}

/**
 * Score every open bid for one stored profile right now — right after onboarding or a settings
 * change, so the feed is not empty until the next scan. Returns how many bids were scored.
 * 'match' events carry isNewBid: false (the profile is new, the bids are not).
 */
export async function scoreProfile(db: Db, profile: Profile, now: Date, bus?: Bus): Promise<number> {
  const bids = await getOpenBids(db, now);
  return (await scoreBids(db, profile, bids, now, new Set(), bus)).scored;
}

export interface ScanDeps {
  db: Db;
  sources: Source[];
  /** Who to score for. A function is called after the sources are fetched, so it sees profiles saved meanwhile. */
  profiles: Profile[] | (() => Promise<Profile[]>);
  ctx: SourceContext;
  /** Publishes 'match' events while scoring and one 'scan' event at the end. */
  bus?: Bus;
}

/**
 * One scan: pull every source (a broken source never stops the others),
 * normalize + dedupe, store, then score each bid for each profile.
 */
export async function runScan({ db, sources, profiles, ctx, bus }: ScanDeps): Promise<ScanReport> {
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

  for (const profile of typeof profiles === 'function' ? await profiles() : profiles) {
    // One bad profile must not cost everyone else their matches.
    try {
      await upsertProfile(db, profile);
      report.profiles[profile.id] = await scoreBids(db, profile, bids, ctx.now, fresh, bus);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.profiles[profile.id] = { scored: 0, byVerdict: noVerdicts(), newGood: 0, error: msg };
      ctx.log(`! profile ${profile.id} failed: ${msg}`);
    }
  }

  report.finishedAt = new Date().toISOString();
  await recordScan(db, started, report);
  await bus?.emit({ type: 'scan', report });
  return report;
}
