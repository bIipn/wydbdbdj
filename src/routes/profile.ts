import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';
import { lastScan } from '../db/repo.js';
import { lookupZip } from '../geo/zip.js';
import { featuresFor } from '../plans.js';
import { summarize } from '../profile/build.js';
import { TRADES } from '../trades/catalog.js';
import type { Account, Profile } from '../types.js';
import { notImplemented } from './shared.js';

/** The fields the v0 app reads from /api/me. Single mode answers exactly these. */
const legacyMe = (p: Profile) => ({
  id: p.id, name: p.name, base: p.base.label, maxDistanceMi: p.maxDistanceMi,
  valueRange: p.valueRange, notifyMinScore: p.notify.minScore,
});

/** Only these fields ever leave the server, whatever else an account object may carry. */
const publicAccount = ({ id, email, name, plan, createdAt }: Account): Account => ({ id, email, name, plan, createdAt });

/** Who am I, health, and onboarding (trades, ZIP lookup, saving the profile). */
export async function register(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { db, config } = ctx;

  app.get('/api/health', async (req) => ({
    ok: true,
    db: db.kind,
    profile: config.authMode === 'single' ? ((await ctx.identify(req)).profile?.id ?? null) : null,
    lastScan: (await lastScan(db))?.finishedAt ?? null,
  }));

  app.get('/api/me', async (req, reply) => {
    const id = await ctx.identify(req);
    if (config.authMode === 'single') return legacyMe(id.profile!);
    if (!id.account) return reply.code(401).send({ error: 'sign_in_required' });
    return {
      account: publicAccount(id.account),
      profile: id.profile ? summarize(id.profile) : null,
      needsOnboarding: !id.profile,
      features: featuresFor(id.plan),
      ...(id.profile ? legacyMe(id.profile) : {}),
    };
  });

  app.get('/api/trades', async () => ({
    trades: TRADES.map((t) => ({ id: t.id, label: t.label, blurb: t.blurb, naics: t.naics.strong })),
  }));

  app.get<{ Params: { zip: string } }>('/api/geo/zip/:zip', async (req, reply) => {
    return lookupZip(req.params.zip) ?? reply.code(404).send({ error: 'zip_not_found' });
  });

  // STUB (foundation). The pieces it needs are ready: validateAnswers + buildProfile(profileIdFor(account.id), …)
  // → saveProfileForAccount (src/db/repo.ts) → scoreProfile (src/scan.ts) → { profile: summarize(stored), scored }.
  app.put('/api/profile', async (_req, reply) => notImplemented(reply));
}
