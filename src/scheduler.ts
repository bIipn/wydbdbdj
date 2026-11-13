import { pacificParts, zonedToUtc } from './util/time.js';

/** Next time it's HH:MM in Pacific time, strictly after `from`. DST-safe. */
export function nextDailyRun(hhmm: string, from = new Date()): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`SCAN_DAILY_AT must look like 06:15, got "${hhmm}"`);
  const [h, mi] = [Number(m[1]), Number(m[2])];
  const today = pacificParts(from);
  let run = zonedToUtc(today.y, today.mo, today.d, h, mi);
  if (run.getTime() <= from.getTime()) {
    // Tomorrow in Pacific terms: step a calendar day, then re-anchor to the wall-clock time.
    const t = pacificParts(new Date(run.getTime() + 26 * 3_600_000));
    run = zonedToUtc(t.y, t.mo, t.d, h, mi);
  }
  return run;
}

/**
 * Runs `job` every day at `hhmm` Pacific. In-process on purpose: with the embedded
 * database only one process may open it, so the server owns both the API and the scan.
 */
export function scheduleDaily(hhmm: string, job: () => Promise<void>, log = console.log): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    const next = nextDailyRun(hhmm);
    log(`[scheduler] next scan ${next.toISOString()} (${hhmm} Pacific)`);
    // setTimeout tops out around 24.8 days; a day is fine.
    timer = setTimeout(async () => {
      try {
        await job();
      } catch (err) {
        log(`[scheduler] scan failed: ${err instanceof Error ? err.stack : String(err)}`);
      }
      arm();
    }, next.getTime() - Date.now());
  };
  arm();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
