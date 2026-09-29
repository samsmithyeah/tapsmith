import { describe, it, expect } from 'vitest';
import { formatJson, jsonError } from '../cli-json.js';

// The error envelope is a public contract (docs/api-reference.md, CLI → JSON
// output). A change here breaks every script and agent that reads it.
describe('jsonError()', () => {
  it('builds { error: { code, message, fix, candidates } } in that key order', () => {
    const envelope = jsonError('AMBIGUOUS_APK', 'Found 2 APK candidates', { fix: 'Pass --apk <path>', candidates: ['a.apk', 'b.apk'] });
    expect(Object.keys(envelope)).toEqual(['error']);
    expect(Object.keys(envelope.error)).toEqual(['code', 'message', 'fix', 'candidates']);
    expect(envelope).toEqual({
      error: { code: 'AMBIGUOUS_APK', message: 'Found 2 APK candidates', fix: 'Pass --apk <path>', candidates: ['a.apk', 'b.apk'] },
    });
  });

  it('leaves out optional keys that are not set, rather than printing null', () => {
    expect(JSON.parse(formatJson(jsonError('UNEXPECTED_ERROR', 'boom', { fix: undefined })))).toEqual({
      error: { code: 'UNEXPECTED_ERROR', message: 'boom' },
    });
  });
});

describe('formatJson()', () => {
  it('prints one pretty-printed document ending in a newline', () => {
    expect(formatJson({ ok: true })).toBe('{\n  "ok": true\n}\n');
  });
});
