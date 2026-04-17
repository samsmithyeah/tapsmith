/**
 * Test tree state management hook for UI mode.
 *
 * Manages the hierarchical test tree, expansion state, filtering,
 * and status updates from the server.
 */

import { useState, useCallback, useMemo } from 'preact/hooks';
import type { TestTreeNode, TestNodeStatus } from '../ui-protocol.js';

export function useTestTree() {
  const [files, setFiles] = useState<TestTreeNode[]>([]);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);
  const [nameFilter, setNameFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'passed' | 'failed' | 'skipped'>('all');

  const setTestTree = useCallback((newFiles: TestTreeNode[]) => {
    setFiles(newFiles);
    // Expand project nodes only — files and below start collapsed
    const expanded = new Set<string>();
    for (const node of newFiles) {
      if (node.type === 'project') expanded.add(node.id);
    }
    setExpandedNodes(expanded);
  }, []);

  /** Expand all nodes in the tree. */
  const expandAll = useCallback(() => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      function walk(nodes: TestTreeNode[]) {
        for (const node of nodes) {
          if (node.children && node.children.length > 0) {
            next.add(node.id);
            walk(node.children);
          }
        }
      }
      walk(files);
      return next;
    });
  }, [files]);

  /** Collapse all nodes in the tree. */
  const collapseAll = useCallback(() => {
    setExpandedNodes(new Set());
  }, []);

  /** Expand the path from root to a specific test node. When `projectName`
   * is provided, only expand within that project's subtree. */
  const expandPathTo = useCallback((fullName: string, filePath: string, projectName?: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      function walk(nodes: TestTreeNode[]): boolean {
        for (const node of nodes) {
          if (node.type === 'test' && node.fullName === fullName && node.filePath === filePath) {
            return true;
          }
          if (node.children) {
            if (walk(node.children)) {
              next.add(node.id);
              return true;
            }
          }
        }
        return false;
      }
      const roots = projectName
        ? files.filter((n) => n.type === 'project' && n.name === projectName)
        : files;
      walk(roots);
      return next;
    });
  }, [files]);

  const toggleExpanded = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const updateTestStatus = useCallback((
    fullName: string,
    filePath: string,
    status: TestNodeStatus,
    duration?: number,
    error?: string,
    projectName?: string,
  ) => {
    setFiles((prev) => updateNodeInTree(prev, fullName, filePath, status, duration, error, projectName));
  }, []);

  const updateFileStatus = useCallback((filePath: string, status: 'running' | 'done', projectName?: string) => {
    setFiles((prev) => updateFileStatusInTree(prev, filePath, status, projectName));
  }, []);

  const updateWatchEnabled = useCallback((filePath: string, enabled: boolean, testFilter?: string, projectName?: string) => {
    if (filePath === 'project' && projectName) {
      setFiles((prev) => updateProjectWatchInTree(prev, projectName, enabled));
      return;
    }
    setFiles((prev) => updateWatchInTree(prev, filePath, enabled, testFilter, projectName));
  }, []);

  /** Reset any 'running' nodes back to 'idle' (e.g. after a stopped run). */
  const resetRunningStatuses = useCallback(() => {
    setFiles((prev) => prev.map(resetRunningInTree));
  }, []);

  // Filter the tree based on name and status
  const filteredFiles = useMemo(() => {
    if (!nameFilter && statusFilter === 'all') return files;
    return filterTree(files, nameFilter.toLowerCase(), statusFilter);
  }, [files, nameFilter, statusFilter]);

  // Compute summary counts
  const counts = useMemo(() => {
    let passed = 0, failed = 0, skipped = 0, total = 0;
    function walk(nodes: TestTreeNode[]) {
      for (const node of nodes) {
        if (node.type === 'test') {
          total++;
          if (node.status === 'passed') passed++;
          else if (node.status === 'failed') failed++;
          else if (node.status === 'skipped') skipped++;
        }
        if (node.children) walk(node.children);
      }
    }
    walk(files);
    return { passed, failed, skipped, total };
  }, [files]);

  const hasWatchedFiles = useMemo(() => {
    function walk(nodes: TestTreeNode[]): boolean {
      for (const n of nodes) {
        if (n.watchEnabled) return true;
        if (n.children && walk(n.children)) return true;
      }
      return false;
    }
    return walk(files);
  }, [files]);

  return {
    files: filteredFiles,
    allFiles: files,
    hasWatchedFiles,
    expandedNodes,
    selectedTestId,
    nameFilter,
    statusFilter,
    counts,
    setTestTree,
    toggleExpanded,
    expandAll,
    collapseAll,
    expandPathTo,
    setSelectedTestId,
    setNameFilter,
    setStatusFilter,
    updateTestStatus,
    updateFileStatus,
    updateWatchEnabled,
    resetRunningStatuses,
  };
}

// ─── Helpers ───

function updateNodeInTree(
  nodes: TestTreeNode[],
  fullName: string,
  filePath: string,
  status: TestNodeStatus,
  duration?: number,
  error?: string,
  projectName?: string,
): TestTreeNode[] {
  return nodes.map((node) => {
    // When a projectName is provided, only descend into the matching project.
    // Other project nodes are left untouched so the same file living in
    // multiple projects doesn't get its status mirrored across all of them.
    if (node.type === 'project' && projectName && node.name !== projectName) {
      return node;
    }

    // Project nodes contain files with various paths — always recurse.
    // Other nodes skip if filePath doesn't match.
    if (node.type !== 'project' && node.filePath !== filePath) return node;

    if (node.type === 'test' && node.fullName === fullName) {
      return { ...node, status, duration, error };
    }

    if (node.children) {
      const updatedChildren = updateNodeInTree(node.children, fullName, filePath, status, duration, error, projectName);
      if (updatedChildren !== node.children) {
        // Derive parent status from children
        const childStatuses = flattenStatuses(updatedChildren);
        const hasRunning = childStatuses.includes('running');
        const hasIdle = childStatuses.includes('idle');
        const hasFailed = childStatuses.includes('failed');
        const allPassed = childStatuses.length > 0
          && childStatuses.every((s) => s === 'passed' || s === 'skipped');
        const allIdle = childStatuses.every((s) => s === 'skipped' || s === 'idle');
        const parentStatus = hasRunning ? 'running'
          // Still running with idle children means more tests are expected —
          // keep 'running' so the parent doesn't flash to passed/failed mid-run.
          : (node.status === 'running' && hasIdle) ? 'running'
          : hasFailed ? 'failed'
          : allPassed ? 'passed'
          : allIdle ? node.status
          : node.status;
        return { ...node, children: updatedChildren, status: parentStatus };
      }
    }

    return node;
  });
}

function flattenStatuses(nodes: TestTreeNode[]): TestNodeStatus[] {
  const statuses: TestNodeStatus[] = [];
  for (const node of nodes) {
    if (node.type === 'test') {
      statuses.push(node.status);
    }
    if (node.children) {
      statuses.push(...flattenStatuses(node.children));
    }
  }
  return statuses;
}

/**
 * Recursively re-derive all parent node statuses from leaf test statuses.
 * Called when a run finishes to clear stale 'running' from describe/file nodes.
 */
function rederiveTree(node: TestTreeNode): TestTreeNode {
  if (node.type === 'test' || !node.children) return node;
  const children = node.children.map(rederiveTree);
  const childStatuses = flattenStatuses(children);
  const hasFailed = childStatuses.includes('failed');
  const allPassed = childStatuses.length > 0
    && childStatuses.every((s) => s === 'passed' || s === 'skipped');
  const status: TestNodeStatus = hasFailed ? 'failed'
    : allPassed ? 'passed'
    : node.status === 'running' ? 'idle'
    : node.status;
  return { ...node, children, status };
}

/**
 * Recursively update a file node's status, handling project → file nesting.
 * Re-derives parent (project/suite) statuses after the update.
 */
function updateFileStatusInTree(
  nodes: TestTreeNode[],
  filePath: string,
  status: 'running' | 'done',
  projectName?: string,
): TestTreeNode[] {
  return nodes.map((node) => {
    // When a projectName is provided, only descend into the matching project.
    if (node.type === 'project' && projectName && node.name !== projectName) {
      return node;
    }

    // Direct match — file node
    if (node.type === 'file' && node.filePath === filePath) {
      if (status === 'running') return { ...node, status: 'running' as const };
      return rederiveTree(node);
    }

    // Recurse into project (or suite) children
    if (node.children) {
      const updatedChildren = updateFileStatusInTree(node.children, filePath, status, projectName);
      if (updatedChildren.some((c, i) => c !== node.children![i])) {
        return rederiveTree({ ...node, children: updatedChildren });
      }
    }

    return node;
  });
}

/**
 * Set watchEnabled on a specific project node (top-level), leaving its
 * descendants alone. Used for project-scoped watch toggles where the
 * project-level icon should light up on its own.
 */
function updateProjectWatchInTree(
  nodes: TestTreeNode[],
  projectName: string,
  enabled: boolean,
): TestTreeNode[] {
  return nodes.map((node) => {
    if (node.type === 'project' && node.name === projectName) {
      return { ...node, watchEnabled: enabled };
    }
    return node;
  });
}

/**
 * Recursively set watchEnabled on a node. If testFilter is undefined, targets
 * the file node; otherwise targets the test/suite node whose fullName matches
 * the filter within that file. When projectName is provided, only nodes
 * descended from that project's subtree are updated — in multi-device
 * configs the same file appears under multiple project subtrees, and watch
 * state must be per-project to match the project-specific run it triggers.
 */
function updateWatchInTree(
  nodes: TestTreeNode[],
  filePath: string,
  enabled: boolean,
  testFilter: string | undefined,
  projectName: string | undefined,
  insideMatchingProject: boolean = projectName === undefined,
): TestTreeNode[] {
  return nodes.map((node) => {
    if (node.type === 'project') {
      const childInside = projectName === undefined || node.name === projectName;
      if (!node.children) return node;
      const updatedChildren = updateWatchInTree(node.children, filePath, enabled, testFilter, projectName, childInside);
      if (updatedChildren.some((c, i) => c !== node.children![i])) {
        return { ...node, children: updatedChildren };
      }
      return node;
    }
    const isTarget = insideMatchingProject && (
      testFilter === undefined
        ? (node.type === 'file' && node.filePath === filePath)
        : (node.filePath === filePath && node.fullName === testFilter
            && (node.type === 'suite' || node.type === 'test'))
    );
    if (isTarget) {
      return { ...node, watchEnabled: enabled };
    }
    if (node.children) {
      const updatedChildren = updateWatchInTree(node.children, filePath, enabled, testFilter, projectName, insideMatchingProject);
      if (updatedChildren.some((c, i) => c !== node.children![i])) {
        return { ...node, children: updatedChildren };
      }
    }
    return node;
  });
}

/**
 * Recursively reset any 'running' node (test, suite, file, project)
 * back to 'idle'. Used when a run is stopped mid-flight.
 */
function resetRunningInTree(node: TestTreeNode): TestTreeNode {
  const status = node.status === 'running' ? 'idle' as const : node.status;
  if (!node.children) {
    return status !== node.status ? { ...node, status } : node;
  }
  const children = node.children.map(resetRunningInTree);
  const changed = status !== node.status || children.some((c, i) => c !== node.children![i]);
  return changed ? { ...node, status, children } : node;
}

function filterTree(
  nodes: TestTreeNode[],
  nameFilter: string,
  statusFilter: string,
): TestTreeNode[] {
  return nodes
    .map((node) => {
      if (node.type === 'test') {
        const matchesName = !nameFilter || node.fullName.toLowerCase().includes(nameFilter);
        const matchesStatus = statusFilter === 'all' || node.status === statusFilter;
        return matchesName && matchesStatus ? node : null;
      }

      // For files and suites, recurse into children
      const filteredChildren = node.children
        ? filterTree(node.children, nameFilter, statusFilter)
        : [];

      // Keep this node if it has matching children
      if (filteredChildren.length > 0) {
        return { ...node, children: filteredChildren };
      }

      return null;
    })
    .filter((node): node is TestTreeNode => node !== null);
}
