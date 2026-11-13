import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/db.js';
import { loadProfile } from '../src/profiles.js';
import { buildServer } from '../src/server.js';
import { memoryDb } from './helpers.js';

/** The built-in file server used where @fastify/static cannot load (src/static.ts). */
let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  db = await memoryDb();
  app = await buildServer({ db, profile: loadProfile('lm-electric') }, { plainStatic: true });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe('plain static file server', () => {
  it('serves the app shell with the right types', async () => {
    const index = await app.inject('/');
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.body).toContain('<title>');
    expect((await app.inject('/index.html')).body).toBe(index.body);

    const js = await app.inject('/js/main.js');
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect((await app.inject('/styles.css')).headers['content-type']).toBe('text/css; charset=utf-8');
    expect((await app.inject('/manifest.webmanifest')).headers['content-type']).toBe('application/manifest+json; charset=utf-8');
    expect((await app.inject('/js/main.js?v=2')).statusCode).toBe(200);
  });

  it('serves nothing outside the shell folder', async () => {
    const tries = [
      '/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/js/../../package.json', '/js/..%2f..%2fpackage.json',
      '/..\\package.json', '//etc/passwd', '/%00', '/js/%E0%A4%A', '/.env', '/js/', '/js', '/nope.js',
    ];
    for (const url of tries) {
      const res = await app.inject(url);
      expect([400, 404], url).toContain(res.statusCode); // 400: the router rejects a malformed escape itself
      expect(res.body, url).not.toContain('"name": "bidswipe"');
    }
  });

  it('leaves the API alone', async () => {
    expect((await app.inject('/api/health')).json()).toMatchObject({ ok: true });
    const unknown = await app.inject('/api/does-not-exist');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'not_found' });
  });
});
