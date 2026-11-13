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
npm test                   # vitest (108 tests as of 2026-11-13, ~5s)
npm run build              # tsc → dist/
npm run scan -- --fixtures # offline: load the real bids captured 2026-11-13 into the local DB
npm run scan -- --no-notify          # LIVE scan of every source (needs internet)
npm run scan -- --source=ngem        # one source
npm run dev                # http://localhost:8787 (tsx watch)
npm run demo:snapshot      # rebuild web/demo-data.json + out/bidswipe-demo.html
```
Embedded DB = one process at a time: stop `npm run dev` before `npm run scan`, or hit
`POST /api/admin/scan` on the running server.

## Map
```
src/sources/*.ts   one file per bid board: pure parse…() + small fetch() — see .claude/skills/add-source
src/geo/           gazetteer (places.ts) + locate(): city → ZIP → county → town in text → agency → region → state
src/score/score.ts fit score + plain-English reasons (the product's brain)
config/<id>.json   a contractor profile (keywords, radius, value range…) — tune scoring HERE, not in code
src/scan.ts        fetch all sources → finalizeBid → upsert → score per profile → record report
src/db/            schema.ts (plain Postgres), db.ts (PGlite | pg), repo.ts (all SQL lives here)
src/server.ts      Fastify API + static web/ + in-process daily scheduler (scheduler.ts)
src/notify/        digest email (Resend) or data/digest-latest.html when no key
web/               index.html, styles.css, app.js (swipe deck, browse, saved, detail sheet)
test/fixtures/     REAL responses, raw as the scanner receives them: HTML captured 2026-11-13, QuestCDN JSON
                   2026-11-11 (except samgov-search.json = synthetic, TEST- ids)
test/              sources.test.ts (parsers) · fetch.test.ts (each fetch(): log line, loud failures, NGEM paging)
                   · http.test.ts (cookie session) · pipeline / score / server / util · helpers.ts
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
  in `test/score.test.ts`. Prefer editing `config/lm-electric.json` over code.
- **Codes & payments:** never add an in-app "enter a code to unlock Pro" box to the iOS build (App Store
  guideline 3.1.1). Use Apple Offer Codes / Google Play promo codes / RevenueCat promotional
  entitlements; the web app may keep `ACCESS_CODE` for the pilot. See `docs/PRODUCT.md` §4.
- **Never fabricate bids.** Demo data comes from captured real pages; the SAM.gov fixture is synthetic
  and must never ship in a demo.
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

## How Ev likes to work
- Just build and keep going — don't pace work out in days.
- Show the actual code you write in chat (key snippets), not only a description — he reads it to learn.
- When something breaks: show the error + the lines involved and let him take a guess before fixing it
  together. **Exception:** if he says to run uninterrupted / finish it, don't stop for guesses — keep
  going and leave the code + explanation in chat for later.
- Blunt yes/no first, honest assessments over encouragement.
