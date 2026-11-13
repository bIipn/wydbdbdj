import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * server.js is the serverless host's entry. The host ships only files it can trace from there, so
 * every data file the app reads from disk at runtime has to be named in it. A prevailing-wage table
 * added to config/ without a line in server.js would be missing in production only: this test is
 * the reminder.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const entry = readFileSync(`${root}server.js`, 'utf8');

describe('serverless entry (server.js)', () => {
  it('names every prevailing-wage table', () => {
    const tables = readdirSync(`${root}config/prevailing-wage`).filter((f) => f.endsWith('.json'));
    expect(tables.length).toBeGreaterThan(0);
    for (const f of tables) expect(entry).toContain(`./config/prevailing-wage/${f}`);
  });

  it('names the ZIP table package and hands over to the compiled server', () => {
    expect(entry).toContain("import('zipcodes')");
    expect(entry).toContain("import './dist/server.js'");
    expect(entry).toContain("import 'fastify'");
  });

  it('the scheduled jobs in vercel.json point at routes that exist', () => {
    const config = JSON.parse(readFileSync(`${root}vercel.json`, 'utf8')) as { crons: { path: string; schedule: string }[] };
    const routes = readFileSync(`${root}src/routes/cron.ts`, 'utf8');
    expect(config.crons.length).toBeGreaterThan(0);
    for (const c of config.crons) {
      expect(routes).toContain(`'${c.path}'`);
      expect(c.schedule.split(' ')).toHaveLength(5);
    }
  });
});
