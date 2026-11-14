# BidSwipe — handoff notes (v1, updated 2026-11-14)

Everything learned while building v0, so nobody has to re-research it. The product vision (price
action, spend limit, alerts, Pro bot, codes) lives in `docs/PRODUCT.md`.

## 1. Where things stand

| Area | Status |
|---|---|
| Source connectors | ✅ 5 Nevada/federal boards (live 2026-11-13) · ✅ wave 2, 2026-11-14: 11 more state/city/OpenGov/E-Rate boards read live in scan groups, 3,715 open bids stored; txesbd + caltrans off by robots.txt (§2 "wave 2") |
| Location + distance | ✅ gazetteer + nationwide ZIP table; SAM places parsed from every shape in the real responses; a listed address we can't place stays unplaced (no guess) |
| Fit scoring + reasons | ✅ audited on the 107 live bids (see §4); certification set-asides and program contracts are hard no's, presolicitations/RFIs never alert |
| Accounts, onboarding, settings | ✅ tested + checked in a phone-size browser (`AUTH_MODE=accounts`); OAuth (Supabase) written, never run |
| Search, filters, next up, spend limits | ✅ tested; no captured bid lists a value, so limits/value filters were only seen on a simulated row (the simulation reports them as "not exercised") |
| Live alerts (inbox + SSE) | ✅ tested + seen in the browser; frames now leave as each alert is stored (the scan yields), measured ~0.4 ms stored→stream in the simulation; web push wired, never delivered end to end |
| Price + award watch (`MARKET_REFRESH_AT`) | ✅ tested on replays of the real BLS/USAspending captures with labelled synthetic "after" data; one live NV award pull (36 awards) by its builder. Not yet run on a schedule against the live APIs. Award matching works for SAM.gov bids only (solicitation numbers) |
| Price check (awards, wages, indexes, NV prevailing wage) | ✅ tested; real USAspending pull (NV 266, CA 2078 awards) and real BLS responses (fixtures) seen in the browser. Prevailing-wage rates were typed from the state PDF, not double-checked |
| Cost engine (`POST /api/estimate`) | ✅ built (src/cost, integer cents), proven by a second implementation (test/cost-oracle) and `npm run simulate:cost`; Pro only (402 otherwise). Screen in web/js/views/cost.js, checked at 390×844 |
| Multi-company simulation | ✅ `npm run simulate`: 16 simulated companies on the real captured bids, all checks pass (incl. `sub-silent`), same seed same hash (b03d9321cd4cbde7, 2026-11-14 evening; was 051f7916d12e0c0e: the state-only SAM notice "Forest Service - Solar Batteries Frenchman Work Center" is now capped, so it leaves the seeded held-out pick, and SAM titles lose their "J061--" code prefix), 12 of 12 mutations caught (+1 checker self-test) |
| Postgres schema + repo | ✅ PGlite tested; Supabase path written, not yet run against Supabase |
| Deploy (PM2/Caddy) | 📄 configs written, not deployed |
| Local jobs marketplace + work profiles | ✅ built 2026-11-14 (accounts mode): post, sealed bids, lowest wins, 7-day contact window, fees recorded (payments off), work profiles, "What brings you here?". Tested (API, rules, Postgres concurrency, `npm run simulate:jobs`), checked end to end in Chromium on the built server. **Not deployed** |

**LIVE since 2026-11-14 16:40 UTC: production (bidswipe-tau.vercel.app) runs commit 0ccddd1** (the wider federal
net, the Sub work tier, the eleven new boards, places, trade-work rules, quiet first load, paging). The schema
changes (bids.psc, matches.tier, matches.quiet) applied themselves on the first request. First load, run by hand,
one scan group per call with `?quiet=1`, default last, 16:40–16:54 UTC:

| Group | Wall (Vercel + Supabase) | Kept |
|---|---|---|
| south | 2 s | flmfmp 25 (txesbd off) |
| west | 45 s | caleprocure 190 · laramp 40 · sfbids 14 · oregonbuys 54 · usac470 495 (caltrans off) |
| east | 188 s | bidbuy 35 · njstart 1 · nycrecord 71 · commbuys 302 (179 s of it) |
| opengov-1 … 5 | 115 · 118 · 114 · 125 · 75 s | 170 · 229 · 93 · 200 · 103 |
| default | 14 s | samgov 668 · ngem 45 · nevadaepro 29 · questcdn 13 · **douglascounty FAILED: HTTP 403** |

Every call answered HTTP 200 inside the host's 300 s; no new board refused Vercel's addresses; no alert was
published (0 alerts for either real profile). Open bids in the live database: 593 → 2,802 (California 36 → 498;
2,258 with a point). The two real accounts (both electrical, ZIP 95675): 100 mi [CA, NV] 142 candidates / 5 fits →
612 / 40 fits (25 with a distance) + 3 sub; 50 mi [CA] 75 / 1 fit → 538 / 20 fits (8 with a distance). Of the 50 mi
account's 20: 2 placed bid jobs, 6 E-Rate school cabling quote requests, 3 Caltrans area contracts, 8 statewide
cards with no site, 1 federal notice that names only the state. Near River Pines the feed is still thin: the
owners there post on PlanetBids, Public Purchase or their own websites (scratch research, 2026-11-14).

Not yet seen: the eleven cron entries firing on their own (first time 2026-11-15 13:20–14:08 UTC; the deploy
accepted them); east has only ~110 s of headroom (COMMBUYS). **Douglas County answers HTTP 403 to Vercel's
addresses** (also on 2026-11-13 22:21 and 2026-11-14 13:20, before this build): the pilot's county board is not
being read in production; no workaround, the owner decides (ask the county, or run that one board from another host).

**Bids placed honestly, a quiet first load, lists that page — 2026-11-14 (after the eleven new boards).** What changed:
- **Places** (`src/geo/caleprocure-place.ts`, `src/geo/california.ts`): a Cal eProcure card is placed by a
  corroborated town, one county, several counties, the Caltrans district in a 2660 event id, the department's own
  place (a CSU campus, a prison), else it stays unplaced. One county, several counties and a district are an AREA:
  no point, no miles ever, a capped "maybe" when the nearest seat is within radius + 25 mi. An unplaced card of a
  statewide board (`src/sources/statewide.ts`) is a capped "could be anywhere in <state>" for a company based
  there, held at 34 (Browse only) for one based elsewhere. A SAM notice that names only the state is capped too
  (not in Nevada: the pilot's rules are unchanged). No "? mi" anywhere.
- **Trade work** (`src/sources/relevance.ts`): purchases, parts, rentals, design, advice, audits, IT, on-call
  services and sales are dropped at the source; a figurative "conduit" in a description is not electrical work;
  sub work never lands on a rental or on a trade-package call.
- **Scan**: a board's first load and any `quiet` scan announce nothing and never reach a digest; at most 10 new
  match alerts per profile per scan; a bid already alerted is not re-published; a bid with no due date is open only
  while its board lists it (last seen ≤ 3 days); a group's scan prunes only its own boards' rows (it used to delete
  every other group's scores).
- **Screens**: Browse pages through the server (`limit`/`offset`/`total`, "Showing 100 of 787 · Show 100 more");
  Saved loads `GET /api/saved` itself (a bid saved past the first 300 stays saved); the Where tile prints the
  server's label and "No distance: site not named" instead of miles.

Measured on a copy of the live test scan (3,898 open bids; NOW 2026-11-14T08:30Z; stored rows re-placed and
re-filtered by stand-in scripts, since no board is read twice a day). Candidates / fits (with a distance; capped) / sub:

| Simulated profile | 85dd509 | now |
|---|---|---|
| Electrician 95675, 60 mi, [CA] | 787 / 47 (12; 0) / 3 | 529 / 21 (9; 12) / 2 |
| Electrician 95675, 100 mi, [CA, NV] | 860 / 60 (25; 0) / 5 | 602 / 39 (24; 15) / 3 |
| Plumber 95814, 60 mi, [CA] | 787 / 22 (7; 2) / 2 | 529 / 12 (6; 6) / 2 |
| Pilot (config/lm-electric.json) | 860 / 39 / 3 | 602 / 11 (5; 4) / 2 |

Read honestly: of the 60-mile electrician's 23 fit + sub rows, about 3 are placed, plain jobs he could bid (Terrell
Drive Fire Rehab in Sacramento, Club West HVAC Replacement in West Sacramento as a maybe, two VA/USACE sub-work
jobs to quote), 7 are E-Rate cabling quote requests at schools 29–58 mi away, 3 are Caltrans highway contracts in
District 3 or 10 (site not named), and 7 are statewide cards whose site the list does not give (fire alarm, an
electrical-infrastructure IFB, generator maintenance). Volume near River Pines is thin: about 50 placed open bids of
any trade within 60 mi. At 100 mi he gets 39 fits, 24 of them with a real distance (Vacaville prison fire alarm,
Napa, Tracy, Alameda, Carson City).

Cal eProcure stored cards after re-placing (190 kept by the trade rules, of 314): 10 town, 35 agency/facility, 19
one-county areas, 12 several-county areas, 40 Caltrans-district areas, 74 unplaced. Rows kept per board
(stored → kept): caleprocure 314 → 190, commbuys 727 → 303, opengov 1,186 → 779, oregonbuys 118 → 54, bidbuy 98 →
35, flmfmp 63 → 25, nycrecord 84 → 70, laramp 47 → 35, sfbids 16 → 14, njstart 4 → 1, usac470 465 → 460.

**The first production load (run it quietly).** The new boards bring about 3,300 bids nobody has seen. Each board's
first load is quiet by itself (no stored bid of that board before the scan), so the scheduled group scans are safe.
To be certain, run the first round by hand with the switch, one group at a time:
`curl -H "Authorization: Bearer $CRON_SECRET" "https://<host>/api/cron/scan?group=<group>&quiet=1"` for every group
in `src/sources/scan-groups.ts` (or `POST /api/admin/scan?quiet=1` with the admin token on a long-running server),
then let the daily schedule take over: from the second scan on, new bids alert as usual (at most 10 per company).
On the host the default group re-scores every open bid for every profile: on local Postgres 16, 50 profiles took
5.2 s and 360 statements (about 12 s at 20 ms a round trip); at ~1,000 profiles it would be minutes, so batch the
match upserts or move the re-score into its own cron call before then. The Vercel docs index did not confirm the
Hobby cron limits or the 300 s default duration: check them in the dashboard (Project Settings → Functions).

**More open bids in reach, 2026-11-14** (a real CA electrician at ZIP 95675 saw one job on the live site). What changed:
- Federal net (`src/sources/psc.ts`, `samgov-bulk.ts`): a notice is kept when its NAICS OR its Product and Service
  Code is trade work (Y/Z always; J/N/K/H on building-equipment groups; S208/S214/S216/S218, M1 power/heating
  plants, P demolition, F grounds work), never for a product NAICS (31–33, 811210), a lease (53), A/E design
  (541310–541340) or group 059 alone (radar, avionics, radios); a service notice with a plain trade title
  ("…HVAC upgrades", "…Chiller Units") is kept whatever its PSC. Every card carries `psc`.
- A notice with no place of performance is placed at its US contracting office (`FLAGS.placeFromOffice`, labelled,
  capped, no miles shown); its title's state wins when it names another. Never for a job abroad (a foreign
  PopCountry, an AA/AE/AP office or a foreign place in the text); a stateless card with words for a place abroad is
  dropped. A bid with no point and no state is held at 34. `samKey` stops merging different jobs numbered
  …0001/…0002 under a 0000 serial (69 families in the file).
- Sub work tier (`src/score/subwork.ts`, contract in CLAUDE.md "Tiers"): building and facility primes for trades
  usually subcontracted; 36–50, "maybe", capped, never alerted, spend limits not applied (they are the prime's).
  An equipment PSC alone is a weak signal (8 + context × 0.45, under 35). Feed: `tier`, `counts`, `tier=`;
  `PUT /api/profile` returns counts without the hard no's. Screens: SUB WORK pill and note, Browse three-way
  filter with counts, a finished deck that offers the next step, a "Show sub work" switch, onboarding's last step.
- Measured on the real SAM.gov file of 2026-11-14 05:27 UTC (222 MB) + the Nevada fixtures, scanned into a scratch
  embedded database with `runScan`, clock 08:00 UTC; "TEST CA Electric (simulated)" = electrical, ZIP 95675,
  states [CA], 90 mi, $10K–$50K:

  | | at 697369e | now |
  |---|---:|---:|
  | federal cards | 508 | 668 |
  | … in California | 36 | 51 |
  | … placed at the contracting office | 0 | 130 (16 moved to the state their title names) |
  | TEST CA Electric: candidates / fit / sub / other | 76 / 5 / 0 / 71 | 82 / 5 / 3 / 74 |
  | L&M Electric (pilot): candidates / fit / sub / other | 143 / 8 / 0 / 135 | 150 / 7 / 2 / 141 |

  Honest reading: this run widens the net (+160 federal cards nationwide, +15 in California) and labels sub work,
  but it does **not** fix "one job" for a California electrician: his fits stay at 5. The pilot's 8th fit (Dini
  Library restroom) is now sub work. Volume has to come from state and local boards (being researched separately).
- Checks: typecheck, 1,702 tests, build; `simulate --seed 20261113` 051f7916d12e0c0e, 12 of 12 mutations;
  `simulate:cost` sha256 70de5331…3830 unchanged; `simulate:jobs --seed 20261114` 21d5d5f488b230c2 unchanged,
  15 checks, 10 of 10 mutations. Browser pass on the built server (accounts mode, fixtures + the real SAM cards).

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
- Contact rule made fair (2026-11-14, src/jobs/rules.ts endOfContact): "made contact" = the winner's first message
  or "We've agreed", or the poster's "They contacted me" or "We've agreed". A poster no-show needs the winner's
  first MESSAGE sent with at least min(48 h, half the window) left and no answer from the poster; every other
  contact without agreement is no_agreement (no fee, nothing on a record). A one-sided "We've agreed" alerts the
  other side once. The 2-days-left reminder uses the same definition. `simulate:jobs --seed 20261114`: 15 checks
  pass, same-seed hash 21d5d5f4…ebf9c4, 10 of 10 mutations caught (new: late-message-marks-poster → endings).
  Two taps at the same moment: confirmAgreement reads the row again and the realtime onJob checks the job once
  more before it stores the "tap it too" alert; any such alert still unread is marked read when the job ends
  (src/db/alerts.ts retireTapAlert), so nobody who already tapped is left asked to tap.

Checks (2026-11-14): see the commit's run — typecheck, the full test suite and build pass;
`npm run simulate -- --seed 20261113` (hash unchanged), `npm run simulate:cost -- --companies 2000 --seed 4242`
(sha256 70de5331…3830, unchanged) and `npm run simulate:jobs -- --seed 20261114` (15 checks, same-seed hash,
9 of 9 mutations caught) all pass. Browser (Playwright 390×844 and 1280×800, built server, accounts mode,
`SOURCES=fixtures` after a fixtures scan): a "Get work done" account signed up and posted; an electrician bid
$420 sealed; a second bid $380; the closing time was moved a minute into the past in the local embedded
database while the server was stopped (the server's own lazy settlement did the rest): award, bid tab, the
loser's result, messages, both agreed, job done, service fee "recorded, not collected".

Known gaps (marketplace):
- No payments: no collection, no payout of the poster's share, no statement screen. Decision open for Ev: pay
  the poster's 2% as cash through Stripe Connect (posters must pass identity checks) or as BidSwipe credit
  (recommended in docs/APIS.md and docs/MARKETPLACE.md).
- Legal: the NV/CA licence lines and the after-the-fact no-show fee rest on search snippets, not pages read in
  full; one paid hour before real money moves (docs/MARKETPLACE.md §8). Terms and privacy still have Ev's
  placeholders (contact email, providers) to fill in before publishing.
- No account deletion yet; when built it must delete the account's `local:<id>` feed rows and decide what
  happens to fee rows.
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
  - Daily jobs (vercel.json, UTC): market 11:40; scan groups west 13:20, east 13:26, south 13:32, opengov-1…5
    13:38–14:02, the default group (SAM.gov + Nevada) LAST at 14:08 (was 13:20 alone until 2026-11-14); tick 14:50.
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

### State and local boards, wave 2 (2026-11-14)
Why: an electrician near ZIP 95675 (Amador County, CA) signed up on the live site and saw ONE job; the app held 575
open bids, 33 in California, all federal. This wave adds 13 board sources (11 reading, 2 off). Every one has a real
captured fixture, a pure parser, its own clock, a loud failure and the shared trade-work filter
(`src/sources/relevance.ts`). Hosts, robots.txt, counts and what is not confirmed: `docs/DATA-SOURCES.md` §7.

The scan now runs in **groups** (one cron call each, 200 s fetch budget): default (last), west, east, south,
opengov-1…5. ONE live scan of every group, 2026-11-14 07:45–08:05 UTC, as the cron calls run them (wall clock of
the whole `npm run scan -- --group=…` call, budget 240 s for the check, 200 s for fetching):

| Group | Wall | Source: listed → kept |
|---|---|---|
| default | 22 s | douglascounty 1 open of 90 · questcdn 17 (5 boards) · ngem 44 · nevadaepro 29 (2 pages) · samgov 508 cards |
| west | 33 s | caleprocure 376 → 314 · laramp 207 → 47 · sfbids 64 → 16 · oregonbuys 174 → 118 (7 pages) · usac470 713 forms → 465 · caltrans OFF |
| east | 167 s | bidbuy 149 → 98 · njstart 19 → 4 · nycrecord 202 → 84 · commbuys 890 → 727 (36 pages, 156 s: the slow one) |
| south | 4 s | flmfmp 120 → 63 · txesbd OFF |
| opengov-1 (CA) | 117 s | 115 governments, 359 open → 285 |
| opengov-2 (FL, NJ) | 119 s | 117 governments, 413 → 332 |
| opengov-3 (AZ, TX…) | 114 s | 112 governments, 167 → 131 |
| opengov-4 (East) | 126 s | 124 governments, 348 → 284 |
| opengov-5 (rest) | 87 s | 74 governments, 210 → 154 |

No source FAILED, none stopped at its budget, no OpenGov government failed. Stored open bids: 599 → 3,715.

**What the Amador electrician gets** (a SIMULATED profile "TEST CA Electric (simulated)": electrical, ZIP 95675,
states [CA], radius 60 mi (the form default), job size 0–$1M; scored with the scan's own `isCandidate` + `scoreBid`):
today's sources alone: 80 candidates, **1** scoring 35 or more; with the new boards: 772 candidates, **47** at 35+.
Honestly, that is better but NOT yet "a lot of options": only **12** of the 47 have a distance, all 29–58 mi away
(OpenGov Sacramento / West Sacramento projects, seven E-Rate school cabling/Wi-Fi forms in Roseville, Loomis,
North Highlands, Woodland, Twain Harte, Dixon). The other 35 are statewide Cal eProcure cards with no place (Caltrans
signal/lighting contracts, prison fire alarms, DSH Atascadero electrical upgrades) that may be 300 mi away; the list
page names no site and the detail pages need a PeopleSoft postback per event. Two of the twelve are weak (an A&E
design contract — now dropped by relevance.ts — and "Traffic Signal Parts", goods). Next levers, in order:
place Cal eProcure events (their counties are often in the title; the event page has them), more local boards near
Sacramento/Amador (PlanetBids agencies, county sites), and a deck rule for distance-less cards (below).

**Pilot feed change (owner decision, not done):** L&M's profile has states [NV, CA], so statewide Cal eProcure
cards with no point enter its deck as capped "maybe" cards with "? mi" (the default-group run shows 7 maybes; the
review measured 7 → 10 on the fixtures and about 30 on the first live run). That is the existing capped-bid rule
working as written; the smallest change would be to keep a pointless card whose state is not the profile's home
state out of the deck (Browse still shows it).

Off, and why: **txesbd** (www.txsmartbuy.gov/robots.txt `User-agent: *` / `Disallow: /`; parser built and tested) and
**caltrans** (ppmoe.dot.ca.gov/robots.txt `Disallow: /`, and the list is a ServiceNow script shell). Turning either on
is the owner's call. Also not built: Virginia eVA (AWS WAF challenge), PlanetBids (needs a browser), Public Purchase
(terms), El Dorado County's site (refuses the host).

Known gaps: E-Rate forms whose text names no quote deadline are stored with no due date and stay "open" in the
database after the board stops listing them (no cleanup of rows a source no longer returns); Texas El Paso's
Mountain time is not handled.

**QuestCDN and robots.txt (2026-11-14, later the same day).** Once the host was reachable from here,
www.questcdn.com/robots.txt (where qcpi.questcdn.com redirects its own) turned out to say `Disallow: /` for every
client. The four boards added in this wave (NV State Parks, Lake County, Campbell, Glendora) are switched OFF
(`QUEST_BOARDS_OFF`): the default group reads 13 QuestCDN rows from one board again, not 17 from five. The pilot's
NV Public Works board is on the same host and still runs: **the owner must decide** whether it stays (it is the
pilot's SPWD feed) or goes. The BuySpeed vendor's file disallows only `/craft` (fine), and OpenGov has no robots file.

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
