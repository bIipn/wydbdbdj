import { describe, expect, it } from 'vitest';
import { finalizeBid } from '../src/scan.js';
import { ERATE_470_FLAG } from '../src/sources/flags.js';
import { entityName, parseUsac470, STATE_ZONE, usac470Source, usacQuery, type UsacRow } from '../src/sources/usac470.js';
import { fx } from './helpers.js';
import { socrataCtx } from './socrata-fake.js';

// The real answer of 2026-11-14 06:59 UTC (California and Nevada), trimmed to 7 whole forms = 40 rows
// (test/fixtures/usac470-ca-nv.md).
const ROWS: UsacRow[] = JSON.parse(fx('usac470-ca-nv.json'));
const NOW = new Date('2026-11-14T07:00:00Z');

describe('parseUsac470 (real Form 470 rows)', () => {
  const p = parseUsac470(ROWS, NOW);
  const by = (id: string) => p.bids.find((b) => b.sourceId === id);

  it('one card per form; equipment-only and past forms left out', () => {
    expect(p).toMatchObject({ forms: 7, notOpen: 1, notTrade: 2 });
    expect(p.bids.map((b) => b.sourceId).sort()).toEqual(['270000261', '270001392', '270002071', '270002757']);
    expect(by('270000608')).toBeUndefined(); // South Bay: antennas and UPS, no installation asked for
    expect(by('270003882')).toBeUndefined(); // Lake Mead Christian Academy: wireless controllers only (network gear)
    expect(by('270000605')).toBeUndefined(); // allowable contract date 2026-11-13: passed
  });

  it('one form, fully checked: Washington Unified (Fresno), cabling with installation', () => {
    const b = by('270000261')!;
    expect(b).toMatchObject({
      source: 'usac470',
      sourceName: 'USAC E-Rate (FCC Form 470)',
      title: 'Washington Unified School District: E-Rate cabling, racks, antennas and connectors, installed',
      agency: 'Washington Unified School District',
      category: 'E-Rate Category 2 (internal connections)',
      // its own text: "Bid response due electronically by 4:00 PM PST on December 2, 2026" (NOT the allowable
      // contract date, 2026-11-27, which is only the first day a contract may be signed)
      dueAt: '2026-12-03T00:00:00.000Z',
      postedAt: '2026-10-13T07:00:00.000Z', // the day it was certified
      url: 'https://publicdata.usac.org/EPC/Prd/Form470/270000261/16067741/22853358-USAC_FCC_FORM_470_APPLICATION_270000261_CERTIFIED.pdf',
      flags: [ERATE_470_FLAG],
      solNumber: '270000261',
      estValue: null,
      location: { city: 'Fresno', state: 'CA', zip: '93706' },
    });
    const lines = b.description!.split('\n');
    expect(lines[0]).toBe(
      'E-Rate Form 470: Washington Unified School District (school district, 9 sites) is taking quotes for cabling, racks, ' +
        'antennas and connectors, installed. A contract may be signed from November 27, 2026; the form says quotes are due ' +
        'December 2, 2026 at 4:00 PM. Quotes, not a sealed public-works bid.',
    );
    // each line repeats once per RFP document (3): counted once
    expect(lines[1]).toBe('Form 270000261 (Washington Unified FY27 C2 Cabling), funding year 2027, 3 RFP documents.');
    expect(lines[2]).toBe('Requested: cabling: 31,000 feet; racks: 110 each; antennas and connectors: 10,000 each.');
    expect(finalizeBid(b).location).toMatchObject({ city: 'Fresno', state: 'CA', precision: 'city' });
  });

  it('the card never looks like a sealed bid: its own flag, and the contract-date wording', () => {
    for (const b of p.bids) {
      expect(b.flags?.[0]).toBe(ERATE_470_FLAG);
      expect(b.description).toMatch(/A contract may be signed from [^;]+; (the form says quotes are due|the RFP says when quotes are due)/);
      expect(b.description).not.toMatch(/so quotes are due before then/);
      expect(b.description).toMatch(/Quotes, not a sealed public-works bid\./);
    }
    expect(by('270002071')!.flags).toEqual([ERATE_470_FLAG, 'Mandatory pre-bid']); // a mandatory job walk
  });

  it('a Nevada form: North Las Vegas, the date in Pacific', () => {
    expect(finalizeBid(by('270002757')!).location).toMatchObject({ city: 'North Las Vegas', state: 'NV', zip: '89030' });
    // its text names no due date: no deadline is made up from the allowable contract date (2026-12-01)
    expect(by('270002757')!.dueAt).toBeNull();
    expect(by('270002757')!.description).toMatch(/the RFP says when quotes are due/);
    expect(by('270002757')!.title).toMatch(/^Cristo Rey St\. Viator Las Vegas College Preparatory, Inc\.: E-Rate wireless access points/);
  });

  it('a form with no RFP document says so and links to the form itself', () => {
    expect(by('270001392')!.description).toMatch(/no RFP document attached/);
    expect(by('270001392')!.url).toMatch(/USAC_FCC_FORM_470_APPLICATION_270001392_CERTIFIED\.pdf$/);
  });

  it("an amended form's Current rows win over its Original ones", () => {
    // Real rows of 270000261 (all Current) plus one of them relabelled Original with another function (edited here).
    const form = ROWS.filter((r) => r.application_number === '270000261');
    const old = { ...form[0]!, form_version: 'Original', service_request_id: '99', function: 'Switches and Necessary Software and Licenses' };
    const q = parseUsac470([...form, old], NOW);
    expect(q.bids[0]!.title).not.toMatch(/switches/);
  });

  it("a due date in the text is read on the applicant's own clock", () => {
    // the real Washington Unified form relabelled New York, its text's "PST" removed (both edited here): 4:00 PM Eastern
    const form = ROWS.filter((x) => x.application_number === '270000261').map((x) => ({ ...x, billed_entity_state: 'NY' }));
    const noZone = form.map((x) => ({ ...x, category_two_description: (x.category_two_description ?? '').replace(' PST', '') }));
    expect(parseUsac470(noZone, NOW).bids[0]!.dueAt).toBe('2026-12-02T21:00:00.000Z');
    expect(STATE_ZONE.TX).toBe('America/Chicago');
  });
});

describe('entityName', () => {
  it('title-cases a shouted name, keeps abbreviations and mixed-case names', () => {
    expect(entityName('LOS ANGELES UNIFIED SCHOOL DISTRICT')).toBe('Los Angeles Unified School District');
    expect(entityName('FAIRFIELD-SUISUN UNIF SCH DIST')).toBe('Fairfield-Suisun Unif SCH Dist');
    expect(entityName('Cristo Rey St. Viator Las Vegas College Preparatory, Inc.')).toBe('Cristo Rey St. Viator Las Vegas College Preparatory, Inc.');
  });
});

describe('usac470Source.fetch', () => {
  it('asks nationwide for certified Internal Connections from this year on, no contact columns', async () => {
    const { ctx, urls, logs } = socrataCtx([ROWS], NOW);
    expect(await usac470Source.fetch(ctx)).toHaveLength(4);
    const u = new URL(urls[0]!);
    expect(`${u.origin}${u.pathname}`).toBe('https://opendata.usac.org/resource/jt8s-3q52.json');
    expect(u.searchParams.get('$where')).toBe(
      "service_type = 'Internal Connections' AND fcc_form_470_status = 'Certified' AND funding_year >= '2026' AND " +
        "allowable_contract_date >= '2026-11-13T00:00:00'",
    );
    expect(u.searchParams.get('$where')).toBe(usacQuery(NOW).where);
    expect(u.searchParams.get('$select')).not.toMatch(/contact|email|phone/);
    expect(logs).toEqual(['usac470: 40 service rows in 1 page(s), 7 forms, 4 kept, 1 past their quote deadline or contract date, 2 left out as equipment only / not trade work']);
  });

  it('an empty answer in filing season is FAILED; between seasons it is logged', async () => {
    await expect(usac470Source.fetch(socrataCtx([[]], NOW).ctx)).rejects.toThrow('in filing season');
    const may = socrataCtx([[]], new Date('2027-05-10T12:00:00Z'));
    expect(await usac470Source.fetch(may.ctx)).toEqual([]);
    expect(may.logs[0]).toMatch(/between filing seasons/);
    await expect(usac470Source.fetch(socrataCtx([[{ x: 1 }]], NOW).ctx)).rejects.toThrow('none with an application_number');
  });
});
