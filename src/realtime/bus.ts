import type { ScanReport } from '../scan.js';
import type { Alert, Award, Bid, JobAlertKind, ScoreResult } from '../types.js';

/**
 * Something happened on a local job that one person should hear about (src/jobs/service.ts publishes it,
 * src/realtime/index.ts turns it into an inbox alert for that person's profile).
 * role = who this person is on the job. Amounts are integer cents. Times are ISO.
 */
export interface JobEvent {
  type: 'job';
  kind: JobAlertKind;
  accountId: string;
  jobId: string;
  title: string;
  role: 'poster' | 'winner' | 'bidder';
  /** The job's status and outcome after the change. */
  status: string;
  outcome: string | null;
  /** The winning bid, when there is one. */
  amountCents: number | null;
  /** This person's own bid (a losing bidder), when they had one. */
  myAmountCents?: number | null;
  contactDeadline: string | null;
  /** job_message only: the message id (the dedupe key) and its first words. */
  messageId?: number;
  preview?: string;
}

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
  /**
   * An award/result notice that matters to a profile: bidId when it settles a bid they saved or bid on;
   * `nearby` when it is a job like theirs inside their travel radius (src/market/watch.ts).
   */
  | { type: 'award'; profileId: string; award: Award; bidId?: string; nearby?: { miles: number; naics: string } }
  /**
   * A watched price/wage series has a new period that moved from the one before (src/market/watch.ts).
   * changePct is against previousPeriod; yearChangePct against the same period a year earlier.
   */
  | {
    type: 'price'; seriesId: string; changePct: number; period: string;
    previousPeriod?: string; yearChangePct?: number | null; preliminary?: boolean;
  }
  /** A local job changed in a way one person should hear about (see JobEvent). */
  | JobEvent;

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
