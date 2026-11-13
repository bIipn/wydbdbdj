---
name: verify
description: Run BidSwipe's checks (typecheck, tests, build) and report the result. Use before every commit and before saying any code change is done.
---

Run these in order and stop at the first failure:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`

All green → reply with one line: `✅ typecheck · <N> tests · build`.

Something failed →
- Show the exact error output and the code involved (`file:line` plus the snippet).
- Unless Ev said to run uninterrupted, ask him to take a guess at the cause before you fix it.
- Fix it, then run this skill again from step 1.

Changes that only touch Markdown docs don't need this.
