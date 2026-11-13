/**
 * The federal parser and the scorer speak one vocabulary (src/sources/flags.ts). REAL SAM.gov notices captured
 * 2026-11-13 04:01 UTC (test/fixtures/samgov-*.json) go through parseSamResponse → finalizeBid (locate) →
 * scoreBid for the pilot, at the scan's clock. If a parser writes a flag or set-aside code the scorer does not
 * act on, these fail.
 */
import { describe, expect, it } from 'vitest';
import { loadProfile } from '../src/profiles.js';
import { finalizeBid } from '../src/scan.js';
import { scoreBid } from '../src/score/score.js';
import { FLAGS, NOT_OPEN_FLAGS, SET_ASIDES } from '../src/sources/flags.js';
import { parseSamResponse, SAM_FLAGS, setAsideFromText, type SamOpportunity, type SamResponse } from '../src/sources/samgov.js';
import type { Bid } from '../src/types.js';
import { fx } from './helpers.js';

const SCAN = new Date('2026-11-13T04:02:14Z'); // the live scan's clock, minutes after the SAM capture
const pilot = loadProfile('lm-electric');
const ALL: SamOpportunity[] = ['samgov-nv.json', 'samgov-ca-238210.json', 'samgov-ca-236220.json']
  .flatMap((f) => (JSON.parse(fx(f)) as SamResponse).opportunitiesData ?? []);
const bids: Bid[] = parseSamResponse({ opportunitiesData: ALL }).map(finalizeBid);
const bySol = (sol: string): Bid => {
  const b = bids.find((x) => x.sourceId === sol);
  if (!b) throw new Error(`no SAM card ${sol}`);
  return b;
};
const cap = Math.min(54, pilot.notify.minScore - 1, (pilot.alerts?.minScore ?? Infinity) - 1);

describe('one vocabulary: what the federal parser writes is what the scorer reads', () => {
  it('SAM flags are the shared strings, and every flag on a real notice is one of them', () => {
    expect(SAM_FLAGS).toEqual({ presolicitation: FLAGS.presolicitation, programContract: FLAGS.programContract });
    const seen = new Set(bids.flatMap((b) => b.flags));
    expect([...seen].sort()).toEqual([FLAGS.presolicitation, FLAGS.programContract].sort());
    expect(NOT_OPEN_FLAGS.map((f) => f.flag)).toContain(SAM_FLAGS.presolicitation);
  });

  it('every set-aside code on a real notice, and every code read from text, is in the shared table', () => {
    const codes = new Set(bids.map((b) => b.setAside).filter((c): c is string => !!c));
    expect([...codes].sort()).toEqual(['8A', 'HZC', 'SBA', 'SDVOSBC']);
    const fromText = ['8(a) set-aside', 'SDVOSB', 'HUBZone', 'EDWOSB', 'WOSB', 'veteran-owned', 'small business set-aside',
      'partial small business set-aside'].map(setAsideFromText);
    for (const c of [...codes, ...fromText]) expect(SET_ASIDES[c!], `code ${c}`).toBeDefined();
    expect(SET_ASIDES.SBA!.reserved).toBeNull(); // a size standard: "check you qualify", never a hard no
  });
});

describe('real notices, parser → locate → scoreBid', () => {
  it('every gate fires on the notices that carry its flag or code', () => {
    for (const b of bids) {
      const s = scoreBid(b, pilot, SCAN);
      const texts = s.reasons.map((r) => r.text);
      if (b.flags.includes(FLAGS.programContract)) {
        expect(s.score, b.title).toBe(0);
        expect(texts.some((t) => t.startsWith('Program contract')), b.title).toBe(true);
      }
      if (b.flags.includes(FLAGS.presolicitation)) {
        expect(s.score, b.title).toBeLessThanOrEqual(cap);
        expect(texts, b.title).toContain('Presolicitation — not open for bids yet');
      }
      const reserved = b.setAside ? SET_ASIDES[b.setAside]?.reserved : null;
      if (reserved && !pilot.setAsidesEligible.includes(b.setAside!)) {
        expect(s.score, b.title).toBe(0);
        expect(texts, b.title).toContain(reserved);
      }
    }
  });

  it('the 8(a) IDIQ JOC (title-only 8(a)) is placed at Twentynine Palms and is a program contract reserved for 8(a)', () => {
    const b = bySol('N6247327R0014');
    expect(b.setAside).toBe('8A'); // SAM's code was empty; the title says 8(a)
    expect(b.flags).toEqual([FLAGS.programContract]);
    expect(b.location).toMatchObject({ city: 'Twentynine Palms', state: 'CA' });
    const s = scoreBid(b, pilot, SCAN);
    expect(s.rejected).toBe('Program contract (“IDIQ”) — not a single job');
    expect(s.reasons).toContainEqual({ kind: 'minus', text: 'Reserved for 8(a) firms' });
    expect(s.score).toBe(0);
  });

  it('the J061 breaker testing in Reno: SDVOSB-only is a hard no for the pilot, a measured fit for a certified firm', () => {
    const b = bySol('36C26127Q0067');
    expect(b.location).toMatchObject({ city: 'Reno', state: 'NV' });
    expect(scoreBid(b, pilot, SCAN).rejected).toBe('Reserved for service-disabled veteran-owned firms');
    const vet = scoreBid(b, { ...pilot, setAsidesEligible: [...pilot.setAsidesEligible, 'SDVOSBC'] }, SCAN);
    expect(vet.rejected).toBeNull();
    expect(vet.distanceMi).toBe(41);
    expect(vet.score).toBeGreaterThan(0);
  });

  it('the Mather Loop Road presolicitation carries the not-open line even for a firm that may bid', () => {
    const b = bySol('36C26127Q0112');
    expect(b.flags).toEqual([FLAGS.presolicitation]);
    const vet = scoreBid(b, { ...pilot, setAsidesEligible: [...pilot.setAsidesEligible, 'SDVOSBC'] }, SCAN);
    expect(vet.reasons).toContainEqual({ kind: 'minus', text: 'Presolicitation — not open for bids yet' });
    expect(vet.score).toBeLessThanOrEqual(cap);
  });

  it('no real SAM notice reaches the pilot\'s alert line on the capture day', () => {
    expect(bids.filter((b) => scoreBid(b, pilot, SCAN).score >= 55).map((b) => b.title)).toEqual([]);
  });
});
