/**
 * Web push (the "web-push" package, VAPID keys from the environment via AppConfig.vapid).
 *
 * Push is simply off when the keys are not configured: no sender is built and GET /api/push/key
 * answers 404. Subscription endpoints and keys are capabilities — nothing in here logs them.
 */
import { createHash } from 'node:crypto';
import { generateRequestDetails, getVapidHeaders, sendNotification, type RequestOptions, type Urgency } from 'web-push';
import type { AppConfig } from '../context.js';
import type { StoredSubscription } from '../db/alerts.js';
import type { Alert, AlertKind } from '../types.js';

export type Vapid = NonNullable<AppConfig['vapid']>;

// ---------------------------------------------------------------- config --

const checked = new WeakMap<AppConfig, Vapid | null>();

/**
 * The VAPID details when push can actually work, else null. Keys that are set but unusable (wrong
 * length, or a subject that is not an https: URL or a mailto: address — push services reject those)
 * turn push off with one log line instead of failing every send later.
 */
export function usableVapid(config: AppConfig, log: (msg: string) => void = () => {}): Vapid | null {
  let vapid = checked.get(config);
  if (vapid === undefined) {
    vapid = config.vapid ?? null;
    if (vapid) {
      try {
        // web-push validates all three values when it signs a header; nothing is sent.
        getVapidHeaders('https://push.invalid', vapid.subject, vapid.publicKey, vapid.privateKey, 'aes128gcm');
      } catch (err) {
        // The messages name the problem (and the subject), never a key.
        log(`push is off: ${err instanceof Error ? err.message : String(err)} (check VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT or CONTACT_EMAIL)`);
        vapid = null;
      }
    }
    checked.set(config, vapid);
  }
  return vapid;
}

// ---------------------------------------------------------- subscription --

const B64URL = /^[A-Za-z0-9_-]+$/;
const decodedLength = (value: unknown): number => (typeof value === 'string' && B64URL.test(value) ? Buffer.from(value, 'base64url').length : -1);

/**
 * A browser PushSubscription (its toJSON()) → what we store, or null when it is not one. The server
 * will POST to the endpoint, so it has to be a plain public https URL: no credentials, no odd port,
 * no IP literal or internal name.
 */
export function parseSubscription(input: unknown): StoredSubscription | null {
  if (typeof input !== 'object' || input === null) return null;
  const { endpoint, keys } = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } | null };
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || typeof keys !== 'object' || keys === null) return null;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  const host = url.hostname;
  const publicHost = host.includes('.') && !/^[\d.]+$/.test(host) && !host.startsWith('[') && !/\.(local|localhost|internal|lan|home|test|invalid)$/.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !publicHost) return null;

  // p256dh is an uncompressed P-256 point (65 bytes); auth is the 16-byte secret.
  const authLength = decodedLength(keys.auth);
  if (decodedLength(keys.p256dh) !== 65 || authLength < 16 || authLength > 64) return null;
  return { endpoint, keys: { p256dh: keys.p256dh as string, auth: keys.auth as string } };
}

// --------------------------------------------------------------- payload --

/**
 * What the service worker receives (JSON). `tag` lets a repeat replace the notification instead of
 * stacking; `url` opens the app; `bidId` is set when the notification is about one bid.
 */
export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  kind: AlertKind | 'summary';
  url: string;
  bidId: string | null;
  alertIds: number[];
}

export interface PushMessage {
  /** JSON of a PushPayload, at most MAX_PAYLOAD_BYTES. */
  payload: string;
  /** Seconds the push service keeps the message for a phone that is off. */
  ttl: number;
  urgency: Urgency;
  /** The push service replaces an undelivered message with the same topic (a retry never doubles up). */
  topic: string;
}

/**
 * Push services must accept 4096 bytes after encryption (RFC 8030); aes128gcm adds about 100.
 * 3000 leaves room and is far more than a title and two lines need.
 */
export const MAX_PAYLOAD_BYTES = 3000;

const HOUR = 3600;
/** A reminder that arrives a day late is wrong, so deadlines expire quickly. */
const TTL: Record<AlertKind, number> = { match: 24 * HOUR, deadline: 4 * HOUR, award: 24 * HOUR, price: 24 * HOUR };
const URGENCY: Record<AlertKind, Urgency> = { match: 'high', deadline: 'high', award: 'normal', price: 'low' };
const URGENCY_ORDER: Urgency[] = ['very-low', 'low', 'normal', 'high'];

const SUMMARY_NOUN: Record<AlertKind, string> = { match: 'new bids fit', deadline: 'deadlines coming up', award: 'awards posted', price: 'price moves' };

/** Half the text, cut on a character boundary, with the cut marked. */
function halve(text: string): string {
  const chars = [...text];
  return chars.length < 2 ? '' : `${chars.slice(0, Math.floor(chars.length / 2) - 1).join('')}…`;
}

/** JSON within the size limit: the body is cut first, then the title. Sizes are bytes, not characters. */
function encode(payload: PushPayload): string {
  let out = payload;
  for (const field of ['body', 'title'] as const) {
    while (Buffer.byteLength(JSON.stringify(out)) > MAX_PAYLOAD_BYTES && out[field] !== '') out = { ...out, [field]: halve(out[field]) };
  }
  return JSON.stringify(out);
}

/**
 * One notification for one or more alerts of a profile (oldest first). Several at once — a scan
 * that found three bids, or everything held overnight — are summed up instead of buzzing in a row.
 */
export function pushMessage(alerts: Alert[], appUrl: string): PushMessage {
  const [first] = alerts;
  if (!first) throw new Error('pushMessage needs at least one alert');
  const kinds = [...new Set(alerts.map((a) => a.kind))];
  const one = alerts.length === 1;
  const tag = one ? `${first.kind}:${first.dedupeKey}`.slice(0, 200) : `summary:${alerts.at(-1)!.id}`;
  const payload: PushPayload = {
    title: one ? first.title : `${alerts.length} ${kinds.length === 1 ? SUMMARY_NOUN[first.kind] : 'new alerts'}`,
    body: one ? first.body : [...alerts.slice(0, 3).map((a) => a.title), ...(alerts.length > 3 ? [`+${alerts.length - 3} more`] : [])].join('\n'),
    tag,
    kind: one ? first.kind : 'summary',
    url: `${appUrl}/`,
    bidId: one ? first.bidId : null,
    alertIds: alerts.map((a) => a.id).slice(0, 50),
  };
  return {
    payload: encode(payload),
    ttl: Math.min(...kinds.map((k) => TTL[k] ?? 24 * HOUR)),
    urgency: URGENCY_ORDER[Math.max(...kinds.map((k) => URGENCY_ORDER.indexOf(URGENCY[k] ?? 'normal')))]!,
    topic: createHash('sha256').update(tag).digest('base64url').slice(0, 32),
  };
}

// ---------------------------------------------------------------- sender --

export type PushResult =
  | { ok: true }
  /** gone = the push service says the subscription no longer exists (404 / 410): delete it. */
  | { ok: false; gone: boolean; status: number | null };

/** Delivers one message to one device. Injectable, so tests never touch a push service. */
export type PushSender = (target: StoredSubscription, message: PushMessage) => Promise<PushResult>;

const SEND_TIMEOUT_MS = 10_000;

const requestOptions = (vapid: Vapid, message: PushMessage): RequestOptions => ({
  vapidDetails: vapid, TTL: message.ttl, urgency: message.urgency, topic: message.topic, timeout: SEND_TIMEOUT_MS,
});

/** The exact request web-push would make, without sending it (tests check size and headers). */
export function buildPushRequest(vapid: Vapid, target: StoredSubscription, message: PushMessage) {
  return generateRequestDetails(target, message.payload, requestOptions(vapid, message));
}

/** A failed send → what to do about it. Anything that is not a push-service status is a plain failure. */
export function toPushResult(err: unknown): PushResult {
  const status = typeof err === 'object' && err !== null && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : null;
  return { ok: false, gone: status === 404 || status === 410, status };
}

export function createWebPushSender(vapid: Vapid): PushSender {
  return async (target, message) => {
    try {
      await sendNotification(target, message.payload, requestOptions(vapid, message));
      return { ok: true };
    } catch (err) {
      return toPushResult(err);
    }
  };
}
