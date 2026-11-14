/**
 * Helpers for tests of the scan's announcing rules (src/scan.ts). A source's FIRST load is quiet (no 'match'
 * events): a test about alerts on a source the app already knows stores one synthetic, long-closed TEST bid of that
 * source first. It is closed, so no feed, count, re-score or digest ever sees it.
 */
import type { Db } from '../src/db/db.js';
import { upsertBids } from '../src/db/repo.js';
import { MAX_MATCH_ALERTS_PER_SCAN } from '../src/scan.js';
import type { Bid, ScoreResult, SourceId } from '../src/types.js';
import { NOW, testBid } from './helpers.js';

/** Store a closed TEST bid of each source (state `state`), so the next scan of it is not its first load. */
export async function markSourcesKnown(db: Db, sources: readonly SourceId[], state: string | null = 'NV'): Promise<void> {
  await upsertBids(db, sources.map((source) => testBid({
    source, sourceId: 'TEST-known-before', title: 'TEST closed bid: the board was read before (synthetic)',
    location: { state }, dueAt: '2020-01-01T00:00:00.000Z',
  })), new Date(NOW.getTime() - 30 * 86_400_000));
}

/** The ids a scan may alert for one profile when `worthy` are all new: the best MAX_MATCH_ALERTS_PER_SCAN. */
export function cappedIds(worthy: ReadonlyArray<{ bid: Pick<Bid, 'id' | 'dueAt'>; score: Pick<ScoreResult, 'score'> }>): string[] {
  const due = (b: Pick<Bid, 'dueAt'>) => (b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY);
  return [...worthy]
    .sort((a, b) => b.score.score - a.score.score || due(a.bid) - due(b.bid) || (a.bid.id < b.bid.id ? -1 : 1))
    .slice(0, MAX_MATCH_ALERTS_PER_SCAN)
    .map((x) => x.bid.id)
    .sort();
}
