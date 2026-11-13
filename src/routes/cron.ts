import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContext } from '../context.js';
import { safeEqual } from './shared.js';

/**
 * The daily jobs as plain GET routes, for hosts that cannot keep a timer alive.
 *
 * On a server that stays up (the VPS setup) the scan and the market refresh run on in-process timers
 * (SCAN_DAILY_AT, MARKET_REFRESH_AT). A serverless host starts the app per request and stops it
 * afterwards, so a timer never fires. There the host's own scheduler calls these routes once a day
 * (vercel.json "crons"). Vercel sends "Authorization: Bearer <CRON_SECRET>" with each call.
 *
 * Without CRON_SECRET the routes do not exist (404): nobody can start a scan from outside.
 */
export async function register(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const secret = ctx.config.cronSecret;

  const allowed = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!secret) {
      reply.code(404).send({ error: 'not_found' });
      return false;
    }
    const given = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
    if (safeEqual(given, secret)) return true;
    reply.code(401).send({ error: 'cron_secret_required' });
    return false;
  };

  // One scan of every source, then scoring. The answer is the scan report (per source: OK or FAILED).
  app.get('/api/cron/scan', async (req, reply) => {
    if (!allowed(req, reply)) return reply;
    if (!ctx.scan) return reply.code(501).send({ error: 'scan not configured' });
    return ctx.scan();
  });

  // The market refresh with its price and award watch. A failed refresh is in the status, never a 500.
  app.get('/api/cron/market', async (req, reply) => {
    if (!allowed(req, reply)) return reply;
    await ctx.market.runDaily();
    return ctx.market.status();
  });
}
