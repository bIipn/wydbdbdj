# BidSwipe — handoff notes (v0, 2026-11-12)

Everything learned while building v0, so nobody has to re-research it. The product vision (price
action, spend limit, alerts, Pro bot, codes) lives in `docs/PRODUCT.md`.

## 1. Where things stand

| Area | Status |
|---|---|
| 5 source connectors | ✅ built · ✅ parsers tested on the raw server responses · ⚠️ first live scan 2026-11-13: three sources came back short with no error — fixed offline against the pages saved that day, **live re-scan still to confirm** |
| Location + distance | ✅ tested (gazetteer covers N. Nevada, Tahoe, CA side; recognizes far-away places to reject them) |
| Fit scoring + reasons | ✅ tested, sane on real data (see §4) |
| Postgres schema + repo | ✅ PGlite tested; Supabase path written, not yet run against Supabase |
| API (Fastify) | ✅ tested with `inject`, plus a real server checked in Chrome |
| Swipe app (web/) | ✅ checked in headless Chrome at 390×844: swipe, buttons, keyboard, undo, browse, saved, details |
| Daily scheduler + digest | ✅ unit tested; Resend send path written, not yet sent for real |
| Deploy (PM2/Caddy) | 📄 configs written, not deployed |

**First live scan (2026-11-13):** `douglascounty` 0 bids (1 expected), `nevadaepro` 0 (25 expected), `ngem`
20 from 1 page (46 on 3 pages) — and no error from any of them. One cause behind all three: the fixtures
had been saved from a browser *after* page JavaScript ran, while the scanner gets the raw server HTML,
which is shaped differently (details per source in §2). What changed:
- `test/fixtures/` now holds the raw responses (HTML captured 2026-11-13; QuestCDN JSON 2026-11-11).
- Each of the three sources throws when it can't read its page (→ FAILED in the scan report) instead of
  returning 0, and logs what it read next to what the board lists.
- The http helper has an opt-in cookie session (`ctx.http.session()`) for NGEM's paging.

**Next:** re-run `npm run scan -- --no-notify` (`.claude/skills/live-scan`). Against the pages saved on
2026-11-13 the log reads `douglascounty: 1 open of 90 rows`, `nevadaepro: 25 of 29 listed (first page
only)` and `ngem: 46 of 46 listed (pages 3/3)`; the counts move daily. The fixes have only been run
against those saved pages, not against the live boards.

## 2. Sources — what we found

### Douglas County, NV — `douglascounty`
- List: `https://www.douglascountynv.gov/rfp-bids` (CivicLive CMS, server-rendered, ~890 KB: one table
  with 90 rows, open and closed together, deadlines back to 2018).
- `table#rfp-table` → rows `tr.rfp-item`; cells: name, `td.status`, description (the full legal ad),
  `td.posted-date` (YYYY/MM/DD), `td.deadline-date`, "View Details" link.
- **Open/closed is not in the HTML.** The server sends every row with an empty `td.status`; an inline
  script writes "Open"/"Close" and the `s-open`/`s-close` classes in the browser, by comparing
  `td.deadline-date` with today's date. The first parser looked for those classes → 0 bids on the live
  scan. Now `parseDouglasPage(html, { now })` decides: a due time found in the legal ad wins (open until
  that moment); with no time in the ad it follows the county's own rule (open until the day before the
  deadline date, Pacific time — closed on the deadline day itself). Rows already stamped (a page saved
  from a browser) are still honored. `fetch()` logs `douglascounty: 1 open of 90 rows`; 0 open is a
  normal day, a missing table or rows it can't read is a failure.
- Quirks: name cell is sometimes empty → title recovered from the ad ("SOLICITATION OF BIDS / <name>").
  `deadline-date` is not always the bid opening → real deadline parsed from the ad ("until 2:00 p.m.
  local time on Thursday, July 30, 2026"). On the 2026-11-13 page the ad's day differs from the cell in
  2 of 90 rows (Jobs Peak PLC: cell 7/20, bids due 7/30; Dangberg Home Ranch: cell 6/21, ad 6/6); the
  scan logs each such row while it matters. `findDueInText` finds a time in about half the ads (44 of
  90); the rest fall back to the date-only rule. Ads include the engineer's estimate ("$81,000.00") and
  bid bond / prevailing wage → parsed into `estValue` and `flags`.
- Bid documents themselves are on QuestCDN (Douglas County Public Works has its own board — group id
  not found yet; worth adding to `QUEST_BOARDS`).
- On 2026-11-13 only 1 open row (a library strategic plan) — the county is quiet; electrical jobs do
  appear (e.g. "Electrical Improvements at Walley's & Genoa Lakes", "Jobs Peak WTP PLC Replacement").

### NV State Public Works Division (SPWD) via QuestCDN — `questcdn`
- Board page: `https://qcpi.questcdn.com/cdn/posting/?group=1903611&provider=1903611` (linked from
  publicworks.nv.gov → Bids → Bid Advertisements).
- Rows load from JSON (DataTables server-side). Works **without a session cookie** when group/provider
  are in the query string:
  `https://qcpi.questcdn.com/cdn/browse_posting/?group=1903611&provider=1903611&search_id=&postings_since_last_login=&draw=1&start=0&length=100`
  → `{recordsTotal, data:[{project_id, render_name, render_category_search_string, bid_date_str,
  render_city, render_county, state_code, render_owner, render_solicitor, posting_type, …}], result:"ok"}`.
- Quirks: `render_*` values are truncated with "..." (~50 chars). County is sometimes "United States".
  Category strings include "Electrical Installation/Constr…" — great signal.
- SPWD requires bidders to be **SPWD-qualified and NV-licensed before bid opening** → flagged on cards.
- 13 open projects on 2026-11-11, incl. the two best L&M fits (Carson City cell doors/intercoms/controls;
  Yerington fire alarm).

### NGEM (Nevada Government eMarketplace) on IonWave — `ngem`
- `https://nevada.ionwave.net/SourcingEvents.aspx?SourceType=1` — public, no login. One list for many
  agencies: Carson City, Reno-Tahoe Airport, BCN Purchasing (UNR/TMCC), Clark County, UNLV, Henderson,
  North Las Vegas… (Carson City posts *only* here.)
- Telerik RadGrid `table.rgMasterTable`, rows `tr.rgRow|tr.rgAltRow`. Columns (`colBidNumber, colTitle,
  colTypeTitle, colWorkGroupName, colOpenDate, colCloseDate`) are named from the header. The raw `th`
  has no `aria-label` (page JavaScript adds it), so the parser reads the sort field in the header link's
  onclick (`Grid.Sort(…, 'BidNumber')`), then the visible label; fixed positions are the last resort and
  are logged when used.
- **Paging is an ASP.NET postback, not GET links** (20/page; 46 items in 3 pages on 2026-11-13). The raw
  pager links are `javascript:__doPostBack('…$ctl06','')`. The
  `…&ctl00_mainContent_rgBidListChangePage=2_20` links the first parser followed only exist in a browser
  (so the first live scan found none and read 1 page of 3), and fetched directly that URL returns page 1
  again. What works (used to fetch pages 2 and 3 on 2026-11-13): GET page 1 and keep its cookies
  (`ASP.NET_SessionId`, `__AntiXsrfToken`), then POST to the same URL, form-encoded, every hidden input
  of the page just read (`__VIEWSTATE` …) plus `__EVENTTARGET` = the pager link's target and an empty
  `__EVENTARGUMENT`.
- **Never post without those cookies:** the board answers with an "An error has occurred" page (5 KB,
  HTTP 200) that says an error report went to its administrators. So `fetch()` checks the cookie names
  first, sends each POST once (the http helper retries GET/HEAD only), reads at most 8 pages, and at the
  first odd answer (error page, wrong page number, nothing new) keeps the pages it has and logs
  `— stopped: <reason>`. Only a page 1 it can't read fails the source.
- Quirks: bid numbers get " Addendum N" appended → id = org + base number. Some titles are blank.
  The row's view icon has no href in the captured HTML → cards link to the list page.
- Most volume is Las Vegas (rejected by distance) — Reno/Carson items are what matter.

### NevadaEPro (State Purchasing, Periscope BSO) — `nevadaepro`
- `https://nevadaepro.com/bso/view/search/external/advancedSearchBid.xhtml?openBids=true` — public.
- PrimeFaces table. The raw cells are bare (`<td role="gridcell">Department of Wildlife</td>`); the
  column labels are only in `<thead>` (11 `th` for 11 `td`), so each cell takes the label of the header
  at the same position — mapped by label, never by a fixed index. The in-cell
  `<span class="ui-column-title">` the first parser relied on only exists in a browser (page JavaScript
  copies the label into each cell) → 0 bids on the live scan. Hidden duplicate columns
  (`style="display:none"`, two of the 11) skipped. Detail: `bso/external/bidDetail.sda?docId=…`.
- First page = 25 newest open bids; the paginator said "1-25 of 29" on 2026-11-13 and the scan logs
  `nevadaepro: 25 of 29 listed (first page only)`. Paging is a JSF POST — not implemented, so the oldest
  few are never read on a fresh database; daily scans cover new ones.
- Mostly goods/services (vehicles, janitorial, food). Electrical-ish items (e.g. "Generator") may be
  supply-only → flagged "May be supply-only" with a small penalty. No location field → statewide.

### SAM.gov (federal) — `samgov`
- Official `https://api.sam.gov/opportunities/v2/search` with `api_key`, `postedFrom`/`postedTo`
  (MM/dd/yyyy, required), `ptype`, `state`, `ncode`, `limit` (≤1000), `offset`.
- Key: sam.gov → Account Details → Public API Key. Personal keys can have a very low daily request cap,
  so v0 makes only **3 calls/day**: NV (all), CA + NAICS 238210, CA + 236220; scoring filters the rest.
- ⚠️ Verify on first live run: that `ptype=o,k,p` (comma list) is accepted. If not, loop per type.
- Set-asides are scored against `setAsidesEligible` (L&M: SBA, SBP).

### Looked at, not built yet (next sources, in order of value for L&M)
1. **Douglas County School District** — posts bid docs on its website + legal ads in The Record-Courier
   (recordcourier.com "Douglas County legal"). Recent: "LED Conversion Project", "Generator
   Inspections", "Roof Top Unit Replacement". Very relevant; URL of their bid page not found yet.
2. **Douglas County Public Works QuestCDN board** — find the group id (Quest numbers appear in county ads).
3. **City of South Lake Tahoe / Lake Tahoe Unified (CA)** — PlanetBids (JS app; find its JSON API).
4. **NDOT** contract services; **Carson City School District**; **Washoe County School District**.
5. **Newspaper legal notices** (Record-Courier, Nevada Appeal) — catch-all for anything ≥ $100K.

Never: PlanHub, BuildingConnected, ConstructConnect, Dodge (login-walled / ToS).

## 3. Decisions (and why)
- **Link out to bid, never handle bids.** No liability, no Apple payment rules for the core flow.
- **Aggregator first, marketplace later.** Indeed's path. Avoids the two-sided cold start.
- **Rule-based, explainable scoring (no LLM yet).** The pilot owner is skeptical — every score shows its
  reasons. AI (summaries/drafts) later runs once per *bid*, not per user, so free users stay cheap.
- **`score = trade + (distance + size + runway) × tradeFactor − penalties`.** Without the factor, a paving
  job 2 mi away scored "good". Factor: electrical 1.0 · related 0.75 · general construction 0.45.
- **Embedded Postgres (PGlite) for the pilot**, same SQL as Supabase → zero migration later.
- **One process in prod** (server runs the daily scan) because PGlite is single-process.
- **Vanilla JS PWA** first: fastest path to people swiping on phones; native shell (Capacitor/Expo) later.
- **Free first, paid later:** free = swipe + daily digest; paid = instant push alerts, AI bid summaries,
  bid drafting, more regions. Bill on the web (Stripe), not in-app.

## 4. Scoring on real data (2026-11-11, 31 open bids)
great 2 · good 1 · maybe 5 · skip 23. Top: 82 SPWD cell doors/intercoms/controls (Carson City, 15 mi) ·
77 SPWD fire sprinkler + fire alarm (Yerington, 32 mi) · 60 NevadaEPro "Generator" (supply-only flag) ·
53 elevator modernizations (related) · 45 HVAC maintenance (N. Nevada) · 40 fire suppression (Reno).
Correctly rejected: janitorial, furniture, traffic-control services, strategic plan, all Las Vegas items.

## 5. Open questions for L&M (tune `config/lm-electric.json` with their answers)
- Real service radius? (now 90 mi straight-line) · Will they do CA-side Tahoe work (C-10 license)?
- Bonding capacity? (affects public jobs > $100K) · SPWD-qualified? NGEM / NevadaEPro registered?
- Job types they want more/less of (service calls, TI, lighting retrofits, generators, solar, EV)?
- Who gets the digest email, and what time?
- Many $10K–$50K jobs are informal quotes that are never posted → get L&M onto agency vendor lists.

## 6. Roadmap
**Now (pilot)**
1. First live scan; fix sources; refresh fixtures. 2. `.env` + deploy to the VPS (PM2 + Caddy, README).
3. Add DCSD + Douglas County QuestCDN board. 4. Two weeks of real use with L&M → tune keywords.

**Next (multi-user)**
5. Supabase Auth + `profiles` per business; onboarding (trade, home base, radius, value range).
6. Per-user scoring is already supported (`matches` is keyed by profile) — wire profile selection to auth.
7. Push notifications for new great/good matches (web push first).

**Then (stores)**
8. Wrap with Capacitor (fastest) or rebuild the deck in Expo; App Store review needs real native value
   (push, saved list offline) beyond a web wrapper. 9. Paid tier (Stripe on the web). 10. More states.

## 7. Files that matter most
`src/score/score.ts` · `config/lm-electric.json` · `src/sources/*` · `src/geo/places.ts` ·
`web/app.js` · `test/score.test.ts` · `test/sources.test.ts`
