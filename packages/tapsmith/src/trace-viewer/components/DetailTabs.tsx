import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { usePersistedString } from '../../ui-mode/hooks/use-persisted-state.js';
import type { ComponentChildren } from 'preact';
import { AlertTriangle } from 'lucide-preact';
import { buildCodeSnippet, formatCodeSnippetPlain } from '../../trace/code-frame.js';
import type { ActionTraceEvent, AssertionTraceEvent, AnyTraceEvent, ConsoleTraceEvent, TraceMetadata, NetworkEntry, ConsoleLevel, SourceLocation } from '../../trace/types.js';
import { resolveSourceView } from './source-view-utils.js';
import { HierarchyTree } from './HierarchyTree.js';
import type { Bounds } from './HierarchyTree.js';
import { NetworkTab } from './NetworkTab.js';
import { parseSelectorParts } from './ActionsPanel.js';

interface Props {
  event: ActionTraceEvent | AssertionTraceEvent | undefined
  events: AnyTraceEvent[]
  hierarchies: Map<string, string>
  sources: Map<string, string>
  metadata: TraceMetadata
  networkEntries: NetworkEntry[]
  networkBodies: Map<string, string>
  onHierarchyNodeSelect?: (bounds: Bounds | null) => void
  locatorTab?: ComponentChildren
  pickMode?: boolean
  /**
   * Source line to highlight when there is no selected event (e.g. previewing
   * a test that hasn't run yet). Ignored once a real event drives the view.
   */
  previewHighlight?: SourceLocation
}

type DetailTab = 'call' | 'log' | 'console' | 'source' | 'hierarchy' | 'locator' | 'errors' | 'network'

export function DetailTabs({ event, events, hierarchies, sources, metadata, networkEntries, networkBodies, onHierarchyNodeSelect, locatorTab, pickMode, previewHighlight }: Props) {
  const testError = metadata.error;
  const [tab, setTab] = usePersistedString('tapsmith-detail-tab', 'call') as [DetailTab, (v: DetailTab) => void];

  const hasActionError = event && (
    (event.type === 'action' && !event.success) ||
    (event.type === 'assertion' && !event.passed)
  );
  const hasError = hasActionError || !!testError;

  // Auto-switch to errors tab when test fails and no specific action is selected
  const prevTestError = useRef(testError);
  useEffect(() => {
    if (testError && !prevTestError.current && !event) {
      setTab('errors');
    }
    prevTestError.current = testError;
  }, [testError, event]);

  // Auto-switch to locator tab when pick mode is enabled
  useEffect(() => {
    if (pickMode && locatorTab) setTab('locator');
  }, [pickMode, locatorTab]);

  // Memoize: DetailTabs re-renders on every selected-event change, and
  // `events` can be large for long tests. Filtering + the dedupe check is
  // cheap per-element but adds up when it runs on every hover.
  const consoleEvents = useMemo(
    () => events.filter((e): e is ConsoleTraceEvent => e.type === 'console'),
    [events],
  );
  const failedEventsForCount = useMemo(
    () => events.filter((e): e is ActionTraceEvent | AssertionTraceEvent =>
      (e.type === 'action' && !(e as ActionTraceEvent).success) ||
      (e.type === 'assertion' && !(e as AssertionTraceEvent).passed),
    ),
    [events],
  );
  // The test-level error is usually just the failing assertion's message, so
  // don't double-count it when ErrorsTab would dedupe it visually.
  const failedCount = useMemo(() => {
    const testErrorIsDuplicate = !!testError
      && failedEventsForCount.some((ev) => ev.error && testError.includes(ev.error));
    return failedEventsForCount.length + (testError && !testErrorIsDuplicate ? 1 : 0);
  }, [failedEventsForCount, testError]);

  return (
    <div class="detail-panel">
      <div class="detail-tabs-bar">
        <div class={`detail-tab vtab${tab === 'call' ? ' active' : ''}`} onClick={() => setTab('call')}>Call</div>
        <div class={`detail-tab vtab${tab === 'log' ? ' active' : ''}`} onClick={() => setTab('log')}>Log</div>
        <div class={`detail-tab vtab${tab === 'console' ? ' active' : ''}`} onClick={() => setTab('console')}>
          Console{consoleEvents.length > 0 && <span class="detail-tab-dot" />}
        </div>
        <div class={`detail-tab vtab${tab === 'source' ? ' active' : ''}`} onClick={() => setTab('source')}>Source</div>
        <div class={`detail-tab vtab${tab === 'hierarchy' ? ' active' : ''}`} onClick={() => setTab('hierarchy')}>Hierarchy</div>
        {locatorTab && <div class={`detail-tab vtab${tab === 'locator' ? ' active' : ''}`} onClick={() => setTab('locator')}>Locator</div>}
        <div class={`detail-tab vtab${tab === 'network' ? ' active' : ''}`} onClick={() => setTab('network')}>
          Network{networkEntries.length > 0 && <span class="ct">{networkEntries.length}</span>}
        </div>
        <div class={`detail-tab vtab${tab === 'errors' ? ' active' : ''}${hasError ? ' has-error' : ''}`} onClick={() => setTab('errors')}>
          Errors{failedCount > 0 && <span class="ct">{failedCount}</span>}
        </div>
      </div>
      {testError && tab !== 'errors' && (
        <div class="test-error-banner" onClick={() => setTab('errors')}>
          <span class="test-error-banner-icon">✕</span>
          <span class="test-error-banner-text">{testError}</span>
        </div>
      )}
      <div class={`detail-content${tab === 'hierarchy' || tab === 'source' || tab === 'network' || tab === 'locator' || tab === 'console' ? ' detail-content-flush' : ''}`}>
        {tab === 'call' && <CallTab event={event} metadata={metadata} />}
        {tab === 'log' && <LogTab event={event} />}
        {tab === 'console' && <ConsoleTab event={event} events={consoleEvents} />}
        {tab === 'source' && <SourceTab event={event} sources={sources} previewHighlight={previewHighlight} />}
        {tab === 'hierarchy' && <HierarchyTabWrapper event={event} hierarchies={hierarchies} onNodeSelect={onHierarchyNodeSelect} />}
        {tab === 'locator' && locatorTab}
        {tab === 'network' && <NetworkTab entries={networkEntries} bodies={networkBodies} />}
        {tab === 'errors' && <ErrorsTab event={event} events={events} testError={testError} sources={sources} />}
      </div>
    </div>
  );
}

// ─── Call Tab ───

function formatSelectorForCall(sel: string | undefined): ComponentChildren {
  if (!sel) return null;
  const parts = parseSelectorParts(sel);
  if (!parts) return <span class="call-value mono">{sel}</span>;
  if (parts.optionKey) {
    return (
      <span class="call-value mono">
        <span class="sel-fn">{parts.fn}</span>({'{ '}<span class="sel-fn">{parts.optionKey}</span>{': '}<span class="sel-val">"{parts.args[0]}"</span>{' }'})
      </span>
    );
  }
  return (
    <span class="call-value mono">
      <span class="sel-fn">{parts.fn}</span>({parts.args.map((a, i) => <span key={i}>{i > 0 && ', '}<span class="sel-val">"{a}"</span></span>)})
    </span>
  );
}

function CallTab({ event, metadata }: { event: ActionTraceEvent | AssertionTraceEvent | undefined; metadata: TraceMetadata }) {
  if (!event) return <div class="no-content">No action selected</div>;
  const wallDuration = event.wallDuration ?? event.duration;

  if (event.type === 'action') {
    return (
      <div class="call-grid">
        <span class="call-label">Action</span>
        <span class="call-value">{event.action}</span>
        {event.selector && <>
          <span class="call-label">Selector</span>
          {formatSelectorForCall(event.selector)}
        </>}
        {event.inputValue !== undefined && <>
          <span class="call-label">Input</span>
          <span class="call-value mono">"{event.inputValue}"</span>
        </>}
        <span class="call-label">Wall time</span>
        <span class="call-value mono">{wallDuration}ms</span>
        {wallDuration !== event.duration && <>
          <span class="call-label">Action time</span>
          <span class="call-value mono">{event.duration}ms</span>
        </>}
        {event.gapBefore !== undefined && event.gapBefore > 0 && <>
          <span class="call-label">Gap before</span>
          <span class="call-value mono">{event.gapBefore}ms</span>
        </>}
        <span class="call-label">Status</span>
        <span class={`call-value ${event.success ? 'success' : 'error'}`}>
          {event.success ? 'passed' : 'failed'}
        </span>
        {metadata.device.serial && <>
          <span class="call-label">Device</span>
          <span class="call-value">{metadata.device.model ? `${metadata.device.model} · ` : ''}{metadata.device.serial}</span>
        </>}
        {event.sourceLocation && <>
          <span class="call-label">Source</span>
          <span class="call-value mono">{event.sourceLocation.file}:{event.sourceLocation.line}</span>
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
      <span class="call-label">Action</span>
      <span class="call-value">{event.assertion}</span>
      {event.selector && <>
        <span class="call-label">Selector</span>
        {formatSelectorForCall(event.selector)}
      </>}
      <span class="call-label">Wait strategy</span>
      <span class="call-value">element to {event.assertion.replace('toBe', 'become ').replace('toHave', 'have ')} (auto-wait)</span>
      {event.expected !== undefined && <>
        <span class="call-label">Expected</span>
        <span class="call-value mono">{event.expected}</span>
      </>}
      {event.actual !== undefined && <>
        <span class="call-label">Received</span>
        <span class="call-value mono">{event.actual}</span>
      </>}
      <span class="call-label">Timeout</span>
      <span class="call-value mono">{event.duration}ms</span>
      <span class="call-label">Elapsed</span>
      <span class={`call-value mono ${event.passed ? '' : 'error'}`}>
        {event.duration}ms{!event.passed ? ' (timed out)' : ''} — {event.attempts} attempt{event.attempts !== 1 ? 's' : ''}
      </span>
      {wallDuration !== event.duration && <>
        <span class="call-label">Wall time</span>
        <span class="call-value mono">{wallDuration}ms</span>
      </>}
      {event.gapBefore !== undefined && event.gapBefore > 0 && <>
        <span class="call-label">Gap before</span>
        <span class="call-value mono">{event.gapBefore}ms</span>
      </>}
      {metadata.device.serial && <>
        <span class="call-label">Device</span>
        <span class="call-value">{metadata.device.model ? `${metadata.device.model} · ` : ''}{metadata.device.serial}</span>
      </>}
      {event.sourceLocation && <>
        <span class="call-label">Source</span>
        <span class="call-value mono">{event.sourceLocation.file}:{event.sourceLocation.line}</span>
      </>}
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

type SourceFilter = 'all' | 'test' | 'device' | 'daemon'

const LEVEL_ORDER: ConsoleLevel[] = ['error', 'warn', 'info', 'log', 'debug'];

function ConsoleTab({ event, events: consoleEvents }: { event: ActionTraceEvent | AssertionTraceEvent | undefined; events: ConsoleTraceEvent[] }) {
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<Set<ConsoleLevel>>(new Set(LEVEL_ORDER));
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [scopeToAction, setScopeToAction] = useState(false);

  const presentSources = useMemo(() => {
    const s = new Set<SourceFilter>();
    for (const e of consoleEvents) s.add(e.source as SourceFilter);
    return s;
  }, [consoleEvents]);
  const showSourceFilter = presentSources.size > 1;

  const filtered = useMemo(() => {
    const lf = search.toLowerCase();
    return consoleEvents.filter(e => {
      if (!levelFilter.has(e.level as ConsoleLevel)) return false;
      if (sourceFilter !== 'all' && e.source !== sourceFilter) return false;
      if (scopeToAction && event && Math.abs(e.actionIndex - event.actionIndex) > 1) return false;
      if (lf && !e.message.toLowerCase().includes(lf)) return false;
      return true;
    });
  }, [consoleEvents, search, levelFilter, sourceFilter, scopeToAction, event]);

  const toggleLevel = (level: ConsoleLevel) => {
    setLevelFilter(prev => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  if (consoleEvents.length === 0) return <div class="no-content">No console output recorded</div>;

  return (
    <div class="con-container">
      <div class="con-toolbar">
        <input
          class="con-search"
          type="text"
          placeholder="Filter logs…"
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        />
        <div class="con-pills">
          {LEVEL_ORDER.map(level => (
            <button
              key={level}
              class={`con-pill level-${level}${levelFilter.has(level) ? ' active' : ''}`}
              onClick={() => toggleLevel(level)}
            >{level}</button>
          ))}
        </div>
        {showSourceFilter && (
          <>
            <div class="con-pill-sep" />
            <div class="con-pills">
              {(['all', 'test', 'device', 'daemon'] as SourceFilter[])
                .filter(s => s === 'all' || presentSources.has(s))
                .map(s => (
                  <button
                    key={s}
                    class={`con-pill${sourceFilter === s ? ' active' : ''}`}
                    onClick={() => setSourceFilter(s)}
                  >{s}</button>
                ))}
            </div>
          </>
        )}
        {event && (
          <>
            <div class="con-pill-sep" />
            <button
              class={`con-pill${scopeToAction ? ' active' : ''}`}
              onClick={() => setScopeToAction(prev => !prev)}
            >current action</button>
          </>
        )}
      </div>
      <div class="con-list">
        {filtered.length === 0
          ? <div class="no-content">No matching log entries</div>
          : filtered.map((ev, i) => (
            <div key={i} class="log-entry">
              <span class={`log-level ${ev.level}`}>{ev.level}</span>
              <span class="log-source">{ev.source}</span>
              <span class="log-message">{ev.message}</span>
            </div>
          ))
        }
      </div>
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

function StackTraceView({ stack, selected, onSelect }: { stack: SourceLocation[]; selected: number; onSelect: (i: number) => void }) {
  return (
    <div class="source-stack">
      <div class="source-stack-title">Call stack</div>
      {stack.map((frame, i) => frame?.file && (
        <div
          key={i}
          class={`source-stack-frame${i === selected ? ' selected' : ''}`}
          title={`${frame.file}:${frame.line}`}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(i)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(i); } }}
        >
          <span class="source-stack-file">{frame.file?.replace(/\\/g, '/').split('/').pop() ?? ''}</span>
          <span class="source-stack-line">:{frame.line}</span>
        </div>
      ))}
    </div>
  );
}

function SourceTab({ event, sources, previewHighlight }: { event: ActionTraceEvent | AssertionTraceEvent | undefined; sources: Map<string, string>; previewHighlight?: SourceLocation }) {
  const highlightRef = useRef<HTMLDivElement>(null);
  const [selectedFrame, setSelectedFrame] = useState(0);

  // With no event (e.g. previewing a test before it runs) fall back to the
  // preview highlight so the test's `test(...)` line is still highlighted.
  const stack = event?.stack ?? (event?.sourceLocation ? [event.sourceLocation] : previewHighlight ? [previewHighlight] : []);
  const eventKey = event ? `${event.type}-${event.actionIndex}` : 'none';
  useEffect(() => { setSelectedFrame(0); }, [eventKey]);

  // Guard against a one-render window where selectedFrame is stale (out of
  // bounds) right after switching to an event with a shorter stack, before the
  // reset effect runs — otherwise resolveSourceView would briefly show nothing.
  const activeFrame = selectedFrame < stack.length ? selectedFrame : 0;

  const { filename, content, highlightLine } = resolveSourceView(stack, sources, activeFrame, !!event);

  useEffect(() => {
    // Instant (not smooth) scroll: in a trace viewer the user steps through
    // actions rapidly, and smooth scrolling lags/bounces behind the clicks.
    highlightRef.current?.scrollIntoView({ block: 'center' });
  }, [highlightLine, filename]);

  const showStack = stack.length > 1;

  if (content === undefined) {
    return (
      <div class={`source-tab${showStack ? ' has-stack' : ''}`}>
        <div class="source-main">
          <div class="no-content">
            {filename ? `Source not captured for ${filename.replace(/\\/g, '/').split('/').pop()}` : 'No source files in trace'}
          </div>
        </div>
        {showStack && <StackTraceView stack={stack} selected={activeFrame} onSelect={setSelectedFrame} />}
      </div>
    );
  }

  const lines = content.split('\n');
  let inBlockComment = false;
  const tokenizedLines: SourceToken[][] = [];
  for (const line of lines) {
    const result = tokenizeLine(line, inBlockComment);
    tokenizedLines.push(result.tokens);
    inBlockComment = result.inBlockComment;
  }

  return (
    <div class={`source-tab${showStack ? ' has-stack' : ''}`}>
      <div class="source-main">
        <div class="source-filename">{filename}</div>
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
                    })}
              </span>
            </div>
          ))}
        </div>
      </div>
      {showStack && <StackTraceView stack={stack} selected={activeFrame} onSelect={setSelectedFrame} />}
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

function errorTitle(ev: ActionTraceEvent | AssertionTraceEvent): string {
  if (ev.type === 'assertion') {
    return `Error: expect(locator).${ev.assertion}() failed`;
  }
  return `Error: ${ev.action}() failed`;
}

function buildCodeFrame(sources: Map<string, string>, loc: { file: string; line: number } | undefined): string | null {
  if (!loc || sources.size === 0) return null;
  const basename = loc.file.split('/').pop()!;
  const content = sources.get(loc.file) ?? sources.get(basename);
  if (!content) return null;
  const snippet = buildCodeSnippet(content, loc.line);
  return formatCodeSnippetPlain(snippet);
}

function ErrorsTab({ event, events, testError, sources }: {
  event: ActionTraceEvent | AssertionTraceEvent | undefined
  events: AnyTraceEvent[]
  testError?: string
  sources: Map<string, string>
}) {
  const failedEvents = events.filter((e): e is ActionTraceEvent | AssertionTraceEvent =>
    (e.type === 'action' && !(e as ActionTraceEvent).success) ||
    (e.type === 'assertion' && !(e as AssertionTraceEvent).passed),
  );

  // The test-level error is usually the message of the failing assertion, so
  // suppress it when a matching failed event exists (mirrors Playwright, which
  // shows one error block per failure rather than duplicating at the bottom).
  const showTestError = testError
    && !failedEvents.some((ev) => ev.error && testError.includes(ev.error));

  if (failedEvents.length === 0 && !testError) return <div class="no-content">No errors</div>;

  return (
    <div class="error-block">
      {failedEvents.map((ev, i) => (
        <ErrorEntry
          key={i}
          ev={ev}
          isSelected={!!event && event.actionIndex === ev.actionIndex && event.type === ev.type}
          sources={sources}
        />
      ))}
      {showTestError && (
        <div class="error-entry">
          <div class="error-title"><AlertTriangle size={14} class="error-title-icon" />Test Error</div>
          <div class="error-message">{testError}</div>
        </div>
      )}
    </div>
  );
}

function ErrorEntry({ ev, isSelected, sources }: { ev: ActionTraceEvent | AssertionTraceEvent; isSelected: boolean; sources: Map<string, string> }) {
  const title = errorTitle(ev);
  const log = ev.type === 'action' ? ev.log : undefined;
  const stack = ev.type === 'action' ? ev.errorStack : undefined;
  const isAssertion = ev.type === 'assertion';
  const codeFrame = buildCodeFrame(sources, ev.sourceLocation);

  const errorLines: string[] = [];
  if (ev.error) errorLines.push(ev.error);
  if (codeFrame) { errorLines.push(''); errorLines.push(codeFrame); }

  const hasGrid = ev.selector || (isAssertion && (ev.expected !== undefined || ev.actual !== undefined));

  return (
    <div class={`error-entry${isSelected ? ' error-entry-selected' : ''}`}>
      <div class="error-title"><AlertTriangle size={14} class="error-title-icon" />{title}</div>

      {hasGrid && (
        <div class="error-grid">
          {ev.selector && <>
            <div class="error-grid-key">Locator</div>
            {formatSelectorForCall(ev.selector)}
          </>}
          {isAssertion && ev.expected !== undefined && <>
            <div class="error-grid-key">Expected</div>
            <div class="error-grid-value expected">{ev.expected}</div>
          </>}
          {isAssertion && ev.actual !== undefined && <>
            <div class="error-grid-key">Received</div>
            <div class="error-grid-value received">{ev.actual}</div>
          </>}
        </div>
      )}

      {errorLines.length > 0 && (
        <pre class="error-detail-block">{errorLines.join('\n')}</pre>
      )}

      {log && log.length > 0 && (
        <details class="error-stack-details">
          <summary>Call log</summary>
          <ul class="error-log-list">
            {log.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </details>
      )}

      {stack && (
        <details class="error-stack-details">
          <summary>Stack trace</summary>
          <pre class="error-stack">{stack}</pre>
        </details>
      )}
    </div>
  );
}
