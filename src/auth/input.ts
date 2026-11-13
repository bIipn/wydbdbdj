/** What people type into the sign-up and sign-in forms, cleaned up. Pure. */

const EMAIL_MAX = 254; // longest address SMTP can carry
const NAME_MAX = 80;

/** Trimmed and lower-cased, or null when it is not an email address. Accounts are keyed on this form. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const email = input.trim().toLowerCase();
  return email.length <= EMAIL_MAX && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email) ? email : null;
}

/** A display name: trimmed text or null when left out. `undefined` when it is not usable (not text, too long). */
export function cleanName(input: unknown): string | null | undefined {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') return undefined;
  const name = input.trim().replace(/\s+/g, ' ');
  return name.length > NAME_MAX ? undefined : name || null;
}
