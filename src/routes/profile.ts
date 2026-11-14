import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';
import { lastScan, saveProfileForAccount } from '../db/repo.js';
import { getWorkProfile, saveIntent } from '../db/work.js';
import { nearestZip } from '../geo/nearest.js';
import { lookupZip } from '../geo/zip.js';
import { featuresFor, type Features } from '../plans.js';
import { buildProfile, profileIdFor, SET_ASIDES, setAsidePartner, summarize, validateAnswers, type ProfileSummary } from '../profile/build.js';
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
    // No stored intent = 'work': every account from before the job marketplace keeps working as it did.
    const { intent } = await getWorkProfile(db, id.account.id);
    return {
      account: publicAccount(id.account),
      profile: id.profile ? summaryFor(id.profile, features) : null,
      // "What brings you here" (the work profile's): which screens the app leads with.
      intent,
      needsOnboarding: !id.profile,
      features,
      ...(id.profile ? legacyMe(id.profile) : {}),
    };
  });

  // Everything the onboarding form picks from. Open before a profile exists.
  app.get('/api/trades', async () => ({
    trades: TRADES.map((t) => ({ id: t.id, label: t.label, blurb: t.blurb, naics: t.naics.strong })),
    // pair: the program's other code. Saving one stores both, so the form ticks and unticks them together.
    setAsides: SET_ASIDES.map((s) => ({ ...s, pair: setAsidePartner(s.code) })),
  }));

  app.get<{ Params: { zip: string } }>('/api/geo/zip/:zip', async (req, reply) => {
    return lookupZip(req.params.zip) ?? reply.code(404).send({ error: 'zip_not_found' });
  });

  /**
   * "Use my location": the browser's point → the nearest ZIP and its town. The client sends lat/lng rounded to
   * 2 decimals (about 1 km) and nearestZip rounds again; they are used for this lookup only and never stored —
   * only the ZIP the person then saves is kept. Open before a profile exists, like the ZIP preview above.
   */
  app.get<{ Querystring: { lat?: string; lng?: string } }>('/api/geo/nearest-zip', async (req, reply) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    // Number('') is 0: an empty lat= or lng= must not quietly become the point 0,0 (off Africa).
    const blank = (v: string | undefined) => v == null || String(v).trim() === '';
    if (blank(req.query.lat) || blank(req.query.lng) || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return reply.code(400).send({ error: 'bad_point', message: 'Send lat and lng as numbers.' });
    }
    const place = nearestZip(lat, lng);
    if (!place) return reply.code(404).send({ error: 'zip_not_found', message: 'No US ZIP near that point.' });
    return { zip: place.zip, city: place.city, state: place.state };
  });

  /** The saved answers (accounts mode). The same summary /api/me carries, for a client that wants only this. */
  app.get('/api/profile', async (req, reply) => {
    if (config.authMode === 'single') {
      return reply.code(409).send({ error: 'single_profile_mode', message: 'This server runs one profile from config/<PROFILE_ID>.json.' });
    }
    const id = await ctx.identify(req);
    if (!id.account) return reply.code(401).send({ error: 'sign_in_required' });
    if (!id.profile) return reply.code(409).send({ error: 'onboarding_required' });
    return { profile: summaryFor(id.profile, featuresFor(id.plan)) };
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
    // A form that does not say why the person is here keeps the stored answer: a 'hire' account's later
    // saves (an older client, a script) must not suddenly need trades. No stored answer = 'work', as before.
    const storedIntent = (await getWorkProfile(db, id.account.id)).intent;
    const body = req.body;
    const withIntent = storedIntent !== 'work' && body && typeof body === 'object' && !Array.isArray(body) && (body as Record<string, unknown>).intent == null
      ? { ...body, intent: storedIntent } : body;
    const answers = validateAnswers(withIntent);
    if (!answers.ok) {
      return reply.code(400).send({ error: 'invalid_profile', message: 'Some answers need fixing.', fields: answers.errors });
    }

    const features = featuresFor(id.plan);
    const profile = buildProfile(profileIdFor(id.account.id), answers.value);
    // A plan without cost settings is never shown them, so its form sends none: keep what is stored.
    if (!features.costSettings && !hasValues(profile.costs) && id.profile?.costs) profile.costs = id.profile.costs;

    const stored = await saveProfileForAccount(db, id.account.id, profile);
    // The intent lives in the work profile (GET /api/me reports it). Answers without one leave it as it is.
    if (answers.value.intent && answers.value.intent !== storedIntent) await saveIntent(db, id.account.id, answers.value.intent, ctx.now());
    const scored = await scoreProfile(db, stored, ctx.now(), ctx.bus);
    return { profile: summaryFor(stored, features), scored };
  });
}
