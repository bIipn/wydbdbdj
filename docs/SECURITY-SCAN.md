# Security scan (HawkScan)

**Status (2026-11-17): no scan has yet attacked the signed-in routes with a live session.** Runs 2 and 3 found
nothing at High or Medium, but run 3's route table showed why that says little: the scanner signed itself out within
five minutes and most of its requests to signed-in routes were answered 401. What those two runs do show: the
signed-out surface (the shell, the legal pages, the public look-ups, the refusals) has no finding at High or
Medium, and the server took about 29,000 hostile requests per run with no 5xx and nothing slower than 5 seconds.
The signed-in routes are covered by the 2026-11-16 audit (scripts run by hand, each finding re-run by a skeptic)
and by the tests, not by a scan. Run 4 goes through the scan guard below; its numbers decide.

## Runs

| Run | Commit | What happened |
|---|---|---|
| 1 · 2026-11-16 17:54 UTC | f540e84 (before the fixes) | Cut off by the job's 60-minute limit with nothing to read: the progress was silenced and the artifact host is not reachable from Claude's sessions. Probably the cost-check crash below, which froze the server on a fuzzed end date (not confirmed) |
| 2 · 2026-11-16 21:35 UTC | cb979c2 (the fixes; the build that is live) | Finished by itself in 61 minutes. High 0 · Medium 0 · Low 2: "Information Leak - Email Address" on `/privacy.html` and `/terms.html`, the public contact address the owner put there on purpose (by design). 28,777 answers: no 5xx, none slower than 5 seconds, 514 were 429 (the new limits at work). 13,533 were 401, and the log could not say on which routes |
| 3 · 2026-11-16 23:02 UTC | f138414 (same app code; a report that prints route by status) | Finished in 48 minutes with the same result, and showed runs 2 and 3 were **hollow behind the sign-in**: the scanner called `POST /api/auth/logout` 171 times although `excludePaths` names it; `GET /api/me` answered 200 only in the first five minutes; a fuzzed sign-up succeeded 4 times, so for a while the scanner held a brand-new account with no profile (437 answers were 409); its fuzzed sign-ins used up the sign-in limit for the runner's address (117 x 429), so it never signed in again. Of 14,499 requests to signed-in routes, 10,057 were answered 401. `POST /api/estimate`: 10 reached the validation, 866 were 401 |
| 4 · 2026-11-17 | the scan guard (below) | Asked for after two reviewers attacked the guard locally. Read its "What the server saw" step: the session table, the share of signed-in requests that reached a handler, and what the guard stopped |

## What runs

`.github/workflows/hawkscan.yml` (GitHub Actions, about an hour; the scan ends itself after 80 minutes at most):

1. builds the app, loads the captured bids into a throwaway database, and starts `node dist/server.js` in
   accounts mode (`DEMO_MODE=1`, so the Pro routes are scanned too) on port 8787;
2. `scripts/hawkscan-seed.mjs` signs up two TEST accounts (example.com addresses, a password made up for this run
   that is masked in the log the moment it is made and only goes to the job's environment): a scan user that bids
   on the other account's local job;
3. starts the **scan guard**, `scripts/hawkscan-guard.mjs`, on port 8788. The scanner talks to the guard; the guard
   passes every request on to the app unchanged, except the few that would end the scan's own session or the
   objects the seed made (next section). It is scaffolding for this job: nothing in `src/` or `web/` knows it;
4. installs StackHawk's `hawk` CLI, finds or creates the StackHawk application `bidswipe`, checks the setup
   (`hawk validate config / api / auth`), then runs HawkScan with `stackhawk.yml`: every route in
   `docs/api/openapi.yaml` (`test/openapi.test.ts` keeps that spec equal to the server's routes), signed in as the
   scan user, with the `x-bidswipe: 1` header the CSRF guard asks for, plus a browser crawl of the app shell.

## What the scan does not test

`app.excludePaths` in `stackhawk.yml` did not keep the scanner off the routes it names (run 3; why is not known), so
the guard enforces the list. The app never sees these, and the scan says nothing about them:

| Stopped by the guard | It answers | Why |
|---|---|---|
| `POST /api/auth/logout` | 200 `{"ok":true}` | it ended the scan session (171 times in run 3) |
| `POST /api/auth/signup`, `POST /api/auth/oauth` | 403 `scan_guard` | a success hands the scanner another account's session |
| `POST /api/auth/login` with anything but the scan user's exact e-mail and password | 401 `invalid_credentials` | fuzzed sign-ins used up the app's sign-in limit for the runner's address. The scan user's own sign-in is passed on without its Cookie header, because a successful sign-in closes the session the request came with |
| `POST /api/jobs/<a seeded job>/cancel` and `/back-out`, `DELETE /api/swipe/<the seeded bid>` | 409 `scan_guard` | they would end the job, or undo the saved bid, that the other routes are attacked on. With any other id these routes pass through, so their id handling is still attacked |
| `GET /api/stream` | passed on, cut after 2 seconds | Server-Sent Events never end by themselves |

So **sign-in, sign-up, sign-out and the social sign-in route are not scanned.** They were attacked by hand in the
audit below (bursts, lock-outs, the limits on Postgres) and are covered by `test/auth.test.ts` and
`test/hardening.test.ts`.

Also outside the scan: every `/api/admin` and `/api/cron` route answers 401 by design (the scan has neither token,
and an admin scan could remove jobs or start a real board scan). The limits cap how much of some routes is
attacked: `PUT /api/profile` allows 20 saves per 10 minutes and the cost check 30 per minute, so most fuzzed
requests to them are answered 429. Messages, contact and agreement need an awarded job, which the seed cannot make
(bids stay open at least a day), so those handlers are reached only in their "not yet" branches.

## Asking for a scan

Either change `.github/hawkscan-run` (any edit, e.g. the date) and push to `main` or a `claude/...` branch, or open
**Actions > HawkScan > Run workflow**. Ordinary pushes never start a scan.

## Results

- The run's **Summary** and its log: each finding with severity, check name and path, then what the server saw:
  the answers by status, the scan user's session over time, and a table of route by status
  (`scripts/hawkscan-report.py`: the server report prints only method, path and status; the findings report prints
  each path's evidence shortened, with session cookie values and e-mail addresses hidden), and what the guard stopped.
  **Read the session table before the findings**: a run whose `GET /api/me` turns to 401 has not tested the
  signed-in routes, whatever its severity counts say.
- The **hawkscan-results** artifact: the full JSON, the server log and the guard's log.
- The StackHawk app (link in the summary), application `bidswipe`, environment `Development`.

A run ends green with a notice when it finds something at Medium or above: those get fixed and a scan is asked
for again. It ends red only when the scan could not run.

## The one owner step

Add the StackHawk API key as a repository secret named `HAWK_API_KEY`:
https://github.com/bIipn/wydbdbdj/settings/secrets/actions (New repository secret). Without it the workflow
prints one line saying so and stops, green.

## Security notes (audit of 2026-11-16)

What the audit found, what was fixed, and what is accepted for now. The fixes have tests; the ones that are
not fixed are written down here so nobody has to rediscover them.

Fixed:
- **Cost check:** a job longer than 3650 days (or a bid date more than 3650 days from the start) answers 400
  before the engine runs. An end date of 9999-12-31 used to pin the thread and crash the process.
- **Sign-in limits** (src/auth/ratelimit.ts, table `auth_attempts`, shared by every serverless instance). Every
  attempt is counted FIRST, in one atomic statement, and refused from that count; a success gives its count back,
  so in effect only failures count. (The first version read the counters, checked the password, then counted: 300
  simultaneous wrong passwords all got 401 against a limit of 10. Found in review, fixed the same day.) 10 per
  e-mail and address; 100 per address, except for an address that has signed in to that e-mail before (an office
  of typists never locks out its own people); once an e-mail has 100 failures in 15 minutes, each address that
  never signed in to it gets 3 tries, and the right password still gets in from anywhere (no lockout of the owner).
  A successful sign-in or sign-up remembers the address for 30 days and clears that e-mail's counters. Sign-up,
  promo codes, the single-mode ACCESS_CODE, profile saves, the cost check (30 a minute) and test alerts use the
  same counters. A 429 says the time really left. If the table cannot be read, one line is logged and the attempt
  goes through. The caller's address: `x-real-ip` / `x-vercel-forwarded-for` only when `VERCEL` is set (Vercel's
  edge writes them); otherwise the last X-Forwarded-For hop from a proxy on this machine, else the socket.
- **ACCESS_CODE** (single mode): 50 wrong codes per address per 15 minutes, then 429 for any code, the right one
  too. A code under 16 characters still starts the server, with one warning line.
- **Promo use limits** hold under a burst on Postgres: a gate row (`promo_codes.uses`) is bumped with
  `uses < limit` before the redemption goes in. Proved with 20 simultaneous redeems on Postgres 16
  (`test/promo-pg.test.ts`, run with TEST_DATABASE_URL).
- **Headers** on every response (src/server.ts SECURITY_HEADERS): a Content-Security-Policy with
  `script-src 'self'` and `style-src 'self'` and no hashes (the inline service-worker script and the legal pages'
  styles moved to files), `frame-ancestors 'none'` + X-Frame-Options DENY, nosniff, Referrer-Policy,
  Permissions-Policy, COOP, CORP, and `Cache-Control: no-store` on API answers that set none of their own.
- **Push endpoints** must be on a push service (FCM, Mozilla, Apple, Windows). A device whose push service
  refuses outright (400, 403, 413) gets nothing until it subscribes again; one that fails 20 times in a row with
  nothing through for a week is deleted. VAPID tokens are reused per push-service origin for 2 hours (Apple asks
  for at most one new token an hour).
- **Errors:** a 5xx answers `{"error":"internal"}` only (Fastify's own 4xx keep their old shape); a NUL in a path id or a JSON body answers 400 (the feed search drops control characters from its query itself).
- **'Get work done' accounts** cannot bid (403, the Jobs screen's sentence).

Accepted for now:
- **Sign-up says whether an address is registered** (409 for a taken address). Accepted until e-mail
  confirmation exists; then both answers become "check your inbox".
- **Social sign-in has no state / PKCE yet.** The return (`#access_token`) is accepted without a check that this
  browser started it. Not reachable today (no provider is turned on), but state or Supabase's PKCE flow MUST be
  added BEFORE any Google / Apple / Microsoft sign-in is turned on.
- **A push endpoint moves to the account that registers it** (by design: two people on one phone). Exploiting it
  needs the device's secret endpoint URL. Sign-out now drops the device: the server is told while the session is
  still valid, and the browser's subscription is dropped at the same time even if that request hangs.
- **One device failing while another accepts** (a 429 or 5xx from its push service) does not get that alert
  again: the retry is per profile, not per device. The in-app inbox always has it. A per-device retry would need
  its own table; not worth it at pilot scale.
- **Burst edge of ACCESS_CODE:** a wrong code is counted first (atomic); the RIGHT code only reads the counter, so
  in a burst the right guess can be read before the wrong ones around it are counted (bounded by how many arrive
  together). Counting every right code would add a write to every request of the pilot.
- **Under attack, a brand-new address gets 3 tries per 15 minutes** for that e-mail. A person who mistypes their
  password three times from a new address while their e-mail is being attacked waits out the window.
- **Someone on the owner's own address guessing the owner's e-mail** uses up that address's 10 tries for it (the
  pair counter is per e-mail and address), so the owner there waits too.
- **The push allowlist might refuse a real endpoint host** not on the list. `jmt17.google.com` was added on
  2026-11-16: Chromium's source names it as the staging push endpoint (pre-release Chrome builds), so it is a real
  Google push host. The subscribe route logs any other refused host: check the log after a deploy.
- **A report notifies nobody.** It is stored and logged (`jobs: a … was reported`); the operator reads them with
  `GET /api/admin/jobs/reports`. The copy says only that reports go to BidSwipe.
- **The scan's push example** (`docs/api/openapi.yaml`) uses a made-up host, so the scan now sees the 400; the
  server never POSTs to a real push service for it.

Limits of what was tested: production (Vercel + Supabase) was read with plain GETs only, never signed in to or
posted to; Vercel's `x-real-ip` behaviour is taken from its documentation, not observed. Real push delivery to a
phone was not run (no push service is reachable from the test machine). WebKit (Safari) was not available: the
policy was walked in Chromium only.
