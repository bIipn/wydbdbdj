// Drawing one EstimateResult (src/cost/estimate.ts). Amounts are integer cents from the API and only ever
// formatted (money.js); the one derived line, burden = burdened labor − cash wages, is an exact BigInt
// subtraction. Engine wording is kept, minus its spec references, which move to the sources list.

import { h, safeUrl } from './dom.js';
import { fmtDay, clock } from './format.js';
import { centsInText, hoursC, minus, pct, plus, unitValue, usd } from './money.js';
import { holds, question, sectionFor } from './cost-form.js';

const noRefs = (s) => centsInText(String(s ?? '')).replace(/\s*\(see needed\)|: see needed/g, ': answer the questions above').replace(/\s*\((?:[AD]-\d+[^)]*|spec [^)]*)\)/g, '').replace(/\s*\(spec [^)]*\)/g, '').replace(/,\s*(?:[AD]-\d+|spec [\d.]+)(?=\))/g, '');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const SECTION_TITLE = {
  job: 'The job', quick: 'Quick price', labor: 'Labor and payroll', materials: 'Material lines', equip: 'Equipment and job costs',
  markups: 'Insurance and markups', bond: 'Bond', payment: 'Payment terms', cash: 'Cash and credit', limits: 'Limits and stress tests', range: 'Bid range',
};

/** A card in the result column. */
const card = (title, tag, ...body) => h('section', { class: 'cc-card' },
  h('div', { class: 'cc-card-head' }, h('h3', {}, title), tag ? h('span', { class: 'pc-tag' }, tag) : null),
  ...body);

/** One aligned money row. `kind`: '' | 'sub' (subtotal) | 'total' | 'minor'. */
function moneyRow(label, cents, { kind = '', note } = {}) {
  return h('div', { class: `cc-row${kind ? ` ${kind}` : ''}` },
    h('span', { class: 'cc-row-label' }, label, note ? h('small', {}, note) : null),
    h('span', { class: 'cc-amt' }, usd(cents)));
}

/** The questions the engine still has, grouped by what they hold up; each one jumps to its section. */
export function neededList(result, draft, jump) {
  const needed = result.needed ?? [];
  if (!needed.length) return null;
  const blocked = needed.some((n) => n.for === 'price');
  return h('section', { class: 'cc-needed', 'aria-live': 'polite' },
    h('h3', {}, blocked ? `${needed.length} answer${needed.length === 1 ? '' : 's'} before there is a price` : `${needed.length} more answer${needed.length === 1 ? '' : 's'} for the full check`),
    h('p', { class: 'cc-needed-sub' }, 'The cost check never guesses a number you have not given it.'),
    h('ul', {}, needed.map((n) => {
      const sec = sectionFor(n.field, draft);
      return h('li', {},
        h('button', { class: 'cc-need-btn', type: 'button', onclick: () => jump(sec, n.field) },
          h('span', { class: 'cc-need-q' }, question(n, draft)),
          h('span', { class: 'cc-need-meta' }, h('span', { class: `cc-holds for-${n.for}` }, holds(n.for)), ` · ${SECTION_TITLE[sec] ?? 'Form'} →`)));
    })),
  );
}

function buildUp(r) {
  const T = r.totals;
  if (!T) return null;
  const rows = [];
  const add = (label, cents, opts) => { if (cents) rows.push(moneyRow(label, cents, opts)); };
  const hours = T.H ? hoursC(T.H) : null;
  add('Labor, cash wages', T.G, { note: hours });
  add('Burden', minus(T.L, T.G), { note: 'payroll taxes, comp, fringe' });
  add('Small tools', T.ST);
  add('Materials', T.MAT, { note: 'with sales tax' });
  add('Equipment', T.E);
  add('Subcontracts', T.SUB);
  add('Job overhead', T.JOOH);
  add('Labor escalation', T.ESC_L);
  add('Contingency', T.CONT);
  rows.push(moneyRow('Total job cost', T.TJC, { kind: 'sub' }));
  add('Overhead', T.OH);
  add('Profit', T.PR);
  add('Financing', T.FIN, { note: 'interest on carried cash' });
  // Name both parts: the bond premium and the rest (insurance and other charges figured on the price).
  if (T.premium && T.otherCharges) {
    add('Bond and other price-based charges', T.q, { note: `bond premium ${usd(T.premium)} · insurance and other charges ${usd(T.otherCharges)}` });
  } else if (T.premium) add('Bond premium', T.q);
  else add('Insurance and other charges on the price', T.q);
  const rounding = plus(T.roundingToProfit, T.roundingToCharges);
  add('Rounding up', rounding, { note: 'to your rounding unit' });
  rows.push(moneyRow('Bid price', T.Pbid, { kind: 'total' }));
  return card('How the price builds up', null, h('div', { class: 'cc-rows' }, rows));
}

function cashCard(r) {
  const c = r.cash;
  if (!c || c.status !== 'computed') {
    return card('Cash you carry', null, h('p', { class: 'cc-reason' }, cap(noRefs(c?.reason ?? 'Not worked out yet.'))));
  }
  const f = r.financing;
  return card('Cash you carry', null,
    h('div', { class: 'cc-stats' },
      h('div', {}, h('span', { class: 'pc-label' }, 'Peak cash out'), h('strong', {}, usd(c.peakFloat)), h('small', {}, `day ${c.peakDay} of the job`)),
      h('div', {}, h('span', { class: 'pc-label' }, 'First payment'), h('strong', {}, c.daysToFirstCashIn == null ? 'None' : `Day ${c.daysToFirstCashIn}`), h('small', {}, c.daysToFirstCashIn == null ? 'no money comes in' : 'after work starts')),
    ),
    h('div', { class: 'cc-rows' },
      moneyRow('Paid out before the first payment', c.upFront),
      c.preStart ? moneyRow('Paid before work starts', c.preStart, { kind: 'minor' }) : null,
      h('div', { class: 'cc-row' }, h('span', { class: 'cc-row-label' }, 'Days your cash is out'), h('span', { class: 'cc-amt' }, String(c.daysCashNegative))),
      f.included
        ? moneyRow('Financing cost', f.FIN, { note: f.annualRatePpm != null ? `at ${pct(f.annualRatePpm)} a year` : null })
        : h('div', { class: 'cc-row' }, h('span', { class: 'cc-row-label' }, 'Financing cost'), h('span', { class: 'cc-amt muted' }, 'Not in the price')),
    ),
    h('p', { class: 'pc-fine' }, `Bills every ${c.grid.billingCycleDays} days, owner pays in ${c.grid.ownerPayDays}, ${c.grid.retainage === 'contract' ? 'retainage as you entered it' : 'retainage by the rule for this owner'}, released ${c.grid.retainageReleaseDays} days after the end.`),
  );
}

const CHECK_NAME = {
  job_size: 'Job size', up_front_cash: 'Up-front cash', peak_float: 'Cash to carry the job', bonding: 'Bonding',
  liquidity_working_capital: 'Working capital', liquidity_current_ratio: 'Current ratio',
};
function verdictChip(v, outcome) {
  const text = v === 'ok' ? 'Fits' : v === 'warn' ? 'Tight' : v === 'stop' ? (/^over/.test(outcome) ? 'Over' : 'Short') : v === 'info' ? 'Note' : 'Not set';
  return h('span', { class: `cc-verdict v-${v}` }, text);
}
function checkDetail(c) {
  const n = c.numbers ?? {};
  switch (c.id) {
    case 'job_size': return n.maxJobSize == null ? 'No largest-job limit set' : `Price ${usd(n.price)} · your limit ${usd(n.maxJobSize)}`;
    case 'up_front_cash': return n.maxUpFrontCash == null ? `${usd(n.upFront)} up front · no limit set` : `${usd(n.upFront)} up front · your limit ${usd(n.maxUpFrontCash)}`;
    case 'peak_float': return `Need ${usd(n.need)} · you have ${usd(n.funds)}${c.verdict === 'stop' ? ` · ${centsInText(c.outcome)}` : ''}`;
    default: return cap(noRefs(c.outcome)) + (c.ruleOfThumb ? ' (rule of thumb)' : '');
  }
}

function limitsCard(r) {
  const L = r.limits;
  if (!L || L.status !== 'checked') return card('Can you carry it?', null, h('p', { class: 'cc-reason' }, cap(noRefs(L?.reason ?? 'Not checked yet.'))));
  return card('Can you carry it?', null,
    h('ul', { class: 'cc-checks' }, L.checks.map((c) => h('li', {},
      h('div', {}, h('strong', {}, CHECK_NAME[c.id] ?? c.id), h('small', {}, checkDetail(c))),
      verdictChip(c.verdict, c.outcome)))),
    L.stress?.length ? h('div', { class: 'cc-stress' },
      h('p', { class: 'pc-label' }, 'If things go worse'),
      h('ul', { class: 'cc-checks' }, L.stress.map((s) => h('li', {},
        h('div', {}, h('strong', {}, s.label), h('small', {}, `Peak cash out ${usd(s.peakFloat)}${s.verdict === 'stop' ? ` · ${centsInText(s.outcome)}` : ''}`)),
        verdictChip(s.verdict, s.outcome))))) : null,
  );
}

function rangeCard(r) {
  const b = r.bidRange;
  if (!b) return null;
  if (b.status === 'shown') {
    const point = (label, p) => h('div', { class: 'cc-row' },
      h('span', { class: 'cc-row-label' }, label, h('small', {}, `about ${Math.round(p.winProbability.p * 100)}% chance to win (${Math.round(p.winProbability.lo * 100)}–${Math.round(p.winProbability.hi * 100)}%)`)),
      h('span', { class: 'cc-amt' }, usd(p.price)));
    return card('Bid range', 'From your history',
      h('div', { class: 'cc-rows' }, point('Low', b.low), point('Recommended', b.recommended), point('High', b.high), moneyRow('Never below', b.floor, { kind: 'minor' })),
      h('p', { class: 'pc-fine' }, noRefs(b.note)));
  }
  return card('Bid range', null, h('p', { class: 'cc-reason' }, cap(noRefs(b.reason))));
}

function notesCard(r) {
  // The limits verdicts and the needed list already have their own cards.
  const skip = /^(Needed|Job size|Up-front cash|Cash to carry the job|Bonding|Rule of thumb|Stress —)/;
  const checks = (r.checks ?? []).filter((c) => !skip.test(c.text));
  const warnings = r.warnings ?? [];
  if (!checks.length && !warnings.length) return null;
  return card('Contract checks and warnings', null,
    h('ul', { class: 'cc-notes' },
      checks.map((c) => h('li', { class: `lvl-${c.level}` }, cap(noRefs(c.text)))),
      warnings.map((w) => h('li', { class: 'lvl-warn' }, cap(noRefs(w))))));
}

function sourcesCard(r) {
  const sources = r.sources ?? [];
  const assumptions = r.assumptions ?? [];
  const facts = r.bidFacts ?? [];
  return h('details', { class: 'cc-card cc-sources' },
    h('summary', {}, 'Where these numbers come from', h('span', { class: 'cc-count' }, `${sources.length} dated defaults · ${assumptions.length} assumptions`)),
    facts.length ? h('div', { class: 'cc-src-group' }, h('p', { class: 'pc-label' }, 'From the bid notice'),
      h('ul', { class: 'cc-src' }, facts.map((f) => h('li', {}, h('strong', {}, `${cap(f.fact)}: ${f.value}`), h('small', {}, `${f.used ? 'Used' : 'Not used'}: ${f.how}`))))) : null,
    sources.length ? h('div', { class: 'cc-src-group' }, h('p', { class: 'pc-label' }, 'Dated public figures used'),
      h('ul', { class: 'cc-src' }, sources.map((s) => h('li', {},
        h('div', { class: 'cc-src-top' }, h('strong', {}, `${s.id} · ${s.name}`), h('span', { class: 'cc-src-val' }, unitValue(s.value, s.unit))),
        h('small', {}, `${s.key} · ${s.jurisdiction} · ${s.effective}${s.from ? ` (${s.from}${s.to ? ` to ${s.to}` : ''})` : ''} · ${s.kind.replace(/_/g, ' ')}`),
        s.urls?.length ? h('small', {}, s.urls.map((u, i) => [i ? ' · ' : '', h('a', { class: 'src-link', href: safeUrl(u), target: '_blank', rel: 'noopener noreferrer' }, new URL(safeUrl(u), location.href).hostname || 'source')])) : null)))) : null,
    assumptions.length ? h('div', { class: 'cc-src-group' }, h('p', { class: 'pc-label' }, 'Assumptions (change them by giving your own number)'),
      h('ul', { class: 'cc-src' }, assumptions.map((a) => h('li', {},
        h('strong', {}, `${a.id} · ${a.text}`),
        h('small', {}, `Default: ${a.engineDefault}`),
        ...(a.usedAs ?? []).map((u) => h('small', {}, `Used: ${centsInText(u.text)}${u.value ? ` = ${centsInText(u.value)}` : ''}`)))))) : null,
  );
}

export const fmtSaved = (iso) => { const d = new Date(iso); return `${fmtDay.format(d)} · ${clock(d)}`; };

/** The whole result column. `saved` = { at } when it is a saved estimate being looked at. */
export function resultView(r, draft, { jump, savedAt }) {
  const priced = r.total != null;
  return h('div', { class: 'cc-result', id: 'ccResult' },
    h('section', { class: `cc-hero${priced ? '' : ' empty'}` },
      h('p', { class: 'eyebrow' }, priced ? 'Bid price' : 'No price yet'),
      priced ? h('strong', { class: 'cc-price' }, usd(r.total)) : h('p', { class: 'cc-hero-why' }, 'Answer the questions below and run the check again.'),
      priced && r.totals ? h('p', { class: 'cc-hero-sub' }, h('span', {}, `Job cost ${usd(r.totals.TJC)}`), ' · ', h('span', {}, `overhead ${usd(r.totals.OH)}`), ' · ', h('span', {}, `profit ${usd(r.totals.profitAsBid)}`)) : null,
      savedAt ? h('p', { class: 'cc-saved-at' }, `Saved ${fmtSaved(savedAt)}`) : null,
    ),
    neededList(r, draft, jump),
    priced ? buildUp(r) : null,
    priced ? cashCard(r) : null,
    priced ? limitsCard(r) : null,
    priced ? rangeCard(r) : null,
    notesCard(r),
    sourcesCard(r),
  );
}

