// BidSwipe service worker: phone/desktop alerts (web push) and a plain offline page.
//
// What it does with requests (see route() below):
//   /api/…            never touched: always the network, never cached. Bids, alerts and prices must be fresh.
//   other servers     never touched (sign-in providers, the agencies' own sites).
//   page loads        network first. No connection: a short page that says the app needs one for fresh bids.
//   app files         network first (css, js, icons); a copy is kept so a flaky connection still draws the
//                     app. Online, the newest file always wins, so a deploy is never hidden behind a stale cache.
//
// SHELL_VERSION names the cache. Bump it when the list in SHELL changes or the offline page changes:
// the new worker installs beside the old one, and on activate every cache with another name is deleted.
// (Changing any byte of this file is what makes the browser install the new worker.)
//
// The push payload is what src/realtime/push.ts pushMessage() sends: { title, body, tag, kind, url, bidId, alertIds }.

const SHELL_VERSION = '2026-11-14.1';
const CACHE = `bidswipe-shell-${SHELL_VERSION}`;
const SHELL = ['./', 'index.html', 'styles.css', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'icons/icon-192.png'];

const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0a0d12"><title>BidSwipe — offline</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; }
  body { display: grid; place-items: center; background: #0a0d12; color: #e6edf5;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 24px; box-sizing: border-box; }
  main { max-width: 360px; text-align: center; }
  svg { width: 64px; height: 64px; }
  h1 { font-size: 21px; margin: 18px 0 8px; letter-spacing: -0.01em; }
  p { margin: 0 0 20px; color: #9aa7b6; font-size: 15px; }
  button { font: inherit; font-weight: 700; border: 0; border-radius: 14px; padding: 12px 22px; background: #ffd43b; color: #0a0d12; cursor: pointer; }
</style></head>
<body><main>
  <svg viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="112" fill="#1c2430"/><path d="M282 72 98 300h130l-18 140 184-244H264z" fill="#ffd43b"/></svg>
  <h1>You’re offline</h1>
  <p>BidSwipe needs an internet connection to load fresh bids and alerts. Nothing is lost — your saved bids are on our server.</p>
  <button type="button" onclick="location.reload()">Try again</button>
</main></body></html>`;

/** 'skip' = let the browser do what it would without us; 'page' / 'asset' = handled below. */
function route(request) {
  if (request.method !== 'GET') return 'skip';
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return 'skip';
  const scope = new URL(self.registration.scope);
  const path = url.pathname.startsWith(scope.pathname) ? url.pathname.slice(scope.pathname.length) : url.pathname.replace(/^\//, '');
  if (path === 'api' || path.startsWith('api/')) return 'skip';
  if (request.mode === 'navigate') return 'page';
  return 'asset';
}

const offlinePage = () => new Response(OFFLINE_HTML, {
  // 200, not 503: some installers and checkers load the start page offline and treat any error code as "no offline support".
  status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
});

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One missing file must not stop the worker from installing (push would stop working with it).
    await Promise.all(SHELL.map((path) => cache.add(new Request(path, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('bidswipe-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const kind = route(event.request);
  if (kind === 'skip') return;
  event.respondWith((async () => {
    try {
      const res = await fetch(event.request);
      // Keep a copy of a good app file; never of a page (it could carry a signed-in state) or an error.
      if (kind === 'asset' && res.ok && res.type === 'basic') {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {}));
      }
      return res;
    } catch (err) {
      if (kind === 'page') return offlinePage();
      const cached = await caches.match(event.request);
      if (cached) return cached;
      throw err;
    }
  })());
});

// ------------------------------------------------------------------ push --

self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch { p = { body: event.data ? event.data.text() : '' }; }
  const title = typeof p.title === 'string' && p.title ? p.title : 'BidSwipe';
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof p.body === 'string' ? p.body : '',
    tag: typeof p.tag === 'string' ? p.tag : undefined,
    // PNG: Windows and Android do not draw SVG notification icons.
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    // jobId only on a local job's alert, so a bid's notification data stays { bidId } as before.
    data: jobIdFrom(p) ? { bidId: null, jobId: jobIdFrom(p) } : { bidId: typeof p.bidId === 'string' ? p.bidId : null },
  }));
});

/**
 * A local job alert's payload carries url …/?job=<id>. Only the id is taken from it (checked to be a plain id);
 * the address that opens is always built here, never the payload's.
 */
function jobIdFrom(p) {
  if (typeof p.kind !== 'string' || !p.kind.startsWith('job_') || typeof p.url !== 'string') return null;
  try {
    const id = new URL(p.url).searchParams.get('job');
    return id && /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null;
  } catch { return null; }
}

// Open the app on the bid or the local job. The address is always this app's own (never a URL from the payload).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const bidId = event.notification.data?.bidId ?? null;
  const jobId = event.notification.data?.jobId ?? null;
  const target = new URL(jobId ? `./?job=${encodeURIComponent(jobId)}` : bidId ? `./?bid=${encodeURIComponent(bidId)}` : './', self.registration.scope).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = open.find((c) => c.url.startsWith(self.registration.scope));
    if (app) {
      await app.focus();
      app.postMessage(jobId ? { type: 'open-job', jobId } : { type: 'open-bid', bidId });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
