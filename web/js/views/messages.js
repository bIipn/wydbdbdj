// Messages: the Messages tab (the list of conversations) and one conversation (a full-page chat).
//
// A conversation exists only between the poster of a local job and its winning bidder, after the award
// (src/jobs/view.ts inThread; CLAUDE.md "Local jobs"). Nobody else can message anybody, and public bids have no
// messages (they are bid on the agency's own site). Who may WRITE, and when, is the server's alone
// (repo.insertMessage): this screen only shows the composer while the server says canWrite, and a sentence after.
//
//   GET  /api/jobs/conversations       the list (the badge counts the conversations with something unread)
//   GET  /api/jobs/:id/conversation    one conversation and its messages
//   POST /api/jobs/:id/read { upTo }   opened: read up to the newest message the screen showed; the bell's
//                                      "New message" alerts for those are retired with it
//
// The bubbles and the composer are the SAME code on the job page (views/job.js imports messageList and composer).
// A message that arrives while either screen is open shows without a reload: live.js turns every job alert into
// a 'bidswipe:job-alert' event, and both screens read again when one names their job.

import { api } from '../api.js';
import { h, icon, ICONS } from '../dom.js';
import { showErrors } from '../form.js';
import { PT } from '../format.js';
import { monogram } from '../home-model.js';
import { jobsOn, openJob } from '../jobs-data.js';
import {
  cannotWriteSentence, EMPTY_LINE, emptyThreadLine, fullTime, listTime, markedRead, mustMarkRead, newestId, otherName, previewLine,
  sortConversations, tabLabel, unreadCount,
} from '../messages-model.js';
import { onEnteredApp, onSignedOut } from '../session.js';
import { onAfterRender, registerTabCount, registerView, render, setView } from '../shell.js';
import { state } from '../state.js';
import { fieldsObject } from '../work-profile.js';

// ------------------------------------------------------------------- shared with the job page --

// Pacific, like every other date in the app (a phone set to another zone still reads the board's time).
const fmtMsgTime = new Intl.DateTimeFormat('en-US', { timeZone: PT, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The thread's bubbles: the other side at the left, the viewer at the right, each with who and when. */
export function messageList(messages) {
  return h('ul', { class: 'msgs' }, messages.map((m) => h('li', { class: `msg ${m.mine ? 'mine' : 'theirs'}`, 'data-id': m.id },
    h('p', {}, m.body),
    h('small', {}, `${m.mine ? 'You' : m.from === 'poster' ? 'Poster' : 'Winner'} · ${fmtMsgTime.format(new Date(m.at))}`))));
}

/**
 * The send box. `store` keeps the half-typed text and the busy flag between redraws ({ msg, busy }); `id` is the
 * textarea's id (focus comes back to it after a redraw). onSent(message) gets the server's MessageView; a refusal
 * shows its sentence under the box, and onClosed() runs when the server says the thread no longer takes messages.
 */
export function composer(store, { jobId, id, onSent, onClosed }) {
  const input = h('textarea', {
    class: 'input textarea short', rows: 2, maxlength: 1000, placeholder: 'Write a message…', 'aria-label': 'Message', id,
  }, store.msg);
  input.addEventListener('input', () => { store.msg = input.value; });
  const send = h('button', { class: 'cta msg-send', type: 'submit', disabled: store.busy }, 'Send');
  const box = h('form', { class: 'msg-box', 'data-field': 'body' }, input, send, h('p', { class: 'field-error', role: 'alert' }));
  // Ctrl/Cmd+Enter sends from a keyboard; a plain Enter is a new line (a phone's Enter key is one).
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); box.requestSubmit(); } });
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = store.msg.trim();
    if (!body || store.busy) return;
    store.busy = true;
    send.disabled = true;
    try {
      const { message } = await api.jobAction(jobId, 'messages', { body });
      store.msg = '';
      store.busy = false;
      onSent(message);
    } catch (err) {
      store.busy = false;
      send.disabled = false;
      const f = Array.isArray(err.body?.fields) ? fieldsObject(err.body.fields) : null;
      showErrors(box, f?.body ? { body: f.body } : { body: err.message || 'That didn’t send. Try again.' });
      if (err.code === 'closed') onClosed?.();
    }
  });
  return box;
}

// ------------------------------------------------------------------------------------ the data --

const box = {
  /** The list from the server, newest activity first; null until loaded. */
  list: null,
  loading: false,
  error: null,
};
const freshConvo = () => ({
  id: null, back: 'messages', conv: null, messages: [], error: null, loading: false,
  msg: '', busy: false, drawnNewest: 0, focus: null, loaded: false,
});
let convo = freshConvo();
onSignedOut(() => { Object.assign(box, { list: null, loading: false, error: null }); convo = freshConvo(); });

export async function loadConversations() {
  if (!jobsOn() || box.loading) return;
  box.loading = true;
  try {
    const res = await api.conversations();
    box.list = sortConversations(res.conversations);
    box.error = null;
  } catch (err) {
    box.error = err.message || 'Couldn’t load your messages.';
  }
  box.loading = false;
  render();
}

registerTabCount('messages', () => {
  const n = jobsOn() ? unreadCount(box.list) : 0;
  return { show: jobsOn(), count: n, label: tabLabel(n) };
});

// The highest message id this device has marked read, per job (sign-out forgets it).
const seenUpTo = new Map();
onSignedOut(() => seenUpTo.clear());

/**
 * This person has the thread on screen up to `messages`' newest: mark it read (the badge and the bell go down).
 * `fresh` = the conversation the server sent WITH these messages (the conversation screen has it; the job page
 * does not). Decided by messages-model mustMarkRead, never by the cached list, which can be older than the screen.
 */
export async function markSeen(jobId, messages, fresh = null) {
  const upTo = newestId(messages);
  if (!upTo) return;
  if (!mustMarkRead(messages, fresh, seenUpTo.get(jobId) ?? 0)) {
    if (fresh) seenUpTo.set(jobId, Math.max(seenUpTo.get(jobId) ?? 0, upTo));
    return;
  }
  try {
    const res = await api.readConversation(jobId, upTo);
    seenUpTo.set(jobId, Math.max(seenUpTo.get(jobId) ?? 0, typeof res?.readUpTo === 'number' ? res.readUpTo : upTo));
    if (box.list) box.list = markedRead(box.list, jobId);
    if (typeof res?.alertsUnread === 'number') state.unread = res.alertsUnread;
    loadConversations(); // a message newer than upTo keeps it unread; the server says
  } catch { /* the badge stays as it was: nothing is lost, it is read next time */ }
}

/** Open one conversation. `back` = where its Back goes: Messages, or the job page it was opened from. */
export function openConversation(jobId, back = 'messages') {
  if (convo.id !== jobId) convo = freshConvo();
  convo.id = jobId;
  convo.back = back === 'job' ? 'job' : 'messages';
  convo.conv = box.list?.find((c) => c.jobId === jobId) ?? convo.conv;
  setView('conversation');
  loadConvo();
}

async function loadConvo(id = convo.id) {
  if (!id) return;
  convo.loading = true;
  try {
    const res = await api.conversation(id);
    if (convo.id !== id) return;
    convo.conv = res.conversation;
    convo.messages = res.messages;
    convo.loaded = true;
    convo.error = null;
  } catch (err) {
    if (convo.id !== id) return;
    convo.error = err.status === 404 ? 'This conversation is gone. The job may have been removed.'
      : err.status === 403 ? 'Messages are only between the poster and the winner, after the award.'
        : err.message || 'Couldn’t load this conversation.';
  }
  convo.loading = false;
  if (state.view === 'conversation') {
    render();
    if (!convo.error) markSeen(id, convo.messages, convo.conv);
  }
}

// The Messages badge is known from the first screen on, not only once the tab is opened.
onEnteredApp(() => { if (jobsOn()) { box.list = null; loadConversations(); } });

// A job alert (a message, the award, the end): a conversation may be new, newer or closed. The list reads again;
// the open conversation too, when the alert is about it.
window.addEventListener('bidswipe:job-alert', (e) => {
  if (!jobsOn()) return;
  loadConversations();
  if (state.view === 'conversation' && e.detail?.jobId === convo.id) loadConvo();
});

// ------------------------------------------------------------------------------ the list --

function avatar(name) {
  const letters = monogram(name);
  return h('span', { class: 'mx-avatar', 'aria-hidden': 'true' }, letters || icon(PERSON));
}
const PERSON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1.2-3.6 3.9-5.5 7-5.5s5.8 1.9 7 5.5"/></svg>';

function row(c) {
  const name = otherName(c);
  const when = c.last?.at ?? c.activityAt;
  const roleWord = c.role === 'poster' ? 'Your job' : 'You won';
  const spoken = [
    `${name}${c.unread ? ', new message' : ''}.`, `${roleWord}: ${c.title}.`, `${previewLine(c)}.`, fullTime(when),
  ].join(' ');
  return h('li', {},
    h('button', { class: `mx-row${c.unread ? ' is-unread' : ''}`, type: 'button', 'aria-label': spoken, onclick: () => openConversation(c.jobId, 'messages') },
      avatar(name),
      h('span', { class: 'mx-text' },
        h('span', { class: 'mx-line1' }, h('span', { class: 'mx-name' }, name), h('span', { class: 'mx-time' }, listTime(when))),
        h('span', { class: 'mx-job' }, h('span', { class: `mx-role ${c.role}` }, roleWord), h('span', { class: 'mx-title' }, c.title)),
        h('span', { class: 'mx-line3' },
          h('span', { class: `mx-preview${c.last ? '' : ' is-none'}` }, previewLine(c)),
          c.unread ? h('span', { class: 'mx-dot', 'aria-hidden': 'true' }) : null),
      ),
    ));
}

function renderList() {
  if (!jobsOn()) {
    return h('div', { class: 'empty' }, h('h3', {}, 'Messages need an account'), h('p', {}, 'Sign in to post a job or bid on one.'));
  }
  if (!box.list && !box.loading && !box.error) loadConversations();
  if (box.error && !box.list) {
    return h('div', { class: 'empty compact' }, h('h3', {}, 'Couldn’t load your messages'), h('p', {}, box.error),
      h('button', { class: 'cta ghost', type: 'button', onclick: () => { box.error = null; render(); } }, 'Try again'));
  }
  if (!box.list) return h('ul', { class: 'mx-list', 'aria-busy': 'true' }, [0, 1, 2].map(() => h('li', { class: 'mx-skeleton', 'aria-hidden': 'true' })));
  if (!box.list.length) {
    return h('div', { class: 'mx-empty' },
      h('span', { class: 'mx-empty-mark', 'aria-hidden': 'true' }, icon(BUBBLE)),
      h('h3', {}, 'No conversations yet'),
      h('p', {}, EMPTY_LINE),
      h('button', { class: 'cta ghost', type: 'button', onclick: () => setView('jobs') }, 'Go to Jobs'));
  }
  return h('div', { class: 'mx' }, h('ul', { class: 'mx-list' }, box.list.map(row)));
}
const BUBBLE = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-4.5 3.5v-3.5a2 2 0 0 1-2-2z"/></svg>';

// ---------------------------------------------------------------------- one conversation --

function convoHead(c) {
  const name = c ? otherName(c) : '';
  const backTo = convo.back === 'job' ? 'Back to the job' : 'Back to Messages';
  return h('header', { class: 'screen-head mx-head' },
    h('button', {
      type: 'button', class: 'icon-btn', 'aria-label': backTo, title: backTo,
      // The job page keeps its own Back (jobs-data.js jobs.open), so returning to it is just showing it again.
      onclick: () => setView(convo.back === 'job' ? 'job' : 'messages'),
    }, icon(ICONS.back)),
    h('div', { class: 'mx-head-text' },
      h('h1', {}, name || 'Conversation'),
      c ? h('button', { class: 'mx-head-job', type: 'button', onclick: () => openJob(convo.id, 'conversation') },
        h('span', { class: 'mx-head-title' }, c.title), h('span', { class: 'mx-head-open' }, 'Job details')) : null),
    c ? avatar(name) : h('span', { class: 'icon-btn ghost', 'aria-hidden': 'true' }));
}

function renderConvo() {
  if (!jobsOn() || !convo.id) return renderList();
  state.threadOnScreen = convo.id; // live.js: no toast for a message this screen already shows
  if (document.activeElement?.id === 'convoMsg') convo.focus = 'convoMsg'; // a redraw keeps the person typing
  if (!convo.loaded && !convo.loading && !convo.error) loadConvo();
  const c = convo.conv;
  let body;
  if (convo.error) {
    body = h('div', { class: 'empty' }, h('h3', {}, 'Can’t open this conversation'), h('p', {}, convo.error),
      h('button', { class: 'cta ghost', type: 'button', onclick: () => setView('messages') }, 'Go to Messages'));
  } else if (!c || (!convo.loaded && c.messageCount > 0)) {
    body = h('div', { class: 'empty' }, h('p', {}, 'Loading…'));
  } else {
    const thread = convo.messages.length ? messageList(convo.messages) : h('p', { class: 'mx-thread-empty' }, emptyThreadLine(c));
    const sentence = cannotWriteSentence(c);
    const foot = sentence
      ? h('p', { class: 'mx-closed', role: 'status' }, sentence)
      : composer(convo, {
        jobId: convo.id, id: 'convoMsg',
        onSent: (message) => {
          convo.messages = [...convo.messages, message];
          convo.focus = 'convoMsg';
          render();
          loadConvo();
          loadConversations();
        },
        onClosed: () => loadConvo(),
      });
    body = [
      h('p', { class: 'mx-who' }, c.role === 'poster' ? 'You posted this job. Only you and the winner see these messages.'
        : 'You won this job. Only you and the poster see these messages.'),
      h('div', { class: 'mx-thread', 'aria-label': 'Messages', role: 'log' }, thread),
      h('div', { class: 'mx-foot' }, foot),
    ];
  }
  return h('div', { class: 'screen mx-convo' }, convoHead(c), body);
}

// Keep the focus in the box across a redraw (a live message redraws the app), and keep the newest message in view.
onAfterRender((view) => {
  if (view !== 'conversation') return;
  const want = convo.focus;
  convo.focus = null;
  if (want) {
    const el = document.getElementById(want);
    if (el) {
      el.focus({ preventScroll: true });
      const end = el.value.length;
      el.setSelectionRange?.(end, end);
    }
  }
  const newest = newestId(convo.messages);
  if (newest > convo.drawnNewest) {
    convo.drawnNewest = newest;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: reduce ? 'auto' : 'smooth' }));
  }
});

registerView('messages', { chrome: 'tabs', render: renderList });
registerView('conversation', { chrome: 'screen', render: renderConvo });
