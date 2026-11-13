// Money and rates from the cost engine. The API sends integer cents and integer parts per million;
// these only turn them into text (string and BigInt work), never float arithmetic on money.

const groups = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 2767497 → "$27,674.97"; null → "—". `whole` drops the cents only when they are exactly zero. */
export function usd(cents, { whole = false } = {}) {
  if (cents == null || !Number.isSafeInteger(cents)) return '—';
  const neg = cents < 0;
  const s = String(Math.abs(cents)).padStart(3, '0');
  const dollars = groups(s.slice(0, -2));
  const frac = s.slice(-2);
  return `${neg ? '−' : ''}$${dollars}${whole && frac === '00' ? '' : `.${frac}`}`;
}

/** a − b in cents, exactly (BigInt), for a line the API gives only as two totals (burden = L − G). */
export function minus(a, b) {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
  const d = BigInt(a) - BigInt(b);
  return Number(d);
}

/** a + b in cents, exactly. */
export function plus(a, b) {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
  return Number(BigInt(a) + BigInt(b));
}

/** 62000 ppm → "6.2%". */
export function pct(ppm) {
  if (ppm == null || !Number.isSafeInteger(ppm)) return '—';
  const s = String(Math.abs(ppm)).padStart(5, '0');
  const frac = s.slice(-4).replace(/0+$/, '');
  return `${ppm < 0 ? '−' : ''}${groups(s.slice(0, -4))}${frac ? `.${frac}` : ''}%`;
}

/** 16800 hundredths of an hour → "168 h". */
export function hoursC(h) {
  if (h == null || !Number.isSafeInteger(h)) return '—';
  const s = String(h).padStart(3, '0');
  const frac = s.slice(-2).replace(/0+$/, '');
  return `${groups(s.slice(0, -2))}${frac ? `.${frac}` : ''} h`;
}

/** A dated default's value in its own unit (sources list). */
export function unitValue(value, unit) {
  if (typeof value !== 'number') return String(value);
  switch (unit) {
    case 'ppm': return pct(value);
    case 'cents': return usd(value, { whole: true });
    case 'days': return `${value} day${value === 1 ? '' : 's'}`;
    case 'months': return `${value} month${value === 1 ? '' : 's'}`;
    case 'hoursC': return hoursC(value);
    case 'factor': return String(value);
    default: return String(value);
  }
}

/** Engine text can say "9000000 cents": show those as dollars. */
export const centsInText = (text) => String(text ?? '').replace(/\b(\d+) cents\b/g, (_m, n) => usd(Number(n)));
