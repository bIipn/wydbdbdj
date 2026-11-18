#!/usr/bin/env node
// Tap targets on the main screens at 390x844 (docs/PLAN.md R3, N9): every visible a / button / input / select /
// textarea / summary / [role=button] / label-for-a-hidden-control whose HIT box is under 44 x 44 CSS px.
//
// The hit box is measured, not read from CSS: from a point inside the control, step outwards along its row and its
// column while document.elementFromPoint() still lands on the control (a ::before hit area counts, anything drawn on
// top of it does not). A link inside a sentence is listed apart: WCAG 2.5.5 exempts inline targets.
//
// It is a check you run by hand (Playwright is not a dependency of the repo; it is installed globally here), against
// YOUR OWN local server in accounts mode with the fixture bids loaded. It writes: it signs up two TEST accounts
// (example.com) and, with --seed, posts a TEST job. It refuses any host but localhost / 127.0.0.1.
//
//   DATA_DIR=/tmp/taps SOURCES=fixtures npm run scan -- --fixtures
//   PORT=8832 AUTH_MODE=accounts DATA_DIR=/tmp/taps SOURCES=fixtures npx tsx src/server.ts &
//   node scripts/measure-taps.mjs --url http://127.0.0.1:8832 --seed [--onboarding] [--out /tmp/taps-shots] [--json out.json]
//   (--width 1280 --height 900 for the desk layout; --onboarding signs up one more TEST account each run)
//
// (NODE_PATH=$(npm root -g) when Playwright is installed globally.) Exit code 0 always: it reports, it does not judge.
// A conversation is measured only if the account has one (an awarded job: that needs the job's closing time to pass).

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : null)).filter(Boolean));
const BASE = String(args.url ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error(`measure-taps: ${BASE} is not a local server; this script signs up TEST accounts, so it runs on localhost only.`);
  process.exit(2);
}
const OUT = typeof args.out === 'string' ? args.out : null;
const WIDTH = Number(args.width ?? 390);
const HEIGHT = Number(args.height ?? 844);
const MIN = 44;
const PASSWORD = 'TEST-password-123';
const WORKER = { email: 'taps-worker@example.com', profile: { intent: 'both', businessName: 'TEST Taps Electric (simulated)', trades: ['electrical'], zip: '89410', radiusMi: 90, valueRange: { min: 10000, max: 50000 } } };
const POSTER = { email: 'taps-poster@example.com', profile: { intent: 'hire', businessName: 'TEST Poster (simulated)', trades: [], zip: '89410' } };

async function call(page, url, method = 'GET', body) {
  return page.evaluate(async ({ url, method, body }) => {
    const headers = { 'x-bidswipe': '1' };
    if (body) headers['content-type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json };
  }, { url, method, body });
}

/** Sign in (signing up the first time) and set the profile. */
async function signIn(page, who) {
  await page.goto(BASE + '/');
  let r = await call(page, '/api/auth/signup', 'POST', { email: who.email, password: PASSWORD, name: who.profile.businessName });
  if (r.status >= 400) r = await call(page, '/api/auth/login', 'POST', { email: who.email, password: PASSWORD });
  if (r.status >= 400) throw new Error(`sign-in failed for ${who.email}: ${r.status}`);
  const p = await call(page, '/api/profile', 'PUT', who.profile);
  if (p.status >= 400) throw new Error(`profile failed for ${who.email}: ${p.status}`);
}

/** Runs in the page: every visible control and its measured hit box. */
function measureInPage({ min, screen, scope }) {
  const SEL = 'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"]';
  const tiny = (el) => { const r = el.getBoundingClientRect(); return r.width <= 2 || r.height <= 2 || getComputedStyle(el).opacity === '0'; };
  const shown = (el) => {
    if (el.closest('[hidden], [inert]')) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelOf = (el) => el.closest('label') || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
  /** The element a finger has to hit: a hidden checkbox's label, never a label that only names a text field. */
  const targetOf = (el) => {
    if (el.tagName === 'INPUT' && el.type === 'hidden') return null;
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio' || tiny(el))) return labelOf(el) || el;
    if (el.tagName === 'LABEL') {
      const c = el.control;
      if (!c || !(c.type === 'checkbox' || c.type === 'radio' || tiny(c))) return null;
      return el;
    }
    if (el.disabled) return null;
    return el;
  };
  const describe = (el) => {
    const cls = [...el.classList].slice(0, 3).map((c) => '.' + c).join('');
    const words = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 36);
    return `${el.tagName.toLowerCase()}${cls}${words ? ` "${words}"` : ''}`;
  };
  /** In a sentence: an inline element whose block has other words around it (WCAG 2.5.5's inline exception). */
  const inlineInText = (el) => {
    if (getComputedStyle(el).display !== 'inline') return false;
    let block = el.parentElement;
    while (block && getComputedStyle(block).display === 'inline') block = block.parentElement;
    return !!block && block.textContent.replace(/\s+/g, ' ').trim().length > el.textContent.replace(/\s+/g, ' ').trim().length + 3;
  };

  // An open sheet is modal: what is behind its backdrop is not on this screen.
  const modal = [...document.querySelectorAll('[aria-modal="true"]')].find((m) => shown(m));
  const root = scope ? document.querySelector(scope) : modal ?? document;
  const targets = new Set();
  for (const el of root ? root.querySelectorAll(SEL) : []) {
    if (!shown(el) && !(el.tagName === 'INPUT' && labelOf(el))) continue;
    const t = targetOf(el);
    if (t && shown(t)) targets.add(t);
  }
  const out = [];
  for (const t of targets) {
    const ctrl = t.tagName === 'LABEL' ? t.control : null;
    const owns = (x, y) => {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
      const e = document.elementFromPoint(x, y);
      return !!e && (t === e || t.contains(e) || (!!ctrl && (ctrl === e || ctrl.contains(e))));
    };
    t.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const r = t.getBoundingClientRect();
    // A whole-pixel point inside it that is really its own (hit testing works on whole CSS pixels): the middle,
    // else the owned grid point nearest the middle.
    let seed = null;
    const cx = Math.floor(r.left + r.width / 2), cy = Math.floor(r.top + r.height / 2);
    if (owns(cx, cy)) seed = [cx, cy];
    else {
      let best = Infinity;
      for (let i = 1; i < 8; i++) for (let j = 1; j < 8; j++) {
        const x = Math.floor(r.left + (r.width * i) / 8), y = Math.floor(r.top + (r.height * j) / 8);
        const d = Math.hypot(x - cx, y - cy);
        if (d < best && owns(x, y)) { best = d; seed = [x, y]; }
      }
    }
    const item = { screen, what: describe(t), box: [Math.round(r.width), Math.round(r.height)] };
    if (!seed) { out.push({ ...item, covered: true }); continue; }
    // Whole pixels that land on it, outwards from the seed along its row and its column (capped: 64 each way).
    const reach = (dx, dy) => { let d = 0; while (d < 64 && owns(seed[0] + dx * (d + 1), seed[1] + dy * (d + 1))) d++; return d; };
    const hit = [reach(-1, 0) + reach(1, 0) + 1, reach(0, -1) + reach(0, 1) + 1];
    const small = hit[0] < min || hit[1] < min;
    out.push({ ...item, hit, small, inline: small && inlineInText(t) });
  }
  scrollTo(0, 0);
  return out;
}

async function settle(page, ms = 700) { await page.waitForTimeout(ms); }
async function tab(page, view) { await page.locator(`.tab[data-view="${view}"]`).click(); await settle(page, 900); }
async function closeSheet(page) {
  if (await page.locator('#sheet:not([hidden])').count()) { await page.keyboard.press('Escape'); await settle(page, 400); }
}

(async () => {
  const browser = await chromium.launch();
  const opts = { viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, hasTouch: true, isMobile: false };
  // The poster: one open TEST job near the worker (seeded once).
  if (args.seed) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    await signIn(page, POSTER);
    const mine = await call(page, '/api/jobs/mine');
    const open = (mine.json?.posted ?? []).find((j) => j.status === 'open');
    if (!open) {
      const r = await call(page, '/api/jobs', 'POST', { title: 'TEST Replace two outdoor lights (simulated)', description: 'TEST job for the tap-target walk (simulated). Nothing real here.', trades: ['electrical'], zip: '89410', address: '1 TEST Lane (simulated)', closesInDays: 7, budgetMaxCents: 90000 });
      if (r.status >= 400) throw new Error(`could not post the TEST job: ${r.status}`);
    }
    await ctx.close();
  }
  const results = [];
  let page = null;
  const shot = async (name) => { if (OUT) { mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: `${OUT}/${name}.png` }); } };
  const measure = async (name, scope = null) => {
    await shot(name);
    const items = await page.evaluate(measureInPage, { min: MIN, screen: name, scope });
    results.push(...items);
    const small = items.filter((i) => i.small && !i.inline).length;
    const inl = items.filter((i) => i.inline).length;
    console.log(`${name.padEnd(13)} ${String(items.length).padStart(3)} controls, ${String(small).padStart(2)} under ${MIN}x${MIN}${inl ? ` (+${inl} inline in a sentence)` : ''}`);
  };

  // Signed out: the first screen anyone sees in accounts mode.
  {
    const ctx = await browser.newContext(opts);
    page = await ctx.newPage();
    await page.goto(BASE + '/');
    await settle(page, 1500);
    await measure('sign-in');
    await ctx.close();
  }

  // --onboarding: a NEW TEST account each run (taps-onb-<time>@example.com), its steps up to the last one, unsaved.
  if (args.onboarding) {
    const ctx = await browser.newContext(opts);
    page = await ctx.newPage();
    await page.goto(BASE + '/');
    const r = await call(page, '/api/auth/signup', 'POST', { email: `taps-onb-${Date.now()}@example.com`, password: PASSWORD, name: 'TEST onboarding (simulated)' });
    if (r.status >= 400) throw new Error(`onboarding sign-up failed: ${r.status}`);
    await page.goto(BASE + '/');
    await settle(page, 1500);
    await measure('onb-intent');
    await page.locator('.intent', { hasText: 'Find work' }).first().click();
    await settle(page, 1200);
    await page.locator('.trade-chip', { hasText: 'Electrical' }).first().click();
    await measure('onb-trades');
    await page.locator('.step-foot .cta').click();
    await settle(page, 900);
    await page.locator('input.zip').fill('89410');
    await settle(page, 1500);
    await measure('onb-shop');
    await page.locator('.trade-chip', { hasText: '100 mi' }).first().click();
    await settle(page, 1500);
    await page.locator('.trade-chip').first().click();
    await measure('onb-sizes');
    await page.locator('.step-foot .cta').click();
    await settle(page, 900);
    await measure('onb-paperwork');
    await page.locator('.step-foot .cta').click();
    await settle(page, 900);
    await measure('onb-alerts');
    await page.locator('.choice').first().click();
    await settle(page, 1500);
    await measure('onb-name');
    await ctx.close();
  }

  const ctx = await browser.newContext(opts);
  page = await ctx.newPage();
  await signIn(page, WORKER);
  // One saved bid, so Saved has a row (only when nothing is saved: a rerun must not empty Home).
  const feed = await call(page, '/api/feed?limit=20');
  const saved = await call(page, '/api/saved');
  const publicBid = (feed.json?.items ?? []).find((i) => !String(i.id).startsWith('local:'));
  if (publicBid && !(saved.json?.items ?? saved.json ?? []).length) await call(page, '/api/swipe', 'POST', { bidId: publicBid.id, action: 'save' });
  const localJob = (feed.json?.items ?? []).find((i) => String(i.id).startsWith('local:') && !i.myBid);
  const mine = await call(page, '/api/jobs/mine');
  const won = (mine.json?.bidding ?? []).find((j) => j.status !== 'open');
  try { await page.evaluate(() => localStorage.clear()); } catch { /* fine */ }

  await page.goto(BASE + '/');
  await page.waitForSelector('.tab[data-view="home"]:not([hidden])', { timeout: 20000 });
  await settle(page, 1500);
  // Home in Scroll, then Swipe, then back to Scroll (the mode is remembered per device).
  if (await page.locator('.mode-opt', { hasText: 'Scroll' }).count()) await page.locator('.mode-opt', { hasText: 'Scroll' }).click();
  await settle(page);
  await measure('home-scroll');
  // The Undo toast after a pass (then Undo, so the walk changes nothing).
  const pass = page.locator('article.mcard .mc-pass').last();
  if (await pass.count()) {
    await pass.click();
    await settle(page, 500);
    if (await page.locator('.toast button').count()) {
      await measure('toast', '.toast');
      await page.locator('.toast button').first().click();
      await settle(page, 600);
    }
  }
  await page.locator('.mode-opt', { hasText: 'Swipe' }).click();
  await settle(page, 900);
  await measure('home-swipe');
  await page.locator('.mode-opt', { hasText: 'Scroll' }).click();
  await settle(page);
  // The detail sheet of the first public card on Home (else the first public row in Search).
  const card = page.locator('article.mcard:not(:has(.mc-chip.local)) button.mc-open').first();
  if (await card.count()) {
    await card.click();
    await settle(page, 900);
    await measure('sheet');
    await closeSheet(page);
  }
  await tab(page, 'browse');
  await measure('search');
  if (!results.some((r) => r.screen === 'sheet')) {
    await page.locator('button.row:not(:has(.tag.local))').first().click();
    await settle(page, 900);
    await measure('sheet');
    await closeSheet(page);
  }
  if (await page.locator('.filter-btn').count()) {
    await page.locator('.filter-btn').first().click();
    await settle(page, 700);
    await measure('filters');
    await closeSheet(page);
  }
  await tab(page, 'saved');
  await measure('saved');
  await page.locator('#profileChip').click();
  await settle(page, 1200);
  await measure('settings');
  await page.goto(BASE + '/');
  await page.waitForSelector('.tab[data-view="jobs"]:not([hidden])', { timeout: 20000 });
  await settle(page, 1200);
  await tab(page, 'jobs');
  await measure('jobs');
  if (localJob) {
    await page.goto(`${BASE}/?job=${encodeURIComponent(String(localJob.id).slice('local:'.length))}`);
    await settle(page, 1800);
    await measure('job');
  } else console.log('job          (no open local job in the feed: run with --seed)');
  if (won) {
    await page.goto(`${BASE}/?job=${encodeURIComponent(won.id)}`);
    await settle(page, 1800);
    await measure('job-won');
  }
  await page.goto(BASE + '/');
  await page.waitForSelector('.tab[data-view="messages"]:not([hidden])', { timeout: 20000 });
  await settle(page, 1200);
  await tab(page, 'messages');
  await measure('messages');
  if (await page.locator('.mx-row').count()) {
    await page.locator('.mx-row').first().click();
    await settle(page, 1200);
    await measure('conversation');
    await page.goto(BASE + '/');
    await settle(page, 1500);
  } else console.log('conversation (none: the account has no awarded job)');
  await page.locator('#bell').click();
  await settle(page, 1200);
  await measure('alerts');

  const small = results.filter((r) => r.small && !r.inline);
  const inline = results.filter((r) => r.inline);
  // One line per kind of control (tag and classes): how many, the smallest hit box, where.
  const kinds = new Map();
  for (const r of small) {
    const key = r.what.replace(/ ".*$/, '');
    const k = kinds.get(key) ?? { n: 0, w: Infinity, h: Infinity, screens: new Set(), example: r.what };
    k.n++; k.w = Math.min(k.w, r.hit[0]); k.h = Math.min(k.h, r.hit[1]); k.screens.add(r.screen);
    kinds.set(key, k);
  }
  console.log(`\nUnder ${MIN}x${MIN} (not inline): ${small.length} on screens, ${kinds.size} kinds of control`);
  for (const [key, k] of [...kinds].sort()) console.log(`  ${String(k.n).padStart(3)}  ${key.padEnd(44)} smallest ${k.w}x${k.h}  [${[...k.screens].join(', ')}]  e.g. ${k.example.slice(key.length).trim()}`);
  if (inline.length) {
    console.log(`\nInline in a sentence (WCAG 2.5.5 exempt): ${inline.length}`);
    for (const r of inline) console.log(`  ${r.what}  hit ${r.hit.join('x')}  [${r.screen}]`);
  }
  const covered = results.filter((r) => r.covered);
  if (covered.length) {
    console.log(`\nCovered (no point of it reaches it): ${covered.length}`);
    for (const r of covered) console.log(`  ${r.what}  box ${r.box.join('x')}  [${r.screen}]`);
  }
  if (typeof args.json === 'string') writeFileSync(args.json, JSON.stringify(results, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
