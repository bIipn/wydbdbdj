import type { Db } from './db/db.js';
import { getBids, getOpenBids, listProfiles, pruneMatches, recordScan, upsertBids, upsertMatches, upsertProfile } from './db/repo.js';
import { accountProfileIds, ownLocalBidIds } from './jobs/repo.js';
import { locate } from './geo/locate.js';
import type { Bus } from './realtime/bus.js';
import { isCandidate } from './score/candidates.js';
import { scoreBid } from './score/score.js';
import { inheritFromStored, mergeDrafts, placeIsBlank } from './sources/dedupe.js';
import { FLAGS } from './sources/flags.js';
import type { Bid, BidDraft, Profile, ScoreResult, Source, SourceContext, SourceId, Tier, Verdict } from './types.js';

export interface SourceReport {
  ok: boolean;
  skipped?: string;
  error?: string;
  fetched: number;
  ms: number;
}

export interface ProfileReport {
  /** Candidates scored and stored (src/score/candidates.ts). */
  scored: number;
  /** Open bids left out as certainly out of reach for this profile: never scored, never stored. */
  outOfReach?: number;
  byVerdict: Record<Verdict, number>;
  /** The same candidates by tier (src/types.ts Tier). Absent in reports stored before tiers existed. */
  byTier?: Record<Tier, number>;
  /** New bids at or above the digest line that may alert: never sub work, capped or over-limit bids. */
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
const noTiers = (): Record<Tier, number> => ({ fit: 0, sub: 0, other: 0 });

/** May this match be announced (a 'match' alert, a "new good" count)? Never sub work, a capped, rejected or over-limit bid. */
export function mayAnnounce(s: ScoreResult, threshold: number): boolean {
  return s.score >= threshold && !s.rejected && !s.overLimit && !s.capped && s.tier !== 'sub';
}

/**
 * Score one profile's candidates and store them. Only `isCandidate` bids are scored at all: a bid certainly
 * out of reach (placed far beyond the travel radius, or unplaced in a state the company does not work) gets no
 * row, so storage grows with what is near each company, not with the whole country (src/score/candidates.ts).
 * Rows are written MATCH_BATCH at a time, then stale rows of bids that stopped being candidates are taken back.
 *
 * With a bus, every match worth an alert (at or above the threshold, not rejected, not over the spend limit)
 * is published as a 'match' event — on every scan, so listeners de-duplicate. Bids in `quiet` are re-scored and
 * stored but never published: they are stored bids this scan did not fetch, re-scored only so "N days to bid"
 * stays true. Events go out after the profile's rows are stored, so a listener that reads the match finds it.
 */
async function scoreBids(
  db: Db, profile: Profile, bids: Bid[], now: Date, fresh: ReadonlySet<string>, bus?: Bus, quiet: ReadonlySet<string> = new Set(),
  candidate: CandidateTest = isCandidate, announce: AnnounceRule = mayAnnounce,
): Promise<ProfileReport> {
  const byVerdict = noVerdicts();
  const byTier = noTiers();
  const threshold = alertThreshold(profile);
  let newGood = 0;
  const scored: Array<{ bid: Bid; bidId: string; score: ScoreResult }> = [];
  // A job this company's own account posted is never scored for it, so it never reaches its own feed. Nor is
  // any local job scored for a profile that cannot take one (seesLocalJobs).
  const hasLocal = bids.some((b) => b.source === 'local');
  const own = hasLocal ? await ownLocalBidIds(db, profile.id) : new Set<string>();
  const local = hasLocal && seesLocalJobs(profile, (await accountProfileIds(db)).has(profile.id));
  for (const bid of bids) {
    if (bid.source === 'local' && (!local || own.has(bid.id))) continue;
    if (!candidate(profile, bid)) continue;
    const s = scoreBid(bid, profile, now);
    scored.push({ bid, bidId: bid.id, score: s });
    byVerdict[s.verdict]++;
    byTier[s.tier]++;
    if (fresh.has(bid.id) && mayAnnounce(s, profile.notify.minScore)) newGood++;
  }
  await upsertMatches(db, profile.id, scored);
  await pruneMatches(db, profile.id, scored.map((x) => x.bidId), now);

  if (bus) {
    for (const { bid, score: s } of scored) {
      if (quiet.has(bid.id) || !announce(s, threshold)) continue;
      await bus.emit({ type: 'match', profileId: profile.id, bid, score: s, isNewBid: fresh.has(bid.id) });
      // Let the event loop run once: the alert's stream frame and push go out now, not when the whole
      // scan ends (the embedded database runs on this thread, so a long scan would otherwise hold them).
      await new Promise<void>((r) => setImmediate(r));
    }
  }
  return { scored: scored.length, outOfReach: bids.length - scored.length, byVerdict, byTier, newGood };
}

/**
 * Score every open bid that could matter to one stored profile right now — right after onboarding or a
 * settings change, so the feed is not empty until the next scan. Only candidates are scored and stored, in
 * batches; rows left over from the profile's old settings (bids no longer in reach) are taken back.
 * Returns how many bids were scored. 'match' events carry isNewBid: false (the profile is new, the bids are not).
 */
export async function scoreProfile(db: Db, profile: Profile, now: Date, bus?: Bus): Promise<number> {
  const bids = await getOpenBids(db, now);
  return (await scoreBids(db, profile, bids, now, new Set(), bus)).scored;
}

/**
 * May this profile be shown local jobs (people's posts, bid on in the app)? Only when an account owns it (a
 * config profile, the pilot's single mode, has no account to bid with: the card would be a dead end) and it does
 * some kind of work: a "Get work done" profile has no trades and no keywords, and its work feed stays empty
 * (jobs contract section 5), so it is not handed jobs at score 0 either.
 */
export function seesLocalJobs(profile: Profile, hasAccount: boolean): boolean {
  const doesWork = (profile.trades?.length ?? 0) > 0 || profile.keywords.strong.length > 0;
  return hasAccount && doesWork;
}

/**
 * Score ONE new bid for every stored profile it could matter to, except `exceptProfileId` (a local job's poster:
 * nobody is shown their own job), store the scores, and raise the normal 'match' events for the good fits.
 * This is what makes a job someone just posted reach the people who fit it without waiting for a scan.
 * Returns how many profiles got a stored score.
 */
export async function scoreNewBid(
  db: Db, bid: Bid, now: Date, bus?: Bus, opts: { exceptProfileId?: string | null } = {},
): Promise<number> {
  let n = 0;
  const withAccount = bid.source === 'local' ? await accountProfileIds(db) : null;
  for (const profile of await listProfiles(db)) {
    if (profile.id === opts.exceptProfileId || !isCandidate(profile, bid)) continue;
    if (withAccount && !seesLocalJobs(profile, withAccount.has(profile.id))) continue;
    try {
      const s = scoreBid(bid, profile, now);
      await upsertMatches(db, profile.id, [{ bidId: bid.id, score: s }]);
      n++;
      if (bus && mayAnnounce(s, alertThreshold(profile))) {
        await bus.emit({ type: 'match', profileId: profile.id, bid, score: s, isNewBid: true });
      }
    } catch (err) {
      // One bad profile must not keep the job from everyone else (the same rule as a scan).
      console.error(`[scan] scoring ${bid.id} for ${profile.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return n;
}

/** Which bids a profile gets a stored score for. Always isCandidate, except in the simulation's mutation run. */
export type CandidateTest = (profile: Profile, bid: Bid) => boolean;

/** Which scored matches the scan publishes as 'match' events. Always mayAnnounce, except in the simulation's mutation run. */
export type AnnounceRule = (score: ScoreResult, threshold: number) => boolean;

export interface ScanDeps {
  db: Db;
  sources: Source[];
  /** Who to score for. A function is called after the sources are fetched, so it sees profiles saved meanwhile. */
  profiles: Profile[] | (() => Promise<Profile[]>);
  ctx: SourceContext;
  /** Publishes 'match' events while scoring and one 'scan' event at the end. */
  bus?: Bus;
  /** Default isCandidate (src/score/candidates.ts). A seam for `npm run simulate`'s "browse-missing" mutation only. */
  candidate?: CandidateTest;
  /** Default mayAnnounce. A seam for `npm run simulate`'s "sub-alerts" mutation only. */
  announce?: AnnounceRule;
}

/**
 * One scan: pull every source (a broken source never stops the others), merge duplicates, store (in
 * batches), then score every open bid that is a candidate for each profile (src/score/candidates.ts).
 */
export async function runScan({ db, sources, profiles, ctx, bus, candidate = isCandidate, announce = mayAnnounce }: ScanDeps): Promise<ScanReport> {
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
  // The stored cards are read in one query per few hundred ids, not one per draft (thousands with SAM's bulk file).
  // 'local' rows are jobs people posted on BidSwipe (src/jobs): only the jobs module writes them. A scan knows the
  // boards alone, so it never stores, overwrites or removes one, whatever a source hands back.
  const boardDrafts = drafts.filter((d) => d.source !== 'local');
  if (boardDrafts.length < drafts.length) ctx.log(`! ${drafts.length - boardDrafts.length} draft(s) claiming source 'local' ignored`);
  const merged = mergeDrafts(boardDrafts);
  // A draft may take from the stored card what today's notices left out: a place, a set-aside, or the real work
  // site an earlier scan read for a card that is placed at its contracting office today (dedupe.ts).
  const inherits = (d: BidDraft): boolean =>
    placeIsBlank(d.location) || !d.setAside || (d.flags ?? []).includes(FLAGS.placeFromOffice);
  const stored = await getBids(db, merged.filter(inherits).map((d) => `${d.source}:${d.sourceId}`));
  const bids: Bid[] = merged.map((d) =>
    finalizeBid(inherits(d) ? inheritFromStored(d, stored.get(`${d.source}:${d.sourceId}`) ?? null) : d));
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
      report.profiles[profile.id] = await scoreBids(db, profile, toScore, ctx.now, fresh, bus, quiet, candidate, announce);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.profiles[profile.id] = { scored: 0, byVerdict: noVerdicts(), byTier: noTiers(), newGood: 0, error: msg };
      ctx.log(`! profile ${profile.id} failed: ${msg}`);
    }
  }

  report.finishedAt = new Date().toISOString();
  await recordScan(db, started, report);
  await bus?.emit({ type: 'scan', report });
  return report;
}
