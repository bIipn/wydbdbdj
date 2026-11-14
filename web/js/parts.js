// Pieces of a bid shared by the swipe card, the list rows and the detail sheet.

import { markOpened } from './actions.js';
import { h, icon, ICONS, safeUrl, store } from './dom.js';
import { dueInfo, estLabel, num, orderedReasons, shortSource, tierOf } from './format.js';
import { jobIdOf, jobsOn, openJob } from './jobs-data.js';


export function scoreRing(score) {
  const C = 2 * Math.PI * 24;
  const ring = icon(
    `<svg viewBox="0 0 56 56" aria-hidden="true"><circle class="track" cx="28" cy="28" r="24" fill="none" stroke-width="5"/>` +
      `<circle class="fill" cx="28" cy="28" r="24" fill="none" stroke-width="5" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>`,
  );
  const wrap = h('div', { class: 'ring', title: `Fit score ${Number(score)} of 100` }, ring, h('b', {}, score));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    ring.querySelector('.fill').style.strokeDashoffset = String(C * (1 - score / 100));
  }));
  return wrap;
}

export function facts(item) {
  const due = dueInfo(item.dueAt);
  // The server's place label, as it is. Miles only when the server measured them to the job itself: an area
  // ("Caltrans District 10: …"), a statewide list or a contracting office has no distance, and the label says why.
  const where = item.location?.label ?? 'Location not listed';
  // No miles: said in words, never "? mi".
  const dist = item.distanceMi != null ? `${num(item.distanceMi)}\u00a0mi away` : 'No distance: site not named';
  // A label that does not fit half a 390 px card (about 18 characters at 14 px) gets the tile's full width: two
  // lines at most on the card, all of it in the detail sheet.
  const wide = where.length > 18;
  return h('div', { class: `facts${wide ? ' has-wide' : ''}` },
    h('div', { class: `fact where${wide ? ' wide' : ''}${item.distanceMi != null ? '' : ' no-dist'}`, title: where }, h('span', {}, 'Where'), h('strong', {}, where), h('small', {}, dist)),
    h('div', { class: `fact${due.urgent ? ' urgent' : ''}` }, h('span', {}, 'Bids due'), h('strong', {}, due.big), h('small', {}, due.small)),
    h('div', { class: `fact${item.overLimit ? ' over' : ''}` }, h('span', {}, 'Est. value'), h('strong', {}, estLabel(item.estValue) ?? 'Not listed'),
      h('small', {}, item.overLimit ? 'over your limit' : jobIdOf(item) ? 'the poster’s ceiling' : 'from the bid notice')),
    h('div', { class: 'fact type', title: [item.category, item.sourceName].filter(Boolean).join(' · ') }, h('span', {}, 'Type'), h('strong', {}, item.category ?? 'Bid'), h('small', { class: 'board' }, item.sourceName)),
  );
}

export function reasonsList(item, max) {
  const rs = orderedReasons(item);
  return h('ul', { class: 'reasons' }, (max ? rs.slice(0, max) : rs).map((r) => h('li', { class: r.kind }, r.text)));
}

/** "Over your limit" — Browse rows and the detail sheet only; the deck never holds these bids. */
export function overLimitTag(item) {
  return item.overLimit ? h('span', { class: 'tag over' }, 'Over your limit') : null;
}

/** The LOCAL JOB pill: a job posted on BidSwipe, bid on in the app (not an agency's board). */
export function localPill(item) {
  return jobIdOf(item) ? h('span', { class: 'pill local' }, 'Local job') : null;
}

/** The SUB WORK pill: a prime contract a general contractor bids, where this trade is usually a subcontract. */
export function subPill(item) {
  return tierOf(item) === 'sub' ? h('span', { class: 'pill sub' }, 'Sub work') : null;
}

const SUB_NOTE_KEY = 'bidswipe:sub-note-seen';

/**
 * The one line under the first SUB WORK pill someone sees, until they close it (remembered on this device).
 * Its reasons say the rest (why it is sub work, who to quote).
 */
export function subNote(item, onClose) {
  if (tierOf(item) !== 'sub' || store.get(SUB_NOTE_KEY)) return null;
  const note = h('p', { class: 'sub-note' },
    h('span', {}, 'A general contractor bids this job. You’d quote the bidders.'),
    h('button', {
      class: 'sub-note-x', type: 'button', 'aria-label': 'Got it, hide this note',
      onclick: (e) => { e.stopPropagation(); store.set(SUB_NOTE_KEY, '1'); note.remove(); onClose?.(); },
    }, icon(ICONS.x)));
  return note;
}

/**
 * The main button. Sub work says "See it on …": the company quotes the bidders, it does not bid the prime.
 * A public bid links out to the agency's site; a local job opens its page here ("See job and bid"),
 * where the sealed bid is placed. Opening a local job is not recorded as a swipe: nothing was bid yet.
 */
export function bidLink(item, extraClass = '') {
  const jobId = jobIdOf(item);
  if (jobId) {
    // Without accounts (the pilot's single mode, the demo) there is nobody to bid as: say so, no dead button.
    if (!jobsOn()) return h('p', { class: `cta-note ${extraClass}` }, 'Local jobs need an account to bid.');
    return h('button', { class: `cta ${extraClass}`, type: 'button', onclick: () => openJob(jobId) }, 'See job and bid');
  }
  return h('a', {
    class: `cta ${extraClass}`,
    href: safeUrl(item.url),
    target: '_blank',
    rel: 'noopener noreferrer',
    onclick: () => {
      if (!item.swipe) markOpened(item);
    },
  }, `${tierOf(item) === 'sub' ? 'See it on' : 'Bid on'} ${shortSource(item.sourceName)}`, icon(ICONS.open.replace('<svg ', '<svg width="16" height="16" stroke="currentColor" ')));
}
