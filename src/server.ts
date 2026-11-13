import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildDeps, type AppDeps } from './app.js';
import { env, loadEnv } from './env.js';
import { getFeed, getItem, getSaved, lastScan, recordSwipe, undoSwipe } from './db/repo.js';
import { sendDigest } from './notify/send.js';
import { runScan, type ScanReport } from './scan.js';
import { scheduleDaily } from './scheduler.js';
import type { SwipeAction } from './types.js';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const ACTIONS: SwipeAction[] = ['save', 'pass', 'bid'];

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface ServerOptions {
  accessCode?: string;
  adminToken?: string;
  /** Called by POST /api/admin/scan and the daily schedule. */
  scan?: () => Promise<ScanReport>;
  logger?: boolean;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export async function buildServer(deps: Pick<AppDeps, 'db' | 'profile'>, opts: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  const { db, profile } = deps;
  const now = opts.now ?? (() => new Date());

  // Optional shared access code for the pilot (real accounts come with the App Store version).
  app.addHook('onRequest', async (req, reply) => {
    if (!opts.accessCode || !req.url.startsWith('/api/') || req.url.startsWith('/api/health')) return;
    if (req.url.startsWith('/api/admin/')) return; // admin routes check their own token
    const given = String(req.headers['x-access-code'] ?? '');
    if (!safeEqual(given, opts.accessCode)) return reply.code(401).send({ error: 'access_code_required' });
  });

  app.get('/api/health', async () => ({ ok: true, db: db.kind, profile: profile.id, lastScan: (await lastScan(db))?.finishedAt ?? null }));

  app.get('/api/me', async () => ({
    id: profile.id, name: profile.name, base: profile.base.label, maxDistanceMi: profile.maxDistanceMi,
    valueRange: profile.valueRange, notifyMinScore: profile.notify.minScore,
  }));

  app.get<{ Querystring: { minScore?: string; limit?: string; all?: string } }>('/api/feed', async (req) => {
    const minScore = Math.max(0, Math.min(100, Number(req.query.minScore ?? 35) || 0));
    const limit = Math.max(1, Math.min(300, Number(req.query.limit ?? 100) || 100));
    const items = await getFeed(db, profile.id, { minScore, limit, includeSwiped: req.query.all === '1', now: now() });
    return { items, lastScan: (await lastScan(db))?.finishedAt ?? null };
  });

  app.get('/api/saved', async () => ({ items: await getSaved(db, profile.id) }));

  app.get<{ Params: { id: string } }>('/api/bids/:id', async (req, reply) => {
    const item = await getItem(db, profile.id, req.params.id);
    return item ?? reply.code(404).send({ error: 'not_found' });
  });

  app.post<{ Body: { bidId?: string; action?: string } }>('/api/swipe', async (req, reply) => {
    const { bidId, action } = req.body ?? {};
    if (!bidId || !ACTIONS.includes(action as SwipeAction)) {
      return reply.code(400).send({ error: 'bidId and action (save | pass | bid) are required' });
    }
    const ok = await recordSwipe(db, profile.id, bidId, action as SwipeAction);
    return ok ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  app.delete<{ Params: { id: string } }>('/api/swipe/:id', async (req) => {
    await undoSwipe(db, profile.id, req.params.id);
    return { ok: true };
  });

  app.post('/api/admin/scan', async (req, reply) => {
    const token = String(req.headers['x-admin-token'] ?? '');
    if (!opts.adminToken || !safeEqual(token, opts.adminToken)) return reply.code(401).send({ error: 'admin_token_required' });
    if (!opts.scan) return reply.code(501).send({ error: 'scan not configured' });
    return opts.scan();
  });

  await app.register(fastifyStatic, { root: WEB_DIR, prefix: '/', index: ['index.html'] });
  return app;
}

// ---------------------------------------------------------------- main --

async function main() {
  loadEnv();
  const deps = await buildDeps();
  let running: Promise<ScanReport> | null = null;

  const scan = async () => {
    // Never run two scans at once (manual trigger + schedule).
    running ??= (async () => {
      try {
        const report = await runScan({ db: deps.db, sources: deps.sources, profiles: [deps.profile], ctx: deps.makeCtx() });
        await sendDigest(deps.db, deps.profile, {
          resendApiKey: env('RESEND_API_KEY'), from: env('DIGEST_FROM'),
          to: (env('DIGEST_TO') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
          appUrl: env('APP_URL') ?? `http://localhost:${env('PORT') ?? 8787}`,
        });
        return report;
      } finally {
        running = null;
      }
    })();
    return running;
  };

  const app = await buildServer(deps, { accessCode: env('ACCESS_CODE'), adminToken: env('ADMIN_TOKEN'), scan, logger: true });
  const port = Number(env('PORT') ?? 8787);
  await app.listen({ port, host: env('HOST') ?? '0.0.0.0' });

  const at = env('SCAN_DAILY_AT');
  const stop = at ? scheduleDaily(at, async () => void (await scan())) : () => {};

  const shutdown = async () => {
    stop();
    await app.close();
    await deps.db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
