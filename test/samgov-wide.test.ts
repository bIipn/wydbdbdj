/**
 * Wider federal intake (2026-11-14): a notice is kept when its NAICS OR its Product and Service Code (PSC) is trade
 * work, and a notice that names no work site is placed at its US contracting office and says so.
 *
 * test/fixtures/samgov-bulk-2026-11-14.csv is the header and 44 whole rows cut, byte for byte, from SAM.gov's daily
 * bulk file downloaded 2026-11-14 05:27 UTC (every notice of 10 solicitations; see the sibling .md). Anything made
 * up here is a TEST row and says so.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { locate } from '../src/geo/locate.js';
import { finalizeBid } from '../src/scan.js';
import { inheritFromStored } from '../src/sources/dedupe.js';
import { FLAGS } from '../src/sources/flags.js';
import { isTradePsc, normalizePsc, PSC_TITLES, pscTitle, tradesForPsc } from '../src/sources/psc.js';
import { bulkSummary, CsvSplitter, decodeField, isTradeNotice, parseSamBulk } from '../src/sources/samgov-bulk.js';
import { parseSamResponse, placeAtOffice, samOffice, type SamOpportunity } from '../src/sources/samgov.js';
import { TRADES } from '../src/trades/catalog.js';
import type { Bid, BidDraft } from '../src/types.js';

const RAW = new Uint8Array(readFileSync(new URL('./fixtures/samgov-bulk-2026-11-14.csv', import.meta.url)));
/** When the file was downloaded: the fixture's "now". */
const NOW = new Date('2026-11-14T05:27:00Z');
const HEADER_END = RAW.indexOf(0x0a) + 1;
const HEADER = new TextDecoder('windows-1252').decode(RAW.subarray(0, HEADER_END));
const enc = (s: string) => new TextEncoder().encode(s);

function records(bytes: Uint8Array = RAW): string[][] {
  const s = new CsvSplitter();
  return [...s.push(bytes), ...s.end()].map((r) => r.map(decodeField));
}
const COLS = records()[0]!;
const col = (name: string) => COLS.indexOf(name);

describe('src/sources/psc.ts: which service codes are trade work', () => {
  it('Y and Z (construction; maintenance, repair, alteration of real property) are always kept, bare letters too', () => {
    for (const p of ['Y1AA', 'Y1NZ', 'Z1GC', 'Z2AA', 'Z2NB', 'Z', 'Y', 'Y3', 'Z300', 'Z111']) expect(isTradePsc(p), p).toBe(true);
    expect(tradesForPsc('Z2AA')).toEqual(['general-building']); // repair or alteration of office buildings
    expect(tradesForPsc('Z')).toEqual(['general-building']);
    expect(tradesForPsc('Z2NB')).toEqual(['hvac', 'plumbing']); // heating and cooling plants
    expect(tradesForPsc('Y1LB')).toEqual(['concrete-paving', 'sitework']); // highways, roads, streets, bridges
    expect(tradesForPsc('Z2BD')).toEqual(['concrete-paving', 'sitework']); // airport runways and taxiways
    expect(tradesForPsc('Y1MZ')).toEqual(['electrical']); // EPG facilities, incl. transmission
    expect(tradesForPsc('Z1NE')).toEqual(['sitework', 'plumbing']); // water supply facilities
  });

  it('equipment work only for the building-equipment groups: J, N, K and H1/H2/H3/H9 of 041, 044, 045, 059, 061–063', () => {
    expect(tradesForPsc('J061')).toEqual(['electrical']); // electric wire and power distribution equipment
    expect(tradesForPsc('N062')).toEqual(['electrical']); // lighting fixtures and lamps
    expect(tradesForPsc('J041')).toEqual(['hvac']);
    expect(tradesForPsc('J045')).toEqual(['plumbing', 'hvac']);
    expect(tradesForPsc('J063')).toEqual(['low-voltage', 'fire-protection']);
    expect(tradesForPsc('H961')).toEqual(['electrical']); // other QC/test/inspect: electric wire and power distribution
    expect(tradesForPsc('H345')).toEqual(['plumbing', 'hvac']);
    expect(tradesForPsc('K063')).toEqual(['low-voltage', 'fire-protection']);
    for (const p of ['J015', 'J065', 'J998', 'N065', 'H265', 'H399', 'K015', 'J', 'N']) expect(isTradePsc(p), p).toBe(false);
  });

  it('housekeeping, facility operation, demolition and grounds: only what a catalog trade does', () => {
    expect(tradesForPsc('S208')).toEqual(['landscaping']);
    expect(tradesForPsc('S214')).toEqual(['flooring']);
    expect(tradesForPsc('S216')).toEqual(['general-building']);
    expect(tradesForPsc('S218')).toEqual(['landscaping']);
    expect(tradesForPsc('M1NB')).toEqual(['hvac', 'plumbing']);
    expect(tradesForPsc('M1MZ')).toEqual(['electrical']);
    expect(tradesForPsc('P400')).toEqual(['sitework']);
    expect(tradesForPsc('F006')).toEqual(['landscaping']);
    // Custodial, pest control, guards, food; fuel depots, museums, sewage plant O&M; salvage; fire crews; consulting.
    for (const p of ['S201', 'S207', 'S206', 'S203', 'M1GC', 'M1JA', 'M1ND', 'M1FD', 'P100', 'P999', 'F003', 'F108', 'F110']) {
      expect(isTradePsc(p), p).toBe(false);
    }
  });

  it('products (numeric codes) are never trade work by PSC; blanks and odd spacing are handled', () => {
    for (const p of ['6120', '5826', '4240', '7A20', '', null, undefined]) expect(isTradePsc(p), String(p)).toBe(false);
    expect(normalizePsc(' z2nb ')).toBe('Z2NB');
    expect(isTradePsc('j061')).toBe(true);
  });

  it('every trade id it names is a catalog trade, and every titled code is one it keeps', () => {
    const ids = new Set(TRADES.map((t) => t.id));
    const sample = [...Object.keys(PSC_TITLES), 'Z', 'Y', 'Z111'];
    for (const p of sample) for (const t of tradesForPsc(p)) expect(ids.has(t), `${p} → ${t}`).toBe(true);
    for (const p of Object.keys(PSC_TITLES)) if (p.length === 4) expect(isTradePsc(p), p).toBe(true);
    expect(pscTitle('z2nb')).toBe('REPAIR OR ALTERATION OF HEATING AND COOLING PLANTS');
    expect(pscTitle('J061')).toBe('MAINT/REPAIR/REBUILD OF EQUIPMENT- ELECTRIC WIRE AND POWER DISTRIBUTION EQUIPMENT');
    expect(pscTitle('6120')).toBeNull();
  });

  it('the bulk filter keeps a notice when its NAICS OR its PSC is trade work', () => {
    expect(isTradeNotice('238210', '6120')).toBe(true); // trade NAICS: today's rule, whatever the PSC
    expect(isTradeNotice('811310', 'J061')).toBe(true); // PSC alone
    expect(isTradeNotice('541990', 'Z1GC')).toBe(true);
    expect(isTradeNotice('334416', '6120')).toBe(false); // a transformer bought as a product
    expect(isTradeNotice('561710', 'S207')).toBe(false); // rodent abatement
  });
});

describe('the 2026-11-14 rows: what is kept, what is left out, and why', () => {
  const { drafts, stats } = parseSamBulk(RAW, { now: NOW });
  const card = (sol: string) => drafts.find((d) => d.sourceId === sol);

  it('counts every row and card (44 rows of 10 solicitations → 6 cards)', () => {
    expect(records().slice(1)).toHaveLength(44);
    expect(stats).toMatchObject({
      bytes: RAW.length, rows: 44, active: 44, kept: 33, keptByPsc: 22, cards: 6, placedAtOffice: 2, malformed: 0,
      dropped: { inactive: 0, type: 0, naics: 11, country: 0, noPlace: 1, pastDue: 0, stale: 0, noId: 0 },
    });
    expect(drafts.map((d) => d.sourceId).sort()).toEqual([
      '36C25627Q0085', '36C26127Q0140', '89503326RWA000049', 'N6247326R9953', 'N6893627Q0023', 'W9128F27QA002',
    ]);
    expect(bulkSummary(stats)).toBe(
      'samgov (bulk file): 6 cards from 33 notices (22 by service code alone), 2 placed at the contracting office (no work ' +
      'site named) — 44 rows, 44 active; left out: 0 not open bids, 11 not construction/trades, 0 abroad, 1 no place given, ' +
      '0 past due (0.1 MB)',
    );
  });

  it('every card carries its PSC as SAM wrote it', () => {
    const psc = new Map(records().slice(1).map((r) => [r[col('Sol#')]!, r[col('ClassificationCode')]!]));
    for (const d of drafts) expect(d.psc, d.sourceId).toBe(psc.get(d.solNumber!));
    expect(card('W9128F27QA002')).toMatchObject({ psc: 'Z1GC', naics: '541990' }); // Vandenberg SFB tank inspection
  });

  it('PSC Z with a NAICS outside the trades is kept (Z1GC, 541990: Vandenberg SFB tank inspection, Lompoc)', () => {
    const b = finalizeBid(card('W9128F27QA002')!);
    expect(b.location).toMatchObject({ city: 'Lompoc', state: 'CA', precision: 'city' });
    expect(b.flags).not.toContain(FLAGS.placeFromOffice);
  });

  it('kept service rows: J061 switchgear repair (811310), H961 electrical inspection (541350), S216 base support (561210)', () => {
    expect(card('36C25627Q0085')).toMatchObject({ psc: 'J061', naics: '811310' });
    expect(card('36C26127Q0140')).toMatchObject({ psc: 'H961', naics: '541350', location: { city: 'Fresno', state: 'CA' } });
    expect(card('N6247326R9953')).toMatchObject({ psc: 'S216', naics: '561210' });
  });

  it('no place of performance + a US contracting office: placed at the office, flagged, and the label says so', () => {
    // WAPA series capacitor design-build: 11 notices, none with a work site; office Folsom, CA.
    const wapa = card('89503326RWA000049')!;
    expect(wapa.location).toEqual({ city: 'Folsom', state: 'CA', zip: '95630', label: null });
    expect(wapa.flags).toEqual([FLAGS.placeFromOffice]);
    expect(finalizeBid(wapa).location).toMatchObject({
      city: 'Folsom', state: 'CA', precision: 'city', label: 'Contracting office: Folsom, CA (job site not named)',
    });
    // NAWC China Lake calibration (J059, PSC alone): office ZIP 93555-6018 puts it at Ridgecrest.
    expect(finalizeBid(card('N6893627Q0023')!).location).toMatchObject({
      state: 'CA', precision: 'city', label: 'Contracting office: Ridgecrest, CA (job site not named)',
    });
  });

  it('no place and no office at all: left out (36C24619B0016, a 2019 carpet job, bare PSC "Z")', () => {
    expect(card('36C24619B0016')).toBeUndefined();
    expect(stats.dropped.noPlace).toBe(1);
  });

  it('a place only an older notice gave still fills in, and beats the office (the newest J061 notice names none)', () => {
    const vamc = card('36C25627Q0085')!;
    expect(vamc.flags ?? []).not.toContain(FLAGS.placeFromOffice);
    expect(vamc.location).toMatchObject({ city: 'Jackson', zip: '39216' });
    // The older notice gives Jackson + ZIP 39216 and no state: the ZIP says Mississippi, not the gazetteer's Jackson, CA.
    expect(finalizeBid(vamc).location).toMatchObject({ city: 'Jackson', state: 'MS', precision: 'city', label: 'Jackson, MS' });
  });

  it('left out: a numeric-PSC product, a service no catalog trade does, an M1 group that is not trade work', () => {
    expect(card('47QSSC27Q0028')).toBeUndefined(); // 6120, 334416: "Purchase Olsun Electrics 225 KVA Transformer"
    expect(card('W9123827QA001')).toBeUndefined(); // S207, 561710: Pine Flat rodent abatement
    expect(card('191BWC26R0009')).toBeUndefined(); // M1ND, 221320: O&M of the South Bay wastewater plant
    expect(stats.dropped.naics).toBe(4 + 4 + 3); // every notice of those three solicitations
  });
});

/** A synthetic TEST row on the real header. */
function testRow(over: Record<string, string>): string {
  const base: Record<string, string> = {
    Active: 'Yes', Type: 'Solicitation', NaicsCode: '561210', ClassificationCode: 'Z2AA', PopCountry: '',
    Title: 'TEST repair (synthetic)', Link: 'https://example.com/test', PostedDate: '2026-11-10 10:00:00',
    ResponseDeadLine: '2026-12-15T14:00:00-08:00',
  };
  return `${COLS.map((c) => `"${(over[c] ?? base[c] ?? '').replace(/"/g, '""')}"`).join(',')}\n`;
}
const withRows = (...rows: string[]) => enc(`${HEADER}${rows.join('')}`);

describe('contracting-office fallback (TEST rows)', () => {
  it('an office abroad or with no state is no place: the notice is left out', () => {
    const r = parseSamBulk(withRows(
      testRow({ NoticeId: 'TEST-a', 'Sol#': 'TEST-ABROAD-1', State: '', City: 'Yokota', CountryCode: 'JPN' }),
      testRow({ NoticeId: 'TEST-b', 'Sol#': 'TEST-NOSTATE-1', State: '', City: 'Somewhere', CountryCode: 'USA' }),
      testRow({ NoticeId: 'TEST-c', 'Sol#': 'TEST-US-1', State: 'NV', City: 'RENO', ZipCode: '895021234', CountryCode: 'USA' }),
    ), { now: NOW });
    expect(r.drafts.map((d) => [d.sourceId, d.location])).toEqual([
      ['TEST-US-1', { city: 'Reno', state: 'NV', zip: '89502-1234', label: null }],
    ]);
    expect(r.stats).toMatchObject({ placedAtOffice: 1, dropped: { noPlace: 2 } });
  });

  it('a state given for the work site (and nothing else) is kept as a state-wide card, not moved to the office', () => {
    const r = parseSamBulk(withRows(
      testRow({ NoticeId: 'TEST-s', 'Sol#': 'TEST-STATE-1', PopState: 'CA', State: 'VA', City: 'NORFOLK', CountryCode: 'USA' }),
    ), { now: NOW });
    expect(r.drafts[0]!.location).toMatchObject({ state: 'CA', city: null });
    expect(r.drafts[0]!.flags ?? []).not.toContain(FLAGS.placeFromOffice);
  });

  it('a renamed office or PSC column fails loudly', () => {
    for (const c of ['ClassificationCode', 'CountryCode', 'ZipCode']) {
      const renamed = HEADER.replace(`"${c}"`, `"${c}X"`);
      expect(() => parseSamBulk(enc(renamed + new TextDecoder('windows-1252').decode(RAW.subarray(HEADER_END))))).toThrow(`"${c}" missing`);
    }
  });

  it('samOffice: US only (USA, blank with a state, or a territory code), ZIP+4 written with its dash', () => {
    expect(samOffice({ city: 'NELLIS AFB', state: 'NV', zipcode: '89191-7063', countryCode: 'USA' })).toEqual({ city: 'Nellis AFB', state: 'NV', zip: '89191-7063' });
    expect(samOffice({ city: 'X', state: 'CA', zipcode: '', countryCode: '' })).toEqual({ city: 'X', state: 'CA', zip: null });
    expect(samOffice({ city: 'SAN JUAN', state: '', zipcode: '00901', countryCode: 'PRI' })?.state).toBe('PR');
    expect(samOffice({ city: 'X', state: 'CA', countryCode: 'DEU' })).toBeNull();
    expect(samOffice(undefined)).toBeNull();
  });
});

describe('the API path places the same way (officeAddress)', () => {
  it('a notice with an empty placeOfPerformance is placed at its office; one with a place is not', () => {
    const base: SamOpportunity = {
      noticeId: 'TEST-api-1', title: 'TEST electrical repair (synthetic)', solicitationNumber: 'TEST-API-1', type: 'Solicitation',
      postedDate: '2026-11-10', responseDeadLine: '2026-12-15T14:00:00-08:00', naicsCode: '238210', classificationCode: 'J061',
      placeOfPerformance: { city: {}, state: {}, country: {} },
      officeAddress: { zipcode: '89502', city: 'RENO', countryCode: 'USA', state: 'NV' }, uiLink: 'https://example.com/test',
    };
    const [a] = parseSamResponse({ opportunitiesData: [base] });
    expect(a).toMatchObject({ psc: 'J061', location: { city: 'Reno', state: 'NV', zip: '89502' } });
    expect(a!.flags).toContain(FLAGS.placeFromOffice);
    const [b] = parseSamResponse({ opportunitiesData: [{ ...base, placeOfPerformance: { city: { name: 'Carson City' }, state: { code: 'NV' } } }] });
    expect(b!.flags).not.toContain(FLAGS.placeFromOffice);
  });
});

describe('locate() and the stored card for an office-placed notice', () => {
  const draft = (over: Partial<BidDraft>): BidDraft => ({
    source: 'samgov', sourceId: 'TEST-LOC-1', sourceName: 'SAM.gov (federal)', title: 'TEST Reno repair (synthetic)', agency: null,
    description: null, category: 'Solicitation', location: { city: null, state: null, zip: null, label: null }, postedAt: null,
    dueAt: null, estValue: null, naics: '238210', setAside: null, url: 'https://example.com/test', flags: [], solNumber: 'TEST-LOC-1',
    ...over,
  });

  it('an office-placed card is never placed from its title, and an unknown office city stays at the state', () => {
    const d = placeAtOffice(draft({ title: 'TEST work in Reno (synthetic)' }), { city: 'Nowhere Test', state: 'NV', zip: null });
    expect(locate(d)).toMatchObject({ precision: 'state', lat: null, label: 'Contracting office: Nowhere Test, NV (job site not named)' });
    // Without the flag the same title would be placed at Reno: the office must not borrow that guess.
    expect(locate(draft({ title: 'TEST work in Reno (synthetic)', location: { city: null, state: 'NV', zip: null, label: null } })).city).toBe('Reno');
  });

  it('a gazetteer town with its state is still the gazetteer town (the ZIP rule is for a missing state only)', () => {
    expect(locate(draft({ location: { city: 'Jackson', state: 'CA', zip: null, label: null } }))).toMatchObject({ city: 'Jackson', state: 'CA' });
    expect(locate(draft({ location: { city: 'Jackson', state: null, zip: '95642', label: null } }))).toMatchObject({ city: 'Jackson', state: 'CA' });
  });

  it('a real work site stored by an earlier scan replaces today\'s office placement, and the office flag goes', () => {
    const today = placeAtOffice(draft({}), { city: 'Reno', state: 'NV', zip: '89502' });
    const stored = { ...finalizeBid(draft({ location: { city: 'Carson City', state: 'NV', zip: '89701', label: null } })) } as Bid;
    const out = inheritFromStored(today, stored);
    expect(out.location).toMatchObject({ city: 'Carson City', state: 'NV', zip: '89701' });
    expect(out.flags).not.toContain(FLAGS.placeFromOffice);
    // A stored card that was itself placed at the office is no work site: nothing is carried over.
    const storedOffice = finalizeBid(placeAtOffice(draft({}), { city: 'Reno', state: 'NV', zip: '89502' }));
    const blank = draft({});
    expect(inheritFromStored(blank, storedOffice).location).toEqual(blank.location);
  });
});
