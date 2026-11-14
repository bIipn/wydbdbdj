import { describe, expect, it } from 'vitest';
import { finalizeBid } from '../src/scan.js';
import { FLAGS } from '../src/sources/flags.js';
import { laRampQuery, laRampSource, laRampTitle, parseLaRamp, type LaRampRow } from '../src/sources/laramp.js';
import { parseUsDateTime } from '../src/util/time.js';
import { fx } from './helpers.js';
import { socrataCtx } from './socrata-fake.js';

// The real answer of 2026-11-14 06:59 UTC, trimmed to 14 whole rows (test/fixtures/laramp-open.md).
const ROWS: LaRampRow[] = JSON.parse(fx('laramp-open.json'));
const NOW = new Date('2026-11-14T07:00:00Z');

describe('parseLaRamp (real RAMP rows)', () => {
  const p = parseLaRamp(ROWS, NOW);
  const by = (id: string) => p.bids.find((b) => b.sourceId === id);

  it('counts what it read, kept and left out', () => {
    expect(p).toMatchObject({ read: 14, notOpen: 1, notTrade: 6 });
    expect(p.bids.map((b) => b.sourceId).sort()).toEqual(['232242', '232828', '232844', '232919', '232995', '233062', '233067']);
  });

  it('one bid, fully checked: Vision Zero traffic signals (Public Works)', () => {
    expect(by('232919')).toMatchObject({
      source: 'laramp',
      sourceName: 'LA City RAMP (Los Angeles)',
      title: 'VISION ZERO PHASE 2H, BACKLOG REDUCTION PHASE 3 & REAP 2.0 TRAFFIC SIGNAL IMPROVEMENTS',
      agency: 'Engineering Bureau, Public Works',
      category: 'Construction',
      postedAt: '2026-11-14T01:00:00.000Z',
      dueAt: '2026-12-16T18:00:00.000Z', // 10:00 AM PST
      url: 'https://www.rampla.org/s/opportunity-details?id=006Ql00000o78KDIAY',
      location: { city: 'Los Angeles', state: 'CA' },
    });
    expect(by('232919')!.description).toBe('Engineering Bureau, Public Works · Construction · RFB - Request For Bid · RAMP 232919');
    expect(finalizeBid(by('232919')!).location).toMatchObject({ label: 'Los Angeles, CA', precision: 'city' });
  });

  it('reads closedate as UTC: every title that states its closing time agrees with the column read that way', () => {
    // (the title column is cut at 120 characters: "Closing: 12/23/202" has no time and is skipped)
    const stated = ROWS.filter((r) => /Closing:\s*\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2} [AP]M$/.test(r.title ?? ''));
    expect(stated).toHaveLength(4); // noon and 5 PM closings
    for (const r of stated) {
      const words = /Closing:\s*(.+)$/.exec(r.title!)![1]!;
      expect(new Date(`${r.closedate}Z`).toISOString()).toBe(parseUsDateTime(words, { timeZone: 'America/Los_Angeles' }));
    }
    // and the parser writes exactly that instant
    expect(by('233062')!.dueAt).toBe('2026-11-27T20:00:00.000Z'); // "Closing: 11/27/2026 12:00 PM"
  });

  it('drops the closing words from the title (the card shows the deadline itself)', () => {
    expect(by('233062')!.title).toBe('RFB-IS-27200325 - ROOF REPLACEMENT - CAMP 8 MAINT BUILDING - JOB WALK');
    expect(laRampTitle('X - Closing: 12/2/2026 12:00 PM')).toBe('X');
  });

  it('keeps a Commodity listing only when its title names work', () => {
    expect(by('233062')!.category).toBe('Commodity'); // roof replacement
    expect(by('232995')!.title).toMatch(/HEIGHT ADJUSTERS AND INSTALLATION/);
    expect(by('232966')).toBeUndefined(); // 146990 FIBER OPTIC CABLE: a supply order
    expect(by('233022')).toBeUndefined(); // 146861 MOTOR, 150HP, 720RPM
    expect(by('232268')).toBeUndefined(); // Case Management System (CMS) Solution
  });

  it('leaves out personal services that are not trade work, keeps the ones that are', () => {
    expect(by('233067')!.title).toMatch(/Heating, Ventilation, and Air Conditioning/);
    expect(by('227079')).toBeUndefined(); // risk consulting
    expect(by('232870')).toBeUndefined(); // commercial driver evaluations
  });

  it('places the Ontario airport in Ontario; flags an RFI; drops the practice listing', () => {
    expect(finalizeBid(by('232242')!).location).toMatchObject({ city: 'Ontario', state: 'CA', precision: 'city' });
    expect(by('232828')!.flags).toContain(FLAGS.rfi);
    expect(by('30751')).toBeUndefined(); // "Online Bidding Practice", due 2037
  });

  it('drops a listing closed by now', () => {
    const later = parseLaRamp(ROWS, new Date('2026-11-18T00:00:00Z'));
    expect(later.bids.find((b) => b.sourceId === '232995')).toBeUndefined(); // closed 11/17 11:00 AM PST
    expect(later.notOpen).toBe(3); // and the motor (11/17 2 PM PST), and the practice listing
  });
});

describe('laRampSource.fetch', () => {
  it('asks once with the open-stage filter and returns the kept bids', async () => {
    const { ctx, urls, logs } = socrataCtx([ROWS], NOW);
    const bids = await laRampSource.fetch(ctx);
    expect(bids).toHaveLength(7);
    const u = new URL(urls[0]!);
    expect(`${u.origin}${u.pathname}`).toBe('https://data.lacity.org/resource/hf3r-utnq.json');
    expect(u.searchParams.get('$where')).toBe("stagename in ('Open', 'Amended') AND closedate > '2026-11-13T07:00:00'");
    expect(u.searchParams.get('$where')).toBe(laRampQuery(NOW).where);
    expect(logs).toEqual(['laramp: 14 listed in 1 page(s), 7 kept, 1 closed/cancelled/practice, 6 left out as not trade work']);
  });

  it('throws on an empty answer, rows without ids, or an error object (FAILED, never a quiet 0)', async () => {
    await expect(laRampSource.fetch(socrataCtx([[]], NOW).ctx)).rejects.toThrow('laramp: no rows');
    await expect(laRampSource.fetch(socrataCtx([[{ name: 'x' }]], NOW).ctx)).rejects.toThrow('none with a rampid');
    await expect(laRampSource.fetch(socrataCtx([{ error: true, message: 'No such column: closedate' }], NOW).ctx))
      .rejects.toThrow('No such column: closedate');
  });
});

describe('laRampPlace: the city only for the City of Los Angeles', () => {
  it('places the other agencies RAMP carries where they are, or at the state', async () => {
    const { laRampPlace } = await import('../src/sources/laramp.js');
    expect(laRampPlace('Port of Long Beach')).toEqual({ city: 'Long Beach', state: 'CA' });
    expect(laRampPlace('Los Angeles County')).toEqual({ county: 'Los Angeles', state: 'CA' });
    expect(laRampPlace('Water & Power')).toEqual({ state: 'CA' }); // LADWP also lists its Nevada facilities
    expect(laRampPlace('Ontario International Airport Authority')).toEqual({ city: 'Ontario', state: 'CA' });
    expect(laRampPlace('General Services')).toEqual({ city: 'Los Angeles', state: 'CA' });
  });
});
