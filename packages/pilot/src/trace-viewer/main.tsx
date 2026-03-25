import { render } from 'preact';
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { unzipSync, strFromU8 } from 'fflate';
import type { AnyTraceEvent, ActionTraceEvent, AssertionTraceEvent, TraceMetadata, NetworkEntry } from '../trace/types.js';
import { ActionsPanel } from './components/ActionsPanel.js';
import { ScreenshotPanel } from './components/ScreenshotPanel.js';
import { DetailTabs } from './components/DetailTabs.js';
import { TimelineFilmstrip } from './components/TimelineFilmstrip.js';
import { ResizeHandle } from './components/ResizeHandle.js';
import { TopBar, type Theme } from './components/TopBar.js';

// ─── Types ───

export interface TraceData {
  metadata: TraceMetadata
  events: AnyTraceEvent[]
  screenshots: Map<string, string>
  hierarchies: Map<string, string>
  sources: Map<string, string>
  network: NetworkEntry[]
  networkBodies: Map<string, string>
}

// ─── Zip Loader ───

async function loadTraceFromUrl(url: string): Promise<TraceData> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load trace: HTTP ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  return parseTraceZip(buf);
}

async function loadTraceFromFile(file: File): Promise<TraceData> {
  const buf = new Uint8Array(await file.arrayBuffer());
  return parseTraceZip(buf);
}

function parseTraceZip(buf: Uint8Array): TraceData {
  const files = unzipSync(buf);
  const decoder = new TextDecoder();

  const metadataRaw = files['metadata.json'];
  if (!metadataRaw) throw new Error('Invalid trace: missing metadata.json');
  const metadata: TraceMetadata = JSON.parse(decoder.decode(metadataRaw));

  const traceRaw = files['trace.json'];
  const events: AnyTraceEvent[] = traceRaw
    ? decoder.decode(traceRaw).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];

  const screenshots = new Map<string, string>();
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith('screenshots/') && name.endsWith('.png')) {
      screenshots.set(name, URL.createObjectURL(new Blob([data], { type: 'image/png' })));
    }
  }

  const hierarchies = new Map<string, string>();
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith('hierarchy/') && name.endsWith('.xml')) {
      hierarchies.set(name, decoder.decode(data));
    }
  }

  const sources = new Map<string, string>();
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith('sources/')) {
      sources.set(name.replace('sources/', ''), decoder.decode(data));
    }
  }

  const networkRaw = files['network.json'];
  const network: NetworkEntry[] = networkRaw
    ? decoder.decode(networkRaw).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];

  const networkBodies = new Map<string, string>();
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith('network/')) {
      networkBodies.set(name, decoder.decode(data));
    }
  }

  return { metadata, events, screenshots, hierarchies, sources, network, networkBodies };
}

// ─── App ───

// ─── Theme ───

function getResolvedTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  const resolved = getResolvedTheme(theme);
  document.documentElement.setAttribute('data-theme', resolved);
}

function App() {
  const [trace, setTrace] = useState<TraceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pinnedIndex, setPinnedIndex] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [hierarchyHighlight, setHierarchyHighlight] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('pilot-trace-theme');
    return (stored === 'light' || stored === 'dark' || stored === 'system') ? stored : 'system';
  });
  const selectedIndex = hoveredIndex ?? pinnedIndex;

  // Apply theme on mount and changes
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem('pilot-trace-theme', theme);
  }, [theme]);

  // Listen for system theme changes when in system mode
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => { if (theme === 'system') applyTheme('system'); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const traceUrl = params.get('trace');
    if (traceUrl) {
      setLoading(true);
      loadTraceFromUrl(traceUrl)
        .then(data => {
          setTrace(data);
          setLoading(false);
          const actionParam = params.get('action');
          if (actionParam) setPinnedIndex(parseInt(actionParam, 10));
        })
        .catch(err => { setError(err.message); setLoading(false); });
    }
  }, []);

  useEffect(() => {
    if (trace) {
      const url = new URL(location.href);
      url.searchParams.set('action', String(selectedIndex));
      history.replaceState(null, '', url.toString());
      setHierarchyHighlight(null);
    }
  }, [selectedIndex, trace]);

  const actionEvents = trace?.events.filter(
    (e): e is ActionTraceEvent | AssertionTraceEvent =>
      e.type === 'action' || e.type === 'assertion'
  ) ?? [];

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      setPinnedIndex(i => Math.min(i + 1, actionEvents.length - 1));
      setHoveredIndex(null);
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      setPinnedIndex(i => Math.max(i - 1, 0));
      setHoveredIndex(null);
    }
  }, [actionEvents.length]);

  useEffect(() => {
    if (!trace) return;
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [trace, handleKeyDown]);

  const handleFileDrop = (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file) {
      setLoading(true); setError(null);
      loadTraceFromFile(file)
        .then(data => { setTrace(data); setLoading(false); })
        .catch(err => { setError(err.message); setLoading(false); });
    }
  };

  const handleFileInput = (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) {
      setLoading(true); setError(null);
      loadTraceFromFile(file)
        .then(data => { setTrace(data); setLoading(false); })
        .catch(err => { setError(err.message); setLoading(false); });
    }
  };

  if (loading) {
    return (
      <div class="full-layout">
        <TopBar metadata={null} theme={theme} onThemeChange={setTheme} />
        <div class="empty-screen"><div class="spinner" /><p>Loading trace...</p></div>
      </div>
    );
  }

  if (error) {
    return (
      <div class="full-layout">
        <TopBar metadata={null} theme={theme} onThemeChange={setTheme} />
        <div class="empty-screen">
          <h2 style={{ color: 'var(--color-error)' }}>Failed to load trace</h2>
          <p style={{ color: 'var(--color-text-muted)' }}>{error}</p>
          <label class="file-picker-btn">Choose a trace file<input type="file" accept=".zip" onChange={handleFileInput} /></label>
        </div>
      </div>
    );
  }

  if (!trace) {
    return (
      <div class="full-layout" onDragOver={e => e.preventDefault()} onDrop={handleFileDrop}>
        <TopBar metadata={null} theme={theme} onThemeChange={setTheme} />
        <div class="empty-screen">
          <div class="drop-content">
            <div class="logo">Pilot</div>
            <h1>Trace Viewer</h1>
            <p>Drop a <code>.zip</code> trace file here</p>
            <p class="or">or</p>
            <label class="file-picker-btn">Select file<input type="file" accept=".zip" onChange={handleFileInput} /></label>
            <p class="privacy-note">Trace Viewer is a client-side app. Your data stays in your browser.</p>
          </div>
        </div>
      </div>
    );
  }

  // Resizable panel sizes (must be before conditional returns — rules of hooks)
  const [leftWidth, setLeftWidth] = useState(300);
  const [bottomHeight, setBottomHeight] = useState(220);

  const handleLeftResize = useCallback((delta: number) => {
    setLeftWidth(w => Math.max(180, Math.min(600, w + delta)));
  }, []);

  const handleBottomResize = useCallback((delta: number) => {
    setBottomHeight(h => Math.max(80, Math.min(500, h - delta)));
  }, []);

  const selectedEvent = actionEvents[selectedIndex];

  return (
    <div class="viewer">
      <TopBar metadata={trace.metadata} theme={theme} onThemeChange={setTheme} />
      {/* Top: Timeline */}
      <TimelineFilmstrip
        events={actionEvents}
        screenshots={trace.screenshots}
        metadata={trace.metadata}
        selectedIndex={selectedIndex}
        onSelect={setPinnedIndex}
      />
      {/* Middle: Actions + Screenshot */}
      <div class="middle-row">
        <div style={{ width: `${leftWidth}px`, flexShrink: 0 }}>
          <ActionsPanel
            events={trace.events}
            actionEvents={actionEvents}
            selectedIndex={selectedIndex}
            pinnedIndex={pinnedIndex}
            onHover={setHoveredIndex}
            onPin={setPinnedIndex}
            metadata={trace.metadata}
          />
        </div>
        <ResizeHandle direction="horizontal" onResize={handleLeftResize} />
        <ScreenshotPanel
          event={selectedEvent}
          screenshots={trace.screenshots}
          highlightBounds={hierarchyHighlight}
        />
      </div>
      {/* Bottom: Detail tabs */}
      <ResizeHandle direction="vertical" onResize={handleBottomResize} />
      <div style={{ height: `${bottomHeight}px`, flexShrink: 0 }}>
        <DetailTabs
          event={selectedEvent}
          events={trace.events}
          hierarchies={trace.hierarchies}
          sources={trace.sources}
          metadata={trace.metadata}
          networkEntries={trace.network}
          networkBodies={trace.networkBodies}
          onHierarchyNodeSelect={setHierarchyHighlight}
        />
      </div>
    </div>
  );
}

// ─── Styles ───

const style = document.createElement('style');
style.textContent = `
  /* ─── Theme variables ─── */
  :root, [data-theme="dark"] {
    --color-bg: #1e1e1e;
    --color-bg-secondary: #252526;
    --color-bg-tertiary: #2d2d2d;
    --color-bg-hover: #2a2d2e;
    --color-bg-selected: #04395e;
    --color-bg-group: #1e2a3a;
    --color-topbar-bg: #1b1b1b;
    --color-border: #3c3c3c;
    --color-text-primary: #e8e8e8;
    --color-text-secondary: #ccc;
    --color-text-muted: #888;
    --color-text-faint: #666;
    --color-text-faintest: #555;
    --color-accent: #4fc1ff;
    --color-accent-hover: #6dcfff;
    --color-accent-dim: #264f78;
    --color-success: #4ec9b0;
    --color-error: #f85149;
    --color-warning: #cca700;
    --color-string: #ce9178;
    --color-keyword: #569cd6;
    --color-function: #dcdcaa;
    --color-number: #b5cea8;
    --color-attr: #9cdcfe;
    --color-highlight: rgba(79,193,255,0.12);
    --color-error-bg: #2d1215;
    --color-error-border: #f8514933;
    --color-spinner-track: #333;
    --color-btn-text: #000;
  }

  [data-theme="light"] {
    --color-bg: #ffffff;
    --color-bg-secondary: #f5f5f5;
    --color-bg-tertiary: #e8e8e8;
    --color-bg-hover: #eaeaea;
    --color-bg-selected: #d6ecff;
    --color-bg-group: #e8f0fa;
    --color-topbar-bg: #f0f0f0;
    --color-border: #d4d4d4;
    --color-text-primary: #1f1f1f;
    --color-text-secondary: #383838;
    --color-text-muted: #6e6e6e;
    --color-text-faint: #888;
    --color-text-faintest: #aaa;
    --color-accent: #0078d4;
    --color-accent-hover: #106ebe;
    --color-accent-dim: #a0c4e8;
    --color-success: #16825d;
    --color-error: #d32f2f;
    --color-warning: #bf8700;
    --color-string: #a31515;
    --color-keyword: #0000ff;
    --color-function: #795e26;
    --color-number: #098658;
    --color-attr: #001080;
    --color-highlight: rgba(0,120,212,0.1);
    --color-error-bg: #fde7e7;
    --color-error-border: #d32f2f33;
    --color-spinner-track: #ddd;
    --color-btn-text: #fff;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--color-bg); color: var(--color-text-secondary); font-size: 13px; overflow: hidden; height: 100vh; }
  #app { height: 100vh; display: flex; flex-direction: column; }

  /* Full layout wrapper for empty/loading/error screens */
  .full-layout { display: flex; flex-direction: column; height: 100vh; }

  /* Empty/loading screens */
  .empty-screen { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 12px; }
  .spinner { width: 28px; height: 28px; border: 3px solid var(--color-spinner-track); border-top-color: var(--color-accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .drop-content { text-align: center; }
  .drop-content .logo { font-size: 14px; font-weight: 700; color: var(--color-accent); text-transform: uppercase; letter-spacing: 3px; margin-bottom: 4px; }
  .drop-content h1 { font-size: 24px; color: var(--color-text-primary); font-weight: 300; margin-bottom: 24px; }
  .drop-content p { color: var(--color-text-muted); margin-bottom: 8px; }
  .drop-content code { background: var(--color-bg-tertiary); padding: 2px 6px; border-radius: 3px; font-size: 13px; }
  .drop-content .or { color: var(--color-text-faintest); font-size: 12px; }
  .drop-content .privacy-note { font-size: 11px; color: var(--color-text-faintest); margin-top: 24px; }
  .file-picker-btn { display: inline-block; padding: 8px 24px; background: var(--color-accent); color: var(--color-btn-text); border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 13px; }
  .file-picker-btn:hover { background: var(--color-accent-hover); }
  .file-picker-btn input { display: none; }

  /* Viewer layout — Playwright-inspired: top bar, timeline, actions+screenshot middle, details bottom */
  .viewer { display: flex; flex-direction: column; height: 100vh; }
  .middle-row { display: flex; flex: 1; min-height: 0; overflow: hidden; }

  /* ─── Timeline ─── */
  .timeline { display: flex; align-items: flex-end; gap: 0; padding: 0; background: var(--color-bg-secondary); border-bottom: 1px solid var(--color-border); flex-shrink: 0; overflow-x: auto; position: relative; height: 80px; }
  .timeline-inner { display: flex; align-items: flex-end; gap: 2px; padding: 4px 8px; min-width: 100%; }
  .timeline-thumb { height: 56px; width: auto; border-radius: 2px; border: 2px solid transparent; cursor: pointer; opacity: 0.6; transition: all 0.1s; flex-shrink: 0; }
  .timeline-thumb:hover { opacity: 1; }
  .timeline-thumb.selected { opacity: 1; border-color: var(--color-accent); }
  .timeline-thumb.failed { border-bottom: 2px solid var(--color-error); }
  .timeline-placeholder { width: 40px; height: 56px; border-radius: 2px; background: var(--color-bg-tertiary); border: 2px solid transparent; display: flex; align-items: center; justify-content: center; font-size: 10px; color: var(--color-text-faintest); flex-shrink: 0; cursor: pointer; }
  .timeline-placeholder.selected { border-color: var(--color-accent); }
  .timeline-time-axis { position: absolute; top: 0; left: 0; right: 0; height: 18px; padding: 0 8px; display: flex; align-items: center; font-size: 10px; color: var(--color-text-faint); pointer-events: none; }
  .timeline-time-label { position: absolute; transform: translateX(-50%); }
  .timeline-meta { position: absolute; top: 2px; right: 12px; font-size: 11px; color: var(--color-text-faint); }
  .timeline-meta .test-status { font-weight: 600; }
  .timeline-meta .passed { color: var(--color-success); }
  .timeline-meta .failed { color: var(--color-error); }

  /* ─── Resize handles ─── */
  .resize-handle { flex-shrink: 0; background: transparent; z-index: 10; }
  .resize-handle:hover, .resize-handle:active { background: var(--color-accent); }
  .resize-handle-horizontal { width: 4px; cursor: col-resize; transition: background 0.15s; }
  .resize-handle-vertical { height: 4px; cursor: row-resize; transition: background 0.15s; }

  /* ─── Actions panel ─── */
  .actions-panel { width: 100%; height: 100%; display: flex; flex-direction: column; background: var(--color-bg-secondary); overflow: hidden; border-right: 1px solid var(--color-border); }
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
  .action-item.failed { }
  .action-item.failed .action-name { color: var(--color-error); }
  .action-icon { font-size: 12px; flex-shrink: 0; width: 18px; text-align: center; color: var(--color-text-muted); }
  .action-icon.tap { color: var(--color-success); }
  .action-icon.type { color: var(--color-string); }
  .action-icon.swipe { color: var(--color-keyword); }
  .action-icon.scroll { color: var(--color-keyword); }
  .action-icon.nav { color: var(--color-function); }
  .action-icon.assert { color: var(--color-number); }
  .action-icon.assert.failed, .action-icon.failed { color: var(--color-error); }
  .action-name { font-size: 12px; color: var(--color-text-primary); white-space: nowrap; }
  .action-selector-text { color: var(--color-text-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .action-duration { color: var(--color-text-faintest); font-size: 11px; flex-shrink: 0; margin-left: auto; padding-left: 8px; }
  .action-details { display: flex; align-items: center; overflow: hidden; flex: 1; min-width: 0; gap: 6px; }

  .group-item { padding: 4px 10px; color: var(--color-text-muted); font-size: 11px; font-weight: 600; border-left: 2px solid var(--color-accent); background: var(--color-bg-group); }
  .group-item.lifecycle { border-left: none; background: var(--color-bg); color: var(--color-text-faint); font-size: 10px; text-transform: uppercase; letter-spacing: 1px; padding: 6px 10px 3px; margin-top: 2px; }

  /* Metadata panel */
  .metadata-panel { padding: 12px; font-size: 12px; overflow-y: auto; flex: 1; }
  .metadata-grid { display: grid; grid-template-columns: 100px 1fr; gap: 4px 12px; }
  .metadata-label { color: var(--color-text-muted); }
  .metadata-value { color: var(--color-text-secondary); word-break: break-all; }

  /* ─── Screenshot panel ─── */
  .screenshot-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: var(--color-bg); }
  .screenshot-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); flex-shrink: 0; }
  .screenshot-tab { padding: 6px 16px; cursor: pointer; color: var(--color-text-muted); border-bottom: 2px solid transparent; font-size: 12px; }
  .screenshot-tab:hover { color: var(--color-text-secondary); }
  .screenshot-tab.active { color: var(--color-text-primary); border-bottom-color: var(--color-accent); }
  .screenshot-container { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: 8px; }
  .screenshot-empty { color: var(--color-text-faintest); text-align: center; font-size: 13px; }

  /* ─── Detail tabs (bottom panel) ─── */
  .detail-panel { height: 100%; display: flex; flex-direction: column; background: var(--color-bg); border-top: 1px solid var(--color-border); }
  .detail-tabs-bar { display: flex; gap: 0; background: var(--color-bg-secondary); border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
  .detail-tab { padding: 6px 14px; cursor: pointer; color: var(--color-text-muted); border-bottom: 2px solid transparent; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .detail-tab:hover { color: var(--color-text-secondary); }
  .detail-tab.active { color: var(--color-text-primary); border-bottom-color: var(--color-accent); }
  .detail-tab.has-error { color: var(--color-error); }
  .detail-content { flex: 1; overflow-y: auto; padding: 10px 14px; font-size: 12px; }
  .detail-content.detail-content-flush { padding: 0; overflow: hidden; }

  /* Call tab */
  .call-grid { display: grid; grid-template-columns: 90px 1fr; gap: 3px 12px; }
  .call-label { color: var(--color-text-muted); }
  .call-value { color: var(--color-text-secondary); word-break: break-all; }
  .call-value.error { color: var(--color-error); }
  .call-value.success { color: var(--color-success); }

  /* Log/Console tab */
  .log-entry { font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 11px; padding: 1px 0; display: flex; gap: 8px; line-height: 1.6; }
  .log-level { min-width: 40px; font-weight: 600; text-transform: uppercase; font-size: 10px; }
  .log-level.error { color: var(--color-error); }
  .log-level.warn { color: var(--color-warning); }
  .log-level.info { color: var(--color-accent); }
  .log-level.debug { color: var(--color-text-muted); }
  .log-level.log { color: var(--color-text-secondary); }
  .log-source { font-size: 10px; color: var(--color-text-faintest); min-width: 46px; }
  .log-message { word-break: break-all; }

  /* Source tab */
  .source-code { font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 12px; line-height: 1.5; white-space: pre; overflow-x: auto; }
  .source-line { display: flex; }
  .source-line-number { min-width: 40px; text-align: right; padding-right: 12px; color: var(--color-text-faintest); user-select: none; }
  .source-line-content { flex: 1; }
  .source-line.highlight { background: var(--color-highlight); }

  /* Hierarchy tab */
  .hierarchy-tree { font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 11px; line-height: 1.5; }
  .hierarchy-node { padding: 0; }
  .hierarchy-class { color: var(--color-success); }
  .hierarchy-attr { color: var(--color-attr); }
  .hierarchy-attr-value { color: var(--color-string); }
  .hierarchy-search { padding: 6px 8px; border-bottom: 1px solid var(--color-border); }
  .hierarchy-search input { width: 100%; padding: 4px 8px; background: var(--color-bg); border: 1px solid var(--color-border); border-radius: 3px; color: var(--color-text-secondary); font-size: 12px; outline: none; }
  .hierarchy-search input:focus { border-color: var(--color-accent); }

  /* Errors tab */
  .error-block { display: flex; flex-direction: column; gap: 8px; }
  .error-entry { background: var(--color-error-bg); border: 1px solid var(--color-error-border); border-radius: 4px; padding: 10px; }
  .error-entry-selected { border-color: var(--color-error); }
  .error-entry-label { font-size: 11px; color: var(--color-text-muted); margin-bottom: 4px; font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; }
  .error-message { color: var(--color-error); font-weight: 500; margin-bottom: 6px; font-size: 12px; }
  .error-stack { font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 11px; color: var(--color-text-muted); white-space: pre-wrap; word-break: break-all; }
  .test-error-banner { display: flex; align-items: center; gap: 6px; padding: 6px 12px; background: var(--color-error-bg); border-bottom: 1px solid var(--color-error-border); cursor: pointer; font-size: 12px; color: var(--color-error); flex-shrink: 0; }
  .test-error-banner:hover { background: var(--color-error-border); }
  .test-error-banner-icon { font-weight: 700; flex-shrink: 0; }
  .test-error-banner-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .no-content { color: var(--color-text-faintest); font-size: 12px; }
`;
document.head.appendChild(style)

// Apply theme on initial load (before React hydrates)
;(() => {
  const stored = localStorage.getItem('pilot-trace-theme');
  const theme = (stored === 'light' || stored === 'dark' || stored === 'system') ? stored : 'system';
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.setAttribute('data-theme', resolved);
})();

// ─── Render ───

render(<App />, document.getElementById('app')!);
