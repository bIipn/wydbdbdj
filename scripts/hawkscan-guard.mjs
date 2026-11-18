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
//   POST /api/account/delete       403 {"error":"scan_guard"} the scan user (and every object the seed made) can never
//                                  be deleted, whatever the scanner puts in the body
//   POST /api/auth/login           passed on ONLY with the scan user's exact e-mail and password, and without the
//                                  Cookie header (a successful sign-in closes the session the request came with);
//                                  anything else is 401 {"error":"invalid_credentials"} here, so fuzzing cannot use
//                                  up the app's sign-in limit
//   POST /api/jobs/<a seeded job>/cancel and /back-out, DELETE /api/swipe/<the seeded bid>
//                                  409 {"error":"scan_guard"}: only for the ids the seed made, so the scan user's
//                                  own job stays open and the other job routes are attacked on a live job. The same
//                                  routes with any other id pass through (their id handling is still attacked)
//   GET  /api/stream               passed on, cut after 2 seconds (Server-Sent Events never end by themselves)
// So the scan does NOT test sign-in, sign-up, sign-out, the social sign-in route or "Delete account". The first four
// were attacked by hand in the 2026-11-16 audit and are covered by test/auth.test.ts and test/hardening.test.ts;
// "Delete account" by test/account-delete.test.ts and test/no-5xx.test.ts (docs/SECURITY-SCAN.md).
//
// It prints one line per stopped request (the rule only: never a body, a cookie or a password).
import http from 'node:http';

const target = new URL(process.env.GUARD_TARGET || 'http://127.0.0.1:8787');
const port = Number(process.env.GUARD_PORT || 8788);
const scanUser = process.env.SCAN_USERNAME || '';
const scanPassword = process.env.SCAN_PASSWORD || '';
/** The objects scripts/hawkscan-seed.mjs made for the scan: ending them early would hollow out their routes. */
const seededJobs = [process.env.SCAN_JOB_ID, process.env.SCAN_OWN_JOB_ID].filter(Boolean);
const seededBid = process.env.SCAN_BID_ID || '';
if (!scanUser || !scanPassword) {
  // Without them every sign-in would be answered 401 here and the scan would run signed out: fail loudly instead.
  console.error('guard: SCAN_USERNAME / SCAN_PASSWORD are missing (the seed step sets them)');
  process.exit(1);
}
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
function forward(req, res, body, { cutAfterMs = 0, headers = req.headers } = {}) {
  const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers }, (answerFromApp) => {
    res.writeHead(answerFromApp.statusCode ?? 502, answerFromApp.statusMessage, answerFromApp.headers);
    answerFromApp.pipe(res);
    const timer = cutAfterMs ? setTimeout(() => { say('stopped stream after 2 s'); res.end(); up.destroy(); }, cutAfterMs) : null;
    answerFromApp.on('close', () => {
      if (timer) clearTimeout(timer);
      // The app dropped the connection mid-answer: pipe() does not end `res` then, and the scanner would wait out
      // its own timeout. Drop ours too (a finished answer has already ended `res`).
      if (!answerFromApp.complete && !res.writableEnded) res.destroy();
    });
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

/**
 * The path the app's router will match: without scheme and host (an absolute-form request line), query or fragment
 * (the router cuts at '?' and at '#'), percent-escapes decoded (the router decodes them, so /api/auth/log%6Fut IS
 * the logout route), no trailing slash. Lower case is NOT applied: the app's routes are case sensitive, so
 * /API/AUTH/LOGOUT is a 404 there and may pass.
 */
function routedPath(url) {
  let path = (url ?? '/').split('#', 1)[0].split('?', 1)[0];
  if (!path.startsWith('/')) {
    try { path = new URL(url).pathname; } catch { /* not a URL either: the app answers 400 or 404 */ }
  }
  try { path = decodeURIComponent(path); } catch { /* a broken escape is a 400 or 404 in the app */ }
  return path.replace(/\/+$/, '');
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
  const path = routedPath(req.url);
  if (req.method === 'POST' && path === '/api/auth/logout') {
    req.resume();
    return answer(res, 200, { ok: true }, 'logout');
  }
  if (req.method === 'POST' && (path === '/api/auth/signup' || path === '/api/auth/oauth')) {
    req.resume();
    return answer(res, 403, { error: 'scan_guard', message: 'Left out of the scan: it would replace the scan session.' }, path.slice('/api/auth/'.length));
  }
  if (req.method === 'POST' && path === '/api/account/delete') {
    // Never passed on: with the scan user's password in a fuzzed body it would delete the scan user, its session and
    // the seeded jobs, and every later request would be answered 401.
    req.resume();
    return answer(res, 403, { error: 'scan_guard', message: 'Left out of the scan: it would delete the scan user.' }, 'account/delete');
  }
  if (req.method === 'POST' && path === '/api/auth/login') {
    const body = await readBody(req);
    if (isScanUserLogin(body)) {
      // Without the Cookie header: on a successful sign-in the app closes the session the request CAME with
      // (src/routes/auth.ts answer()). An attack on this route that leaves both values alone (a fuzzed header, a
      // query parameter) would otherwise end the scanner's live session each time.
      const headers = { ...req.headers };
      delete headers.cookie;
      return forward(req, res, body, { headers });
    }
    return answer(res, 401, { error: 'invalid_credentials' }, 'login that is not the scan user');
  }
  const ending = /^\/api\/jobs\/([^/]+)\/(cancel|back-out)$/.exec(path);
  if (req.method === 'POST' && ending && seededJobs.includes(ending[1])) {
    req.resume();
    return answer(res, 409, { error: 'scan_guard', message: 'Left out of the scan: it would end a job the scan needs open.' }, `${ending[2]} of a seeded job`);
  }
  if (req.method === 'DELETE' && seededBid && path === `/api/swipe/${seededBid}`) {
    req.resume();
    return answer(res, 409, { error: 'scan_guard', message: 'Left out of the scan: it would undo the saved bid the scan needs.' }, 'undo of the seeded saved bid');
  }
  if (req.method === 'GET' && path === '/api/stream') return forward(req, res, undefined, { cutAfterMs: STREAM_MS });
  return forward(req, res);
});

await readPolicy();
server.listen(port, '127.0.0.1', () => say(`guard: http://127.0.0.1:${port} -> ${target.origin} (scan user ${scanUser ? 'set' : 'NOT set'})`));
