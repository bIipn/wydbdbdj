# OpenGov Procurement fixtures (opengov-*.json)

Raw answers of the public API behind procurement.opengov.com, captured with
`curl -A "BidSwipe/0.1 (daily public-bid check)"` (the scanner's User-Agent). No login, no key, no session tokens.

| File | Request | Captured (UTC) | Trimmed |
|---|---|---|---|
| `opengov-governments.json` | `GET https://api.procurement.opengov.com/api/v1/government` | 2026-11-14 05:59 | 13 of 588 whole entries kept, bytes unchanged (the answer is one compact JSON line; `JSON.stringify` of the parsed array reproduced it exactly, so the kept objects are byte-for-byte): 7 California (County of Sacramento, West Sacramento, Rancho Cordova, Georgetown Divide PUD, Lakeport, San Marino, San Joaquin RTD), 1GPA (AZ), Alachua County (FL), Brazos Valley COG (TX), Ann Arbor AATA (MI, `isActive: false`), OpenGov Demo (`isInternal: true`), `cityofshenanigans` (no state) |
| `opengov-projects-saccounty.json` | `POST https://api.procurement.opengov.com/api/v1/government/saccounty/project/public` body `{"filters":[{"type":"status","value":"open"}],"quickSearchQuery":null,"limit":100,"page":1}`, `Content-Type: application/json`, `Accept: application/json` | 2026-11-14 06:26 | none (count 11, all 11 rows) |
| `opengov-projects-lakeport.json` | the same POST for `cityoflakeport` | 2026-11-14 06:27 | none (count 1) |
| `opengov-projects-empty.json` | the same POST for `cityofsanmarino` | 2026-11-14 06:27 | none (`{"count":0,"rows":[]}`) |

Card links (`https://procurement.opengov.com/portal/<code>/projects/<id>`) were never fetched.
