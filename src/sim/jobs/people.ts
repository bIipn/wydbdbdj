/**
 * The SIMULATED people of the marketplace simulation (`npm run simulate:jobs`). Nobody here is real: every
 * name starts with "SIM" and ends with "(simulated)", every email is sim-…@example.com, and the passwords are
 * throwaway strings for a throwaway in-memory database. The places are real ZIP codes (from the ZIP table) so
 * the feed's distances and the job's public place work exactly as they do for a real person.
 *
 * Who is who: posters ("Get work done", onboarding intent 'hire'), workers (intent 'work'), and a few people
 * who do both (intent 'both': they post jobs and bid on other people's). The list is fixed, not seeded: the
 * seed changes the jobs and the bids, not the cast.
 */
import { lookupZip } from '../../geo/zip.js';

export type Intent = 'work' | 'hire' | 'both';

export interface SimPerson {
  /** P01 (posts), W01 (works), B01 (both). The label every report and check uses instead of an account id. */
  key: string;
  name: string;
  email: string;
  password: string;
  zip: string;
  /** Where they work; jobs are posted and bid on inside one region. */
  region: string;
  intent: Intent;
  /** Catalog trade ids ([] for a poster who only hires). */
  trades: string[];
  radiusMi: number;
  posts: boolean;
  works: boolean;
}

/** Real ZIPs per region (checked against the ZIP table when the cast is built). */
export const REGIONS: Readonly<Record<string, readonly string[]>> = {
  'Carson Valley / Reno / Tahoe': ['89410', '89423', '89460', '89701', '89703', '89501', '89511', '96150', '89449'],
  Sacramento: ['95814', '95816', '95608', '95630'],
  'Las Vegas': ['89101', '89123', '89014', '89074'],
  Phoenix: ['85004', '85008', '85281', '85201'],
  'Salt Lake': ['84101', '84106', '84047', '84601'],
  Boise: ['83702', '83706', '83651'],
  Portland: ['97201', '97214', '97005'],
};

/** Trades the simulated jobs and workers use (catalog ids). */
export const SIM_TRADES = ['electrical', 'plumbing', 'hvac', 'general-building', 'roofing', 'painting', 'flooring', 'landscaping'] as const;

export interface CastSize {
  /** People who only post. */
  posters: number;
  /** People who only work. */
  workers: number;
  /** People who do both (counted once; they post and they bid). */
  both: number;
}

/** About 12 posters and 30 workers, 4 of them doing both: 8 + 26 + 4 accounts. */
export const FULL_CAST: CastSize = { posters: 8, workers: 26, both: 4 };
/** The test suite's small run. */
export const SMALL_CAST: CastSize = { posters: 3, workers: 7, both: 1 };

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The cast, deterministic for a size. Regions are dealt round-robin (Carson Valley twice, it is the pilot's
 * home), trades rotate so every region has several, and every fourth worker has a second trade.
 */
export function buildCast(size: CastSize): SimPerson[] {
  const regionNames = Object.keys(REGIONS);
  const deal = ['Carson Valley / Reno / Tahoe', ...regionNames];
  const people: SimPerson[] = [];
  const place = (i: number) => {
    const region = deal[i % deal.length]!;
    const zips = REGIONS[region]!;
    const zip = zips[Math.floor(i / deal.length) % zips.length]!;
    if (!lookupZip(zip)) throw new Error(`simulated cast: ZIP ${zip} is not in the ZIP table`);
    return { region, zip };
  };
  const tradesFor = (i: number): string[] => {
    const first = SIM_TRADES[i % SIM_TRADES.length]!;
    if (i % 4 !== 3) return [first];
    return [first, SIM_TRADES[(i + 3) % SIM_TRADES.length]!];
  };
  // Posting people and working people are dealt separately, so every region with a poster has workers.
  let i = 0;
  for (let n = 1; n <= size.posters; n++, i++) {
    people.push({
      key: `P${pad(n)}`, name: `SIM Poster ${pad(n)} (simulated)`, email: `sim-p${pad(n)}@example.com`, password: `SIM-pass-p${pad(n)}-not-real`,
      ...place(i), intent: 'hire', trades: [], radiusMi: 25, posts: true, works: false,
    });
  }
  for (let n = 1; n <= size.both; n++, i++) {
    people.push({
      key: `B${pad(n)}`, name: `SIM Poster and worker ${pad(n)} (simulated)`, email: `sim-b${pad(n)}@example.com`, password: `SIM-pass-b${pad(n)}-not-real`,
      ...place(i), intent: 'both', trades: tradesFor(i), radiusMi: 75, posts: true, works: true,
    });
  }
  for (let n = 1; n <= size.workers; n++) {
    people.push({
      key: `W${pad(n)}`, name: `SIM Worker ${pad(n)} (simulated)`, email: `sim-w${pad(n)}@example.com`, password: `SIM-pass-w${pad(n)}-not-real`,
      ...place(n - 1), intent: 'work', trades: tradesFor(n - 1 + size.both), radiusMi: [40, 60, 90, 150][n % 4]!, posts: false, works: true,
    });
  }
  return people;
}

/** What PUT /api/profile is sent for a person (the onboarding answers). */
export function onboardingAnswers(p: SimPerson): Record<string, unknown> {
  if (p.intent === 'hire') return { intent: 'hire', businessName: p.name, zip: p.zip };
  return { intent: p.intent, businessName: p.name, trades: p.trades, zip: p.zip, radiusMi: p.radiusMi, valueRange: { min: 0, max: 50_000 } };
}
