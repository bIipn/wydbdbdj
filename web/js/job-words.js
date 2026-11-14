// Local jobs in words: where a job stands for the person looking at it, how it ended, the fee lines, the licence
// notice, and dates. Pure functions of the API's Job (src/jobs/view.ts) and the clock: no DOM, no requests.
//
// Money stays integer cents. A fee is worked out like the server does it (src/jobs/rules.ts feeLine): the rate in
// parts per million, a BigInt product, one half-up rounding. The client only does this to show "what it would
// be" under the bid box; the amounts on record always come from the server.

import { clock, fmtDay, PT } from './format.js';
import { usd } from './money.js';

// ------------------------------------------------------------------ money --

/** 5 → 50000, 2.5 → 25000 (parts per million), read from the number's text so no float touches a rate. */
export function ppmOf(pct) {
  const m = /^(\d{1,3})(?:\.(\d{1,4}))?$/.exec(String(pct ?? ''));
  if (!m) return null;
  return Number(m[1]) * 10_000 + Number((m[2] ?? '').padEnd(4, '0'));
}

/** cents × rate, rounded half up to the cent (BigInt, like the server). null when either is missing. */
export function feeCents(cents, ppm) {
  if (!Number.isSafeInteger(cents) || cents < 0 || !Number.isSafeInteger(ppm) || ppm < 0) return null;
  return Number((BigInt(cents) * BigInt(ppm) + 500_000n) / 1_000_000n);
}

/**
 * What someone typed in a $ box → integer cents, from the text (never a float): "420" → 42000,
 * "1,250.5" → 125050, "$99.99" → 9999. Blank → null; anything else → NaN (the box says so).
 */
export function parseCents(text) {
  const s = String(text ?? '').trim().replace(/[$,\s]/g, '');
  if (!s) return null;
  const m = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return NaN;
  return Number(BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0'));
}

/** 42000 → "$420", 42050 → "$420.50": whole dollars when the cents are zero (people bid in dollars). */
export const dollars = (cents) => usd(cents, { whole: true });

/** "5%" from 5, "2.5%" from 2.5. */
export const pctText = (pct) => `${pct}%`;

/**
 * The two fee lines under the bid box, for the amount typed (or "x% of your bid" before one is typed).
 * Wording from the jobs contract §1 rule 8; the poster's share is part of the no-show fee, never on top of it.
 */
export function feeLines(rules, amountCents) {
  const has = Number.isSafeInteger(amountCents) && amountCents > 0;
  const noShow = has ? feeCents(amountCents, ppmOf(rules.noShowFeePct)) : null;
  const share = has ? feeCents(amountCents, ppmOf(rules.posterSharePct)) : null;
  const service = has ? feeCents(amountCents, ppmOf(rules.serviceFeePct)) : null;
  const days = `${rules.contactDays} day${rules.contactDays === 1 ? '' : 's'}`;
  return {
    noShow: `If you win and no contact is recorded in BidSwipe within ${days} (your message or “We’ve agreed”, or the poster’s “They contacted me” or “We’ve agreed”), or you back out: a no-show fee of ${pctText(rules.noShowFeePct)} of your bid`
      + (has ? ` (${usd(noShow)}). ${usd(share)} of it goes to the poster.` : `. ${pctText(rules.posterSharePct)} of your bid goes to the poster.`),
    service: `If the job is agreed: a ${pctText(rules.serviceFeePct)} service fee${has ? ` (${usd(service)})` : ''}.`,
  };
}

/**
 * How long a poster has to answer the winner's first message before a silence counts as the poster's no-show:
 * min(48 hours, half the contact window), as src/jobs/rules.ts answerWindowMs. "48 hours" at 7 days, "12 hours" at 1.
 */
export function answerWindowText(rules) {
  const hours = Math.min(48, (rules.contactDays * 24) / 2);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** Payments are off (rules.paymentsOn is false): the screens say so every time a fee is mentioned. */
export const FEES_OFF = 'Fees are not being collected yet. A no-show is recorded on your profile.';

// ---------------------------------------------------------------- licence --

// Sourced lines from the research notes (docs/MARKETPLACE.md §2; NRS 624.031; Cal. Bus. & Prof. Code 7048).
const LICENCE = {
  NV: 'Nevada: a contractor’s licence is needed for most work. The only exception is repair or maintenance under $1,000 with labor and materials that needs no permit, is not part of a bigger job, and is not electrical, plumbing, heating, air-conditioning or refrigeration work (NRS 624.031).',
  CA: 'California: a contractor’s licence is needed for a job of $1,000 or more with labor and materials, any job that needs a building permit, or any job that is part of a bigger job (Bus. & Prof. Code 7048).',
};
const LICENCE_GENERAL = 'Many states require a contractor’s licence for work above a small amount or work that needs a permit. Check your state’s rules before you post, bid or take a job.';

/** The licence notice for a job's state (two-letter code), or the general line. */
export const licenceLine = (state) => LICENCE[state] ?? LICENCE_GENERAL;

// ------------------------------------------------------------------ dates --

const fmtWeekday = new Intl.DateTimeFormat('en-US', { timeZone: PT, weekday: 'short' });
const fmtMonthDay = new Intl.DateTimeFormat('en-US', { timeZone: PT, month: 'short', day: 'numeric' });

/** "Fri 5 PM" within the coming week, else "Nov 21". */
export function whenShort(iso, now = Date.now()) {
  const d = new Date(iso);
  const days = (d.getTime() - now) / 864e5;
  return days > -1 && days < 6 ? `${fmtWeekday.format(d)} ${clock(d)}` : fmtMonthDay.format(d);
}

/** "Fri, Nov 21 · 5 PM" */
export const whenLong = (iso) => { const d = new Date(iso); return `${fmtDay.format(d)} · ${clock(d)}`; };

/** "Nov 21" */
export const dayOnly = (iso) => fmtMonthDay.format(new Date(iso));

/** "2 days 4 h", "5 h 20 min", "12 min"; null once it has passed. */
export function timeLeft(iso, now = Date.now()) {
  const ms = Date.parse(iso) - now;
  if (!(ms > 0)) return null;
  const min = Math.floor(ms / 60_000);
  const d = Math.floor(min / 1440);
  const hr = Math.floor((min % 1440) / 60);
  if (d >= 1) return `${d} day${d === 1 ? '' : 's'}${hr ? ` ${hr} h` : ''}`;
  if (hr >= 1) return `${hr} h${min % 60 ? ` ${min % 60} min` : ''}`;
  return `${Math.max(1, min)} min`;
}

// ------------------------------------------------------------ the states --

/** The viewer won this job (still holds it, or did and defaulted). */
export const iWon = (job) => !!job.award?.isMe || job.my.bid?.status === 'won' || job.my.bid?.status === 'defaulted';

/** How a job ended, said to the person looking at it. */
export function endedWords(job) {
  const poster = job.my.role === 'poster';
  const me = iWon(job);
  if (job.status === 'cancelled') return poster ? 'You cancelled it before bidding closed' : 'The poster cancelled it before bidding closed';
  if (job.status === 'completed') return 'Job done';
  if (job.status === 'agreed') return 'Agreed';
  switch (job.outcome) {
    case 'no_bids': return 'No bids came in';
    case 'bidder_no_show': return me ? 'You didn’t make contact in time' : 'The winner never made contact';
    case 'bidder_backed_out': return me ? 'You gave the job back' : 'The winner gave the job back';
    case 'poster_no_show': return poster ? 'You didn’t answer the winner in time' : me ? 'The poster never answered you' : 'The poster never answered the winner';
    case 'no_agreement': return 'No agreement before the deadline';
    case 'poster_cancelled': return poster ? 'You cancelled after the award' : 'The poster cancelled after the award';
    // The winner's account is gone, so nobody reading this is "me, the winner".
    case 'bidder_left': return 'The winner deleted their account';
    default: return 'Ended';
  }
}

const bidsWord = (n) => `${n} bid${n === 1 ? '' : 's'}`;

/**
 * Where a job stands for this viewer: which group it goes in on the Jobs tab, the state in words, and what to
 * do next. group: 'needs' (waiting on this person), 'open' (running, nothing to do now), 'done' (over).
 * `reposted`: this job was already posted again (so an unfilled one asks nothing more).
 */
export function stage(job, { now = Date.now(), reposted = false } = {}) {
  const a = job.award;
  const lowest = a ? dollars(a.amountCents) : null;
  if (job.my.role === 'poster') {
    switch (job.status) {
      case 'open':
        return { group: 'open', status: `Open · ${bidsWord(job.bidCount)} · closes ${whenShort(job.closesAt, now)}`, next: 'Amounts stay sealed until bidding closes.' };
      case 'awarded': {
        const by = a ? dayOnly(a.contactDeadline) : '';
        if (a?.posterConfirmedAt) return { group: 'open', status: `Lowest bid ${lowest} · you agreed`, next: `Waiting for them to confirm, by ${by}.` };
        if (a?.bidderContactedAt) return { group: 'needs', status: `Lowest bid ${lowest} · they contacted you`, next: 'Reply, then tap “We’ve agreed” once you’ve worked it out.' };
        return { group: 'needs', status: `Lowest bid ${lowest} · waiting for them to contact you`, next: `They have until ${by}. Tap “They contacted me” if they call, or “We’ve agreed” if you settled it.` };
      }
      case 'agreed':
        return { group: 'needs', status: `Agreed at ${lowest}`, next: 'Tap “Job done” when the work is finished.' };
      case 'completed':
        return { group: 'done', status: `Done · ${lowest}`, next: null };
      default: { // unfilled, cancelled
        // A job of theirs that just ended asks for one thing: post it again. After 3 days it just sits in Finished.
        const endedAt = Date.parse(a?.contactDeadline ?? job.closesAt);
        const fresh = !reposted && now - endedAt < 3 * 864e5;
        // The winner deleted their account: the job ended there and then, and it cost the poster nothing.
        const owe = job.outcome === 'bidder_left' ? 'You owe nothing. ' : '';
        return { group: fresh ? 'needs' : 'done', status: endedWords(job), next: reposted ? 'Posted again.' : `${owe}You can post it again with one tap.` };
      }
    }
  }
  // Someone who never bid (opened a link or an alert): nobody "got" anything from their side.
  if (job.my.role === 'viewer') {
    return job.status === 'open'
      ? { group: 'open', status: `Open · ${bidsWord(job.bidCount)} · closes ${whenShort(job.closesAt, now)}`, next: null }
      : { group: 'done', status: 'Bidding has closed', next: null };
  }
  // A bidder (or someone whose bid was withdrawn).
  const mine = job.my.bid;
  switch (job.status) {
    case 'open':
      if (mine?.status === 'active') return { group: 'open', status: `Your sealed bid ${dollars(mine.amountCents)} · closes ${whenShort(job.closesAt, now)}`, next: 'You can change or withdraw it until then.' };
      return { group: 'open', status: `You withdrew your bid · closes ${whenShort(job.closesAt, now)}`, next: 'You can bid again before it closes.' };
    case 'awarded':
      if (iWon(job)) {
        const by = dayOnly(a.contactDeadline);
        if (a.bidderConfirmedAt) return { group: 'open', status: `You won at ${lowest} · you agreed`, next: `Waiting for the poster to confirm, by ${by}.` };
        if (a.bidderContactedAt) return { group: 'needs', status: `You won · you’ve made contact`, next: `Tap “We’ve agreed” once you’ve worked it out, by ${by}.` };
        return { group: 'needs', status: `You won · contact them by ${by}`, next: 'Send a message in the job to make contact, or tap “We’ve agreed” if you already settled it by phone.' };
      }
      return { group: 'done', status: a ? `Closed · lowest bid ${lowest}${mine ? ` · yours ${dollars(mine.amountCents)}` : ''}` : 'Bidding closed', next: null };
    case 'agreed':
      return iWon(job) ? { group: 'open', status: `Agreed at ${lowest}`, next: 'The poster taps “Job done” when the work is finished.' }
        : { group: 'done', status: 'Someone else got this job', next: null };
    case 'completed':
      return { group: 'done', status: iWon(job) ? `Done · ${lowest}` : 'Someone else got this job', next: null };
    default:
      return { group: 'done', status: endedWords(job), next: null };
  }
}

/**
 * A job whose POSTER deleted their account, for someone who was waiting on it (the API's GoneJob: GET
 * /api/jobs/mine `ended`, and the 410 of GET /api/jobs/:id). The job itself is gone; this is its one line.
 */
export const GONE_TITLE = 'The poster deleted their account';
export function goneWords(g) {
  if (g.role === 'bidder') return 'The job was taken down before bidding closed. Your sealed bid is closed.';
  return g.feeWaivedCents
    ? `The job ended here. You owe nothing: the service fee of ${usd(g.feeWaivedCents)} that was recorded for you was waived.`
    : 'The job ended here. You owe nothing.';
}

/** Words for a fee on record. Always says it was not collected (payments are off). */
export function feeWords(fee) {
  const what = fee.kind === 'no_show' ? 'No-show fee' : 'Service fee';
  const who = fee.owedByMe ? ' (yours)' : '';
  const share = fee.kind === 'no_show' && fee.posterShareCents ? ` · ${usd(fee.posterShareCents)} of it for the poster` : '';
  return `${what}${who}: ${usd(fee.amountCents)}${share} · ${fee.status === 'waived' ? 'waived' : 'recorded, not collected'}`;
}

/** "3 jobs won · 2 agreed · 0 no-shows" (and "2 jobs posted" for someone who posts). */
export function statsWords(s) {
  if (!s) return '';
  const parts = [];
  if (s.posted) parts.push(`${s.posted} job${s.posted === 1 ? '' : 's'} posted`);
  const misses = (s.noShows ?? 0) + (s.backedOut ?? 0);
  if (s.won || misses) {
    parts.push(`${s.won} job${s.won === 1 ? '' : 's'} won`, `${s.agreed ?? 0} agreed`, `${misses} no-show${misses === 1 ? '' : 's'}`);
  }
  if (s.posterNoShows) parts.push(`${s.posterNoShows} unanswered`);
  return parts.length ? parts.join(' · ') : 'New on BidSwipe';
}
