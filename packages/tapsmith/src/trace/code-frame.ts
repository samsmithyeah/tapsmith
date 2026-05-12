export interface SnippetLine {
  lineNumber: number
  text: string
  highlight: boolean
}

export interface CodeSnippet {
  lines: SnippetLine[]
  gutterWidth: number
}

export function buildCodeSnippet(
  source: string,
  lineNum: number,
  contextSize = 2,
): CodeSnippet {
  const sourceLines = source.split('\n');
  const start = Math.max(0, lineNum - 1 - contextSize);
  const end = Math.min(sourceLines.length, lineNum + contextSize);
  const lines: SnippetLine[] = [];
  for (let i = start; i < end; i++) {
    lines.push({
      lineNumber: i + 1,
      text: sourceLines[i],
      highlight: i + 1 === lineNum,
    });
  }
  return { lines, gutterWidth: String(end).length };
}

export function formatCodeSnippetPlain(snippet: CodeSnippet): string {
  return snippet.lines.map((sl) => {
    const gutter = String(sl.lineNumber).padStart(snippet.gutterWidth);
    const marker = sl.highlight ? '>' : ' ';
    return `${marker} ${gutter} |   ${sl.text}`;
  }).join('\n');
}
