import { render } from 'preact';
import { useState, useCallback, useMemo, useRef, useEffect } from 'preact/hooks';
import type { ServerMessage, ClientMessage, TestTreeNode, WorkerInfo } from './ui-protocol.js';
import type { ActionTraceEvent, AssertionTraceEvent, TraceMetadata } from '../trace/types.js';
import { useWebSocket } from './hooks/use-websocket.js';
import {
  useTraceData,
  base64ToBlobUrl,
  revokeTraceScreenshots,
  emptyTraceData,
  getOrCreateTrace,
  EMPTY_MAP,
  EMPTY_EVENTS,
  EMPTY_ACTION_EVENTS,
  EMPTY_NETWORK,
  type TestTraceData,
} from './hooks/use-trace-data.js';
import { useScreenMirror, useMultiScreenMirror } from './hooks/use-screen-mirror.js';
import { useTestTree } from './hooks/use-test-tree.js';
import { useRunTimer } from './hooks/use-run-timer.js';
import { Layout } from './components/Layout.js';
import { TestExplorer } from './components/TestExplorer.js';
import { RunControls, type Theme } from './components/RunControls.js';
import { DevicePane } from './components/DevicePane.js';
// Trace viewer components — reused for live trace display
import { ActionsPanel } from '../trace-viewer/components/ActionsPanel.js';
import { ScreenshotPanel } from '../trace-viewer/components/ScreenshotPanel.js';
import { DetailTabs } from '../trace-viewer/components/DetailTabs.js';
import { TimelineFilmstrip } from '../trace-viewer/components/TimelineFilmstrip.js';
import { uiModeStyles } from './styles/ui-mode.css.js';

// ─── App ───

function App() {
  const [connected, setConnected] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [deviceSerial, setDeviceSerial] = useState('');
  const [deviceDpr, setDeviceDpr] = useState<number | undefined>();
  const [pilotVersion, setPilotVersion] = useState('');
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('pilot-ui-theme');
    return (stored === 'light' || stored === 'dark' || stored === 'system') ? stored : 'system';
  });

  // Multi-worker state
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  /** Maps test fullName → workerId that ran it. */
  const testWorkerMapRef = useRef<Map<string, number>>(new Map());
  /**
   * Auto-follow control for multi-worker mode.
   * - 'auto': follow the latest test start (single-worker behavior)
   * - 'worker:N': only follow tests from worker N
   * - 'manual': user clicked a test — stop auto-following
   */
  const autoFollowRef = useRef<'auto' | `worker:${number}` | 'manual'>('auto');

  const { testTraces, setTestTraces, activeTestRef, pendingSourcesRef } = useTraceData();
  const [pinnedIndex, setPinnedIndex] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const selectedIndex = hoveredIndex ?? pinnedIndex;

  // Device pane state
  const [selectedWorkerId, setSelectedWorkerId] = useState(0);
  const [deviceViewMode, setDeviceViewMode] = useState<'all' | number>('all');

  // "Run deps first" toggle — persisted in localStorage
  const [runDepsFirst, setRunDepsFirst] = useState(() => {
    return localStorage.getItem('pilot-ui-run-deps') === 'true';
  });
  const runDepsRef = useRef(runDepsFirst);

  const { runElapsed, startRunTimer, stopRunTimer } = useRunTimer();

  const tree = useTestTree();
  // Ref to tree methods so handleMessage doesn't depend on the tree object
  // (which is recreated each render), preventing useCallback churn.
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const { canvasRef, handleBinaryFrame } = useScreenMirror();
  const { registerCanvas, unregisterCanvas, handleBinaryFrame: handleMultiBinaryFrame } = useMultiScreenMirror();

  // Whether any project has dependencies (controls visibility of the toggle)
  const hasProjectDeps = useMemo(() => {
    return tree.allFiles.some((node) =>
      node.type === 'project' && node.dependencies && node.dependencies.length > 0,
    );
  }, [tree.allFiles]);

  // Tree node ids look like "<filePath>::<fullName>" or, when running a
  // multi-project config, "project::<projectName>::<filePath>::<fullName>".
  // Strip the project prefix before splitting so file/test extraction works
  // for both shapes.
  const stripProjectPrefix = (id: string): string => {
    if (!id.startsWith('project::')) return id;
    // Skip past "project::<name>::"
    const afterProject = id.slice('project::'.length);
    const sep = afterProject.indexOf('::');
    return sep === -1 ? afterProject : afterProject.slice(sep + 2);
  };

  // Extract the project name from a tree node id, or undefined if the id has
  // no project prefix.
  const extractProject = (id: string): string | undefined => {
    if (!id.startsWith('project::')) return undefined;
    const afterProject = id.slice('project::'.length);
    const sep = afterProject.indexOf('::');
    return sep === -1 ? afterProject : afterProject.slice(0, sep);
  };

  // Composite key for trace storage. Trace data is stored per (project, test)
  // so the same test running under multiple projects (multi-device configs)
  // doesn't collide on a single map entry.
  const traceKey = (projectName: string | undefined, fullName: string): string =>
    `${projectName ?? ''}::${fullName}`;

  // Get the currently viewed test's trace data.
  // Only show trace data when a test is explicitly selected in the tree.
  const viewedTestName = useMemo(() => {
    if (tree.selectedTestId) {
      const stripped = stripProjectPrefix(tree.selectedTestId);
      const sep = stripped.indexOf('::');
      if (sep !== -1) {
        return stripped.slice(sep + 2);
      }
    }
    return null;
  }, [tree.selectedTestId]);

  const viewedTestNameRef = useRef(viewedTestName);
  viewedTestNameRef.current = viewedTestName;

  const viewedTestFile = useMemo(() => {
    if (tree.selectedTestId) {
      const stripped = stripProjectPrefix(tree.selectedTestId);
      const sep = stripped.indexOf('::');
      if (sep !== -1) {
        return stripped.slice(0, sep);
      }
    }
    return '';
  }, [tree.selectedTestId]);

  // Find the viewed test node in the tree for duration/status
  const viewedTestNode = useMemo(() => {
    if (!tree.selectedTestId) return undefined;
    function find(nodes: TestTreeNode[]): TestTreeNode | undefined {
      for (const n of nodes) {
        if (n.id === tree.selectedTestId) return n;
        if (n.children) {
          const found = find(n.children);
          if (found) return found;
        }
      }
    }
    return find(tree.allFiles);
  }, [tree.selectedTestId, tree.allFiles]);

  const viewedTestProject = useMemo(
    () => (tree.selectedTestId ? extractProject(tree.selectedTestId) : undefined),
    [tree.selectedTestId],
  );
  const viewedTraceKey = viewedTestName ? traceKey(viewedTestProject, viewedTestName) : null;
  const currentTrace = viewedTraceKey && viewedTestNode?.type === 'test' ? testTraces.get(viewedTraceKey) : undefined;
  const traceEvents = currentTrace?.events ?? EMPTY_EVENTS;
  const actionEvents = currentTrace?.actionEvents ?? EMPTY_ACTION_EVENTS;
  const screenshots = currentTrace?.screenshots ?? EMPTY_MAP;
  const hierarchies = currentTrace?.hierarchies ?? EMPTY_MAP;
  const sources = currentTrace?.sources ?? EMPTY_MAP;
  const networkEntries = currentTrace?.network ?? EMPTY_NETWORK;

  // Metadata for trace viewer components
  const testDeviceSerial = useMemo(() => {
    if (viewedTraceKey) {
      const workerId = testWorkerMapRef.current.get(viewedTraceKey);
      if (workerId != null && workers[workerId]) {
        return workers[workerId].displayName || workers[workerId].deviceSerial;
      }
    }
    return deviceSerial;
  }, [viewedTraceKey, workers, deviceSerial]);

  // DPR for the worker that ran the viewed test — not the currently selected
  // device-mirror tab. Multi-worker mode mixes platforms (iOS @2/3x +
  // Android @1x), so a single global value would mis-scale bounds whenever
  // the viewed trace and the visible mirror belong to different workers.
  const viewedTestDpr = useMemo(() => {
    if (viewedTraceKey) {
      const workerId = testWorkerMapRef.current.get(viewedTraceKey);
      if (workerId != null && workers[workerId]) {
        return workers[workerId].devicePixelRatio;
      }
    }
    return deviceDpr;
  }, [viewedTraceKey, workers, deviceDpr]);

  const metadata = useMemo<TraceMetadata>(() => ({
    version: 1,
    pilotVersion,
    testFile: viewedTestFile,
    testName: viewedTestName ?? (isRunning ? 'Running...' : ''),
    testStatus: viewedTestNode?.status === 'failed' ? 'failed'
      : viewedTestNode?.status === 'running' ? 'running'
      : viewedTestNode?.status === 'skipped' ? 'skipped'
      : viewedTestNode?.status === 'passed' ? 'passed'
      : 'idle',
    testDuration: viewedTestNode?.duration ?? 0,
    startTime: 0,
    endTime: viewedTestNode?.duration ?? 0,
    device: { serial: testDeviceSerial, isEmulator: testDeviceSerial.startsWith('emulator-') },
    traceConfig: { screenshots: true, snapshots: true, sources: true, network: true },
    actionCount: actionEvents.length,
    screenshotCount: screenshots.size,
    error: viewedTestNode?.error,
  }), [viewedTestName, viewedTestFile, viewedTestNode, isRunning, actionEvents.length, screenshots.size, testDeviceSerial, pilotVersion]);

  const selectedEvent = actionEvents[selectedIndex];

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'test-tree':
        treeRef.current.setTestTree(msg.files);
        break;
      case 'run-start':
        setIsRunning(true);
        startRunTimer();
        // Scope trace clearing: single test > single file > all.
        // This preserves traces from other tests/files so clicking back
        // on them still shows their actions and status.
        if (msg.testFilter) {
          // Running a single test — clear only the trace for this exact
          // (project, test) tuple. Without the project scope we'd wipe the
          // sibling project's copy of the same test from a previous run.
          setTestTraces((prev) => {
            const targetKey = traceKey(msg.projectName, msg.testFilter!);
            const old = prev.get(targetKey);
            if (!old) return prev;
            revokeTraceScreenshots(old);
            const next = new Map(prev);
            next.delete(targetKey);
            return next;
          });
        } else if (msg.filePath) {
          // Running a whole file — clear traces for that file, scoped to the
          // current project when one is set so the other project's traces
          // for the same file path stay intact.
          setTestTraces((prev) => {
            const next = new Map<string, TestTraceData>();
            for (const [k, data] of prev) {
              const matchesFile = data.filePath === msg.filePath;
              const matchesProject = !msg.projectName || k.startsWith(`${msg.projectName}::`);
              if (matchesFile && matchesProject) {
                revokeTraceScreenshots(data);
              } else {
                next.set(k, data);
              }
            }
            return next;
          });
        } else {
          // Running all files — revoke all blob URLs
          setTestTraces((prev) => {
            for (const data of prev.values()) revokeTraceScreenshots(data);
            return new Map();
          });
        }
        activeTestRef.current = null;

        pendingSourcesRef.current = new Map();
        setPinnedIndex(0);
        setHoveredIndex(null);
        if (!msg.filePath && !msg.testFilter) {
          // Full run — clear worker mappings
          testWorkerMapRef.current.clear();
        }
        autoFollowRef.current = 'auto';
        break;
      case 'run-end':
        setIsRunning(false);
        setIsStopping(false);
        stopRunTimer();
        // Clear any tests/suites/files stuck in 'running' (e.g. after stop).
        treeRef.current.resetRunningStatuses();
        break;
      case 'test-start': {
        const key = traceKey(msg.projectName, msg.fullName);
        // Track which worker ran this test
        if (msg.workerId != null) {
          testWorkerMapRef.current.set(key, msg.workerId);
        }
        // Mark this test (and its parent describe/file) as running — scoped
        // to the project running it so a sibling project's copy of the same
        // file doesn't pulse blue too.
        treeRef.current.updateTestStatus(msg.fullName, msg.filePath, 'running', undefined, undefined, msg.projectName);

        // Track the active test for trace data accumulation, but don't
        // auto-select in the tree — only failures trigger auto-selection.
        activeTestRef.current = key;

        // Only reset pin if the user is viewing this test (or no test selected)
        if (!viewedTestNameRef.current || viewedTestNameRef.current === msg.fullName) {
          setPinnedIndex(0);
          setHoveredIndex(null);
        }
        // Ensure trace data exists for this test, snapshotting its source file.
        // If trace data already exists (e.g. retry after infrastructure error
        // recovery), clear it so stale events from the failed attempt don't
        // accumulate alongside the retry's events.
        setTestTraces((prev) => {
          const existing = prev.get(key);
          if (existing) revokeTraceScreenshots(existing);
          const next = new Map(prev);
          const data = emptyTraceData(msg.filePath);
          // Match pending source by test file basename
          const basename = msg.filePath.split('/').pop() ?? '';
          const sourceContent = pendingSourcesRef.current.get(basename);
          if (sourceContent) {
            data.sources = new Map([[basename, sourceContent]]);
          }
          next.set(key, data);
          return next;
        });
        break;
      }
      case 'test-status': {
        const statusKey = traceKey(msg.projectName, msg.fullName);
        if (msg.workerId != null) {
          testWorkerMapRef.current.set(statusKey, msg.workerId);
        }
        treeRef.current.updateTestStatus(msg.fullName, msg.filePath, msg.status, msg.duration, msg.error, msg.projectName);
        if (msg.tracePath) {
          setTestTraces((prev) => {
            const data = prev.get(statusKey);
            if (!data) return prev;
            const next = new Map(prev);
            next.set(statusKey, { ...data, tracePath: msg.tracePath });
            return next;
          });
        }
        // Auto-expand tree path to failing test, select it, and pin the failing action
        if (msg.status === 'failed') {
          treeRef.current.expandPathTo(msg.fullName, msg.filePath, msg.projectName);
          // Tree IDs are scoped per-project (e.g. "project::android::") when
          // running multi-device configs, so use the same prefix here.
          const idPrefix = msg.projectName ? `project::${msg.projectName}::` : '';
          treeRef.current.setSelectedTestId(`${idPrefix}${msg.filePath}::${msg.fullName}`);
          autoFollowRef.current = 'manual';
          activeTestRef.current = statusKey;

          // Find the last failed action and pin it
          setTestTraces((prev) => {
            const trace = prev.get(statusKey);
            if (trace) {
              const failIdx = trace.actionEvents.findLastIndex((e) => e.status === 'failed');
              if (failIdx !== -1) {
                setPinnedIndex(failIdx);
                setHoveredIndex(null);
              }
            }
            return prev;
          });
        }
        break;
      }
      case 'file-status':
        treeRef.current.updateFileStatus(msg.filePath, msg.status, msg.projectName);
        break;
      case 'trace-event': {
        const testName = msg.testFullName || (activeTestRef.current ?? '').split('::').slice(1).join('::');
        if (!testName) break;
        const key = msg.testFullName
          ? traceKey(msg.projectName, msg.testFullName)
          : (activeTestRef.current ?? '');
        if (!key) break;
        const ev = msg.event;

        setTestTraces((prev) => {
          const { data, map } = getOrCreateTrace(key, prev);

          // Append event. For assertions without bounds, inherit from the
          // most recent action that had bounds (e.g. find() → toBe() chain).
          let eventToStore = ev;
          if ((ev.type === 'assertion' && !ev.bounds) || (ev.type === 'action' && !ev.bounds)) {
            const prevWithBounds = [...data.actionEvents].reverse().find((e) =>
              (e.type === 'action' || e.type === 'assertion') && e.bounds
            );
            if (prevWithBounds?.bounds) {
              eventToStore = { ...ev, bounds: prevWithBounds.bounds };
            }
          }
          // Skip internal marker events from the visible event lists
          const isInternal = ev.type === 'action' && (ev as ActionTraceEvent).action === '__final_screenshot';
          const events = isInternal ? data.events : [...data.events, eventToStore];
          const actionEvents = (!isInternal && (eventToStore.type === 'action' || eventToStore.type === 'assertion'))
            ? [...data.actionEvents, eventToStore as ActionTraceEvent | AssertionTraceEvent]
            : data.actionEvents;

          // Store screenshots/hierarchies
          const screenshots = new Map(data.screenshots);
          const hierarchies = new Map(data.hierarchies);
          if (ev.type === 'action' || ev.type === 'assertion') {
            const pad = String(ev.actionIndex).padStart(3, '0');
            if (msg.screenshotBefore) {
              const key = `screenshots/action-${pad}-before.png`;
              const old = screenshots.get(key);
              if (old) try { URL.revokeObjectURL(old); } catch { /* already revoked */ }
              screenshots.set(key, base64ToBlobUrl(msg.screenshotBefore));
            }
            if (msg.screenshotAfter) {
              const key = `screenshots/action-${pad}-after.png`;
              const old = screenshots.get(key);
              if (old) try { URL.revokeObjectURL(old); } catch { /* already revoked */ }
              screenshots.set(key, base64ToBlobUrl(msg.screenshotAfter));
            }
            // For actions without screenshots (e.g. generic toBe assertions),
            // inherit the most recent screenshot so clicking them still shows
            // the device state.
            if (!msg.screenshotBefore && !msg.screenshotAfter) {
              const prevIdx = ev.actionIndex - 1;
              if (prevIdx >= 0) {
                const prevPad = String(prevIdx).padStart(3, '0');
                const prevAfter = screenshots.get(`screenshots/action-${prevPad}-after.png`)
                  ?? screenshots.get(`screenshots/action-${prevPad}-before.png`);
                if (prevAfter) {
                  screenshots.set(`screenshots/action-${pad}-before.png`, prevAfter);
                }
              }
            }
            if (msg.hierarchyBefore) {
              hierarchies.set(`hierarchy/action-${pad}-before.xml`, msg.hierarchyBefore);
            }
            if (msg.hierarchyAfter) {
              hierarchies.set(`hierarchy/action-${pad}-after.xml`, msg.hierarchyAfter);
            }
          }

          const next = new Map(map);
          next.set(key, { events, actionEvents, screenshots, hierarchies, sources: data.sources, network: data.network, filePath: data.filePath });
          return next;
        });

        // Auto-pin to latest action, but only when viewing the running test
        if ((ev.type === 'action' || ev.type === 'assertion') && key === activeTestRef.current
          && (!viewedTestNameRef.current || viewedTestNameRef.current === testName)) {
          setPinnedIndex(ev.actionIndex);
        }
        break;
      }
      case 'source':
        // Buffer source files — they arrive before test-start, so we snapshot
        // them into per-test trace data when each test begins.
        pendingSourcesRef.current.set(msg.fileName, msg.content);
        break;
      case 'network': {
        const key = msg.testFullName
          ? traceKey(msg.projectName, msg.testFullName)
          : (activeTestRef.current ?? '');
        if (!key) break;
        setTestTraces((prev) => {
          const { data, map } = getOrCreateTrace(key, prev);
          const next = new Map(map);
          next.set(key, { ...data, network: msg.entries });
          return next;
        });
        break;
      }
      case 'watch-event':
        if (msg.event === 'watch-enabled') {
          treeRef.current.updateWatchEnabled(msg.filePath, true);
        } else if (msg.event === 'watch-disabled') {
          treeRef.current.updateWatchEnabled(msg.filePath, false);
        }
        break;
      case 'device-info':
        setDeviceSerial(msg.serial);
        if (msg.devicePixelRatio != null) setDeviceDpr(msg.devicePixelRatio);
        if (msg.pilotVersion) setPilotVersion(msg.pilotVersion);
        break;
      case 'workers-info':
        setWorkers(msg.workers.map((w) => ({
          ...w,
          displayName: w.displayName,
          status: 'idle' as const,
          passed: 0,
          failed: 0,
          skipped: 0,
        })));
        break;
      case 'worker-status':
        setWorkers((prev) => {
          const idx = prev.findIndex((w) => w.workerId === msg.workerId);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = {
            ...next[idx],
            status: msg.status,
            currentFile: msg.currentFile,
            currentTest: msg.currentTest,
            passed: msg.passed,
            failed: msg.failed,
            skipped: msg.skipped,
          };
          return next;
        });
        break;
      case 'error':
        console.error('[Pilot UI]', msg.message);
        break;
    }
  }, []);

  const handleConnectionChange = useCallback((isConnected: boolean) => {
    setConnected(isConnected);
  }, []);

  // Route binary frames to the appropriate mirror hook based on view mode.
  // Only use multi-mirror when in 'all' mode AND multiple workers exist.
  const deviceViewModeRef = useRef(deviceViewMode);
  deviceViewModeRef.current = deviceViewMode;
  const workersLenRef = useRef(workers.length);
  workersLenRef.current = workers.length;
  const handleScreenFrame = useCallback((data: ArrayBuffer) => {
    if (deviceViewModeRef.current === 'all' && workersLenRef.current > 1) {
      handleMultiBinaryFrame(data);
    } else {
      handleBinaryFrame(data);
    }
  }, [handleBinaryFrame, handleMultiBinaryFrame]);

  const { send } = useWebSocket({
    onMessage: handleMessage,
    onBinaryMessage: handleScreenFrame,
    onConnectionChange: handleConnectionChange,
  });

  const handleThemeChange = useCallback((newTheme: Theme) => {
    setTheme(newTheme);
    localStorage.setItem('pilot-ui-theme', newTheme);
    const resolved = newTheme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : newTheme;
    document.documentElement.setAttribute('data-theme', resolved);
  }, []);

  const handleSend = useCallback((msg: ClientMessage) => {
    // Inject runDeps flag when the toggle is on. Use the ref for the latest
    // value regardless of React batching (same pattern as activeTestRef).
    if (runDepsRef.current && (msg.type === 'run-file' || msg.type === 'run-test' || msg.type === 'run-project')) {
      send({ ...msg, runDeps: true });
    } else {
      send(msg);
    }
  }, [send]);

  const handleToggleRunDeps = useCallback(() => {
    setRunDepsFirst((prev) => {
      const next = !prev;
      runDepsRef.current = next;
      localStorage.setItem('pilot-ui-run-deps', String(next));
      return next;
    });
  }, []);

  // Auto-switch device mirror to the worker that ran the viewed test.
  // Only fires when the viewed test changes — manual mirror selections must
  // not be clobbered, so deviceViewMode is read via ref instead of as a dep.
  const lastSentWorkerRef = useRef<number | undefined>(undefined);
  const deviceViewModeRefForAutoSwitch = useRef(deviceViewMode);
  deviceViewModeRefForAutoSwitch.current = deviceViewMode;
  useEffect(() => {
    if (!viewedTraceKey || workers.length < 2) return;
    const wid = testWorkerMapRef.current.get(viewedTraceKey);
    if (wid != null && wid !== lastSentWorkerRef.current) {
      lastSentWorkerRef.current = wid;
      setSelectedWorkerId(wid);
      const mode = deviceViewModeRefForAutoSwitch.current;
      if (mode !== 'all') setDeviceViewMode(wid);
      send({ type: 'select-worker-view', mode: mode === 'all' ? 'all' : wid });
    }
  }, [viewedTraceKey, workers.length, send]);

  const handleSelectDeviceView = useCallback((mode: 'all' | number) => {
    setDeviceViewMode(mode);
    if (typeof mode === 'number') {
      setSelectedWorkerId(mode);
      lastSentWorkerRef.current = mode;
    }
    send({ type: 'select-worker-view', mode });
  }, [send]);

  const handleActionPin = useCallback((index: number) => {
    setPinnedIndex(index);
  }, []);

  // ─── Keyboard shortcuts ───

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore when typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      switch (e.key) {
        case 'r':
          send({ type: 'run-all' });
          break;
        case 'f':
          send({ type: 'run-failed' });
          break;
        case 'Escape':
          send({ type: 'stop-run' });
          setIsStopping(true);
          break;
        case 'w':
          send({ type: 'toggle-watch', filePath: 'all' });
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [send]);

  // ─── Download trace ───

  const handleDownloadTrace = useCallback(async () => {
    if (!viewedTestName || !currentTrace?.tracePath) return;
    try {
      const resp = await fetch(`/trace/${encodeURIComponent(currentTrace.tracePath)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trace-${viewedTestName.replace(/[^a-zA-Z0-9]+/g, '-')}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[Pilot UI] Failed to download trace:', err);
      alert(`Failed to download trace: ${err instanceof Error ? err.message : err}`);
    }
  }, [viewedTestName, currentTrace]);

  return (
    <Layout
      topBar={
        <RunControls
          connected={connected}
          isRunning={isRunning}
          deviceSerial={deviceSerial}
          counts={tree.counts}
          theme={theme}
          onThemeChange={handleThemeChange}
          onSend={handleSend}
          workers={workers}
          runElapsed={runElapsed}
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
          connected={connected}
          isRunning={isRunning}
          isStopping={isStopping}
          isWatching={tree.hasWatchedFiles}
          hasProjectDeps={hasProjectDeps}
          runDepsFirst={runDepsFirst}
          onToggleExpanded={tree.toggleExpanded}
          onExpandAll={tree.expandAll}
          onCollapseAll={tree.collapseAll}
          onSelectTest={useCallback((id: string | null) => {
            if (id != null) autoFollowRef.current = 'manual';
            tree.setSelectedTestId(id);
          }, [tree])}
          onSetNameFilter={tree.setNameFilter}
          onSetStatusFilter={tree.setStatusFilter}
          onSend={handleSend}
          onStop={() => { send({ type: 'stop-run' }); setIsStopping(true); }}
          onToggleRunDeps={handleToggleRunDeps}
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
          showMetadata={viewedTestNode?.type === 'test'}
        />
      }
      screenshotPanel={
        <div class="ui-screen-area">
          {currentTrace?.tracePath && (
            <div class="ui-screen-header">
              <button
                class="ui-download-btn"
                onClick={handleDownloadTrace}
                title="Download trace for this test"
              >
                {'\u2913'} Trace
              </button>
            </div>
          )}
          <div class="ui-screen-content">
            <ScreenshotPanel
              event={selectedEvent}
              screenshots={screenshots}
              devicePixelRatio={viewedTestDpr}
            />
          </div>
        </div>
      }
      devicePane={
        <DevicePane
          canvasRef={canvasRef}
          connected={connected}
          workers={workers}
          selectedWorkerId={selectedWorkerId}
          deviceViewMode={deviceViewMode}
          onSelectDeviceView={handleSelectDeviceView}
          registerCanvas={registerCanvas}
          unregisterCanvas={unregisterCanvas}
        />
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
  );
}

// ─── Styles ───

const style = document.createElement('style');
style.textContent = uiModeStyles;
document.head.appendChild(style);

// ─── Theme (apply before first render) ───

function applyInitialTheme(): void {
  const stored = localStorage.getItem('pilot-ui-theme');
  const theme = (stored === 'light' || stored === 'dark' || stored === 'system') ? stored : 'system';
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}
applyInitialTheme();

// ─── Render ───

render(<App />, document.getElementById('app')!);
