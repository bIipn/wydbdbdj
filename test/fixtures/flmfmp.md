# flmfmp-bids-page1.json, flmfmp-bids-page2.json

MyFloridaMarketPlace Vendor Information Portal, bid search (open ads), as the scanner receives it.

- **Request:** `POST https://vendor.myfloridamarketplace.com/mfmp/pub/search/bids` with
  `User-Agent: BidSwipe/0.1 (daily public-bid check)`, `Content-Type: application/json`, `Accept: application/json`
  (without Accept the host answers with its web app's HTML), body `{"status":["OPEN"],"page":N,"pageSize":100}` (curl).
- **Captured:** page 1 on 2026-11-14 05:59 UTC (the first request, first/florida-ok.out: 100 ads, 57,732 bytes);
  page 2 on 2026-11-14 06:41 UTC (ours: 20 ads, a short page, so 120 open ads in all). One line of JSON each, a bare
  array (no count).
- **Trimmed:** whole ads dropped only: page 1 keeps 17 of 100, page 2 keeps 7 of 20 (original order). Each raw response
  re-serialised is byte for byte itself (`JSON.stringify(JSON.parse(raw)) === raw`), so the kept ads are unchanged.
  No session values in these answers.
- **Ads chosen for:** every type seen: Agency Decision (2, one a fire alarm job: an award notice, left out), Grant
  Opportunities, Informational Notice, Invitation to Bid (roof, electrical, HVAC, awning, Chipley in the Central-time
  panhandle with a null agency number, janitorial: not trade), Invitation to Negotiate (USF, 04:00 UTC = 11 PM Eastern),
  Request for Information, Request for Proposals (HVAC controls; AHCA 04:59 UTC = 11:59 PM Eastern), Request for
  Statement of Qualifications (A/E services: not trade; construction management: kept), Single Source (page 2), a town
  (Town of Orange Park), a special district (Central Florida Tourism Oversight District), a college "at Jacksonville".
- **robots.txt:** none: `https://vendor.myfloridamarketplace.com/robots.txt` answers 404 "Cannot GET /robots.txt" (2026-11-14 06:40 UTC).
