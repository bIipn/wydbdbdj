import { createHash, randomBytes } from 'node:crypto';

/**
 * Secret tokens the server hands out once and then recognises again: a session's cookie value
 * (src/auth/sessions.ts) and a password reset link (src/auth/index.ts startReset). Same recipe for both.
 */

/** 256 random bits as 43 base64url characters. */
export const newToken = (): string => randomBytes(32).toString('base64url');

/** What one of our tokens looks like. Anything else is not looked up at all. */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Only this hash is stored, so a copy of the table cannot be replayed as cookies or reset links. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
