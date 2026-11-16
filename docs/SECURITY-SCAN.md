# Security scan (HawkScan)

**Status: set up, not run yet.** Nothing here has run on GitHub. The first run will show what still needs
fixing in the setup (the hawk CLI's answers, the login check). Until it has run, no result says the app is secure.

## What runs

`.github/workflows/hawkscan.yml` (GitHub Actions, about 15 to 40 minutes):

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

- The run's **Summary** and its log: each finding with severity, check name, count and path.
- The **hawkscan-results** artifact: the full JSON and the server log.
- The StackHawk app (link in the summary), application `bidswipe`, environment `Development`.

A run ends green with a notice when it finds something at Medium or above: those get fixed and a scan is asked
for again. It ends red only when the scan could not run.

## The one owner step

Add the StackHawk API key as a repository secret named `HAWK_API_KEY`:
https://github.com/bIipn/wydbdbdj/settings/secrets/actions (New repository secret). Without it the workflow
prints one line saying so and stops, green.
