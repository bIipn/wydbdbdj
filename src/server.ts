import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { buildDeps, scanProfiles, type AppDeps } from './app.js';
import { registerCsrfGuard } from './auth/guard.js';
import { createAuth, type AuthService } from './auth/index.js';
import { createContext, loadConfig, type AppConfig, type RouteContext } from './context.js';
import type { Db } from './db/db.js';
import { env, loadEnv } from './env.js';
import { projectDir } from './paths.js';
import type { MarketHttp } from './market/refresh.js';
import { mailerFromEnv, type Mailer } from './notify/email.js';
import { sendDigest } from './notify/send.js';
import { createBus, type Bus } from './realtime/bus.js';
import { createRealtime, startRealtime } from './realtime/index.js';
import { logUrl } from './util/log-url.js';
import { registerPlainStatic } from './static.js';
import { register as accountRoutes } from './routes/account.js';
import { register as adminRoutes } from './routes/admin.js';
import { register as authRoutes } from './routes/auth.js';
import { register as cronRoutes } from './routes/cron.js';
import { register as estimateRoutes } from './routes/estimate.js';
import { register as feedRoutes } from './routes/feed.js';
import { register as jobsRoutes } from './routes/jobs.js';
import { register as marketRoutes } from './routes/market.js';
import { register as profileRoutes } from './routes/profile.js';
import { register as realtimeRoutes } from './routes/realtime.js';
import { register as workRoutes } from './routes/work.js';
import { safeEqual } from './routes/shared.js';
import { runScan, type ScanReport } from './scan.js';
import { scheduleDaily } from './scheduler.js';
import type { Profile } from './types.js';

const WEB_DIR = projectDir('web');

export interface ServerOptions {
  /** Shortcuts for config.accessCode / config.adminToken; they win over `config`. */
  accessCode?: string;
  adminToken?: string;
  /** Called by POST /api/admin/scan and the daily schedule. */
  scan?: () => Promise<ScanReport>;
  logger?: boolean;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Defaults to single mode with nothing else configured. */
  config?: AppConfig;
  /** Share one bus between the scan, the routes and the realtime module. Defaults to a private one. */
  bus?: Bus;
  /** Defaults to createAuth(db, config). Tests pass a fake to be "signed in". */
  auth?: AuthService;
  /**
   * Reverse proxies whose X-Forwarded-For is believed (Fastify's trustProxy): their addresses or
   * CIDR ranges, comma-separated. Only for a proxy on another machine — one on this machine needs
   * nothing, the sign-in rate limiter already reads the header from loopback (src/auth/ratelimit.ts).
   */
  trustProxy?: string;
  /** Market refresh clients (tests and the offline demo replay captured pages). Default: polite real clients. */
  marketHttp?: MarketHttp;
  /** Serve the app shell with the built-in plain file server instead of @fastify/static (hosts that cannot load the plugin). */
  plainStatic?: boolean;
  /** Sends the password reset email. Absent = email is off, and the app says so (main() builds it from the environment). */
  mailer?: Mailer | null;
}

export interface ServerDeps {
  db: Db;
  /** The config profile: required in single mode, unused in accounts mode. */
  profile?: Profile | null;
}

/** The Fastify app plus the context its routes share (main() hands the context to startRealtime). */
export async function buildApp(deps: ServerDeps, opts: ServerOptions = {}): Promise<{ app: FastifyInstance; ctx: RouteContext }> {
  // forceCloseConnections: a long-lived /api/stream connection must not keep close() waiting.
  // The logger writes each request's URL through logUrl: no "Use my location" point and no promo code in a log.
  const logger = opts.logger
    ? {
      serializers: {
        req: (req: { method?: string; url?: string; ip?: string }) => ({ method: req.method, url: logUrl(req.url), remoteAddress: req.ip }),
      },
    }
    : false;
  const options: FastifyServerOptions = { logger, forceCloseConnections: true, trustProxy: opts.trustProxy ?? false };
  const app = Fastify(options);
  const base = opts.config ?? loadConfig({});
  const config: AppConfig = {
    ...base,
    accessCode: opts.accessCode ?? base.accessCode,
    adminToken: opts.adminToken ?? base.adminToken,
  };

  // Optional shared access code. It gates the whole API in both modes (accounts sign in on top of it).
  app.addHook('onRequest', async (req, reply) => {
    if (!config.accessCode) return;
    // Judged by the route the router matched as well as the raw URL: the router decodes "/%61pi/me"
    // to "/api/me", so the raw text alone would wave that request through.
    const route = req.routeOptions.url ?? '';
    if (!route.startsWith('/api/') && !req.url.startsWith('/api/')) return; // the app shell and its files
    // health is public; admin and cron routes check their own token
    if (route === '/api/health' || route.startsWith('/api/admin/') || route.startsWith('/api/cron/')) return;
    const given = String(req.headers['x-access-code'] ?? '');
    if (!safeEqual(given, config.accessCode)) return reply.code(401).send({ error: 'access_code_required' });
  });
  registerCsrfGuard(app, config);

  const ctx = createContext({
    db: deps.db,
    config,
    profile: deps.profile,
    bus: opts.bus ?? createBus(),
    auth: opts.auth ?? createAuth(deps.db, config),
    now: opts.now,
    log: (msg) => app.log.info(msg),
    scan: opts.scan,
    marketHttp: opts.marketHttp,
    mailer: opts.mailer,
  });

  // One plugin per area; each file has exactly one owner.
  for (const routes of [authRoutes, profileRoutes, feedRoutes, marketRoutes, estimateRoutes, realtimeRoutes, adminRoutes, cronRoutes, workRoutes, jobsRoutes, accountRoutes]) {
    await routes(app, ctx);
  }

  // The app shell. @fastify/static is imported only where it is used: Vercel's module loader cannot
  // load it at all (it require()s an ES-module-only package), and a top-level import crashed every
  // request there. That host gets the plain file server in src/static.ts instead (the host ships
  // the whole project with the function, so web/ is on disk there too).
  if (existsSync(WEB_DIR)) {
    if (opts.plainStatic) registerPlainStatic(app, WEB_DIR);
    else {
      const { default: fastifyStatic } = await import('@fastify/static');
      await app.register(fastifyStatic, { root: WEB_DIR, prefix: '/', index: ['index.html'] });
    }
  }
  return { app, ctx };
}

export async function buildServer(deps: ServerDeps, opts: ServerOptions = {}): Promise<FastifyInstance> {
  return (await buildApp(deps, opts)).app;
}

// ---------------------------------------------------------------- main --

/** One scan at a time (manual trigger, schedule, cron route), with the pilot's digest after it. */
function createScanRunner(deps: AppDeps, config: AppConfig, bus: Bus): () => Promise<ScanReport> {
  let running: Promise<ScanReport> | null = null;
  return async () => {
    // Never run two scans at once (manual trigger + schedule).
    running ??= (async () => {
      try {
        const report = await runScan({ db: deps.db, sources: deps.sources, profiles: scanProfiles(deps), ctx: deps.makeCtx(), bus });
        // The emailed digest is the pilot's (single mode). In accounts mode alerts go out through the bus.
        if (deps.profile) {
          await sendDigest(deps.db, deps.profile, {
            resendApiKey: env('RESEND_API_KEY'), from: env('DIGEST_FROM'),
            to: (env('DIGEST_TO') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
            appUrl: config.appUrl,
          });
        }
        return report;
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

/** Database, sources, bus, app and realtime wiring: everything except listening and timers. */
async function boot(how: { plainStatic?: boolean } = {}) {
  loadEnv();
  const config = loadConfig();
  const deps = await buildDeps(config);
  const bus = createBus((err, event) => {
    console.error(`[bus] a "${event.type}" listener failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  const scan = createScanRunner(deps, config, bus);
  const { app, ctx } = await buildApp(deps, {
    config, bus, auth: createAuth(deps.db, config), scan, logger: true, trustProxy: env('TRUST_PROXY'), plainStatic: how.plainStatic,
    mailer: mailerFromEnv(env, (msg) => console.warn(`[email] ${msg}`)),
  });
  return { app, ctx, deps, scan };
}

async function main() {
  const { app, ctx, deps, scan } = await boot();
  const port = Number(env('PORT') ?? 8787);
  await app.listen({ port, host: env('HOST') ?? '0.0.0.0' });

  const stopRealtime = startRealtime(ctx);
  const at = env('SCAN_DAILY_AT');
  const stopSchedule = at ? scheduleDaily(at, async () => void (await scan())) : () => {};
  // The daily market refresh + price/award watch (MARKET_REFRESH_AT). Its own timer: a failed refresh
  // is logged and shows in GET /api/market/watch, and never touches the scan's schedule.
  const stopMarket = ctx.market.start();

  const shutdown = async () => {
    stopSchedule();
    stopMarket();
    stopRealtime();
    await app.close();
    await deps.db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Serverless start (Vercel). The host imports this file for each new instance and routes requests to
 * the server that listens; the instance is frozen between requests and thrown away when idle. So:
 * no timers (the host's scheduler calls GET /api/cron/* instead, see vercel.json; that includes the alert
 * rules' deadline reminders, /api/cron/tick, and the pushes a scan queues), and the database
 * must be a real Postgres (DATABASE_URL): the embedded one would start empty on every instance.
 */
async function serverless() {
  if (!env('DATABASE_URL')) throw new Error('DATABASE_URL is required on a serverless host: the embedded database does not survive between requests');
  const { app, ctx } = await boot({ plainStatic: true });
  // Stores alerts for what a scan publishes; push hangs off the same bus. tickMs 0: no timers here (a frozen
  // instance never fires them). The cron routes call ctx.realtime.tick() / flush() instead (routes/cron.ts).
  ctx.realtime = createRealtime(ctx, { tickMs: 0 });
  await app.ready(); // every route is registered before the host sends the first request
  // NOT awaited, on purpose. Vercel takes over the server's listen() and feeds it requests itself;
  // the "now listening" answer never comes back there, so awaiting it hung every request until the
  // host gave up after 60 s. (Its own Fastify example calls listen() without awaiting it, too.)
  app.listen({ port: Number(env('PORT') ?? 3000) }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

if (process.env.VERCEL) {
  await serverless();
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
