// Local jobs: what the app keeps between screens. The person's own jobs (GET /api/jobs/mine), the rules, which
// job page is open, and the Jobs tab's count. The three job screens (views/jobs.js, job-post.js, job.js) and
// anything that opens a job (a feed card, an alert, a ?job= link) go through here, so none of them imports another.

import { api } from './api.js';
import { stage } from './job-words.js';
import { closeSheet } from './sheet-close.js';
import { onEnteredApp, onSignedOut } from './session.js';
import { registerTabCount, render, setView } from './shell.js';
import { isLive, state } from './state.js';

export const jobs = {
  /** { posted, bidding } from GET /api/jobs/mine; null until loaded. */
  mine: null,
  loading: false,
  error: null,
  rules: null,
  /** The job page: which job, and the screen Back returns to. */
  open: { id: null, back: 'jobs' },
};
onSignedOut(() => Object.assign(jobs, { mine: null, loading: false, error: null, open: { id: null, back: 'jobs' } }));

/** Jobs live only behind sign-in (accounts mode): the pilot and the bundled demo have none. */
export const jobsOn = () => isLive() && state.auth === 'accounts';

export async function loadMine() {
  if (!jobsOn() || jobs.loading) return;
  jobs.loading = true;
  try {
    jobs.mine = await api.myJobs();
    jobs.error = null;
  } catch (err) {
    jobs.error = err.message || 'Couldn’t load your jobs.';
  }
  jobs.loading = false;
  render();
}

export async function loadRules() {
  if (jobs.rules) return jobs.rules;
  jobs.rules = (await api.jobRules()).rules;
  return jobs.rules;
}

/** Ids of the person's jobs that were posted again (their repost carries repostedFrom). */
export const repostedIds = () => new Set((jobs.mine?.posted ?? []).map((j) => j.repostedFrom).filter(Boolean));

/** Every job of mine with where it stands: [{ job, side: 'posted' | 'bidding', st }]. */
export function staged() {
  if (!jobs.mine) return [];
  const re = repostedIds();
  const now = Date.now();
  return [
    ...jobs.mine.posted.map((job) => ({ job, side: 'posted', st: stage(job, { now, reposted: re.has(job.id) }) })),
    ...jobs.mine.bidding.map((job) => ({ job, side: 'bidding', st: stage(job, { now }) })),
  ];
}

/** Things waiting on this person: a job they won, a job of theirs that just closed. The tab shows this, or nothing. */
export const needsCount = () => staged().filter((s) => s.st.group === 'needs').length;

registerTabCount('jobs', () => {
  const n = jobsOn() ? needsCount() : 0;
  return { show: jobsOn(), count: n, label: n ? `Jobs: ${n} need${n === 1 ? 's' : ''} you` : 'Jobs: post a job, or see the jobs you bid on' };
});

/** Show one job's page. `back` = where its Back button goes (the screen it was opened from by default). */
export function openJob(id, back = state.view === 'job' ? jobs.open.back : state.view) {
  jobs.open = { id, back: back === 'job' || back === 'job-post' ? 'jobs' : back };
  closeSheet();
  setView('job');
}

/** A feed row id "local:<jobId>" → the job id; null for a public bid. */
export const jobIdOf = (item) => (item?.source === 'local' || String(item?.id ?? '').startsWith('local:') ? String(item.id).slice(6) : null);

// The Jobs tab's count is known from the first screen on, not only once the tab is opened.
onEnteredApp(() => { if (jobsOn()) { jobs.mine = null; loadMine(); } });

// Something happened on one of my jobs (a job alert arrived): the counts and the open page are stale.
window.addEventListener('bidswipe:job-alert', () => { if (jobsOn()) loadMine(); });
