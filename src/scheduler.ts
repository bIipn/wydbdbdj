import { pacificParts, zonedToUtc } from './util/time.js';

/** Next time it's HH:MM in Pacific time, strictly after `from`. DST-safe. `setting` names the variable in the error. */
export function nextDailyRun(hhmm: string, from = new Date(), setting = 'SCAN_DAILY_AT'): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`${setting} must look like 06:15, got "${hhmm}"`);
  const [h, mi] = [Number(m[1]), Number(m[2])];
  const today = pacificParts(from);
  let run = atWallClock(today.y, today.mo, today.d, h, mi);
  if (run.getTime() <= from.getTime()) {
    // Tomorrow on the Pacific calendar (a calendar step, never a fixed number of hours: a run at
    // 22:00 or later plus 26 h would land two days on), then re-anchor to the wall-clock time.
    const t = new Date(Date.UTC(today.y, today.mo - 1, today.d + 1));
    run = atWallClock(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), h, mi);
  }
  return run;
}

/**
 * `h:mi` Pacific on that date as a UTC instant. A time inside the spring-forward gap (02:xx on the
 * March change day) does not exist; it runs at the same minutes one hour later (03:xx PDT), never
 * an hour early.
 */
function atWallClock(y: number, mo: number, d: number, h: number, mi: number): Date {
  const run = zonedToUtc(y, mo, d, h, mi);
  const p = pacificParts(run);
  return p.h !== h || p.mi !== mi ? (p.h < h || (p.h === h && p.mi < mi) ? new Date(run.getTime() + 3_600_000) : run) : run;
}

/**
 * Runs `job` every day at `hhmm` Pacific. In-process on purpose: with the embedded
 * database only one process may open it, so the server owns the API, the scan and the market refresh.
 * `what` names the job in the log ("scan", "market refresh"). A job that throws is logged and the next day is armed.
 */
export function scheduleDaily(hhmm: string, job: () => Promise<void>, log = console.log, what = 'scan'): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    const next = nextDailyRun(hhmm);
    log(`[scheduler] next ${what} ${next.toISOString()} (${hhmm} Pacific)`);
    // setTimeout tops out around 24.8 days; a day is fine.
    timer = setTimeout(async () => {
      try {
        await job();
      } catch (err) {
        log(`[scheduler] ${what} failed: ${err instanceof Error ? err.stack : String(err)}`);
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
