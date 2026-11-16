import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadProfile } from '../src/profiles.js';
import { buildServer } from '../src/server.js';
import type { Db } from '../src/db/db.js';
import { accountsConfig, memoryDb } from './helpers.js';

/**
 * docs/api/openapi.yaml is what the HawkScan security scan reads to know the API (stackhawk.yml, openApiConf).
 * A route the spec leaves out is never tested; a path the spec names that the server does not have is a 404 on
 * every request. This test keeps the two equal: it records every route the real server registers (Fastify's
 * onRoute hook, added to each app the moment it is created) and compares that set with the spec, both ways,
 * in accounts mode and in single mode.
 */
const seen = vi.hoisted(() => ({ routes: [] as Array<{ method: string; url: string }>, on: false }));

vi.mock('fastify', async (importOriginal) => {
  const mod = await importOriginal<typeof import('fastify')>();
  const real = mod.default as unknown as (...args: unknown[]) => FastifyInstance;
  const wrapped = (...args: unknown[]) => {
    const app = real(...args);
    app.addHook('onRoute', (r) => {
      if (!seen.on) return;
      for (const m of [r.method].flat()) seen.routes.push({ method: String(m).toUpperCase(), url: r.url });
    });
    return app;
  };
  return { ...mod, default: Object.assign(wrapped, real) };
});

const SPEC = resolve(__dirname, '../docs/api/openapi.yaml');
const WEB = resolve(__dirname, '../web');
const METHODS = ['get', 'put', 'post', 'delete', 'patch'];

/**
 * The spec's operations as "METHOD /path". The repo has no YAML library, so this reads the one layout the spec
 * is written in: a path key at two spaces under `paths:`, its methods at four. Anything else under `paths:`
 * at those indents fails the test, so a layout change cannot quietly hide an operation.
 */
function specOperations(text: string): string[] {
  const ops: string[] = [];
  let inPaths = false;
  let path: string | null = null;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      inPaths = line.startsWith('paths:');
      path = null;
      continue;
    }
    if (!inPaths || line.trim() === '' || line.trim().startsWith('#')) continue;
    const p = /^ {2}(\/\S*):\s*$/.exec(line);
    if (p) {
      path = p[1]!;
      continue;
    }
    if (/^ {2}\S/.test(line)) throw new Error(`openapi.yaml: unexpected line under paths: ${line}`);
    const m = /^ {4}([a-z]+):\s*$/.exec(line);
    if (m && path) {
      if (METHODS.includes(m[1]!)) ops.push(`${m[1]!.toUpperCase()} ${path}`);
      else if (m[1] !== 'parameters') throw new Error(`openapi.yaml: unexpected key "${m[1]}" under ${path}`);
    }
  }
  return ops;
}

/** Fastify's ":id" → OpenAPI's "{id}". HEAD and OPTIONS twins are Fastify's own, not routes of the app. */
function serverOperations(routes: Array<{ method: string; url: string }>): string[] {
  return [...new Set(routes
    .filter((r) => r.method !== 'HEAD' && r.method !== 'OPTIONS')
    .map((r) => `${r.method} ${r.url.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`))].sort();
}

/**
 * The app shell is served by one wildcard route (GET /*). OpenAPI cannot say "any file", so the spec names the
 * shell's real pages instead: every non-/api path in the spec must be "/" or a file that exists in web/, and the
 * wildcard counts as covered when the spec names "/".
 */
function compare(server: string[], spec: string[]) {
  const shell = (op: string) => !op.split(' ')[1]!.startsWith('/api/');
  const serverApi = server.filter((op) => !shell(op));
  const specApi = spec.filter((op) => !shell(op));
  const specShell = spec.filter(shell);
  return {
    missingFromSpec: serverApi.filter((op) => !specApi.includes(op)),
    notOnServer: specApi.filter((op) => !serverApi.includes(op)),
    shellRoutes: server.filter(shell),
    specShell,
    badShellPaths: specShell.filter((op) => {
      const [method, path] = op.split(' ') as [string, string];
      return method !== 'GET' || (path !== '/' && !existsSync(resolve(WEB, `.${path}`)));
    }),
  };
}

const spec = specOperations(readFileSync(SPEC, 'utf8'));
let db: Db;
const routesOf: Record<'accounts' | 'single', string[]> = { accounts: [], single: [] };
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  db = await memoryDb();
  for (const mode of ['accounts', 'single'] as const) {
    seen.routes = [];
    seen.on = true;
    const app = mode === 'accounts'
      ? await buildServer({ db }, { config: accountsConfig() })
      : await buildServer({ db, profile: loadProfile('lm-electric') });
    await app.ready();
    seen.on = false;
    apps.push(app);
    routesOf[mode] = serverOperations(seen.routes);
  }
});

afterAll(async () => {
  for (const app of apps) await app.close();
  await db.close();
});

describe('docs/api/openapi.yaml matches the routes the server registers', () => {
  it('reads a spec with operations in it', () => {
    expect(spec.length).toBeGreaterThan(60);
    expect(new Set(spec).size).toBe(spec.length);
  });

  for (const mode of ['accounts', 'single'] as const) {
    it(`${mode} mode: every route is in the spec and every spec path is a route`, () => {
      const routes = routesOf[mode];
      expect(routes.length).toBeGreaterThan(60);
      const diff = compare(routes, spec);
      expect(diff.missingFromSpec, 'routes the server registers that docs/api/openapi.yaml does not describe').toEqual([]);
      expect(diff.notOnServer, 'operations in docs/api/openapi.yaml the server does not register').toEqual([]);
      expect(diff.shellRoutes, 'the app shell is one wildcard route').toEqual(['GET /*']);
      expect(diff.specShell).toContain('GET /');
      expect(diff.badShellPaths, 'shell paths in the spec that are not files in web/').toEqual([]);
    });
  }

  it('the two modes register the same routes (single mode answers 404 on the accounts-only ones)', () => {
    expect(routesOf.single).toEqual(routesOf.accounts);
  });
});
