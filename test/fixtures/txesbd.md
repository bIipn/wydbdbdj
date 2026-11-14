# txesbd-page1.json

Texas Electronic State Business Daily (ESBD), the first page of the "Posted" list, as the scanner receives it.

- **Request:** `POST https://www.txsmartbuy.gov/app/extensions/CPA/CPAMain/1.0.0/services/ESBD.Service.ss` with
  `User-Agent: BidSwipe/0.1 (daily public-bid check)`, `Content-Type: application/json; charset=UTF-8`,
  `Referer: https://www.txsmartbuy.gov/esbd`, body `{"lines":[],"page":1,"urlRoot":"esbd","status":"1"}` (curl).
- **Captured:** 2026-11-14, 05:59 UTC (one request, before robots.txt was read). Raw response 42,116 bytes:
  `{ agencies[413], lines[24], page: 1, recordsPerPage: 24, totalRecordsFound: 501 }`, one line of JSON.
- **Trimmed:** whole objects dropped only: `agencies` keeps its first 5 entries, `lines` keeps 13 of its 24 (original
  order). The parsed file re-serialised is byte for byte the raw response (checked: `JSON.stringify(JSON.parse(raw)) === raw`),
  so the kept objects are unchanged. No session values in this answer. `totalRecordsFound` still says 501.
- **Lines chosen for:** a 10:30 PM deadline and an El Paso site under a state agency (HHS0018130, laundry: left out), an
  agency name with no number (Office Of The Attorney General) and an outside bidding site, NIGP construction classes
  (TxDOT salt shed 90925, UT System 90900, Mitte HVAC 914), an "Addendum Posted" line, universities that name their
  city (Univ. Of Texas At San Antonio, University Of Houston), a county (Hays County, dumpsters: left out).
- **robots.txt:** `https://www.txsmartbuy.gov/robots.txt` read once on 2026-11-14 06:40 UTC: `User-agent: *` / `Disallow: /`.
  So the source is built but switched off (`disabledReason`), and no further request was made to this host.
