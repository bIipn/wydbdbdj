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

**Three kinds of user (since 2026-11-14).** The first screen after sign-up asks "What brings you here?":
- **Find work** — contractors big and small, and solo tradespeople between jobs: public bids that fit their
  trade, plus local jobs people post on BidSwipe.
- **Get work done** — a homeowner, a nanny's employer, a property manager, a business: they post a job and
  let people bid. Only a place and a name; no trades, no work feed, no work alerts.
- **Both** — a shop that also subcontracts out, or anyone who does both.

## 2. How it works (the 30-second version)

1. **Set up once, by taps (about 14 taps, nothing typed):** ✅ built
   1. **Trades** (chips, one or more).
   2. **Where's your shop?** "Use my location" (the point becomes the nearest ZIP and is never stored) or a
      5-digit ZIP, then **how far you'll travel**: 25 / 50 / 100 / 150 / 250 mi.
   3. **Job sizes** (chips: Under $25K … Over $2M, pick several).
   4. **Your paperwork**, Yes / No / Not sure each: Nevada SPWD bidder qualification (asked only for a
      Nevada shop: it is the only state requirement a board marks today), SAM.gov registration, bid and
      performance bonds, prevailing-wage jobs; then federal certifications (Small business, 8(a), HUBZone,
      SDVOSB, WOSB, EDWOSB, or None). Built for both kinds of company: a "Yes" says "you have it" on the
      card, "Not sure" says "check yours", a "No" keeps the bid visible but below the alert line and says
      what it needs. No answer ever hides a bid; answers can change any time in Settings.
   5. **When to ping you:** Only great fits (75+) / Good fits (55+, recommended) / Anything worth a look (35+).
   6. **Business name** (optional; skipped = "My electrical shop"). Spend limits are in Settings.
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
- 🟡 **What similar jobs went for:** federal award prices from USAspending.gov are in (Price check +
  Market, Pro for the full history). State/local bid results (QuestCDN results pages, NV Public Works
  Recommendation to Award letters, NGEM results) are not read yet.
- ✅ **Cost swings (Pro):** BLS material price indexes (copper wire, conduit, switchgear…) and the trade's
  BLS wage, checked once a day (`MARKET_REFRESH_AT`); a new month that moves past the threshold sends a
  price alert ("Conduit and conduit fittings up 2% · Oct 2026 (preliminary) vs Sep 2026"). Indexes, not dollar prices.
- ✅ **Cost check (Pro):** your hours, wage, quotes and markups → a bid price, how it builds up, the cash you
  carry before the owner pays, whether it fits your limits, and every public figure behind it. It never
  guesses: anything it needs and does not have, it asks for.
- **What "underbid" and award alerts mean here:** bids are sealed. Nobody — us included — can see a
  competitor's price before the opening. An award alert is a result posted *after* the fact (who won, for
  how much, from the public record), useful for pricing the next one; it is never a live view of other bids.

### 3.3 Spend limit — never chase work you can't carry ✅ (needs a notice that states a value to bite)
- Settings: **max job size**, **max up-front cost** you can float (materials + payroll before the first
  pay app), **bonding capacity**, and optionally a **monthly bid-prep budget** (hours or $).
- Jobs over the limit: **no alerts**, marked "Over your limit" in Browse, and the bot will not prep a
  bid for them. Under-limit jobs that need bonds show the bond math ("5% bid bond ≈ $4,050").
- Built in v1: max job size, max up-front cash and bonding capacity in onboarding and settings; over-limit
  bids get no alert and an "Over your limit" tag. None of the 111 bids captured so far states a value, so
  on today's boards the limit rarely has anything to stop; the cost check applies the same limits to your price.
- Same spirit for the subscription: **flat monthly price, no surprise charges**; the bot's AI usage is
  capped on our side.

### 3.4 Alerts to your phone 🟡 (inbox + live in-app stream + email digest; web push wired, not yet delivered end to end)
- Push for: new great/good matches (instant on Pro, daily summary on Free), deadline reminders for
  saved bids (3 days / 1 day / morning-of), addendum posted on a saved bid, results posted on a bid
  you bid on, price-action alerts (Pro).
- **What "real time" means:** an alert goes out the moment *our scan* finds a new bid, or the moment the
  daily market refresh finds a new price figure or award. The scan runs once a day by default, so a bid
  posted on a board reaches you up to a day later — not the second the agency posts it. (Today: inbox +
  live in-app stream work; web push is wired but has not been delivered end to end.)
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

### 3.6 Local jobs — the marketplace ✅ (built 2026-11-14; payments off)
Ev's idea: people post a job, others bid on it, and like government contracting the lowest bid gets it.
- **Post:** title, what needs doing, up to 4 trades, ZIP (the public place is city, state, ZIP), an optional
  street address and phone (shown only to the winner after the award), an optional budget ceiling, and how
  long bidding stays open (1, 3, 7 or 14 days). Nearby workers who fit get the normal 'match' alert at once.
- **Bid:** sealed. Only the bidder sees an amount while the job is open; the poster sees a count. Bids can be
  changed or withdrawn free until closing. Bids are placed IN the app (unlike public bids, which link out).
- **Closing:** the lowest bid wins automatically (tie: placed first). The poster and the bidders then see the
  ranked tab, like a public bid opening; only the poster sees who bid.
- **Contact window:** the winner has 7 days to make contact. Contact = the winner's first message in the app,
  the winner's "We've agreed", the poster's "They contacted me" or the poster's "We've agreed" (a phone call alone
  does not count, but either side records it with one tap). A one-sided "We've agreed" tells the other side once,
  so they know to tap it too. Both tap "We've agreed", and later the poster taps "Job done".
- **Fees (Ev: "5–10%, and a very small fee for us"):** a winner who never makes contact or backs out owes a
  **5% no-show fee**, of which **2% of the bid goes to the poster** whose time was wasted and 3% to BidSwipe; an
  agreed job carries a **1% service fee**. A **poster no-show** (no fee, counted on the poster's record as
  unanswered) only when the winner's first message left with at least min(48 h, half the contact window) to go
  and the poster never answered. Every other case where contact was made but the two did not both agree is
  `no_agreement`: no fee, nothing on anyone's record. No fee either when nobody bid. Each is a setting with hard limits (no-show 0–10%, service 0–3%).
  **Payments are off:** fees are recorded on the person's record and never collected; no payment company is
  connected. Before money moves: docs/MARKETPLACE.md §8 (one paid hour on the after-the-fact card fee; ask
  Apple's App Review about in-app purchase) and docs/APIS.md (Stripe Connect; pay the poster's share as credit).
- **Work profile ("like Indeed"):** headline, about, years, skills, experience, licence as typed (not verified
  by BidSwipe), insured, résumé link, what they're looking for. Others see a card with the name and their
  record (jobs posted, won, agreed, no-shows), only once they share a job — never an email, phone or address.
- **Safety valves:** report a job; an operator can remove a job or waive a fee; posting, bidding, messages
  and reports are rate-limited. Licence notices on the post and bid screens (Nevada, California, general).
- **Terms:** web/terms.html (the rules in plain words); web/privacy.html covers the marketplace's data.

## 4. Free vs Pro, and codes

| | Free | Pro (subscription) |
|---|---|---|
| Feed: swipe, browse, saved | ✅ 1 trade, 1 area | ✅ multiple trades/areas |
| Fit score + reasons | ✅ | ✅ |
| Alerts | daily digest | **instant push** + deadline reminders |
| Price action | the notice's estimate, prevailing-wage hint, award count | award history, BLS wages and price trends |
| Cost check (bid price, cash carried, limits) | — (shows what it is, locked) | ✅ |
| Cost settings (saved labor rate, burden, markups) | — | ✅ |
| Price + award watch (daily price and award alerts) | — | ✅ |
| Spend limit filtering | ✅ | ✅ + bond math in the cost check |
| The bot (summaries, checklists, drafts) | — | ✅ |
| Team seats | — | ✅ (later) |

Price: start with one Pro plan, monthly + annual. The price is a guess to test with real users
(competitors charge ~$59–$200+/month); don't hard-code it.

### Codes, free access and "demo mode" — how to do it without getting rejected
- **Pilot now (L&M):** the **web app** runs in demo mode — full Pro features, no billing — behind the
  shared `ACCESS_CODE` (✅ built). Web apps aren't bound by store rules.
- **Our own promo codes (✅ built, web + Microsoft Store builds only):** `PROMO_CODES` on the host
  (`CODE:pro[:maxUses][:expiresISO]`) turns on a quiet "Have a promo code?" box on the Settings plan card
  and `…/?promo=CODE` links (applied right after sign-up and setup). The real codes live only in the
  host's settings, never in the repository; give each a use limit and an expiry (a business name is easy
  to guess). Microsoft Store policy 10.8 allows this for a non-game PC app (`docs/MICROSOFT-STORE.md` §7).
  The iOS build sets `STORE_BUILD = 'ios'`, which hides the box and makes the server refuse redeems.
- **In the iOS app, do NOT show our own "enter a code to unlock Pro" box.** Apple's guideline 3.1.1
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
