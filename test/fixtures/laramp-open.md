# laramp-open.json

LA RAMP open bid opportunities on the City of Los Angeles open-data portal (Socrata dataset `hf3r-utnq`), as the scanner
receives it.

- **Request:** `GET https://data.lacity.org/resource/hf3r-utnq.json?%24where=stagename+in+%28%27Open%27%2C+%27Amended%27%29+AND+closedate+%3E+%272026-11-13T06%3A59%3A38%27&%24order=rampid&%24limit=1000&%24offset=0` (the exact URL `socrataUrl(laRampQuery(now), 0)` builds, src/sources/laramp.ts), curl with
  `User-Agent: BidSwipe/0.1 (daily public-bid check)`.
- **Captured:** 2026-11-14 06:59:46 UTC (server Date). HTTP 200, `application/json;charset=utf-8`, 76,868 bytes, 207 rows
  (one page). Headers: `X-SODA2-Types` gives bidpost/closedate as `floating_timestamp`; Last-Modified 2026-11-14 06:30:01 GMT.
- **Trimmed:** whole row objects dropped only, original order kept. Socrata writes one object per line joined by `\n,`; the kept
  lines are the received bytes unchanged (`JSON.parse` of the trimmed file equals the kept objects of the full answer, checked
  by the trim script). No session values in these answers. No app token was sent.
- **Kept 14 of 207**, chosen for: Construction (Vision Zero traffic signals, Ontario airport fire alarm, an LAUSD RFI),
  Commodity jobs (roof replacement with "Closing: 11/27/2026 12:00 PM" in the title, height adjusters and installation)
  and Commodity goods (motor, fiber optic cable, case management system), Personal Services (HVAC repair kept; risk
  consulting, driver evaluations, vehicle wrapping left out), an Amended row, LA County titles that state the closing
  time (noon and 5 PM: the UTC check), the practice listing.
- **robots.txt** (https://data.lacity.org/robots.txt, 2026-11-14): `User-agent: *`, `Crawl-delay: 1`, Disallow for
  /browse?…, /api/odata/, /api/collocate* and similar; nothing on /resource/.
