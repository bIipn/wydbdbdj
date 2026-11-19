# ⚡ BidSwipe

Public bids that fit your trade, one swipe at a time. **v0 is tuned for L&M Electric (Gardnerville, NV).**

Every morning it pulls open bids from county, state, local-agency and federal boards, scores each one for
L&M (electrical scope, distance from Gardnerville, job size, days left to bid), emails the good ones, and
serves a phone-friendly swipe app. Bidding on a public bid happens on the agency's own site — every card
links straight there; BidSwipe never takes those bids.

**Local jobs** (accounts mode): anyone signed in can post a job; others place a **sealed** bid in the app; at
closing the lowest bid wins; the winner has 7 days to make contact (a message, or either side's "We've agreed",
or the poster's "They contacted me"). A winner who never makes contact or backs
out owes a 5% no-show fee (2% of the bid to the poster); an agreed job carries a 1% service fee. **Payments
are off: fees are recorded, never collected.** Rules and research: `docs/MARKETPLACE.md`.

**The screens** (phone first; a five-tab bar at the bottom, a row under the header at desk width):
**Home** (the landing: "Welcome" with the bell and the profile button, the tasks and preferences cards, then
"Matches your preferences" as a scrolling list of cards with Save and Pass at the right edge, or, with the
Scroll | Swipe switch, the swipe deck) · **Search** (every open bid in reach, search, filters, sort, paging) ·
**Saved** · **Jobs** (local jobs, accounts mode) · **Messages** (poster and winner of a local job, after the
award; accounts mode). Single mode and the bundled demo show Home · Search · Saved; an account here only to get
work done sees Jobs · Messages. Across the top of every tab screen runs the **market tape**: one rounded pill
showing one monthly figure at a time (a material's price index level and one-month change, or the area wage),
the next sliding up into its place every 4 seconds (pause button; still with reduced motion). Tapping it opens
**Market** (award history, wages, material prices; Back, or the phone's own Back, returns to the tab; not in the
bundled demo). A **conversation** opens from Messages (or a job page, or a "New message" toast) as a full-page chat:
the other side at the left, you at the right, the composer while the contact rules allow writing, one sentence
after.

```
sources ──► normalize + locate ──► score per contractor ──► Postgres ──► API ──► swipe app (PWA)
                                                                     └──► daily email digest
```

## Sources

| Source | Group | What it covers | How |
|---|---|---|---|
| `douglascounty` | default | Douglas County NV (Minden/Gardnerville) bids | public HTML table |
| `questcdn` | default | NV State Public Works (four more boards are built but OFF: the host's robots.txt says `Disallow: /`) | QuestCDN board JSON, one GET per board |
| `ngem` | default | NGEM: Carson City, Reno-Tahoe Airport, UNR/TMCC, Clark County… | public IonWave list, paged by form postback |
| `nevadaepro` | default | NV State Purchasing (goods + services) | BuySpeed open-bids table, paged by PrimeFaces partial POST |
| `samgov` | default | Federal, the whole US (construction + trade NAICS) | SAM.gov's public daily bulk file (no key, ~222 MB, streamed); `SAM_SOURCE=api` uses the v2 API instead (key, 10 calls/day) |
| `caleprocure` | west | California State Contracts Register: every state department | PeopleSoft HTML grid (suppliers.fiscal.ca.gov), all events on one page |
| `laramp` | west | Los Angeles RAMP: City departments, LAUSD, LA County, Port of Long Beach | Socrata open data (data.lacity.org) |
| `sfbids` | west | San Francisco: every City department | Socrata open data (data.sf.gov) |
| `oregonbuys` | west | Oregon state agencies, counties, cities | BuySpeed, paged |
| `usac470` | west | E-Rate FCC Form 470: schools and libraries taking quotes for cabling / installed Wi-Fi (NOT a sealed bid: own flag) | Socrata open data (opendata.usac.org), nationwide |
| `civicplus` | west | City sites on the CivicPlus "Bid Postings" module: Citrus Heights and Auburn, CA (one line per site in `CIVICPLUS_SITES`) | public HTML list (/Bids.aspx), one GET per site |
| `bidsandtenders` | west | Agencies on the bids&tenders platform: Placer County, CA (one line per agency in `BIDSANDTENDERS_AGENCIES`) | the list page's own JSON call: one GET of the list page (token + NodeId), then a POST per 100 open rows, one cookie session |
| `caltrans` | west | Caltrans advertised projects | **off**: robots.txt `Disallow: /`, and the page is a script shell |
| `commbuys` | east | Massachusetts state agencies, towns, housing authorities | BuySpeed, paged (≈36 pages, slow board) |
| `bidbuy` | east | Illinois state agencies (Tollway, DNR, CMS…) | BuySpeed, paged |
| `njstart` | east | New Jersey state contracts | BuySpeed |
| `nycrecord` | east | NYC City Record: procurement solicitations | Socrata open data (data.cityofnewyork.us) |
| `flmfmp` | south | MyFloridaMarketPlace: Florida agencies, universities, districts | JSON POST, 100 a page |
| `txesbd` | south | Texas ESBD | **off**: robots.txt `Disallow: /` (parser built and tested) |
| `opengov` | opengov-1…5 | OpenGov Procurement portals: ~540 governments (128 in California: Sacramento County, Rancho Cordova, West Sacramento…) | JSON: the government list, then one POST per government, sliced by state |

The scan runs in **groups**, one cron call each (`vercel.json`; `npm run scan -- --group=west`), each with a 200 s
fetch budget inside the host's 300 s; the default group runs last. Every board is filtered to work a contractor could
do (`src/sources/relevance.ts`), reads times on its own clock, and fails loudly when a page is not what it expects.
Board by board (hosts, robots.txt, counts, fixtures): `docs/DATA-SOURCES.md` §7.

Each source is one file in `src/sources/` with a pure `parse…()` function (unit-tested against real
responses in `test/fixtures/` — the raw server HTML/JSON, captured Nov 13 2026; QuestCDN Nov 11;
the wave-2 boards Nov 14) plus a
small `fetch()` wrapper. The SAM.gov bulk file (`src/sources/samgov-bulk.ts`) is parsed as it downloads
(RFC 4180, each field decoded as UTF-8 or Windows-1252 on its own); `test/fixtures/samgov-bulk-sample.csv`
holds 82 raw rows of the 2026-11-13 file. A download with under 20,000 rows (`SAM_BULK_MIN_ROWS`) is
treated as cut off and fails loudly. Only bids that could matter to a company (its states, or within
max(2 × radius, radius + 100 mi, 150 mi)) get a stored score: `src/score/candidates.ts`. A source that breaks never stops the others — the scan report shows which one
failed.

**Add a source:** copy `src/sources/douglascounty.ts`, change the URL + parser, add it to `ALL_SOURCES`
in `src/sources/index.ts`, drop a saved page in `test/fixtures/` (the raw response, not a browser
"Save as"), write a test. More QuestCDN boards are one line in `QUEST_BOARDS`, but the host's robots.txt says `Disallow: /`: none is added without the owner's say (`QUEST_BOARDS_OFF`).

## Scoring (the part to tune with L&M)

`config/lm-electric.json` is the whole personality of the scanner — no code changes needed:

- `keywords.strong` electrical scope · `related` adjacent trades · `general` generic construction ·
  `otherTrades` points off · `exclude` hard no. `word*` = prefix match, plain = whole word.
- `maxDistanceMi`, `valueRange`, `minDaysToBid`, `setAsidesEligible`, `notify.minScore`.

`score = trade (0–45) + [distance 25 + size 15 + runway 15] × tradeFactor − penalties`. The factor
(1.0 electrical / 0.75 related / 0.45 general) stops "close by with lots of time" from making a paving
job look good. Every score comes with plain-English reasons on the card.

Tiers: **fit** (the company's own trade, 35+), **sub** (a building or facility prime where the trade is usually
subcontracted: 36–50, always "maybe", never an alert; `src/score/subwork.ts`) and **other**. Federal notices also
carry their Product and Service Code (`psc`, `src/sources/psc.ts`): a facility code counts like the trade's NAICS,
an equipment code (J/N/K/H) only weakly. `PUT /api/profile` answers with the same `counts` for the onboarding.

## Working with Claude Code

`CLAUDE.md` is the project memory Claude Code loads every session. `docs/PRODUCT.md` is the product
spec (what the app is supposed to be). `docs/HANDOFF.md` has the research
notes, decisions and roadmap; `docs/KICKOFF_PROMPT.md` is the first message to paste in. Project skills:
`/verify` (typecheck + tests + build, also runs before commits), `/add-source <agency or URL>`,
`/live-scan`. CI (`.github/workflows/ci.yml`) runs the same checks on every push.

## Run it locally

```bash
npm install
npm test                       # ~1,530 tests in 60 files (vitest, ~50 s)
npm run scan -- --fixtures     # load the captured real bids (no network needed)
npm run dev                    # http://localhost:8787
```

Modes, set in `.env`: `AUTH_MODE=single` (default) is the pilot — one profile from `config/`, no sign-in,
optional `ACCESS_CODE`. `AUTH_MODE=accounts` is the multi-company app: email + password sign-up (Google /
Apple / Microsoft buttons appear only when `SUPABASE_URL` is set — never run for real yet), a 6-step
onboarding done by taps (trades → "Use my location" or ZIP + travel distance → job sizes → your paperwork:
SPWD / SAM.gov / bonds / prevailing wage, Yes / No / Not sure, plus federal certifications → alert level →
optional business name) and a profile per account. A paperwork "No" never hides a bid: it holds the score
under the alert line and says why on the card. `PROMO_CODES` turns on a promo-code box in Settings and
`?promo=CODE` links (web + Microsoft Store builds only; see `docs/PRODUCT.md` §4).
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
2000 --seed 4242` stress-runs the cost engine on seeded simulated companies. `npm run simulate:jobs -- --seed
20261114 --out out/sim-jobs` runs 38 simulated people through the real marketplace (post, sealed bids, award,
contact window, fees): 15 checks, a same-seed hash and 10 mutations at real seams; about 8 minutes.

Environment (all in `.env`, see `.env.example`): `PORT`, `HOST`, `DATA_DIR` (embedded DB folder),
`DATABASE_URL`, `AUTH_MODE`, `DEMO_MODE`, `SOURCES`, `ACCESS_CODE`, `ADMIN_TOKEN`, `SCAN_DAILY_AT` and
`MARKET_REFRESH_AT` (Pacific `HH:MM`, blank = off), `PRICE_WATCH_THRESHOLD_PCT` (price alert threshold,
default 2), `SAM_SOURCE` (`bulk` default / `api`), `SAM_API_KEY` (api mode only), `SAM_BULK_MIN_ROWS`,
`PROMO_CODES` (`CODE:pro[:maxUses][:expiresISO]`, comma-separated; real codes only on the host),
`REALTIME_MODE` (`stream` / `poll`; poll is the default on Vercel) + `REALTIME_POLL_MS`, `CRON_SECRET`
(serverless cron routes), `BLS_API_KEY`, `RESEND_API_KEY` + `DIGEST_TO`, `VAPID_*`, `APP_URL`.

## Deploy on Vercel (serverless)

`vercel.json` builds with `npm run build` and starts `server.js`, which imports `serverless-files.cjs`
(names every folder the function must ship: `web/` and each sub-folder, `config/`; a new sub-folder needs
a line there, `test/serverless-entry.test.ts` checks it). On Vercel the app has no timers:

- `DATABASE_URL` is required (Supabase): the embedded database would start empty on every instance.
- The host's scheduler calls `GET /api/cron/market`, `/api/cron/scan` and `/api/cron/tick` (deadline
  reminders + waiting pushes) with `Authorization: Bearer $CRON_SECRET`. Without `CRON_SECRET` they 404.
  Hobby plans allow daily crons only, so reminders run once a day there (14:50 UTC). Saved-bid reminders go by the
  calendar day on the user's alert clock (3 days before, the day before, the due day; `src/realtime/alerts.ts`
  deadlineStage), so that one run sends the 3-day and day-before reminders on their own day in every Settings zone.
  The due-day reminder goes only when the deadline is later than that day's run: 06:50 PST / 07:50 PDT, 09:50 EST /
  10:50 EDT, 08:50 CST / 09:50 CDT, 07:50 MST / 08:50 MDT (Arizona 07:50), 05:50 AKST / 06:50 AKDT, 04:50 in Hawaii.
  A 10:00 AM Eastern deadline gets no due-day reminder in summer (the day before said "Due tomorrow at 10:00 AM")
  and one 10 minutes before it in winter. An hourly tick (docs/PLAN.md O9) fixes that.
- Live alerts poll (`REALTIME_MODE=poll` is automatic when `VERCEL` is set): the app asks the inbox about
  once a minute while open and reloads its feed after each scan.
- The SAM.gov bulk download is ~222 MB per scan. Measured in a Vercel function on 2026-11-13: download
  and parse 8.2 s, 495 federal cards stored, the whole scan 10 s. `SAM_SOURCE=api` is the fallback.
- Vercel quirks this setup works around (each cost a failed deploy; do not undo them):
  the entry is plain JavaScript (`server.js`) because Vercel's own TypeScript step fails on this
  tsconfig; `listen()` is not awaited in serverless mode (it never reports back there);
  `@fastify/static` cannot load there, so `src/static.ts` serves the shell from a fixed file list;
  `vercel.json` must not have a `functions` block (rejected for this framework); `TRUST_PROXY` cannot
  be a `/0` range (use `0.0.0.0/1,128.0.0.0/1,::/1,8000::/1`); `engines.node` is pinned to 22.x.
- Supabase: connect through the shared pooler in transaction mode (port 6543) as the app's own
  database login. Keep the tables in that login's own schema, not `public`: Supabase's REST API
  exposes `public` to anyone with the project's public key.
- Set `PROMO_CODES` in the project's environment variables, never in the repo. `docs/MICROSOFT-STORE.md`
  has the Store steps (PWABuilder package, listing text, privacy page).

## Deploy on the VPS (PM2 + Caddy)

```bash
git clone … bidswipe && cd bidswipe
cp .env.example .env          # fill in ACCESS_CODE, ADMIN_TOKEN, RESEND_API_KEY, DIGEST_TO, APP_URL
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
| `GET /api/feed` | scored bids; `?all=1&minScore=0` for Browse, plus search/filters `q`, value, distance, due, verdict, source, sort, `tier=fit\|sub\|other\|all`, and paging: `limit` (1–300, default 100) and `offset` (0-based, default 0). Answers `{ items, counts, total, lastScan }`: every item carries `tier`; `counts: {fit, sub, other}` (open, unswiped, same non-tier filters); `total` = rows that match every filter of the request (tier included) before limit/offset. The order is stable across pages (ties broken by bid id). The deck (no `all`) holds sub work below the fits unless the profile's `showSubWork` is false or `tier=fit` |
| `GET /api/bids/:id`, `GET /api/next` | one bid · the "next up" pick with its reasons |
| `GET /api/bids/:id/calendar` | "Add to calendar": the bid's due time as an `.ics` file (`text/calendar`, attachment), a plain link with the session cookie; 404 `no_due_time` / `closed` (due time passed) / `local_job` / `not_found` with a message |
| `POST /api/swipe {bidId, action}` | `save` · `pass` · `bid` |
| `DELETE /api/swipe/:bidId` | undo |
| `GET /api/saved` | saved, soonest deadline first |
| `GET /api/me`, `GET /api/health` | who/what profile (401 `sign_in_required`, 409 `onboarding_required` in accounts mode), status |
| `GET /api/auth/config`, `POST /api/auth/{signup,login,logout,oauth}` | accounts mode sign-in (cookie session) |
| `GET /api/trades`, `GET /api/geo/zip/:zip`, `GET /api/geo/nearest-zip?lat=&lng=`, `GET`/`PUT /api/profile` | onboarding / settings (the location point is used once, never stored or logged) |
| `POST /api/promo/redeem {code}` | accounts mode, `PROMO_CODES` set: 200 `{plan, features}` · 400 `invalid_code` · 403 `not_available` (no codes, demo mode, iOS build) · 429 after 5 tries in 10 min |
| `GET /api/alerts`, `POST /api/alerts/read`, `GET /api/stream` | alert inbox (`lastScan` tells a polling app to reload its feed), live events (SSE; 404 `stream_off` in poll mode) |
| `GET /api/push/key`, `POST`/`DELETE /api/push/subscribe` | phone (web push) alerts; a subscription whose endpoint is not on a known push service (FCM, Mozilla, Apple, Windows) is 400 `invalid_subscription` |
| `POST /api/push/test` | the bell's **Send a test alert** button: one "Test alert from BidSwipe" to this account's devices through the real sender → `{ok, tried, accepted}` (never an endpoint; nothing goes to the inbox). Every plan (local jobs buzz on Free as on Pro); 409 `push_off` / `quiet_hours`, 429 after 3 in 10 minutes, 404 with no VAPID keys |
| `GET /api/market/{awards,area,prevailing}` | price check: federal awards, BLS wage + indexes, NV prevailing wage hint |
| `GET /api/market/watch` | Pro: what the price/award watch looks at, last and next check (`{ locked: true, … }` otherwise) |
| `POST /api/estimate`, `GET /api/estimates?bidId=` | Pro cost check: `EstimateRequest` → price, build-up, cash carried, limits, sources, or `needed`; saved per profile. 402 `premium_required` without the feature; a job over 3650 days is 400; 30 checks a minute per profile, then 429 |
| `POST /api/admin/scan`, `/api/admin/market/refresh`, `/api/admin/plan`, `GET /api/admin/market/watch`, `GET /api/admin/usage` | operator routes (`x-admin-token`). `GET /api/admin/usage`: counts only, for the last 7 and 28 days: return visits and the days (and mornings) with a decision, each on the person's own calendar; minutes from a match alert to the first decision, saves per alert, bids opened from "Bid on …", alerts read, alert opt-outs (phone alerts and each kind), local jobs. `POST /api/admin/scan?quiet=1` (or body `{"quiet": true}`) stores and scores but announces nothing: no 'match' alert, no push, and those bids never enter a digest |
| `GET /api/cron/{scan,market,tick}` | serverless scheduler (`Authorization: Bearer $CRON_SECRET`; 404 without it); `scan?group=…&quiet=1` is a quiet scan; `tick` also settles local jobs and sends the "2 days left to make contact" reminders |
| `GET /api/jobs/rules` | local jobs (accounts mode; 404 in single mode): fee rates, contact days, limits, `paymentsOn: false`. No sign-in needed |
| `POST /api/jobs {title, description, trades, zip, address?, phone?, budgetMaxCents?, closesInDays}` | post a job → 201 `{job}`; scored at once for nearby workers ('match' alerts) |
| `GET /api/jobs/mine`, `GET /api/jobs/:id` | `{posted, bidding}` · `{job, messages}`, shaped for the viewer (hidden fields are `null`/`[]`) |
| `POST`/`DELETE /api/jobs/:id/bid {amountCents, note?, agree: true}` | place/replace or withdraw a sealed bid while open |
| `POST /api/jobs/:id/{cancel,repost,messages,contacted,confirm,back-out,complete,report}` | poster/winner actions; repost once per job (409 after) |
| `GET /api/jobs/conversations` | Messages: `{conversations, unread}`, the viewer's conversations (poster and winner of an awarded job only), newest activity first; `unread` = how many have a message from the other side not yet read |
| `GET /api/jobs/:id/conversation` | `{conversation, messages}` for one of them; 403 `not_allowed` to anyone else, 404 for a removed job. Reading changes nothing |
| `POST /api/jobs/:id/read {upTo?}` | opened: read up to message `upTo` (default: all stored) → `{readUpTo, alertsRetired, alertsUnread}`; the read mark never moves back, the bell's "New message" alerts up to it are retired. A body that is not an object, or a bad `upTo`, is 400 |
| `POST /api/jobs/:id/conversation/report {reason, note?}` | report a conversation (its poster or winner only; anyone else gets the thread routes' 403) → `{ok, already, message}`; the other side is never told |
| `GET`/`PUT /api/work-profile`, `GET /api/people/:id` | work profile + its card · someone's card, only once you share a job (404 otherwise) |
| `POST /api/people/:id/report {reason, note?}` | report a card (only someone allowed to see it; else the people route's 404) |
| `GET /api/admin/jobs/reports`, `POST /api/admin/jobs/:id/remove`, `POST /api/admin/jobs/fees/:feeId/waive` | operator (`x-admin-token`): the reports list also carries `conversationReports` (with the thread) and `profileReports` (with the card) |
| `POST /api/admin/jobs/messages/:messageId/remove`, `POST /api/admin/people/:id/{hide,unhide}`, `POST /api/admin/reports/:reportId/resolve` | operator: remove one message (the row stays; both sides see "Message removed by BidSwipe"), hide a card (others see "BidSwipe member" and the job record), close a report |

Jobs errors: 400 `{error:'invalid_input', fields:[{path,message}]}`, 403 `not_allowed`, 404 `not_found`, 409
`closed`, 429 `too_many_attempts`. Settlement is lazy and idempotent: every jobs route, `GET /api/alerts` and
the realtime tick run `settleDue`. Settings: `JOB_NO_SHOW_FEE_PCT` (default 5, 0–10), `JOB_POSTER_SHARE_PCT`
(2, at most the no-show fee), `JOB_SERVICE_FEE_PCT` (1, 0–3), `JOB_CONTACT_DAYS` (7, 1–30), `JOB_MAX_CENTS`
(25000000); a bad value stops the boot with a plain sentence.

**Quiet loads.** A board's FIRST load (no stored bid of that board, or of that slice's states, before the scan) is
always quiet, whatever the switch: its bids are stored and scored but raise no alert and never reach a digest. Any
other scan sends at most 10 new 'match' alerts per profile (best first); the rest are held for good (still in the
deck). `npm run scan -- --quiet` is the same switch from the command line. A bid with no due date counts as open only
while its board still lists it (`last_seen_at` within 3 days).

Every POST/PUT/PATCH/DELETE must send `x-bidswipe: 1` (CSRF guard). If `ACCESS_CODE` is set (single
mode), the app asks for it once and sends it as `x-access-code`; 50 wrong codes per address in 15 minutes answer
429 for any code.

**Security headers.** One `onSend` hook in `src/server.ts` (SECURITY_HEADERS) puts these on every answer, the app
shell and its files included: a Content-Security-Policy (`default-src 'self'`, `script-src 'self'`, `style-src
'self'`, `img-src 'self' data:`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'` …), X-Frame-Options
DENY, nosniff, Referrer-Policy, Permissions-Policy, COOP and CORP same-origin, and `Cache-Control: no-store` on /api
answers that set none. So `web/index.html`, `privacy.html` and `terms.html` carry no inline script, no `<style>`,
no `style=` and no `on…=` attribute (`test/security-headers.test.ts`), and the JS sets styles through the CSSOM only.
Sign-in, sign-up, promo, access-code, profile-save, cost-check and test-alert limits are counters in the database
(`auth_attempts`), counted before the slow part in one atomic statement, so every serverless instance shares them.

## Honest limits

- Small jobs ($10K–$50K) are often handled by quote, not posted publicly — L&M should also get on
  vendor lists (Douglas County, DCSD, Carson City, GIDs). The scanner finds the public ones.
- QuestCDN and NGEM detail pages open via JavaScript, so those cards link to the board and show the
  project/bid number.
- NevadaEPro is mostly supply purchases — those cards are flagged "May be supply-only".
- Distances are straight-line miles.
- SAM.gov reads the public bulk file (no key). Notices that name no place of performance (511 merged
  cards on 2026-11-13, 146 of them still open) are left out: we cannot say they are in the US or near
  anyone. No-deadline notices posted over a year ago are dropped as stale. A deadline written without a
  time zone is read as Pacific unless a sibling notice gives the offset, and the card says to check.
  Captured API responses are in `test/fixtures/samgov-*.json` and the bulk sample beside them;
  `npm run simulate` uses them, `--fixtures` mode and the demo do not yet.
- The jobs routes' speed bumps (posting, bidding, messages, reports) live in memory per process; on serverless each
  instance counts on its own. The sign-in, promo and other limits above are in the database.
- None of the 111 bids captured so far lists an estimated value, so spend limits and the value filter
  never bite on real data (the simulation reports those checks as "not exercised").
- Phone push has never been delivered end to end to a real phone (only to a local mock of a push service). The bell's
  **Send a test alert** button is how to check it on a device: `docs/IPHONE-ALERTS.md` has the owner's iPhone recipe. Alerts are as fresh as the last scan (once a day by
  default): "live" means the moment a scan finds a bid, not the moment a board posts it.
- Bids are sealed: nobody sees a competitor's price before the opening. Award alerts are results after the fact,
  and they only match SAM.gov bids (the only source with a solicitation number).
- California has no state or local source yet: California companies see only federal notices.

## Road to the App Store

1. Pilot with L&M (this repo) → track saves and bids.
2. Accounts (Supabase Auth) + one profile per business; onboarding = pick trade, home base, radius.
3. Wrap the PWA (Capacitor) or rebuild the deck in Expo; push notifications for new matches.
4. Paid tier: instant alerts, AI bid summaries/drafts, more regions. Bill on the web (Stripe).
