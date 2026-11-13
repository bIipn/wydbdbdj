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
| `ngem` | NGEM: Carson City, Reno-Tahoe Airport, UNR/TMCC, Clark County… | public IonWave list, paged |
| `nevadaepro` | NV State Purchasing (goods + services) | public BSO open-bids table |
| `samgov` | Federal (NV + Tahoe-side CA) | official SAM.gov v2 API — **needs a free key** |

Each source is one file in `src/sources/` with a pure `parse…()` function (unit-tested against real pages
captured Nov 11 2026 in `test/fixtures/`) plus a small `fetch()` wrapper. A source that breaks never stops
the others — the scan report shows which one failed.

**Add a source:** copy `src/sources/douglascounty.ts`, change the URL + parser, add it to `ALL_SOURCES`
in `src/sources/index.ts`, drop a saved page in `test/fixtures/`, write a test. More QuestCDN boards are
one line in `QUEST_BOARDS`.

## Scoring (the part to tune with L&M)

`config/lm-electric.json` is the whole personality of the scanner — no code changes needed:

- `keywords.strong` electrical scope · `related` adjacent trades · `general` generic construction ·
  `otherTrades` points off · `exclude` hard no. `word*` = prefix match, plain = whole word.
- `maxDistanceMi`, `valueRange`, `minDaysToBid`, `setAsidesEligible`, `notify.minScore`.

`score = trade (0–45) + [distance 25 + size 15 + runway 15] × tradeFactor − penalties`. The factor
(1.0 electrical / 0.75 related / 0.45 general) stops "close by with lots of time" from making a paving
job look good. Every score comes with plain-English reasons on the card.

## Working with Claude Code

`CLAUDE.md` is the project memory Claude Code loads every session. `docs/HANDOFF.md` has the research
notes, decisions and roadmap; `docs/KICKOFF_PROMPT.md` is the first message to paste in. Project skills:
`/verify` (typecheck + tests + build, also runs before commits), `/add-source <agency or URL>`,
`/live-scan`. CI (`.github/workflows/ci.yml`) runs the same checks on every push.

## Run it locally

```bash
npm install
npm test                       # 41 tests
npm run scan -- --fixtures     # load the captured real bids (no network needed)
npm run dev                    # http://localhost:8787
```

`npm run scan` (no flag) hits the live boards. `npm run demo:snapshot` rebuilds `web/demo-data.json`
and `out/bidswipe-demo.html` (a single-file, no-server demo of the app).

## Deploy on the VPS (PM2 + Caddy)

```bash
git clone … bidswipe && cd bidswipe
cp .env.example .env          # fill in SAM_API_KEY, ACCESS_CODE, ADMIN_TOKEN, RESEND_API_KEY, DIGEST_TO, APP_URL
npm ci && npm run build
npm run scan:prod -- --no-notify   # first scan, check every source says OK
pm2 start ecosystem.config.cjs && pm2 save
```

Add `Caddyfile.example` to your Caddyfile for HTTPS. The server runs the daily scan itself at
`SCAN_DAILY_AT` (Pacific). Trigger one by hand with:

```bash
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" https://bids.yourdomain.com/api/admin/scan
```

**Database:** blank `DATABASE_URL` = embedded Postgres (PGlite) in `./data` — perfect for one company.
For the multi-user App Store version, point `DATABASE_URL` at Supabase; same schema, no code changes.

## API

| | |
|---|---|
| `GET /api/feed?all=1&minScore=0` | scored bids (swipe deck + browse list) |
| `POST /api/swipe {bidId, action}` | `save` · `pass` · `bid` |
| `DELETE /api/swipe/:bidId` | undo |
| `GET /api/saved` | saved, soonest deadline first |
| `GET /api/me`, `GET /api/health` | profile, status |
| `POST /api/admin/scan` | run a scan now (`x-admin-token`) |

If `ACCESS_CODE` is set, the app asks for it once and sends it as `x-access-code`.

## Honest limits (v0)

- Small jobs ($10K–$50K) are often handled by quote, not posted publicly — L&M should also get on
  vendor lists (Douglas County, DCSD, Carson City, GIDs). The scanner finds the public ones.
- QuestCDN and NGEM detail pages open via JavaScript, so those cards link to the board and show the
  project/bid number.
- NevadaEPro is mostly supply purchases — those cards are flagged "May be supply-only".
- Distances are straight-line miles.

## Road to the App Store

1. Pilot with L&M (this repo) → track saves and bids.
2. Accounts (Supabase Auth) + one profile per business; onboarding = pick trade, home base, radius.
3. Wrap the PWA (Capacitor) or rebuild the deck in Expo; push notifications for new matches.
4. Paid tier: instant alerts, AI bid summaries/drafts, more regions. Bill on the web (Stripe).
