/**
 * The request URL as it may appear in the server log. Two things never reach a log line:
 *   - the point sent to GET /api/geo/nearest-zip ("Use my location"): the app promises it is never stored,
 *     and a host keeps its logs, so the whole query string goes;
 *   - a promo code in a ?promo= query (the app sends codes only in a POST body, which is not logged, but a
 *     hand-typed URL could carry one): its value becomes "…".
 * Everything else is logged as it came.
 */
export function logUrl(url: string | undefined): string {
  if (!url) return '';
  const q = url.indexOf('?');
  if (q < 0) return url;
  const path = url.slice(0, q);
  if (path === '/api/geo/nearest-zip') return `${path}?…`;
  // promo=… up to the next "&name=" pair (a code may hold a bare "&", see web/js/promo-link.js)
  return url.replace(/([?&]promo=)(.*?)(?=&[^&=]*=|$)/, '$1…');
}
