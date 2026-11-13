import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../context.js';

/**
 * CSRF guard for accounts mode: every state-changing /api request must carry `x-bidswipe: 1`
 * or get 403 { error: 'csrf' }. buildApp() calls this once, right after the access-code hook.
 *
 * STUB (foundation): registers nothing. The auth builder replaces the body.
 */
export function registerCsrfGuard(_app: FastifyInstance, _config: AppConfig): void {}
