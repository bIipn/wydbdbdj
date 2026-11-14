/**
 * Work profiles: what someone tells other people about their work (like a short Indeed profile), and what
 * brought them to BidSwipe. Stored per account in work_profiles (src/db/work.ts); shown to others only as a
 * PersonCard (src/profile/person.ts), and only to people they have dealt with on a job.
 *
 * Everything here is untrusted input until validateWorkProfile has read it. Each bad field gets one plain
 * sentence, keyed by its path ("experience.2.from"), so the form can put it under the right box.
 */
import type { Experience } from './person.js';

/** Why someone is here: find work (bids and local jobs), get work done (post jobs), or both. */
export type Intent = 'work' | 'hire' | 'both';
export const INTENTS: readonly Intent[] = ['work', 'hire', 'both'];
export const isIntent = (v: unknown): v is Intent => INTENTS.includes(v as Intent);

export type Insured = 'yes' | 'no' | 'unsure';
export const LOOKING_KINDS = ['side_jobs', 'subcontract', 'full_time', 'emergency'] as const;
export const AVAILABILITY = ['weekdays', 'evenings', 'weekends'] as const;
export type LookingKind = (typeof LOOKING_KINDS)[number];
export type Availability = (typeof AVAILABILITY)[number];

export interface WorkProfile {
  intent: Intent;
  headline: string | null;
  about: string | null;
  yearsExperience: number | null;
  skills: string[];
  /** As the person typed it. BidSwipe does not verify licences. */
  license: { state: string; number: string } | null;
  insured: Insured;
  experience: Experience[];
  /** http or https only. */
  resumeUrl: string | null;
  lookingFor: { kinds: LookingKind[]; availability: Availability[] };
}

/** Limits from the contract (docs: jobs-contract §5), plus the few it leaves open. */
export const WORK_LIMITS = {
  headline: 80,
  about: 600,
  years: { min: 0, max: 70 },
  skills: 12,
  skill: 30,
  licenseNumber: 40,
  experience: 10,
  title: 80,
  company: 80,
  summary: 300,
  url: 500,
  firstYear: 1950,
} as const;

/** What an account has before it saves anything: here to find work, nothing filled in. */
export function defaultWorkProfile(): WorkProfile {
  return {
    intent: 'work', headline: null, about: null, yearsExperience: null, skills: [], license: null, insured: 'unsure',
    experience: [], resumeUrl: null, lookingFor: { kinds: [], availability: [] },
  };
}

/** The licence states: the 50 states, DC and the territories (two-letter USPS codes). */
export const LICENSE_STATES: readonly string[] = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR', 'GU', 'VI', 'AS', 'MP',
];

// ------------------------------------------------------------ validation --

/** One problem: the field's path and one plain sentence (the jobs API's error shape). */
export interface FieldError { path: string; message: string }
export type WorkResult = { ok: true; value: WorkProfile } | { ok: false; fields: FieldError[] };

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);
const KEYS = ['intent', 'headline', 'about', 'yearsExperience', 'skills', 'license', 'insured', 'experience', 'resumeUrl', 'lookingFor'] as const;
const EXPERIENCE_KEYS = ['title', 'company', 'from', 'to', 'summary'];

/** User text quoted back in a message: short, on one line. */
const quote = (v: unknown) => `“${String(v).replace(/\s+/g, ' ').slice(0, 30)}”`;

/**
 * Text that leaves our hands to other people's screens: no control characters (they can hide text or break
 * a layout). One-line fields also collapse runs of spaces; `about` and summaries keep their line breaks.
 */
function clean(v: string, multiline: boolean): string {
  // eslint-disable-next-line no-control-regex
  const noControls = v.replace(multiline ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, ' ');
  return multiline
    ? noControls.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    : noControls.replace(/\s+/g, ' ').trim();
}

/**
 * The checker. `stored` is what the account has now: PUT may send only the fields it changes (Settings sends
 * "what brings you here" on its own), and a field it leaves out keeps its stored value. `now` sets the
 * latest year an experience entry may use.
 */
export function validateWorkProfile(input: unknown, now: Date, stored: WorkProfile = defaultWorkProfile()): WorkResult {
  if (!isDict(input)) return { ok: false, fields: [{ path: 'form', message: 'Send your work profile as one JSON object.' }] };
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  const fail = (path: string, message: string) => {
    if (seen.has(path)) return; // the first problem with a field is the one to fix first
    seen.add(path);
    errors.push({ path, message });
  };
  // A misspelled key must be an error: "lookingfor" silently dropped would be a choice that never saves.
  for (const key of Object.keys(input)) if (!(KEYS as readonly string[]).includes(key)) fail(key, `Unknown field ${quote(key)}.`);

  const has = (k: (typeof KEYS)[number]) => input[k] !== undefined;
  const thisYear = now.getUTCFullYear();
  const out: WorkProfile = structuredClone(stored);

  if (has('intent')) {
    if (isIntent(input.intent)) out.intent = input.intent;
    else fail('intent', 'Pick find work, get work done, or both.');
  }
  if (has('headline')) out.headline = readText(input.headline, 'headline', 'Headline', WORK_LIMITS.headline, false, fail);
  if (has('about')) out.about = readText(input.about, 'about', 'About', WORK_LIMITS.about, true, fail);

  if (has('yearsExperience')) {
    const y = input.yearsExperience;
    if (y === null) out.yearsExperience = null;
    else if (typeof y === 'number' && Number.isInteger(y) && y >= WORK_LIMITS.years.min && y <= WORK_LIMITS.years.max) out.yearsExperience = y;
    else fail('yearsExperience', `Years in the trade must be a whole number from ${WORK_LIMITS.years.min} to ${WORK_LIMITS.years.max}.`);
  }

  if (has('skills')) out.skills = readSkills(input.skills, fail);

  if (has('license')) out.license = readLicense(input.license, fail);

  if (has('insured')) {
    const v = input.insured;
    if (v === 'yes' || v === 'no' || v === 'unsure') out.insured = v;
    else fail('insured', 'Insured must be yes, no or not sure.');
  }

  if (has('experience')) out.experience = readExperience(input.experience, thisYear, fail);

  if (has('resumeUrl')) out.resumeUrl = readUrl(input.resumeUrl, fail);

  if (has('lookingFor')) out.lookingFor = readLookingFor(input.lookingFor, fail);

  return errors.length ? { ok: false, fields: errors } : { ok: true, value: out };
}

type Fail = (path: string, message: string) => void;

/** null, '' or only spaces → null (left empty). */
function readText(v: unknown, path: string, label: string, max: number, multiline: boolean, fail: Fail): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') {
    fail(path, `${label} must be text.`);
    return null;
  }
  const text = clean(v, multiline);
  if (text.length > max) fail(path, `${label} can be at most ${max} characters (it has ${text.length}).`);
  return text || null;
}

function readSkills(v: unknown, fail: Fail): string[] {
  if (!Array.isArray(v)) {
    fail('skills', 'Skills must be a list.');
    return [];
  }
  const out: string[] = [];
  const lower = new Set<string>();
  v.forEach((item, i) => {
    if (typeof item !== 'string') return fail(`skills.${i}`, 'Each skill must be text.');
    const s = clean(item, false);
    if (!s) return; // an empty box is not a skill; drop it quietly
    if (s.length > WORK_LIMITS.skill) return fail(`skills.${i}`, `A skill can be at most ${WORK_LIMITS.skill} characters: ${quote(s)} is longer.`);
    if (lower.has(s.toLowerCase())) return; // the same skill twice is one skill
    lower.add(s.toLowerCase());
    out.push(s);
  });
  if (out.length > WORK_LIMITS.skills) fail('skills', `Pick up to ${WORK_LIMITS.skills} skills.`);
  return out;
}

function readLicense(v: unknown, fail: Fail): WorkProfile['license'] {
  if (v === null) return null;
  if (!isDict(v)) {
    fail('license', 'Licence must have a state and a number.');
    return null;
  }
  for (const key of Object.keys(v)) if (key !== 'state' && key !== 'number') fail(`license.${key}`, `Unknown field ${quote(`license.${key}`)}.`);
  const state = typeof v.state === 'string' ? v.state.trim().toUpperCase() : '';
  const number = typeof v.number === 'string' ? clean(v.number, false) : '';
  // Both empty = no licence entered: the person cleared the two boxes.
  if (!state && !number) return null;
  if (!LICENSE_STATES.includes(state)) fail('license.state', 'Pick the state that issued the licence.');
  if (!number) fail('license.number', 'Enter the licence number, or clear the state to leave it out.');
  else if (number.length > WORK_LIMITS.licenseNumber) fail('license.number', `Licence number can be at most ${WORK_LIMITS.licenseNumber} characters.`);
  return { state, number };
}

const isYear = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function readExperience(v: unknown, thisYear: number, fail: Fail): Experience[] {
  if (!Array.isArray(v)) {
    fail('experience', 'Experience must be a list.');
    return [];
  }
  if (v.length > WORK_LIMITS.experience) fail('experience', `Add up to ${WORK_LIMITS.experience} jobs.`);
  const years = `a year from ${WORK_LIMITS.firstYear} to ${thisYear}`;
  return v.slice(0, WORK_LIMITS.experience).map((item, i): Experience => {
    const p = `experience.${i}`;
    const none: Experience = { title: '', company: null, from: null, to: null, summary: null };
    if (!isDict(item)) {
      fail(p, 'Each job needs at least a title.');
      return none;
    }
    for (const key of Object.keys(item)) if (!EXPERIENCE_KEYS.includes(key)) fail(`${p}.${key}`, `Unknown field ${quote(key)}.`);
    const title = typeof item.title === 'string' ? clean(item.title, false) : '';
    if (!title) fail(`${p}.title`, 'Enter a job title.');
    else if (title.length > WORK_LIMITS.title) fail(`${p}.title`, `Job title can be at most ${WORK_LIMITS.title} characters.`);
    const company = item.company == null ? null : readText(item.company, `${p}.company`, 'Company', WORK_LIMITS.company, false, fail);
    const summary = item.summary == null ? null : readText(item.summary, `${p}.summary`, 'Summary', WORK_LIMITS.summary, true, fail);

    let from: number | null = null;
    if (item.from != null) {
      if (isYear(item.from) && item.from >= WORK_LIMITS.firstYear && item.from <= thisYear) from = item.from;
      else fail(`${p}.from`, `“From” must be ${years}.`);
    }
    // `to` null (or absent) = still there ("present").
    let to: number | null = null;
    if (item.to != null) {
      if (isYear(item.to) && item.to >= WORK_LIMITS.firstYear && item.to <= thisYear) to = item.to;
      else fail(`${p}.to`, `“To” must be ${years}, or “present”.`);
    }
    if (from !== null && to !== null && to < from) fail(`${p}.to`, '“To” can’t be before “From”.');
    return { title, company, from, to, summary };
  });
}

/**
 * Only an http(s) link someone can open, with no user name or password inside it (a link like
 * https://user:pass@host would hand a login to everyone who sees the card). Blank = no link.
 */
function readUrl(v: unknown, fail: Fail): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') {
    fail('resumeUrl', 'The link must be text.');
    return null;
  }
  const text = v.trim();
  if (!text) return null;
  const bad = () => {
    fail('resumeUrl', 'Use a full web link that starts with http:// or https://.');
    return null;
  };
  if (text.length > WORK_LIMITS.url) {
    fail('resumeUrl', `The link can be at most ${WORK_LIMITS.url} characters.`);
    return null;
  }
  if (/\s/.test(text) || !/^https?:\/\//i.test(text)) return bad();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return bad();
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname.includes('.')) return bad();
  if (url.username || url.password) {
    fail('resumeUrl', 'Take the user name and password out of the link.');
    return null;
  }
  return url.href;
}

function readLookingFor(v: unknown, fail: Fail): WorkProfile['lookingFor'] {
  const empty = { kinds: [] as LookingKind[], availability: [] as Availability[] };
  if (v === null) return empty;
  if (!isDict(v)) {
    fail('lookingFor', 'Pick what you are looking for from the list.');
    return empty;
  }
  for (const key of Object.keys(v)) if (key !== 'kinds' && key !== 'availability') fail(`lookingFor.${key}`, `Unknown field ${quote(key)}.`);
  const pick = <T extends string>(list: unknown, allowed: readonly T[], path: string, what: string): T[] => {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || list.some((x) => !allowed.includes(x as T))) {
      fail(path, `Pick ${what} from the list.`);
      return [];
    }
    return allowed.filter((a) => list.includes(a)); // de-duplicated, in the screen's order
  };
  return {
    kinds: pick(v.kinds, LOOKING_KINDS, 'lookingFor.kinds', 'the kinds of work'),
    availability: pick(v.availability, AVAILABILITY, 'lookingFor.availability', 'when you can work'),
  };
}

/** A stored row read back: anything missing or odd (an older shape) falls back to the default for that field. */
export function readStoredWorkProfile(raw: unknown): WorkProfile {
  const base = defaultWorkProfile();
  if (!isDict(raw)) return base;
  // Stored rows passed the checker when they were saved; re-checking them keeps one source of truth for the
  // shape and drops any field an older version stored but this one no longer knows.
  const known = Object.fromEntries(Object.entries(raw).filter(([k]) => (KEYS as readonly string[]).includes(k)));
  const later = new Date(8.64e15); // the latest date there is: a year saved last year stays valid
  const r = validateWorkProfile(known, later, base);
  if (r.ok) return r.value;
  // One odd field must not wipe the rest: drop the fields that failed and keep the others.
  const broken = new Set(r.fields.map((f) => f.path.split('.')[0]));
  const again = validateWorkProfile(Object.fromEntries(Object.entries(known).filter(([k]) => !broken.has(k))), later, base);
  return again.ok ? again.value : base;
}
