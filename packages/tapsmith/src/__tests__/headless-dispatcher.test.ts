import { describe, it, expect } from 'vitest';
import { resultEntryKey } from '../mcp/headless-dispatcher.js';

describe('resultEntryKey', () => {
  it('disambiguates same-named tests across different files', () => {
    const a = resultEntryKey(undefined, '/tests/a.test.ts', 'Suite > renders');
    const b = resultEntryKey(undefined, '/tests/b.test.ts', 'Suite > renders');
    expect(a).not.toBe(b);
  });

  it('returns identical keys for the same project + file + test', () => {
    expect(resultEntryKey('android', '/tests/a.test.ts', 'Suite > renders'))
      .toBe(resultEntryKey('android', '/tests/a.test.ts', 'Suite > renders'));
  });

  it('disambiguates the same file + test across projects', () => {
    const android = resultEntryKey('android', '/tests/a.test.ts', 'Suite > renders');
    const ios = resultEntryKey('ios', '/tests/a.test.ts', 'Suite > renders');
    expect(android).not.toBe(ios);
  });

  it('treats no project as distinct from a named project', () => {
    expect(resultEntryKey(undefined, '/tests/a.test.ts', 'Suite > renders'))
      .not.toBe(resultEntryKey('android', '/tests/a.test.ts', 'Suite > renders'));
  });
});
