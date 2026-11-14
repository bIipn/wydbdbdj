# nycrecord-open.json

The City Record Online, procurement solicitations, on NYC Open Data (Socrata dataset `dg92-zbpx`).

- **Request:** `GET https://data.cityofnewyork.us/resource/dg92-zbpx.json?%24select=request_id%2C+start_date%2C+end_date%2C+agency_name%2C+type_of_notice_description%2C+category_description%2C+short_title%2C+selection_method_description%2C+section_name%2C+pin%2C+due_date%2C+additional_description_1&%24where=section_name+%3D+%27Procurement%27+AND+type_of_notice_description+%3D+%27Solicitation%27+AND+due_date+%3E+%272026-11-13T06%3A59%3A38%27&%24order=request_id&%24limit=1000&%24offset=0` (`socrataUrl(nycQuery(now), 0)`, src/sources/nycrecord.ts: only the columns the parser reads, so no
  contact COLUMNS; the notice text itself can still name a contact person with an e-mail or a phone, which the parser
  strips before storing (stripContacts) — the raw text is kept here as received), curl with `User-Agent: BidSwipe/0.1 (daily public-bid check)`.
- **Captured:** 2026-11-14 06:59:51 UTC. HTTP 200, 606,061 bytes, 202 rows (one page). Last-Modified 2026-11-13 13:47:26 GMT.
- **Trimmed:** whole row objects dropped only, original order kept. Socrata writes one object per line joined by `\n,`; the kept
  lines are the received bytes unchanged (`JSON.parse` of the trimmed file equals the kept objects of the full answer, checked
  by the trim script). No session values in these answers. No app token was sent.
- **Kept 18 of 202**, chosen for: a 2015 DDC roofing list due "2999" (stale), its 2026 successor PQL000124 (due 2040), the
  Parks site-work PQL published three times (2024 twice with 2099, 2026 with 2027-04-20), PQL000172 published twice (same
  due date: one card), Jacobi Medical Center with "LOCATION: … Bronx, NY 10461", a "Bid Extension:" title, an RFI,
  a NYCHA IDIQ job order contract, Goods (window air conditioners; mobile food units), a cancellation, Human Services
  (2026 supportive housing; 2020 school-based), a row with PIN "N/A".
- **robots.txt** (https://data.cityofnewyork.us/robots.txt, 2026-11-14): `User-agent: *`, `Crawl-delay: 1`, Disallow for
  /browse?…, /api/odata/, /api/collocate* and similar; nothing on /resource/.
- **Card link:** https://a856-cityrecord.nyc.gov/RequestDetail/<request_id>: pattern, not fetched (that host refuses this
  machine's proxy: CONNECT 403 on 2026-11-14). The rows' own document_links use the same host.
- **Names trimmed:** six staff contacts named in the notice texts (their names, personal e-mail local parts and direct
  lines) are replaced with `TRIMMED`, as session tokens are; role addresses (procurement@…, vendorhotline@…) and
  conference-bridge numbers are kept. The JSON stays valid; nothing else changed.
