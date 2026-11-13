import * as cheerio from 'cheerio';

/** Collapse whitespace (incl. &nbsp;) into single spaces and trim. */
export function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Undo one leftover layer of HTML escaping. Some boards escape a value twice: NGEM serves
 * "Customer Portal &amp;amp; AMI Technology", which reads "Customer Portal &amp; AMI Technology" even
 * in a browser. Call it on text that has already been through the HTML parser once.
 */
export function unescapeLeftover(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
  return s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e: string) => named[e]!);
}

/** Empty string → null, otherwise the cleaned string. */
export function cleanOrNull(s: string | null | undefined): string | null {
  const c = clean(s);
  return c === '' ? null : c;
}

/** Some boards cut long values off with "...". Strip the dots and tell the caller. */
export function untruncate(s: string | null | undefined): { text: string; truncated: boolean } {
  const c = clean(s);
  const m = /(?:\.{3}|…)$/.exec(c);
  return m ? { text: c.slice(0, m.index).trim(), truncated: true } : { text: c, truncated: false };
}

/** HTML fragment → readable plain text that keeps line breaks from <br> and <p>. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  const $ = cheerio.load(`<div id="__root">${html}</div>`);
  $('br').replaceWith('\n');
  $('p, div, li, tr').each((_, el) => {
    $(el).append('\n');
  });
  const text = $('#__root').text();
  return text
    .split('\n')
    .map((line) => clean(line))
    .filter((line, i, arr) => line !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim();
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** "jobs_peak_w_t_p_p_l_c_replacement_project" → "Jobs Peak WTP PLC Replacement Project" */
export function humanizeSlug(slug: string): string {
  // CivicLive spells acronyms as single letters separated by underscores: w_t_p → WTP
  const collapsed = slug.replace(/(?:^|_)((?:[a-z]_){1,}[a-z])(?=_|$)/gi, (m, letters: string) => {
    const lead = m.startsWith('_') ? '_' : '';
    return lead + letters.replace(/_/g, '').toUpperCase();
  });
  return collapsed
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => (w === w.toUpperCase() && w.length > 1 ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

export function slugify(s: string): string {
  return clean(s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "GENERAL SERVICES ADMINISTRATION" → "General Services Administration" (keeps short acronyms). */
export function titleCaseIfShouting(s: string): string {
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .split(' ')
    .map((w) => (w.length <= 3 && /^[a-z]+$/.test(w) && !['of', 'the', 'and', 'for'].includes(w) ? w.toUpperCase() : w))
    .map((w, i) => (['of', 'the', 'and', 'for'].includes(w) && i > 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
