# Outside services BidSwipe uses or needs

Researched 2026-11-14 for Ev's two questions: *"what other apis do i need for this app to function and max"*
and *"give me the apis we need to make this work for 1,000 of searches everyday and active in real time
contract alerts"*.

**Short answer:** nothing more is needed for searches or for live alerts inside the app. Searches read our own
database, and outside data comes in once a day. Turning on **phone push** is the biggest step toward real-time
alerts, and it needs no account (`npm run push:keys`). Everything else in group 2 switches on a feature that is
already written (email, social sign-in, a bigger BLS allowance) or still to come (collecting fees, résumé
files, a domain).

How each fact was checked:

- **[search]**: from a web-search summary, or from the text of the official page as shown in a government-law
  search index. Today this machine could not open the vendors' pages themselves: only a short allow-list of
  hosts is reachable, and leg.state.nv.us and geocoding.geo.census.gov were refused. **Check prices on the
  linked page before paying for anything.** Prices change.
- **[repo]**: read in this repository today (code, `.env.example`, `docs/HANDOFF.md`, `docs/DATA-SOURCES.md`).
- **not confirmed**: no source was found. It is a lead to check, not a fact.

No fact here was read directly from an official page today, so no **[read]** tags appear.

---

## 1. In use now: free, nothing to do

| Service | What it does for BidSwipe | Key | Cost | Notes |
|---|---|---|---|---|
| **SAM.gov Contract Opportunities bulk file** | Every open federal notice, nationwide, once a day | No | Free | ~222 MB a day, no daily limit, no key that expires [repo: DATA-SOURCES.md §2] |
| **State and county bid boards** (NGEM, NevadaEPro, QuestCDN, Douglas County) | Nevada public bids | No | Free | Public pages, read politely once a day. Douglas County answers 403 to Vercel's address [repo: HANDOFF.md §1] |
| **USAspending API** | Federal awards: who won and for how much | No | Free | No limit stated on the pages we read [repo: DATA-SOURCES.md] |
| **BLS Public Data API v1** | Wages and material price indexes | No | Free | 25 queries a day without a key. A full refresh uses 15 [repo: .env.example] |
| **Vercel** (Hobby plan) | Hosts the app and runs the daily jobs | Ev's account | $0 | **Hobby is for non-commercial use only.** Up to about 1M function calls and 4 CPU-hours a month [search: [Vercel fair use](https://vercel.com/docs/limits/fair-use-guidelines)]. Move to Pro ($20/month [repo: HANDOFF.md]) **before** BidSwipe charges anyone |
| **Supabase Postgres** (Free plan) | The live database | Ev's account | $0 | 500 MB database, 1 GB file storage, 5 GB egress. Pro is $25/month [search: [Supabase pricing](https://supabase.com/pricing)]. A Free project is paused after a week without activity [search: [Supabase pausing](https://supabase.com/docs/guides/platform/free-project-pausing)]. The daily cron jobs keep it busy, but see §4 |

---

## 2. Needed to switch on a feature (only Ev can sign up: each one asks for his identity, card or both)

| Service | Unlocks | Free tier → price after | Key expires? | Sign-up time | Variables the code reads |
|---|---|---|---|---|---|
| **Web push (VAPID keys)** | Phone and desktop alerts the moment something is found | No account, no cost | Never (keep the private key secret) | 1 minute: `npm run push:keys` [repo: package.json] | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (optional: falls back to `mailto:` + `CONTACT_EMAIL`, then `APP_URL`) [repo: src/context.ts] |
| **Resend** (email) | The daily digest email, and (accounts mode) the "forgot password" link: without this key the sign-in screen says reset by email is not available yet and nothing is sent. Receipts would also go through it, but that code is not written | 3,000 emails a month, 100 a day, free. First paid tier: not confirmed (sources say $20/month for 50,000) [search: [Resend free tier](https://resend.com/blog/new-free-tier), [pricing](https://resend.com/pricing)] | No expiry found (not confirmed) | ~30 min, plus DNS records on a domain you own (so it needs the domain first) | `RESEND_API_KEY`, `DIGEST_FROM`, `DIGEST_TO`, `APP_URL`; `EMAIL_FROM` (the reset link's sender; falls back to `DIGEST_FROM`) [repo: src/server.ts, src/cli/scan.ts, src/notify/email.ts] |
| **Supabase Auth: Google / Microsoft / Apple sign-in** | "Continue with Google" and the others | Included in the Supabase plan (Free plan: 50,000 monthly users [search: [pricing](https://supabase.com/pricing)]). Google and Microsoft: no fee found (not confirmed). **Apple needs the Apple Developer Program: $99 a year** [search: [Apple](https://developer.apple.com/support/compare-memberships)] | Apple's sign-in secret must be renewed regularly (how often: not confirmed) | 1–2 hours for Google and Microsoft. Apple's enrolment can take days (not confirmed) | `SUPABASE_URL`, `SUPABASE_ANON_KEY`. Provider secrets go in the Supabase dashboard, not in our env [repo: .env.example] |
| **BLS API v2 key** | 500 queries a day instead of 25 | Free | **Renew at least once a year** [search: [BLS API FAQ](https://www.bls.gov/developers/api_faqs.htm)] | 5 min at data.bls.gov/registrationEngine | `BLS_API_KEY` [repo: src/market/watcher.ts] |
| **Stripe Connect** (payments) | Collect the marketplace fees, pay the poster's share, Pro subscriptions on the web | No monthly fee. Card payments 2.9% + 30¢ [search: [Stripe pricing](https://stripe.com/pricing)]. Connect where the platform sets the prices: **$2 per month for each account paid out that month, plus 0.25% + 25¢ per payout** [search: [Connect pricing](https://stripe.com/connect/pricing)]. Disputes $15 each (not confirmed) | Keys don't expire. Rotate them if they leak | Account: ~1 hour. Business verification: a few days (not confirmed) | **None yet.** The code does not talk to any payment company (contract rule 8: `paymentsOn: false`) |
| **Supabase Storage** | Résumé files people upload (today a résumé is only a link, `resumeUrl`) | 1 GB on Free. Max file 50 MB (which plan: not confirmed) [search: [pricing](https://supabase.com/pricing)] | Uses the project keys | Already signed up | **None yet** |
| **A domain name** | Our own address instead of bidswipe-tau.vercel.app. Email sending (Resend) and store listings need it | About $10–20 a year for a .com (not confirmed) | Renew yearly | 15 min + DNS (up to a day) | `APP_URL`, `DIGEST_FROM`, `VAPID_SUBJECT` |

### What a marketplace needs from Stripe

Two separate jobs:

1. **Charge a saved card later** (the no-show fee and the 1% service fee). Stripe saves a card with a
   "SetupIntent" and later charges it with `off_session: true`, which means the customer is not there to
   approve it [search: [Save a card and charge it later](https://docs.stripe.com/payments/cards/save-and-reuse)].
   Stripe says the customer must agree to this when the card is saved, so the bid screen's "I agree" step
   would need the card step attached (the exact consent wording is not confirmed). Some banks refuse a charge
   made later without the customer, so some fees will go unpaid.
2. **Pay a share to another user** (the poster's 2%). The usual tool is a "destination charge" with
   `application_fee_amount` (BidSwipe's part) and `transfer_data.destination` (the poster's Stripe account)
   [search: [Destination charges](https://docs.stripe.com/connect/destination-charges)].

**The catch, plainly:** to receive money, the poster must have their own connected Stripe account, and
Stripe has to verify who they are. For a US person that is at least name, date of birth, address, the last 4
digits of their SSN and a bank account, and all 9 digits once volume is high
[search: [identity verification](https://docs.stripe.com/connect/identity-verification),
[SSN requirement](https://support.stripe.com/questions/date-of-birth-and-last-4-digits-of-social-security-number-ssn-requirement-for-us-stripe-accounts),
[required information](https://docs.stripe.com/connect/required-verification-information)].
A homeowner who posted one job to get a light fixed will not want to do that for a $20 share.

**The simpler way:** give the poster their 2% as **BidSwipe credit** (it pays down their own future fees).
Then only BidSwipe receives money. Each poster costs no $2 monthly account fee, needs no identity check and
gets no tax form. Building it would take a credit balance column and a ledger kind, and nothing else
outside the app.

---

## 3. Optional, for "max"

| Service | What for | Price | Notes |
|---|---|---|---|
| **SMS (Twilio)** | Text alerts for people who won't install the app | About **$0.0083 per text** plus carrier fees of about $0.003–0.005 per text. Carrier registration (10DLC): $4.50 or $46 per brand, $15 vetting per campaign, $1.50–10 a month per campaign [search: [Twilio US pricing](https://www.twilio.com/en-us/sms/pricing/us)] | Web push does the same job for free. Registration takes days to weeks (not confirmed) |
| **US Census Geocoder** | Street address → map point, for exact distances | **Free, no key** for single addresses and batches of up to 10,000 [search: [Census Geocoding Services API](https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html)]. The 10,000 figure comes from a 2017 page (not confirmed today) | We deliberately show jobs only at ZIP level (contract rule 10), so this is only needed for private distance math |
| **Nevada contractor licence look-up** | Show "licence checked" on a profile | NSCB has a public search page and **no API or bulk file found** [search: [NSCB License Search](https://app.nvcontractorsboard.com/Clients/NVSCB/Public/ContractorLicenseSearch/LicenseSearchResults.aspx)] | Third-party scrapers exist. Don't use them: our rule is no scraping of pages that don't offer data |
| **California licence look-up (CSLB)** | Same, for California | **Free download** of the licence master list on CSLB's Data Portal, refreshed by CSLB. A paid full file is about $235 (2012-era form) [search: [CSLB Data Portal](https://www.cslb.ca.gov/OnlineServices/DataPortal/ContractorList)] | The cleanest licence data we found. A daily download would fit the scan |
| **Identity / background checks (Checkr)** | "ID verified" badges | From about **$29.99 per report**, plus court fees [search: third-party price lists, e.g. [costbench](https://www.costbench.com/software/background-checks/checkr/). Checkr's own page not seen] | Needs the person's consent under background-check law (not researched). Stripe already verifies identity for anyone who gets paid out |
| **Error monitoring (Sentry)** | Know when the live app breaks | **Free for 1 user, 5,000 errors a month.** Team plan about $26/month [search: [Sentry pricing](https://sentry.io/pricing/)] | Vercel's own logs are enough for now |
| **Apple App Store** | iPhone app | **$99 a year** [search: [Apple](https://developer.apple.com/support/compare-memberships)]. Apple takes **15%** of in-app sales under $1M a year (Small Business Program), otherwise 30% [search: [Small Business Program](https://developer.apple.com/app-store/small-business-program/)] | Pro subscription inside the iOS app must use Apple's in-app purchase. Fees for real-world jobs must **not** (see docs/MARKETPLACE.md §6) |
| **Google Play** | Android app | Registration fee (likely $25 once, not confirmed). From 2026-06-30 (US): a **10%** service fee on the first $1M a year and on subscriptions, plus 5% if Google Play Billing is used (20–25% above $1M) [search: [MacRumors 2026-06-24](https://macrumors.com/2026/06/24/google-play-store-fee-change/)]; the settlement is not yet final, so check the Play Console fee page [search: [Google service fees](https://support.google.com/googleplay/android-developer/answer/10632485)] | Physical services are outside Google's billing [search: [Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738)] |
| **RevenueCat** | One subscription system across Apple, Google and the web | **Free up to $2,500 a month** in tracked revenue, then 1% of all of it [search: [RevenueCat pricing](https://www.revenuecat.com/pricing)] | Worth it only once Pro is sold in both stores |

---

## 4. Why 1,000 searches a day needs no API

A search in BidSwipe (`GET /api/feed`, `/api/next`, `/api/bids/:id`) reads **our own database**. Nothing goes
to SAM.gov, BLS or any board while someone searches. The server pulls outside data once a day (the scan and
the market refresh) and stores it, and every user is served from that one copy [repo: src/routes/feed.ts,
src/scan.ts]. So the number of searches never touches an outside limit or an outside bill.

What it does touch is our own hosting (estimates, labelled as such):

- **1 user, 1,000 searches a day:** ~1,000 function calls and ~1,000 small database reads a day, ~30,000 a
  month. Vercel Hobby allows about 1,000,000 calls a month [search]. Fine.
- **10,000 users:** if each one does 25 things a day (searches, opening cards, the inbox check every minute
  while the app is open: `REALTIME_POLL_MS`, default 60 s [repo: .env.example]), that is 250,000 calls a day,
  about **7.5 million a month**. That is past Hobby's 1M, and Hobby can't be used commercially anyway.
  **Vercel Pro and Supabase Pro (~$45/month together [repo: HANDOFF.md, search]) before that many users.**
  Still no outside API.
- The outside services are the same for 1 user or 10,000: one SAM.gov file a day, about 15 BLS queries a day
  (25 allowed without a key), one USAspending pull a day.

## 5. What "real time" means here

- **A posted local job** is scored for every nearby company the moment it is saved. A good fit raises a
  'match' alert at once (contract §3). An open app sees it within one inbox check, about a minute on Vercel
  (`REALTIME_MODE=poll`). On a server that stays up (`stream`) it shows the same second.
- **A phone that is closed** gets nothing until the push keys are set (group 2, one command). Then it gets a
  push notification within seconds: a jobs request sends the pushes it raised before it answers (on Vercel
  too), and the alert poll settles jobs that closed, so an award reaches the winner at their next poll. **That is the one step that makes alerts truly live**, and it costs
  nothing.
- **Public bids** arrive with the daily scan (13:20 UTC on Vercel [repo: HANDOFF.md]). "Live" for them means
  "the moment the daily scan finds it". Polling the boards more often would not be polite and is not needed:
  boards post bids days or weeks before they close.
- SMS (group 3) only adds text messages for people without the app. It does not make anything faster.
