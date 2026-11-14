# Data sources: bids and prices, free, at scale

Researched 2026-11-13. Every fact is tagged with how it was checked:

- **[read]** — the official page itself was downloaded today and the quoted words are on it.
- **[search]** — the official page could not be reached from this machine (the network allow-list
  blocks bls.gov, fred.stlouisfed.org, eia.gov, census.gov, dir.ca.gov, labor.nv.gov, usaspending.gov's
  website). The fact comes from a web-search summary of that page. Re-check it on the page before
  depending on it.
- **[seen]** — we called the endpoint today and saw the answer.

Nothing here is a guess. Where a question had no answer on a page we could read, it says "not stated".

---

## Short answers to Ev's questions

1. **Is there a SAM.gov key that never expires?** **No.** SAM.gov's Terms of Use say, for personal keys
   *and* system accounts: *"Update your API key and system account password every 90 days."* [read]
   ([sam.gov/about/terms-of-use](https://sam.gov/about/terms-of-use))
2. **Can we get more than 10 lookups a day without paying?** **Yes, two free ways.**
   - Best: **don't use the API for bids at all.** SAM.gov publishes every open opportunity as one public
     CSV file, rebuilt daily, **no key, no daily limit, no expiry** (§2). One download a day covers every
     user in every state.
   - Also: the 10/day cap is only for a *personal key with no role*. A personal key **with a role**, or a
     non-federal **system account**, gets **1,000 requests/day**, free — but still expires every 90 days.
3. **Another website for pricing?** Yes, all free: USAspending (federal awards, no key), BLS (wages and
   material price indexes, works with no key), EIA (fuel prices, free key), Census (construction
   spending), state prevailing-wage tables, and Caltrans' bid-item unit-price database. See the table.

---

## The table

| Source | What it gives BidSwipe | Key? | Key expires? | Daily limit | Terms that matter for the app |
|---|---|---|---|---|---|
| **SAM.gov Contract Opportunities bulk CSV** | Every active federal notice, nationwide, incl. award rows | **No** | — | None stated; one file a day | Public data; offered as a download on sam.gov/data-services |
| SAM.gov Get Opportunities API | Same notices, searchable | Yes | 90-day rule | 10 / 1,000 / 10,000 (by account type) | Don't share the key |
| SAM.gov Contract Awards API | Federal contract awards (FPDS) | Yes | 90-day rule | Same table | Same |
| **USAspending API + monthly award files** | Federal awards: who won, for how much, where | **No** | — | None stated on the pages read | Public spending data (DATA Act) |
| **BLS API v1** | OEWS wages, PPI material indexes | **No** | — | 25 queries, 25 series each [search] | Show BLS's disclaimer line (already in `src/market/bls.ts`) |
| BLS API v2 | Same, bigger | Free key | Renew **at least once a year** [search] | 500 queries, 50 series, 20 years [search] | Same |
| FRED API | Mirrors many BLS/Census series | Free key | Not stated | ~120 req/min [search, unofficial] | **Forbids storing/caching** API content [search] → don't use it for our design |
| EIA API v2 | Gasoline/diesel retail prices | Free key (emailed) [search] | Not stated | Not published officially [search] | Federal data, credit EIA [search] |
| Census Data API | Construction spending (value put in place) | Free key; may now be required [search] | Not stated | 500 queries/IP/day without key [search] | Public |
| SAM.gov wage determinations (Davis-Bacon) | Federal prevailing wages by county & trade | — | — | **No API, no bulk file** [read] | Website only; SAM forbids scraping it [read] |
| Nevada Labor Commissioner PDFs | NV prevailing wage, 4 regions | No | — | — | Public PDFs; already typed into `config/prevailing-wage/` |
| California DIR determinations | CA prevailing wage by county & craft | No | — | — | HTML pages per county/craft [search]; no bulk file found |
| **Caltrans Contract Cost Data** | Unit prices actually bid on Caltrans items | No | — | — (interactive search) | "Conditions of use" page linked, not read |
| RSMeans and similar cost books | Unit costs per assembly | **Paid** | — | — | **Not used** |

---

## 1. SAM.gov API keys

Source pages [read]: [Entity Management API](https://open.gsa.gov/api/entity-api/) (the rate table),
[Contract Awards API](https://open.gsa.gov/api/contract-awards/) (same table, word for word),
[Get Opportunities Public API](https://open.gsa.gov/api/get-opportunities-public-api/),
[SAM.gov Terms of Use](https://sam.gov/about/terms-of-use).

**Who can get one.** "Registered user can request for a public API on 'Account Details' page." The key
shows after you enter your password / a one-time code sent to your email. [read]

**Official daily limits** (headed "API Key Rate Limits") [read]:

| Type of user account | Type of key | Default daily limit |
|---|---|---|
| Non-federal user with **no role** in SAM.gov | Personal API key | **10 requests/day** ← Ev's key today |
| Non-federal user **with a role** in SAM.gov | Personal API key | **1,000 requests/day** |
| Federal user | Personal API key | 1,000 requests/day |
| Non-federal **system** user | System account API key | **1,000 requests/day** |
| Federal system user | System account API key | 10,000 requests/day |

The Opportunities API page itself only says "Request per day are limited based on the federal or
non-federal or general roles" [read]. It does not define what "a role" is; neither does the table page.

**System account requirements** [read]: "The SAM.gov non-Federal registered users must request for a
System Account. If their registration and request criteria are satisfied, then they will be provided with
the 'System Accounts' widget on their SAM.gov 'Workspace' page." You then create the system account, get it
**approved**, set its password, and retrieve its key. The account must list: a unique system ID, the
permissions (public read is enough for us), **every IP address the system calls from**, and "REST APIs".
How long approval takes: not stated.

That IP-address rule matters: a host whose outgoing IP changes (most serverless platforms) does not fit.

**Expiry.** Terms of Use, section "System Accounts and API Keys": *"Update your API key and system account
password every 90 days. Do not share your individual account API key with anyone."* [read] This covers
both key types. **A non-expiring SAM.gov key does not exist.** The same page says "Automated data
gathering, web scraping tools are prohibited" for the website, and names the APIs and
`https://sam.gov/data-services` extracts as the way to get data. [read]

## 2. SAM.gov bulk file — the answer to the 10-a-day problem

- Listing [read, via the endpoint behind sam.gov/data-services]: folder `Contract Opportunities/datagov`,
  privacy **Public**, file `ContractOpportunitiesFullCSV.csv`, last modified Nov 12 2026. Its description:
  *"The Contract Opportunites data is available as a daily electronic download in order to promote data
  sharing and provide a way for related government systems to download data reliably and efficiently."*
  Page: [sam.gov/data-services → Contract Opportunities/datagov](https://sam.gov/data-services?domain=Contract%20Opportunities%2Fdatagov)
  (linked from the Get Opportunities API page [read]).
- Download: `https://sam.gov/api/prod/fileextractservices/v1/api/download/Contract%20Opportunities/datagov/ContractOpportunitiesFullCSV.csv?privacy=Public`
  answers **HTTP 303** to a signed `falextracts.s3.amazonaws.com` link valid 2,700 s (`X-Amz-Expires=2700`). [seen]
  No key. Size 222 MB (the lead's full download today).
- Columns [seen, first line of the file]: `NoticeId, Title, Sol#, Department/Ind.Agency, CGAC, Sub-Tier,
  FPDS Code, Office, AAC Code, PostedDate, Type, BaseType, ArchiveType, ArchiveDate, SetASideCode, SetASide,
  ResponseDeadLine, NaicsCode, ClassificationCode, PopStreetAddress, PopCity, PopState, PopZip, PopCountry,
  Active, AwardNumber, AwardDate, Award$, Awardee, Primary/Secondary contact fields, OrganizationType, State,
  City, ZipCode, CountryCode, AdditionalInfoLink, Link, Description`.
  Everything the API gives our `samgov` parser is there (solicitation number, NAICS, set-aside, place of
  performance, deadline, link).
- Past years: `Contract Opportunities/Archived Data` holds `FY<year>_archived_opportunities.csv`, public,
  updated Nov 8 2026 [read].
- Stated terms: none beyond the SAM.gov Terms of Use above. The listing marks it Public.

- **Built (v1.1, `src/sources/samgov-bulk.ts`), and what it leaves out.** Measured on the 2026-11-13 file at
  20:00Z: 72,318 rows → 8,840 open construction/trade notices → 2,295 solicitations → 1,784 after dropping
  511 that name no place of performance (146 of those were still open; kept out because we cannot say
  they are in the US, and a placeless card would sit in every company's feed) → 529 open cards. Also left
  out: no-deadline notices posted more than a year ago (26 from 2008–2021; ArchiveDate is blank or
  mistyped on several, so it is not used). Kept: US territories written as a country code (VIR → VI).
  A deadline without a time zone (714 rows) takes the offset a sibling notice of the same solicitation
  gives for that time; otherwise it is read as Pacific and the card says "Deadline time zone not stated".

- **Widened (2026-11-14): service codes, the contracting office, distinct solicitation numbers.** A real CA
  electrician saw one job. Three changes, all in `src/sources/` and `src/geo/`, no new host:
  1. **PSC as well as NAICS.** A notice is kept when its NAICS is a trade NAICS (as before) *or* its Product and
     Service Code is trade work (`src/sources/psc.ts`): every Y (construction) and Z (maintenance, repair,
     alteration of real property) code; J/N/K/H1–H9 only for building equipment (FSC groups 041, 044, 045, 059,
     061–063); S208, S214, S216, S218; M1M* and M1NB; P4/P400, P5/P500; F005, F006, F008, F014, F021. Titles are the
     GSA PSC Manual's, verbatim, from USAspending's PSC tree (`api.usaspending.gov/api/v2/references/filter_tree/psc/`,
     fetched 2026-11-14; acquisition.gov itself was not reachable from here). Left out on purpose, with the evidence
     of the open notices that day: custodial, food, guards, pest control (no catalog trade), M1 building groups (fuel
     depots, air traffic control, food service, concessions, a museum), salvage, fire-suppression crews, numeric
     codes (products: 5,746 of the 7,751 open US solicitations).
  2. **No place of performance → the contracting office**, when the office is in the US (`State`/`City`/`ZipCode`/
     `CountryCode` columns; the API's `officeAddress`). The card carries the flag *"Work site not named — placed at
     the contracting office"* and locate() labels it *"Contracting office: Folsom, CA (job site not named)"*; it
     is placed from the office's own city/ZIP only, never guessed from the title. A place any notice of the same
     solicitation gives still wins. No place and no US office → left out, as before (98 cards, mostly 2015–2019).
  3. **`samKey` no longer merges distinct jobs.** A 4-digit tail is an amendment only after a numeric serial other
     than 0000 (36C26127Q0026 → 36C26127Q00260001). The Bureau of Prisons (15B41827Q00000001 roof vs …0002 pumps),
     WAPA (89503326RWA000049) and the Coast Guard (70ZL1927QELIZ0001 vs …0002) number different jobs that way:
     69 families in the file were being merged into one card each, against 7 real amendments.
  Also fixed: a place with a city and a ZIP but no state is no longer put at a gazetteer town of the same name in
  another state ("Jackson" + 39216 was Jackson, CA; it is Jackson, MS).

  Measured with the real parser (`SamBulkParser`, `now` = 2026-11-14 05:27 UTC, the download time) on that day's
  full file (222,454,232 bytes, 72,204 rows, all active); states after locate():

  | | before (HEAD 697369e) | after (final, 2026-11-14) |
  |---|---:|---:|
  | notices kept by the row filters | 8,816 | 9,631 (815 by PSC or trade title alone) |
  | **cards** | **508** | **668** |
  | of them placed at the contracting office | — | 130 (16 moved to the state their title names) |
  | left out: not an open-bid type | 23,386 | 23,386 |
  | left out: not construction/trades (NAICS, PSC and title) | 39,826 | 38,965 |
  | left out: abroad | 176 | 432 |
  | left out: no place given (and no US office) | 522 | 7 |
  | left out: past due | 1,244 | 1,619 |
  | left out: stale (no deadline, posted over a year ago) | 29 | 59 |
  | **California** | **36** | **51** |
  | no state at all | 18 | 9 |

  The first wider cut gave 706 cards; review then took out what was not trade work (group 059 radar, avionics and
  radio repair, aircraft parts, leases, A/E design, carpet cleaning, janitorial) and every job abroad that had been
  placed at a US office (Kuwait, Korea, Okinawa…). Most PSC-kept notices were amendments of a few solicitations
  already past due, so the gain is +160 cards, not the ~600 a count of every J/S/H/C notice suggested. The rest of
  the volume has to come from state and local boards. Fixture: `test/fixtures/samgov-bulk-2026-11-14.csv` (66 whole
  rows, byte for byte).

## 3. Awards and prices paid

- **USAspending API** — [api.usaspending.gov](https://api.usaspending.gov/) [read]: "allows the public to
  access comprehensive U.S. government spending data… who received federal contracts or grants, geographic
  breakdowns". The home page and the [intro tutorial](https://api.usaspending.gov/docs/intro-tutorial)
  mention no key and no rate limit. [read] (Our client already backs off on 429 / 5xx.)
- **USAspending bulk files** — `POST /api/v2/bulk_download/list_monthly_files/` answered today with
  `FY2026_All_Contracts_Full_20261106.zip` and a delta file, hosted on `files.usaspending.gov`, updated
  2026-11-06. [seen] No key.
- **What the SAM bulk file's award columns add:** on award-notice rows, `AwardNumber`, `AwardDate`,
  `Award$`, `Awardee` sit in the same row as `Sol#` and `NoticeId`, so a card we showed can be closed out
  with its winner and price from the same daily file — no second lookup. Only notices the agency posts as
  awards on SAM.gov carry them; USAspending stays the full record of federal awards.

## 4. Wages and material prices

- **BLS API v1 vs v2** [search, from [bls.gov/developers/api_faqs.htm](https://www.bls.gov/developers/api_faqs.htm)
  and [bls.gov/bls/api_features.htm](https://www.bls.gov/bls/api_features.htm)]:
  v1 no key: 25 queries/day, 25 series/query, 10 years. v2 free key: 500 queries/day, 50 series/query,
  20 years. All users: 50 requests per 10 seconds. "Users must renew registration … at least once a year."
  Registration asks for an email and organization name; the key comes by email from labstat@bls.gov.
  (Our code uses the same figures: `BLS_LIMITS` in `src/market/bls.ts`.)
- **BLS flat files** — `https://download.bls.gov/pub/time.series/` (whole surveys as text files, no key).
  Not reachable from here. Third-party packages report 403s unless the User-Agent identifies the caller with a
  contact email [search]; no official BLS page saying so was found.
- **FRED** [search, [API terms](https://fred.stlouisfed.org/docs/api/terms_of_use.html)]: free key; the
  only official limit wording found was not on an official page (~120 requests/minute is reported by third
  parties). Key expiry: not stated. Its PPI and wage series are copies of BLS series. **Its API terms forbid
  storing, caching or archiving FRED content and serving it to third parties** — that is exactly our design,
  so **take BLS series from BLS, not FRED.**
- **EIA** (weekly gasoline/diesel retail prices) [search, [eia.gov/opendata](https://www.eia.gov/opendata/)]:
  free, registration required, key emailed automatically, key goes in the URL. No official rate limit
  found. Key expiry not stated. Data is federal; EIA asks to be credited
  ([copyrights & reuse](https://www.eia.gov/about/copyrights_reuse.php)).
- **Census** [search, [API user guide](https://www.census.gov/data/developers/guidance/api-user-guide.Help_&_Contact_Us.html)]:
  500 queries per IP per day without a key; a newsletter quoting a Census email says a key is required for
  all queries from 2026-05-12 (not confirmed on an official page). Keys are free at
  [api.census.gov/data/key_signup.html](https://api.census.gov/data/key_signup.html). Construction spending
  also comes as XLSX files: [historical data](https://www.census.gov/construction/c30/historical_data.html).
  This is national/regional spending, not prices — background only.

## 5. Prevailing wage

- **Federal Davis-Bacon.** sam.gov/wage-determinations [read] offers search by WD number or by category
  (DBA / SCA). **There is no wage-determination API** in GSA's API list
  ([open.gsa.gov/api](https://open.gsa.gov/api/) [read]) and **no wage-determination folder** in the public
  sam.gov/data-services listing (top level: Assistance Listings, Contract Opportunities, Data Dictionary,
  Documentation, Entity Registration, Exclusions) [read]. Each determination can be downloaded one at a time
  as text from the website [search, [DOL](https://www.dol.gov/agencies/whd/government-contracts/prevailing-wage-resource-book/db-wage-determinations)].
  SAM.gov's Terms forbid scraping the site [read] → if we want them, a person downloads the few counties we
  serve, like the Nevada PDFs.
- **Nevada Labor Commissioner** — one PDF per region (Clark, Washoe, Northern Rural, Southern Rural), with
  amendments [search]. The 2026-2027 Amendment #01 rates for Washoe and Northern Rural are already in
  `config/prevailing-wage/nevada-2026-2027.json`, sourced from
  [labor.nv.gov 2026-2027 page](https://labor.nv.gov/PrevailingWage/2026-2027_Prevailing_Wages/) (still
  marked unchecked by a person).
- **California DIR** — determinations per county and craft as HTML pages, e.g. Inside Wireman, with
  separate apprentice-rate pages [search, [DIR determinations](https://www.dir.ca.gov/oprl/DPreWageDetermination.htm)].
  No bulk download found.

## 6. Unit prices actually paid (state DOT bid tabs)

- **Caltrans Contract Cost Data** — [sv08data.dot.ca.gov](https://sv08data.dot.ca.gov/) [read]:
  "3,476,161 records in database. Latest bid-open-date imported: 11-03-2026." Search by item code or
  description, by district (12) and year (1993–2026), awarded bidder or top 2–5. Results give
  "average unit cost, standard deviation, and total price" and an index-adjusted price (current 12-month
  index CHCCI 2020 base: 146.53) [read, [help](https://sv08data.dot.ca.gov/help.php)]. One test query today,
  `%LIGHTING%`, District 03, 2025, returned "over 50 different items" [seen] — so electrical highway items
  (lighting, signals) are in it. No bulk download or API: one query at a time. Most recent bids:
  [bid summary results](https://ppmoe.dot.ca.gov/cc?id=cc_bid_summary&archived=false). Its conditions of
  use are linked but were not read.
- **NDOT** — the contract bid tabulation for each job is posted to the NDOT Public Portal after bid opening
  [search]; no average-unit-price table found. `www.dot.nv.gov` refused this machine (HTTP 403).
- **Others** with published average unit prices: TxDOT, Nebraska DOT, Louisiana DOTD, WSDOT bid tabs
  [search; not read].
- **What they tell an electrical contractor:** real low/average bids for highway electrical items —
  conduit, pull boxes, lighting and signal systems — per unit, by district and year.
  **What they don't:** building work (panels, branch circuits, fixtures inside buildings, service upgrades),
  small municipal jobs, labor hours, or the contractor's own overhead. DOT items are often lump-sum
  ("LS") systems, so they are a sanity check, not an estimate.
- **Commercial unit-cost books (RSMeans and the like) are paid** — RSMeans Data Online is sold by yearly
  subscription [search, [rsmeans.com](https://www.rsmeans.com/products/online/tiers)]. **BidSwipe does not
  use them.**

---

## (a) The rule that makes limits irrelevant to user count

**The server pulls each source once a day into our database. Users only ever read our copy.**
No user action ever calls SAM.gov, BLS, USAspending or EIA.

| | 1 user | 10,000 users |
|---|---|---|
| SAM.gov bids (bulk CSV) | 1 download/day | **1 download/day** |
| BLS refresh (v1, no key) | ≤ 25 queries/day | **≤ 25 queries/day** |
| USAspending refresh | N calls/day (per state) | **same N** |
| Our API reads | a few per app open | 10,000 × ~5 opens = ~50,000/day — our own database, no outside limit |

If instead the app called SAM.gov's API per user: 10,000 users × 1 search = 10,000 requests/day — 1,000×
the current 10/day key and 10× even a system account. The pull-once rule keeps outside calls flat while
users grow. (Cost to us: 222 MB downloaded per day ≈ 6.7 GB/month, plus parsing it.)

## (b) Use now, no key at all

- SAM.gov **bulk CSV** for federal bids (replaces the API source; ends the 90-day key chore).
- SAM.gov **archived FY CSVs** + **USAspending** API/monthly files for awards and prices paid.
- **BLS v1** (25 queries/day) for wages and PPI indexes.
- **Caltrans Contract Cost Data** by hand, for highway electrical items.
- **NV / CA prevailing-wage** tables, maintained by a person.

## (c) Free sign-ups only Ev can do

| Sign-up | Needs | How long | Unlocks |
|---|---|---|---|
| BLS API v2 key ([registration](https://data.bls.gov/registrationEngine/)) | email + organization name | key by email [search] | 500 queries/day instead of 25; renew yearly |
| EIA API key ([opendata](https://www.eia.gov/opendata/)) | email | key sent automatically [search] | weekly fuel prices |
| Census API key ([sign-up](https://api.census.gov/data/key_signup.html)) | email | not stated | construction-spending series beyond 500 queries/IP |
| SAM.gov non-federal **system account** (optional) | SAM.gov registration + approval; fixed IP list | not stated | 1,000 API calls/day — only if we ever need the API; still a 90-day key |

Not needed: FRED (its terms forbid caching), any SAM.gov key for bids once the bulk file is used.

## (d) Not available for free

- A **SAM.gov key that never expires** — every key, system accounts included, is on the 90-day rule.
- A **bulk file or API for Davis-Bacon wage determinations** — website only, scraping forbidden.
- **Unit costs for building electrical work** (RSMeans-type books) — paid, not used.
- **Bid tabs for most local agencies** — no national free feed; each board posts its own, if at all.
- **Competitors' prices before bid opening** — bids are sealed; only results after the fact exist.

## 7. State and local bid boards (wave 2, checked 2026-11-14)

Each board except caltrans (a page shell with no rows, see its row) answered one polite request on 2026-11-14 with
the scanner's own User-Agent ("BidSwipe/0.1 (daily public-bid check)"), with real open bids. Public lists only: no
login, no key. The scan group is the cron call that reads it (`src/sources/scan-groups.ts`, `vercel.json`: one call
per group, each inside the host's 300 s, a fetch budget of 200 s per group). Requests are paced 1,000 ms per host,
start to start (`util/http.ts`; the Socrata hosts ask for `Crawl-delay: 1`). Two boards are built but switched OFF
because their robots.txt says `Disallow: /` (caltrans, txesbd); four more QuestCDN boards are built and off for the same reason.

| Id | Host (what we fetch) | What | Format | Group | Rows on 2026-11-14 | Fixture / built |
|---|---|---|---|---|---|---|
| caleprocure | suppliers.fiscal.ca.gov (caleprocure.ca.gov answers 403 to the host; cards link to its /event/&lt;dept&gt;/&lt;id&gt; pages). robots.txt: none (/robots.txt is a 404, checked twice on 2026-11-14) | California State Contracts Register, every state department | PeopleSoft HTML grid, 1.18 MB, all events on one page; a 302 sets the session cookie first | west | 376 events ("1-376 of 376"); live scan: 322 kept, 54 left out as not trade work | test/fixtures/caleprocure-grid.html (12 rows); built. Detail pages (counties, licence) not read: a postback per event |
| caltrans | ppmoe.dot.ca.gov. robots.txt: **`User-agent: *` / `Disallow: /`** (read once, 2026-11-14 ~07:00 UTC; test/fixtures/caltrans-robots.txt): the host asks every automated client to stay out | Caltrans projects currently advertised | Not a list: `/des/oe/weekly-ads/all-adv-projects.php` (HTTP 200, 168 KB) is the shell of a ServiceNow Service Portal ("OE Index - PPMOE MIgration", start page `oe_index`, guest user); its 8 `<tr>` are AngularJS templates, no rows, no embedded JSON, no data-file link. Rows would load through the portal's session-token REST API (`/api/now/sp/page`) | west | ? (no project readable in the HTML) | **not built, switched OFF** (`disabledReason`): no parser on guesses, no request after robots.txt was read. Needs the owner's decision or a Caltrans feed published for reuse |
| laramp | data.lacity.org (hf3r-utnq; cards link to the listing's www.rampla.org page). robots.txt (read once, 2026-11-14 ~06:58 UTC): `User-agent: *`, `Crawl-delay: 1`, Disallow only /browse?…, /api/odata/, /api/collocate* and similar: /resource/ is allowed | Los Angeles RAMP: City departments (Public Works, Water & Power, General Services, Port, Housing Authority, Fire), LAUSD, LA County | Socrata JSON, one GET (`stagename in ('Open','Amended')`, closedate after yesterday); closedate is a floating timestamp that holds UTC (checked against the closing times LA County writes in its titles); the board's category (Construction / Commodity / Personal Services) | west | 208 rows in the dataset (Open 175, Amended 33). Live scan 07:07 UTC: 207 listed (1 page, 0.9 s), 1 practice listing, 159 not trade work (goods filed as Commodity count here), 47 kept, all placed (City departments in Los Angeles; Ontario airport in Ontario, Port of Long Beach in Long Beach; LA County and Water & Power at the state unless the text names a known town) | test/fixtures/laramp-open.json (14 rows), notes in laramp-open.md; built |
| sfbids | data.sf.gov (eshn-8t3a; data.sfgov.org answers 301 there; cards link to the event's sfcitypartner.sfgov.org page). robots.txt (read once, 2026-11-14 ~06:58 UTC): `User-agent: *`, `Crawl-delay: 1`, Disallow only /browse?…, /api/odata/, /api/collocate* and similar: /resource/ is allowed | San Francisco (SF City Partner): every City department | Socrata JSON, one GET (`status in ('Open','Amended')`, due_date after yesterday); due_date in Pacific wall clock; 2099/2100 due dates are placeholders (open lists: no deadline); reloaded about weekly (rows past due still listed); Public Works files construction under Commodity / Personal Services, so for it the words decide | west | 69 rows in the dataset (Open 48, Amended 21). Live scan 07:07 UTC: 64 listed (0.9 s), 7 closed or bid results, 42 not trade work, 15 kept, placed in San Francisco (the Airport at SFO's ZIP 94128, the PUC at the state) | test/fixtures/sfbids-open.json (13 rows), notes in sfbids-open.md; built |
| oregonbuys | oregonbuys.gov. robots.txt: /robots.txt redirects (302) to the software vendor's file, www.periscopeholdings.com/robots.txt, which then applies to this host. Read 2026-11-14 with the scanner's User-Agent: `User-agent: *` / `Disallow: /craft` only, so the bid pages are allowed | Oregon state agencies, counties, cities, districts | BuySpeed HTML (PrimeFaces), 25 a page; pages 2+ are a PrimeFaces partial POST (XML) through the first GET's cookie session and ViewState, never retried; no category or codes on the list (title only for isTradeWork), plus the board's own notices left out (sole source, change order, exempt reports); Pacific times | west | 174. Live scan 06:49 UTC: 174 read (7 pages, 7.9 s), 43 not trade work, 7 notices, 124 kept; 12 placed in a city from "City of …" | test/fixtures/oregonbuys-open-bids.html (10 rows), oregonbuys-page2.xml (the real page-2 answer, 7 rows), notes in buyspeed.md; built |
| usac470 | opendata.usac.org (jt8s-3q52; cards link to the certified Form 470 PDF on publicdata.usac.org). robots.txt (read once, 2026-11-14 ~06:58 UTC): `User-agent: *`, `Crawl-delay: 1`, Disallow only /browse?…, /api/odata/, /api/collocate* and similar: /resource/ is allowed | E-Rate FCC Form 470, nationwide: schools and libraries asking for quotes. Only Category 2 Internal Connections, and only forms with cabling or installed building work (access points, antennas/connectors, racks, UPS); not internet service, managed broadband, basic maintenance, equipment-only or network-gear-only forms. NOT a sealed bid: own flag (`ERATE_470_FLAG`) and card text | Socrata JSON, `$select` without the contact columns, certified, funding year ≥ this year, allowable contract date not passed; 1,000 rows a page (one row per service line per RFP document), grouped into one card per form (Current version wins); due = only a due date the form's own text names (e.g. "Bid response due … by 4:00 PM PST on December 2, 2026"), in the applicant's state zone; else no due date (the card says the RFP sets it). The allowable contract date is the FIRST day a contract may be signed, not a quote deadline | west | Internal Connections rows with a future allowable date: 4,007 (all funding year 2027; 564–698 distinct forms: 134 Current + 564 Original by `count(distinct application_number)`, scratch capture usac-ver.json). Live scan 07:07–07:09 UTC: 4,208 rows (5 pages, 4.9 s), 713 forms, 21 past their date, 225 left out, 467 kept (first run, before the network-gear rule: 539, CA 32, NV 2) | test/fixtures/usac470-ca-nv.json (7 whole CA/NV forms, 40 rows), notes in usac470-ca-nv.md; built |
| commbuys | www.commbuys.com. robots.txt: /robots.txt redirects (302) to the software vendor's file, www.periscopeholdings.com/robots.txt, which then applies to this host. Read 2026-11-14 with the scanner's User-Agent: `User-agent: *` / `Disallow: /craft` only, so the bid pages are allowed | Massachusetts state agencies, towns, housing authorities, municipal light plants | BuySpeed HTML, as oregonbuys; Eastern times | east (runs last in the group: it needs the time) | 890. Live scan 06:49 UTC: 890 read (36 pages, 152.6 s, about 4.2 s a page: the board is slow, well above the 900 ms gap), 159 not trade work, 1 notice, 730 kept; 265 placed in a town. 194 list an opening date over a year out (standing master agreements), 6 one already past, 2 none | test/fixtures/commbuys-open-bids.html (10 rows); built |
| bidbuy | www.bidbuy.illinois.gov. robots.txt: /robots.txt redirects (302) to the software vendor's file, www.periscopeholdings.com/robots.txt, which then applies to this host. Read 2026-11-14 with the scanner's User-Agent: `User-agent: *` / `Disallow: /craft` only, so the bid pages are allowed | Illinois state agencies (Tollway, DNR, DHS, CMS …) | BuySpeed HTML, as oregonbuys; Central times | east | 149. Live scan 06:49 UTC: 149 read (6 pages, 6.3 s), 28 not trade work, 23 notices (change-order and exempt notices), 98 kept, all placed at the state | test/fixtures/bidbuy-open-bids.html (8 rows); built |
| njstart | www.njstart.gov. robots.txt: /robots.txt redirects (302) to the software vendor's file, www.periscopeholdings.com/robots.txt, which then applies to this host. Read 2026-11-14 with the scanner's User-Agent: `User-agent: *` / `Disallow: /craft` only, so the bid pages are allowed | New Jersey state contracts (Division of Purchase and Property) | BuySpeed HTML, one page ("Contract #" where the others say "Blanket #"); Eastern times | east | 19. Live scan 06:49 UTC: 19 read (1 page, 0.6 s), 15 not trade work, 4 kept | test/fixtures/njstart-open-bids.html (all 19 rows); built |
| nevadaepro (existing) | nevadaepro.com. robots.txt: /robots.txt redirects (302) to the software vendor's file, www.periscopeholdings.com/robots.txt, which then applies to this host. Read 2026-11-14 with the scanner's User-Agent: `User-agent: *` / `Disallow: /craft` only, so the bid pages are allowed | Nevada State Purchasing | BuySpeed HTML; now paged like the others; every row kept as before (no trade filter: the pilot's feed is unchanged) | default | 29. Live scan 06:49 UTC: 29 of 29 read (2 pages, 1.7 s) | test/fixtures/nevadaepro-open-bids.html (2026-11-13); built |
| nycrecord | data.cityofnewyork.us (dg92-zbpx; cards link to a856-cityrecord.nyc.gov/RequestDetail/&lt;request_id&gt;: pattern, not fetched, that host refuses the proxy here). robots.txt (read once, 2026-11-14 ~06:58 UTC): `User-agent: *`, `Crawl-delay: 1`, Disallow only /browse?…, /api/odata/, /api/collocate* and similar: /resource/ is allowed | NYC City Record Online: section Procurement, notice type Solicitation (the dataset is 1.1 M rows, mostly personnel) | Socrata JSON, one GET with `$select` (no contact columns); due_date in New York wall clock; 2999/2099 due dates are open pre-qualified lists (kept only when the notice is under 18 months old); one card per agency + PIN (newest notice); Human Services and Goods that name no work left out; site ZIP only from a "LOCATION:" line | east | Procurement rows due after 2026-11-14: 198 Solicitation + 5 Intent to Award. Live scan 07:07 UTC: 202 listed (2.1 s), 78 closed / stale lists / cancellations, 1 older notice of a PIN, 39 not trade work, 84 kept, all placed (New York; Bronx etc. from a LOCATION line) | test/fixtures/nycrecord-open.json (18 rows), notes in nycrecord-open.md; built |
| txesbd | www.txsmartbuy.gov (cards would link to its /esbddetails/view/&lt;solicitation id&gt; pages, path not confirmed). robots.txt: **`User-agent: *` / `Disallow: /`** (read once, 2026-11-14 06:40 UTC): the host asks every automated client to stay out | Texas Electronic State Business Daily: state agencies, universities, many counties, cities, ISDs | JSON POST (`ESBD.Service.ss`, body `{"lines":[],"page":N,"urlRoot":"esbd","status":"1"}`), 24 a page; due date + time as Central wall clock, NIGP codes per line | south | 501 "Posted" (status 1, which also holds "Addendum Posted" lines: 14 of the first 24); first page only, 10 of 13 fixture lines kept as trade work | test/fixtures/txesbd-page1.json (13 lines), notes in txesbd.md; built and tested, **switched OFF** (`disabledReason`, robots.txt). No live check, no request after robots.txt was read. Paging and the status 6 pass are tested on fakes only |
| flmfmp | vendor.myfloridamarketplace.com (cards link to its /search/bids/detail/&lt;advertisementId&gt; pages). robots.txt: none (/robots.txt answers 404 "Cannot GET /robots.txt", 2026-11-14 06:40 UTC) | MyFloridaMarketPlace: State of Florida agencies, universities, water management districts, a few towns | JSON POST (needs Accept: application/json, else the web app's HTML), a bare array, 100 a page, 1-based, until a short page; dates are ISO instants with a zone | south | 120 open ads (100 + 20, 2 pages). Live scan 06:49 UTC: 120 read, 27 left out by type (5 Agency Decision, 4 Grant Opportunities, 1 Informational Notice, 2 Request for Information, 15 Single Source), 28 left out as not trade work, 65 kept | test/fixtures/flmfmp-bids-page1.json (17 ads), -page2.json (7), notes in flmfmp.md; built |
| opengov | api.procurement.opengov.com (cards link to procurement.opengov.com/portal/&lt;code&gt;/projects/&lt;id&gt;, never fetched). robots.txt: none (api host /robots.txt answers 404 `{"message":"Not Found"}`, 2026-11-14 06:27 UTC; procurement.opengov.com/robots.txt answers the web app's HTML page, not a robots file, read 2026-11-14) | OpenGov Procurement portals: 588 governments listed, 562 active and not deleted; we read the 543 that are not OpenGov's own (19 `isInternal`: demos, training, QA) and have a state (the 1 left without is a test portal) | JSON: GET the government list (1.8 MB), then one POST per government (`project/public`, status open, 100 a page); deadlines are ISO instants with a zone | opengov-1 … opengov-5 (sliced by state) | Live, CA slice only (opengov-1, 06:33 UTC): 115 governments read, 0 failed, 359 open projects at 69 of them, 291 kept, 68 left out as not trade work, 104 s | test/fixtures/opengov-governments.json (13 entries), opengov-projects-saccounty.json (11), -lakeport.json (1), -empty.json (0), notes in opengov.md; built. Paging past 100 open projects per government is coded but not seen live |
| questcdn (more boards) | qcpi.questcdn.com. robots.txt: /robots.txt answers 302 to https://www.questcdn.com/robots.txt/, which says for every client **`User-agent: *` / `Disallow: /quest/` / `Disallow: /questcdn/` / `Disallow: /`** (then Allow only /about, /solicitors, /bidders, /online-bidding, /news; read 2026-11-14 with the scanner's User-Agent): the host asks every automated client to stay out | Four agency boards the parser reads: NV State Parks (8011805), Lake County CA (7484192), City of Campbell CA (5618062), City of Glendora CA (5645931) | JSON (`browse_posting`, one GET per board), bid times carry their zone ("PST") | none | 1 open project on each (one request each, 07:01 UTC, before the robots file could be opened) | test/fixtures/questcdn-nvparks.json, -lakecounty.json, -campbell.json, -glendora.json (raw, one row each), notes in questcdn.md; built and tested, **switched OFF** (`QUEST_BOARDS_OFF`, `QUEST_OFF_REASON` in src/sources/questcdn.ts): the scan never asks for them. **The pilot's NV Public Works board (1903611) is on the same host and still runs**, as it did before the file was read: keeping it on or switching it off is the owner's decision |

**Final live scan of every group** (2026-11-14 07:45–08:05 UTC, after the review fixes): no source failed or stopped
at its budget; per-group wall clock and listed → kept counts are in docs/HANDOFF.md §2 "wave 2" (e.g. caleprocure
376 → 314, opengov 542 governments → 1,186 kept, commbuys 890 → 727 in 156 s). The counts in the rows above are
each builder's first live run.

**Terms of use.** robots.txt is recorded above for every host. Terms of use were NOT read for any of these boards in
this pass (no terms on automated access were found on the pages we fetched; none was looked for beyond them). Per
board: caleprocure, opengov, oregonbuys, commbuys, bidbuy, njstart, nevadaepro, flmfmp, laramp, sfbids, nycrecord,
usac470, questcdn: "no terms on automated access found; terms page not read". caltrans, txesbd and the four added
QuestCDN boards are off by robots.txt.

**Not confirmed before launch** (each is one read by a person, not by the scanner):
- (done 2026-11-14, after the three hosts were allowed here) www.periscopeholdings.com/robots.txt: only `/craft` is
  disallowed, the five BuySpeed boards are fine; procurement.opengov.com has no robots file; www.questcdn.com/robots.txt
  says `Disallow: /`: the four added QuestCDN boards are off, and the pilot's NV Public Works board needs the
  owner's decision;
- the terms pages: Oregon DAS Procurement's TermsOfUse (oregonbuys), the COMMBUYS / Periscope policies, the
  MyFloridaMarketPlace Terms of Use, OpenGov's portal terms, Cal eProcure's conditions of use, and the Socrata
  open-data terms of the four city/USAC portals;
- the card links never opened from here: caleprocure.ca.gov/event/…, a856-cityrecord.nyc.gov/RequestDetail/…,
  vendor.myfloridamarketplace.com/search/bids/detail/…, procurement.opengov.com/portal/…/projects/….

Left out on purpose: Virginia eVA (AWS WAF challenge), PlanetBids (needs a browser), Public Purchase (terms),
El Dorado County's own site (Akamai "Access Denied" to the host), anything behind a login.

What every one of them must do (CLAUDE.md "Rules"): a pure parser tested on a raw saved response; `fetch()` throws
on a page it does not expect; times through `util/time.ts` in the board's own zone; only trade work
(`src/sources/relevance.ts isTradeWork`, with the board's category or codes), the rest counted in the log.

## 8. Placement tables (where a state bid is, checked 2026-11-14)

Cal eProcure lists only an event name, a department and an event id: no site. `src/geo/caleprocure-place.ts` places
a card from those three, in this order: a town the title names with corroboration, one county, several counties,
the Caltrans district in a department-2660 event id, the department's own place, else unplaced
(`src/geo/california.ts` holds the tables). Nothing here is fetched at run time; every table is typed in the repo.

| Table | Where it comes from | What it is used for |
|---|---|---|
| 58 counties and their seats (`CA_COUNTIES`) | the California State Association of Counties county list (counties.org), the same seats the Secretary of State lists. Ventura's official seat is San Buenaventura; the ZIP table calls it Ventura | an area's reach: in reach when its nearest county seat is within the travel radius + 25 mi. The seat is never shown as the job's distance |
| 12 Caltrans districts and their counties (`CALTRANS_DISTRICTS`) | Caltrans' own district pages, dot.ca.gov/caltrans-near-me/district-1 … district-12. Kern is in District 6 (west) and District 9 (east); District 12 is Orange County alone | a 2660 event id that starts with 01–12 ("10-1H0204", "03A4243") is an area of that district. Checked against the 26 real rows of 2026-11-14 that name counties: 25 name only their district's counties; the nine TMS rows (56A0915–56A0923) list each district's counties exactly |
| Campuses and agencies with one town (`CA_AGENCY_TOWNS`) | the campuses' own addresses (CSU Channel Islands is in Camarillo, Dominguez Hills in Carson, Northridge in Los Angeles; UC Davis Medical Center in Sacramento; 22nd DAA = Del Mar Fairgrounds) | a card of that department is placed in that town (precision 'agency') |
| Facilities whose town is certain (`CA_FACILITIES`) | each facility's published address: CSP Solano (Vacaville), SATF and CSP Corcoran (Corcoran), Pelican Bay (Crescent City), SVSP (Soledad), DSH Napa / Atascadero, Porterville DC, CalPERS Lincoln Plaza (Sacramento), the CHP Academy (West Sacramento), named state parks, Ramona Air Attack Base, Camp San Luis Obispo, Camp Roberts | a title that names the facility is placed in its town; a facility certain only of its county is an area of that county |
| Town points | the nationwide ZIP table (`src/geo/zip.ts`, the `zipcodes` package) | a corroborated town's point, and every seat's point |

There are no county outlines: whether a company lies in a county is not known, only how far it is from the seat.
A one-county area is therefore judged by the seat's distance, and the no says so ("San Bernardino County's seat is
161 mi away — outside your 60 mi range (site not named …)").

