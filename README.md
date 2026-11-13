# ⚡ BidSwipe

Public bids that fit your trade, one swipe at a time. **v0 is tuned for L&M Electric (Gardnerville, NV).**

Every morning it pulls open bids from county, state, local-agency and federal boards, scores each one for
L&M (electrical scope, distance from Gardnerville, job size, days left to bid), emails the good ones, and
serves a phone-friendly swipe app. Bidding itself happens on the agency's own site — every card links
straight there.

```
sources ──► normalize + locate ──► score per contractor ──► Postgres ──► API ──► swipe app (PWA)
                                                                     └──► daily email digest
```

## Sources

| Source | What it covers | How |
|---|---|---|
| `douglascounty` | Douglas County NV (Minden/Gardnerville) bids | public HTML table |
| `questcdn` | NV State Public Works construction (Carson City, Reno, Yerington…) | QuestCDN board JSON |
| `ngem` | NGEM: Carson City, Reno-Tahoe Airport, UNR/TMCC, Clark County… | public IonWave list, paged by form postback |
| `nevadaepro` | NV State Purchasing (goods + services) | public BSO open-bids table |
| `samgov` | Federal (NV + Tahoe-side CA) | official SAM.gov v2 API — **needs a free key** |

Each source is one file in `src/sources/` with a pure `parse…()` function (unit-tested against real
responses in `test/fixtures/` — the raw server HTML/JSON, captured Nov 13 2026; QuestCDN Nov 11) plus a
small `fetch()` wrapper. A source that breaks never stops the others — the scan report shows which one
failed.

**Add a source:** copy `src/sources/douglascounty.ts`, change the URL + parser, add it to `ALL_SOURCES`
in `src/sources/index.ts`, drop a saved page in `test/fixtures/` (the raw response, not a browser
"Save as"), write a test. More QuestCDN boards are one line in `QUEST_BOARDS`.

## Scoring (the part to tune with L&M)

`config/lm-electric.json` is the whole personality of the scanner — no code changes needed:

- `keywords.strong` electrical scope · `related` adjacent trades · `general` generic construction ·
  `otherTrades` points off · `exclude` hard no. `word*` = prefix match, plain = whole word.
- `maxDistanceMi`, `valueRange`, `minDaysToBid`, `setAsidesEligible`, `notify.minScore`.

`score = trade (0–45) + [distance 25 + size 15 + runway 15] × tradeFactor − penalties`. The factor
(1.0 electrical / 0.75 related / 0.45 general) stops "close by with lots of time" from making a paving
job look good. Every score comes with plain-English reasons on the card.

## Working with Claude Code

`CLAUDE.md` is the project memory Claude Code loads every session. `docs/PRODUCT.md` is the product
spec (what the app is supposed to be). `docs/HANDOFF.md` has the research
notes, decisions and roadmap; `docs/KICKOFF_PROMPT.md` is the first message to paste in. Project skills:
`/verify` (typecheck + tests + build, also runs before commits), `/add-source <agency or URL>`,
`/live-scan`. CI (`.github/workflows/ci.yml`) runs the same checks on every push.

## Run it locally

```bash
npm install
npm test                       # ~1,390 tests (vitest, ~65 s)
npm run scan -- --fixtures     # load the captured real bids (no network needed)
npm run dev                    # http://localhost:8787
```

Modes, set in `.env`: `AUTH_MODE=single` (default) is the pilot — one profile from `config/`, no sign-in,
optional `ACCESS_CODE`. `AUTH_MODE=accounts` is the multi-company app: email + password sign-up (Google /
Apple / Microsoft buttons appear only when `SUPABASE_URL` is set — never run for real yet), a 5-step
onboarding (business, trades, ZIP + radius, job sizes and spend limits, alerts) and a profile per account.
`DEMO_MODE=1` puts everyone on plan "pilot" (all features on, nothing billed). `SOURCES=fixtures` makes
scans read the saved pages instead of the boards. Phone alerts need `VAPID_*` keys (`npm run push:keys`).

`npm run market:refresh -- --states=NV,CA` pulls federal award prices (USAspending) and BLS wages +
material indexes into the database for the price check; `--skip-bls` / `--skip-awards` limit it.

`npm run scan` (no flag) hits the live boards. `npm run demo:snapshot` rebuilds `web/demo-data.json`
and `out/bidswipe-demo.html` (a single-file, no-server demo of the app; premium screens show their locked card there).

`npm run simulate -- --seed 20261113 --out out/sim` runs 16 simulated companies (SIM … (simulated),
@example.com) through the real server on the real captured bids, SAM.gov included, and writes
`report.md` + `report.json`: per-company results, checks (and which ones this data cannot exercise),
a same-seed hash and mutation runs that prove the checks can fail. `npm run simulate:cost -- --companies
2000 --seed 4242` stress-runs the cost engine on seeded simulated companies.

Environment (all in `.env`, see `.env.example`): `PORT`, `HOST`, `DATA_DIR` (embedded DB folder),
`DATABASE_URL`, `AUTH_MODE`, `DEMO_MODE`, `SOURCES`, `ACCESS_CODE`, `ADMIN_TOKEN`, `SCAN_DAILY_AT` and
`MARKET_REFRESH_AT` (Pacific `HH:MM`, blank = off), `PRICE_WATCH_THRESHOLD_PCT` (price alert threshold,
default 2), `SAM_API_KEY`, `BLS_API_KEY`, `RESEND_API_KEY` + `DIGEST_TO`, `VAPID_*`, `APP_URL`.

## Deploy on the VPS (PM2 + Caddy)

```bash
git clone … bidswipe && cd bidswipe
cp .env.example .env          # fill in SAM_API_KEY, ACCESS_CODE, ADMIN_TOKEN, RESEND_API_KEY, DIGEST_TO, APP_URL
npm ci && npm run build
npm run scan:prod -- --no-notify   # first scan, check every source says OK
pm2 start ecosystem.config.cjs && pm2 save
```

Add `Caddyfile.example` to your Caddyfile for HTTPS. The server runs the daily scan itself at
`SCAN_DAILY_AT` (Pacific) and, when `MARKET_REFRESH_AT` is set, a daily market refresh that also sends
price and award alerts to Pro profiles. Trigger one by hand with:

```bash
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" https://bids.yourdomain.com/api/admin/scan
```

**Database:** blank `DATABASE_URL` = embedded Postgres (PGlite) in `./data` — perfect for one company.
For the multi-user App Store version, point `DATABASE_URL` at Supabase; same schema, no code changes.

## API

| | |
|---|---|
| `GET /api/feed` | scored bids; `?all=1&minScore=0` for Browse, plus search/filters `q`, value, distance, due, verdict, source, sort |
| `GET /api/bids/:id`, `GET /api/next` | one bid · the "next up" pick with its reasons |
| `POST /api/swipe {bidId, action}` | `save` · `pass` · `bid` |
| `DELETE /api/swipe/:bidId` | undo |
| `GET /api/saved` | saved, soonest deadline first |
| `GET /api/me`, `GET /api/health` | who/what profile (401 `sign_in_required`, 409 `onboarding_required` in accounts mode), status |
| `GET /api/auth/config`, `POST /api/auth/{signup,login,logout,oauth}` | accounts mode sign-in (cookie session) |
| `GET /api/trades`, `GET /api/geo/zip/:zip`, `PUT /api/profile` | onboarding / settings |
| `GET /api/alerts`, `POST /api/alerts/read`, `GET /api/stream` | alert inbox, live events (SSE) |
| `GET /api/push/key`, `POST`/`DELETE /api/push/subscribe` | phone (web push) alerts |
| `GET /api/market/{awards,area,prevailing}` | price check: federal awards, BLS wage + indexes, NV prevailing wage hint |
| `GET /api/market/watch` | Pro: what the price/award watch looks at, last and next check (`{ locked: true, … }` otherwise) |
| `POST /api/estimate`, `GET /api/estimates?bidId=` | Pro cost check: `EstimateRequest` → price, build-up, cash carried, limits, sources, or `needed`; saved per profile. 402 `premium_required` without the feature |
| `POST /api/admin/scan`, `/api/admin/market/refresh`, `/api/admin/plan`, `GET /api/admin/market/watch` | operator routes (`x-admin-token`) |

Every POST/PUT/PATCH/DELETE must send `x-bidswipe: 1` (CSRF guard). If `ACCESS_CODE` is set (single
mode), the app asks for it once and sends it as `x-access-code`.

## Honest limits

- Small jobs ($10K–$50K) are often handled by quote, not posted publicly — L&M should also get on
  vendor lists (Douglas County, DCSD, Carson City, GIDs). The scanner finds the public ones.
- QuestCDN and NGEM detail pages open via JavaScript, so those cards link to the board and show the
  project/bid number.
- NevadaEPro is mostly supply purchases — those cards are flagged "May be supply-only".
- Distances are straight-line miles.
- SAM.gov needs `SAM_API_KEY`; without it the federal source is skipped. Its saved responses are in
  `test/fixtures/samgov-*.json`; `npm run simulate` uses them, `--fixtures` mode and the demo do not yet.
- None of the 111 bids captured so far lists an estimated value, so spend limits and the value filter
  never bite on real data (the simulation reports those checks as "not exercised").
- Phone push has never been delivered end to end. Alerts are as fresh as the last scan (once a day by
  default): "live" means the moment a scan finds a bid, not the moment a board posts it.
- Bids are sealed: nobody sees a competitor's price before the opening. Award alerts are results after the fact,
  and they only match SAM.gov bids (the only source with a solicitation number).
- California has no state or local source yet: California companies see only federal notices.

## Road to the App Store

1. Pilot with L&M (this repo) → track saves and bids.
2. Accounts (Supabase Auth) + one profile per business; onboarding = pick trade, home base, radius.
3. Wrap the PWA (Capacitor) or rebuild the deck in Expo; push notifications for new matches.
4. Paid tier: instant alerts, AI bid summaries/drafts, more regions. Bill on the web (Stripe).
