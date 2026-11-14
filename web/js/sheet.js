// The detail sheet that slides up over any view.

import { setSwipe } from './actions.js';
import { $, h } from './dom.js';
import { VERDICT_LABEL } from './format.js';
import { bidLink, facts, localPill, reasonsList, scoreRing } from './parts.js';
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
  // replaceChildren() would print a null as the text "null": drop the parts this bid does not have.
  body.replaceChildren(...[
    h('div', { class: `card-head verdict-${item.verdict}` },
      h('div', { class: 'pills' },
        h('span', { class: 'pill verdict' }, VERDICT_LABEL[item.verdict] ?? item.verdict),
        localPill(item) ?? h('span', { class: 'pill' }, item.sourceName),
        item.overLimit ? h('span', { class: 'pill over' }, 'Over your limit') : null,
      ),
      scoreRing(item.score),
    ),
    h('h2', { id: 'sheetTitle' }, item.title),
    h('p', { class: 'agency' }, item.agency ?? ''),
    facts(item),
    item.overLimit ? h('p', { class: 'over-note' }, 'This job is bigger than the spend limits in your settings, so it stays out of your swipe deck.') : null,
    h('div', { class: `verdict-${item.verdict}` }, reasonsList(item)),
    item.description ? h('div', { class: 'desc' }, item.description) : null,
    actions,
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

function showSheet() {
  const sheet = $('#sheet');
  sheet.hidden = false;
  sheet.scrollTop = 0;
  $('#sheetBackdrop').hidden = false;
}

export const closeSheet = close;
export const sheetOpen = isSheetOpen;
