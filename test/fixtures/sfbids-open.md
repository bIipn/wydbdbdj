# sfbids-open.json

San Francisco open bid opportunities (SF City Partner) on the City's open-data portal (Socrata dataset `eshn-8t3a`). The old
host data.sfgov.org answers 301 to data.sf.gov; the source asks data.sf.gov.

- **Request:** `GET https://data.sf.gov/resource/eshn-8t3a.json?%24where=status+in+%28%27Open%27%2C+%27Amended%27%29+AND+due_date+%3E+%272026-11-13T06%3A59%3A38%27&%24order=event_id&%24limit=1000&%24offset=0` (`socrataUrl(sfBidsQuery(now), 0)`, src/sources/sfbids.ts), curl with
  `User-Agent: BidSwipe/0.1 (daily public-bid check)`.
- **Captured:** 2026-11-14 06:59:48 UTC. HTTP 200, 39,336 bytes, 64 rows (one page). Last-Modified 2026-11-09 11:07:14 GMT
  (the dataset is reloaded about weekly: rows due 2026-11-13 are still listed on the 14th).
- **Trimmed:** whole row objects dropped only, original order kept. Socrata writes one object per line joined by `\n,`; the kept
  lines are the received bytes unchanged (`JSON.parse` of the trimmed file equals the kept objects of the full answer, checked
  by the trim script). No session values in these answers. No app token was sent.
- **Kept 13 of 64**, chosen for: Public Works construction filed under Commodity (San Bruno Ave paving, Pier tenant
  improvements), HVAC Master Agreement, landscaping, the 2099 placeholder ("Construction & Prof Services"), Airport
  Concessions and Leases (2099, left out), "Professional Services (Non-Construction)", "Bid Results", catering, a software
  licence, rows already past due (2026-11-13), the one "Request for Information".
- **robots.txt** (https://data.sfgov.org/robots.txt → 301 → https://data.sf.gov/robots.txt, 2026-11-14): `User-agent: *`,
  `Crawl-delay: 1`, Disallow for /browse?…, /api/odata/, /api/collocate* and similar; nothing on /resource/.
