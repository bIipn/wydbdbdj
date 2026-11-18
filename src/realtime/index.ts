/**
 * Everything that reacts to bus events or the clock:
 *
 *   'match' / 'award' / 'price' on the bus → the pure rules in alerts.ts decide → the alert is stored
 *   once (alerts table, unique per profile + kind + dedupe key) → announced as 'alert' on the bus,
 *   which the /api/stream connections listen to → pushed to the profile's devices.
 *
 *   'job' (src/jobs) → decideJob → the same store / stream / push path, to the profile of the account it is about.
 *
 *   Every 15 minutes (on the serverless host: once a day, /api/cron/tick): deadline reminders for saved bids, the job
 *   marketplace's settlement and contact reminders, then every push that is still waiting.
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
  releasePushClaim, retireTapAlert, savedBidsDueWithin, seriesLabel, subscriptionsForProfile, type AlertTarget,
} from '../db/alerts.js';
import { getBid } from '../db/repo.js';
import { env as processEnv } from '../env.js';
import { loadJobRules } from '../jobs/config.js';
import { getJob, profileIdOf } from '../jobs/repo.js';
import { remindContact, settleDue, type JobsDeps } from '../jobs/service.js';
import { PPI_SERIES } from '../market/bls.js';
import { watchedSeries } from '../market/watch.js';
import { effectivePlan, featuresFor } from '../plans.js';
import {
  DEADLINE_LOOKAHEAD_HOURS, decideAward, decideDeadline, decideJob, decideMatch, decidePrice, pushDecision, type AlertDecision,
} from './alerts.js';
import type { BusEventOf } from './bus.js';
import { createWebPushSender, pushMessage, testPushMessage, toPushResult, usableVapid, type PushResult, type PushSender } from './push.js';

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
  /**
   * How often tick() runs when something else calls it (tickMs 0): the serverless host's daily cron passes
   * HOST_TICK_EVERY_MS. The deadline reminders need it to know whether a run is the last one of someone's day
   * (alerts.ts deadlineStage). Default: tickMs; with tickMs 0 and nothing given, not known (reminders from 07:00 only).
   */
  tickEveryMs?: number;
  coalesceMs?: number;
}

/** The serverless host calls /api/cron/tick once a day (vercel.json "50 14 * * *": 14:50 UTC). */
export const HOST_TICK_EVERY_MS = 24 * 3_600_000;

export interface Realtime {
  /** Unsubscribe from the bus and cancel every timer. Safe to call at any time, any number of times. */
  stop(): void;
  /** Run the periodic job now: deadline reminders, then every push that is waiting. */
  tick(): Promise<void>;
  /** Send what is scheduled right away and wait until nothing is in flight. */
  flush(): Promise<void>;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** The push service's host of an endpoint, for a log line (the endpoint itself is a capability and is never logged). */
const serviceHost = (endpoint: string): string => {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'an unknown push service';
  }
};

export function createRealtime(ctx: RouteContext, opts: RealtimeOptions = {}): Realtime {
  const { db, bus, config } = ctx;
  const vapid = usableVapid(config, ctx.log);
  const sender = opts.sender !== undefined ? opts.sender : vapid ? createWebPushSender(vapid) : null;
  const coalesceMs = opts.coalesceMs ?? PUSH_COALESCE_MS;
  const tickMs = opts.tickMs ?? TICK_MS;
  const tickEveryMs = opts.tickEveryMs ?? tickMs;
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
    if (!target) return;
    const now = ctx.now();
    // A plan without instant push buzzes for local jobs only (alerts.ts pushDecision): what waits there is local
    // anyway, and a public bid's push left waiting from a Pro month is not sent after a move to Free.
    const plan = planOf(target);
    const localOnly = !featuresFor(plan).instantPush;
    // 'hold' (quiet hours): leave the alerts waiting, the next tick looks again.
    if (pushDecision(target.profile.alerts, plan, now, localOnly ? 'local' : 'bid') !== 'send') return;
    const devices = await subscriptionsForProfile(db, profileId);
    if (devices.length === 0) return;
    const alerts = await claimWaitingPushes(db, profileId, new Date(now.getTime() - PUSH_MAX_AGE_MS), now, { localOnly });
    if (alerts.length === 0) return;

    const push = pushMessage(alerts, config.appUrl);
    const results = await Promise.all(devices.map(async (device) => {
      let result: PushResult;
      try {
        result = await sender(device, push);
      } catch (err) {
        result = toPushResult(err); // a sender that throws must not lose the claim
      }
      const outcome = result.ok ? 'ok' : result.gone ? 'gone' : result.permanent ? 'refused' : 'failed';
      await recordPushResult(db, device.endpoint, outcome, now, result.ok ? null : result.status);
      if (!result.ok && result.permanent) {
        // The push service's host and its own reason, never the endpoint (a capability URL).
        ctx.log(`push: ${serviceHost(device.endpoint)} refused a device (${result.status}${result.reason ? ` ${result.reason}` : ''}); it gets nothing until it subscribes again`);
      }
      return result;
    }));
    const accepted = results.filter((r) => r.ok).length;
    // Nothing reached a phone: hand the alerts back so the next tick tries again.
    // Known gap (audit push-retry-1, documented on purpose): the claim is per profile, not per device. When one device
    // accepts and another fails for a passing reason (429, 5xx, no answer), the failed one never gets this message: a
    // second device suppresses the retry. Phones keep the in-app inbox, which always has it. A per-device retry needs
    // its own table; not worth it at pilot scale.
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

  /** A local job event is about one account: its profile's inbox (an account with no profile yet has no inbox). */
  async function onJob(e: BusEventOf<'job'>): Promise<void> {
    // "The other side tapped “We’ve agreed”, tap it too": checked again against the row as it is now, so two taps
    // at the same moment (the second one completing the agreement) never tell someone who already tapped.
    if (e.tap === 'agreed') {
      const job = await getJob(db, e.jobId);
      const theirTap = e.role === 'winner' ? job?.bidderConfirmedAt : job?.posterConfirmedAt;
      if (!job || job.status !== 'awarded' || theirTap != null) return;
    }
    const profileId = await profileIdOf(db, e.accountId);
    // The job ended (agreed, or any other way): a "tap it too" alert still unread asks for nothing now.
    if (profileId && e.kind === 'job_closed') await retireTapAlert(db, profileId, e.jobId, e.role, ctx.now());
    const target = profileId ? await getAlertTarget(db, profileId) : null;
    const decision = target && decideJob(e, target.profile, planOf(target), ctx.now());
    if (decision && profileId) await store(profileId, decision);
  }

  // ------------------------------------------------------------- tick --

  /**
   * The job marketplace has no timers of its own (settlement is lazy): each tick settles what is due, so award
   * and no-show alerts go out even when nobody opens a job, and sends the "2 days left to make contact" reminders.
   * Accounts mode only: single mode (the pilot) has no marketplace. The settings were checked at start-up.
   */
  let jobsDeps: JobsDeps | null = null;
  async function tickJobs(): Promise<void> {
    if (config.authMode !== 'accounts') return;
    jobsDeps ??= { db, bus, rules: loadJobRules(processEnv), appUrl: config.appUrl, log: ctx.log };
    const now = ctx.now().getTime();
    await settleDue(jobsDeps, now);
    await remindContact(jobsDeps, now);
  }

  /**
   * One alert per saved bid per stage; the unique key makes every later tick a no-op. The stage is the calendar day
   * on each profile's clock; the next run tells the rule whether this one is the last of someone's day.
   */
  async function remindDeadlines(): Promise<void> {
    const now = ctx.now();
    const nextRunAt = tickEveryMs > 0 ? new Date(now.getTime() + tickEveryMs) : null;
    const targets = new Map<string, AlertTarget | null>();
    for (const saved of await savedBidsDueWithin(db, now, DEADLINE_LOOKAHEAD_HOURS)) {
      if (stopped) return;
      if (!targets.has(saved.profileId)) targets.set(saved.profileId, await getAlertTarget(db, saved.profileId));
      const target = targets.get(saved.profileId);
      const decision = target && decideDeadline(saved, target.profile, planOf(target), now, nextRunAt);
      if (decision) await inOrder(() => store(saved.profileId, decision));
    }
  }

  async function runTick(): Promise<void> {
    if (stopped) return;
    await remindDeadlines();
    await tickJobs().catch(failed('jobs'));
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
    bus.on('job', (e) => inOrder(() => onJob(e))),
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

// ------------------------------------------------------------- test push --
// Added for POST /api/push/test (src/routes/realtime.ts, the fix-ios stage): appended here, nothing above changed.

export interface TestPushOutcome {
  /** Devices of this profile's owner that were sent to (the same list a real alert goes to). */
  tried: number;
  /** How many of them the push services accepted. */
  accepted: number;
}

/**
 * "Send a test alert": one notification to the caller's own devices, through what deliver() uses for a real alert —
 * subscriptionsForProfile (so a device refused for good is skipped the same way), the same PushSender, and
 * recordPushResult (a 404/410 removes the device, a 400/403/413 marks it refused). The caller (the route) has already
 * checked the gate deliver() checks (pushDecision: the plan's instantPush, alerts not switched off, no quiet hours).
 * Stores no alert: a test is not news and never enters the inbox.
 */
export async function sendTestPush(ctx: RouteContext, profileId: string, owner: string, sender: PushSender): Promise<TestPushOutcome> {
  const now = ctx.now();
  const devices = await subscriptionsForProfile(ctx.db, profileId);
  const push = testPushMessage(ctx.config.appUrl, owner, now);
  const results = await Promise.all(devices.map(async (device) => {
    let result: PushResult;
    try {
      result = await sender(device, push);
    } catch (err) {
      result = toPushResult(err);
    }
    const outcome = result.ok ? 'ok' : result.gone ? 'gone' : result.permanent ? 'refused' : 'failed';
    await recordPushResult(ctx.db, device.endpoint, outcome, now, result.ok ? null : result.status);
    if (!result.ok && result.permanent) {
      ctx.log(`push: ${serviceHost(device.endpoint)} refused a device (${result.status}${result.reason ? ` ${result.reason}` : ''}); it gets nothing until it subscribes again`);
    }
    return result;
  }));
  const accepted = results.filter((r) => r.ok).length;
  ctx.log(`push: test alert for ${profileId}, ${accepted} of ${devices.length} device(s) accepted`);
  return { tried: devices.length, accepted };
}
