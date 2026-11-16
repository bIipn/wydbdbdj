# Security scan (HawkScan)

**Status (2026-11-16): the second run finished on the fixed code with 0 High, 0 Medium and 2 Low findings**
(one check, two paths). A third run was asked for the same day, only to show route by route that the scanner was
signed in (see "Runs" below): until it is read, "clean" means "no finding", not yet "every signed-in route was
attacked".

## Runs

| Run | Commit | What happened |
|---|---|---|
| 1 · 2026-11-16 17:54 UTC | f540e84 (before the fixes) | Cut off by the job's 60-minute limit with nothing to read: the progress was silenced and the artifact host is not reachable from Claude's sessions. Probably the cost-check crash below, which froze the server on a fuzzed end date (not confirmed) |
| 2 · 2026-11-16 21:35 UTC | cb979c2 (the fixes; the build that is live) | Finished by itself in 61 minutes. **High 0 · Medium 0 · Low 2.** The one check: "Information Leak - Email Address" on `/privacy.html` and `/terms.html`. That is the public contact address the owner put there on purpose: **by design, nothing to fix.** The server answered 28,777 requests: no 5xx at all, none slower than 5 seconds, health 200 at the end, 514 answers were 429 (the new limits at work) |
| 3 · 2026-11-16 | same app code | Asked for because 13,533 of run 2's answers were 401 and the log could not say which routes they were. 14 of the 64 API paths (admin and cron) answer 401 on purpose, since the scan has neither token, but that alone was not shown to explain the number. This run prints the scan user's session over time and a table of route by status (`scripts/hawkscan-report.py`) |

## What runs

`.github/workflows/hawkscan.yml` (GitHub Actions, about an hour; the scan ends itself after 80 minutes at most):

1. builds the app, loads the captured bids into a throwaway database, and starts `node dist/server.js` in
   accounts mode (`DEMO_MODE=1`, so the Pro routes are scanned too) on port 8787;
2. `scripts/hawkscan-seed.mjs` signs up two TEST accounts (example.com addresses, a password made up for this run
   that only goes to the job's environment): a scan user that bids on the other account's local job;
3. installs StackHawk's `hawk` CLI, finds or creates the StackHawk application `bidswipe`, checks the setup
   (`hawk validate config / api / auth`), then runs HawkScan with `stackhawk.yml`: every route in
   `docs/api/openapi.yaml` (`test/openapi.test.ts` keeps that spec equal to the server's routes), signed in as the
   scan user, with the `x-bidswipe: 1` header the CSRF guard asks for, plus a browser crawl of the app shell.

Left out on purpose: sign-out, sign-in and sign-up (they would end the scan's own session), the live stream
(it never ends), cancelling or backing out of a job, undoing a swipe.

## Asking for a scan

Either change `.github/hawkscan-run` (any edit, e.g. the date) and push to `main` or a `claude/...` branch, or open
**Actions > HawkScan > Run workflow**. Ordinary pushes never start a scan.

## Results

- The run's **Summary** and its log: each finding with severity, check name and path, then what the server saw:
  the answers by status, the scan user's session over time, and a table of route by status
  (`scripts/hawkscan-report.py`; it prints no cookie, password or request body).
- The **hawkscan-results** artifact: the full JSON and the server log.
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
