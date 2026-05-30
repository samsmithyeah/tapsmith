import type { SourceLocation } from '../../trace/types.js';

export function resolveSourceView(
  stack: SourceLocation[],
  sources: Map<string, string>,
  selectedFrame: number,
  hasEvent: boolean,
): { filename?: string; content?: string; highlightLine?: number } {
  const frame = stack[selectedFrame];
  if (frame) {
    const exact = sources.get(frame.file);
    if (exact !== undefined) {
      return { filename: frame.file, content: exact, highlightLine: frame.line };
    }
    // Case-insensitive fallback: on macOS/Windows the casing of a stack-frame
    // path can differ from the captured key (e.g. drive letter `c:` vs `C:`)
    // even though they point at the same file.
    const lower = frame.file.toLowerCase();
    for (const [key, content] of sources) {
      if (key.toLowerCase() === lower) {
        return { filename: key, content, highlightLine: frame.line };
      }
    }
  }
  if (!hasEvent) {
    const [first] = sources;
    if (first) return { filename: first[0], content: first[1] };
  }
  if (frame) return { filename: frame.file };
  return {};
}
