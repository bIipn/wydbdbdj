import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContext } from '../context.js';
import { getWorkProfile, saveWorkProfile } from '../db/work.js';
import { sharesJob } from '../jobs/stats.js';
import { personCard } from '../profile/person.js';
import { validateWorkProfile } from '../profile/work.js';
import type { Account } from '../types.js';

/**
 * Work profiles: experience, licence, what someone is looking for; the card other people see.
 *
 *   GET /api/work-profile  -> { workProfile, card }   the caller's own, with the card exactly as others see it
 *   PUT /api/work-profile  -> { workProfile, card }   fields left out keep their saved value
 *   GET /api/people/:id    -> { card }                only someone the caller has dealt with on a job; else 404
 *
 * Accounts mode only: the pilot (single mode) has no accounts, so these answer 404 there, like sign-in.
 * A profile (onboarding) is not needed: someone can fill this in before or after.
 */
export async function register(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { db, config } = ctx;

  if (config.authMode !== 'accounts') {
    const absent = async (_req: FastifyRequest, reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
    app.get('/api/work-profile', absent);
    app.put('/api/work-profile', absent);
    app.get('/api/people/:id', absent);
    return;
  }

  /** The signed-in account, or null after answering 401 itself. */
  const signedIn = async (req: FastifyRequest, reply: FastifyReply): Promise<Account | null> => {
    const { account } = await ctx.identify(req);
    if (!account) reply.code(401).send({ error: 'sign_in_required' });
    return account;
  };

  app.get('/api/work-profile', async (req, reply) => {
    const account = await signedIn(req, reply);
    if (!account) return reply;
    return { workProfile: await getWorkProfile(db, account.id), card: await personCard(db, account.id) };
  });

  app.put('/api/work-profile', async (req, reply) => {
    const account = await signedIn(req, reply);
    if (!account) return reply;
    const stored = await getWorkProfile(db, account.id);
    const checked = validateWorkProfile(req.body, ctx.now(), stored);
    if (!checked.ok) return reply.code(400).send({ error: 'invalid_input', fields: checked.fields });
    await saveWorkProfile(db, account.id, checked.value, ctx.now());
    return { workProfile: checked.value, card: await personCard(db, account.id) };
  });

  // The same 404 for "no such person" and "not someone you have dealt with": a stranger cannot even learn
  // whether an id exists. Your own card is in GET /api/work-profile.
  app.get<{ Params: { id: string } }>('/api/people/:id', async (req, reply) => {
    const account = await signedIn(req, reply);
    if (!account) return reply;
    const other = req.params.id;
    if (other === account.id || !(await sharesJob(db, account.id, other))) return reply.code(404).send({ error: 'not_found' });
    const card = await personCard(db, other);
    return card ? { card } : reply.code(404).send({ error: 'not_found' });
  });
}
