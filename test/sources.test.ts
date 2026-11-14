import * as cheerio from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { parseDouglasPage, parseDouglasRfp } from '../src/sources/douglascounty.js';
import { fixtureSources } from '../src/sources/fixtures.js';
import { parseNevadaEproOpenBids, parseNevadaEproPage, parseNevadaEproTotal } from '../src/sources/nevadaepro.js';
import { buildNgemPostback, isNgemErrorPage, NGEM_URL, parseNgemPage, parseNgemPager } from '../src/sources/ngem.js';
import { parseQuestJson, QUEST_BOARDS } from '../src/sources/questcdn.js';
import { buildSamUrl, parseSamResponse, type SamResponse } from '../src/sources/samgov.js';
import { browserSavedNgem, CAPTURED, edit, fakeCtx, FIXTURE_DIR, fx, NGEM_GRID, ngemTarget } from './helpers.js';

// Parsers only. What each source's fetch() does with a page (log lines, loud failures, NGEM paging)
// is in fetch.test.ts. The HTML fixtures are RAW server responses captured 2026-11-13.

describe('Douglas County (raw server HTML)', () => {
  // Every row is a bare tr.rfp-item with an empty td.status: the page only stamps Open/Close in a browser.
  const raw = fx('douglas-rfp.html');
  const openIds = (nowIso: string, html = raw) => parseDouglasRfp(html, { now: new Date(nowIso) }).map((b) => b.sourceId);

  const LIBRARY = 'library_strategic_plan';
  const PLC = 'jobs_peak_w_t_p_p_l_c_replacement_project';
  const GENERATOR = 'animal_services_emergency_generator_project';
  const DANGBERG = 'dangberg_home_ranch_foundation_restoration';
  const LIGHTING = 'Fairground_Arena_Lighting_Project';
  const SERVICE = 'electrical_service_upgrade';
  const WATERLOO = 'r_f_p___waterloo_lampe_park_rd_realignment_project';

  it('returns only open rows by default', () => {
    const page = parseDouglasPage(raw, { now: CAPTURED });
    expect(page).toMatchObject({ tableFound: true, rows: 9, notes: [] });
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

  it('takes id and url from "View Details" (the last link), even when the ad links to the board', () => {
    // As in the live row "Safe Streets for All Action Plan" (not in this excerpt): the ad carries the board's URL.
    const boardLink = '<a href="https://www.douglascountynv.gov/r_f_p__b_i_d_s">https://www.douglascountynv.gov/r_f_p__b_i_d_s</a>';
    const withBoardLink = edit(raw, ($) => $('tr.rfp-item').first().children('td').eq(2).prepend(boardLink));
    expect(withBoardLink).toContain(boardLink);
    expect(parseDouglasPage(withBoardLink, { now: CAPTURED }).bids[0]).toMatchObject({
      sourceId: LIBRARY,
      url: 'https://www.douglascountynv.gov/rfp-bids/library_strategic_plan',
    });
  });

  it('never shows Cloudflare\'s "[email protected]" placeholder', () => {
    // The raw HTML has <a class="__cf_email__">[email protected]</a> wherever a browser shows an address.
    expect(raw).toContain('class="__cf_email__"');
    const all = parseDouglasRfp(raw, { now: CAPTURED, includeClosed: true });
    expect(all.filter((b) => /\[email.protected\]/.test(b.description ?? ''))).toEqual([]);
    const library = all.find((b) => b.sourceId === LIBRARY)!;
    expect(library.description).toContain('emailed to the following address (e-mail address on the county page)');
  });

  it('cannot tell open from closed without "now", and says so instead of returning 0 bids', () => {
    expect(() => parseDouglasRfp(raw)).toThrow(/no Open\/Close status.*pass opts\.now/);
  });

  it('pulls title, deadline, estimate and requirements out of the legal ad', () => {
    const all = parseDouglasRfp(raw, { now: CAPTURED, includeClosed: true });
    expect(all.map((b) => b.category)).toEqual(['County bid', ...Array<string>(8).fill('County bid (closed)')]);

    const plc = all.find((b) => b.sourceId === PLC)!;
    expect(plc.title).toBe('Jobs Peak WTP PLC Replacement Project'); // name cell is empty; recovered from the ad
    expect(plc.dueAt).toBe('2026-07-30T21:00:00.000Z'); // "until 2:00 p.m. local time on Thursday, July 30, 2026"
    expect(plc.estValue).toEqual({ min: 81000, max: 81000 }); // "Engineer's estimate ... $81,000.00"
    expect(plc.flags).toEqual(expect.arrayContaining(['Bid bond', 'Prevailing wage']));
    expect(plc.postedAt).toBe('2026-07-15T15:00:00.000Z');

    const wells = all.find((b) => b.sourceId === 'electrical_improvements_at_walley_s___genoa_lakes')!;
    expect(wells.title).toBe("RFP Bids for Walley's Well & Genoa Lakes Well 2 Electrical Improvements");
    expect(wells.dueAt).toBe('2023-08-22T21:00:00.000Z'); // "until 2:00 PM local time on Tuesday, August 22, 2023"
    expect(wells.estValue).toEqual({ min: 150000, max: 150000 });

    // A row the county left blank: no name, no ad, placeholder dates (1800/01/01).
    const blank = all.find((b) => b.sourceId === 'water_model_maintenance_and_expansion')!;
    expect(blank).toMatchObject({ title: 'Water Model Maintenance And Expansion', description: null, postedAt: null, dueAt: null });
  });

  describe('open or closed?', () => {
    it('date-only rows follow the county: open until the day before the deadline, in Pacific time', () => {
      // Library: deadline cell 2026/11/20, no time in the ad. Midnight Pacific (PST, UTC-8) is 08:00Z.
      expect(openIds('2026-11-20T03:00:00Z')).toContain(LIBRARY); // Nov 19, 7 PM Pacific (already Nov 20 in UTC)
      expect(openIds('2026-11-20T07:59:59Z')).toContain(LIBRARY); // Nov 19, 11:59 PM
      expect(openIds('2026-11-20T08:00:00Z')).not.toContain(LIBRARY); // the deadline day itself: closed, like the county's page
      expect(openIds('2026-11-20T18:00:00Z')).not.toContain(LIBRARY); // 10 AM on the deadline day
      expect(openIds('2026-11-21T18:00:00Z')).not.toContain(LIBRARY);
    });

    it('uses the right midnight in summer too (PDT, UTC-7)', () => {
      // Electrical Service Upgrade: deadline cell 2018/10/19, no date or time in the ad. Midnight PDT is 07:00Z, not 08:00Z.
      expect(openIds('2018-10-19T06:59:59Z')).toContain(SERVICE); // Oct 18, 11:59 PM PDT
      expect(openIds('2018-10-19T07:00:00Z')).not.toContain(SERVICE); // Oct 19, 12:00 AM PDT
    });

    it('reads the due time from the short ads too, not 5 PM by default', () => {
      const all = parseDouglasRfp(raw, { now: CAPTURED, includeClosed: true });
      // "Electronic proposals must be received by November 9, 2026 no later than 2:00pm PST." 2 PM PST = 22:00Z.
      expect(all.find((b) => b.sourceId === WATERLOO)!.dueAt).toBe('2026-11-09T22:00:00.000Z');
      expect(openIds('2026-11-09T21:59:59Z')).toContain(WATERLOO); // due day, 1:59 PM
      expect(openIds('2026-11-09T22:00:00Z')).not.toContain(WATERLOO); // 2:00 PM: over
      // Fairground Arena Lighting: "Bid Due Date: 2PM Thursday August 25, 2022". 2 PM PDT = 21:00Z.
      expect(all.find((b) => b.sourceId === LIGHTING)!.dueAt).toBe('2022-08-25T21:00:00.000Z');
      expect(openIds('2022-08-25T20:59:59Z')).toContain(LIGHTING);
      expect(openIds('2022-08-25T21:00:00Z')).not.toContain(LIGHTING);
    });

    it('an ad that leaves the year out gets it from the deadline cell', () => {
      // As in the live Herbig Park row (not in this excerpt): "on or before 2:00 pm Thursday, June 20th."
      // Here the generator ad with its ", 2024" taken out (in memory); the deadline cell says 2024/12/19.
      const noYear = raw.replace('on or before 2PM December 19, 2024.', 'on or before 2PM December 19.');
      expect(noYear).not.toBe(raw);
      const row = parseDouglasRfp(noYear, { now: CAPTURED, includeClosed: true }).find((b) => b.sourceId === GENERATOR)!;
      expect(row.dueAt).toBe('2024-12-19T22:00:00.000Z'); // 2 PM PST, not the cell's 5 PM default
    });

    it('a date without a time in the ad is not a due time: closed from that day on, like the county', () => {
      // The Fairground ad with its "2PM" taken out (in memory): the 5 PM in dueAt is our default, not the ad's word.
      const dateOnly = raw.replace('</strong>2PM Thursday August 25, 2022', '</strong>Thursday August 25, 2022');
      expect(dateOnly).not.toBe(raw);
      const row = parseDouglasRfp(dateOnly, { now: CAPTURED, includeClosed: true }).find((b) => b.sourceId === LIGHTING)!;
      expect(row.dueAt).toBe('2022-08-26T00:00:00.000Z'); // Aug 25, 5 PM PDT
      expect(openIds('2022-08-25T06:59:59Z', dateOnly)).toContain(LIGHTING); // Aug 24, 11:59 PM PDT
      expect(openIds('2022-08-25T07:00:00Z', dateOnly)).not.toContain(LIGHTING); // the due day itself, long before 5 PM

      // The ad's date, not the cell's: Dangberg Home Ranch without its "2:00 pm on" (in memory); cell 2024/06/21.
      const otherDay = raw.replace('on or before 2:00 pm on Thursday June 6', 'on or before Thursday June 6');
      expect(otherDay).not.toBe(raw);
      expect(openIds('2024-06-06T06:59:59Z', otherDay)).toContain(DANGBERG); // June 5, 11:59 PM PDT
      expect(parseDouglasPage(otherDay, { now: new Date('2024-06-06T07:00:00Z') }).notes).toEqual([
        `${DANGBERG}: closed, the ad says bids were due 2024-06-07T00:00:00.000Z (date only in the ad, 5 PM assumed); the county's page still shows it open (deadline cell: 2024/06/21)`,
      ]);
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

describe('NGEM / IonWave (raw server HTML)', () => {
  const [p1, p2, p3] = [fx('ngem-page1.html'), fx('ngem-page2.html'), fx('ngem-page3.html')];
  const errorPage = fx('ngem-error.html');
  const pages = [p1, p2, p3].map((html) => parseNgemPage(html));
  const all = pages.flatMap((p) => p.bids);
  const byId = (id: string) => all.find((b) => b.sourceId === id)!;

  it('parses every row of all three pages', () => {
    expect(pages.map((p) => p.bids.length)).toEqual([20, 20, 6]);
    expect(pages.map((p) => p.rows)).toEqual([20, 20, 6]);
    expect(pages.every((p) => p.tableFound && !p.errorPage)).toBe(true);
    expect(new Set(all.map((b) => b.sourceId)).size).toBe(46);
    expect(all.every((b) => b.title && b.agency && b.category && b.postedAt && b.dueAt)).toBe(true);
    expect(all[0]!.sourceId).toBe('las-vegas-clark-county-library-district:27-02'); // sorted by close date
    expect(all[45]!.sourceId).toBe('city-of-henderson:rfq-172-20-professional-services');
  });

  it('reads the fields of a row', () => {
    expect(byId('carson-city-nevada:27300240')).toMatchObject({
      source: 'ngem',
      sourceName: 'NGEM (local agencies)',
      title: 'Carson River Trail System Phase IV Riverview Trailhead',
      agency: 'Carson City, Nevada',
      category: 'BID',
      description: 'BID · 27300240',
      location: { state: 'NV' },
      postedAt: '2026-11-03T16:00:00.000Z', // 11/3/2026, no time on the board → 8 AM PST
      dueAt: '2026-12-03T22:00:00.000Z', // 12/3/2026 02:00:00 PM (PT)
      url: NGEM_URL, // rows open by JavaScript, so the card links to the board
      flags: [],
    });
  });

  it('undoes the board\'s double escaping in a title (the raw page says "Portal &amp;amp; AMI")', () => {
    expect(p2).toContain('Customer Portal &amp;amp; AMI Technology');
    expect(byId('city-of-north-las-vegas:rfp-2026-024').title).toBe('Customer Portal & AMI Technology');
    expect(all.filter((b) => /&(amp|lt|gt|quot|#39);/.test(`${b.title} ${b.agency}`))).toEqual([]);
  });

  it('makes addenda keep the same id and flags them', () => {
    // The board shows the number as "607998-26 Addendum 1".
    expect(byId('clark-county-nevada:607998-26')).toMatchObject({
      title: 'Fire Station 71 Bunkerville Emergency Generator Connection',
      description: 'Clark County BID · 607998-26 Addendum 1',
      flags: ['Addendum 1 posted'],
      dueAt: '2026-12-03T22:15:00.000Z',
    });
  });

  it('falls back to the bid number when the title is blank', () => {
    expect(byId('clark-county-nevada:request-for-quotation-10272026sitstand').title).toBe('Request for Quotation 10272026SITSTAND');
  });

  it('converts Pacific wall-clock times to UTC', () => {
    expect(byId('las-vegas-clark-county-library-district:27-02').dueAt).toBe('2026-11-13T22:00:00.000Z'); // 02:00 PM PST
    expect(byId('clark-county-department-of-aviation:request-for-quote-fy27-0053').dueAt).toBe('2026-11-19T07:59:00.000Z'); // 11/18 11:59 PM PST → next day
    expect(byId('city-of-henderson:rfq-172-20-professional-services').dueAt).toBe('2027-07-01T00:00:00.000Z'); // 6/30/2027 05:00 PM PDT
  });

  it('names the columns from the raw header, not from fixed positions', () => {
    expect(pages.every((p) => p.guessedColumns.length === 0)).toBe(true);

    // Move "Organization" to the front, in both header rows and every data row: nothing may change.
    const moved = edit(p1, ($) => {
      $(`${NGEM_GRID} thead tr, ${NGEM_GRID} tbody tr`).each((_, tr) => {
        $(tr).prepend($(tr).children().eq(4));
      });
    });
    expect(moved).not.toBe(p1);
    expect(parseNgemPage(moved).bids).toEqual(pages[0]!.bids);

    // Either clue alone is enough: the sort field in the link's onclick, or the visible label.
    const bySortField = parseNgemPage(edit(moved, ($) => $(`${NGEM_GRID} thead th a`).text('?')));
    const byLabel = parseNgemPage(edit(moved, ($) => $(`${NGEM_GRID} thead th a`).removeAttr('onclick')));
    for (const page of [bySortField, byLabel]) {
      expect(page.guessedColumns).toEqual([]);
      expect(page.bids).toEqual(pages[0]!.bids);
    }
  });

  it('falls back to the usual positions when the header names nothing, and reports it', () => {
    const page = parseNgemPage(edit(p1, ($) => $(`${NGEM_GRID} thead th`).empty()));
    expect(page.guessedColumns).toEqual(['colBidNumber', 'colTitle', 'colTypeTitle', 'colWorkGroupName', 'colOpenDate', 'colCloseDate']);
    expect(page.bids).toEqual(pages[0]!.bids);
  });

  it('still reads a page saved from a browser: columns named by aria-label, pager without postback links', () => {
    // Same rows; only the header and pager are reshaped the way page JavaScript leaves them. Labels hidden
    // so that aria-label is the one clue left.
    const saved = edit(browserSavedNgem(p1), ($) => $(`${NGEM_GRID} thead th a`).text('?'));
    const page = parseNgemPage(saved);
    expect(page.guessedColumns).toEqual([]);
    expect(page.bids).toEqual(pages[0]!.bids);
    expect(page.pager).toEqual({ current: 1, totalPages: 3, totalItems: 46, targets: {} });
  });

  it('reads the pager: current page, totals and the postback target of each page link', () => {
    // The raw pager has no plain-GET links at all, only __doPostBack targets (why the first live scan read 1 page of 3).
    const targets = { 1: ngemTarget(1), 2: ngemTarget(2), 3: ngemTarget(3) };
    expect(parseNgemPager(p1)).toEqual({ current: 1, totalPages: 3, totalItems: 46, targets });
    expect(parseNgemPager(p2)).toEqual({ current: 2, totalPages: 3, totalItems: 46, targets });
    expect(parseNgemPager(p3)).toEqual({ current: 3, totalPages: 3, totalItems: 46, targets });
    expect(pages.map((p) => p.pager.current)).toEqual([1, 2, 3]);
    expect([p1, p2, p3].some((html) => html.includes('rgBidListChangePage='))).toBe(false);
  });

  it('builds the postback body from the hidden fields of the form', () => {
    const body = new URLSearchParams(buildNgemPostback(p1, ngemTarget(2))!);
    expect([...body.keys()]).toEqual([
      'ctl00_ScriptManager_TSM',
      '__VIEWSTATE',
      '__VIEWSTATEGENERATOR',
      '__VIEWSTATEENCRYPTED',
      'ctl00_mainContent_rtb_ClientState',
      'ctl00_mainContent_rgBidList_ctl00_ctl03_ctl01_PageSizeComboBox_ClientState',
      'ctl00_mainContent_rgBidList_rfltMenu_ClientState',
      'ctl00_mainContent_rgBidList_ClientState',
      '__EVENTTARGET',
      '__EVENTARGUMENT',
    ]);
    expect(body.get('__VIEWSTATE')).toBe('TRIMMED'); // about 66 KB on the live page; neutralized in the fixture
    expect(body.get('__VIEWSTATEGENERATOR')).toBe('A4E5206D');
    expect(body.get('__EVENTTARGET')).toBe(ngemTarget(2));
    expect(body.get('__EVENTARGUMENT')).toBe('');
  });

  it('form-encodes the body', () => {
    const body = buildNgemPostback(p1.replace('value="TRIMMED"', 'value="a+b/c=="'), ngemTarget(3))!;
    expect(body).toContain('__VIEWSTATE=a%2Bb%2Fc%3D%3D&');
    expect(body).toContain('__EVENTTARGET=ctl00%24mainContent%24rgBidList%24ctl00%24ctl03%24ctl01%24ctl07&__EVENTARGUMENT=');
  });

  it('recognises the error page (it arrives with HTTP 200)', () => {
    expect(isNgemErrorPage(errorPage)).toBe(true);
    expect([p1, p2, p3].some((html) => isNgemErrorPage(html))).toBe(false);
    expect(parseNgemPage(errorPage)).toMatchObject({ errorPage: true, tableFound: false, rows: 0, bids: [] });
    expect(buildNgemPostback('<html><body>no form here</body></html>', ngemTarget(2))).toBeNull();
  });
});

describe('NevadaEPro (raw server HTML)', () => {
  // Cells are bare (<td role="gridcell">Department of Wildlife</td>); only <thead> names the columns.
  const raw = fx('nevadaepro-open-bids.html');
  const page = parseNevadaEproPage(raw);
  const bids = page.bids;
  const byId = (id: string) => bids.find((b) => b.sourceId === id)!;

  /** The page as a browser's "save as" leaves it: page JavaScript has copied each header label into its cells. */
  const browserSaved = (html: string) =>
    edit(html, ($) => {
      const labels = $('thead th').toArray().map((th) => $(th).find('span.ui-column-title').text());
      $('tbody tr').each((_, tr) => {
        $(tr).children('td').each((i, td) => {
          $(td).prepend($('<span class="ui-column-title"></span>').text(labels[i]!));
        });
      });
    });

  it('parses every row of the first page', () => {
    expect(page).toMatchObject({ tableFound: true, rows: 25, total: 29 });
    expect(bids).toHaveLength(25);
    expect(new Set(bids.map((b) => b.sourceId)).size).toBe(25);
    expect(bids[0]!.sourceId).toBe('72DOW-S4085'); // newest first
    expect(bids[24]!.sourceId).toBe('41NHA-S4031');
    expect(bids.every((b) => b.title && b.agency && b.dueAt)).toBe(true);
    expect(parseNevadaEproOpenBids(raw)).toEqual(bids);
  });

  it('maps cells by label: bare cells take the header at the same position', () => {
    const gen = bids.find((b) => b.title === 'Generator')!;
    expect(gen).toMatchObject({
      source: 'nevadaepro',
      sourceId: '55AGR-S4066',
      agency: 'Department of Agriculture',
      description: 'Buyer: Christian Armas · Bid 55AGR-S4066',
      dueAt: '2026-11-25T01:00:00.000Z', // 11/24/2026 5:00 PM PST
      location: { state: 'NV' },
      flags: ['May be supply-only'],
    });
    // "Alternate Id" is the last column; most rows leave it empty.
    expect(byId('80DOT-S4076')).toMatchObject({
      title: '35 TON DETACHABLE GOOSENECK TRAILER',
      agency: 'Department of Transportation',
      description: 'Buyer: Heather Moon · Alt ID NDEQ027423 · Bid 80DOT-S4076',
    });
    expect(bids[0]!.title).toBe('Roof Decking for Habitat Structures'); // double space on the board
  });

  it('converts Pacific wall-clock due times to UTC', () => {
    expect(byId('80DOT-S4076').dueAt).toBe('2026-12-02T20:00:00.000Z'); // 12/02/2026 12:00 PM PST
    expect(byId('43ADG-S4069').dueAt).toBe('2026-12-05T00:59:00.000Z'); // 12/04/2026 4:59 PM PST → next day in UTC
    expect(byId('65DPS-S4063').dueAt).toBe('2026-12-02T17:00:00.000Z'); // 12/02/2026 9:00 AM PST
  });

  it('makes the relative detail link absolute', () => {
    expect(byId('55AGR-S4066').url).toBe('https://nevadaepro.com/bso/external/bidDetail.sda?docId=55AGR-S4066&external=true&parentUrl=close');
    expect(bids.every((b) => b.url === `https://nevadaepro.com/bso/external/bidDetail.sda?docId=${b.sourceId}&external=true&parentUrl=close`)).toBe(true);
    // Another page URL proves the link is read from the row: the built-in fallback always says nevadaepro.com.
    expect(parseNevadaEproOpenBids(raw, 'https://example.test/a/b.xhtml')[0]!.url).toBe(
      'https://example.test/bso/external/bidDetail.sda?docId=72DOW-S4085&external=true&parentUrl=close',
    );
  });

  it('ignores the hidden duplicate columns', () => {
    // Scramble only the hidden cells (in memory): nothing may change, in either shape.
    const scrambled = raw.replace(/(<td role="gridcell" style="display:none">)[^<]*/g, '$1HIDDEN');
    expect(scrambled).not.toBe(raw);
    expect(parseNevadaEproOpenBids(scrambled)).toEqual(bids);
    expect(parseNevadaEproOpenBids(browserSaved(scrambled))).toEqual(bids); // there the hidden cells carry a label too
  });

  it('survives reordered columns', () => {
    // Move the last column (Alternate Id) to the front, in the header and in every row.
    const $ = cheerio.load(raw);
    $('thead tr, tbody tr').each((_, tr) => {
      $(tr).prepend($(tr).children().last());
    });
    expect($('thead th').first().text()).toBe('Alternate Id');
    expect(parseNevadaEproOpenBids($.html())).toEqual(bids);
  });

  it('takes header labels from aria-label when the title span is missing', () => {
    expect(parseNevadaEproOpenBids(edit(raw, ($) => $('thead span.ui-column-title').remove()))).toEqual(bids);
  });

  it('still reads a page saved from a browser: label inside each cell, no header needed', () => {
    const saved = edit(browserSaved(raw), ($) => $('thead').remove());
    expect(saved).toContain('<span class="ui-column-title">Organization Name</span>Department of Wildlife');
    expect(parseNevadaEproOpenBids(saved)).toEqual(bids);
  });

  describe('announced total', () => {
    it('reads the paginator text ("1-25 of 29")', () => {
      expect(parseNevadaEproTotal(raw)).toBe(29);
    });

    it('falls back to the widget config (rowCount:29)', () => {
      expect(parseNevadaEproTotal(edit(raw, ($) => $('.ui-paginator-current').remove()))).toBe(29);
    });

    it('is null when the page does not say', () => {
      const silent = edit(raw, ($) => $('.ui-paginator-current, script').remove());
      expect(parseNevadaEproTotal(silent)).toBeNull();
      expect(parseNevadaEproOpenBids(silent)).toHaveLength(25); // the rows are still read
    });
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
  it('maps a real response (CA electrical query, captured 2026-11-13)', () => {
    const bids = parseSamResponse(JSON.parse(fx('samgov-ca-238210.json')));
    expect(bids.map((b) => b.sourceId)).toEqual(['N6247324R2610', 'N6247327R0014', '36C26127Q0067', 'N6600126Q6298', 'W9123826RA002']);
    expect(bids[2]).toEqual({
      source: 'samgov',
      sourceId: '36C26127Q0067',
      sourceName: 'SAM.gov (federal)',
      title: 'J061--Triennial Circuit Breaker and Feeder Testing',
      agency: 'Veterans Affairs, Department of · 261-network Contract Office 21 (36c261)', // prettyAgency's title case
      description: 'Solicitation · Service-Disabled Veteran-Owned Small Business (SDVOSB) Set-Aside (FAR 19.14) · Sol. 36C26127Q0067',
      category: 'Solicitation',
      location: { city: 'Reno', state: 'NV', zip: '89502', label: null },
      postedAt: '2026-11-06T16:00:00.000Z',
      dueAt: '2026-11-20T20:00:00.000Z',
      estValue: null,
      naics: '238210',
      psc: 'J061', // the notice's classificationCode (src/sources/psc.ts)
      setAside: 'SDVOSBC',
      url: 'https://sam.gov/workspace/contract/opp/0219242e57b54ac1bf223aaa8c9edc6c/view', // SAM's own uiLink
      flags: [],
      solNumber: '36C26127Q0067',
    });
  });

  it('reads all three real responses (NV, CA 238210, CA 236220) without losing a notice', () => {
    const files = ['samgov-nv.json', 'samgov-ca-238210.json', 'samgov-ca-236220.json'];
    const notices = files.flatMap((f) => (JSON.parse(fx(f)) as SamResponse).opportunitiesData ?? []);
    const bids = files.flatMap((f) => parseSamResponse(JSON.parse(fx(f))));
    expect(notices).toHaveLength(32);
    // 32 notices, 26 jobs: 3 + 3 + 2 + 2 notices of the same solicitation are one card each.
    expect(bids).toHaveLength(26);
    expect(new Set(bids.map((b) => b.sourceId)).size).toBe(26);
    for (const b of bids) {
      expect(b.url).toMatch(/^https:\/\/sam\.gov\/(?:workspace\/contract\/)?opp\/[0-9a-f]{32}\/view$/);
      expect(b.location?.zip ?? null).not.toBe(''); // SAM's "" is no ZIP
      expect(b.location?.city ?? null).not.toBe('0'); // nor is its city "0"
    }
  });
});

describe('fixture mode (npm run scan -- --fixtures)', () => {
  it('reads the captured pages as of the capture day, whatever the real date is', async () => {
    // Both clocks long after every deadline, the scan's (ctx.now) and the machine's (new Date()):
    // the saved Douglas page must still give its open row.
    const later = new Date('2030-01-01T20:00:00Z');
    const { ctx } = fakeCtx('', later);
    vi.useFakeTimers({ toFake: ['Date'], now: later });
    try {
      expect(new Date().getUTCFullYear()).toBe(2030);
      const counts: Record<string, number> = {};
      for (const source of fixtureSources(FIXTURE_DIR)) counts[source.id] = (await source.fetch(ctx)).length;
      expect(counts).toEqual({ douglascounty: 1, questcdn: 13, ngem: 46, nevadaepro: 25 }); // no synthetic SAM.gov data
    } finally {
      vi.useRealTimers();
    }
  });
});
