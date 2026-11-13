import { lookupZip, statesWithin } from '../geo/zip.js';
import { getTrade, mergeTrades } from '../trades/catalog.js';
import type { AlertSettings, CostSettings, Profile, QualAnswer, Qualifications, SpendLimits } from '../types.js';

/** What the sign-up / settings form sends (PUT /api/profile). */
export interface OnboardingAnswers {
  businessName: string;
  /** Trade ids from src/trades/catalog.ts. */
  trades: string[];
  /** Home ZIP — becomes Profile.base via src/geo/zip.ts. */
  zip: string;
  radiusMi: number;
  valueRange: { min: number; max: number };
  limits?: SpendLimits;
  costs?: CostSettings;
  alerts?: AlertSettings;
  /** SAM.gov set-aside codes the business qualifies for. */
  setAsides?: string[];
  /**
   * "Your paperwork": optional. Old clients and the simulation send none, and then nothing changes.
   * A key left out of the object counts as 'unsure' (the screen's "unanswered counts as Not sure").
   */
  qualifications?: Qualifications;
}

/** errors: field name → one plain-English sentence the form shows under that field. */
export type AnswersResult = { ok: true; value: OnboardingAnswers } | { ok: false; errors: Record<string, string> };

const NAME_LENGTH = { min: 2, max: 80 };
const MAX_TRADES = 4;
const RADIUS_MI = { min: 5, max: 500 };
const MIN_DAYS_TO_BID = 5;
/** Where "good fit" starts (verdictFor in src/score/score.ts): the default digest and alert threshold. */
const GOOD_FIT = 55;

/**
 * The set-aside codes SAM.gov puts on a notice (Get Opportunities API, `typeOfSetAside`), with short labels
 * for the form. A business ticks the programs it is in; bids set aside for anything else lose points.
 */
export const SET_ASIDES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'SBA', label: 'Small business' },
  { code: 'SBP', label: 'Small business (partial set-aside)' },
  { code: '8A', label: '8(a)' },
  { code: '8AN', label: '8(a) sole source' },
  { code: 'HZC', label: 'HUBZone' },
  { code: 'HZS', label: 'HUBZone sole source' },
  { code: 'SDVOSBC', label: 'Service-disabled veteran-owned small business' },
  { code: 'SDVOSBS', label: 'Service-disabled veteran-owned sole source' },
  { code: 'WOSB', label: 'Women-owned small business' },
  { code: 'WOSBSS', label: 'Women-owned sole source' },
  { code: 'EDWOSB', label: 'Economically disadvantaged women-owned small business' },
  { code: 'EDWOSBSS', label: 'Economically disadvantaged women-owned sole source' },
  { code: 'LAS', label: 'Local area (disaster area) set-aside' },
  { code: 'IEE', label: 'Indian Economic Enterprise (Interior)' },
  { code: 'ISBEE', label: 'Indian Small Business Economic Enterprise (Interior)' },
  { code: 'BICiv', label: 'Buy Indian (Indian Health Service)' },
  { code: 'VSA', label: 'Veteran-owned small business (VA)' },
  { code: 'VSS', label: 'Veteran-owned small business sole source (VA)' },
];

/** Two codes for one program (total / partial, competitive / sole source): in for one means in for both. */
const SET_ASIDE_PAIRS = [
  ['SBA', 'SBP'], ['8A', '8AN'], ['HZC', 'HZS'], ['SDVOSBC', 'SDVOSBS'], ['WOSB', 'WOSBSS'], ['EDWOSB', 'EDWOSBSS'], ['VSA', 'VSS'],
];

/** The other code of a code's program (SBA → SBP), or null when the program has one code. */
export function setAsidePartner(code: string): string | null {
  const pair = SET_ASIDE_PAIRS.find((p) => p.includes(code));
  return pair ? pair.find((c) => c !== code)! : null;
}

function withPairs(codes: readonly string[]): string[] {
  const all = new Set(codes);
  for (const pair of SET_ASIDE_PAIRS) if (pair.some((c) => all.has(c))) for (const c of pair) all.add(c);
  return SET_ASIDES.map((s) => s.code).filter((c) => all.has(c));
}

// ------------------------------------------------------------ validation --

type Dict = Record<string, unknown>;
type Fail = (field: string, message: string) => void;

const FIELDS = ['businessName', 'trades', 'zip', 'radiusMi', 'valueRange', 'limits', 'costs', 'alerts', 'setAsides', 'qualifications'];
/** The four paperwork questions, in the order the screen asks them. */
export const QUALIFICATION_KEYS = ['statePublicWorks', 'samRegistered', 'bonding', 'prevailingWage'] as const;
const QUAL_ANSWERS: readonly QualAnswer[] = ['yes', 'no', 'unsure'];
const QUAL_LABELS: Record<keyof Qualifications, string> = {
  statePublicWorks: 'State public works', samRegistered: 'SAM.gov registration', bonding: 'Bonding', prevailingWage: 'Prevailing wage',
};
const LIMIT_LABELS: Record<keyof SpendLimits, string> = {
  maxJobSize: 'Max job size', maxUpfront: 'Max up-front cost', bondingCapacity: 'Bonding capacity',
};
const COST_LABELS: Record<keyof CostSettings, string> = {
  laborRate: 'Labor rate', burdenPct: 'Burden %', overheadPct: 'Overhead %', profitPct: 'Profit %',
};
const ALERT_KINDS = ['match', 'deadline', 'award', 'price'] as const;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
/** User text quoted back in a message: short, on one line. */
const quote = (v: unknown) => `“${String(v).replace(/\s+/g, ' ').slice(0, 40)}”`;

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A misspelled key must be an error: `limits.maxJobsize` silently dropped would be a spend limit that is not there. */
function rejectUnknown(obj: Dict, known: readonly string[], prefix: string, fail: Fail): void {
  for (const key of Object.keys(obj)) if (!known.includes(key)) fail(`${prefix}${key}`, `Unknown field ${quote(prefix + key)}.`);
}

/** An optional group of settings at `path`: absent or null → undefined, an object → checked for unknown keys. */
function group(v: unknown, path: string, known: readonly string[], fail: Fail): Dict | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isDict(v)) {
    fail(path, `${quote(path)} must be a group of settings.`);
    return undefined;
  }
  rejectUnknown(v, known, `${path}.`, fail);
  return v;
}

/** Numbers that must be 0 or more. null = left blank (not set); a key that is absent stays absent. */
function amounts<K extends string>(
  src: Dict | undefined, prefix: string, labels: Record<K, string>, fail: Fail,
): Partial<Record<K, number | null>> | undefined {
  if (!src) return undefined;
  const out: Partial<Record<K, number | null>> = {};
  for (const key of Object.keys(labels) as K[]) {
    const v = src[key];
    if (v === undefined) continue;
    if (v === null || isAmount(v)) out[key] = v;
    else fail(`${prefix}.${key}`, `${labels[key]} must be a number, 0 or more (leave it blank to skip).`);
  }
  return out;
}

function readName(v: unknown, fail: Fail): string {
  const name = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!name) fail('businessName', 'Enter your business name.');
  else if (name.length < NAME_LENGTH.min) fail('businessName', `Business name needs at least ${NAME_LENGTH.min} characters.`);
  else if (name.length > NAME_LENGTH.max) fail('businessName', `Business name can be at most ${NAME_LENGTH.max} characters.`);
  return name;
}

function readTrades(v: unknown, fail: Fail): string[] {
  if (!Array.isArray(v) || v.length === 0) {
    fail('trades', 'Pick at least one trade.');
    return [];
  }
  const bad = v.findIndex((id) => typeof id !== 'string' || !getTrade(id));
  if (bad !== -1) {
    fail('trades', `Unknown trade ${quote(v[bad])}.`);
    return [];
  }
  const ids = mergeTrades(v as string[]).trades; // de-duplicated, in catalog order
  if (ids.length > MAX_TRADES) fail('trades', `Pick up to ${MAX_TRADES} trades.`);
  return ids;
}

function readZip(v: unknown, fail: Fail): string {
  const zip = typeof v === 'string' ? /^\s*(\d{5})(?:[-\s]?\d{4})?\s*$/.exec(v)?.[1] : undefined;
  if (!zip) fail('zip', 'Enter a 5-digit ZIP code.');
  else if (!lookupZip(zip)) fail('zip', `We can’t find ZIP ${zip}. Check the number.`);
  return zip ?? '';
}

function readRadius(v: unknown, fail: Fail): number {
  if (typeof v === 'number' && v >= RADIUS_MI.min && v <= RADIUS_MI.max) return v;
  fail('radiusMi', `Travel radius must be a number from ${RADIUS_MI.min} to ${RADIUS_MI.max} miles.`);
  return 0;
}

function readRange(v: unknown, fail: Fail): { min: number; max: number } {
  const none = { min: 0, max: 0 };
  if (!isDict(v)) {
    fail('valueRange', 'Enter the smallest and the largest job you want.');
    return none;
  }
  rejectUnknown(v, ['min', 'max'], 'valueRange.', fail);
  const { min, max } = v;
  if (!isAmount(min)) fail('valueRange.min', 'Smallest job must be a dollar amount, 0 or more.');
  if (!isAmount(max)) fail('valueRange.max', 'Largest job must be a dollar amount.');
  if (!isAmount(min) || !isAmount(max)) return none;
  if (min >= max) fail('valueRange.max', 'Largest job must be more than the smallest job.');
  return { min, max };
}

function readAlerts(src: Dict | undefined, fail: Fail): AlertSettings | undefined {
  if (!src) return undefined;
  const out: AlertSettings = {};
  const { minScore, push, quietHours, timeZone } = src;

  if (typeof minScore === 'number' && minScore >= 0 && minScore <= 100) out.minScore = minScore;
  else if (minScore !== undefined) fail('alerts.minScore', 'Alert score must be a number from 0 to 100.');

  if (typeof push === 'boolean') out.push = push;
  else if (push !== undefined) fail('alerts.push', 'Phone alerts must be on (true) or off (false).');

  if (quietHours === null) out.quietHours = null;
  else if (quietHours !== undefined) {
    const hours = isDict(quietHours) ? quietHours : {};
    rejectUnknown(hours, ['start', 'end'], 'alerts.quietHours.', fail);
    const { start, end } = hours;
    if (typeof start !== 'string' || typeof end !== 'string' || !CLOCK.test(start) || !CLOCK.test(end)) {
      fail('alerts.quietHours', 'Quiet hours need a start and an end time like 21:00 and 06:00.');
    } else if (start === end) {
      fail('alerts.quietHours', 'Quiet hours need different start and end times (turn them off instead).');
    } else {
      out.quietHours = { start, end };
    }
  }

  if (typeof timeZone === 'string' && isTimeZone(timeZone)) out.timeZone = timeZone;
  else if (timeZone !== undefined) fail('alerts.timeZone', `Unknown time zone ${quote(timeZone)}.`);

  const given = group(src.kinds, 'alerts.kinds', ALERT_KINDS, fail);
  if (given) {
    const kinds: NonNullable<AlertSettings['kinds']> = {};
    for (const kind of ALERT_KINDS) {
      const on = given[kind];
      if (typeof on === 'boolean') kinds[kind] = on;
      else if (on !== undefined) fail(`alerts.kinds.${kind}`, `The ${quote(kind)} alert must be on (true) or off (false).`);
    }
    out.kinds = kinds;
  }
  return out;
}

function readSetAsides(v: unknown, fail: Fail): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    fail('setAsides', 'Set-asides must be a list of codes.');
    return undefined;
  }
  const codes = new Set<string>();
  for (const item of v) {
    const known = typeof item === 'string' ? SET_ASIDES.find((s) => s.code.toLowerCase() === item.trim().toLowerCase()) : undefined;
    if (known) codes.add(known.code);
    else fail('setAsides', `Unknown set-aside code ${quote(item)}.`);
  }
  return [...codes];
}

/** absent or null → undefined (never asked); an object → all four answers, a missing one as 'unsure'. */
function readQualifications(v: unknown, fail: Fail): Qualifications | undefined {
  const src = group(v, 'qualifications', QUALIFICATION_KEYS, fail);
  if (!src) return undefined;
  const out = {} as Qualifications;
  for (const key of QUALIFICATION_KEYS) {
    const a = src[key];
    if (a === undefined || a === null) out[key] = 'unsure';
    else if (typeof a === 'string' && (QUAL_ANSWERS as readonly string[]).includes(a)) out[key] = a as QualAnswer;
    else fail(`qualifications.${key}`, `${QUAL_LABELS[key]} must be yes, no or unsure.`);
  }
  return out;
}

/**
 * Check and normalize untrusted form input. Nothing gets past it unchecked: unknown keys are errors
 * (at any depth), names are trimmed, trades are de-duplicated into catalog order, the ZIP must exist.
 * Every error is keyed by the field's path ("zip", "valueRange.max", "limits.maxJobSize"); "form" = the whole body.
 */
export function validateAnswers(input: unknown): AnswersResult {
  if (!isDict(input)) return { ok: false, errors: { form: 'Send your answers as one JSON object.' } };
  // A Map, not an object: a key named "__proto__" must be reported like any other unknown field.
  const errors = new Map<string, string>();
  const fail: Fail = (field, message) => {
    if (!errors.has(field)) errors.set(field, message); // the first problem with a field is the one to fix first
  };
  rejectUnknown(input, FIELDS, '', fail);

  const value: OnboardingAnswers = {
    businessName: readName(input.businessName, fail),
    trades: readTrades(input.trades, fail),
    zip: readZip(input.zip, fail),
    radiusMi: readRadius(input.radiusMi, fail),
    valueRange: readRange(input.valueRange, fail),
  };
  const limits = amounts(group(input.limits, 'limits', Object.keys(LIMIT_LABELS), fail), 'limits', LIMIT_LABELS, fail);
  const costs = amounts(group(input.costs, 'costs', Object.keys(COST_LABELS), fail), 'costs', COST_LABELS, fail);
  const alerts = readAlerts(group(input.alerts, 'alerts', ['minScore', 'push', 'quietHours', 'timeZone', 'kinds'], fail), fail);
  const setAsides = readSetAsides(input.setAsides, fail);
  const qualifications = readQualifications(input.qualifications, fail);
  if (limits) value.limits = limits;
  if (costs) value.costs = costs;
  if (alerts) value.alerts = alerts;
  if (setAsides) value.setAsides = setAsides;
  if (qualifications) value.qualifications = qualifications;

  return errors.size ? { ok: false, errors: Object.fromEntries(errors) } : { ok: true, value };
}

// --------------------------------------------------------------- building --

/**
 * Answers → a full scoring Profile: trade templates give the keywords and NAICS codes, the ZIP gives the
 * home base, the radius gives the states. `answers` must have passed validateAnswers (throws on an
 * unknown ZIP or trade). Saving the summary of the result back as answers builds the same profile again.
 */
export function buildProfile(profileId: string, answers: OnboardingAnswers): Profile {
  const place = lookupZip(answers.zip);
  if (!place) throw new Error(`buildProfile: unknown ZIP "${answers.zip}"`);
  const mix = mergeTrades(answers.trades);
  return {
    id: profileId,
    name: answers.businessName,
    base: { label: `${place.city}, ${place.state}`, lat: place.lat, lng: place.lng },
    // Home state first. A bid with no map point is kept only when its state is on this list.
    states: [...new Set([place.state, ...statesWithin(place, answers.radiusMi)])],
    maxDistanceMi: answers.radiusMi,
    valueRange: { min: answers.valueRange.min, max: answers.valueRange.max },
    minDaysToBid: MIN_DAYS_TO_BID,
    keywords: mix.keywords,
    naics: mix.naics,
    // Nothing ticked = no set-aside claimed: we do not assume a business is small.
    setAsidesEligible: withPairs(answers.setAsides ?? []),
    notify: { minScore: GOOD_FIT },
    trades: mix.trades,
    zip: place.zip,
    limits: { ...answers.limits },
    costs: { ...answers.costs },
    alerts: { minScore: GOOD_FIT, ...answers.alerts },
    // Only when answered: a profile that was never asked keeps no key, so it scores exactly as before.
    ...(answers.qualifications ? { qualifications: { ...answers.qualifications } } : {}),
  };
}

/**
 * The id of the one profile an account owns. Stable (matches, swipes and alerts hang off it) and
 * always a valid profile id (lowercase letters, digits, dashes).
 */
export function profileIdFor(accountId: string): string {
  return `acct-${accountId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

/** A profile as the app shows and edits it: the answers back out, without the keyword lists. */
export interface ProfileSummary {
  id: string;
  businessName: string;
  trades: string[];
  zip: string | null;
  /** Home base label, e.g. "Gardnerville, NV". */
  base: string;
  radiusMi: number;
  valueRange: { min: number; max: number };
  limits: SpendLimits;
  costs: CostSettings;
  /** minScore is always filled in (falls back to the digest threshold). */
  alerts: AlertSettings & { minScore: number };
  setAsides: string[];
  /** Only present when the company answered "Your paperwork". */
  qualifications?: Qualifications;
}

export function summarize(profile: Profile): ProfileSummary {
  return {
    id: profile.id,
    businessName: profile.name,
    trades: profile.trades ?? [],
    zip: profile.zip ?? null,
    base: profile.base.label,
    radiusMi: profile.maxDistanceMi,
    valueRange: profile.valueRange,
    limits: profile.limits ?? {},
    costs: profile.costs ?? {},
    alerts: { ...profile.alerts, minScore: profile.alerts?.minScore ?? profile.notify.minScore },
    setAsides: profile.setAsidesEligible,
    ...(profile.qualifications ? { qualifications: { ...profile.qualifications } } : {}),
  };
}
