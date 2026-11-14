# civicplus-*.html

CivicPlus CivicEngage "Bid Postings" module (`/Bids.aspx`), read by `src/sources/civicplus.ts`. Each request was made ONCE,
on 2026-11-14, by curl with the scanner's own User-Agent, from the build sandbox, never in a browser:

    curl -sS -A "BidSwipe/0.1 (daily public-bid check)" https://www.citrusheights.net/Bids.aspx
    curl -sS -A "BidSwipe/0.1 (daily public-bid check)" https://www.auburn.ca.gov/Bids.aspx
    curl -sS -A "BidSwipe/0.1 (daily public-bid check)" "https://www.citrusheights.net/Bids.aspx?CatID=All&txtSort=Category&showAllBids=on"

| Fixture | Request | Received | What it is |
|---|---|---|---|
| `civicplus-citrusheights-open.html` | `GET https://www.citrusheights.net/Bids.aspx` | 2026-11-14 18:06:26 UTC (Date header), HTTP 200, 110,280 bytes | The open list as the scanner asks for it: 2 rows (bidID 234, 235), both Open / Upon Contract, one group "Public Works Projects (Maintenance & Professional Services)". Both rows kept. |
| `civicplus-auburn-empty.html` | `GET https://www.auburn.ca.gov/Bids.aspx` | 2026-11-14 18:06:27 UTC (Date header), HTTP 200, 127,203 bytes | The real empty state: "There are no open bid postings at this time." |
| `civicplus-citrusheights-all.html` | `GET https://www.citrusheights.net/Bids.aspx?CatID=All&txtSort=Category&showAllBids=on` (the page's own "Show Closed/Awarded/Cancelled Bids" checkbox, a GET form) | 2026-11-14 ~18:11 UTC (file time; no header file was kept), 212,447 bytes | 107 rows in 3 groups (Open 2, Closed 78, Awarded 27). **15 row elements kept** (14 postings: bidID 172 is listed in two groups, kept in both to test the repeat): every status (Open, Closed, Awarded), "Upon Contract" under Closed and Awarded, closing times `8/17/2023 4:00 PM`, `8/23/2022 11:59 PM`, `11/8/2023 4:00 AM`, `12/15/2021 2:00 PM`, `11/6/2026 5:00 PM`, a "Bid No." line (`2023-07`, `28-20-001 (see addenda 1)`), a row with no "[Read on]" tail (173) and one with an empty snippet (152). The scanner itself never asks for this page: it is here for the real status and date strings. |

**Trimmed:** each fixture is one contiguous excerpt of the received bytes: the module's lines, from `<!-- BEGIN Left Margin ***** -->`
to `<script type="text/javascript">order+='ModuleContent\n'</script>` (Citrus Heights lines 1238–1303 of the open page and
1238–2377 of the all-statuses page, Auburn 1214–1257). Line endings untouched (CRLF, tabs as sent). The page's head (scripts,
`__VIEWSTATE`), navigation and footer (street address, phone and fax numbers, social links) are cut. In the all-statuses
excerpt whole `div.listItemsRow` elements were dropped only, each with the whitespace that followed it; the group headers
still say "47 Bids", "24 Bids", "36 Bids" as sent. One row was left out for what it carries even apart from the choice: a Zoom
bid-opening link with its meeting password (bidID 133). No session or token value is inside the excerpts (the
`__VIEWSTATE` input sits in the cut head; the trim script replaces any such value with `TRIMMED` all the same). No staff
names, e-mail addresses or phone numbers.

**robots.txt** (read once each, 2026-11-14 18:05 UTC, https://www.citrusheights.net/robots.txt and
https://www.auburn.ca.gov/robots.txt; auburn.ca.gov serves the same file): for `User-agent: *` it disallows /activedit, /admin,
/common/admin/, /OJA, /support, /currenteventsview.asp(x), /search.asp(x), /Search, /currentevents.aspx, /map.asp(x),
**/RSS.aspx and /rss.aspx**, /error.aspx, /404.aspx, /common/modules/icalendar/, /common/modules/debug/, /publiclogin.aspx, and
sets **`Crawl-delay: 10`**. `/Bids.aspx` is not disallowed. Named groups for AI/SEO crawlers (GPTBot, ClaudeBot, AhrefsBot, …)
carry extra rules; "BidSwipe" is not named in any. So the source reads `/Bids.aspx` only (never the RSS feed, search or a
detail page), one request per host per scan.

**Checked and out:** www.cityofwoodland.gov (`/Bids.aspx` answers 301 to /1710/Bid-Opportunities, whose list is a Public
Purchase iframe) and www.tuolumnecounty.ca.gov (`/Bids.aspx` answers HTTP 403 "Just a moment..." with
`cf-mitigated: challenge`). The tests use Woodland's 301 body (verbatim, 140 bytes) and the shape of that challenge page (its
title and noscript line; the script and its tokens left out) to check that such a page FAILS.
