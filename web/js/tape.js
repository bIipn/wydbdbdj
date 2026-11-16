// The market tape: the strip of price moves that scrolls across the top of Home (index.html #tape).
// STUB: the tape builder fills this file. The shell calls paintTape(show) on every render.

/** Show or hide the tape and keep its content current. Never throws; with nothing honest to show it stays hidden. */
export function paintTape(_show) {
  const el = document.getElementById('tape');
  if (el) el.hidden = true;
}
