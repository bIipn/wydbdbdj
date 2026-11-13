/**
 * Date helpers. Every bid board here lists times in Pacific time with no offset,
 * so we convert "wall clock in Los Angeles" → UTC ourselves (DST-aware, no deps).
 */
export const PACIFIC = 'America/Los_Angeles';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Offset of `timeZone` from UTC at `date`, in minutes (e.g. -480 for PST, -420 for PDT). */
export function tzOffsetMinutes(date: Date, timeZone = PACIFIC): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(date);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** Wall-clock time in `timeZone` → the real instant (Date). */
export function zonedToUtc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, timeZone = PACIFIC): Date {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = tzOffsetMinutes(new Date(asUtc), timeZone);
  let instant = asUtc - first * 60_000;
  const second = tzOffsetMinutes(new Date(instant), timeZone);
  if (second !== first) instant = asUtc - second * 60_000; // we crossed a DST boundary
  return new Date(instant);
}

function to24h(hour: number, ampm: string | undefined): number {
  if (!ampm) return hour;
  const pm = ampm.toLowerCase().startsWith('p');
  if (hour === 12) return pm ? 12 : 0;
  return pm ? hour + 12 : hour;
}

function valid(y: number, mo: number, d: number): boolean {
  return y > 1990 && y < 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
}

export interface ParseOpts {
  timeZone?: string;
  /** Used when the string has a date but no time, as [hour, minute]. Default 5:00 PM. */
  defaultTime?: [number, number];
}

/**
 * Parses the date formats the boards use:
 *   "12/08/2026 2:00 PM", "11/12/2026 11:00:00 AM (PT)", "11/17/2026 10:30 AM PST",
 *   "11/4/2026", "2026/11/20", "2026-11-02", and full ISO strings with an offset.
 * Returns ISO-8601 UTC, or null if nothing parseable is found.
 */
export function parseUsDateTime(input: string | null | undefined, opts: ParseOpts = {}): string | null {
  if (!input) return null;
  const s = input.trim();
  const timeZone = opts.timeZone ?? PACIFIC;
  const [dh, dm] = opts.defaultTime ?? [17, 0];

  // Full ISO with an explicit offset or Z — trust it.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }

  const time = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i.exec(s) ?? /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/.exec(s);
  const hm = (): [number, number, number] =>
    time ? [to24h(Number(time[1]), time[4]), Number(time[2]), Number(time[3] ?? 0)] : [dh, dm, 0];

  let m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); // M/D/YYYY
  if (m) {
    const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!valid(y, mo, d)) return null;
    const [h, mi, sec] = hm();
    return zonedToUtc(y, mo, d, h, mi, sec, timeZone).toISOString();
  }
  m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(s); // YYYY/MM/DD or YYYY-MM-DD
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!valid(y, mo, d)) return null;
    const [h, mi, sec] = hm();
    return zonedToUtc(y, mo, d, h, mi, sec, timeZone).toISOString();
  }
  return parseLongDate(s, opts);
}

const LONG_DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i;
const CLOCK = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i;

/** "Thursday, July 30, 2026" (+ optional "2:00 p.m.") → ISO. */
export function parseLongDate(s: string, opts: ParseOpts = {}): string | null {
  const m = LONG_DATE.exec(s);
  if (!m) return null;
  const mo = MONTHS[m[1]!.toLowerCase().slice(0, 3)];
  const d = Number(m[2]);
  const y = Number(m[3]);
  if (!mo || !valid(y, mo, d)) return null;
  const c = CLOCK.exec(s);
  const [dh, dm] = opts.defaultTime ?? [17, 0];
  const h = c ? to24h(Number(c[1]), c[3]) : dh;
  const mi = c ? Number(c[2] ?? 0) : dm;
  return zonedToUtc(y, mo, d, h, mi, 0, opts.timeZone ?? PACIFIC).toISOString();
}

const T = String.raw`(\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\.?)`;
const D = String.raw`((?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})`;
const WD = String.raw`(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day,?\s+)?`;

const DUE_PATTERNS: Array<{ re: RegExp; time: number; date: number }> = [
  // "until 2:00 p.m. local time on Thursday, July 30, 2026"
  { re: new RegExp(String.raw`(?:until|before|by|no later than|on or before)\s+${T}[^.]{0,40}?\bon\s+${WD}${D}`, 'i'), time: 1, date: 2 },
  // "Bid end date: August 5, 2025 at 10:00am" / "Bids are due February 10, 2026 at 2 pm"
  { re: new RegExp(String.raw`(?:end date|due date|due|closing date|deadline|received)[:\s]+(?:on\s+)?${WD}${D}(?:,?\s*(?:at|@|by)\s*${T})?`, 'i'), time: 2, date: 1 },
  // "on or before 10:00am February 29, 2024"
  { re: new RegExp(String.raw`on or before\s+${T}\s*,?\s*${WD}${D}`, 'i'), time: 1, date: 2 },
];

/** Find the bid deadline inside free text like a legal ad. Returns ISO or null. */
export function findDueInText(text: string | null | undefined, opts: ParseOpts = {}): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ');
  for (const p of DUE_PATTERNS) {
    const m = p.re.exec(flat);
    if (!m) continue;
    const datePart = m[p.date];
    if (!datePart) continue;
    const timePart = m[p.time] ?? '';
    const iso = parseLongDate(`${datePart} ${timePart}`, opts);
    if (iso) return iso;
  }
  return null;
}

export function daysBetween(fromIso: string | Date, toIso: string | Date): number {
  const a = typeof fromIso === 'string' ? Date.parse(fromIso) : fromIso.getTime();
  const b = typeof toIso === 'string' ? Date.parse(toIso) : toIso.getTime();
  return (b - a) / 86_400_000;
}

/** "MM/dd/yyyy" in Pacific time — SAM.gov wants this format for postedFrom/postedTo. */
export function samDate(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('month')}/${get('day')}/${get('year')}`;
}

/** Wall-clock parts of an instant in Pacific time. */
export function pacificParts(d: Date): { y: number; mo: number; d: number; h: number; mi: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(d);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: n('year'), mo: n('month'), d: n('day'), h: n('hour'), mi: n('minute') };
}
