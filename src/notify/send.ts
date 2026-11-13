import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Db } from '../db/db.js';
import { getUnnotified, markNotified } from '../db/repo.js';
import type { Profile } from '../types.js';
import { buildDigest } from './digest.js';

export interface NotifyConfig {
  resendApiKey?: string;
  from?: string;
  to: string[];
  appUrl: string;
  outDir?: string;
  log?: (m: string) => void;
}

/**
 * Sends the "new matches" digest. With a Resend key it emails; without one it
 * writes data/digest-latest.html so you can see exactly what would have gone out.
 * Bids are only marked notified after a successful send, so nothing gets lost.
 */
export async function sendDigest(db: Db, profile: Profile, cfg: NotifyConfig, now = new Date()) {
  const log = cfg.log ?? console.log;
  const items = await getUnnotified(db, profile.id, profile.notify.minScore, now);
  if (items.length === 0) {
    log(`digest ${profile.id}: nothing new`);
    return { sent: false, count: 0 };
  }
  const digest = buildDigest(profile, items, cfg.appUrl, now);

  if (cfg.resendApiKey && cfg.from && cfg.to.length > 0) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.from, to: cfg.to, subject: digest.subject, html: digest.html, text: digest.text }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Resend rejected the digest: ${res.status} ${await res.text()}`);
    await markNotified(db, profile.id, items.map((i) => i.id));
    log(`digest ${profile.id}: emailed ${items.length} to ${cfg.to.join(', ')}`);
    return { sent: true, count: items.length };
  }

  const dir = cfg.outDir ?? resolve(process.cwd(), 'data');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, 'digest-latest.html');
  writeFileSync(file, digest.html);
  log(`digest ${profile.id}: ${items.length} new (no RESEND_API_KEY — wrote ${file})\n${digest.text}`);
  return { sent: false, count: items.length, file };
}
