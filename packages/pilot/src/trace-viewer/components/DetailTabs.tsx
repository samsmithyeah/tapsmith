import { useState } from 'preact/hooks'
import type { ActionTraceEvent, AssertionTraceEvent, AnyTraceEvent, ConsoleTraceEvent, TraceMetadata } from '../../trace/types.js'

interface Props {
  event: ActionTraceEvent | AssertionTraceEvent | undefined
  events: AnyTraceEvent[]
  hierarchies: Map<string, string>
  sources: Map<string, string>
  metadata: TraceMetadata
}

type DetailTab = 'call' | 'log' | 'console' | 'source' | 'hierarchy' | 'errors'

export function DetailTabs({ event, events, hierarchies, sources, metadata }: Props) {
  const [tab, setTab] = useState<DetailTab>('call')

  const hasError = event && (
    (event.type === 'action' && !event.success) ||
    (event.type === 'assertion' && !event.passed)
  )
  const hasSources = sources.size > 0
  const hasHierarchy = hierarchies.size > 0

  const consoleEvents = events.filter((e): e is ConsoleTraceEvent => e.type === 'console')
  const hasConsole = consoleEvents.length > 0

  return (
    <div class="detail-panel">
      <div class="detail-tabs-bar">
        <div class={`detail-tab${tab === 'call' ? ' active' : ''}`} onClick={() => setTab('call')}>Call</div>
        {hasConsole && (
          <div class={`detail-tab${tab === 'console' ? ' active' : ''}`} onClick={() => setTab('console')}>Console</div>
        )}
        {hasSources && (
          <div class={`detail-tab${tab === 'source' ? ' active' : ''}`} onClick={() => setTab('source')}>Source</div>
        )}
        {hasHierarchy && (
          <div class={`detail-tab${tab === 'hierarchy' ? ' active' : ''}`} onClick={() => setTab('hierarchy')}>Hierarchy</div>
        )}
        {hasError && (
          <div class={`detail-tab${tab === 'errors' ? ' active' : ''}${hasError ? ' has-error' : ''}`} onClick={() => setTab('errors')}>Errors</div>
        )}
      </div>
      <div class="detail-content">
        {tab === 'call' && <CallTab event={event} />}
        {tab === 'console' && <ConsoleTab event={event} events={consoleEvents} />}
        {tab === 'source' && <SourceTab event={event} sources={sources} />}
        {tab === 'hierarchy' && <HierarchyTab event={event} hierarchies={hierarchies} />}
        {tab === 'errors' && <ErrorsTab event={event} />}
      </div>
    </div>
  )
}

// ─── Call Tab ───

function CallTab({ event }: { event: ActionTraceEvent | AssertionTraceEvent | undefined }) {
  if (!event) return <div class="no-content">No action selected</div>

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
    )
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
  )
}

// ─── Console Tab ───

function ConsoleTab({ event, events: consoleEvents }: { event: ActionTraceEvent | AssertionTraceEvent | undefined; events: ConsoleTraceEvent[] }) {
  if (consoleEvents.length === 0) return <div class="no-content">No console output recorded</div>

  const relevant = event
    ? consoleEvents.filter(e => Math.abs(e.actionIndex - event.actionIndex) <= 1)
    : consoleEvents

  if (relevant.length === 0) return <div class="no-content">No console output for this action</div>

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
  )
}

// ─── Source Tab ───

function SourceTab({ event, sources }: { event: ActionTraceEvent | AssertionTraceEvent | undefined; sources: Map<string, string> }) {
  if (sources.size === 0) return <div class="no-content">No source files in trace</div>

  const [filename, content] = [...sources.entries()][0]
  const loc = event?.sourceLocation
  const highlightLine = loc?.line

  const lines = content.split('\n')

  return (
    <div>
      <div style={{ color: '#888', fontSize: '11px', marginBottom: '6px', fontFamily: 'monospace' }}>{filename}</div>
      <div class="source-code">
        {lines.map((line, i) => (
          <div key={i} class={`source-line${highlightLine === i + 1 ? ' highlight' : ''}`}>
            <span class="source-line-number">{i + 1}</span>
            <span class="source-line-content">{line}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Hierarchy Tab ───

function HierarchyTab({ event, hierarchies }: { event: ActionTraceEvent | AssertionTraceEvent | undefined; hierarchies: Map<string, string> }) {
  const [search, setSearch] = useState('')

  if (!event || hierarchies.size === 0) return <div class="no-content">No view hierarchy available</div>

  const pad = String(event.actionIndex).padStart(3, '0')
  const afterKey = `hierarchy/action-${pad}-after.xml`
  const beforeKey = `hierarchy/action-${pad}-before.xml`
  const xml = hierarchies.get(afterKey) ?? hierarchies.get(beforeKey)

  if (!xml) return <div class="no-content">No hierarchy snapshot for this action</div>

  const lines = xml.split('\n').filter(Boolean)
  const filtered = search
    ? lines.filter(l => l.toLowerCase().includes(search.toLowerCase()))
    : lines

  return (
    <div>
      <div class="hierarchy-search">
        <input
          type="text"
          placeholder="Search hierarchy (class, text, id)..."
          value={search}
          onInput={e => setSearch((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class="hierarchy-tree">
        {filtered.map((line, i) => {
          const indent = line.match(/^\s*/)?.[0].length ?? 0
          const trimmed = line.trim()
          return (
            <div key={i} class="hierarchy-node" style={{ paddingLeft: `${Math.min(indent, 40) * 6}px` }}>
              <HierarchyLine content={trimmed} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function HierarchyLine({ content }: { content: string }) {
  const tagMatch = content.match(/^(<\/?)(\w[\w.]*)([\s\S]*?)(\/?>)$/)
  if (!tagMatch) return <span>{content}</span>

  const parts: preact.JSX.Element[] = []
  parts.push(<span>{tagMatch[1]}</span>)
  parts.push(<span class="hierarchy-class">{tagMatch[2]}</span>)

  const attrs = tagMatch[3]
  const attrRe = /(\w[\w-]*)="([^"]*)"/g
  let lastIndex = 0
  let attrMatch
  while ((attrMatch = attrRe.exec(attrs)) !== null) {
    if (attrMatch.index > lastIndex) parts.push(<span>{attrs.slice(lastIndex, attrMatch.index)}</span>)
    parts.push(<span class="hierarchy-attr">{attrMatch[1]}</span>)
    parts.push(<span>=</span>)
    parts.push(<span class="hierarchy-attr-value">"{attrMatch[2]}"</span>)
    lastIndex = attrRe.lastIndex
  }
  if (lastIndex < attrs.length) parts.push(<span>{attrs.slice(lastIndex)}</span>)
  parts.push(<span>{tagMatch[4]}</span>)

  return <>{parts}</>
}

// ─── Errors Tab ───

function ErrorsTab({ event }: { event: ActionTraceEvent | AssertionTraceEvent | undefined }) {
  if (!event) return null

  const error = event.type === 'action' ? event.error : event.error
  const stack = event.type === 'action' ? event.errorStack : undefined

  if (!error) return <div class="no-content">No errors</div>

  return (
    <div class="error-block">
      <div class="error-message">{error}</div>
      {stack && <pre class="error-stack">{stack}</pre>}
      {event.type === 'assertion' && !event.passed && (
        <div style={{ marginTop: '8px', fontSize: '12px' }}>
          {event.expected !== undefined && (
            <div><span style={{ color: '#888' }}>Expected: </span><span style={{ color: '#4ec9b0' }}>{event.expected}</span></div>
          )}
          {event.actual !== undefined && (
            <div><span style={{ color: '#888' }}>Actual: </span><span style={{ color: '#f85149' }}>{event.actual}</span></div>
          )}
        </div>
      )}
    </div>
  )
}
