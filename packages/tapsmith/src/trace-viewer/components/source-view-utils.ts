import type { SourceLocation } from '../../trace/types.js';

export function resolveSourceView(
  stack: SourceLocation[],
  sources: Map<string, string>,
  selectedFrame: number,
  hasEvent: boolean,
): { filename?: string; content?: string; highlightLine?: number } {
  const frame = stack[selectedFrame];
  if (frame && sources.has(frame.file)) {
    return { filename: frame.file, content: sources.get(frame.file), highlightLine: frame.line };
  }
  if (!hasEvent && sources.size > 0) {
    const [filename, content] = [...sources.entries()][0];
    return { filename, content };
  }
  if (frame) return { filename: frame.file };
  return {};
}
