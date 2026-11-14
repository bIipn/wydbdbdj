# QuestCDN fixtures

`questcdn-spwd.json`: NV State Public Works Division (group 1903611), captured 2026-11-11 (see test/helpers.ts).

Added 2026-11-14, one live request each at 07:01 UTC, raw and untrimmed (each board had one open project):

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
No session tokens in these answers. qcpi.questcdn.com/robots.txt answers 302 to https://www.questcdn.com/robots.txt/,
which the outbound proxy here refused to open (2026-11-14): not read.
