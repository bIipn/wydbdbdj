# BidSwipe in the Microsoft Store

For Ev. Everything here was checked against Microsoft's own pages on **2026-11-16** (Store Policies 7.20, effective
2026-10-22); links are at each step. "Checked" means the store research pass read and quoted those pages that day;
what nobody could check (Partner Center screens behind your sign-in, the age-rating questionnaire, PWABuilder's
service) is marked **not checked**. Only you can do the account and submission steps: they need your Microsoft sign-in.

## What you still have to click

1. ~~Deploy this version~~ **Done 2026-11-16** (commit cb979c2). Checked on the live site: `/privacy.html` and
   `/terms.html` show `3verettholt@gmail.com` and November 16, 2026; the manifest has the five shortcuts.
2. **Decide the domain** (risk 1 below). If you move to your own domain, do it now: the package bakes in its start address.
3. ~~Rebuild the package~~ **Done 2026-11-16** from the live manifest: `BidSwipe-store.zip`, sent to you in the chat
   (version 1.0.1.0, classic 1.0.0.0, your three identity values, start address `https://bidswipe-tau.vercel.app/`).
   Upload the two bundles inside it. The package you built earlier on pwabuilder.com came from the OLD manifest: do
   not upload that one; if it is already in a draft submission, remove it there first. To build it again later:
   `node scripts/store-package.mjs` (section 3).
4. **Decide how you read reports** (policy 11.12): nothing alerts you when one arrives; see section 4.
5. ~~Make the two reviewer accounts~~ **Made 2026-11-18** on the live site by Claude, as section 4 describes: a Poster
   ("Get work done") and a Bidder ("Find work", Electrical, Pro turned on with the admin route), ZIP 89410, and the job
   "Store review job: replace a light fixture" with one sealed bid. Bids close 2026-11-19 19:20 UTC; then Claude makes
   the award happen and sends one message each way, and leaves the job in its contact window, which ends 2026-11-26
   19:20 UTC: **submit by about Nov 21**. The e-mails, passwords and the filled-in notes are in a private file given
   to the owner; they are never in this repository.
6. In Partner Center open BidSwipe → **Start your submission** and fill in: Pricing and availability, Properties,
   Age ratings, Packages, Store listing (text and the 8 screenshots below), Notes for certification.
7. **Submit for certification.**

---

## 0. Where things stand (2026-11-16)

| Needed | Status |
|---|---|
| Developer account and the reserved name "BidSwipe" | **Done by you.** |
| Product identity | Package ID `bidswipe.bidswipe` · Publisher ID `CN=6A3385ED-1658-4BBF-A229-10E7AD5417AE` · Publisher display name `bidswipe` (none of the three is secret) |
| The app live on HTTPS | `https://bidswipe-tau.vercel.app` (production runs commit cb979c2 since 2026-11-16 21:35 UTC: this version) |
| Accounts mode, poll mode, `CRON_SECRET` | As today: `AUTH_MODE=accounts`; with `VERCEL` set the app polls for alerts about once a minute; `CRON_SECRET` runs the daily jobs |
| Privacy policy | `web/privacy.html`: contact `3verettholt@gmail.com`, Vercel (hosting) and Supabase (database) named, "Use my location", 18+, deletion by email, reports. Effective November 16, 2026 |
| Terms and community rules | `web/terms.html`: retitled, contact address, community rules and how to report a job, a conversation or a profile |
| Reporting (policy 11.12) | Live since 2026-11-16: report a job (job page), a conversation (Messages and the job page), a profile (under the card); operators can remove a message and hide a profile. There is no block or mute |
| Manifest | Updated: description covers public bids and local jobs, shortcuts Home · Search · Saved · Jobs · Alerts, `launch_handler`, four new screenshots |
| Store screenshots | `docs/store/screenshots/01…08` (1920×1080) with captions in `docs/store/captions.md` |
| Package | **Rebuilt 2026-11-16** from the live manifest (`node scripts/store-package.mjs`); its identity, versions and start address were read back out of the bundles |
| Two reviewer accounts with an awarded job | **Made 2026-11-18**; the award and the thread follow on 2026-11-19 (step 5 above) |

## 1. The account and the name

They exist. The three identity values above go into the package. If Partner Center ever shows different values under
**Product management → Product identity**, Partner Center wins: use its values.

## 2. Two risks, stated plainly

**Risk 1: the vercel.app address (policy 10.1.1).** The policy: *"Products submitted as web apps must be published by
the domain or website owner."* `bidswipe-tau.vercel.app` is a subdomain of Vercel's domain, not yours. A reviewer may
apply that line and fail the submission. Nothing we found says vercel.app addresses are accepted. The fix is a domain you
own pointed at the Vercel deployment, then the package built from that address: *"PWAs that are installed from the
Microsoft Store have a hard-coded start URL"* (Edge PWA guide), so moving later means a new package and a new submission,
and installed copies keep the old address. You can also submit on vercel.app and see what certification says; that is
your call.

**Risk 2: the account type (policy 10.14).** The policy: *"Company accounts must be used for organizations, businesses,
and any person acting in relation to their trade or profession ... A company account is required if ... a reasonable
consumer would interpret your application or publisher name to be that of a business entity."* BidSwipe is a business
tool. If your account was opened as **Individual**, Microsoft can enforce this later, and *"you can't change an
Individual account to a Company account"* (prepare-developer-account). A Company account needs a D-U-N-S number or
business documents and *"a work email address on your organization's domain"* (Gmail is not accepted), and it must show
a support contact on the product page. We do not know which type you chose: check **Account settings** in Partner Center.

## 3. Rebuild the package

Either way the result is a `.zip` with an **`.msixbundle`** and a **`.classic.appxbundle`**; upload both.

**A. You, on pwabuilder.com (the supported route).**
1. Go to **https://www.pwabuilder.com**, enter `https://bidswipe-tau.vercel.app` (or your own domain), click **Start**.
   The report card should show the new manifest (description, five shortcuts, four screenshots, launch_handler).
2. **Package for stores → Windows → Generate package.**
3. Package ID `bidswipe.bidswipe`, Publisher ID `CN=6A3385ED-1658-4BBF-A229-10E7AD5417AE`, Publisher display name
   `bidswipe`. App name "BidSwipe". **App version `1.0.1`, classic package version `1.0.0`**: PWABuilder refuses a classic
   version that is not lower (*"App version must be greater than classic package version"*). Each later upload needs a
   higher version.
4. **Download package.** The zip also has a test package you can install on your own PC first.

**B. `node scripts/store-package.mjs` (how the 2026-11-16 package was built).** pwabuilder.com itself POSTs this
JSON to `https://pwabuilder-windows-docker.azurewebsites.net/msix/generatezip` and gets the zip back (read from
PWABuilder's source, `src/script/utils/environment.ts` and `services/publish/windows-publish.ts`). The script reads
the live manifest, sends the same JSON and writes `out/store/BidSwipe-store.zip`; `--version`, `--classic` and
`--url` change the versions and the address. Called on 2026-11-16 (the owner allowed the host for Claude's sessions):
it answered in 14 seconds with a 7.8 MB zip holding `BidSwipe.msixbundle`, `BidSwipe.classic.appxbundle` and a
`BidSwipe.sideload.msix` with `install.ps1` for trying it on your own PC. Read back out of the bundles: Name
`bidswipe.bidswipe`, Publisher `CN=6A3385ED-1658-4BBF-A229-10E7AD5417AE`, display name `bidswipe`, versions
1.0.1.0 and 1.0.0.0, start address `https://bidswipe-tau.vercel.app/`. The JSON:

```json
{
 "name": "BidSwipe",
 "packageId": "bidswipe.bidswipe",
 "url": "https://bidswipe-tau.vercel.app/",
 "version": "1.0.1",
 "allowSigning": true,
 "publisher": {
  "displayName": "bidswipe",
  "commonName": "CN=6A3385ED-1658-4BBF-A229-10E7AD5417AE"
 },
 "generateModernPackage": true,
 "classicPackage": {
  "generate": true,
  "version": "1.0.0",
  "url": "https://bidswipe-tau.vercel.app/"
 },
 "edgeHtmlPackage": {
  "generate": false
 },
 "manifestUrl": "https://bidswipe-tau.vercel.app/manifest.webmanifest",
 "manifest": "<the live manifest.webmanifest, as JSON, after this version is deployed>",
 "images": {
  "baseImage": "https://bidswipe-tau.vercel.app/icons/icon-512.png",
  "backgroundColor": "transparent",
  "padding": 0
 },
 "resourceLanguage": "en-us"
}
```

Change `url`, `classicPackage.url`, `manifestUrl` and `baseImage` if you move to your own domain.

Before packaging, the manifest must be the deployed one (step 1 at the top). Any later manifest change needs a new
package and a new submission (Edge PWA guide: *"if you make changes to the web app manifest file, you must create a new
app package"*).

Icons: PWABuilder builds every Windows tile from the manifest; all 24 icon files exist at the sizes they claim. To redraw
them after changing `web/icon.svg`: `NODE_PATH=$(npm root -g) node scripts/make-icons.cjs`.

## 4. The submission (Partner Center → BidSwipe → Start your submission)

### Pricing and availability
- **Free.** Markets: **United States** only (the bid boards are US public agencies).
- Visibility: you can start with **Private audience** and go public in a later submission.

### Properties
- Category: **Business**. Secondary: **Productivity**.
- Privacy policy URL: `https://bidswipe-tau.vercel.app/privacy.html` (policy 10.5.1).
- Website: `https://bidswipe-tau.vercel.app`.
- **Support contact: `3verettholt@gmail.com`** (the same address as the privacy and terms pages).
- Product declarations: nothing special. No in-app purchases, no third-party purchase API (nothing is sold), no
  generative AI.

### Age ratings (IARC questionnaire)
Microsoft's page says the first question asks *"the category that best describes your app"*; the follow-ups depend on
it. **Not checked:** the live questions (they exist only inside Partner Center). The wording below is IARC's usual
wording: read each question before answering. Category: an app that is not a game (utility / productivity / reference;
not social networking, not shopping).

| Question (wording varies) | Answer | Why |
|---|---|---|
| Violence, fear, sexual content, nudity, crude humour, profanity, discrimination | **No** | Public agency bid text; job posts are user text behind sign-in, under the community rules |
| Drugs, alcohol, tobacco, gambling, simulated gambling | **No** | |
| Users can interact or exchange content with each other | **Yes** | Job posts, sealed bids, work profiles shown to posters, and messages between a poster and the winning bidder |
| App shares the user's location with other users | **Yes** (conservative) | A job's town, state and ZIP are seen by everyone signed in; the poster's street address goes to the winner. The home ZIP of a business profile is never shown. No device location is shared |
| Digital purchases | **No** | Nothing is sold. Fees are recorded, not collected. Promo codes are not purchases |
| Unrestricted internet / web browser | **No** | Agency links open in the browser; the app is not a browser |
| Collects or shares personal information | **Yes**, if asked | Email, name, business profile, work profile, messages |

Expected result: the lowest content rating in most systems, with the interactive elements "Users Interact" (and
probably "Shares Location") shown beside it. Some regions may rate higher when users can talk to each other (not
checked against IARC's own pages). The terms require users to be 18 or older; that is a terms rule, not the rating.
After the rating is issued, its ID can go into the manifest's `iarc_rating_id` (optional; a new package then).

### Packages
Upload the **`.msixbundle`** and the **`.classic.appxbundle`** from section 3.

### Store listing (English, United States): ready to paste

Counts below are Python `len()` on the exact text, run 2026-11-16.

**Description** (3,681 of 10,000 characters; plain text, no URLs):

```
BidSwipe finds open public bids that fit your trade and tells you why, and it is a place to post local jobs and bid on them.

Public bids
Once a day BidSwipe reads public bid boards (cities, counties, school districts, state purchasing sites and federal SAM.gov notices) and scores each open bid for your business. Each card says in plain words why it fits or where it falls short: your trade's words in the scope, how far the job is from your home base, the job size, the days left to bid and the paperwork it asks for, such as bonding, prevailing wage or a state registration.

Home shows your best matches as a list you scroll or as a deck you swipe: right to save, left to pass. Search holds every open bid that fits, with filters and sorting, and Saved keeps the ones you want to work on. When a bid is worth it, one tap opens the agency's own page. You bid there, directly with the agency: BidSwipe never takes a public bid and never sees your price.

Local jobs
People and businesses can post a job in BidSwipe, and others place a sealed bid on it in the app. While bidding is open only you see your amount; the poster sees how many bids there are. When bidding closes, the lowest bid wins (on a tie, the bid placed first). The winner then has 7 days to make contact with the poster. You can post jobs, bid on jobs, or both.

Messages
After the award, and only then, the poster and the winner can message each other in the app, under Messages or on the job's page. No other user sees their messages. The winner also sees the address and phone the poster chose to add.

Work profiles
A short card about you or your business: a headline, your experience, your skills, a licence as you typed it and a résumé link. The poster sees it after bidding closes, when the bids are no longer sealed. BidSwipe does not check licences or insurance, and your email, phone and address are never on the card.

Reporting
You can report a job, a conversation or a profile from its screen. Reports go to BidSwipe, which can take down a job, remove a message or hide a profile. The terms and community rules are linked from the sign-in screen and from Settings.

Fees
The terms for local jobs set a no-show fee and a service fee. Fees are not being collected: BidSwipe only records them, and the exact figures are shown before you bid. Nothing is sold in the app.

Alerts
An in-app inbox with new matches, reminders before the bids you saved are due, and news on the local jobs you posted or bid on.

Market
A small price pill at the top of the screen shows one government figure at a time: a construction material's monthly price index with its one-month change, or the area wage for your trade. Tap it to open Market, with the monthly price indexes from the U.S. Bureau of Labor Statistics and wage figures for the trades. They are government indexes, not prices for your job.

BidSwipe Pro
Some features are part of BidSwipe Pro: phone and desktop notifications, a cost check for a bid, your own cost settings, award history from federal records, and alerts when an award is posted on a bid you saved or a price index moves. Award results are public records published after the bids are opened, never a competitor's price before. Pro is not sold in the app today.

Sealed means sealed: on a public bid nobody, BidSwipe included, sees a competitor's price before the agency opens the bids, and on a local job nobody sees another bid's amount before bidding closes. A score is a first pass. Always read the bid documents before you price a job.

You need a free BidSwipe account. Setup takes about a minute: pick your trade, enter your ZIP, choose how far you travel and the job sizes you want.
```

**Short description** (180 of 1,000; under the 270 shown in some views):

```
Public bids that fit your trade, each with the reasons it fits, on a list or one swipe at a time. Or post a local job: others place a sealed bid in the app and the lowest bid wins.
```

**Product features** (18 of 20; each at most 200 characters; no bullets, the Store adds them;
lengths in order: 76 · 87 · 86 · 57 · 70 · 101 · 77 · 88 · 92 · 75 · 103 · 99 · 63 · 69 · 75 · 115 · 83 · 85):

```
Open public bids scored for your trade, your area and the job sizes you want
Plain-English reasons on every card: scope, distance, job size, days left and paperwork
Scroll your matches as a list or swipe them one at a time: right to save, left to pass
Search every open bid that fits, with filters and sorting
One tap to the agency's own bid page: you bid directly with the agency
Bids from city, county, school district and state boards and federal SAM.gov notices, read once a day
In-app alerts for new matches and reminders before the bids you saved are due
A price pill with one government price index or wage figure at a time; tap it for Market
Post a local job and receive sealed bids in the app; the lowest bid wins when bidding closes
Bid on local jobs near you; while bidding is open, only you see your amount
The winner has 7 days to make contact; after the award the poster and the winner can message in the app
Work profiles: headline, experience, skills and a licence as you typed it (not checked by BidSwipe)
Your email, phone and address never appear on your work profile
Report a job, a conversation or a profile to BidSwipe from its screen
Nothing is sold in the app; local job fees are only recorded, not collected
BidSwipe Pro (not sold in the app today) adds notifications, a cost check, award history and award and price alerts
Setup in about a minute: pick your trade, enter your ZIP, choose how far you travel
The same account works in the Windows app and in any browser, on a phone or a desktop
```

**Keywords** (7 of 7; each at most 30 characters, which fits both the 40-character form and the
submission API's 30; 15 words of the 21 allowed; policy 10.1.3: no prices, no other
products' names): public bids (11) · government contracts (20) · construction bids (17) · contractor jobs (15) · bid alerts (10) · public works (12) · local job bids (14)

```
public bids
government contracts
construction bids
contractor jobs
bid alerts
public works
local job bids
```

**Copyright**: `© 2026 <your name or company, as registered>`.

**Before pasting, check:** "7 days" is the `JOB_CONTACT_DAYS` default; if the host sets another value, change every
mention. Reporting of conversations and profiles must be deployed before the listing says so.

**Screenshots**: the 8 files in `docs/store/screenshots/` (1920×1080 PNG; the Store wants 1366×768 or larger, at most
10, captions up to 200 characters, critical content in the top three quarters, no added logos or marketing text). The
captions are in `docs/store/captions.md`:

| File | Caption | Characters |
|---|---|---|
| `01-home-swipe.png` | Each open public bid is scored for your trade, area and job size, with the reasons in plain words. Swipe right to save, left to pass. | 133 |
| `02-home-scroll.png` | Home: your best matches as a list, or one at a time. The pill at the top shows one government price index at a time. | 116 |
| `03-bid-details.png` | A bid's details and the reasons it fits. One tap opens the agency's own page: you bid there, directly with the agency. | 118 |
| `04-search.png` | Search: every open public bid that fits, with filters and sorting. | 66 |
| `05-jobs.png` | Example job shown. Local jobs: post work and receive sealed bids in the app. Amounts stay sealed until bidding closes. | 118 |
| `06-job-awarded.png` | Example job shown. When bidding closes the lowest bid wins, and the winner has 7 days to make contact. | 102 |
| `07-conversation.png` | Example job shown. After the award the poster and the winner can message in the app, and either one can report the conversation. | 128 |
| `08-market.png` | Market: monthly government price indexes for materials and wages for the trades, with their changes. Indexes, not prices for your job. | 134 |

How they were taken: shots 01 to 04 and 08 come from a fresh account whose business name is "Your company"
(Gardnerville, NV), on a copy of the real 2026-11-14 scan and the real BLS captures; nothing on the page was edited and
the pilot's name appears nowhere. Shots 05 to 07 use example accounts ("Alex (example)", "Example Electric", "Example
Lighting Co.") and jobs titled "Example job: …", with the address "123 Example St" and a 555 phone number (neither is
visible in the shots); their captions say "Example job shown". To close the example job, the local server's clock was
moved forward one day. No cost-check result is shown (Pro is not sold). Shot 07 shows three whole messages and the
"Report this conversation" link (an earlier take with the report form open was replaced: its help line has since
changed, and it showed two Send buttons).

**Store logos**: optional; the package logos are used if you upload none.

### Submission options → Notes for certification

Make the two accounts first, on the live site, with addresses you control (Microsoft asks for *"a working demo
account"*, policy 10.3.1; one account cannot show the award or the messages):

1. **Poster**: sign up, choose **"Get work done"**, enter a ZIP (for example 89410), finish.
2. **Bidder**: in another browser (or a private window), sign up, choose **"Find work"**, pick **Electrical**, the same
   ZIP, finish. A "Get work done" account cannot bid.
3. As the poster: **Jobs → Post a job**, trade Electrical, the same ZIP, bids open for **1 day**. Use a title that says
   it is a test, for example "Store review job: replace a light fixture". Address and phone are optional.
4. As the bidder: open that job (Home or Search, LOCAL JOB tag) and place a bid.
5. After it closes (a day later; the award happens the next time either of you opens the app), as the bidder send a
   message in the job's thread; as the poster, answer it. Leave the job there (do not tap "We've agreed"), so the
   reviewer sees the contact window and the thread.

Then paste this, with the placeholders filled in:

```
BidSwipe needs a free account. Two test accounts are ready, with setup finished (home ZIP <zip>):
- Poster: <poster email> / <password>
- Bidder: <bidder email> / <password>

The Poster posted a local job, "<job title>"; the Bidder bid on it and won when bidding closed. Sign in as either
account and open Jobs, then that job, to see the award, the contact window and the message thread between them.
Messages are also under the Messages tab. Messages, the street address and the phone are visible only to the poster
and the winner, and only after the award. Please do not cancel that job or tap "We've agreed": it is what shows the
award, the contact window and the thread. Both accounts show times in Pacific time (their time zone setting).

Public bids come from public agency bid boards (cities, counties, states, and federal SAM.gov notices), read once a
day. A "Bid on ..." button opens the agency's own website, where the contractor bids directly; BidSwipe never takes a
public bid.

Local jobs: bids are sealed until closing and the lowest bid wins. The terms (linked from the sign-in screen and from
Settings, and at https://bidswipe-tau.vercel.app/terms.html) set a no-show fee and a service fee. These are only
recorded: the app has no payment code, collects no payment or card details, and has no in-app purchases.

User content: on a job someone else posted, "Report this job" is at the bottom of the job page. In a conversation,
"Report this conversation" is in Messages and under the messages on the job page (poster and winner only). On a
profile card, "Report this profile" is under the card. Reports go to BidSwipe <the routine you decide, e.g.: and are
read every day>; an operator can take down a job, remove a message or hide a profile. Posting, bidding, messaging and reporting are rate-limited per
account. The terms and community rules and the privacy policy are linked from the sign-in screen and from Settings.

Pro features (cost check, award history, award and price alerts, notifications) are not sold. <Optional: To see them,
enter the code <reviewer-only code> in Settings > Plan > "Have a promo code?". It unlocks Pro for this account only.>

"Use my location" during setup asks the browser for permission, is used once to find the nearest ZIP, and is not
stored. No generative AI is used.

Support: 3verettholt@gmail.com
```

The optional reviewer code: add it only to the host's `PROMO_CODES` as `CODE:pro:3:<date 30 days out>` and only in
these notes, never in the repository. The notes do not promise who reads reports or how fast: nothing in the app
tells anyone when a report arrives (each one writes a line `jobs: a conversation was reported (…)` to the server log,
and the list is `GET /api/admin/jobs/reports` with the admin token). Decide a routine (for example: open that list
every morning) and write it in the placeholder above; only then may the app or the listing say "a person reads every
report" (review 2026-11-16: the copy now says only that reports go to BidSwipe).

Then **Submit for certification**.

## 5. How long it takes

- Microsoft: certification *"can take up to three business days"* ([Get started](https://learn.microsoft.com/windows/apps/publish/get-started)).
- The PWA guide says *"typically within 24 to 48 hours"* ([Publish a PWA](https://learn.microsoft.com/microsoft-edge/progressive-web-apps/how-to/microsoft-store)).
- If it fails, you get a report saying why; fix and resubmit.

Changes to the web app reach Store users as soon as they are deployed (the package is a shell around the live site).
Resubmit only for the name, icons, manifest changes or listing text.

## 6. Install it on Windows today, without the Store

In **Microsoft Edge** on Windows 10/11:

1. Open `https://bidswipe-tau.vercel.app`.
2. Click the **App available / Install** icon at the right end of the address bar (or **⋯ → Apps → Install BidSwipe**).
3. **Install**. BidSwipe opens in its own window with a Start menu entry and a taskbar icon; right-click the taskbar
   icon for the shortcuts **Home**, **Search**, **Saved**, **Jobs** and **Alerts** (after this version is deployed;
   production still has "Swipe bids", "Search all bids" and "Alerts"). For a "Get work done" account, Home, Search and
   Saved open Jobs, because those screens are not shown to that kind of account; its own shortcut is Jobs. Where there
   are no local jobs (the pilot's single mode), Jobs opens Home.
4. To remove it: Start → right-click BidSwipe → Uninstall (or `edge://apps`).

## 7. Promo codes, fees and the Microsoft Store

**Promo codes are allowed for this app.** Policy **10.8.1**: *"Non-game products made available on PC devices may
either use a secure third-party purchase API or the Microsoft Store in-product purchase API for in-app purchases of
digital items or services that are consumed or used within the product."* Only games and Xbox products must use
Microsoft's system. Two rules still apply:

- **10.8.4**: *"You may not mislead customers and must be clear about the nature of your in-product promotions and
  offerings including the scope and terms of any trial experiences."*
- **10.8.4** also: once Pro is sold, the listing must *"provide information about the types of in-product purchases
  offered and the range of prices"*.
- **Local job fees**: they are payments for a real-world service, so when they are collected, policy **10.8.2**
  applies: *"You must use the Microsoft payment request API or a secure third-party purchase API for purchases of
  physical goods or services"*, with its checklist (identify the provider, authenticate, confirm each transaction,
  PCI DSS), and the provider must be noted in Partner Center. Today nothing is collected: say so, and never imply a charge.

**Setting a code.** Real codes live only in the host's `PROMO_CODES` (Vercel → Project → Settings → Environment
Variables), never in the repository. Give each a use limit and an expiry: `<code>:pro:25:2027-03-01`. In a share link,
write `&` as `%26`. The **iOS** build is different: Apple guideline 3.1.1 bars unlocking features with your own codes
(`docs/PRODUCT.md` §4; `STORE_BUILD` in `web/js/api.js` turns codes off there).

## 8. What is still missing (honest list)

- ~~Deploy~~ and ~~the package~~: done 2026-11-16 (the list at the top).
- **A domain you own** (risk 1).
- **The account type** (risk 2): check it.
- ~~Two reviewer accounts~~: made 2026-11-18; the award and the messages on 2026-11-19 (step 5 at the top).
- **No block or mute** between a poster and a winner. Microsoft does not ask for one by name.
- ~~**Account deletion in the app.**~~ Built 2026-11-18: Settings → Delete account (password, or the email address
  for an account with no password), at once; the privacy page says what goes. Apple and Google require an in-app way.
- **Optional manifest extras**: `widgets`, `share_target`, `protocol_handlers`, `edge_side_panel`,
  `window-controls-overlay` (only with title-bar CSS), `iarc_rating_id` after the rating. None is needed for certification.

## 9. What was checked, and what was not

- Microsoft Learn pages (policies 7.20, account types, roles, submission API, msstore CLI, screenshots, age ratings):
  read and quoted by the store research pass on 2026-11-16. Not re-opened while writing this page.
- PWABuilder: its rules and request body were read from its GitHub source on 2026-11-16. The packaging service was
  called that day and the package's identity read back out of the bundles (section 3). pwabuilder.com's report card
  was **not opened**, and the package was **not installed** on a Windows PC.
- The manifest: checked locally on 2026-11-16 (valid JSON; `id`, `start_url`, `scope`, `name`, `short_name` and the
  24 icons unchanged; every icon and screenshot file exists at the size it claims; each shortcut opens a view that
  `openShortcut` in `web/js/live.js` accepts). The live manifest was fetched after the deploy: the same file.
- The listing counts and captions: counted with Python on 2026-11-16.
- **Not checked**: Partner Center screens, the IARC questionnaire, the Windows App Certification Kit, an install of a
  package, and the Store wrapper with the app's security headers (`X-Frame-Options: DENY`, COOP and CORP).

## Sources (checked 2026-11-16)

- Microsoft Store Policies 7.20 — https://learn.microsoft.com/windows/apps/publish/store-policies
- Publish a PWA to the Microsoft Store — https://learn.microsoft.com/microsoft-edge/progressive-web-apps/how-to/microsoft-store
- Define icons and a theme color (Windows icon sizes) — https://learn.microsoft.com/microsoft-edge/progressive-web-apps/how-to/icon-theme-color
- Store listing fields (PWA) — https://learn.microsoft.com/windows/apps/publish/publish-your-app/pwa/add-and-edit-store-listing-info and https://learn.microsoft.com/windows/apps/publish/publish-your-app/pwa/add-additional-information
- Screenshots and images — https://learn.microsoft.com/windows/apps/publish/publish-your-app/pwa/screenshots-and-images
- Age ratings — https://learn.microsoft.com/windows/apps/publish/publish-your-app/pwa/age-ratings
- Get started / certification time — https://learn.microsoft.com/windows/apps/publish/get-started
- Set up your developer account early — https://learn.microsoft.com/windows/apps/publish/prepare-developer-account
- Open a developer account — https://learn.microsoft.com/windows/apps/publish/partner-center/open-a-developer-account
- Roles — https://learn.microsoft.com/windows/apps/publish/partner-center/assign-roles-to-account-users
- Store submission API — https://learn.microsoft.com/windows/apps/publish/store-submission-api
- msstore CLI — https://learn.microsoft.com/windows/apps/publish/msstore-dev-cli/commands
- PWABuilder source — https://github.com/pwa-builder/PWABuilder
