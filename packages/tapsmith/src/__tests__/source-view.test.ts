import { describe, it, expect } from 'vitest';
import { resolveSourceView } from '../trace-viewer/components/source-view-utils.js';
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
});
