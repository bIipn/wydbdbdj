import type { FeedItem, Profile, Reason } from '../types.js';
import { formatRange } from '../util/money.js';
import { pacificParts } from '../util/time.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dueLabel(iso: string | null, now = new Date()): string {
  if (!iso) return 'No deadline listed';
  const d = new Date(iso);
  const p = pacificParts(d);
  const days = Math.floor((d.getTime() - now.getTime()) / 86_400_000);
  const h12 = ((p.h + 11) % 12) + 1;
  const time = `${h12}:${String(p.mi).padStart(2, '0')} ${p.h < 12 ? 'AM' : 'PM'}`;
  const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  return `Due ${when} · ${MONTHS[p.mo - 1]} ${p.d}, ${time} PT`;
}

const VERDICT_COLOR: Record<string, string> = { great: '#16a34a', good: '#65a30d', maybe: '#ca8a04', skip: '#6b7280' };

const MARK: Record<Reason['kind'], { sign: string; color: string }> = {
  plus: { sign: '✓', color: '#166534' },
  minus: { sign: '✗', color: '#b91c1c' },
  info: { sign: '•', color: '#4b5563' },
};

/**
 * The reasons an email card shows: the first 3 positives, then every caveat (minus) and every note (info),
 * the same lines the app card shows, so a set-aside or "may be a purchase" is never hidden behind the ticks.
 */
export function digestReasons(reasons: readonly Reason[]): Reason[] {
  return [...reasons.filter((r) => r.kind === 'plus').slice(0, 3), ...reasons.filter((r) => r.kind === 'minus'), ...reasons.filter((r) => r.kind === 'info')];
}

/** "3 new matches within 90 mi of Gardnerville, NV", but only when every card has a known distance. */
export function digestHeadline(profile: Profile, items: readonly FeedItem[]): string {
  const n = items.length;
  const matches = `${n} new match${n === 1 ? '' : 'es'}`;
  const unplaced = items.filter((b) => b.distanceMi == null).length;
  if (unplaced === 0) return `${matches} within ${profile.maxDistanceMi} mi of ${profile.base.label}`;
  return `${matches} (${unplaced === n ? (n === 1 ? 'distance not known' : 'none with a known distance') : `${unplaced} with no known distance`})`;
}

export interface Digest {
  subject: string;
  html: string;
  text: string;
}

export function buildDigest(profile: Profile, items: FeedItem[], appUrl: string, now = new Date()): Digest {
  const n = items.length;
  const subject = `${n} new bid${n === 1 ? '' : 's'} for ${profile.name}${items[0] ? ` — top: ${items[0].title.slice(0, 60)}` : ''}`;

  const cards = items
    .map((b) => {
      const lines = digestReasons(b.reasons);
      const meta = [b.agency, b.location.label, b.distanceMi != null ? `${b.distanceMi} mi` : null, b.estValue ? `Est. ${formatRange(b.estValue)}` : null]
        .filter(Boolean)
        .map((s) => esc(String(s)))
        .join(' · ');
      return `
      <tr><td style="padding:14px 16px;border-bottom:1px solid #e5e7eb">
        <div style="font:600 12px system-ui,sans-serif;color:${VERDICT_COLOR[b.verdict]};text-transform:uppercase;letter-spacing:.04em">
          ${b.score} · ${esc(b.verdict)} fit · ${esc(b.sourceName)}</div>
        <div style="font:600 16px system-ui,sans-serif;color:#111827;margin:4px 0">${esc(b.title)}</div>
        <div style="font:13px system-ui,sans-serif;color:#4b5563">${meta}</div>
        <div style="font:13px system-ui,sans-serif;color:#111827;margin:6px 0">${esc(dueLabel(b.dueAt, now))}</div>
        ${lines.length ? `<div style="font:13px system-ui,sans-serif;line-height:1.45">${lines.map((r) => `<span style="color:${MARK[r.kind].color}">${MARK[r.kind].sign} ${esc(r.text)}</span>`).join('<br>')}</div>` : ''}
        <div style="margin-top:10px"><a href="${esc(b.url)}" style="font:600 13px system-ui,sans-serif;color:#1d4ed8">Open bid on ${esc(b.sourceName)} →</a></div>
      </td></tr>`;
    })
    .join('');

  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;padding:24px">
  <table role="presentation" width="100%" style="max-width:620px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border-collapse:collapse">
    <tr><td style="padding:18px 16px;background:#0b0f14;color:#fff">
      <div style="font:700 18px system-ui,sans-serif">⚡ BidSwipe — ${esc(profile.name)}</div>
      <div style="font:13px system-ui,sans-serif;color:#9ca3af;margin-top:2px">${esc(digestHeadline(profile, items))}</div>
    </td></tr>
    ${cards || '<tr><td style="padding:16px;font:14px system-ui,sans-serif">No new matches today.</td></tr>'}
    <tr><td style="padding:16px;font:13px system-ui,sans-serif;color:#6b7280">
      <a href="${esc(appUrl)}" style="color:#1d4ed8">Swipe through everything in the app →</a><br>
      Scores are a first pass — always read the bid documents before you price a job.
    </td></tr>
  </table></body></html>`;

  const text = [
    `BidSwipe — ${profile.name}: ${digestHeadline(profile, items)}`,
    '',
    ...items.map((b) =>
      [
        `[${b.score} ${b.verdict}] ${b.title}`,
        `  ${[b.agency, b.location.label, b.distanceMi != null ? `${b.distanceMi} mi` : null].filter(Boolean).join(' · ')}`,
        `  ${dueLabel(b.dueAt, now)}`,
        ...digestReasons(b.reasons).map((r) => `  ${MARK[r.kind].sign} ${r.text}`),
        `  ${b.url}`,
      ].join('\n'),
    ),
    '',
    `App: ${appUrl}`,
  ].join('\n');

  return { subject, html, text };
}
