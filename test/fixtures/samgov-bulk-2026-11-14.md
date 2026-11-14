# samgov-bulk-2026-11-14.csv

The header row and 66 whole rows of SAM.gov's daily Contract Opportunities bulk file
(`ContractOpportunitiesFullCSV.csv`, 222,454,232 bytes, downloaded 2026-11-14 05:27 UTC), cut **byte for byte**:
every row of the 18 solicitations below, in file order, line endings and mixed Windows-1252 / UTF-8 bytes untouched.
Nothing edited, nothing made up. The cutter splits records on LF outside quotes and never decodes the bytes.

| Sol# | Rows | PSC | NAICS | Why it is here |
|---|---:|---|---|---|
| 89503326RWA000049 | 10 | Y1NZ | 237130 | no place of performance, US office (Folsom, CA): placed at the office |
| N6893627Q0023 | 2 | J059 | 811210 | calibration (electronics): group 059 never lets a notice in alone: left out |
| 36C24619B0016 | 1 | Z | 238330 | no place and no office (2019): left out |
| W9128F27QA002 | 6 | Z1GC | 541990 | PSC Z with a NAICS outside the trades: kept |
| 36C25627Q0085 | 2 | J061 | 811310 | J kept by PSC; the newest notice has no place, the older one does (Jackson + ZIP 39216, no state) |
| 36C26127Q0140 | 2 | H961 | 541350 | inspection of electrical distribution: kept |
| N6247326R9953 | 10 | S216 | 561210 | facilities operations support: kept |
| 47QSSC27Q0028 | 4 | 6120 | 334416 | numeric PSC (a transformer bought as a product): left out |
| W9123827QA001 | 4 | S207 | 561710 | rodent abatement, no catalog trade: left out |
| 191BWC26R0009 | 3 | M1ND | 221320 | operation of a sewage plant, an M1 group not kept: left out |
| W912ER26RA016 | 6 | Y1BZ | 236220 | "Apache Alert Mission Complex": no place, Virginia office, text says Kuwait: abroad, left out |
| 70Z08526RRJ001B00 | 7 | J059 | 811210 | TRS-3D AN/SPS-75 radar repairs: electronics, left out |
| FA811827RB010 | 1 | J041 | 336413 | overhaul of a C-5 ram air fan (aircraft part): left out |
| AFCEC-27-R-0001 | 2 | Z1QA | 53 | Edwards AFB enhanced use lease (real estate): left out |
| FA301626Q0012 | 3 | S214 | 561740 | carpet cleaning: left out |
| 124PSA27Q0029 | 1 | J036 | 811310 | maintenance of two chiller units: kept on its plain trade title |
| W51LL527QA003 | 1 | J061 | 811310 | USAG Humphreys (Korea): address only, office at APO AP: abroad, left out |
| 140FF027Q0035 | 1 | Z2JZ | 238220 | "CA-SAN LUIS NWR-FIRE SYSTEM REHAB": no place, Virginia office: put in CA by its title |

The last 8 solicitations were added later the same day from the same file, cut the same way. Tests read it as of 2026-11-14 05:27 UTC (`test/samgov-wide.test.ts`). Fixture mode does not read this file
(`FIXTURES_CAPTURED_AT` is unchanged).
