// The cost check form: a draft of what the person typed, the POST /api/estimate body built from it, and the
// sections that draw it. The quick card (job + six numbers) gives a price with one tap; everything else sits in
// named sections that stay closed until opened, or until the engine needs an answer that lives there.
//
// Rules this file keeps:
//  - Every number goes to the API as the text that was typed (the engine parses decimals exactly). Nothing is
//    computed here, and an empty box is left out, never sent as 0: the engine lists what it still needs.
//  - Reference figures from public data (area wage, prevailing wage, federal awards) are hints beside the
//    inputs with their source and period. They are never typed into a box for the person.
//  - Every field wrapper carries data-field="<API path>" so 400 field errors and "needed" questions land on it.

import { h, icon, ICONS } from './dom.js';
import { dollarsText } from './format.js';
import { field, moneyInput, nextId, textInput } from './form.js';
import { OWNER_FROM_SOURCE } from './source-labels.js';

// ------------------------------------------------------------- vocab --

export const OWNER_TYPES = [
  { id: 'nv_local', label: 'Nevada city, county or district' },
  { id: 'nv_state_spwd', label: 'Nevada state (Public Works Division)' },
  { id: 'ndot', label: 'NDOT (Nevada roads)' },
  { id: 'federal', label: 'Federal agency' },
  { id: 'federal_aided_local', label: 'Local agency, federal money' },
  { id: 'ca_local', label: 'California city, county or district' },
  { id: 'ca_state', label: 'California state agency' },
  { id: 'caltrans', label: 'Caltrans (California roads)' },
  { id: 'private', label: 'Private owner' },
];
/** Owner types whose state the engine does not imply: the person names it. */
const NEEDS_STATE = new Set(['', 'federal', 'federal_aided_local', 'private']);

const PREVAILING = [
  { id: 'none', label: 'Not required' },
  { id: 'davis_bacon', label: 'Davis-Bacon (federal)' },
  { id: 'nv_338', label: 'Nevada NRS 338' },
  { id: 'ca_dir', label: 'California DIR' },
];

const GL_BASIS = [
  { id: 'none', label: 'Already in my overhead' },
  { id: 'receipts', label: 'On sales (per $1,000)' },
  { id: 'payroll', label: 'On payroll (% of wages)' },
];

// The bid's board says who the owner is, for some boards only (source-labels.js `owner`); shown as "from the
// bid", always changeable.

export const SECTIONS = [
  { id: 'labor', title: 'Labor and payroll', blurb: 'Workers’ comp, payroll taxes, more crews' },
  { id: 'materials', title: 'Material lines', blurb: 'Line-by-line quotes, sales tax, freight' },
  { id: 'equip', title: 'Equipment and job costs', blurb: 'Rentals, permits, supervision' },
  { id: 'markups', title: 'Insurance and markups', blurb: 'General liability, small tools, contingency' },
  { id: 'bond', title: 'Bond', blurb: 'Performance and payment bond' },
  { id: 'payment', title: 'Payment terms', blurb: 'Billing, owner pay days, retainage' },
  { id: 'cash', title: 'Cash and credit', blurb: 'Cash for the job, credit line, financing' },
  { id: 'limits', title: 'Limits and stress tests', blurb: 'Job size, up-front cash, surety letter' },
];

// ------------------------------------------------------------- draft --

const str = (v) => (v == null ? '' : String(v));

/**
 * A fresh draft. `profile` = ProfileSummary (accounts mode) or null; `bid` = the feed item or null.
 * `prefilled` names the boxes filled from saved settings or the bid, so the form can say so.
 */
export function newDraft({ profile, bid }) {
  const costs = profile?.costs ?? {};
  const limits = profile?.limits ?? {};
  const d = {
    bidId: bid?.id ?? null,
    prefilled: new Set(),
    job: { ownerType: '', state: '', prevailingWage: '', startDate: '', endDate: '', estimatedCost: '' },
    quick: { hours: '', wage: '', materials: '', subs: '', overheadPct: '', profitPct: '' },
    labor: {
      burdenMode: 'statutory', flatBurdenPercent: '', wc: '', overtimeHours: '', planFringe: '',
      prevBasic: '', prevFringe: '', experienceMod: '', policyEffectiveDate: '', mbtMode: '', mbtWages: '',
      uiRate: '', futa: '', classes: [],
    },
    materials: { lines: [], salesTaxPercent: '', freight: '' },
    equipment: [],
    jobOverhead: [],
    markups: { glBasis: '', glValue: '', smallToolsPercent: '', contingencyPercent: '', bidRoundingUnit: '' },
    bond: { required: '', ratePer1000: '', surcharge: '', officerChoice: '' },
    payment: { billingCycleDays: '', ownerPayDays: '', retainagePercent: '', retainageReleaseDays: '', supplierNetDays: '' },
    cash: { financing: '', rate: '', cashForJob: '', unusedCreditLine: '', bufferPercent: '' },
    limits: { maxJobSize: '', maxUpFrontCash: '', single: '', aggregate: '', backlog: '', laborUp: '', changeOrder: '' },
  };
  const fill = (obj, key, value, name) => {
    if (value == null || value === '') return;
    obj[key] = value;
    d.prefilled.add(name);
  };
  fill(d.quick, 'wage', costs.laborRate != null ? (Number.isInteger(costs.laborRate) ? str(costs.laborRate) : costs.laborRate.toFixed(2)) : null, 'quick.wage');
  fill(d.quick, 'overheadPct', costs.overheadPct != null ? str(costs.overheadPct) : null, 'quick.overheadPct');
  fill(d.quick, 'profitPct', costs.profitPct != null ? str(costs.profitPct) : null, 'quick.profitPct');
  if (costs.burdenPct != null) {
    d.labor.burdenMode = 'flat';
    fill(d.labor, 'flatBurdenPercent', str(costs.burdenPct), 'labor.flatBurdenPercent');
  }
  fill(d.limits, 'maxJobSize', limits.maxJobSize != null ? dollarsText(limits.maxJobSize) : null, 'limits.maxJobSize');
  fill(d.limits, 'maxUpFrontCash', limits.maxUpfront != null ? dollarsText(limits.maxUpfront) : null, 'limits.maxUpFrontCash');
  if (bid) {
    if (/^[A-Z]{2}$/.test(bid.location?.state ?? '')) fill(d.job, 'state', bid.location.state, 'job.state');
    fill(d.job, 'ownerType', OWNER_FROM_SOURCE[bid.source] ?? null, 'job.ownerType');
  }
  return d;
}

/** Is there a main crew (the quick hours and wage)? It is labor class 0 when there is. */
const hasMain = (d) => d.quick.hours.trim() !== '' || d.quick.wage.trim() !== '';
const classOffset = (d) => (hasMain(d) ? 1 : 0);

/**
 * Will the engine apply a prevailing wage? The Job card's choice when one is made ('none' = no). Left on
 * "As the bid notice says", it follows the notice: the bid's prevailing-wage flag, or the last result's
 * bid facts ("prevailing wage: nv_338"). Then the determination basic and fringe fields must be there,
 * because the engine will ask for them.
 */
export function prevailingOn(d, bid, result) {
  if (d.job.prevailingWage) return d.job.prevailingWage !== 'none';
  if (bid?.flags?.some((f) => /prevailing/i.test(f))) return true;
  return (result?.bidFacts ?? []).some((f) => /^prevailing wage:\s*(?!none\b)\S/i.test(f.how ?? ''));
}

// ----------------------------------------------------------- request --

const t = (s) => (typeof s === 'string' ? s.trim() : s);
/** Put `value` at obj[key] only when something was typed. */
function put(obj, key, value) {
  const v = t(value);
  if (v !== '' && v != null) obj[key] = v;
  return obj;
}
/** Whole days go to the API as numbers; anything else as typed, so the API names the problem under the box. */
function days(obj, key, value) {
  const v = t(value);
  if (v === '' || v == null) return obj;
  obj[key] = /^\d+$/.test(v) ? Number(v) : v;
  return obj;
}
const nonEmpty = (o) => Object.keys(o).length > 0;

/** The POST /api/estimate body (an EstimateRequest, plus bidId). */
export function requestFrom(d) {
  const body = {};
  if (d.bidId) body.bidId = d.bidId;

  const job = {};
  put(job, 'ownerType', d.job.ownerType);
  if (NEEDS_STATE.has(d.job.ownerType)) put(job, 'state', d.job.state.toUpperCase());
  put(job, 'prevailingWage', d.job.prevailingWage);
  put(job, 'startDate', d.job.startDate);
  put(job, 'endDate', d.job.endDate);
  put(job, 'estimatedCost', d.job.estimatedCost);
  body.job = job;

  const L = d.labor;
  const labor = {};
  if (L.burdenMode === 'flat') { labor.burdenMode = 'flat'; put(labor, 'flatBurdenPercent', L.flatBurdenPercent); }
  const classes = [];
  if (hasMain(d)) {
    const c = { label: 'Your crew' };
    put(c, 'hours', d.quick.hours);
    put(c, 'wage', d.quick.wage);
    put(c, 'overtimeHours', L.overtimeHours);
    put(c, 'planFringe', L.planFringe);
    put(c, 'workersCompPer100', L.wc);
    if (t(L.prevBasic) || t(L.prevFringe)) c.prevailing = put(put({}, 'basic', L.prevBasic), 'fringe', L.prevFringe);
    classes.push(c);
  }
  for (const x of L.classes) {
    const c = { label: t(x.label) || 'Labor class' };
    put(c, 'hours', x.hours);
    put(c, 'wage', x.wage);
    put(c, 'workersCompPer100', x.wc);
    if (t(x.prevBasic) || t(x.prevFringe)) c.prevailing = put(put({}, 'basic', x.prevBasic), 'fringe', x.prevFringe);
    classes.push(c);
  }
  if (classes.length) labor.classes = classes;
  if (t(L.experienceMod) || t(L.policyEffectiveDate)) labor.workersComp = put(put({}, 'experienceMod', L.experienceMod), 'policyEffectiveDate', L.policyEffectiveDate);
  if (L.mbtMode === 'none') labor.mbt = { mode: 'none' };
  else if (L.mbtMode) labor.mbt = put({ mode: L.mbtMode }, 'quarterlyGrossWages', L.mbtWages);
  put(labor, 'stateUiRatePercent', L.uiRate);
  put(labor, 'futaCreditReductionPercent', L.futa);
  if (nonEmpty(labor)) body.labor = labor;

  const materials = {};
  if (d.materials.lines.length) {
    materials.lines = d.materials.lines.map((x) => put(put(put({ label: t(x.label) || 'Material' }, 'quantity', x.quantity), 'unitPrice', x.unitPrice), 'wastePercent', x.wastePercent));
  } else if (t(d.quick.materials)) {
    materials.total = { amount: t(d.quick.materials) };
  }
  put(materials, 'salesTaxPercent', d.materials.salesTaxPercent);
  put(materials, 'freight', d.materials.freight);
  if (nonEmpty(materials)) body.materials = materials;

  const lineList = (rows, fallback) => rows.map((x) => put({ label: t(x.label) || fallback }, 'amount', x.amount));
  if (d.equipment.length) body.equipment = lineList(d.equipment, 'Equipment');
  if (t(d.quick.subs)) body.subcontracts = [{ label: 'Subcontracts', amount: t(d.quick.subs) }];
  if (d.jobOverhead.length) body.jobOverhead = lineList(d.jobOverhead, 'Job cost');

  const M = d.markups;
  const markups = {};
  if (t(d.quick.overheadPct)) markups.overhead = { method: 'on_cost', percent: t(d.quick.overheadPct) };
  put(markups, 'profitPercent', d.quick.profitPct);
  put(markups, 'smallToolsPercent', M.smallToolsPercent);
  put(markups, 'contingencyPercent', M.contingencyPercent);
  put(markups, 'bidRoundingUnit', M.bidRoundingUnit);
  if (nonEmpty(markups)) body.markups = markups;
  if (M.glBasis === 'none') body.insurance = { generalLiability: { basis: 'none' } };
  else if (M.glBasis === 'receipts') body.insurance = { generalLiability: put({ basis: 'receipts' }, 'per1000', M.glValue) };
  else if (M.glBasis === 'payroll') body.insurance = { generalLiability: put({ basis: 'payroll' }, 'percentOfWages', M.glValue) };

  const B = d.bond;
  const bond = {};
  put(bond, 'required', B.required);
  if (t(B.ratePer1000)) bond.tiers = [{ upTo: null, ratePer1000: t(B.ratePer1000) }];
  put(bond, 'surcharge', B.surcharge);
  if (B.officerChoice) bond.officerChoiceMeansBond = B.officerChoice === 'yes';
  if (nonEmpty(bond)) body.bond = bond;

  const P = d.payment;
  const payment = {};
  days(payment, 'billingCycleDays', P.billingCycleDays);
  days(payment, 'ownerPayDays', P.ownerPayDays);
  if (t(P.retainagePercent)) payment.retainage = { percent: t(P.retainagePercent) };
  days(payment, 'retainageReleaseDays', P.retainageReleaseDays);
  days(payment, 'supplierNetDays', P.supplierNetDays);
  if (nonEmpty(payment)) body.payment = payment;

  const C = d.cash;
  if (C.financing === 'exclude') body.financing = { include: false };
  else if (C.financing === 'include' || t(C.rate)) body.financing = put({ include: true }, 'annualRatePercent', C.rate);

  const Lm = d.limits;
  const limits = {};
  put(limits, 'cashForJob', C.cashForJob);
  put(limits, 'unusedCreditLine', C.unusedCreditLine);
  put(limits, 'bufferPercent', C.bufferPercent);
  put(limits, 'maxJobSize', Lm.maxJobSize);
  put(limits, 'maxUpFrontCash', Lm.maxUpFrontCash);
  if (t(Lm.single) || t(Lm.aggregate) || t(Lm.backlog)) {
    limits.suretyLetter = put(put(put({}, 'singleLimit', Lm.single), 'aggregateLimit', Lm.aggregate), 'backlogRemaining', Lm.backlog);
  }
  if (nonEmpty(limits)) body.limits = limits;
  const stress = put(put({}, 'laborIncreasePercent', Lm.laborUp), 'unpaidChangeOrder', Lm.changeOrder);
  if (nonEmpty(stress)) body.stress = stress;
  return body;
}

// ------------------------------------------------------- needed / errors --

const HOLDS = { price: 'Holds up the price', cash: 'Holds up the cash check', limits: 'Holds up the limits check', range: 'Holds up the bid range' };
export const holds = (f) => HOLDS[f] ?? 'Needed';

/** Which section owns an API path ('quick' and 'job' are always open). */
export function sectionFor(path, d) {
  const off = classOffset(d);
  if (/^job(\.|$)/.test(path)) return 'job';
  if (off && /^labor\.classes\[0\]\.(hours|wage)$/.test(path)) return 'quick';
  if (/^materials\.total/.test(path) || /^subcontracts/.test(path)) return 'quick';
  if (/^markups\.(overhead|profitPercent)/.test(path)) return 'quick';
  if (/^labor/.test(path)) return 'labor';
  if (/^materials/.test(path)) return 'materials';
  if (/^(equipment|jobOverhead)/.test(path)) return 'equip';
  if (/^(insurance|markups)/.test(path)) return 'markups';
  if (/^bond/.test(path)) return 'bond';
  if (/^payment/.test(path)) return 'payment';
  if (/^financing/.test(path) || /^limits\.(cashForJob|unusedCreditLine|bufferPercent)/.test(path)) return 'cash';
  if (/^(limits|stress)/.test(path)) return 'limits';
  if (/^award/.test(path)) return 'range';
  return 'quick';
}

/** Spec references ("(A-11: no default)", "(D-7)", "(spec 2.3)") are for the sources list, not the question. */
const plain = (why) => String(why ?? '').replace(/\s*\((?:[AD]-\d+[^)]*|spec [^)]*)\)/g, '').replace(/^\w/, (c) => c.toUpperCase());

/** One "needed" entry as a plain question. */
export function question(n, d) {
  const f = n.field;
  const m = /^labor\.classes\[(\d+)\]\.(\w+)/.exec(f);
  if (m) {
    const i = Number(m[1]);
    const off = classOffset(d);
    const who = off && i === 0 ? 'your crew' : (t(d.labor.classes[i - off]?.label) || 'this labor class');
    const q = {
      wage: `What do you pay ${who} per hour?`,
      workersCompPer100: `What is your workers’ comp rate for ${who}, in dollars per $100 of payroll? It is on your policy.`,
      prevailing: `What basic and fringe rates does the wage determination set for ${who}?`,
      doubleTimeRate: `What is the double-time pay per hour for ${who} in the wage determination?`,
    }[m[2]];
    if (q) return q;
  }
  const fixed = {
    'job.ownerType': 'Who is paying for this job?',
    'job.startDate': 'When does the work start?',
    'job.endDate': 'When does the work finish?',
    'labor.flatBurdenPercent': 'What one burden percentage do you add on wages?',
    'labor.stateUiRatePercent': 'What unemployment tax rate is on your state notice?',
    'labor.futaCreditReductionPercent': 'What FUTA credit reduction applies this year?',
    'labor.mbt': 'Nevada Modified Business Tax: what are your firm’s quarterly gross wages, or are you exempt?',
    'labor.mbt.quarterlyGrossWages': 'What are your firm’s gross wages per quarter, for the Nevada business tax?',
    'labor.workersComp.experienceMod': 'What is your workers’ comp experience mod? Use 1.00 if you have none.',
    'labor.workersComp.policyEffectiveDate': 'When did your workers’ comp policy start?',
    'insurance.generalLiability': 'How is your general liability insurance rated: on sales, on payroll, or already in your overhead?',
    'materials.salesTaxPercent': 'What is the sales tax rate where the job is?',
    'materials.forwardRatePercent': 'How fast do you expect material prices to rise, percent per year?',
    'markups.overhead': 'What overhead percentage do you add?',
    'markups.profitPercent': 'What profit percentage do you add?',
    'bond.required': 'Does this job require a performance or payment bond?',
    'bond.officerChoiceMeansBond': 'Will the contracting officer require a payment bond on this job?',
    'bond.surcharge': 'The job runs over 12 months: which duration table does your surety use?',
    'payment.billingCycleDays': 'How many days between your pay applications?',
    'payment.ownerPayDays': 'How many days after you bill does the owner pay?',
    'payment.retainage': 'What percentage does the owner hold back as retainage?',
    'payment.retainageReleaseDays': 'How many days after the job ends is the retainage paid?',
    payment: 'Financing is priced from the cash timeline: fill in the payment terms.',
    'financing.annualRatePercent': 'What interest rate do you pay on money borrowed to carry the job? Or leave financing out of the price.',
    'limits.cashForJob': 'How much of your own cash can go into this job?',
    'limits.unusedCreditLine': 'How much unused credit line do you have? Use 0 if none.',
  }[f];
  if (fixed) return fixed;
  if (f === 'job.state') return /NV and CA only/.test(n.why) ? 'Payroll tables cover Nevada and California only. Is the work in NV or CA?' : 'Which state is the work in?';
  if (f === 'job.prevailingWage') {
    const hint = /\(([^)]*NRS 338[^)]*)\)/.exec(n.why)?.[1];
    return `Does the bid require prevailing wage?${hint ? ` ${plain(hint.replace(/, D-\d+/, ''))}.` : ''}`;
  }
  return `${plain(n.why)}.`.replace(/\.\.$/, '.');
}

// ------------------------------------------------------------ inputs --

/** A text box with a unit on the right ("%", "days", "per $100"). */
function unitInput({ value, unit, placeholder, oninput, label, mode = 'decimal' }) {
  const input = h('input', { class: 'input', type: 'text', inputmode: mode, autocomplete: 'off', value, placeholder: placeholder ?? '', 'aria-label': label, id: nextId('u') });
  input.addEventListener('input', () => oninput(input.value));
  if (!unit) return input;
  return h('div', { class: 'affix' }, input, h('span', { class: 'affix-unit', 'aria-hidden': 'true' }, unit));
}

function select({ value, options, placeholder, onchange, label }) {
  const s = h('select', { class: 'input select', 'aria-label': label, id: nextId('s') },
    placeholder != null ? h('option', { value: '', selected: value === '' }, placeholder) : null,
    options.map((o) => h('option', { value: o.id, selected: value === o.id }, o.label)));
  s.addEventListener('change', () => onchange(s.value));
  return s;
}

function dateInput({ value, oninput, label }) {
  const i = h('input', { class: 'input', type: 'date', value, 'aria-label': label, id: nextId('d') });
  i.addEventListener('input', () => oninput(i.value));
  return i;
}

/** "saved" = filled from your saved settings; "from the bid" = from the notice. Always yours to change. */
const tagFrom = (text) => h('span', { class: 'from-tag', title: text === 'saved' ? 'Filled in from your saved settings' : `Filled in ${text}` }, text);

/** A field bound to draft[obj][key]. kind: money | pct | days | hours | rate | text. */
function bound(d, obj, key, { path, label, help, kind = 'money', unit, placeholder, from, rerender }) {
  const target = obj;
  const set = (v) => { target[key] = v; };
  let control;
  if (kind === 'money') control = moneyInput({ text: target[key], placeholder, label, oninput: set });
  else if (kind === 'text') control = textInput({ value: target[key], placeholder: placeholder ?? '', 'aria-label': label });
  else control = unitInput({ value: target[key], unit: unit ?? { pct: '%', days: 'days', hours: 'h', rate: 'per $100' }[kind], placeholder, label, oninput: set, mode: kind === 'days' ? 'numeric' : 'decimal' });
  if (kind === 'text') control.addEventListener('input', () => set(control.value));
  if (rerender) control.addEventListener('change', rerender);
  const f = field({ key: path, label, help, control });
  if (from) f.querySelector('.field-label').append(tagFrom(from));
  return f;
}

// --------------------------------------------------------- the cards --

/** The job: who owns it, where, prevailing wage, dates. The engine cannot price without these. */
export function jobCard(d, { bid, hints, rerender }) {
  const J = d.job;
  const owner = field({
    key: 'job.ownerType', label: 'Who is paying for it',
    control: select({ value: J.ownerType, options: OWNER_TYPES, placeholder: 'Choose the owner', label: 'Who is paying for it', onchange: (v) => { J.ownerType = v; rerender(); } }),
    help: 'Sets the bond, retainage and payment rules the law gives this owner.',
  });
  if (d.prefilled.has('job.ownerType') && bid) owner.querySelector('.field-label').append(tagFrom(`from ${bid.sourceName ?? 'the bid'}`));

  const flag = bid?.flags?.find((f) => /prevailing/i.test(f));
  const pw = field({
    key: 'job.prevailingWage', label: 'Prevailing wage',
    control: select({ value: J.prevailingWage, options: PREVAILING, placeholder: flag ? `As the bid notice says (“${flag}”)` : 'Not sure yet', label: 'Prevailing wage', onchange: (v) => { J.prevailingWage = v; rerender(); } }),
  });
  if (hints?.prevailing) pw.append(hints.prevailing);

  return h('div', { class: 'stack' },
    owner,
    NEEDS_STATE.has(J.ownerType)
      ? bound(d, J, 'state', { path: 'job.state', label: 'State of the work', kind: 'text', placeholder: 'NV', help: 'Two letters. Payroll tables are shipped for Nevada and California.', from: d.prefilled.has('job.state') ? 'from the bid' : null })
      : null,
    pw,
    h('div', { class: 'pair' },
      field({ key: 'job.startDate', label: 'Work starts', control: dateInput({ value: J.startDate, label: 'Work starts', oninput: (v) => { J.startDate = v; } }) }),
      field({ key: 'job.endDate', label: 'Work ends', control: dateInput({ value: J.endDate, label: 'Work ends', oninput: (v) => { J.endDate = v; } }) }),
    ),
    (() => {
      const f = bound(d, J, 'estimatedCost', { path: 'job.estimatedCost', label: 'Owner’s estimate', placeholder: 'If the notice gives one', help: bid ? 'Leave blank to use the notice’s value when it gives one number.' : 'The owner’s estimate, if there is one. Used for thresholds.' });
      f.querySelector('.field-label').append(h('span', { class: 'optional' }, 'optional'));
      if (hints?.awards) f.append(hints.awards);
      return f;
    })(),
  );
}

/** The six numbers that give a price with one tap. */
export function quickCard(d, { hints, rerender }) {
  const Q = d.quick;
  const off = classOffset(d);
  const lines = d.materials.lines.length;
  const mats = lines
    ? h('div', { class: 'field', 'data-field': 'materials.total.amount' },
      h('p', { class: 'field-label' }, 'Materials from quotes'),
      h('p', { class: 'lines-note' }, `Priced from ${lines} material line${lines === 1 ? '' : 's'} below`),
      h('p', { class: 'field-error', role: 'alert' }))
    : bound(d, Q, 'materials', { path: 'materials.total.amount', label: 'Materials from quotes', placeholder: '0', help: 'Your suppliers’ total, before tax.' });
  // Hours and wage make the main crew (labor class 0): when that flips, redraw so the Labor section shows
  // the crew's comp, overtime and fringe fields. 'change' fires on blur, so typing is never interrupted.
  const flip = rerender ? () => { if (classOffset(d) !== off) rerender(); } : undefined;
  const wage = bound(d, Q, 'wage', { path: off ? 'labor.classes[0].wage' : 'quick.wage', label: 'Hourly wage', placeholder: '0.00', help: 'Cash wage per hour, before burden.', from: d.prefilled.has('quick.wage') ? 'saved' : null, rerender: flip });
  if (hints?.wage) wage.append(hints.wage);
  return h('div', { class: 'stack' },
    h('div', { class: 'pair' },
      bound(d, Q, 'hours', { path: off ? 'labor.classes[0].hours' : 'quick.hours', label: 'Labor hours', kind: 'hours', placeholder: '0', help: 'Crew hours on the job.', rerender: flip }),
      wage,
    ),
    h('div', { class: 'pair' },
      mats,
      bound(d, Q, 'subs', { path: 'subcontracts[0].amount', label: 'Subcontracts', placeholder: '0', help: 'Quotes from your subs.' }),
    ),
    h('div', { class: 'pair' },
      bound(d, Q, 'overheadPct', { path: 'markups.overhead', label: 'Overhead', kind: 'pct', placeholder: '0', help: 'On job cost.', from: d.prefilled.has('quick.overheadPct') ? 'saved' : null }),
      bound(d, Q, 'profitPct', { path: 'markups.profitPercent', label: 'Profit', kind: 'pct', placeholder: '0', help: 'On cost + overhead.', from: d.prefilled.has('quick.profitPct') ? 'saved' : null }),
    ),
  );
}

/** Rows of { label, … } with an Add and a Remove, each cell a field with its own API path. */
function rowsEditor(rows, { pathOf, cells, addLabel, empty, rerender }) {
  return h('div', { class: 'rows' },
    rows.map((row, i) => h('div', { class: 'row-edit' },
      h('div', { class: 'row-cells' }, cells.map((c) => {
        const f = c.kind === 'text'
          ? bound(null, row, c.key, { path: pathOf(i, c.key), label: c.label, kind: 'text', placeholder: c.placeholder })
          : bound(null, row, c.key, { path: pathOf(i, c.key), label: c.label, kind: c.kind, placeholder: c.placeholder, unit: c.unit });
        f.classList.add('cell', `cell-${c.key}`);
        return f;
      })),
      h('button', { class: 'row-remove', type: 'button', 'aria-label': `Remove ${row.label || 'this line'}`, onclick: () => { rows.splice(i, 1); rerender(); } }, icon(ICONS.x)),
    )),
    rows.length ? null : h('p', { class: 'field-help' }, empty),
    h('button', { class: 'chip add', type: 'button', onclick: () => { rows.push(Object.fromEntries(cells.map((c) => [c.key, '']))); rerender(); } }, `+ ${addLabel}`),
  );
}

const sub = (title, note) => h('div', { class: 'subhead' }, h('h3', {}, title), note ? h('span', { class: 'optional' }, note) : null);

/** The body of one optional section. */
export function sectionBody(id, d, { bid, rerender, profile, result }) {
  const L = d.labor;
  const off = classOffset(d);
  switch (id) {
    case 'labor': {
      const pwOn = prevailingOn(d, bid, result);
      return h('div', { class: 'stack' },
        off ? h('div', { class: 'stack' },
          h('div', { class: 'subhead first' }, h('h3', {}, 'Your crew')),
          h('div', { class: 'pair' },
            bound(d, L, 'wc', { path: 'labor.classes[0].workersCompPer100', label: 'Workers’ comp', kind: 'rate', placeholder: '0.00', help: 'Dollars per $100 of payroll, from your policy.' }),
            bound(d, L, 'overtimeHours', { path: 'labor.classes[0].overtimeHours', label: 'Overtime hours', kind: 'hours', placeholder: '0', help: 'Paid at 1.5×.' }),
          ),
          bound(d, L, 'planFringe', { path: 'labor.classes[0].planFringe', label: 'Fringe to plans, per hour', placeholder: '0.00', help: 'Health, pension or training plan contributions.' }),
          pwOn ? h('div', { class: 'pair', 'data-field': 'labor.classes[0].prevailing' },
            bound(d, L, 'prevBasic', { path: 'labor.classes[0].prevailing.basic', label: 'Determination basic', placeholder: '0.00' }),
            bound(d, L, 'prevFringe', { path: 'labor.classes[0].prevailing.fringe', label: 'Determination fringe', placeholder: '0.00' }),
          ) : null,
          pwOn ? h('p', { class: 'field-help tight' }, 'From the wage determination in the bid documents. The engine checks your pay meets it.') : null,
        ) : h('p', { class: 'field-help' }, 'Type labor hours and a wage in the quick card for your main crew, or add labor classes below.'),
        sub('Your company', 'from your policy'),
        h('div', { class: 'pair' },
          bound(d, L, 'experienceMod', { path: 'labor.workersComp.experienceMod', label: 'Experience mod', kind: 'text', placeholder: 'e.g. 1.00', help: '1.00 if you have none.' }),
          field({ key: 'labor.workersComp.policyEffectiveDate', label: 'Comp policy start', control: dateInput({ value: L.policyEffectiveDate, label: 'Comp policy start', oninput: (v) => { L.policyEffectiveDate = v; } }) }),
        ),
        field({
          key: 'labor.burdenMode', label: 'Payroll taxes',
          control: select({ value: L.burdenMode, options: [{ id: 'statutory', label: 'From the dated tax tables' }, { id: 'flat', label: 'One flat burden percentage' }], label: 'Payroll taxes', onchange: (v) => { L.burdenMode = v; rerender(); } }),
          help: L.burdenMode === 'flat' ? 'One percentage on wages is an approximation. The tables add Social Security, Medicare and unemployment by the rules.' : 'Social Security, Medicare, unemployment and state tax by the rules for the year.',
        }),
        L.burdenMode === 'flat' ? bound(d, L, 'flatBurdenPercent', { path: 'labor.flatBurdenPercent', label: 'Burden', kind: 'pct', placeholder: '0', from: d.prefilled.has('labor.flatBurdenPercent') ? 'your settings' : null }) : null,
        L.burdenMode === 'statutory' ? h('div', { class: 'pair' },
          bound(d, L, 'uiRate', { path: 'labor.stateUiRatePercent', label: 'Unemployment rate', kind: 'pct', placeholder: '', help: 'From your notice. Blank: the new-employer rate, labelled.' }),
          bound(d, L, 'futa', { path: 'labor.futaCreditReductionPercent', label: 'FUTA reduction', kind: 'pct', placeholder: '0', help: 'Only if your state has one.' }),
        ) : null,
        L.burdenMode === 'statutory' ? field({
          key: 'labor.mbt', label: 'Nevada business tax (MBT)',
          control: select({ value: L.mbtMode, options: [{ id: 'marginal', label: 'I pay it (marginal rate)' }, { id: 'average', label: 'I pay it (average rate)' }, { id: 'none', label: 'Exempt or not in Nevada' }], placeholder: 'Choose', label: 'Nevada business tax', onchange: (v) => { L.mbtMode = v; rerender(); } }),
        }) : null,
        L.burdenMode === 'statutory' && L.mbtMode && L.mbtMode !== 'none' ? bound(d, L, 'mbtWages', { path: 'labor.mbt.quarterlyGrossWages', label: 'Your gross wages per quarter', placeholder: '0', help: 'Whole company, one quarter.' }) : null,
        sub('More labor classes', 'apprentices, foremen'),
        rowsEditor(L.classes, {
          pathOf: (i, k) => `labor.classes[${i + off}].${{ wc: 'workersCompPer100', prevBasic: 'prevailing.basic', prevFringe: 'prevailing.fringe' }[k] ?? k}`,
          cells: [
            { key: 'label', label: 'Name', kind: 'text', placeholder: 'Apprentice' },
            { key: 'hours', label: 'Hours', kind: 'hours', placeholder: '0' },
            { key: 'wage', label: 'Wage', kind: 'money', placeholder: '0.00' },
            { key: 'wc', label: 'Comp', kind: 'rate', unit: '/$100', placeholder: '0.00' },
            ...(pwOn ? [
              { key: 'prevBasic', label: 'Determ. basic', kind: 'money', placeholder: '0.00' },
              { key: 'prevFringe', label: 'Determ. fringe', kind: 'money', placeholder: '0.00' },
            ] : []),
          ],
          addLabel: 'Add a labor class', empty: 'None added.', rerender,
        }),
      );
    }
    case 'materials':
      return h('div', { class: 'stack' },
        rowsEditor(d.materials.lines, {
          pathOf: (i, k) => `materials.lines[${i}].${k}`,
          cells: [
            { key: 'label', label: 'Item', kind: 'text', placeholder: '12 AWG THHN' },
            { key: 'quantity', label: 'Qty', kind: 'hours', unit: '', placeholder: '0' },
            { key: 'unitPrice', label: 'Unit price', kind: 'money', placeholder: '0.00' },
            { key: 'wastePercent', label: 'Waste', kind: 'pct', placeholder: '0' },
          ],
          addLabel: 'Add a material line', empty: 'No lines: the quick card’s material total is used.', rerender,
        }),
        h('div', { class: 'pair' },
          bound(d, d.materials, 'salesTaxPercent', { path: 'materials.salesTaxPercent', label: 'Sales tax', kind: 'pct', placeholder: '0', help: 'Combined rate where the job is.' }),
          bound(d, d.materials, 'freight', { path: 'materials.freight', label: 'Freight', placeholder: '0' }),
        ),
      );
    case 'equip':
      return h('div', { class: 'stack' },
        h('div', { class: 'subhead first' }, h('h3', {}, 'Equipment')),
        rowsEditor(d.equipment, {
          pathOf: (i, k) => `equipment[${i}].${k}`,
          cells: [{ key: 'label', label: 'Item', kind: 'text', placeholder: 'Lift rental' }, { key: 'amount', label: 'Cost', kind: 'money', placeholder: '0' }],
          addLabel: 'Add equipment', empty: 'None added.', rerender,
        }),
        sub('Job costs'),
        rowsEditor(d.jobOverhead, {
          pathOf: (i, k) => `jobOverhead[${i}].${k}`,
          cells: [{ key: 'label', label: 'Item', kind: 'text', placeholder: 'Permit' }, { key: 'amount', label: 'Cost', kind: 'money', placeholder: '0' }],
          addLabel: 'Add a job cost', empty: 'Permits, supervision, mobilization, cleanup.', rerender,
        }),
      );
    case 'markups': {
      const M = d.markups;
      return h('div', { class: 'stack' },
        field({
          key: 'insurance.generalLiability', label: 'General liability insurance',
          control: select({ value: M.glBasis, options: GL_BASIS, placeholder: 'How is it rated?', label: 'General liability insurance', onchange: (v) => { M.glBasis = v; rerender(); } }),
          help: 'From your policy.',
        }),
        M.glBasis === 'receipts' ? bound(d, M, 'glValue', { path: 'insurance.generalLiability.per1000', label: 'Rate per $1,000 of sales', kind: 'rate', unit: 'per $1,000', placeholder: '0.00' }) : null,
        M.glBasis === 'payroll' ? bound(d, M, 'glValue', { path: 'insurance.generalLiability.percentOfWages', label: 'Percent of wages', kind: 'pct', placeholder: '0' }) : null,
        h('div', { class: 'pair' },
          bound(d, M, 'smallToolsPercent', { path: 'markups.smallToolsPercent', label: 'Small tools', kind: 'pct', placeholder: '2', help: 'Of burdened labor. Blank uses 2%.' }),
          bound(d, M, 'contingencyPercent', { path: 'markups.contingencyPercent', label: 'Contingency', kind: 'pct', placeholder: '0' }),
        ),
        bound(d, M, 'bidRoundingUnit', { path: 'markups.bidRoundingUnit', label: 'Round the bid up to', placeholder: 'e.g. 100', help: 'Optional. The rounding goes to profit.' }),
      );
    }
    case 'bond': {
      const B = d.bond;
      const cap = profile?.limits?.bondingCapacity;
      return h('div', { class: 'stack' },
        field({
          key: 'bond.required', label: 'Is a bond required?',
          control: select({ value: B.required, options: [{ id: 'auto', label: 'As the law sets for this owner' }, { id: 'yes', label: 'Yes, the bid documents require one' }, { id: 'no', label: 'No bond' }], placeholder: bid?.flags?.some((f) => /bond/i.test(f)) ? 'As the bid notice says' : 'Not sure yet', label: 'Is a bond required?', onchange: (v) => { B.required = v; rerender(); } }),
          help: 'The bid documents decide. Without your answer the engine uses the statute for the owner.',
        }),
        B.required !== 'no' ? bound(d, B, 'ratePer1000', { path: 'bond.tiers', label: 'Your surety’s rate', kind: 'rate', unit: 'per $1,000', placeholder: 'Sample schedule', help: 'Blank uses an illustrative sample schedule, labelled in the sources.' }) : null,
        B.required !== 'no' ? field({
          key: 'bond.surcharge', label: 'Jobs over 12 months',
          control: select({ value: B.surcharge, options: [{ id: 'non_deviating', label: 'Standard (non-deviating)' }, { id: 'deviating', label: 'Deviating' }, { id: 'table_24', label: '24-month table' }], placeholder: 'Ask only if the job is long', label: 'Duration table', onchange: (v) => { B.surcharge = v; } }),
        }) : null,
        d.job.ownerType === 'federal' || d.job.ownerType === 'federal_aided_local' ? field({
          key: 'bond.officerChoiceMeansBond', label: 'Federal job $35,000–$150,000',
          control: select({ value: B.officerChoice, options: [{ id: 'yes', label: 'Officer requires a payment bond' }, { id: 'no', label: 'Officer accepts other protection' }], placeholder: 'Only asked in that band', label: 'Contracting officer choice', onchange: (v) => { B.officerChoice = v; } }),
        }) : null,
        cap != null ? h('p', { class: 'field-help' }, `Your settings: bonding capacity $${Number(cap).toLocaleString('en-US')}. The check uses your surety letter under Limits.`) : null,
      );
    }
    case 'payment': {
      const P = d.payment;
      return h('div', { class: 'stack' },
        h('div', { class: 'pair' },
          bound(d, P, 'billingCycleDays', { path: 'payment.billingCycleDays', label: 'Bill every', kind: 'days', placeholder: '30' }),
          bound(d, P, 'ownerPayDays', { path: 'payment.ownerPayDays', label: 'Owner pays in', kind: 'days', placeholder: '30' }),
        ),
        h('div', { class: 'pair' },
          bound(d, P, 'retainagePercent', { path: 'payment.retainage', label: 'Retainage', kind: 'pct', placeholder: 'By law', help: 'Blank: the rule for this owner.' }),
          bound(d, P, 'retainageReleaseDays', { path: 'payment.retainageReleaseDays', label: 'Retainage paid', kind: 'days', unit: 'days after', placeholder: '60' }),
        ),
        bound(d, P, 'supplierNetDays', { path: 'payment.supplierNetDays', label: 'Suppliers want payment in', kind: 'days', placeholder: '30', help: 'Blank: net 30, labelled as an assumption.' }),
        h('p', { class: 'field-help' }, 'Placeholders are examples, not values: an empty box is never sent.'),
      );
    }
    case 'cash': {
      const C = d.cash;
      return h('div', { class: 'stack' },
        h('div', { class: 'pair' },
          bound(d, C, 'cashForJob', { path: 'limits.cashForJob', label: 'Your cash for this job', placeholder: '0' }),
          bound(d, C, 'unusedCreditLine', { path: 'limits.unusedCreditLine', label: 'Unused credit line', placeholder: '0', help: '0 if none.' }),
        ),
        bound(d, C, 'bufferPercent', { path: 'limits.bufferPercent', label: 'Safety buffer', kind: 'pct', placeholder: '0', help: 'Keep this share of your cash untouched.' }),
        field({
          key: 'financing.include', label: 'Financing cost in the price',
          control: select({ value: C.financing, options: [{ id: 'include', label: 'Yes, add the interest on carried cash' }, { id: 'exclude', label: 'No, leave it out' }], placeholder: 'Choose', label: 'Financing cost in the price', onchange: (v) => { C.financing = v; rerender(); } }),
        }),
        C.financing !== 'exclude' ? bound(d, C, 'rate', { path: 'financing.annualRatePercent', label: 'Interest rate', kind: 'pct', unit: '% a year', placeholder: '0' }) : null,
      );
    }
    case 'limits': {
      const Lm = d.limits;
      return h('div', { class: 'stack' },
        h('div', { class: 'pair' },
          bound(d, Lm, 'maxJobSize', { path: 'limits.maxJobSize', label: 'Largest job', placeholder: 'No limit', from: d.prefilled.has('limits.maxJobSize') ? 'saved' : null }),
          bound(d, Lm, 'maxUpFrontCash', { path: 'limits.maxUpFrontCash', label: 'Most up-front cash', placeholder: 'No limit', from: d.prefilled.has('limits.maxUpFrontCash') ? 'saved' : null }),
        ),
        sub('Surety letter', 'all three, or none'),
        h('div', { class: 'stack', 'data-field': 'limits.suretyLetter' },
          h('div', { class: 'pair' },
            bound(d, Lm, 'single', { path: 'limits.suretyLetter.singleLimit', label: 'Single job', placeholder: '0' }),
            bound(d, Lm, 'aggregate', { path: 'limits.suretyLetter.aggregateLimit', label: 'Aggregate', placeholder: '0' }),
          ),
          bound(d, Lm, 'backlog', { path: 'limits.suretyLetter.backlogRemaining', label: 'Bonded work still open', placeholder: '0' }),
          h('p', { class: 'field-error', role: 'alert' }),
        ),
        sub('Stress tests'),
        h('div', { class: 'pair' },
          bound(d, Lm, 'laborUp', { path: 'stress.laborIncreasePercent', label: 'Labor runs over by', kind: 'pct', placeholder: '0' }),
          bound(d, Lm, 'changeOrder', { path: 'stress.unpaidChangeOrder', label: 'Unpaid change order', placeholder: '0' }),
        ),
      );
    }
    default:
      return h('div', {});
  }
}
