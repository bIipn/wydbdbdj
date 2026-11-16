import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Sign out lets this device go first (web/js/session.js signOut → push.js releaseDevice, audit push-signout-1): the
// server forgets the device while the session is still valid, the browser drops the subscription, and none of it can
// hold Sign out longer than SIGN_OUT_PUSH_MS. The browser parts (navigator.serviceWorker, PushManager, fetch) are
// stubs that record what the app asks for; the screen change is mocked. Everything is synthetic (TEST-, example.com).

vi.mock('../web/js/shell.js', () => ({ setView: vi.fn(), render: vi.fn(), onAfterRender: vi.fn() }));

type Session = { signOut: () => Promise<void> };
type Push = { releaseDevice: (ms?: number) => Promise<void>; SIGN_OUT_PUSH_MS: number; pushSupport: () => string };
// web/js is plain JavaScript with no type declarations; computed paths keep tsc from asking for them.
const sessionPath = '../web/js/session.js';
const pushPath = '../web/js/push.js';
const shellPath = '../web/js/shell.js';

const ENDPOINT = 'https://push.example.com/send/TEST-signout-device';
const calls: string[] = [];
let subscription: { endpoint: string; unsubscribe: () => Promise<boolean> } | null;
let registration: () => Promise<unknown>;
let fetchFails = false;
let fetchHangs = false;

function stubBrowser({ push = true, standalone }: { push?: boolean; standalone?: boolean } = {}) {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.isSecureContext = true;
  if (push) {
    g.PushManager = class {};
    g.Notification = { permission: 'granted' };
  } else {
    delete g.PushManager;
    delete g.Notification;
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      standalone,
      serviceWorker: { getRegistration: () => registration(), ready: new Promise(() => {}) },
    },
  });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: { method?: string; body?: string }) => {
    calls.push(`${init.method ?? 'GET'} ${path}${init.body ? ` ${init.body}` : ''}`);
    if (fetchFails && path === 'api/push/subscribe') throw new TypeError('TEST network down');
    if (fetchHangs && path === 'api/push/subscribe') return new Promise<Response>(() => {});
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

beforeEach(() => {
  calls.length = 0;
  fetchFails = false;
  fetchHangs = false;
  subscription = {
    endpoint: ENDPOINT,
    unsubscribe: async () => { calls.push('browser unsubscribe'); return true; },
  };
  registration = async () => ({ pushManager: { getSubscription: async () => subscription } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sign out and phone alerts', () => {
  it('forgets this device on the server (session still valid), drops the browser subscription, then signs out', async () => {
    stubBrowser();
    const { signOut } = (await import(sessionPath)) as Session;
    const { setView } = (await import(shellPath)) as { setView: ReturnType<typeof vi.fn> };
    await signOut();
    expect(calls).toEqual([
      `DELETE api/push/subscribe ${JSON.stringify({ endpoint: ENDPOINT })}`,
      'browser unsubscribe',
      'POST api/auth/logout',
    ]);
    expect(setView).toHaveBeenLastCalledWith('signin');
  });

  it('a device with no subscription signs out with one request', async () => {
    stubBrowser();
    subscription = null;
    const { signOut } = (await import(sessionPath)) as Session;
    await signOut();
    expect(calls).toEqual(['POST api/auth/logout']);
  });

  it('never hangs: a browser that does not answer is given up after SIGN_OUT_PUSH_MS, and sign out goes on', async () => {
    stubBrowser();
    registration = () => new Promise(() => {}); // getRegistration() that never answers (a stuck worker)
    const { SIGN_OUT_PUSH_MS } = (await import(pushPath)) as Push;
    expect(SIGN_OUT_PUSH_MS).toBe(3_000);
    const { signOut } = (await import(sessionPath)) as Session;
    vi.useFakeTimers();
    let done = false;
    const out = signOut().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(SIGN_OUT_PUSH_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await out;
    expect(calls).toEqual(['POST api/auth/logout']);
  });

  it('a failed DELETE (no network) still drops the browser subscription and signs out', async () => {
    stubBrowser();
    fetchFails = true;
    const { signOut } = (await import(sessionPath)) as Session;
    await signOut();
    expect(calls).toEqual([`DELETE api/push/subscribe ${JSON.stringify({ endpoint: ENDPOINT })}`, 'browser unsubscribe', 'POST api/auth/logout']);
  });

  it('a DELETE that never answers still drops the browser subscription, and sign out goes on in time (review rs-1)', async () => {
    stubBrowser();
    fetchHangs = true;
    const { SIGN_OUT_PUSH_MS } = (await import(pushPath)) as Push;
    const { signOut } = (await import(sessionPath)) as Session;
    vi.useFakeTimers();
    let done = false;
    const out = signOut().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toContain('browser unsubscribe'); // at once, not after the DELETE
    await vi.advanceTimersByTimeAsync(SIGN_OUT_PUSH_MS);
    await out;
    expect(done).toBe(true);
    expect(calls).toEqual([`DELETE api/push/subscribe ${JSON.stringify({ endpoint: ENDPOINT })}`, 'browser unsubscribe', 'POST api/auth/logout']);
  });

  it('a browser without push (a Safari tab on an iPhone) just signs out', async () => {
    stubBrowser({ push: false, standalone: false });
    const { signOut } = (await import(sessionPath)) as Session;
    const { pushSupport } = (await import(pushPath)) as Push;
    expect(pushSupport()).toBe('unsupported');
    await signOut();
    expect(calls).toEqual(['POST api/auth/logout']);
  });

  it('pushSupport reads navigator.standalone, never the user agent: an installed app on an old iOS is old_ios', async () => {
    const { pushSupport } = (await import(pushPath)) as Push;
    stubBrowser({ push: false, standalone: true });
    expect(pushSupport()).toBe('old_ios');
    stubBrowser({ push: false, standalone: undefined }); // Android, Windows, a desktop browser without push
    expect(pushSupport()).toBe('unsupported');
    stubBrowser({ push: true, standalone: true });
    expect(pushSupport()).toBe('ok');
  });
});
