/**
 * The response headers every answer of the app carries (src/server.ts SECURITY_HEADERS + CONTENT_SECURITY_POLICY),
 * through BOTH shell file servers (@fastify/static here, src/static.ts on Vercel), in accounts and single mode; and
 * the pages stay free of the inline code that policy forbids. Audit hdr-csp-1, hdr-frame-1, hdr-misc-1, hdr-cache-1,
 * sec-session-5. Everything here is synthetic.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { loadConfig } from '../src/context.js';
import { loadProfile } from '../src/profiles.js';
import { buildServer, CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from '../src/server.js';
import { accountsConfig, memoryDb } from './helpers.js';

const web = (name: string) => readFileSync(fileURLToPath(new URL(`../web/${name}`, import.meta.url)), 'utf8');

let db: Db;
const apps: FastifyInstance[] = [];
beforeAll(async () => { db = await memoryDb(); });
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await db.close();
});

const expectSecurityHeaders = (res: LightMyRequestResponse, what: string) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers[name], `${what}: ${name}`).toBe(value);
};

describe.each([
  ['@fastify/static', false],
  ['src/static.ts (Vercel)', true],
] as const)('every response carries the security headers: %s', (_name, plainStatic) => {
  describe.each(['accounts', 'single'] as const)('%s mode', (mode) => {
    let app: FastifyInstance;
    beforeAll(async () => {
      app = mode === 'accounts'
        ? await buildServer({ db }, { config: accountsConfig(), plainStatic })
        : await buildServer({ db, profile: loadProfile('lm-electric') }, { config: loadConfig({}), accessCode: 'TEST-access-code-0123456789', plainStatic });
      apps.push(app);
    });

    it('the shell, a static js file, an API 200, an API 401 and two 404s', async () => {
      const shell = await app.inject('/');
      expect(shell.statusCode).toBe(200);
      expectSecurityHeaders(shell, 'shell');
      // The shell keeps its own caching (no-cache on Vercel's file server, the plugin's own value here).
      expect(shell.headers['cache-control']).toBe(plainStatic ? 'no-cache' : 'public, max-age=0');

      const js = await app.inject('/js/main.js');
      expect(js.statusCode).toBe(200);
      expectSecurityHeaders(js, 'js');
      expect(js.headers['cache-control']).not.toBe('no-store');

      const health = await app.inject('/api/health');
      expect(health.statusCode).toBe(200);
      expectSecurityHeaders(health, 'API 200');
      expect(health.headers['cache-control']).toBe('no-store');

      const refused = await app.inject(mode === 'accounts' ? '/api/me' : '/api/feed?limit=1');
      expect(refused.statusCode).toBe(401);
      expectSecurityHeaders(refused, 'API 401');
      expect(refused.headers['cache-control']).toBe('no-store');

      for (const url of ['/TEST-no-such-file.js', '/api/TEST-no-such-route']) {
        const missing = await app.inject(url);
        expect(missing.statusCode, url).toBe(mode === 'single' && url.startsWith('/api/') ? 401 : 404);
        expectSecurityHeaders(missing, `404 ${url}`);
      }
    });
  });
});

describe('the policy itself', () => {
  it('has no unsafe-inline, no unsafe-eval, no hashes, and forbids framing', () => {
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-|sha256-|nonce-/);
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("style-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(SECURITY_HEADERS['x-frame-options']).toBe('DENY');
    expect(CONTENT_SECURITY_POLICY).not.toContain('upgrade-insecure-requests'); // it breaks http://127.0.0.1
  });

  it('a route that sets its own Cache-Control keeps it', async () => {
    const app = await buildServer({ db }, { config: accountsConfig() });
    apps.push(app);
    app.get('/api/TEST-own-cache', async (_req, reply) => reply.header('cache-control', 'private, max-age=5').send({ ok: true }));
    expect((await app.inject('/api/TEST-own-cache')).headers['cache-control']).toBe('private, max-age=5');
  });
});

describe('the pages carry no inline code the policy would block', () => {
  it.each(['index.html', 'privacy.html', 'terms.html'])('%s: no inline <script>, no <style>, no style= or on* attribute', (page) => {
    const html = web(page).replace(/<!--[\s\S]*?-->/g, '');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    if (page === 'index.html') expect(scripts).toHaveLength(2); // js/main.js and js/sw-register.js
    for (const [, attrs, body] of scripts) {
      expect(attrs, `${page}: a <script> needs src`).toMatch(/\bsrc=/);
      expect(body!.trim(), `${page}: a <script src> has a body`).toBe('');
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/<[a-z][^>]*\sstyle\s*=/i);
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
  });

  it('the moved files exist and are what the pages link', () => {
    expect(web('index.html')).toContain('<script src="js/sw-register.js" data-demo-strip></script>');
    expect(web('js/sw-register.js')).toContain("navigator.serviceWorker.register('sw.js')");
    expect(web('privacy.html')).toContain('<link rel="stylesheet" href="privacy.css" />');
    expect(web('terms.html')).toContain('<link rel="stylesheet" href="terms.css" />');
    expect(web('privacy.css')).toContain('.doc table');
    expect(web('terms.css')).toContain('.doc-brand svg');
  });
});
