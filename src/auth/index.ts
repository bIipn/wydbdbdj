import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { JWTVerifyGetKey } from 'jose';
import type { AppConfig } from '../context.js';
import {
  createAccount, findAccountByIdentity, findCredentials, findCredentialsById, isLiveResetToken, linkVerifiedIdentity, recordLogin,
  replaceResetToken, setPasswordHash, useResetToken,
} from '../db/accounts.js';
import type { Db } from '../db/db.js';
import type { Account } from '../types.js';
import { cleanName, normalizeEmail } from './input.js';
import {
  DEFAULT_COST, hashPassword, isAcceptablePassword, needsRehash, PASSWORD_MAX, passwordLength, verifyPassword, type ScryptCost,
} from './password.js';
import { closeSession, openSession, resolveSession, sessionAgeMs } from './sessions.js';
import { OAUTH_PROVIDERS, supabaseKeys, verifySupabaseToken } from './supabase.js';
import { hashToken, newToken, TOKEN_SHAPE } from './tokens.js';

/** A password reset link works once, for this long. */
export const RESET_TTL_MS = 60 * 60 * 1000;
/** An account with no password proves it is its owner by a sign-in no older than this (see confirmOwner). */
export const RECENT_SIGN_IN_MS = 10 * 60 * 1000;

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
  | 'oauth_not_configured' | 'invalid_token' | 'oauth_unavailable' | 'provider_not_supported' | 'email_not_verified'
  /** A reset link that was never ours, was used already, or ran out: one answer for all three. */
  | 'reset_link_invalid';

/** How an account proves it is still its owner asking: its password, or (it has none) a sign-in minutes ago. */
export type OwnerCheck = 'password' | 'recent_sign_in';

export type OwnerResult =
  | { ok: true }
  /**
   * wrong_password: not the account's password. recent_sign_in_required: the account has no password and its
   * session is older than RECENT_SIGN_IN_MS. confirm_mismatch: such an account did not type its own email.
   */
  | { ok: false; error: 'wrong_password' | 'recent_sign_in_required' | 'confirm_mismatch' };

/** A reset link to email: the token exists only here and in that one email, the database keeps its hash. */
export interface ResetLink {
  email: string;
  token: string;
  expiresAt: Date;
}

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
  /**
   * "Forgot password": a new reset link for the account with this email, or null when there is nothing to send
   * (not an address, no account, or an account that signs in through a provider and has no password). The caller
   * emails it and answers the same either way. Asking again replaces the earlier link.
   */
  startReset(email: unknown): Promise<ResetLink | null>;
  /**
   * Set a new password with a reset link's token. On success every session of the account is ended and a new
   * one opened for this browser. Errors: invalid_password, reset_link_invalid.
   */
  finishReset(input: { token?: unknown; password?: unknown }): Promise<SignInResult>;
  /** Which proof confirmOwner will ask this account for. */
  ownerCheck(account: Account): Promise<OwnerCheck>;
  /**
   * Is it the account's owner asking, right now? Asked before something that cannot be undone (deleting the
   * account). An account with a password must give it again. An account without one (it signs in through
   * Google, Apple or Microsoft) has nothing to type that a borrowed phone does not already show, so it needs a
   * session opened in the last RECENT_SIGN_IN_MS, which means signing in again, and its own email as `confirm`.
   */
  confirmOwner(req: FastifyRequest, account: Account, input: { password?: unknown; confirm?: unknown }): Promise<OwnerResult>;
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

    async startReset(input) {
      const email = normalizeEmail(input);
      const found = email ? await findCredentials(db, email) : null;
      if (!found?.passwordHash) return null;
      const token = newToken();
      const at = now();
      const expiresAt = new Date(at.getTime() + RESET_TTL_MS);
      await replaceResetToken(db, found.account.id, hashToken(token), at, expiresAt);
      return { email: found.account.email, token, expiresAt };
    },

    async finishReset(input) {
      if (!isAcceptablePassword(input.password)) return failed('invalid_password');
      const { token } = input;
      if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return failed('reset_link_invalid');
      const tokenHash = hashToken(token);
      // Looked at before the hash is computed: a made-up token must not cost 128 MiB of scrypt. The write
      // below checks the link again, in its own WHERE, so two requests with one link cannot both win.
      if (!(await isLiveResetToken(db, tokenHash, now()))) return failed('reset_link_invalid');
      const passwordHash = await hashPassword(input.password, cost);
      const account = await useResetToken(db, tokenHash, passwordHash, now());
      if (!account) return failed('reset_link_invalid');
      await recordLogin(db, account.id, now());
      return signedIn(account);
    },

    async ownerCheck(account) {
      return (await findCredentialsById(db, account.id))?.passwordHash ? 'password' : 'recent_sign_in';
    },

    async confirmOwner(req, account, input) {
      const stored = (await findCredentialsById(db, account.id))?.passwordHash ?? null;
      if (stored) {
        const { password } = input;
        if (typeof password !== 'string' || password === '' || passwordLength(password) > PASSWORD_MAX) return { ok: false, error: 'wrong_password' };
        return (await verifyPassword(password, stored)) ? { ok: true } : { ok: false, error: 'wrong_password' };
      }
      const age = await sessionAgeMs(db, req, now());
      if (age === null || age > RECENT_SIGN_IN_MS) return { ok: false, error: 'recent_sign_in_required' };
      return normalizeEmail(input.confirm) === account.email ? { ok: true } : { ok: false, error: 'confirm_mismatch' };
    },
  };
}
