import { describe, expect, it } from 'vitest';

// web/js is plain JavaScript with no type declarations; a computed path keeps tsc from asking for them.
// Everything here is synthetic (TEST- ids, made-up names and titles).
const modulePath = '../web/js/messages-model.js';
type Conv = Record<string, unknown>;
const m = (await import(modulePath)) as {
  sortConversations: (l: unknown) => Conv[];
  unreadCount: (l: unknown) => number;
  tabLabel: (n: number) => string;
  otherName: (c: unknown) => string;
  previewLine: (c: unknown) => string;
  listTime: (iso: string, now?: number) => string;
  fullTime: (iso: string) => string;
  cannotWriteSentence: (c: unknown, now?: number) => string | null;
  emptyThreadLine: (c: unknown) => string;
  newestId: (m: unknown) => number;
  markedRead: (l: Conv[], id: string) => Conv[];
  mustMarkRead: (msgs: unknown, fresh: unknown, seen?: number) => boolean;
  EMPTY_LINE: string;
};

const NOW = Date.parse('2026-11-16T20:00:00Z'); // Mon Nov 16, 12:00 PM Pacific
const conv = (over: Conv = {}): Conv => ({
  jobId: 'TEST-1', title: 'TEST job (simulated)', role: 'poster', status: 'awarded', outcome: null,
  contactDeadline: '2026-11-20T20:00:00.000Z', other: { id: 'TEST-a', name: 'TEST Sparky (simulated)' },
  canWrite: true, messageCount: 0, last: null, unread: false, activityAt: '2026-11-16T19:00:00.000Z', ...over,
});

describe('the list', () => {
  it('orders by newest activity first, ties by job id, and never mutates its input', () => {
    const list = [
      conv({ jobId: 'TEST-b', activityAt: '2026-11-15T10:00:00Z' }),
      conv({ jobId: 'TEST-c', activityAt: '2026-11-16T10:00:00Z' }),
      conv({ jobId: 'TEST-a', activityAt: '2026-11-15T10:00:00Z' }),
    ];
    expect(m.sortConversations(list).map((c) => c.jobId)).toEqual(['TEST-c', 'TEST-a', 'TEST-b']);
    expect(list[0]!.jobId).toBe('TEST-b');
    expect(m.sortConversations(null)).toEqual([]);
  });

  it('the badge counts conversations with something unread, not messages', () => {
    expect(m.unreadCount([conv({ unread: true, messageCount: 5 }), conv({ unread: false }), conv({ unread: true })])).toBe(2);
    expect(m.unreadCount(undefined)).toBe(0);
    expect(m.tabLabel(0)).toBe('Messages');
    expect(m.tabLabel(1)).toBe('Messages: 1 conversation with something new');
    expect(m.tabLabel(3)).toBe('Messages: 3 conversations with something new');
  });

  it('the preview line: one line, "You: " for my own, "No messages yet" when none', () => {
    expect(m.previewLine(conv())).toBe('No messages yet');
    expect(m.previewLine(conv({ last: { preview: 'See you\n  Thursday', at: '', mine: false } }))).toBe('See you Thursday');
    expect(m.previewLine(conv({ last: { preview: 'On my way', at: '', mine: true } }))).toBe('You: On my way');
  });

  it('the other side by name only, with a plain fallback', () => {
    expect(m.otherName(conv())).toBe('TEST Sparky (simulated)');
    expect(m.otherName(conv({ other: { id: 'x', name: '  ' } }))).toBe('BidSwipe member');
  });

  it('list times on the Pacific calendar', () => {
    expect(m.listTime('2026-11-16T18:41:00Z', NOW)).toBe('10:41 AM');
    expect(m.listTime('2026-11-16T07:30:00Z', NOW)).toBe('Yesterday'); // Nov 15, 11:30 PM Pacific
    expect(m.listTime('2026-11-12T20:00:00Z', NOW)).toBe('Thu');
    expect(m.listTime('2026-10-03T20:00:00Z', NOW)).toBe('Oct 3');
    expect(m.listTime('2025-10-03T20:00:00Z', NOW)).toBe('Oct 3, 2025');
    expect(m.listTime('nope', NOW)).toBe('');
    expect(m.fullTime('2026-11-16T18:41:00Z')).toBe('Monday, November 16 at 10:41 AM');
  });

  it('marking one conversation read leaves the others alone', () => {
    const list = [conv({ jobId: 'TEST-a', unread: true }), conv({ jobId: 'TEST-b', unread: true })];
    expect(m.markedRead(list, 'TEST-a').map((c) => c.unread)).toEqual([false, true]);
    expect(list[0]!.unread).toBe(true);
  });

  it('the empty tab says when conversations appear', () => {
    expect(m.EMPTY_LINE).toMatch(/awarded/);
    expect(m.EMPTY_LINE).toMatch(/only between the poster and the winner/);
  });
});

describe('the conversation', () => {
  it('no sentence while writing is allowed', () => {
    expect(m.cannotWriteSentence(conv(), NOW)).toBeNull();
  });

  it('one plain sentence when it is not', () => {
    expect(m.cannotWriteSentence(conv({ canWrite: false, status: 'completed' }), NOW)).toMatch(/^This job is done\./);
    expect(m.cannotWriteSentence(conv({ canWrite: false, status: 'cancelled' }), NOW)).toMatch(/^This job was cancelled\./);
    expect(m.cannotWriteSentence(conv({ canWrite: false, status: 'unfilled', contactDeadline: '2026-11-10T20:00:00Z' }), NOW))
      .toBe('The contact window closed on Nov 10. No new messages can be sent.');
    expect(m.cannotWriteSentence(conv({ canWrite: false, status: 'awarded', contactDeadline: '2026-11-16T19:00:00Z' }), NOW))
      .toBe('The contact window closed on Nov 16. No new messages can be sent.');
    expect(m.cannotWriteSentence(conv({ canWrite: false, status: 'unfilled', contactDeadline: null }), NOW))
      .toBe('The contact window has closed. No new messages can be sent.');
  });

  it('the empty thread says who writes first and what the first message counts for', () => {
    expect(m.emptyThreadLine(conv({ role: 'winner' }))).toMatch(/counts as making contact/);
    expect(m.emptyThreadLine(conv({ role: 'poster' }))).toBe('No messages yet. The winner writes first, or you can.');
    expect(m.emptyThreadLine(conv({ canWrite: false }))).toBe('No messages were sent on this job.');
  });

  it('the newest message id the screen showed', () => {
    expect(m.newestId([{ id: 3 }, { id: 9 }, { id: 4 }])).toBe(9);
    expect(m.newestId([])).toBe(0);
    expect(m.newestId(null)).toBe(0);
  });

  it('marks read from the messages on screen, never from an older cached list', () => {
    const msgs = [{ id: 1, mine: true }, { id: 2, mine: false }];
    // the server's own answer with these messages says unread: tell it, whatever the list thought
    expect(m.mustMarkRead(msgs, { unread: true })).toBe(true);
    expect(m.mustMarkRead(msgs, { unread: false })).toBe(false);
    // no fresh answer (the job page): the other side's newest above what this device marked
    expect(m.mustMarkRead(msgs, null, 0)).toBe(true);
    expect(m.mustMarkRead(msgs, null, 2)).toBe(false);
    // only my own messages: nothing to read
    expect(m.mustMarkRead([{ id: 5, mine: true }], null, 0)).toBe(false);
  });
});
