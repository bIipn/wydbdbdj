/**
 * The simulated companies of `npm run simulate`. NONE of them is real: every name starts with "SIM" and ends
 * with "(simulated)", every email is sim-NN@example.com, and every figure they type (value ranges, spend
 * limits, bonding capacity) is a made-up setting of the persona, labelled simulated wherever it is reported.
 *
 * They are chosen to cover the places, trades, sizes, limits, certifications and plans the product has to
 * get right, each with a one-line reason. The ZIPs are real (src/geo/zip.ts resolves them); the companies are not.
 */
import type { OnboardingAnswers } from '../profile/build.js';
import type { Plan } from '../types.js';

export interface Persona {
  /** "sim-01" … */
  key: string;
  email: string;
  /** Simulated sign-up password. Never a real one. */
  password: string;
  plan: Extract<Plan, 'free' | 'pro'>;
  /** What PUT /api/profile receives, exactly as the onboarding form sends it. */
  answers: OnboardingAnswers;
  /** Why this company is in the run: what it tests. */
  reason: string;
  /** Short place label for the report. */
  town: string;
}

const persona = (
  n: number, plan: Persona['plan'], town: string, answers: Omit<OnboardingAnswers, 'businessName'> & { name: string }, reason: string,
): Persona => {
  const key = `sim-${String(n).padStart(2, '0')}`;
  const { name, ...rest } = answers;
  return {
    key, email: `${key}@example.com`, password: `SIM-password-${key}`, plan, town, reason,
    answers: { businessName: `SIM ${name} (simulated)`, ...rest },
  };
};

/** Small business (self-certified by size, not a certification program): ticked by every small persona. */
const SMALL = ['SBA'];

export const PERSONAS: readonly Persona[] = [
  persona(1, 'pro', 'Gardnerville, NV 89410', {
    name: 'Carson Valley Electric', trades: ['electrical'], zip: '89410', radiusMi: 90,
    valueRange: { min: 10_000, max: 50_000 }, limits: { maxJobSize: 100_000, bondingCapacity: 150_000 }, setAsides: SMALL,
  }, "The pilot's twin: a 2-person electrical shop wanting $10K–$50K within 90 miles of Gardnerville."),
  persona(2, 'pro', 'Reno, NV 89501', {
    name: 'Truckee Meadows Power & Data', trades: ['electrical', 'low-voltage'], zip: '89501', radiusMi: 120,
    valueRange: { min: 25_000, max: 400_000 }, limits: { maxJobSize: 750_000, bondingCapacity: 1_000_000 }, setAsides: [...SMALL, 'SDVOSBC'],
  }, 'The one certified service-disabled veteran-owned firm (SDVOSB), electrical + low voltage, medium jobs: a reserved job must reach it.'),
  persona(3, 'free', 'Carson City, NV 89701', {
    name: 'Capital Fire Sprinkler', trades: ['fire-protection'], zip: '89701', radiusMi: 75,
    valueRange: { min: 10_000, max: 200_000 }, limits: { maxJobSize: 250_000 }, setAsides: SMALL,
  }, 'Fire protection on the free plan: trade separation from electrical, and no premium numbers anywhere.'),
  persona(4, 'free', 'Fallon, NV 89406', {
    name: 'Lahontan Plumbing', trades: ['plumbing'], zip: '89406', radiusMi: 100,
    valueRange: { min: 5_000, max: 60_000 }, limits: { maxJobSize: 60_000, bondingCapacity: 0 }, setAsides: SMALL,
  }, 'A small rural plumber with a tight spend limit and no bonding: must never see an electrical-only job as a fit.'),
  persona(5, 'pro', 'Elko, NV 89801', {
    name: 'Ruby Mountain Mechanical', trades: ['hvac'], zip: '89801', radiusMi: 150,
    valueRange: { min: 20_000, max: 300_000 }, limits: { maxJobSize: 400_000, bondingCapacity: 500_000 }, setAsides: SMALL,
  }, 'HVAC in remote northeast Nevada: tests how thin coverage is far from Reno and Las Vegas.'),
  persona(6, 'pro', 'Las Vegas, NV 89101', {
    name: 'Neon Valley Electric', trades: ['electrical'], zip: '89101', radiusMi: 60,
    valueRange: { min: 50_000, max: 2_000_000 }, limits: { maxJobSize: 3_000_000, bondingCapacity: 2_500_000 }, setAsides: SMALL,
  }, 'A large-range electrical contractor in Las Vegas: the other big Nevada market, mostly on NGEM.'),
  persona(7, 'free', 'South Lake Tahoe, CA 96150', {
    name: 'Tahoe Basin Builders', trades: ['general-building'], zip: '96150', radiusMi: 60,
    valueRange: { min: 25_000, max: 500_000 }, setAsides: SMALL,
  }, 'A California general builder on the state line: which Nevada and California boards reach it.'),
  persona(8, 'pro', 'Sacramento, CA 95814', {
    name: 'Capitol 8a Electrical Contractors', trades: ['electrical'], zip: '95814', radiusMi: 100,
    valueRange: { min: 100_000, max: 5_000_000 }, limits: { maxJobSize: 5_000_000, bondingCapacity: 4_000_000 }, setAsides: [...SMALL, '8A'],
  }, 'The one 8(a) firm, in Sacramento: tests California coverage (federal notices only) and 8(a) set-asides.'),
  persona(9, 'free', 'Bishop, CA 93514', {
    name: 'Owens Valley Electric', trades: ['electrical'], zip: '93514', radiusMi: 150,
    valueRange: { min: 5_000, max: 40_000 }, limits: { maxJobSize: 50_000 }, setAsides: SMALL,
  }, 'A small shop in the Eastern Sierra, far from every board we read: the "almost nothing" case.'),
  persona(10, 'pro', 'Minden, NV 89423', {
    name: 'Douglas General Contractors', trades: ['general-building'], zip: '89423', radiusMi: 120,
    valueRange: { min: 250_000, max: 5_000_000 }, limits: { maxJobSize: 6_000_000, bondingCapacity: 5_000_000 }, setAsides: SMALL,
  }, 'A large general building contractor next to the pilot: same place, different trade and size.'),
  persona(11, 'free', 'Reno, NV 89502', {
    name: 'High Desert Heating & Air', trades: ['hvac'], zip: '89502', radiusMi: 80,
    valueRange: { min: 15_000, max: 250_000 }, limits: { maxJobSize: 250_000 }, setAsides: SMALL,
  }, 'HVAC in Reno on the free plan: the reverse trade check (HVAC must not get electrical-only work).'),
  persona(12, 'free', 'Carson City, NV 89703', {
    name: 'Eagle Valley Sparks', trades: ['electrical'], zip: '89703', radiusMi: 60,
    valueRange: { min: 10_000, max: 25_000 }, limits: { maxJobSize: 25_000, bondingCapacity: 0 }, setAsides: SMALL,
  }, 'The tightest spend limit ($25K, no bonding) with a short radius: what a cautious one-truck shop sees.'),
  persona(13, 'pro', 'Reno, NV 89521', {
    name: 'Sierra Pacific Constructors', trades: ['general-building', 'electrical'], zip: '89521', radiusMi: 250,
    valueRange: { min: 100_000, max: 10_000_000 }, limits: { maxJobSize: 15_000_000, bondingCapacity: 15_000_000 },
  }, 'A large firm with loose limits and a wide radius, over the small-business size (no set-aside ticked).'),
  persona(14, 'free', 'Sacramento, CA 95814', {
    name: 'River City Plumbing', trades: ['plumbing'], zip: '95814', radiusMi: 80,
    valueRange: { min: 20_000, max: 400_000 }, limits: { maxJobSize: 400_000 }, setAsides: SMALL,
  }, 'A Sacramento plumber on the free plan: the second California case, different trade.'),
  persona(15, 'free', 'Las Vegas, NV 89101', {
    name: 'Mojave Fire Protection', trades: ['fire-protection'], zip: '89101', radiusMi: 50,
    valueRange: { min: 10_000, max: 300_000 }, setAsides: SMALL,
  }, 'Fire protection in Las Vegas: the second Las Vegas trade, no spend limits set at all.'),
  persona(16, 'pro', 'Elko, NV 89801', {
    name: 'Great Basin Low Voltage', trades: ['electrical', 'low-voltage'], zip: '89801', radiusMi: 200,
    valueRange: { min: 5_000, max: 150_000 }, limits: { maxJobSize: 150_000, bondingCapacity: 100_000 }, setAsides: SMALL,
  }, 'Electrical + low voltage in Elko with a 200-mile radius: how far a wide radius reaches from a remote town.'),
];

/** Trades a check treats as "electrical side" vs "pipe side". */
export const ELECTRICAL_SIDE = new Set(['electrical', 'low-voltage']);
export const PIPE_SIDE = new Set(['plumbing', 'hvac']);
