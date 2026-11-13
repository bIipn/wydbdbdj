import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with scrypt from node:crypto (no dependency).
 *
 * Cost: the OWASP Password Storage Cheat Sheet (checked 2026-11-13,
 * https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt) asks for at
 * least N = 2^17, r = 8, p = 1 for scrypt — about 128 MiB per hash. DEFAULT_COST is that minimum.
 * The cost is written into every hash, so it can be raised later: logins re-hash old ones (needsRehash).
 *
 * Stored form (PHC string, unpadded base64): $scrypt$ln=17,r=8,p=1$<16-byte salt>$<32-byte key>
 */
export interface ScryptCost {
  /** log2 of N, the CPU/memory cost. */
  ln: number;
  /** Block size. */
  r: number;
  /** Parallelization. */
  p: number;
}

export const DEFAULT_COST: ScryptCost = { ln: 17, r: 8, p: 1 };

/** Length limits, counted in characters (code points). No composition rules. */
const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** A stored hash that claims to need more than this is not run: a corrupt row must not exhaust memory. */
const MAX_MEMORY_BYTES = 1024 ** 3;

/** scrypt's working memory: 128 · r · N bytes. */
const memoryBytes = (cost: ScryptCost): number => 128 * cost.r * 2 ** cost.ln;

/** The same password typed on two keyboards can differ in bytes (é as one code point or two); NFKC makes them one. */
const normalize = (password: string): string => password.normalize('NFKC');

/** A password's length the way the limits count it: characters, after normalizing. */
export const passwordLength = (password: string): number => [...normalize(password)].length;

/** A string of 8 to 128 characters. Nothing else is required of a password. */
export function isAcceptablePassword(password: unknown): password is string {
  if (typeof password !== 'string') return false;
  const length = passwordLength(password);
  return length >= PASSWORD_MIN && length <= PASSWORD_MAX;
}

// Each hash holds ~128 MiB and one of libuv's four pool threads, which file reads also use.
// Two at a time keeps a burst of sign-ins from starving the rest of the server.
const MAX_PARALLEL = 2;
let running = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(job: () => Promise<T>): Promise<T> {
  if (running < MAX_PARALLEL) running++;
  else await new Promise<void>((go) => waiting.push(go)); // the finishing job hands its slot over
  try {
    return await job();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

function derive(password: string, salt: Buffer, cost: ScryptCost, keyBytes: number): Promise<Buffer> {
  // Node refuses scrypt above `maxmem` (32 MiB by default): allow what this cost needs, plus the small per-p blocks.
  const maxmem = memoryBytes(cost) + 128 * cost.r * (cost.p + 2) + 1024 * 1024;
  return withSlot(() => new Promise<Buffer>((done, fail) => {
    scrypt(normalize(password), salt, keyBytes, { N: 2 ** cost.ln, r: cost.r, p: cost.p, maxmem }, (err, key) => (err ? fail(err) : done(key)));
  }));
}

const b64 = (buf: Buffer): string => buf.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string, cost: ScryptCost = DEFAULT_COST): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, cost, KEY_BYTES);
  return `$scrypt$ln=${cost.ln},r=${cost.r},p=${cost.p}$${b64(salt)}$${b64(key)}`;
}

interface Parsed { cost: ScryptCost; salt: Buffer; key: Buffer }

function parse(stored: string): Parsed | null {
  const m = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(stored);
  if (!m) return null;
  const cost = { ln: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  if (cost.ln < 1 || cost.r < 1 || cost.p < 1 || cost.p > 16 || memoryBytes(cost) > MAX_MEMORY_BYTES) return null;
  const [salt, key] = [Buffer.from(m[4]!, 'base64'), Buffer.from(m[5]!, 'base64')];
  return salt.length > 0 && key.length > 0 ? { cost, salt, key } : null;
}

/** True when `password` matches the stored hash. An unreadable hash matches nothing. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.cost, parsed.key.length);
  return timingSafeEqual(key, parsed.key);
}

/** True when a stored hash was made with a lower cost than `cost` (or cannot be read): hash it again at the next login. */
export function needsRehash(stored: string, cost: ScryptCost = DEFAULT_COST): boolean {
  const have = parse(stored)?.cost;
  return !have || have.ln < cost.ln || have.r < cost.r || have.p < cost.p;
}
