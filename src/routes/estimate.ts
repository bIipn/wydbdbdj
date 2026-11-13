import type { FastifyInstance, FastifyReply } from 'fastify';
import type { RouteContext } from '../context.js';
import { estimate, estimateErrorBody, fromQuickForm, type BidFacts, type EstimateRequest } from '../cost/estimate.js';
import { listEstimates, saveEstimate } from '../db/estimates.js';
import { getBid, getProfile, upsertProfile } from '../db/repo.js';
import { featuresFor } from '../plans.js';
import type { Bid, Plan } from '../types.js';
import { pacificParts } from '../util/time.js';

/** The cost engine is a premium feature: plans without it get 402 and no numbers at all (contract 6). */
function premiumGate(plan: Plan, reply: FastifyReply): boolean {
  if (featuresFor(plan).estimator) return true;
  reply.code(402).send({ error: 'premium_required', message: 'The cost engine is part of BidSwipe Pro' });
  return false;
}

const bad = (reply: FastifyReply, path: string, message: string) =>
  reply.code(400).send({ error: 'invalid_input', message: 'Some fields need fixing', fields: [{ path, message }] });

/** What we know about a stored bid, for the estimate. The due date is the agency's (Pacific) calendar date. */
function bidFacts(b: Bid): BidFacts {
  let dueDate: string | null = null;
  if (b.dueAt) {
    const p = pacificParts(new Date(b.dueAt));
    dueDate = `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  }
  return { id: b.id, estValue: b.estValue, flags: b.flags, dueDate, state: b.location.state, locationLabel: b.location.label };
}

/** The cost check: run an estimate (POST /api/estimate) and list saved ones (GET /api/estimates?bidId=). */
export async function register(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { db } = ctx;

  app.post('/api/estimate', async (req, reply) => {
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    if (!premiumGate(id.plan, reply)) return reply;

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad(reply, 'body', 'send a JSON object');
    const { bidId, ...rest } = body as Record<string, unknown>;
    if (bidId !== undefined && bidId !== null && (typeof bidId !== 'string' || !bidId || bidId.length > 200)) return bad(reply, 'bidId', 'must be a bid id');

    // Full request, or the contract's quick form ({ laborHours, laborRate, materials, ... }).
    let request: EstimateRequest = rest as EstimateRequest;
    let notes: string[] = [];
    if (!('job' in rest) && ('laborHours' in rest || ('materials' in rest && typeof rest.materials !== 'object'))) {
      ({ request, notes } = fromQuickForm(rest));
    }

    let bid: Bid | null = null;
    if (typeof bidId === 'string') {
      bid = await getBid(db, bidId);
      if (!bid) return reply.code(404).send({ error: 'bid_not_found' });
    }

    let result;
    try {
      result = estimate(request, { ...(bid ? { bid: bidFacts(bid) } : {}), tenantId: id.profile.id });
    } catch (e) {
      const body400 = estimateErrorBody(e);
      if (body400) return reply.code(400).send(body400);
      throw e;
    }
    if (notes.length) result = { ...result, warnings: [...notes, ...result.warnings] };

    // Single mode: the pilot profile row may not exist before the first scan (estimates reference it).
    if (!(await getProfile(db, id.profile.id))) await upsertProfile(db, id.profile);
    const saved = await saveEstimate(db, { profileId: id.profile.id, bidId: bid?.id ?? null, inputs: request, result }, ctx.now());
    return { id: saved.id, savedAt: saved.createdAt, bidId: saved.bidId, ...result };
  });

  app.get<{ Querystring: { bidId?: string; limit?: string } }>('/api/estimates', async (req, reply) => {
    const id = await ctx.requireProfile(req, reply);
    if (!id) return reply;
    if (!premiumGate(id.plan, reply)) return reply;
    const { bidId, limit } = req.query;
    if (bidId !== undefined && (typeof bidId !== 'string' || !bidId || bidId.length > 200)) return bad(reply, 'bidId', 'must be a bid id');
    const n = limit === undefined ? undefined : Number(limit);
    if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 200)) return bad(reply, 'limit', 'must be a whole number from 1 to 200');
    const items = await listEstimates(db, id.profile.id, { ...(bidId ? { bidId } : {}), ...(n ? { limit: n } : {}) });
    return { items };
  });
}
