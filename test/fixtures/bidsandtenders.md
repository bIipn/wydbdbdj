# bidsandtenders-placer-*.{html,json}

Placer County, CA on the bids&tenders platform (placer.bidsandtenders.net), read by `src/sources/bidsandtenders.ts`.
Every request was made ONCE on 2026-11-14 (18:06–18:08 UTC) by curl with `User-Agent: BidSwipe/0.1 (daily public-bid
check)`, the two POSTs through the cookie jar of the GET made a second before (curl -c/-b), with
`X-Requested-With: XMLHttpRequest` and `Referer: https://placer.bidsandtenders.net/Module/Tenders/en`. The cookies the
GET set (`Suite.Web.SecurityProvider.Customer_PRD_NET`, `__RequestVerificationToken_L01vZHVsZS9UZW5kZXJz0`) are not
stored anywhere here.

- **bidsandtenders-placer-list.html** — `GET https://placer.bidsandtenders.net/Module/Tenders/en`, HTTP 200, 29,900
  bytes, CRLF line endings. The page has no rows (a Fuel UX "repeater" loads them by script). Trimmed to whole lines,
  verbatim, line endings untouched: the `<head>` start and title, the main content with the logout form's token,
  `#Home` and `#NodeId`, the `#bidDetailAntiForgery` token (the one the list call sends) and the closing tags. Both
  `__RequestVerificationToken` values are replaced with `TRIMMED`.
- **bidsandtenders-placer-open.json** — the page's own list call for the Open filter, as captured, unchanged:
  `POST /Module/Tenders/en/Tender/Search/b92921bd-18c6-468d-b08f-848b03b7c2e6?status=Open&limit=100&start=0&dir=ASC&from=&to=&sort=DateClosing ASC,Id`
  with `keywords=&__RequestVerificationToken=<the page's token>`. Answer `{"success":true,"data":[],"total":0}`:
  Placer County had no open bid that day. This is the real empty state, not a failure.
- **bidsandtenders-placer-all.json** — the same call with `status=` (All), `limit=15&start=0&dir=DESC`: total 473,
  15 rows, all Closed (latest closing 2026-11-03). Trimmed by dropping whole row objects only: the kept rows are the
  received bytes, sliced out of the answer and joined with the server's own commas (the trim script checked that the
  sliced rows parse to the received rows and that the slices put back together give the raw answer). Kept 7 of 15:
  only rows whose text names no person, e-mail address or phone number. The 8 dropped rows carry a Microsoft Teams
  bid-opening block with a dial-in phone number, or (the Roseville cemetery row) the district's staff e-mails.
  The one PST row (20693 Olympic Valley Road Snow Removal, `/Date(1793721600000)/`, "Tue Nov 3, 2026 11:00 AM",
  " (PST)") is one of the dropped ones; the test uses its three time values only.

**robots.txt** (`https://placer.bidsandtenders.net/robots.txt`, read once on 2026-11-14 18:06 UTC): one group,
`User-agent: *`, no Crawl-delay. It disallows /Management/, /Module/ShoppingCart/, /Module/Tenders/Management/,
/Module/Tenders/API/, and under /Module/Tenders/en/ (and /fr/): Management/, Login, Logout, Sso, SamlAssertionService,
Vendor, Submission, Order, Subscription, Contact, Contract, Evaluation, Performance, Certificate, Insurance, Document,
Email, Print, Utility, Validation, Common, Error, Home/EvaluatorPortal, Home/ActiveReqs, Home/RemoveLongRunningRequest,
Tender/Preview, Tender/TenderPreamblePreview, Tender/TenderDetailsPreview, Tender/Download, Tender/Terms,
Tender/SubmitQuestion, Tender/SubmitAQuestion, Tender/AddAgencyAndRegister, and any /Module/Tenders/ URL with `?fa=`,
`&fa=`, `?dsat=` or `&dsat=`. NOT disallowed: `/Module/Tenders/en` (the list page),
`/Module/Tenders/en/Tender/Search/<NodeId>` (the list's own data call) and `/Module/Tenders/en/Tender/Detail/<Id>`
(the card link, never fetched). Terms of use were not read.
