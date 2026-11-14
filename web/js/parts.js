// Pieces of a bid shared by the swipe card, the list rows and the detail sheet.

import { markOpened } from './actions.js';
import { h, icon, ICONS, safeUrl } from './dom.js';
import { dueInfo, estLabel, orderedReasons, shortSource } from './format.js';
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
  const where = item.location?.label ?? 'Location not listed';
  const dist = item.distanceMi != null ? `${item.distanceMi} mi away` : 'Distance unknown';
  return h('div', { class: 'facts' },
    h('div', { class: 'fact' }, h('span', {}, 'Where'), h('strong', {}, where), h('small', {}, dist)),
    h('div', { class: `fact${due.urgent ? ' urgent' : ''}` }, h('span', {}, 'Bids due'), h('strong', {}, due.big), h('small', {}, due.small)),
    h('div', { class: `fact${item.overLimit ? ' over' : ''}` }, h('span', {}, 'Est. value'), h('strong', {}, estLabel(item.estValue) ?? 'Not listed'),
      h('small', {}, item.overLimit ? 'over your limit' : jobIdOf(item) ? 'the poster’s ceiling' : 'from the bid notice')),
    h('div', { class: 'fact' }, h('span', {}, 'Type'), h('strong', {}, item.category ?? 'Bid'), h('small', {}, item.sourceName)),
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

/**
 * The main button. A public bid links out to the agency's site; a local job opens its page here ("See job and bid"),
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
  }, `Bid on ${shortSource(item.sourceName)}`, icon(ICONS.open.replace('<svg ', '<svg width="16" height="16" stroke="currentColor" ')));
}
