/**
 * One simulated person's phone: real HTTP to the local server, the session cookie it sets, the x-bidswipe
 * header on every write (web/js/api.js does the same). Unlike src/sim/http.ts it keeps the RAW answer text,
 * because the privacy checks search the exact bytes a person received, not a parsed copy of them.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';

export interface Answer<T = any> {
  status: number;
  body: T;
  text: string;
}

/** Every answer any simulated person received, as it was received. */
export interface Received {
  who: string;
  /** The simulation clock when it was answered. */
  t: number;
  method: string;
  path: string;
  status: number;
  text: string;
  /** Wall time of the request on this machine (measurements only, never in the report). */
  ms: number;
}

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class Phone {
  private cookie = '';

  constructor(
    private readonly port: number,
    /** The person's key (P01, W07…), or 'operator' / 'cron'. */
    readonly who: string,
    private readonly forwardedFor: string,
    private readonly clock: () => number,
    private readonly sink: (r: Received) => void,
    private readonly extra: Record<string, string> = {},
  ) {}

  async call<T = any>(method: string, path: string, body?: unknown): Promise<Answer<T>> {
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
    let parsed: unknown = null;
    try {
      parsed = res.text ? JSON.parse(res.text) : null;
    } catch {
      parsed = res.text;
    }
    this.sink({ who: this.who, t: this.clock(), method, path, status: res.status, text: res.text, ms });
    return { status: res.status, body: parsed as T, text: res.text };
  }

  get<T = any>(path: string) {
    return this.call<T>('GET', path);
  }
}
