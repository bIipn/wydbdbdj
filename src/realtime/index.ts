import type { RouteContext } from '../context.js';

/**
 * Starts everything that reacts to bus events or the clock (alert rules, push sender, deadline
 * reminders, price watcher). main() calls it once after the server is listening and calls the
 * returned function on shutdown; tests call it only when they want it running.
 *
 * STUB (foundation): starts nothing.
 */
export function startRealtime(_ctx: RouteContext): () => void {
  return () => {};
}
