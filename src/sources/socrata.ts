import type { SourceContext } from '../types.js';
import { outOfTime, stopAtBudget } from './budget.js';

/**
 * Socrata open-data reads ("https://<host>/resource/<dataset id>.json", SoQL in the query string), for the
 * city and federal datasets: LA RAMP (data.lacity.org hf3r-utnq), SF (data.sfgov.org eshn-8t3a), NYC City
 * Record (data.cityofnewyork.us dg92-zbpx), USAC E-Rate Form 470 (opendata.usac.org jt8s-3q52).
 *
 * No app token: Socrata throttles anonymous callers by IP, which one read a day per dataset never comes near.
 * Pages of `$limit` rows are read with `$offset` until a page comes back short; `maxPages` is a hard stop so a
 * runaway filter can never read a whole dataset. Always give `$order` with a unique column (or `:id`): without a
 * stable order Socrata may repeat or skip rows between pages.
 */
export interface SocrataQuery {
  /** e.g. 'data.lacity.org' (no scheme, no path). */
  host: string;
  /** e.g. 'hf3r-utnq'. */
  dataset: string;
  /** SoQL $where, e.g. "stagename = 'Open'". */
  where?: string;
  /** SoQL $order. Default ':id' (Socrata's row id: stable across pages). */
  order?: string;
  /** SoQL $select, when only some columns are needed. */
  select?: string;
  /** Rows per page (default 1000; Socrata allows up to 50,000 on v2.1 endpoints). */
  pageSize?: number;
  /** Hard stop (default 20 pages). Reaching it with a full last page is logged: there may be more rows. */
  maxPages?: number;
}

export interface SocrataResult<T> {
  rows: T[];
  /** Pages requested. */
  pages: number;
  /** True when the read stopped early (page cap or time budget) with a full last page: there may be more. */
  truncated: boolean;
}

/** The request URL of one page. Exported for the tests and the scan log. */
export function socrataUrl(q: SocrataQuery, offset: number): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  p.set('$order', q.order ?? ':id');
  p.set('$limit', String(q.pageSize ?? 1000));
  p.set('$offset', String(offset));
  return `https://${q.host}/resource/${encodeURIComponent(q.dataset)}.json?${p.toString()}`;
}

/**
 * Read every matching row (up to the page cap and ctx.deadline). Throws when an answer is not a JSON array
 * (an error object such as {"error":true,"message":…}, an HTML page): the scan then reports FAILED, never 0.
 * `id` names the source in log lines ("laramp: stopped at the time budget, 2000 of ? read").
 */
export async function readSocrata<T = Record<string, unknown>>(
  ctx: Pick<SourceContext, 'http' | 'log' | 'deadline' | 'partial'>, id: string, q: SocrataQuery,
): Promise<SocrataResult<T>> {
  const size = q.pageSize ?? 1000;
  const cap = q.maxPages ?? 20;
  if (!Number.isInteger(size) || size < 1) throw new Error(`${id}: page size must be a positive whole number`);
  const rows: T[] = [];
  for (let page = 0; ; page++) {
    if (page >= cap) {
      ctx.log(`${id}: stopped at the page cap (${cap} pages of ${size}), ${rows.length} rows read — there may be more`);
      ctx.partial?.(`${id}: stopped at the page cap, ${rows.length} rows read`);
      return { rows, pages: page, truncated: true };
    }
    if (page > 0 && outOfTime(ctx)) {
      stopAtBudget(ctx, id, rows.length, null, 'rows');
      return { rows, pages: page, truncated: true };
    }
    const answer: unknown = await ctx.http.json(socrataUrl(q, page * size));
    if (!Array.isArray(answer)) {
      const message = answer && typeof answer === 'object' && 'message' in answer ? String((answer as { message: unknown }).message) : typeof answer;
      throw new Error(`${id}: expected a JSON array from ${q.host}/resource/${q.dataset}.json, got ${message.slice(0, 120)}`);
    }
    rows.push(...(answer as T[]));
    if (answer.length < size) return { rows, pages: page + 1, truncated: false };
  }
}
