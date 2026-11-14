# caleprocure-grid.html

Cal eProcure (California State Contracts Register), the open-events grid, as the scanner receives it.

- **Request:** `GET https://suppliers.fiscal.ca.gov/psc/psfpd1/SUPPLIER/ERP/c/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?Page=AUC_RESP_INQ_AUC&Action=U`
  with `User-Agent: BidSwipe/0.1 (daily public-bid check)` and `Referer: https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx`,
  cookies kept (`curl -A … -e … -c jar -b jar -L`). The first answer is a 302 to the same URL plus `&`, which sets the
  PeopleSoft session cookies; the 200 behind it is this page.
- **Captured:** 2026-11-14, 05:59 UTC (one request). Raw response 1,183,977 bytes, a grid of 376 events
  ("1-376 of 376"; every event on one page).
- **Trimmed:** only whole grid rows were dropped. Kept are 68 of the 376 rows, at indices 0, 2, 3, 6, 18, 20, 23, 28,
  29, 32, 33, 34, 40, 42, 51, 56, 66, 70, 71, 76, 81, 90, 93, 100, 102, 106, 107, 117, 124, 128, 143, 144, 154, 157, 158,
  162, 166, 185, 200, 204, 213, 220, 221, 227, 248, 259, 261, 267, 269, 272, 283, 286, 288, 314, 315, 319, 324, 332, 336,
  339, 340, 357, 359, 364, 365, 367, 368, 369 (their `$i` ids unchanged, in the page's order), so the counter still reads
  "1-376 of 376" (the parser's tests rewrite it where they need a page that holds all its rows). Session values replaced
  with `TRIMMED`: the hidden `ICSID` input and the F5 `f5_p` token in the first script. The state buyers' names and
  e-mail addresses (cells `RESP_INQA1_WK_OPRDEFNDESC$i` and `RESP_INQA1_WK_EMAILID$i`, every kept row that has them:
  64 rows; no parser reads them) are replaced with `TRIMMED` too: public contacts, but people's names have no place in a
  test file. Everything else, line endings included, is byte for byte the response. The 56 rows added on 2026-11-14
  (second pass) were cut from the same capture by a script that first reproduced the 12 earlier rows byte for byte.
- **Rows chosen for:** an RFI-format event that is a real solicitation (UCLA fire sprinkler retrofit, `&amp;` in the name),
  non-trade events (ASL interpreting, a software platform, dam-safety engineering with the board's own "¿"), Caltrans
  construction ads, an RFI-format event that is information only (row 51), electrical work (rows 56, 70), the board's
  two-space time ("11/17/2026&nbsp; 2:00PM PST") and PDT end dates (367, 368).
  The second pass added a real row for every placement case of src/geo/caleprocure-place.ts (test/caleprocure-place.test.ts
  lists all 68 with where each goes): a town with its county ("ATASCADERO, SAN LUIS OBISPO COUNTY", Porterville,
  Potrero, Napa), a town backed by a county in brackets (Winterhaven, Smith River), ", CA" (Los Alamitos, Oakland,
  San Luis Obispo), DMV field offices (Carmichael, Ventura, Bishop), CHP and other offices (Madera, Santa Cruz,
  Bakersfield, Oxnard), a title ending in a town (Crescent City), one county (Shasta, Placer, Solano, Fresno, Imperial,
  Alpine), several counties (Caltrans 05A3054, 06A3342, 09A1153, 05A3060 which names Santa Clara on a District 5 event,
  "Nevada & Placer", "HUMBOLDT & SHASTA COUNTIES", the TMS program 56A0916 / 56A0921), Caltrans district only
  (03-1N7504, 01-0H2464; 12-0R9704 = Orange County alone), CSU and UC campuses (Fresno, Sacramento, Channel Islands,
  Dominguez Hills, Northridge, Santa Cruz, UC Davis Medical Center), state facilities (CSP Solano, SATF, Pelican Bay,
  Weaverville Joss House, Gateway Armory, Hammer Field, Camp San Luis Obispo, Grover Hot Springs, the 22nd DAA), and
  traps that must stay unplaced or go to the facility: "PERS Q Lincoln Plaza" (CalPERS, Sacramento, not Lincoln),
  "Sacramento Okinawa FMS-22", "Butte Slough … Sacramento River", "… Services in Bakersfield", "CHP Central L.A.", and
  statewide purchases (canned tuna, plastic trash bags, a portable-restroom rental).
