---
name: live-scan
description: Run a live BidSwipe scan against the real bid boards and fix any source that fails or returns suspicious results (zero rows, missing dates or titles). Use after deploys, when a source breaks, or when asked to check the sources.
---

1. Make sure nothing else has the embedded database open (stop `npm run dev`), or call
   `POST /api/admin/scan` on the running server instead.
2. Run `npm run scan -- --no-notify` and read the **Sources** table.
3. For each source that FAILED, returned 0 rows, or returned rows with null `dueAt`/empty titles:
   1. Fetch the live page or JSON **once** (same User-Agent as `src/util/http.ts`) and save it to `/tmp`.
   2. Compare its structure with the matching file in `test/fixtures/`: classes, columns, JSON keys, URL.
   3. Show Ev the error and the parser lines involved, and let him guess (unless running uninterrupted).
   4. Update the parser — handle both the old and new shape when practical — and replace the fixture with
      a trimmed copy of the new page (keep the URL + capture-date comment).
   5. `npm test` until green.
4. Re-run the scan. Report per-source counts, the top 10 matches for the profile, and anything in the
   scoring that looks off.

Rules: one request per page, never retry in a loop, never log in anywhere, never print or commit `.env`.
