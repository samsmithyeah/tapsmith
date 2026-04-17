/**
 * Test Explorer — file/suite/test tree with run controls.
 *
 * Displays the hierarchical test tree with status indicators,
 * per-node play buttons, watch toggles, and filtering.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArrowLeft, Check, ChevronsDownUp, ChevronsUpDown, Circle, CircleSlash, Eye, Link, LoaderCircle, Play, Square, X } from 'lucide-preact';
import type { TestTreeNode, ClientMessage } from '../ui-protocol.js';

const ICON_SIZE = 13;
const STATUS_SIZE = 12;
const TOOLBAR_ICON_SIZE = 14;

// ─── Pending helpers ───

/** Build a map from node ID → parent ID by walking the tree. */
function buildParentMap(roots: TestTreeNode[]): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (node: TestTreeNode, parentId?: string) => {
    if (parentId) map.set(node.id, parentId);
    node.children?.forEach((c) => walk(c, node.id));
  };
  roots.forEach((r) => walk(r));
  return map;
}

/** Collect a node and all its descendants. */
function collectSubtreeIds(node: TestTreeNode, out: string[] = []): string[] {
  out.push(node.id);
  node.children?.forEach((c) => collectSubtreeIds(c, out));
  return out;
}

/** Find a node by ID in the tree. */
function findNode(roots: TestTreeNode[], id: string): TestTreeNode | undefined {
  for (const root of roots) {
    if (root.id === id) return root;
    if (root.children) {
      const found = findNode(root.children, id);
      if (found) return found;
    }
  }
}


interface TestExplorerProps {
  files: TestTreeNode[]
  expandedNodes: Set<string>
  selectedTestId: string | null
  nameFilter: string
  statusFilter: 'all' | 'passed' | 'failed' | 'skipped'
  counts: { passed: number; failed: number; skipped: number; total: number }
  connected: boolean
  isRunning: boolean
  isStopping: boolean
  isWatching: boolean
  hasProjectDeps: boolean
  runDepsFirst: boolean
  onToggleExpanded: (nodeId: string) => void
  onExpandAll: () => void
  onCollapseAll: () => void
  onSelectTest: (testId: string | null) => void
  onSetNameFilter: (filter: string) => void
  onSetStatusFilter: (filter: 'all' | 'passed' | 'failed' | 'skipped') => void
  onSend: (msg: ClientMessage) => void
  onStop: () => void
  onToggleRunDeps: () => void
}

export function TestExplorer(props: TestExplorerProps) {
  const {
    files, expandedNodes, selectedTestId, nameFilter, statusFilter,
    counts, connected, isRunning, isStopping, isWatching, hasProjectDeps, runDepsFirst,
    onToggleExpanded, onExpandAll, onCollapseAll, onSelectTest,
    onSetNameFilter, onSetStatusFilter, onSend, onStop, onToggleRunDeps,
  } = props;

  const parentMap = useMemo(() => buildParentMap(files), [files]);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  /** Status snapshot per pending id, captured when play was clicked. Pending
   * is cleared the moment the node's status moves off its snapshot — this
   * catches the normal transition to 'running' *and* the edge case where
   * the server jumps straight to a terminal state ('passed'/'failed'/
   * 'skipped') without an intermediate 'running'. */
  const pendingSnapshots = useRef<Map<string, TestTreeNode['status']>>(new Map());

  useEffect(() => {
    if (pendingIds.size === 0) return;
    const stillPending = new Set<string>();
    const check = (node: TestTreeNode) => {
      if (pendingIds.has(node.id)) {
        const snapshot = pendingSnapshots.current.get(node.id);
        const unchanged = snapshot === undefined
          ? node.status !== 'running'
          : node.status === snapshot;
        if (unchanged) stillPending.add(node.id);
      }
      node.children?.forEach(check);
    };
    files.forEach(check);
    if (stillPending.size !== pendingIds.size) {
      for (const id of pendingIds) {
        if (!stillPending.has(id)) pendingSnapshots.current.delete(id);
      }
      setPendingIds(stillPending);
    }
  }, [files, pendingIds]);

  // Clear all pending when a run stops
  useEffect(() => {
    if (!isRunning && pendingIds.size > 0) {
      pendingSnapshots.current.clear();
      setPendingIds(new Set());
    }
  }, [isRunning]);

  const handleSetPending = useCallback((nodeId: string) => {
    const node = findNode(files, nodeId);
    if (!node) return;
    const ids = collectSubtreeIds(node);
    // Walk up ancestors
    let cur = parentMap.get(nodeId);
    while (cur) {
      ids.push(cur);
      cur = parentMap.get(cur);
    }
    for (const id of ids) {
      const n = findNode(files, id);
      if (n) pendingSnapshots.current.set(id, n.status);
    }
    setPendingIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
  }, [files, parentMap]);

  return (
    <div class="test-explorer">
      <div class="te-header">
        <input
          class="te-search"
          type="text"
          placeholder="Filter tests..."
          value={nameFilter}
          onInput={(e) => onSetNameFilter((e.target as HTMLInputElement).value)}
        />
        <div class="te-status-filters">
          <StatusButton label="All" value="all" count={counts.total} active={statusFilter} onClick={onSetStatusFilter} />
          <StatusButton label="Pass" value="passed" count={counts.passed} active={statusFilter} onClick={onSetStatusFilter} />
          <StatusButton label="Fail" value="failed" count={counts.failed} active={statusFilter} onClick={onSetStatusFilter} />
          <StatusButton label="Skip" value="skipped" count={counts.skipped} active={statusFilter} onClick={onSetStatusFilter} />
        </div>
      </div>
      <div class="te-toolbar">
        <span class="te-toolbar-title">Tests</span>
        <div class="te-toolbar-actions">
          <button
            class="te-toolbar-btn"
            onClick={() => onSend({ type: 'run-all' })}
            disabled={isRunning || !connected}
            title="Run all tests"
          >
            <Play size={TOOLBAR_ICON_SIZE} />
          </button>
          <button
            class={`te-toolbar-btn${isStopping ? ' stopping' : ''}`}
            onClick={onStop}
            disabled={!isRunning || isStopping}
            title={isStopping ? 'Stopping…' : 'Stop current run'}
          >
            <Square size={TOOLBAR_ICON_SIZE} />
          </button>
          <button
            class={`te-toolbar-btn ${isWatching ? 'active' : ''}`}
            onClick={() => onSend({ type: 'toggle-watch', filePath: 'all' })}
            disabled={!connected}
            title={isWatching ? 'Disable watch mode' : 'Watch all files for changes'}
          >
            <Eye size={TOOLBAR_ICON_SIZE} />
          </button>
          {hasProjectDeps && (
            <button
              class={`te-toolbar-btn ${runDepsFirst ? 'active' : ''}`}
              onClick={onToggleRunDeps}
              title={runDepsFirst
                ? 'Dependencies run automatically — click to disable'
                : 'Run dependency projects first — click to enable'}
            >
              <Link size={TOOLBAR_ICON_SIZE} />
            </button>
          )}
          <span class="te-toolbar-sep" />
          <button class="te-toolbar-btn" onClick={onExpandAll} title="Expand all">
            <ChevronsUpDown size={TOOLBAR_ICON_SIZE} />
          </button>
          <button class="te-toolbar-btn" onClick={onCollapseAll} title="Collapse all">
            <ChevronsDownUp size={TOOLBAR_ICON_SIZE} />
          </button>
        </div>
      </div>
      <div class="te-tree">
        {files.map((file) => (
          <TreeNode
            key={file.id}
            node={file}
            depth={0}
            expandedNodes={expandedNodes}
            selectedTestId={selectedTestId}
            onToggleExpanded={onToggleExpanded}
            onSelectTest={onSelectTest}
            onSend={onSend}
            isRunning={isRunning}
            pendingIds={pendingIds}
            onSetPending={handleSetPending}
          />
        ))}
        {files.length === 0 && (
          <div class="te-empty">No tests found</div>
        )}
      </div>
    </div>
  );
}

// ─── Status filter button ───

interface StatusButtonProps {
  label: string
  value: 'all' | 'passed' | 'failed' | 'skipped'
  count: number
  active: string
  onClick: (value: 'all' | 'passed' | 'failed' | 'skipped') => void
}

function StatusButton({ label, value, count, active, onClick }: StatusButtonProps) {
  return (
    <button
      class={`te-status-btn ${active === value ? 'active' : ''} te-status-${value}`}
      onClick={() => onClick(value)}
    >
      {label} {count > 0 && <span class="te-count">{count}</span>}
    </button>
  );
}

// ─── Tree node ───

interface TreeNodeProps {
  node: TestTreeNode
  depth: number
  /** Name of the nearest ancestor project node, if any. Threaded down so
   * file/test runs can include `projectName` and route to the right device
   * when the same file is shared across multiple projects. */
  parentProjectName?: string
  expandedNodes: Set<string>
  selectedTestId: string | null
  onToggleExpanded: (nodeId: string) => void
  onSelectTest: (testId: string | null) => void
  onSend: (msg: ClientMessage) => void
  isRunning: boolean
  pendingIds: Set<string>
  onSetPending: (nodeId: string) => void
}

function TreeNode({ node, depth, parentProjectName, expandedNodes, selectedTestId, onToggleExpanded, onSelectTest, onSend, isRunning, pendingIds, onSetPending }: TreeNodeProps) {
  const isExpanded = expandedNodes.has(node.id);
  const isSelected = selectedTestId === node.id;
  const hasChildren = node.children && node.children.length > 0;

  // Status flash animation (failures only — green flashes are distracting)
  const prevStatusRef = useRef(node.status);
  const [flashClass, setFlashClass] = useState('');

  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = node.status;
    if (prev === 'running' && node.status === 'failed') {
      setFlashClass('te-status-flash-failed');
      const timer = setTimeout(() => setFlashClass(''), 600);
      return () => clearTimeout(timer);
    }
    setFlashClass('');
  }, [node.status]);

  const pending = pendingIds.has(node.id);

  const handleRun = useCallback((e: Event) => {
    e.stopPropagation();
    onSelectTest(node.id);
    onSetPending(node.id);
    if (node.type === 'project') {
      onSend({ type: 'run-project', projectName: node.name });
    } else if (node.type === 'file') {
      onSend({ type: 'run-file', filePath: node.filePath, projectName: parentProjectName });
    } else {
      onSend({ type: 'run-test', fullName: node.fullName, filePath: node.filePath, projectName: parentProjectName });
    }
  }, [node, parentProjectName, onSend, onSelectTest, onSetPending]);

  const handleWatch = useCallback((e: Event) => {
    e.stopPropagation();
    if (node.type === 'project') {
      // Project-level watch: server iterates every file in the project and
      // toggles whole-file watch scoped to that project.
      onSend({ type: 'toggle-watch', filePath: 'project', projectName: node.name });
      return;
    }
    // File nodes watch the whole file; test/suite nodes pass their fullName
    // as the filter so only that test (or describe subtree) re-runs.
    // parentProjectName scopes the watch to one project in multi-device
    // configs so sibling projects don't inherit it.
    const testFilter = node.type === 'file' ? undefined : node.fullName;
    onSend({ type: 'toggle-watch', filePath: node.filePath, testFilter, projectName: parentProjectName });
  }, [node, parentProjectName, onSend]);

  const handleClick = useCallback(() => {
    if (hasChildren) {
      onToggleExpanded(node.id);
    }
    onSelectTest(node.id);
  }, [node.id, hasChildren, onToggleExpanded, onSelectTest]);

  const runningClass = node.status === 'running' ? 'te-status-running' : '';

  return (
    <div class="te-node-group">
      <div
        class={`te-node ${isSelected ? 'selected' : ''} te-node-${node.type} ${runningClass} ${flashClass}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={handleClick}
      >
        {hasChildren && (
          <span class={`te-chevron ${isExpanded ? 'expanded' : ''}`} />
        )}
        {!hasChildren && <span class="te-chevron-spacer" />}

        <StatusIcon status={node.status} pending={pending} />

        <span class="te-name" title={node.fullName}>
          {node.type === 'project' ? `[${node.name}]` : node.name}
        </span>

        {node.type === 'project' && node.dependencies && node.dependencies.length > 0 && (
          <span class="te-deps" title={`Depends on: ${node.dependencies.join(', ')}`}>
            <ArrowLeft size={10} /> {node.dependencies.join(', ')}
          </span>
        )}

        {node.duration !== undefined && node.duration > 0 && (
          <span class="te-duration">{formatDuration(node.duration)}</span>
        )}

        <div class="te-actions">
          <button class="te-action-btn te-run-btn" onClick={handleRun} disabled={isRunning} title="Run">
            <Play size={ICON_SIZE} />
          </button>
          <button
            class={`te-action-btn te-watch-btn ${node.watchEnabled ? 'active' : ''}`}
            onClick={handleWatch}
            title={node.type === 'project'
              ? 'Watch all files in this project'
              : node.type === 'file'
                ? 'Watch file for changes'
                : node.type === 'suite'
                  ? 'Watch this describe block'
                  : 'Watch this test'}
          >
            <Eye size={ICON_SIZE} />
          </button>
        </div>
      </div>
      {hasChildren && isExpanded && node.children!.map((child) => (
        <TreeNode
          key={child.id}
          node={child}
          depth={depth + 1}
          parentProjectName={node.type === 'project' ? node.name : parentProjectName}
          expandedNodes={expandedNodes}
          selectedTestId={selectedTestId}
          onToggleExpanded={onToggleExpanded}
          onSelectTest={onSelectTest}
          onSend={onSend}
          isRunning={isRunning}
          pendingIds={pendingIds}
          onSetPending={onSetPending}
        />
      ))}
    </div>
  );
}

// ─── Status icon ───

function StatusIcon({ status, pending }: { status: TestTreeNode['status']; pending?: boolean }) {
  // While pending (play clicked, run not yet reported as started) show the
  // pulsing pending icon regardless of the previous result — a lingering
  // passed/failed icon makes the UI feel unresponsive.
  if (pending && status !== 'running') {
    return <span class="te-status-icon pending"><Circle size={STATUS_SIZE} /></span>;
  }
  switch (status) {
    case 'passed':
      return <span class="te-status-icon passed"><Check size={STATUS_SIZE} /></span>;
    case 'failed':
      return <span class="te-status-icon failed"><X size={STATUS_SIZE} /></span>;
    case 'skipped':
      return <span class="te-status-icon skipped"><CircleSlash size={STATUS_SIZE} /></span>;
    case 'running':
      return <span class="te-status-icon running"><LoaderCircle size={STATUS_SIZE} /></span>;
    default:
      return <span class="te-status-icon idle"><Circle size={STATUS_SIZE} /></span>;
  }
}

// ─── Helpers ───

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
