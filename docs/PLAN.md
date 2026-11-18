# BidSwipe: the standing plan (problems we cannot have)

Written 2026-11-18 from the owner's words and a research pass on PlanHub, ConstructConnect and ToolBelt; revised the
same day after a review. Read it before you add a feature, a price, an alert or store copy. CLAUDE.md holds the short
rules; this file holds the why, the checks and the sources. Update §2 when a check changes. Source keys are in §7.

## 0. The short version
- Six rules (the owner's three problems, plus three the research shows matter as much), each with a check.
- **Biggest risk: a Free account hears nothing from BidSwipe outside the app.** Push is Pro only (`pushDecision`,
  `src/realtime/alerts.ts`); the e-mail digest goes only to the pilot's config profile (`src/server.ts`). That costs
  return visits, and it is unfair: a Free winner of a local job gets no push for "You won", "2 days left to make
  contact" or the poster's messages, yet a no-show and a 5% fee row can be recorded (not charged). Pro also hears of a
  new local job first, and a tie goes to the bid placed first. N2 fixes the job side; X1, X2, O2 and O10 the rest.
- **Push has never been confirmed on a real phone.** The live site has its push keys (GET /api/push/key answers a
  key: checked 2026-11-18), but no test alert has been seen arriving on an iPhone or on Windows. X1 is that test.
- **A real bug:** the host sends deadline reminders once a day, at 14:50 UTC (`vercel.json`). The due-day reminder
  starts at 07:00 local, so it never fires in Pacific winter, Alaska or Hawaii, and "1 day before" fires only when the
  deadline is earlier in the day than the tick. N3 fixes it.

## 1. Problems we cannot have
The owner (2026-11-18): contractors say enterprise tools are too expensive and bloated for small crews, homeowner lead
apps burn cash on shared leads, and government portals are bureaucratic and hard to use on a phone in the field.
"Make all of this a plan, never forget."

**Where the framing needs correcting, plainly:**
1. **Screen time is the wrong goal.** A contractor in a truck wants to decide fast and get back to work. Our goal is
   return visits (L&M "opens it most mornings": PRODUCT.md §6) and fast decisions. In a field study, notifications
   batched three times a day left people more attentive and less stressed than the default stream [E1]. Construction
   starts early: 45–52% of construction workers are on the job at 7 a.m., against about 28% of all workers [E2][E3].
2. **We do not "use their information".** Their projects sit behind logins, and we never scrape login-walled boards
   (CLAUDE.md). We learn from their public pages and users' public reviews, and never name them in our store copy.
3. **Procore is not a lead source.** Procore runs jobs after you win them; we help you find and decide on work, and we
   will not grow into a project-management suite. Its lesson is about bloat and price [X1][X2], not leads.
4. **Free alone is not our edge.** Subs already get a free inbox for invitations to bid (ConstructConnect's Bid Center
   [CC6], Autodesk's BuildingConnected Bid Board [X8]). Our edge is the public boards, read every morning and scored
   with reasons, on a phone, plus local jobs. We will not have their private GC projects, and copy says so.
5. **Our closest look-alikes are public-bid aggregators** (DemandStar, BidNet Direct, GovSpend, constructionbids.ai,
   govcontractfinder; three are in our sources [PH15][X9][X17]), not PlanHub or ToolBelt. They were not researched,
   so "our edge is the public boards" is untested against them (X13).

### R1. Not too expensive or bloated for a small crew
- **Rule:** Free is useful on its own: fit reasons, swipe, Browse, Saved, and posting and bidding on local jobs. What
  Free covers (trades, areas) is PRODUCT.md §4 until the owner answers O8. Free is never metered by count. Pro sells
  speed on public bids and depth (cost check, award history, price and award watch), never access to public bids or
  rank. No pricing by radius, market or seat (team seats may be a Pro feature; the price is per company). No PM suite.
- **Why:** ConstructConnect charges $129/mo per market and per seat; its documents tier starts at $199/mo on an annual
  contract [CC1]. PlanHub sells sub reach by radius, $1,999/yr for 50 mi up to $3,299/yr for 200 mi [PH2]. Procore
  publishes no price [X1]; reviewers name price as its top downside, and some say it may have too many features for a
  smaller company [X2].
- **Check:** `src/plans.ts` is the only list of Pro features (six flags). A Pro route answers Free 402
  `premium_required` (`test/estimate-route.test.ts`). At most 5 tabs (`TABS`, `test/home-model.test.ts`). Onboarding by
  taps (390×844). A new screen, setting or field names the problem it serves in its commit message.

### R2. No shared leads that burn cash
- **Rule:** Never charge per lead, view, contact or application; never sell one person's job to a pack of paying pros.
  Posting and bidding are free. A fee exists only in `src/jobs/rules.ts`'s cases (winner no-show or back-out 5%, both
  agreed 1%), shown before the bid, recorded and not charged while PAYMENTS ARE OFF. Local-job alerts reach every plan
  the same way at the same moment (N2). We never imply we told someone something outside the app unless we did. On
  public bids BidSwipe never sells, routes or takes a bid.
- **Why:** Angi Leads' FAQ, per a search summary we could not re-check, says a lead goes to up to four pros and is
  charged whether or not you answer [X3]. The FTC made HomeAdvisor pay up to $7.2M over how it marketed leads [X4].
  Thumbtack charges a direct lead automatically when the customer reaches out [X5]. Bark credits are non-refundable
  except in narrow cases [X6]. Angi now lets homeowners pick each pro [X7]. ToolBelt ranks paid postings above free
  ones [TB3] and gives a partner's pros early alerts [TB11]: where a tie goes to the first bid, a head start is an edge.
- **Check:** `test/jobs-rules.test.ts` (no fee on a poster no-show, no agreement, no bids or a cancel). `feeLines` show
  before the bid (`web/js/views/job.js`). `test/realtime.test.ts` (N2): Free and Pro get the same push decision for
  every local-job alert. No payment code (`grep -ri stripe src package.json` is empty).

### R3. Not bureaucratic; works on a phone in the field
- **Rule:** The card carries the red tape: why it fits, the due time, paperwork lines (bond, prevailing wage, SAM,
  state qualification) and where to bid (the agency's page). One thumb: tap targets of 44 px or more (WCAG 2.2 AAA; AA
  is 24 px [E6]; we choose AAA for gloved hands); the main path works at 390×844. No PDF needed to know whether a job
  fits. The agency's page stays the place to bid and read addenda, and we say so. New detail-sheet lines never push
  "Bid on …" down (S1, §5).
- **Why:** Every agency runs its own portal and registration [X9]. After the 2022 switch to UEI, up to about 50,000
  SAM.gov registrations waited on validation [X10]. Some boards charge for plans or to bid: QuestCDN at the agency's
  price (e.g. $15 in Denver) [X11], DemandStar $5 a package [X17], Bid Express $60/mo or $50 a solicitation [X12]. A
  missed amendment can make a bid nonresponsive, and the bidder carries that risk [X13][X18]. In 2018 only 67% of 400
  state government sites passed a mobile-friendliness test [X14]; 92% of construction professionals surveyed use a
  smartphone every day at work [X15]. **Gap:** no study of contractors using bid portals on a phone; ask L&M first.
- **Check:** `test/tap-targets.test.ts` plus an on-screen measure (N9, coming). Each release at 390×844: sign-up →
  first card → "Bid on …", timed and counted in taps (measure first, then set a target). The score reason tests.

### R4. No alert spam (research)
- **Rule:** Alert only on fits inside the user's trade, reach and limits; never sub work, capped or over-limit bids.
  At most 10 per scan, never the same bid twice, a board's first load quiet. A switch per kind, plus quiet hours.
  Public bids: every plan's alerts come from the same daily scan; Pro gets a push at once, Free the inbox (and, after
  X2, one morning summary). Never notify about nothing new.
- **Why:** PlanHub reviewers say invites feel like spam and come from outside their area [PH9]. In 2019, PlanHub told a
  swamped user to turn off all e-mail notifications [PH9]; its help centre now offers a daily summary and per-category
  switches [PH20]. ConstructConnect reviewers call its daily e-mail the same useless leads every day [CC9] and get
  invitations far outside their area [CC10].
- **Check:** `test/tiers.test.ts`, `test/scan-quiet.test.ts`, `test/scan-events.test.ts`, `test/realtime.test.ts`.
  Numbers: the alert opt-out rate, and alerts read against alerts sent (N11).

### R5. No stale, fake-looking or empty listings (research)
- **Rule:** Every card says how fresh it is: a due date, or "Seen on the board <day>" (N4). A bid with no due date is
  open only by `openBidSql()` (3 days' grace). A local job closes on its date. Every count is real; 0 is said as 0. A
  board we cannot read is reported FAILED, never a quiet 0.
- **Why:** ToolBelt reviewers kept seeing postings about four months old and called them fake [TB6], and say there is
  not enough work on it [TB7]. ConstructConnect reviewers report late, lagging and duplicated data [CC10].
- **Check:** `test/scan-quiet.test.ts`, `test/repo-v1.test.ts` (the open rule), `test/format.test.ts` (N4, coming).
  The onboarding's "in your reach" counts come from the server.

### R6. No money traps (research)
- **Rule (settled):** No price behind a form. No sales calls or SMS. No phone number required to sign up or find work
  (a poster may still add a phone only the winner sees). The rest of billing (monthly or annual, cancelling, renewal
  notices, refunds) waits for O1, and the app-store rules shape it.
- **Why:** ConstructConnect allows no mid-term cancellation or refund and asks for a work e-mail and phone before it
  shows detailed pricing [CC1]; the BBB lists 54 complaints in 3 years, many about renewals [CC7]; Trustpilot scores it
  about 2/5 [CC8]. PlanHub reviewers describe aggressive reps after a trial and a renewal against their wish
  [PH10][PH11]. A ToolBelt user who had stopped using it got repeated sales calls [TB6].
- **Check:** no billing and no phone field at sign-up (screen check); O1's terms go into PRODUCT.md §4 before billing.

## 2. Where BidSwipe stands (code audit, 2026-11-18)
| Rule | Today | At risk |
|---|---|---|
| R1 | Free gets the feed, reasons, swipe, Browse, Saved and local jobs. Pro is six flags, not sold, no price. The code does not limit Free to one trade or one area, although PRODUCT.md §4 says it should (O8). | Free gets no push and no e-mail. The app is broad: about 15 views, a market tape, a 21-module cost engine, Settings with up to 11 sections. Fine for Pro, but it must not crowd Free's main path. |
| R2 | No per-lead charge. Bids are sealed. Fee lines show before a bid, with "Fees are not being collected yet". No fee on a poster no-show or no agreement. No payment code. | `decideJob` uses the Pro-only push: a Free winner hears nothing outside the app while a no-show can be recorded (N2, O10). A new local job pushes only to Pro (N2). The Jobs tab never says posting and bidding are free (N8). Lowest-bid-wins draws price shoppers (forum anecdotes [X16]). |
| R3 | Phone-first PWA, checked at 390×844. Plain reasons, paperwork lines, due times, a "Bid on …" link. Tab bar 60 px; main buttons 44 px or more. Onboarding already says the radius is straight-line miles. | Chips about 33 px (`.chip` padding 7px), Yes/No 40 px (`.seg3-btn`), `.row-remove` 34×34, the radius slider 30 px tall (`.range`). The tape toggle's box is 36×40 (32 wide on narrow screens), but its `::before` makes the hit area 44 px. Host reminders broken (N3). No calendar file, no addenda line. Saved does not open offline. Web push never confirmed on a real phone (the host has its keys, checked 2026-11-18). No real iPhone test. The Settings radius help and the detail sheet do not say "straight line" (N6). |
| R4 | Strong: quiet first loads, 10 per scan, sub/capped/over-limit never alert, a switch per kind, quiet hours, `notified_at` keeps the digest from repeating. | No "pause all", no "fewer like this", no pass reasons. On the host, a push held by quiet hours waits for the next daily tick and is then dropped (`PUSH_MAX_AGE_MS`, 24 h): O9. |
| R5 | `openBidSql`, 3-day grace. Jobs close on a set date. Onboarding shows real counts by tier. | A no-due-date card says "Not listed · Check the bid". **Douglas County, the pilot's own county board, is FAILED on the host** (HTTP 403 to Vercel's address, HANDOFF.md §1): known missing pilot coverage (O11). Local jobs will be thin at first. |
| R6 | No billing, no phone at sign-up; the Store text says Pro is not sold. | No billing terms or price decided (O1). |
| Goal | Nothing measures return visits or decision speed. | N11 adds the numbers. |

## 3. The competitors
**How this was read:** whole pages only for planhub.com (home, pricing, subcontractors) and ConstructConnect (pricing,
find-work). The rest came from search-engine summaries, which paraphrase and can be out of date, so we do not quote
them; Reddit was unreachable. Review points are signals, not counts. **Not researched: public-bid aggregators** (X13).

### 3.1 PlanHub: a commercial bidding marketplace (GCs, subs, suppliers)
- **What it is, who pays:** GCs post projects and invite bids for free [PH4]. A sub's free profile gets invitations and
  sees projects in a "local radius" of unpublished size [PH3]. Subs pay by radius a year: $1,999 (50 mi), $2,349
  (100 mi), $3,299 (200 mi), with no per-lead fees [PH2]. Paid GC tiers have no published price [PH4].
- **Users like:** easy setup [PH12]; work they would not otherwise hear about [PH16]. **Users hate:** cost for small
  subs [PH12][PH18]; irrelevant, out-of-area invites that feel like spam [PH9]; pushy reps and an unwanted renewal
  [PH10][PH11]; weak on a phone in 2019–2021 reviews, maybe fixed since [PH14]; App Store reviews of freezing after
  login and being sent to another app [PH8]; straight-line distance [PH13].
- **We TAKE:** one morning summary with a count; a go/no-go decision on the spot, as in its sub app [PH7]; a status on
  each saved bid [PH3]; per-kind notification switches, as its help centre has now [PH20]; AI answers that cite the
  page [PH3].
- **We AVOID:** reach priced by radius per year; one app per role [PH8]; selling "competitors viewed or bid" counts
  [PH3]; an all-or-nothing off switch as the answer to too many alerts (its 2019 answer [PH9]).
- **We DIFFERENTIATE:** public work (it does not replace watching government portals, says a rival [PH15]); small
  jobs first; reasons on every card; one app.

### 3.2 ConstructConnect: construction lead data and preconstruction software
- **What it is, who pays:** a project-lead database (public and private), a free board for invitations a sub already
  got (Bid Center), GC bid management and takeoff software [CC1][CC2][CC6]. Starter $129/mo per market per seat, month
  to month; Professional from $199/mo per market per seat, annual; Premium from $10,000/yr; takeoff $1,200–$2,450/yr
  per seat; no refund for a mid-term cancel [CC1].
- **Users like:** time saved, information in one place, the contacts [CC10]. **Users hate:** price for small firms
  [CC11]; renewals that are hard to stop [CC7][CC8]; the same leads every day [CC9]; out-of-area invitations, late or
  stale data, clunky search [CC10].
- **Telling facts:** it removed its Match Score in 2024 [CC3] while its pricing page still promises automatic matching
  [CC1]. A help note says its app left the stores (date unclear) [CC5]. PlanSwift, one of its takeoff products, is
  Windows desktop software [CC13].
- **We TAKE:** a bid intent on a saved bid, as in Bid Center [CC14]; calendar dates [CC6]; a daily message done
  better: its daily e-mail mixes new and updated projects [CC4] and users call it repetitive [CC9], so ours lists only
  bids never sent before, and changes only for bids you marked Bidding (X3).
- **We AVOID:** per-market or per-seat pricing, annual lock-in, a price behind a form, metering Free by count, and
  advertising a feature we don't have [CC1][CC5].
- **We DIFFERENTIATE:** reasons on every card (they dropped theirs), phone-first, a free public feed, local jobs.

### 3.3 ToolBelt: a residential skilled-labour marketplace
- **What it is, who pays:** contractors post projects or crew openings, tradespeople apply free and without limit,
  then they call or text each other; no payments [TB1][TB2][TB3]. ToolBelt HIRE costs $199.99/mo on a 12-month
  commitment [TB4]; a CareerPlug add-on $149/mo [TB5]. Pro postings rank above free ones [TB3]; Pro's price is not on
  ToolBelt's pages, and one third-party review says $400/mo [TB12].
- **Users like:** easy to use, helpful staff, real hires for some, free for workers [TB6][TB7][TB12]. **Users hate:**
  not enough work [TB7]; months-old postings that look fake [TB6]; sales calls after they stopped using it [TB6]; login
  bugs [TB6]; a verification gate that locked out a licensed pro [TB8]; narrow geography [TB9].
- **We TAKE:** freshness in words; "is there work here?" in real counts; a search in three taps (trade, specialty,
  miles) [TB2]; paperwork shown as entered [TB10]; a true count for the poster [TB13].
- **We AVOID:** paid rank or early alerts [TB3][TB11], sales calls, contact by phone before an award, verification
  gates, "#1" taglines [TB1].
- **We DIFFERENTIATE:** the feed is never empty (agency boards exist without any users), reasons on every card, and
  accountability: each job closes on a date and the winner has 7 days to make contact.

## 4. Engagement without confusion or boredom
**We will:**
- Make one morning moment: a summary after the default scan group (14:08 UTC, about 6:10 AM Pacific in winter), with
  a count and the best one named, and nothing on a day with nothing new. Batching beats a stream [E1]; crews start
  early [E2][E3].
- Badge only what is unread, and clear it when read [E4]. Put the decision on the card: save or pass, with Undo.
- Show the reasons first, then the due time and paperwork. End the deck honestly; it already does ("You're caught up",
  "See N more in Search", "Widen your reach": `web/js/views/feed.js`, deck-done).
- Remind on Saved bids 3 days out, the day before and on the due day (N3), with an addenda line (N5) and a calendar
  file (N10). Ask why on a pass with optional chips in the Undo toast, never a modal (X4). Later, Save / Pass on the
  notification itself where the platform allows [E5].

**We refuse:** streaks, points or usage badges; fake urgency, made-up countdowns, "N contractors are looking"; live
bid counts shown to bidders (O3); "We miss you" pushes, sales calls and SMS; infinite scroll built to keep people in
(Browse pages by 100 on purpose); notifications about nothing new; hiding the off switch.

**How we know (N11):** decisions on 4+ mornings a week (the pilot's "most mornings"); median minutes from a morning
alert to the first save or pass; saves per alert; "Bid on …" taps; alert opt-outs. Targets only after two real weeks.

## 5. The changes
**Wait for the work in progress.** Commit 5113718 (five fixes) plus the working tree (delete-account and more) is
unverified. `git status` (2026-11-18) shows it touching `docs/SECURITY-SCAN.md`, `docs/api/openapi.yaml`,
`scripts/hawkscan-guard.mjs`, `src/db/accounts.ts`, `src/jobs/repo.ts`, `src/jobs/view.ts`, `src/routes/auth.ts`,
`src/routes/account.ts` (new), `test/account-delete.test.ts` (new), `test/no-5xx.test.ts`, `web/js/api.js`,
`web/js/job-words.js`, `web/js/push.js`, `web/js/views/settings.js`, `web/privacy.html`, `web/styles.css`. N8–N11
touch those files or add a route that `openapi.yaml` and `no-5xx` must cover, so they start after that commit lands. N4
needs no openapi change (checked: `/api/feed` answers are documented as plain JSON). N2, N3 and N5 share
`src/realtime/alerts.ts` and `test/realtime.test.ts`: do them one after another.

**S1 (shared acceptance for N5, N6, N10, X7):** at 390×844, on a typical public card, "Bid on …" in the detail sheet
does not move down (`getBoundingClientRect().top` and screenshots, before and after). New lines go below it.

### Now (no owner decision; the same list is in the build queue, in this order)
- **N1** Save this plan; replace CLAUDE.md's problems block (lines 21–32) with testable rules. Small. *Done:* ≤ 350
  lines here; every test file the block names exists or is marked "coming".
- **N2** Local-job alerts reach every plan alike: "You won", "2 days left", messages, job closed and a new local job's
  match push on Free as on Pro (push switch and quiet hours still apply); public-bid alerts unchanged. R2. Small.
  *Done:* a test gives a Free and a Pro profile the same push decision for each kind.
- **N3** Reminders by calendar day, so the host's one daily tick sends each stage in all 7 Settings time zones (tested
  in January and July). R3. Medium. Push benefit: pilot and Pro today; Free sees them in the inbox.
- **N4** Freshness in words: "No due date · Seen on the board Tue, Nov 17". R5. Small.
- **N5** An addenda line on the 1-day and due-day reminders and in the detail sheet. R3. Small.
- **N6** "41 mi, straight line" in the detail sheet; the Settings radius help says straight-line too. R3. Small.
- **N7** A copy guard test: store and manifest text never claims "#1", "largest", "real-time" or user counts, and
  never "instant" without "once a day". R6, honest copy. Small.
- **N8** The Jobs tab says posting and bidding are free, and a bidder's fee applies only after they win. R2. Small.
- **N9** Tap targets of 44 px or more, guarded by a CSS test and an on-screen measure. R3. Medium.
- **N10** "Add to calendar" (.ics) from a plain GET link, checked on Ev's iPhone. R3. Medium.
- **N11** `GET /api/admin/usage`: counts only (return visits, decision speed, opt-outs, local jobs). Goal, R4. Medium.

### Next (bigger, or waiting on something)
- **X1** Push proven on the live site. The keys are set on Vercel (GET /api/push/key answers one; checked
  2026-11-18). "Send a test alert" must arrive on Ev's iPhone (Home Screen app, docs/IPHONE-ALERTS.md) and on Windows,
  and Ev says so. Until then no copy promises phone alerts that work. R3, R4.
- **X2** The Free morning summary (PRODUCT.md §4 promises a daily digest): one a day, counted, best named, only bids
  never sent before. Needs X1, O2; on time only with O9. Medium. *Done:* 7 new fits = one push; 0 = no push; an
  unchanged re-scored bid never in a second summary; one held by quiet hours goes at the first tick after (within
  24 h) or stays in the inbox, tested on the host's tick schedule; Pro unchanged.
- **X3** Bid intent on Saved: Reviewing · Bidding · Not bidding. Not bidding stops reminders; Bidding turns on the
  results alert and "Changed since we told you": one notice when the due date moves (the dedupe key has it). Medium.
- **X4** Optional pass reasons in the Undo toast (Too far · Too big · Not my work · Already bidding), never a modal or
  a block. A weekly hint ("3 passes for Too far: lower your reach?") changes nothing until tapped. R4. Medium.
- **X5** Saved opens offline: the last list kept on the device, "as of 6:12 AM"; `sw.js` never caches `/api`. R3.
- **X6** "Pause all alerts for 7 days", and "Fewer like this" on a match alert that opens the right setting. R4. Small.
- **X7** A red-tape line per board, only from sourced facts in docs/DATA-SOURCES.md. R3. Medium. S1 applies.
- **X8** Up to 3 saved searches, each with "add new ones to my morning summary". R4. Medium. After X2.
- **X9** Real counts while choosing, signed in: "+12 open bids" under a trade chip or radius in onboarding. R5.
  Medium. A count before sign-up ("Within 90 mi of 89410 today: …") is a new public endpoint and waits for O6.
- **X10** After a post, the poster sees "7 people nearby do this work and will see it in their feed", counted by the
  scorer's own rule (`seesLocalJobs`), never who. R5. Small.
- **X11** Ask L&M when their day starts; if before 7, move the crons an hour earlier for summer. Small.
- **X12** PersonCard paperwork (crew, miles, licence as typed, insured), "entered by the member, not checked". R2.
- **X13** Research the public-bid aggregators named in §1: public pricing and review pages only, §3's rules. Small.

### Later
- **L1** Public pages by state and trade linking straight to agency pages, no sign-up wall [PH19]. Needs O6.
- **L2** The Pro bot: every line cites its document page, and says to check the number there [PH3][CC12].
- **L3** "Quote the bidders" stays a link to the agency's plan-holder list plus a draft the user addresses and sends
  themselves. BidSwipe never reads, stores or fills in plan-holder contacts.
- **L4** Up to 6 photos of past work (location data stripped, removal through the report flow). Needs file storage.
- **L5** A licence line, "checked on the NSCB public lookup <date>", never a gate [TB8].
- **L6** State and local bid results for award history. **L7** Store apps (Capacitor) with native push.

### Owner decisions (cost, accounts, store, trade-offs)
- **O1 Pro price and billing terms**, before any billing code. R1 rules out pricing by radius, market or seat (what
  makes ConstructConnect and PlanHub expensive for small crews): that rule stands unless you overrule it. Rec.: one flat monthly price per company, annual only
  by choice. Web: cancel in Settings in two taps, an e-mail 7 days before an annual renewal. iOS and Play: the store's
  billing (Apple 3.1.1, RevenueCat), its cancel screen and its notices. Well under $129/mo [CC1]; Pro speed = public bids.
- **O2 Free summary channel:** push (needs X1) · e-mail (needs the Resend key and a sending domain, neither on the
  host; one-tap unsubscribe) · both · inbox only (today). Rec.: push first, e-mail later as an opt-in.
- **O3 Lowest bid wins, and price shoppers:** strict · poster picks from the lowest 3 · a live count for bidders.
  Rec.: strict, and no live count while bidding is open (it pushes prices down and changes the sealed-bid rules).
- **O4 Collecting marketplace fees.** Rec.: payments off through store launch (MARKETPLACE.md §8 open).
- **O5 Store lines.** Microsoft Store (Windows PCs): "City, county, state and federal bids for your trade, scored
  every morning, free". App Store and Play: add "Built for the phone in your truck". N7 guards the words.
- **O6 Public pages and counts without sign-in** (L1, X9). Rec.: later; counts and agency links, no scores.
- **O7 The QuestCDN NV board** (robots.txt Disallow, still on): the one place we break §6 today. Rec.: ask QuestCDN
  in writing with a deadline; off without a yes.
- **O8 What Free includes:** (a) PRODUCT.md §4, 1 trade and 1 area · (b) every trade the crew picks, 1 area.
  Rec.: (b). One area already avoids per-market pricing; one trade cuts work a small shop also does; the code limits
  neither today.
- **O9 An hourly tick (Vercel Pro, $20/month; HANDOFF.md §1: move before charging).** Fixes reminders in every zone,
  held pushes and the summary's timing. Rec.: before X2.
- **O10 A no-show for a winner we could not reach outside the app:** as today · keep the row but show and collect
  nothing unless they had alerts on or opened the job · no row. Rec.: the middle one until X1 works; before O4.
- **O11 Douglas County on the host** (HTTP 403): ask the county, or run it from another network. Rec.: ask first.

## 6. Never
| BidSwipe will never… | Problem |
|---|---|
| Sell a lead, or charge per lead, view, contact or application | R2 |
| Charge anyone to post or bid, or before a job is real | R2, R6 |
| Charge to see or bid public bids, meter Free by count, or price by radius, market or seat | R1 |
| Sell rank or boosts, or give one plan an earlier local-job alert | R2, R4 |
| Say or imply we told someone something outside the app when we did not | R2, honest copy |
| Scrape login-walled boards, ignore robots.txt, use a competitor's data, or harvest third parties' contacts | trust |
| Fabricate bids, counts, urgency, "N viewing", "#1" claims or user numbers | R5, R6 |
| Use streaks, guilt, fake countdowns, win-back pushes, sales calls or SMS, or require a phone number to sign up | R4, R6 |
| Hide a price behind a form | R6 |
| Add bloat: a PM suite, desktop-only estimating, one app per role, or Pro tools on Free's main path | R1, R3 |
| Alert outside trade and reach, re-send a bid, or alert on sub work or capped bids | R4 |
| Advertise a feature that does not work end to end (e.g. phone alerts before X1) | R6 |
| Show a competitor's price, or imply we can see sealed bids | honest copy |

## 7. Sources (all read 2026-11-18; "full" = whole page read, "sum" = search-engine summary only)
- [PH2] https://planhub.com/pricing-subcontractors/ (full) · [PH3] https://planhub.com/subcontractors/ (full)
- [PH4] https://planhub.com/pricing-general-contractors/ (full)
- [PH7] https://apps.apple.com/us/app/itb-inbox/id6741428619 (sum) · [PH8] https://apps.apple.com/us/app/planhub/id1631169350 (sum)
- [PH9] https://www.capterra.com/p/179042/PlanHub/reviews/?page=16 (sum)
- [PH10] https://www.capterra.com/p/179042/PlanHub/reviews/?page=5 (sum) · [PH11] https://www.capterra.com/p/179042/PlanHub/reviews/?page=7 (sum)
- [PH12] https://www.g2.com/products/planhub/reviews (sum) · [PH13] https://www.capterra.co.uk/software/179042/planhub (sum)
- [PH14] https://www.capterra.com/p/179042/PlanHub/reviews/?page=3 (sum; 2019–2021 reviews)
- [PH15] https://constructionbids.ai/blog/planhub-review-pricing-2026 (sum; written by a competitor)
- [PH16] https://www.capterra.com/p/179042/PlanHub/reviews/ (sum)
- [PH18] https://www.getapp.com/all-software/a/planhub/ (sum) · [PH19] https://planhub.com/construction-bids/ (sum)
- [PH20] https://knowledgebase.planhub.com/knowledge/subcontractors-user-account-and-notifications (sum)
- [CC1] https://www.constructconnect.com/pricing (full) · [CC2] https://www.constructconnect.com/find-contracting-work (full)
- [CC3] https://help.constructconnect.com/project-intelligence-bid-center-document-viewer-bid-management-historical-release-notes-110/removal-match-score-2024-07-24-2623 (sum)
- [CC4] https://help.constructconnect.com/project-intelligence-bid-center-document-viewer-bid-management-historical-release-notes-110/saved-search-emails-2023-12-15-2629 (sum)
- [CC5] https://constructconnect-help.atlassian.net/wiki/x/GAARl (sum) · [CC6] https://www.constructconnect.com/products/bid-center (sum)
- [CC7] https://www.bbb.org/us/oh/cincinnati/profile/computer-software/constructconnect-0292-11047629/complaints (sum)
- [CC8] https://www.trustpilot.com/review/www.constructconnect.com (sum) · [CC9] https://www.trustradius.com/products/constructconnect-insight/reviews/all (sum)
- [CC10] https://www.g2.com/products/constructconnect-project-intelligence/reviews (sum; pages 3, 5, 7, 8)
- [CC11] https://www.selecthub.com/construction-bidding-software/constructconnect/ (sum)
- [CC12] https://www.constructconnect.com/blog/ask-documents-a-faster-way-to-get-clear-answers-from-project-documents (sum)
- [CC13] https://constructconnect-help.atlassian.net/wiki/spaces/PSUPPORT/pages/49119507 (sum) · [CC14] https://constructconnect-help.atlassian.net/wiki/x/iZMO (sum)
- [TB1] https://www.toolbelt.work/ (sum) · [TB3] https://www.toolbelt.work/termsconditions/ (sum)
- [TB2] https://knowledge.toolbelt.work/knowledge/how-to-find-work-on-toolbelt (sum)
- [TB4] https://www.toolbelt.work/toolbelt-hire/ (sum; snippet ~150 days old) · [TB5] https://support.careerplug.com/careerplug-partner-toolbelt (sum)
- [TB6] https://play.google.com/store/apps/details?id=com.toolbeltapp&hl=en_US (sum)
- [TB7] https://apps.apple.com/us/app/toolbelt-find-labor-find-work/id1453760963 (sum)
- [TB8] https://apps.apple.com/us/app/toolbelt-labor-platform/id1453760963 (sum)
- [TB9] https://knowledge.toolbelt.work/knowledge/why-dont-i-see-any-work-in-my-area-on-toolbelt (sum)
- [TB10] https://adpsupport.careerplug.com/toolbelt-understanding-a-contractor-profile (sum)
- [TB11] https://www.toolbelt.work/srs/ (sum) · [TB12] https://sidehusl.com/toolbelt/ (sum; third-party, ~19 months old)
- [TB13] https://knowledge.toolbelt.work/knowledge/toolbelt-hire-organic-vs.-toolbelt-match-candidates (sum)
- [X1] https://www.procore.com/pricing (sum) · [X2] https://www.g2.com/products/procore/reviews?qs=pros-and-cons (sum)
- [X3] https://prohelp.homeadvisor.com/leads-faq (sum; a second search returned nothing, so not re-verified)
- [X4] https://ftc.gov/news-events/news/press-releases/2023/01/ftc-order-requires-homeadvisor-pay-72-million-stop-deceptively-marketing-its-leads-home-improvement
- [X5] https://help.thumbtack.com/article/types-of-leads · [X6] https://help.bark.com/hc/en-us/articles/27485031195676-Get-Hired-Guarantee
- [X7] https://ir.angi.com/static-files/128ba500-4f2b-48ac-b408-b951a57fbcdd · [X8] https://construction.autodesk.com/pricing/buildingconnected/
- [X9] https://govcontractfinder.com/guides/agency-vendor-portals (a vendor that sells aggregation)
- [X10] https://federalnewsnetwork.com/?p=4330266 · [X11] https://denvergov.org/Business/Contract-Administration/Process
- [X12] https://infotechinc.com/bid-express-fee-schedule · [X13] https://www.gao.gov/products/b-254155-0
- [X14] https://itif.org/publications/2018/08/27/benchmarking-state-government-websites/
- [X15] https://constructiondive.com/news/construction-app-usage-increases-despite-continued-lack-of-integration/592922 (2020 survey, cited second-hand)
- [X16] https://www.contractortalk.com/threads/competition-with-extremely-low-prices.150081/ (anecdote)
- [X17] https://network.demandstar.com/?p=80 · [X18] https://www.wardberry.com/?p=33111
- [E1] https://scholars.duke.edu/publication/1402953 · [E2] https://www.bls.gov/tus/tables/a5-1317.htm
- [E3] https://www.bls.gov/careeroutlook/2015/article/night-owls-and-early-birds.htm · [E4] https://developer.apple.com/design/human-interface-guidelines/notifications
- [E5] https://developer.apple.com/documentation/usernotifications/declaring-your-actionable-notification-types
- [E6] https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html (SC 2.5.5, AAA, 44×44 CSS px; SC 2.5.8, AA, 24×24; page not opened here, sizes from the research pass)
