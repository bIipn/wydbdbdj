// The swipe card (with drag handling) and the list row.

import { commit } from './actions.js';
import { $, h } from './dom.js';
import { dueInfo, estLabel, num, VERDICT_LABEL } from './format.js';
import { bidLink, facts, localPill, overLimitTag, reasonsList, scoreRing, subNote, subPill } from './parts.js';
import { openSheet } from './sheet.js';

export function card(item, layer) {
  return h('article', { class: `card verdict-${item.verdict} ${layer}`, 'aria-label': item.title },
    h('div', { class: 'stamp save' }, 'SAVE'),
    h('div', { class: 'stamp pass' }, 'PASS'),
    h('div', { class: 'card-head' },
      h('div', { class: 'pills' },
        h('span', { class: 'pill verdict' }, VERDICT_LABEL[item.verdict] ?? item.verdict),
        // Sub work: its pill takes the board's place on the card (the board is in "Type" and on the button), so
        // the pills stay on one line and its reasons, which say what to do, keep their room.
        subPill(item) ?? localPill(item) ?? h('span', { class: 'pill' }, item.sourceName),
      ),
      scoreRing(item.score),
    ),
    subNote(item),
    h('h2', {}, item.title),
    h('p', { class: 'agency' }, item.agency ?? ''),
    facts(item),
    reasonsList(item, 4),
    bidLink(item),
    h('div', { class: 'card-foot' },
      h('span', {}, (item.description ?? '').split('\n')[0].slice(0, 70)),
      h('button', { type: 'button', onclick: () => openSheet(item) }, 'Details'),
    ),
  );
}

/** One line in Browse / Saved. Tags: Saved / Opened / Passed, and "Over your limit". */
export function row(item) {
  const due = dueInfo(item.dueAt);
  // Miles only when the server measured them to the job; otherwise the place label alone says where.
  const meta = [item.agency, item.location?.label, item.distanceMi != null ? `${num(item.distanceMi)}\u00a0mi` : null].filter(Boolean).join(' · ');
  const value = estLabel(item.estValue);
  const swipeTag = item.swipe === 'save' || item.swipe === 'bid' ? h('span', { class: 'tag saved' }, item.swipe === 'bid' ? 'Opened' : 'Saved')
    : item.swipe === 'pass' ? h('span', { class: 'tag passed' }, 'Passed') : null;
  const local = localPill(item);
  const sub = subPill(item);
  const tags = swipeTag || item.overLimit || local || sub ? h('div', { class: 'tags' },
    sub ? h('span', { class: 'tag sub' }, 'Sub work') : null,
    local ? h('span', { class: 'tag local' }, 'Local job') : null, swipeTag, overLimitTag(item)) : null;
  return h('button', { class: `row verdict-${item.verdict}`, type: 'button', 'data-id': item.id, onclick: () => openSheet(item) },
    h('div', { class: 'badge' }, item.score),
    h('div', {},
      h('h4', {}, item.title),
      h('p', { class: 'meta' }, meta),
      h('p', {}, h('span', { class: `due${due.urgent ? ' urgent' : ''}` }, due.big), ` · ${due.small}`),
      h('p', { class: `value${value ? '' : ' unknown'}` }, value ? `Est. ${value}` : 'Value not listed'),
      tags,
    ),
  );
}

/** Drag the top card left / right. */
export function attachSwipe(el, item) {
  let startX = 0, startY = 0, dx = 0, dy = 0, t0 = 0, active = false, id = null;
  const save = $('.stamp.save', el);
  const pass = $('.stamp.pass', el);

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('a, button')) return;
    active = true; id = e.pointerId; startX = e.clientX; startY = e.clientY; t0 = performance.now(); dx = dy = 0;
    el.setPointerCapture(id);
    el.dataset.dragging = '1'; // a live update waits until the card is let go (shell.js render)
    el.style.transition = 'none';
  });
  el.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== id) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    el.style.transform = `translate(${dx}px, ${dy * 0.2}px) rotate(${dx / 18}deg)`;
    const p = Math.min(1, Math.abs(dx) / 110);
    save.style.opacity = dx > 0 ? String(p) : '0';
    pass.style.opacity = dx < 0 ? String(p) : '0';
  });
  const end = (e) => {
    if (!active || e.pointerId !== id) return;
    active = false;
    delete el.dataset.dragging;
    const speed = Math.abs(dx) / Math.max(1, performance.now() - t0);
    if (Math.abs(dx) > 110 || (Math.abs(dx) > 45 && speed > 0.55)) {
      commit(item, dx > 0 ? 'save' : 'pass', el, dy);
    } else {
      el.style.transition = 'transform .28s cubic-bezier(.2,.8,.2,1)';
      el.style.transform = '';
      save.style.opacity = pass.style.opacity = '0';
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
