import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { textRegexValue, translateRegex, formatRegex, toJsRegExp } from '../text-regex.js';

/**
 * RegExp locators (PILOT-520). The SDK translates a JavaScript RegExp into a
 * pattern the device engines (ICU on both platforms) read with JavaScript's
 * semantics. The cases below are the conformance table: each is checked here
 * against JavaScript's own RegExp (the ground truth) and its translation is
 * pinned in `fixtures/regex-conformance.json`, which the Android agent's
 * TextMatchTest and the iOS agent's TextMatchTests replay through their real
 * regex engines. Regenerate the fixture after changing the translator with
 * `UPDATE_REGEX_FIXTURE=1 npx vitest run src/__tests__/text-regex.test.ts`.
 */

interface Case { source: string; flags: string; input: string; matches: boolean; why: string }

const CASES: Case[] = [
  // \s is JavaScript's whitespace set, Unicode spaces included.
  { source: 'Welcome to\\sExpo', flags: '', input: 'Welcome to Expo', matches: true, why: '\\s matches NBSP' },
  { source: 'Save\\sdraft', flags: '', input: 'Save draft', matches: true, why: '\\s matches a narrow no-break space' },
  { source: 'a\\sb', flags: '', input: 'a　b', matches: true, why: '\\s matches an ideographic space' },
  { source: 'a\\sb', flags: '', input: 'a﻿b', matches: true, why: '\\s matches U+FEFF' },
  { source: 'a\\sb', flags: '', input: 'a\u000Bb', matches: true, why: '\\s matches a vertical tab' },
  { source: 'a\\sb', flags: '', input: 'a\u0085b', matches: false, why: '\\s does not match NEL (not JS whitespace)' },
  { source: 'a\\Sb', flags: '', input: 'a b', matches: false, why: '\\S excludes NBSP' },
  { source: '[^\\s]', flags: '', input: ' ', matches: false, why: 'negated class of \\s' },
  { source: '[^\\S]', flags: '', input: ' ', matches: true, why: 'negated class of \\S matches whitespace' },
  { source: '^[^\\S]$', flags: '', input: 'a', matches: false, why: 'negated class of \\S rejects a letter' },
  { source: '[\\s\\d]+$', flags: '', input: '1 2', matches: true, why: 'class union of \\s and \\d' },
  // \d \w \b are ASCII, as in JavaScript.
  { source: '\\d', flags: '', input: '٣', matches: false, why: '\\d is ASCII-only' },
  { source: '\\d{3}', flags: '', input: 'a123', matches: true, why: '\\d with a quantifier' },
  { source: '\\w', flags: '', input: 'é', matches: false, why: '\\w is ASCII-only' },
  { source: '^\\W$', flags: '', input: 'é', matches: true, why: '\\W includes non-ASCII letters' },
  { source: '\\bcat\\b', flags: '', input: 'a cat sat', matches: true, why: 'word boundaries' },
  { source: '\\bcat\\b', flags: '', input: 'concat', matches: false, why: 'no boundary inside a word' },
  { source: 'caf\\b', flags: '', input: 'café', matches: true, why: '\\b treats non-ASCII letters as non-word' },
  { source: '\\Bat', flags: '', input: 'cat', matches: true, why: '\\B' },
  { source: '\\Bcat', flags: '', input: 'cat', matches: false, why: '\\B at a boundary' },
  // Flags.
  { source: '^welcome', flags: 'i', input: 'Welcome to Expo', matches: true, why: 'i flag' },
  { source: '^welcome', flags: '', input: 'Welcome to Expo', matches: false, why: 'case-sensitive by default' },
  { source: 'été', flags: 'i', input: 'ÉTÉ', matches: true, why: 'i flag folds non-ASCII letters' },
  { source: 'save', flags: 'gd', input: 'SAVE save', matches: true, why: 'g and d have no effect' },
  // Anchors and line terminators.
  { source: '^Expo', flags: '', input: 'Welcome to Expo', matches: false, why: '^ anchors at the start' },
  { source: 'Expo$', flags: '', input: 'Welcome to Expo\n', matches: false, why: '$ is the very end (no final-newline allowance)' },
  { source: '^Line two$', flags: '', input: 'Line one\nLine two', matches: false, why: 'anchors are input-wide without m' },
  { source: '^Line two$', flags: 'm', input: 'Line one\nLine two', matches: true, why: 'm flag anchors at lines' },
  { source: '^Line one$', flags: 'm', input: 'Line one\r\nLine two', matches: true, why: 'm flag: $ before CR' },
  { source: '^b', flags: 'm', input: 'a b', matches: true, why: 'm flag: ^ after LINE SEPARATOR' },
  { source: '^b', flags: 'm', input: 'a\u0085b', matches: false, why: 'm flag: NEL is not a line terminator' },
  { source: '^$', flags: '', input: '', matches: true, why: 'empty input' },
  { source: 'one.Line', flags: '', input: 'Line one\nLine', matches: false, why: '. excludes a line feed' },
  { source: 'a.c', flags: '', input: 'a c', matches: false, why: '. excludes LINE SEPARATOR' },
  { source: 'a.c', flags: '', input: 'a\u0085c', matches: true, why: '. matches NEL' },
  { source: 'one.Line', flags: 's', input: 'Line one\nLine', matches: true, why: 's flag: . matches a line feed' },
  // Annex B literals and escapes.
  { source: 'a{', flags: '', input: 'a{', matches: true, why: 'a lone { is literal' },
  { source: 'a{2}', flags: '', input: 'xaa', matches: true, why: 'a { quantifier' },
  { source: 'a{1,}b', flags: '', input: 'aaab', matches: true, why: 'open-ended quantifier' },
  { source: 'x{,2}', flags: '', input: 'x{,2}', matches: true, why: '{,n} is literal' },
  { source: 'a}]', flags: '', input: 'a}]', matches: true, why: 'lone } and ] are literal' },
  { source: '\\a\\e\\z', flags: '', input: 'aez', matches: true, why: 'identity escapes of letters' },
  { source: '\\8', flags: '', input: '8', matches: true, why: '\\8 with no groups is a literal 8' },
  { source: '\\101', flags: '', input: 'A', matches: true, why: 'legacy octal escape' },
  { source: '\\0', flags: '', input: 'a\u0000', matches: true, why: '\\0 is NUL' },
  { source: '\\cJ', flags: '', input: 'a\nb', matches: true, why: 'control escape' },
  { source: '\\x41\\u0042', flags: '', input: 'AB', matches: true, why: 'hex and unicode escapes' },
  { source: '\\uD83D\\uDE00', flags: '', input: '\u{1F600}', matches: true, why: 'surrogate-pair escape' },
  { source: '\\u{1F600}', flags: 'u', input: '\u{1F600}', matches: true, why: 'code point escape with u' },
  { source: '\\p{Lu}', flags: 'u', input: 'É', matches: true, why: 'property escape with u' },
  { source: '^\\P{L}$', flags: 'u', input: '1', matches: true, why: 'negated property escape with u' },
  { source: '\\p{Lu}', flags: '', input: 'p{Lu}', matches: true, why: '\\p without u is a literal p' },
  { source: '\\/\\.\\$', flags: '', input: '/.$', matches: true, why: 'escaped punctuation' },
  { source: 'a b#c', flags: '', input: 'a b#c', matches: true, why: 'literal space and # (no comment mode)' },
  // Character classes.
  { source: '[]', flags: '', input: 'a', matches: false, why: 'empty class matches nothing' },
  { source: '[^]', flags: '', input: '\n', matches: true, why: '[^] matches anything' },
  { source: '[a\\-z]', flags: '', input: '-', matches: true, why: 'escaped hyphen in a class' },
  { source: '[\\w-]+$', flags: '', input: 'a-b', matches: true, why: 'trailing hyphen in a class' },
  { source: '[\\d-x]', flags: '', input: '-', matches: true, why: 'class escape next to a hyphen is not a range' },
  { source: '[[]', flags: '', input: '[', matches: true, why: '[ in a class is literal' },
  { source: '[a&&b]', flags: '', input: '&', matches: true, why: '&& in a class is literal' },
  { source: '^[*--]$', flags: '', input: '+', matches: true, why: 'a range ending at a hyphen' },
  { source: '[\\b]', flags: '', input: '\b', matches: true, why: '\\b in a class is backspace' },
  { source: '[^a-c]', flags: 'i', input: 'B', matches: false, why: 'negated range with i' },
  { source: '[à-å]', flags: '', input: 'ã', matches: true, why: 'non-ASCII range' },
  { source: '[\\u{1F600}-\\u{1F64F}]', flags: 'u', input: '\u{1F610}', matches: true, why: 'astral range with u' },
  // Groups.
  { source: '(a)\\1', flags: '', input: 'aa', matches: true, why: 'numbered backreference' },
  { source: '(a)\\10', flags: '', input: 'a\u0008', matches: true, why: '\\10 with one group is octal 10' },
  { source: '(?<word>ab)\\k<word>', flags: '', input: 'abab', matches: true, why: 'named group and backreference' },
  { source: '(?<$x>a)(?<y_1>b)\\k<y_1>', flags: '', input: 'abb', matches: true, why: 'JS-only group names' },
  { source: '\\k', flags: '', input: 'k', matches: true, why: '\\k with no named groups is a literal k' },
  { source: '(?:ab)+(?=c)', flags: '', input: 'ababc', matches: true, why: 'non-capturing group and lookahead' },
  { source: '(?<=\\$)\\d+', flags: '', input: 'cost $42', matches: true, why: 'lookbehind' },
  { source: '(?<!\\$)\\b\\d+', flags: '', input: '$42', matches: false, why: 'negative lookbehind' },
  { source: '(?<=ab?)c', flags: '', input: 'ac', matches: true, why: 'bounded lookbehind with ?' },
  { source: 'cat|dog', flags: '', input: 'hotdog', matches: true, why: 'alternation' },
  { source: 'a+?b*?', flags: '', input: 'a', matches: true, why: 'lazy quantifiers' },
];

const FIXTURE = fileURLToPath(new URL('./fixtures/regex-conformance.json', import.meta.url));

function buildFixture() {
  return {
    comment:
      'Generated by packages/tapsmith/src/__tests__/text-regex.test.ts (PILOT-520). Each case\'s `pattern`/`ignoreCase` ' +
      'is the SDK translation the agents compile; `matches` is JavaScript\'s own answer. Replayed by the Android ' +
      'agent\'s TextMatchTest and the iOS agent\'s TextMatchTests.',
    cases: CASES.map((c) => ({ ...c, ...translateRegex(c.source, c.flags) })),
  };
}

describe('regex conformance table', () => {
  it.each(CASES)('JavaScript agrees: /$source/$flags on $input → $matches ($why)', (c) => {
    expect(new RegExp(c.source, c.flags).test(c.input)).toBe(c.matches);
  });

  it('the agents\' fixture is the current translation of every case', () => {
    const fresh = buildFixture();
    if (process.env.UPDATE_REGEX_FIXTURE) writeFileSync(FIXTURE, JSON.stringify(fresh, null, 2) + '\n');
    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
    expect(committed).toEqual(fresh);
  });
});

describe('translateRegex', () => {
  it('carries only the i flag', () => {
    expect(translateRegex('a', 'i').ignoreCase).toBe(true);
    expect(translateRegex('a', 'msu').ignoreCase).toBe(false);
  });

  it('spells \\s as JavaScript\'s whitespace set, not the engine\'s', () => {
    const { pattern } = translateRegex('a\\sb', '');
    expect(pattern).toContain('\\u00A0');
    expect(pattern).toContain('\\u202F');
    expect(pattern).not.toContain('\\s');
  });

  it('anchors explicitly instead of relying on engine ^ $ defaults', () => {
    expect(translateRegex('^a$', '').pattern).toBe('\\Aa\\z');
  });

  it('turns named groups into numbered ones', () => {
    expect(translateRegex('(?<x>a)\\k<x>', '').pattern).toBe('(a)(?:\\1)');
  });

  it('keeps the i part of a modifier group and applies its m and s itself', () => {
    expect(translateRegex('(?i:a)', '').pattern).toBe('(?i:a)');
    expect(translateRegex('(?-i:a)', 'i').pattern).toBe('(?-i:a)');
    expect(translateRegex('(?s:.)', '').pattern).toBe('(?:(?s:.))');
    expect(translateRegex('(?m:^)^', '').pattern).toBe('(?:(?<![^\\u000A\\u000D\\u2028\\u2029]))\\A');
  });

  it('rejects an unbounded lookbehind, which the device engines cannot run', () => {
    expect(() => translateRegex('(?<=a+)b', '')).toThrow(/lookbehind/);
    expect(() => translateRegex('(?<=a*)b', '')).toThrow(/lookbehind/);
    expect(() => translateRegex('(?<=a{2,})b', '')).toThrow(/lookbehind/);
    expect(() => translateRegex('(?<=(a)\\1)b', '')).toThrow(/lookbehind/);
    expect(() => translateRegex('(?<=a{1,3})b(?=c+)', '')).not.toThrow();
  });
});

describe('textRegexValue', () => {
  it('keeps the RegExp as written alongside its translation', () => {
    const v = textRegexValue(/Save\sdraft/i, 'getByText()');
    expect(v.source).toBe('Save\\sdraft');
    expect(v.flags).toBe('i');
    expect(v.ignoreCase).toBe(true);
    expect(v.pattern).toBe(translateRegex('Save\\sdraft', 'i').pattern);
  });

  it.each(['y', 'v'])('rejects the %s flag with a TypeError naming the call', (flag) => {
    const re = new RegExp('a', flag);
    expect(() => textRegexValue(re, 'getByText()')).toThrow(TypeError);
    expect(() => textRegexValue(re, 'getByText()')).toThrow(
      new RegExp(`getByText\\(\\) does not support the RegExp flag "${flag}"`),
    );
  });

  it('names the call when a lookbehind is unbounded', () => {
    expect(() => textRegexValue(/(?<=a+)b/, 'getByRole() option `name`')).toThrow(
      /getByRole\(\) option `name`.*lookbehind/,
    );
  });
});

describe('formatRegex / toJsRegExp', () => {
  it('prints a RegExp literal', () => {
    expect(formatRegex(textRegexValue(/a\/b\s/gi, 'x'))).toBe('/a\\/b\\s/gi');
  });

  it('rebuilds a stateless RegExp (no g, so test() never skips ahead)', () => {
    const re = toJsRegExp(textRegexValue(/save/gi, 'x'));
    expect(re.flags).toBe('i');
    expect(re.test('SAVE')).toBe(true);
    expect(re.test('SAVE')).toBe(true);
  });
});
