# BidSwipe — project memory for Claude Code

Public bids that fit your trade, one swipe at a time. A scanner pulls open public bids every morning,
scores them per contractor, emails the good ones, and serves a phone-first swipe app ("Tinder deck +
Indeed list"). Contractors bid on the agency's own site via the card's link — we never take bids.

- **Pilot customer:** L&M Electric, a small electrical contractor in Gardnerville/Minden, NV. They want
  $10K–$50K jobs within ~90 mi, and the owner must see *why* a bid fits before trusting it.
- **Goal after the pilot:** App Store + Google Play, thousands of mostly-free users, paid tier later.
- **Product spec:** `docs/PRODUCT.md` — the full vision: contracts feed, price action, spend limit, phone
  alerts, the Pro "bot", Free vs Pro, codes/demo mode (and the App Store rules around codes).
- **Read next:** `README.md` (setup/deploy/API) and `docs/HANDOFF.md` (research notes, decisions, roadmap).

## Stack
Node ≥ 20.10 (CI uses 22) · TypeScript 7 (native `tsc`) · ESM (`"type": "module"`, imports end in `.js`)
· Fastify 5 · cheerio · Postgres via PGlite (embedded, dev + pilot) or `pg` (Supabase, prod) · Vitest 5
· Front end is plain HTML/CSS/JS in `web/` — no build step, no framework.

## Commands
```bash
npm install
npm run typecheck          # tsc --noEmit
npm test                   # vitest (~1,530 tests in 60 files as of 2026-11-13, ~50s; simulate.test.ts alone ~25s)
npm run build              # tsc → dist/
npm run scan -- --fixtures # offline: load the real bids captured 2026-11-13 into the local DB
npm run scan -- --no-notify          # LIVE scan of every source (needs internet)
npm run scan -- --source=ngem        # one source
npm run dev                # http://localhost:8787 (tsx watch)
npm run market:refresh -- --states=NV,CA   # USAspending awards + BLS wages/indexes (network; --skip-bls etc.)
npm run demo:snapshot      # rebuild web/demo-data.json + out/bidswipe-demo.html
npm run simulate -- --seed 20261113 --out out/sim   # 16 SIMULATED companies through the real server on the
                           # real captured bids (SAM.gov included): checks, same-seed hash, mutations; exit 1 on any miss
npm run simulate:cost -- --companies 2000 --seed 4242  # seeded cost-engine run: invariants, limits, sha256
```
Embedded DB = one process at a time: stop `npm run dev` before `npm run scan`, or hit
`POST /api/admin/scan` on the running server. Modes (env): `AUTH_MODE=single` (default, the pilot: one
config profile, optional `ACCESS_CODE`) · `AUTH_MODE=accounts` (sign-up, onboarding, a profile per account)
· `DEMO_MODE=1` (everyone gets plan "pilot", all features on) · `SOURCES=fixtures` (scan the saved pages)
· `DATA_DIR=<folder>` (embedded DB folder; one process per folder) · `SCAN_DAILY_AT` / `MARKET_REFRESH_AT`
(Pacific "HH:MM": the daily scan and the daily market refresh + price/award watch; blank = off)
· `SAM_SOURCE=bulk|api` (default bulk: SAM.gov's public daily file, no key) · `PROMO_CODES` (`CODE:pro[:uses][:ISO]`,
real codes only on the host) · `REALTIME_MODE=stream|poll` (poll is the default when `VERCEL` is set) +
`REALTIME_POLL_MS` · `CRON_SECRET` (serverless cron routes).

## Map
```
src/sources/*.ts   one file per bid board: pure parse…() + small fetch() — see .claude/skills/add-source
src/sources/flags.ts  the flag strings, program-contract terms and SAM set-aside codes parsers write and
                   score.ts reads — ONE copy (test/federal-chain.test.ts guards it)
src/sources/dedupe.ts SAM: one card per solicitation (samgov:<sol number>), newest notice wins
src/sources/samgov-bulk.ts SAM.gov's public daily CSV (~222 MB): streaming RFC 4180 parser, per-field UTF-8 /
                   Windows-1252 decode, same samDraft() as the API path; drops stale no-deadline notices,
                   fills a zoneless deadline from a sibling notice (else flags it); <20,000 rows = cut off
src/geo/           gazetteer (places.ts) + nationwide ZIP table (zip.ts) + locate(): gazetteer town → ZIP →
                   nationwide ZIP / city+state → county → town in text → agency → region → state; a listed
                   address it can't place stays unplaced (no guess)
src/score/score.ts fit score + plain-English reasons (the product's brain); paperwork answers
                   (profile.qualifications) → plus / check / minus lines, a "no" caps the score (capped)
src/score/candidates.ts which bids a company gets a stored score for at all (its states, or within
                   max(2×radius, radius+100, 150 mi)); Browse shows candidates only
config/<id>.json   a contractor profile (keywords, radius, value range…) — tune scoring HERE, not in code
src/scan.ts        fetch all sources → finalizeBid → upsert → score per profile → record report
src/db/            schema.ts (plain Postgres), db.ts (PGlite | pg), repo.ts (all SQL lives here)
src/server.ts      Fastify API + static web/ + in-process daily scheduler (scheduler.ts); routes in src/routes/
src/auth/ src/profile/ src/trades/  accounts + sessions · onboarding answers → Profile · trades catalog
src/auth/promo.ts + src/db/promo.ts  PROMO_CODES parsing (sha256, constant-time match) + one-statement redeem
src/geo/nearest.ts "Use my location": a point → nearest ZIP (never stored; src/util/log-url.ts keeps it out of logs)
src/routes/cron.ts serverless scheduler routes: scan, market, tick (realtime has no timers there)
src/feed/ src/realtime/  "next bid" pick · alert inbox + SSE stream + web push
src/market/        USAspending awards, BLS wages + material indexes, NV prevailing wage (config/prevailing-wage);
                   watch.ts (pure price/award watch rules) + watcher.ts (runs the refresh, publishes 'price'/'award')
src/cost/          the cost engine (21 modules, integer cents, BigInt where it multiplies): estimate.ts is the
                   API (EstimateRequest → EstimateResult, "needed" instead of guesses); test/cost-oracle re-derives it
src/sim/           the multi-company simulation (personas, takeoffs, checks, report) behind `npm run simulate`
src/notify/        digest email (Resend) or data/digest-latest.html when no key
web/               index.html, styles.css, desktop.css (≥900px only), sw.js (registered on every load; bump
                   SHELL_VERSION when the shell list changes), manifest.webmanifest, icons/ (from icon.svg via
                   scripts/make-icons.cjs), privacy.html, js/*.js (ES modules, no build). main.js imports every view;
                   promo.js + promo-link.js: the code box and ?promo= links;
                   views/ (feed, market, alerts, cost, settings, sign-in, onboarding, gate) register themselves;
                   dom.js h() + safeUrl, state.js features(), money.js (cents only), cost-form.js / cost-result.js.
                   demo:snapshot bundles them: src/cli/snapshot.ts understands only plain import/export forms
serverless-files.cjs every folder the Vercel function ships (web/ and EACH sub-folder, config/): add a line for
                   a new folder (test/serverless-entry.test.ts)
docs/              PRODUCT.md (spec) · HANDOFF.md · DATA-SOURCES.md (free data sources, limits, checked) ·
                   MICROSOFT-STORE.md (Store submission steps)
test/fixtures/     REAL responses, raw as the scanner receives them: HTML captured 2026-11-13, QuestCDN JSON
                   2026-11-11, SAM.gov JSON (samgov-*.json) 2026-11-13 04:01 UTC, trimmed; BLS JSON 2026-11-13
test/              sources.test.ts (parsers) · fetch.test.ts (each fetch(): log line, loud failures, NGEM paging)
                   · http.test.ts (cookie session) · pipeline / score / server / util · cost/ + cost-oracle/
                   · market-watch (replays of the real BLS/USAspending captures + labelled synthetic "after")
                   · simulate.test.ts · helpers.ts. No harness for web JS: check screens in Playwright at 390×844
```

## Rules
- **Sources:** keep `parse…()` pure (string in → `BidDraft[]` out) and unit-tested against a saved real
  page in `test/fixtures/`. A broken source must never stop the scan (`runScan` already isolates them).
  A page `fetch()` can't read (table missing, rows but nothing parsed) must throw so the report says
  FAILED — never return a quiet 0 bids.
- **Fixtures = the RAW response,** exactly what `ctx.http` receives (e.g. `curl` with the scanner's
  User-Agent) — never a browser "Save as": page JavaScript rewrites these tables, and fixtures saved that
  way hid three broken sources until the first live scan (2026-11-13). Keep excerpts verbatim (dropping
  whole rows is fine; line endings untouched) and replace session-token values (`__VIEWSTATE`, `_csrf`,
  `javax.faces.ViewState`) with `TRIMMED`. Fixture mode reads them as of `FIXTURES_CAPTURED_AT`
  (`src/sources/fixtures.ts`) — update it when you re-capture.
- **Scraping etiquette:** public pages only — never log in, never scrape login-walled boards (PlanHub,
  BuildingConnected, ConstructConnect). Keep the polite User-Agent + per-host delay in `util/http.ts`.
  One scan a day is plenty.
- **Times:** boards list Pacific wall-clock times with no offset — always go through `util/time.ts`
  (`parseUsDateTime`, `findDueInText`), never `new Date(string)` on board text. Store ISO UTC.
- **Scoring:** reasons are user-facing copy; keep them short and specific. Behavior changes need a test
  in `test/score.test.ts` (or `score-audit.test.ts` on real bids). Prefer editing `config/lm-electric.json`
  over code; the pilot's keyword lists must stay equal to the catalog's electrical template
  (`test/profile.test.ts`). A new flag or set-aside code goes in `src/sources/flags.ts`, never retyped.
- **Codes & payments:** a promo-code box (Settings, `?promo=` links) is allowed on the web and Microsoft
  Store builds, never in an iOS store build (App Store guideline 3.1.1: `STORE_BUILD` in web/js/api.js turns
  it off there; use Apple Offer Codes / RevenueCat instead). The real codes live only in the host's
  `PROMO_CODES`: never in the repo, a test, a doc or a commit (tests use `A&Btest` / TEST- codes). Give each
  real code a use limit and an expiry. See `docs/PRODUCT.md` §4.
- **Never fabricate bids, awards, wages or prices.** Demo data comes from captured real pages. The SAM.gov
  fixtures are real (trimmed): `npm run simulate` uses them, fixture mode and the demo do not yet. Anything
  synthetic says so (TEST- ids, example.com, "SIM … (simulated)"); simulated persona figures are labelled.
- **Premium:** the cost check (`POST /api/estimate`), cost settings, award history and the price/award watch
  are Pro. A plan without the feature gets HTTP 402 `premium_required` (or a `locked` shape) and no numbers;
  the client shows what the feature is and that it is part of BidSwipe Pro — nothing else, no code box.
- **Honest copy:** bids are sealed; nobody sees a competitor's price before the opening. Award notices are
  results after the fact. "Live" means: the moment a scan (once a day) or a market refresh finds it.
- **Money in the client:** the API sends integer cents; format them (money.js), never float arithmetic.
- **Secrets** live in `.env` (gitignored). Never print or commit keys.
- **Front end:** build DOM with the `h()` helper (text nodes only) — no `innerHTML` with data. Only
  `http(s)` links (`safeUrl`). Keep it dependency-free and mobile-first; Ev cares that it looks neat.
- Before saying something is done: `npm run typecheck && npm test && npm run build` (the `verify` skill).

## Gotchas
- PGlite can't be opened by two processes → server owns the DB in production (scan runs in-process).
- Fastify 5 rejects an empty body sent as `application/json` → the web client only sets that header
  when there is a body (was a real Undo bug).
- TypeScript 7 is the native compiler; keep tsconfig on `module/moduleResolution: NodeNext`.
- QuestCDN and NGEM detail pages open via JavaScript → those cards link to the board + show the number.
- NevadaEPro's first page = 25 newest open bids; daily scans catch new ones. The log says how many the
  board announces ("nevadaepro: 25 of 29 listed (first page only)"). Raw cells have no labels: columns
  are named from `<thead>`.
- NGEM pages by ASP.NET postback, not links: page 1 is a GET, pages 2+ are a POST of that page's hidden
  fields through `ctx.http.session()` (cookie jar). Never send a postback without the `ASP.NET_SessionId`
  + `__AntiXsrfToken` cookies of the first GET: the board answers with an "An error has occurred" page
  (HTTP 200) and files an error report with its admins. POSTs are never retried; on any doubt NGEM keeps
  the pages it has and logs "— stopped: <reason>".
- Douglas County's Open/Close status is not in the HTML (a script stamps it in the browser), so
  `parseDouglasPage` decides it from `now`: the due time in the legal ad if there is one, else the county's
  rule (open until the day before `td.deadline-date`, Pacific). Raw page without `now` → it throws.
- Every state-changing `/api` request needs the header `x-bidswipe: 1` (CSRF guard, `src/auth/guard.ts`) or
  it gets 403 `csrf` — `curl` POSTs to `/api/admin/scan` included.
- SAM.gov card ids are `samgov:<solicitation number>` since 2026-11-13 (were `samgov:<noticeId>`); rows
  stored under the old ids are not cleaned up and sit beside the new ones until they close.
- Each scan re-scores every still-open stored bid, but only bids fetched in that scan can raise 'match'
  alerts. The scan yields to the event loop after each alert it publishes (src/scan.ts): without it every
  SSE frame waited for the end of the scan, because PGlite runs on the server thread.
- Daily schedules step a calendar day (src/scheduler.ts), never a fixed 24/26 h: a 23:30 run used to fire
  every other day. A time in the spring-forward gap runs an hour later (02:30 → 03:30 PDT).
- Award alerts are keyed per case (`<awardId>:bid:<bidId>` vs `<awardId>:nearby`): one award can be told
  once as "similar job nearby" and again as "Award posted" when its solicitation number arrives. "Nearby"
  needs the state AND the NAICS code to have been loaded before (award_coverage), so a first load is silent.
- Only SAM.gov bids carry a solicitation number, so only they can be matched to a federal award.
- SAM.gov's bulk file is ~222 MB a day, streamed through `ctx.http.stream()` (util/http.ts follows the
  303 to a signed S3 link by hand and never prints its query). Notices with no place of performance are
  dropped (cannot say they're in the US). Fixture mode (`SOURCES=fixtures`) still loads only the 85 Nevada
  bids; `fixtureReaders({ samgov: true })` (the simulation) adds the SAM captures.
- A capped bid (paperwork "no", no measurable site, not open yet) is held at min(54, alert line − 1) but
  never under 35 (`CAPPED_FLOOR`, the deck's line) and carries `capped: true`, which the scan and the alert
  rules skip. So it stays in the deck as a "maybe" and never pings anyone, even at alert line 35.
- `pruneMatches` (a company moved or narrowed its range) keeps swiped bids, closed bids and bids the digest
  already emailed (`notified_at`), so moving back never emails the same bid twice.
- Serverless (Vercel): `ctx.realtime` is created with `tickMs: 0`; the cron routes call `flush()` after a
  scan/refresh (the function freezes once it answers) and `/api/cron/tick` runs deadline reminders.
  `GET /api/alerts` returns `lastScan`, so a polling app reloads its feed after a scan.
- Fixture mode resolves `test/fixtures` from the working directory: run the server from the repo (or link it).

## How Ev likes to work
- Just build and keep going — don't pace work out in days.
- Show the actual code you write in chat (key snippets), not only a description — he reads it to learn.
- When something breaks: show the error + the lines involved and let him take a guess before fixing it
  together. **Exception:** if he says to run uninterrupted / finish it, don't stop for guesses — keep
  going and leave the code + explanation in chat for later.
- Blunt yes/no first, honest assessments over encouragement.
