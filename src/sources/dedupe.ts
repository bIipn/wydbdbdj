/**
 * One card per job. A board can list the same job several times: SAM.gov posts every amendment and the
 * presolicitation that announced it as separate notices, and our three SAM queries overlap. Drafts with
 * the same id are merged here, before storage. Pure: drafts in, drafts out.
 */
import type { Bid, BidDraft, BidLocation, LocationPrecision } from '../types.js';

/**
 * The stable part of a SAM.gov solicitation number, used as the card id. Amendments re-post the same
 * number with a "_1" tail ("36C26127Q0072_1") or four more digits ("36C26127Q00260001" for 36C26127Q0026,
 * the standard 13-character federal number: 6-character office code, 2-digit year, a letter, 4 characters).
 * No number → the notice id, which is all we have.
 */
export function samKey(solNumber: string | null | undefined, noticeId: string): string {
  const n = (solNumber ?? '').trim().toUpperCase().replace(/\s+/g, '').replace(/_\d{1,3}$/, '');
  if (!n) return noticeId;
  const std = /^([A-Z0-9]{6}\d{2}[A-Z][A-Z0-9]{4})\d{4}$/.exec(n);
  return std ? std[1]! : n;
}

/** Newer notice first; at the same time the bid package beats the advance notice. */
const TYPE_RANK: Record<string, number> = { solicitation: 3, 'combined synopsis/solicitation': 3, presolicitation: 1 };
const rank = (d: BidDraft) => TYPE_RANK[(d.category ?? '').toLowerCase()] ?? 2;

function newerFirst(a: BidDraft, b: BidDraft): number {
  const pa = a.postedAt ? Date.parse(a.postedAt) : -Infinity;
  const pb = b.postedAt ? Date.parse(b.postedAt) : -Infinity;
  if (pa !== pb) return pb - pa;
  if (rank(a) !== rank(b)) return rank(b) - rank(a);
  return 0;
}

/** Flags that describe one notice, not the job: a merged card takes them from the newest notice only. */
const NOTICE_FLAGS = new Set(['Presolicitation']);

/** No city, county, ZIP, address text or point: the notice did not say where the work is (a state alone is not a place). */
export function placeIsBlank(loc: Partial<BidLocation> | undefined): boolean {
  return !loc || (!loc.city && !loc.county && !loc.zip && !loc.label && loc.lat == null);
}

function fillFrom(target: BidDraft, sib: { location?: Partial<BidLocation>; setAside: string | null }): BidDraft {
  let out = target;
  if (placeIsBlank(out.location) && !placeIsBlank(sib.location)) {
    const state = out.location?.state ?? null;
    if (!state || !sib.location?.state || sib.location.state === state) out = { ...out, location: { ...sib.location } };
  }
  if (!out.setAside && sib.setAside) out = { ...out, setAside: sib.setAside };
  return out;
}

/** Merge one group of drafts that share an id: the newest is kept, blanks filled from the others. */
function mergeGroup(group: BidDraft[]): BidDraft {
  // A full tie keeps the later draft, as a plain "last one wins" map would.
  const [newest, ...older] = group.map((d, i) => ({ d, i })).sort((a, b) => newerFirst(a.d, b.d) || b.i - a.i).map((x) => x.d);
  let out: BidDraft = { ...newest!, flags: [...(newest!.flags ?? [])] };
  for (const sib of older) {
    out = fillFrom(out, sib);
    for (const f of sib.flags ?? []) if (!NOTICE_FLAGS.has(f) && !out.flags!.includes(f)) out.flags!.push(f);
  }
  return out;
}

/** Drafts with the same source + sourceId become one, in first-seen order. */
export function mergeDrafts(drafts: BidDraft[]): BidDraft[] {
  const groups = new Map<string, BidDraft[]>();
  for (const d of drafts) {
    const k = `${d.source}:${d.sourceId}`;
    const g = groups.get(k);
    if (g) g.push(d);
    else groups.set(k, [d]);
  }
  return [...groups.values()].map((g) => (g.length === 1 ? g[0]! : mergeGroup(g)));
}

/** Only a place the earlier scan read from the listing itself is worth carrying over, not one it guessed. */
const FIRM: ReadonlySet<LocationPrecision> = new Set(['exact', 'city', 'county']);

/**
 * The stored card for the same id, from an earlier scan: a place or set-aside the newest notice dropped
 * is kept (SAM's 3-day window often holds only the latest amendment, which may omit both).
 * Only the listing's own fields are carried over (city, county, state, ZIP), never coordinates, so
 * locate() decides again with today's gazetteer.
 */
export function inheritFromStored(draft: BidDraft, stored: Bid | null): BidDraft {
  if (!stored || stored.source !== draft.source || stored.sourceId !== draft.sourceId) return draft;
  const loc = stored.location;
  const place = FIRM.has(loc.precision) ? { city: loc.city, county: loc.county, state: loc.state, zip: loc.zip } : undefined;
  return fillFrom(draft, { location: place, setAside: stored.setAside });
}
