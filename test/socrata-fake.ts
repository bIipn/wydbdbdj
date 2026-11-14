import type { SourceContext } from '../src/types.js';

/**
 * A SourceContext whose http.json answers Socrata pages from a list (the source tests' fake network). Records the URLs
 * asked for and the log lines. Shared by test/source-laramp, -sfbids, -nycrecord and -usac470.test.ts.
 */
export function socrataCtx(pages: unknown[], now: Date): { ctx: SourceContext; urls: string[]; logs: string[] } {
  const urls: string[] = [];
  const logs: string[] = [];
  const ctx: SourceContext = {
    http: {
      text: async () => { throw new Error('text() not expected'); },
      json: async <T>(url: string) => {
        urls.push(url);
        if (urls.length > pages.length) throw new Error(`TEST: no page ${urls.length}`);
        return pages[urls.length - 1] as T;
      },
    },
    now,
    env: () => undefined,
    log: (m) => logs.push(m),
  };
  return { ctx, urls, logs };
}
