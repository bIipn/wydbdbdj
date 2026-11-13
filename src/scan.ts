import type { Db } from './db/db.js';
import { getBid, getOpenBids, recordScan, upsertBids, upsertMatch, upsertProfile } from './db/repo.js';
import { locate } from './geo/locate.js';
import type { Bus } from './realtime/bus.js';
import { scoreBid } from './score/score.js';
import { inheritFromStored, mergeDrafts, placeIsBlank } from './sources/dedupe.js';
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
 * event — on every scan, so listeners de-duplicate. Bids in `quiet` are re-scored and stored but never
 * published: they are stored bids this scan did not fetch, re-scored only so "N days to bid" stays true.
 */
async function scoreBids(
  db: Db, profile: Profile, bids: Bid[], now: Date, fresh: ReadonlySet<string>, bus?: Bus, quiet: ReadonlySet<string> = new Set(),
): Promise<ProfileReport> {
  const byVerdict = noVerdicts();
  const threshold = alertThreshold(profile);
  let newGood = 0;
  for (const bid of bids) {
    const s = scoreBid(bid, profile, now);
    await upsertMatch(db, profile.id, bid.id, s);
    byVerdict[s.verdict]++;
    const isNewBid = fresh.has(bid.id);
    if (isNewBid && s.score >= profile.notify.minScore && !s.overLimit) newGood++;
    if (bus && !quiet.has(bid.id) && s.score >= threshold && !s.rejected && !s.overLimit) {
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
 * merge duplicates, store, then score every open bid for each profile.
 */
export async function runScan({ db, sources, profiles, ctx, bus }: ScanDeps): Promise<ScanReport> {
  const started = new Date();
  const report: ScanReport = {
    startedAt: started.toISOString(), finishedAt: '', sources: {}, totalBids: 0, newBids: 0, profiles: {},
  };

  const drafts: BidDraft[] = [];
  for (const source of sources) {
    const t0 = Date.now();
    const skip = source.disabledReason?.(ctx) ?? null;
    if (skip) {
      report.sources[source.id] = { ok: true, skipped: skip, fetched: 0, ms: 0 };
      ctx.log(`- ${source.id}: skipped (${skip})`);
      continue;
    }
    try {
      const got = await source.fetch(ctx);
      drafts.push(...got);
      report.sources[source.id] = { ok: true, fetched: got.length, ms: Date.now() - t0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.sources[source.id] = { ok: false, error: msg, fetched: 0, ms: Date.now() - t0 };
      ctx.log(`! ${source.id} failed: ${msg}`);
    }
  }

  // One card per job: drafts with the same id (a SAM solicitation from two queries, or two notices of it)
  // merge, newest first. A place or set-aside that only the stored card still knows is carried over.
  const bids: Bid[] = [];
  for (let d of mergeDrafts(drafts)) {
    if (placeIsBlank(d.location) || !d.setAside) d = inheritFromStored(d, await getBid(db, `${d.source}:${d.sourceId}`));
    bids.push(finalizeBid(d));
  }
  const fresh = await upsertBids(db, bids, ctx.now);
  report.totalBids = bids.length;
  report.newBids = fresh.size;

  // Every still-open stored bid is re-scored too, not only what the boards returned today: SAM.gov is asked
  // for the last 3 days and NevadaEPro shows its 25 newest, so a bid drops out of the fetch long before it
  // closes, and its "N days to bid" and score would freeze. Those are stored quietly (no 'match' events).
  const fetched = new Set(bids.map((b) => b.id));
  const stale = (await getOpenBids(db, ctx.now)).filter((b) => !fetched.has(b.id));
  const quiet = new Set(stale.map((b) => b.id));
  const toScore = [...bids, ...stale];

  for (const profile of typeof profiles === 'function' ? await profiles() : profiles) {
    // One bad profile must not cost everyone else their matches.
    try {
      await upsertProfile(db, profile);
      report.profiles[profile.id] = await scoreBids(db, profile, toScore, ctx.now, fresh, bus, quiet);
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
