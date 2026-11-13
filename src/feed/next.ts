import type { FeedItem } from '../types.js';

/**
 * "What should I look at next?" — one bid, chosen on fit and urgency, with the reasons in plain
 * English. Pure. Callers pass open, un-swiped items; an over-limit item must never be picked.
 *
 * STUB (foundation): never picks anything.
 */
export function pickNext(_items: FeedItem[], _now: Date): { item: FeedItem | null; why: string[] } {
  return { item: null, why: [] };
}
