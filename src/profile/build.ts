import type { AlertSettings, CostSettings, Profile, SpendLimits } from '../types.js';

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
}

/** errors: field name → one plain-English sentence the form shows under that field. */
export type AnswersResult = { ok: true; value: OnboardingAnswers } | { ok: false; errors: Record<string, string> };

/** Check and normalize untrusted form input. STUB (foundation): not implemented. */
export function validateAnswers(_input: unknown): AnswersResult {
  throw new Error('validateAnswers: not implemented');
}

/** Answers → a full scoring Profile (trade templates, ZIP → base, radius → states). STUB (foundation): not implemented. */
export function buildProfile(_profileId: string, _answers: OnboardingAnswers): Profile {
  throw new Error('buildProfile: not implemented');
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
  };
}
