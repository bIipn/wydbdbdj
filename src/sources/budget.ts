import type { SourceContext } from '../types.js';

/**
 * The per-source time budget (SourceContext.deadline), for sources that read page after page.
 *
 *   for (let page = 1; ; page++) {
 *     if (page > 1 && outOfTime(ctx)) { stopAtBudget(ctx, 'commbuys', bids.length, total); break; }
 *     …one request…
 *   }
 *
 * Check BEFORE a request, never in the middle of one, and never before the first: a source that read
 * nothing has nothing to keep, so it lets its first request run (the group's budget leaves room for it).
 * The clock is the real one (Date.now), not ctx.now: ctx.now is the scan's "today", fixed for the whole run.
 */

/** Milliseconds left before ctx.deadline; Infinity when the run has no budget. */
export function timeLeftMs(ctx: Pick<SourceContext, 'deadline'>): number {
  return ctx.deadline ? ctx.deadline.getTime() - Date.now() : Number.POSITIVE_INFINITY;
}

/** True once the deadline has passed (or is closer than `marginMs`, e.g. one slow request). */
export function outOfTime(ctx: Pick<SourceContext, 'deadline'>, marginMs = 0): boolean {
  return timeLeftMs(ctx) <= marginMs;
}

/**
 * Stop at the budget, loudly: logs "<id>: stopped at the time budget, N of M read" and tells runScan, which
 * puts the same sentence in the scan report (SourceReport.stopped). `total` = what the board announces, or
 * null when it does not say ("N of ? read"). `what` names the unit when it is not bids ("governments").
 */
export function stopAtBudget(
  ctx: Pick<SourceContext, 'log' | 'partial'>, id: string, read: number, total: number | null, what?: string,
): string {
  const msg = `${id}: stopped at the time budget, ${read} of ${total ?? '?'}${what ? ` ${what}` : ''} read`;
  ctx.log(msg);
  ctx.partial?.(msg);
  return msg;
}
