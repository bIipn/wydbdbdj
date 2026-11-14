import type { Source } from '../types.js';

/**
 * Caltrans Office Engineer: state highway projects currently advertised. NOT BUILT, switched off on purpose.
 *
 * WHAT WE FOUND (2026-11-14):
 *  - GET https://ppmoe.dot.ca.gov/des/oe/weekly-ads/all-adv-projects.php (one request, the scanner's User-Agent,
 *    05:59 UTC) → HTTP 200, 168 KB. It is not a list: it is the shell of a ServiceNow Service Portal
 *    ("OE Index - PPMOE MIgration", instance cdotprod, portal suffix "des", start page "oe_index", user "guest").
 *    Its 8 <tr> are AngularJS templates (ng-repeat="row in …"), no project in the HTML, no embedded JSON, no
 *    iframe with a list, no link to a data file. The rows would come from the portal's own REST calls
 *    (/api/now/sp/page?id=…), made by the browser with the session cookie and the page's g_ck user token.
 *  - GET https://ppmoe.dot.ca.gov/robots.txt (once, 2026-11-14 ~07:00 UTC) → HTTP 200 text/plain:
 *        User-agent: *
 *        Disallow: /
 *    (test/fixtures/caltrans-robots.txt, raw). The host asks every automated client to stay out of every path.
 *
 * So the list cannot be read from this host honestly: the only way in is the portal's session-token REST API on
 * a host whose robots.txt disallows everything. No parser was written on guesses and no further request was made.
 * Turning this on is the owner's decision (e.g. a Caltrans data feed they publish for reuse, or their consent).
 */
export const CALTRANS_LIST_URL = 'https://ppmoe.dot.ca.gov/des/oe/weekly-ads/all-adv-projects.php';

export const CALTRANS_DISABLED =
  'ppmoe.dot.ca.gov/robots.txt says "User-agent: * Disallow: /" (read 2026-11-14), and the advertised-projects ' +
  'page is a ServiceNow portal shell with no rows in its HTML (they load through the portal\'s session-token API): ' +
  'not built, off until the owner decides';

export const caltransSource: Source = {
  id: 'caltrans',
  name: 'Caltrans (Office Engineer)',
  homepage: CALTRANS_LIST_URL,
  states: ['CA'],
  timeZone: 'America/Los_Angeles',
  group: 'west',
  disabledReason: () => CALTRANS_DISABLED,
  async fetch() {
    // Never reached in a scan (disabledReason). Called directly, it fails loudly before any request.
    throw new Error(`caltrans: not built (${CALTRANS_DISABLED})`);
  },
};
