// Closing the detail sheet, on its own so a module the sheet itself imports (parts.js → jobs-data.js) can close
// it without an import cycle. sheet.js hands these on unchanged.

import { $ } from './dom.js';

export function closeSheet() {
  if ($('#sheet').hidden) return;
  $('#sheet').setAttribute('aria-labelledby', 'sheetTitle');
  $('#sheet').hidden = true;
  $('#sheetBackdrop').hidden = true;
}

export const sheetOpen = () => !$('#sheet').hidden;
