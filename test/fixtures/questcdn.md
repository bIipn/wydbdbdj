# QuestCDN fixtures

`questcdn-spwd.json`: NV State Public Works Division (group 1903611), captured 2026-11-11 (see test/helpers.ts).

Captured 2026-11-14, one live request each at 07:01 UTC, raw and untrimmed (each board had one open project):

    curl -A "BidSwipe/0.1 (daily public-bid check)" -H "X-Requested-With: XMLHttpRequest" \
      -H "Referer: https://qcpi.questcdn.com/cdn/posting/?group=<g>&provider=<g>" \
      "https://qcpi.questcdn.com/cdn/browse_posting/?group=<g>&provider=<g>&search_id=&postings_since_last_login=&draw=1&start=0&length=100"

| File | group = provider | Owner (as the JSON names it) | recordsTotal |
|---|---|---|---|
| questcdn-nvparks.json | 8011805 | State of Nevada - Nevada Division of State Parks | 1 |
| questcdn-lakecounty.json | 7484192 | Lake County, CA | 1 |
| questcdn-campbell.json | 5618062 | City of Campbell | 1 |
| questcdn-glendora.json | 5645931 | Glendora CA, City of | 1 |

The ids come from the boards' public posting pages (qcpi.questcdn.com/cdn/posting/?group=…&provider=…) found by
web search. Checked the same way the same morning and answered `recordsTotal: 0` (not added): Roseville CA 7637,
Dixon CA 7259977, City of Orange CA 5653602, San Gabriel CA 6229169, Denver 842700, Boulder County 814582.
No session tokens in these answers.

**robots.txt (read 2026-11-14, after these captures, with the scanner's User-Agent).** qcpi.questcdn.com/robots.txt
answers 302 to https://www.questcdn.com/robots.txt/, which says for every client `User-agent: *` / `Disallow: /quest/`
/ `Disallow: /questcdn/` / `Disallow: /` (then Allow only /about, /solicitors, /bidders, /online-bidding, /news).
The four boards above are therefore OFF (`QUEST_BOARDS_OFF` in src/sources/questcdn.ts): the fixtures stay as parser
tests, the scan never asks for those boards, and no further request was made to them. The pilot's NV Public Works
board (1903611) is on the same host and still runs until the owner decides.
