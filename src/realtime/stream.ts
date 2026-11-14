/**
 * The live stream behind GET /api/stream (Server-Sent Events): who is connected, and what goes down
 * the wire. One hub per server; the route plugin feeds it from the bus.
 *
 *   : connected                      a comment as soon as the stream opens
 *   retry: 5000                      browsers reconnect after 5 s
 *
 *   event: match | deadline | award | price     an alert, exactly as GET /api/alerts returns it
 *   id: 42                                       the alert's id
 *   data: {"id":42,"kind":"match","title":"…","body":"…","data":{"bidId":"…","score":82,"url":"…"},…}
 *
 *   event: scan                      a scan finished: { finishedAt, totalBids, newBids, profile }
 *   event: ping                      every 25 s, so proxies keep the connection open: { at }
 *
 * Every event carries `id:` — the id of the newest alert this connection has been sent — so a client
 * that reconnects with Last-Event-ID gets exactly the alerts it missed, replayed from the inbox.
 */
import type { ServerResponse } from 'node:http';
import type { ScanReport } from '../scan.js';
import type { Alert } from '../types.js';

export const PING_MS = 25_000;
/** Phone, laptop and a few forgotten tabs. */
export const MAX_STREAMS_PER_ACCOUNT = 5;
/** Single mode has no accounts: the whole shop shares one identity, so the cap is the shop's. */
export const MAX_STREAMS_SINGLE = 25;
/** Alerts replayed to a client that reconnects; anything older is in the inbox. */
export const REPLAY_LIMIT = 100;
/** A client that stops reading is dropped once this much is queued for it. */
const MAX_QUEUED_BYTES = 1_000_000;

export function sseFrame(event: string, id: number, data: unknown): string {
  // JSON.stringify never emits a raw line break, so the data is always one line.
  return `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** One open connection, as the route sees it. */
export interface StreamClient {
  readonly profileId: string;
  /** What the connection cap counts by: the account id, or the single-mode owner. */
  readonly owner: string;
}

interface Client extends StreamClient {
  res: ServerResponse;
  /** Id of the newest alert sent on this connection (or the one the client said it already has). */
  cursor: number;
  /** Alerts that arrived while the replay was being read; null once the client is live. */
  backlog: Alert[] | null;
}

export interface StreamHub {
  /** Open connections for an owner. */
  count(owner: string): number;
  /** Take over a response: send the headers and the opening comment, and start collecting its alerts. */
  open(res: ServerResponse, who: StreamClient): StreamClient;
  /** Go live: `missed` (oldest first) is replayed, then whatever arrived in the meantime. */
  start(client: StreamClient, cursor: number, missed: Alert[]): void;
  /** An alert was stored for a profile. */
  alert(profileId: string, alert: Alert): void;
  /** A scan finished. Each client hears the totals and its own profile's numbers, nobody else's. */
  scan(report: ScanReport): void;
  /** End every open stream of one owner (their sessions were ended). Returns how many were closed. */
  closeOwner(owner: string): number;
  /** End every stream and stop pinging. */
  close(): void;
}

export function createStreamHub(opts: { now?: () => Date; pingMs?: number } = {}): StreamHub {
  const now = opts.now ?? (() => new Date());
  const byProfile = new Map<string, Set<Client>>();
  const perOwner = new Map<string, number>();

  const everyone = function* (): Generator<Client> {
    for (const set of byProfile.values()) yield* set;
  };

  function write(c: Client, event: string, data: unknown, id = 0): void {
    if (id > c.cursor) c.cursor = id;
    if (c.res.destroyed || c.res.writableEnded) return;
    c.res.write(sseFrame(event, c.cursor, data));
    if (c.res.writableLength > MAX_QUEUED_BYTES) c.res.destroy();
  }

  const writeAlert = (c: Client, alert: Alert): void => write(c, /^[a-z]+$/.test(alert.kind) ? alert.kind : 'alert', alert, alert.id);

  function remove(c: Client): void {
    const set = byProfile.get(c.profileId);
    if (!set?.delete(c)) return;
    if (set.size === 0) byProfile.delete(c.profileId);
    const left = (perOwner.get(c.owner) ?? 1) - 1;
    if (left > 0) perOwner.set(c.owner, left);
    else perOwner.delete(c.owner);
  }

  const pinger = setInterval(() => {
    const at = now().toISOString();
    for (const c of everyone()) if (!c.backlog) write(c, 'ping', { at });
  }, opts.pingMs ?? PING_MS);
  pinger.unref();

  return {
    count: (owner) => perOwner.get(owner) ?? 0,

    open(res, who) {
      const c: Client = { profileId: who.profileId, owner: who.owner, res, cursor: 0, backlog: [] };
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no', // nginx-style proxies: do not hold events back
      });
      res.socket?.setNoDelay(true);
      res.write(': connected\nretry: 5000\n\n');

      let set = byProfile.get(c.profileId);
      if (!set) byProfile.set(c.profileId, (set = new Set()));
      set.add(c);
      perOwner.set(c.owner, (perOwner.get(c.owner) ?? 0) + 1);
      res.on('close', () => remove(c)); // the client went away, or we dropped it
      res.on('error', () => {}); // a broken pipe ends this stream ('close' follows), never the process
      return c;
    },

    start(client, cursor, missed) {
      const c = client as Client;
      const waiting = c.backlog ?? [];
      c.backlog = null;
      c.cursor = cursor;
      for (const alert of missed) writeAlert(c, alert);
      // An alert stored during the replay query is in both lists: send it once.
      const replayed = new Set(missed.map((a) => a.id));
      for (const alert of waiting) if (!replayed.has(alert.id)) writeAlert(c, alert);
    },

    alert(profileId, alert) {
      for (const c of byProfile.get(profileId) ?? []) {
        if (c.backlog) c.backlog.push(alert);
        else writeAlert(c, alert);
      }
    },

    scan(report) {
      for (const c of everyone()) {
        if (c.backlog) continue;
        const mine = report.profiles[c.profileId];
        write(c, 'scan', {
          finishedAt: report.finishedAt, totalBids: report.totalBids, newBids: report.newBids,
          profile: mine ? { scored: mine.scored, byVerdict: mine.byVerdict, newGood: mine.newGood } : null,
        });
      }
    },

    closeOwner(owner) {
      const theirs = [...everyone()].filter((c) => c.owner === owner);
      // end(): the client sees a normal end of stream, reconnects, and is answered 401 like any signed-out request.
      for (const c of theirs) c.res.end();
      return theirs.length;
    },

    close() {
      clearInterval(pinger);
      for (const c of [...everyone()]) c.res.end();
    },
  };
}
