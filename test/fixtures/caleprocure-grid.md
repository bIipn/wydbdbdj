# caleprocure-grid.html

Cal eProcure (California State Contracts Register), the open-events grid, as the scanner receives it.

- **Request:** `GET https://suppliers.fiscal.ca.gov/psc/psfpd1/SUPPLIER/ERP/c/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?Page=AUC_RESP_INQ_AUC&Action=U`
  with `User-Agent: BidSwipe/0.1 (daily public-bid check)` and `Referer: https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx`,
  cookies kept (`curl -A … -e … -c jar -b jar -L`). The first answer is a 302 to the same URL plus `&`, which sets the
  PeopleSoft session cookies; the 200 behind it is this page.
- **Captured:** 2026-11-14, 05:59 UTC (one request). Raw response 1,183,977 bytes, a grid of 376 events
  ("1-376 of 376"; every event on one page).
- **Trimmed:** only whole grid rows were dropped. Kept are the rows at indices 0, 2, 18, 28, 34, 51, 56, 70, 76, 162,
  367, 368 (their `$i` ids unchanged), so the counter still reads "1-376 of 376" (the parser's tests rewrite it
  where they need a page that holds all its rows). Session values replaced with `TRIMMED`: the hidden `ICSID` input and
  the F5 `f5_p` token in the first script. The state buyers' names and e-mail addresses (cells
  `RESP_INQA1_WK_OPRDEFNDESC$i` and `RESP_INQA1_WK_EMAILID$i`, 10 rows each; no parser reads them) are replaced with
  `TRIMMED` too: public contacts, but people's names have no place in a test file. Everything else, line endings included, is byte for byte the response.
- **Rows chosen for:** an RFI-format event that is a real solicitation (UCLA fire sprinkler retrofit, `&amp;` in the name),
  non-trade events (ASL interpreting, a software platform, dam-safety engineering with the board's own "¿"), Caltrans
  construction ads, an RFI-format event that is information only (row 51), electrical work (rows 56, 70), a town in
  the name (row 76, Sacramento), the board's two-space time ("11/17/2026&nbsp; 2:00PM PST") and PDT end dates (367, 368).
