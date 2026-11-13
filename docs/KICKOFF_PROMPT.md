Paste this as your first message in Claude Code, from the repo root.

---

You're picking up **BidSwipe**, a working v0 I built with Claude in chat. It's a public-bid scanner +
phone swipe app ("Tinder deck + Indeed list" for contracts). The pilot customer is L&M Electric in
Gardnerville, NV; the long-term goal is the App Store and Google Play with thousands of mostly-free users.

Before doing anything, read `CLAUDE.md`, `docs/PRODUCT.md` (what the app is supposed to be),
`README.md` and `docs/HANDOFF.md`, then give me a 5-line summary of the project and the plan so I
know you've got it.

Then work through this in order:

1. **Setup check** — `npm install`, `npm run typecheck`, `npm test` (expect 41 passing), `npm run build`.
   If the repo has no commits yet, commit everything as "Import BidSwipe v0" and push to `origin main`.
2. **First live scan** — this code has never run against the live sites (it was built in a sandbox with
   no internet, from real pages captured 2026-11-11). Run `npm run scan -- --no-notify` and report each
   source as OK (with counts) or FAILED (with the error).
3. **Fix any failing source** using the `/live-scan` skill: save the live page to `test/fixtures/`, update
   the parser, keep every test green. Don't touch login-walled sites, and keep scans polite.
4. **Report back** with: per-source counts, the top 10 bids for L&M with their scores and reasons, and
   anything in the scoring that looks wrong to you. Then stop and wait for me before deploying or
   adding new sources (the next ones are listed in docs/HANDOFF.md §2).

How I work (also in CLAUDE.md):
- Show me the actual code you write in chat as you go — key snippets, not just a description. I read it
  to learn.
- If something breaks, show me the error and the lines involved and let me take a guess before you fix
  it. If I say "run it uninterrupted", skip the guessing, keep going, and leave the code + explanation
  for me to read later.
- Don't pace things out in days — just build. Run the `/verify` skill before calling anything done.
- Never print or commit anything from `.env`.
