import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../context.js';
import type { Db } from '../db/db.js';
import type { Account } from '../types.js';

/**
 * Who is signed in. The request context (src/context.ts) calls this on every request in accounts
 * mode; single mode never does. Keep it to this one method — tests and the context build fakes of it.
 */
export interface AuthService {
  /** The account behind the request's session, or null. A bad or expired session is null, never a throw. */
  authenticate(req: FastifyRequest): Promise<Account | null>;
}

/** STUB (foundation): nobody is ever signed in. The auth builder replaces the body. */
export function createAuth(_db: Db, _config: AppConfig): AuthService {
  return { authenticate: async () => null };
}
