import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { cleanName, normalizeEmail } from './input.js';

/**
 * Google / Apple / Microsoft sign-in goes through Supabase Auth: the browser signs in there and posts
 * the access token (a JWT) to POST /api/auth/oauth. This module checks that token. Pure apart from
 * fetching the project's public keys.
 *
 * Checked against the Supabase docs on 2026-11-13:
 * - Keys: GET <project>/auth/v1/.well-known/jwks.json lists the project's asymmetric public signing
 *   keys — ES256 (recommended) or RS256. Supabase's edge caches it for 10 minutes and asks apps not to
 *   cache longer; jose's remote key set keeps keys for 10 minutes and refetches on an unknown key id.
 *   https://supabase.com/docs/guides/auth/jwts#verifying-a-jwt-from-supabase · .../guides/auth/signing-keys
 * - A project still on the legacy shared secret signs with HS256 and publishes NO keys there. Its
 *   tokens are refused here (HS256 is never accepted): move the project to asymmetric signing keys.
 * - Claims: iss = <project>/auth/v1, aud = "authenticated" for a signed-in user, exp, sub (user id),
 *   email, is_anonymous, app_metadata.provider. https://supabase.com/docs/guides/auth/jwt-fields
 * - There is NO standard "email verified" claim. The provider's answer is copied into
 *   user_metadata.email_verified, and user_metadata can be edited by the user (Supabase's database
 *   advisor has a lint against security rules that read it). So "verified" is only as strong as two things the
 *   user cannot change: app_metadata.provider (checked against OAUTH_PROVIDERS by the caller), and the
 *   project keeping "Confirm email" and "Secure email change" ON, so the email claim itself is always a
 *   confirmed address. If the project adds a top-level boolean email_verified claim with a Custom
 *   Access Token Hook, that claim is used instead.
 */

/** The Supabase provider ids this app offers. Tokens from any other sign-in method are refused. */
export const OAUTH_PROVIDERS: readonly string[] = ['google', 'apple', 'azure'];

/** Asymmetric only: the shared-secret algorithms and "none" must never verify. */
const ALGORITHMS = ['ES256', 'RS256'];

export interface SupabaseIdentity {
  /** app_metadata.provider — how the Supabase user first signed up (e.g. "google"). */
  provider: string | null;
  /** The Supabase user id. */
  subject: string;
  /** Lower-cased, or null when the token carries no usable address. */
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export type TokenCheck =
  | { ok: true; identity: SupabaseIdentity }
  /** `code` is for the server log only (a jose error code, never token content). */
  | { ok: false; reason: 'invalid' | 'unavailable'; code: string };

export interface VerifyOptions {
  /** config.supabase.url, no trailing slash. */
  projectUrl: string;
  /** Resolves the signing key for a token. Production: supabaseKeys(projectUrl). Tests: a local key set. */
  keys: JWTVerifyGetKey;
  now: Date;
}

/** The project's published signing keys, fetched on first use and cached by jose. */
export function supabaseKeys(projectUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(`${projectUrl}/auth/v1/.well-known/jwks.json`));
}

/** jose error codes that mean "this token is no good" — as opposed to "the keys could not be fetched". */
const TOKEN_FAULTS = new Set([
  'ERR_JWT_EXPIRED', 'ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWT_INVALID', 'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED', 'ERR_JOSE_ALG_NOT_ALLOWED', 'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWKS_NO_MATCHING_KEY', 'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
]);

const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** Verify signature, issuer, audience and expiry of a Supabase access token and read who it is for. */
export async function verifySupabaseToken(token: string, opts: VerifyOptions): Promise<TokenCheck> {
  try {
    const { payload } = await jwtVerify(token, opts.keys, {
      issuer: `${opts.projectUrl}/auth/v1`,
      audience: 'authenticated',
      algorithms: ALGORITHMS,
      requiredClaims: ['exp', 'sub'],
      currentDate: opts.now,
    });
    const subject = payload.sub;
    if (typeof subject !== 'string' || subject === '') return { ok: false, reason: 'invalid', code: 'ERR_JWT_INVALID' };
    const app = record(payload.app_metadata);
    const user = record(payload.user_metadata);
    const verified = typeof payload.email_verified === 'boolean' ? payload.email_verified : user.email_verified === true;
    const email = normalizeEmail(payload.email);
    return {
      ok: true,
      identity: {
        provider: typeof app.provider === 'string' ? app.provider : null,
        subject,
        email,
        emailVerified: verified && email !== null && payload.is_anonymous !== true,
        name: cleanName(user.full_name ?? user.name) ?? null,
      },
    };
  } catch (err) {
    const code = err instanceof errors.JOSEError ? err.code : 'ERR_FETCH';
    return { ok: false, reason: TOKEN_FAULTS.has(code) ? 'invalid' : 'unavailable', code };
  }
}
