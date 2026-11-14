// "Your work profile" in Settings: what other people see about your work (like a short Indeed profile), and
// the "How others see you" card. Saved with PUT /api/work-profile; checked again on the server
// (src/profile/work.ts), whose { path, message } errors land under the matching box here.
//
// Chips wherever there is a choice. Typing only for names and free text: the headline, a skill that is not
// in the list, the licence number, a job's title, company and summary, the link, and "about".

import { h, icon, ICONS, safeUrl } from './dom.js';
import { field, textInput } from './form.js';
import { chip } from './profile-form.js';
import { statsWords } from './job-words.js';

const LIMITS = { headline: 80, about: 600, skills: 12, skill: 30, experience: 10, summary: 300, title: 80, company: 80 };

/** Years in the trade, as bands. The number saved is each band's start (0 = under 2 years). */
export const YEAR_BANDS = [
  { years: 0, label: 'Under 2' },
  { years: 2, label: '2–5' },
  { years: 5, label: '5–10' },
  { years: 10, label: '10–20' },
  { years: 20, label: '20+' },
];
const bandOf = (years) => (years == null ? null : [...YEAR_BANDS].reverse().find((b) => years >= b.years) ?? YEAR_BANDS[0]);

export const LOOKING_KINDS = [
  { id: 'side_jobs', label: 'Side jobs' },
  { id: 'subcontract', label: 'Subcontract work' },
  { id: 'full_time', label: 'Full-time' },
  { id: 'emergency', label: 'Emergency call-outs' },
];
export const AVAILABILITY = [
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'evenings', label: 'Evenings' },
  { id: 'weekends', label: 'Weekends' },
];
const INSURED = [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }, { id: 'unsure', label: 'Not sure' }];

/** The licence states (two-letter codes), the same list the server accepts. */
const STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR', 'GU', 'VI', 'AS', 'MP',
];

// ------------------------------------------------------------------ draft --

/** GET /api/work-profile's workProfile → a draft the boxes edit. */
export function workDraftFrom(wp) {
  return {
    headline: wp.headline ?? '',
    about: wp.about ?? '',
    years: wp.yearsExperience ?? null,
    skills: [...(wp.skills ?? [])],
    license: { state: wp.license?.state ?? '', number: wp.license?.number ?? '' },
    insured: wp.insured ?? 'unsure',
    experience: (wp.experience ?? []).map((e) => ({ ...e })),
    resumeUrl: wp.resumeUrl ?? '',
    kinds: [...(wp.lookingFor?.kinds ?? [])],
    availability: [...(wp.lookingFor?.availability ?? [])],
    editing: null, // index of the job being edited, 'new' while adding one, null otherwise
    jobDraft: null,
  };
}

/** The PUT /api/work-profile body (intent is sent by Settings with it). Blank boxes are sent as null. */
export function workBodyFrom(w) {
  const blank = (s) => (String(s ?? '').trim() ? String(s).trim() : null);
  return {
    headline: blank(w.headline),
    about: blank(w.about),
    yearsExperience: w.years,
    skills: [...w.skills],
    license: w.license.state || w.license.number.trim() ? { state: w.license.state, number: w.license.number.trim() } : null,
    insured: w.insured,
    experience: w.experience.map((e) => ({ title: e.title, company: e.company, from: e.from, to: e.to, summary: e.summary })),
    resumeUrl: blank(w.resumeUrl),
    lookingFor: { kinds: [...w.kinds], availability: [...w.availability] },
  };
}

/** The server's [{ path, message }] → the { path: message } object showErrors() takes. */
export const fieldsObject = (list) => Object.fromEntries((list ?? []).map((f) => [f.path, f.message]));

// ----------------------------------------------------------------- pieces --

const errorLine = () => h('p', { class: 'field-error', role: 'alert' });

/** A labelled group of chips that repaints itself on every tap. */
function chipGroup({ key, label, help, items, isOn, onTap, optional = true }) {
  const group = h('div', { class: 'trade-chips', role: 'group', 'aria-label': label });
  const paint = () => group.replaceChildren(...items().map((it) => chip(it.label, isOn(it), () => { onTap(it); paint(); })));
  paint();
  return h('div', { class: 'field', 'data-field': key },
    h('p', { class: 'field-label' }, label, optional ? h('span', { class: 'optional' }, 'optional') : null),
    group, help ? h('p', { class: 'field-help' }, help) : null, errorLine());
}

/** A text box with a live "12 / 80" count, so a long headline never surprises anyone at Save. */
function countedText({ key, label, value, max, multiline = false, placeholder, onInput, help }) {
  const count = h('span', { class: 'wp-count', 'aria-hidden': 'true' });
  const box = multiline
    ? h('textarea', { class: 'input textarea', rows: 4, maxlength: max, placeholder })
    : textInput({ value, maxlength: max, placeholder, autocomplete: 'off' });
  if (multiline) box.value = value;
  const paint = () => { count.textContent = `${box.value.length} / ${max}`; };
  box.addEventListener('input', () => { onInput(box.value); paint(); });
  paint();
  const f = field({ key, label: h('span', { class: 'wp-label-row' }, h('span', {}, label), count), help, control: box, optional: false });
  return f;
}

/** Skills: the trades as chips, plus anything typed in (shown as chips too, tap to remove). */
function skillsField(w, trades, changed) {
  const note = h('p', { class: 'field-help' });
  const sayCount = () => { note.textContent = `${w.skills.length} of ${LIMITS.skills}. Tap a chip to add or remove it.`; };
  const group = h('div', { class: 'trade-chips', role: 'group', 'aria-label': 'Skills' });
  const lower = (s) => s.toLowerCase();
  const toggleSkill = (label) => {
    const have = w.skills.find((s) => lower(s) === lower(label));
    if (have) w.skills = w.skills.filter((s) => s !== have);
    else if (w.skills.length >= LIMITS.skills) { note.textContent = `Up to ${LIMITS.skills} skills. Remove one first.`; return; }
    else w.skills = [...w.skills, label];
    paint();
    changed();
  };
  const paint = () => {
    // Catalog trades first (in catalog order), then what the person typed.
    const fromCatalog = trades.map((t) => t.label);
    const typed = w.skills.filter((s) => !fromCatalog.some((c) => lower(c) === lower(s)));
    group.replaceChildren(
      ...fromCatalog.map((label) => chip(label, w.skills.some((s) => lower(s) === lower(label)), () => toggleSkill(label))),
      ...typed.map((label) => chip(label, true, () => toggleSkill(label))),
    );
    sayCount();
  };
  const input = textInput({ maxlength: LIMITS.skill, placeholder: 'Another skill, e.g. EV chargers', 'aria-label': 'Add a skill', enterkeyhint: 'done' });
  const add = () => {
    const s = input.value.replace(/\s+/g, ' ').trim();
    if (!s) return;
    if (!w.skills.some((x) => lower(x) === lower(s))) toggleSkill(s);
    input.value = '';
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  paint();
  return h('div', { class: 'field', 'data-field': 'skills' },
    h('p', { class: 'field-label' }, 'Skills', h('span', { class: 'optional' }, 'optional')),
    group,
    h('div', { class: 'wp-add-row' }, input, h('button', { type: 'button', class: 'cta ghost wp-add', onclick: add }, 'Add')),
    note, errorLine());
}

/** Licence: state (a list) and number (typed). Never checked by BidSwipe, and the screen says so. */
function licenseField(w, changed) {
  const state = h('select', { class: 'input select', 'aria-label': 'Licence state' },
    h('option', { value: '' }, 'State'),
    STATES.map((s) => h('option', { value: s, selected: s === w.license.state }, s)));
  state.addEventListener('change', () => { w.license.state = state.value; changed(); });
  const number = textInput({ value: w.license.number, maxlength: 40, placeholder: 'Licence number', 'aria-label': 'Licence number', autocomplete: 'off' });
  number.addEventListener('input', () => { w.license.number = number.value; changed(); });
  return h('div', { class: 'field', 'data-field': 'license' },
    h('p', { class: 'field-label' }, 'Contractor licence', h('span', { class: 'optional' }, 'optional')),
    h('div', { class: 'wp-license', 'data-field': 'license.state' }, state,
      h('div', { class: 'wp-license-number', 'data-field': 'license.number' }, number, errorLine())),
    h('p', { class: 'wp-note' }, 'As you typed it. BidSwipe does not verify licences.'),
    errorLine());
}

function insuredField(w, changed) {
  const seg = h('div', { class: 'seg3', role: 'radiogroup', 'aria-label': 'Insured' });
  const paint = () => seg.replaceChildren(...INSURED.map((a) => {
    const b = h('button', { type: 'button', role: 'radio', class: `seg3-btn is-${a.id}`, 'aria-checked': String(w.insured === a.id) }, a.label);
    b.addEventListener('click', () => { w.insured = a.id; paint(); changed(); });
    return b;
  }));
  paint();
  return h('div', { class: 'field', 'data-field': 'insured' }, h('p', { class: 'field-label' }, 'Insured?'), seg, errorLine());
}

const yearsText = (e) => (e.from == null && e.to == null ? '' : `${e.from ?? '?'} – ${e.to ?? 'present'}`);

/** Years for the from / to lists: this year back to 1950. */
function yearOptions(selected, { present = false, none = 'Year' } = {}) {
  const now = new Date().getFullYear();
  const opts = [h('option', { value: '' }, none)];
  if (present) opts.push(h('option', { value: 'present', selected: selected === 'present' }, 'Present'));
  for (let y = now; y >= 1950; y -= 1) opts.push(h('option', { value: String(y), selected: selected === String(y) }, String(y)));
  return opts;
}

/** Past jobs: a list with Edit / Remove, and one inline editor (add or edit) at a time. */
function experienceField(w, changed, repaintAll) {
  const startEdit = (i) => {
    const e = i === 'new' ? { title: '', company: null, from: null, to: null, summary: null } : w.experience[i];
    w.editing = i;
    w.jobDraft = { title: e.title ?? '', company: e.company ?? '', from: e.from == null ? '' : String(e.from), to: e.to == null ? (i === 'new' ? '' : 'present') : String(e.to), summary: e.summary ?? '' };
    repaintAll();
  };
  const rows = w.experience.map((e, i) => (w.editing === i ? editor(i) : h('li', { class: 'wp-job', 'data-field': `experience.${i}` },
    h('div', { class: 'wp-job-text' },
      h('strong', {}, e.title),
      h('span', {}, [e.company, yearsText(e)].filter(Boolean).join(' · ')),
      e.summary ? h('p', {}, e.summary) : null,
      errorLine()),
    h('div', { class: 'wp-job-actions' },
      h('button', { type: 'button', class: 'text-btn', onclick: () => startEdit(i) }, 'Edit'),
      h('button', { type: 'button', class: 'text-btn danger', onclick: () => { w.experience.splice(i, 1); changed(); repaintAll(); } }, 'Remove')))));

  function editor(i) {
    const j = w.jobDraft;
    const title = textInput({ value: j.title, maxlength: LIMITS.title, placeholder: 'e.g. Journeyman electrician', autocomplete: 'off' });
    title.addEventListener('input', () => { j.title = title.value; });
    const company = textInput({ value: j.company, maxlength: LIMITS.company, placeholder: 'Company (optional)', autocomplete: 'off', 'aria-label': 'Company' });
    company.addEventListener('input', () => { j.company = company.value; });
    const from = h('select', { class: 'input select', 'aria-label': 'From year' }, yearOptions(j.from, { none: 'From' }));
    from.addEventListener('change', () => { j.from = from.value; });
    const to = h('select', { class: 'input select', 'aria-label': 'To year' }, yearOptions(j.to, { present: true, none: 'To' }));
    to.addEventListener('change', () => { j.to = to.value; });
    const summary = h('textarea', { class: 'input textarea short', rows: 2, maxlength: LIMITS.summary, placeholder: 'What you did (optional)', 'aria-label': 'Summary' });
    summary.value = j.summary;
    summary.addEventListener('input', () => { j.summary = summary.value; });
    const problem = h('p', { class: 'field-error', role: 'alert' });
    const done = () => {
      const t = j.title.replace(/\s+/g, ' ').trim();
      if (!t) { problem.textContent = 'Enter a job title.'; title.focus(); return; }
      const fromY = j.from ? Number(j.from) : null;
      const toY = j.to && j.to !== 'present' ? Number(j.to) : null;
      if (fromY != null && toY != null && toY < fromY) { problem.textContent = '“To” can’t be before “From”.'; return; }
      const entry = { title: t, company: j.company.trim() || null, from: fromY, to: toY, summary: j.summary.trim() || null };
      if (i === 'new') w.experience.push(entry); else w.experience[i] = entry;
      w.editing = null;
      w.jobDraft = null;
      changed();
      repaintAll();
    };
    const cancel = () => { w.editing = null; w.jobDraft = null; repaintAll(); };
    return h('li', { class: 'wp-job is-editing', 'data-field': i === 'new' ? 'experience' : `experience.${i}` },
      h('label', { class: 'mini' }, h('span', {}, 'Title'), title),
      company,
      h('div', { class: 'pair' }, from, to),
      summary,
      problem,
      h('div', { class: 'wp-job-actions' },
        h('button', { type: 'button', class: 'cta wp-done', onclick: done }, i === 'new' ? 'Add job' : 'Done'),
        h('button', { type: 'button', class: 'text-btn', onclick: cancel }, 'Cancel')));
  }

  const full = w.experience.length >= LIMITS.experience;
  return h('div', { class: 'field', 'data-field': 'experience' },
    h('p', { class: 'field-label' }, 'Experience', h('span', { class: 'optional' }, 'optional')),
    rows.length || w.editing === 'new' ? h('ul', { class: 'wp-jobs' }, rows, w.editing === 'new' ? editor('new') : null) : null,
    w.editing === null && !full
      ? h('button', { type: 'button', class: 'cta ghost wp-add-job', onclick: () => startEdit('new') }, '+ Add a job')
      : null,
    full ? h('p', { class: 'field-help' }, `Up to ${LIMITS.experience} jobs.`) : null,
    errorLine());
}

function linkField(w, changed) {
  const input = h('input', { class: 'input', type: 'url', inputmode: 'url', id: 'wp-link', value: w.resumeUrl, maxlength: 500, placeholder: 'https://…', autocomplete: 'url' });
  const hint = h('p', { class: 'field-help' });
  const check = () => {
    const v = input.value.trim();
    hint.textContent = !v || /^https?:\/\/[^\s/]+\.[^\s]+/i.test(v) ? 'Your résumé, website or a page of your work. A link that starts with https://.'
      : 'Use a full link that starts with http:// or https://.';
  };
  input.addEventListener('input', () => { w.resumeUrl = input.value; check(); changed(); });
  check();
  return h('div', { class: 'field', 'data-field': 'resumeUrl' },
    h('label', { class: 'field-label', for: 'wp-link' }, 'Résumé or website', h('span', { class: 'optional' }, 'optional')),
    input, hint, errorLine());
}

// ------------------------------------------------------------ the preview --

const fmtMonth = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' });
const INSURED_TEXT = { yes: 'Insured', no: 'Not insured', unsure: null };

/** "3 jobs won · 2 agreed · 0 no-shows", or "New on BidSwipe" before any job. */
// The same words as the job pages (job-words.js): "3 jobs won · 2 agreed · 0 no-shows".
function statsLine(s) {
  return s ? statsWords(s) : null;
}

/**
 * The card as other people see it: the server's card (name, member since, job record), with what is being
 * edited laid over it, so the preview changes as you type. Save makes it real.
 */
export function personCardView(card, w = null) {
  const c = w ? { ...card, ...cardFieldsFrom(w) } : card;
  const band = bandOf(c.yearsExperience);
  const facts = [
    band ? `${band.label} years in the trade` : null,
    INSURED_TEXT[c.insured],
  ].filter(Boolean);
  const href = safeUrl(c.resumeUrl);
  return h('article', { class: 'person-card' },
    h('header', { class: 'pcard-head' },
      h('div', { class: 'pcard-avatar', 'aria-hidden': 'true' }, initials(c.name)),
      h('div', { class: 'pcard-who' },
        h('strong', { class: 'pcard-name' }, c.name),
        c.headline ? h('span', { class: 'pcard-headline' }, c.headline) : null)),
    facts.length ? h('p', { class: 'pcard-facts' }, facts.join(' · ')) : null,
    c.license ? h('p', { class: 'pcard-license' }, `${c.license.state} licence ${c.license.number}`, h('small', {}, 'As typed. Not verified by BidSwipe.')) : null,
    c.skills?.length ? h('div', { class: 'pcard-skills' }, c.skills.map((s) => h('span', { class: 'pcard-skill' }, s))) : null,
    c.about ? h('p', { class: 'pcard-about' }, c.about) : null,
    c.experience?.length ? h('ul', { class: 'pcard-jobs' }, c.experience.map((e) => h('li', {},
      h('strong', {}, e.title), h('span', {}, [e.company, yearsText(e)].filter(Boolean).join(' · '))))) : null,
    href !== '#' ? h('a', { class: 'pcard-link', href, target: '_blank', rel: 'noopener noreferrer nofollow' }, icon(OPEN_ICON), h('span', {}, linkLabel(href))) : null,
    h('footer', { class: 'pcard-foot' },
      h('span', {}, c.memberSince ? `Member since ${fmtMonth.format(new Date(c.memberSince))}` : ''),
      h('span', {}, statsLine(c.stats) ?? '')),
  );
}

const OPEN_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg>';

const initials = (name) => (name ?? '').split(/\s+/).filter((p) => /^[\p{L}\p{N}]/u.test(p)).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';

/** "example.com/resume" — the host and path, short, so a long link never pushes the card wider. */
function linkLabel(href) {
  try {
    const u = new URL(href);
    const text = `${u.host.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`;
    return text.length > 40 ? `${text.slice(0, 39)}…` : text;
  } catch { return 'Link'; }
}

/**
 * The draft in the card's shape. "What you're looking for" is not on the card (jobs contract §5: the card
 * has no such field), so it is not in the preview either: the preview shows exactly what others see.
 */
function cardFieldsFrom(w) {
  const b = workBodyFrom(w);
  return {
    headline: b.headline, about: b.about, yearsExperience: b.yearsExperience, skills: b.skills,
    license: b.license && b.license.state && b.license.number ? b.license : null,
    insured: b.insured, experience: b.experience, resumeUrl: b.resumeUrl,
  };
}

// --------------------------------------------------------------- section --

/**
 * The whole "Your work profile" section. `w` is the draft (workDraftFrom), `card` the server's card,
 * `trades` the catalog (GET /api/trades) for the skill chips. Edits change `w` in place.
 */
export function workProfileSection(w, { card, trades }) {
  const wrap = h('div', { class: 'stack wp' });
  const preview = h('div', { class: 'pcard-wrap' });
  const repaintPreview = () => preview.replaceChildren(card ? personCardView(card, w) : h('p', { class: 'field-help' }, 'Loading…'));
  const changed = () => repaintPreview();
  const repaintAll = () => { wrap.replaceChildren(...build()); repaintPreview(); };

  function build() {
    return [
      countedText({ key: 'headline', label: 'Headline', value: w.headline, max: LIMITS.headline, placeholder: 'e.g. Licensed electrician, small jobs welcome', onInput: (v) => { w.headline = v; changed(); } }),
      chipGroup({
        key: 'yearsExperience', label: 'Years in the trade', items: () => YEAR_BANDS,
        isOn: (b) => bandOf(w.years)?.years === b.years,
        onTap: (b) => { w.years = bandOf(w.years)?.years === b.years ? null : b.years; changed(); },
      }),
      skillsField(w, trades ?? [], changed),
      licenseField(w, changed),
      insuredField(w, changed),
      chipGroup({
        key: 'lookingFor.kinds', label: 'What you’re looking for', items: () => LOOKING_KINDS,
        isOn: (k) => w.kinds.includes(k.id),
        onTap: (k) => { w.kinds = w.kinds.includes(k.id) ? w.kinds.filter((x) => x !== k.id) : LOOKING_KINDS.map((x) => x.id).filter((id) => id === k.id || w.kinds.includes(id)); changed(); },
      }),
      chipGroup({
        key: 'lookingFor.availability', label: 'When you can work', items: () => AVAILABILITY,
        isOn: (a) => w.availability.includes(a.id),
        onTap: (a) => { w.availability = w.availability.includes(a.id) ? w.availability.filter((x) => x !== a.id) : AVAILABILITY.map((x) => x.id).filter((id) => id === a.id || w.availability.includes(id)); changed(); },
      }),
      experienceField(w, changed, repaintAll),
      linkField(w, changed),
      countedText({ key: 'about', label: 'About', value: w.about, max: LIMITS.about, multiline: true, placeholder: 'A few lines about you and the work you like.', onInput: (v) => { w.about = v; changed(); } }),
      h('div', { 'data-field': 'lookingFor' }, errorLine()),
    ];
  }
  wrap.replaceChildren(...build());
  repaintPreview();
  return { form: wrap, preview };
}
