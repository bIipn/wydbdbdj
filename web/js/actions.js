// Swipes: save / pass / opened, with Undo. Shared by the deck, the lists and the detail sheet.

import { api } from './api.js';
import { $, showToast } from './dom.js';
import { render } from './shell.js';

/** Tell whoever cares (e.g. "Next up") that a swipe was stored or undone. */
const swiped = () => window.dispatchEvent(new CustomEvent('bidswipe:swiped'));

export async function setSwipe(item, action, message) {
  const before = item.swipe;
  item.swipe = action;
  showToast(message, async () => {
    item.swipe = before;
    render();
    try { before ? await api.swipe(item.id, before) : await api.undo(item.id); swiped(); } catch { showToast('Couldn’t undo — check your connection'); }
  });
  try {
    await api.swipe(item.id, action);
    swiped();
  } catch {
    item.swipe = before;
    render();
    showToast('Couldn’t save that swipe — check your connection');
  }
}

export function markOpened(item) {
  setSwipe(item, 'bid', 'Saved · bid page opened');
  setTimeout(render, 60);
}

/** Fly a card off screen and record the swipe. */
export function commit(item, action, el, dy) {
  const dir = action === 'pass' ? -1 : 1;
  el.style.transition = 'transform .3s ease-in, opacity .3s ease-in';
  el.style.transform = `translate(${dir * (window.innerWidth + 240)}px, ${dy * 0.2 + 30}px) rotate(${dir * 24}deg)`;
  el.style.opacity = '0';
  try { navigator.vibrate?.(8); } catch { /* not supported */ }
  setSwipe(item, action, action === 'pass' ? 'Passed' : 'Saved');
  setTimeout(render, 240);
}

/** Button / keyboard swipe on the current top card. */
export function fling(item, action) {
  const el = $('.card.is-top');
  if (!el || !item) return;
  $(action === 'pass' ? '.stamp.pass' : '.stamp.save', el).style.opacity = '1';
  commit(item, action, el, 0);
}
