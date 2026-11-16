import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContext } from '../context.js';
import {
  alertsAfter, countUnread, deleteSubscription, ensureSingleOwner, latestAlertId, listAlerts, markAlertsRead,
  saveSubscription, singleOwnerId,
} from '../db/alerts.js';
import { lastScanAt } from '../db/repo.js';
import { env } from '../env.js';
import { loadJobRules } from '../jobs/config.js';
import { settleDue, type JobsDeps } from '../jobs/service.js';
import { featuresFor } from '../plans.js';
import { createAttemptLimiter } from '../auth/ratelimit.js';
import { pushDecision } from '../realtime/alerts.js';
import { sendTestPush } from '../realtime/index.js';
import { checkSubscription, createWebPushSender, usableVapid, type PushSender } from '../realtime/push.js';
import { createStreamHub, MAX_STREAMS_PER_ACCOUNT, MAX_STREAMS_SINGLE, REPLAY_LIMIT } from '../realtime/stream.js';

export interface RealtimeRouteOptions {
  /** Milliseconds between pings on /api/stream (default 25 s). */
  pingMs?: number;
  /** Open streams allowed per account (default 5; 25 for the one shared identity of single mode). */
  maxStreams?: number;
  /** 'stream' (default) or 'poll'. Default: the REALTIME_MODE environment variable. Tests pass it. */
  mode?: RealtimeMode;
  /** How often a polling client asks GET /api/alerts (default 60 s). */
  pollMs?: number;
  /** POST /api/push/test's sender. Default: web push with the configured VAPID keys, as for a real alert. */
  pushSender?: PushSender;
}

/** "Send a test alert": per account (or the pilot's one owner), counted in the database so every instance agrees. */
export const PUSH_TEST_LIMIT = { limit: 3, windowMs: 10 * 60 * 1000 } as const;
const TESTED_TOO_OFTEN = 'You can send 3 test alerts every 10 minutes. Wait a few minutes, then try again.';

/**
 * How the app hears about new alerts.
 *
 *   'stream'  one long-lived GET /api/stream per open app (Server-Sent Events). Instant, but the server
 *             must hold every connection open: right for one long-running process (the pilot, a VM).
 *   'poll'    no stream: the app asks GET /api/alerts once a minute while it is on screen. A serverless
 *             host (Vercel) bills a function for every second it is open and cuts it off after a few
 *             minutes, and the scan runs in a different function anyway, so a stream there would hear nothing.
 */
export type RealtimeMode = 'stream' | 'poll';
export const POLL_MS = 60_000;

/** REALTIME_POLL_MS (whole milliseconds, at least 15 s) overrides the 60 s poll; anything else is ignored. */
export function pollInterval(value: string | undefined = env('REALTIME_POLL_MS')): number {
  const ms = value && /^\d{1,9}$/.test(value) ? Number(value) : NaN;
  return ms >= 15_000 ? ms : POLL_MS;
}

/**
 * REALTIME_MODE=poll turns the stream off; any other value keeps it on. Unset, it follows the host: Vercel
 * sets VERCEL=1 in every function, and a stream there would hear nothing (see above), so it polls.
 */
export function realtimeMode(value: string | undefined = env('REALTIME_MODE'), onVercel: boolean = !!env('VERCEL')): RealtimeMode {
  if (!value) return onVercel ? 'poll' : 'stream';
  return value.toLowerCase() === 'poll' ? 'poll' : 'stream';
}

const MAX_READ_IDS = 500;

const wholeNumber = (value: unknown): number | undefined => (typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : undefined);

/** Alert ids from a request body: a list of positive whole numbers, or null when it is anything else. */
function readIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > MAX_READ_IDS) return null;
  return value.every((id) => Number.isSafeInteger(id) && id > 0) ? [...new Set(value as number[])] : null;
}

const signInRequired = (reply: FastifyReply) => reply.code(401).send({ error: 'sign_in_required' });
const pushNotConfigured = (reply: FastifyReply) => reply.code(404).send({ error: 'push_not_configured' });

/**
 * Live stream, web push subscriptions and the alert inbox.
 *
 * The stream only carries what startRealtime() (src/realtime/index.ts) stores: it listens for
 * 'alert' and 'scan' on the bus. The app's own code never passes `opts`; tests do.
 */
export async function register(app: FastifyInstance, ctx: RouteContext, opts: RealtimeRouteOptions = {}): Promise<void> {
  const mode = opts.mode ?? realtimeMode();
  if (mode === 'poll') registerPollMode(app, opts.pollMs ?? pollInterval());
  else registerStream(app, ctx, opts);
  registerPushAndInbox(app, ctx, opts.pushSender);
}

/**
 * Poll mode: the stream answers 404 stream_off with how often to poll instead. It answers before any
 * sign-in check: it reveals nothing, and the app learns the mode with a single request.
 * (The bus is not listened to at all: nothing would be there to hear it.)
 */
function registerPollMode(app: FastifyInstance, pollMs: number): void {
  app.get('/api/stream', { exposeHeadRoute: false }, async (_req, reply) =>
    reply.code(404).header('cache-control', 'no-store').send({ error: 'stream_off', pollMs }));
}

function registerStream(app: FastifyInstance, ctx: RouteContext, opts: RealtimeRouteOptions): void {
  const { db } = ctx;
  const maxStreams = opts.maxStreams ?? (ctx.config.authMode === 'single' ? MAX_STREAMS_SINGLE : MAX_STREAMS_PER_ACCOUNT);

  const hub = createStreamHub({ now: ctx.now, pingMs: opts.pingMs });
  const offs = [
    ctx.bus.on('alert', (e) => hub.alert(e.profileId, e.alert)),
    ctx.bus.on('scan', (e) => hub.scan(e.report)),
  ];
  // preClose, not onClose: open streams would keep the server from closing.
  app.addHook('preClose', async () => {
    for (const off of offs) off();
    hub.close();
  });

  // No HEAD twin: a HEAD request would open a stream that never ends.
  app.get('/api/stream', { exposeHeadRoute: false }, async (req, reply) => {
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    const profileId = id.profile.id;
    const owner = id.account?.id ?? singleOwnerId(profileId);
    if (hub.count(owner) >= maxStreams) {
      return reply.code(429).send({ error: 'too_many_streams', message: `At most ${maxStreams} live connections at once. Close another tab or device.` });
    }
    // A browser's EventSource sends the header by itself when it reconnects; a fetch()-based reader
    // (needed when the access code is on: EventSource cannot send headers) sets either.
    const since = wholeNumber(req.headers['last-event-id']) ?? wholeNumber((req.query as { lastEventId?: unknown }).lastEventId);

    reply.hijack(); // from here on we write to the socket ourselves
    const client = hub.open(reply.raw, { profileId, owner });
    try {
      if (since === undefined) {
        hub.start(client, await latestAlertId(db, profileId), []);
      } else {
        const missed = await alertsAfter(db, profileId, since, REPLAY_LIMIT);
        // An id from the future (a reset database, a typo) must not stick as the cursor, or the
        // client would replay nothing ever again: fall back to the newest alert that exists.
        hub.start(client, missed.length > 0 ? since : Math.min(since, await latestAlertId(db, profileId)), missed);
      }
    } catch (err) {
      ctx.log(`stream: could not start: ${err instanceof Error ? err.message : String(err)}`);
      reply.raw.destroy();
    }
    return reply;
  });
}

/** Web push subscriptions and the alert inbox: the same in both modes (poll mode reads the inbox). */
function registerPushAndInbox(app: FastifyInstance, ctx: RouteContext, testSender?: PushSender): void {
  const { db } = ctx;
  const attempts = createAttemptLimiter(db, ctx.now, ctx.log);
  let webPush: PushSender | null = null;

  // -------------------------------------------------------------- push --

  app.get('/api/push/key', async (_req, reply) => {
    const vapid = usableVapid(ctx.config, ctx.log);
    return vapid ? { publicKey: vapid.publicKey } : pushNotConfigured(reply);
  });

  /** Who a device is registered to: the signed-in account, or the single-mode owner. Null = nobody. */
  const deviceOwner = async (req: FastifyRequest, create: boolean): Promise<{ owner: string; instantPush: boolean } | null> => {
    const id = await ctx.identify(req);
    const instantPush = featuresFor(id.plan).instantPush;
    if (id.account) return { owner: id.account.id, instantPush };
    if (ctx.config.authMode !== 'single' || !id.profile) return null;
    return { owner: create ? await ensureSingleOwner(db, id.profile) : singleOwnerId(id.profile.id), instantPush };
  };

  // Needs an account, not a profile: a device can be registered before onboarding is finished.
  app.post('/api/push/subscribe', async (req, reply) => {
    if (!usableVapid(ctx.config, ctx.log)) return pushNotConfigured(reply);
    const checked = checkSubscription((req.body as { subscription?: unknown } | null | undefined)?.subscription, ctx.config.pushHosts);
    const who = await deviceOwner(req, checked.ok);
    if (!who) return signInRequired(reply);
    if (!checked.ok && checked.reason === 'host') {
      ctx.log(`push: refused a device on ${checked.host}: not a known push service`); // the host only, never the endpoint
      return reply.code(400).send({ error: 'invalid_subscription', message: 'This browser’s push service isn’t supported. Phone alerts work in Chrome, Edge, Firefox and Safari.' });
    }
    if (!checked.ok) {
      return reply.code(400).send({ error: 'invalid_subscription', message: 'Send { subscription } as the browser gives it: an https endpoint and its p256dh and auth keys.' });
    }
    await saveSubscription(db, who.owner, checked.subscription, ctx.now());
    // Stored on every plan; instantPush says whether this plan actually buzzes the phone.
    return { ok: true, instantPush: who.instantPush };
  });

  app.delete('/api/push/subscribe', async (req, reply) => {
    const who = await deviceOwner(req, false);
    if (!who) return signInRequired(reply);
    const endpoint = (req.body as { endpoint?: unknown } | null | undefined)?.endpoint;
    if (typeof endpoint !== 'string' || endpoint === '') return reply.code(400).send({ error: 'invalid_endpoint', message: 'Send { endpoint }.' });
    await deleteSubscription(db, who.owner, endpoint);
    return { ok: true };
  });

  /**
   * "Send a test alert" (the bell, when this device is on): one notification titled "Test alert from BidSwipe" to the
   * caller's OWN devices, through the sender and the bookkeeping a real alert uses (src/realtime/index.ts
   * sendTestPush). Gated exactly like a real phone alert (pushDecision: the plan, the alerts switch, quiet hours),
   * then at most PUSH_TEST_LIMIT per account. Answers how many devices were tried and accepted, never an endpoint.
   */
  app.post('/api/push/test', async (req, reply) => {
    const vapid = usableVapid(ctx.config, ctx.log);
    if (!vapid) return pushNotConfigured(reply);
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    const gate = pushDecision(id.profile.alerts, id.plan, ctx.now());
    if (!featuresFor(id.plan).instantPush) {
      return reply.code(402).send({ error: 'premium_required', message: 'Instant phone alerts are part of BidSwipe Pro.' });
    }
    if (gate === 'off') {
      return reply.code(409).send({ error: 'push_off', message: 'Phone alerts are switched off in Settings → Alerts. Turn them on there, then send the test.' });
    }
    if (gate === 'hold') {
      return reply.code(409).send({ error: 'quiet_hours', message: 'It’s your quiet hours (Settings → Alerts), so phone alerts wait until they end. Send the test after that.' });
    }
    const owner = id.account?.id ?? singleOwnerId(id.profile.id);
    const counted = await attempts.count([{ key: `push:test:${owner}`, ...PUSH_TEST_LIMIT }]);
    if (!counted.ok) return reply.code(429).header('retry-after', counted.retryAfterSec).send({ error: 'too_many_attempts', message: TESTED_TOO_OFTEN });
    const sender = testSender ?? (webPush ??= createWebPushSender(vapid));
    const { tried, accepted } = await sendTestPush(ctx, id.profile.id, owner, sender);
    return { ok: true, tried, accepted };
  });

  // ------------------------------------------------------------- inbox --

  // Local jobs settle lazily (no timers on the serverless host). The alert poll is what an open app calls every
  // minute, so it settles too: a winner then hears "You won" at the next poll after closing, not when someone
  // happens to open a jobs screen (or at the daily tick). Accounts mode only; single mode has no marketplace.
  let jobsDeps: JobsDeps | null = null;
  const settleJobs = async (): Promise<void> => {
    if (ctx.config.authMode !== 'accounts') return;
    jobsDeps ??= { db, bus: ctx.bus, rules: loadJobRules(env), appUrl: ctx.config.appUrl, log: ctx.log };
    const settled = await settleDue(jobsDeps, ctx.now().getTime());
    // An award raises pushes on a short timer; send them before answering (a serverless function freezes then).
    if (settled.closed || settled.ended) await ctx.realtime?.flush();
  };

  app.get('/api/alerts', async (req, reply) => {
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    await settleJobs();
    const q = req.query as { unread?: unknown; limit?: unknown; before?: unknown };
    const items = await listAlerts(db, id.profile.id, {
      unread: q.unread === '1' || q.unread === 'true', limit: wholeNumber(q.limit), before: wholeNumber(q.before),
    });
    // lastScan: when the last scan finished. A polling app reloads its feed when this changes, the way a
    // streaming app does on the stream's 'scan' event (most new fits raise no alert, so alerts alone miss them).
    return { items, unread: await countUnread(db, id.profile.id), lastScan: await lastScanAt(db) };
  });

  app.post('/api/alerts/read', async (req, reply) => {
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    const body = (req.body ?? {}) as { ids?: unknown; all?: unknown };
    const ids = body.all === true ? 'all' : readIds(body.ids);
    if (!ids) return reply.code(400).send({ error: 'invalid_ids', message: `Send { ids: [alert ids] } (at most ${MAX_READ_IDS}) or { all: true }.` });
    const updated = await markAlertsRead(db, id.profile.id, ids, ctx.now());
    return { ok: true, updated, unread: await countUnread(db, id.profile.id) };
  });
}
