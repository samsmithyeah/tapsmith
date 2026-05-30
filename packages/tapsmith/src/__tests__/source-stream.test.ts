import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { streamSourcesForEvent } from '../ui-mode/source-stream.js';
import type { AnyTraceEvent } from '../trace/types.js';

describe('streamSourcesForEvent', () => {
  it('reads and emits each referenced file once', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-ss-'));
    try {
      const f = path.join(tmp, 'a.ts');
      fs.writeFileSync(f, 'const a = 1\n');
      const sent = new Set<string>();
      const emitted: Array<{ path: string; fileName: string; content: string }> = [];
      const emit = (p: string, fn: string, content: string) => emitted.push({ path: p, fileName: fn, content });
      const ev = { type: 'action', stack: [{ file: f, line: 1 }, { file: f, line: 2 }] } as unknown as AnyTraceEvent;
      streamSourcesForEvent(ev, sent, emit);
      streamSourcesForEvent(ev, sent, emit);
      expect(emitted).toEqual([{ path: f, fileName: 'a.ts', content: 'const a = 1\n' }]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ignores events without a stack and missing files', () => {
    const sent = new Set<string>();
    let calls = 0;
    streamSourcesForEvent({ type: 'console' } as unknown as AnyTraceEvent, sent, () => { calls++; });
    streamSourcesForEvent({ type: 'action', stack: [{ file: '/no/such/file.ts', line: 1 }] } as unknown as AnyTraceEvent, sent, () => { calls++; });
    expect(calls).toBe(0);
  });
});
