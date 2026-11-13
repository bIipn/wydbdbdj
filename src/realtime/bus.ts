import type { ScanReport } from '../scan.js';
import type { Alert, Award, Bid, ScoreResult } from '../types.js';

/**
 * Tiny in-process event bus. The scan and the market watchers publish; the alert rules,
 * the push sender and the /api/stream connections listen. One process on purpose (see CLAUDE.md:
 * the server owns the database), so there is no broker.
 */
export type BusEvent =
  /** A bid scored at or above the profile's alert threshold, not rejected, not over limit. */
  | { type: 'match'; profileId: string; bid: Bid; score: ScoreResult; isNewBid: boolean }
  /** A scan finished. */
  | { type: 'scan'; report: ScanReport }
  /** An alert was written to a profile's inbox. */
  | { type: 'alert'; profileId: string; alert: Alert }
  /** An award/result notice that matters to a profile (bidId when it ties to a bid they saved or bid on). */
  | { type: 'award'; profileId: string; award: Award; bidId?: string }
  /** A watched price/wage series moved. */
  | { type: 'price'; seriesId: string; changePct: number; period: string };

export type BusEventType = BusEvent['type'];
export type BusEventOf<T extends BusEventType> = Extract<BusEvent, { type: T }>;
export type BusListener<T extends BusEventType> = (event: BusEventOf<T>) => void | Promise<void>;

export interface Bus {
  /** Subscribe. Returns a function that unsubscribes. */
  on<T extends BusEventType>(type: T, listener: BusListener<T>): () => void;
  off<T extends BusEventType>(type: T, listener: BusListener<T>): void;
  /**
   * Deliver to every listener of `event.type`. Resolves once they have all settled and never rejects:
   * a listener that throws (or rejects) is reported to `onError` and the others still run.
   * The scan awaits this for every match, so a listener should finish its database work before it
   * returns and leave slow network calls (push) running in the background.
   */
  emit(event: BusEvent): Promise<void>;
}

export function createBus(onError: (err: unknown, event: BusEvent) => void = () => {}): Bus {
  const listeners = new Map<BusEventType, Set<(event: BusEvent) => void | Promise<void>>>();

  const off: Bus['off'] = (type, listener) => {
    listeners.get(type)?.delete(listener as (event: BusEvent) => void | Promise<void>);
  };

  return {
    on(type, listener) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(listener as (event: BusEvent) => void | Promise<void>);
      return () => off(type, listener);
    },
    off,
    async emit(event) {
      // Copy first: a listener may unsubscribe (or subscribe) while we deliver.
      const current = [...(listeners.get(event.type) ?? [])];
      await Promise.all(
        current.map(async (listener) => {
          try {
            await listener(event);
          } catch (err) {
            try {
              onError(err, event);
            } catch {
              // an error handler that throws must not break delivery either
            }
          }
        }),
      );
    },
  };
}
