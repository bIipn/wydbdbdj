/**
 * Sending one email (Resend), for mail the app owes a person: today the password reset link.
 * It is OFF unless RESEND_API_KEY and a from-address are set; mailerFromEnv() then returns null and every
 * caller has to say so on screen. Nothing here ever pretends an email went out: send() resolves only after
 * the delivery service accepted the message, and throws otherwise.
 */

export interface Email {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  /** Resolves once the delivery service has accepted the email. Throws when it did not. */
  send(email: Email): Promise<void>;
}

export interface ResendOptions {
  apiKey: string;
  /** "BidSwipe <hello@yourdomain.com>": an address on a domain verified with the delivery service. */
  from: string;
  /** Injectable for tests. Default: the real fetch. */
  fetch?: typeof fetch;
}

/** The error carries the HTTP status only: never the key, the recipient or the message. */
export class EmailError extends Error {
  constructor(public readonly status: number) {
    super(`the email service answered ${status}`);
    this.name = 'EmailError';
  }
}

export function resendMailer(opts: ResendOptions): Mailer {
  const post = opts.fetch ?? fetch;
  return {
    async send(email) {
      const res = await post('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: opts.from, to: [email.to], subject: email.subject, html: email.html, text: email.text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new EmailError(res.status);
    },
  };
}

/**
 * The mailer the environment configures, or null when email is off. EMAIL_FROM is the sender for mail to
 * account holders; DIGEST_FROM (the pilot's digest sender) is used when it is not set. APP_URL must be set too:
 * the reset email carries a link to this app, and without it that link would point at localhost.
 */
export function mailerFromEnv(env: (name: string) => string | undefined, log: (msg: string) => void = () => {}): Mailer | null {
  const apiKey = env('RESEND_API_KEY');
  const from = env('EMAIL_FROM') ?? env('DIGEST_FROM');
  if (!apiKey || !from) return null;
  if (!env('APP_URL')) {
    log('email to account holders is off: RESEND_API_KEY is set but APP_URL is not, and a reset link has to point at this app');
    return null;
  }
  return resendMailer({ apiKey, from });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The reset email. The token rides in the link's FRAGMENT (#reset=…): a browser never sends that part to a
 * server, so the token cannot land in a request log, on our host or on anything in between.
 */
export function resetEmail(input: { to: string; appUrl: string; token: string; minutes: number }): Email {
  const link = `${input.appUrl}/#reset=${input.token}`;
  const life = `${input.minutes} minutes`;
  const text = [
    'Someone asked to reset the password of the BidSwipe account with this email address.',
    '',
    `Choose a new password here (the link works once, for ${life}):`,
    link,
    '',
    'If that was not you, ignore this email. Your password stays as it is.',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;padding:24px">
  <table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border-collapse:collapse">
    <tr><td style="padding:18px 20px;background:#0b0f14;color:#fff;font:700 18px system-ui,sans-serif">BidSwipe</td></tr>
    <tr><td style="padding:20px;font:15px/1.5 system-ui,sans-serif;color:#111827">
      <p style="margin:0 0 14px">Someone asked to reset the password of the BidSwipe account with this email address.</p>
      <p style="margin:0 0 18px"><a href="${esc(link)}" style="display:inline-block;background:#ffd43b;color:#0a0d12;font-weight:700;text-decoration:none;border-radius:10px;padding:11px 18px">Choose a new password</a></p>
      <p style="margin:0 0 14px;color:#4b5563;font-size:13px">The link works once, for ${life}.</p>
      <p style="margin:0;color:#4b5563;font-size:13px">If that was not you, ignore this email. Your password stays as it is.</p>
    </td></tr>
  </table></body></html>`;
  return { to: input.to, subject: 'Reset your BidSwipe password', html, text };
}
