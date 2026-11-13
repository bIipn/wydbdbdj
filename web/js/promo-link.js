// Reading ?promo= out of a link. Pure (string in, object out) so test/promo-link.test.ts can run it in Node.
//
// Why not URLSearchParams.get('promo'): a code may contain '&' ("A&Btest"). Typed or pasted into a link
// without %26, the browser splits it: URLSearchParams reads promo = "A" and a second key "Btest". So the code
// runs from "promo=" up to the next "&name=" pair (or the end): a bare "&Btest" with no '=' stays part of it.
// A properly encoded link (?promo=A%26Btest) reads the same either way.

/**
 * Take the promo code out of a query string.
 * @param {string} search  location.search, e.g. "?promo=A&Btest&bid=x"
 * @returns {{ code: string, rest: string } | null}  the decoded code, and the query string without it
 *          ("?bid=x", or "" when nothing is left); null when there is no promo= in it.
 */
export function takePromoFromSearch(search) {
  const m = /[?&]promo=(.*?)(?=&[^&=]*=|$)/.exec(search);
  if (!m) return null;
  let code;
  try { code = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { code = m[1]; } // a stray '%' stays as typed
  let rest = search.replace(m[0], '');
  if (rest.startsWith('&')) rest = `?${rest.slice(1)}`;
  if (rest === '?') rest = '';
  return { code, rest };
}
