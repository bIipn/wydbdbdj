import { describe, expect, it } from 'vitest';
import { finalizeBid } from '../src/scan.js';
import { parseSfBids, sfBidsQuery, sfBidsSource, sfTitle, type SfBidsRow } from '../src/sources/sfbids.js';
import { fx } from './helpers.js';
import { socrataCtx } from './socrata-fake.js';

// The real answer of 2026-11-14 06:59 UTC, trimmed to 13 whole rows (test/fixtures/sfbids-open.md).
const ROWS: SfBidsRow[] = JSON.parse(fx('sfbids-open.json'));
const NOW = new Date('2026-11-14T07:00:00Z');

describe('parseSfBids (real SF City Partner rows)', () => {
  const p = parseSfBids(ROWS, NOW);
  const by = (id: string) => p.bids.find((b) => b.sourceId === `SFGOV~${id}`);

  it('counts what it read, kept and left out', () => {
    expect(p).toMatchObject({ read: 13, notOpen: 3, notTrade: 5 });
    expect(p.bids.map((b) => b.sourceId)).toEqual(
      ['0000002191', '0000007082', '0000009170', '0000009416', '0000012033'].map((n) => `SFGOV~${n}`),
    );
  });

  it('one bid, fully checked: Public Works paving (filed under Commodity), Pacific wall clock', () => {
    expect(by('0000009170')).toMatchObject({
      source: 'sfbids',
      sourceName: 'SF City Partner (San Francisco)',
      title: 'PW SAN BRUNO AVE PAVE RENOV',
      agency: 'San Francisco Public Works',
      category: 'Commodity',
      postedAt: '2026-09-29T07:00:00.000Z', // midnight PDT
      dueAt: '2026-11-18T22:30:00.000Z', // 2:30 PM PST
      solNumber: '9170',
      location: { city: 'San Francisco', state: 'CA' },
    });
    expect(by('0000009170')!.url).toMatch(/^https:\/\/sfcitypartner\.sfgov\.org\/pages\/Events-BS3\/event-details\.aspx\?.*AUC_ID=0000009170/);
    expect(by('0000009170')!.description).toBe('Public Works · Commodity · Seeking Bids · Amended · Event 9170');
    expect(finalizeBid(by('0000009170')!).location).toMatchObject({ label: 'San Francisco, CA', precision: 'city' });
  });

  it('strips the department code from the title', () => {
    expect(by('0000012033')!.title).toBe('PW 887 Ptrr Tnnt Imprv & Fire');
    expect(sfTitle('OCA | TC78150 Citywide Landscaping Services')).toBe('TC78150 Citywide Landscaping Services');
    expect(sfTitle('No bar here')).toBe('No bar here');
  });

  it('a 2099 due date is a placeholder: no deadline, and the card says it is an open list', () => {
    expect(by('0000002191')).toMatchObject({ title: 'Construction & Prof Services', dueAt: null });
    expect(by('0000002191')!.description).toMatch(/No closing date listed: an open list/);
    expect(by('0000012243')).toBeUndefined(); // Airport Concessions and Leases (2099): not trade work
  });

  it('leaves out past due rows, bid results, non-construction and non-trade listings', () => {
    expect(by('0000011697')).toBeUndefined(); // due 2026-11-13 1 PM, still listed (weekly reload)
    expect(by('0000012177')).toBeUndefined();
    expect(by('0000012178')).toBeUndefined(); // Bid Results 7/1/2026-12/31/2026
    expect(by('0000012098')).toBeUndefined(); // Professional Services (Non-Construction)
    expect(by('0000011663')).toBeUndefined(); // catering
    expect(by('0000012241')).toBeUndefined(); // software licence
    expect(by('0000009416')!.dueAt).toBe('2026-12-07T21:00:00.000Z'); // landscaping, 1 PM PST
  });
});

describe('sfBidsSource.fetch', () => {
  it('asks data.sf.gov once with the open-status filter', async () => {
    const { ctx, urls, logs } = socrataCtx([ROWS], NOW);
    expect(await sfBidsSource.fetch(ctx)).toHaveLength(5);
    const u = new URL(urls[0]!);
    expect(`${u.origin}${u.pathname}`).toBe('https://data.sf.gov/resource/eshn-8t3a.json');
    expect(u.searchParams.get('$where')).toBe(sfBidsQuery(NOW).where);
    expect(u.searchParams.get('$where')).toBe("status in ('Open', 'Amended') AND due_date > '2026-11-13T07:00:00'");
    expect(logs).toEqual(['sfbids: 13 listed in 1 page(s), 5 kept, 3 closed/results, 5 left out as not trade work']);
  });

  it('throws on an empty answer or rows without ids', async () => {
    await expect(sfBidsSource.fetch(socrataCtx([[]], NOW).ctx)).rejects.toThrow('sfbids: no rows');
    await expect(sfBidsSource.fetch(socrataCtx([[{ x: 1 }]], NOW).ctx)).rejects.toThrow('none with an event_id');
  });
});

describe('sfPlace: SFO and the water system are not in the City', () => {
  it('Airport → ZIP 94128, PUC → CA only, the rest San Francisco', async () => {
    const { sfPlace } = await import('../src/sources/sfbids.js');
    expect(sfPlace('Airport Commission')).toEqual({ zip: '94128', state: 'CA' });
    expect(sfPlace('Public Utilities Commission')).toEqual({ state: 'CA' });
    expect(sfPlace('Public Works')).toEqual({ city: 'San Francisco', state: 'CA' });
  });
});
