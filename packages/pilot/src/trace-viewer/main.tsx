import { render } from 'preact'
import { useState, useEffect, useCallback } from 'preact/hooks'
import { unzipSync, strFromU8 } from 'fflate'
import type { AnyTraceEvent, ActionTraceEvent, AssertionTraceEvent, TraceMetadata } from '../trace/types.js'
import { ActionsPanel } from './components/ActionsPanel.js'
import { ScreenshotPanel } from './components/ScreenshotPanel.js'
import { DetailTabs } from './components/DetailTabs.js'
import { TimelineFilmstrip } from './components/TimelineFilmstrip.js'

// ─── Types ───

export interface TraceData {
  metadata: TraceMetadata
  events: AnyTraceEvent[]
  screenshots: Map<string, string>
  hierarchies: Map<string, string>
  sources: Map<string, string>
}

// ─── Zip Loader ───

async function loadTraceFromUrl(url: string): Promise<TraceData> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Failed to load trace: HTTP ${resp.status}`)
  const buf = new Uint8Array(await resp.arrayBuffer())
  return parseTraceZip(buf)
}

async function loadTraceFromFile(file: File): Promise<TraceData> {
  const buf = new Uint8Array(await file.arrayBuffer())
  return parseTraceZip(buf)
}

function parseTraceZip(buf: Uint8Array): TraceData {
  const files = unzipSync(buf)
  const decoder = new TextDecoder()

  const metadataRaw = files['metadata.json']
  if (!metadataRaw) throw new Error('Invalid trace: missing metadata.json')
  const metadata: TraceMetadata = JSON.parse(decoder.decode(metadataRaw))

  const traceRaw = files['trace.json']
  const events: AnyTraceEvent[] = traceRaw
    ? decoder.decode(traceRaw).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []

  const screenshots = new Map<string, string>()
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith('screenshots/') && name.endsWith('.png')) {
      screenshots.set(name, URL.createObjectURL(new Blob([data], { type: 'image/png' })))
    }
  }

  const hierarchies = new Map<string, string>()
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith('hierarchy/') && name.endsWith('.xml')) {
      hierarchies.set(name, decoder.decode(data))
    }
  }

  const sources = new Map<string, string>()
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith('sources/')) {
      sources.set(name.replace('sources/', ''), decoder.decode(data))
    }
  }

  return { metadata, events, screenshots, hierarchies, sources }
}

// ─── App ───

function App() {
  const [trace, setTrace] = useState<TraceData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const traceUrl = params.get('trace')
    if (traceUrl) {
      setLoading(true)
      loadTraceFromUrl(traceUrl)
        .then(data => {
          setTrace(data)
          setLoading(false)
          const actionParam = params.get('action')
          if (actionParam) setSelectedIndex(parseInt(actionParam, 10))
        })
        .catch(err => { setError(err.message); setLoading(false) })
    }
  }, [])

  useEffect(() => {
    if (trace) {
      const url = new URL(location.href)
      url.searchParams.set('action', String(selectedIndex))
      history.replaceState(null, '', url.toString())
    }
  }, [selectedIndex, trace])

  const actionEvents = trace?.events.filter(
    (e): e is ActionTraceEvent | AssertionTraceEvent =>
      e.type === 'action' || e.type === 'assertion'
  ) ?? []

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, actionEvents.length - 1))
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    }
  }, [actionEvents.length])

  useEffect(() => {
    if (!trace) return
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [trace, handleKeyDown])

  const handleFileDrop = (e: DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer?.files[0]
    if (file) {
      setLoading(true); setError(null)
      loadTraceFromFile(file)
        .then(data => { setTrace(data); setLoading(false) })
        .catch(err => { setError(err.message); setLoading(false) })
    }
  }

  const handleFileInput = (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (file) {
      setLoading(true); setError(null)
      loadTraceFromFile(file)
        .then(data => { setTrace(data); setLoading(false) })
        .catch(err => { setError(err.message); setLoading(false) })
    }
  }

  if (loading) {
    return <div class="empty-screen"><div class="spinner" /><p>Loading trace...</p></div>
  }

  if (error) {
    return (
      <div class="empty-screen">
        <h2 style={{ color: '#f85149' }}>Failed to load trace</h2>
        <p style={{ color: '#8b949e' }}>{error}</p>
        <label class="file-picker-btn">Choose a trace file<input type="file" accept=".zip" onChange={handleFileInput} /></label>
      </div>
    )
  }

  if (!trace) {
    return (
      <div class="empty-screen" onDragOver={e => e.preventDefault()} onDrop={handleFileDrop}>
        <div class="drop-content">
          <div class="logo">Pilot</div>
          <h1>Trace Viewer</h1>
          <p>Drop a <code>.zip</code> trace file here</p>
          <p class="or">or</p>
          <label class="file-picker-btn">Select file<input type="file" accept=".zip" onChange={handleFileInput} /></label>
          <p class="privacy-note">Trace Viewer is a client-side app. Your data stays in your browser.</p>
        </div>
      </div>
    )
  }

  const selectedEvent = actionEvents[selectedIndex]

  return (
    <div class="viewer">
      {/* Top: Timeline */}
      <TimelineFilmstrip
        events={actionEvents}
        screenshots={trace.screenshots}
        metadata={trace.metadata}
        selectedIndex={selectedIndex}
        onSelect={setSelectedIndex}
      />
      {/* Middle: Actions + Screenshot */}
      <div class="middle-row">
        <ActionsPanel
          events={trace.events}
          actionEvents={actionEvents}
          selectedIndex={selectedIndex}
          onSelect={setSelectedIndex}
          metadata={trace.metadata}
        />
        <ScreenshotPanel
          event={selectedEvent}
          screenshots={trace.screenshots}
        />
      </div>
      {/* Bottom: Detail tabs */}
      <DetailTabs
        event={selectedEvent}
        events={trace.events}
        hierarchies={trace.hierarchies}
        sources={trace.sources}
        metadata={trace.metadata}
      />
    </div>
  )
}

// ─── Styles ───

const style = document.createElement('style')
style.textContent = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1e1e1e; color: #ccc; font-size: 13px; overflow: hidden; height: 100vh; }
  #app { height: 100vh; display: flex; flex-direction: column; }

  /* Empty/loading screens */
  .empty-screen { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; gap: 12px; }
  .spinner { width: 28px; height: 28px; border: 3px solid #333; border-top-color: #4fc1ff; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .drop-content { text-align: center; }
  .drop-content .logo { font-size: 14px; font-weight: 700; color: #4fc1ff; text-transform: uppercase; letter-spacing: 3px; margin-bottom: 4px; }
  .drop-content h1 { font-size: 24px; color: #e8e8e8; font-weight: 300; margin-bottom: 24px; }
  .drop-content p { color: #888; margin-bottom: 8px; }
  .drop-content code { background: #2d2d2d; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
  .drop-content .or { color: #555; font-size: 12px; }
  .drop-content .privacy-note { font-size: 11px; color: #555; margin-top: 24px; }
  .file-picker-btn { display: inline-block; padding: 8px 24px; background: #4fc1ff; color: #000; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 13px; }
  .file-picker-btn:hover { background: #6dcfff; }
  .file-picker-btn input { display: none; }

  /* Viewer layout — Playwright-inspired: timeline top, actions+screenshot middle, details bottom */
  .viewer { display: flex; flex-direction: column; height: 100vh; }
  .middle-row { display: flex; flex: 1; min-height: 0; overflow: hidden; }

  /* ─── Timeline ─── */
  .timeline { display: flex; align-items: flex-end; gap: 0; padding: 0; background: #252526; border-bottom: 1px solid #3c3c3c; flex-shrink: 0; overflow-x: auto; position: relative; height: 80px; }
  .timeline-inner { display: flex; align-items: flex-end; gap: 2px; padding: 4px 8px; min-width: 100%; }
  .timeline-thumb { height: 56px; width: auto; border-radius: 2px; border: 2px solid transparent; cursor: pointer; opacity: 0.6; transition: all 0.1s; flex-shrink: 0; }
  .timeline-thumb:hover { opacity: 1; }
  .timeline-thumb.selected { opacity: 1; border-color: #4fc1ff; }
  .timeline-thumb.failed { border-bottom: 2px solid #f85149; }
  .timeline-placeholder { width: 40px; height: 56px; border-radius: 2px; background: #2d2d2d; border: 2px solid transparent; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #555; flex-shrink: 0; cursor: pointer; }
  .timeline-placeholder.selected { border-color: #4fc1ff; }
  .timeline-time-axis { position: absolute; top: 0; left: 0; right: 0; height: 18px; padding: 0 8px; display: flex; align-items: center; font-size: 10px; color: #666; pointer-events: none; }
  .timeline-time-label { position: absolute; transform: translateX(-50%); }
  .timeline-meta { position: absolute; top: 2px; right: 12px; font-size: 11px; color: #666; }
  .timeline-meta .test-status { font-weight: 600; }
  .timeline-meta .passed { color: #4ec9b0; }
  .timeline-meta .failed { color: #f85149; }

  /* ─── Actions panel ─── */
  .actions-panel { width: 300px; min-width: 240px; max-width: 400px; border-right: 1px solid #3c3c3c; display: flex; flex-direction: column; background: #252526; overflow: hidden; flex-shrink: 0; }
  .actions-header { display: flex; align-items: center; border-bottom: 1px solid #3c3c3c; flex-shrink: 0; }
  .actions-header-tab { padding: 6px 14px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #888; cursor: pointer; border-bottom: 2px solid transparent; }
  .actions-header-tab.active { color: #e8e8e8; border-bottom-color: #4fc1ff; }
  .actions-filter { padding: 6px 8px; border-bottom: 1px solid #3c3c3c; flex-shrink: 0; }
  .actions-filter input { width: 100%; padding: 4px 8px; background: #1e1e1e; border: 1px solid #3c3c3c; border-radius: 3px; color: #ccc; font-size: 12px; outline: none; }
  .actions-filter input:focus { border-color: #4fc1ff; }
  .actions-list { flex: 1; overflow-y: auto; }

  .action-item { padding: 5px 10px; cursor: pointer; border-left: 2px solid transparent; display: flex; align-items: center; gap: 8px; min-height: 30px; }
  .action-item:hover { background: #2a2d2e; }
  .action-item.selected { background: #04395e; border-left-color: #4fc1ff; }
  .action-item.failed { }
  .action-item.failed .action-name { color: #f85149; }
  .action-icon { font-size: 12px; flex-shrink: 0; width: 18px; text-align: center; color: #888; }
  .action-icon.tap { color: #4ec9b0; }
  .action-icon.type { color: #ce9178; }
  .action-icon.swipe { color: #569cd6; }
  .action-icon.scroll { color: #569cd6; }
  .action-icon.nav { color: #dcdcaa; }
  .action-icon.assert { color: #b5cea8; }
  .action-icon.assert.failed { color: #f85149; }
  .action-name { font-size: 12px; color: #e8e8e8; white-space: nowrap; }
  .action-selector-text { color: #888; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .action-duration { color: #555; font-size: 11px; flex-shrink: 0; margin-left: auto; padding-left: 8px; }
  .action-details { display: flex; align-items: center; overflow: hidden; flex: 1; min-width: 0; gap: 6px; }

  .group-item { padding: 4px 10px; color: #888; font-size: 11px; font-weight: 600; border-left: 2px solid #4fc1ff; background: #1e2a3a; }

  /* Metadata panel */
  .metadata-panel { padding: 12px; font-size: 12px; overflow-y: auto; flex: 1; }
  .metadata-grid { display: grid; grid-template-columns: 100px 1fr; gap: 4px 12px; }
  .metadata-label { color: #888; }
  .metadata-value { color: #ccc; word-break: break-all; }

  /* ─── Screenshot panel ─── */
  .screenshot-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: #1e1e1e; }
  .screenshot-tabs { display: flex; gap: 0; border-bottom: 1px solid #3c3c3c; background: #252526; flex-shrink: 0; }
  .screenshot-tab { padding: 6px 16px; cursor: pointer; color: #888; border-bottom: 2px solid transparent; font-size: 12px; }
  .screenshot-tab:hover { color: #ccc; }
  .screenshot-tab.active { color: #e8e8e8; border-bottom-color: #4fc1ff; }
  .screenshot-container { flex: 1; display: flex; align-items: center; justify-content: center; overflow: auto; padding: 16px; }
  .device-frame { background: #111; border-radius: 24px; padding: 12px 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); display: inline-block; transition: transform 0.1s; }
  .screenshot-empty { color: #555; text-align: center; font-size: 13px; }

  /* ─── Detail tabs (bottom panel) ─── */
  .detail-panel { height: 220px; min-height: 120px; max-height: 400px; border-top: 1px solid #3c3c3c; display: flex; flex-direction: column; background: #1e1e1e; flex-shrink: 0; }
  .detail-tabs-bar { display: flex; gap: 0; background: #252526; border-bottom: 1px solid #3c3c3c; flex-shrink: 0; }
  .detail-tab { padding: 6px 14px; cursor: pointer; color: #888; border-bottom: 2px solid transparent; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .detail-tab:hover { color: #ccc; }
  .detail-tab.active { color: #e8e8e8; border-bottom-color: #4fc1ff; }
  .detail-tab.has-error { color: #f85149; }
  .detail-content { flex: 1; overflow-y: auto; padding: 10px 14px; font-size: 12px; }

  /* Call tab */
  .call-grid { display: grid; grid-template-columns: 90px 1fr; gap: 3px 12px; }
  .call-label { color: #888; }
  .call-value { color: #ccc; word-break: break-all; }
  .call-value.error { color: #f85149; }
  .call-value.success { color: #4ec9b0; }

  /* Log/Console tab */
  .log-entry { font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 11px; padding: 1px 0; display: flex; gap: 8px; line-height: 1.6; }
  .log-level { min-width: 40px; font-weight: 600; text-transform: uppercase; font-size: 10px; }
  .log-level.error { color: #f85149; }
  .log-level.warn { color: #cca700; }
  .log-level.info { color: #4fc1ff; }
  .log-level.debug { color: #888; }
  .log-level.log { color: #ccc; }
  .log-source { font-size: 10px; color: #555; min-width: 46px; }
  .log-message { word-break: break-all; }

  /* Source tab */
  .source-code { font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 12px; line-height: 1.5; white-space: pre; overflow-x: auto; }
  .source-line { display: flex; }
  .source-line-number { min-width: 40px; text-align: right; padding-right: 12px; color: #555; user-select: none; }
  .source-line-content { flex: 1; }
  .source-line.highlight { background: rgba(79,193,255,0.12); }

  /* Hierarchy tab */
  .hierarchy-tree { font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 11px; line-height: 1.5; }
  .hierarchy-node { padding: 0; }
  .hierarchy-class { color: #4ec9b0; }
  .hierarchy-attr { color: #9cdcfe; }
  .hierarchy-attr-value { color: #ce9178; }
  .hierarchy-search { padding: 6px 8px; border-bottom: 1px solid #3c3c3c; }
  .hierarchy-search input { width: 100%; padding: 4px 8px; background: #1e1e1e; border: 1px solid #3c3c3c; border-radius: 3px; color: #ccc; font-size: 12px; outline: none; }
  .hierarchy-search input:focus { border-color: #4fc1ff; }

  /* Errors tab */
  .error-block { background: #2d1215; border: 1px solid #f8514933; border-radius: 4px; padding: 10px; margin-bottom: 8px; }
  .error-message { color: #f85149; font-weight: 500; margin-bottom: 6px; font-size: 12px; }
  .error-stack { font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 11px; color: #888; white-space: pre-wrap; word-break: break-all; }
  .no-content { color: #555; font-size: 12px; }
`
document.head.appendChild(style)

// ─── Render ───

render(<App />, document.getElementById('app')!)
