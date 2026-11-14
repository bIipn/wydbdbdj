import { describe, expect, it } from 'vitest';
import { readSocrata, socrataUrl, type SocrataQuery } from '../src/sources/socrata.js';
import type { SourceContext } from '../src/types.js';

// readSocrata through a fake http: which URLs it asks for, when it stops, and what it refuses.
// The rows are synthetic ({ n: TEST-… }): what is tested is the paging, not a dataset.

const Q: SocrataQuery = { host: 'data.example.test', dataset: 'abcd-1234', where: "stagename = 'Open'", order: 'rampid', pageSize: 3 };

function fakeCtx(pages: unknown[], deadline?: Date) {
  const urls: string[] = [];
  const logs: string[] = [];
  const partial: string[] = [];
  const ctx: Pick<SourceContext, 'http' | 'log' | 'deadline' | 'partial'> = {
    http: {
      text: async () => { throw new Error('text() not expected'); },
      json: async <T>(url: string) => {
        urls.push(url);
        if (urls.length > pages.length) throw new Error(`TEST: no page ${urls.length}`);
        return pages[urls.length - 1] as T;
      },
    },
    log: (m) => logs.push(m),
    partial: (m) => partial.push(m),
    ...(deadline ? { deadline } : {}),
  };
  return { ctx, urls, logs, partial };
}

const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ n: `TEST-${from + i}` }));

describe('socrataUrl', () => {
  it('puts the SoQL in the query string, with a stable order by default', () => {
    const u = new URL(socrataUrl(Q, 6));
    expect(`${u.origin}${u.pathname}`).toBe('https://data.example.test/resource/abcd-1234.json');
    expect(Object.fromEntries(u.searchParams)).toEqual({ $where: "stagename = 'Open'", $order: 'rampid', $limit: '3', $offset: '6' });
    expect(new URL(socrataUrl({ host: 'h.test', dataset: 'x-y' }, 0)).searchParams.get('$order')).toBe(':id');
    expect(new URL(socrataUrl({ host: 'h.test', dataset: 'x-y' }, 0)).searchParams.get('$limit')).toBe('1000');
  });
});

describe('readSocrata', () => {
  it('pages with $offset until a short page', async () => {
    const { ctx, urls, logs } = fakeCtx([rows(0, 3), rows(3, 3), rows(6, 1)]);
    const got = await readSocrata<{ n: string }>(ctx, 'laramp', Q);
    expect(got).toMatchObject({ pages: 3, truncated: false });
    expect(got.rows.map((r) => r.n)).toEqual(rows(0, 7).map((r) => r.n));
    expect(urls.map((u) => new URL(u).searchParams.get('$offset'))).toEqual(['0', '3', '6']);
    expect(logs).toEqual([]);
  });

  it('an empty page ends the read (a full page exactly at the end costs one more request)', async () => {
    const { ctx, urls } = fakeCtx([rows(0, 3), []]);
    expect((await readSocrata(ctx, 'sfbids', Q)).rows).toHaveLength(3);
    expect(urls).toHaveLength(2);
  });

  it('stops at the page cap and says there may be more', async () => {
    const { ctx, urls, logs, partial } = fakeCtx([rows(0, 3), rows(3, 3), rows(6, 3)]);
    const got = await readSocrata(ctx, 'nycrecord', { ...Q, maxPages: 2 });
    expect(got).toMatchObject({ pages: 2, truncated: true });
    expect(got.rows).toHaveLength(6);
    expect(urls).toHaveLength(2);
    expect(logs).toEqual(['nycrecord: stopped at the page cap (2 pages of 3), 6 rows read — there may be more']);
    expect(partial).toEqual(['nycrecord: stopped at the page cap, 6 rows read']);
  });

  it('stops at the time budget after the first page, never before it', async () => {
    const { ctx, urls, logs, partial } = fakeCtx([rows(0, 3), rows(3, 3)], new Date(Date.now() - 1));
    const got = await readSocrata(ctx, 'usac470', Q);
    expect(urls).toHaveLength(1);
    expect(got).toMatchObject({ pages: 1, truncated: true });
    expect(logs).toEqual(['usac470: stopped at the time budget, 3 of ? rows read']);
    expect(partial).toEqual(logs);
  });

  it('throws on an answer that is not an array (Socrata error object, HTML)', async () => {
    const err = { error: true, message: 'Unrecognized arguments [$wher]' };
    await expect(readSocrata(fakeCtx([err]).ctx, 'laramp', Q)).rejects.toThrow(
      'laramp: expected a JSON array from data.example.test/resource/abcd-1234.json, got Unrecognized arguments [$wher]',
    );
    await expect(readSocrata(fakeCtx(['<html>']).ctx, 'laramp', Q)).rejects.toThrow('got string');
    await expect(readSocrata(fakeCtx([rows(0, 3), null]).ctx, 'laramp', Q)).rejects.toThrow('got object');
  });

  it('refuses a page size that is not a positive whole number', async () => {
    await expect(readSocrata(fakeCtx([]).ctx, 'laramp', { ...Q, pageSize: 0 })).rejects.toThrow('page size');
  });
});
