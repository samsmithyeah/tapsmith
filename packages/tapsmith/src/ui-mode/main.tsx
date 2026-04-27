import { render } from 'preact';
import { useState, useCallback, useMemo, useRef, useEffect } from 'preact/hooks';
import type { ServerMessage, ClientMessage, TestTreeNode, WorkerInfo } from './ui-protocol.js';
import type { ActionTraceEvent, AssertionTraceEvent, TraceMetadata } from '../trace/types.js';
import { sortEventsByStartTime } from '../trace/sort-events.js';
import { useWebSocket } from './hooks/use-websocket.js';
import {
  useTraceData,
  base64ToBlobUrl,
  base64ToUtf8,
  revokeTraceScreenshots,
  emptyTraceData,
  getOrCreateTrace,
  EMPTY_MAP,
  EMPTY_EVENTS,
  EMPTY_ACTION_EVENTS,
  EMPTY_NETWORK,
  type TestTraceData,
  type InFlightAction,
} from './hooks/use-trace-data.js';
import { useScreenMirror, useMultiScreenMirror } from './hooks/use-screen-mirror.js';
import { useTestTree } from './hooks/use-test-tree.js';
import { useRunTimer } from './hooks/use-run-timer.js';
import { Layout } from './components/Layout.js';
import { TestExplorer } from './components/TestExplorer.js';
import { RunControls, type Theme } from './components/RunControls.js';
import { DevicePane } from './components/DevicePane.js';
import { McpPanel } from './components/McpPanel.js';
// Trace viewer components — reused for live trace display
import { ActionsPanel } from '../trace-viewer/components/ActionsPanel.js';
import { ScreenshotPanel } from '../trace-viewer/components/ScreenshotPanel.js';
import { DetailTabs } from '../trace-viewer/components/DetailTabs.js';
import { TimelineFilmstrip } from '../trace-viewer/components/TimelineFilmstrip.js';
import { SelectorTab, handlePickFromScreenshot, handleHoverFromScreenshot } from '../trace-viewer/components/SelectorPlayground.js';
import { parseHierarchyXml } from '../trace-viewer/components/hierarchy-utils.js';
import type { HierarchyNode, Bounds } from '../trace-viewer/components/hierarchy-utils.js';
import { uiModeStyles } from './styles/ui-mode.css.js';

// ─── App ───

function App() {
  const [connected, setConnected] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [deviceSerial, setDeviceSerial] = useState('');
  const [deviceDpr, setDeviceDpr] = useState<number | undefined>();
  const [tapsmithVersion, setTapsmithVersion] = useState('');
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('tapsmith-ui-theme');
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

  // Selector playground state
  const [hierarchyHighlight, setHierarchyHighlight] = useState<Bounds | null>(null);
  const [selectorHighlights, setSelectorHighlights] = useState<Bounds[]>([]);
  const [pickMode, setPickMode] = useState(false);
  const [selectorText, setSelectorText] = useState('');
  const [pickedNode, setPickedNode] = useState<HierarchyNode | null>(null);
  const [hoverBounds, setHoverBounds] = useState<Bounds | null>(null);

  // Device pane state
  const [selectedWorkerId, setSelectedWorkerId] = useState(0);
  const [deviceViewMode, setDeviceViewMode] = useState<'all' | number>('all');

  // MCP state
  const [mcpSseUrl, setMcpSseUrl] = useState<string | undefined>();
  const [mcpClientName, setMcpClientName] = useState<string | undefined>();
  const [mcpClientVersion, setMcpClientVersion] = useState<string | undefined>();
  const [mcpToolCalls, setMcpToolCalls] = useState<import('./ui-protocol.js').McpToolCallMessage[]>([]);
  const [mcpPanelOpen, setMcpPanelOpen] = useState(false);

  // "Run deps first" toggle — persisted in localStorage
  const [runDepsFirst, setRunDepsFirst] = useState(() => {
    return localStorage.getItem('tapsmith-ui-run-deps') === 'true';
  });
  const runDepsRef = useRef(runDepsFirst);

  const { runElapsed, startRunTimer, stopRunTimer } = useRunTimer();

  const tree = useTestTree(isRunning);
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
  // no project prefix. The synthetic "default" project is normalized to
  // undefined to match how the server tags trace-event messages (the server
  // strips "default" on broadcast); without this, trace lookup keys mismatch
  // for tests under the default project and the Actions tab stays empty.
  const extractProject = (id: string): string | undefined => {
    if (!id.startsWith('project::')) return undefined;
    const afterProject = id.slice('project::'.length);
    const sep = afterProject.indexOf('::');
    const name = sep === -1 ? afterProject : afterProject.slice(0, sep);
    return name === 'default' ? undefined : name;
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
  // Sort by start time (timestamp - duration) so concurrent actions
  // (e.g. route handlers firing during a tap) appear in start-time order
  // rather than completion order.
  const traceEvents = useMemo(
    () => (currentTrace?.events ? sortEventsByStartTime(currentTrace.events) : EMPTY_EVENTS),
    [currentTrace?.events],
  );
  const actionEvents = useMemo(
    () => (currentTrace?.actionEvents
      ? sortEventsByStartTime(currentTrace.actionEvents)
      : EMPTY_ACTION_EVENTS),
    [currentTrace?.actionEvents],
  );
  const screenshots = currentTrace?.screenshots ?? EMPTY_MAP;
  const hierarchies = currentTrace?.hierarchies ?? EMPTY_MAP;
  const sources = currentTrace?.sources ?? EMPTY_MAP;
  const networkEntries = currentTrace?.network ?? EMPTY_NETWORK;
  const networkBodies = currentTrace?.networkBodies ?? EMPTY_MAP;

  // Metadata for trace viewer components
  const testDeviceSerial = useMemo(() => {
    if (viewedTraceKey) {
      const workerId = testWorkerMapRef.current.get(viewedTraceKey);
      if (workerId != null && workers[workerId]) {
        return workers[workerId].displayName || workers[workerId].deviceSerial;
      }
    }
    // Multi-worker runs: don't fall back to the global deviceSerial — it
    // holds the first worker's serial from the initial `device-info` event,
    // which is almost never the worker that ran the viewed test. Returning
    // empty hides the label rather than labelling the filmstrip with a
    // sibling worker's name. Single-worker runs have no ambiguity.
    return workers.length > 1 ? '' : deviceSerial;
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
    tapsmithVersion,
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
  }), [viewedTestName, viewedTestFile, viewedTestNode, isRunning, actionEvents.length, screenshots.size, testDeviceSerial, tapsmithVersion]);

  // Prefer a real completed event at this index; fall back to a synthesized
  // one from the in-flight slot so ScreenshotPanel can render the before-
  // screenshot (and overlay bounds, if any) while the action is running.
  const selectedEvent = useMemo<ActionTraceEvent | AssertionTraceEvent | undefined>(() => {
    const completed = actionEvents[selectedIndex];
    if (completed) return completed;
    const inFlight = currentTrace?.inFlightAction;
    if (!inFlight || inFlight.actionIndex !== selectedIndex) return undefined;
    if (inFlight.kind === 'action') {
      return {
        type: 'action',
        actionIndex: inFlight.actionIndex,
        timestamp: inFlight.startedAt,
        category: 'other',
        action: inFlight.label,
        selector: inFlight.selector,
        duration: 0,
        success: true,
        bounds: inFlight.bounds,
        point: inFlight.point,
        hasScreenshotBefore: inFlight.hasScreenshotBefore,
        hasScreenshotAfter: false,
        hasHierarchyBefore: inFlight.hasHierarchyBefore,
        hasHierarchyAfter: false,
      } satisfies ActionTraceEvent;
    }
    return {
      type: 'assertion',
      actionIndex: inFlight.actionIndex,
      timestamp: inFlight.startedAt,
      assertion: inFlight.label,
      selector: inFlight.selector,
      passed: true,
      soft: false,
      negated: false,
      duration: 0,
      attempts: 0,
      bounds: inFlight.bounds,
      hasScreenshotBefore: inFlight.hasScreenshotBefore,
      hasScreenshotAfter: false,
      hasHierarchyBefore: inFlight.hasHierarchyBefore,
      hasHierarchyAfter: false,
    } satisfies AssertionTraceEvent;
  }, [actionEvents, selectedIndex, currentTrace?.inFlightAction]);

  // Hierarchy XML for the current action (used by selector playground)
  const currentHierarchyXml = useMemo(() => {
    if (!selectedEvent || hierarchies.size === 0) return undefined;
    const pad = String(selectedEvent.actionIndex).padStart(3, '0');
    const afterKey = `hierarchy/action-${pad}-after.xml`;
    const beforeKey = `hierarchy/action-${pad}-before.xml`;
    return hierarchies.get(afterKey) ?? hierarchies.get(beforeKey);
  }, [selectedEvent, hierarchies]);

  const currentRoots = useMemo(
    () => currentHierarchyXml ? parseHierarchyXml(currentHierarchyXml) : [],
    [currentHierarchyXml],
  );

  const dpr = viewedTestDpr ?? 1;

  const handleScreenshotClick = useCallback((point: { x: number; y: number }) => {
    if (!pickMode || currentRoots.length === 0) return;
    const result = handlePickFromScreenshot(currentRoots, point.x / dpr, point.y / dpr);
    if (result) {
      setSelectorText(result.selector);
      setPickedNode(result.node);
      setPickMode(false);
      setHoverBounds(null);
    }
  }, [pickMode, currentRoots, dpr]);

  const handlePickToggle = useCallback(() => {
    setPickMode(p => !p);
    setHoverBounds(null);
  }, []);

  const handleScreenshotHover = useCallback((point: { x: number; y: number } | null) => {
    if (!pickMode || currentRoots.length === 0 || !point) {
      setHoverBounds(null);
      return;
    }
    setHoverBounds(handleHoverFromScreenshot(currentRoots, point.x / dpr, point.y / dpr));
  }, [pickMode, currentRoots, dpr]);

  // Clear selector state when selected action changes
  useEffect(() => {
    setSelectorHighlights([]);
    setHierarchyHighlight(null);
    setPickedNode(null);
    setHoverBounds(null);
  }, [selectedIndex]);

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
        // Clear any in-flight slots that didn't receive a completed event
        // (e.g. run aborted mid-action) so spinners don't linger.
        setTestTraces((prev) => {
          let changed = false;
          const next = new Map(prev);
          for (const [k, data] of prev) {
            if (data.inFlightAction != null) {
              next.set(k, { ...data, inFlightAction: null });
              changed = true;
            }
          }
          return changed ? next : prev;
        });
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
        // Single reducer: clear any stale in-flight slot AND store tracePath
        // (when present) in one render. Test end implies pre-flight done and
        // any spinner should clear; on reconnect we may have no entry yet
        // for this test, in which case stub one so the Download Trace
        // button can appear.
        setTestTraces((prev) => {
          const existing = prev.get(statusKey);
          const needsClear = existing?.inFlightAction != null;
          if (!existing && !msg.tracePath) return prev;
          if (existing && !needsClear && !msg.tracePath) return prev;
          const data = existing ?? emptyTraceData(msg.filePath);
          const next = new Map(prev);
          next.set(statusKey, {
            ...data,
            inFlightAction: null,
            ...(msg.tracePath ? { tracePath: msg.tracePath } : {}),
          });
          return next;
        });
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
        // Skip internal marker events from the visible event lists and from
        // auto-pin — their actionIndex is one past the last real event.
        const isInternal = ev.type === 'action' && ev.action === '__final_screenshot';
        const isStarted = msg.lifecycle === 'started';

        setTestTraces((prev) => {
          const { data, map } = getOrCreateTrace(key, prev);

          // Always store before-screenshot/hierarchy at action-XXX-before so
          // the screenshot panel can display device state during execution.
          // Both 'started' and 'completed' carry the same before-capture, so
          // this runs identically for both branches.
          const screenshots = new Map(data.screenshots);
          const hierarchies = new Map(data.hierarchies);
          if (ev.type === 'action' || ev.type === 'assertion') {
            const pad = String(ev.actionIndex).padStart(3, '0');
            if (msg.screenshotBefore) {
              const k = `screenshots/action-${pad}-before.png`;
              const old = screenshots.get(k);
              if (old) try { URL.revokeObjectURL(old); } catch { /* already revoked */ }
              screenshots.set(k, base64ToBlobUrl(msg.screenshotBefore));
            }
            if (msg.screenshotAfter) {
              const k = `screenshots/action-${pad}-after.png`;
              const old = screenshots.get(k);
              if (old) try { URL.revokeObjectURL(old); } catch { /* already revoked */ }
              screenshots.set(k, base64ToBlobUrl(msg.screenshotAfter));
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

          // Started: set the in-flight slot, do NOT append to events/actionEvents.
          // The matching 'completed' event will land at the same actionIndex.
          if (isStarted && !isInternal && (ev.type === 'action' || ev.type === 'assertion')) {
            // Inherit bounds from the most recent completed action when the
            // started signal lacks them (e.g. assertions chained off a find).
            // Without this the in-flight overlay flickers off between actions.
            let inheritedBounds = ev.bounds;
            if (!inheritedBounds) {
              const prevWithBounds = [...data.actionEvents].reverse().find((e) =>
                (e.type === 'action' || e.type === 'assertion') && e.bounds
              );
              if (prevWithBounds?.bounds) inheritedBounds = prevWithBounds.bounds;
            }
            // ev is narrowed to ActionTraceEvent | AssertionTraceEvent here;
            // both have these flags (assertion's are optional, hence the ??).
            const hasShotBefore = !!ev.hasScreenshotBefore;
            const hasHierBefore = !!ev.hasHierarchyBefore;
            const inFlightAction: InFlightAction = ev.type === 'action'
              ? {
                  actionIndex: ev.actionIndex,
                  kind: 'action',
                  label: ev.action,
                  selector: ev.selector,
                  failed: false,
                  startedAt: ev.timestamp,
                  bounds: inheritedBounds,
                  point: ev.point,
                  hasScreenshotBefore: hasShotBefore,
                  hasHierarchyBefore: hasHierBefore,
                }
              : {
                  actionIndex: ev.actionIndex,
                  kind: 'assertion',
                  label: ev.assertion,
                  selector: ev.selector,
                  failed: false,
                  startedAt: ev.timestamp,
                  bounds: inheritedBounds,
                  hasScreenshotBefore: hasShotBefore,
                  hasHierarchyBefore: hasHierBefore,
                };
            const next = new Map(map);
            next.set(key, { ...data, screenshots, hierarchies, inFlightAction });
            return next;
          }

          // Completed (or no lifecycle = legacy completed). Append event.
          // For assertions/actions without bounds, inherit from the most
          // recent action that had bounds (e.g. find() → toBe() chain).
          let eventToStore = ev;
          if ((ev.type === 'assertion' && !ev.bounds) || (ev.type === 'action' && !ev.bounds)) {
            const prevWithBounds = [...data.actionEvents].reverse().find((e) =>
              (e.type === 'action' || e.type === 'assertion') && e.bounds
            );
            if (prevWithBounds?.bounds) {
              eventToStore = { ...ev, bounds: prevWithBounds.bounds };
            }
          }
          const events = isInternal ? data.events : [...data.events, eventToStore];
          const actionEvents = (!isInternal && (eventToStore.type === 'action' || eventToStore.type === 'assertion'))
            ? [...data.actionEvents, eventToStore]
            : data.actionEvents;

          // Clear in-flight slot when the matching completion arrives.
          const inFlightAction = data.inFlightAction
            && (ev.type === 'action' || ev.type === 'assertion')
            && data.inFlightAction.actionIndex === ev.actionIndex
              ? null
              : data.inFlightAction;

          const next = new Map(map);
          next.set(key, { ...data, events, actionEvents, screenshots, hierarchies, inFlightAction });
          return next;
        });

        // Auto-pin to latest action, but only when viewing the running test.
        // Skip internal markers (e.g. __final_screenshot) — their actionIndex
        // is one past the last real event, so pinning to them leaves the UI
        // with nothing selected once the test ends.
        // Pin on both 'started' and 'completed' so the in-flight row is
        // highlighted while running, then stays selected after it lands.
        if (!isInternal && (ev.type === 'action' || ev.type === 'assertion') && key === activeTestRef.current
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
          const networkBodies = new Map(data.networkBodies);
          if (msg.bodies) {
            for (const [path, b64] of Object.entries(msg.bodies)) {
              networkBodies.set(path, base64ToUtf8(b64));
            }
          }
          const next = new Map(map);
          next.set(key, { ...data, network: msg.entries, networkBodies });
          return next;
        });
        break;
      }
      case 'watch-event':
        if (msg.event === 'watch-enabled') {
          treeRef.current.updateWatchEnabled(msg.filePath, true, msg.testFilter, msg.projectName);
        } else if (msg.event === 'watch-disabled') {
          treeRef.current.updateWatchEnabled(msg.filePath, false, msg.testFilter, msg.projectName);
        }
        break;
      case 'device-info':
        setDeviceSerial(msg.serial);
        if (msg.devicePixelRatio != null) setDeviceDpr(msg.devicePixelRatio);
        if (msg.tapsmithVersion) setTapsmithVersion(msg.tapsmithVersion);
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
        console.error('[Tapsmith UI]', msg.message);
        break;

      case 'mcp-status':
        setMcpSseUrl(msg.sseUrl);
        setMcpClientName(msg.clientName);
        setMcpClientVersion(msg.clientVersion);
        break;

      case 'mcp-tool-call':
        setMcpToolCalls((prev) => {
          const next = [...prev, msg];
          return next.length > 200 ? next.slice(-200) : next;
        });
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
    localStorage.setItem('tapsmith-ui-theme', newTheme);
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

  // Wrap tree.setPending to also clear trace data for the node being run so
  // the Actions tab immediately shows the preflight "Waiting for first
  // action…" message instead of lingering actions from the previous run.
  // Without this, old actions stay visible until the server's run-start
  // broadcast arrives and clears the trace — a noticeable delay, especially
  // with multiple workers where ensureWorkersReady() adds latency.
  const handleSetPending = useCallback((nodeId: string) => {
    treeRef.current.setPending(nodeId);

    const projectName = extractProject(nodeId);
    const stripped = stripProjectPrefix(nodeId);
    const sep = stripped.indexOf('::');
    if (sep !== -1) {
      // Test or suite node — clear its specific trace
      const fullName = stripped.slice(sep + 2);
      const key = traceKey(projectName, fullName);
      setTestTraces((prev) => {
        const old = prev.get(key);
        if (!old) return prev;
        revokeTraceScreenshots(old);
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    } else {
      // File or project node — clear all traces for matching file
      setTestTraces((prev) => {
        let changed = false;
        const next = new Map<string, TestTraceData>();
        for (const [k, data] of prev) {
          const matchesFile = data.filePath === stripped;
          const matchesProject = !projectName || k.startsWith(`${projectName}::`);
          if (matchesFile && matchesProject) {
            revokeTraceScreenshots(data);
            changed = true;
          } else {
            next.set(k, data);
          }
        }
        return changed ? next : prev;
      });
    }
  }, [setTestTraces]);

  const handleToggleRunDeps = useCallback(() => {
    setRunDepsFirst((prev) => {
      const next = !prev;
      runDepsRef.current = next;
      localStorage.setItem('tapsmith-ui-run-deps', String(next));
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

  // Show an in-progress empty state in the Actions tab whenever the
  // currently-viewed test is pending (play clicked, server hasn't yet
  // confirmed the run started) or running but no action has streamed
  // yet. The test explorer tree pulses across exactly this same window;
  // this mirrors the visual on the Actions side so the panel doesn't
  // look frozen during the IPC dispatch + ESM import + hooks-before-
  // first-action gap.
  const preflightMessage = useMemo<string | undefined>(() => {
    if (!viewedTestNode) return undefined;
    const isPending = tree.pendingIds.has(viewedTestNode.id);
    const isRunning = viewedTestNode.status === 'running';
    return isPending || isRunning ? 'Waiting for first action…' : undefined;
  }, [viewedTestNode, tree.pendingIds]);

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
      console.error('[Tapsmith UI] Failed to download trace:', err);
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
          mcpClientName={mcpClientName}
          mcpPanelOpen={mcpPanelOpen}
          onToggleMcpPanel={() => setMcpPanelOpen(prev => !prev)}
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
          pendingIds={tree.pendingIds}
          onSetPending={handleSetPending}
        />
      }
      filmstrip={
        <TimelineFilmstrip
          events={actionEvents}
          screenshots={screenshots}
          metadata={metadata}
          selectedIndex={selectedIndex}
          onSelect={handleActionPin}
        />
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
          inFlightAction={currentTrace?.inFlightAction}
          preflightMessage={preflightMessage}
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
              highlightBounds={hierarchyHighlight}
              selectorHighlights={selectorHighlights}
              hoverBounds={hoverBounds}
              onScreenshotClick={pickMode ? handleScreenshotClick : undefined}
              onScreenshotHover={pickMode ? handleScreenshotHover : undefined}
              pickMode={pickMode}
              onPickModeToggle={handlePickToggle}
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
      mcpPanel={mcpPanelOpen ? (
        <McpPanel
          sseUrl={mcpSseUrl}
          clientName={mcpClientName}
          clientVersion={mcpClientVersion}
          toolCalls={mcpToolCalls}
          onClear={() => setMcpToolCalls([])}
        />
      ) : undefined}
      detailTabs={
        <DetailTabs
          event={selectedEvent}
          events={traceEvents}
          hierarchies={hierarchies}
          sources={sources}
          metadata={metadata}
          networkEntries={networkEntries}
          networkBodies={networkBodies}
          onHierarchyNodeSelect={setHierarchyHighlight}
          pickMode={pickMode}
          locatorTab={
            <SelectorTab
              hierarchyXml={currentHierarchyXml}
              pickedNode={pickedNode}
              onHighlightsChange={setSelectorHighlights}
              selector={selectorText}
              onSelectorChange={setSelectorText}
            />
          }
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
  const stored = localStorage.getItem('tapsmith-ui-theme');
  const theme = (stored === 'light' || stored === 'dark' || stored === 'system') ? stored : 'system';
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}
applyInitialTheme();

// ─── Render ───

render(<App />, document.getElementById('app')!);
