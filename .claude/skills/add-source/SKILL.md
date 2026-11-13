---
name: add-source
description: Add a new public bid board to BidSwipe (a school district, city, county, utility, or QuestCDN board) with a captured fixture and tests. Use when asked to add, cover, or scrape a new agency, portal, or bid site.
---

Target: $ARGUMENTS

1. **Allowed?** Public pages only, no login. Never PlanHub, BuildingConnected, ConstructConnect or Dodge.
   If it's a QuestCDN board: add an entry to `QUEST_BOARDS` in `src/sources/questcdn.ts` (group/provider
   are in the board URL), then skip to step 6.
2. **Find the open-bids list.** Prefer, in order: an official API or the JSON call the page itself makes
   → a server-rendered HTML table → RSS. If rows only appear after JavaScript runs, find the JSON request
   behind them rather than scraping rendered HTML.
3. **Capture a fixture:** save a real response to `test/fixtures/<id>-<what>.html|json`, trimmed to
   ~5–10 rows with the markup unchanged, plus a comment with the URL and capture date.
4. **Write `src/sources/<id>.ts`**, modeled on `douglascounty.ts` / `ngem.ts`:
   - export a pure `parse<Name>(input): BidDraft[]` — no network, no `Date.now()`
   - map cells by header/label, not position, where the markup allows
   - dates through `util/time.ts` (`parseUsDateTime`, `findDueInText`) — boards use Pacific wall-clock time
   - `findEstimate` (util/money.ts) and `detectFlags` (util/flags.ts) on ad text
   - a `sourceId` that stays stable across addenda; `url` = where a contractor goes to bid
   - export a `Source` whose `fetch()` uses `ctx.http` (polite User-Agent + per-host delay built in)
5. **Register it:** add the id to `SourceId` in `src/types.ts` and to `ALL_SOURCES` in
   `src/sources/index.ts`. If the agency name doesn't reveal where it works, add it to `AGENCY_PLACES`
   in `src/geo/places.ts`.
6. **Tests** in `test/sources.test.ts`: row count, one fully checked bid (title, agency, dueAt ISO, url,
   location), and each quirk you handled.
7. **Live check:** `npm run scan -- --source=<id> --no-notify`; show the counts and top matches.
8. Run `/verify`, then update the source tables in `README.md` and `docs/HANDOFF.md` §2.

Show Ev the parser code you wrote, in chat.
