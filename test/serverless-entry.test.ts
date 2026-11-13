import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * server.js is the serverless host's entry. The host ships only files it can trace from there, so
 * every folder the app reads from disk at runtime has to be named in serverless-files.cjs. A new
 * sub-folder under web/ or config/ without a line there would be missing in production only: this
 * test is the reminder.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const entry = readFileSync(`${root}server.js`, 'utf8');

describe('serverless entry (server.js)', () => {
  const folders = readFileSync(`${root}serverless-files.cjs`, 'utf8');

  it('ships the app shell and the config folders, every sub-folder named', () => {
    expect(entry).toContain("import './serverless-files.cjs'");
    // The host's tracer takes one folder per readdirSync line, not its sub-folders: each needs its own.
    const dirsOf = (dir: string, rel: string[]): string[][] =>
      readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .flatMap((d) => [[...rel, d.name], ...dirsOf(`${dir}/${d.name}`, [...rel, d.name])]);
    for (const top of ['web', 'config']) {
      for (const parts of [[top], ...dirsOf(`${root}${top}`, [top])]) {
        const line = `path.join(__dirname, ${parts.map((p) => `'${p}'`).join(', ')})`;
        expect(folders, `serverless-files.cjs is missing ${parts.join('/')}`).toContain(line);
      }
    }
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
