# Cost engine: cost-model specification

Version 1, written 2026-11-13. Audience: engineers implementing the premium "cost engine" and the "price agent" as pure TypeScript functions with property-based tests.

Scope: take a contractor's own takeoff (hours, crew, quotes) plus dated public tables, build up a complete bid price for a public electrical contract, check it against what the contractor can carry, and suggest a bid range. Everything here is arithmetic with named inputs. Nothing in this file is a price list: public labor-hour units and itemized unit costs by ZIP are paid data and are **not** supplied.

How this file was made: it is a synthesis of eight research briefs and their independent verification passes (notes in the same folder: `bid-cost-structure-notes.md`, `labor-burden-notes.md`, `bonds-retainage-payment-notes.md`, `unit-price-sources-notes.md`, `bid-pricing-math-notes.md`, `cash-float-notes.md`, `time-place-adjustment-notes.md`, `proof-testing-notes.md`). The verifier's corrections are applied. Values the verifier could not confirm are in section 9, not section 8.

Evidence tags used below:

| Tag | Meaning |
|---|---|
| **[R]** | Primary document or data file read directly by a researcher or the verifier |
| **[X]** | Verbatim extract of the primary page returned by a government-document index or search; the whole page was not opened |
| **[S]** | Secondary source or search summary only |
| **law / rate / study / thumb** | Kind: statute, regulation or contract clause / published rate or table / survey or study / rule of thumb |
| **MUST / USUALLY** | MUST = required by law or by a contract clause. USUALLY = estimating convention; the contractor may choose otherwise |

Most statutes and regulations are **[X]**, not **[R]**: the session's network blocked the official hosts. Re-open the URL before any number becomes user-facing copy.

---

## 0. Conventions that every section relies on

### 0.1 Numeric types (money path)

| Type | Unit | Example |
|---|---|---|
| `Cents` | integer cents | $45.00 = `4500` |
| `Ppm` | integer parts per million | 6.2% = `62000`; $25 per $1,000 = `25000`; $2.50 per $100 = `25000` |
| `HoursC` | integer hundredths of an hour | 8.25 h = `825` |
| `QtyM` | integer thousandths of a unit | 2,400 ft = `2400000` |
| `MicroHours` | integer millionths of an hour per unit (labor unit) | 0.035 h/ft = `35000` |
| `Days`, `IsoDate` | integer days, calendar date | |

Rules:

1. No floating point in the money path. Intermediate products are computed in `BigInt` (recommended; it removes the 2^53 limits the verifier hit in rate multiplication and in allocation). Every result returned as a `number` must satisfy `Number.isSafeInteger`, otherwise throw `RangeError`. Largest exact integer: 9,007,199,254,740,991 **[R]**.
2. Negative money, a zero or negative divisor, all-zero weights, or a rate outside its range throw `RangeError`. The engine refuses; it never returns a silently wrong number.
3. Statistics in section 7 (probabilities, percentiles) may use float64. Convert to `Cents` once at the end. Never feed a float back into the money chain.
4. A price quoted per 100 or per 1,000 units is entered by scaling the quantity, not the price.

### 0.2 Primitives

```
divRoundHalfUp(n, d):  q = floor(n/d); r = n - q*d; return (2*r >= d) ? q+1 : q      // n >= 0, d >= 1
mulRate(c: Cents, r: Ppm): Cents           = divRoundHalfUp(c*r, 1_000_000)
mulHours(h: HoursC, rate: Cents): Cents    = divRoundHalfUp(h*rate, 100)
extend(q: QtyM, waste: Ppm, unit: Cents)   = divRoundHalfUp(q*(1_000_000+waste)*unit, 1_000_000_000)
effRate(rate: Ppm, W: Cents, cap: Cents?)  = (cap == null || W <= cap) ? rate : divRoundHalfUp(rate*cap, W)
allocate(T: Cents, w: int[]): Cents[]      // largest remainder, section 2.15
```

Half-up is the default rounding mode and is a **named parameter** (`'half-up'`), because half-even also exists in regulation (NIST Handbook 130 **[X]**). For non-negative amounts half-up equals the Nevada sales-tax rule (section 2.6).

### 0.3 The engine's rounding points

Published worked examples round differently from each other (one DoD form carries unrounded values and rounds for display, another prints whole dollars), so the engine states its own policy:

- Round to the cent **once** at each of: every wage-bucket extension; every payroll-tax and insurance component per labor class; every material line extension; every escalation line; sales tax (once on the taxable base by default); every equipment and job-overhead line; small tools; contingency; home-office overhead; profit; and the total of all price-based charges (section 2.13).
- Totals are sums of rounded lines. Nothing is re-rounded.
- Whole-dollar rounding appears only in (a) the optional final bid rounding (section 2.14) and (b) the SBA fee payable (section 4.4).

### 0.4 Rate base tags

Mixing bases silently is the classic under-pricing error. Every rate the engine stores carries a `base` tag and is rejected without one:

| Tag | Rate multiplies |
|---|---|
| `on_cost` | total job cost TJC (overhead) or TJC + overhead (profit) |
| `on_sales` | the price before price-based charges (revenue basis) |
| `on_labor_cost` | direct labor dollars (state which: cash wages G or burdened labor L) |
| `per_labor_hour` | job labor hours |
| `on_taxable_wages` | taxable cash wages G |
| `per_100_payroll` | workers' compensation payroll |
| `per_1000_receipts` / `on_price` | the contract price including the charge itself |

---

## 1. Inputs

"From" column: **C** = contractor (their takeoff, quotes, policies, notices); **D** = the bid documents for this job (they override every default); **P** = dated public table shipped with the engine (section 8); **A** = labelled assumption, editable, shown to the user as an assumption (section 9). Ranges are engine guards (design choices, not sourced facts).

### 1.1 Job and owner

| Input | Type | From | Guard | Notes |
|---|---|---|---|---|
| `ownerType` | enum `federal`, `federal_aided_local`, `nv_state_spwd`, `nv_local`, `ndot`, `ca_state`, `ca_local`, `caltrans`, `private` | D | required | Selects threshold and timing presets (section 4) |
| `stateOfWork` | `NV`, `CA`, other | D | required | Payroll tables, overtime regime, sales tax |
| `estimatedCost` or magnitude range | Cents or range | D / P | >= 0 | Owner's estimate; federal jobs publish only a range (D-73) |
| `prevailingWage` | `none`, `davis_bacon`, `nv_338`, `ca_dir` | D | | Engine suggests from thresholds; the solicitation decides |
| wage determination per class: `BHR_wd`, `FB_wd` | Cents/h | D | > 0 | From the determination attached to the bid. Do not fetch SAM.gov from the app |
| `bidDate`, `startDate`, `endDate` | IsoDate | D / C | bid <= start <= end | Duration, midpoint, year tables |
| `bondRequired` | `auto`, `yes`, `no`; `perfPct`, `payPct` | D | 0..100% | `auto` applies section 4.2 |
| bid security: `pct`, `cap`, `form` (`bond`/`cash`), `rule` (`difference`/`forfeiture`) | Ppm, Cents, enum | D | | Section 4.1 |
| `liquidatedDamagesPerDay` | Cents | D | >= 0 | No statutory default anywhere |
| `bidItems[]` | list of items with direct cost | D | optional | For distributing indirects (section 2.15) |

### 1.2 Labor takeoff

| Input | Type | From | Guard | Notes |
|---|---|---|---|---|
| `tasks[]`: quantity `Q` | QtyM | C | >= 0 | |
| labor unit `u` | MicroHours per unit | C | > 0 | Contractor's own units. Trade manuals are paid and their units exclude supervision **[S]** |
| productivity factor `pf` | Ppm | C / A | 500,000..5,000,000 | >= 1,000,000 for worse-than-normal conditions; log a reason per task |
| crew mix per task | counts per class | C | >= 0 | |
| or direct hours per class: `h10`, `h15`, `h20` | HoursC | C | 0..10,000,000 | Straight, 1.5x and 2x buckets |
| per class: `w_basic` | Cents/h | C | > 0; >= state minimum where known | Cash basic wage actually paid |
| per class: `w_cil` | Cents/h | C | >= 0 | Fringe paid as cash in lieu (taxable wages) |
| per class: `f_plan`, of which `f_health` | Cents/h | C | 0 <= f_health <= f_plan | **Employer** contributions to bona fide plans only. Employee elective deferrals stay wages |
| per plan: `annualize` flag and annual plan cost / annual hours | bool, Cents, HoursC | C | | Section 2.2 compliance check |
| per class: travel/subsistence `T`, `other_h` | Cents/h | C | >= 0 | Paid time off, training fund, vehicle. Taxable per diem goes in `w_cil` |
| per class: expected annual taxable wages `W` | Cents | C / A | > 0 | Drives wage-base caps. If missing: 2,000 h x `(w_basic + w_cil)`, shown as an assumption |
| `otRegime` | enum, section 2.2 | D / derived | | |
| weekly or daily schedule | hours per day | C | optional | Only for the partition helper |

### 1.3 Burden

| Input | Type | From | Guard | Notes |
|---|---|---|---|---|
| `burdenMode` | `statutory` (annualized), `ytd` (pay period), `flat` | C | default `statutory` | `flat` is an approximation and is labelled so |
| Social Security, Medicare, FUTA tables by year | Ppm, Cents | P | | D-1..D-5 |
| FUTA credit reduction `CR[state][year]` | Ppm | P / A | 0..60,000 | 2026 values not final (A-9) |
| state unemployment rate `r_ui` | Ppm | C (rate notice) | NV 2,500..54,000; CA 15,000..62,000 | Default = new-employer rate (D-7, D-10), labelled |
| Nevada MBT: `mode` (`none`/`marginal`/`average`), `GW_q`, `HC_q` | enum, Cents | C | | Firm-level quarterly tax, D-9 |
| workers' comp: `R_class` | Ppm of payroll (`per_100_payroll`) | C (policy) | 0..1,000,000 | **No default.** Bureau figures are reference only |
| workers' comp: `XMod`, other modifiers | Ppm (1.00 = 1,000,000) | C | > 0 | |
| workers' comp: `policyEffectiveDate`, `excludeOtPremium` | IsoDate, bool | C / P | | Nevada: `false` (D-13) |
| general liability: `basis` (`payroll`/`receipts`), rate | enum, Ppm | C (policy) | | Receipts-rated GL is a price-based charge (section 2.13) |
| `b_flat` | Ppm `on_taxable_wages` | C | 0..2,000,000 | Only in `flat` mode |

### 1.4 Materials

| Input | Type | From | Guard | Notes |
|---|---|---|---|---|
| per line: `q`, `unitPrice`, `waste` | QtyM, Cents, Ppm | C (quote) | waste 0..500,000 | No labor is charged on the waste quantity |
| per line: `taxable` | bool | C | default true | State rules decide |
| per line: `quotedOn`, `holdThrough`, `purchaseDate` | IsoDate | C | | Escalation and staleness (section 6) |
| per line: `ppiSeriesId` | string | P (registry) | optional | For aging a dated quote |
| per line: supplier terms: `depositPct`, `depositDate`, `netDays` | Ppm, IsoDate, Days | C / A | | Cash model (section 5) |
| `freight`, `freightTaxable` | Cents, bool | C / A | | Freight taxability is state-specific and unverified (A-17) |
| `salesTaxRate` `s`, `taxBasis` (`total`/`line`) | Ppm, enum | C / D | 0..150,000 | Combined state + local rate at the taxing location. **No default rate shipped** |
| forward escalation rate `r_fwd` | Ppm per year | C | 0..500,000 | **No default** (A-21) |

### 1.5 Equipment, subcontracts, job overhead

| Input | Type | From | Notes |
|---|---|---|---|
| equipment lines: hours x rate, or rental lump sums incl. fuel | HoursC, Cents | C | |
| subcontract and vendor quotes | Cents | C | The sub's full price is a direct cost to you |
| job overhead items: `monthlyCost` x `months`, or one-time | Cents, QtyM | C | Supervision not in labor units, PM time, permits and fees, temporary power, testing, submittals, cleanup, mobilization, project insurance |

### 1.6 Markups and policy choices

| Input | Type | From | Guard | Notes |
|---|---|---|---|---|
| overhead `method` | `on_cost`, `on_sales`, `per_labor_hour`, `on_labor_cost`, `dual` | C | required | Section 2.11 |
| overhead rate(s) with base tag, or annual figures `OH_annual`, `DC_annual`, `Sales_annual`, `LH_annual`, `DL_annual`, dual weight `X` | Ppm, Cents, HoursC | C | `o_s + m_s < 1` | **No default.** Published ranges are shown as context only |
| profit `p_c` (on cost + overhead) or `m_s` (on sales) | Ppm | C | 0..1,000,000 | **No default** |
| `m_min` minimum acceptable markup | Ppm | C | >= 0 | Floor for section 7 |
| contingency `c` | Ppm | C / A | 0..500,000 | Default 0 (A-19) |
| small tools `st` | Ppm | C / A | 0..200,000 | 2% published for prime contractors (D-66); base is an interpretation (A-18) |
| `includeFinancingInPrice` | bool | C | default true | Section 2.12 |
| `bidRoundingUnit` | Cents | C | 1, 100, 10000... | Upward only |

### 1.7 Bonds and price-based charges

| Input | Type | From | Notes |
|---|---|---|---|
| bond schedule: tiers `(upperBound, ratePer1000)` | Cents, Ppm | C (surety agent) | If absent: illustrative sample (D-38), shown as an assumption |
| surcharge parameters `M1`, `M2`, `s1`, `s2` | months, Ppm | C / P | D-39 |
| `sbaGuaranteed`, `guaranteeApprovalDate` | bool, IsoDate | C | D-37 |
| other fees proportional to price | Ppm `on_price` | C | Receipts-rated insurance, any gross-receipts tax |

### 1.8 Schedule, billing, payment

| Input | Type | From | Notes |
|---|---|---|---|
| billing cycle `b` | Days | D | Default monthly (D-44) |
| owner payment lag `L_pay` | Days | D / P | 14 federal, 30 Nevada, 30 California (D-44, D-48, D-53) |
| retainage: `rho1`, `theta`, `rho2`, `kappa`, `dollarCap`, `halfRelease`, release lag `L_rel` | Ppm, Cents, bool, Days | D / P | Section 4.5 |
| pay-down lag to subs `L_sub` | Days | D / P | 7 federal and California, 10 Nevada |
| per cost category: timing weights or dated events, payment lag, deposit share and date | | C / A | Section 5 |
| payroll frequency | Days | D / P | Weekly on Davis-Bacon work (D-29) |

### 1.9 Contractor limits

| Input | Type | From | Notes |
|---|---|---|---|
| `cashForJob` | Cents | C | Own cash the owner will commit to one job |
| `unusedCreditLine`, annual rate `i`, `dayCountBasis` (360/365) | Cents, Ppm, int | C | No default rate. Prime is context (D-60) |
| safety buffer `beta` | Ppm | C / A | A-27 |
| `maxJobSize`, `maxUpFrontCash` | Cents | C | The contractor's own rules |
| surety letter: `singleLimit`, `aggregateLimit`; `backlogRemaining` | Cents | C | If no letter: rule-of-thumb estimate only (A-3) |
| working capital `WC`, net worth `NW`, current assets and liabilities | Cents | C | Informational flags only |

### 1.10 Time and place

| Input | Type | From | Notes |
|---|---|---|---|
| index registry: series id, exact title, source, frequency, reference base, preliminary flag per value | | P | Section 6.5 |
| area cost factor table (one edition) | | P | Context only, never a multiplier on a takeoff |
| wage ratio inputs (same measure, same period, two areas) | Cents | P | Labor dollars only |

### 1.11 Bid selection

| Input | Type | From | Notes |
|---|---|---|---|
| history of comparable lettings: anchor, lowest competing bid, bidder count, our cost estimate, our bid, won/lost, agency class, size band, trade | | C / P | Bid tabulations plus the contractor's own records |
| competitor count `n` or distribution `g(k)` | | D / P / C | Nevada small works: statutory minimum (D-70) |
| estimating error `sigma`, common-value share `kappa` | float | C / A | A-23 |
| tolerance `delta`, display thresholds | float, int | A | A-24, A-25 |
| preference status: ours and competitors' | flags | C / D | Section 7.1 |

---

## 2. Cost build-up (ordered formulas, takeoff to bid price)

Order of operations is settled by government estimating guides (DoD UFS 3-740-05, 2 Feb 2026 **[R]**; it is written for the Government's own estimate and is non-mandatory, so it is used for structure and test vectors, never for default rates). Each step names its base.

### 2.1 Labor hours (USUALLY)

```
H_task (HoursC) = divRoundHalfUp(Q * u * pf, 10^13)      // QtyM * MicroHours * Ppm -> hundredths of an hour
H_class         = sum over tasks of H_task * (n_class / n_crew)        // or entered directly as h10/h15/h20
```

Waste never changes hours. Labor units exclude supervision: a non-working foreman, general foreman and PM time are separate lines in job overhead (2.9) or separate labor lines.

Productivity as a ratio (DoD example, **[R]**): `pf = normal productive minutes / actual productive minutes` (430 productive minutes of 480 paid = 100%).

### 2.2 Cash wages by overtime regime (MUST for the legal minimums)

Per class: taxable straight-time cash `w_tax = w_basic + w_cil`. Cash paid for one hour in each bucket:

| `otRegime` | Applies when | `pay_10` | `pay_15` | `pay_20` | Plan fringe |
|---|---|---|---|---|---|
| `FLSA` | Private work, or public work with no prevailing-wage or state daily rule; hours over 40 in the workweek | `w_tax` | `1.5 * w_tax` | n/a | `f_plan` on every hour; excluded from the regular rate |
| `NV_PRIVATE` | Nevada, not prevailing-wage. Weekly over 40 for everyone; daily over 8 **only** if the rate is below 1.5 x minimum wage ($18.00, D-28), unless an agreed 4x10 schedule | `w_tax` | `1.5 * w_tax` | n/a | same |
| `NV_PUBLIC` | Nevada public work with estimated cost >= $100,000 (D-30). Over 40 in the week **or** 8 in a workday (4x10 exception; a collective agreement's own terms govern if it has them) | `w_tax` | `1.5 * (w_basic + w_cil + f_plan) - f_plan` | per wage-determination footnotes | `f_plan` on every hour |
| `CA_PRIVATE` | California private. 1.5x over 8 in a workday, over 40 in the workweek, first 8 h on the 7th day of work in the workweek; 2x over 12 in a day and over 8 on that 7th day; no pyramiding | `w_tax` | `1.5 * w_tax` | `2 * w_tax` | same |
| `CA_PUBLIC` | California public work. Over 8 per day and 40 per week | `w_tax` | `1.5 * max(BHR_wd, w_basic) + w_cil` | per determination | employer payments at straight rate on every hour |
| `DAVIS_BACON` | Federal or federally assisted construction with a wage determination. Over 40 in the workweek | `w_tax` | `w_tax + 0.5 * basicRate` | n/a | fringe (cash or plan) owed on every hour at straight rate |

Notes that change results:

- `DAVIS_BACON`: `basicRate = max(BHR_wd, w_basic)`. Flag `cashInLieuCountsAsBasic`: if set, `basicRate = w_tax` (DOL describes cases where the contractor gets no exclusion). The **name of the governing overtime law** depends on contract size: CWHSSA only above $100,000 (above $150,000 for contracts under federal acquisition rules); at or below that it is the FLSA (D-27). The arithmetic is the same. Nevada and California daily rules still apply on federal jobs in those states.
- `NV_PUBLIC`: the 1.5x multiplier on base **plus** fringe is the Labor Commissioner's handbook reading **[X]**. Zone pay is added to the hourly rate before the multiplier.
- Seventh-day rule (California): keyed to the employer's fixed workweek, not any seven consecutive days.
- Minimums only. The specific wage determination's footnotes (double time, shift premiums) override.

Wages for class k on the job:

```
G_k (Cents)    = mulHours(h10, pay_10) + mulHours(h15, pay_15) + mulHours(h20, pay_20)
OTprem_k       = mulHours(h15, pay_15 - pay_10) + mulHours(h20, pay_20 - pay_10)
H_k            = h10 + h15 + h20
```

Prevailing-wage compliance check (MUST, law): for every hour, including overtime hours,

```
w_basic + w_cil + planCredit >= BHR_wd + FB_wd
planCredit (annualized) = annual cost of the bona fide plan for the worker / all hours the worker worked that year (public and private)
```

Per-plan flag `annualize`: `false` for plans the rules except (federal: defined-contribution pension plans with immediate participation and essentially immediate vesting; Nevada NRS 338.035: workers whose benefits are set by a collective bargaining agreement, and defined-contribution plans up to 25% of the hourly prevailing rate, D-31). Payroll taxes and workers' comp are never creditable fringe. A failed check is an error, not a warning.

Partition helper (pure): `partitionHours(regime, hoursByDay[7]) -> {h10, h15, h20}`. Invariant: the buckets sum to hours worked and no hour is counted twice.

### 2.3 Labor burden (MUST for statutory rates; a direct cost, never overhead)

Burden is not a flat percentage: wage-base caps make it fall as annual wages rise. Three modes.

**Mode `statutory` (default, for bidding).** Per class, with `W` = expected annual taxable wages of a representative worker with this employer, and the table year = the calendar year the wages are paid (split hours by year when the job spans a year end, or use the start year and show a warning):

```
te_ss    = effRate(62_000, W, SSB[year])                     // Social Security, employer share
te_med   = 14_500                                            // Medicare, no cap; Additional Medicare is employee-only: 0
te_futa  = effRate(6_000 + CR[state][year], W, 700_000)      // 6.0% - 5.4% credit + credit reduction, first $7,000
te_suta  = NV: effRate(r_ui + (r_ui == 54_000 ? 0 : 500), W, B_NV[year])      // UI + Career Enhancement Program
           CA: effRate(r_ui + r_ett, W, 700_000)             // SDI is employee-paid: employer cost 0
SS_k   = mulRate(G_k, te_ss)     MED_k  = mulRate(G_k, te_med)
FUTA_k = mulRate(G_k, te_futa)   SUTA_k = mulRate(G_k, te_suta)
```

Nevada Modified Business Tax (firm-level, quarterly; **not** per worker):

```
MBT_q   = mulRate(max(0, GW_q - HC_q - 5_000_000), 11_700)                 // the tax itself
marginal mode:  t_mbt = (GW_q - HC_q > 5_000_000) ? 11_700 : 0
average mode:   t_mbt = divRoundHalfUp(MBT_q * 1_000_000, GW_q)
MBT_k   = mulRate(max(0, G_k - mulHours(H_k, f_health)), t_mbt)            // health benefits are deducted from the base
```

A small shop under $50,000 of quarterly wages owes zero; allocating 1.17% to every job overstates its cost. The allocation mode is a costing choice (USUALLY), the tax is law.

Workers' compensation (rates from the contractor's policy; law for the Nevada payroll rules):

```
P_wc_k   = G_k - (excludeOtPremium ? OTprem_k : 0)           // Nevada: excludeOtPremium = false
capShare = Nevada only: min(W_wc, Cap_NV) / W_wc             // W_wc = worker's annual WC payroll; Cap_NV by policy date (D-12)
WC_k     = divRoundHalfUp(P_wc_k * R_class * XMod * mods * min(W_wc, Cap), 10^18 * W_wc)     // one rounding
California class: 5140 if regular hourly wage >= threshold (D-14), else 5190; payroll not shown to meet it goes to 5190
```

Plan contributions (bona fide plans) are outside workers' comp payroll and outside Social Security, Medicare and FUTA wages; cash in lieu of fringe is inside all of them. The workers' comp side of that rests on bureau manual rules whose wording was not opened (A-12).

General liability, if payroll-rated: `GLp_k = mulRate(G_k, R_gl)`. If receipts-rated it is a price-based charge (2.13).

**Mode `ytd` (costing one pay period).** For each capped tax with year-to-date wages `Y`: taxable slice `= min(Y + pay, cap) - min(Y, cap)`; tax `= mulRate(slice, rate)`. The slices sum to `min(W, cap)` exactly.

**Mode `flat`.** `Burden_k = mulRate(G_k, b_flat)` replaces SS, Medicare, FUTA, SUTA and MBT. Workers' comp and plan fringe stay separate. Labelled "approximation: one flat percentage".

Handbook closed form (flat mode, used for the DoD golden rows): `R = (B*(1+ot) + F_taxable)*(1+ti) + F_plan + T`, carried unrounded and rounded at the end. The verifier's correction is the `F_taxable` term: fringe paid in cash is burdened (B = 40, F = 20 in cash, ti = 0.15: the uncorrected formula is short by $3.00/h).

### 2.4 Direct labor total

```
FR_k = mulHours(H_k, f_plan)        TR_k = mulHours(H_k, T)        OTH_k = mulHours(H_k, other_h)
L_k  = G_k + SS_k + MED_k + FUTA_k + SUTA_k + MBT_k + WC_k + GLp_k + FR_k + TR_k + OTH_k
L    = sum_k L_k            G = sum_k G_k            H = sum_k H_k
```

Display only: composite rate `L_k / H_k`.

### 2.5 Small tools and consumables (USUALLY)

`ST = mulRate(L, st)`. Base = burdened direct labor `L` (our reading of "direct labor cost", A-18). It must not also sit inside the overhead rate.

### 2.6 Materials (MUST for tax liability; USUALLY for the rest)

```
ext_i   = extend(q_i, waste_i, unitPrice_i)
esc_i   = mulRate(ext_i, e_i)          // e_i from section 6.2; 0 if a price hold covers the purchase date
M       = sum ext_i       ESC_M = sum esc_i       FRT = freight not included in quotes
TB      = sum over taxable lines (ext_i + esc_i) + (freightTaxable ? FRT : 0)
TAX     = mulRate(TB, s)               // taxBasis 'total' (default);  'line' = sum of mulRate(ext_i + esc_i, s)
MAT     = M + ESC_M + TAX + FRT        // non-taxable material is kept: only TB is taxed, MAT contains all of M
```

- Sales tax is a direct cost of materials. In Nevada the research says the contractor is the consumer and pays tax on materials even for an exempt owner; that bulletin was not independently read (A-16).
- Nevada rounding (NRS 372.366 **[X]**, law): tax "computed to the third decimal place and rounded to a whole cent using a method that rounds up to the next cent if the numeral in the third decimal place is greater than 4". Under a truncate-then-round reading this equals half-up exactly; a round-to-three-decimals-first reading differs in about 5% of cases (A-15). The statute allows per-item or per-invoice computation; they differ by cents; the engine picks one and says which.
- Escalation is a separate labelled line, not contingency. Never escalate a forward-priced quote again.

### 2.7 Equipment

`E = sum mulHours(hours, rate) + sum rental lump sums (incl. fuel)`.

### 2.8 Subcontracts and vendor quotes

`SUB = sum of quotes`. The sub's price already contains its own overhead, profit and bond.

### 2.9 Job (field) overhead, itemized by duration (USUALLY)

`JOOH = sum extend(months_i, 0, monthlyCost_i) + sum one-time items`. Permits, plan review, inspection and utility fees, testing, as-builts, mobilization (when it is not its own bid item) are lines here. A flat percentage "may be used for early design stages, but it is not an accurate or reliable method" (UFS 3-740-05 para 10-1.2 **[R]**).

### 2.10 Labor escalation, contingency, total job cost

```
ESC_L = mulRate(G_notScheduled, e_L)     // only wages not already priced at a known future rate
DC0   = L + ST + MAT + E + SUB + JOOH + ESC_L
CONT  = mulRate(DC0, c)                  // bidder's risk allowance; default c = 0
TJC   = DC0 + CONT                       // total job cost (prime cost)
```

Placing escalation and contingency before overhead is convention; the guides only require separate labelled lines. Owner-side design contingencies must never be applied to a bid from finished plans.

### 2.11 Home-office overhead (USUALLY; no law caps it on a sealed fixed-price bid)

Home-office (G&A) only. Field overhead is already itemized in 2.9; applying a combined field-plus-office percentage on top of it counts field overhead twice.

| `method` | Formula | Rate source |
|---|---|---|
| `on_cost` | `OH = mulRate(TJC, o_c)` | `o_c = OH_annual / DC_annual` |
| `on_sales` | `S0 = divRoundHalfUp(TJC * 10^6, 10^6 - o_s - m_s)`; `OH = mulRate(S0, o_s)`; `PR = S0 - TJC - OH` | `o_s = OH_annual / Sales_annual`; requires `o_s + m_s < 1` |
| `per_labor_hour` | `OH = mulHours(H, oh_per_hour)` | `oh_per_hour = OH_annual / LH_annual` |
| `on_labor_cost` | `OH = mulRate(L or G, oh_on_labor)` | `oh_on_labor = OH_annual / DL_annual`, same labor measure in both |
| `dual` | `OH = mulRate(L, r_L) + mulRate(TJC - L, r_M)` | `r_M = OH_annual / (X*L_annual + MS_annual)`, `r_L = X * r_M`, `X > 1` chosen by the contractor |

Break-even cost before price-based charges: `BE = TJC + OH`.

A percentage quoted on revenue must not be entered as a rate on cost: `o_s = 10%`, `m_s = 5%` gives `o_c = 11.7647%`; using 10% on cost under-recovers. Published overhead ranges (3% to 10% of contract amount, 7% to 20% of volume) are on **revenue**.

### 2.12 Profit and the financing line (USUALLY)

```
PR  = mulRate(BE, p_c)                   // on cost + overhead; every guide read applies profit after overhead
                                         // (method on_sales: PR was already set in 2.11 and is not recomputed)
FIN = includeFinancingInPrice ? financing cost from section 5.6 computed at the price without FIN : 0
S   = BE + PR + FIN                      // price before price-based charges
```

`FIN` is a one-pass figure (adding it raises receipts and lowers interest slightly, so the true fixed point is a little lower); it errs on the safe side and is labelled an approximation. It is shown as its own line, not hidden in overhead: on negotiated federal work interest is not an allowable overhead expense **[R]**. Placing it after profit is our convention.

Reference calculator only (never a default, never a cap on a bid): DoD weighted-guidelines profit `p = sum_i rate_i * w_i` with weights 0.03 to 0.12 (D-67).

### 2.13 Charges priced on the contract price (bond premium, SBA fee, receipts-rated insurance)

Applied last, on the price that includes them. One function, **rounded once**:

```
tier(P)  = sum_k r_k * max(0, min(P, b_k) - b_{k-1})          // marginal tiers, b_0 = 0, last b = infinity; r_k in Ppm -> cents * 10^6
m_dur    = 10^6 + s1 * max(0, min(Mo, M2) - M1) + s2 * max(0, Mo - M2)   // Ppm (1.00 = 10^6); s1, s2 in Ppm per month; requires M2 >= M1
q(P)     = divRoundHalfUp( m_dur * tier(P) + f * P * 10^6 , 10^12 )      // f = sum of Ppm fees on price; everything in ONE rounding
P        = the smallest integer with  P - q(P) >= S
```

In the prose below, `m_dur`, `r_k` and `f` are read as fractions (1.08, 0.025, 0.006).

- Existence and uniqueness (proof, mathematics): if `m_dur * max_k(r_k) + f < 1`, then `P - q(P)` rises by 0 or 1 cent per extra cent of `P`, so an exact solution `P - q(P) = S` exists and binary search finds it. Use the **maximum** tier rate in the condition (user schedules need not decrease). Search window: `hi = floor((S+1) / (1 - m_dur*r_max - f)) + 2`. Throw if the condition fails or the result does not satisfy `P - q(P) = S`.
- Rounding the base premium and the duration surcharge separately breaks the step property (the verifier found 800 downward steps). Fold the surcharge into the rates and round once.
- Never implement the whole-amount bracket form `r_k * P`: it is discontinuous at breakpoints.
- Reported split: `premium = divRoundHalfUp(m_dur * tier(P), 10^12)`, `otherCharges = q(P) - premium`, so the parts add to `q(P)`.
- Single flat rate, no rounding: `P = S / (1 - b)`. `P = S * (1 + b)` is only an owner-side approximation (it under-recovers by about `b^2 * S`).
- `Mo` = contract duration in months. Treatment of part months is not in the source; the engine uses whole months rounded up (A-6).
- `bondRequired = auto`: compute `P_nobond` with the bond tiers removed. If `P_nobond` exceeds the threshold in section 4.2, recompute with tiers. The jump at the threshold is intentional (invariant 61).

### 2.14 Optional bid rounding

`P_bid = ceil(P / unit) * unit`. Upward only; the difference is added to the profit line and shown.

### 2.15 Distribution of indirects to bid items (USUALLY)

```
indirectTotal   = P_bid - sum DC_item              // overhead + profit + financing + price-based charges (+ mobilization when it has no item)
indirect_item   = allocate(indirectTotal, DC_item) // proportional to direct cost; largest remainder
price_item      = DC_item + indirect_item          // items sum to P_bid exactly
```

`allocate(T, w)`: `floor_i = floor(T*w_i / W)`; hand the leftover `T - sum floor_i` one cent at a time to the lines with the largest remainders `(T*w_i) mod W`, ties to the lowest index. Use `BigInt` for `T*w_i` (with weights in cents a $1,000,000 total over a $950,000 weight overflows a double). Costs incurred regardless of optional items go on base-bid items only. Do not front-load the schedule of values: a federal bid "so unbalanced as to be tantamount to allowing an advance payment" can be rejected **[X]**.

### 2.16 What each percentage applies to

| Percentage | Base | Kind |
|---|---|---|
| Social Security 6.2%, Medicare 1.45% | taxable cash wages `G`, Social Security up to the wage base per employee per year | law |
| FUTA, state unemployment (+ Nevada CEP, + California ETT) | taxable cash wages up to each wage base per employee per year | law |
| Nevada MBT 1.17% | firm's quarterly gross wages minus employer-paid health benefits, above $50,000 | law |
| Workers' comp rate | WC payroll per $100 (Nevada: includes overtime pay, capped per employee per policy year) x experience mod | policy / law |
| Small tools `st` | burdened direct labor `L` | convention |
| Waste | material quantity | convention |
| Sales tax `s` | taxable materials including their escalation (and freight if taxable) | law |
| Escalation `e_i` | the dated line it belongs to | convention |
| Contingency `c` | direct cost before contingency `DC0` | convention |
| Overhead `o_c` | total job cost `TJC` | convention |
| Profit `p_c` | `TJC + OH` | convention |
| Bond tiers, SBA fee, receipts-rated GL | contract price including the charge | surety filing / law / policy |
| Retainage | each gross progress payment | law / contract |

---

## 3. Identities and conversions

All of these are algebra (re-derived by the verifier). Tests in section 10.

**3.1 Markup versus margin.** With cost `C` and price `P` (always state which cost: direct cost gives gross figures, cost plus overhead gives net):

```
markup k = (P - C)/C        margin m = (P - C)/P
m = k/(1 + k)               k = m/(1 - m)               P = C*(1 + k) = C/(1 - m)
```

For `k >= 0`: `0 <= m < 1` and `m <= k`. A 20% markup is a 16.67% margin, never 20%. Published check: cost $0.70, price $1.00 gives markup 42.86% and margin 30% **[X]**.

**3.2 Multiplicative stack.** Before price-based charges, `S = TJC*(1+o_c)*(1+p_c)` (plus `FIN`). The product does not depend on the order of the multipliers, but `(1+o)(1+p) > 1+o+p` whenever `o*p > 0`: adding the two percentages under-prices by `TJC*o*p`.

**3.3 Revenue basis to cost basis.** From `Sales = Direct + Overhead + Profit`:

```
S   = TJC / (1 - o_s - m_s)                      requires o_s + m_s < 1
o_c = o_s / (1 - o_s - m_s)       p_c = m_s / (1 - m_s)       (1 + o_c)*(1 + p_c) = 1/(1 - o_s - m_s)
```

**3.4 Overhead recovery.** Pricing every job at `o_c = OH_annual/DC_plan` recovers `OH_annual * DC_actual/DC_plan`: exactly the overhead when volume meets plan, and a shortfall linear in the volume shortfall. Labor-hour allocation: `sum_jobs(oh_per_hour * H_job) = OH_annual` when `sum H_job = LH_annual`. Dual rate: `r_L*L_annual + r_M*MS_annual = OH_annual` exactly, by construction. Daily office overhead of one job (federal delay-claim form, also a useful "what does a day cost" number): `(contract billings / total billings in the period) * total home-office overhead in the period / days of performance`.

**3.5 Break-even.**

```
units:      BE_units = FC / (price_u - vc_u)
revenue:    BE_revenue = OH_annual / (1 - DC_annual/Sales_annual)        // fixed cost over gross-margin ratio
this job:   break-even price = grossUp(TJC + OH)                         // section 2.13 applied to BE, with PR = FIN = 0
```

Profit as a function of revenue, `revenue*grossMarginRatio - OH_annual`, is zero at `BE_revenue`, negative below, positive above.

**3.6 Overtime premium percent** (flat-mode input `ot`): `ot = sum_k(OT_hours_k * (mult_k - 1)) / hours_worked`. Eight overtime hours at 1.5x in a 48-hour week is exactly 4/48 = 8.33%.

**3.7 Capped tax.** `T(r, B, W) = r*min(W, B)`; per-period accrual `dT = r*(min(Y1, B) - min(Y0, B))` telescopes to the annual figure. Effective rate `T/W` equals `r` while `W <= B` and is non-increasing in `W`.

**3.8 Per-line versus total rounding.** `abs(sum_i round(r*x_i) - round(r*sum_i x_i)) <= floor(n/2)` cents over `n` lines or pay periods. It is usually not zero, which is why the IRS has a "fractions-of-cents" adjustment **[X]**. State bounds in tests, never equality.

**3.9 Rounding-error tolerance for the whole chain.** Each rounding moves a value by at most half a cent, and every later step multiplies by a non-negative gain, so

```
abs(S - S_exact) <= 0.5 * sum over rounding operations j of gain_j ,      gain_j = d S / d (value_j)
abs(P - P_exact) <= abs(S - S_exact) / (1 - m_dur*r_max - f) + 1
```

`gain_j` is the product of the downstream multipliers, for example `(1+c)*(1+o_c)*(1+p_c)` for any direct-cost line, times `(1+s)` for a taxable material extension, times `(1 + te_ss + te_med + te_futa + te_suta + t_mbt + wcRate + glRate)*(1+st)` for a wage bucket. The prototype chain proved by the verifier is the special case `[nL*(1.5+0.5b) + nM*(1+0.5t)]*(1+oh)*(1+p) + 0.5*(1+p) + 0.5` cents (it held in 120,000 exact cases, worst case 95.4% of the bound). Use this as the tolerance in scaling and metamorphic tests instead of a guessed epsilon. The general form is derived here from the same argument; the differential test against the exact reference (section 10, invariant 20) is what confirms the code.

---

## 4. Bonds, retainage and payment timing

Every statutory percentage below is a minimum or a maximum, not the number on a given job. **A value read from the bid documents overrides every preset.** At the pilot's $10,000 to $50,000 job size almost no bond law triggers in Nevada or on federal work; California is the exception (payment bond above $25,000).

### 4.1 Bid security

```
S_bid = required ? min(CAP, max(FLOOR, mulRate(B_basis, p_bid))) : 0
Cost_bidsec = bidBondPremium + (form == cash ? S_bid * i * d_hold / 365 : 0)
```

| Owner | `p_bid` (minimum) | `B_basis` | Cap | When | Evidence |
|---|---|---|---|---|---|
| Federal (FAR 28.101) | 20% | bid price | $3,000,000 | Only when a performance bond is also required: construction contracts exceeding $150,000, or lower if the solicitation requires bonds | law **[X]** |
| Nevada State Public Works (NAC 341) | 5% | base bid + all alternates | none | Bids in excess of $100,000 | law **[X]**; the extract reads "a bond securing the bid and a certified check or cash", re-read before coding which forms qualify |
| NDOT (NRS 408) | 5% | amount bid | none | All bids | law **[X]** |
| Nevada local (NRS 338) | from bid documents | | | The statute sets no percentage | |
| California state (PCC 10167), cities (PCC 20171) | 10% | amount bid | none | | law **[X]** |
| Federally funded state/local (2 CFR 200.326) | 5% | bid price | none | Contracts above the simplified acquisition threshold, when the federal agency has not accepted the recipient's own bonding policy | law **[X]** |

Bid-bond premium default is 0 (convention; A-2). Exposure if awarded and the bidder walks away, with `B_next` = next low responsible bid or the cost of acquiring the work:

| Rule | Exposure |
|---|---|
| Federal (FAR 52.228-1): liable for "any cost of acquiring the work that exceeds the amount of its bid"; the guarantee offsets it | `max(0, B_next - B)`, **not capped** at `S_bid` |
| `difference` (limited to the bond) | `min(S_bid, max(0, B_next - B))` |
| `forfeiture` | `S_bid` |

Which rule Nevada and California bid forms use was not checked: it is an input (A-40).

### 4.2 Performance and payment bonds: who needs them

`penal = pct * C` if `C > threshold`, else 0. Comparisons are strict: exactly $150,000.00 (federal), $100,000.00 (Nevada) or $25,000.00 (California payment bond) does **not** trigger; one cent more does.

| Owner | Trigger on contract price `C` | Performance | Payment | Evidence |
|---|---|---|---|---|
| Federal | `C > $150,000` | 100% of original price, plus 100% of any increase | 100% | law **[X]** (statute text still reads $100,000; $150,000 is the FAR figure and was excluded from the October 2025 inflation adjustment) |
| Federal | `$35,000 < C <= $150,000` | none | payment bond **or** alternative payment protection, 100%, chosen by the contracting officer | law **[X]** |
| Federal | `C <= $35,000` | none | none | |
| Nevada: State, county, city, town, school district, any public agency (NRS 339.025); not NRS 408 work | `C > $100,000` | not less than 50%, fixed by the contracting body (many require 100%) | not less than 50% | law **[X]** |
| Nevada State Public Works subcontractors | sub's work `> max($50,000, 1% of project)` | bond to the Division in an amount it fixes | | law **[X]** |
| NDOT | all contracts | bonds equal to the full contract amount (performance, labor and material, or both) | | law **[X]** |
| California public works | expenditure `> $25,000` | local: from bid documents; State Contract Act: at least 50% | 100% of the total amount payable | law **[X]** |
| Federally funded state/local (2 CFR 200.326) | above the simplified acquisition threshold | 100% | 100% | law **[X]** |

The premium is normally computed on the contract price regardless of the penal percentage **[X]**.

### 4.3 Premium

Formulas are in section 2.13. Parameters:

- Schedule: the contractor's own tiers from their surety agent. Sureties file their own rates; no state sets them **[X]**. Without one, the engine uses the illustrative sample D-38 and labels the result an assumption.
- Duration surcharge presets **[R]**: non-deviating `M1 = 12, s1 = s2 = 1%` of premium per month; deviating `M1 = 12, M2 = 24, s1 = 0.5%, s2 = 1%`; states on the 24-month table (South Carolina, Louisiana, Delaware, Hawaii, Arkansas) `M1 = M2 = 24, s = 1%`.
- True-up at final price (convention): `deltaPremium = premium(C_final) - premium(C_orig)`; additional premium if positive, refund if negative.

### 4.4 SBA surety bond guarantee fee (law)

```
g = guaranteeApprovalDate < 2026-11-30 ? 6_000 : 7_290          // Ppm of contract price: $6.00 or $7.29 per $1,000
feePayable = 100 * divRoundHalfUp(g * C, 10^8)                  // Cents, rounded to the nearest whole dollar; bid-bond guarantees: 0
eligible   = C <= $9,000,000  (federal contracts up to $14,000,000 with a contracting officer's certification)
```

Inside the price fixed point the fee enters as `f = g` (unrounded, one rounding in `q`). The engine also displays `feePayable`; the two differ by at most $0.50. The fee is in addition to the surety's own premium. The notice has an exception clause that could not be read (A-36).

### 4.5 Retainage

Per gross approved progress billing `B_j` on contract price `C`, with cumulative billed `E_j`:

```
E_j      = E_{j-1} + B_j
below_j  = max(0, min(B_j, theta*C - E_{j-1}))        above_j = B_j - below_j
W_j      = mulRate(below_j, rho1) + mulRate(above_j, rho2)
W_j      = min(W_j, max(0, capTotal - grossWithheld_{j-1}))      // capTotal = min(mulRate(C, kappa), dollarCap)
Rel_j    = (halfRelease and j is the first billing with above_j > 0 and rho2 > 0) ? divRoundHalfUp(retainageFromFirstPart, 2) : 0
R_j      = R_{j-1} + W_j - Rel_j                       // retainage held
Pay_j    = B_j - W_j - otherDeductions_j               // received at billDate + L_pay
```

Track gross withheld separately from held so a mid-job release does not reopen room under a cap. Splitting the billing that crosses the switch point pro rata is a modelling convention (A-22); the statute says only "until 50 percent of the work ... has been performed".

| Preset | `rho1` | `theta` | `rho2` | Cap | Release | Kind |
|---|---|---|---|---|---|---|
| Federal default | 0 | | 0 | | | law **[X]**: payment "in full" when progress is satisfactory |
| Federal stress (unsatisfactory progress) | 10% | | 10% | 10% of the approved estimated amount of work | per contract; if silent, 30 days after the contracting officer approves release | law **[X]** |
| Nevada NRS 338.515, best case | 5% | 50% | 0 | | per contract | law **[X]**: 5% until 50% is mandatory; paying without further retainage afterwards is discretionary ("may") |
| Nevada, base case | 5% | 50% | 2.5% | | `halfRelease = true`: before withholding at up to 2.5% the public body must pay 50% of the retainage withheld so far | law **[X]** |
| Nevada, stress (withholding under NRS 338.525) | 5% | 50% | 5% | | earlier retainage may be kept | law **[X]**; the (b) branch was truncated in the extract, read the section in full |
| NDOT (NRS 408) | 5% | | 5% | `min(5% of C, $50,000)` | | law **[X]** |
| California (PCC 7201) | up to 5% | | up to 5% | 5% of contract price | within 60 days after completion; 150% of a disputed amount may be withheld | law **[X]**; higher than 5% allowed when the project is found "substantially complex" and the bid documents say so |
| California local agency using PCC 9203 | 5% | 50% | 0 | | | law **[X]** |
| Caltrans transportation projects (PCC 7202) | 0 | | 0 | | | law **[X]** |

The same Nevada rule applies prime-to-subcontractor (NRS 338.555), including the half release. Nevada pays the contractor quarterly interest on retainage at a bank-quoted rate (an inflow, entered when known).

### 4.6 Payment timing presets (deadlines are maximums for a proper, undisputed request)

| | Federal (FAR) | Nevada public works | California public works |
|---|---|---|---|
| Billing cycle | monthly, or more often if the contracting officer decides | per contract | per contract |
| Progress payment due (`L_pay`) | 14 days after a proper payment request | 30 days after the public body receives the progress bill, or shorter per contract | 30 days after an undisputed, properly submitted request; the agency has 7 days to return an improper one |
| Final payment | 30 days after the later of proper invoice or acceptance | per contract | |
| Retainage release (`L_rel`) | per contract; else 30 days after the contracting officer approves release | per contract (the release section was not read, A-30) | within 60 days after completion |
| Pay subcontractors (`L_sub`) | 7 days from receipt | 10 days after receiving the money | 7 days after each progress payment; 2% per month penalty |
| Interest owed to you when the owner is late | Treasury prompt-payment rate (D-46) | from the 30th day at the statutory rate | 10% per year |
| Wages | at least weekly on Davis-Bacon work | at least semimonthly otherwise | at least twice a month otherwise |
| Bond premium | reimbursed on request inside progress payments after proof of payment | | |

The federal 15-day accelerated payment for small businesses is a goal, not a due date: do not use it as the default lag. Show a +30-day and a +60-day stress case next to every base case; real waits run longer than the legal deadline.

### 4.7 Late-payment interest owed to the contractor (an upside, never a planning assumption)

```
Federal, up to 30 days late:   I = P * (r/360 * d)
Federal, longer:               I = P * (1 + r/12)^n * (1 + r/360 * d) - P        // n whole months, d remaining days
                               r = the Treasury rate in effect on the day after the due date (locked, not reset each half-year)
California progress payment:   I = P * 0.10 * d / 365                            // 365 basis is an assumption (A-30)
California retention:          charge = 0.02 * P * monthsLate
```

### 4.8 Financing cost of retainage

```
simple:        FC = sum_j W_j * i * (t_release - tau_j) / basis  -  interest the owner pays on retainage
uniform case:  FC = rho * C * i * ((T - 1) * Delta/2 + L) / basis        // T equal billings every Delta days, release L days after the last progress receipt
```

`tau_j` = date the withheld money would otherwise have arrived. The day-count `basis` (365 or 360) is an explicit parameter.

### 4.9 Liquidated damages

`LD = lambda * max(0, D_actual - D_allowed)`. `lambda` comes from the contract; there is no statutory default in any of the three jurisdictions. California: a delay-damages clause is unenforceable unless the amount is liquidated and identified in the contract (contracts from 2016-01-01) **[X]**.

---

## 5. Cash carried: peak float, financing cost, and the comparison with the contractor's limits

A dated cash ledger. Cash out per cost category (deposit share at the order date, the rest after a payment lag); cash in per pay application (earned value at each bill date, less retainage, received after the owner's lag; retainage later). The verifier re-implemented the model independently in exact fractions: the worked example, four closed-form cases and 3,000 random jobs agree.

### 5.1 Time grid

`t = 0..H` integer periods of `Delta` days; period 0 = pre-start; work periods `1..D`. **Use `Delta = 1` day with real calendar dates in production** and aggregate to weeks only for display. On a coarser grid convert inflow lags with `ceil(days/Delta)` and outflow lags with `floor(days/Delta)`: rounding an outflow lag up understates the float (net 30 on a weekly grid must be 4 periods, not 5).

### 5.2 Cost and cash out

Categories `k`: labor net pay; labor burden (tax deposits, trust contributions, workers' comp premium on their own lags); material; equipment; subcontracts; job overhead; pre-start items (bond premium, SBA fee, permits, insurance deposits, cash bid security). Home-office overhead is not job cash and is excluded by default.

```
c(t)   = sum_k C_k * w_k(t)          K(t) = sum_{s<=t} c(s)          K(D) = C_cash = TJC + q(P)       // K = cumulative cost incurred
OUT(t) = sum_k [ d_k * C_k * 1{t = dep_k}  +  (1 - d_k) * C_k * w_k(t - l_k) ]
```

`w_k(t) >= 0`, `sum_t w_k(t) = 1` (share of category `k` incurred or delivered in period `t`); `d_k` = deposit share paid at `dep_k` (not later than the normal pay date); `l_k` = lag from incurrence to payment. Deliveries are dated events, not a smooth curve.

### 5.3 Earned value, pay applications, cash in

```
E(t)  = P * K(t) / C_cash                 // cost-proportional schedule of values (A-22); replace with the real schedule when known
t_j   = min(j*b, D),  j = 1..J,  J = ceil(D/b)
A_j   = E(t_j) - E(t_{j-1}),  E(t_0) := 0          // gross pay application
W_j, Rel_j from section 4.5 with B_j = A_j
IN(t) = sum_j (A_j - W_j) * 1{t = t_j + lam}  +  sum_j Rel_j * 1{t = its release date}  +  (retainage still held) * 1{t = D + lam_R}
        require D + lam_R >= t_J + lam
```

Federal bond premium: model it as a retainage-free line billable in the first pay application after proof of payment. It is early billing of the bond line, **not** revenue on top of the price.

### 5.4 Position and peak float

```
Nminus(t) = N(t-1) - OUT(t)          N(t) = Nminus(t) + IN(t)          N(-1) = 0
F*        = max(0, -min_t Nminus(t)) = max(0, max_t [ sum_{s<=t} OUT(s) - sum_{s<t} IN(s) ])
t*        = first t attaining it
F*_rf     = max(0, -min_t N(t)) <= F*                 // receipts-first variant
```

`F*` is the own money (cash plus credit) the job needs at its worst point. Paying before collecting inside a period is the conservative choice; on a weekly grid it can overstate the peak by up to one period of outflow, on a daily grid the difference mostly disappears.

Outputs: `F*` and its date; composition of cumulative cash paid by category at `t*`; days to first cash in; days cash-negative; dollar-days `Q = sum_t max(0, -N(t)) * Delta`; `F*/C_cash` and `F*/P`; final cash `N(H) = P - C_cash`.

Three facts the user must see for small jobs:

1. When the job is shorter than billing cycle plus payment lag, the contractor funds nearly all cash paid before the first receipt.
2. On such jobs retainage and markup do not change the peak at all; payment lag, billing frequency, supplier terms and deposits do.
3. "A longer billing cycle always needs more cash" is **false**. Only nested cycles (`b` replaced by a multiple of `b`) are monotone.

### 5.5 Closed form for uniform cost paid when incurred (test oracle)

With `l_k = 0`, `d_k = 0`, `w(t) = 1/D`, cost `C`, markup `m = P/C - 1`, flat retainage rate `r`, owner lag `lam` in periods, and `g = (1 - r)*(1 + m)`:

```
F* = (C/D) * max_{1<=j<=J} [ min(t_j + lam, D) - g * t_{j-1} ]            if g >= 1:  F* = C * min(1, (b + lam)/D)
```

Rule of thumb that follows: float is about burn rate times (billing period + payment lag).

### 5.6 Financing cost

```
i_per = i_annual * Delta / basis
I(t)  = i_per * max(0, -Nf(t-1))          Nf(t) = Nf(t-1) + IN(t) - OUT(t) - I(t)          Nf(-1) = 0
FIN   = sum_t I(t)                         simple approximation: i_per * sum_t max(0, -N(t))
m_fin = FIN / C_cash                       // one-pass; the fixed point is slightly lower
```

Interest is charged on the opening balance and paid in cash each period (convention; the loan agreement sets the day-count basis). Compute with exact rationals and round `FIN` to the cent once. With weekly periods this convention sits slightly below the pay-first trough; at `Delta = 1` the difference is negligible.

### 5.7 Accounting view (ties the ledger to percent complete)

```
p(t)  = K(t)/C_est          ER(t) = p(t)*P                       // cost-to-cost percent complete, earned revenue
BL(t) = sum_{j: t_j<=t} A_j          OU(t) = BL(t) - ER(t)       // billed minus earned: > 0 overbilled, < 0 underbilled
AR(t) = sum_{j: t_j <= t < t_j+lam} (A_j - W_j)                  RR(t) = retainage held
AP(t) = K(t) - sum_{s<=t} OUT(s)                                 GP(t) = ER(t) - K(t)
identity, every period:   N(t) = GP(t) + OU(t) - AR(t) - RR(t) + AP(t)
```

Sign conventions differ between sources: name the field `billedMinusEarned`.

### 5.8 Comparison with the contractor's limits

```
funds     = cashForJob + unusedCreditLine
need      = mulRate(F*, 1_000_000 + beta)
headroom  = funds - need                  coverage = funds / F*
upFront   = sum of OUT(s) for s <= first period with IN > 0        // cash out before any money comes in
preStart  = OUT(0)
```

| Check | Rule | Output |
|---|---|---|
| Job size | `P <= maxJobSize` | `within` / `over by $x` (the contractor's own rule) |
| Up-front cash | `upFront <= maxUpFrontCash` | `within` / `over by $x` |
| Peak float | `headroom >= 0` | `fits`, `tight` (fits only without the buffer), `short by $x`; always shown with the stress cases |
| Bonding, with a surety letter | `P <= singleLimit` and `backlogRemaining + P <= aggregateLimit` | `within letter` / `over letter by $x` |
| Bonding, without a letter | none | "Unknown: ask your surety agent." An optional rule-of-thumb estimate (A-3) is display-only and is never a pass or fail |
| Liquidity flags | working capital vs 10% of backlog incl. this job; current ratio | informational, labelled rule of thumb (A-4) |

Stress cases always computed: owner lag +30 and +60 days; supplier cash on delivery; labor +20% at fixed price; unpaid change order (optional). Portfolio: sum the `Nminus` series of all active jobs on one calendar; the portfolio peak is at most the sum of the individual peaks.

### 5.9 Cost-flow shapes (when the contractor gives no schedule)

`w(t) = S(t/D) - S((t-1)/D)` for any non-decreasing `S` with `S(0) = 0`, `S(1) = 1`; put the rounding remainder in the last period so the weights sum to exactly 1.

- Uniform: `S(x) = x` (labor default).
- Trapezoid with ramp-up share `a` and ramp-down share `d` (`a, d > 0`, `a + d <= 1`), `h = 2/(2 - a - d)`: `S = h*x^2/(2a)` on `[0, a)`; `h*(x - a/2)` on `[a, 1-d]`; `1 - h*(1-x)^2/(2d)` on `(1-d, 1]`. With `a = d = 1/3`: 25% at one third, 75% at two thirds.
- Dated events for deliveries and deposits.
- Optional normalised logistic `S(x) = (L(x) - L(0))/(L(1) - L(0))`, `L(x) = 1/(1 + exp(-k*(x - x0)))`, parameters entered by the user.

No published S-curve coefficients are shipped: the tables could not be read, and they describe large UK and Australian building projects, the wrong reference class for small electrical jobs.

---

## 6. Time and place adjustment

Time is one formula: multiply the old price by the ratio of two values of the **same** index. Place has the same shape with a location factor. The two multiply cleanly only when the time index is national and the location factors come from one edition.

On a takeoff-based public bid, "place" comes from local inputs (the county's prevailing wage determination, local quotes, local sales tax), **not** from a factor.

### 6.1 Index-ratio escalation (convention; binding only if a contract clause adopts it)

```
C(t2) = C(t1) * I(t2) / I(t1)                 pct = (I(t2)/I(t1) - 1) * 100          // never a difference in index points
chain:   I(tn)/I(t0) = product_k I(tk)/I(tk-1)                                        // multiply (1 + p), never add percentages
rebase:  I'(t) = k*I(t), k > 0   =>   I'(t2)/I'(t1) = I(t2)/I(t1)
```

Both values come from one named series on one reference base, pulled in one request. The rebase identity is exact only before rounding (BLS publishes three decimals), and does not cover a discontinued series: store the series id and both raw index values with every escalated line.

### 6.2 Forward escalation of a dated quote (the factor behind `e_i` in section 2.6)

```
F_fwd(m) = (1 + r_fwd)^(m/12)                           // r_fwd = the user's annual rate; m = whole months
r_eq     = (I(t2)/I(t1))^(12/m) - 1                     // trailing annualized rate of a series, shown as context only

if holdThrough >= purchaseDate:   factor = 1 exactly
else:
    t_last   = latest FINAL month of the line's series (not preliminary)
    hist     = (series set and month(quotedOn) < t_last) ? I(t_last)/I(month(quotedOn)) : 1
    start    = max(month(quotedOn), t_last)
    factor   = hist * F_fwd(months(start -> purchaseDate))
e_i (Ppm) = round((factor - 1) * 1_000_000)            // float64 here, rounded half-up once, stored with the line
```

The forward factor must start where the historical index stops. If a published factor table `F` is used instead of a rate, the forward part is `F(T)/F(t_last)` with `F` interpolated at `t_last`; anchoring it at the table's own base date counts the months in between twice.

`r_fwd` has no default. The DoD projected rates (2.1%, then 2.0% a year) are budget guidance, not a forecast: the same table's realized index rose 3.58% and 4.08% in the last two years, and one wire series rose 23.0% in twelve months.

### 6.3 Midpoint of construction, and when not to use it

```
T_mid = T_start + (T_end - T_start)/2          // T_start = expected start of work; the award-to-start lag counts in m
cost-loaded:  F = sum_k s_k * F(t_k),  sum s_k = 1
even spending, exact average factor / midpoint factor = sinh(g*D/2)/(g*D/2) ~ 1 + (g*D)^2/24,   g = ln(1 + r)
```

DoD and GSA both escalate owner estimates to the midpoint **[R]**. For a short job where wire and gear are bought in week one, escalate each material line to its **purchase date** instead. Do not escalate labor already priced at known scheduled wage rates.

### 6.4 Published factor table (reference only)

`F(Y) = product_{y = base+1..Y} (1 + r_y)`, `F(base) = 1`; between two 1 October anchors DoD interpolates linearly: `F(d) = F(Y_k) + (m_k/12)*(F(Y_k+1) - F(Y_k))`. Geometric interpolation is lower by at most about `F*r^2/8`. Values: D-77.

### 6.5 Series registry and rules

| Material or cost class | BLS series id | Note |
|---|---|---|
| Copper wire and cable | `WPU10260314` | values **[R]** (API); title and reference base not verified (A-35) |
| Conduit and fittings | `WPU11710216` | same |
| Switchgear | `WPU1175` | same |
| Lighting fixtures | `WPU1083` | same |
| Electrical contractors, nonresidential work | `PCU23821X23821X` | same |
| Inputs to nonresidential construction, goods | `WPUIP2312001` | same |
| New office building construction | `PCU236223236223` | same |

1. Each material class uses its own series. Over the same twelve months wire rose 23.0%, conduit 1.7%, switchgear 10.4%, fixtures 3.5%: one general index is wrong for all of them.
2. The newest four months of PPI are preliminary and get revised **[R]**. Stored factors use the latest final month.
3. A missing value, an index <= 0, values from two series or two bases, or location factors from two editions raise an error. They never fall back to 1.0.
4. PPI is a national producer selling price. It is not what a contractor pays a distributor and excludes sales tax and local freight. A fresh supplier quote beats an escalated old one.
5. Staleness warning: when `abs(I(t_last)/I(month(quotedOn)) - 1)` exceeds a product threshold (A-25), tell the user to re-quote.

### 6.6 Place

| Method | Formula | Allowed use |
|---|---|---|
| Local inputs | none | The default for every takeoff-based bid |
| Wage ratio | `Labor_B = Labor_A * W_B / W_A` | Moving a labor-only historical cost. Same wage measure, same period, two areas. Hours unchanged; productivity is separate. Labor dollars only. On public works the wage determination **is** the rate, so no ratio is needed |
| Share-weighted composite | `LF = s_L*(W_B/W_A) + s_M*(m_B/m_A) + s_O*(o_B/o_A)`, shares of the origin estimate summing to 1; relatives default to 1 | Whole-job historical cost |
| DoD Area Cost Factor | `C_B = C_A * ACF_B / ACF_A`, same edition | Whole-project parametric checks and a labelled context number **only** |

The ACF limit is verbatim **[R]**: "Do not use the MILCON ACFs to modify detailed quantity take-offs, unit price book (UPB) line items, commercial cost data, or user-generated unit costs." Key the table on site code or county plus city: ZIP is not unique (195 of 6,873 ZIPs carry more than one factor pair). Douglas County, Nevada has no row. BEA Regional Price Parities are not shipped (values unverified, consumer-price based). One method per cost bucket, labelled. Small-area wage ratios get a low-confidence flag (adjacent areas differ by 16.1% in the survey).

### 6.7 Combining, without double counting

```
C(B, T) = C(A, t1) * [LF_B/LF_A] * [I_nat(t_last)/I_nat(t1)] * [F(T)/F(t_last)]
```

Guards: a line with a firm price hold through its purchase date, or labor at a known scheduled rate, has time factor exactly 1; a forward-priced quote is not escalated again; escalation is never hidden in contingency; a location factor is never applied to inputs that are already local; markups are applied once.

### 6.8 Price-adjustment clauses (only when the contract has one)

Small firm-fixed-price jobs will usually have none (an inference, not a sourced fact): check each solicitation. Two different mechanisms; do not mix them.

```
Index template (FHWA-style):
    change = I_cur/I_base - 1
    adj    = abs(change) < trigger ? 0 : P_base * phi * clamp(change or (change beyond trigger), -floor, +cap)
```

`phi` = indexed share of the price; `trigger`, `cap`, `floor` and whether the whole change or only the part beyond the trigger is paid come from the contract. FHWA's 1980 advisory suggests a 3% to 10% trigger and a 25% to 100% ceiling on the increase "from the base price for (material)" **[R]**.

FAR 52.216-4 is **not** an index clause: it adjusts for actual changes in the labor rates and material unit prices listed in the contract schedule, on negotiated fixed-price contracts; no adjustment unless the net change is at least 3% of the then-current total contract price; aggregate increases limited to 10% of the original unit price (the contracting officer may raise it); no limit on decreases; indirect cost and profit excluded **[R]**. Never model it with `I_cur/I_base`.

### 6.9 Public unit-price sanity band (optional; a flag, never a suggested price)

Free public line-item prices exist only for roadway electrical work (lighting, signals, conduit, pull boxes). Nothing public covers building electrical line items, and nobody publishes labor-hour units.

```
like-for-like:   u_contractor = item sell total / quantity          // loaded: direct cost + its share of overhead, profit, bond
                 (leave out any cost the bid form pays under a separate item, e.g. mobilization or time-related overhead)
sample:          same normalized unit;  q_ref/10 <= q_i <= 10*q_ref;  awarded bids only;
                 exclude unit LS, quantity-1 lump sums, price <= 0, and lump-sum-derived unit prices
adjust:          P_adj = P_orig * I_to / I_from          // missing I_from: factor 1 and a flag
weighted mean:   Pw = sum(q_i*p_i) / sum(q_i)
band:            x sorted, 0-indexed;  h = (n-1)*k;  Pk = x[floor(h)] + (h - floor(h)) * (x[min(floor(h)+1, n-1)] - x[floor(h)])
flag:            below_range if u_contractor < P10;  above_range if u_contractor > P90;
                 no flag if n < n_min, units differ, or rows are lump-sum derived;  label "thin" if n < 20
unreliable:      standard deviation > minimum price (the binding form of the agency's rule);  state whether s uses n or n-1
```

Rules: a bid unit price already includes overhead and profit, so comparing it with direct cost always makes the contractor look cheap. Decide "lump sum" from the agency's item list (bidding unit), not from a units column. Show raw and adjusted prices side by side and never flag on adjusted prices alone (one state index swung between 126.75 and 210.72 inside a year). Never present an out-of-state price as a Nevada price. Reuse terms for the state and city data were not read (section 12).

---

## 7. Bid price selection (the price agent)

The honest product is a curve with error bars and a range, not one magic price.

### 7.1 Award rule: law, coded as a deterministic rule before any probability

| Rule | Evaluated price | Conditions (inputs) | Evidence |
|---|---|---|---|
| Sealed bid | lowest price among responsive, responsible bidders | | law **[X]** |
| Nevada bidder preference (NRS 338.147, 338.1389) | a preferred bidder is the best bid if `B_pref <= 1.05 * B_low_nonpreferred` | estimated cost exceeds $250,000; bidder is responsive and responsible, holds a valid certificate of eligibility from the State Contractors' Board, and files the affidavit within 2 hours after bid opening; compared with the lowest responsive, responsible bid lacking the certificate or affidavit | law **[X]** |
| Nevada State public works up to $250,000 (NRS 338.13844) | the bid of a local business owned and operated by a veteran with a service-connected disability "shall be deemed to be 5 percent lower than the bid actually submitted" | State owner; covers the pilot's job sizes | law **[X]**, full text not read |
| Federal HUBZone preference (FAR 19.1307) | add 10% to an offer **unless** it is (1) from a HUBZone small business that has not waived the preference, or (2) an otherwise successful offer from a small business | full and open competition where price is a factor; does not apply when the initial low responsive, responsible offeror is a small business | law **[X]** |

For a small-business user the factor on its own offer is always 1.00. Apply `evaluatedPrice()` to our bid and to every competitor ratio before computing any probability.

### 7.2 How many competitors

- Nevada small works (NRS 338.13862, law **[X]**): estimated cost above $25,000 up to $100,000, bids are solicited from at least three licensed contractors; $25,000 or less, at least one. These are quotes solicited by the agency, not advertised bids: there may be no public tabulation, and the count is whoever the agency asked.
- Above $100,000 Nevada advertises. Estimate `g(k)` = share of past comparable lettings with exactly `k` competitors.
- Federal awards report `number_of_offers_received` (sometimes missing); competitors = offers minus 1. Award data shows only the winner's price: competitor distributions need bid tabulations.

### 7.3 Data form

`x_j = Lc_j / A_j`: lowest **competing** bid over an anchor, per past comparable letting (same agency class, trade, size band, bidder-count band). Anchor = the government or engineer's estimate when published, else the contractor's own cost estimate at bid time. The owner's estimate is itself noisy; prefer the contractor's own cost when enough history exists. `J` = number of lettings.

### 7.4 Win-probability models

```
(a) empirical (preferred when data are thin; needs no independence assumption):
        P_win(B) = count{ j : x_j > B/A } / J
(b) smoothed, on logs:   y_j = ln x_j;   h = 0.9 * min(s_y, IQR_y/1.34) * J^(-1/5)
        P_win(B) = 1 - (1/J) * sum_j Phi( (ln(B/A) - y_j) / h )
(c) Friedman:   P_win(m) = product_i p_i(m);   n typical rivals: p(m)^n;   unknown n: sum_k g(k) * p(m)^k   (k = 0 term included)
(d) Gates:      P_win(m) = 1 / (1 + sum_i (1 - p_i(m))/p_i(m));   any p_i = 0 returns 0
        p_i(m) = count{ jobs where rival i bid and bid_ij / C_j > 1 + m } / count{ jobs where rival i bid }      // C_j = OUR estimate then
```

- `Friedman <= Gates` for all `p_i` in (0, 1], with equality for one competitor. Present them as **two model outputs**, not as low and high confidence limits: with positively correlated bids the truth can sit above both (the verifier simulated Friedman 0.508, Gates 0.580, true 0.650). Under positive dependence the true value lies in `[product p_i, min p_i]`.
- Friedman is exact for independent rival ratios at a fixed bid; in practice every ratio `bid_ij/C_j` shares our own estimating error, which is why it runs pessimistic. Gates is exact only for proportional-hazards bid distributions.
- Symmetric sanity anchor: with `N` exchangeable bidders each wins `1/N`; Gates with all `p = 0.5` gives exactly `1/(n+1)`.
- Smoothing does not reduce uncertainty. The bandwidth is a density-estimation default and oversmooths a distribution function; show the raw step curve too.
- The formulas are stated as reported in a 1977 review; the 1956 and 1967 originals were not read (section 12).

### 7.5 Uncertainty (always shown)

```
Wilson interval for k wins in J:   centre = (p + z^2/(2J)) / (1 + z^2/J),   half = z*sqrt(p(1-p)/J + z^2/(4J^2)) / (1 + z^2/J),   z = 1.96
DKW band for the whole curve:      eps = sqrt( ln(2/alpha) / (2J) )          alpha = 0.05:  J=10 0.43, 30 0.25, 100 0.14, 185 0.10, 738 0.05
tail claims:   a statement at win probability w needs  J >= ln(alpha)/ln(1 - min(w, 1-w))      (10% tail: 29;  5%: 59;  25%: 11)
zero wins in J tries:  95% upper bound 1 - 0.05^(1/J), about 3/J
```

### 7.6 Winner's curse (a model with a judgment parameter, shown as an adjustable line)

The lowest of `N` unbiased cost estimates is biased low by about `sigma * e_N` (`e_N` = expected maximum of `N` standard normals: 0.5642, 0.8463, 1.0294, 1.1630, 1.2672, 1.3522, 1.4236 for `N` = 2..8; 1.5388 for 10; recomputed by the verifier).

```
C_adj = C / (1 - kappa * sigma * e_N)          requires kappa * sigma * e_N < 1
```

`sigma` = the contractor's estimating error (from estimate-versus-actual history); `kappa` in [0, 1] = share of cost uncertainty common to all bidders; `N` = total bidders including us. The linear form `C*(1 + kappa*sigma*e_N)` understates by 1% to 6% in the checked cases. Apply `C_adj` only inside the profit-if-won term, and not at all if win probabilities and margins are already calibrated on realized job costs (double counting).

### 7.7 Expected profit, optimum and range

```
profitIfWon(B) = B - q(B) - (TJC_adj + OH + FIN)                 // TJC_adj = TJC * C_adj/C;  'contribution' view drops OH (a business choice)
EV(B)          = profitIfWon(B) * P_win(B) - K                    // K = sunk bid cost; affects bid/no-bid only
floor          = grossUp( BE*(1 + m_min) + FIN )                  // never below the cost engine's break-even plus minimum markup
B*             = argmax EV(B) over B >= floor
range          = EV(B*) > 0 ? { B >= floor : EV(B) >= (1 - delta) * EV(B*) } : NO BID
```

- With an empirical step curve, `EV` rises linearly between jumps, so the maximum is at `floor` or one cent below a jump point `A*x_j`. Evaluate those candidates exactly; no numeric optimiser is needed. Smooth curves use a bounded numeric search.
- First-order condition for smooth curves, with `d = C_adj/C - 1` and markup `m` on cost: `m* = d - P_win(m*)/P_win'(m*)`.
- Exact test case: `p(m) = exp(-lambda*m)` under Friedman gives `m* = d + 1/(n*lambda)`, `P_win(m*) = 1/e`, `EV* = C/(n*lambda*e)`; the markup halves when the number of competitors doubles.
- Game-theory benchmark (not a pricing rule): symmetric private costs uniform on [0, 1], `n` total bidders: `b(c) = (1 + (n-1)c)/n`, markup `(1-c)/n`, expected lowest bid `2/(n+1)`.
- Expected-profit maximisation is risk-neutral: it ignores ruin, backlog, bonding and cash. The limits check of section 5.8 is evaluated at every candidate price and can veto it.
- Per price in the range, report: markup, win probability low/mid/high, profit if won, expected value.

### 7.8 Calibration

`BS = (1/N) * sum (f_i - o_i)^2`; reference `pbar*(1 - pbar)`; skill `1 - BS/BS_ref` (undefined when the observed win rate is 0 or 1; the reference is in-sample only). Store every forecast and outcome. With thin data shrink toward `1/(n+1)` (design choice).

### 7.9 Owner-side adequacy warning (legacy guidance, a warning only)

The 2004 FHWA guideline (still printed in the 2014 core curriculum; dropped from the 2021 guideline) treated competition as adequate when the low bid does not exceed, for `k` bids within 20% of the low bid (counting the low bid): `k=1` 100%, `k=2` 105%, `k=3` 110%, `k=4` 115%, `k=5` 120% of the engineer's estimate. Six or more is "excellent", with no ceiling stated. Use it to warn that a high bid with few bidders risks rejection or re-advertisement on highway-type lettings.

### 7.10 Presentation rules

1. Always show the sample size `J` and the reference class. Show win probability as a range (Wilson). No decimals on percentages.
2. Below `J = 10` show "not enough data" instead of an estimate; quote no 10% tail below `J = 29` (A-25).
3. Published low-bid-to-estimate tables by bidder count (D-75) are highway work, mostly large contracts, and disagree wildly on one-bid jobs (from -0.9% to +65.5%). They are labelled context, never an input to `P_win`.
4. Bidder count is not random (attractive jobs draw more bidders); the published correlations are not the effect of adding a bidder.
5. A multi-tenant price agent must never use one customer's private bids or costs to advise a competing customer on the same job. This raises bid-rigging and information-exchange risk, was not researched, and needs counsel before launch.

---

## 8. Defaults table (verifier-confirmed or verifier-corrected values only)

Store every row as dated configuration with its source URL and show source and date beside the number in the product. "Ev" = evidence tag from the top of this file. Rows marked *context* are displayed for orientation and are never multiplied into a bid. Verbatim quotes for each row are in the research notes named at the top.

### 8.1 Payroll taxes

| ID | Name | Value | Unit | Jurisdiction | Effective | Kind | Ev | Source |
|---|---|---|---|---|---|---|---|---|
| D-1 | Social Security, employer share | 6.2 | % of wages up to the wage base | US | 2026; 2027 by statute | law | X | https://www.irs.gov/taxtopics/tc751 |
| D-2 | Social Security wage base | 176,100 (2025); 184,500 (2026); 192,300 (2027) | USD per employee per year | US | calendar year | law | X; 2027 from reports of the SSA announcement | https://www.irs.gov/taxtopics/tc751 ; https://www.ssa.gov/oact/cola/cbb.html |
| D-3 | Medicare, employer share | 1.45, no wage cap. Additional Medicare 0.9% over $200,000 is employee-only (employer cost 0) | % of wages | US | 2026 | law | X | https://www.irs.gov/taxtopics/tc751 |
| D-4 | FUTA | 6.0 on the first 7,000; credit up to 5.4; net 0.6 where there is no credit reduction (at most $42.00 per employee) | %; USD per employee per year | US | 2025, 2026 | law | X | https://www.irs.gov/taxtopics/tc759 |
| D-5 | FUTA credit reduction | 0.3 points per year a state stays on the list (add-ons possible from the 3rd and 5th year); California 2025: 1.2 (net 1.8%, $126 per employee) | % of FUTA wages | US; California | tax year 2025 | law | X | https://www.irs.gov/businesses/small-businesses-self-employed/futa-credit-reduction ; https://www.irs.gov/pub/irs-pdf/f940sa.pdf |
| D-6 | Nevada unemployment taxable wage base | 41,800 (2025); 43,700 (2026); 45,400 (2027) | USD per employee per year | Nevada | calendar year | law | X | https://detr.nv.gov/Page/UI_Tax |
| D-7 | Nevada unemployment rate | new employer 2.95 (kept 14 to 17 quarters); experience-rated 0.25 to 5.40 (18 rates) | % of taxable wages | Nevada | 2026 schedule | law | X | https://detr.nv.gov/Page/UI_Information_for_Employers |
| D-8 | Nevada Career Enhancement Program | 0.05; not owed by employers at the 5.4% rate (new employer total 3.00%) | % of taxable wages | Nevada | current | law | X | https://detr.nv.gov/Page/NUI_View_Quarterly_Reporting_Info |
| D-9 | Nevada Modified Business Tax, general business | 1.17 of quarterly gross wages less employer-paid health benefits, above 50,000 per quarter per employer | %; USD | Nevada | since 2023-07-01 | law | X | https://tax.nv.gov/tax-types/modified-business-tax/ |
| D-10 | California unemployment | wage base 7,000; new employer 3.4; 2026 schedule F+ 1.5 to 6.2 (at most $434 per employee) | USD; % | California | 2026 | law | X | https://edd.ca.gov/en/payroll_taxes/rates_and_withholding/ |
| D-11 | California ETT and SDI | ETT 0.1 on the first 7,000 (at most $7); SDI 1.3 (2026), 1.2 (2025), no cap, withheld from the employee (employer cost 0) | % | California | 2026; 2025 | law | X | https://edd.ca.gov/en/payroll_taxes/rates_and_withholding/ |
| D-17 | Federal employment-tax deposits, monthly depositor | by the 15th of the following month; monthly schedule when lookback taxes are 50,000 or less | date; USD | US | 2026 | law | X | https://www.irs.gov/publications/p15 |
| D-18 | Per-paycheck rounding differs from the total | IRS "fractions-of-cents" adjustment exists | rule | US | 2026 | law | X | https://www.irs.gov/publications/p15 |

### 8.2 Workers' compensation

| ID | Name | Value | Unit | Jurisdiction | Effective | Kind | Ev | Source |
|---|---|---|---|---|---|---|---|---|
| D-12 | Nevada workers' comp payroll cap | 36,000 per employee per policy year under the statute in force through 2026-09-30; 12 x maximum average monthly wage = 98,433.60 for new and renewal policies from 2026-10-01; re-set each 1 January | USD | Nevada | by policy effective date | law | X | https://www.leg.state.nv.us/nrs/NRS-616B.html ; https://dir.nv.gov/uploadedFiles/dirnvgov/content/WCS/ImportantDocs/FYI-DR-NV-2026-01.pdf |
| D-13 | Nevada premium payroll includes overtime pay | no exclusion of the overtime premium (corrected by the verifier); confirm with the carrier | rule | Nevada | current | law (NAC 616A.200) | X | https://www.leg.state.nv.us/nac/nac-616a.html |
| D-14 | California electrical dual-wage threshold | 40.00 (was 36.00): class 5140 at or above, 5190 below | USD per hour, regular hourly wage | California | policies effective on or after 2026-09-01 | regulation | X | https://www.wcirb.com/filings-and-plans/usrp-erp-and-miscellaneous-regulations/september-1-2026-regulatory-filing-quick-reference-guide-usrp-and-erp-changes |
| D-15 | California advisory pure premium rates (*context*; loss-only benchmark, not what an insurer charges) | all-class average 1.65; class 5190 3.729; class 5140 2.109 | USD per $100 of payroll | California | policies from 2026-09-01 | rate | average X; class values S | https://www.insurance.ca.gov/0400-news/0100-press-releases/2026/upload/Workers-Comp-Decision-and-Order-7-10-26.pdf ; https://wcirb.com/class-search/electrical-wiring-low-wage |
| D-16 | Nevada loss-cost level changes (*context*) | +6.5% (2025-03-01); +21.6% (2026-03-01); -32.8% (2026-10-01, paired with the larger payroll base) | % change, overall voluntary market | Nevada | as dated | rate | X for 2025; S (trade press) for 2026 | https://doi.nv.gov/Insurers/Property-Casualty/Filing-Information/Workers-Compensation/ |

### 8.3 Overtime and prevailing wage

| ID | Name | Value | Unit | Jurisdiction | Effective | Kind | Ev | Source |
|---|---|---|---|---|---|---|---|---|
| D-19 | FLSA overtime | 1.5 x regular rate over 40 hours per workweek; bona fide plan contributions excluded from the regular rate | multiple | US | current | law | X | https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title29-section207&num=0&edition=prelim |
| D-20 | Davis-Bacon fringe obligation | basic rate + fringe may be met with cash, bona fide plan contributions, or a mix; plan credit annualized over all hours worked, with exceptions | rule | US | current | law | X | https://www.dol.gov/agencies/whd/fact-sheets/66E-DBRA-compliance-fringe-benefit-requirements |
| D-21 | Davis-Bacon overtime arithmetic | fringe at straight rate on every hour; half-time premium on the basic rate | rule | US | current | law | X | https://www.dol.gov/agencies/whd/government-contracts/prevailing-wage-resource-book/db-compliance-principles |
| D-22 | California private overtime (Labor Code 510) | 1.5x over 8 per day, over 40 per week, first 8 hours of the 7th day of work in the workweek; 2x over 12 per day and over 8 on that 7th day | multiple of regular rate | California | current | law | X | https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=510 |
| D-23 | California public works overtime (Labor Code 1815) | 1.5 x basic rate over 8 per day and 40 per week; employer payments at straight rate | multiple of basic rate | California | current | law | X | https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=1815. ; https://www.dir.ca.gov/dlse/PWManualCombined.pdf |
| D-24 | Nevada private overtime (NRS 608.018) | 1.5x over 40 per week; over 8 per workday only below 1.5 x minimum wage (4x10 exception) | multiple of regular wage rate | Nevada | current | law | X | https://www.leg.state.nv.us/NRS/NRS-608.html |
| D-25 | Nevada public works overtime (NRS 338.020) | 1.5 x prevailing rate of wages (base + fringe per the Labor Commissioner's handbook) over 40 per week or 8 per workday; 4x10 and collective-agreement exceptions | multiple | Nevada | handbook rev. 2026-07-22 | law | X | https://www.leg.state.nv.us/nrs/NRS-338.html |
| D-26 | Minimum wage-payment frequency | Nevada semimonthly (NRS 608.060); California twice per calendar month (Labor Code 204) | frequency | Nevada; California | current | law | X | https://www.leg.state.nv.us/NRS/NRS-608.html ; https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=204 |
| D-27 | CWHSSA coverage (corrected) | only contracts over 100,000 (over 150,000 for contracts under federal acquisition rules); at or below, FLSA overtime applies | USD | US | current | law | X | https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title40-section3702&num=0&edition=prelim ; https://www.dol.gov/agencies/whd/government-contracts/prevailing-wage-resource-book/dbra-coverage |
| D-28 | Nevada minimum wage and daily-overtime threshold | 12.00; daily overtime only for employees earning less than 18.00 | USD per hour | Nevada | bulletin effective 2026-07-01 | law | X | https://labor.nv.gov/uploadedFiles/labornvgov/content/Employer/26.06.29%20Annual%20Bulletin%20-%20Daily%20Overtime.pdf |
| D-29 | Davis-Bacon wage payment | not less often than once a week | frequency | US federal and federally assisted construction | current (29 CFR 5.5) | law | X | https://www.ecfr.gov/current/title-29/part-5 |
| D-30 | Nevada prevailing-wage project threshold | NRS 338.020 to 338.090 do not apply when the estimated cost is less than 100,000 ("except as otherwise provided in NRS 226.826") | USD estimated cost | Nevada | current (NRS 338.080) | law | X | https://www.leg.state.nv.us/nrs/NRS-338.html |
| D-31 | Nevada annualization exceptions (NRS 338.035) | benefits set by a collective bargaining agreement; or defined-contribution plan contributions up to 25% of the hourly prevailing rate | % | Nevada | current | law | X | https://www.leg.state.nv.us/nrs/NRS-338.html |

### 8.4 Bonds

| ID | Name | Value | Unit | Jurisdiction | Effective | Kind | Ev | Source |
|---|---|---|---|---|---|---|---|---|
| D-32 | Federal performance and payment bonds | contract exceeding 150,000; performance 100% of the original price plus 100% of increases; payment 100% (statute text: more than 100,000) | USD; % | US federal | current FAR | law | X | https://www.acquisition.gov/far/28.102-1 ; https://www.acquisition.gov/far/28.102-2 |
| D-33 | Federal payment protection band | exceeding 35,000 and not exceeding 150,000: payment bond or alternative protection at 100% | USD | US federal | current FAR | law | X | https://www.acquisition.gov/far/28.102-1 |
| D-34 | Federal bid guarantee | at least 20% of the bid price, at most 3,000,000; only when a performance bond is also required; on default the bidder owes the excess cost over its bid | %; USD | US federal | current FAR | law | X | https://www.acquisition.gov/far/28.101-2 ; https://www.acquisition.gov/far/52.228-1 |
| D-35 | Nevada bonds and bid security | NRS 339.025: contract exceeding 100,000 (not NRS 408 work), performance and payment each not less than 50%, for State, county, city, town, school district; State Public Works subs over max(50,000, 1% of project) bond to the Division; State Public Works bid security at least 5% of base bid plus alternates for bids over 100,000; NDOT bid security at least 5%, bonds equal to the full contract amount | USD; % | Nevada | current | law | X | https://www.leg.state.nv.us/nrs/NRS-339.html ; https://www.leg.state.nv.us/nac/nac-341.html ; https://www.leg.state.nv.us/nrs/NRS-408.html |
| D-36 | California bonds and bid security | payment bond for expenditure over 25,000, at 100% of the amount payable; bid security at least 10% of the amount bid (state and cities); State Contract Act bonds at least 50% each | USD; % | California | current | law | X | https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=9550. ; https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PCC&sectionNum=10167. |
| D-37 | SBA surety bond guarantee (corrected) | contractor fee 6.00 per 1,000 of contract price for guarantees approved before 2026-11-30, 7.29 per 1,000 on or after; rounded to the nearest dollar; no fee on bid-bond guarantees; contract limit 9,000,000 (14,000,000 federal with certification); Quick Bond 500,000 or less | USD | US | as dated | law | X | https://www.federalregister.gov/documents/2026/10/30/2026-22177/surety-bond-guarantee-program-fees ; https://www.sba.gov/funding-programs/surety-bonds |
| D-38 | Sample tiered bond rates, Class B (lists Electrical), non-deviating (**illustrative; shown as an assumption; never a quote**) | first 100,000: 25.00; next 400,000: 15.00; next 2,000,000: 10.00; next 2,500,000: 7.50; next 2,500,000: 7.00; over 7,500,000: 6.50. Deviating sample: 10.00 / 8.00 / 7.00 / 6.00 / 5.00 / 4.50 | USD per $1,000 of contract price, 12 months or less | US advisory sample | 2010 table; first three tiers repeated in the 2026 example | rate | tiers 1 to 4 R; tier 5 corrected from the printed 7.50 by two independent government-hosted sources; tier 6 6.50 (a 2006 source shows 6.00) | https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ARCHIVES/ufc_3_740_05_2010_c1.pdf ; https://www.fhwa.dot.gov/publications/research/infrastructure/14034/003.cfm |
| D-39 | Bond premium duration surcharge | non-deviating: 1% of premium per month over 12; deviating: 0.5% per month for months 13 to 24 and 1% after 24; five states use a 24-month table | % of premium per month | US (surety manual rules as described by DoD) | 2026-02-02 | rate | R | https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ufs_3_740_05_2026.pdf |
| D-40 | Federally funded state and local construction (2 CFR 200.326) | bid guarantee 5% of bid price; performance and payment bonds 100% each | % | US grants, above the simplified acquisition threshold | current | law | X | https://www.ecfr.gov/current/title-2/part-200 |
| D-41 | Bond premium ranges (*context*) | 1.5% to 3.0% of contract amount; 1% to 3% of bond amount; reported one-time premiums: $100,000 contract $1,200 to $2,500, $1M $7,700 to $13,500, $10M $56,950 to $81,000, $50M $206,475 to $341,000; state DOT survey under $100,000: 0.22 / 1.06 / 2.5% low / average / high | %; USD | US | 2014 for the dollar table | study | X | https://www.congress.gov/crs-product/R42037 ; https://www.fhwa.dot.gov/publications/research/infrastructure/14034/003.cfm |
| D-42 | How premiums are set | sureties file their own rates (no state-set rate); the premium is usually based on the contract amount and duration | rule | Texas page; US study | current | law / study | X | https://www.tdi.texas.gov/commercial/pcbond.html |

### 8.5 Retainage, payment timing, interest

| ID | Name | Value | Unit | Jurisdiction | Effective | Kind | Ev | Source |
|---|---|---|---|---|---|---|---|---|
| D-43 | Federal retainage | none when progress is satisfactory; at most 10% of the payment otherwise; total not above 10% of the approved estimated amount | % | US federal | current FAR | law | X | https://www.acquisition.gov/far/52.232-5 ; https://www.acquisition.gov/far/32.103 |
| D-44 | Federal construction payments | monthly progress payments; due 14 days after a proper request; final payment 30 days; retained amounts 30 days after approval of release unless the contract says otherwise; subs paid within 7 days; small-business accelerated-payment goal 15 days | days | US federal | current FAR | law | X | https://www.acquisition.gov/far/32.904 ; https://www.acquisition.gov/far/52.232-27 |
| D-45 | Federal bond-premium reimbursement | on request, inside progress payments, after proof of payment to the surety | rule | US federal | current FAR | law | X | https://www.acquisition.gov/far/52.232-5 |
| D-46 | Prompt Payment Act interest | 4.75 (2026-07-01 to 2026-12-31); 4.125 (Jan to Jun 2026); 4.625 (Jul to Dec 2025); simple formula `P * r/360 * d`; the rate in effect the day after the due date applies | % per year | US federal | as dated | rate / law | X | https://fiscal.treasury.gov/payments-from-government/prompt-payment/rates ; https://www.ecfr.gov/current/title-5/section-1315.17 |
| D-47 | Federal liquidated damages | a rate per day of delay stated in the contract | USD per calendar day | US federal | current FAR | law | X | https://www.acquisition.gov/far/11.502 |
| D-48 | Nevada public works progress payments (NRS 338.515) | due within 30 days after the public body receives the progress bill (or sooner per contract); 5% withheld until 50% of the work is performed | days; % | Nevada | current | law | X | https://www.leg.state.nv.us/nrs/NRS-338.html |
| D-49 | Nevada retainage after 50% (corrected) | the public body may pay without further retainage; if it keeps withholding: at most 2.5% per payment after first paying 50% of the retainage withheld so far, or at most 5% (keeping earlier retainage) when it withholds under NRS 338.525 | % | Nevada | current | law | X | https://www.leg.state.nv.us/nrs/NRS-338.html |
| D-50 | Nevada interest on retainage and pay-down | interest paid quarterly at a bank-quoted rate; contractor and subcontractors pay lower tiers within 10 days of receiving money; the same 2.5% and half-release rule applies prime-to-sub | rule; days | Nevada | current | law | X | https://www.leg.state.nv.us/nrs/NRS-338.html |
| D-51 | NDOT payments (corrected) | progress payments not more than 95% of the contract price; the retained 5% is not more than 50,000 | %; USD | Nevada DOT | current (NRS 408) | law | X | https://www.leg.state.nv.us/nrs/NRS-408.html |
| D-52 | California retention | at most 5% of each payment and 5% of the contract price (more only if found "substantially complex" and stated in the bid documents); local agencies not less than 5%, may pay in full after 50%; Caltrans transportation projects none | % | California | current | law | X | https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PCC&sectionNum=7201 |
| D-53 | California payment timing | progress payment within 30 days of an undisputed proper request (7 days to return an improper one); late interest 10% per year; retention released within 60 days of completion (150% of a disputed amount may be withheld); subs paid within 7 days, 2% per month penalty | days; % | California | current | law | X | https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PCC&sectionNum=20104.50 ; https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PCC&sectionNum=7107 |
| D-54 | California delay damages | enforceable only if liquidated to a set amount identified in the contract | rule | California | contracts from 2016-01-01 | law | X | https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PCC&sectionNum=7203. |
| D-55 | SBA 7(a) maximum variable rates | base + 6.5 points (loans of 50,000 or less); + 6.0 (to 250,000); + 4.5 (to 350,000); + 3.0 (above 350,000) | percentage points | US | current (13 CFR 120.214) | law | X | https://www.ecfr.gov/current/title-13/section-120.214 |
| D-56 | Typical supplier net terms (*context*) | net 30 and net 60 | days | US, general trade | current | thumb | X | https://sba.gov/blog/top-10-business-credit-terms-small-business-owners-should-know |
| D-57 | State capacity rules (*context*; analogues, not surety practice) | South Dakota: at most 10 x working capital; Tennessee: 10 x the lesser of working capital and net worth; Washington: 5.0 x net worth; Illinois: 10, 11 or 12 x allowable net current assets, real estate and equipment; Kentucky: 12 x net current assets plus 6 x equipment book value | multiple | as named | current | law (prequalification or licensing rules) | X | https://sdlegislature.gov/Rules/Administrative/70:07:02:09 ; https://ilga.gov/agencies/JCAR/EntirePart?titlepart=04400650 |
| D-58 | Staged mobilization payment (*context*, example of the pattern) | 25% of the mobilization item once 5% of the original contract amount is complete | % | Iowa specification; not Nevada | current | rate | X | https://ia.iowadot.gov/erl/current/US/content/11020.htm |
| D-60 | Bank prime loan rate (*context*) | 7.00 | % per year | US | observation of 2026-10-09 (release of 2026-10-16); refresh before use | rate | X | https://www.federalreserve.gov/releases/h15/ |

### 8.6 Tax rounding, estimating guidance, bidding rules

| ID | Name | Value | Unit | Jurisdiction | Effective | Kind | Ev | Source |
|---|---|---|---|---|---|---|---|---|
| D-59 | Small-business size standard, NAICS 238210 | 19.0 | million USD average annual receipts | US | current (13 CFR 121.201) | law | X | https://www.ecfr.gov/current/title-13/section-121.201 |
| D-61 | Nevada sales-tax rounding (NRS 372.366) | computed to the third decimal place; rounded up to the next cent if the third decimal is greater than 4; per item or per invoice | rule | Nevada | 2025 NRS | law | X | https://www.leg.state.nv.us/NRS/NRS-372.html |
| D-62 | Unit price governs over the extension | "the unit bid prices shall govern" | rule | Nevada DOT contracts | 2014 Standard Specifications | contract specification | X | https://www.dot.nv.gov/home/showpublisheddocument/6916/636257041112930000 |
| D-63 | Half-even rounding exists in regulation | 984.50 becomes 984; 985.50 becomes 986 | rule | US model regulation | 2025 | rate | X | https://nvlpubs.nist.gov/nistpubs/hb/2025/NIST.HB.130-2025.pdf |
| D-64 | JavaScript number limits | largest exact integer 9,007,199,254,740,991; `Math.round` sends ties toward +infinity | integer | n/a | n/a | engineering fact | R | https://github.com/mdn/content/blob/main/files/en-us/web/javascript/reference/global_objects/number/max_safe_integer/index.md |
| D-65 | Overhead and profit ranges (*context only, never defaults*) | home-office overhead 3% (large) to 10% (small contractors) of contract amount; overhead 7% to 20% of volume of work; profit 3% to 10% of direct plus indirect cost | % of **revenue** for the overhead figures | US Army (1997 text, cancelled); state DOT estimating guides | as dated | thumb | R (Army); X (state guides; one verification pass could not confirm them) | https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ARCHIVES/ufc_3_700_02a_2005.pdf ; https://apps.itd.idaho.gov/apps/manuals/Const-Cost-Estimating-Guide.pdf |
| D-66 | Small tools allowance | typically 2% of direct labor cost for the prime contractor (1997 text: up to 12%); must not also be in overhead | % | US DoD estimating guidance | 2026-02-02 | rate | R | https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ufs_3_740_05_2026.pdf |
| D-67 | DoD weighted-guidelines profit (*reference calculator*; Government estimates and negotiated changes, not a cap on a bid) | each of 7 factors weighted 0.03 to 0.12, so profit 3% to 12%; size-of-job weight 0.12 at 100,000 or less, linear to 0.05 at 5,000,000, 0.04 for 5 to 10 million, 0.03 above; factor rates 20/15/15/15/5/5/25 (historical, from the cancelled 2005 edition) | weight; % | US DoD | 2026-02-02 (weights); 2005 (rates) | rate | R | https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ufs_3_740_05_2026.pdf |
| D-68 | Change-order markup limits (*context*; specific owners; **never applied to a bid**) | GSA: profit at most 10%, subcontracted work at 50% of own rates and at most 10% combined; VA: 10 / 7.5 / 5% on the first 20,000 / next 30,000 / balance, for changes of 500,000 or less; NASA: 10 / 10 / 10; Caltrans force account: labor 35%, equipment 15%, materials 15%, subcontractor +10% | % | owner-specific | as dated | law (contract clauses) | X / S | https://www.acquisition.gov/gsam/552.243-71 ; https://www.ecfr.gov/current/title-48/chapter-8/subchapter-H/part-852/subpart-852.2/section-852.243-70 |
| D-69 | FEMA cost-estimating factors (*context*, owner side) | contractor home-office overhead 7.7%; insurance and bonds 3.3% in total | % | US FEMA | 1999-era tool | rate | S | https://www.fema.gov/sites/default/files/documents/fema_pa-cef-instructional-guide.pdf |
| D-70 | Nevada small public works solicitation (NRS 338.13862) | estimated cost over 25,000 up to 100,000: at least three licensed contractors; 25,000 or less: at least one | contractors solicited | Nevada | 2025 NRS | law | X | https://law.justia.com/codes/nevada/chapter-338/statute-338-13862/ |
| D-71 | Nevada bidder preferences | 5% on public works with estimated cost over 250,000 (certificate of eligibility plus affidavit within 2 hours of opening); on State public works under 250,000 a qualifying veteran-owned local business's bid is deemed 5% lower | % | Nevada | current | law | X | https://www.leg.state.nv.us/nrs/NRS-338.html |
| D-72 | Federal award rule and HUBZone preference (corrected) | award on price and price-related factors to the responsible bidder with the conforming bid most advantageous to the Government; HUBZone: 10% added to offers other than non-waiving HUBZone small businesses and otherwise-successful small businesses | % | US federal | current | law | X | https://www.acquisition.gov/far/14.408-1 ; https://www.ecfr.gov/current/title-48/section-19.1307 |
| D-73 | Federal construction magnitude ranges | under 25,000; 25,000 to 100,000; 100,000 to 250,000; 250,000 to 500,000; 500,000 to 1,000,000; 1 to 5 million; 5 to 10 million; over 10 million | USD | US federal | current (FAR 36.204) | law | X | https://www.acquisition.gov/far/36.204 |
| D-74 | Owner-side award guidelines by number of bids (*legacy guidance*) | FHWA 2004 table: 1 bid 100%, 2: 105%, 3: 110%, 4: 115%, 5: 120% of the engineer's estimate; Washington DOT: 3 or more 110%, 4 or more 115%, 5 or more 120%; FHWA legacy accuracy target: estimate within 10% of the low bid for at least half of projects | % of engineer's estimate | US federal-aid highway; Washington | 2004 text (dropped in 2021); manual as indexed | guidance | R (FHWA); X (Washington) | https://www.fhwa.dot.gov/programadmin/contracts/cacc.pdf ; https://www.wsdot.wa.gov/publications/manuals/fulltext/m27-02/adandaward.pdf |
| D-75 | Low bid versus engineer's estimate by number of bidders (*context*; highway work) | Washington FY1985: 1 to 2 bidders +9 to +10%, 3 to 5 +1 to +2%, 6 or more -2 to -4%. Washington 2017 to 2024: +65.5 / +10.3 / +3.9 / -3.0 / -5.5% for 1 / 2 / 3 / 4 / 5 or more (mapping inferred from chart order). Colorado 2011 to 2015: -0.90, -2.53, +1.78, -0.22, -5.23, -4.32, -5.48, -8.13% for 1 to 7 and 8 or more. Kentucky 2018 to 2023, awarded over estimate: 100.5, 93.5, 93.2, 92.1% for 1 to 4 bidders (the printed average is not the mean of the year columns). Maine, large one-bid projects: +15% | % | as named | as dated | study | R (Colorado); X (others) | https://www.codot.gov/business/eema/assets/fhwa-validation-of-project-level-construction-cost-index-estimation-methodology.pdf ; https://apps.legislature.ky.gov/lrc/publications/ResearchReports/RR488.pdf |
| D-76 | Statistical constants | expected maximum of N standard normals 0.5642, 0.8463, 1.0294, 1.1630, 1.2672, 1.3522, 1.4236 (N = 2 to 8), 1.5388 (N = 10); kernel bandwidth 0.9 x min(s, IQR/1.34) x n^(-1/5); logistic models: at least 10 events per predictor | number | mathematics / statistics | n/a | mathematics; thumb | recomputed by the verifier | https://www.itl.nist.gov/div898/software/dataplot/refman1/auxillar/kernplot.htm ; https://doi.org/10.1016/s0895-4356(96)00236-3 |

### 8.7 Time, place and reference data

| ID | Name | Value | Unit | Jurisdiction | Effective | Kind | Ev | Source |
|---|---|---|---|---|---|---|---|---|
| D-77 | DoD escalation table (*reference*; budget guidance, not a forecast) | projected rates FY2026 2.1%, FY2027 onward 2.0%; factors 1.021 (1 Oct 2026), 1.04142, 1.0622484, 1.083493368, 1.10516323536, 1.1272665000672 (base 1 Oct 2025 = 1); Selling Price Index Oct 2023 172.87, Oct 2024 179.05, Oct 2025 186.35 (Oct 2007 = 100); assumed midpoint: halfway through a 15-month project awarded in March | %; factor; index | US DoD | guidance dated 2026-03-25 | rate | R | https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ufs_3_701_01_2026_Data_Tables.xlsx |
| D-78 | DoD Area Cost Factors, MILCON / Sustainment (*context only*) | NAS Fallon 1.20 / 1.21; Nellis 1.17 / 1.22; Creech 1.23 / 1.27; Hawthorne 1.30 / 1.31; Carson City and Reno 1.17 / 1.19; Las Vegas (non-Nellis) 1.13 / 1.17; Travis 1.27 / 1.33; Beale 1.22 / 1.27; Sierra Army Depot 1.26 / 1.31; Bridgeport 1.27 / 1.32; Sacramento 1.18 / 1.22; San Diego 1.13 / 1.18; Camp Pendleton 1.11 / 1.15; Los Angeles AFB 1.11 / 1.16; San Francisco 1.32 / 1.38. Basket weights materials / labor / equipment 63 / 35 / 2 (MILCON), 46 / 53 / 1 (Sustainment) | factor, national average = 1.00 | Nevada; California | 2026 edition; workbook saved 2026-06-08 (re-download before use) | rate | R | https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ufs_3_701_01_2026_Data_Tables.xlsx |
| D-79 | BLS PPI values, May 2025 to May 2026 (final) | WPU10260314 459.176 to 564.877 (Sep 2026 607.705 preliminary); WPU11710216 204.296 to 207.695; WPU1175 374.197 to 413.241; WPU1083 235.199 to 243.385; PCU23821X23821X 171.680 to 178.148; WPUIP2312001 164.704 to 179.556; PCU236223236223 210.845 to 218.935; all indexes revisable up to four months after publication | index | US national | pulled 2026-11-13 | study | R (API) | https://api.bls.gov/publicAPI/v2/timeseries/data/ |
| D-80 | BLS OEWS electricians (47-2111), hourly | mean: US 34.37; Nevada 36.40; Reno 35.20; Carson City 40.86; Balance of Nevada nonmetropolitan 38.81; Las Vegas 36.16; California 41.28; Sacramento 38.40. Nevada percentiles: p10 22.17, p25 23.52, median 35.37, p75 46.42, p90 58.27 | USD per hour, straight time, no benefits | as named (area names not verified) | May 2025 | study | R (API) | https://api.bls.gov/publicAPI/v2/timeseries/data/ |
| D-81 | FHWA National Highway Construction Cost Index (*context*; highway bid items only) | 2003 Q1 = 1; 2025 Q1 3.162838217; 2026 Q1 3.134822428 | index | US national | fetched 2026-11-13 | study | R | https://data.transportation.gov/resource/r94d-n4f9.json |
| D-82 | Price-adjustment clause parameters | FHWA advisory: trigger 3% to 10% (5% suggested by AASHTO), ceiling 25% to 100% increase from the material's base price; FAR 52.216-4: increases at most 10% of the original unit price, no adjustment below a 3% net change of the then-current total contract price | % | US federal-aid guidance (1980); federal contracts with the clause | as dated | guidance; law | R | https://www.fhwa.dot.gov/programadmin/contracts/ta50803.cfm ; https://raw.githubusercontent.com/GSA/GSA-Acquisition-FAR/master/dita/52.216-4.dita |
| D-83 | Midpoint-of-construction convention | escalate to the midpoint of construction; with a cost-loaded schedule, by activity | rule | US DoD; GSA | 2026-02-02; 2022-11-07 | guidance | R | https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ufs_3_740_05_2026.pdf ; https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/GSA/p120_2022.pdf |
| D-84 | Caltrans cost index (for adjusting Caltrans rows only) | 2020 = 100; 2024 Q1 to Q4: 190.72, 168.45, 197.13, 141.33; 2025: 210.72, 204.25, 166.63, 149.76; 2026 Q1 126.75, Q2 146.53 (also the site's "current" index); adjustment uses the bid-open quarter | index | California | read 2026-11-12 | rate | R | https://sv08data.dot.ca.gov/indexes.php |
| D-85 | Agency rules of thumb for reading bid data | at least 20 results for a usable average; average not representative when the standard deviation exceeds the minimum or average price; compare quantities within an order of magnitude; bids treated as normal from 20% under to 10% over the engineer's estimate | rows; % | California (district guidance) | read 2026-11-12 | thumb | R | https://sv08data.dot.ca.gov/searchtips.php |
| D-86 | Federal electrical awards in Nevada, size distribution (*context*; thin sample) | n = 36; min 3,380.00; p25 12,271.75; median 38,209.62; p75 82,771.61; p90 166,702.02; max 2,838,934.31 (dollars obligated to date) | USD per award | Nevada, federal awards, NAICS 238210 | 2024-11-13 to 2026-11-13 | study | R (API re-run) | https://api.usaspending.gov/api/v2/search/spending_by_award/ |
| D-87 | Public unit-price observations (*context*; roadway electrical only; store as dated rows) | Washington conduit pipe 2 in.: low bids 30.35, 85.00, 30.00 per LF, quantity-weighted state average 33.04 (3 contracts); California loop detector 480.00 and 725.00 each (2 awarded rows); Oregon illumination "unit" prices are lump sums divided by a plan quantity; Albuquerque figures are an engineer's list, not bids | USD per unit | Washington; California; Oregon; New Mexico | 2024 to 2026 | rate | R | https://wsdot.wa.gov/biz/contaa/uba/ ; https://sv08data.dot.ca.gov/ |

---

## 9. Assumptions table (conventions and unverified values; each editable; each shown to the user as an assumption)

| ID | Assumption | Engine default | Why it is not in section 8 |
|---|---|---|---|
| A-1 | Bond rate schedule when the contractor has not entered their surety's | sample D-38 with a visible "illustrative rates" label | Real rates are filed per surety and priced per contractor; the sample is a 2010 advisory reprint with a corrected tier |
| A-2 | One premium covers both the performance and the payment bond; a bid bond costs nothing | true; 0 | The handbook sentence could not be opened by the bonds verifier; "nominal" bid-bond cost rests on a 1975 report |
| A-3 | Bonding capacity without a surety letter | display-only estimate: single job about 10 x adjusted working capital, aggregate about 10 to 20 x the lesser of working capital and net worth; never a pass or fail | Broker and CPA articles, not opened; state rules in D-57 are analogues only. With both multiples at 10 the aggregate test always dominates: use a larger aggregate multiple or enforce aggregate >= single |
| A-4 | Surety liquidity rules of thumb | working capital about 10% of backlog (7% to 10% for subs); credit line about 10% of backlog; current ratio above 1.2; debt to equity below 2.5 | Unverified trade sources |
| A-5 | Owner-side default markups (10% overhead, 10% profit, 0.5% bond; FEMA's 1.5 / 0.3 / 1.5 split; FEMA profit table) | **not used** | Federal Lands handbook text unreachable; FEMA table incomplete. Estimate defaults for larger general contractors |
| A-6 | Part months in the bond duration surcharge | whole months, rounded up | Not specified in the source |
| A-7 | Home-office overhead and profit rates | **none: the contractor must enter them**; D-65 ranges shown as context | No law or public source fixes them; trade benchmark reports are paid and the figures quoted on vendor blogs conflict |
| A-8 | Annual taxable wages `W` when not entered | 2,000 hours x straight-time cash wage | Illustration convention; burden depends on it |
| A-9 | FUTA credit reduction for 2026 | Nevada 0 with a warning; California requires an explicit entry | The final 2026 list was not published when checked; California's potential figure is 1.5% and could be 5.3% if an add-on is not waived |
| A-10 | Nevada workers' comp payroll cap from 2027-01-01 | keep 98,433.60 with a "check the new cap" warning | The cap is re-set each January; the 2027 figure (102,452.16 if the fiscal-2027 wage figure is adopted) is not verified |
| A-11 | Workers' comp rates | **none: from the contractor's policy**; bureau figures (D-15) are reference only | Nevada class 5190 loss cost (1.89 in March 2025, superseded three times) and the assigned-risk multiplier (1.499) could not be verified. A loss cost is not a rate |
| A-12 | Workers' comp payroll rules outside Nevada: overtime premium excluded when recorded separately; plan contributions excluded; cash in lieu included | `excludeOtPremium = true` outside Nevada | Bureau manual wording not opened |
| A-13 | General liability premium basis and rates | from the contractor's policy; no default | Rating-manual text not reached |
| A-14 | Sales tax rate | **none: entered per job location** | Local rates were not researched |
| A-15 | Reading of the Nevada rounding statute as "truncate to three decimals, then round" | half-up to the cent | The statute says only "computed to the third decimal place"; the other reading differs in about 5% of cases |
| A-16 | In Nevada the contractor is the consumer and pays sales tax on materials, even for an exempt owner | materials taxable | The tax bulletin was not independently read |
| A-17 | Freight is not taxable | `freightTaxable = false` | State-specific; not verified for Nevada |
| A-18 | Small tools: base is burdened direct labor; 2% also applied to a subcontractor | `st = 2%` on `L` | The guide says "direct labor cost ... for the Prime Contractor"; base and applicability are our reading |
| A-19 | Contingency 0, placed before overhead with escalation | `c = 0` | Placement is convention; a bid from finished plans carries no design contingency |
| A-20 | Financing cost placed after profit, computed in one pass | included, shown as its own line | Our convention; the fixed point is slightly lower |
| A-21 | Forward escalation rate | **none: the user enters it**, with a sensitivity range | Published 2.0% to 2.1% is budget guidance; realized changes were higher |
| A-22 | Cost-proportional schedule of values; a billing that crosses the 50% point is split pro rata; the Nevada half release arrives with the first payment after 50% | as stated | Modelling conventions; the statute does not settle the crossing billing |
| A-23 | Winner's-curse inputs | `kappa = 0` (off) until the contractor sets `sigma` from their own estimate-versus-actual history | Judgment parameters |
| A-24 | Near-optimal tolerance `delta` | 0.05 | Product setting, not sourced |
| A-25 | Display thresholds | "not enough data" below `J = 10`; no 10% tail below `J = 29`; unit-price band label "thin" below `n = 20`, no flag below `n_min = 5`; staleness threshold for dated quotes | Design choices; 29 and 59 are mathematical minimums for tail bounds |
| A-26 | Cash-timing conventions | supplier terms net 30, no deposit, unless entered; pay-first ordering within a period; outflow lags rounded down, inflow lags rounded up | Conventions; contract- and vendor-specific |
| A-27 | Safety buffer on peak float | `beta = 0` | No authoritative value found |
| A-28 | Owner-payment stress cases | +30 and +60 days | Legal deadlines are maximums for proper undisputed requests; survey averages (51 and 96 days) are unverified |
| A-29 | Day-count basis for financing | 365 | Set by the loan agreement; federal late-payment interest uses 360 |
| A-30 | Timing details not read | the federal 14-day period can be lengthened by contract; Nevada retainage release per contract; California late interest on a 365-day basis | From memory or not captured |
| A-31 | Productivity factors | 1.00 | Estimator judgment, logged with a reason |
| A-32 | Location context | nearest listed ACF site for a county with no row (Carson City for Douglas County); small-area wage ratios flagged low confidence; price parities not shipped | Mapping is ours, not the publisher's; parity values unverified |
| A-33 | Synthetic-contractor generator fields without a published anchor | working capital, credit line, bonding limits, crew-size distribution, labor / material / subcontract split | No free published data; marked `ASSUMPTION` in code; simulated companies are never shown as real |
| A-34 | 2027 tables beyond the confirmed wage bases | Nevada unemployment rates unchanged; California 2027 values not loaded | Not published or not found |
| A-35 | PPI series titles and reference bases | as listed in section 6.5 | The keyless API returns values only |
| A-36 | SBA fee notice exception clause | none modelled | Clause text truncated |
| A-37 | Nevada retainage rule applied to small solicited works; mobilization paid like any other cost unless the bid documents stage it | as stated | Not confirmed for the small-works procedure; schedules are agency-specific |
| A-38 | Dual overhead rate: non-labor base is all of `TJC - L`; weight `X` | contractor enters `X` | The method is attributed only by secondary sources; no standard `X` |
| A-39 | Davis-Bacon coverage threshold | from the solicitation | Mentioned by the verifier (over $2,000) without a captured quote |
| A-40 | Bid-security rule on Nevada and California bid forms | `difference` | Not checked |

---

## 10. Invariants for property-based tests

### 10.0 Test plan the invariants plug into

Tooling confirmed to work together: fast-check 4.10.2, @fast-check/vitest 0.5.0, Vitest 5.1.0 (needs Node 22.12 or newer, although the project file says Node >= 20.10), StrykerJS 10.1.1.

| Layer | What | Cadence |
|---|---|---|
| L0 | Published golden examples (section 11, "published") via `test.each`, each fixture with its source URL and its own rounding mode | every pull request |
| L1 to L4 | Properties below: primitives, components, whole bid, metamorphic relations | pull request: pinned seed, 1,000 runs per property; nightly: random seed (printed), 100,000 runs |
| L5 | Differential test against a slow exact reference (BigInt fractions, written independently, **no shared code**, rounding at the same points); sample it, it is slow by design | pull request (few hundred cases); nightly (more) |
| L6 | Seeded Monte Carlo of synthetic contractors and jobs, with calibration checks | pull request (20,000 pairs price in well under a second) |
| L7 | Mutation testing on the cost modules, seed pinned; target at least 95% | before each release |
| L8 | Regression corpus: every shrunk counterexample ever found, kept as an explicit example | every pull request |

Rules that matter:

- **Pin the seed** (`fc.configureGlobal({ seed })` in a Vitest setup file). The default seed changes every run and is written into test names; unpinned, mutation testing could not match tests between runs and scored 36.9% to 53.9% instead of 82.3%.
- Passing tests are evidence, not proof: zero failures in `N` runs bound the failure rate at about `3/N` (1,000 runs: 0.30%) **under the generator's own, edge-biased distribution**. The proofs here are the short arguments (gross-up existence, error bound, statute equals half-up); tests confirm the code matches them.
- Good-looking properties can be too weak: the first 27 properties all passed while two arithmetic mutations in the leftover-cent logic survived. Mutation testing is the check on the tests.
- Generators: bounded `fc.integer` for cents (the unbounded default stops near $21.47 million); never `fc.float` for money; `fc.double` only with `noNaN` and bounds; `fc.noBias` for Monte Carlo sampling (the default puts 18.6% of draws next to a bound); never `Math.random`.
- Force boundary values at every legal threshold: threshold minus one cent, the threshold, threshold plus one cent.
- Do not assert equalities that are false. Splitting a line, summing per-item tax, or taxing per paycheck changes the answer by cents: state bounds.

Synthetic contractors and jobs (the user asked for made-up but realistic companies): every generated field carries either a published anchor or the word `ASSUMPTION` in code.

| Field | Anchor |
|---|---|
| Hourly wage | Nevada electrician percentiles (D-80), sampled by percentile-table interpolation |
| Job size | the 36 real federal Nevada awards (D-86): **resample them**, or interpolate log-linearly above p90. Linear interpolation to the maximum overstates the mean by 38.6% |
| Overhead, profit | D-65 ranges, converted to a cost basis |
| Firm size | below the $19.0 million size standard (D-59) |
| Payroll tables, retainage, payment lags, thresholds | section 8 |
| Working capital, credit line, bonding limits, crew size, labor / material / subcontract split | `ASSUMPTION` (A-33) |

Percentile-table sampler: draw `u` uniform on [0, 1), interpolate between the two published points that bracket `u`, clamp outside the table (the clamp puts 10% of draws exactly on each end value; acceptable for tests, labelled). Triangular three-point sampler: `u < (c-a)/(b-a) ? a + sqrt(u(b-a)(c-a)) : b - sqrt((1-u)(b-a)(b-c))`; mean `(a+b+c)/3`; variance `(a^2+b^2+c^2-ab-ac-bc)/18`. Simulation standard error of a mean is `sigma/sqrt(N)`; use 4 standard errors as the tolerance so calibration tests do not flake.

Notation: money in integer cents; rates in ppm; `round` = half-up to the cent on non-negative values.

### 10.1 Money primitives

1. `divRoundHalfUp(n, d)` is nearest with ties up: `abs(2*(q*d - n)) <= d`; if `2*(n mod d) = d` then `q*d > n`; the result equals the value computed with exact BigInt fractions.
2. `mulRate(x, 1_000_000) = x`; rounding an already whole-cent amount changes nothing.
3. For `a <= b` and `r <= 100%`: `mulRate(a, r) <= mulRate(b, r)` and `0 <= mulRate(a, r) <= a`.
4. `abs(mulRate(a+b, r) - mulRate(a, r) - mulRate(b, r)) <= 1` cent.
5. The Nevada procedure (truncate to the third decimal of a dollar, round up when that digit is greater than 4) returns exactly `mulRate(ext, rate)`.
6. `abs(sum_i mulRate(x_i, r) - mulRate(sum_i x_i, r)) <= floor(n/2)` cents.
7. `allocate(T, w)`: the parts sum to `T` exactly.
8. `allocate`: each part differs from its exact share `T*w_i/W` by less than 1 cent; a zero weight gets zero; no part is negative.
9. `allocate` rule is pinned: a line with a larger remainder never receives less of the leftover than one with a smaller remainder; ties go to the lowest index; the output equals an independent one-cent-at-a-time oracle.
10. Refusal: negative amounts, a zero or negative divisor, all-zero weights, a rate without a base tag, or any result outside the safe-integer range throw `RangeError`; no function returns `NaN`, an infinity or a non-integer amount.
11. `allocate(T, w)` succeeds for any safe-integer `T` and weights (for example a $1,000,000.00 total over weights of $950,000.00 and $50,000.00).
12. Every reported total equals the sum of its reported lines (no re-rounding); every figure is a non-negative safe integer.

### 10.2 Tiers and price-based charges

13. `q(0) = 0`; for `d >= 0`: `0 <= q(x+d) - q(x) <= ceil(k_max*d) + 1`, with `k_max = m_dur*r_max + f`.
14. `k_min*x - 1 <= q(x) <= k_max*x + 1` cents.
15. At each breakpoint `b`, with `k_max < 1`: `q(b+1) - q(b)` and `q(b) - q(b-1)` are each 0 or 1 cent (no jump).
16. Splitting any tier into two tiers with the same rate does not change `q(x)` for any `x`.
17. With non-increasing tier rates the unrounded premium is concave, its average rate is non-increasing in `x` and lies between the last and first rate, and it is sub-additive.
18. `m_dur >= 1`, non-decreasing in months, and exactly 1 for months `<= M1`.
19. Gross-up: `P - q(P) = S` exactly and `P - 1` does not satisfy `>= S`; `P >= S`; `P` is strictly increasing in `S`; the function throws when `k_max >= 1`.
20. Differential: direct cost, `S` and `P` from the engine equal the independent slow exact reference for every generated bid.
21. One flat rate, no rounding: `P = S/(1-b)` and `S*(1+b) <= S/(1-b)`.
22. SBA fee: non-decreasing in contract amount; 0 for bid bonds; refused above the contract limit; the rate switches exactly at approval date 2026-11-30; `abs(feePayable - unrounded fee) <= 50` cents.

### 10.3 Labor and burden

23. Capped tax: `T = r*W` for `W <= B`, `r*B` for `W >= B`; non-decreasing in `W`; never above `r*B`; changes by 0 or 1 cent across the cap.
24. For any sequence of pay amounts and any cap, the per-period taxable slices sum to `min(total wages, cap)` exactly.
25. `effRate(rate, W, cap) <= rate`, equals `rate` for `W <= cap`, and is non-increasing in `W`.
26. Employer Social Security plus Medicare is exactly 7.65% of wages whenever `W <=` the wage base; above it the marginal rate is exactly 1.45%.
27. The Additional Medicare tax and California SDI never change employer cost at any wage.
28. With no credit reduction FUTA per employee lies in [0, $42.00]; it equals `(0.6% + CR) * $7,000` once `W >= $7,000`.
29. Nevada unemployment plus CEP for a 2026 new employer never exceeds `3.00% * $43,700 = $1,311.00` per employee; CEP is 0 exactly when the assigned rate is 5.4%; California UI is at most $434.00 and ETT at most $7.00 per employee.
30. `MBT_q >= 0`; it is 0 whenever quarterly wages less the health deduction are at most $50,000; above that it rises by 1.17 cents per extra wage dollar; a larger health deduction never raises it.
31. `L_k >= G_k + FR_k + TR_k + OTH_k`, with equality only when every tax and insurance rate is zero. Flat mode: `R(ot=0, ti=0) = B + F + T`; with `F = T = 0`, `R` is homogeneous of degree 1 in `B`.
32. Overtime premium percent is 0 with no overtime hours and lies in `[0, max multiplier - 1]`; 8 overtime hours at 1.5x in a 48-hour week give exactly 4/48.
33. Hour buckets partition the hours worked; no hour is in two buckets; California: `h20 > 0` only if a day exceeds 12 hours or the 7th-day hours exceed 8.
34. Nevada private regime: daily-overtime hours are 0 for any worker paid at least 1.5 x minimum wage ($18.00), whatever the daily hours; weekly overtime still applies.
35. Davis-Bacon week: `Pay = H*(BHR+FB) + 0.5*basicRate*max(0, H-40)`; the premium term is 0 for `H <= 40`; pay is continuous and piecewise linear in `H`. Crossing the $100,000 contract line changes the governing-law label and no dollar.
36. Prevailing-wage compliance holds on every hour including overtime hours, or the engine returns an error.
37. For a fixed prevailing-wage package, moving dollars from cash in lieu to bona fide plan contributions never raises employer cost; the saving equals the dollars moved times the marginal tax and insurance rates that apply to cash (below all caps except unemployment, $30,000 moved saves exactly `$30,000 * 7.65%` in Social Security and Medicare).
38. Workers' comp payroll never exceeds gross cash payroll; with the exclusion on it equals gross minus the overtime premium; in Nevada it equals gross (no exclusion) and is capped per employee; premium is linear in uncapped payroll and in the experience modification.
39. California class is a step at the threshold in force on the policy date: wage `>=` threshold maps to 5140, below maps to 5190.
40. Table years are monotone: Social Security base 176,100 <= 184,500 <= 192,300; Nevada unemployment base 41,800 <= 43,700 <= 45,400.

### 10.4 Direct cost and whole-bid structure

41. Waste changes material cost and never labor hours; the sales tax rate changes material cost and never labor cost.
42. `MAT >= M`; a non-taxable line adds its full extension to `MAT` and nothing to the taxable base; `TAX = 0` when `s = 0`.
43. A line with a price hold through its purchase date has `esc_i = 0` exactly; labor at a known scheduled rate has `ESC_L = 0`.
44. Adding `d` of subcontract cost to a bid without tiers raises `S` by `d*(1+c)*(1+o_c)*(1+p_c)` within `(1+o_c)*(1+p_c) + (1+p_c) + 1` cents (two runs, three roundings each; the verifier's prototype, which has no contingency step, held within 2.5 cents).
45. Conservation: `TJC = L + ST + MAT + E + SUB + JOOH + ESC_L + CONT`; `S = TJC + OH + PR + FIN`; `P = S + q(P)`.
46. Monotonicity: raising any one non-negative input (hours, wage, any burden rate, quantity, price, waste, tax, overhead, profit, a tier rate) never lowers `P`; and `P >= S >= BE >= TJC`.
47. Metamorphic: permuting lines changes nothing; adding a zero-hour or zero-quantity line changes nothing; splitting one line into two with the same rates changes `S` by at most the section 3.9 bound (generally not by zero).

### 10.5 Markup, overhead, distribution

48. In exact fractions markup to margin to markup is the identity; margin `< 1`; margin `<=` markup for markup `>= 0`. (In floats the round trip is not exact; compare in fractions.)
49. `P*(1-m) = C` and `C*(1+k) = P`.
50. The overhead-profit product does not depend on the order of the multipliers, and `(1+o)(1+p) >= 1+o+p`.
51. `abs(PR - p_c*(TJC+OH)) <= 0.5` cent and `abs(OH - o_c*TJC) <= 0.5` cent: profit's base includes overhead.
52. `TJC/(1-o_s-m_s) = TJC*(1+o_c)*(1+p_c)` with `o_c = o_s/(1-o_s-m_s)`, `p_c = m_s/(1-m_s)`, in exact fractions.
53. `on_sales` method: `TJC + OH + PR = S0` exactly and `abs(OH - o_s*S0) <= 0.5` cent.
54. Overhead recovery: `recovered = OH_annual * DC_actual/DC_plan`; labor-hour allocations sum to `OH_annual` when job hours sum to the plan; dual rate `r_L*L_annual + r_M*MS_annual = OH_annual` exactly.
55. Break-even: profit as a function of revenue is zero at `BE_revenue`, negative below, positive above.
56. For bids with no tiers, wage caps or thresholds, the exact price is homogeneous of degree 1: `exact(k*x) = k*exact(x)`; rounded, `abs(price(k*x) - k*price(x)) <= (k+1) * bound`. Do **not** assert this across tiers, wage-base caps or legal thresholds.
57. Item indirects sum to the indirect total and item prices sum to `P_bid` exactly.
58. `0 <= P_bid - P < unit`, and the difference appears in the profit line.

### 10.6 Bonds, thresholds, retainage

59. `FLOOR <= S_bid <= CAP`; non-decreasing in the bid; equals `p*bid` whenever that lies between them; the federal cap binds exactly for bids of $15,000,000 and above at 20%.
60. Federal walk-away exposure is `max(0, B_next - B)` whatever the guarantee amount; under the `difference` rule it never exceeds `S_bid`.
61. Legal thresholds are intentional jumps and occur only where the law puts them: a contract of exactly $150,000.00 (federal), $100,000.00 (Nevada) or $25,000.00 (California payment bond) does not trigger; one cent more does. Test each location; do not assert monotonicity or continuity across them.
62. Per billing `0 <= W_j <= max(rho1, rho2) * B_j` (plus half a cent of rounding per part).
63. At every period: net payments + retainage held + retainage released = gross billings; by closeout everything withheld has been released.
64. Without a half release, total withheld equals `rho1*min(E, theta*C) + rho2*max(0, E - theta*C)` however the same work is split into billings (exact arithmetic; within one cent per billing after rounding).
65. Gross withheld never exceeds the cap (California 5% of contract price; NDOT `min(5%, $50,000)`; federal 10%).
66. Nevada half release equals half of the retainage withheld before the 50% point, happens once, and retainage held is never negative.
67. Retainage financing cost is non-negative before interest credits, linear in `i` and in the retainage rate, non-decreasing in the release delay, and 0 when either is 0; the uniform closed form equals the discrete sum.
68. Late-payment interest is 0 for zero days late, linear in principal, and (simple form) linear in days.
69. The premium true-up has the sign of `C_final - C_orig`.

### 10.7 Cash float

70. `sum OUT = C_cash`; `sum IN = P`; `N(H) = P - C_cash`.
71. Every period: `N(t) = GP(t) + OU(t) - AR(t) - RR(t) + AP(t)`.
72. `0 <= F*_rf <= F* <= C_cash`.
73. `F*` is at least all cash paid up to and including the period of the first receipt.
74. Scaling every dollar input by `k` scales `F*` and every balance by `k`.
75. A longer owner payment lag never lowers `F*`.
76. Higher retainage never lowers `F*` (given retainage is not released before the last progress receipt).
77. A higher markup at the same cost never raises `F*`.
78. Longer supplier terms or a later payday never raise `F*`; a larger deposit share never lowers it.
79. Coarser **nested** billing (`b` replaced by a multiple of `b`) never lowers `F*`. `F*` is not monotone in `b` in general: never test that it is.
80. Uniform cost paid when incurred equals the closed form of section 5.5 exactly.
81. If the peak occurs on or before the first receipt, changing retainage or markup leaves `F*` unchanged.
82. A zero interest rate reproduces the unfinanced path; total interest `>= i_per * sum max(0, -N(t))`; the financed peak is at least the unfinanced peak; financed final cash `= P - C_cash - FIN`.
83. Pay applications sum to `P`; billed to date never exceeds `P`; under cost-proportional billing `billedMinusEarned <= 0` between bills and is exactly 0 on bill dates and at the end.
84. Every cost-flow shape has `S(0) = 0`, `S(1) = 1` and is non-decreasing; weights are non-negative and sum to exactly 1; the trapezoid with one-third ramps gives exactly 25% and 75% at one third and two thirds.
85. The portfolio peak of jobs on one calendar is at most the sum of the individual peaks.
86. More cash or credit never turns `fits` into `short`; headroom is linear in funds.

### 10.8 Time and place

87. `factor(t, t) = 1`; `factor(t1, t2) * factor(t2, t1) = 1`; `factor(t1, t3) = factor(t1, t2) * factor(t2, t3)`; the same three for places.
88. Multiplying every index value by `k > 0` leaves every factor unchanged (before rounding of published values).
89. `adjust(k*c) = k*adjust(c)` and `adjust(a+b) = adjust(a) + adjust(b)` under one factor; if `I(t2) >= I(t1)` and `c >= 0` the adjusted cost is at least `c`.
90. A composite factor is the dollar-weighted mean of line factors, so it lies between the smallest and largest line factor; sum of adjusted lines = composite x sum of base lines (one final rounding).
91. The product of consecutive period relatives equals the endpoint ratio; `(1+r_eq)^(m/12)` reproduces `I2/I1`; `F(Y) = F(Y-1)*(1+r_Y)`, never a sum of rates.
92. An interpolated factor lies between its two anchors and equals them at the anchor dates; linear minus geometric interpolation is in `[0, F*r^2/8]` within one year.
93. `T_start <= T_mid <= T_end`; a zero-duration job has `T_mid = T_start`.
94. Place and time multipliers commute.
95. Index clause: a change below the trigger gives zero adjustment; an increase never exceeds the cap; indexed share 0 gives none; share 1 with no cap gives the plain ratio.
96. A missing index value, an index `<= 0`, values from two series or two bases, or factors from two editions raise an error and never fall back to 1.0.
97. A wage-ratio factor changes labor dollars only.
98. Unit-price band: `P10 <= P25 <= P50 <= P75 <= P90`, all inside `[min, max]`; the weighted average lies in `[min, max]`, equals the simple mean when quantities are equal, satisfies `sum q_i*(p_i - Pw) = 0`, and is unchanged by scaling all quantities or reordering rows; scaling all prices by `c` scales the band by `c`; excluded rows (lump sum, quantity-1 lump sums, non-positive price or quantity, lump-sum derived) never enter; mixed units raise an error; no row dated after the as-of date is used; the contractor's percentile rank never falls when their price rises.

### 10.9 Bid selection

99. `0 <= P_win <= 1` and `P_win(B)` is non-increasing in `B`, for every model and input.
100. No competitors gives `P_win = 1`; one competitor gives `p_1` in both the Friedman and Gates forms.
101. `Friedman <= Gates` for all `p_i` in (0, 1], with equality iff at most one `p_i < 1`; `(1 - Gates)/Gates = sum (1-p_i)/p_i`; all `p_i = 0.5` gives `1/(n+1)` (Gates) and `2^-n` (Friedman); both are symmetric under permutation; adding a rival with `p < 1` strictly lowers both, with `p = 1` changes nothing; any `p_i = 0` gives 0 without a division error.
102. The empirical estimate takes values in `{0, 1/J, ..., 1}` and is a non-increasing step function of `B`.
103. `EV(B) <= profitIfWon(B)` when the profit is non-negative; `EV = -K` where `profitIfWon = 0`; `EV < 0` below cost whenever `P_win > 0`.
104. For a fixed competitor curve the maximum expected profit is non-increasing in the number of competitors, in both models.
105. `p(m) = exp(-lambda*m)` under Friedman: the optimiser returns `m* = d + 1/(n*lambda)` and `P_win(m*) = exp(-1)`; `m*` (less `d`) halves when `n` doubles.
106. Multiplying all dollar inputs by `k` leaves `m*`, `P_win` and every ratio unchanged and multiplies `EV` by `k`.
107. Uniform benchmark: `b(c) >= c`, `b(1) = 1`, markup `(1-c)/n` strictly decreasing in `n`, and the expected lowest bid is `2/(n+1)` (Monte Carlo within tolerance).
108. `e_1 = 0`, `e_2 = 1/sqrt(pi)`, `e_3 = 3/(2*sqrt(pi))`, `e_N` strictly increasing; `C_adj >= C`, with equality when `sigma = 0` or `kappa = 0`; the function throws when `kappa*sigma*e_N >= 1`.
109. Wilson: `0 <= lower <= k/J <= upper <= 1`; for `k = 0` the upper limit is `z^2/(J + z^2)`; the width shrinks as `J` grows at fixed `k/J`. The DKW half-width is decreasing in `J` and the band is clipped to [0, 1].
110. The tail-sample rule `ceil(ln(0.05)/ln(1-q))` returns 59, 29, 14, 11, 5 for `q` = 0.05, 0.10, 0.20, 0.25, 0.50.
111. The preference rules are scale invariant, reduce to plain lowest price when no bidder holds a preference, and a small business's own HUBZone factor is 1.00.
112. The suggested range contains `B*`, never goes below the floor, widens (never narrows) as `delta` grows, and is replaced by `NO BID` when `EV(B*) <= 0`; `low <= recommended <= high`.
113. The Brier score lies in [0, 1]; a constant forecast equal to the base rate scores `pbar*(1-pbar)`; a perfect forecast scores 0.
114. Adequacy thresholds are non-decreasing in the number of competitive bids and defined only for 1 to 5.
115. `r = L/E` and `pct = (L-E)/E*100` satisfy `r = 1 + pct/100` and `r > 0`.

### 10.10 Simulation

116. The same seed gives byte-identical simulation output (compare a SHA-256 of the results); a different seed gives different output.
117. Every simulated bid satisfies invariants 45 and 46.
118. The generator reproduces each published anchor it claims (for example the wage median) within 4 standard errors.
119. Triangular samples stay inside `[a, b]`; the sample mean matches `(a+b+c)/3` within 4 standard errors and the variance matches the closed form within a stated tolerance.

---

## 11. Golden examples

"Published" = numbers printed in a public source and re-computed by the verifier. "Illustration" = made-up inputs with the arithmetic re-checked; illustrations are test vectors for the arithmetic, never evidence about real jobs, and must never be shown as market data. Every illustration below (and every published figure that could be re-run) is reproduced by `/tmp/claude-0/-home-user-wydbdbdj/16aa75d7-798d-5f2a-9ff0-ee877d241c81/scratchpad/research/scripts/cost_model_golden.py` (integer arithmetic; run with `python3 -I`).

### 11.1 Published

| ID | Source | Inputs and expected results |
|---|---|---|
| P-1 | DoD UFC 3-740-05 (2010, change 1) Figure 16-10, wage-rate form **[R]** | Flat mode `R = B*1.10*(1+ti) + F + T`, carried unrounded, rounded at the end. `(B, ti, F, T) -> R`: (20.49, 38.7%, 5.55, 2.00) -> 38.81; (18.49, 38.7%, 5.55, 2.00) -> 35.76; (16.47, 38.7%, 4.43, 3.00) -> 32.56; (14.47, 38.7%, 4.43, 3.00) -> 29.51; (18.97, 29.7%, 6.08, 5.00) -> 38.14 (rounding each column first gives 38.15); (14.80, 29.7%, 6.08, 5.00) -> 32.20; (17.91, 29.7%, 5.08, 3.00) -> 33.63 |
| P-2 | Same PDF, Figure 16-11, overhead 19.50% and profit 7.05% **[R]** | Whole-dollar half-up per row: direct 955,142 -> overhead 186,253 -> 1,141,395 -> profit 80,468 -> 1,221,863; direct 294,636 -> 57,454 -> 352,090 -> 24,822 -> 376,912. **Do not** use the form's totals row as a step-rounding test: it only foots with unrounded carry |
| P-3 | Same PDF, Figure 16-12, quantity x unit cost **[R]** | 52 x (23.34, 0.43, 6.67) = 1,213.68 + 22.36 + 346.84 = 1,582.88; 6,390 x (0.52, 0.52, 0.46) = 3,322.80 + 3,322.80 + 2,939.40 = 9,585.00; 80 x (15.50, 0.54, 65.80) = 1,240.00 + 43.20 + 5,264.00 = 6,547.20; 35 x (9.64, 0.32) = 337.40 + 11.20 = 348.60. Hours: 52 x 0.750 = 39; 6,390 x 0.014 = 89.46 (printed 89); 80 x 0.520 = 41.6 (printed 42); 35 x 0.920 = 32.2 (printed 32) |
| P-4 | Same PDF, Figure 16-2 **[R]** | 109,436 + 150,001 + 408,385 + 24,219 = 692,041; 32% distributed cost = 221,453; total 913,494; bid rounded up to 913,500 |
| P-5 | DoD UFS 3-740-05 (2 Feb 2026) Figure 12-1, "sample only" **[R]** | $2,500,000 including bond, 20 months, Class B: 2,500 + 6,000 + 20,000 = 28,500; surcharge 8 x 1% x 28,500 = 2,280; premium 30,780. Engine form (rates folded to 27.00 / 16.20 / 10.80, one rounding): `q($2,500,000.00) = $30,780.00`; `grossUp($2,469,220.00) = $2,500,000.00` |
| P-6 | UFS 3-740-05 Figures 5-1 to 5-3; UFC 3-700-02A Table 5-1 **[R]** | 52 paid / 48 worked: premium 8.33%. Table: 45 h week 5.56% at 1.5x (printed 5.55), 11.11% at 2x; 50 h 10.00 / 20.00; 55 h 13.64 / 27.27; 60 h 16.67 / 33.33; 6 x 8 h 8.33 / 16.67. 7.60 + 3.20 + 0.80 + 7.65 = 19.25% (example only; its 0.80% FUTA line is out of date) |
| P-7 | UFC 3-700-02A Example 6-1 **[R]** | 338/430 = 78.6% (printed 79); 207/430 = 48.1%; 190/430 = 44.2%; 140/430 = 32.6% |
| P-8 | California Office of Tax Appeals opinion **[X]** | cost 0.70, price 1.00: markup 42.86%, margin 30% |
| P-9 | US Department of Labor prevailing-wage examples **[X]** | 44 h at $27.00 + $18.00: 44 x 45.00 = 1,980.00; 4 x 0.5 x 27.00 = 54.00; total 2,034.00. 44 h at $12.00 + $2.50: 110.00 + 528.00 + 24.00 = 662.00 (also 662.00 when paid $10.00 cash + $4.50 fringe: the half-time stays on $12.00). Basic $34.00 of $55.00 total: overtime rate 72.00. $27 + $14 = $41 met by $41 cash, $27 + $14 plan, or $35 + $6 plan |
| P-10 | California DLSE Public Works Manual 4.2.3.1; Nevada Labor Commissioner handbook **[X]** | California $32.00 + $22.00: overtime hour 48.00 + 22.00 = 70.00. Nevada $70.00 + $5.00: 1.5 x 75.00 = 112.50 = 107.50 cash + 5.00 plan |
| P-11 | SSA, EDD, IRS **[X]** | 6.2% x 192,300 = 11,922.60; California UI maximum 7,000 x 6.2% = 434, ETT 7; a 0.3% credit reduction gives 0.9% FUTA |
| P-12 | 5 CFR 1315.17 **[X]** | 1,500 x 0.065/360 x 10 = 2.71 |
| P-13 | DoD UFS 3-730-01 and UFS 3-701-01 data tables; Army TM 5-800-4 **[R]** | 503 x 0.995 x 0.92 x 1.1173 x 1.00 x 1.05 x 1.05 x 1.0455 = 592.9954, printed 593.00 per square foot; 48,750 x 593 = 28,908,750. Interpolation: (1.1284 - 1.1062)/12 = 0.00185; 6 x 0.00185 = 0.0111; 1.1173. Compounding 2.1%, then 2.0% x 5: 1.021, 1.04142, 1.0622484, 1.083493368, 1.10516323536, 1.1272665000672. 1880/1869 = 1.005886. Index ratio 186.35/179.05 = 1.040771 |
| P-14 | FHWA-HRT-22-075; Michigan State Administrative Board minutes **[X]** | estimate 1,919,815.94, low bid 1,578,986.55: -340,829.39 = -17.75%. Low bid 629,137.87 against estimate 451,862.80: +39.23% |
| P-15 | Caltrans cost data; Washington DOT unit bid analysis; Oregon DOT bid data **[R]** | `P * 146.53 / I_from`: 725.00 at 168.45 -> 630.66; 480.00 at 126.75 -> 554.91; 80.00 at 168.45 -> 69.59; 400,000.00 at 168.45 -> 347,948.95; 76,000.00 at 197.13 -> 56,492.06; 700,000.00 at 141.33 -> 725,755.32; 541,000.00 at 204.25 -> 388,116.18. Quantities [278, 1,060, 17,841] at [30.35, 85.00, 30.00]: weighted 33.04; first two 73.65; simple mean 48.45. 32,000 / 420 = 76.19047619047619 (lump-sum derived) |
| P-16 | FHWA-HRT-14-034 reported premiums (high ends) **[X]** | Reproduced by the corrected D-38 schedule: $100,000 -> 2,500; $1,000,000 -> 13,500; $10,000,000 -> 81,000; $50,000,000 -> 341,000 |
| P-17 | FHWA legacy adequacy table **[R]** | 3 competitive bids, low bid at 108% of estimate: adequate (limit 110%); 2 bids at 108%: not adequate (105%); 5 bids at 121%: not adequate (120%) |

### 11.2 Illustration I-1: one Nevada job, end to end (every number)

Made-up inputs. Nevada local public work solicited as small works; estimated cost under $100,000, so no prevailing wage (D-30) and no statutory bond (D-35); regime `NV_PRIVATE`; 2026 tables; firm over the MBT threshold; workers' comp policy effective after 2026-10-01 and workers under the cap; general liability rated on receipts.

| Input | Value |
|---|---|
| Journeyman | 160.00 h straight + 8.00 h at 1.5x; cash $45.00/h; employer health plan $4.00/h; `W` = $90,000 |
| Apprentice | 120.00 h straight; cash $24.00/h; health plan $4.00/h; `W` = $48,000 |
| Unemployment | new employer 2.95% + CEP 0.05%; FUTA net 0.6% |
| MBT | marginal mode, 1.17% |
| Workers' comp | example policy rate $2.50 per $100, experience modification 1.00 |
| Small tools | 2% of burdened labor |
| Wire | 2,400 ft at $1.85, waste 5%; purchased 2 months after the quote, forward rate 6% a year |
| Conduit | 600 ft at $3.40, waste 3% |
| Gear package | 1 at $6,800.00 |
| Fixtures | 24 at $185.00 |
| Freight; sales tax | $350.00, not taxed; example rate 7.10% on the taxable base (not a verified local rate) |
| Equipment; subcontract | lift rental $650.00; trenching quote $3,200.00 |
| Job overhead | permit $420.00; supervision 12.00 h at $65.00; mobilization $300.00; cleanup $150.00 |
| Markups | contingency 0; overhead 15% `on_cost`; profit 10% on cost + overhead; financing line off |
| Price-based charge | general liability $6.00 per $1,000 of receipts; no bond |

| Step | Journeyman | Apprentice |
|---|---|---|
| Effective rates (ppm): Social Security / FUTA / Nevada UI + CEP | 62,000 / 467 / 14,567 | 62,000 / 875 / 27,313 |
| Cash wages `G` | 160 x 45.00 + 8 x 67.50 = 7,740.00 | 2,880.00 |
| Social Security | 479.88 | 178.56 |
| Medicare | 112.23 | 41.76 |
| FUTA | 3.61 | 2.52 |
| Nevada UI + CEP | 112.75 | 78.66 |
| MBT on (wages - health) | 1.17% x (7,740.00 - 672.00) = 82.70 | 1.17% x (2,880.00 - 480.00) = 28.08 |
| Workers' comp (overtime pay included) | 193.50 | 72.00 |
| Plan fringe | 672.00 | 480.00 |
| `L_k` | 9,396.67 | 3,761.58 |

| Line | Amount |
|---|---|
| Burdened labor `L` (cash wages 10,620.00) | 13,158.25 |
| Small tools `ST` | 263.17 |
| Material extensions `M`: 4,662.00 + 2,101.20 + 6,800.00 + 4,440.00 | 18,003.20 |
| Wire escalation: factor 1.06^(2/12) = 1.0097588, 9,759 ppm x 4,662.00 | 45.50 |
| Sales tax 7.10% x 18,048.70 | 1,281.46 |
| Freight | 350.00 |
| Materials `MAT` | 19,680.16 |
| Equipment `E` | 650.00 |
| Subcontract `SUB` | 3,200.00 |
| Job overhead `JOOH`: 420.00 + 780.00 + 300.00 + 150.00 | 1,650.00 |
| **Total job cost `TJC`** | **38,601.58** |
| Home-office overhead 15% of `TJC` | 5,790.24 |
| Break-even `BE` | 44,391.82 |
| Profit 10% of `BE` | 4,439.18 |
| `S` (price before price-based charges) | 48,831.00 |
| Price-based charge `q(P)` = 0.6% of `P` | 294.75 |
| **Bid price `P`** (`P - q(P) = S`; `P - 1` cent fails) | **49,125.75** |

Read-outs: markup on `TJC` 27.2636%; margin on price 21.4229% (`m = k/(1+k)` holds exactly); profit 9.0364% of price; overhead 11.7866% of price. Adding 15% + 10% instead of multiplying would give 48,251.98 before charges, short by `TJC*o*p` = 579.02. Rule checks: 49,125.75 does not exceed $100,000 (no Nevada statutory bond); the job is in the band where at least three contractors are solicited (D-70).

### 11.3 Other illustrations

| ID | Topic | Inputs and expected results |
|---|---|---|
| I-2 | Bonded gross-up | `S` = $180,000.00, sample schedule D-38, 5 months (`m_dur = 1`). No SBA fee: `P` = 183,756.35, premium 3,756.35. With SBA fee at $6.00 per $1,000: `P` = 184,882.53, total charge 4,882.53 (premium part 3,773.24), fee payable 1,109.00. At $7.29: `P` = 185,126.47, total charge 5,126.47 (premium part 3,776.90), fee payable 1,350.00 |
| I-3 | Corrected sample schedule, cumulative premium | $5,000,000 -> 47,250; $7,500,000 -> 64,750; $10,000,000 -> 81,000; $50,000,000 -> 341,000 (with the printed 7.50 fifth tier: 47,250; 66,000; 82,250; 342,250) |
| I-4 | Bid security and SBA fee | 20% of $1,000,000 = 200,000; the $3,000,000 cap binds from a $15,000,000 bid. SBA fee on $400,000: 2,400 at $6.00, 2,916 at $7.29 |
| I-5 | Gross-up search window (regression) | One flat 60% rate, `S` = 100,000 cents: `P` = 249,999 cents, `q` = 149,999. (A window of `2*S + 100` wrongly returned 200,100.) |
| I-6 | Burden, Nevada 2026, new employer, example $45.00/h, 2,000 h, `W` = $90,000 | Social Security 5,580.00; Medicare 1,305.00; FUTA 42.00; UI 2.95% x 43,700 = 1,289.15; CEP 21.85 (state total 1,311.00); total 8,238.00 = 9.1533% of wages = $4.1190/h. Same inputs on 2025 tables: 8,181.00; on 2027 wage bases with unchanged rates: 8,289.00 |
| I-7 | Burden, California 2026, new employer, example $45.00/h (class 5140), `W` = $90,000 | 5,580.00 + 1,305.00 + 42.00 + UI 238.00 + ETT 7.00 + workers' comp at the advisory 2.109 per $100 = 1,898.10; total 9,070.10 = 10.0779%. A 1.2% FUTA credit reduction would add 84.00. Class cliff at the advisory rates: $39.99/h in 5190 costs $1.4912/h, $40.00/h in 5140 costs $0.8436/h |
| I-8 | Cash in lieu versus plan, $35.00 + $15.00 package, Nevada 2026, 2,000 h | All cash: taxable wages 100,000, employer taxes 9,003.00. $15 to a bona fide plan: taxable wages 70,000, taxes 6,708.00. Difference 2,295.00 = 30,000 x 7.65% |
| I-9 | Overtime | Nevada private 50-hour week at $45.00: 40 x 45.00 + 10 x 67.50 = 2,475.00 gross; **Nevada workers' comp payroll 2,475.00** (corrected: the 225.00 premium is not excluded). California private 13-hour day at $45.00: 8 x 45.00 + 4 x 67.50 + 1 x 90.00 = 720.00 |
| I-10 | Flat-mode correction | `B` = 40, fringe 20 paid in cash, `ti` = 0.15: leaving the cash fringe out of the taxed base is short by 3.00 per hour |
| I-11 | Overhead base | `o_s` = 10%, `m_s` = 5%: `o_c` = 11.7647%, `p_c` = 5.2632%; (1.117647)(1.052632) = 1/0.85 = 1.176471 |
| I-12 | Retainage, $240,000 contract, six $40,000 billings | Nevada best case: withheld 2,000 x 3 then 0; held 6,000. Nevada base case: withheld 2,000, 2,000, 2,000, 1,000, 1,000, 1,000; 3,000 released with billing 4; held at completion 6,000. Nevada stress: 2,000 x 6 = 12,000. California 5% throughout: 12,000 |
| I-13 | Billing that crosses 50% | Contract 45,000, first billing 23,750: 5% x 22,500 + 2.5% x 1,250 = 1,156.25 (the whole billing at 2.5% would be 593.75) |
| I-14 | Retainage financing and late interest | Nevada best case, receipts 30 days after each bill, release on day 240, 9% simple, 365 basis: 2,000 x 0.09 x (180 + 150 + 120)/365 = 221.92. California, release 60 days after the last receipt: 399.45 (closed form identical). Federal: 50,000 paid 20 days late at 4.75%: 50,000 x 0.0475/360 x 20 = 131.94 |
| I-15 | Cash float, weekly grid | See 11.4 |
| I-16 | Closed-form oracle (uniform cost paid when incurred) | `C` = 36,000: (`D`=12, `b`=4, `lam`=2, `r`=5%, `m`=25%) -> 18,000; (12, 4, 2, 10%, 5%) -> 18,660; (8, 4, 4, 5%, 25%) -> 36,000. `C` = 50,000: (3, 4, 4, 5%, 15%) -> 50,000 |
| I-17 | Billing cycle is not monotone | `m` = 0, `r` = 0, `lam` = 1, `D` = 8, material 10,000 paid week 5, labor 1,000 paid weeks 6 to 8: `b` = 4 gives 13,000; `b` = 5 gives 11,000 |
| I-18 | Escalation with real index values and made-up dollars, May 2025 to May 2026 | wire 18,400 x 564.877/459.176 = 22,635.63; conduit 6,200 x 207.695/204.296 = 6,303.15; gear 22,000 x 413.241/374.197 = 24,295.50; fixtures 9,500 x 243.385/235.199 = 9,830.64; total 56,100.00 -> 63,064.92; composite 1.124152. Forward 11 months: at 2% 64,220.15; at 5% 65,949.48; at 10% 68,822.61. Table interpolation for April 2027: 1.021 + 0.5 x (1.04142 - 1.021) = 1.03121 (geometric 1.031159) |
| I-19 | Place | National to Balance of Nevada wage ratio 38.81/34.37 = 1.129182; with a 45% labor share the composite is 1.058132. Parametric only: 42,000 x (1.20/1.18) x 1.040771 x 1.03121 = 45,840.64 |
| I-20 | Midpoint approximation | `r` = 5%, `D` = 1.25 years: exact average factor 1.031123 against midpoint factor 1.030964 |
| I-21 | Friedman and Gates | (`p`, `n`) -> Friedman / Gates: (0.5, 2) 0.2500 / 0.3333; (0.5, 3) 0.1250 / 0.2500; (0.7, 3) 0.3430 / 0.4375; (0.9, 3) 0.7290 / 0.7500; (0.9, 5) 0.5905 / 0.6429; (0.7, 8) 0.0576 / 0.2258 |
| I-22 | Optimal markup, exact | `p(m) = exp(-12m)`: `n` = 1, 2, 4 -> `m*` = 8.333%, 4.167%, 2.083%; win probability 36.79% at each; `EV*/C` = 3.066%, 1.533%, 0.766%. With `d` = 0.03, `n` = 2: `m*` = 7.1667% |
| I-23 | Optimal markup, constructed curve | Rival ratio Normal(1.10, 0.07): Friedman `m*` for `n` = 1, 2, 3, 4, 5, 8: 9.40%, 6.69%, 5.40%, 4.60%, 4.04%, 3.03%; Gates: 9.40%, 7.86%, 7.08%, 6.58%, 6.23%, 5.61% |
| I-24 | Winner's curse | `sigma` = 8%, `N` = 5, `kappa` = 1: `C_adj/C` = 1/(1 - 0.08 x 1.16296) = 1.1026 (linear form 1.0930). `sigma` = 15%, `N` = 8: 1.2715 (linear 1.2135) |
| I-25 | Intervals | Wilson 95%: 3 of 10 -> 10.8% to 60.3%; 6 of 20 -> 14.5% to 51.9%; 25 of 100 -> 17.5% to 34.3%; 0 of 10 -> 0% to 27.8%. DKW half-width: `J` = 30 -> 0.248; 100 -> 0.136 |
| I-26 | Nevada preference | Non-preferred low bid 300,000: a preferred bid of 314,000 wins (limit 315,000); 316,000 does not |
| I-27 | Benchmark | Uniform costs, bid `(1 + (n-1)c)/n`: expected lowest bid 0.6667, 0.5000, 0.3333, 0.2222 for `n` = 2, 3, 5, 8; a bidder with cost 0.40 bids 0.70, 0.60, 0.52 for `n` = 2, 3, 5 |
| I-28 | Allocation | 100 cents over [1, 1, 1] -> [34, 33, 33]; 1 cent over [1, 1] -> [1, 0]; 5 cents over [0, 3, 0, 3] -> [0, 3, 0, 2] |
| I-29 | Float pitfalls kept as regression examples | a three-way split of $428,895.33 by weights [1, 46, 5]; summing [495154.25, 145717.70, 722071.60] in different orders; rounding $41,613.215 and $90,559.015 to cents; 58,725,287,889 cents x 310,185 ppm; pay periods [1726.05, 626.05] at 6.2%; tax on items [0.04, 3952.57] at an example 7.1% |

### 11.4 Illustration I-15: cash float (weekly periods; confirmed independently by the verifier in exact fractions)

Inputs: `D` = 8 weeks; price 45,000 on cost 36,000 (markup 25%); bill every 4 weeks; owner pays 4 weeks after the bill; retainage 5% released at week 16. Labor 16,000 = 2,000 per week in weeks 1 to 8, paid one week later. Material 18,000 = deliveries of 9,000 in weeks 1 and 5; 25% deposit (4,500) in week 0; the remaining 6,750 per delivery paid 4 weeks after delivery (weeks 5 and 9). Other 2,000 incurred and paid in week 0.

| Quantity | Values |
|---|---|
| Cumulative cost `K(0..8)` | 2,000; 13,000; 15,000; 17,000; 19,000; 30,000; 32,000; 34,000; 36,000 |
| Pay application 1 (week 4) | 23,750; retainage 1,187.50; net 22,562.50 received week 8 |
| Pay application 2 (week 8) | 21,250; retainage 1,062.50; net 20,187.50 received week 12 |
| Retainage | 2,250 received week 16 |
| `OUT(0..9)` | 6,500; 0; 2,000; 2,000; 2,000; 8,750; 2,000; 2,000; 2,000; 8,750 |
| `Nminus(0..16)` | -6,500; -6,500; -8,500; -10,500; -12,500; -21,250; -23,250; -25,250; **-27,250**; -13,437.50 (x4); 6,750 (x4) |
| `N(0..16)` | -6,500; -6,500; -8,500; -10,500; -12,500; -21,250; -23,250; -25,250; -4,687.50; -13,437.50 (x3); 6,750 (x4); 9,000 |
| Peak float | 27,250.00 at week 8 (75.69% of cost, 60.56% of price); receipts-first 25,250.00 at week 7 |
| Composition at the peak | labor 14,000 + material 11,250 + other 2,000 |
| Billed minus earned, weeks 0..8 | -2,500; -16,250; -18,750; -21,250; 0; -13,750; -16,250; -18,750; 0 |
| Identity at week 5 | 7,500 - 13,750 - 22,562.50 - 1,187.50 + 8,750 = -21,250 |
| Financing at 9.00%, 360 basis (weekly rate 0.00175) | dollar-weeks 159,250; simple interest 278.6875; with the recursion 281.099412; peak draw 27,450.77; final cash 8,718.90; 0.78% of cost |
| Sensitivities of the peak | owner lag 8 weeks 36,000; owner lag 2 weeks 23,250; bill every 2 weeks 23,250; retainage 0% or 10% 27,250; markup 10% 27,250; no deposit 25,000; 50% deposit 29,500; supplier cash on delivery 34,000; supplier 8-week terms (deposit kept) 20,500; labor +20% at fixed price 30,050 with final cash 5,800 |
| Limit check | against 25,000 of cash plus credit: short by 2,250 |

---

## 12. What the engine must never claim, and known data gaps

### 12.1 Never claim

1. That one number is "the right bid" or that a price will win. Output is a cost build-up, a curve, a range and the sample size behind it.
2. A win probability without its sample size and reference class, or any estimate below the display thresholds. Never present the Friedman and Gates outputs as confidence limits.
3. That the contractor is or is not bondable, or what a surety will approve. Only a surety letter is a limit; multiples are labelled rules of thumb.
4. That illustrative bond rates, bureau workers' comp figures, new-employer unemployment rates, or any section 9 value are the contractor's real rates.
5. That a highway, out-of-state, federal-estimate or DoD-factor figure is a Nevada electrical price, or a prediction for a small Nevada job.
6. Labor-hour units or itemized unit costs by ZIP. They are paid data and are not in the product. Never invent them; never show a simulated company or a synthetic bid as real.
7. A location factor applied to a takeoff, an owner-side design contingency on a bid from finished plans, or an owner-side default markup as the contractor's markup.
8. A legal cap on overhead or profit for a sealed fixed-price bid (there is none), or a change-order markup limit applied to a bid.
9. Compliance. The prevailing-wage and bond checks are arithmetic on entered numbers; the wage determination's footnotes and the bid documents govern.
10. Tax, legal, insurance or surety advice. Show the source and date beside every rate, and say that the bid documents override every preset.
11. That a legal payment deadline is when cash will arrive, or that late-payment interest is planned income. Always show the stress cases.
12. That front-loading the schedule of values is a way to reduce float.
13. A substituted value: missing data never becomes 1.0, 0 or a default without a visible label; a flat burden percentage is always labelled an approximation.
14. That a statute quoted from an index extract was read in full, or that tests prove correctness (1,000 clean runs bound the failure rate near 0.3% under the generator, no more).
15. Anything derived from another customer's private bids or costs.

### 12.2 Known data gaps

| Gap | Effect on the engine |
|---|---|
| Labor-hour units and itemized material prices (paid, copyrighted trade data) | Contractor supplies hours and quotes. The engine can check their resulting dollars per unit against awarded roadway prices, never their hours against a public norm |
| The contractor's surety rate schedule and limits | Required input for anything bonded; the sample is a labelled stand-in |
| Nevada workers' comp class 5190 loss cost for any 2026 or 2027 date; insurer multipliers; the cap taking effect 2027-01-01 | No default rate; policy inputs only |
| Final 2026 FUTA credit-reduction list (California; Nevada assumed 0) | Dated input with a warning |
| Local sales tax rates; taxability of freight; the Nevada contractor-as-consumer bulletin; any gross-receipts tax | Per-job inputs; flags in section 9 |
| Statutes seen only as extracts or in part: NRS 338.515 (branch b), 338.520 (release), 338.525, 338.035, 338.13844, 338.147 conditions; NAC 341 wording; California PCC 10262; pending 2027 amendments | Re-read before coding each rule as user-facing copy |
| Official hosts blocked this session (FAR, eCFR, IRS, Nevada and California legislatures, BLS site, BEA, FHWA Federal Lands, NDOT) | Most law rows are tag X, not R. The FAR is mid-rewrite: section numbers in Parts 14, 19, 28, 36 and 52 may move |
| SBA fee notice exception clause | Fee switch date coded; exception not modelled |
| Bid tabulations for Nevada small works (solicited quotes, often no public tab); federal award data shows only the winner | Win-probability data for the pilot's price band will be thin; the agent says so |
| Friedman (1956) and Gates (1967) originals not read; three academic figures unverified (bidders-raise-cost estimate, a Clark County sample, a six-to-eight-bidder plateau) | Formulas used as reported in a later review; the three figures are not coded |
| Overhead and profit benchmarks (paid reports; conflicting vendor-blog figures) | No default; contractor enters their own |
| Public unit prices for building electrical work: none. Florida, Texas and Colorado DOT files not read; no Nevada DOT average-price book found | Sanity band limited to roadway electrical items from other states, labelled |
| Reuse terms for state and city bid data (two sites carry copyright notices); the federal public-domain statute text was not opened | Store facts with attribution and links; do not mirror databases; check terms before a paid launch |
| Regional price parities; PPI series titles and reference bases; wage-survey area definitions; firm-count statistics | Not shipped, or shipped with a "title unverified" note |
| Prevailing wage rates and their overtime footnotes | Always from the determination in the solicitation |
| Timing of union trust remittances, workers' comp premium payments and sales tax | Cash-model inputs |
| Published S-curve coefficients | Not shipped; uniform, trapezoid and dated events only |
| Change-order pricing rules (VA bracket base, NASA deviation, Caltrans edition) | Out of scope for the bid engine; a separate rule set selected by owner if ever built |
| The area-cost-factor workbook may have been updated after the copy that was parsed | Re-download and diff before use |
| Antitrust review of a multi-tenant price agent | Needed before launch |
| Runtime: Vitest 5.1.0 needs Node 22.12 or newer; the project file says Node >= 20.10 | The tests cannot run on Node 20 |

---

## Appendix: suggested pure-function surface

Names are suggestions; each is a pure function with typed inputs and no I/O.

```
money:        divRoundHalfUp, mulRate, mulHours, extend, effRate, allocate, parseCents, formatCents
labor:        taskHours, partitionHours(regime, hoursByDay), bucketPay(regime, class), prevailingWageCheck,
              effectiveRates(class, year, state), mbtQuarter, mbtForJob, workersComp, laborClassCost, compositeRateFlat
materials:    materialLines, escalationPpm(line, registry, r_fwd), salesTax
build-up:     totalJobCost, homeOfficeOverhead(method), profit, priceBasedCharge q, grossUp, bidRounding, distributeIndirects
identities:   markupToMargin, marginToMarkup, salesBasisToCostBasis, breakEvenRevenue, overheadRecovery
bonds:        bidSecurity, walkAwayExposure(rule), bondRequirement(ownerType, C), durationMultiplier, sbaFee(C, approvalDate), premiumTrueUp
payment:      retainageSchedule(preset, billings), latePaymentInterest(regime), retainageFinancingCost
cash:         costWeights(shape), cashLedger(job) -> {OUT, IN, Nminus, N}, peakFloat, financingCost, accountingView, limitsCheck, portfolio
time/place:   indexRatio, forwardFactor, midpoint, interpolateFactor, wageRatio, compositeLocationFactor, clauseAdjustment, unitPriceBand
bid:          evaluatedPrice(rule, flags), pWinEmpirical, pWinKernel, friedman, gates, wilson, dkwBand, tailMinimumJ,
              winnersCurse, expectedProfitCurve, bestBid, bidRange, brier
```

Arithmetic re-check script for section 11: `/tmp/claude-0/-home-user-wydbdbdj/16aa75d7-798d-5f2a-9ff0-ee877d241c81/scratchpad/research/scripts/cost_model_golden.py`




