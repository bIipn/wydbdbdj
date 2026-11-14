// The Jobs tab: "Post a job", then the jobs this person posted and the jobs they bid on, each grouped by what
// it needs (Needs you · Open · Finished). Every row says where the job stands in words and what to do next;
// a tap opens the job page (views/job.js).

import { h, icon, ICONS } from '../dom.js';
import { GONE_TITLE, goneWords } from '../job-words.js';
import { jobs, jobsOn, loadMine, loadRules, openJob, staged } from '../jobs-data.js';
import { openPostJob } from './job-post.js';
import { setHireLanding } from '../session.js';
import { registerView, render } from '../shell.js';
import { intent } from '../state.js';

const GROUPS = [
  { id: 'needs', title: 'Needs you' },
  { id: 'open', title: 'Open' },
  { id: 'done', title: 'Finished' },
];

const PLUS = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

function jobRow({ job, st }) {
  return h('button', { class: `row job-row group-${st.group}`, type: 'button', onclick: () => openJob(job.id, 'jobs') },
    h('div', { class: 'job-row-mark', 'aria-hidden': 'true' }),
    h('div', { class: 'job-row-text' },
      h('h4', {}, job.title),
      h('p', {}, `${job.place.city}, ${job.place.state} ${job.place.zip}`),
      h('p', { class: 'job-state' }, st.status),
      st.next ? h('p', { class: 'job-next' }, st.next) : null,
    ),
  );
}

/**
 * A job this person was waiting on whose poster deleted their account (GET /api/jobs/mine `ended`). The job is
 * gone; the row says so and that nothing is owed, and opens the same one line as a page.
 */
function goneRow(g) {
  return h('button', { class: 'row job-row group-done', type: 'button', onclick: () => openJob(g.id, 'jobs') },
    h('div', { class: 'job-row-mark', 'aria-hidden': 'true' }),
    h('div', { class: 'job-row-text' },
      h('h4', {}, g.title),
      h('p', { class: 'job-state' }, GONE_TITLE),
      h('p', { class: 'job-next' }, goneWords(g)),
    ),
  );
}

/**
 * One side (posted / bidding) in its three groups; groups with nothing in them are left out. `gone` rows (jobs
 * that ended with their poster's account) close the Finished group.
 */
function side(title, list, empty, gone = []) {
  if (!list.length && !gone.length) return h('section', { class: 'jobs-side' }, h('h2', { class: 'section-title' }, title), empty);
  // Inside a group: the job that ends soonest first.
  const soon = (s) => Date.parse(s.job.award?.contactDeadline ?? s.job.closesAt);
  return h('section', { class: 'jobs-side' },
    h('h2', { class: 'section-title' }, title),
    GROUPS.map((g) => {
      const rows = list.filter((s) => s.st.group === g.id)
        .sort((a, b) => (g.id === 'done' ? soon(b) - soon(a) : soon(a) - soon(b)));
      const extra = g.id === 'done' ? gone : [];
      if (!rows.length && !extra.length) return null;
      return h('div', { class: `jobs-group jobs-${g.id}` },
        h('h3', { class: 'jobs-group-title' }, g.title, h('span', { class: 'jobs-group-n' }, String(rows.length + extra.length))),
        h('div', { class: 'list' }, rows.map(jobRow), extra.map(goneRow)));
    }),
  );
}

function emptyLine(text, button) {
  return h('div', { class: 'jobs-empty' }, h('p', {}, text), button);
}

function renderJobs() {
  if (!jobsOn()) {
    return h('div', { class: 'empty' }, h('h3', {}, 'Local jobs need an account'), h('p', {}, 'Sign in to post a job or bid on one.'));
  }
  if (!jobs.mine && !jobs.loading && !jobs.error) loadMine();
  if (!jobs.rules) loadRules().then(render, () => {});
  const hire = intent() === 'hire';
  const post = h('button', { class: 'cta post-job', type: 'button', onclick: openPostJob }, icon(PLUS), 'Post a job');

  let body;
  if (jobs.error && !jobs.mine) {
    body = h('div', { class: 'empty compact' }, h('h3', {}, 'Couldn’t load your jobs'), h('p', {}, jobs.error),
      h('button', { class: 'cta ghost', type: 'button', onclick: () => { jobs.error = null; render(); } }, 'Try again'));
  } else if (!jobs.mine) {
    body = h('div', { class: 'list' }, [0, 1].map(() => h('div', { class: 'row skeleton', 'aria-hidden': 'true' })));
  } else {
    const all = staged();
    const posted = all.filter((s) => s.side === 'posted');
    const bidding = all.filter((s) => s.side === 'bidding');
    // Someone here to get work done sees their posts first; someone here for work sees their bids first.
    const postedSide = side('Your jobs', posted, emptyLine(hire
      ? 'Nothing posted yet. Describe the job, pick the trade, and people nearby send sealed bids. The lowest bid wins.'
      : 'Need a hand yourself? Post a job and people nearby send sealed bids.'));
    const biddingSide = side('Your bids', bidding, emptyLine(hire
      ? 'You haven’t bid on anything. To bid on other people’s jobs too, pick “Both” in Settings and add your trade.'
      : 'No bids yet. Local jobs that fit your trade show up in Swipe and Browse with a LOCAL JOB tag. Open one to bid.'),
    jobs.mine.ended ?? []);
    body = hire ? [postedSide, biddingSide] : [biddingSide, postedSide];
  }

  return h('div', { class: 'jobs' },
    post,
    h('p', { class: 'jobs-intro' }, 'Sealed bids, lowest wins.',
      jobs.rules ? ` The winner has ${jobs.rules.contactDays} days to make contact and work it out with the poster.` : null),
    body,
  );
}

registerView('jobs', { chrome: 'tabs', render: renderJobs });
// Someone here only to get work done lands on this tab (session.js homeView()).
setHireLanding('jobs');
