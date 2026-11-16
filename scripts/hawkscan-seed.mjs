#!/usr/bin/env node
// Seed data for the HawkScan security scan (.github/workflows/hawkscan.yml), run after the server is up.
//
//   SEED_BASE_URL=http://localhost:8787 GITHUB_ENV=<file> node scripts/hawkscan-seed.mjs
//
// Makes two TEST accounts on the running server (accounts mode) so the scan has real objects to work on:
//   - the scan user: a "find work" electrical company (TEST- name, example.com address, ZIP 95675, 100 miles)
//     with a work profile, a saved bid, its own posted job, and a sealed bid on the other account's job;
//   - a poster ("get work done") who posts the local job the scan user bids on.
// The scan user's password is random per run and goes ONLY to the file named by GITHUB_ENV (as SCAN_USERNAME /
// SCAN_PASSWORD, with the ids the scan's customVariables use). This script prints counts and ids, never a secret.
//
// What it cannot reach: the "awarded" stage (messages, contact, agreement). A job's bids stay open for at least
// one day (CLOSES_IN_DAYS.min in src/jobs/service.ts) and the API has no way to move time, so the messages routes
// answer 403 to the scan user here; they are still requested, which tests their refusal.
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const BASE = (process.env.SEED_BASE_URL || process.env.APP_HOST || 'http://localhost:8787').replace(/\/$/, '');
const OUT = process.env.GITHUB_ENV;
if (!OUT) {
  console.error('hawkscan-seed: GITHUB_ENV is not set: there is nowhere safe to put the scan password.');
  process.exit(1);
}

const run = randomBytes(4).toString('hex');
const password = `${randomBytes(18).toString('base64url')}-Aa1`; // 8 to 128 characters (src/auth/input.ts)

/** One signed-in browser: keeps its cookie, sends x-bidswipe on every request (the CSRF guard). */
function client(label) {
  let cookie = '';
  return {
    async call(method, path, body, expect = [200, 201]) {
      const headers = { 'x-bidswipe': '1' };
      if (cookie) headers.cookie = cookie;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const pair = c.split(';')[0];
        if (pair.startsWith('bs_session=')) cookie = pair;
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      if (!expect.includes(res.status)) {
        // The error code only: a body could echo what was sent.
        throw new Error(`${label}: ${method} ${path} answered ${res.status} ${json?.error ?? ''}`.trim());
      }
      return json;
    },
  };
}

const scanEmail = `scan-${run}@example.com`;
const scan = client('scan user');
const poster = client('poster');

await scan.call('POST', '/api/auth/signup', { email: scanEmail, password, name: 'TEST HawkScan User (simulated)' });
await scan.call('PUT', '/api/profile', {
  intent: 'work', businessName: `TEST HawkScan Electric ${run} (simulated)`, trades: ['electrical'],
  zip: '95675', radiusMi: 100, valueRange: { min: 10000, max: 500000 },
});
await scan.call('PUT', '/api/work-profile', {
  headline: 'TEST Licensed electrician (simulated)', about: 'TEST work profile for the security scan (simulated).',
  yearsExperience: 12, skills: ['Panel upgrades', 'Lighting'], insured: 'yes',
});
const me = await scan.call('GET', '/api/me');

await poster.call('POST', '/api/auth/signup', {
  email: `scan-poster-${run}@example.com`, password: `${randomBytes(18).toString('base64url')}-Bb2`, name: 'TEST HawkScan Poster (simulated)',
});
await poster.call('PUT', '/api/profile', {
  intent: 'hire', businessName: `TEST HawkScan Homeowner ${run} (simulated)`, trades: [], zip: '95675', radiusMi: 25,
  valueRange: { min: 0, max: 250000 },
});
const posterMe = await poster.call('GET', '/api/me');

const job = (title) => ({
  title, description: 'Swap a breaker and test the circuit. TEST job for the security scan (simulated).',
  trades: ['electrical'], zip: '95675', address: '9 TEST Lane (simulated)', phone: '916-555-0142',
  budgetMaxCents: 90000, closesInDays: 3,
});
const theirJob = (await poster.call('POST', '/api/jobs', job('TEST Replace a garage subpanel (simulated)'), [201])).job;
const ownJob = (await scan.call('POST', '/api/jobs', job('TEST Hang four porch lights (simulated)'), [201])).job;
await scan.call('POST', `/api/jobs/${theirJob.id}/bid`, { amountCents: 42000, agree: true, note: 'TEST bid (simulated)' });

// A stored bid for the feed, bid and market routes: the first board bid Browse shows this profile, saved. The
// captured bids close over time (fixture mode stores them as they were on 2026-11-13); with none open, the poster's
// job, mirrored into the feed as local:<id>, stands in.
const feed = await scan.call('GET', '/api/feed?all=1&limit=50&tier=all');
const board = (feed.items ?? []).find((b) => !String(b.id).startsWith('local:')) ?? feed.items?.[0] ?? { id: `local:${theirJob.id}` };
if (!feed.items?.length) console.log('hawkscan-seed: the feed is empty (no captured bid is still open): using the local job');
await scan.call('POST', '/api/swipe', { bidId: board.id, action: 'save' }, [200, 404]);

const values = {
  SCAN_USERNAME: scanEmail,
  SCAN_PASSWORD: password,
  SCAN_JOB_ID: theirJob.id,
  SCAN_OWN_JOB_ID: ownJob.id,
  SCAN_BID_ID: board.id,
  SCAN_PERSON_ID: posterMe.account.id,
};
appendFileSync(OUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));

console.log(`hawkscan-seed: 2 TEST accounts on ${BASE} (scan user ${me.account.id}, poster ${posterMe.account.id})`);
console.log(`hawkscan-seed: jobs ${theirJob.id} (poster's, 1 sealed bid from the scan user) and ${ownJob.id} (the scan user's own)`);
console.log(`hawkscan-seed: feed total ${feed.total}, saved bid ${board.id}`);
console.log(`hawkscan-seed: wrote ${Object.keys(values).length} values to GITHUB_ENV (the password is not printed)`);
console.log('hawkscan-seed: not reached: the awarded stage (bids stay open at least 1 day; no clock in the API)');
