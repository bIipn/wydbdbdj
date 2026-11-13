# BidSwipe — project memory for Claude Code

Public bids that fit your trade, one swipe at a time. A scanner pulls open public bids every morning,
scores them per contractor, emails the good ones, and serves a phone-first swipe app ("Tinder deck +
Indeed list"). Contractors bid on the agency's own site via the card's link — we never take bids.

- **Pilot customer:** L&M Electric, a small electrical contractor in Gardnerville/Minden, NV. They want
  $10K–$50K jobs within ~90 mi, and the owner must see *why* a bid fits before trusting it.
- **Goal after the pilot:** App Store + Google Play, thousands of mostly-free users, paid tier later.
- **Read next:** `README.md` (setup/deploy/API) and `docs/HANDOFF.md` (research notes, decisions, roadmap).

## Stack
Node ≥ 20.10 (CI uses 22) · TypeScript 7 (native `tsc`) · ESM (`"type": "module"`, imports end in `.js`)
· Fastify 5 · cheerio · Postgres via PGlite (embedded, dev + pilot) or `pg` (Supabase, prod) · Vitest 5
· Front end is plain HTML/CSS/JS in `web/` — no build step, no framework.

## Commands
```bash
npm install
npm run typecheck          # tsc --noEmit
npm test                   # vitest (41 tests, ~6s)
npm run build              # tsc → dist/
npm run scan -- --fixtures # offline: load real bids captured 2026-11-11 into the local DB
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
test/fixtures/     REAL pages captured 2026-11-11 (except samgov-search.json = synthetic, TEST- ids)
```

## Rules
- **Sources:** keep `parse…()` pure (string in → `BidDraft[]` out) and unit-tested against a saved real
  page in `test/fixtures/`. A broken source must never stop the scan (`runScan` already isolates them).
- **Scraping etiquette:** public pages only — never log in, never scrape login-walled boards (PlanHub,
  BuildingConnected, ConstructConnect). Keep the polite User-Agent + per-host delay in `util/http.ts`.
  One scan a day is plenty.
- **Times:** boards list Pacific wall-clock times with no offset — always go through `util/time.ts`
  (`parseUsDateTime`, `findDueInText`), never `new Date(string)` on board text. Store ISO UTC.
- **Scoring:** reasons are user-facing copy; keep them short and specific. Behavior changes need a test
  in `test/score.test.ts`. Prefer editing `config/lm-electric.json` over code.
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
- NevadaEPro's first page = 25 newest open bids; daily scans catch new ones.

## How Ev likes to work
- Just build and keep going — don't pace work out in days.
- Show the actual code you write in chat (key snippets), not only a description — he reads it to learn.
- When something breaks: show the error + the lines involved and let him take a guess before fixing it
  together. **Exception:** if he says to run uninterrupted / finish it, don't stop for guesses — keep
  going and leave the code + explanation in chat for later.
- Blunt yes/no first, honest assessments over encouragement.
