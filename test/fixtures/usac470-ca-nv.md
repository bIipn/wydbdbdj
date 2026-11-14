# usac470-ca-nv.json

USAC E-Rate FCC Form 470 service requests (Socrata dataset `jt8s-3q52` on opendata.usac.org), Category 2 Internal
Connections, California and Nevada.

- **Request:** `GET https://opendata.usac.org/resource/jt8s-3q52.json?%24select=application_number%2C+form_nickname%2C+form_pdf%2C+service_request_id%2C+rfp_documents%2C+form_version%2C+funding_year%2C+fcc_form_470_status%2C+allowable_contract_date%2C+certified_date_time%2C+billed_entity_name%2C+billed_entity_city%2C+billed_entity_state%2C+billed_entity_zip%2C+applicant_type%2C+number_of_eligible_entities%2C+category_two_description%2C+service_category%2C+service_type%2C+function%2C+quantity%2C+unit%2C+installation_initial%2C+manufacturer&%24where=service_type+%3D+%27Internal+Connections%27+AND+fcc_form_470_status+%3D+%27Certified%27+AND+funding_year+%3E%3D+%272026%27+AND+allowable_contract_date+%3E%3D+%272026-11-13T00%3A00%3A00%27+AND+billed_entity_state+in+%28%27CA%27%2C+%27NV%27%29&%24order=%3Aid&%24limit=1000&%24offset=0` (`socrataUrl(usacQuery(now, ['CA', 'NV']), 0)`, src/sources/usac470.ts; the scanner sends the
  same query without the state clause, nationwide), curl with `User-Agent: BidSwipe/0.1 (daily public-bid check)`.
- **Captured:** 2026-11-14 06:59:54 UTC. HTTP 200, 1,375,663 bytes, 561 rows (57 forms, one page). Last-Modified
  2026-11-13 10:28:41 GMT. No contact columns selected.
- **Trimmed:** whole row objects dropped only, original order kept. Socrata writes one object per line joined by `\n,`; the kept
  lines are the received bytes unchanged (`JSON.parse` of the trimmed file equals the kept objects of the full answer, checked
  by the trim script). No session values in these answers. No app token was sent.
- **Kept 40 of 561 rows = 7 whole forms** (every row of each): 270000261 Washington USD (Current version, cabling with 3 RFP
  documents, so each line repeats 3 times), 270000608 South Bay (equipment only, no installation: left out), 270001392
  (no RFP document), 270002071 Fairfield-Suisun (mandatory job walk), 270002757 (Nevada), 270003882 (Nevada, wireless
  controllers only: network gear, left out), 270000605
  (allowable contract date 2026-11-13: passed).
- **robots.txt** (https://opendata.usac.org/robots.txt, 2026-11-14): `User-agent: *`, `Crawl-delay: 1`, Disallow for
  /browse?…, /api/odata/, /api/collocate* and similar; nothing on /resource/.
