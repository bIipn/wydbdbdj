/**
 * The simulated companies talk to the server the way the web app does: real HTTP on a local port, the
 * session cookie the server sets, and the x-bidswipe header on every write (web/js/api.js). Plain node:http,
 * so no proxy setting can send a local request anywhere else.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

export interface SimResponse<T = unknown> {
  status: number;
  body: T;
  /** Wall time of the request on this machine, milliseconds. */
  ms: number;
}

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class SimClient {
  private cookie = '';

  /** `forwardedFor`: the simulated caller's address (documentation range), so each company is its own client. */
  constructor(private readonly port: number, private readonly forwardedFor: string, private readonly extra: Record<string, string> = {}) {}

  get session(): string {
    return this.cookie;
  }

  async call<T = any>(method: string, path: string, body?: unknown): Promise<SimResponse<T>> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { 'x-forwarded-for': this.forwardedFor, ...this.extra };
    if (WRITES.has(method)) headers['x-bidswipe'] = '1';
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    if (this.cookie) headers.cookie = this.cookie;
    const t0 = performance.now();
    const res = await new Promise<{ status: number; text: string; setCookie: string[] }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: this.port, method, path, headers }, (r: IncomingMessage) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), setCookie: r.headers['set-cookie'] ?? [] }));
        r.on('error', reject);
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
    const ms = performance.now() - t0;
    for (const c of res.setCookie) {
      const pair = c.split(';')[0]!;
      if (pair.startsWith('bs_session=')) this.cookie = pair === 'bs_session=' ? '' : pair;
    }
    let parsed: unknown = res.text;
    try {
      parsed = res.text ? JSON.parse(res.text) : null;
    } catch {
      // not JSON: keep the text
    }
    return { status: res.status, body: parsed as T, ms };
  }

  get<T = any>(path: string) {
    return this.call<T>('GET', path);
  }
}


/** Wall-clock milliseconds with sub-millisecond resolution, comparable across threads of this process. */
export const clockMs = (): number => performance.timeOrigin + performance.now();

export interface StreamFrame {
  event: string;
  id: number;
  data: unknown;
  /** clockMs() when the reader thread took the frame off the socket. */
  at: number;
}

export interface StreamSpec {
  key: string;
  cookie: string;
  forwardedFor: string;
}

export interface StreamReaders {
  /** Frames per stream key, in arrival order. */
  frames: Map<string, StreamFrame[]>;
  /** Resolves once every stream has its opening comment. */
  ready: Promise<void>;
  close(): Promise<void>;
}

/**
 * The reader runs in its own thread (plain JavaScript, so it needs no TypeScript loader): a scan keeps the
 * main thread busy, and a reader on that thread would only see a frame once the scan let go, which would
 * measure the simulation, not the server. Each frame is stamped with the reader's clock on arrival.
 */
const READER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const now = () => performance.timeOrigin + performance.now();
const reqs = [];
for (const s of workerData.streams) {
  let buffer = '';
  const req = http.request({ host: '127.0.0.1', port: workerData.port, method: 'GET', path: '/api/stream',
    headers: { cookie: s.cookie, accept: 'text/event-stream', 'x-forwarded-for': s.forwardedFor } }, (res) => {
    if (res.statusCode !== 200) { parentPort.postMessage({ type: 'error', key: s.key, message: 'HTTP ' + res.statusCode }); res.resume(); return; }
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      const at = now();
      buffer += chunk;
      let cut;
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (block.startsWith(':')) { parentPort.postMessage({ type: 'ready', key: s.key }); continue; }
        let event = 'message', id = 0, data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('id: ')) id = Number(line.slice(4));
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        let parsed = data;
        try { parsed = JSON.parse(data); } catch {}
        parentPort.postMessage({ type: 'frame', key: s.key, frame: { event, id, data: parsed, at } });
      }
    });
    res.on('error', () => {});
  });
  req.on('error', (e) => parentPort.postMessage({ type: 'error', key: s.key, message: e.message }));
  req.end();
  reqs.push(req);
}
parentPort.on('message', (m) => { if (m === 'close') { for (const r of reqs) r.destroy(); parentPort.close(); } });
`;

/** GET /api/stream for every company at once, read on a separate thread the way a phone would read it. */
export function openStreams(port: number, streams: StreamSpec[]): StreamReaders {
  const frames = new Map<string, StreamFrame[]>(streams.map((s) => [s.key, []]));
  const waiting = new Set(streams.map((s) => s.key));
  const worker = new Worker(READER, { eval: true, workerData: { port, streams } });
  const ready = new Promise<void>((resolve, reject) => {
    if (waiting.size === 0) resolve();
    worker.on('message', (m: { type: string; key: string; frame?: StreamFrame; message?: string }) => {
      if (m.type === 'frame') frames.get(m.key)!.push(m.frame!);
      else if (m.type === 'ready') {
        waiting.delete(m.key);
        if (waiting.size === 0) resolve();
      } else if (m.type === 'error') reject(new Error(`stream for ${m.key}: ${m.message}`));
    });
    worker.on('error', reject);
  });
  ready.catch(() => {}); // the caller awaits it; a later error must not become an unhandled rejection
  return {
    frames, ready,
    close: async () => {
      worker.postMessage('close');
      await worker.terminate();
    },
  };
}
