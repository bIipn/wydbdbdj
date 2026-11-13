import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService } from './auth/index.js';
import type { Db } from './db/db.js';
import { getProfileByAccount } from './db/repo.js';
import { env as processEnv } from './env.js';
import type { MarketHttp, refreshMarket } from './market/refresh.js';
import { createMarketWatcher, type MarketWatcher } from './market/watcher.js';
import { effectivePlan } from './plans.js';
import type { Bus } from './realtime/bus.js';
import type { ScanReport } from './scan.js';
import { nextDailyRun } from './scheduler.js';
import type { Account, Plan, Profile } from './types.js';

// ----------------------------------------------------------------- config --

/** single = one profile from config/<id>.json (the pilot). accounts = sign in, one stored profile per account. */
export type AuthMode = 'single' | 'accounts';

export interface AppConfig {
  authMode: AuthMode;
  /** Every account is treated as plan 'pilot' (all Pro features, no billing). */
  demoMode: boolean;
  accessCode?: string;
  adminToken?: string;
  /** Public base URL, no trailing slash. Used for links in emails and pushes. */
  appUrl: string;
  /** Mark the session cookie Secure (true when appUrl is https). */
  cookieSecure: boolean;
  supabase?: { url: string; anonKey: string };
  vapid?: { publicKey: string; privateKey: string; subject: string };
  /** Daily market refresh + price/award watch, "HH:MM" Pacific (MARKET_REFRESH_AT). Absent = off. */
  marketRefreshAt?: string;
}

/** `env('NAME')`-style getter or a plain object such as process.env. Blank values count as unset. */
export type EnvSource = ((name: string) => string | undefined) | Record<string, string | undefined>;

export function loadConfig(env: EnvSource = processEnv): AppConfig {
  const get = (name: string): string | undefined => {
    const v = (typeof env === 'function' ? env(name) : env[name])?.trim();
    return v ? v : undefined;
  };
  const mode = get('AUTH_MODE') ?? 'single';
  if (mode !== 'single' && mode !== 'accounts') throw new Error(`AUTH_MODE must be "single" or "accounts", got "${mode}"`);

  const appUrl = (get('APP_URL') ?? `http://localhost:${get('PORT') ?? 8787}`).replace(/\/+$/, '');
  const [supabaseUrl, anonKey] = [get('SUPABASE_URL'), get('SUPABASE_ANON_KEY')];
  const [publicKey, privateKey] = [get('VAPID_PUBLIC_KEY'), get('VAPID_PRIVATE_KEY')];
  const contact = get('CONTACT_EMAIL');
  const marketRefreshAt = get('MARKET_REFRESH_AT');
  if (marketRefreshAt) nextDailyRun(marketRefreshAt, new Date(), 'MARKET_REFRESH_AT'); // a typo stops the boot, not the 3 a.m. run

  return {
    authMode: mode,
    demoMode: ['1', 'true'].includes((get('DEMO_MODE') ?? '').toLowerCase()),
    accessCode: get('ACCESS_CODE'),
    adminToken: get('ADMIN_TOKEN'),
    appUrl,
    cookieSecure: appUrl.startsWith('https://'),
    // Each integration is on only when it is fully configured.
    supabase: supabaseUrl && anonKey ? { url: supabaseUrl.replace(/\/+$/, ''), anonKey } : undefined,
    vapid: publicKey && privateKey
      ? { publicKey, privateKey, subject: get('VAPID_SUBJECT') ?? (contact ? `mailto:${contact}` : appUrl) }
      : undefined,
    marketRefreshAt,
  };
}

// --------------------------------------------------------------- identity --

/** Who a request is. Single mode: the config profile, no account. Accounts mode: whoever is signed in. */
export interface Identity {
  account: Account | null;
  /** null = not signed in, or signed in but not onboarded yet. */
  profile: Profile | null;
  plan: Plan;
}
export type ProfileIdentity = Identity & { profile: Profile };

/** What every route plugin gets: `export async function register(app, ctx: RouteContext)`. */
export interface RouteContext {
  db: Db;
  config: AppConfig;
  /** Injectable clock (tests). */
  now: () => Date;
  bus: Bus;
  auth: AuthService;
  log: (msg: string) => void;
  /** Runs a scan now (admin route + daily schedule). Absent when the server was built without one. */
  scan?: () => Promise<ScanReport>;
  /** The market refresh with its price and award watch (admin route, daily schedule, GET /api/market/watch). */
  market: MarketWatcher;
  identify(req: FastifyRequest): Promise<Identity>;
  /**
   * The identity when it has a profile. Otherwise it answers the request itself —
   * 401 { error: 'sign_in_required' } or 409 { error: 'onboarding_required' } — and returns null:
   *
   *   const id = await ctx.requireProfile(req, reply);
   *   if (!id) return reply;
   */
  requireProfile(req: FastifyRequest, reply: FastifyReply): Promise<ProfileIdentity | null>;
}

export interface ContextParts {
  db: Db;
  config: AppConfig;
  bus: Bus;
  auth: AuthService;
  /** The config profile: required in single mode, ignored in accounts mode. */
  profile?: Profile | null;
  now?: () => Date;
  log?: (msg: string) => void;
  scan?: () => Promise<ScanReport>;
  /** Market refresh clients (tests replay captured pages). Default: polite real clients, built on first use. */
  marketHttp?: MarketHttp;
  /** Stand-in for refreshMarket (tests). */
  marketRefresh?: typeof refreshMarket;
  /** Environment reader for the market refresh (BLS key, query budget, watch threshold). Default: process env. */
  env?: (name: string) => string | undefined;
}

export function createContext(parts: ContextParts): RouteContext {
  const { db, config, bus, auth, scan } = parts;
  const single = config.authMode === 'single' ? parts.profile : null;
  if (config.authMode === 'single' && !single) throw new Error('AUTH_MODE=single needs a profile (config/<PROFILE_ID>.json)');

  const identify = async (req: FastifyRequest): Promise<Identity> => {
    if (single) return { account: null, profile: single, plan: effectivePlan(config, null) };
    const account = await auth.authenticate(req);
    const profile = account ? await getProfileByAccount(db, account.id) : null;
    return { account, profile, plan: effectivePlan(config, account) };
  };

  const now = parts.now ?? (() => new Date());
  const log = parts.log ?? (() => {});
  const market = createMarketWatcher({
    db, bus, now, log, env: parts.env ?? processEnv, schedule: config.marketRefreshAt ?? null, profile: single,
    http: parts.marketHttp, refresh: parts.marketRefresh,
  });

  return {
    db, config, bus, auth, scan, market, now, log,
    identify,
    async requireProfile(req, reply) {
      const id = await identify(req);
      if (id.profile) return id as ProfileIdentity;
      if (id.account) reply.code(409).send({ error: 'onboarding_required' });
      else reply.code(401).send({ error: 'sign_in_required' });
      return null;
    },
  };
}
