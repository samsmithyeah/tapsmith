import type { SourceLocation } from '../../trace/types.js';

/**
 * Locate the 1-based line of a `<fnName>('name', ...)` declaration in source,
 * so the Source tab can highlight a node that hasn't run yet (no trace, so no
 * captured sourceLocation). Matches `fnName(`, `fnName.only(`, `fnName.skip(`,
 * etc. followed by the exact name in matching quotes/backticks. Returns
 * undefined for dynamic/interpolated names that aren't a literal match.
 */
function findDeclarationLine(content: string, fnName: string, name: string): number | undefined {
  if (!name) return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${fnName}\\s*(?:\\.\\w+)?\\s*\\(\\s*(['"\`])${escaped}\\1`);
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return undefined;
}

/** Find the 1-based line of `test('name', ...)`. @see findDeclarationLine */
export function findTestDeclarationLine(content: string, testName: string): number | undefined {
  return findDeclarationLine(content, 'test', testName);
}

/** Find the 1-based line of `describe('name', ...)`. @see findDeclarationLine */
export function findSuiteDeclarationLine(content: string, suiteName: string): number | undefined {
  return findDeclarationLine(content, 'describe', suiteName);
}

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
