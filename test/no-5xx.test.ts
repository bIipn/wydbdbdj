/**
 * No hostile input answers a 5xx: every operation in docs/api/openapi.yaml, through the real app in accounts mode.
 *
 * Why: HawkScan run 4 (2026-11-17) found one 500 (GET /api/estimates?bidId=%00 reached Postgres, which refuses a NUL
 * in text), and it could not reach the routes of an AWARDED job at all (it cannot move a clock), nor most handlers
 * behind a real id. This test goes where the scanner could not:
 *
 *   - the operations come from the spec, so a route is covered the day it is documented (the spec is read with the
 *     small YAML reader below: the repo has no YAML library, and test/openapi.test.ts keeps the spec equal to the server);
 *   - it seeds REAL objects first (two TEST accounts with profiles, an open job with a sealed bid, an awarded job
 *     with messages, an agreed job, a cancelled one, a no-show fee, a conversation report, a saved TEST- bid) and
 *     puts their ids where the spec's examples hold placeholders; a job route gets FRESH jobs of its own, so one
 *     route's "cancel" or "back out" never leaves the next route a dead job;
 *   - then, signed in as the account that may call the route, it sends each documented example unchanged, and each
 *     hostile value in each query parameter, each path parameter (the real id replaced), each top-level body field
 *     and each field of a top-level object, one at a time; then the example again as the other account and signed out;
 *   - the clock moves 61 minutes before every request, so every limit's window (the longest is an hour) is over
 *     and the handlers are reached instead of a 429. It ASSERTS that: no 429 at all, more than 60% of the answers
 *     not 401/404/429, every operation but one answered by its handler, and every example (with real ids) accepted
 *     but two named below. The counts by status are printed. Two scan runs looked clean while being refused everywhere.
 * The whole value set runs (about 2,600 requests, ~5 s): nothing was cut.
 *
 * Nothing leaves the process: the scan is a stub, the market refresh gets HTTP clients that refuse, web push goes to
 * an in-process mock of push.example.com, and fetch() throws. Everything here is synthetic (TEST-, example.com).
 *
 * Not covered: GET /api/stream in stream mode (a stream that works never ends, so app.inject would wait for ever);
 * the app runs in poll mode, where that route answers 404 stream_off before reading anything. Header values are not
 * varied (only x-bidswipe and the identity headers are sent).
 */
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateVAPIDKeys } from 'web-push';
import { createAuth } from '../src/auth/index.js';
import type { RouteContext } from '../src/context.js';
import { findCredentials } from '../src/db/accounts.js';
import type { Db } from '../src/db/db.js';
import { upsertBids } from '../src/db/repo.js';
import { createRealtime, type Realtime } from '../src/realtime/index.js';
import { PUSH_SERVICE_HOSTS } from '../src/realtime/push.js';
import type { ScanReport } from '../src/scan.js';
import { buildApp } from '../src/server.js';
import type { Account } from '../src/types.js';
import { accountsConfig, memoryDb, testBid } from './helpers.js';

// --------------------------------------------------------------------------------------------- spec reader --

type Yaml = null | boolean | number | string | Yaml[] | { [key: string]: Yaml };
interface Line { indent: number; text: string }

/** A plain scalar the way YAML 1.2 types it (the core schema's ints, floats, booleans and null). */
function scalar(s: string): Yaml {
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

/** A flow value ({ a: b }, [x, y], 'quoted', "quoted", plain) from `src` at `pos.i`. */
function flow(src: string, pos: { i: number }, inFlow: boolean): Yaml {
  const ws = () => { while (pos.i < src.length && src[pos.i] === ' ') pos.i++; };
  ws();
  const c = src[pos.i];
  if (c === '{' || c === '[') {
    const close = c === '{' ? '}' : ']';
    pos.i++;
    const map: Record<string, Yaml> = {};
    const seq: Yaml[] = [];
    for (;;) {
      ws();
      if (src[pos.i] === close) { pos.i++; break; }
      if (c === '{') {
        const key = flowKey(src, pos);
        ws();
        if (src[pos.i] !== ':') throw new Error(`openapi.yaml: expected ":" in ${src}`);
        pos.i++;
        map[key] = flow(src, pos, true);
      } else seq.push(flow(src, pos, true));
      ws();
      if (src[pos.i] === ',') pos.i++;
      else if (src[pos.i] !== close) throw new Error(`openapi.yaml: expected "," or "${close}" in ${src}`);
    }
    return c === '{' ? map : seq;
  }
  if (c === "'" || c === '"') return quoted(src, pos);
  const start = pos.i;
  if (inFlow) while (pos.i < src.length && !',]}'.includes(src[pos.i]!)) pos.i++;
  else pos.i = src.length;
  return scalar(src.slice(start, pos.i).trim());
}

function quoted(src: string, pos: { i: number }): string {
  const q = src[pos.i]!;
  let out = '';
  pos.i++;
  while (pos.i < src.length) {
    const ch = src[pos.i]!;
    if (q === "'" && ch === "'") {
      if (src[pos.i + 1] === "'") { out += "'"; pos.i += 2; continue; }
      pos.i++;
      return out;
    }
    if (q === '"' && ch === '\\') { out += JSON.parse(`"${src.slice(pos.i, pos.i + 2)}"`); pos.i += 2; continue; }
    if (q === '"' && ch === '"') { pos.i++; return out; }
    out += ch;
    pos.i++;
  }
  throw new Error(`openapi.yaml: unterminated string in ${src}`);
}

function flowKey(src: string, pos: { i: number }): string {
  if (src[pos.i] === "'" || src[pos.i] === '"') return quoted(src, pos);
  const start = pos.i;
  while (pos.i < src.length && src[pos.i] !== ':') pos.i++;
  return src.slice(start, pos.i).trim();
}

const KEY = /^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^'"\s][^:]*?)\s*:(?:\s+(.*))?$/;

/** The block YAML the spec is written in: mappings, "- " sequences, flow values, quoted scalars and ">-" text. */
function parseYaml(text: string): Yaml {
  const lines: Line[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim() });
  }
  let i = 0;
  const isItem = (l: Line) => l.text === '-' || l.text.startsWith('- ');

  const block = (indent: number): Yaml => (isItem(lines[i]!) ? sequence(indent) : mapping(indent));

  const value = (rest: string | undefined, indent: number): Yaml => {
    i++;
    if (rest === undefined || rest === '') {
      const next = lines[i];
      if (next && next.indent > indent) return block(next.indent);
      if (next && next.indent === indent && isItem(next)) return sequence(indent);
      return null;
    }
    if (/^[>|][-+]?$/.test(rest)) {
      const parts: string[] = [];
      while (i < lines.length && lines[i]!.indent > indent) parts.push(lines[i++]!.text);
      return parts.join(rest.startsWith('>') ? ' ' : '\n');
    }
    return flow(rest, { i: 0 }, false);
  };

  const mapping = (indent: number): Record<string, Yaml> => {
    const map: Record<string, Yaml> = {};
    while (i < lines.length && lines[i]!.indent === indent && !isItem(lines[i]!)) {
      const m = KEY.exec(lines[i]!.text);
      if (!m) throw new Error(`openapi.yaml: cannot read "${lines[i]!.text}"`);
      const key = /^['"]/.test(m[1]!) ? quoted(m[1]!, { i: 0 }) : m[1]!;
      map[key] = value(m[2], indent);
    }
    if (i < lines.length && lines[i]!.indent > indent) throw new Error(`openapi.yaml: unexpected indent at "${lines[i]!.text}"`);
    return map;
  };

  const sequence = (indent: number): Yaml[] => {
    const seq: Yaml[] = [];
    while (i < lines.length && lines[i]!.indent === indent && isItem(lines[i]!)) {
      const rest = lines[i]!.text.slice(1).trim();
      if (rest === '') {
        i++;
        seq.push(block(lines[i]!.indent));
      } else if (/^[{['"]/.test(rest) || !KEY.test(rest)) {
        i++;
        seq.push(flow(rest, { i: 0 }, false));
      } else {
        // "- key: value" opens a mapping whose keys sit two columns in.
        lines[i] = { indent: indent + 2, text: rest };
        seq.push(mapping(indent + 2));
      }
    }
    return seq;
  };

  return block(0);
}

// ------------------------------------------------------------------------------------------- operations --

type Obj = Record<string, Yaml>;
interface Param { name: string; in: string; example?: Yaml }
interface Operation { method: string; path: string; params: Param[]; body: Yaml | undefined; publicRoute: boolean }

const METHODS = ['get', 'put', 'post', 'delete', 'patch'];
const spec = parseYaml(readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8')) as Obj;

function deref(p: Yaml): Obj {
  const o = p as Obj;
  if (typeof o.$ref !== 'string') return o;
  const name = o.$ref.replace('#/components/parameters/', '');
  const found = ((spec.components as Obj).parameters as Obj)[name];
  if (!found) throw new Error(`openapi.yaml: no parameter ${o.$ref}`);
  return found as Obj;
}

const operations: Operation[] = [];
for (const [path, item] of Object.entries(spec.paths as Obj)) {
  const shared = ((item as Obj).parameters as Yaml[] | undefined) ?? [];
  for (const [method, raw] of Object.entries(item as Obj)) {
    if (!METHODS.includes(method)) continue;
    const op = raw as Obj;
    const params = [...shared, ...((op.parameters as Yaml[] | undefined) ?? [])].map(deref)
      .map((p) => ({ name: String(p.name), in: String(p.in), ...(p.example !== undefined ? { example: p.example } : {}) }));
    const json = (((op.requestBody as Obj | undefined)?.content as Obj | undefined)?.['application/json'] as Obj | undefined);
    const security = op.security as Yaml[] | undefined;
    operations.push({
      method: method.toUpperCase(), path, params, body: json?.example ?? undefined,
      publicRoute: Array.isArray(security) && security.length === 0,
    });
  }
}

// ------------------------------------------------------------------------------------------ hostile values --

/** For a query or path value: [label, the raw text after "name=" (already percent-encoded)]. */
const enc = (s: string) => encodeURIComponent(s);
const TEXT: Array<[string, string]> = [
  ['NUL', '\u0000'], ['a NUL b', 'a\u0000b'], ['a control character', 'a\u0007b'], ['a lone backslash', '\\'], ['a quote', "'"],
  ['5,000 characters', 'x'.repeat(5000)], ['an emoji', '\u{1F527}'], ['__proto__', '__proto__'], ['-1', '-1'], ['1e999', '1e999'],
  ['NaN', 'NaN'], ['null', 'null'], ['true', 'true'], ['empty', ''], ['0', '0'], ['20 digits', '99999999999999999999'],
  ['a path', '../../etc/passwd'],
];
const INVALID_UTF8 = '%C3%28';
/** Query forms: [label, (name) => the query-string piece]. */
const QUERY: Array<[string, (name: string) => string]> = [
  ...TEXT.map(([label, v]): [string, (name: string) => string] => [label, (n) => `${enc(n)}=${enc(v)}`]),
  ['invalid UTF-8', (n) => `${enc(n)}=${INVALID_UTF8}`],
  ['a lone %', (n) => `${enc(n)}=%`],
  ['the array form x[]=1', (n) => `${enc(n)}[]=1`],
  ['given twice', (n) => `${enc(n)}=1&${enc(n)}=2`],
];
const PATH: Array<[string, string]> = [...TEXT.map(([label, v]): [string, string] => [label, enc(v)]), ['invalid UTF-8', INVALID_UTF8], ['a lone %', '%']];
const nested = (depth: number): string => (depth === 0 ? '1' : `{"a":${nested(depth - 1)}}`);
/** Body forms: [label, the raw JSON token]. 1e999 is valid JSON text that parses to Infinity. */
const BODY: Array<[string, string]> = [
  ...TEXT.filter(([label]) => !['-1', '1e999', 'null', 'true', '0', '20 digits'].includes(label)).map(([label, v]): [string, string] => [label, JSON.stringify(v)]),
  ['-1', '-1'], ['1e999', '1e999'], ['null', 'null'], ['true', 'true'], ['0', '0'], ['20 digits', '99999999999999999999'],
  ['an array', '[1]'], ['an empty object', '{}'], ['an object 30 deep', nested(30)],
  ['invalid UTF-8', '"\u0000BADUTF8\u0000"'], // replaced by raw bytes below
];

// -------------------------------------------------------------------------------------------------- app --

const START = Date.parse('2026-11-14T18:00:00Z');
const STEP = 61 * 60_000; // longer than every limit's window (the longest is an hour)
const ADMIN = 'TEST-admin-token-no5xx';
const CRON = 'TEST-cron-secret-no5xx';
const PUSH_HOST = 'push.example.com';
const PASSWORD = 'TEST-password-123';

let db: Db;
let app: FastifyInstance;
let ctx: RouteContext;
let rt: Realtime;
let clock = START;
let A: Account; // scan-user@example.com (the spec's examples name it): Pro, posts the jobs
let B: Account; // the bidder and winner
const emails = new Map<string, string>();
const bidId = testBid({ sourceId: 'TEST-no5xx-1', dueAt: '2028-12-01T22:00:00.000Z', title: 'TEST panel upgrade for the no-5xx test (synthetic)' }).id;

const realRequest = https.request;
const realFetch = globalThis.fetch;
const savedEnv = { PROMO_CODES: process.env.PROMO_CODES, REALTIME_MODE: process.env.REALTIME_MODE };

/** web push goes to an in-process push.example.com that answers 201; any other host fails the request loudly. */
function mockRequest(...args: unknown[]) {
  const [opts, cb] = args as [{ hostname?: string }, (res: EventEmitter) => void];
  if (opts?.hostname !== PUSH_HOST) throw new Error(`no-5xx test: an https request left for ${String(opts?.hostname)}`);
  const req = Object.assign(new EventEmitter(), {
    write: () => {}, setTimeout: () => {}, destroy: (e?: Error) => { if (e) req.emit('error', e); },
    end: () => setImmediate(() => {
      const res = Object.assign(new EventEmitter(), { statusCode: 201, headers: {} });
      cb(res);
      res.emit('end');
    }),
  });
  return req;
}

const counts = new Map<number, number>();
/** Per operation: how many answers came from past the sign-in, the router's 404 and the limits. */
const reachedByOp = new Map<string, number>();
let currentOp = '';
const fivexx: string[] = [];
let total = 0;
/** The examples sent unchanged that were refused as signed out / not found / limited (should be very few). */
const exampleRefused: string[] = [];

interface Sent { method: string; url: string; body?: string | Buffer; who: Account | null }

async function send({ method, url, body, who }: Sent, record = true) {
  clock += STEP;
  const headers: Record<string, string> = { 'x-bidswipe': '1' };
  if (who) headers['x-test-as'] = who.id;
  if (url.startsWith('/api/admin/')) headers['x-admin-token'] = ADMIN;
  if (url.startsWith('/api/cron/')) headers.authorization = `Bearer ${CRON}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.inject({ method: method as 'GET', url, headers, ...(body !== undefined ? { payload: body } : {}) });
  if (record) {
    total++;
    counts.set(res.statusCode, (counts.get(res.statusCode) ?? 0) + 1);
    if (![401, 404, 429].includes(res.statusCode)) reachedByOp.set(currentOp, (reachedByOp.get(currentOp) ?? 0) + 1);
    if (res.statusCode >= 500) {
      const shown = typeof body === 'string' ? body.slice(0, 160) : body ? '<bytes>' : '';
      fivexx.push(`${method} ${url.slice(0, 200)} ${shown} → ${res.statusCode} ${res.body.slice(0, 200)}`);
    }
  }
  return { status: res.statusCode, json: () => res.json() as Record<string, unknown>, body: res.body };
}

/** A seeding call: must succeed (2xx), and is not counted. */
async function seed(method: string, url: string, who: Account | null, payload?: unknown): Promise<Record<string, unknown>> {
  const res = await send({ method, url, who, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) }, false);
  if (res.status >= 300) throw new Error(`seed ${method} ${url}: ${res.status} ${res.body}`);
  return res.body ? res.json() : {};
}

// ---------------------------------------------------------------------------------------------- worlds --

const JOB = (closesInDays: number) => ({
  title: 'TEST Hang four porch lights (simulated)', description: 'Four exterior fixtures on an existing circuit. TEST job (simulated).',
  trades: ['electrical'], zip: '95675', address: '9 TEST Lane (simulated)', phone: '916-555-0142', budgetMaxCents: 90_000, closesInDays,
});

async function postJob(closesInDays: number): Promise<string> {
  return ((await seed('POST', '/api/jobs', A, JOB(closesInDays))).job as { id: string }).id;
}
/** Open, with B's sealed bid on it; closes in 30 days (far longer than any one operation's requests). */
async function openJob(): Promise<string> {
  const id = await postJob(30);
  await seed('POST', `/api/jobs/${id}/bid`, B, { amountCents: 42_000, agree: true, note: 'TEST bid (simulated)' });
  return id;
}
/** Awarded to B (the clock moved past closing), with a message from each side. */
async function awardedJob(): Promise<{ id: string; messageId: number }> {
  const id = await postJob(1);
  await seed('POST', `/api/jobs/${id}/bid`, B, { amountCents: 41_000, agree: true });
  clock += 25 * 3_600_000;
  const job = (await seed('GET', `/api/jobs/${id}`, A)).job as { stage?: string; status?: string };
  if (job.status !== 'awarded') throw new Error(`seed: job ${id} is ${job.status}, not awarded`);
  await seed('POST', `/api/jobs/${id}/messages`, B, { body: 'TEST hello from the winner (simulated)' });
  const m = (await seed('POST', `/api/jobs/${id}/messages`, A, { body: 'TEST hello from the poster (simulated)' })).message as { id: number };
  return { id, messageId: m.id };
}

interface World { who: Account | null; path: Record<string, string> }

/** Who calls an operation, and the real ids for its path, made fresh for the job routes. */
async function worldFor(op: Operation): Promise<World> {
  const p = op.path;
  const who = op.publicRoute ? null : A;
  if (p.startsWith('/api/jobs/{id}')) {
    const tail = p.slice('/api/jobs/{id}'.length);
    if (tail === '/bid') return { who: B, path: { id: await openJob() } };
    if (tail === '/report') return { who: B, path: { id: await openJob() } };
    if (tail === '' || tail === '/cancel') return { who: A, path: { id: await openJob() } };
    if (tail === '/repost') {
      const id = await postJob(30);
      await seed('POST', `/api/jobs/${id}/cancel`, A);
      return { who: A, path: { id } };
    }
    const { id } = await awardedJob();
    if (tail === '/back-out') return { who: B, path: { id } };
    if (tail === '/complete') {
      await seed('POST', `/api/jobs/${id}/confirm`, A);
      await seed('POST', `/api/jobs/${id}/confirm`, B);
      return { who: A, path: { id } };
    }
    return { who: A, path: { id } }; // conversation, read, messages, contacted, confirm, conversation/report
  }
  if (p === '/api/admin/jobs/{id}/remove') return { who: null, path: { id: await openJob() } };
  if (p === '/api/admin/jobs/fees/{feeId}/waive') {
    const { id } = await awardedJob();
    await seed('POST', `/api/jobs/${id}/back-out`, B);
    const fee = (await db.query<{ id: number }>('select id from job_fees where job_id = $1 order by id', [id]))[0];
    if (!fee) throw new Error('seed: the back-out left no fee row');
    return { who: null, path: { feeId: String(fee.id) } };
  }
  if (p === '/api/admin/jobs/messages/{messageId}/remove') return { who: null, path: { messageId: String((await awardedJob()).messageId) } };
  if (p === '/api/admin/reports/{reportId}/resolve') {
    const { id } = await awardedJob();
    await seed('POST', `/api/jobs/${id}/conversation/report`, A, { reason: 'spam', note: 'TEST report (simulated)' });
    const row = (await db.query<{ id: number }>('select id from content_reports order by id desc limit 1'))[0];
    if (!row) throw new Error('seed: no content report row');
    return { who: null, path: { reportId: String(row.id) } };
  }
  if (p.startsWith('/api/people/{id}') || p.startsWith('/api/admin/people/{id}')) return { who: A, path: { id: B.id } };
  if (p.startsWith('/api/admin/') || p.startsWith('/api/cron/')) return { who: null, path: {} };
  return { who, path: { id: bidId } }; // /api/bids/{id}, /api/swipe/{id}; other path names keep their example
}

/** The spec's example, with the seeded objects' ids in place of the placeholders. */
function realValue(name: string, example: Yaml | undefined): string | undefined {
  if (name === 'bidId') return bidId;
  return example === undefined || example === null ? undefined : String(example);
}

function realBody(op: Operation): Obj | undefined {
  if (op.body === undefined || op.body === null || typeof op.body !== 'object' || Array.isArray(op.body)) return undefined;
  const body = structuredClone(op.body) as Obj;
  if ('bidId' in body) body.bidId = bidId;
  return body;
}

/** JSON text of `body` with the value at `at` (a field, or a field of a field) replaced by a raw token. */
function withField(body: Obj, at: string[], token: string): string | Buffer {
  const copy = structuredClone(body);
  let target = copy;
  for (const key of at.slice(0, -1)) target = target[key] as Obj;
  target[at[at.length - 1]!] = '\u0000HOSTILE\u0000';
  const text = JSON.stringify(copy).replace('"\\u0000HOSTILE\\u0000"', token);
  if (text.includes('HOSTILE')) throw new Error('no-5xx test: the hostile value was not put in');
  if (!text.includes('\u0000BADUTF8\u0000')) return text;
  const [before, after] = text.split('"\u0000BADUTF8\u0000"') as [string, string];
  return Buffer.concat([Buffer.from(`${before}"a`), Buffer.from([0xc3, 0x28, 0xff]), Buffer.from(`b"${after}`)]);
}

async function attack(op: Operation): Promise<void> {
  currentOp = `${op.method} ${op.path}`;
  reachedByOp.set(currentOp, 0);
  const world = await worldFor(op);
  const pathValue = (name: string) => world.path[name] ?? realValue(name, op.params.find((p) => p.name === name)?.example);
  const buildPath = (hostile?: { name: string; raw: string }) => op.path.replace(/\{([^}]+)\}/g, (_, name: string) =>
    (hostile?.name === name ? hostile.raw : enc(pathValue(name) ?? 'TEST-no-example')));
  const query = op.params.filter((p) => p.in === 'query');
  const buildQuery = (hostile?: { name: string; piece: string }) => query
    .map((p) => (p.name === hostile?.name ? hostile.piece : (() => { const v = realValue(p.name, p.example); return v === undefined ? '' : `${enc(p.name)}=${enc(v)}`; })()))
    .filter(Boolean).join('&');
  const url = (path: string, q: string) => (q ? `${path}?${q}` : path);
  const body = realBody(op);
  const bodyText = body ? JSON.stringify(body) : undefined;
  const call = (u: string, b: string | Buffer | undefined = bodyText) => send({ method: op.method, url: u, who: world.who, ...(b !== undefined ? { body: b } : {}) });

  // Hostile path values (the real id replaced), hostile query values, hostile body fields: one at a time.
  for (const p of op.params.filter((x) => x.in === 'path')) {
    for (const [, raw] of PATH) await call(url(buildPath({ name: p.name, raw }), buildQuery()));
  }
  for (const p of query) {
    for (const [, piece] of QUERY) await call(url(buildPath(), buildQuery({ name: p.name, piece: piece(p.name) })));
  }
  if (body) {
    // Each top-level field, and each field of a top-level object (valueRange.min, subscription.keys, ...).
    const fields: string[][] = [];
    for (const [field, v] of Object.entries(body)) {
      fields.push([field]);
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const sub of Object.keys(v)) fields.push([field, sub]);
    }
    for (const at of fields) {
      for (const [, token] of BODY) await call(url(buildPath(), buildQuery()), withField(body, at, token));
    }
    // A "__proto__" key next to the real fields (JSON.parse makes it an own property; a careless merge would not).
    const rest = JSON.stringify(body).slice(1);
    await call(url(buildPath(), buildQuery()), `{"__proto__":{"isAdmin":true}${rest === '}' ? '' : ','}${rest}`);
  }
  // Last, the documented example unchanged (with the real ids): it must be ACCEPTED (a 2xx). Anything else is listed,
  // a 400 too: an example the route's own validation refuses would mean every hostile variant of it was refused for
  // the example's sake, and the "reached a handler" counts would be made of validation answers only.
  const plain = await call(url(buildPath(), buildQuery()));
  if (plain.status < 200 || plain.status > 299) exampleRefused.push(`${op.method} ${op.path} → ${plain.status} ${plain.body.slice(0, 120)}`);
  // The same example from the other side (the other account, and signed out): the "not yours" branches.
  if (!op.publicRoute && world.who) {
    const other = world.who === A ? B : A;
    for (const who of [other, null]) {
      await send({ method: op.method, url: url(buildPath(), buildQuery()), who, ...(bodyText !== undefined ? { body: bodyText } : {}) });
    }
  }
}

// -------------------------------------------------------------------------------------------------- run --

beforeAll(async () => {
  process.env.PROMO_CODES = 'TEST-CODE:pro:100000';
  process.env.REALTIME_MODE = 'poll';
  (https as { request: unknown }).request = mockRequest;
  globalThis.fetch = (async (input: unknown) => { throw new Error(`no-5xx test: fetch(${String(input)}) would leave the machine`); }) as typeof fetch;

  db = await memoryDb();
  const config = accountsConfig({
    adminToken: ADMIN, cronSecret: CRON, appUrl: 'https://bidswipe.example.com',
    vapid: { ...generateVAPIDKeys(), subject: 'mailto:test@example.com' }, pushHosts: [...PUSH_SERVICE_HOSTS, PUSH_HOST],
  });
  const now = () => new Date(clock);
  const real = createAuth(db, config, { now, cost: { ln: 10, r: 8, p: 1 } });
  // Real sign-up, sign-in and sessions; a request carrying x-test-as is that account (read fresh, so a plan change shows).
  const auth = {
    ...real,
    authenticate: async (req: Parameters<typeof real.authenticate>[0]) => {
      const as = req.headers['x-test-as'];
      const email = typeof as === 'string' ? emails.get(as) : undefined;
      return email ? ((await findCredentials(db, email))?.account ?? null) : real.authenticate(req);
    },
  };
  const refuse = { text: async () => { throw new Error('TEST: no network in the no-5xx test'); }, json: async () => { throw new Error('TEST: no network in the no-5xx test'); } };
  const scan = async (req?: unknown) => ({ TEST: 'stub scan report (simulated)', req }) as unknown as ScanReport;
  const built = await buildApp({ db }, { config, auth, now, scan, marketHttp: { awards: refuse, bls: refuse } });
  app = built.app;
  ctx = built.ctx;
  rt = createRealtime(ctx, { tickMs: 0 });
  ctx.realtime = rt;

  // Two TEST accounts through the real sign-up, A made Pro by the operators' route, both onboarded.
  for (const [email, name] of [['scan-user@example.com', 'TEST Scan User (simulated)'], ['test-no5xx-b@example.com', 'TEST Bidder (simulated)']] as const) {
    await seed('POST', '/api/auth/signup', null, { email, password: PASSWORD, name });
    const account = (await findCredentials(db, email))!.account;
    emails.set(account.id, email);
    if (email.startsWith('scan-user')) A = account;
    else B = account;
  }
  await seed('POST', '/api/admin/plan', null, { email: 'scan-user@example.com', plan: 'pro' });
  const answers = { intent: 'both', businessName: 'TEST Foothill Electric (simulated)', trades: ['electrical'], zip: '95675', radiusMi: 100, valueRange: { min: 10_000, max: 500_000 } };
  await seed('PUT', '/api/profile', A, answers);
  await seed('PUT', '/api/profile', B, { ...answers, businessName: 'TEST Bidder Electric (simulated)' });

  // A stored TEST bid (far-off due date: the clock moves a lot), saved by A; a device; one awarded job so A and B
  // share a job (the people routes need that).
  await upsertBids(db, [testBid({ sourceId: 'TEST-no5xx-1', dueAt: '2028-12-01T22:00:00.000Z', title: 'TEST panel upgrade for the no-5xx test (synthetic)', location: { city: 'Auburn', state: 'CA' } })], new Date(clock));
  await seed('PUT', '/api/profile', A, answers); // scores the new bid for A
  await seed('POST', '/api/swipe', A, { bidId, action: 'save' });
  await seed('POST', '/api/push/subscribe', A, (operations.find((o) => o.path === '/api/push/subscribe' && o.method === 'POST')!.body));
  await awardedJob();
}, 60_000);

afterAll(async () => {
  rt?.stop();
  await app?.close();
  await db?.close();
  (https as { request: unknown }).request = realRequest;
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('no request in docs/api/openapi.yaml answers a 5xx (hostile values, signed in, real objects)', () => {
  it('reads the spec: every documented operation, with its parameters and example bodies', () => {
    expect(operations.length).toBeGreaterThan(60);
    expect(operations.filter((o) => o.params.some((p) => p.in === 'path')).length).toBeGreaterThan(20);
    expect(operations.filter((o) => o.body !== undefined).length).toBeGreaterThan(20);
    const awards = operations.find((o) => o.path === '/api/market/awards')!;
    expect(awards.params.map((p) => p.name)).toEqual(['bidId', 'naics', 'zip', 'radiusMi', 'months']);
    expect(operations.find((o) => o.path === '/api/push/subscribe' && o.method === 'POST')!.body).toMatchObject({ subscription: { endpoint: `https://${PUSH_HOST}/TEST-scan-device` } });
  });

  it('every operation, every hostile value: never a 5xx, and most answers come from a handler', async () => {
    const started = Date.now();
    for (const op of operations) await attack(op);
    const byStatus = Object.fromEntries([...counts.entries()].sort((a, b) => a[0] - b[0]));
    const refused = (counts.get(401) ?? 0) + (counts.get(404) ?? 0) + (counts.get(429) ?? 0);
    console.log(`no-5xx: ${operations.length} operations, ${total} requests in ${((Date.now() - started) / 1000).toFixed(1)} s; by status ${JSON.stringify(byStatus)}; `
      + `${total - refused} reached past 401/404/429`);
    if (exampleRefused.length) console.log(`no-5xx: examples refused:\n  ${exampleRefused.join('\n  ')}`);
    expect(fivexx, 'requests that answered a 5xx').toEqual([]);
    // The floor: the test must not pass by being refused everywhere (how two HawkScan runs looked clean).
    expect(counts.get(429) ?? 0, 'answers limited by a rate limit (the clock should have moved past every window)').toBe(0);
    expect(total - refused).toBeGreaterThan(total * 0.6);
    expect(exampleRefused, 'documented examples, with real ids, that were not accepted (no 2xx)').toEqual(EXPECTED_REFUSED);
    // And per operation: each one had answers from its handler, except the two refused by design above.
    const never = [...reachedByOp].filter(([, n]) => n === 0).map(([op]) => op);
    // (oauth's hostile bodies are answered 400 by its handler before the "not configured" check.)
    expect(never, 'operations whose every answer was 401, 404 or 429').toEqual(['GET /api/stream']);
    // POST /api/account/delete was attacked as A, as B and signed out, and no value was a right password: both seeded
    // accounts are still here, with their sessions' worth of data (a deleted A would have hollowed out every later route).
    for (const email of ['scan-user@example.com', 'test-no5xx-b@example.com']) expect(await findCredentials(db, email), email).not.toBeNull();
  }, 120_000);
});

/** Examples that are not accepted (no 2xx) by design in this setup, and why. Anything else here means the seeding broke. */
const EXPECTED_REFUSED: string[] = [
  // The example's address is the seeded scan user's own: the account exists, and the answer says so without saying which.
  'POST /api/auth/signup → 409 {"error":"signup_failed","message":"Could not create that account. If you already have one, sign in instead."}',
  // Supabase sign-in is not configured here (and the test never talks to an outside service).
  'POST /api/auth/oauth → 404 {"error":"oauth_not_configured","message":"That sign-in method is not set up here."}',
  // On purpose: the example's password is NOT the seeded accounts' (TEST-password-123). The right one would delete
  // the scan user in the middle of the run and leave every later route without its account and objects. The route's
  // success, its limits and every refusal are tested on throwaway accounts in test/account-delete.test.ts.
  'POST /api/account/delete → 401 {"error":"wrong_password","message":"That password isn’t right."}',
  // Poll mode (see the top of the file): the stream route answers this before reading anything.
  'GET /api/stream → 404 {"error":"stream_off","pollMs":60000}',
];
