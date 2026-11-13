// BidSwipe service worker: phone alerts only (no offline cache).
// The payload is what src/realtime/push.ts pushMessage() sends: { title, body, tag, kind, url, bidId, alertIds }.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch { p = { body: event.data ? event.data.text() : '' }; }
  const title = typeof p.title === 'string' && p.title ? p.title : 'BidSwipe';
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof p.body === 'string' ? p.body : '',
    tag: typeof p.tag === 'string' ? p.tag : undefined,
    icon: 'icon.svg',
    badge: 'icon.svg',
    data: { bidId: typeof p.bidId === 'string' ? p.bidId : null },
  }));
});

// Open the app on the bid. The address is always this app's own (never a URL from the payload).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const bidId = event.notification.data?.bidId ?? null;
  const target = new URL(bidId ? `./?bid=${encodeURIComponent(bidId)}` : './', self.registration.scope).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = open.find((c) => c.url.startsWith(self.registration.scope));
    if (app) {
      await app.focus();
      app.postMessage({ type: 'open-bid', bidId });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
