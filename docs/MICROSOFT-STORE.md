# BidSwipe in the Microsoft Store — from zero to submitted

For Ev. Everything here was checked against Microsoft's own pages on **2026-11-13**; links are at each step.
Only you can do the account and submission steps: they need your identity and your Microsoft account.

**Short version:** it's free. You make a developer account, reserve the name "BidSwipe", copy three
values from Partner Center into PWABuilder, upload the two files PWABuilder gives you, fill in the
listing (text below, ready to paste), and wait for certification (up to 3 business days).

---

## 0. Before you start (things the app needs first)

| Needed | Status |
|---|---|
| The app live on HTTPS | `https://bidswipe-tau.vercel.app` (the lead's deploy). Check it opens before you start. |
| Accounts mode on the live site | Store users must be able to sign up: `AUTH_MODE=accounts` in the host's env. |
| Poll mode on Vercel | Automatic: with `VERCEL` set and `REALTIME_MODE` blank the app checks for new alerts about once a minute while it's on screen and reloads its feed after each scan (`src/routes/realtime.ts`). Also set `CRON_SECRET` so the daily scan, market refresh and reminder tick run. |
| Privacy policy page | `https://bidswipe-tau.vercel.app/privacy.html` — **fill in your contact email first** (two orange `[CONTACT EMAIL]` boxes) and the hosting providers line. |
| Manifest, icons, service worker | Done: `web/manifest.webmanifest`, `web/icons/`, `web/sw.js`. Chromium reports no installability errors. |
| A test account for Microsoft's testers | Make one on the live site (e.g. `store-review@<your domain>`), finish onboarding with a real ZIP. Policy 10.3.1 asks for it. |

> **Domain warning (policy 10.1.1):** "Products submitted as web apps must be published by the domain or
> website owner." A `*.vercel.app` address belongs to Vercel's domain. It is usually accepted for PWAs,
> but a domain you own (e.g. `bidswipe.app`, ~$15/yr) removes the doubt and keeps the app's address the
> same if you ever move hosts. If you switch domains *after* publishing, users' installed app keeps the old one.

## 1. Make the developer account (free)

- Go to **https://storedeveloper.microsoft.com** and sign up.
- **Individual or company?** Policy 10.14: *"Company accounts must be used for organizations, businesses,
  and any person acting in relation to their trade or profession… A company account is required if … a
  reasonable consumer would interpret your application or publisher name to be that of a business entity."*
  BidSwipe is a business product, so pick **Company**. Both are free now:
  - Individuals: free since September 2025 ([Windows Developer Blog, 2025-09-10](https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/)).
  - Companies: the $99 fee was removed in May 2026; you can sign up with a work account and most checks
    are automated. Have a **D-U-N-S number** and a business document (formation papers or license) ready
    ([Windows Developer Blog, 2026-05-07](https://blogs.windows.com/windowsdeveloper/2026/05/07/publish-to-microsoft-store-as-a-company-now-with-free-registration-and-faster-onboarding/)).
  - Individual sign-up needs a personal Microsoft account plus an ID and a selfie for verification.
- Company accounts must show **customer-support contact info** on the Store page in some regions (10.14):
  use the same email as the privacy page.

## 2. Reserve the name and copy the three identity values

From Microsoft's guide ([Publish a PWA to the Microsoft Store](https://learn.microsoft.com/microsoft-edge/progressive-web-apps/how-to/microsoft-store)):

1. Open **[Partner Center](https://partner.microsoft.com/dashboard/home)** → **Apps and games** → **New product** → **MSIX or PWA app**.
2. Type **BidSwipe** → **Reserve product name**. (Policy 10.1.1: the name must be unique and must not carry
   marketing text, so "BidSwipe", not "BidSwipe – Public Bids". That's why the manifest `name` is just "BidSwipe".)
3. Left menu: **Product management** → **Product identity**. Copy these three into a note:
   - **Package ID** (looks like `12345YourName.BidSwipe`)
   - **Publisher ID** (looks like `CN=ABCD1234-…`)
   - **Publisher display name** (your company name as registered)

## 3. Build the package with PWABuilder

1. Go to **https://www.pwabuilder.com**, paste `https://bidswipe-tau.vercel.app`, click **Start**.
2. The report card should show the manifest, service worker and icons as present. (If it flags something,
   send me the screenshot.)
3. **Package for stores** → **Windows** → **Generate package**.
4. Paste the **Package ID**, **Publisher ID**, **Publisher display name** from step 2.
   Leave the app name "BidSwipe" and the version at `1.0.0` for the first submission (each later upload needs a higher version).
5. **Download package**. You get a `.zip` with an **`.msixbundle`** and a **`.classic.appxbundle`**
   (the classic one is for older Windows versions). **Upload both** in step 4. The zip also has an
   `install.ps1` / test package you can use to try it on your own PC first.

Icons: PWABuilder builds every Windows tile from the manifest. We ship a 512px icon plus the Windows sizes
Microsoft lists ([icon sizes](https://learn.microsoft.com/microsoft-edge/progressive-web-apps/how-to/icon-theme-color#icon-image-sizes):
44/88/176 app icon, 71/150/310 tiles at 1x and 2x, 310×150 wide, 50/100 store logo, 1240×600 splash,
16–256 target sizes). To redraw them after changing `web/icon.svg`:
`NODE_PATH=$(npm root -g) node scripts/make-icons.cjs`.

## 4. The submission (Partner Center → your app → Start your submission)

### Pricing and availability
- **Free.** Markets: start with **United States** only (the bid boards are US public agencies).
- Visibility: you can choose **Private audience** first (only people you list can find it) to "get a feel"
  before going public — then switch to public in a later submission.

### Properties
- Category: **Business** (subcategory if offered: none needed). Secondary: **Productivity**.
- Privacy policy URL: `https://bidswipe-tau.vercel.app/privacy.html` (required: the app has accounts — policy 10.5.1).
- Website: `https://bidswipe-tau.vercel.app` · Support contact: your email.
- Product declarations: nothing special (no accessibility claim unless tested; no pen/kinect/etc.).

### Age ratings (IARC questionnaire)
Category to choose: **"Productivity / Utility / Reference / other app"** (not game, not social, not
shopping). Answers that fit this app as it is today:

| Question (wording varies) | Answer | Why |
|---|---|---|
| Violence, fear, sexual content, nudity, crude humour, profanity | **No** to all | Bid titles from public agencies only |
| Drugs, alcohol, tobacco references | **No** | (A bid could name e.g. a "tobacco-free signage" job, but the app doesn't depict or promote them) |
| Gambling / simulated gambling | **No** | |
| Users can interact or exchange content with each other | **No** | No chat, no user posts, no public profiles |
| App shares the user's location with other users | **No** | The home ZIP is never shown to anyone else |
| Digital purchases | **No** today. **Yes** once Pro is sold in-app | Promo codes are not purchases |
| Unrestricted internet / web browser | **No** | It opens agency bid links in the browser, it is not a browser |
| Collects personal info | Answer **yes** if asked (email, business profile) | Matches the privacy page |

Expected result: the lowest rating (e.g. ESRB Everyone / PEGI 3). Don't guess: if a question doesn't fit, read it to me.

### Packages
Upload the **`.msixbundle`** and the **`.classic.appxbundle`** from step 3.

### Store listing (English, United States) — ready to paste

**Description** (plain text, limit 10,000):

```
BidSwipe finds open public bids that fit your trade — and tells you why.

Every morning BidSwipe reads public bid boards (cities, counties, school districts, state public works
and federal SAM.gov notices), scores each open bid for your business, and shows you the good ones first.
Each card says in plain words why it fits: your trade's keywords in the scope, how far it is from your
home base, the job size, how many days you have to bid, and the paperwork it asks for (bonding,
prevailing wage, registrations).

Swipe right to save a bid, left to pass. Or browse the full list, search it and sort it. When a public
bid is worth it, one tap opens the agency's own page: you bid there, directly with the agency. BidSwipe
never takes a public bid and never sees your price on it.

Local jobs: people and businesses near you can post a job in the app, and contractors place a sealed bid
on it, right in BidSwipe. Nobody sees another bid's amount while bidding is open. When bidding closes,
the lowest bid wins, and the winner has 7 days to make contact with the poster. You can post jobs, bid
on them, or both.

Work profiles: a short card about you or your business (headline, experience, skills, the licence you
list (BidSwipe does not check it), a résumé link) that posters see when you bid. Your email, phone and address are never on it.

Set it up in a minute: pick your trade, type your ZIP, choose how far you travel and the job sizes you
want. BidSwipe does the reading.

Alerts: new matches, deadline reminders for the bids you saved, award results after the fact, and news
on the local jobs you posted or bid on.

BidSwipe Pro adds a cost check for a bid, price and award history from public records, and price-move
alerts.

Bids are sealed: on a public bid nobody, including us, sees a competitor's price before the bid
opening, and on a local job nobody sees another bid's amount before bidding closes. Scores are a
first pass — always read the bid documents before you price a job.
```

**Short description** (keep under 270 characters; this one is 207):

```
Public bids that fit your trade, one swipe at a time, each with the reasons it fits. Or post a local job: others place a sealed bid in the app, the lowest bid wins, and the winner has 7 days to make contact.
```

**Product features** (up to 20, 200 characters each — no bullets, the Store adds them):

```
Open public bids scored for your trade, area and job size
Plain-English reasons on every card: scope, distance, size, days left, paperwork
Swipe to save or pass, or browse and search the full list
One tap to the agency's own bid page — you bid directly with the agency
Alerts for new matches and reminders before saved bids are due
Award results after the fact, from public records
Fast setup: pick your trade, enter your ZIP, choose how far you travel
Post a local job and get sealed bids in the app; the lowest bid wins when bidding closes
Bid on local jobs near you; the winner has 7 days to make contact with the poster
Work profiles: headline, experience, skills and licence, without your email, phone or address
Works on Windows, phones and the web with the same account
```

**Keywords** (max 7, 40 characters each, 21 words in total — policy 10.1.3: relevant, no prices, no other products' names):

```
public bids
government contracts
contractor bids
RFP
construction bids
public works
bid alerts
```

**Screenshots** (at least one; we have four, real screens of the app on real captured bids):
`web/icons/screenshots/wide-swipe.png`, `wide-browse.png` (1280×800, for the desktop listing) and
`narrow-swipe.png`, `narrow-browse.png` (780×1688). The company name in the top-right chip reads
"Your company" instead of the pilot's name; everything else is exactly what the app shows. For the best
Store page, also take 1920×1080 or larger desktop shots from the live site after signing in.

**Store logos**: optional. The package logos are used if you upload none.

**Copyright**: `© 2026 <your company name>`.

### Submission options → Notes for certification
```
BidSwipe needs an account. Test account: <email> / <password> (onboarding already finished, ZIP <zip>).
Bids come from public agency bid boards and refresh once a day. "Bid on …" buttons open the agency's
own website. Pro features can be tried with the promo code in the app's Settings (see below).
```

Then **Submit for certification**.

## 5. How long it takes

- Microsoft: certification *"can take up to three business days"*; after it passes, the listing shows
  within about 15 minutes ([Get started with Microsoft Store](https://learn.microsoft.com/windows/apps/publish/get-started#app-certification-process-msix-pwa)).
- Microsoft's PWA guide says PWAs are *"typically"* reviewed *"within 24 to 48 hours"*
  ([Publish a PWA](https://learn.microsoft.com/microsoft-edge/progressive-web-apps/how-to/microsoft-store)).
- If it fails, you get a report saying why; fix and resubmit.

Updates to the web app (anything on Vercel) reach Store users **immediately** — the Store package is a
shell around the live site. You only resubmit for name, icons, manifest-level changes or listing text.

## 6. Install it on Windows today, without the Store

In **Microsoft Edge** on Windows 10/11:

1. Open `https://bidswipe-tau.vercel.app`.
2. Click the **App available / Install** icon at the right end of the address bar
   (or **⋯ Settings and more → Apps → Install BidSwipe**).
3. **Install**. BidSwipe opens in its own window and gets a Start menu entry and a taskbar icon; right-click
   the taskbar icon for the **Swipe / Browse / Alerts** shortcuts.
4. To remove it: Start → right-click BidSwipe → Uninstall (or `edge://apps`).

Chrome works the same way (install icon in the address bar). This is the same app the Store installs.

## 7. Promo codes (the free Pro code for L&M) and the Microsoft Store

**Yes, allowed for this app — unlike Apple.** Microsoft's rule only forces **games** and **Xbox** products
to use Microsoft's purchase system. Policy **10.8.1** ([Microsoft Store Policies 7.20, effective 2026-10-22](https://learn.microsoft.com/windows/apps/publish/store-policies#product-policies)):

> "The following products are required to use the Microsoft Store in-product purchase APIs for the
> purchase of digital goods and services. … (a) Games … (b) Products offered on XBOX consoles."
>
> "Non-game products made available on PC devices may either use a secure third-party purchase API or the
> Microsoft Store in-product purchase API for in-app purchases of digital items or services that are
> consumed or used within the product."

BidSwipe is a non-game PC product, so our own promo codes (and later our own payment provider) are
allowed. We found **no** Microsoft Store rule against a code that unlocks features in a non-game app. Two
rules still apply:

- **10.8.4**: *"You may not mislead customers and must be clear about the nature of your in-product
  promotions and offerings including the scope and terms of any trial experiences."* → the code box must
  say exactly what it unlocks and for how long.
- **10.8.4** also: the listing must *"provide information about the types of in-product purchases offered
  and the range of prices"* — once Pro is sold, say so in the description with the price.
- When you sell Pro with a third-party payment provider: **10.8.2** (its list for a secure third-party
  purchase API: identify the payment provider, confirm each purchase, PCI DSS for cards) and *"You must note
  the use of a secure third-party purchase API in Partner Center during the submission process."*

**Setting the pilot's code.** The real code lives only in the host's `PROMO_CODES` variable (Vercel →
Project → Settings → Environment Variables), never in the repository. A code with no limits works for
anyone who learns it, for ever, and a business name is easy to guess, so give it a use limit and an expiry:
`<code>:pro:25:2027-03-01` (25 accounts, until March 1, 2027). The server logs one line at start-up for an
entry that has neither (it names the entry's position, never the code). In a share link, write the code's
`&` as `%26` (`…/?promo=A%26Btest`); a link typed with a plain `&` works too, as long as the part after it
has no `=`.

The **iOS** build is different: Apple guideline 3.1.1 bars unlocking features with your own codes —
see `docs/PRODUCT.md` §4. The app already turns codes off for an iOS build (`STORE_BUILD` in `web/js/api.js`).

## 8. What is still missing or worth doing (honest list)

- **Contact email** in `web/privacy.html` (two placeholders) and the hosting-providers line — required before submitting.
- **Account deletion in the app.** Today the privacy page says "email us to delete". Microsoft's policy
  10.5.1 asks the policy to describe user controls (done); Apple and Google require in-app deletion, so it's
  worth building before the phone stores.
- **A domain you own** (see the warning in step 0).
- ~~Privacy link inside the app~~: done, under the sign-in screen and at the bottom of Settings.
- **`widgets`, `share_target`, `protocol_handlers`** in the manifest: optional; PWABuilder may list them as
  "nice to have". Not needed for certification.
- **Store screenshots at 1920×1080** from the signed-in live site would look better than the 1280×800 ones.

## Sources (checked 2026-11-13)

- Publish a PWA to the Microsoft Store — https://learn.microsoft.com/microsoft-edge/progressive-web-apps/how-to/microsoft-store
- Define icons and a theme color (Windows icon sizes) — https://learn.microsoft.com/microsoft-edge/progressive-web-apps/how-to/icon-theme-color
- Microsoft Store Policies 7.20 — https://learn.microsoft.com/windows/apps/publish/store-policies
- Store listing fields (PWA) — https://learn.microsoft.com/windows/apps/publish/publish-your-app/pwa/add-and-edit-store-listing-info and …/pwa/add-additional-information
- Get started / certification time — https://learn.microsoft.com/windows/apps/publish/get-started
- Free registration for individuals — https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/
- Free registration for companies — https://blogs.windows.com/windowsdeveloper/2026/05/07/publish-to-microsoft-store-as-a-company-now-with-free-registration-and-faster-onboarding/
