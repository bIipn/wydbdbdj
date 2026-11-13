import { createReadStream, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/** What the app shell is made of. A file with any other extension is never served. */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** Every servable file under `root`, keyed by its URL path ("/js/main.js"). Dot files and dot folders are skipped. */
export function listShellFiles(root: string): Map<string, { file: string; type: string; size: number }> {
  const files = new Map<string, { file: string; type: string; size: number }>();
  const walk = (dir: string, url: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const file = join(dir, name);
      const stat = statSync(file);
      if (stat.isDirectory()) walk(file, `${url}${name}/`);
      else if (stat.isFile() && TYPES[extname(name).toLowerCase()]) {
        files.set(`${url}${name}`, { file, type: TYPES[extname(name).toLowerCase()]!, size: stat.size });
      }
    }
  };
  walk(root, '/');
  return files;
}

/**
 * A plain read-only file server for the app shell, for hosts where @fastify/static cannot be loaded
 * (Vercel: the plugin require()s an ES-module-only package, which that host's loader refuses).
 *
 * The list of files is read once at start, and a request can only name one of them: the URL is looked
 * up in that list as a string and never joined onto a folder, so "../" tricks have nothing to act on.
 */
export function registerPlainStatic(app: FastifyInstance, root: string): void {
  const files = listShellFiles(root);
  app.get('/*', async (req, reply) => {
    let path: string;
    try {
      path = decodeURIComponent(req.url.split('?')[0] ?? '/');
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
    const hit = files.get(path === '/' ? '/index.html' : path);
    if (!hit) return reply.code(404).send({ error: 'not_found' });
    // no-cache = "ask before reusing": a new deployment's shell is picked up on the next load.
    reply.header('content-type', hit.type).header('content-length', hit.size).header('cache-control', 'no-cache');
    return reply.send(createReadStream(hit.file));
  });
}
