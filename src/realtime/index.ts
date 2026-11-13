/**
 * Everything that reacts to bus events or the clock:
 *
 *   'match' / 'award' / 'price' on the bus → the pure rules in alerts.ts decide → the alert is stored
 *   once (alerts table, unique per profile + kind + dedupe key) → announced as 'alert' on the bus,
 *   which the /api/stream connections listen to → pushed to the profile's devices.
 *
 *   Every 15 minutes: deadline reminders for saved bids, then every push that is still waiting.
 *
 * Storing and streaming happen inside the bus listener (the scan awaits it). Pushes never do: they
 * are scheduled, coalesced per profile (several alerts in a burst = one notification) and sent in
 * the background. A push that cannot go out yet — quiet hours, no device accepted it, the server
 * stopped first — stays marked as waiting on its alert row and the next tick tries again, for up to
 * 24 hours. Claiming the rows before sending is what guarantees nothing is pushed twice.
 */
import type { RouteContext } from '../context.js';
import {
  claimWaitingPushes, getAlertTarget, insertAlert, listAlertTargets, profilesWithWaitingPush, recordPushResult,
  releasePushClaim, savedBidsDueWithin, seriesLabel, subscriptionsForProfile, type AlertTarget,
} from '../db/alerts.js';
import { getBid } from '../db/repo.js';
import { PPI_SERIES } from '../market/bls.js';
import { watchedSeries } from '../market/watch.js';
import { effectivePlan } from '../plans.js';
import {
  DEADLINE_LOOKAHEAD_HOURS, decideAward, decideDeadline, decideMatch, decidePrice, pushDecision, type AlertDecision,
} from './alerts.js';
import type { BusEventOf } from './bus.js';
import { createWebPushSender, pushMessage, toPushResult, usableVapid, type PushResult, type PushSender } from './push.js';

export const TICK_MS = 15 * 60_000;
/** Alerts for one profile that land within this window share one notification. */
export const PUSH_COALESCE_MS = 1500;
/** A push that still has not gone out after this long is dropped (the alert stays in the inbox). */
export const PUSH_MAX_AGE_MS = 24 * 3_600_000;
/** The first tick comes soon after start, to catch up on what a restart missed. */
const FIRST_TICK_MS = 5_000;

export interface RealtimeOptions {
  /** Default: web push with the configured VAPID keys. null = push off. Tests pass a fake. */
  sender?: PushSender | null;
  /** Milliseconds between ticks (default 15 minutes). 0 = never tick by itself: call tick(). */
  tickMs?: number;
  coalesceMs?: number;
}

export interface Realtime {
  /** Unsubscribe from the bus and cancel every timer. Safe to call at any time, any number of times. */
  stop(): void;
  /** Run the periodic job now: deadline reminders, then every push that is waiting. */
  tick(): Promise<void>;
  /** Send what is scheduled right away and wait until nothing is in flight. */
  flush(): Promise<void>;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createRealtime(ctx: RouteContext, opts: RealtimeOptions = {}): Realtime {
  const { db, bus, config } = ctx;
  const vapid = usableVapid(config, ctx.log);
  const sender = opts.sender !== undefined ? opts.sender : vapid ? createWebPushSender(vapid) : null;
  const coalesceMs = opts.coalesceMs ?? PUSH_COALESCE_MS;
  const tickMs = opts.tickMs ?? TICK_MS;
  let stopped = false;

  const planOf = (target: AlertTarget) => effectivePlan(config, target.account);
  /** Background work reports its failures; after stop() the database may be gone, so it stays silent. */
  const failed = (what: string) => (err: unknown): void => {
    if (!stopped) ctx.log(`realtime: ${what} failed: ${message(err)}`);
  };

  // ------------------------------------------------------------- push --

  const scheduled = new Map<string, NodeJS.Timeout>();
  const inFlight = new Set<Promise<void>>();

  /** Send a profile's waiting alerts to its devices as one notification, if it may buzz right now. */
  async function deliver(profileId: string): Promise<void> {
    if (stopped || !sender) return;
    const target = await getAlertTarget(db, profileId);
    const now = ctx.now();
    // 'hold' (quiet hours): leave the alerts waiting, the next tick looks again.
    if (!target || pushDecision(target.profile.alerts, planOf(target), now) !== 'send') return;
    const devices = await subscriptionsForProfile(db, profileId);
    if (devices.length === 0) return;
    const alerts = await claimWaitingPushes(db, profileId, new Date(now.getTime() - PUSH_MAX_AGE_MS), now);
    if (alerts.length === 0) return;

    const push = pushMessage(alerts, config.appUrl);
    const results = await Promise.all(devices.map(async (device) => {
      let result: PushResult;
      try {
        result = await sender(device, push);
      } catch (err) {
        result = toPushResult(err); // a sender that throws must not lose the claim
      }
      await recordPushResult(db, device.endpoint, result.ok ? 'ok' : result.gone ? 'gone' : 'failed', now);
      return result;
    }));
    const accepted = results.filter((r) => r.ok).length;
    // Nothing reached a phone: hand the alerts back so the next tick tries again.
    if (accepted === 0) await releasePushClaim(db, alerts.map((a) => a.id));
    const gone = results.filter((r) => !r.ok && r.gone).length;
    ctx.log(`push: ${alerts.length} alert(s) for ${profileId}, ${accepted} of ${devices.length} device(s) accepted${gone ? `, ${gone} expired and removed` : ''}`);
  }

  function inBackground(work: Promise<void>): void {
    const tracked = work.catch(failed('push')).finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
  }

  function schedulePush(profileId: string): void {
    if (stopped || scheduled.has(profileId)) return;
    const timer = setTimeout(() => {
      scheduled.delete(profileId);
      inBackground(deliver(profileId));
    }, coalesceMs);
    timer.unref();
    scheduled.set(profileId, timer);
  }

  // ------------------------------------------------------------ store --

  // One alert at a time, so ids reach the stream in order (Last-Event-ID depends on that).
  let last: Promise<unknown> = Promise.resolve();
  function inOrder<T>(work: () => Promise<T>): Promise<T> {
    const run = last.then(work);
    last = run.catch(() => {});
    return run;
  }

  async function store(profileId: string, decision: AlertDecision): Promise<void> {
    const wantsPush = decision.push !== 'off' && sender !== null;
    const alert = await insertAlert(db, profileId, decision.alert, { push: wantsPush, now: ctx.now() });
    if (!alert) return; // seen before: nothing is stored, streamed or pushed twice
    await bus.emit({ type: 'alert', profileId, alert });
    if (wantsPush) schedulePush(profileId);
  }

  async function onMatch(e: BusEventOf<'match'>): Promise<void> {
    const target = await getAlertTarget(db, e.profileId);
    const decision = target && decideMatch(e, target.profile, planOf(target), ctx.now());
    if (decision) await store(e.profileId, decision);
  }

  async function onAward(e: BusEventOf<'award'>): Promise<void> {
    const target = await getAlertTarget(db, e.profileId);
    if (!target) return;
    const bid = e.bidId ? await getBid(db, e.bidId) : null;
    const decision = decideAward(e, target.profile, planOf(target), ctx.now(), bid);
    if (decision) await store(e.profileId, decision);
  }

  /**
   * A price move is about no one profile: everyone who watches that series (every price index; the
   * median wage of their trade in their home state) and whose plan and settings want it gets the alert.
   */
  async function onPrice(e: BusEventOf<'price'>): Promise<void> {
    const stored = await seriesLabel(db, e.seriesId);
    if (!stored) return void ctx.log(`realtime: no alert for series ${e.seriesId}: it has no title and source on record`);
    const short = PPI_SERIES.find((p) => p.seriesId === e.seriesId)?.label;
    const label = { title: short ?? `${stored.title}${stored.area ? `, ${stored.area}` : ''}`, source: stored.source, sourceUrl: stored.sourceUrl };
    for (const target of await listAlertTargets(db)) {
      if (watchedSeries(target.profile, [{ seriesId: e.seriesId, kind: stored.kind }]).length === 0) continue;
      const decision = decidePrice(e, label, target.profile, planOf(target), ctx.now());
      if (decision) await store(target.profile.id, decision);
    }
  }

  // ------------------------------------------------------------- tick --

  /** One alert per saved bid per stage; the unique key makes every later tick a no-op. */
  async function remindDeadlines(): Promise<void> {
    const now = ctx.now();
    const targets = new Map<string, AlertTarget | null>();
    for (const saved of await savedBidsDueWithin(db, now, DEADLINE_LOOKAHEAD_HOURS)) {
      if (stopped) return;
      if (!targets.has(saved.profileId)) targets.set(saved.profileId, await getAlertTarget(db, saved.profileId));
      const target = targets.get(saved.profileId);
      const decision = target && decideDeadline(saved, target.profile, planOf(target), now);
      if (decision) await inOrder(() => store(saved.profileId, decision));
    }
  }

  async function runTick(): Promise<void> {
    if (stopped) return;
    await remindDeadlines();
    if (!sender) return;
    const since = new Date(ctx.now().getTime() - PUSH_MAX_AGE_MS);
    for (const profileId of await profilesWithWaitingPush(db, since)) await deliver(profileId).catch(failed('push'));
  }

  let ticking: Promise<void> | null = null;
  /** Never two ticks at once: a slow one is joined, not doubled. */
  const tick = (): Promise<void> =>
    (ticking ??= runTick().catch(failed('tick')).finally(() => {
      ticking = null;
    }));

  // ------------------------------------------------------------ start --

  const offs = [
    bus.on('match', (e) => inOrder(() => onMatch(e))),
    bus.on('award', (e) => inOrder(() => onAward(e))),
    bus.on('price', (e) => inOrder(() => onPrice(e))),
  ];
  const firstTick = tickMs > 0 ? setTimeout(() => void tick(), Math.min(tickMs, FIRST_TICK_MS)) : undefined;
  const everyTick = tickMs > 0 ? setInterval(() => void tick(), tickMs) : undefined;
  firstTick?.unref();
  everyTick?.unref();
  ctx.log(`realtime: alerts on, web push ${sender ? 'on' : 'off'}`);

  return {
    stop() {
      stopped = true;
      for (const off of offs) off();
      clearTimeout(firstTick);
      clearInterval(everyTick);
      for (const timer of scheduled.values()) clearTimeout(timer); // these pushes stay waiting: the next start sends them
      scheduled.clear();
    },
    tick,
    async flush() {
      for (const [profileId, timer] of [...scheduled]) {
        clearTimeout(timer);
        scheduled.delete(profileId);
        inBackground(deliver(profileId));
      }
      while (inFlight.size > 0) await Promise.all(inFlight);
    },
  };
}

/**
 * Starts the alert rules, the push sender and the 15-minute job. main() calls it once after the
 * server is listening and calls the returned function on shutdown; tests call it only when they
 * want it running (or use createRealtime for the tick and flush handles).
 */
export function startRealtime(ctx: RouteContext, opts: RealtimeOptions = {}): () => void {
  return createRealtime(ctx, opts).stop;
}
