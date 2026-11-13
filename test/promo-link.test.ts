import { describe, expect, it } from 'vitest';

// web/js is plain JavaScript with no type declarations; a computed path keeps tsc from asking for them.
const modulePath = '../web/js/promo-link.js';
const { takePromoFromSearch } = (await import(modulePath)) as {
  takePromoFromSearch: (search: string) => { code: string; rest: string } | null;
};

describe('reading ?promo= from a link (web/js/promo-link.js)', () => {
  it('keeps an unencoded "&" inside the code, and leaves nothing of it in the address bar', () => {
    // URLSearchParams would read promo = "A" and leave "?Btest=" behind (a real bug, seen in the browser).
    expect(takePromoFromSearch('?promo=A&Btest')).toEqual({ code: 'A&Btest', rest: '' });
  });
  it('reads an encoded link the same way', () => {
    expect(takePromoFromSearch('?promo=A%26Btest')).toEqual({ code: 'A&Btest', rest: '' });
  });
  it('stops at the next name=value pair and keeps the other keys', () => {
    expect(takePromoFromSearch('?promo=A&Btest&bid=x')).toEqual({ code: 'A&Btest', rest: '?bid=x' });
    expect(takePromoFromSearch('?promo=TEST-NOPE&bid=x')).toEqual({ code: 'TEST-NOPE', rest: '?bid=x' });
    expect(takePromoFromSearch('?bid=x&promo=A&Btest')).toEqual({ code: 'A&Btest', rest: '?bid=x' });
    expect(takePromoFromSearch('?view=browse&promo=TEST-1&bid=x')).toEqual({ code: 'TEST-1', rest: '?view=browse&bid=x' });
  });
  it('no promo key → null; a broken % escape stays as typed; + is a space', () => {
    expect(takePromoFromSearch('?bid=x')).toBeNull();
    expect(takePromoFromSearch('')).toBeNull();
    expect(takePromoFromSearch('?promo=TEST%ZZ')).toEqual({ code: 'TEST%ZZ', rest: '' });
    expect(takePromoFromSearch('?promo=TEST+CODE')).toEqual({ code: 'TEST CODE', rest: '' });
  });
});
