import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { JWTVerifyGetKey } from 'jose';
import type { AppConfig } from '../context.js';
import {
  createAccount, findAccountByIdentity, findCredentials, linkVerifiedIdentity, recordLogin, setPasswordHash,
} from '../db/accounts.js';
import type { Db } from '../db/db.js';
import type { Account } from '../types.js';
import { cleanName, normalizeEmail } from './input.js';
import {
  DEFAULT_COST, hashPassword, isAcceptablePassword, needsRehash, PASSWORD_MAX, passwordLength, verifyPassword, type ScryptCost,
} from './password.js';
import { closeSession, openSession, resolveSession } from './sessions.js';
import { OAUTH_PROVIDERS, supabaseKeys, verifySupabaseToken } from './supabase.js';

/**
 * Who is signed in. The request context (src/context.ts) calls this on every request in accounts
 * mode; single mode never does. Keep it to this one method — tests and the context build fakes of it.
 */
export interface AuthService {
  /** The account behind the request's session, or null. A bad or expired session is null, never a throw. */
  authenticate(req: FastifyRequest): Promise<Account | null>;
}

/** Why a sign-up or sign-in was refused. src/routes/auth.ts turns each into a status and a message. */
export type SignInError =
  | 'invalid_email' | 'invalid_password' | 'invalid_name' | 'signup_failed' | 'invalid_credentials'
  | 'oauth_not_configured' | 'invalid_token' | 'oauth_unavailable' | 'provider_not_supported' | 'email_not_verified';

export type SignInResult =
  /** `token` is the new session's cookie value: hand it to the browser and nowhere else. */
  | { ok: true; account: Account; token: string }
  /** `detail` is for the server log only (a jose error code; never token or password content). */
  | { ok: false; error: SignInError; detail?: string };

/** What createAuth() returns: AuthService plus the operations behind the /api/auth routes. */
export interface SignInService extends AuthService {
  signUp(input: { email?: unknown; password?: unknown; name?: unknown }): Promise<SignInResult>;
  logIn(input: { email?: unknown; password?: unknown }): Promise<SignInResult>;
  /** Sign in with a Supabase access token (Google / Apple / Microsoft). */
  oauth(accessToken: unknown): Promise<SignInResult>;
  /** End the session the request carries. Safe when there is none. */
  logOut(req: FastifyRequest): Promise<void>;
}

export const isSignInService = (auth: AuthService): auth is SignInService => typeof (auth as Partial<SignInService>).signUp === 'function';

export interface AuthOptions {
  /** Injectable clock (tests). */
  now?: () => Date;
  /** scrypt cost for new hashes. Tests lower it; leave it alone otherwise. */
  cost?: ScryptCost;
  /** Signing keys for Supabase tokens. Default: the project's published key set. Tests pass a local one. */
  supabaseKeys?: JWTVerifyGetKey;
}

const failed = (error: SignInError, detail?: string): SignInResult => ({ ok: false, error, detail });

export function createAuth(db: Db, config: AppConfig, opts: AuthOptions = {}): SignInService {
  const now = opts.now ?? (() => new Date());
  const cost = opts.cost ?? DEFAULT_COST;
  const projectUrl = config.supabase?.url;
  let keys = opts.supabaseKeys;

  // A throwaway hash to check a password against when the address has no password to check.
  let decoy: Promise<string> | undefined;
  const decoyHash = (): Promise<string> =>
    (decoy ??= hashPassword(randomBytes(32).toString('base64'), cost).catch((err: unknown) => {
      decoy = undefined; // do not keep a failure: the next sign-in tries again
      throw err;
    }));

  const signedIn = async (account: Account): Promise<SignInResult> => ({ ok: true, account, token: await openSession(db, account.id, now()) });

  /** Where a new provider identity with a VERIFIED email lands: a new account, or the one that has the email. */
  const accountFor = async (provider: string, subject: string, email: string, name: string | null): Promise<Account> => {
    const created = await createAccount(db, { id: randomUUID(), email, name, passwordHash: null }, now(), { provider, subject });
    if (created) return created;
    const existing = (await findCredentials(db, email))!.account; // createAccount only refuses a taken email
    await linkVerifiedIdentity(db, provider, subject, existing.id);
    return existing;
  };

  return {
    authenticate: (req) => resolveSession(db, req, now()),

    async signUp(input) {
      const email = normalizeEmail(input.email);
      const name = cleanName(input.name);
      if (!email) return failed('invalid_email');
      if (!isAcceptablePassword(input.password)) return failed('invalid_password');
      if (name === undefined) return failed('invalid_name');
      // Hash before looking: a taken address costs the same time as a free one.
      const passwordHash = await hashPassword(input.password, cost);
      const account = await createAccount(db, { id: randomUUID(), email, name, passwordHash }, now());
      return account ? signedIn(account) : failed('signup_failed');
    },

    async logIn(input) {
      const email = normalizeEmail(input.email);
      const { password } = input;
      // Turned away without a hash only when the input alone rules it out (nothing stored is over the maximum).
      if (!email || typeof password !== 'string' || password === '' || passwordLength(password) > PASSWORD_MAX) {
        return failed('invalid_credentials');
      }
      const found = await findCredentials(db, email);
      // Unknown address, or an account with no password: still run one hash, against the decoy,
      // so the answer takes as long as a wrong password does.
      const stored = found?.passwordHash ?? (await decoyHash());
      const matches = await verifyPassword(password, stored);
      if (!found?.passwordHash || !matches) return failed('invalid_credentials');

      if (needsRehash(stored, cost)) await setPasswordHash(db, found.account.id, await hashPassword(password, cost));
      await recordLogin(db, found.account.id, now());
      return signedIn(found.account);
    },

    async oauth(accessToken) {
      if (!projectUrl) return failed('oauth_not_configured');
      if (typeof accessToken !== 'string') return failed('invalid_token');
      keys ??= supabaseKeys(projectUrl);
      const check = await verifySupabaseToken(accessToken, { projectUrl, keys, now: now() });
      if (!check.ok) return failed(check.reason === 'unavailable' ? 'oauth_unavailable' : 'invalid_token', check.code);

      const { provider, subject, email, emailVerified, name } = check.identity;
      if (!provider || !OAUTH_PROVIDERS.includes(provider)) return failed('provider_not_supported');
      let account = await findAccountByIdentity(db, provider, subject);
      if (!account) {
        // First sign-in with this identity. Accounts are keyed on the email, so an unverified one
        // gets nothing: opening an account for it would squat the address, and linking it would
        // hand the address's account to whoever typed it.
        if (!email || !emailVerified) return failed('email_not_verified');
        account = await accountFor(provider, subject, email, name);
      }
      await recordLogin(db, account.id, now());
      return signedIn(account);
    },

    logOut: (req) => closeSession(db, req),
  };
}
