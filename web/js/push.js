// Phone alerts (web push): a service worker (web/sw.js) plus a subscription stored by the API.
// Permission is only ever asked from a tap (turnOnPush is called from a button), and only after the
// server has said it can send pushes at all.
//
// iPhone and iPad (docs/IPHONE-ALERTS.md): web push works only in BidSwipe added to the Home Screen and opened from
// its icon, on iOS 16.4 or later. The one fact the app reads for that is navigator.standalone, which only iOS and
// iPadOS WebKit define: true = opened from the Home Screen icon, false = a Safari (or other iOS browser) tab,
// undefined = any other platform. Never the user agent: iPadOS Safari says it is a Mac.

import { api } from './api.js';

/** navigator.standalone as it is: true (iOS Home Screen app), false (an iOS browser tab), undefined (elsewhere). */
export const standalone = () => (typeof navigator !== 'undefined' ? navigator.standalone : undefined);

/**
 * What this browser can do: 'ok', 'insecure', 'unsupported', or 'old_ios' = opened from the Home Screen on an
 * iPhone whose iOS has no web push (before 16.4): adding it to the Home Screen again would change nothing.
 */
export function pushSupport() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return standalone() === true ? 'old_ios' : 'unsupported';
  }
  if (!window.isSecureContext) return 'insecure';
  return 'ok';
}

/** A browser step that can hang (subscribe() waits on the browser's push service): give up after `ms`. */
function within(ms, promise, what) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer. Check your connection and try again.`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** "BASE64URL" VAPID key → the bytes pushManager.subscribe() wants. */
function keyBytes(base64url) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * The service worker registration, fetched BEFORE any tap (devicePush, on opening the bell): web/js/sw-register.js
 * registers the worker on every page load, so the tap itself never waits on it (Apple: call subscribe "immediately
 * from the gesture's event handler", audit ios-gesture-1).
 */
let readyReg = null;
async function registration() {
  if (readyReg) return readyReg;
  try {
    readyReg = (await within(5_000, navigator.serviceWorker.ready, 'The app’s background worker')) ?? null;
  } catch { readyReg = (await navigator.serviceWorker.getRegistration().catch(() => null)) ?? null; }
  return readyReg;
}

/** The subscription this device already has, if any (never asks for anything). */
export async function currentSubscription() {
  if (pushSupport() !== 'ok') return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/**
 * GET /api/push/key: { ok: true, key } or { ok: false, reason: 'not_configured' | 'error' }.
 * 404 push_not_configured = the server has no VAPID keys: phone alerts cannot be sent from it.
 */
export async function pushKey() {
  try {
    return { ok: true, key: (await api.pushKey()).publicKey };
  } catch (err) {
    return { ok: false, reason: err.code === 'push_not_configured' ? 'not_configured' : 'error', message: err.message };
  }
}

/**
 * This device's phone-alert state, without asking for anything (the bell's panel, Home's task, Settings' row):
 * { state, key } with state 'ok'-path answers 'on' | 'off' | 'denied' | 'locked', or what stops it:
 * 'unsupported' | 'old_ios' | 'insecure' | 'not_configured' | 'error'. key = the server's VAPID key when known.
 * `instantPush` = the plan's feature (state.js features()).
 */
export async function devicePush(instantPush) {
  const support = pushSupport();
  if (support !== 'ok') return { state: support, key: null };
  const key = await pushKey();
  if (!key.ok) return { state: key.reason === 'not_configured' ? 'not_configured' : 'error', key: null };
  if (!instantPush) return { state: 'locked', key: key.key };
  const sub = await currentSubscription();
  if (sub) {
    resendOnce(sub);
    return { state: 'on', key: key.key };
  }
  if (Notification.permission === 'denied') return { state: 'denied', key: key.key };
  await registration(); // ready before the tap: see registration()
  return { state: 'off', key: key.key };
}

/**
 * The browser still holds a subscription, but the server may have dropped it (the push service answered 410, or
 * the device was refused and pruned): "On" on screen would then be a device that gets nothing (review rs-2). So
 * once per page load the subscription is stored again, quietly (POST /api/push/subscribe is an upsert). Errors are
 * ignored: the screen state comes from the browser either way.
 */
let resent = false;
function resendOnce(sub) {
  if (resent) return;
  resent = true;
  api.pushSubscribe(sub.toJSON()).catch(() => { resent = false; });
}

/**
 * From a tap: ask permission, subscribe, and store it with the API. Nothing is awaited between the tap and
 * requestPermission, or between permission and subscribe() when the registration was fetched beforehand.
 * Returns { ok: true, instantPush } or { ok: false, reason, message }.
 */
export async function turnOnPush(key) {
  let permission = Notification.permission;
  if (permission === 'default') permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };
  try {
    // Fallback only (the bell normally fetched it before the tap): the page's own registration, never a new one.
    const reg = readyReg ?? await registration();
    if (!reg) throw new Error('The app’s background worker isn’t running. Close BidSwipe, open it again and try once more.');
    const sub = await within(20_000, reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }), 'Your browser’s push service');
    const res = await api.pushSubscribe(sub.toJSON());
    return { ok: true, instantPush: res.instantPush };
  } catch (err) {
    return { ok: false, reason: 'error', message: err?.message };
  }
}

export async function turnOffPush() {
  const sub = await currentSubscription();
  if (!sub) return;
  try { await api.pushUnsubscribe(sub.endpoint); } finally { await sub.unsubscribe().catch(() => {}); }
}

/** How long Sign out waits for the device to be let go before it signs out anyway. */
export const SIGN_OUT_PUSH_MS = 3_000;

/**
 * Sign out: this device stops getting the account's alerts (the server forgets it while the session is still
 * valid, then the browser drops the subscription, so the next person to sign in here starts from "Off"). Never
 * throws and never takes longer than `ms`: a bad network must not hold Sign out (audit push-signout-1).
 * `server: false` (after "Delete account"): the account and its devices are already gone on the server, so only the
 * browser drops its subscription; asking the server would only get "sign in again".
 */
export async function releaseDevice(ms = SIGN_OUT_PUSH_MS, { server = true } = {}) {
  if (pushSupport() !== 'ok') return;
  try {
    await within(ms, (async () => {
      const sub = await currentSubscription();
      if (!sub) return;
      // Both at once, each on its own: a DELETE that never answers must not stop the browser from dropping the
      // subscription (review rs-1: a hung DELETE left the device subscribed and the next person here got the alerts).
      // A device the server still lists is removed at its next push (the push service answers 410).
      await Promise.allSettled([
        server ? within(Math.max(1, ms - 1_000), api.pushUnsubscribe(sub.endpoint), 'Signing this device out of phone alerts') : null,
        sub.unsubscribe(),
      ]);
    })(), 'Signing this device out of phone alerts');
  } catch { /* signed out anyway */ }
}

/**
 * POST /api/push/test: one "Test alert from BidSwipe" to this account's devices, through the same sender as a real
 * alert. → { ok: true, tried, accepted } or { ok: false, code, message } (402 Pro, 409 quiet hours or alerts off in
 * Settings, 429 too many tests, network).
 */
export async function sendTestPush() {
  try {
    const res = await api.pushTest();
    return { ok: true, tried: res.tried, accepted: res.accepted };
  } catch (err) {
    return { ok: false, code: err.code ?? null, message: err.message };
  }
}

/** Refusals whose answer carries its own sentence (src/routes/realtime.ts POST /api/push/test, api.js network). */
const SENTENCE_CODES = new Set(['premium_required', 'quiet_hours', 'push_off', 'too_many_attempts', 'network']);
/** Refusals that carry no sentence. */
const TEST_REFUSED = {
  push_not_configured: 'Phone alerts aren’t set up on this server, so it can’t send a test.',
  sign_in_required: 'Sign in again, then send the test.',
};

/** The result line under "Send a test alert": what happened, in plain words. */
export function testResultLine(res) {
  if (!res) return '';
  if (!res.ok) return TEST_REFUSED[res.code] ?? (SENTENCE_CODES.has(res.code) && res.message ? res.message : 'The test didn’t go out. Try again in a minute.');
  const devices = (n) => `${n} device${n === 1 ? '' : 's'}`;
  if (res.tried === 0) return 'BidSwipe has no device of yours to send to. Turn phone alerts off and on again on this device, then send another test.';
  if (res.accepted === 0) return `The push service didn’t take it (${devices(res.tried)} tried). Turn phone alerts off and on again on this device, then send another test.`;
  return `Sent to ${devices(res.accepted)}. It can take a minute to arrive.${res.accepted < res.tried ? ` ${devices(res.tried - res.accepted)} didn’t take it.` : ''}`;
}
