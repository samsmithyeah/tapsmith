import { render } from 'preact'
import { useState, useCallback, useMemo, useRef } from 'preact/hooks'
import type { ServerMessage, ClientMessage } from './ui-protocol.js'
import type { AnyTraceEvent, ActionTraceEvent, AssertionTraceEvent, TraceMetadata, NetworkEntry } from '../trace/types.js'
import { useWebSocket } from './hooks/use-websocket.js'
import { useScreenMirror } from './hooks/use-screen-mirror.js'
import { useTestTree } from './hooks/use-test-tree.js'
import { Layout } from './components/Layout.js'
import { TestExplorer } from './components/TestExplorer.js'
import { RunControls, type Theme } from './components/RunControls.js'
import { DeviceMirror } from './components/DeviceMirror.js'

// Trace viewer components — reused for live trace display
import { ActionsPanel } from '../trace-viewer/components/ActionsPanel.js'
import { ScreenshotPanel } from '../trace-viewer/components/ScreenshotPanel.js'
import { DetailTabs } from '../trace-viewer/components/DetailTabs.js'
import { TimelineFilmstrip } from '../trace-viewer/components/TimelineFilmstrip.js'

// ─── Helpers ───

function base64ToBlobUrl(base64: string): string {
  const bytes = atob(base64)
  const arr = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return URL.createObjectURL(new Blob([arr], { type: 'image/png' }))
}

const EMPTY_MAP = new Map<string, string>()
const EMPTY_EVENTS: AnyTraceEvent[] = []
const EMPTY_ACTION_EVENTS: (ActionTraceEvent | AssertionTraceEvent)[] = []
const EMPTY_NETWORK: NetworkEntry[] = []

/** Per-test trace data accumulated during execution. */
interface TestTraceData {
  events: AnyTraceEvent[]
  actionEvents: (ActionTraceEvent | AssertionTraceEvent)[]
  screenshots: Map<string, string>
  hierarchies: Map<string, string>
  network: NetworkEntry[]
}

function emptyTraceData(): TestTraceData {
  return { events: [], actionEvents: [], screenshots: new Map(), hierarchies: new Map(), network: [] }
}

// ─── App ───

function App() {
  const [connected, setConnected] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [deviceSerial, setDeviceSerial] = useState('')
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('pilot-ui-theme')
    return (stored === 'light' || stored === 'dark' || stored === 'system') ? stored : 'system'
  })

  // Per-test trace data, keyed by test fullName
  const [testTraces, setTestTraces] = useState<Map<string, TestTraceData>>(new Map())
  // Ref tracks the currently-running test — a ref (not state) so the message
  // handler always reads the latest value regardless of React batching.
  const activeTestRef = useRef<string | null>(null)
  const [activeTestName, setActiveTestName] = useState<string | null>(null)
  const [sources, setSources] = useState<Map<string, string>>(new Map())
  const [pinnedIndex, setPinnedIndex] = useState(0)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const selectedIndex = hoveredIndex ?? pinnedIndex

  // Whether to show live device vs action screenshots
  const [showLiveDevice, setShowLiveDevice] = useState(true)

  const tree = useTestTree()
  const { canvasRef, handleBinaryFrame } = useScreenMirror()

  // Get the currently viewed test's trace data.
  // Prefer the test selected in the explorer; fall back to the actively running test.
  const viewedTestName = useMemo(() => {
    // If a test node is selected in the tree, use its fullName
    if (tree.selectedTestId) {
      // selectedTestId is in the format "filePath::fullName" for tests
      const sep = tree.selectedTestId.indexOf('::')
      if (sep !== -1) {
        const fullName = tree.selectedTestId.slice(sep + 2)
        if (testTraces.has(fullName)) return fullName
      }
    }
    return activeTestName
  }, [tree.selectedTestId, activeTestName, testTraces])

  const currentTrace = viewedTestName ? testTraces.get(viewedTestName) : undefined
  const traceEvents = currentTrace?.events ?? EMPTY_EVENTS
  const actionEvents = currentTrace?.actionEvents ?? EMPTY_ACTION_EVENTS
  const screenshots = currentTrace?.screenshots ?? EMPTY_MAP
  const hierarchies = currentTrace?.hierarchies ?? EMPTY_MAP
  const networkEntries = currentTrace?.network ?? EMPTY_NETWORK

  // Stub metadata for trace viewer components
  const metadata = useMemo<TraceMetadata>(() => ({
    version: 1,
    pilotVersion: '',
    testFile: '',
    testName: viewedTestName ?? (isRunning ? 'Running...' : ''),
    testStatus: 'passed',
    testDuration: 0,
    startTime: 0,
    endTime: 0,
    device: { serial: deviceSerial, isEmulator: deviceSerial.startsWith('emulator-') },
    traceConfig: { screenshots: true, snapshots: true, sources: true, network: true },
    actionCount: actionEvents.length,
    screenshotCount: screenshots.size,
  }), [viewedTestName, isRunning, actionEvents.length, screenshots.size, deviceSerial])

  const selectedEvent = actionEvents[selectedIndex]

  /** Get or create trace data for a test. */
  function getOrCreateTrace(testFullName: string, traces: Map<string, TestTraceData>): { data: TestTraceData; map: Map<string, TestTraceData> } {
    const existing = traces.get(testFullName)
    if (existing) return { data: existing, map: traces }
    const data = emptyTraceData()
    const map = new Map(traces)
    map.set(testFullName, data)
    return { data, map }
  }

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'test-tree':
        tree.setTestTree(msg.files)
        break
      case 'run-start':
        setIsRunning(true)
        setTestTraces(new Map())
        activeTestRef.current = null
        setActiveTestName(null)
        setSources(new Map())
        setPinnedIndex(0)
        setHoveredIndex(null)
        setShowLiveDevice(true)
        break
      case 'run-end':
        setIsRunning(false)
        break
      case 'test-start':
        // Update ref immediately (no batching delay)
        activeTestRef.current = msg.fullName
        setActiveTestName(msg.fullName)
        setPinnedIndex(0)
        setHoveredIndex(null)
        // Mark this test (and its parent describe/file) as running
        tree.updateTestStatus(msg.fullName, msg.filePath, 'running')
        // Auto-select this test in the explorer
        tree.setSelectedTestId(`${msg.filePath}::${msg.fullName}`)
        // Ensure trace data exists for this test
        setTestTraces((prev) => {
          if (prev.has(msg.fullName)) return prev
          const next = new Map(prev)
          next.set(msg.fullName, emptyTraceData())
          return next
        })
        break
      case 'test-status':
        tree.updateTestStatus(msg.fullName, msg.filePath, msg.status, msg.duration, msg.error)
        break
      case 'file-status':
        tree.updateFileStatus(msg.filePath, msg.status)
        break
      case 'trace-event': {
        const testName = msg.testFullName || activeTestRef.current
        if (!testName) break
        const ev = msg.event

        setTestTraces((prev) => {
          const { data, map } = getOrCreateTrace(testName, prev)

          // Append event. For assertions without bounds, inherit from the
          // most recent action that had bounds (e.g. find() → toBe() chain).
          let eventToStore = ev
          if ((ev.type === 'assertion' && !ev.bounds) || (ev.type === 'action' && !ev.bounds)) {
            const prevWithBounds = [...data.actionEvents].reverse().find((e) =>
              (e.type === 'action' || e.type === 'assertion') && e.bounds
            )
            if (prevWithBounds?.bounds) {
              eventToStore = { ...ev, bounds: prevWithBounds.bounds }
            }
          }
          const events = [...data.events, eventToStore]
          const actionEvents = (eventToStore.type === 'action' || eventToStore.type === 'assertion')
            ? [...data.actionEvents, eventToStore as ActionTraceEvent | AssertionTraceEvent]
            : data.actionEvents

          // Store screenshots/hierarchies
          const screenshots = new Map(data.screenshots)
          const hierarchies = new Map(data.hierarchies)
          if (ev.type === 'action' || ev.type === 'assertion') {
            const pad = String(ev.actionIndex).padStart(3, '0')
            if (msg.screenshotBefore) {
              screenshots.set(`screenshots/action-${pad}-before.png`, base64ToBlobUrl(msg.screenshotBefore))
            }
            if (msg.screenshotAfter) {
              screenshots.set(`screenshots/action-${pad}-after.png`, base64ToBlobUrl(msg.screenshotAfter))
            }
            // For actions without screenshots (e.g. generic toBe assertions),
            // inherit the most recent screenshot so clicking them still shows
            // the device state.
            if (!msg.screenshotBefore && !msg.screenshotAfter) {
              const prevIdx = ev.actionIndex - 1
              if (prevIdx >= 0) {
                const prevPad = String(prevIdx).padStart(3, '0')
                const prevAfter = screenshots.get(`screenshots/action-${prevPad}-after.png`)
                  ?? screenshots.get(`screenshots/action-${prevPad}-before.png`)
                if (prevAfter) {
                  screenshots.set(`screenshots/action-${pad}-before.png`, prevAfter)
                }
              }
            }
            if (msg.hierarchyBefore) {
              hierarchies.set(`hierarchy/action-${pad}-before.xml`, msg.hierarchyBefore)
            }
            if (msg.hierarchyAfter) {
              hierarchies.set(`hierarchy/action-${pad}-after.xml`, msg.hierarchyAfter)
            }
          }

          const next = new Map(map)
          next.set(testName, { events, actionEvents, screenshots, hierarchies, network: data.network })
          return next
        })

        // Auto-pin to latest action for the active test
        if ((ev.type === 'action' || ev.type === 'assertion') && testName === activeTestRef.current) {
          setPinnedIndex(ev.actionIndex)
          setShowLiveDevice(false)
        }
        break
      }
      case 'source':
        setSources((prev) => {
          const next = new Map(prev)
          next.set(msg.fileName, msg.content)
          return next
        })
        break
      case 'network': {
        // Attach network entries to the active test
        const testName = activeTestRef.current
        if (!testName) break
        setTestTraces((prev) => {
          const { data, map } = getOrCreateTrace(testName, prev)
          const next = new Map(map)
          next.set(testName, { ...data, network: msg.entries })
          return next
        })
        break
      }
      case 'watch-event':
        if (msg.event === 'watch-enabled') {
          tree.updateWatchEnabled(msg.filePath, true)
        } else if (msg.event === 'watch-disabled') {
          tree.updateWatchEnabled(msg.filePath, false)
        }
        break
      case 'device-info':
        setDeviceSerial(msg.serial)
        break
      case 'error':
        console.error('[Pilot UI]', msg.message)
        break
    }
  }, [tree])

  const handleConnectionChange = useCallback((isConnected: boolean) => {
    setConnected(isConnected)
  }, [])

  const { send } = useWebSocket({
    onMessage: handleMessage,
    onBinaryMessage: handleBinaryFrame,
    onConnectionChange: handleConnectionChange,
  })

  const handleThemeChange = useCallback((newTheme: Theme) => {
    setTheme(newTheme)
    localStorage.setItem('pilot-ui-theme', newTheme)
    const resolved = newTheme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : newTheme
    document.documentElement.setAttribute('data-theme', resolved)
  }, [])

  const handleSend = useCallback((msg: ClientMessage) => {
    send(msg)
  }, [send])

  const handleActionPin = useCallback((index: number) => {
    setPinnedIndex(index)
    setShowLiveDevice(false)
  }, [])

  return (
    <Layout
      topBar={
        <RunControls
          connected={connected}
          isRunning={isRunning}
          isWatching={tree.allFiles.some((f) => f.watchEnabled)}
          deviceSerial={deviceSerial}
          counts={tree.counts}
          theme={theme}
          onThemeChange={handleThemeChange}
          onSend={handleSend}
        />
      }
      testExplorer={
        <TestExplorer
          files={tree.files}
          expandedNodes={tree.expandedNodes}
          selectedTestId={tree.selectedTestId}
          nameFilter={tree.nameFilter}
          statusFilter={tree.statusFilter}
          counts={tree.counts}
          onToggleExpanded={tree.toggleExpanded}
          onSelectTest={tree.setSelectedTestId}
          onSetNameFilter={tree.setNameFilter}
          onSetStatusFilter={tree.setStatusFilter}
          onSend={handleSend}
        />
      }
      filmstrip={
        actionEvents.length > 0 ? (
          <TimelineFilmstrip
            events={actionEvents}
            screenshots={screenshots}
            metadata={metadata}
            selectedIndex={selectedIndex}
            onSelect={handleActionPin}
          />
        ) : null
      }
      actionsPanel={
        <ActionsPanel
          events={traceEvents}
          actionEvents={actionEvents}
          selectedIndex={selectedIndex}
          pinnedIndex={pinnedIndex}
          onHover={setHoveredIndex}
          onPin={handleActionPin}
          metadata={metadata}
        />
      }
      screenshotPanel={
        <div class="ui-screen-area">
          {/* Tab bar to switch between live device and action screenshots */}
          <div class="ui-screen-tabs">
            <button
              class={`ui-screen-tab ${showLiveDevice ? 'active' : ''}`}
              onClick={() => setShowLiveDevice(true)}
            >
              Live Device
            </button>
            <button
              class={`ui-screen-tab ${!showLiveDevice ? 'active' : ''}`}
              onClick={() => setShowLiveDevice(false)}
              disabled={actionEvents.length === 0}
            >
              Action
            </button>
          </div>
          <div class="ui-screen-content">
            {showLiveDevice ? (
              <DeviceMirror
                canvasRef={canvasRef}
                connected={connected}
                onSend={handleSend}
              />
            ) : (
              <ScreenshotPanel
                event={selectedEvent}
                screenshots={screenshots}
              />
            )}
          </div>
        </div>
      }
      detailTabs={
        <DetailTabs
          event={selectedEvent}
          events={traceEvents}
          hierarchies={hierarchies}
          sources={sources}
          metadata={metadata}
          networkEntries={networkEntries}
          networkBodies={EMPTY_MAP}
        />
      }
    />
  )
}

// ─── Styles ───

const style = document.createElement('style')
style.textContent = `
/* ─── Reset & Base ─── */

:root, [data-theme="dark"] {
  /* UI mode variables */
  --bg-primary: #1e1e1e;
  --bg-secondary: #252526;
  --bg-tertiary: #2d2d30;
  --bg-hover: #2a2d2e;
  --bg-selected: #094771;
  --bg-active: #37373d;
  --border: #3e3e42;
  --border-light: #4e4e52;
  --color-text: #cccccc;
  --color-text-muted: #888888;
  --color-text-faint: #666666;
  --color-text-faintest: #444444;
  --color-accent: #4fc1ff;
  --color-success: #4ec9b0;
  --color-error: #f14c4c;
  --color-warning: #cca700;
  --color-skipped: #888888;
  --color-topbar-bg: #252526;
  --font-mono: 'SF Mono', 'Cascadia Code', 'Consolas', 'DejaVu Sans Mono', monospace;
  --font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  /* Trace viewer component variables (used by ActionsPanel, DetailTabs, etc.) */
  --color-bg: #1e1e1e;
  --color-bg-secondary: #252526;
  --color-bg-tertiary: #2d2d2d;
  --color-bg-hover: #2a2d2e;
  --color-bg-selected: #04395e;
  --color-bg-group: #1e2a3a;
  --color-border: #3c3c3c;
  --color-text-primary: #e8e8e8;
  --color-text-secondary: #ccc;
  --color-accent-hover: #6dcfff;
  --color-accent-dim: #264f78;
  --color-string: #ce9178;
  --color-keyword: #569cd6;
  --color-function: #dcdcaa;
  --color-number: #b5cea8;
  --color-attr: #9cdcfe;
  --color-highlight: rgba(79,193,255,0.12);
  --color-error-bg: #2d1215;
  --color-error-border: #f8514933;
  --color-spinner-track: #333;
}

[data-theme="light"] {
  --bg-primary: #ffffff;
  --bg-secondary: #f3f3f3;
  --bg-tertiary: #e8e8e8;
  --bg-hover: #e8e8e8;
  --bg-selected: #cce5ff;
  --bg-active: #d4d4d4;
  --border: #d4d4d4;
  --border-light: #c8c8c8;
  --color-text: #333333;
  --color-text-muted: #666666;
  --color-text-faint: #999999;
  --color-text-faintest: #bbbbbb;
  --color-accent: #0078d4;
  --color-success: #16825d;
  --color-error: #cd3131;
  --color-warning: #bf8803;
  --color-skipped: #888888;
  --color-topbar-bg: #f3f3f3;
  /* Trace viewer light theme */
  --color-bg: #ffffff;
  --color-bg-secondary: #f5f5f5;
  --color-bg-tertiary: #e8e8e8;
  --color-bg-hover: #eaeaea;
  --color-bg-selected: #d6ecff;
  --color-bg-group: #e8f0fa;
  --color-border: #d4d4d4;
  --color-text-primary: #1f1f1f;
  --color-text-secondary: #383838;
  --color-accent-hover: #106ebe;
  --color-accent-dim: #a0c4e8;
  --color-string: #a31515;
  --color-keyword: #0000ff;
  --color-function: #795e26;
  --color-number: #098658;
  --color-attr: #001080;
  --color-highlight: rgba(0,120,212,0.1);
  --color-error-bg: #fde7e7;
  --color-error-border: #d32f2f33;
  --color-spinner-track: #ddd;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html, body, #app {
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--bg-primary);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: 13px;
}

/* ─── Layout ─── */

.ui-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}

.ui-topbar {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--border);
}

.ui-body {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

.ui-explorer {
  flex: 0 0 auto;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  background: var(--bg-secondary);
}

.ui-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.ui-filmstrip {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--border);
  overflow: hidden;
}

.ui-middle {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

.ui-actions {
  flex: 0 0 auto;
  overflow-y: auto;
  border-right: 1px solid var(--border);
}

.ui-screenshot {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.ui-detail {
  flex: 0 0 auto;
  overflow: hidden;
  border-top: 1px solid var(--border);
}

.ui-resize-handle {
  flex: 0 0 4px;
  background: transparent;
  transition: background 0.15s;
}
.ui-resize-handle:hover { background: var(--color-accent); }
.ui-resize-col { cursor: col-resize; }
.ui-resize-row { cursor: row-resize; }

/* ─── Screen area (Live Device / Action tabs) ─── */

.ui-screen-area {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.ui-screen-tabs {
  display: flex;
  padding: 4px 8px 0;
  gap: 2px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}

.ui-screen-tab {
  padding: 5px 14px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 12px;
  font-family: var(--font-ui);
  transition: color 0.15s, border-color 0.15s;
}
.ui-screen-tab:hover { color: var(--color-text); }
.ui-screen-tab.active {
  color: var(--color-accent);
  border-bottom-color: var(--color-accent);
}
.ui-screen-tab:disabled { opacity: 0.4; cursor: not-allowed; }

.ui-screen-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ─── Run Controls (Top Bar) ─── */

.run-controls {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  gap: 12px;
  background: var(--bg-secondary);
  min-height: 42px;
}

.rc-left { display: flex; align-items: center; gap: 8px; }
.rc-center { display: flex; align-items: center; gap: 6px; flex: 1; justify-content: center; }
.rc-right { display: flex; align-items: center; gap: 12px; }

.rc-logo-text {
  font-weight: 700;
  font-size: 15px;
  color: var(--color-accent);
  letter-spacing: -0.3px;
}
.rc-mode {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-left: 6px;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
}

.rc-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--color-text);
  cursor: pointer;
  font-size: 12px;
  font-family: var(--font-ui);
  transition: background 0.15s;
}
.rc-btn:hover:not(:disabled) { background: var(--bg-hover); }
.rc-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.rc-run-all { color: var(--color-success); }
.rc-stop { color: var(--color-error); }
.rc-watch-all.active { color: var(--color-accent); border-color: var(--color-accent); background: rgba(79,193,255,0.1); }

.rc-counts { display: flex; gap: 8px; font-size: 12px; }
.rc-count.passed { color: var(--color-success); }
.rc-count.failed { color: var(--color-error); }
.rc-count.skipped { color: var(--color-skipped); }

.rc-connection {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--color-text-muted);
}
.rc-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-error);
}
.rc-connection.connected .rc-dot { background: var(--color-success); }

.rc-theme-select {
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: var(--font-ui);
  cursor: pointer;
  outline: none;
}
.rc-theme-select:focus { border-color: var(--color-accent); }

/* ─── Test Explorer ─── */

.test-explorer { display: flex; flex-direction: column; height: 100%; }

.te-header { padding: 8px; border-bottom: 1px solid var(--border); }

.te-search {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--color-text);
  font-size: 12px;
  font-family: var(--font-ui);
  outline: none;
  margin-bottom: 6px;
}
.te-search:focus { border-color: var(--color-accent); }
.te-search::placeholder { color: var(--color-text-faint); }

.te-status-filters { display: flex; gap: 3px; }

.te-status-btn {
  flex: 1;
  padding: 3px 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 10px;
  font-family: var(--font-ui);
  transition: background 0.15s;
}
.te-status-btn:hover { background: var(--bg-hover); }
.te-status-btn.active { background: var(--bg-active); color: var(--color-text); border-color: var(--border-light); }
.te-status-btn.active.te-status-passed { color: var(--color-success); }
.te-status-btn.active.te-status-failed { color: var(--color-error); }

.te-count { font-weight: 600; margin-left: 2px; }

.te-tree { flex: 1; overflow-y: auto; padding: 4px 0; }

.te-empty { padding: 20px; text-align: center; color: var(--color-text-faint); font-size: 12px; }

.te-node {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  cursor: pointer;
  user-select: none;
  transition: background 0.1s;
}
.te-node:hover { background: var(--bg-hover); }
.te-node.selected { background: var(--bg-selected); }

.te-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  transition: transform 0.15s;
  cursor: pointer;
  flex-shrink: 0;
}
.te-chevron::before {
  content: '';
  display: block;
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 4px 0 4px 6px;
  border-color: transparent transparent transparent var(--color-text-muted);
}
.te-chevron:hover::before { border-left-color: var(--color-text); }
.te-chevron.expanded { transform: rotate(90deg); }
.te-chevron-spacer { display: inline-block; width: 20px; flex-shrink: 0; }

.te-status-icon { width: 16px; text-align: center; font-size: 12px; flex-shrink: 0; }
.te-status-icon.passed { color: var(--color-success); }
.te-status-icon.failed { color: var(--color-error); }
.te-status-icon.skipped { color: var(--color-skipped); }
.te-status-icon.running { color: var(--color-accent); animation: pulse 1s infinite; }
.te-status-icon.idle { color: var(--color-text-faint); }

@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

.te-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.te-node-file .te-name { font-weight: 600; }

.te-duration { font-size: 10px; color: var(--color-text-faint); font-family: var(--font-mono); flex-shrink: 0; }

.te-actions { display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; flex-shrink: 0; }
.te-node:hover .te-actions { opacity: 1; }
.te-actions:has(.te-watch-btn.active) { opacity: 1; }

.te-action-btn {
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 3px;
  background: transparent; color: var(--color-text-muted);
  cursor: pointer; font-size: 10px;
}
.te-action-btn:hover { background: var(--bg-active); color: var(--color-text); }
.te-run-btn:hover { color: var(--color-success); }
.te-watch-btn.active { color: var(--color-accent); }

/* ─── Device Mirror ─── */

.device-mirror {
  display: flex; flex-direction: column; align-items: center;
  height: 100%; width: 100%; padding: 8px; gap: 6px;
}

.dm-viewport {
  flex: 1; display: flex; align-items: center; justify-content: center;
  position: relative; min-height: 0; width: 100%;
}

.dm-canvas {
  max-width: 100%; max-height: 100%; object-fit: contain;
  border-radius: 6px; border: 2px solid var(--border); background: #000;
}
.dm-canvas.tap-mode { cursor: crosshair; border-color: var(--color-accent); }

.dm-overlay {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.6); border-radius: 6px; z-index: 1;
}
.dm-overlay-text { color: var(--color-text-muted); font-size: 14px; }

.dm-controls { display: flex; gap: 6px; }

.dm-btn {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 10px; border: 1px solid var(--border); border-radius: 4px;
  background: var(--bg-tertiary); color: var(--color-text-muted);
  cursor: pointer; font-size: 11px; font-family: var(--font-ui);
  transition: background 0.15s, color 0.15s;
}
.dm-btn:hover { background: var(--bg-hover); color: var(--color-text); }
.dm-btn.active { color: var(--color-accent); border-color: var(--color-accent); }

/* ─── Trace viewer components (ActionsPanel, DetailTabs, etc.) ─── */

.actions-panel { width: 100%; height: 100%; display: flex; flex-direction: column; background: var(--color-bg-secondary); overflow: hidden; }
.actions-header { display: flex; align-items: center; border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
.actions-header-tab { padding: 6px 14px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--color-text-muted); cursor: pointer; border-bottom: 2px solid transparent; }
.actions-header-tab.active { color: var(--color-text-primary); border-bottom-color: var(--color-accent); }
.actions-filter { padding: 6px 8px; border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
.actions-filter input { width: 100%; padding: 4px 8px; background: var(--color-bg); border: 1px solid var(--color-border); border-radius: 3px; color: var(--color-text-secondary); font-size: 12px; outline: none; }
.actions-filter input:focus { border-color: var(--color-accent); }
.actions-list { flex: 1; overflow-y: auto; }

.action-item { padding: 5px 10px; cursor: pointer; border-left: 2px solid transparent; display: flex; align-items: center; gap: 8px; min-height: 30px; }
.action-item:hover { background: var(--color-bg-hover); }
.action-item.selected { background: var(--color-bg-selected); border-left-color: var(--color-accent); }
.action-item.pinned { border-left-color: var(--color-accent); }
.action-item.pinned:not(.selected) { border-left-color: var(--color-accent-dim); }
.action-item.failed .action-name { color: var(--color-error); }
.action-icon { font-size: 12px; flex-shrink: 0; width: 18px; text-align: center; color: var(--color-text-muted); }
.action-icon.tap { color: var(--color-success); }
.action-icon.type { color: var(--color-string); }
.action-icon.swipe { color: var(--color-keyword); }
.action-icon.scroll { color: var(--color-keyword); }
.action-icon.nav { color: var(--color-function); }
.action-icon.assert { color: var(--color-number); }
.action-icon.assert.failed { color: var(--color-error); }
.action-name { font-size: 12px; color: var(--color-text-primary); white-space: nowrap; }
.action-selector-text { color: var(--color-text-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.action-duration { color: var(--color-text-faintest); font-size: 11px; flex-shrink: 0; margin-left: auto; padding-left: 8px; }
.action-details { display: flex; align-items: center; overflow: hidden; flex: 1; min-width: 0; gap: 6px; }

.group-item { padding: 4px 10px; color: var(--color-text-muted); font-size: 11px; font-weight: 600; border-left: 2px solid var(--color-accent); background: var(--color-bg-group); }
.group-item.lifecycle { border-left: none; background: var(--color-bg); color: var(--color-text-faint); font-size: 10px; text-transform: uppercase; letter-spacing: 1px; padding: 6px 10px 3px; margin-top: 2px; }

.metadata-panel { padding: 12px; font-size: 12px; overflow-y: auto; flex: 1; }
.metadata-grid { display: grid; grid-template-columns: 100px 1fr; gap: 4px 12px; }
.metadata-label { color: var(--color-text-muted); }
.metadata-value { color: var(--color-text-secondary); word-break: break-all; }

/* Screenshot panel */
.screenshot-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: var(--color-bg); min-height: 0; }
.screenshot-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); flex-shrink: 0; }
.screenshot-tab { padding: 6px 16px; cursor: pointer; color: var(--color-text-muted); border-bottom: 2px solid transparent; font-size: 12px; }
.screenshot-tab:hover { color: var(--color-text-secondary); }
.screenshot-tab.active { color: var(--color-text-primary); border-bottom-color: var(--color-accent); }
.screenshot-container { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: 8px; min-height: 0; }
.screenshot-empty { color: var(--color-text-faintest); text-align: center; font-size: 13px; }

.detail-panel { height: 100%; display: flex; flex-direction: column; background: var(--color-bg); }
.detail-tabs-bar { display: flex; gap: 0; background: var(--color-bg-secondary); border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
.detail-tab { padding: 6px 14px; cursor: pointer; color: var(--color-text-muted); border-bottom: 2px solid transparent; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
.detail-tab:hover { color: var(--color-text-secondary); }
.detail-tab.active { color: var(--color-text-primary); border-bottom-color: var(--color-accent); }
.detail-tab.has-error { color: var(--color-error); }
.detail-content { flex: 1; overflow-y: auto; padding: 10px 14px; font-size: 12px; }
.detail-content.detail-content-flush { padding: 0; overflow: hidden; }

.call-grid { display: grid; grid-template-columns: 90px 1fr; gap: 3px 12px; }
.call-label { color: var(--color-text-muted); }
.call-value { color: var(--color-text-secondary); word-break: break-all; }
.call-value.error { color: var(--color-error); }
.call-value.success { color: var(--color-success); }

.log-entry { font-family: var(--font-mono); font-size: 11px; padding: 1px 0; display: flex; gap: 8px; line-height: 1.6; }
.log-level { min-width: 40px; font-weight: 600; text-transform: uppercase; font-size: 10px; }
.log-level.error { color: var(--color-error); }
.log-level.warn { color: var(--color-warning); }
.log-level.info { color: var(--color-accent); }
.log-level.debug { color: var(--color-text-muted); }
.log-level.log { color: var(--color-text-secondary); }
.log-source { font-size: 10px; color: var(--color-text-faintest); min-width: 46px; }
.log-message { word-break: break-all; }

.source-code { font-family: var(--font-mono); font-size: 12px; line-height: 1.5; white-space: pre; overflow-x: auto; }
.source-line { display: flex; }
.source-line-number { min-width: 40px; text-align: right; padding-right: 12px; color: var(--color-text-faintest); user-select: none; }
.source-line-content { flex: 1; }
.source-line.highlight { background: var(--color-highlight); }

.error-block { background: var(--color-error-bg); border: 1px solid var(--color-error-border); border-radius: 4px; padding: 10px; margin-bottom: 8px; }
.error-message { color: var(--color-error); font-weight: 500; margin-bottom: 6px; font-size: 12px; }
.error-stack { font-family: var(--font-mono); font-size: 11px; color: var(--color-text-muted); white-space: pre-wrap; word-break: break-all; }
.no-content { color: var(--color-text-faintest); font-size: 12px; }

/* Timeline */
.timeline { display: flex; align-items: flex-end; gap: 0; padding: 0; background: var(--color-bg-secondary); border-bottom: 1px solid var(--color-border); flex-shrink: 0; overflow-x: auto; position: relative; height: 80px; }
.timeline-inner { display: flex; align-items: flex-end; gap: 2px; padding: 4px 8px; min-width: 100%; }
.timeline-thumb { height: 56px; width: auto; border-radius: 2px; border: 2px solid transparent; cursor: pointer; opacity: 0.6; transition: all 0.1s; flex-shrink: 0; }
.timeline-thumb:hover { opacity: 1; }
.timeline-thumb.selected { opacity: 1; border-color: var(--color-accent); }
.timeline-thumb.failed { border-bottom: 2px solid var(--color-error); }
.timeline-placeholder { width: 40px; height: 56px; border-radius: 2px; background: var(--color-bg-tertiary); border: 2px solid transparent; display: flex; align-items: center; justify-content: center; font-size: 10px; color: var(--color-text-faintest); flex-shrink: 0; cursor: pointer; }
.timeline-placeholder.selected { border-color: var(--color-accent); }
.timeline-time-label { position: absolute; transform: translateX(-50%); }
.timeline-meta { position: absolute; top: 2px; right: 12px; font-size: 11px; color: var(--color-text-faint); }
.timeline-meta .test-status { font-weight: 600; }
.timeline-meta .passed { color: var(--color-success); }
.timeline-meta .failed { color: var(--color-error); }

/* ─── Scrollbar ─── */

::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--border-light); }
`
document.head.appendChild(style)

// ─── Theme ───

;(() => {
  const stored = localStorage.getItem('pilot-ui-theme')
  const theme = (stored === 'light' || stored === 'dark' || stored === 'system') ? stored : 'system'
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme
  document.documentElement.setAttribute('data-theme', resolved)
})()

// ─── Render ───

render(<App />, document.getElementById('app')!)
