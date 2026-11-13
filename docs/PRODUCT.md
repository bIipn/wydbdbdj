# BidSwipe — what we're building

**One line:** an app that finds public contracts a trade business can actually win and afford, shows
what they're worth, and pings your phone when a good one drops — with an AI "bot" on the paid plan
that does the paperwork legwork.

Platforms: **iOS App Store, Google Play (Android), and the web.** Working name: BidSwipe.

Status key: ✅ built in v0 · 🟡 partly built · ⬜ planned

---

## 1. Who it's for and why

Small trade contractors (electrical first; then HVAC, plumbing, general) — 2 to 50 people, no
estimator on staff, no time to check a dozen county/state/school/federal bid boards every day.
Today they either pay $1,500–$4,000+/yr for clunky lead services built for big commercial
estimators, or they miss the work entirely.

**Pilot:** L&M Electric (Gardnerville/Minden, NV) — small shop, wants $10K–$50K jobs within ~90 mi,
and the owner won't trust anything he can't see the reasoning for. Every design choice has to pass
"would the owner trust this?"

## 2. How it works (the 30-second version)

1. **Set up once:** trade, home base, how far you'll drive, job sizes you want, and your **spend limit**.
2. **Every morning** the scanner pulls new open bids from public boards and scores each one for you.
3. **Your phone buzzes** for great fits. Open the app → swipe right to save, left to pass.
4. Tap **"Bid on …"** → you go to the agency's own site to bid. We never take or submit bids.
5. **Pro:** the bot reads the bid documents, summarizes them, builds your checklist, tells you what
   similar jobs went for, and drafts the paperwork for you to approve.

## 3. Features

### 3.1 Contracts — the feed ✅
- Sources: Douglas County NV, NV State Public Works (QuestCDN), NGEM (Carson City, Reno-area
  agencies, UNR…), NevadaEPro, SAM.gov (federal). More in `docs/HANDOFF.md` §2.
- **Swipe deck** (Tinder-style) + **Browse list** (Indeed-style, filters: good fits / great only /
  within 30 mi / everything; sort by fit / due soonest / closest) + **Saved** (by deadline).
- Every card: fit score (0–100) with plain-English reasons, where + how far, days left to bid,
  estimated value, requirements (bid bond, prevailing wage, prequalification, licenses).
- Link-out bidding only — no liability, no bid handling.

### 3.2 Price action — the money side of every contract 🟡
*Ev's term. Read as: what a job is worth, what similar jobs actually went for, and what moves your
costs — so you can decide fast whether it's worth bidding and at what price. Confirm/adjust.*
- ✅ **What it's worth:** estimate pulled from the notice ("Engineer's estimate … $81,000").
- ⬜ **What similar jobs went for:** bid results / tabulations / award letters (QuestCDN boards have a
  results page; NV Public Works posts Recommendation to Award letters; NGEM posts results). Show
  "jobs like this were won at $X–$Y, N bidders" and the trend over time.
- ⬜ **Cost swings:** material prices that move electrical bids (copper wire, conduit, steel) with an
  alert when they jump — "copper +8% this month, re-check open quotes". Data source TBD.
- ⬜ **Margin check (Pro):** the bot's rough cost range vs. the estimate → "room" / "tight" / "skip".

### 3.3 Spend limit — never chase work you can't carry ⬜ (🟡 today: soft size range)
- Settings: **max job size**, **max up-front cost** you can float (materials + payroll before the first
  pay app), **bonding capacity**, and optionally a **monthly bid-prep budget** (hours or $).
- Jobs over the limit: **no alerts**, marked "Over your limit" in Browse, and the bot will not prep a
  bid for them. Under-limit jobs that need bonds show the bond math ("5% bid bond ≈ $4,050").
- Today v0 only has a preferred size range in the profile (bigger jobs score lower, with a "sub to the
  GC?" hint). The hard limit + bonding fields are the next step.
- Same spirit for the subscription: **flat monthly price, no surprise charges**; the bot's AI usage is
  capped on our side.

### 3.4 Alerts to your phone ⬜ (🟡 today: daily email digest)
- Push for: new great/good matches (instant on Pro, daily summary on Free), deadline reminders for
  saved bids (3 days / 1 day / morning-of), addendum posted on a saved bid, results posted on a bid
  you bid on, price-action alerts (Pro).
- Quiet hours + per-type toggles. Never alert on over-limit jobs.
- Delivery: web push for the pilot web app, then APNs/FCM in the store apps. Email digest stays.

### 3.5 The bot — AI agent (Pro) ⬜
- **Reads the bid** (ad + documents) → one-screen summary: scope, site, schedule, requirements,
  mandatory meetings, contacts, red flags.
- **Checklist + calendar:** pre-bid meeting, questions deadline, bid due, required forms/bonds.
- **Drafts for approval:** RFI questions, bid cover letter, required forms prefilled from the company
  profile. **Nothing is sent or submitted without the owner tapping approve.**
- **Price help:** pulls price action (3.2) into a suggested range with its reasoning shown.
- **Get-registered helper:** which agencies' vendor lists/portals to join (many $10K–$50K jobs are
  quoted from vendor lists and never posted publicly).
- Runs once per *bid* (shared across users), so free users stay cheap and Pro stays profitable.

## 4. Free vs Pro, and codes

| | Free | Pro (subscription) |
|---|---|---|
| Feed: swipe, browse, saved | ✅ 1 trade, 1 area | ✅ multiple trades/areas |
| Fit score + reasons | ✅ | ✅ |
| Alerts | daily digest | **instant push** + deadline reminders |
| Price action | estimate only | award history, trends, cost-swing alerts |
| Spend limit filtering | ✅ | ✅ + bond math |
| The bot (summaries, checklists, drafts) | — | ✅ |
| Team seats | — | ✅ (later) |

Price: start with one Pro plan, monthly + annual. The price is a guess to test with real users
(competitors charge ~$59–$200+/month); don't hard-code it.

### Codes, free access and "demo mode" — how to do it without getting rejected
- **Pilot now (L&M):** the **web app** runs in demo mode — full Pro features, no billing — behind the
  shared `ACCESS_CODE` (✅ built). Web apps aren't bound by store rules.
- **In the iOS app, do NOT build our own "enter a code to unlock Pro" box.** Apple's guideline 3.1.1
  bars apps from using their own mechanisms (license keys, codes, QR codes…) to unlock features —
  paid features must go through in-app purchase. Apps get rejected for exactly this.
- **Use the stores' own codes instead:** Apple **Offer Codes** give free or discounted subscription
  time for a set period — one-time codes or custom codes (e.g. `LMPILOT`), redeemed in the App Store,
  through a redemption URL, or with Apple's redemption sheet inside the app. (Apple retired the old IAP
  promo codes on March 26, 2026.) Google Play has promo codes for subscriptions too.
- **For specific people (family, pilots, partners):** grant a **RevenueCat promotional entitlement**
  from the dashboard or API — free Pro for a set time, never charges or auto-converts. It's granted on
  our side (admin tool / server), not typed into the app.
- **Web checkout** (Stripe) can sell Pro and redeem our own codes on the web; the app reads the
  account's entitlement after login.

## 5. Platforms & tech plan
- **Now:** Node/TypeScript + Fastify API, Postgres (PGlite → Supabase), vanilla-JS PWA (installable).
- **Accounts:** Supabase Auth; one business profile per account (`profiles` table already exists).
- **Store apps:** wrap the PWA with **Capacitor** (fastest, keeps one codebase) — add native push,
  offline Saved, haptics so it's more than a web wrapper for App Review. Expo rewrite only if needed.
- **Subscriptions:** **RevenueCat** across App Store + Google Play + web (Stripe); entitlements =
  `pro`, `pilot`.
- **Push:** web push (pilot) → APNs/FCM via Capacitor push or a provider.
- **AI:** Claude API with a hard per-account monthly cap; results cached per bid.

## 6. Pilot plan (L&M, demo mode)
1. Deploy v0 on the VPS (PM2 + Caddy), `ACCESS_CODE` for L&M, daily email to the owners.
2. Two weeks of real use → tune `config/lm-electric.json` from their swipes (what they pass on).
3. Add spend limit + bonding fields, deadline reminders, web push.
4. Success = L&M bids at least one job they found in the app, and opens it most mornings.

## 7. Metrics that matter
Daily opens (not downloads) · % of great/good matches saved · bids placed via "Bid on…" ·
jobs won · Free → Pro conversion · alert opt-outs (too noisy?).

## 8. Open questions for Ev
- Is "price action" right as written in 3.2, or did you mean something else?
- Spend limit: which matters most to L&M — job size, up-front cost, or bonding?
- Pro price to test first? Annual discount?
- Final name — check App Store / Google Play / trademark availability before launch.
- Which trades/regions after electrical in Northern Nevada?

---
Sources for the store rules: Apple App Store Review Guidelines §3.1.1
(developer.apple.com/app-store/review/guidelines), Apple "Set up offer codes"
(developer.apple.com/help/app-store-connect), RevenueCat "Promotionals"
(revenuecat.com/docs/dashboard-and-metrics/customer-history/promotionals).
