import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../context.js';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host;
  } catch {
    return null; // "null", or anything that is not a URL
  }
};

/**
 * CSRF guard for accounts mode. buildApp() calls this once, right after the access-code hook.
 *
 * A state-changing /api request must carry `x-bidswipe: 1`, or it gets 403 { error: 'csrf' }.
 * Another site cannot add a custom header to a request it makes a browser send (no CORS is enabled),
 * so the header proves the request came from our own page. An Origin header, when the browser sends
 * one, must also name this host or the configured APP_URL.
 *
 * The rule covers every request that could be forged: one that carries a Cookie header (the session
 * cookie is the only credential a browser attaches by itself), and every /api/auth route (they set
 * that cookie). A request with no cookie at all is anonymous and is left to its handler, which
 * answers 401. /api/admin/ is token-only and exempt. Single mode has no cookie session: no guard.
 */
export function registerCsrfGuard(app: FastifyInstance, config: AppConfig): void {
  if (config.authMode !== 'accounts') return;
  const ownHost = hostOf(config.appUrl);

  app.addHook('onRequest', async (req, reply) => {
    if (!STATE_CHANGING.has(req.method)) return;
    // The matched route, not req.url: the router decodes "/%61pi/…" to "/api/…" but req.url keeps it raw.
    const route = req.routeOptions.url ?? '';
    if (!route.startsWith('/api/') || route.startsWith('/api/admin/')) return;
    if (req.headers.cookie === undefined && !route.startsWith('/api/auth/')) return;

    const { origin, host } = req.headers;
    const from = origin === undefined ? null : hostOf(origin);
    const originOk = origin === undefined || (from !== null && (from === host || from === ownHost));
    if (req.headers['x-bidswipe'] !== '1' || !originOk) return reply.code(403).send({ error: 'csrf' });
  });
}
