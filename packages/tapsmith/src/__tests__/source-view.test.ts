import { describe, it, expect } from 'vitest';
import { resolveSourceView, findTestDeclarationLine, findSuiteDeclarationLine } from '../trace-viewer/components/source-view-utils.js';
import type { SourceLocation } from '../trace/types.js';

const stack: SourceLocation[] = [{ file: '/p/a.ts', line: 5 }, { file: '/p/h.ts', line: 9 }];

describe('resolveSourceView', () => {
  it('shows the selected frame file + line when captured', () => {
    const sources = new Map([['/p/a.ts', 'A'], ['/p/h.ts', 'H']]);
    expect(resolveSourceView(stack, sources, 1, true)).toEqual({ filename: '/p/h.ts', content: 'H', highlightLine: 9 });
  });
  it('falls back to first file with no highlight pre-run (no event)', () => {
    const sources = new Map([['/p/test.ts', 'T']]);
    expect(resolveSourceView([], sources, 0, false)).toEqual({ filename: '/p/test.ts', content: 'T' });
  });
  it('reports filename without content when frame not captured', () => {
    expect(resolveSourceView(stack, new Map(), 0, true)).toEqual({ filename: '/p/a.ts' });
  });
  it('returns empty when nothing available', () => {
    expect(resolveSourceView([], new Map(), 0, true)).toEqual({});
  });
  it('resolves via a case-insensitive fallback when exact casing differs', () => {
    const sources = new Map([['/p/a.ts', 'A'], ['/p/h.ts', 'H']]);
    expect(resolveSourceView([{ file: '/P/A.ts', line: 5 }], sources, 0, true))
      .toEqual({ filename: '/p/a.ts', content: 'A', highlightLine: 5 });
  });
  it('prefers an exact match over the case-insensitive fallback', () => {
    const sources = new Map([['/p/a.ts', 'lower'], ['/P/A.ts', 'upper']]);
    expect(resolveSourceView([{ file: '/P/A.ts', line: 1 }], sources, 0, true))
      .toEqual({ filename: '/P/A.ts', content: 'upper', highlightLine: 1 });
  });
});

describe('findTestDeclarationLine', () => {
  const src = [
    "import { test, expect } from 'tapsmith'", // 1
    '',                                         // 2
    "test('opens the app', async ({ device }) => {", // 3
    '  await device.tap()',                     // 4
    '})',                                       // 5
    '',                                         // 6
    'describe(\'group\', () => {',              // 7
    '  test.only(\"runs only this\", async ({ device }) => {})', // 8
    '  test.skip(`templated name`, async () => {})',             // 9
    '})',                                       // 10
  ].join('\n');

  it('finds a single-quoted test declaration (1-based line)', () => {
    expect(findTestDeclarationLine(src, 'opens the app')).toBe(3);
  });
  it('finds a test.only declaration with double quotes', () => {
    expect(findTestDeclarationLine(src, 'runs only this')).toBe(8);
  });
  it('finds a test.skip declaration with backticks', () => {
    expect(findTestDeclarationLine(src, 'templated name')).toBe(9);
  });
  it('escapes regex metacharacters in the test name', () => {
    const s = "test('a.b(c)$', async () => {})";
    expect(findTestDeclarationLine(s, 'a.b(c)$')).toBe(1);
  });
  it('returns undefined when the name is not found', () => {
    expect(findTestDeclarationLine(src, 'no such test')).toBeUndefined();
  });
  it('returns undefined for an empty name', () => {
    expect(findTestDeclarationLine(src, '')).toBeUndefined();
  });
  it('does not match a substring of a longer test name', () => {
    const s = "test('login flow works', async () => {})";
    expect(findTestDeclarationLine(s, 'login flow')).toBeUndefined();
  });
  it('does not match a describe block as a test', () => {
    const s = "describe('opens the app', () => {})";
    expect(findTestDeclarationLine(s, 'opens the app')).toBeUndefined();
  });
});

describe('findSuiteDeclarationLine', () => {
  const src = [
    "describe('Home screen', () => {",                     // 1
    "  test('shows the app header', async () => {})",      // 2
    '})',                                                  // 3
    "describe.only(\"Settings\", () => {",                 // 4
    '})',                                                  // 5
  ].join('\n');

  it('finds a describe block (1-based line)', () => {
    expect(findSuiteDeclarationLine(src, 'Home screen')).toBe(1);
  });
  it('finds a describe.only block with double quotes', () => {
    expect(findSuiteDeclarationLine(src, 'Settings')).toBe(4);
  });
  it('does not match a test as a describe block', () => {
    expect(findSuiteDeclarationLine(src, 'shows the app header')).toBeUndefined();
  });
  it('returns undefined when the suite name is not found', () => {
    expect(findSuiteDeclarationLine(src, 'no such suite')).toBeUndefined();
  });
});
