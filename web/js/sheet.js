// The detail sheet that slides up over any view. Its top bar (index.html: the grip and the Close button) is the same
// for every use: bid details (openSheet), and whatever showInSheet puts in it (Filters, a person's card).

import { setSwipe } from './actions.js';
import { $, h } from './dom.js';
import { addendaLine, VERDICT_LABEL } from './format.js';
import { agencyLine } from './home-model.js';
import { bidLink, facts, localPill, reasonsList, scoreRing, subNote, subPill } from './parts.js';
import { costCheckButton, priceCheck } from './price.js';
import { render, setView } from './shell.js';
import { isLive } from './state.js';
import { closeSheet as close, sheetOpen as isSheetOpen } from './sheet-close.js';

export function openSheet(item) {
  const body = $('#sheetBody');
  const actions = h('div', { class: 'sheet-actions' },
    h('button', { class: 'cta ghost', type: 'button', onclick: () => { closeSheet(); setSwipe(item, 'pass', 'Passed'); render(); } }, 'Pass'),
    h('button', { class: 'cta ghost', type: 'button', onclick: () => { closeSheet(); setSwipe(item, 'save', 'Saved'); render(); } }, item.swipe === 'save' ? 'Saved ✓' : 'Save'),
    bidLink(item, 'full'),
  );
  const addenda = addendaLine(item); // public bids only: a local job is bid in the app
  // replaceChildren() would print a null as the text "null": drop the parts this bid does not have.
  body.replaceChildren(...[
    h('div', { class: `card-head verdict-${item.verdict}` },
      h('div', { class: 'pills' },
        h('span', { class: 'pill verdict' }, VERDICT_LABEL[item.verdict] ?? item.verdict),
        subPill(item) ?? localPill(item) ?? h('span', { class: 'pill' }, item.sourceName), // the board is in "Type"
        item.overLimit ? h('span', { class: 'pill over' }, 'Over your limit') : null,
      ),
      scoreRing(item.score),
    ),
    subNote(item),
    h('h2', { id: 'sheetTitle' }, item.title),
    h('p', { class: 'agency' }, agencyLine(item)),
    facts(item, { sheet: true }), // "41 mi, straight line": no new line, so "Bid on …" stays where it was (S1)
    item.overLimit ? h('p', { class: 'over-note' }, 'This job is bigger than the spend limits in your settings, so it stays out of your swipe deck.') : null,
    h('div', { class: `verdict-${item.verdict}` }, reasonsList(item)),
    item.description ? h('div', { class: 'desc' }, item.description) : null,
    actions,
    // Below "Bid on …", never above it: a new line must not push the button down (docs/PLAN.md S1).
    addenda ? h('p', { class: 'addenda-note' }, addenda) : null,
    // The price check needs the API (the bundled demo has no market data); the cost check button explains itself.
    isLive() ? priceCheck(item, () => { closeSheet(); setView('market'); }) : h('section', { class: 'price-check' }, costCheckButton(item)),
  ].filter(Boolean));
  showSheet();
}

/** Open the sheet on other content (the Browse filters). `children` replaces whatever it showed. */
export function showInSheet(children, labelledBy) {
  $('#sheetBody').replaceChildren(...children.filter(Boolean));
  $('#sheet').setAttribute('aria-labelledby', labelledBy ?? 'sheetTitle');
  showSheet();
}

/** What had keyboard focus when the sheet opened (a card's title, the Filters button): see dismissSheet. */
let opener = null;

function showSheet() {
  const sheet = $('#sheet');
  // Opening never moves focus. Remember where it is (not on a redraw of an open sheet: Filters redraws on each tap).
  if (sheet.hidden) {
    const was = document.activeElement;
    opener = was && was !== document.body && !sheet.contains(was) ? was : null;
  }
  sheet.hidden = false;
  sheet.scrollTop = 0;
  $('#sheetBackdrop').hidden = false;
}

/**
 * Close the sheet from the sheet itself: its Close button, the dim strip above it, Escape (main.js wires all three
 * here). If focus was inside the sheet (the Close button, or a Tab into it), it goes back to what opened the sheet
 * while that is still on the page, so it is never left on a hidden element. Focus outside the sheet stays put.
 */
export function dismissSheet() {
  const sheet = $('#sheet');
  if (sheet.hidden) return;
  const inside = sheet.contains(document.activeElement);
  close();
  if (inside && opener?.isConnected) opener.focus({ preventScroll: true });
  opener = null;
}

export const closeSheet = close;
export const sheetOpen = isSheetOpen;
