---
name: live-scan
description: Run a live BidSwipe scan against the real bid boards and fix any source that fails or returns suspicious results (zero rows, missing dates or titles). Use after deploys, when a source breaks, or when asked to check the sources.
---

1. Make sure nothing else has the embedded database open (stop `npm run dev`), or call
   `POST /api/admin/scan` on the running server instead.
2. Run `npm run scan -- --no-notify` and read the **Sources** table and the `[scan]` log lines
   (`douglascounty: 1 open of 90 rows`, `nevadaepro: 25 of 29 listed (first page only)`,
   `ngem: 46 of 46 listed (pages 3/3)`).
3. For each source that FAILED, returned 0 rows, read fewer bids than the board announces (an NGEM line
   ending in `— stopped: <reason>`), or returned rows with null `dueAt`/empty titles:
   1. Fetch the live page or JSON **once** and save the **raw response** outside the repo (scratch dir or
      `/tmp`), with the scanner's User-Agent (built in `src/app.ts`):
      `curl -sS -A 'BidSwipe/0.1 (daily public-bid check)' -o douglas.html 'https://…'`.
      Never use a browser's "Save as" or copy from DevTools: page JavaScript rewrites these tables
      (status classes, `aria-label`s, in-cell labels, pager links), and a fixture saved that way passes the
      tests while the live source returns nothing — that is what the first live scan (2026-11-13) hit on
      three sources.
   2. Compare its structure with the matching file in `test/fixtures/`: classes, columns, JSON keys, URL.
   3. Show Ev the error and the parser lines involved, and let him guess (unless running uninterrupted).
   4. Update the parser — handle both the old and new shape when practical — and replace the fixture with
      a trimmed copy of the new raw page: verbatim excerpts (drop whole rows/sections, change nothing
      inside what you keep), a comment with the URL + capture date, and every session-token value
      (`__VIEWSTATE`, `__EVENTVALIDATION`, `_csrf`, `javax.faces.ViewState`) replaced by `TRIMMED`.
      If the capture date changes, update `FIXTURES_CAPTURED_AT` in `src/sources/fixtures.ts`.
   5. `npm test` until green.
4. Re-run the scan. Report per-source counts, the top 10 matches for the profile, and anything in the
   scoring that looks off.

NGEM pages 2+ are form postbacks, not links. A postback is only valid with the cookies the page-1 GET
set (`ASP.NET_SessionId`, `__AntiXsrfToken`); without them the board answers with an "An error has
occurred" page (HTTP 200) and files an error report with its administrators. So never POST to NGEM by
hand without the cookie jar of the same session (`curl -c jar` on the GET, `-b jar` on the POST), never
re-send a postback, and prefer letting the source do it: `npm run scan -- --source=ngem --no-notify`.

Rules: one request per page, never retry in a loop, never log in anywhere, never print or commit `.env`.
