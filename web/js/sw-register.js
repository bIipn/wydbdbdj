// The service worker from the first visit (installable app, offline page); push.js reuses the same registration.
// A classic script in its own file (it was inline in index.html) so the Content-Security-Policy can be script-src 'self'.
// index.html marks its tag data-demo-strip: the offline demo (file://) has no service worker.
if ('serviceWorker' in navigator && location.protocol !== 'file:') addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
