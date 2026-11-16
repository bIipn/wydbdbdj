// Home's "Finish setting up" tasks: which ones this account really has. Pure: facts in, tasks out
// (test/home-tasks.test.ts); home-extras.js gathers the facts and draws the card.
//
// A task exists only when it is TRUE for this account and DOABLE in the app right now, and its button goes to the
// exact place it is done. No task promises a result or quotes a figure we do not have, and a feature the plan does
// not include is never a task (the Premium rule). Checked and left out on purpose:
//   - a price range: every "find work" profile has one (onboarding asks for a job size; Settings cannot clear it);
//   - sub work switched off: a choice the company made, not something left undone (Your preferences shows it);
//   - a small radius: "small" would be our guess; the finished deck already offers "Widen your reach".

/** The paperwork questions the scorer reads (src/score/score.ts); the state public-works one only for Nevada. */
export const PAPERWORK_KEYS = ['statePublicWorks', 'samRegistered', 'bonding', 'prevailingWage'];

/** The two-letter state at the end of a base label ("Gardnerville, NV" → "NV"); null when there is none. */
export function homeStateOf(base) {
  const m = /,\s*([A-Z]{2})(?:\s+\d{5})?\s*$/.exec(String(base ?? ''));
  return m ? m[1] : null;
}

/** The paperwork questions still unanswered or "Not sure" (a profile that never answered: all of them). */
export function paperworkOpen(profile) {
  const keys = PAPERWORK_KEYS.filter((k) => k !== 'statePublicWorks' || homeStateOf(profile?.base) === 'NV');
  const q = profile?.qualifications ?? {};
  return keys.filter((k) => q[k] !== 'yes' && q[k] !== 'no');
}

/** How the task names each question (what the bid cards check: src/score/score.ts). */
const PAPERWORK_WORDS = {
  statePublicWorks: 'Nevada public works qualification',
  samRegistered: 'SAM.gov registration',
  bonding: 'bonding',
  prevailingWage: 'prevailing wage',
};

/** ["a", "b", "c"] → "a, b and c". */
const listWords = (w) => (w.length < 2 ? w.join('') : `${w.slice(0, -1).join(', ')} and ${w.at(-1)}`);

/** GET /api/work-profile's workProfile with nothing in it: no headline, years, skills, licence, jobs, link or about. */
export function workProfileEmpty(wp) {
  if (!wp) return false;
  const blank = (s) => !String(s ?? '').trim();
  return blank(wp.headline) && blank(wp.about) && wp.yearsExperience == null && !(wp.skills ?? []).length
    && !wp.license && !(wp.experience ?? []).length && blank(wp.resumeUrl)
    && !(wp.lookingFor?.kinds ?? []).length && !(wp.lookingFor?.availability ?? []).length
    && (wp.insured == null || wp.insured === 'unsure');
}

/** The name onboarding gives a company that skipped the step ("My electrical shop", profile-form.js defaultBusinessName). */
export const isDefaultName = (name) => /^My (?:\w[\w\s/&-]* )?shop$/.test(String(name ?? '').trim());

/**
 * facts: {
 *   live, auth ('single' | 'accounts'), intent ('work' | 'hire' | 'both'), profile (GET /api/me profile summary),
 *   features (the plan's), push ('off' | 'on' | 'locked' | 'denied' | 'unsupported' | 'not_configured' | null = not checked),
 *   jobsOn (local jobs are on), workProfile (GET /api/work-profile's workProfile, null = not loaded)
 * }
 * → [{ id, title, text, actions: [{ label, go: { to: 'settings', field } | { to: 'alerts' } }] }]
 */
export function homeTasks(f) {
  // The pilot (single mode) cannot edit its profile in the app; the demo has no server; 'hire' never sees Home.
  if (!f?.live || f.auth !== 'accounts' || !f.profile || f.intent === 'hire') return [];
  const out = [];

  const open = paperworkOpen(f.profile);
  if (open.length > 0) {
    const words = listWords(open.map((k) => PAPERWORK_WORDS[k]));
    out.push({
      id: 'paperwork',
      title: open.length === 1 ? 'One paperwork question is open' : `${open.length} paperwork questions are open`,
      text: `${words[0].toUpperCase()}${words.slice(1)}: until you answer Yes or No, bid cards that ask for ${open.length === 1 ? 'it' : 'them'} tell you to check.`,
      actions: [{ label: open.length === 1 ? 'Answer it' : 'Answer them', go: { to: 'settings', field: 'qualifications' } }],
    });
  }

  if (f.features?.instantPush === true && f.push === 'off') {
    out.push({
      id: 'push',
      title: 'Phone alerts are off on this device',
      text: 'Turn them on and a new bid that fits reaches this phone when the daily scan finds it.',
      actions: [{ label: 'Turn on phone alerts', go: { to: 'alerts' } }],
    });
  }

  if (f.jobsOn && workProfileEmpty(f.workProfile)) {
    out.push({
      id: 'work-profile',
      title: 'Your work profile is empty',
      text: 'People who post local jobs see it when you deal with them on a job. Add a headline, your years in the trade or your licence.',
      actions: [{ label: 'Fill it in', go: { to: 'settings', field: 'headline' } }],
    });
  }

  if (isDefaultName(f.profile.businessName)) {
    out.push({
      id: 'name',
      title: 'Your business has no name yet',
      text: `BidSwipe shows it as “${f.profile.businessName}”. Add your real business name.`,
      actions: [{ label: 'Add the name', go: { to: 'settings', field: 'businessName' } }],
    });
  }
  return out;
}
