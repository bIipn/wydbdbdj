#!/usr/bin/env node
// A pass-through that stands between HawkScan and the app, for the scan job only (.github/workflows/hawkscan.yml).
// The scanner talks to this port; every request goes on to the app unchanged, except the few that would end the
// scan's own session. Not part of the app: nothing in src/ or web/ knows it exists.
//
//   GUARD_TARGET=http://127.0.0.1:8787 GUARD_PORT=8788 SCAN_USERNAME=… SCAN_PASSWORD=… node scripts/hawkscan-guard.mjs
//
// Why it exists (run 3, 2026-11-16): `app.excludePaths` in stackhawk.yml did not keep the scanner off the routes
// it names. It called POST /api/auth/logout 171 times and was signed out within five minutes; a fuzzed sign-up
// handed it a brand-new account for a while; its fuzzed sign-ins used up the app's sign-in limit for the runner's
// address, so it could not sign in again. 10,057 of 14,499 requests to signed-in routes were answered 401: the
// scan was "clean" without having attacked them.
//
// What it stops, and what it answers instead (with the app's own security headers, copied from GET /api/health):
//   POST /api/auth/logout          200 {"ok":true}            the app never hears it, the session lives on
//   POST /api/auth/signup, oauth   403 {"error":"scan_guard"} no new account, no other session cookie
//   POST /api/auth/login           passed on ONLY with the scan user's exact e-mail and password; anything else is
//                                  401 {"error":"invalid_credentials"} here, so fuzzing cannot use up the limit
//   GET  /api/stream               passed on, cut after 2 seconds (Server-Sent Events never end by themselves)
// So the scan does NOT test sign-in, sign-up, sign-out or the social sign-in route. Those were attacked by hand in
// the 2026-11-16 audit and are covered by test/auth.test.ts and test/hardening.test.ts (docs/SECURITY-SCAN.md).
//
// It prints one line per stopped request (the rule only: never a body, a cookie or a password).
import http from 'node:http';

const target = new URL(process.env.GUARD_TARGET || 'http://127.0.0.1:8787');
const port = Number(process.env.GUARD_PORT || 8788);
const scanUser = process.env.SCAN_USERNAME || '';
const scanPassword = process.env.SCAN_PASSWORD || '';
const STREAM_MS = 2_000;
const MAX_BODY = 64 * 1024;
/** Headers that belong to one answer, not to the app's policy. */
const NOT_COPIED = new Set(['content-length', 'content-type', 'date', 'etag', 'last-modified', 'connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'accept-ranges']);

let policyHeaders = {};
const say = (line) => console.log(line);

/** The app's security headers, read once from a harmless request, so a stopped request looks like the app's own. */
async function readPolicy() {
  const res = await fetch(new URL('/api/health', target));
  await res.arrayBuffer();
  policyHeaders = Object.fromEntries([...res.headers].filter(([name]) => !NOT_COPIED.has(name.toLowerCase())));
}

function answer(res, status, body, rule) {
  say(`stopped ${rule}`);
  const text = JSON.stringify(body);
  res.writeHead(status, { ...policyHeaders, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Send the request on as it came (method, path, headers, body) and hand back the app's answer untouched. */
function forward(req, res, body, cutAfterMs = 0) {
  const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers }, (answerFromApp) => {
    res.writeHead(answerFromApp.statusCode ?? 502, answerFromApp.statusMessage, answerFromApp.headers);
    answerFromApp.pipe(res);
    if (cutAfterMs) {
      const timer = setTimeout(() => { say('stopped stream after 2 s'); res.end(); up.destroy(); }, cutAfterMs);
      answerFromApp.on('close', () => clearTimeout(timer));
    }
  });
  up.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'scan_guard_upstream', message: String(err.message).slice(0, 200) }));
  });
  res.on('close', () => up.destroy());
  if (body === undefined) req.pipe(up);
  else up.end(body);
}

/** The whole body of a small request, or null when it is larger than a sign-in could be. */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => resolve(size <= MAX_BODY ? Buffer.concat(chunks) : null));
    req.on('error', () => resolve(null));
  });
}

const isScanUserLogin = (body) => {
  if (!body || !scanUser || !scanPassword) return false;
  try {
    const sent = JSON.parse(body.toString('utf8'));
    return sent !== null && typeof sent === 'object' && !Array.isArray(sent) && sent.email === scanUser && sent.password === scanPassword;
  } catch {
    return false;
  }
};

const server = http.createServer(async (req, res) => {
  // The path as the app's router will see it: no query, percent-escapes decoded (the router decodes them, so
  // /api/auth/log%6Fut IS the logout route), no trailing slash. Lower case is NOT applied: the app's routes are
  // case sensitive, so /API/AUTH/LOGOUT is a 404 there and may pass.
  const raw = (req.url ?? '').split('?', 1)[0];
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* a broken escape is a 400 or 404 in the app */ }
  const path = decoded.replace(/\/+$/, '');
  if (req.method === 'POST' && path === '/api/auth/logout') {
    req.resume();
    return answer(res, 200, { ok: true }, 'logout');
  }
  if (req.method === 'POST' && (path === '/api/auth/signup' || path === '/api/auth/oauth')) {
    req.resume();
    return answer(res, 403, { error: 'scan_guard', message: 'Left out of the scan: it would replace the scan session.' }, path.slice('/api/auth/'.length));
  }
  if (req.method === 'POST' && path === '/api/auth/login') {
    const body = await readBody(req);
    if (isScanUserLogin(body)) return forward(req, res, body);
    return answer(res, 401, { error: 'invalid_credentials' }, 'login that is not the scan user');
  }
  if (req.method === 'GET' && path === '/api/stream') return forward(req, res, undefined, STREAM_MS);
  return forward(req, res);
});

await readPolicy();
server.listen(port, '127.0.0.1', () => say(`guard: http://127.0.0.1:${port} -> ${target.origin} (scan user ${scanUser ? 'set' : 'NOT set'})`));
