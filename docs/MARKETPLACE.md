# Local jobs marketplace: the rules as built, and what they mean in law and money

Written 2026-11-14. The rules come from the build contract and the code (`src/jobs/`, `src/routes/jobs.ts`).
The research notes say how each fact was checked:

- **[search]**: from a web-search summary, or from the official text as it appears in a government-law
  search index. This machine could not open the state legislature sites directly today, so **read the linked
  section yourself before you rely on it.**
- **not confirmed**: no source was found. Treat it as a question, not an answer.

**This is information to help you decide, not legal advice.**

---

## 1. The rules as built

| Rule | As built |
|---|---|
| Who | Anyone signed in may post a job and bid on other people's jobs, never their own. One account can do both |
| Open for bids | The poster picks 1, 3, 7 or 14 days (1–30 allowed) |
| Sealed bids | While a job is open, only the bidder sees their own amount. The poster sees only how many bids there are. A bidder may change or withdraw a bid free until closing |
| Who wins | At closing the **lowest bid wins**, automatically. A tie goes to the bid placed first. No bids: the job ends "unfilled" |
| Bid tab | After closing, the amounts are shown ranked to the poster and to everyone who bid. Bidder names are shown only to the poster |
| Contact window | The winner has **7 days** (`JOB_CONTACT_DAYS`) to make contact. A message in the job's thread counts, and so does the poster tapping "They contacted me". Both tap "We've agreed" → agreed. Poster taps "Job done" → completed |
| No-show | Winner never made contact, or gave the job back → job unfilled, **no-show fee** recorded |
| No fee | Poster never answered, no agreement reached, or the poster cancelled after the award → unfilled, no fee. Cancelling while the job is open is free |
| Repost | An unfilled or cancelled job can be posted again with one tap |
| **No-show fee** | **5%** of the winning bid (`JOB_NO_SHOW_FEE_PCT`, 0–10). **2% of the bid** of it is the poster's share (`JOB_POSTER_SHARE_PCT`). BidSwipe keeps the other 3% |
| **Service fee** | **1%** of the winning bid (`JOB_SERVICE_FEE_PCT`, 0–3), owed by the winner when both sides confirm the agreement |
| **Payments** | **Off.** Every fee is one ledger row (`job_fees`, status `recorded`) with its basis and rates. Nothing is collected. The screens say "Fees are not being collected yet." An operator can waive a fee |
| Amounts | $20.00 to $250,000.00 (`JOB_MAX_CENTS`). A bid above the poster's optional budget is refused |
| Privacy | The public place is city, state and ZIP only. The street address and phone go only to the poster, and to the winner after the award. Messages exist only between the poster and the winner after the award |
| Safety | Anyone can report a job. An operator can remove it everywhere. Posting (10 an hour), bidding (30 per 10 minutes), messages and reports are rate-limited per account |

Example, on a **$1,000.00** winning bid: no-show fee $50.00 (the poster's share is $20.00, BidSwipe keeps
$30.00). Service fee if they agree: $10.00.

---

## 2. Contractor licences

### Nevada

- **The small-job exemption is $1,000.** NRS 624.031 says the licensing chapter does not apply to *"Any work
  to repair or maintain property the value of which is less than $1,000, including labor and materials,
  unless: (a) A building permit is required to perform the work; (b) The work is of a type performed by a
  plumbing, electrical, refrigeration, heating or air-conditioning contractor; (c) …"* [search:
  [NRS 624](https://www.leg.state.nv.us/NRS/NRS-624.html)]. Clause (c) and the rest were cut off in the
  snippet. North Las Vegas's guide adds that the work must not be **part of a larger project** [search:
  [North Las Vegas "Blue Book" C-17](https://www.cityofnorthlasvegas.com/home/showpublisheddocument/5856/638221834482500000)].
  So in Nevada **any electrical job needs a licence, however small.** That matters for the pilot's own trade
  and for Ev's "small electrical job for the nanny" example.
- **Bidding counts as contracting.** In NRS 624.020, a contractor is anyone who *"undertakes to, offers to
  undertake to, purports to have the capacity to undertake to, or submits a bid to"* do the work [search:
  [NRS 624](https://www.leg.state.nv.us/NRS/NRS-624.html)]. An unlicensed person placing a bid in BidSwipe on
  a job that needs a licence may be breaking that rule, not only by doing the work.
- **Advertising:** NRS 624.720(3): *"All advertising by a licensed contractor must include the name of the
  contractor's company and the number of the contractor's license."* The Board watches Craigslist, Angie's List
  and online boards [search: [NSCB newsletter, 2015](http://epubs.nsla.nv.gov/statepubs/epubs/606549-2015-08.pdf)].
  A BidSwipe work profile that says "electrician" is arguably an advertisement. Not confirmed how the Board
  treats in-app profiles.
- **Bigger thresholds are coming but are not in force.** SB 158 (2025), which would have raised the exemption
  to $5,000, failed in committee [search: [SB 158](https://leg.state.nv.us/Session/83rd2025/Bills/SB/SB158.pdf)].
  A 2025 law requires the Board to adopt rules **by January 1, 2027** for a *restricted* licence with a
  **$7,000** limit, labor and materials included [search: [2025 Statutes of Nevada](https://www.leg.state.nv.us/Statutes/83rd2025/Stats202515.html)].
  Not confirmed whether it can be applied for yet.

### California

- **The small-job exemption is under $1,000** since 2025-01-01 (it was $500). B&P Code 7048: no licence is
  needed when *"the aggregate contract price for labor, materials, and all other items is less than one
  thousand dollars ($1,000) … and the work or operation does not require a building permit"* [search:
  [BPC 7048](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=7048),
  [AB 2622](https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202320240AB2622)].
  Secondary sources say it also does not apply when the person hires help (not confirmed).
- **Advertising:** B&P 7027.2: an unlicensed person *"may advertise for construction work … only if the
  aggregate contract price … is less than one thousand dollars ($1,000)"* [search:
  [BPC 7027.2](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=7027.2)],
  and the ad must say they are not licensed [search: [Justia copy](https://law.justia.com/codes/california/code-bpc/division-3/chapter-9/article-2/section-7027-2/)].
  CSLB's own online-marketplace fact sheet still said $500 when it was last indexed [search:
  [CSLB fact sheet](https://www.cslb.ca.gov/Resources/IndustryBulletins/Online_Marketplace_Fast_Facts.pdf)].
- Contracting without a licence when one is needed is a misdemeanor [search:
  [BPC 7028](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=7028)].

### Other states

Every state draws the line somewhere else. Third-party guides list Arizona at $1,000, Florida at $2,500 and
Washington at $500, and Utah has paperwork between $3,000 and $7,000 [search:
[guide](https://contractorlicenserequirements.com/trades/handyman/)]. None of these were checked against
the statutes. Electrical and plumbing are usually excluded whatever the amount, and cities can be stricter.
**So one line telling people to check their own state is the honest choice.** BidSwipe cannot apply 50
rule sets. The jobs allow up to $250,000, so most of them will be far above every exemption.

---

## 3. A yardstick for the 5%: bid security on public work

Public agencies make bidders put money up **before** the opening, and keep it if the low bidder walks away:

- **Federal (FAR 28.101-2):** *"The bid guarantee amount shall be at least 20 percent of the bid price but
  shall not exceed $3 million"* [search: [FAR 28.101-2](https://www.acquisition.gov/far/28.101-2)].
- **Nevada highways (NRS 408.337):** *"cash or a certified check in an amount equal to at least 5 percent of
  the amount bid"*. If the second or third bidder later refuses too, their security is *"likewise forfeited to
  the State"* [search: [NRS 408](https://www.leg.state.nv.us/nrs/NRS-408.html)].
- **Nevada state purchasing (NRS chapter 333):** a vendor who does not perform is liable for *"a penalty of
  not more than 5 percent of the total value of the bid or contract"*. The section number was not shown
  [search: [NRS 333](https://www.leg.state.nv.us/nrs/NRS-333.html)].
- **California cities (PCC 20170/20172):** cities ask for 10% bid security, which is forfeited to the city if
  the winner does not sign [search: [City of Belmont bid documents](https://www.belmont.gov/home/showpublisheddocument/22091/638122309940930000),
  [PCC 20172](https://legalfix.com/statutes/state-codes/california/code-pcc/division-2/part-3/chapter-1/article-4/section-20172)].

**So 5% sits at the low end of what public owners charge.** One big difference: they hold the money first.
BidSwipe would be billing someone afterwards, which is harder to collect and easier to dispute.

## 4. When a fee for breaking an agreement holds up

In plain words: a court will usually enforce a fixed fee for backing out **when it was a fair guess, made up
front, of the real harm, and when the real harm was hard to put a number on**. It will not enforce one that
works as a punishment. California writes this down in Civil Code 1671. Between businesses the fee is valid
unless the challenger shows it was unreasonable. In a **consumer** contract it is presumed void unless the
side charging it shows it was a genuine attempt to estimate a fair average of the damage [search:
[Civil Code 1671](https://california.public.law/codes/civil_code_section_1671)]. Nevada's rule was not
researched.

What helps BidSwipe's version:

- The amount is shown **before** the bid is placed, and the bidder ticks agree (`agree: true`).
- A reason for each part: the poster's 2% stands for their lost week, and the 3% for the cost of rerunning the job.
- A small, flat percentage, with no fee when the poster is the one who disappears.
- Being able to waive it (already built).

Which test applies to a solo worker bidding on a homeowner's job is not confirmed.

## 5. Why money should move through a payment company's marketplace product

If BidSwipe takes a bidder's money and passes part of it to a poster, it is moving other people's money.
Federal rules can treat that as **money transmission**. A "payment processor" exemption exists, but it is
narrow and depends on the facts [search: [Modern Treasury explainer](https://moderntreasury.com/journal/how-do-money-transmission-laws-work),
FinCEN's [administrative rulings](https://www.fincen.gov/resources/statutes-regulations/administrative-rulings/application-money-services-business);
no single ruling was read].
States license money transmitters separately (not researched). A marketplace product such as **Stripe
Connect** exists so the platform never holds the funds: Stripe moves the money, checks who is paid and sends
the tax forms (docs/APIS.md §2). Holding fees in BidSwipe's own bank account and paying posters by hand is
the version to avoid. **Paying the poster's share as BidSwipe credit, not cash, removes the problem**: only
BidSwipe is ever paid.

## 6. Tax reporting

- **Form 1099-K:** payment companies and marketplaces report a payee who receives **more than $20,000 and more
  than 200 payments in a year**. The One Big Beautiful Bill Act restored that line for 2025 onward (it had
  been heading to $600) [search: [Kiplinger](https://www.kiplinger.com/taxes/1099-k-threshold-to-file--what-to-know),
  [Avalara](https://www.avalara.com/us/en/blog/2025/07/one-big-beautiful-bill-act-1099-reporting-threshold.html)].
  With Stripe Connect, Stripe gathers the tax details and files the forms for payees (how it divides the work
  with the platform: not confirmed).
- With credit instead of cash, no poster gets a form. BidSwipe's own fee income is ordinary business income.

## 7. What the app stores say

- **Apple 3.1.3(e):** *"If your app enables people to purchase physical goods or services that will be
  consumed outside of the app, you must use purchase methods other than in-app purchase to collect those
  payments"* [search: [Apple forum quoting the guideline](https://developer.apple.com/forums/thread/687921)].
  The job itself is a real-world service, so its fees go through Stripe and not Apple. **Not confirmed:**
  whether Apple sees BidSwipe's own no-show and service fees as part of a real-world service or as a digital
  service. Ask App Review before the iOS build charges anything.
- **Pro (a digital subscription) inside the iOS app must use Apple's in-app purchase.** The promo-code rule in
  CLAUDE.md already follows this.
- **Google Play:** physical services are not supported by Play billing [search: [Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738)].

---

## 8. What you can handle yourself, and where an hour of a professional is worth it

Most of this you can handle with the sources above. The licence notices are based on the statutes (Nevada: part of the exemption text was not read in full). Stripe
does the identity checks and the tax forms. Giving the poster credit instead of cash keeps you out of money
transmission. Waiving fees while payments are off costs nothing. Two points are worth one paid hour **before
real money moves**, not before. **(1)** The no-show fee: whether a fee charged to a saved card after the fact
will stand up, and what the agree wording and card-saving consent must say. **(2)** The app-store question
about whether BidSwipe's own fees may bypass Apple's in-app purchase. That one goes to Apple's App Review
rather than a lawyer, and it costs nothing to ask.

---

## 9. The licence notice for the post and bid screens

**General (every state), shown when the state rule is not known:**

> Many states require a contractor's licence for work above a small amount or work that needs a permit. Check your state's rules before you post, bid or take a job.

Source: the spread in §2 ("Other states"). Every state checked has a limit, and electrical and plumbing are
usually excluded.

**Nevada (the job's ZIP is in NV):**

> Nevada: a contractor's licence is needed for most work. The only exception is repair or maintenance under $1,000 with labor and materials that needs no permit, is not part of a bigger job, and is not electrical, plumbing, heating, air-conditioning or refrigeration work (NRS 624.031).

The exemption covers only work "to repair or maintain property" [search: the NRS 624.031 snippet]; new work of any size is not exempt. Clause (c) onward was not read in full.

Source: [NRS 624.031](https://www.leg.state.nv.us/NRS/NRS-624.html) and the
[North Las Vegas guide](https://www.cityofnorthlasvegas.com/home/showpublisheddocument/5856/638221834482500000) [search].

**California (the job's ZIP is in CA):**

> California: a contractor's licence is needed for a job of $1,000 or more with labor and materials, any job that needs a building permit, or any job that is part of a bigger job (Bus. & Prof. Code 7048).

The "part of a larger or major operation" condition is from 7048(b), as quoted in bill AB-1170 on leginfo [search].

Source: [BPC 7048](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=7048) [search].
