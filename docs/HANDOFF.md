# BidSwipe — handoff notes (v1, updated 2026-11-13)

Everything learned while building v0, so nobody has to re-research it. The product vision (price
action, spend limit, alerts, Pro bot, codes) lives in `docs/PRODUCT.md`.

## 1. Where things stand

| Area | Status |
|---|---|
| 5 source connectors | ✅ parsers tested on raw responses · ✅ live scan 2026-11-13 read every board (107 open bids) · ⚠️ the three source fixes made after it (Douglas, NevadaEPro, NGEM paging) are tested on that day's pages, not yet re-run live |
| Location + distance | ✅ gazetteer + nationwide ZIP table; SAM places parsed from every shape in the real responses; a listed address we can't place stays unplaced (no guess) |
| Fit scoring + reasons | ✅ audited on the 107 live bids (see §4); certification set-asides and program contracts are hard no's, presolicitations/RFIs never alert |
| Accounts, onboarding, settings | ✅ tested + checked in a phone-size browser (`AUTH_MODE=accounts`); OAuth (Supabase) written, never run |
| Search, filters, next up, spend limits | ✅ tested; no captured bid lists a value, so limits/value filters were only seen on a simulated row |
| Live alerts (inbox + SSE) | ✅ tested + seen in the browser; web push wired, never delivered end to end |
| Price check (awards, wages, indexes, NV prevailing wage) | ✅ tested; real USAspending pull (NV 266, CA 2078 awards) and real BLS responses (fixtures) seen in the browser. Prevailing-wage rates were typed from the state PDF, not double-checked |
| Cost engine (`POST /api/estimate`) | ❌ not built, answers 501 |
| Postgres schema + repo | ✅ PGlite tested; Supabase path written, not yet run against Supabase |
| Deploy (PM2/Caddy) | 📄 configs written, not deployed |

**Final check, 2026-11-13** (commit "v1: reconciled core…"): typecheck, 1025 tests and build pass. The
built server (`node dist/server.js`, `SOURCES=fixtures`) was driven in Chromium at 390×844: sign-up,
onboarding, a live scan raising 2 alerts, swipe + next up, browse search/filters, bid sheet with price
check, market, alerts inbox, settings, sign-out (accounts + `DEMO_MODE=1`), and the pilot's single mode.

**Live data, 2026-11-13:** SAM.gov answered 3 queries (32 notices, saved trimmed in
`test/fixtures/samgov-*.json` — real data now; the old synthetic `samgov-search.json` is gone). The 107
open bids of that scan, re-scored with the final code at the scan's clock: great 3 → 2, good 3 → 0,
maybe 10 → 6, skip 91 → 96; 3 duplicate SAM cards merged (104 cards); federal cards with a distance 7 of
22 → 17 of 19. Alerts (55+) went from 6 to 2 (Cell Doors 82, Fire Sprinkler/Fire Alarm 77): both IDIQ
JOCs and the $465M MATOC are program contracts, the J061 breaker testing is SDVOSB-only, "Generator" names
no work (supply board). Both remaining alerts need SPWD bidder qualification — ask L&M (§5).

**Next:** re-run `npm run scan -- --no-notify` live (`.claude/skills/live-scan`) to confirm the source
fixes; answer the §5 questions; deploy.

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
  4 of 90 rows (Jobs Peak PLC: cell 7/20, bids due 7/30; Dangberg Home Ranch: cell 6/21, ad 6/6; Herbig
  Park: cell 6/21, ad "Thursday, June 20th" with no year; DCSO Records: cell 2022/01/17, ad 02/17/2022);
  the scan logs each such row while it matters.
- Due time: `findDue` (util/time.ts) reads a clock time in 62 of the 90 ads, which is every ad on that
  page that states one. The short ads word it many ways ("received by November 9, 2026 no later than
  2:00pm", "Bid Due Date: 2PM Thursday August 25, 2022", "due by 9AM, March 21, 2024"); the first
  version missed 14 of them and showed 5:00 PM instead. Each wording is a test in `test/util.test.ts`:
  when the county words one a new way, add it there first. 1 ad gives a date only ("Deadline
  9/23/2021") and 27 give nothing: those rows keep the 5 PM default and the county's date-only rule.
- E-mail addresses: the raw HTML has Cloudflare's placeholder "[email protected]" in 46 of 90 ads (a
  browser script puts the address back). The parser shows "(e-mail address on the county page)"
  instead. Decoding is possible (`data-cfemail`, XOR with the first byte) but would republish addresses
  the county hides from scrapers. Ev's call.
- Ads include the engineer's estimate ("$81,000.00") and bid bond / prevailing wage → parsed into
  `estValue` and `flags`. The county's standard line "Attendance at the pre-bid conference is highly
  encouraged but is not mandatory" must not raise "Mandatory pre-bid" (it did, on 6 ads).
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
- `ptype=o,k,p` (comma list) was accepted on the 2026-11-13 live run. Raw responses (trimmed, contacts and
  links removed) are `test/fixtures/samgov-nv.json`, `samgov-ca-238210.json`, `samgov-ca-236220.json`.
- One card per solicitation (`samgov:<sol number>`): amendments, presolicitations and repeats across the
  3 queries merge, newest notice wins. Place of performance comes in many shapes (ZIP only, street text,
  city "0", state by name, several sites) — `parseSamPlace` reads them all; never the office address.
- Flags `Presolicitation` and `Program contract` (IDIQ/JOC/MATOC/MACC/BPA/OTA) and the set-aside codes are
  shared with the scorer in `src/sources/flags.ts`. Certification set-asides (8(a), HUBZone, SDVOSB,
  WOSB…) are a hard no unless listed in `setAsidesEligible` (L&M: SBA, SBP — an assumption, see §5).

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

## 4. Scoring on real data (2026-11-11, 31 open bids — v0, superseded by §1's 2026-11-13 re-score)
great 2 · good 1 · maybe 5 · skip 23. Top: 82 SPWD cell doors/intercoms/controls (Carson City, 15 mi) ·
77 SPWD fire sprinkler + fire alarm (Yerington, 32 mi) · 60 NevadaEPro "Generator" (supply-only flag) ·
53 elevator modernizations (related) · 45 HVAC maintenance (N. Nevada) · 40 fire suppression (Reno).
Correctly rejected: janitorial, furniture, traffic-control services, strategic plan, all Las Vegas items.

## 5. Open questions for L&M (tune `config/lm-electric.json` with their answers)
- Real service radius? (now 90 mi straight-line) · Will they do CA-side Tahoe work (C-10 license)?
- Bonding capacity? (affects public jobs > $100K) · **SPWD-qualified?** (both current alerts need it) ·
  NGEM / NevadaEPro registered? · Certified for any federal set-aside (SDVOSB, 8(a), HUBZone, WOSB)?
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
`src/score/score.ts` · `config/lm-electric.json` · `src/sources/*` (incl. `flags.ts`, `dedupe.ts`) ·
`src/geo/places.ts` + `locate.ts` · `src/routes/*` · `web/js/*` · `test/score.test.ts` ·
`test/score-audit.test.ts` · `test/federal-chain.test.ts` · `test/sources.test.ts`
