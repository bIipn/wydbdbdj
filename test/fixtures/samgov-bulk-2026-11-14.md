# samgov-bulk-2026-11-14.csv

The header row and 44 whole rows of SAM.gov's daily Contract Opportunities bulk file
(`ContractOpportunitiesFullCSV.csv`, 222,454,232 bytes, downloaded 2026-11-14 05:27 UTC), cut **byte for byte**:
every row of the 10 solicitations below, in file order, line endings and mixed Windows-1252 / UTF-8 bytes untouched.
Nothing edited, nothing made up. The cutter splits records on LF outside quotes and never decodes the bytes.

| Sol# | Rows | PSC | NAICS | Why it is here |
|---|---:|---|---|---|
| 89503326RWA000049 | 11 | Y1NZ | 237130 | no place of performance, US office (Folsom, CA): placed at the office |
| N6893627Q0023 | 2 | J059 | 811210 | no place, US office (China Lake, CA), kept by PSC alone |
| 36C24619B0016 | 1 | Z | 238330 | no place and no office (2019): left out |
| W9128F27QA002 | 6 | Z1GC | 541990 | PSC Z with a NAICS outside the trades: kept |
| 36C25627Q0085 | 2 | J061 | 811310 | J kept by PSC; the newest notice has no place, the older one does (Jackson + ZIP 39216, no state) |
| 36C26127Q0140 | 2 | H961 | 541350 | inspection of electrical distribution: kept |
| N6247326R9953 | 10 | S216 | 561210 | facilities operations support: kept |
| 47QSSC27Q0028 | 4 | 6120 | 334416 | numeric PSC (a transformer bought as a product): left out |
| W9123827QA001 | 4 | S207 | 561710 | rodent abatement, no catalog trade: left out |
| 191BWC26R0009 | 3 | M1ND | 221320 | operation of a sewage plant, an M1 group not kept: left out |

Tests read it as of 2026-11-14 05:27 UTC (`test/samgov-wide.test.ts`). Fixture mode does not read this file
(`FIXTURES_CAPTURED_AT` is unchanged).
