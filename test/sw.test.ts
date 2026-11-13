/**
 * web/sw.js, run in a vm sandbox with a fake `self`, `caches` and `fetch`: which requests it answers,
 * that /api is never cached, the offline page, cache clean-up on activate, and the push handlers.
 * Everything here is synthetic (example.com / TEST- ids).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const SW = readFileSync(fileURLToPath(new URL('../web/sw.js', import.meta.url)), 'utf8');
const ORIGIN = 'https://app.example.com';

type Handler = (event: any) => void;

function loadWorker(network: (req: Request) => Promise<Response>) {
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, Map<string, Response>>();
  const puts: string[] = [];
  const notifications: Array<{ title: string; opts: any }> = [];
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        add: async (req: Request) => { store.set(new URL(req.url, `${ORIGIN}/`).href, new Response('shell')); },
        put: async (req: Request, res: Response) => { puts.push(req.url); store.set(req.url, res); },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (req: Request) => {
      for (const s of stores.values()) if (s.has(req.url)) return s.get(req.url);
      return undefined;
    },
  };
  const self = {
    location: { origin: ORIGIN },
    registration: { scope: `${ORIGIN}/`, showNotification: async (title: string, opts: any) => void notifications.push({ title, opts }) },
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
    skipWaiting: async () => {},
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
  };
  // Request in the sandbox resolves relative URLs against the app's origin, as in a worker.
  class SandboxRequest extends Request {
    constructor(input: string | Request, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, `${ORIGIN}/`).href : input, init);
    }
  }
  runInNewContext(SW, { self, caches, fetch: network, Request: SandboxRequest, Response, URL, Promise, console });
  return { handlers, stores, puts, notifications };
}

/** Fire a fetch event; resolves to the response the worker gave, or 'skipped' if it left the request alone. */
async function fire(worker: ReturnType<typeof loadWorker>, url: string, init: { method?: string; mode?: RequestMode } = {}) {
  const request = new Request(url, { method: init.method ?? 'GET' });
  if (init.mode) Object.defineProperty(request, 'mode', { value: init.mode });
  let answer: Promise<Response> | null = null;
  const later: Promise<unknown>[] = [];
  worker.handlers.get('fetch')!({ request, respondWith: (p: Promise<Response>) => { answer = p; }, waitUntil: (p: Promise<unknown>) => later.push(p) });
  if (!answer) return 'skipped' as const;
  const res = await answer;
  await Promise.all(later);
  return res as Response;
}

/** What a browser's same-origin fetch gives: a 200 whose type is 'basic' (a constructed Response says 'default'). */
const ok = (body = 'ok') => async () => Object.defineProperty(new Response(body, { status: 200 }), 'type', { value: 'basic' });
const offline = async (): Promise<Response> => { throw new TypeError('Failed to fetch'); };

describe('web/sw.js fetch routing', () => {
  it('never touches /api, other origins or non-GET requests', async () => {
    const w = loadWorker(ok());
    for (const url of [`${ORIGIN}/api/feed`, `${ORIGIN}/api/stream`, `${ORIGIN}/api`, 'https://sam.example.com/x.js']) {
      expect(await fire(w, url), url).toBe('skipped');
    }
    expect(await fire(w, `${ORIGIN}/styles.css`, { method: 'POST' })).toBe('skipped');
    expect(w.puts).toEqual([]);
  });

  it('keeps a copy of app files (network first) but never of pages or /api answers', async () => {
    const w = loadWorker(ok('body{}'));
    const res = await fire(w, `${ORIGIN}/styles.css`);
    expect(res).not.toBe('skipped');
    expect(await (res as Response).text()).toBe('body{}');
    await fire(w, `${ORIGIN}/`, { mode: 'navigate' });
    await fire(w, `${ORIGIN}/api/alerts?limit=50`);
    expect(w.puts).toEqual([`${ORIGIN}/styles.css`]);
  });

  it('offline: a page load gets the offline page, an app file comes from the cache', async () => {
    let net: (r: Request) => Promise<Response> = ok('cached css');
    const w = loadWorker((r) => net(r));
    await fire(w, `${ORIGIN}/styles.css`); // online once: copy kept
    net = offline;

    const page = (await fire(w, `${ORIGIN}/`, { mode: 'navigate' })) as Response;
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    const html = await page.text();
    expect(html).toContain('You’re offline');
    expect(html).toContain('needs an internet connection to load fresh bids');

    expect(await ((await fire(w, `${ORIGIN}/styles.css`)) as Response).text()).toBe('cached css');
    await expect(fire(w, `${ORIGIN}/js/never-seen.js`)).rejects.toThrow('Failed to fetch');
  });
});

describe('web/sw.js install and activate', () => {
  it('precaches the shell under a versioned name and deletes older bidswipe caches on activate', async () => {
    const w = loadWorker(ok());
    const name = /const SHELL_VERSION = '([^']+)'/.exec(SW)?.[1];
    expect(name).toBeTruthy();
    const waits: Promise<unknown>[] = [];
    w.handlers.get('install')!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect([...w.stores.keys()]).toEqual([`bidswipe-shell-${name}`]);
    expect([...w.stores.get(`bidswipe-shell-${name}`)!.keys()]).toContain(`${ORIGIN}/index.html`);

    w.stores.set('bidswipe-shell-old', new Map());
    w.stores.set('someone-else', new Map());
    w.handlers.get('activate')!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect([...w.stores.keys()].sort()).toEqual([`bidswipe-shell-${name}`, 'someone-else']);
  });
});

describe('web/sw.js push', () => {
  it('shows the alert with PNG icons and keeps only the bid id', async () => {
    const w = loadWorker(ok());
    const waits: Promise<unknown>[] = [];
    const payload = { title: 'Great fit (82) · TEST town', body: 'TEST job (synthetic)', tag: 'match', bidId: 'samgov:TEST-1', url: 'https://evil.example.com' };
    w.handlers.get('push')!({ data: { json: () => payload, text: () => JSON.stringify(payload) }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(w.notifications).toEqual([{
      title: payload.title,
      opts: { body: payload.body, tag: 'match', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', data: { bidId: 'samgov:TEST-1' } },
    }]);
  });

  it('a payload that is not JSON still shows as text under the app name', async () => {
    const w = loadWorker(ok());
    const waits: Promise<unknown>[] = [];
    w.handlers.get('push')!({ data: { json: () => { throw new Error('not json'); }, text: () => 'plain words' }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(w.notifications[0]).toMatchObject({ title: 'BidSwipe', opts: { body: 'plain words' } });
  });
});
