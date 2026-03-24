/**
 * Test Explorer — file/suite/test tree with run controls.
 *
 * Displays the hierarchical test tree with status indicators,
 * per-node play buttons, watch toggles, and filtering.
 */

import { useCallback } from 'preact/hooks'
import type { TestTreeNode, ClientMessage } from '../ui-protocol.js'

interface TestExplorerProps {
  files: TestTreeNode[]
  expandedNodes: Set<string>
  selectedTestId: string | null
  nameFilter: string
  statusFilter: 'all' | 'passed' | 'failed' | 'skipped'
  counts: { passed: number; failed: number; skipped: number; total: number }
  onToggleExpanded: (nodeId: string) => void
  onSelectTest: (testId: string | null) => void
  onSetNameFilter: (filter: string) => void
  onSetStatusFilter: (filter: 'all' | 'passed' | 'failed' | 'skipped') => void
  onSend: (msg: ClientMessage) => void
}

export function TestExplorer(props: TestExplorerProps) {
  const {
    files, expandedNodes, selectedTestId, nameFilter, statusFilter,
    counts, onToggleExpanded, onSelectTest, onSetNameFilter, onSetStatusFilter, onSend,
  } = props

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
          />
        ))}
        {files.length === 0 && (
          <div class="te-empty">No tests found</div>
        )}
      </div>
    </div>
  )
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
  )
}

// ─── Tree node ───

interface TreeNodeProps {
  node: TestTreeNode
  depth: number
  expandedNodes: Set<string>
  selectedTestId: string | null
  onToggleExpanded: (nodeId: string) => void
  onSelectTest: (testId: string | null) => void
  onSend: (msg: ClientMessage) => void
}

function TreeNode({ node, depth, expandedNodes, selectedTestId, onToggleExpanded, onSelectTest, onSend }: TreeNodeProps) {
  const isExpanded = expandedNodes.has(node.id)
  const isSelected = selectedTestId === node.id
  const hasChildren = node.children && node.children.length > 0

  const handleRun = useCallback((e: Event) => {
    e.stopPropagation()
    if (node.type === 'project') {
      onSend({ type: 'run-project', projectName: node.name })
    } else if (node.type === 'file') {
      onSend({ type: 'run-file', filePath: node.filePath })
    } else {
      onSend({ type: 'run-test', fullName: node.fullName, filePath: node.filePath })
    }
  }, [node, onSend])

  const handleWatch = useCallback((e: Event) => {
    e.stopPropagation()
    onSend({ type: 'toggle-watch', filePath: node.filePath })
  }, [node, onSend])

  const handleClick = useCallback(() => {
    if (hasChildren) {
      onToggleExpanded(node.id)
    }
    onSelectTest(node.id)
  }, [node.id, hasChildren, onToggleExpanded, onSelectTest])

  return (
    <div class="te-node-group">
      <div
        class={`te-node ${isSelected ? 'selected' : ''} te-node-${node.type}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={handleClick}
      >
        {hasChildren && (
          <span class={`te-chevron ${isExpanded ? 'expanded' : ''}`} />
        )}
        {!hasChildren && <span class="te-chevron-spacer" />}

        <StatusIcon status={node.status} />

        <span class="te-name" title={node.fullName}>
          {node.type === 'project' ? `[${node.name}]` : node.name}
        </span>

        {node.type === 'project' && node.dependencies && node.dependencies.length > 0 && (
          <span class="te-deps" title={`Depends on: ${node.dependencies.join(', ')}`}>
            {'\u2190'} {node.dependencies.join(', ')}
          </span>
        )}

        {node.duration !== undefined && node.duration > 0 && (
          <span class="te-duration">{formatDuration(node.duration)}</span>
        )}

        <div class="te-actions">
          <button class="te-action-btn te-run-btn" onClick={handleRun} title="Run">
            {'\u25B6'}
          </button>
          {node.type === 'file' && (
            <button
              class={`te-action-btn te-watch-btn ${node.watchEnabled ? 'active' : ''}`}
              onClick={handleWatch}
              title="Watch"
            >
              {'\u25C9'}
            </button>
          )}
        </div>
      </div>
      {hasChildren && isExpanded && node.children!.map((child) => (
        <TreeNode
          key={child.id}
          node={child}
          depth={depth + 1}
          expandedNodes={expandedNodes}
          selectedTestId={selectedTestId}
          onToggleExpanded={onToggleExpanded}
          onSelectTest={onSelectTest}
          onSend={onSend}
        />
      ))}
    </div>
  )
}

// ─── Status icon ───

function StatusIcon({ status }: { status: TestTreeNode['status'] }) {
  switch (status) {
    case 'passed':
      return <span class="te-status-icon passed">{'\u2713'}</span>
    case 'failed':
      return <span class="te-status-icon failed">{'\u2717'}</span>
    case 'skipped':
      return <span class="te-status-icon skipped">{'\u2298'}</span>
    case 'running':
      return <span class="te-status-icon running">{'\u25CB'}</span>
    default:
      return <span class="te-status-icon idle">{'\u25CB'}</span>
  }
}

// ─── Helpers ───

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
