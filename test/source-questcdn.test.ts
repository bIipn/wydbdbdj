/**
 * The QuestCDN boards: the one the scan reads (QUEST_BOARDS, the pilot's NV Public Works board) and the four the
 * parser reads but the scan never asks for (QUEST_BOARDS_OFF: www.questcdn.com/robots.txt says Disallow: /).
 * Each fixture is ONE raw browse_posting answer (curl -A "BidSwipe/0.1 (daily public-bid check)",
 * X-Requested-With + Referer as the scanner sends them), 2026-11-14 07:01 UTC, untrimmed: each of the four had
 * one open project. See questcdn.md.
 */
import { describe, expect, it } from 'vitest';
import {
  QUEST_BOARDS, QUEST_BOARDS_OFF, QUEST_OFF_REASON, checkQuestJson, fetchQuestBoards, parseQuestJson, questApiUrl,
  questZone, questcdnSource, type QuestBoard,
} from '../src/sources/questcdn.js';
import type { SourceContext } from '../src/types.js';
import { fx } from './helpers.js';

const EVERY_BOARD = [...QUEST_BOARDS, ...QUEST_BOARDS_OFF];
const board = (group: string): QuestBoard => EVERY_BOARD.find((b) => b.group === group)!;
const FIXTURE: Record<string, string> = {
  '1903611': 'questcdn-spwd.json',
  '8011805': 'questcdn-nvparks.json',
  '7484192': 'questcdn-lakecounty.json',
  '5618062': 'questcdn-campbell.json',
  '5645931': 'questcdn-glendora.json',
};
const parse = (group: string) => parseQuestJson(JSON.parse(fx(FIXTURE[group]!)), board(group));

describe('QuestCDN board list', () => {
  it('keeps the NV Public Works board first (fixture mode and older tests read QUEST_BOARDS[0])', () => {
    expect(QUEST_BOARDS[0]).toMatchObject({ group: '1903611', label: 'NV Public Works (QuestCDN)' });
  });
  it('the scan reads ONLY the pilot board: the four others are off (robots.txt) and say why', () => {
    expect(QUEST_BOARDS.map((b) => b.group)).toEqual(['1903611']);
    expect(QUEST_BOARDS_OFF.map((b) => b.group)).toEqual(['8011805', '7484192', '5618062', '5645931']);
    expect(QUEST_OFF_REASON).toMatch(/robots\.txt says Disallow: \//);
    expect(questcdnSource.states).toEqual(['NV']);
    for (const b of EVERY_BOARD) expect(FIXTURE[b.group], b.label).toBeDefined();
    expect(new Set(EVERY_BOARD.map((b) => b.group)).size).toBe(EVERY_BOARD.length);
  });
  it('the parser still reads the saved answers of the boards that are off (CA and NV rows)', () => {
    const states = new Set(Object.keys(FIXTURE).flatMap((g) => parse(g).map((b) => b.location?.state)));
    expect([...states].sort()).toEqual(['CA', 'NV']);
  });
});

describe('QuestCDN new boards (real JSON, 2026-11-14)', () => {
  it('Lake County, CA: the full title and owner come from the tooltips', () => {
    const [b, ...rest] = parse('7484192');
    expect(rest).toHaveLength(0);
    expect(b).toMatchObject({
      source: 'questcdn',
      sourceId: '7484192:10426128',
      sourceName: 'Lake County, CA (QuestCDN)',
      title: 'South Main Street and Soda Bay Rd Widening and Bike Lanes Project',
      agency: 'Lake County, CA',
      location: { city: 'Lakeport', county: 'Lake', state: 'CA' },
      postedAt: '2026-10-30T15:00:00.000Z', // 10/30/2026, no time → 8 AM PDT
      dueAt: '2026-11-30T23:00:00.000Z', // 11/30/2026 03:00 PM PST
      url: 'https://qcpi.questcdn.com/cdn/posting/?group=7484192&provider=7484192',
      description: 'Quest #10426128 · Design: Lake County, CA · Construction Project',
    });
    // The electrical lines the scorer must see are in the category text.
    expect(b!.category).toMatch(/Street Lighting|Traffic Control Signal Systems|Electrical/);
  });

  it('NV State Parks: a 2027 opening in PST, the county as the board gives it', () => {
    const [b] = parse('8011805');
    expect(b).toMatchObject({
      sourceId: '8011805:10421309',
      title: 'Spooner Meadows & North Canyon Restoration',
      agency: 'State of Nevada - Nevada Division of State Parks',
      location: { city: 'Incline Village', county: 'Douglas', state: 'NV' },
      dueAt: '2027-01-27T19:00:00.000Z', // 01/27/2027 11:00 AM PST
    });
  });

  it('Campbell and Glendora: one open project each', () => {
    expect(parse('5618062').map((b) => [b.title, b.location?.city, b.dueAt])).toEqual([
      ['Annual Accessibility Ramps FY24', 'Campbell', '2026-11-23T23:00:00.000Z'],
    ]);
    expect(parse('5645931').map((b) => [b.title, b.agency, b.location?.county, b.dueAt])).toEqual([
      ['Storm Drain Inlet Insert Installation', 'Glendora CA, City of', 'Los Angeles', '2026-11-19T18:00:00.000Z'],
    ]);
  });
});

describe('questZone', () => {
  const b = board('7484192');
  it('reads the zone the bid time names, else the board zone, else Pacific', () => {
    expect(questZone('11/30/2026 03:00 PM PST', b)).toBe('America/Los_Angeles');
    expect(questZone('11/30/2026 03:00 PM CST', b)).toBe('America/Chicago');
    expect(questZone('11/30/2026 03:00 PM MDT', b)).toBe('America/Denver');
    expect(questZone('11/30/2026 03:00 PM EST', b)).toBe('America/New_York');
    expect(questZone('11/30/2026 03:00 PM', { ...b, timeZone: 'America/Denver' })).toBe('America/Denver');
    expect(questZone(null, b)).toBe('America/Los_Angeles');
  });
  it('a Central board time lands on the Central instant', () => {
    const json = JSON.parse(fx('questcdn-campbell.json'));
    json.data[0].bid_date_str = '11/23/2026 03:00 PM CST'; // labelled variation of the real row
    expect(parseQuestJson(json, b)[0]!.dueAt).toBe('2026-11-23T21:00:00.000Z');
  });
});

describe('checkQuestJson', () => {
  const b = board('5618062');
  it('accepts the real answers, including an empty board', () => {
    for (const f of Object.values(FIXTURE)) expect(() => checkQuestJson(JSON.parse(fx(f)), b)).not.toThrow();
    expect(() => checkQuestJson({ draw: 1, recordsTotal: 0, recordsFiltered: 0, data: [], result: 'ok' }, b)).not.toThrow();
  });
  it('throws on an answer that is not the listing', () => {
    expect(() => checkQuestJson('<html>', b)).toThrow(/did not answer JSON/);
    expect(() => checkQuestJson({ result: 'error' }, b)).toThrow(/result=error/);
    expect(() => checkQuestJson({ result: 'ok' }, b)).toThrow(/no data array/);
    expect(() => checkQuestJson({ result: 'ok', recordsTotal: 3, data: [] }, b)).toThrow(/announces 3 but sent no rows/);
  });
});

describe('questcdnSource.fetch', () => {
  function ctx(answer: (group: string) => unknown) {
    const logs: string[] = [];
    const partial: string[] = [];
    const urls: string[] = [];
    const c = {
      http: {
        json: async (url: string) => {
          urls.push(url);
          const group = /group=(\d+)/.exec(url)![1]!;
          const a = answer(group);
          if (a instanceof Error) throw a;
          return a;
        },
      },
      now: new Date('2026-11-14T08:00:00Z'),
      env: () => undefined,
      log: (m: string) => logs.push(m),
      partial: (m: string) => partial.push(m),
    } as unknown as SourceContext;
    return { c, logs, partial, urls };
  }
  const real = (g: string) => JSON.parse(fx(FIXTURE[g]!));

  it("the scan asks ONE board: the pilot's, never a board that is off", async () => {
    const t = ctx(real);
    const bids = await questcdnSource.fetch(t.c);
    expect(t.urls).toEqual([questApiUrl(QUEST_BOARDS[0]!)]);
    expect(t.urls.join(' ')).not.toMatch(/8011805|7484192|5618062|5645931/);
    expect(bids).toHaveLength(13);
    expect(t.partial).toEqual([]);
  });

  it('the pilot board failing is a FAILED source, never a quiet 0', async () => {
    const t = ctx(() => '<!DOCTYPE html><html>challenge</html>');
    await expect(questcdnSource.fetch(t.c)).rejects.toThrow(/every QuestCDN board failed/);
  });

  // The many-board paths, on the saved answers only (no board that is off is ever requested by the scan).
  it('several boards: each read once, in order, all construction projects kept', async () => {
    const t = ctx(real);
    const bids = await fetchQuestBoards(t.c, EVERY_BOARD);
    expect(t.urls).toEqual(EVERY_BOARD.map((b) => questApiUrl(b)));
    expect(bids).toHaveLength(13 + 4);
    expect(t.partial).toEqual([]);
    expect(t.logs).toContain('questcdn Lake County, CA (QuestCDN): 1/1');
  });

  it('several boards: one failed board is reported and the others are kept', async () => {
    const t = ctx((g) => (g === '7484192' ? new Error('HTTP 503') : real(g)));
    const bids = await fetchQuestBoards(t.c, EVERY_BOARD);
    expect(bids).toHaveLength(16);
    expect(t.partial).toEqual(['questcdn: 1 of 5 boards failed: Lake County, CA (QuestCDN) (group 7484192): HTTP 503']);
  });
});
