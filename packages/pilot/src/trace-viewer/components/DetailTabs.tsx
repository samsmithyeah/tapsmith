import { useState, useRef, useEffect } from 'preact/hooks';
import type { ActionTraceEvent, AssertionTraceEvent, AnyTraceEvent, ConsoleTraceEvent, TraceMetadata, NetworkEntry } from '../../trace/types.js';
import { HierarchyTree } from './HierarchyTree.js';
import type { Bounds } from './HierarchyTree.js';
import { NetworkTab } from './NetworkTab.js';

interface Props {
  event: ActionTraceEvent | AssertionTraceEvent | undefined
  events: AnyTraceEvent[]
  hierarchies: Map<string, string>
  sources: Map<string, string>
  metadata: TraceMetadata
  networkEntries: NetworkEntry[]
  networkBodies: Map<string, string>
  onHierarchyNodeSelect?: (bounds: Bounds | null) => void
}

type DetailTab = 'call' | 'log' | 'console' | 'source' | 'hierarchy' | 'errors' | 'network'

export function DetailTabs({ event, events, hierarchies, sources, metadata, networkEntries, networkBodies, onHierarchyNodeSelect }: Props) {
  const [tab, setTab] = useState<DetailTab>('call');

  const hasError = event && (
    (event.type === 'action' && !event.success) ||
    (event.type === 'assertion' && !event.passed)
  );
  const hasSources = sources.size > 0;
  const hasHierarchy = hierarchies.size > 0;

  const consoleEvents = events.filter((e): e is ConsoleTraceEvent => e.type === 'console');
  const hasConsole = consoleEvents.length > 0;
  const hasNetwork = networkEntries.length > 0;

  return (
    <div class="detail-panel">
      <div class="detail-tabs-bar">
        <div class={`detail-tab${tab === 'call' ? ' active' : ''}`} onClick={() => setTab('call')}>Call</div>
        <div class={`detail-tab${tab === 'log' ? ' active' : ''}`} onClick={() => setTab('log')}>Log</div>
        {hasConsole && (
          <div class={`detail-tab${tab === 'console' ? ' active' : ''}`} onClick={() => setTab('console')}>Console</div>
        )}
        {hasSources && (
          <div class={`detail-tab${tab === 'source' ? ' active' : ''}`} onClick={() => setTab('source')}>Source</div>
        )}
        {hasHierarchy && (
          <div class={`detail-tab${tab === 'hierarchy' ? ' active' : ''}`} onClick={() => setTab('hierarchy')}>Hierarchy</div>
        )}
        {hasNetwork && (
          <div class={`detail-tab${tab === 'network' ? ' active' : ''}`} onClick={() => setTab('network')}>Network</div>
        )}
        {hasError && (
          <div class={`detail-tab${tab === 'errors' ? ' active' : ''}${hasError ? ' has-error' : ''}`} onClick={() => setTab('errors')}>Errors</div>
        )}
      </div>
      <div class={`detail-content${tab === 'hierarchy' ? ' detail-content-flush' : ''}`}>
        {tab === 'call' && <CallTab event={event} />}
        {tab === 'log' && <LogTab event={event} />}
        {tab === 'console' && <ConsoleTab event={event} events={consoleEvents} />}
        {tab === 'source' && <SourceTab event={event} sources={sources} />}
        {tab === 'hierarchy' && <HierarchyTabWrapper event={event} hierarchies={hierarchies} onNodeSelect={onHierarchyNodeSelect} />}
        {tab === 'network' && <NetworkTab entries={networkEntries} bodies={networkBodies} />}
        {tab === 'errors' && <ErrorsTab event={event} />}
      </div>
    </div>
  );
}

// ─── Call Tab ───

function CallTab({ event }: { event: ActionTraceEvent | AssertionTraceEvent | undefined }) {
  if (!event) return <div class="no-content">No action selected</div>;

  if (event.type === 'action') {
    return (
      <div class="call-grid">
        <span class="call-label">Action</span>
        <span class="call-value">{event.action}</span>
        {event.selector && <>
          <span class="call-label">Selector</span>
          <span class="call-value">{event.selector}</span>
        </>}
        {event.inputValue !== undefined && <>
          <span class="call-label">Input</span>
          <span class="call-value">"{event.inputValue}"</span>
        </>}
        <span class="call-label">Duration</span>
        <span class="call-value">{event.duration}ms</span>
        <span class="call-label">Status</span>
        <span class={`call-value ${event.success ? 'success' : 'error'}`}>
          {event.success ? 'passed' : 'failed'}
        </span>
        {event.bounds && <>
          <span class="call-label">Bounds</span>
          <span class="call-value">[{event.bounds.left}, {event.bounds.top}, {event.bounds.right}, {event.bounds.bottom}]</span>
        </>}
        {event.sourceLocation && <>
          <span class="call-label">Source</span>
          <span class="call-value">{event.sourceLocation.file}:{event.sourceLocation.line}</span>
        </>}
        {event.error && <>
          <span class="call-label">Error</span>
          <span class="call-value error">{event.error}</span>
        </>}
      </div>
    );
  }

  return (
    <div class="call-grid">
      <span class="call-label">Assertion</span>
      <span class="call-value">{event.assertion}</span>
      {event.selector && <>
        <span class="call-label">Selector</span>
        <span class="call-value">{event.selector}</span>
      </>}
      {event.expected !== undefined && <>
        <span class="call-label">Expected</span>
        <span class="call-value">{event.expected}</span>
      </>}
      {event.actual !== undefined && <>
        <span class="call-label">Actual</span>
        <span class="call-value">{event.actual}</span>
      </>}
      <span class="call-label">Result</span>
      <span class={`call-value ${event.passed ? 'success' : 'error'}`}>
        {event.passed ? 'passed' : 'failed'}{event.negated ? ' (negated)' : ''}{event.soft ? ' (soft)' : ''}
      </span>
      <span class="call-label">Duration</span>
      <span class="call-value">{event.duration}ms ({event.attempts} attempt{event.attempts !== 1 ? 's' : ''})</span>
      {event.error && <>
        <span class="call-label">Error</span>
        <span class="call-value error">{event.error}</span>
      </>}
    </div>
  );
}

// ─── Log Tab (internal action log) ───

function LogTab({ event }: { event: ActionTraceEvent | AssertionTraceEvent | undefined }) {
  if (!event) return <div class="no-content">No action selected</div>;

  const log = event.type === 'action' ? event.log : undefined;

  if (!log || log.length === 0) {
    return <div class="no-content">No internal log for this action</div>;
  }

  return (
    <div>
      {log.map((entry, i) => (
        <div key={i} class="log-entry">
          <span class="log-message">{entry}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Console Tab ───

function ConsoleTab({ event, events: consoleEvents }: { event: ActionTraceEvent | AssertionTraceEvent | undefined; events: ConsoleTraceEvent[] }) {
  if (consoleEvents.length === 0) return <div class="no-content">No console output recorded</div>;

  const relevant = event
    ? consoleEvents.filter(e => Math.abs(e.actionIndex - event.actionIndex) <= 1)
    : consoleEvents;

  if (relevant.length === 0) return <div class="no-content">No console output for this action</div>;

  return (
    <div>
      {relevant.map((ev, i) => (
        <div key={i} class="log-entry">
          <span class={`log-level ${ev.level}`}>{ev.level}</span>
          <span class="log-source">{ev.source === 'device' ? 'device' : 'test'}</span>
          <span class="log-message">{ev.message}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Source Tab ───

interface SourceToken {
  text: string
  type: 'keyword' | 'string' | 'comment' | 'number' | 'plain'
}

const KEYWORDS = new Set([
  'import', 'from', 'export', 'const', 'let', 'var', 'async', 'await',
  'function', 'return', 'if', 'else', 'try', 'catch', 'throw', 'new',
  'typeof', 'describe', 'test', 'expect', 'beforeEach', 'afterEach',
]);

function tokenizeLine(line: string, inBlockComment: boolean): { tokens: SourceToken[]; inBlockComment: boolean } {
  const tokens: SourceToken[] = [];
  let remaining = line;
  let blockComment = inBlockComment;

  // If we're inside a block comment from a previous line, consume until we find */
  if (blockComment) {
    const endIdx = remaining.indexOf('*/');
    if (endIdx === -1) {
      tokens.push({ text: remaining, type: 'comment' });
      return { tokens, inBlockComment: true };
    }
    tokens.push({ text: remaining.slice(0, endIdx + 2), type: 'comment' });
    remaining = remaining.slice(endIdx + 2);
    blockComment = false;
  }

  while (remaining.length > 0) {
    // Line comment
    if (remaining.startsWith('//')) {
      tokens.push({ text: remaining, type: 'comment' });
      remaining = '';
      break;
    }

    // Block comment start
    if (remaining.startsWith('/*')) {
      const endIdx = remaining.indexOf('*/', 2);
      if (endIdx === -1) {
        tokens.push({ text: remaining, type: 'comment' });
        remaining = '';
        blockComment = true;
        break;
      }
      tokens.push({ text: remaining.slice(0, endIdx + 2), type: 'comment' });
      remaining = remaining.slice(endIdx + 2);
      continue;
    }

    // Single-quoted string
    if (remaining[0] === "'") {
      const match = remaining.match(/^'(?:[^'\\]|\\.)*'/);
      if (match) {
        tokens.push({ text: match[0], type: 'string' });
        remaining = remaining.slice(match[0].length);
        continue;
      }
    }

    // Double-quoted string
    if (remaining[0] === '"') {
      const match = remaining.match(/^"(?:[^"\\]|\\.)*"/);
      if (match) {
        tokens.push({ text: match[0], type: 'string' });
        remaining = remaining.slice(match[0].length);
        continue;
      }
    }

    // Template literal (basic - no nesting)
    if (remaining[0] === '`') {
      const match = remaining.match(/^`(?:[^`\\]|\\.)*`/);
      if (match) {
        tokens.push({ text: match[0], type: 'string' });
        remaining = remaining.slice(match[0].length);
        continue;
      }
    }

    // Number
    const numMatch = remaining.match(/^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+\.?\d*(?:[eE][+-]?\d+)?)(?!\w)/);
    if (numMatch && (tokens.length === 0 || /[^a-zA-Z_$]$/.test(tokens[tokens.length - 1].text))) {
      tokens.push({ text: numMatch[0], type: 'number' });
      remaining = remaining.slice(numMatch[0].length);
      continue;
    }

    // Keyword or identifier
    const wordMatch = remaining.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
    if (wordMatch) {
      const word = wordMatch[0];
      const type = KEYWORDS.has(word) ? 'keyword' : 'plain';
      tokens.push({ text: word, type });
      remaining = remaining.slice(word.length);
      continue;
    }

    // Any other character
    // Collect consecutive non-special characters as plain text
    const plainMatch = remaining.match(/^[^a-zA-Z_$'"`/0-9]+/);
    if (plainMatch) {
      tokens.push({ text: plainMatch[0], type: 'plain' });
      remaining = remaining.slice(plainMatch[0].length);
    } else {
      tokens.push({ text: remaining[0], type: 'plain' });
      remaining = remaining.slice(1);
    }
  }

  return { tokens, inBlockComment: blockComment };
}

const TOKEN_COLORS: Record<SourceToken['type'], string | undefined> = {
  keyword: 'var(--color-keyword)',
  string: 'var(--color-string)',
  comment: 'var(--color-text-faint)',
  number: 'var(--color-number)',
  plain: undefined,
};

function SourceTab({ event, sources }: { event: ActionTraceEvent | AssertionTraceEvent | undefined; sources: Map<string, string> }) {
  const highlightRef = useRef<HTMLDivElement>(null);

  if (sources.size === 0) return <div class="no-content">No source files in trace</div>;

  const [filename, content] = [...sources.entries()][0];
  const loc = event?.sourceLocation;
  const highlightLine = loc?.line;

  const lines = content.split('\n');

  // Tokenize all lines, tracking block comment state across lines
  let inBlockComment = false;
  const tokenizedLines: SourceToken[][] = [];
  for (const line of lines) {
    const result = tokenizeLine(line, inBlockComment);
    tokenizedLines.push(result.tokens);
    inBlockComment = result.inBlockComment;
  }

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightLine]);

  return (
    <div>
      <div style={{ color: 'var(--color-text-muted)', fontSize: '11px', marginBottom: '6px', fontFamily: 'monospace' }}>{filename}</div>
      <div class="source-code">
        {tokenizedLines.map((tokens, i) => (
          <div
            key={i}
            ref={highlightLine === i + 1 ? highlightRef : undefined}
            class={`source-line${highlightLine === i + 1 ? ' highlight' : ''}`}
          >
            <span class="source-line-number">{i + 1}</span>
            <span class="source-line-content">
              {tokens.length === 0
                ? '\u200b'
                : tokens.map((token, j) => {
                    const color = TOKEN_COLORS[token.type];
                    return color
                      ? <span key={j} style={{ color }}>{token.text}</span>
                      : <span key={j}>{token.text}</span>;
                  })
              }
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Hierarchy Tab ───

function HierarchyTabWrapper({ event, hierarchies, onNodeSelect }: {
  event: ActionTraceEvent | AssertionTraceEvent | undefined
  hierarchies: Map<string, string>
  onNodeSelect?: (bounds: Bounds | null) => void
}) {
  if (!event || hierarchies.size === 0) return <div class="no-content">No view hierarchy available</div>;

  const pad = String(event.actionIndex).padStart(3, '0');
  const afterKey = `hierarchy/action-${pad}-after.xml`;
  const beforeKey = `hierarchy/action-${pad}-before.xml`;
  const xml = hierarchies.get(afterKey) ?? hierarchies.get(beforeKey);

  if (!xml) return <div class="no-content">No hierarchy snapshot for this action</div>;

  return <HierarchyTree xml={xml} onNodeSelect={onNodeSelect} />;
}

// ─── Errors Tab ───

function ErrorsTab({ event }: { event: ActionTraceEvent | AssertionTraceEvent | undefined }) {
  if (!event) return null;

  const error = event.type === 'action' ? event.error : event.error;
  const stack = event.type === 'action' ? event.errorStack : undefined;

  if (!error) return <div class="no-content">No errors</div>;

  return (
    <div class="error-block">
      <div class="error-message">{error}</div>
      {stack && <pre class="error-stack">{stack}</pre>}
      {event.type === 'assertion' && !event.passed && (
        <div style={{ marginTop: '8px', fontSize: '12px' }}>
          {event.expected !== undefined && (
            <div><span style={{ color: 'var(--color-text-muted)' }}>Expected: </span><span style={{ color: 'var(--color-success)' }}>{event.expected}</span></div>
          )}
          {event.actual !== undefined && (
            <div><span style={{ color: 'var(--color-text-muted)' }}>Actual: </span><span style={{ color: 'var(--color-error)' }}>{event.actual}</span></div>
          )}
        </div>
      )}
    </div>
  );
}
