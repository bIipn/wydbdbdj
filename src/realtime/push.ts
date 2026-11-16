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
 * The push services a browser's endpoint may point at (audit sec-input-2: the server POSTs to the endpoint, so an
 * open "any public https host" check let an account aim those POSTs at wildcard-DNS names such as *.nip.io).
 * A host matches an entry exactly or on a dot boundary ("wns2-by3p.notify.windows.com" matches "notify.windows.com").
 *   fcm.googleapis.com                  Chrome, Android, Samsung Internet, Opera
 *   android.googleapis.com              older Chrome endpoints
 *   updates.push.services.mozilla.com   Firefox
 *   push.apple.com                      Safari and the iPhone home-screen app (web.push.apple.com)
 *   notify.windows.com                  Edge (wns2-*.notify.windows.com)
 * A browser that uses another service gets a 400 and the refused host (never the endpoint) is logged, so it can be
 * added here.
 */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  'fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'push.apple.com', 'notify.windows.com',
];

/** Lower-cased, one trailing dot dropped, then an exact or dot-boundary match against the list. */
export function isPushServiceHost(hostname: string, hosts: readonly string[] = PUSH_SERVICE_HOSTS): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.endsWith('.')) return false;
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

export type SubscriptionCheck =
  | { ok: true; subscription: StoredSubscription }
  /** host: the endpoint is a well-formed https URL on a host that is not a push service (`host` names it). */
  | { ok: false; reason: 'invalid' } | { ok: false; reason: 'host'; host: string };

/**
 * A browser PushSubscription (its toJSON()) → what we store. The server will POST to the endpoint, so it has to be
 * a plain https URL (no credentials, no odd port) on one of the push services. `hosts` is the production list; only
 * tests pass another (AppConfig.pushHosts, which loadConfig never sets).
 */
export function checkSubscription(input: unknown, hosts: readonly string[] = PUSH_SERVICE_HOSTS): SubscriptionCheck {
  const invalid = { ok: false, reason: 'invalid' } as const;
  if (typeof input !== 'object' || input === null) return invalid;
  const { endpoint, keys } = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } | null };
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || typeof keys !== 'object' || keys === null) return invalid;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return invalid;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return invalid;

  // p256dh is an uncompressed P-256 point (65 bytes); auth is the 16-byte secret.
  const authLength = decodedLength(keys.auth);
  if (decodedLength(keys.p256dh) !== 65 || authLength < 16 || authLength > 64) return invalid;
  if (!isPushServiceHost(url.hostname, hosts)) return { ok: false, reason: 'host', host: url.hostname.slice(0, 253) };
  return { ok: true, subscription: { endpoint, keys: { p256dh: keys.p256dh as string, auth: keys.auth as string } } };
}

/** checkSubscription without the reason: the subscription, or null. */
export function parseSubscription(input: unknown, hosts: readonly string[] = PUSH_SERVICE_HOSTS): StoredSubscription | null {
  const checked = checkSubscription(input, hosts);
  return checked.ok ? checked.subscription : null;
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
const TTL: Record<AlertKind, number> = {
  match: 24 * HOUR, deadline: 4 * HOUR, award: 24 * HOUR, price: 24 * HOUR,
  job_awarded: 24 * HOUR, job_message: 24 * HOUR, job_deadline: 12 * HOUR, job_closed: 24 * HOUR,
};
const URGENCY: Record<AlertKind, Urgency> = {
  match: 'high', deadline: 'high', award: 'normal', price: 'low',
  job_awarded: 'high', job_message: 'high', job_deadline: 'high', job_closed: 'normal',
};
const URGENCY_ORDER: Urgency[] = ['very-low', 'low', 'normal', 'high'];

const SUMMARY_NOUN: Record<AlertKind, string> = {
  match: 'new bids fit', deadline: 'deadlines coming up', award: 'awards posted', price: 'price moves',
  job_awarded: 'jobs awarded', job_message: 'new messages', job_deadline: 'contact reminders', job_closed: 'job updates',
};

/** A notification about one local job opens that job (web/js reads ?job=); everything else opens the app. */
function openUrl(alert: Alert, appUrl: string): string {
  const jobId = alert.kind.startsWith('job_') ? alert.data.jobId : undefined;
  return typeof jobId === 'string' && jobId ? `${appUrl}/?job=${encodeURIComponent(jobId)}` : `${appUrl}/`;
}

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

/** Kinds whose title is a label ("Due in 2 days · Wed 2:00 PM", "Good fit (72) · Napa"): the bid is named in the body. */
const LABEL_TITLE: ReadonlySet<AlertKind> = new Set(['match', 'deadline']);
/** Longest line of a summary body, in characters (a Lock Screen shows about this much per line). */
const SUMMARY_LINE = 80;

const clipLine = (text: string, max = SUMMARY_LINE): string => {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
};

/**
 * One line of a summary. A label title alone would read the same for two deadlines on one day ("Due in 2 days ·
 * Wed 2:00 PM" twice, audit notif-summary-1), so those kinds add what the alert is about: the body up to its first
 * " — " (the bid's title), clipped.
 */
function summaryLine(alert: Alert): string {
  if (!LABEL_TITLE.has(alert.kind)) return clipLine(alert.title);
  const subject = alert.body.split(' — ')[0]?.trim();
  return clipLine(subject ? `${alert.title} — ${subject}` : alert.title);
}

/**
 * One notification for one or more alerts of a profile (oldest first). Several at once — a scan
 * that found three bids, or everything held overnight — are summed up instead of buzzing in a row:
 * up to three lines that each name their bid or job, then "+N more".
 */
export function pushMessage(alerts: Alert[], appUrl: string): PushMessage {
  const [first] = alerts;
  if (!first) throw new Error('pushMessage needs at least one alert');
  const kinds = [...new Set(alerts.map((a) => a.kind))];
  const one = alerts.length === 1;
  const tag = one ? `${first.kind}:${first.dedupeKey}`.slice(0, 200) : `summary:${alerts.at(-1)!.id}`;
  const payload: PushPayload = {
    title: one ? first.title : `${alerts.length} ${kinds.length === 1 ? SUMMARY_NOUN[first.kind] : 'new alerts'}`,
    body: one ? first.body : [...alerts.slice(0, 3).map(summaryLine), ...(alerts.length > 3 ? [`+${alerts.length - 3} more`] : [])].join('\n'),
    tag,
    kind: one ? first.kind : 'summary',
    url: one ? openUrl(first, appUrl) : `${appUrl}/`,
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
  /**
   * gone = the push service says the subscription no longer exists (404 / 410): delete it.
   * permanent = it refused the request itself (400, 403, 413: a bad or rotated VAPID key, a malformed request, a
   * payload too large): sending the same again cannot work, so the device is not sent to until it re-subscribes.
   * reason = the service's own word for it when it gave one (Apple answers JSON { reason }), never the endpoint.
   */
  | { ok: false; gone: boolean; status: number | null; permanent?: true; reason?: string };

/** Delivers one message to one device. Injectable, so tests never touch a push service. */
export type PushSender = (target: StoredSubscription, message: PushMessage) => Promise<PushResult>;

const SEND_TIMEOUT_MS = 10_000;

/**
 * VAPID Authorization headers, one per push-service origin (scheme + host: the JWT's audience), reused for
 * VAPID_REUSE_MS. web-push signed a new token for every request; Apple asks for at most one new token per hour
 * ("Don't refresh your JWT more frequently than once per hour", audit ios-jwt-1). Each token is valid 12 hours
 * (VAPID_TOKEN_SEC) and reused for 2 of them: well inside its life, never across origins (FCM, Mozilla and Apple
 * each need their own audience).
 */
export const VAPID_REUSE_MS = 2 * 60 * 60 * 1000;
const VAPID_TOKEN_SEC = 12 * 60 * 60;

export interface VapidCache {
  /** The Authorization header for this endpoint's push service. */
  authorization(endpoint: string): string;
}

export function createVapidCache(vapid: Vapid, now: () => number = Date.now): VapidCache {
  const cache = new Map<string, { header: string; until: number }>();
  return {
    authorization(endpoint) {
      const { protocol, host } = new URL(endpoint);
      const audience = `${protocol}//${host}`;
      const at = now();
      const hit = cache.get(audience);
      if (hit && hit.until > at) return hit.header;
      const exp = Math.floor(at / 1000) + VAPID_TOKEN_SEC;
      const header = getVapidHeaders(audience, vapid.subject, vapid.publicKey, vapid.privateKey, 'aes128gcm', exp).Authorization;
      cache.set(audience, { header, until: at + VAPID_REUSE_MS });
      return header;
    },
  };
}

/** The send options: the cached VAPID header passed as a plain header, so web-push signs nothing itself. */
const requestOptions = (vapid: Vapid, message: PushMessage, authorization: string): RequestOptions => ({
  vapidDetails: null, headers: { Authorization: authorization },
  TTL: message.ttl, urgency: message.urgency, topic: message.topic, timeout: SEND_TIMEOUT_MS,
} as unknown as RequestOptions);

/** The exact request web-push would make, without sending it (tests check size and headers). */
export function buildPushRequest(vapid: Vapid, target: StoredSubscription, message: PushMessage, vapidCache: VapidCache = createVapidCache(vapid)) {
  return generateRequestDetails(target, message.payload, requestOptions(vapid, message, vapidCache.authorization(target.endpoint)));
}

/** A push service's refusal that sending again cannot fix. */
const PERMANENT = new Set([400, 403, 413]);

/** A failed send → what to do about it. Anything that is not a push-service status is a plain failure. */
export function toPushResult(err: unknown): PushResult {
  const status = typeof err === 'object' && err !== null && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : null;
  let reason: string | undefined;
  const body = typeof err === 'object' && err !== null && 'body' in err && typeof err.body === 'string' ? err.body : '';
  try {
    const parsed = body ? (JSON.parse(body) as { reason?: unknown }) : null;
    if (parsed && typeof parsed.reason === 'string' && /^[\w .-]{1,80}$/.test(parsed.reason)) reason = parsed.reason;
  } catch { /* not JSON: no reason */ }
  return {
    ok: false, gone: status === 404 || status === 410, status,
    ...(status !== null && PERMANENT.has(status) ? { permanent: true as const } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function createWebPushSender(vapid: Vapid, now: () => number = Date.now): PushSender {
  const vapidCache = createVapidCache(vapid, now);
  return async (target, message) => {
    try {
      await sendNotification(target, message.payload, requestOptions(vapid, message, vapidCache.authorization(target.endpoint)));
      return { ok: true };
    } catch (err) {
      return toPushResult(err);
    }
  };
}
