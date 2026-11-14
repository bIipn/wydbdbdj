// One local job (full screen): opened from the Jobs tab, a LOCAL JOB card in the feed, a job alert, or a
// /?job=<id> link. What it shows depends on who is looking, exactly as the API decides (src/jobs/view.ts):
// fields a viewer may not see arrive as null or [], and this screen simply has nothing to draw for them.
//
//   open, someone else's   description, place, countdown, bid count, the poster's card, the sealed-bid box
//   open, my own           the bid count only (amounts stay sealed), Cancel
//   after closing          the bid tab, the award with its contact countdown, the other side's card, the
//                          address and phone (winner), messages, and the buttons the state allows
//   ended                  how it ended, in words, and any fee "recorded, not collected"
//
// The page is kept between redraws (a live alert redraws the app) so a half-typed bid or message survives,
// and the focus goes back where it was.

import { api } from '../api.js';
import { PT } from '../format.js';
import { h, icon, ICONS, showToast } from '../dom.js';
import { clearErrors, formError, moneyInput, showErrors } from '../form.js';
import {
  answerWindowText, dayOnly, dollars, endedWords, FEES_OFF, feeCents, feeLines, feeWords, iWon, licenceLine, parseCents, ppmOf, stage, statsWords, timeLeft, whenLong,
} from '../job-words.js';
import { jobs, loadMine, openJob } from '../jobs-data.js';
import { chip } from '../profile-form.js';
import { onSignedOut } from '../session.js';
import { showInSheet } from '../sheet.js';
import { onAfterRender, registerView, render, setView } from '../shell.js';
import { state } from '../state.js';
import { fieldsObject, personCardView, YEAR_BANDS } from '../work-profile.js';
import { CLOSES_IN } from './job-post.js';

const fresh = () => ({
  id: null, job: null, messages: [], error: null, loading: false,
  el: null, focus: null, // the drawn page, kept while nothing changed
  bidText: '', note: '', agree: false, editing: false, busy: false,
  confirm: null, // 'cancel' | 'backout' | 'withdraw' | 'report' | 'repost'
  msg: '', reportText: '', repostDays: 7,
});
let ui = fresh();
onSignedOut(() => { ui = fresh(); });

const STATUS_PILL = { open: 'Open', awarded: 'Awarded', agreed: 'Agreed', completed: 'Done', unfilled: 'Ended', cancelled: 'Cancelled' };

// ------------------------------------------------------------ loading --

async function load(id = ui.id) {
  ui.loading = true;
  try {
    const res = await api.job(id);
    if (ui.id !== id) return;
    ui.job = res.job;
    ui.messages = res.messages;
    ui.error = null;
  } catch (err) {
    if (ui.id !== id) return;
    ui.error = err.status === 404 ? 'This job is gone. It may have been removed.' : err.message || 'Couldn’t load this job.';
  }
  ui.loading = false;
  redraw();
}

/** Draw the page again from ui (after a load or an action). */
function redraw() {
  ui.el = null;
  if (state.view === 'job') render();
}

/** A job answer from an action: show it, refresh the Jobs tab. */
function took(job, toast) {
  ui.job = job;
  ui.confirm = null;
  ui.busy = false;
  ui.actionError = null;
  loadMine();
  if (toast) showToast(toast);
  load(); // messages and the award may have moved on too
}

/** Run one action; a refusal shows its sentence in the page's error line. */
async function act(fn, toast) {
  if (ui.busy) return;
  ui.busy = true;
  redraw();
  try {
    const res = await fn();
    took(res.job ?? ui.job, toast);
  } catch (err) {
    ui.busy = false;
    ui.actionError = err.code === 'too_many_attempts' ? 'Too many tries. Wait a few minutes and try again.' : err.message || 'That didn’t work. Try again.';
    if (err.code === 'closed' || err.code === 'not_found') load();
    else redraw();
  }
}

// --------------------------------------------------------------- people --

const bandLabel = (years) => (years == null ? null : [...YEAR_BANDS].reverse().find((b) => years >= b.years)?.label ?? null);
const initials = (name) => (name ?? '').split(/\s+/).filter((p) => /^[\p{L}\p{N}]/u.test(p)).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
const fmtMonth = new Intl.DateTimeFormat('en-US', { timeZone: PT, month: 'short', year: 'numeric' });

/** The full card in the sheet. A lite card (name and record only) is fetched in full when the API allows it. */
async function openCard(card) {
  if ('headline' in card) return showInSheet([h('h2', { id: 'cardTitle', class: 'sr-only' }, card.name), personCardView(card)], 'cardTitle');
  try {
    const { card: full } = await api.person(card.id);
    showInSheet([h('h2', { id: 'cardTitle', class: 'sr-only' }, full.name), personCardView(full)], 'cardTitle');
  } catch {
    showToast('Their full card opens once bidding has closed.');
  }
}

/**
 * A person on a job, short: name, headline, years, licence (as typed, not verified), insured, the record in
 * words, their last jobs. `card` is a PersonCard (the poster sees bidders' and the winner's) or a lite one.
 */
function personMini(card, { role, canOpen = true, fallbackName = null } = {}) {
  // A shared default name ("My electrical shop") tells nobody who this is: say what they are to this job instead.
  const name = fallbackName && isDefaultShopName(card.name) ? fallbackName : card.name;
  const years = bandLabel(card.yearsExperience);
  const facts = [years ? `${years} years` : null, card.insured === 'yes' ? 'Insured' : card.insured === 'no' ? 'Not insured' : null].filter(Boolean);
  const body = h('div', { class: 'pmini-text' },
    role ? h('span', { class: 'pmini-role' }, role) : null,
    h('strong', { class: 'pmini-name' }, name),
    card.headline ? h('span', { class: 'pmini-line' }, card.headline) : null,
    facts.length ? h('span', { class: 'pmini-line' }, facts.join(' · ')) : null,
    card.license ? h('span', { class: 'pmini-line' }, `${card.license.state} licence ${card.license.number} · as typed, not verified`) : null,
    h('span', { class: 'pmini-stats' }, statsWords(card.stats)),
    card.experience?.length ? h('span', { class: 'pmini-line' }, card.experience.slice(0, 2).map((e) => [e.title, e.company].filter(Boolean).join(', ')).join(' · ')) : null,
    card.memberSince ? h('span', { class: 'pmini-since' }, `Member since ${fmtMonth.format(new Date(card.memberSince))}`) : null,
  );
  const inner = [h('span', { class: 'pcard-avatar pmini-avatar', 'aria-hidden': 'true' }, initials(name)), body,
    canOpen ? h('span', { class: 'pmini-go', 'aria-hidden': 'true' }, '›') : null];
  return canOpen
    ? h('button', { type: 'button', class: 'pmini', 'aria-label': `${name}: see their card`, onclick: () => openCard(card) }, inner)
    : h('div', { class: 'pmini' }, inner);
}

// --------------------------------------------------------------- pieces --

const section = (title, ...body) => h('section', { class: 'panel' }, title ? h('h2', { class: 'panel-title' }, title) : null, ...body);
const termsLink = () => h('a', { class: 'fine-link', href: 'terms.html', target: '_blank', rel: 'noopener' }, 'Terms');

function head(job) {
  const ceiling = job.budgetMaxCents != null ? `Ceiling ${dollars(job.budgetMaxCents)}` : 'No ceiling';
  return h('section', { class: 'panel job-head' },
    h('div', { class: 'pills' },
      h('span', { class: 'pill local' }, 'Local job'),
      h('span', { class: `pill status-${job.status}` }, STATUS_PILL[job.status] ?? job.status),
      job.tradeLabels.map((l) => h('span', { class: 'pill' }, l))),
    h('h2', { class: 'job-title', id: 'jobTitle' }, job.title),
    h('p', { class: 'job-place' }, icon(ICONS.pin), `${job.place.city}, ${job.place.state} ${job.place.zip}`),
    h('p', { class: 'job-sub' }, `Posted ${dayOnly(job.postedAt)} · ${ceiling}`),
    h('p', { class: 'job-desc' }, job.description),
    job.repostedFrom ? h('p', { class: 'job-sub' }, 'Posted again after an earlier try.') : null,
  );
}

/** Closing countdown and the bid count: open jobs. */
function openFacts(job) {
  const left = timeLeft(job.closesAt);
  return h('div', { class: 'job-facts' },
    h('div', { class: 'fact' }, h('span', {}, 'Bidding closes'), h('strong', {}, left ? `in ${left}` : 'now'), h('small', {}, whenLong(job.closesAt))),
    h('div', { class: 'fact' }, h('span', {}, 'Sealed bids'), h('strong', {}, String(job.bidCount)), h('small', {}, 'amounts hidden')),
  );
}

/** The poster's own open job: a count, never an amount; Cancel. */
function myOpenJob(job) {
  return section('Your job',
    h('p', { class: 'job-note' }, `${job.bidCount} sealed bid${job.bidCount === 1 ? '' : 's'} so far. Amounts stay sealed until bidding closes, then the lowest wins.`),
    privateBox(job),
    ui.confirm === 'cancel'
      ? confirmBox('Cancel this job?', 'Bidding stops and every bid is closed. Nobody owes anything.', 'Cancel job', () => act(() => api.jobAction(job.id, 'cancel'), 'Job cancelled'))
      : h('button', { class: 'cta ghost danger-ghost', type: 'button', onclick: () => { ui.confirm = 'cancel'; redraw(); } }, 'Cancel job'),
  );
}

function confirmBox(title, text, yes, onYes) {
  return h('div', { class: 'job-confirm', role: 'alertdialog', 'aria-label': title },
    h('strong', {}, title), h('p', {}, text),
    h('div', { class: 'job-confirm-actions' },
      h('button', { class: 'cta danger', type: 'button', disabled: ui.busy, onclick: onYes }, ui.busy ? 'One moment…' : yes),
      h('button', { class: 'cta ghost', type: 'button', onclick: () => { ui.confirm = null; ui.actionError = null; redraw(); } }, 'Keep it')));
}

/** Who sees the poster's address and phone right now (src/jobs/view.ts: the winner only while the job runs). */
function privateLine(status) {
  if (status === 'open') return 'Only the winner sees this, after the job is awarded.';
  if (status === 'awarded' || status === 'agreed' || status === 'completed') return 'Shared with the winner.';
  return 'Not shown to anyone now.';
}

/** The address and phone: the poster always, the winner after the award. */
function privateBox(job) {
  if (!job.private) return null;
  const { address, phone } = job.private;
  const poster = job.my.role === 'poster';
  if (!address && !phone) {
    return poster ? h('p', { class: 'job-note faint' }, 'You added no street address or phone. You can share them in messages after the award.') : null;
  }
  return h('div', { class: 'job-private' },
    h('p', { class: 'job-private-head' }, icon(ICONS.lock), poster ? privateLine(job.status) : 'Shared with you as the winner.'),
    address ? h('p', {}, h('span', {}, 'Address'), h('strong', {}, address)) : null,
    phone ? h('p', {}, h('span', {}, 'Phone'), h('a', { href: `tel:${phone.replace(/[^\d+]/g, '')}` }, phone)) : null,
  );
}

// ------------------------------------------------------------ the bid box --

function bidBox(job) {
  const rules = job.rules;
  const mine = job.my.bid;
  if (mine?.status === 'active' && !ui.editing) {
    return section('Your bid',
      h('p', { class: 'my-bid' }, 'Your sealed bid: ', h('strong', {}, dollars(mine.amountCents))),
      mine.note ? h('p', { class: 'job-note' }, `Note: ${mine.note}`) : null,
      h('p', { class: 'job-note faint' }, 'Only you see this amount until bidding closes. You can change or withdraw it until then, free.'),
      ui.confirm === 'withdraw'
        ? confirmBox('Withdraw your bid?', 'You can bid again before it closes.', 'Withdraw', () => act(() => api.withdrawJobBid(job.id), 'Bid withdrawn'))
        : h('div', { class: 'job-buttons two' },
          h('button', { class: 'cta ghost', type: 'button', onclick: () => { ui.editing = true; ui.bidText = dollars(mine.amountCents).slice(1); ui.note = mine.note ?? ''; ui.agree = false; redraw(); } }, 'Change'),
          h('button', { class: 'cta ghost', type: 'button', onclick: () => { ui.confirm = 'withdraw'; redraw(); } }, 'Withdraw')),
    );
  }
  if (!job.my.canBid) return section(null, h('p', { class: 'job-note' }, job.my.whyNot ?? 'Bidding is closed.'));

  const fees = h('div', { class: 'fee-lines' });
  const paintFees = () => {
    const c = parseCents(ui.bidText);
    const lines = feeLines(rules, Number.isSafeInteger(c) ? c : null);
    fees.replaceChildren(h('p', {}, lines.noShow), h('p', {}, lines.service), h('p', { class: 'fees-off' }, FEES_OFF));
  };
  paintFees();
  const amount = moneyInput({ text: ui.bidText, placeholder: '0', label: 'Your bid in dollars', oninput: (v) => { ui.bidText = v; paintFees(); } });
  const amountInput = amount.querySelector('input');
  amountInput.setAttribute('enterkeyhint', 'done');
  const note = h('textarea', { class: 'input textarea short', rows: 2, maxlength: 500, placeholder: 'When you could start, what’s included…' }, ui.note);
  note.addEventListener('input', () => { ui.note = note.value; });
  const box = h('input', { type: 'checkbox', id: 'jobAgree', checked: ui.agree });
  box.addEventListener('change', () => { ui.agree = box.checked; });
  const send = h('button', { class: 'cta', type: 'submit', disabled: ui.busy }, ui.busy ? 'Sending…' : mine?.status === 'active' ? 'Update sealed bid' : 'Place sealed bid');
  const limits = `From ${dollars(rules.minCents)}${job.budgetMaxCents != null ? ` up to the poster’s ceiling of ${dollars(job.budgetMaxCents)}` : ''}. Labor and materials, all in.`;

  const form = h('form', { class: 'bid-form stack', novalidate: true },
    h('div', { class: 'field', 'data-field': 'amountCents' },
      h('label', { class: 'field-label', for: amountInput.id }, 'Your bid'), amount,
      h('p', { class: 'field-help' }, limits), h('p', { class: 'field-error', role: 'alert' })),
    h('div', { class: 'field', 'data-field': 'note' },
      h('label', { class: 'field-label', for: 'jobNote' }, 'Your note', h('span', { class: 'optional' }, 'optional')),
      // The API keeps the note for the bidder only (contract: the tab carries amounts, never notes).
      Object.assign(note, { id: 'jobNote' }), h('p', { class: 'field-help' }, 'Only you see this note. If you win, tell the poster in messages.'), h('p', { class: 'field-error', role: 'alert' })),
    fees,
    h('p', { class: 'jp-licence' }, licenceLine(job.place.state)),
    h('div', { class: 'field', 'data-field': 'agree' },
      h('label', { class: 'check agree', for: 'jobAgree' }, box, h('span', { class: 'check-box', 'aria-hidden': 'true' }, icon(ICONS.check)),
        h('span', { class: 'check-text' }, 'I agree to these rules and the ', termsLink(), '.')),
      h('p', { class: 'field-error', role: 'alert' })),
    formError(),
    send,
    mine?.status === 'active' ? h('button', { class: 'text-btn', type: 'button', onclick: () => { ui.editing = false; redraw(); } }, 'Keep my current bid') : null,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ui.busy) return;
    clearErrors(form);
    const cents = parseCents(ui.bidText);
    if (!Number.isSafeInteger(cents)) {
      showErrors(form, { amountCents: cents === null ? 'Type your bid in dollars.' : 'Type your bid in dollars, like 420 or 420.50.' });
      return;
    }
    ui.busy = true;
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      const { job: next } = await api.placeJobBid(job.id, { amountCents: cents, note: ui.note.trim() || undefined, agree: ui.agree });
      Object.assign(ui, { editing: false, bidText: '', note: '', agree: false });
      took(next, `Sealed bid placed: ${dollars(cents)}`);
    } catch (err) {
      ui.busy = false;
      send.disabled = false;
      send.textContent = mine?.status === 'active' ? 'Update sealed bid' : 'Place sealed bid';
      const fields = Array.isArray(err.body?.fields) ? fieldsObject(err.body.fields) : null;
      showErrors(form, fields && Object.keys(fields).length ? fields
        : { form: err.code === 'too_many_attempts' ? 'Too many tries. Wait a few minutes and try again.' : err.message || 'That didn’t go through. Try again.' });
      if (err.code === 'closed') load();
    }
  });

  return section(mine?.status === 'active' ? 'Change your bid' : 'Place a sealed bid',
    mine?.status === 'withdrawn' ? h('p', { class: 'job-note' }, 'You withdrew your bid. You can bid again until it closes.') : null,
    h('p', { class: 'job-note faint' }, 'Nobody sees your amount until bidding closes. The lowest bid wins.'),
    form);
}

// ------------------------------------------------------- after closing --

/** Where the job stands, in one banner. */
function statusBanner(job) {
  const st = stage(job, { reposted: (jobs.mine?.posted ?? []).some((j) => j.repostedFrom === job.id) });
  const ended = job.status === 'unfilled' || job.status === 'cancelled';
  return h('section', { class: `job-banner banner-${st.group}${ended ? ' is-ended' : ''}` },
    h('strong', {}, ended ? endedWords(job) : st.status),
    st.next ? h('p', {}, st.next) : null,
  );
}

/** The award: the amount, and the countdown to the contact deadline while it runs. */
function awardBox(job) {
  const a = job.award;
  if (!a) return null;
  const running = job.status === 'awarded';
  const left = running ? timeLeft(a.contactDeadline) : null;
  const step = (done, text) => h('li', { class: done ? 'done' : '' }, h('span', { class: 'step-dot', 'aria-hidden': 'true' }, done ? icon(ICONS.check) : null), text);
  // A losing bidder sees the result only: the winner's countdown and progress are between the two of them.
  if (job.my.role !== 'poster' && !a.isMe) {
    const tie = job.my.bid?.amountCents === a.amountCents;
    return section('Result',
      h('div', { class: 'job-facts' },
        h('div', { class: 'fact' }, h('span', {}, 'Lowest bid'), h('strong', {}, dollars(a.amountCents)), h('small', {}, `awarded ${dayOnly(a.awardedAt)}`))),
      tie ? h('p', { class: 'job-note' }, 'Same amount as the winner; the bid placed first wins.') : null);
  }
  return section('Award',
    h('div', { class: 'job-facts' },
      h('div', { class: 'fact' }, h('span', {}, a.isMe ? 'Your winning bid' : 'Lowest bid'), h('strong', {}, dollars(a.amountCents)), h('small', {}, `awarded ${dayOnly(a.awardedAt)}`)),
      h('div', { class: `fact${running && left && Date.parse(a.contactDeadline) - Date.now() < 2 * 864e5 ? ' urgent' : ''}` },
        h('span', {}, 'Contact by'), h('strong', {}, running ? (left ? `${left} left` : 'now') : dayOnly(a.contactDeadline)), h('small', {}, whenLong(a.contactDeadline)))),
    job.status === 'awarded' || job.status === 'agreed' || job.status === 'completed' ? h('ol', { class: 'job-steps' },
      // Contact (src/jobs/rules.ts madeContact): the winner's message or "We've agreed", the poster's "They
      // contacted me" or "We've agreed". The API's bidderContactedAt is the earliest of the four.
      step(!!a.bidderContactedAt, 'The winner made contact (a message or a tap)'),
      // posterContactedAt: the poster's message, "They contacted me" or "We've agreed" (rules.ts posterAnswered).
      step(!!a.posterContactedAt, 'The poster answered'),
      step(!!a.posterConfirmedAt && !!a.bidderConfirmedAt, `Both tapped “We’ve agreed”${a.posterConfirmedAt && !a.bidderConfirmedAt ? ' (poster has)' : !a.posterConfirmedAt && a.bidderConfirmedAt ? ' (winner has)' : ''}`),
      step(job.status === 'completed', 'The poster marked it done')) : null,
  );
}

/** The other side: the winner's card for the poster, the poster's card for everyone else. */
function people(job) {
  if (job.my.role === 'poster') return job.award?.winner ? section('Winner', personMini(job.award.winner, { fallbackName: 'Bidder 1 (no business name yet)' })) : null;
  // A bidder whose bid was in may open the poster's full card once bidding has closed (they have dealt with each
  // other: src/jobs/stats.ts sharesJob). Anyone else gets the short card only.
  return section('Posted by', personMini(job.poster, { canOpen: job.my.role === 'bidder' && !!job.tab }));
}

/**
 * The onboarding's default business name ("My electrical shop", web/js/profile-form.js defaultBusinessName) says
 * nothing about who it is, and many bidders share it, so the tab falls back to "Bidder N" for it. The server's
 * cards (src/profile/person.ts) already use the account name instead; this covers rows from before that.
 */
const isDefaultShopName = (name) => /^My( .+)? shop$/.test(name ?? '') || name === 'BidSwipe member';

/** The ranked amounts after closing: the viewer's own marked; the poster also sees who. */
function bidTab(job) {
  if (!job.tab?.length) return null;
  const poster = job.my.role === 'poster';
  return section('Bid tab',
    h('ol', { class: 'bid-tab' }, job.tab.map((r) => h('li', { class: `${r.mine ? 'mine' : ''}${r.rank === 1 ? ' first' : ''}` },
      h('span', { class: 'bt-rank' }, String(r.rank)),
      h('span', { class: 'bt-who' }, r.mine ? 'You' : poster && r.bidder && !isDefaultShopName(r.bidder.name) ? r.bidder.name : `Bidder ${r.rank}`),
      h('strong', { class: 'bt-amt' }, dollars(r.amountCents)),
      poster && r.bidder ? h('button', { class: 'text-btn bt-card', type: 'button', onclick: () => openCard(r.bidder) }, 'Card') : null))),
    h('p', { class: 'job-note faint' }, poster ? 'Lowest first. Tap Card to see a bidder.' : 'Lowest first. Bidders’ names are shown only to the poster.'),
  );
}

// Pacific, like every other date in the app (a phone set to another zone still reads the board's time).
const fmtMsgTime = new Intl.DateTimeFormat('en-US', { timeZone: PT, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The thread between the poster and the winner, with a send box while the job is live. */
function thread(job) {
  const inThread = job.award && (job.my.role === 'poster' || job.award.isMe) && (job.status !== 'unfilled' || ui.messages.length);
  if (!inThread) return null;
  const canSend = job.status === 'awarded' || job.status === 'agreed';
  const list = ui.messages.length
    ? h('ul', { class: 'msgs' }, ui.messages.map((m) => h('li', { class: `msg ${m.mine ? 'mine' : 'theirs'}` },
      h('p', {}, m.body), h('small', {}, `${m.mine ? 'You' : m.from === 'poster' ? 'Poster' : 'Winner'} · ${fmtMsgTime.format(new Date(m.at))}`))))
    : h('p', { class: 'job-note faint' }, job.my.role === 'poster' ? 'No messages yet. The winner writes first, or you can.' : 'No messages yet. Say hello and when you could come look: your first message counts as making contact.');
  let box = null;
  if (canSend) {
    const input = h('textarea', { class: 'input textarea short', rows: 2, maxlength: 1000, placeholder: 'Write a message…', 'aria-label': 'Message', id: 'jobMsg' }, ui.msg);
    input.addEventListener('input', () => { ui.msg = input.value; });
    const send = h('button', { class: 'cta msg-send', type: 'submit', disabled: ui.busy }, 'Send');
    box = h('form', { class: 'msg-box', 'data-field': 'body' }, input, send, h('p', { class: 'field-error', role: 'alert' }));
    box.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = ui.msg.trim();
      if (!body || ui.busy) return;
      ui.busy = true;
      send.disabled = true;
      try {
        const { message } = await api.jobAction(job.id, 'messages', { body });
        ui.messages = [...ui.messages, message];
        ui.msg = '';
        ui.busy = false;
        ui.focus = 'jobMsg';
        load();
      } catch (err) {
        ui.busy = false;
        send.disabled = false;
        const f = Array.isArray(err.body?.fields) ? fieldsObject(err.body.fields) : null;
        showErrors(box, f?.body ? { body: f.body } : { body: err.message || 'That didn’t send. Try again.' });
        if (err.code === 'closed') load();
      }
    });
  }
  return section('Messages', list, box,
    canSend ? h('p', { class: 'job-note faint' }, job.my.role === 'poster'
      ? `Only you two see these. A reply, “They contacted me” or “We’ve agreed” is your answer. If the winner writes with at least ${answerWindowText(job.rules)} left and you never answer, it is recorded on your profile as unanswered.`
      : 'Only you two see these. Your first message counts as making contact. Agree the price, the scope and a day, then both tap “We’ve agreed”.') : null);
}

/** The buttons the API allows for this person and this state. */
function actions(job) {
  const a = job.award;
  const poster = job.my.role === 'poster';
  const winner = iWon(job) && job.my.role !== 'poster';
  const rules = job.rules;
  const out = [];
  if (job.status === 'awarded' && a) {
    if (poster && !a.bidderContactedAt) {
      out.push(h('button', { class: 'cta ghost', type: 'button', onclick: () => act(() => api.jobAction(job.id, 'contacted'), 'Noted: they contacted you') }, 'They contacted me'));
    }
    const confirmedByMe = poster ? a.posterConfirmedAt : a.bidderConfirmedAt;
    if ((poster || winner) && !confirmedByMe) {
      const service = feeCents(a.amountCents, ppmOf(rules.serviceFeePct));
      out.push(h('button', { class: 'cta', type: 'button', onclick: () => act(() => api.jobAction(job.id, 'confirm'), 'Thanks. When you both tap it, the job is agreed.') }, 'We’ve agreed'),
        h('p', { class: 'job-note faint' }, `Tap once you’ve settled price, scope and a day, here or by phone. Your tap counts as contact, and the ${poster ? 'winner' : 'poster'} is told to tap it too. When you both have, a ${rules.serviceFeePct}% service fee (${dollars(service)}) is recorded for the winner. ${FEES_OFF.split('. ')[0]}.`));
    } else if (confirmedByMe) {
      out.push(h('p', { class: 'job-note' }, poster ? 'You tapped “We’ve agreed”. Waiting for the winner.' : 'You tapped “We’ve agreed”. Waiting for the poster.'));
    }
    if (winner) {
      const fee = feeCents(a.amountCents, ppmOf(rules.noShowFeePct));
      out.push(ui.confirm === 'backout'
        ? confirmBox('Give the job back?',
          `The job ends unfilled and a no-show fee of ${rules.noShowFeePct}% of your bid (${dollars(fee)}) is recorded on your profile. ${FEES_OFF.split('. ')[0]}.`,
          'Give it back', () => act(() => api.jobAction(job.id, 'back-out'), 'You gave the job back'))
        : h('button', { class: 'cta ghost danger-ghost', type: 'button', onclick: () => { ui.confirm = 'backout'; redraw(); } }, 'I can’t take it'));
    }
    if (poster) {
      out.push(ui.confirm === 'cancel'
        ? confirmBox('Cancel this job?', 'It ends unfilled. Nobody owes a fee. You can post it again.', 'Cancel job',
          () => act(() => api.jobAction(job.id, 'cancel'), 'Job cancelled'))
        : h('button', { class: 'cta ghost danger-ghost', type: 'button', onclick: () => { ui.confirm = 'cancel'; redraw(); } }, 'Cancel job'));
    }
  }
  if (job.status === 'agreed' && poster) {
    out.push(h('button', { class: 'cta', type: 'button', onclick: () => act(() => api.jobAction(job.id, 'complete'), 'Marked done. Thanks!') }, 'Job done'));
  }
  if ((job.status === 'unfilled' || job.status === 'cancelled') && poster) {
    const reposted = (jobs.mine?.posted ?? []).find((j) => j.repostedFrom === job.id);
    if (reposted) {
      out.push(h('button', { class: 'cta ghost', type: 'button', onclick: () => openJob(reposted.id, jobs.open.back) }, 'See the new post'));
    } else {
      const days = h('div', { class: 'trade-chips', role: 'group', 'aria-label': 'Bidding closes in' });
      const paint = () => days.replaceChildren(...CLOSES_IN.map((n) => chip(`${n} day${n === 1 ? '' : 's'}`, ui.repostDays === n, () => { ui.repostDays = n; paint(); })));
      paint();
      out.push(h('div', { class: 'field' }, h('p', { class: 'field-label' }, 'Post it again: bidding closes in'), days),
        h('button', {
          class: 'cta', type: 'button', disabled: ui.busy,
          onclick: async () => {
            if (ui.busy) return;
            ui.busy = true;
            try {
              const { job: next } = await api.jobAction(job.id, 'repost', { closesInDays: ui.repostDays });
              ui.busy = false;
              loadMine();
              openJob(next.id, jobs.open.back);
              showToast('Posted again');
            } catch (err) {
              ui.busy = false;
              ui.actionError = err.message || 'That didn’t post. Try again.';
              redraw();
            }
          },
        }, 'Post again'));
    }
  }
  if (!out.length && !ui.actionError) return null;
  return section(null, h('div', { class: 'job-actions' }, out),
    ui.actionError ? h('p', { class: 'field-error', role: 'alert' }, ui.actionError) : null);
}

function feesBox(job) {
  if (!job.fees.length) return null;
  // "A no-show is recorded" belongs only next to a no-show fee; a service fee gets the first sentence alone.
  const off = job.fees.some((f) => f.kind === 'no_show') ? FEES_OFF : `${FEES_OFF.split('. ')[0]}.`;
  return section('Fees', h('ul', { class: 'fee-list' }, job.fees.map((f) => h('li', {}, feeWords(f)))), h('p', { class: 'job-note faint' }, off));
}

function reportBox(job) {
  if (job.my.role === 'poster') return null;
  if (ui.confirm !== 'report') {
    return h('p', { class: 'fine' }, h('button', { class: 'link-btn report-link', type: 'button', onclick: () => { ui.confirm = 'report'; redraw(); } }, 'Report this job'));
  }
  const input = h('textarea', { class: 'input textarea short', rows: 3, maxlength: 500, placeholder: 'What’s wrong with it?', id: 'jobReport' }, ui.reportText);
  input.addEventListener('input', () => { ui.reportText = input.value; });
  const form = h('form', { class: 'stack', novalidate: true },
    h('div', { class: 'field', 'data-field': 'reason' }, h('label', { class: 'field-label', for: 'jobReport' }, 'Report this job'), input,
      h('p', { class: 'field-help' }, 'A person at BidSwipe reads every report. The poster isn’t told who sent it.'), h('p', { class: 'field-error', role: 'alert' })),
    formError(),
    h('div', { class: 'job-buttons two' },
      h('button', { class: 'cta', type: 'submit' }, 'Send report'),
      h('button', { class: 'cta ghost', type: 'button', onclick: () => { ui.confirm = null; redraw(); } }, 'Never mind')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    try {
      await api.jobAction(job.id, 'report', { reason: ui.reportText.trim() });
      ui.confirm = null;
      ui.reportText = '';
      showToast('Thanks. We’ll take a look.');
      redraw();
    } catch (err) {
      const f = Array.isArray(err.body?.fields) ? fieldsObject(err.body.fields) : null;
      showErrors(form, f && Object.keys(f).length ? f : { form: err.code === 'too_many_attempts' ? 'Too many reports in the last hour.' : err.message || 'That didn’t send.' });
    }
  });
  return section(null, form);
}

// ---------------------------------------------------------------- page --

function header() {
  return h('header', { class: 'screen-head' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', onclick: () => setView(jobs.open.back || 'jobs') }, icon(ICONS.back)),
    h('h1', {}, 'Local job'),
    h('span', { class: 'icon-btn ghost', 'aria-hidden': 'true' }));
}

function page(job) {
  const open = job.status === 'open';
  const poster = job.my.role === 'poster';
  return [
    head(job),
    open ? openFacts(job) : statusBanner(job),
    open && poster ? myOpenJob(job) : null,
    open && !poster ? people(job) : null,
    open && !poster ? bidBox(job) : null,
    !open ? awardBox(job) : null,
    !open ? actions(job) : null,
    !open ? thread(job) : null,
    !open ? privateBox(job) && section('Address and phone', privateBox(job)) : null,
    !open ? people(job) : null,
    !open ? bidTab(job) : null,
    !open ? feesBox(job) : null,
    reportBox(job),
  ];
}

function renderJob() {
  if (jobs.open.id !== ui.id) { ui = fresh(); ui.id = jobs.open.id; }
  if (ui.el) {
    const a = document.activeElement;
    if (a && ui.el.contains(a) && a.id) ui.focus = a.id;
    return ui.el;
  }
  if (!ui.job && !ui.loading && !ui.error) load();
  let body;
  if (ui.error) body = h('div', { class: 'empty' }, h('h3', {}, 'Can’t open this job'), h('p', {}, ui.error),
    h('button', { class: 'cta ghost', type: 'button', onclick: () => setView('jobs') }, 'Go to Jobs'));
  else if (!ui.job) body = h('div', { class: 'empty' }, h('p', {}, 'Loading…'));
  else body = page(ui.job);
  ui.el = h('div', { class: 'screen job-page' }, header(), body);
  return ui.el;
}

onAfterRender((view) => {
  if (view !== 'job' || !ui.focus) return;
  const el = document.getElementById(ui.focus);
  ui.focus = null;
  el?.focus({ preventScroll: true });
});

// A job alert about the open page (a message, the award): read it again.
window.addEventListener('bidswipe:job-alert', (e) => {
  if (state.view === 'job' && e.detail?.jobId === ui.id) load();
});

registerView('job', { chrome: 'screen', render: renderJob });
