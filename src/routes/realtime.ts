import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContext } from '../context.js';
import {
  alertsAfter, countUnread, deleteSubscription, ensureSingleOwner, latestAlertId, listAlerts, markAlertsRead,
  saveSubscription, singleOwnerId,
} from '../db/alerts.js';
import { featuresFor } from '../plans.js';
import { parseSubscription, usableVapid } from '../realtime/push.js';
import { createStreamHub, MAX_STREAMS_PER_ACCOUNT, MAX_STREAMS_SINGLE, REPLAY_LIMIT } from '../realtime/stream.js';

export interface RealtimeRouteOptions {
  /** Milliseconds between pings on /api/stream (default 25 s). */
  pingMs?: number;
  /** Open streams allowed per account (default 5; 25 for the one shared identity of single mode). */
  maxStreams?: number;
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

  // ------------------------------------------------------------ stream --

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
    const subscription = parseSubscription((req.body as { subscription?: unknown } | null | undefined)?.subscription);
    const who = await deviceOwner(req, subscription !== null);
    if (!who) return signInRequired(reply);
    if (!subscription) {
      return reply.code(400).send({ error: 'invalid_subscription', message: 'Send { subscription } as the browser gives it: an https endpoint and its p256dh and auth keys.' });
    }
    await saveSubscription(db, who.owner, subscription, ctx.now());
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

  // ------------------------------------------------------------- inbox --

  app.get('/api/alerts', async (req, reply) => {
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    const q = req.query as { unread?: unknown; limit?: unknown; before?: unknown };
    const items = await listAlerts(db, id.profile.id, {
      unread: q.unread === '1' || q.unread === 'true', limit: wholeNumber(q.limit), before: wholeNumber(q.before),
    });
    return { items, unread: await countUnread(db, id.profile.id) };
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
