import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDouglasRfp } from '../src/sources/douglascounty.js';
import { parseNevadaEproOpenBids } from '../src/sources/nevadaepro.js';
import { parseNgemPage } from '../src/sources/ngem.js';
import { parseQuestJson, QUEST_BOARDS } from '../src/sources/questcdn.js';
import { buildSamUrl, parseSamResponse } from '../src/sources/samgov.js';

const fx = (f: string) => readFileSync(resolve(__dirname, 'fixtures', f), 'utf8');

describe('Douglas County (real page)', () => {
  it('returns only open rows by default', () => {
    const bids = parseDouglasRfp(fx('douglas-rfp.html'));
    expect(bids).toHaveLength(1);
    expect(bids[0]!.title).toBe('RFP Library 5-year Strategic Plan');
    expect(bids[0]!.url).toBe('https://www.douglascountynv.gov/rfp-bids/library_strategic_plan');
  });

  it('pulls title, deadline, estimate and requirements out of the legal ad', () => {
    const all = parseDouglasRfp(fx('douglas-rfp.html'), { includeClosed: true });
    const plc = all.find((b) => b.sourceId === 'jobs_peak_w_t_p_p_l_c_replacement_project')!;
    expect(plc.title).toBe('Jobs Peak WTP PLC Replacement Project'); // name cell is empty; recovered from the ad
    expect(plc.dueAt).toBe('2026-07-30T21:00:00.000Z'); // "until 2:00 p.m. ... Thursday, July 30, 2026"
    expect(plc.estValue).toEqual({ min: 81000, max: 81000 }); // "Engineer's estimate ... $81,000.00"
    expect(plc.flags).toEqual(expect.arrayContaining(['Bid bond', 'Prevailing wage']));
    expect(plc.postedAt).toBe('2026-07-15T15:00:00.000Z');
  });
});

describe('QuestCDN NV Public Works (real JSON)', () => {
  const bids = parseQuestJson(JSON.parse(fx('questcdn-spwd.json')), QUEST_BOARDS[0]!);
  it('parses all 13 projects', () => expect(bids).toHaveLength(13));
  it('keeps truncated names honest and restores the owner', () => {
    const b = bids.find((x) => x.sourceId.endsWith(':10385980'))!;
    expect(b.title).toBe('Replace Cell Doors, Locks, Intercoms & Controls in…');
    expect(b.agency).toBe('Nevada State Public Works Division');
    expect(b.category).toBe('Electrical Installation/Constr…');
    expect(b.location).toMatchObject({ city: 'Carson Cit', county: 'Carson City', state: 'NV' });
    expect(b.dueAt).toBe('2026-11-18T22:00:00.000Z');
  });
  it('drops bogus county values', () => {
    const fish = bids.find((x) => x.sourceId.endsWith(':10414275'))!;
    expect(fish.location?.county).toBeNull(); // JSON says "United States"
  });
});

describe('NGEM / IonWave (real page)', () => {
  const { bids, pageUrls } = parseNgemPage(fx('ngem-page1.html'));
  it('parses rows and pager links', () => {
    expect(bids).toHaveLength(9);
    expect(pageUrls).toEqual([
      'https://nevada.ionwave.net/SourcingEvents.aspx?SourceType=1&ctl00_mainContent_rgBidListChangePage=2_20',
      'https://nevada.ionwave.net/SourcingEvents.aspx?SourceType=1&ctl00_mainContent_rgBidListChangePage=3_20',
    ]);
  });
  it('makes addenda keep the same id and flags them', () => {
    const fire = bids.find((b) => b.title.includes('Fire Alarm'))!;
    expect(fire.sourceId).toBe('city-of-north-las-vegas:1797');
    expect(fire.flags).toContain('Addendum 2 posted');
    expect(fire.dueAt).toBe('2026-11-12T19:00:00.000Z');
  });
  it('falls back to the bid number when the title is blank', () => {
    expect(bids.some((b) => b.title === 'Request for Quotation 10272026SITSTAND')).toBe(true);
  });
});

describe('NevadaEPro (real page)', () => {
  const bids = parseNevadaEproOpenBids(fx('nevadaepro-open-bids.html'));
  it('maps cells by label', () => {
    expect(bids).toHaveLength(9);
    const gen = bids.find((b) => b.title === 'Generator')!;
    expect(gen.sourceId).toBe('55AGR-S4066');
    expect(gen.agency).toBe('Department of Agriculture');
    expect(gen.dueAt).toBe('2026-11-25T01:00:00.000Z'); // 11/24/2026 5:00 PM PST
    expect(gen.url).toBe('https://nevadaepro.com/bso/external/bidDetail.sda?docId=55AGR-S4066&external=true&parentUrl=close');
  });
});

describe('SAM.gov', () => {
  it('builds the official v2 query', () => {
    const url = new URL(buildSamUrl({ apiKey: 'K', state: 'NV', from: new Date('2026-11-08T20:00:00Z'), to: new Date('2026-11-11T20:00:00Z') }));
    expect(url.origin + url.pathname).toBe('https://api.sam.gov/opportunities/v2/search');
    expect(url.searchParams.get('postedFrom')).toBe('11/08/2026');
    expect(url.searchParams.get('postedTo')).toBe('11/11/2026');
    expect(url.searchParams.get('state')).toBe('NV');
    expect(url.searchParams.get('ptype')).toBe('o,k,p');
  });
  it('maps the response shape', () => {
    const bids = parseSamResponse(JSON.parse(fx('samgov-search.json')));
    expect(bids).toHaveLength(3);
    expect(bids[0]).toMatchObject({
      sourceId: 'TEST-0001',
      agency: 'General Services Administration · PBS R9',
      naics: '238210',
      setAside: 'SBA',
      dueAt: '2026-12-01T22:00:00.000Z',
      url: 'https://sam.gov/opp/TEST-0001/view',
      location: { city: 'Carson City', state: 'NV', zip: '89701' },
    });
  });
});
