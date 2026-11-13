/**
 * Promo codes that unlock BidSwipe Pro for free (web + Microsoft Store builds only — see below).
 *
 * The codes live ONLY in the host's environment, never in this repository: a public repo with a free-Pro
 * code in it gives everyone Pro. Format of PROMO_CODES, comma-separated entries:
 *
 *   CODE:plan[:maxUses][:expiresISO]
 *   e.g.  A&Btest:pro                        any number of accounts, never expires
 *         TEST-PROMO:pro:100:2027-01-01      the first 100 accounts, until 2027-01-01T00:00Z
 *         TEST-PROMO:pro::2027-01-01         no use limit, with an expiry (empty maxUses = no limit)
 *
 * Only plan 'pro' is accepted (a code must never hand out 'pilot' or anything new by accident). A bad entry
 * is skipped with one log line that names its position and the reason, never the code itself (the log is
 * not a secret store), and the server keeps running.
 *
 * Apple guideline 3.1.1: an iOS App Store build may not unlock features with its own codes. That build
 * sends `x-bidswipe-store: ios`; the server then says promo: false and refuses a redeem (src/routes/auth.ts).
 * The web app and the Microsoft Store build may show the box.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export interface PromoCode {
  /** sha256 of the normalized code (normalizeCode). The plain code is not kept after parsing. */
  key: Buffer;
  /** The same key as hex: what the redemptions table stores, so the code itself is never written down. */
  keyHex: string;
  plan: 'pro';
  /** How many different accounts may redeem it. null = no limit. */
  maxUses: number | null;
  /** The code stops working at this instant. null = never. */
  expiresAt: Date | null;
}

/** Longer than any code anyone will type; anything longer is refused before hashing. */
export const CODE_MAX = 64;

/**
 * One spelling for one code: trimmed, Unicode NFKC (so a full-width "Ｌ" or a ligature typed on a phone
 * matches the plain letter), then lower case. "a&btest", " A&BTEST " and "A&Btest" are equal.
 */
export function normalizeCode(raw: string): string {
  return raw.trim().normalize('NFKC').toLowerCase();
}

/** The key a code is stored and compared under. */
export const codeKey = (raw: string): Buffer => createHash('sha256').update(normalizeCode(raw), 'utf8').digest();

/** Parse PROMO_CODES. Never throws: a malformed entry is logged (without the code) and skipped. */
export function parsePromoCodes(value: string | undefined, log: (msg: string) => void = () => {}): PromoCode[] {
  if (!value?.trim()) return [];
  const codes: PromoCode[] = [];
  const seen = new Set<string>();
  value.split(',').forEach((raw, i) => {
    const entry = raw.trim();
    if (!entry) return; // a trailing comma is not worth a warning
    const skip = (why: string) => log(`PROMO_CODES: entry ${i + 1} skipped (${why})`);
    // The expiry is everything after the third ':' — an ISO time has colons of its own (2027-01-01T08:00:00Z).
    const [code = '', plan = '', uses = '', ...rest] = entry.split(':').map((s) => s.trim());
    const expires = rest.join(':');
    const normalized = normalizeCode(code);
    if (!normalized) return skip('empty code');
    if (normalized.length > CODE_MAX) return skip(`code longer than ${CODE_MAX} characters`);
    if (plan.toLowerCase() !== 'pro') return skip('plan must be "pro"');
    let maxUses: number | null = null;
    if (uses !== '') {
      if (!/^\d+$/.test(uses) || Number(uses) < 1) return skip('maxUses must be a whole number of 1 or more');
      maxUses = Number(uses);
    }
    let expiresAt: Date | null = null;
    if (expires !== '') {
      // ISO only (2027-01-01 or 2027-01-01T08:00:00Z): Date.parse also takes loose text, which hides typos.
      const t = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(expires) ? Date.parse(expires) : Number.NaN;
      if (!Number.isFinite(t)) return skip('expiresISO must be an ISO date such as 2027-01-01');
      expiresAt = new Date(t);
    }
    const key = codeKey(code);
    const keyHex = key.toString('hex');
    if (seen.has(keyHex)) return skip('the same code is listed twice; the first one counts');
    seen.add(keyHex);
    // A code with neither limit works for anyone who learns it, for ever. Allowed (Ev may want that), but said
    // once at start-up, by position only, so whoever set it can add ":<uses>:<date>".
    if (maxUses === null && expiresAt === null) log(`PROMO_CODES: entry ${i + 1} has no use limit and no expiry`);
    codes.push({ key, keyHex, plan: 'pro', maxUses, expiresAt });
  });
  return codes;
}

/**
 * The configured code a typed code matches, or null. Every configured key is compared, in constant time,
 * without stopping at a hit, so the time taken does not tell how close a guess was or which code it hit.
 * (Hashing first makes every comparison the same length, which timingSafeEqual needs.)
 */
export function findCode(codes: readonly PromoCode[], typed: unknown): PromoCode | null {
  if (typeof typed !== 'string') return null;
  const normalized = normalizeCode(typed);
  if (!normalized || normalized.length > CODE_MAX) return null;
  const key = codeKey(normalized);
  let hit: PromoCode | null = null;
  for (const c of codes) if (timingSafeEqual(c.key, key) && !hit) hit = c;
  return hit;
}

/** Still inside its expiry? (Use limits are counted in the database: src/db/promo.ts.) */
export const isLive = (code: PromoCode, now: Date): boolean => code.expiresAt === null || now.getTime() < code.expiresAt.getTime();
