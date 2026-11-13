/**
 * The trade catalog: its integrity, the merge rules for a company with several trades, and what the
 * templates do to REAL bids (the pages in test/fixtures). Anything made up says so: "TEST … (synthetic)".
 */
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadProfile } from '../src/profiles.js';
import { finalizeBid } from '../src/scan.js';
import { compileKeywords, scoreBid } from '../src/score/score.js';
import { fixtureSources } from '../src/sources/fixtures.js';
import { getTrade, mergeTrades, NAICS_TITLES, TRADES } from '../src/trades/catalog.js';
import type { Bid, Profile } from '../src/types.js';
import { NOW, scanCtx, testBid, testProfile } from './helpers.js';

const pilot = loadProfile('lm-electric');
const IDS = TRADES.map((t) => t.id);
const LISTS = ['strong', 'related', 'general', 'otherTrades', 'exclude'] as const;

/** A simulated company with these trades, at the pilot's base so only the trade lists differ. */
function company(tradeIds: string[]): Profile {
  const mix = mergeTrades(tradeIds);
  return testProfile(`test-${mix.trades.join('-')}`, { keywords: mix.keywords, naics: mix.naics, trades: mix.trades });
}

/** Any 1 to 4 trades, in any order. */
const anyMix = fc.shuffledSubarray(IDS, { minLength: 1, maxLength: 4 });

let real: Bid[]; // the 32 real bids captured on 2026-11-11
beforeAll(async () => {
  real = (await Promise.all(fixtureSources().map((s) => s.fetch(scanCtx())))).flat().map(finalizeBid);
});

describe('trade catalog', () => {
  it('lists the trades public agencies bid out, electrical first, each with a label and a one-line blurb', () => {
    expect(IDS[0]).toBe('electrical');
    for (const id of [
      'electrical', 'plumbing', 'hvac', 'fire-protection', 'low-voltage', 'general-building', 'roofing', 'painting',
      'concrete-paving', 'landscaping',
    ]) expect(IDS, id).toContain(id);
    expect(new Set(IDS).size).toBe(IDS.length);
    for (const t of TRADES) {
      expect(t.id, t.id).toMatch(/^[a-z0-9-]+$/);
      expect(t.label.trim(), t.id).toBe(t.label);
      expect(t.label.length, t.id).toBeGreaterThan(2);
      expect(t.blurb.length, t.id).toBeGreaterThan(10);
      expect(t.blurb, t.id).not.toMatch(/\n/);
      expect(getTrade(t.id)).toBe(t);
    }
    expect(new Set(TRADES.map((t) => t.label)).size).toBe(TRADES.length);
  });

  it('every NAICS code is 6 digits and has its official 2022 title on file', () => {
    const used = new Set<string>();
    for (const t of TRADES) {
      for (const code of [...t.naics.strong, ...t.naics.related]) {
        expect(code, t.id).toMatch(/^\d{6}$/);
        expect(NAICS_TITLES[code], `${t.id} ${code}`).toBeTruthy();
        used.add(code);
      }
      expect(t.naics.strong.filter((c) => t.naics.related.includes(c)), t.id).toEqual([]);
    }
    // The title table holds exactly the codes in use: a typo cannot hide in either place.
    expect(Object.keys(NAICS_TITLES).sort()).toEqual([...used].sort());
    expect(NAICS_TITLES['238210']).toBe('Electrical Contractors and Other Wiring Installation Contractors');
    expect(NAICS_TITLES['238220']).toBe('Plumbing, Heating, and Air-Conditioning Contractors');
    expect(NAICS_TITLES['238160']).toBe('Roofing Contractors');
  });

  it('keywords are clean: lowercase, trimmed, no repeats, * only as a suffix, and every one compiles', () => {
    for (const t of TRADES) {
      for (const list of LISTS) {
        const words = t.keywords[list];
        expect(words.length, `${t.id}.${list}`).toBeGreaterThan(0);
        expect(new Set(words).size, `${t.id}.${list} has a repeat`).toBe(words.length);
        for (const w of words) {
          expect(w, `${t.id}.${list}`).toBe(w.trim().toLowerCase());
          expect(w.replace(/\*$/, ''), `${t.id}.${list} “${w}”`).toMatch(/^[a-z0-9][a-z0-9 /&()-]*$/);
          // The keyword finds itself, and a prefix keyword finds a longer word.
          const m = compileKeywords([w]);
          expect(m.test(`TEST ${w.replace(/\*$/, '')} job`), w).toBeTruthy();
          if (w.endsWith('*')) expect(m.test(`${w.slice(0, -1)}zz`), w).toBeTruthy();
        }
      }
    }
  });

  it('within a trade no keyword sits in two lists that contradict each other', () => {
    for (const t of TRADES) {
      const { strong, related, otherTrades, exclude } = t.keywords;
      const both = (a: string[], b: string[]) => a.filter((w) => b.includes(w));
      expect(both(strong, exclude), `${t.id}: strong and excluded`).toEqual([]);
      expect(both(related, exclude), `${t.id}: related and excluded`).toEqual([]);
      expect(both(strong, related), `${t.id}: strong and related`).toEqual([]);
      expect(both(strong, otherTrades), `${t.id}: strong and another trade's`).toEqual([]);
      expect(both(related, otherTrades), `${t.id}: related and another trade's`).toEqual([]);
    }
  });

  it('electrical is the pilot: the same strong, related, general and other-trade lists, word for word, and the same NAICS codes', () => {
    const electrical = getTrade('electrical')!;
    expect(electrical.keywords.strong).toEqual(pilot.keywords.strong);
    expect(electrical.keywords.related).toEqual(pilot.keywords.related);
    expect(electrical.keywords.general).toEqual(pilot.keywords.general);
    expect(electrical.keywords.otherTrades).toEqual(pilot.keywords.otherTrades);
    expect(electrical.naics).toEqual(pilot.naics);
  });

  it('every trade shares the same generic construction words', () => {
    for (const t of TRADES) expect(t.keywords.general, t.id).toEqual(pilot.keywords.general);
  });

  it('the exclude list is generic: service and supply phrases, none of the words tuned to one day of bids', () => {
    const exclude = getTrade('electrical')!.keywords.exclude;
    for (const w of ['janitorial', 'custodial', 'consulting', 'software', 'furniture', 'insurance', 'strategic plan*', 'surveying']) {
      expect(exclude, w).toContain(w);
    }
    for (const w of ['fish food', 'jackets', 'wifi services', 'tip management', 'customer portal', 'photo processing', 'preschool', 'director']) {
      expect(exclude, w).not.toContain(w);
    }
    // No bare word for what a building is used for, and no prefix that swallows "auditorium".
    for (const w of ['medical', 'pharmacy', 'food', 'legal', 'printing', 'audit*', 'vehicle*']) expect(exclude, w).not.toContain(w);
    const hits = compileKeywords(exclude);
    for (const title of [
      'TEST VA Medical Center - Replace Chillers (synthetic)', 'TEST Auditorium HVAC Replacement (synthetic)',
      'TEST Food Bank Warehouse Boiler Replacement (synthetic)', 'TEST Vehicle Maintenance Shop Fire Protection (synthetic)',
      'TEST Fire Training Center Elevator Repair (synthetic)',
    ]) expect(hits.test(title), title).toBeNull();
    for (const title of ['TEST Janitorial Services (synthetic)', 'TEST Annual Financial Audit (synthetic)', 'TEST Office Furniture (synthetic)']) {
      expect(hits.test(title), title).toBeTruthy();
    }
  });
});

describe('mergeTrades', () => {
  it('one trade gives that trade\'s own lists and codes', () => {
    for (const t of TRADES) {
      expect(mergeTrades([t.id])).toEqual({ trades: [t.id], keywords: t.keywords, naics: t.naics });
    }
  });

  it('several trades: strong is the union, and a word that is strong for one is never just related', () => {
    const electrical = getTrade('electrical')!;
    const roofing = getTrade('roofing')!;
    const mix = mergeTrades(['roofing', 'electrical']);
    expect(mix.trades).toEqual(['electrical', 'roofing']); // catalog order, whatever order they were picked in
    expect(mix.keywords.strong).toEqual([...electrical.keywords.strong, ...roofing.keywords.strong]);
    expect(mix.naics.strong).toEqual(['238210', '238160']);
    expect(mix.naics.related).toEqual(expect.arrayContaining(['238220', '236220']));

    // "hvac" is related for an electrician and strong for an HVAC contractor: strong wins.
    const both = mergeTrades(['electrical', 'hvac']);
    expect(both.keywords.strong).toContain('hvac');
    expect(both.keywords.related).not.toContain('hvac');
    // 238220 is related for electrical and the HVAC contractor's own code.
    expect(both.naics.strong).toEqual(['238210', '238220']);
    expect(both.naics.related).not.toContain('238220');
  });

  it('other-trade words: the usual list minus the company\'s own strong and related words', () => {
    const electrical = getTrade('electrical')!.keywords.otherTrades;
    for (const w of ['roofing', 'reroof*', 'roof replacement']) expect(electrical).toContain(w);
    const mix = mergeTrades(['electrical', 'roofing']).keywords.otherTrades;
    for (const w of ['roofing', 'reroof*', 'roof replacement']) expect(mix).not.toContain(w);
    expect(mix).toEqual(electrical.filter((w) => !['roofing', 'reroof*', 'roof replacement'].includes(w)));
    // "striping" is a paver's word, but painters stripe too (related for painting).
    expect(getTrade('painting')!.keywords.otherTrades).not.toContain('striping');
    expect(getTrade('roofing')!.keywords.otherTrades).toContain('striping');
  });

  it('kin trades are not "another trade": a trade whose own NAICS code you list is work you may carry', () => {
    // The pilot lists 238220 (plumbing, heating, air-conditioning) as related.
    const electrical = getTrade('electrical')!.keywords.otherTrades;
    for (const w of ['plumbing', 'hvac', 'fire sprinkler*', 'cctv']) expect(electrical, w).not.toContain(w);
    // A roofer lists none of the building-systems codes: those jobs are someone else's.
    const roofing = getTrade('roofing')!.keywords.otherTrades;
    for (const w of ['electric*', 'lighting', 'plumbing', 'hvac', 'boiler*', 'fire sprinkler*', 'cctv', 'paving', 'landscap*']) {
      expect(roofing, w).toContain(w);
    }
    // A plumber shares 238220 with HVAC and fire sprinklers, not with electricians.
    const plumbing = getTrade('plumbing')!.keywords.otherTrades;
    expect(plumbing).toContain('electric*');
    for (const w of ['hvac', 'chiller*', 'fire sprinkler*']) expect(plumbing, w).not.toContain(w);
  });

  it('exclude: the generic list minus the company\'s own words (a landscaper keeps "mowing")', () => {
    const generic = getTrade('electrical')!.keywords.exclude;
    for (const w of ['mowing', 'weed control', 'snow removal']) expect(generic, w).toContain(w);
    const landscaping = getTrade('landscaping')!;
    for (const w of ['mowing', 'weed control', 'snow removal']) expect(landscaping.keywords.exclude, w).not.toContain(w);
    expect(landscaping.keywords.exclude).toEqual(generic.filter((w) => !['mowing', 'weed control', 'snow removal'].includes(w)));
    expect(mergeTrades(['electrical', 'landscaping']).keywords.exclude).toEqual(landscaping.keywords.exclude);
  });

  it('throws on a trade that is not in the catalog', () => {
    expect(() => mergeTrades(['electrical', 'TEST-no-such-trade'])).toThrow(/Unknown trade "TEST-no-such-trade"/);
  });

  it('for ANY mix of trades: order and repeats do not matter, the union holds, and no list contradicts another', () => {
    fc.assert(
      fc.property(anyMix, fc.array(fc.constantFrom(...IDS), { maxLength: 3 }), (ids, noise) => {
        const mix = mergeTrades(ids);
        const inCatalogOrder = IDS.filter((id) => ids.includes(id));
        expect(mix.trades).toEqual(inCatalogOrder);
        // Same picks in another order, with repeats: the same result.
        const repeated = [...ids].reverse().concat(noise.filter((id) => ids.includes(id)));
        expect(mergeTrades(repeated)).toEqual(mix);

        const { strong, related, general, otherTrades, exclude } = mix.keywords;
        const own = new Set([...strong, ...related]);
        expect(general).toEqual(pilot.keywords.general);
        for (const id of ids) {
          const t = getTrade(id)!;
          // Union: nothing a trade brings is lost, and its codes are all there.
          for (const w of t.keywords.strong) expect(strong).toContain(w);
          for (const w of t.keywords.related) expect(own.has(w), w).toBe(true);
          for (const c of t.naics.strong) expect(mix.naics.strong).toContain(c);
          for (const c of t.naics.related) expect([...mix.naics.strong, ...mix.naics.related]).toContain(c);
          // Adding trades only ever removes other-trade and exclude words.
          for (const w of otherTrades) expect(t.keywords.otherTrades, w).toContain(w);
          for (const w of exclude) expect(t.keywords.exclude, w).toContain(w);
        }
        expect(strong.filter((w) => related.includes(w))).toEqual([]);
        expect(mix.naics.strong.filter((c) => mix.naics.related.includes(c))).toEqual([]);
        for (const w of [...otherTrades, ...exclude]) expect(own.has(w), w).toBe(false);
        for (const list of LISTS) expect(new Set(mix.keywords[list]).size, list).toBe(mix.keywords[list].length);
      }),
    );
  });
});

describe('the templates on real bids (captured 2026-11-11)', () => {
  const titled = (re: RegExp) => real.filter((b) => re.test(b.title));
  const scores = (p: Profile, bids: Bid[]) => bids.map((b) => scoreBid(b, p, NOW).score);

  it('reads all 32 real bids', () => {
    expect(real).toHaveLength(32);
  });

  it('a roofer sees the four real roofing jobs as good fits; an electrician still does not', () => {
    const roofs = titled(/^Roofing Replacement/);
    expect(roofs).toHaveLength(4);
    for (const s of scores(company(['roofing']), roofs)) expect(s).toBeGreaterThanOrEqual(55);
    expect(scores(company(['electrical']), roofs)).toEqual(scores(pilot, roofs));
    for (const s of scores(pilot, roofs)) expect(s).toBeLessThan(35);
  });

  it('each systems trade finds its own real job', () => {
    const top = (tradeId: string) => {
      const p = company([tradeId]);
      return [...real].sort((a, b) => scoreBid(b, p, NOW).score - scoreBid(a, p, NOW).score)[0]!.title;
    };
    expect(top('hvac')).toBe('Northern Nevada - HVAC Maintenance Services');
    expect(top('plumbing')).toBe('OTAG Water Heater Replacement');
    expect(top('fire-protection')).toMatch(/^Fire Sprinkler System Installation and Fire Alarm/);
    expect(top('low-voltage')).toMatch(/^Replace Cell Doors, Locks, Intercoms & Controls/);
  });

  it('janitorial and other non-construction bids are a hard no for every trade', () => {
    const notWork = titled(/Janitorial Services|Furniture Walls|Strategic Plan/);
    expect(notWork).toHaveLength(4);
    for (const t of TRADES) {
      for (const b of notWork) expect(scoreBid(b, company([t.id]), NOW).rejected, `${t.id}: ${b.title}`).toBeTruthy();
    }
  });

  it('adding a trade never costs a company a job that is squarely in a trade it already had', () => {
    fc.assert(
      fc.property(fc.constantFrom(...IDS), anyMix, (id, others) => {
        const alone = company([id]);
        const mixed = company([id, ...others]);
        const strong = compileKeywords(getTrade(id)!.keywords.strong);
        for (const b of real.filter((bid) => strong.test(bid.title))) {
          expect(scoreBid(b, mixed, NOW).score, `${id} + ${others.join(',')}: ${b.title}`).toBeGreaterThanOrEqual(scoreBid(b, alone, NOW).score);
        }
      }),
    );
  });

  it('for ANY mix, a real bid scores 0 to 100 and a rejected bid scores 0', () => {
    fc.assert(
      fc.property(anyMix, (ids) => {
        const p = company(ids);
        for (const b of real) {
          const r = scoreBid(b, p, NOW);
          expect(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100, `${b.title}: ${r.score}`).toBe(true);
          if (r.rejected) expect(r.score).toBe(0);
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe('the templates on made-up titles (synthetic bids, never shown to users)', () => {
  const score = (tradeIds: string[], title: string) => scoreBid(testBid({ title }), company(tradeIds), NOW);

  it('a landscaper gets mowing; for everyone else it is still not construction', () => {
    const title = 'TEST Mowing and Weed Control Services (synthetic)';
    expect(score(['landscaping'], title).score).toBeGreaterThanOrEqual(55);
    expect(score(['electrical'], title).rejected).toMatch(/Not your trade/);
    expect(score(['roofing'], title).rejected).toMatch(/Not your trade/);
  });

  it('a job named after the building it is in is not thrown out by a facility word', () => {
    expect(score(['hvac'], 'TEST VA Medical Center - Replace Chillers (synthetic)').score).toBeGreaterThanOrEqual(55);
    expect(score(['electrical'], 'TEST Auditorium HVAC Replacement (synthetic)').rejected).toBeNull();
  });

  it('an ambiguous word is only "related", so the exclude list can still say no', () => {
    // "carpet" alone is related for flooring: carpet cleaning is a service, a carpet install is a job.
    expect(score(['flooring'], 'TEST Carpet Cleaning Services (synthetic)').rejected).toMatch(/Not your trade/);
    expect(score(['flooring'], 'TEST Carpet Replacement, Library (synthetic)').score).toBeGreaterThanOrEqual(55);
    // "heating" alone is related for HVAC: heating oil is a fuel delivery.
    expect(score(['hvac'], 'TEST Heating Oil Delivery (synthetic)').rejected).toMatch(/Not your trade/);
  });

  it('another trade\'s job loses points unless the company does that trade too', () => {
    // A paving contractor reads "parking lot" as related; "lighting" marks it as an electrician's job.
    const title = 'TEST Parking Lot Lighting Upgrade (synthetic)';
    const paver = score(['concrete-paving'], title);
    const both = score(['concrete-paving', 'electrical'], title);
    expect(paver.score).toBeLessThan(55);
    expect(both.score).toBeGreaterThanOrEqual(75);
    expect(both.score - paver.score).toBeGreaterThanOrEqual(20);
  });

  it('every trade scores a plain job in its own words as a good fit', () => {
    const samples: Record<string, string> = {
      electrical: 'TEST Electrical Panel Upgrade (synthetic)',
      plumbing: 'TEST Plumbing Fixture Replacement (synthetic)',
      hvac: 'TEST Rooftop Unit Replacement (synthetic)',
      'fire-protection': 'TEST Fire Sprinkler System Repair (synthetic)',
      'low-voltage': 'TEST Access Control and CCTV Upgrade (synthetic)',
      'general-building': 'TEST Restroom Remodel (synthetic)',
      roofing: 'TEST Re-Roof of Maintenance Shop (synthetic)',
      painting: 'TEST Exterior Painting of Fire Station (synthetic)',
      'concrete-paving': 'TEST Sidewalk and Curb Replacement (synthetic)',
      landscaping: 'TEST Tree Trimming and Removal (synthetic)',
      flooring: 'TEST Gym Floor Refinishing (synthetic)',
      sitework: 'TEST Storm Drain and Culvert Replacement (synthetic)',
      fencing: 'TEST Chain Link Fence Replacement (synthetic)',
    };
    expect(Object.keys(samples).sort()).toEqual([...IDS].sort());
    for (const [id, title] of Object.entries(samples)) {
      expect(score([id], title).score, `${id}: ${title}`).toBeGreaterThanOrEqual(55);
    }
  });
});
