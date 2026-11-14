# BidSwipe — handoff notes (v1, updated 2026-11-13)

Everything learned while building v0, so nobody has to re-research it. The product vision (price
action, spend limit, alerts, Pro bot, codes) lives in `docs/PRODUCT.md`.

## 1. Where things stand

| Area | Status |
|---|---|
| 5 source connectors | ✅ parsers tested on raw responses · ✅ live scan 2026-11-13 read every board (107 open bids) · ⚠️ the three source fixes made after it (Douglas, NevadaEPro, NGEM paging) are tested on that day's pages, not yet re-run live |
| Location + distance | ✅ gazetteer + nationwide ZIP table; SAM places parsed from every shape in the real responses; a listed address we can't place stays unplaced (no guess) |
| Fit scoring + reasons | ✅ audited on the 107 live bids (see §4); certification set-asides and program contracts are hard no's, presolicitations/RFIs never alert |
| Accounts, onboarding, settings | ✅ tested + checked in a phone-size browser (`AUTH_MODE=accounts`); OAuth (Supabase) written, never run. Delete my account and forgot password: ✅ built 2026-11-14 (see below); the reset email has never been sent for real (no Resend key on the host) |
| Search, filters, next up, spend limits | ✅ tested; no captured bid lists a value, so limits/value filters were only seen on a simulated row (the simulation reports them as "not exercised") |
| Live alerts (inbox + SSE) | ✅ tested + seen in the browser; frames now leave as each alert is stored (the scan yields), measured ~0.4 ms stored→stream in the simulation; web push wired, never delivered end to end |
| Price + award watch (`MARKET_REFRESH_AT`) | ✅ tested on replays of the real BLS/USAspending captures with labelled synthetic "after" data; one live NV award pull (36 awards) by its builder. Not yet run on a schedule against the live APIs. Award matching works for SAM.gov bids only (solicitation numbers) |
| Price check (awards, wages, indexes, NV prevailing wage) | ✅ tested; real USAspending pull (NV 266, CA 2078 awards) and real BLS responses (fixtures) seen in the browser. Prevailing-wage rates were typed from the state PDF, not double-checked |
| Cost engine (`POST /api/estimate`) | ✅ built (src/cost, integer cents), proven by a second implementation (test/cost-oracle) and `npm run simulate:cost`; Pro only (402 otherwise). Screen in web/js/views/cost.js, checked at 390×844 |
| Multi-company simulation | ✅ `npm run simulate`: 16 simulated companies on the 111 real captured bids, all checks pass, same seed same hash, 10 of 10 mutations caught (+1 checker self-test) |
| Postgres schema + repo | ✅ PGlite tested; Supabase path written, not yet run against Supabase |
| Deploy (PM2/Caddy) | 📄 configs written, not deployed |
| Local jobs marketplace + work profiles | ✅ built 2026-11-14 (accounts mode): post, sealed bids, lowest wins, 7-day contact window, fees recorded (payments off), work profiles, "What brings you here?". Tested (API, rules, Postgres concurrency, `npm run simulate:jobs`), checked end to end in Chromium on the built server. **Not deployed** |

**Job marketplace, 2026-11-14** (commit "Job marketplace: post a job, sealed bids…"). What was built:
- `src/jobs/` (rules, config, repo, service, view, stats), `src/db/schema-jobs.ts` (jobs, job_bids, job_messages,
  job_fees, job_reports), `src/routes/jobs.ts`; work profiles in `src/profile/work.ts`, `person.ts`,
  `src/db/work.ts`, `src/routes/work.ts`; four new alert kinds (job_awarded, job_message, job_deadline,
  job_closed); screens `web/js/views/jobs.js`, `job-post.js`, `job.js`, onboarding's "What brings you here?",
  the Settings work-profile section; `web/terms.html`; the marketplace rows in `web/privacy.html`.
- Research: `docs/MARKETPLACE.md` (licence rules NV/CA, bid-security yardsticks, fees, money transmission,
  app stores; every outside fact tagged [search], none read directly) and `docs/APIS.md` (every outside
  service, its price, what turns each feature on).
- Fees: no-show 5% of the winning bid (2% of the bid to the poster), service 1% when agreed. Settings
  `JOB_*` (see `.env.example`); limits enforced at boot. **Payments are off**: rows are 'recorded' only.
- Settlement is lazy and idempotent: every jobs route, `GET /api/alerts` and the realtime tick
  (`GET /api/cron/tick`) run `settleDue`. Jobs routes flush pushes before answering (Vercel freezes after).
- Fixes after review: the bid note's copy (only the bidder sees it); the onboarding's default business name no
  longer names a bidder on cards ("Bidder N" in the tab); fee box wording; losers see only the result; the
  checklist counts "We've agreed" as an answer; a viewer who never bid cannot open the poster's card; Pacific
  times on messages; the privacy line follows the job's state; Nevada licence line limited to repair or
  maintenance under $1,000, California line adds "part of a bigger job"; terms define "making contact" and give
  the fee ranges; privacy policy covers the marketplace; one live repost per job (unique index); the pilot's
  config profile and "Get work done" profiles are never scored for local jobs; Google Play fees updated.

Checks (2026-11-14): see the commit's run — typecheck, the full test suite and build pass;
`npm run simulate -- --seed 20261113` (hash unchanged), `npm run simulate:cost -- --companies 2000 --seed 4242`
(sha256 70de5331…3830, unchanged) and `npm run simulate:jobs -- --seed 20261114` (15 checks, same-seed hash,
9 of 9 mutations caught) all pass. Browser (Playwright 390×844 and 1280×800, built server, accounts mode,
`SOURCES=fixtures` after a fixtures scan): a "Get work done" account signed up and posted; an electrician bid
$420 sealed; a second bid $380; the closing time was moved a minute into the past in the local embedded
database while the server was stopped (the server's own lazy settlement did the rest): award, bid tab, the
loser's result, messages, both agreed, job done, service fee "recorded, not collected".

**Delete my account and forgot password, 2026-11-14.** What was built:
- **Delete my account**: Settings → "Delete my account" (web/js/account-delete.js) shows what the deletion would end
  for this account (`GET /api/account/deletion`), asks for the password again, then `DELETE /api/account`
  (src/routes/account.ts; 5 tries per 15 minutes). An account with no password (Google / Apple / Microsoft)
  needs a sign-in from the last 10 minutes and types its email instead. The deletion is ONE statement
  (`deleteAccount` in src/jobs/repo.ts): the foreign keys take the profile, sessions, jobs, bids, messages, alerts
  and work profile; the statement also deletes the `local:<jobId>` feed rows of the account's jobs and every alert
  that points at one (their matches and swipes cascade from `bids`). For someone who is locked out (forgot the
  password while reset by email is off) and asks by email: `POST /api/admin/account/delete {email}` with the
  admin token does the same deletion; the privacy page promises it within 30 days.
- **Decisions** (Ev can flip them; each is one place in that statement):
  - *A fee row is never deleted.* `job_fees.payer_id` is now `on delete set null` and `job_fees.job_id` has no
    foreign key, so a row outlives the payer AND the job. The row keeps who it was: `payer_ref` (the account id,
    written with the fee), `payer_name` (the name on the account, never the email) and `payer_deleted_at`.
    `ledgerTotals()` and `GET /api/admin/jobs/fees` read the ledger.
  - *A deletion never records a new fee.* A winner who deletes while the job is awarded hands it back for free
    (tapping "I can't take it" records the 5% no-show fee; deleting the account does not). Reason: nothing can
    be collected from a deleted account, and a fee invented at the moment someone leaves would make the ledger
    less true, not more. **Revisit when payments are switched on**: with a card on file, settle the back-out fee
    before the deletion, or people will delete instead of backing out.
  - *The one who stays owes nothing.* Winner leaves an awarded or agreed job: it ends unfilled / `bidder_left`
    for the poster, who is told and can post again (a service fee already recorded stays on the leaver's line).
    Poster leaves: the job row is gone, so the winner (and each sealed bidder of an open job) is left one
    `job_tombstones` line (title, own bid, why), `GET /api/jobs/:id` answers 410 `gone` to them, it shows under
    Finished on their Jobs tab, and a service fee already recorded for an agreed job is **waived** (the row stays).
- **Forgot password**: `POST /api/auth/forgot` → a one-hour, single-use link `<APP_URL>/#reset=<token>` (the token
  is in the fragment, so no server ever logs it; only its sha256 is stored; an earlier link stays good until one of
  them is used, so nobody else can cancel the link you are about to open), the
  same answer for every address, 3 an hour per address and 5 per caller. `POST /api/auth/reset` sets the new
  password in one statement, signs every other device out (sessions, stored push devices, open live streams)
  and signs this one in. Mail goes through
  src/notify/email.ts (Resend). **The live host has no `RESEND_API_KEY`, so today the sign-in screen says
  "Password reset by email is not available yet" and nothing is sent.** To switch it on: a domain verified with
  Resend, then `RESEND_API_KEY` and `EMAIL_FROM` on the host (`APP_URL` is already set there; without it there is
  no mailer, because the link would point at localhost). The real email has never been sent.
- An older database is upgraded in place at start-up (the `do $upgrade$` block in src/db/schema-jobs.ts).
- web/privacy.html ("Deleting your account": what is deleted, what is kept and why) and web/terms.html say
  exactly this. One new placeholder for Ev in the privacy page: how long the providers keep backups and logs.

Checks (2026-11-14): typecheck, the full test suite (1,665 passed; test/account-delete.test.ts and
test/password-reset.test.ts are new) and build pass. `npm run simulate:jobs -- --seed 20261114`: 15 checks,
same-seed hash, 10 of 10 mutations caught. On a real Postgres 16 (the container's own, `TEST_DATABASE_URL`):
the 5 Postgres tests pass, including ten deletions of one account at the same moment (one deletes it), and the
in-place upgrade of an old-shape database was run by hand. Browser (Playwright 390×844, a local server on an
in-memory database, simulated people): forgot password with email off and on, the emailed link, a used link,
the delete panel with a wrong and a right password, and what the winner and the poster who stayed see.
Not done: nothing was deployed; the live Supabase database has not run the upgrade yet (it runs by itself at the
next start); the reset email was only ever written to a file by a test mailer.

Known gaps (marketplace):
- No payments: no collection, no payout of the poster's share, no statement screen. Decision open for Ev: pay
  the poster's 2% as cash through Stripe Connect (posters must pass identity checks) or as BidSwipe credit
  (recommended in docs/APIS.md and docs/MARKETPLACE.md).
- Legal: the NV/CA licence lines and the after-the-fact no-show fee rest on search snippets, not pages read in
  full; one paid hour before real money moves (docs/MARKETPLACE.md §8). Terms and privacy still have Ev's
  placeholders (contact email, providers) to fill in before publishing.
- A second reader went through the first commit of this work and found no way for one account to delete or
  reset another. What it found and was fixed: open live streams survived a reset, phone alerts died silently
  after one, a new reset link cancelled the earlier one, a mailer without `APP_URL` would have emailed a
  localhost link, and two privacy sentences said more than the code does. What it found and is left open:
  - An account with no password (social sign-in) confirms a deletion with a sign-in from the last 10 minutes.
    That is only as strong as the provider: a phone where Google is still signed in asks for nothing.
  - **Before social sign-in is switched on:** deleting an account here does not remove the person's record in
    Supabase Auth (that needs its service-role key, a new secret, or a manual step). The privacy page has a
    placeholder for it.
  - When a poster deletes their account their jobs go, so those jobs no longer count in the winner's record
    (won, agreed, done, and also no-shows), while a no-show fee line stays in the ledger. Keeping the record
    would mean keeping the job rows without their poster: a bigger change, not made.
  - A refused reset email answers 502 only for an address that has an account (sign-up tells the same thing).
  - Deleting an account frees its use of a limited promo code.
  - A job whose winner left shows under "Needs you" for 3 days counted from its contact deadline, so an agreed
    job whose winner leaves long after that goes straight to Finished (the poster is still told by an alert).
  - A device's phone alerts now follow whoever is signed in on it (it re-registers when the app is entered).
- Account deletion: an alert that was already in someone else's inbox (a message preview, a job title) stays
  there; other people's saved cost checks on a deleted local job keep its id; a request of the deleted account
  that is in flight at that very instant may be refused with a server error (a foreign key refuses its write; not seen, not tested). `job_tombstones` rows
  are never cleaned up (they go when their owner's account goes).
- A newly posted job is scored by looping over every profile in the request; batch it before thousands of
  users. `GET /api/jobs/mine` loads every job one at a time (median ~33 ms in the simulation).
- On a multi-connection Postgres a bid sent in the exact millisecond of closing could, in theory, be swept to
  'lost' (very unlikely; the embedded database cannot hit it).
- The 'match' alert of a 3-day job says "2 days left" (whole-day rounding). A "Get work done" account still
  sees the Swipe/Browse/Saved/Market tabs (empty work feed); the alerts inbox copy talks only about bids.
- terms.html states today's fee figures as "today"; edit it by hand if the JOB_* settings change.
- No harness for web JS: the screens were checked in Playwright only; a job notification tap on a real phone
  was not tried.

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

**Final check, v1 (2026-11-13, commit "v1: premium cost check, price and award watcher, multi-company test on real
bids"):** typecheck, the full test suite and build pass. `npm run simulate -- --seed 20261113`: all checks pass,
spend-limit and price-filter checks not exercised (no captured bid states a value), report repeats, 10 of 10
mutations caught. `npm run simulate:cost -- --companies 2000 --seed 4242`: 6000 jobs priced, 0 refused, 0
invariant violations. Browser (Playwright 390×844, built server, `SOURCES=fixtures`): accounts + `DEMO_MODE=1`
(sign-up, onboarding, deck, search + filters, price check, cost check for a small job and a bonded job,
saved checks, Market with the price watch card, alerts, settings with cost settings / set-asides / alert
kinds, unsaved-changes guard, sign-out), a free account (every Pro screen locked, no code box) and the
pilot's single mode. Market data was empty on that server (no network), so the price watch was only seen
"not scheduled" and the wage/award hints only as "not loaded".

**v1.1 (2026-11-13, commit "v1.1: tap-only onboarding with qualification answers, promo codes, nationwide
federal bids from the free bulk file, store-ready PWA"):**
- Onboarding is 6 tap-only steps (trades, location or ZIP + distance chips, job-size chips, paperwork
  Yes/No/Not sure + federal certifications, alert level, optional name). Paperwork answers change the card's
  lines; a "No" caps the score (never under 35, `capped`, never alerts). The SPWD question is asked only of
  Nevada shops, the only state requirement a board marks today.
- Promo codes: `PROMO_CODES` on the host, a Settings box and `?promo=` links (an unencoded `&` in a link
  works); never in an iOS build. Real codes are not in the repo.
- SAM.gov now reads the public daily bulk file (no key, the whole US): ~222 MB streamed, 529 cards on the
  2026-11-13 file. Only candidate bids (own states, or within max(2×radius, radius+100, 150 mi)) get a stored
  score: the nationwide bench went from 239.8 s / 632,968 rows to 10.6 s / 97,303 rows for 1,016 companies.
  Stale no-deadline notices (posted over a year ago) are dropped, US territories coded as countries (VIR)
  are kept, zoneless deadlines borrow a sibling notice's offset or carry a "check the notice" flag, and a
  download under 20,000 rows fails loudly. Notices with no place of performance are still dropped (511
  merged cards, 146 open, on 2026-11-13; N6600126Q6298 is in the file but past due and in Okinawa).
- Store-ready PWA: manifest + icons + service worker on every load, desktop layout (`web/desktop.css`),
  privacy page (contact email still a placeholder), `docs/MICROSOFT-STORE.md`. Poll mode for serverless
  hosts (automatic on Vercel) reloads the feed after a scan; cron routes flush pushes and run reminders
  (`/api/cron/tick`).
- Checks: typecheck, 1,527 tests in 60 files, build; `npm run simulate -- --seed 20261113` all checks pass,
  11 of 11 mutations caught; `npm run simulate:cost` sha256 unchanged (70de5331…3830). Browser (built server,
  accounts mode, `DEMO_MODE` off, `SOURCES=fixtures`, a TEST promo code): sign-up + onboarding by taps at
  390×844 and 1280×800, Pro unlocked from a `?promo=` link, cost check opened; poll mode raised 2 alerts and
  reloaded the deck to 7 bids without a stream.
- Known gaps: sign-in/promo rate limits are per process (weak on serverless); no in-app account deletion;
  the privacy page needs a contact email; CA DIR and county prequalification are not scored.
- **Live since 2026-11-13: https://bidswipe-tau.vercel.app** (accounts mode, promo codes on).
  - Host: Vercel project `bidswipe` (team "biipn's projects"), Hobby plan, region sfo1, Node 22. It is
    linked to this GitHub repository with production branch `main`. The live version was deployed by
    hand from `claude/affectionate-hypatia-57wdiv`; a push to that branch only builds a preview. Once
    this work is on `main`, every push to `main` goes live by itself.
  - Database: Supabase project `bidswipe` (us-west-1, free plan). The app logs in as its own role
    `bidswipe_app` and keeps every table in the schema of the same name (not `public`, which Supabase
    exposes through its REST API). The pooler host is `aws-1-us-west-1.pooler.supabase.com:6543`
    (`aws-0-…` answers "tenant/user not found").
  - Settings live in the Vercel project's environment variables: `DATABASE_URL`, `ADMIN_TOKEN`,
    `CRON_SECRET`, `SAM_API_KEY`, `PROMO_CODES` (all marked sensitive), `AUTH_MODE=accounts`, `APP_URL`,
    `REALTIME_MODE=poll`, `MARKET_REFRESH_AT`, `PG_SSL_NO_VERIFY=1`, `TRUST_PROXY`. Preview builds also
    get `SOURCES=samgov`, so testing a preview never re-reads the Nevada boards.
  - Daily jobs (vercel.json, UTC): market 11:40, scan 13:20, tick 14:50.
  - First live scan: QuestCDN 13, NGEM 44, NevadaEPro 25, SAM.gov bulk 495 (8.2 s for the 222 MB file).
    **Douglas County answers HTTP 403 to the host's address** (it works from other networks), so that
    source is FAILED on Vercel until it runs from somewhere else or the county allows it.
  - Checked on the live site in a phone-size browser: a `?promo=` link gave Pro after a 14-tap,
    zero-typing onboarding; Browse showed state and federal bids; `/package.json`, `/server.js` and
    `/config/…` answer 404.
  - Not done there: phone push (no VAPID keys set), the daily digest email (no Resend key), social
    sign-in (no Supabase Auth keys), a BLS key (wages and price indexes depend on the no-key limit).
  - Vercel's Hobby plan is for non-commercial use: move to Pro ($20/month) or another host before
    charging for BidSwipe Pro.

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
- **Default since v1.1: the public daily bulk file** (`src/sources/samgov-bulk.ts`; facts, limits and the
  URL in `docs/DATA-SOURCES.md` §2). No key, no daily cap, one download serves every company. A personal
  API key allows only 10 calls a day and must be rotated every 90 days (SAM.gov Terms of Use), so the API
  path below is kept only behind `SAM_SOURCE=api`.
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

**Done in v1 (2026-11-13):** accounts + onboarding + a profile per account (email/password; Supabase OAuth
written, not run) · per-account scoring · live alert inbox + SSE + web push wiring · price check · the Pro
cost check · the daily price and award watch · the multi-company simulation.

**Done in v1.1 (2026-11-13):** tap-only onboarding with paperwork answers · promo codes (web + Microsoft
Store) · nationwide SAM.gov from the bulk file + candidate-only scoring · installable PWA, desktop layout,
privacy page, Store guide · poll mode + serverless cron tick.

**Next (multi-user)**
5. Run Supabase (auth + `DATABASE_URL`) for real; deliver one web push end to end.
6. Set `MARKET_REFRESH_AT` on the server and watch a week of real price/award alerts.
7. A California state/local source (Cal eProcure) and a source that states job values, so spend limits bite.
8. Cost check: load a saved check's inputs back into the form; bid history for the bid range.

**Then (stores)**
9. Wrap with Capacitor (fastest) or rebuild the deck in Expo; App Store review needs real native value
   (push, saved list offline) beyond a web wrapper. 10. Paid tier (Stripe on the web). 11. More states.

## 7. Files that matter most
`src/score/score.ts` · `config/lm-electric.json` · `src/sources/*` (incl. `flags.ts`, `dedupe.ts`) ·
`src/geo/places.ts` + `locate.ts` · `src/routes/*` · `src/cost/estimate.ts` · `src/market/watch.ts` +
`watcher.ts` · `src/sim/*` · `web/js/*` · `test/score.test.ts` ·
`test/score-audit.test.ts` · `test/federal-chain.test.ts` · `test/sources.test.ts`
