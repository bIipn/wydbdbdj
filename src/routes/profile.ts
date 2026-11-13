import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';
import { lastScan, saveProfileForAccount } from '../db/repo.js';
import { lookupZip } from '../geo/zip.js';
import { featuresFor, type Features } from '../plans.js';
import { buildProfile, profileIdFor, SET_ASIDES, summarize, validateAnswers, type ProfileSummary } from '../profile/build.js';
import { scoreProfile } from '../scan.js';
import { TRADES } from '../trades/catalog.js';
import type { Account, Profile } from '../types.js';

/** The fields the v0 app reads from /api/me. Single mode answers exactly these. */
const legacyMe = (p: Profile) => ({
  id: p.id, name: p.name, base: p.base.label, maxDistanceMi: p.maxDistanceMi,
  valueRange: p.valueRange, notifyMinScore: p.notify.minScore,
});

/** Only these fields ever leave the server, whatever else an account object may carry. */
const publicAccount = ({ id, email, name, plan, createdAt }: Account): Account => ({ id, email, name, plan, createdAt });

const hasValues = (o: object | undefined): boolean => Object.values(o ?? {}).some((v) => v != null);

/** The profile as this plan may see it: saved cost settings stay on the server until the plan includes them. */
function summaryFor(profile: Profile, features: Features): ProfileSummary {
  const summary = summarize(profile);
  return features.costSettings ? summary : { ...summary, costs: {} };
}

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
    const features = featuresFor(id.plan);
    return {
      account: publicAccount(id.account),
      profile: id.profile ? summaryFor(id.profile, features) : null,
      needsOnboarding: !id.profile,
      features,
      ...(id.profile ? legacyMe(id.profile) : {}),
    };
  });

  // Everything the onboarding form picks from. Open before a profile exists.
  app.get('/api/trades', async () => ({
    trades: TRADES.map((t) => ({ id: t.id, label: t.label, blurb: t.blurb, naics: t.naics.strong })),
    setAsides: SET_ASIDES,
  }));

  app.get<{ Params: { zip: string } }>('/api/geo/zip/:zip', async (req, reply) => {
    return lookupZip(req.params.zip) ?? reply.code(404).send({ error: 'zip_not_found' });
  });

  /**
   * Onboarding and every later settings save: answers → Profile → stored → every open bid scored
   * at once, so the feed is there when the form closes. Replaces the account's whole profile.
   */
  app.put('/api/profile', async (req, reply) => {
    if (config.authMode === 'single') {
      return reply.code(409).send({ error: 'single_profile_mode', message: 'This server runs one profile from config/<PROFILE_ID>.json.' });
    }
    const id = await ctx.identify(req);
    if (!id.account) return reply.code(401).send({ error: 'sign_in_required' });
    const answers = validateAnswers(req.body);
    if (!answers.ok) {
      return reply.code(400).send({ error: 'invalid_profile', message: 'Some answers need fixing.', fields: answers.errors });
    }

    const features = featuresFor(id.plan);
    const profile = buildProfile(profileIdFor(id.account.id), answers.value);
    // A plan without cost settings is never shown them, so its form sends none: keep what is stored.
    if (!features.costSettings && !hasValues(profile.costs) && id.profile?.costs) profile.costs = id.profile.costs;

    const stored = await saveProfileForAccount(db, id.account.id, profile);
    const scored = await scoreProfile(db, stored, ctx.now(), ctx.bus);
    return { profile: summaryFor(stored, features), scored };
  });
}
