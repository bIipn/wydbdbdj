// Phone alerts (web push): a service worker (web/sw.js) plus a subscription stored by the API.
// Permission is only ever asked from a tap (turnOnPush is called from a button), and only after the
// server has said it can send pushes at all.

import { api } from './api.js';

/** What this browser can do. */
export function pushSupport() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
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
 * From a tap: ask permission, register the service worker, subscribe, and store it with the API.
 * Returns { ok: true, instantPush } or { ok: false, reason, message }.
 */
export async function turnOnPush(key) {
  let permission = Notification.permission;
  if (permission === 'default') permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    await within(10_000, navigator.serviceWorker.ready, 'The app’s background worker');
    const sub = (await reg.pushManager.getSubscription())
      ?? await within(20_000, reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }), 'Your browser’s push service');
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
