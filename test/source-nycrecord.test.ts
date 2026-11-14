import { describe, expect, it } from 'vitest';
import { finalizeBid } from '../src/scan.js';
import { FLAGS } from '../src/sources/flags.js';
import {
  nycNoticeUrl, nycPin, nycQuery, nycRecordSource, nycSite, nycText, nycTitle, parseNycRecord, type NycRow,
} from '../src/sources/nycrecord.js';
import { fx } from './helpers.js';
import { socrataCtx } from './socrata-fake.js';

// The real answer of 2026-11-14 06:59 UTC, trimmed to 18 whole rows (test/fixtures/nycrecord-open.md).
const ROWS: NycRow[] = JSON.parse(fx('nycrecord-open.json'));
const NOW = new Date('2026-11-14T07:00:00Z');

describe('parseNycRecord (real City Record rows)', () => {
  const p = parseNycRecord(ROWS, NOW);
  const by = (id: string) => p.bids.find((b) => b.sourceId === id);

  it('counts what it read, kept and left out', () => {
    expect(p).toMatchObject({ read: 18, notOpen: 7, notTrade: 3, replaced: 1 });
    expect(p.bids).toHaveLength(7);
  });

  it('one bid, fully checked: Jacobi Medical Center (NYC Health + Hospitals), placed from its LOCATION line', () => {
    const b = by('nyc-health-hospitals-21202303')!;
    expect(b).toMatchObject({
      source: 'nycrecord',
      sourceName: 'NYC City Record',
      title: 'Jacobi Patient Account Decanting',
      agency: 'NYC Health + Hospitals', // other agencies get "NYC " in front ("NYC Education")
      category: 'Construction Related Services',
      postedAt: '2026-11-13T05:00:00.000Z', // midnight EST
      dueAt: '2027-01-07T16:00:00.000Z', // 11:00 AM EST
      url: 'https://a856-cityrecord.nyc.gov/RequestDetail/20261106018',
      solNumber: '21202303',
      location: { zip: '10461', state: 'NY', city: 'Bronx' },
    });
    expect(b.description).toMatch(/^NYC Health \+ Hospitals · Construction Related Services · Competitive Sealed Bids · PIN 21202303\nLOCATION: Jacobi Medical Center, 1400 Pelham Parkway South, Bronx, NY 10461/);
    expect(b.flags).toEqual(expect.arrayContaining(['Mandatory pre-bid']));
    expect(finalizeBid(b).location).toMatchObject({ city: 'Bronx', state: 'NY', zip: '10461', precision: 'city' });
  });

  it('elsewhere the place is New York, NY (the notice gives no site), never the agency office', () => {
    const b = by('education-B5721040')!;
    expect(b.location).toEqual({ city: 'New York', state: 'NY' });
    expect(b.agency).toBe('NYC Education');
    expect(finalizeBid(b).location).toMatchObject({ label: 'New York, NY', precision: 'city' });
  });

  it('"Bid Extension:" and "Correction:" go from the title to the description', () => {
    expect(by('education-B5721040')!.title).toBe('Requirement Contract for Electrical Installations and Repair');
    expect(by('education-B5721040')!.description).toMatch(/^Bid extension · Education · Goods and Services · /);
    const rfi = by('information-technology-and-telecommunications-85827Y1399')!;
    expect(rfi.title).toMatch(/^Leveraging Ground-Scanning Technology/);
    expect(rfi.description).toMatch(/^Correction · /);
    expect(rfi.flags).toContain(FLAGS.rfi);
    expect(rfi.dueAt).toBe('2026-11-17T04:45:00.000Z'); // 11:45 PM EST on the 16th
  });

  it('one card per agency + PIN, the newest notice; a stale open list is left out', () => {
    expect(by('design-and-construction-PQL000172')!.url).toBe(nycNoticeUrl('20260729023')); // not 20260625051
    expect(by('parks-and-recreation-PQL000154')).toMatchObject({ url: nycNoticeUrl('20260413020'), dueAt: '2027-04-20T21:00:00.000Z' });
    // PQL000124 2025 (due 2099, 19 months old) is stale; its 2026 notice (due 2040-12-31) is the card
    expect(by('design-and-construction-PQL000124')!.url).toBe(nycNoticeUrl('20260420038'));
    expect(p.bids.some((b) => /ROOFRFQ20151/.test(b.sourceId))).toBe(false); // the 2015 list due "2999"
  });

  it('leaves out human services and goods that are not work', () => {
    expect(by('health-and-mental-hygiene-81622P0004')).toBeUndefined(); // supportive housing
    expect(by('citywide-administrative-services-85727B0033')).toBeUndefined(); // window air conditioners (a purchase)
    expect(by('parks-and-recreation-CWB-2026-A')).toBeUndefined(); // food from mobile food units
  });

  it('an open list with a recent notice keeps no deadline and says so; a cancellation is left out', () => {
    // The real 2020 notices below, with start_date moved to 2026-10-01 (edited in the test) so only the rule decides.
    const recent = (id: string) => ({ ...ROWS.find((r) => r.request_id === id)!, start_date: '2026-10-01T00:00:00.000' });
    const q = parseNycRecord([recent('20241104004'), recent('20200727109')], NOW);
    expect(q.bids).toHaveLength(1);
    expect(q.bids[0]).toMatchObject({ sourceId: '20241104004', dueAt: null }); // PIN "N/A": the request id
    expect(q.bids[0]!.description).toMatch(/No closing date listed: an open list/);
    expect(q.notOpen).toBe(1); // "Cancellation: LANDSCAPE MAINTENANCE"
  });
});

describe('nycrecord helpers', () => {
  it('reads PINs, titles, 0x1A and sites', () => {
    expect(nycPin('ROOFRFQ20151.')).toBe('ROOFRFQ20151');
    expect(nycPin('N/A')).toBeNull();
    expect(nycPin('NoPINFound')).toBeNull();
    expect(nycPin('Emergency Solicitati')).toBeNull();
    expect(nycTitle('Bid CANCELLATION : Landscape maintenance')).toEqual({ title: 'Landscape maintenance', note: 'Bid cancellation' });
    expect(nycText('PROPOSAL \x1A SCHOOL; PQL\x1As')).toBe("PROPOSAL – SCHOOL; PQL's");
    expect(nycSite('Bids go to 1 Centre Street, New York, NY 10007')).toEqual({ city: 'New York', state: 'NY' });
  });
});

describe('nycRecordSource.fetch', () => {
  it('asks once for procurement solicitations, only the columns it reads', async () => {
    const { ctx, urls, logs } = socrataCtx([ROWS], NOW);
    expect(await nycRecordSource.fetch(ctx)).toHaveLength(7);
    const u = new URL(urls[0]!);
    expect(`${u.origin}${u.pathname}`).toBe('https://data.cityofnewyork.us/resource/dg92-zbpx.json');
    expect(u.searchParams.get('$where')).toBe(
      "section_name = 'Procurement' AND type_of_notice_description = 'Solicitation' AND due_date > '2026-11-13T07:00:00'",
    );
    expect(u.searchParams.get('$where')).toBe(nycQuery(NOW).where);
    expect(u.searchParams.get('$select')).not.toMatch(/contact|email|phone/);
    expect(logs).toEqual([
      'nycrecord: 18 solicitations listed in 1 page(s), 7 kept, 1 older notices of the same PIN, 7 closed, 3 left out as not trade work',
    ]);
  });

  it('throws on an empty answer or rows without ids', async () => {
    await expect(nycRecordSource.fetch(socrataCtx([[]], NOW).ctx)).rejects.toThrow("nycrecord: no Procurement 'Solicitation' rows");
    await expect(nycRecordSource.fetch(socrataCtx([[{ x: 1 }]], NOW).ctx)).rejects.toThrow('none with a request_id');
  });
});

describe('stripContacts: no named contact is stored from a notice text', () => {
  it('takes e-mails and phone numbers out of what the card keeps', async () => {
    const { stripContacts } = await import('../src/sources/nycrecord.js');
    // SYNTHETIC contact (example.com, a 555 number)
    expect(stripContacts('Contact TEST Person at (555) 010-0100 or test.person@example.com.'))
      .toBe('Contact TEST Person at [phone in the notice] or [e-mail in the notice].');
    const { parseNycRecord } = await import('../src/sources/nycrecord.js');
    const rows = JSON.parse(fx('nycrecord-open.json')) as Parameters<typeof parseNycRecord>[0];
    const all = parseNycRecord(rows, new Date('2026-11-14T07:00:00Z')).bids.map((b) => b.description ?? '').join('\n');
    expect(all).not.toMatch(/[a-z0-9.]+@[a-z.]+\.(gov|com)|\(\d{3}\) \d{3}-\d{4}/i);
  });
});
