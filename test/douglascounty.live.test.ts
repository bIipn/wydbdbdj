import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { douglasCountySource, parseDouglasPage, parseDouglasRfp } from '../src/sources/douglascounty.js';
import type { SourceContext } from '../src/types.js';

/** RAW server HTML (no page JavaScript has run): every row is a bare tr.rfp-item with an empty td.status. */
const raw = readFileSync(resolve(__dirname, 'fixtures', 'douglas-rfp.raw.html'), 'utf8');

/** Capture day, noon Pacific. */
const CAPTURED = new Date('2026-11-13T20:00:00Z');
const openIds = (nowIso: string, html = raw) => parseDouglasRfp(html, { now: new Date(nowIso) }).map((b) => b.sourceId);

const LIBRARY = 'library_strategic_plan';
const WATERLOO = 'r_f_p___waterloo_lampe_park_rd_realignment_project';
const PLC = 'jobs_peak_w_t_p_p_l_c_replacement_project';
const GENERATOR = 'animal_services_emergency_generator_project';
const DANGBERG = 'dangberg_home_ranch_foundation_restoration';
const LIGHTING = 'Fairground_Arena_Lighting_Project';

describe('Douglas County — raw server HTML (captured 2026-11-13)', () => {
  it('finds the one open bid on capture day', () => {
    const page = parseDouglasPage(raw, { now: CAPTURED });
    expect(page).toMatchObject({ hasTable: true, rows: 9, notes: [] });
    expect(page.bids).toHaveLength(9);
    expect(page.open).toHaveLength(1);
    expect(page.open[0]).toMatchObject({
      sourceId: LIBRARY,
      title: 'RFP Library 5-year Strategic Plan',
      url: 'https://www.douglascountynv.gov/rfp-bids/library_strategic_plan',
      category: 'County bid',
      postedAt: '2026-11-02T16:00:00.000Z', // 2026/11/02, 8 AM PST
      dueAt: '2026-11-21T01:00:00.000Z', // 2026/11/20, no time given → 5 PM PST
    });
    expect(parseDouglasRfp(raw, { now: CAPTURED })).toEqual(page.open);
  });

  it('cannot tell open from closed without "now" — and says so instead of returning 0 bids', () => {
    expect(() => parseDouglasRfp(raw)).toThrow(/no Open\/Close status.*pass opts\.now/);
  });

  it('still reads the legal ad of every row', () => {
    const all = parseDouglasRfp(raw, { now: CAPTURED, includeClosed: true });
    expect(all.map((b) => b.category)).toEqual(['County bid', ...Array(8).fill('County bid (closed)')]);

    const plc = all.find((b) => b.sourceId === PLC)!;
    expect(plc.title).toBe('Jobs Peak WTP PLC Replacement Project'); // name cell is empty; recovered from the ad
    expect(plc.dueAt).toBe('2026-07-30T21:00:00.000Z'); // "until 2:00 p.m. local time on Thursday, July 30, 2026"
    expect(plc.postedAt).toBe('2026-07-15T15:00:00.000Z');
    expect(plc.estValue).toEqual({ min: 81000, max: 81000 });
    expect(plc.flags).toEqual(expect.arrayContaining(['Bid bond', 'Prevailing wage']));

    const wells = all.find((b) => b.sourceId === 'electrical_improvements_at_walley_s___genoa_lakes')!;
    expect(wells.title).toBe("RFP Bids for Walley's Well & Genoa Lakes Well 2 Electrical Improvements");
    expect(wells.dueAt).toBe('2023-08-22T21:00:00.000Z'); // "until 2:00 PM local time on Tuesday, August 22, 2023"
    expect(wells.estValue).toEqual({ min: 150000, max: 150000 });

    // A row the county left blank: no name, no ad, placeholder dates (1800/01/01).
    const blank = all.find((b) => b.sourceId === 'water_model_maintenance_and_expansion')!;
    expect(blank).toMatchObject({ title: 'Water Model Maintenance And Expansion', description: null, postedAt: null, dueAt: null });
  });
});

describe('Douglas County — open or closed?', () => {
  it('date-only rows follow the county: open until the day before the deadline, in Pacific time', () => {
    // Library: deadline cell 2026/11/20, no time in the ad. Midnight Pacific (PST, UTC-8) is 08:00Z.
    expect(openIds('2026-11-20T03:00:00Z')).toContain(LIBRARY); // Nov 19, 7 PM Pacific (already Nov 20 in UTC)
    expect(openIds('2026-11-20T07:59:59Z')).toContain(LIBRARY); // Nov 19, 11:59 PM
    expect(openIds('2026-11-20T08:00:00Z')).not.toContain(LIBRARY); // the deadline day itself: closed, like the county's page
    expect(openIds('2026-11-20T18:00:00Z')).not.toContain(LIBRARY); // 10 AM on the deadline day
    expect(openIds('2026-11-21T18:00:00Z')).not.toContain(LIBRARY);
  });

  it('uses the right midnight in summer too (PDT, UTC-7)', () => {
    // Fairground Arena Lighting: deadline cell 2022/08/25, date only. Midnight PDT is 07:00Z, not 08:00Z.
    expect(openIds('2022-08-25T06:59:59Z')).toContain(LIGHTING); // Aug 24, 11:59 PM PDT
    expect(openIds('2022-08-25T07:00:00Z')).not.toContain(LIGHTING); // Aug 25, 12:00 AM PDT
  });

  it('a due time in the ad beats the deadline cell: open until that moment', () => {
    // Jobs Peak PLC: deadline cell 2026/07/20 (really the pre-bid meeting); bids due 7/30 2:00 PM PDT = 21:00Z.
    expect(openIds('2026-07-19T19:00:00Z')).toContain(PLC);
    expect(openIds('2026-07-25T19:00:00Z')).toContain(PLC); // the county's page hides it from 7/20 on
    expect(openIds('2026-07-30T20:59:59Z')).toContain(PLC); // due day, 1:59 PM
    expect(openIds('2026-07-30T21:00:00Z')).not.toContain(PLC); // 2:00 PM: over
    expect(parseDouglasPage(raw, { now: new Date('2026-07-25T19:00:00Z') }).notes).toEqual([
      `${PLC}: open, the ad says bids are due 2026-07-30T21:00:00.000Z; the county's page already shows it closed (deadline cell: 2026/07/20)`,
    ]);
  });

  it('never shows a bid as open after the due time in its ad', () => {
    // Dangberg Home Ranch: ad "on or before 2:00 pm on Thursday June 6th, 2024"; deadline cell 2024/06/21.
    expect(openIds('2024-06-06T20:59:59Z')).toContain(DANGBERG);
    const page = parseDouglasPage(raw, { now: new Date('2024-06-10T19:00:00Z') }); // the county would still list it
    expect(page.open.map((b) => b.sourceId)).not.toContain(DANGBERG);
    expect(page.notes).toEqual([
      `${DANGBERG}: closed, the ad says bids were due 2024-06-06T21:00:00.000Z; the county's page still shows it open (deadline cell: 2024/06/21)`,
    ]);
  });

  it('ad time on the deadline day: open until the hour (PST)', () => {
    // Animal Services Emergency Generator: "on or before 2PM December 19, 2024"; cell 2024/12/19. 2 PM PST = 22:00Z.
    expect(openIds('2024-12-19T18:00:00Z')).toContain(GENERATOR); // 10 AM
    expect(openIds('2024-12-19T22:00:00Z')).not.toContain(GENERATOR);
  });

  it('honors rows already stamped Open/Close (page saved from a browser), with or without "now"', () => {
    // What the county's script does in a browser on 2026-11-13: first row s-open, the rest s-close.
    let n = 0;
    const stamped = raw.replaceAll('<tr class="rfp-item">', () => `<tr class="rfp-item ${n++ === 0 ? 's-open' : 's-close'}">`);
    expect(n).toBe(9);
    expect(parseDouglasRfp(stamped).map((b) => b.sourceId)).toEqual([LIBRARY]);
    expect(openIds('2030-01-01T20:00:00Z', stamped)).toEqual([LIBRARY]); // the stamp wins over the dates
    expect(parseDouglasRfp(stamped, { includeClosed: true })).toHaveLength(9);

    // Status text alone works too: mark the Library row "Close" and it is gone on capture day.
    const closedByText = raw.replace('<td class="status" />', '<td class="status">Close</td>');
    expect(openIds(CAPTURED.toISOString(), closedByText)).toEqual([]);
  });
});

describe('Douglas County — fetch() is loud', () => {
  function fakeCtx(html: string, now = CAPTURED) {
    const logs: string[] = [];
    const ctx: SourceContext = {
      http: { text: async () => html, json: async () => ({}) as never },
      now,
      env: () => undefined,
      log: (m) => logs.push(m),
    };
    return { ctx, logs };
  }

  it('uses ctx.now and logs "N open of M rows"', async () => {
    const { ctx, logs } = fakeCtx(raw);
    expect((await douglasCountySource.fetch(ctx)).map((b) => b.sourceId)).toEqual([LIBRARY]);
    expect(logs).toEqual(['douglascounty: 1 open of 9 rows']);
  });

  it('0 open is a normal answer when the rows are there (deadline day)', async () => {
    const { ctx, logs } = fakeCtx(raw, new Date('2026-11-20T18:00:00Z'));
    expect(await douglasCountySource.fetch(ctx)).toEqual([]);
    expect(logs).toEqual(['douglascounty: 0 open of 9 rows']);
  });

  it('logs every row where the ad overrules the county', async () => {
    const { ctx, logs } = fakeCtx(raw, new Date('2026-07-25T19:00:00Z'));
    expect((await douglasCountySource.fetch(ctx)).map((b) => b.sourceId)).toEqual([LIBRARY, WATERLOO, PLC]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/^douglascounty: jobs_peak_w_t_p_p_l_c_replacement_project: open, the ad says/);
    expect(logs[1]).toBe('douglascounty: 3 open of 9 rows');
  });

  it('throws when the table is missing', async () => {
    const { ctx } = fakeCtx(raw.replace('<table id="rfp-table" class="open-bid">', '<table>'));
    await expect(douglasCountySource.fetch(ctx)).rejects.toThrow('bid table (#rfp-table) not found');
  });

  it('throws when the table has no rows', async () => {
    const { ctx } = fakeCtx(raw.replaceAll('<tr class="rfp-item">', '<tr>'));
    await expect(douglasCountySource.fetch(ctx)).rejects.toThrow('bid table has no rfp-item rows');
  });

  it('throws when the rows are there but none can be read', async () => {
    const { ctx } = fakeCtx(raw.replaceAll('href="/rfp-bids/', 'href="/moved/'));
    await expect(douglasCountySource.fetch(ctx)).rejects.toThrow('none of the 9 rows could be read');
  });

  it('counts rows it had to skip', async () => {
    const { ctx, logs } = fakeCtx(raw.replace('href="/rfp-bids/closed-bids/electrical_service_upgrade"', 'href="#"'));
    expect(await douglasCountySource.fetch(ctx)).toHaveLength(1);
    expect(logs).toEqual(['douglascounty: 1 open of 9 rows (1 unreadable)']);
  });
});
