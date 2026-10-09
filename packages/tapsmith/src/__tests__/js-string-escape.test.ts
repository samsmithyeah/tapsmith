import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { escapeJsString, unescapeJsString } from '../js-string-escape.js';

describe('escapeJsString / unescapeJsString (PILOT-659)', () => {
  it.each([
    ['plain', 'Sign in'],
    ['quotes and backslashes', 'Say "hi" C:\\new'],
    ['line breaks and tabs', 'a\nb\r\tc'],
    ['BMP icon glyph', '\uE865, Library'],
    ['astral icon glyph', `${String.fromCodePoint(0xF0001)}, Library`],
    ['no-break and thin spaces', 'Pay\u00A0now\u2009ok'],
    ['bidi and zero-width marks', '\u200Eabc\u200Bdef\uFEFF'],
    ['lone surrogate', 'cut \uD83D'],
    ['visible symbols and emoji', 'T, ✓, Tester 👩‍💻 café 日本'],
  ])('round-trips %s', (_label, raw) => {
    const escaped = escapeJsString(raw);
    expect(unescapeJsString(escaped)).toBe(raw);
    // JavaScript reads the escape back to the same value.
    expect(runInNewContext(`"${escaped}"`)).toBe(raw);
  });

  it('writes copy-unsafe characters as \\u escapes and keeps visible text raw', () => {
    expect(escapeJsString('\uE865, Library')).toBe('\\uE865, Library');
    expect(escapeJsString(String.fromCodePoint(0xF0001))).toBe('\\u{F0001}');
    expect(escapeJsString('a\u00A0b')).toBe('a\\u00A0b');
    expect(escapeJsString('👩‍💻 ✓')).toBe('👩‍💻 ✓');
  });

  it('reads an unknown escape as the character itself and leaves an out-of-range code point alone', () => {
    expect(unescapeJsString('\\x\\q')).toBe('xq');
    expect(unescapeJsString('\\u{110000}')).toBe('\\u{110000}');
    expect(unescapeJsString('\\u12')).toBe('u12');
  });
});
