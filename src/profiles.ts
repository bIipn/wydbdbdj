import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Profile } from './types.js';

const CONFIG_DIR = resolve(process.cwd(), 'config');

/** Light validation so a typo in the JSON fails loudly at startup instead of scoring everything 0. */
export function validateProfile(p: unknown, file = 'profile'): Profile {
  const errors: string[] = [];
  const o = p as Partial<Profile>;
  const need = (cond: unknown, msg: string) => {
    if (!cond) errors.push(msg);
  };
  need(typeof o.id === 'string' && /^[a-z0-9-]+$/.test(o.id), 'id: lowercase letters, digits, dashes');
  need(typeof o.name === 'string', 'name: string');
  need(o.base && Number.isFinite(o.base.lat) && Number.isFinite(o.base.lng), 'base: { label, lat, lng }');
  need(Array.isArray(o.states), 'states: ["NV", ...]');
  need(Number.isFinite(o.maxDistanceMi), 'maxDistanceMi: number');
  need(o.valueRange && Number.isFinite(o.valueRange.min) && Number.isFinite(o.valueRange.max), 'valueRange: { min, max }');
  need(Number.isFinite(o.minDaysToBid), 'minDaysToBid: number');
  for (const k of ['strong', 'related', 'general', 'otherTrades', 'exclude'] as const) {
    need(Array.isArray(o.keywords?.[k]), `keywords.${k}: string[]`);
  }
  need(Array.isArray(o.naics?.strong) && Array.isArray(o.naics?.related), 'naics: { strong: [], related: [] }');
  need(Array.isArray(o.setAsidesEligible), 'setAsidesEligible: string[]');
  need(Number.isFinite(o.notify?.minScore), 'notify: { minScore }');
  if (errors.length) throw new Error(`Invalid ${file}:\n  - ${errors.join('\n  - ')}`);
  return o as Profile;
}

export function loadProfile(id: string, dir = CONFIG_DIR): Profile {
  const file = resolve(dir, `${id}.json`);
  if (!existsSync(file)) throw new Error(`No profile config at ${file}`);
  return validateProfile(JSON.parse(readFileSync(file, 'utf8')), file);
}

export function loadAllProfiles(dir = CONFIG_DIR): Profile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => validateProfile(JSON.parse(readFileSync(resolve(dir, f), 'utf8')), f));
}
