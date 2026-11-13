import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { deleteExpiredSessions, deleteSession, extendSession, findSession, insertSession } from '../db/accounts.js';
import type { Db } from '../db/db.js';
import type { Account } from '../types.js';

const SESSION_COOKIE = 'bs_session';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A session lives 30 days past its last use ("sliding"). */
const SESSION_TTL_MS = 30 * DAY_MS;
/** The expiry is pushed out at most once a day: one write a day for a busy session, not one per request. */
const RENEW_AFTER_MS = DAY_MS;

/** 256 random bits as 43 base64url characters. */
const newToken = (): string => randomBytes(32).toString('base64url');
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Only this hash is stored, so a copy of the sessions table cannot be replayed as cookies. */
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** The session token in the request's Cookie header, if there is one shaped like ours. */
function readSessionToken(req: FastifyRequest): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return TOKEN_SHAPE.test(value) ? value : null;
  }
  return null;
}

/** A Set-Cookie value for the session. `token` null tells the browser to drop it. */
export function sessionCookie(token: string | null, secure: boolean): string {
  const maxAge = token ? SESSION_TTL_MS / 1000 : 0;
  return `${SESSION_COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

/** Start a session and return its token (the only time it exists outside the browser). */
export async function openSession(db: Db, accountId: string, now: Date): Promise<string> {
  await deleteExpiredSessions(db, now); // every sign-in sweeps out the dead rows
  const token = newToken();
  await insertSession(db, hashToken(token), accountId, now, new Date(now.getTime() + SESSION_TTL_MS));
  return token;
}

/** End the session the request carries, if any. */
export async function closeSession(db: Db, req: FastifyRequest): Promise<void> {
  const token = readSessionToken(req);
  if (token) await deleteSession(db, hashToken(token));
}

const renewed = new WeakMap<FastifyRequest, string>();

/** The token whose expiry this request pushed out, so the response can renew the cookie as well. */
export const renewedToken = (req: FastifyRequest): string | null => renewed.get(req) ?? null;

/** The account behind the request's session cookie, or null. Slides the expiry of a session in use. */
export async function resolveSession(db: Db, req: FastifyRequest, now: Date): Promise<Account | null> {
  const token = readSessionToken(req);
  if (!token) return null;
  const hash = hashToken(token);
  const found = await findSession(db, hash, now);
  if (!found) return null;
  if (found.expiresAt.getTime() - now.getTime() < SESSION_TTL_MS - RENEW_AFTER_MS) {
    await extendSession(db, hash, new Date(now.getTime() + SESSION_TTL_MS));
    renewed.set(req, token);
  }
  return found.account;
}
