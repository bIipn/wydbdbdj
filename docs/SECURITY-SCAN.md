# Security scan (HawkScan)

**Status (2026-11-18): runs 4, 5 and 6 were signed in all the way and found nothing at High or Medium, and no 5xx.**
Both fixes after run 4 hold. `POST /api/estimate` reaches the cost engine (237 x 200 in runs 5 and 6). Every
job-route request whose id was a UUID carried one of the two seeded jobs (run 6: 1,444 requests, 0 other ids).

A correction to what was written after run 5: `messages`, `confirm`, `complete`, `contacted` and `read` were not
84 x 404 and not ids that are not jobs. That was a misread column. They were 84 x 403 in run 5 and in run 6: the
seeded job's id with the app's answer to someone who is neither the poster nor the winner of an awarded job.

The seeded jobs are open, so those five handlers stop at that check. The scanner would only get past it with a seeded
job already awarded to the scan user (not done). Until then, what lies past it is covered by test/no-5xx.test.ts,
whose seed includes an awarded job.

The job routes' 404s are the scanner asking GET of routes that only take POST, ids that are not UUIDs and probe paths
(`.git/index`). What the guard keeps the scanner from is still not scanned: sign-in, sign-up, sign-out, social
sign-in and Delete account. It is covered by the 2026-11-16 audit and the tests (test/account-delete.test.ts,
test/no-5xx.test.ts).

## Runs

| Run | Commit | What happened |
|---|---|---|
| 1 · 2026-11-16 17:54 UTC | f540e84 (before the fixes) | Cut off by the job's 60-minute limit with nothing to read: the progress was silenced and the artifact host is not reachable from Claude's sessions. Probably the cost-check crash below, which froze the server on a fuzzed end date (not confirmed) |
| 2 · 2026-11-16 21:35 UTC | cb979c2 (the fixes; the build that is live) | Finished by itself in 61 minutes. High 0 · Medium 0 · Low 2: "Information Leak - Email Address" on `/privacy.html` and `/terms.html`, the public contact address the owner put there on purpose (by design). 28,777 answers: no 5xx, none slower than 5 seconds, 514 were 429 (the new limits at work). 13,533 were 401, and the log could not say on which routes |
| 3 · 2026-11-16 23:02 UTC | f138414 (same app code; a report that prints route by status) | Finished in 48 minutes with the same result, and showed runs 2 and 3 were **hollow behind the sign-in**: the scanner called `POST /api/auth/logout` 171 times although `excludePaths` names it; `GET /api/me` answered 200 only in the first five minutes; a fuzzed sign-up succeeded 4 times, so for a while the scanner held a brand-new account with no profile (437 answers were 409); its fuzzed sign-ins used up the sign-in limit for the runner's address (117 x 429), so it never signed in again. Of 14,499 requests to signed-in routes, 10,057 were answered 401. `POST /api/estimate`: 10 reached the validation, 866 were 401 |
| 4 · 2026-11-17 | the scan guard (below) | Finished by itself: 89 minutes of scanning (the app's log covers 91, with the seeding before it). High 0 · Medium 0 · Low 2: the contact address on the two legal pages, as in run 2 (by design). Signed in all the way: `GET /api/me` answered 200 in every five-minute slot, 3,537 times; the 15 x 401 are the scanner's own signed-out probes of that route. Of 14,703 requests to signed-in routes, 13,201 (90%) reached a handler, 1,484 (10%) were 429 and 18 were 401. The guard stopped 271 sign-ups, 271 sign-ins that were not the scan user's, 139 oauth calls and 133 logouts, and cut 59 streams. No answer slower than 5 seconds. ONE 500: `GET /api/estimates` with a NUL in `bidId` (Postgres refuses a NUL in text; the route passed the query on unchecked), fixed in the same change, with a test. Two limits: the job routes got an id that is not a job (`POST /api/jobs/{id}/messages` 139 x 404 of 140, the same for confirm, complete, contacted, read, cancel and back-out: most answers were the first look-up's 404), and `POST /api/estimate` never reached the cost engine (10 x 400, 725 x 404, 20 x 429, never 200) |
| 5 · 2026-11-18 | 5eb226e (real ids and a complete cost request; the NUL fix) | Finished by itself in 82 minutes (scan 7cf84905…, 158 URLs). High 0 · Medium 0 · Low 2: the contact address on the two legal pages (by design). Signed in all the way: `GET /api/me` answered 200 in every five-minute slot, 2,351 times; its 25 x 401 are the scanner's own signed-out probes. Of 10,335 requests to signed-in routes, 9,141 (88%) reached a handler, 1,167 (11%) were 429 and 27 were 401. No 5xx, no answer slower than 5 seconds, no error line. `POST /api/estimate`: 237 x 200 (run 4: never), 1,110 x 400, 137 x 429. The job routes: 1,886 requests, 918 (49%) answered 404. `messages`, `confirm`, `complete`, `contacted` and `read`: 84 x 403 each. This row first said 84 x 404 and ids that are not jobs; that was a misread column, corrected after run 6 |
| 6 · 2026-11-18 | 01d8457 (the app code of 964378f, the live build; the report prints which id each job-route request carried) | Finished by itself in 83 minutes (scan 2a21cf18…, 160 URLs). High 0 · Medium 0 · Low 2: the contact address on the two legal pages (by design). The first run with Delete account in the app. Signed in all the way: `GET /api/me` answered 200 in every five-minute slot that had a call, 1,998 times. Its 8 x 401 are the scanner's own signed-out probes, all in the first 15 minutes. Of 9,638 requests to signed-in routes, 8,609 (89%) reached a handler, 1,020 (11%) were 429 and 9 were 401. No 5xx, no answer slower than 5 seconds, no error line. The guard stopped: 164 sign-ups · 164 sign-ins that were not the scan user's · 125 Delete account calls (so the scan user was never deleted) · 86 oauth calls · 86 back-outs of the seeded jobs · 85 cancels of the seeded jobs · 80 logouts. It also cut 37 streams. `POST /api/estimate`: 237 x 200, 1,059 x 400, 16 x 404, 140 x 429. The job routes: 1,881 requests, 918 (49%) answered 404. The 1,444 with a UUID all carried a seeded job (0 other ids); their 548 x 404 are GET on 11 routes that only take POST (49 each) and 9 probe paths. The other 437 carried something that is not a UUID (370 x 404). `messages`, `confirm`, `read` and `contacted`: 84 x 403 each; `complete`: 83 x 403. The scan user is neither the poster nor the winner of an awarded job, because the seeded jobs are open |

## What runs

`.github/workflows/hawkscan.yml` (GitHub Actions, about an hour; the scan ends itself after 80 minutes at most):

1. builds the app, loads the captured bids into a throwaway database, and starts `node dist/server.js` in
   accounts mode (`DEMO_MODE=1`, so the Pro routes are scanned too) on port 8787;
2. `scripts/hawkscan-seed.mjs` signs up two TEST accounts (example.com addresses, a password made up for this run
   that is masked in the log the moment it is made and only goes to the job's environment): a scan user that bids
   on the other account's local job;
3. `scripts/hawkscan-spec.py` writes the scan's copy of the spec (next section) and checks it;
4. starts the **scan guard**, `scripts/hawkscan-guard.mjs`, on port 8788. The scanner talks to the guard; the guard
   passes every request on to the app unchanged, except the few that would end the scan's own session or the
   objects the seed made ("What the scan does not test"). It is scaffolding for this job: nothing in `src/` or
   `web/` knows it;
5. installs StackHawk's `hawk` CLI, finds or creates the StackHawk application `bidswipe`, checks the setup
   (`hawk validate config / api / auth`), then runs HawkScan with `stackhawk.yml`: every route in that copy of
   `docs/api/openapi.yaml` (`test/openapi.test.ts` keeps the spec equal to the server's routes), signed in as the
   scan user, with the `x-bidswipe: 1` header the CSRF guard asks for, plus a browser crawl of the app shell.

## Ids and the cost check (after run 4)

Every path id in `docs/api/openapi.yaml` is called `{id}`, and the spec must stay that way (`test/openapi.test.ts`
compares it with the server's `:id` routes). `stackhawk.yml`'s customVariables are keyed by that name; runs 2 to 4
scoped three `id` entries by `path`, the scoping did not take effect, and one value (the other account's id) went
into every `{id}`. So the job routes were attacked with an id that is not a job: the first look-up answered 404 and
the handler behind it was never reached.

`scripts/hawkscan-spec.py` (run after the seed) writes the scan's own copy to `$RUNNER_TEMP/openapi-scan.yaml`, and
`stackhawk.yml` reads it through `SCAN_SPEC` (without it, the repository's spec). In the copy:
- each kind of path id has its own name: the job routes `{jobId}`, the people routes `{personId}`, `/api/bids` and
  `/api/swipe` `{bidRef}`; the customVariables use those names, with no `path` scoping;
- the placeholder ids in the examples are the seed's (its two jobs, the other account, the saved bid);
- `POST /api/estimate` asks for a complete cost request (made-up inputs, TEST labels) on the saved bid, as the body's
  schema and as its example. Checked by hand against a local server: the run 4 shape (the quick form with a made-up
  `bidId`) answers 404 `bid_not_found`; the spec's quick form answers 200 but "incomplete", 13 fields needed and no
  price; the copy's request answers 200 "complete" with a total.

The script checks its own output (every `{name}` in a path has a path parameter of that name, no `{id}` left, no path
lost or doubled, as many operations as the spec) and stops the job with a sentence when a check fails.

Not reachable with real ids either: the people routes answer 404 until a job between the two accounts has closed,
and messages, contact and agreement need an awarded job (the seed cannot wait a day). The numeric ids (`feeId`,
`messageId`, `reportId`) are only in `/api/admin` routes, which answer 401 before any look-up; the seed has no fee,
message or report id to give (a report answers `{"ok":true}` without one). A real job id also reaches
`DELETE /api/jobs/{jobId}/bid`, which withdraws the scan user's bid; `POST` on the same path places it again.

## What the scan does not test

`app.excludePaths` in `stackhawk.yml` did not keep the scanner off the routes it names (run 3; why is not known), so
the guard enforces the list. The app never sees these, and the scan says nothing about them:

| Stopped by the guard | It answers | Why |
|---|---|---|
| `POST /api/auth/logout` | 200 `{"ok":true}` | it ended the scan session (171 times in run 3) |
| `POST /api/auth/signup`, `POST /api/auth/oauth` | 403 `scan_guard` | a success hands the scanner another account's session |
| `POST /api/account/delete` | 403 `scan_guard` | a body with the scan user's password would delete the scan user, its session and the seeded jobs, and every later request would be answered 401. Covered by `test/account-delete.test.ts` (refusals, the count-first limit, the 409s, no row left behind; on Postgres too) and `test/no-5xx.test.ts` (hostile bodies, never a 5xx) |
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
  each path's evidence shortened, with session cookie values and e-mail addresses hidden), how many requests to the
  job routes were answered 404 (mostly 404 = the scanner's job ids do not exist), and what the guard stopped.
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
