# BuySpeed fixtures (oregonbuys, commbuys, bidbuy, njstart)

Periscope BuySpeed open-bid lists, as the scanner receives them. Parser: `src/sources/buyspeed.ts`; tests:
`test/source-buyspeed.test.ts`. NevadaEPro's own fixture (`nevadaepro-open-bids.html`, 2026-11-13) is the same page
on the same software.

All requests: `User-Agent: BidSwipe/0.1 (daily public-bid check)`, no login, no key.

| File | Request | Captured | Raw answer | Kept |
|---|---|---|---|---|
| `oregonbuys-open-bids.html` | `GET https://oregonbuys.gov/bso/view/search/external/advancedSearchBid.xhtml?openBids=true`, through a cookie session (`createHttp().session()`, src/util/http.ts) | 2026-11-14 ~06:45 UTC | 25 rows, "1-25 of 174" | rows data-ri 0, 2, 3, 4, 8, 9, 13, 14, 16, 19 |
| `oregonbuys-page2.xml` | the POST below, same session, right after that GET | 2026-11-14 ~06:45 UTC | 16,314 bytes, 25 rows (data-ri 25–49), `{"totalRecords":174}` | rows 25, 26, 34, 37, 38, 41, 43 |
| `commbuys-open-bids.html` | `GET https://www.commbuys.com/bso/view/search/external/advancedSearchBid.xhtml?openBids=true` | 2026-11-14 ~05:59 UTC (the run's first request) | 25 rows, "1-25 of 890" | rows 0, 2, 3, 5, 11, 13, 14, 15, 20, 24 |
| `bidbuy-open-bids.html` | `GET https://www.bidbuy.illinois.gov/bso/view/search/external/advancedSearchBid.xhtml?openBids=true` | 2026-11-14 ~05:59 UTC | 25 rows, "1-25 of 149" | rows 2, 3, 4, 6, 8, 12, 13, 17 |
| `njstart-open-bids.html` | `GET https://www.njstart.gov/bso/view/search/external/advancedSearchBid.xhtml?openBids=true` | 2026-11-14 ~05:59 UTC | 19 rows, "1-19 of 19" | all 19 |

**Trimmed:** each HTML file is a verbatim excerpt of the response, the results form only
(`<form id="bidSearchResultsForm">` … `</form>`: both paginators, the table with its `<thead>`, the DataTable widget
config, the hidden fields), with a comment line in front; rows not listed above were dropped whole, so the paginator
still reads the board's real count. The XML is the whole answer with rows dropped whole. Session values replaced with
`TRIMMED`: the `_csrf` input and `javax.faces.ViewState` (input and the XML's ViewState `<update>`). Cookies were
never saved. Line endings untouched.

**The page-2 request** (worked out on OregonBuys with one GET and one POST): `POST` to the form's action
(`/bso/view/search/external/advancedSearchBid.xhtml`) with the GET's cookies (the board set `AWSALB`, `AWSALBCORS`,
`dtCookie`, `JSESSIONID`, `XSRF-TOKEN`), headers `Faces-Request: partial/ajax`, `X-Requested-With: XMLHttpRequest`,
`Content-Type: application/x-www-form-urlencoded; charset=UTF-8`, and a body of the form's hidden fields plus
`javax.faces.partial.ajax=true`, `javax.faces.source` / `.partial.execute` / `.partial.render` = the table,
`<table>=<table>`, `<table>_pagination=true`, `<table>_first=25`, `<table>_rows=25`, `<table>_skipChildren=true`,
`<table>_encodeFeature=true` (`<table>` = `bidSearchResultsForm:bidResultId`). `buySpeedPageBody()` builds it.

**Rows chosen for:** trade work kept (playground, road, parking structure, culvert, roof, on-call electric, flooring,
bridge), non-trade dropped (printing, grants, deli salads, engineering services), the boards' own notices (sole source,
"NOT A BID", notice of intent to award / accept, change order, emergency final cost, exempt report), towns in the
organisation name ("City of Salem", "Town of Richmond", "Quincy Housing Authority", "Holyoke Gas & Electric";
"City of Detroit" on page 2 is Detroit, Oregon), counties ("Clackamas County"), COMMBUYS' double-encoded quotes
(row 20), Central "12:00 AM" times (BidBuy), NJSTART's "Contract #" header.
