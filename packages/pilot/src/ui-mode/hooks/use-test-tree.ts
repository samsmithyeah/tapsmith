/**
 * Test tree state management hook for UI mode.
 *
 * Manages the hierarchical test tree, expansion state, filtering,
 * and status updates from the server.
 */

import { useState, useCallback, useMemo } from 'preact/hooks'
import type { TestTreeNode, TestNodeStatus } from '../ui-protocol.js'

export interface TestTreeState {
  files: TestTreeNode[]
  expandedNodes: Set<string>
  selectedTestId: string | null
  nameFilter: string
  statusFilter: 'all' | 'passed' | 'failed' | 'skipped'
}

export function useTestTree() {
  const [files, setFiles] = useState<TestTreeNode[]>([])
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null)
  const [nameFilter, setNameFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'passed' | 'failed' | 'skipped'>('all')

  const setTestTree = useCallback((newFiles: TestTreeNode[]) => {
    setFiles(newFiles)
    // Auto-expand all file nodes
    const expanded = new Set<string>()
    for (const file of newFiles) {
      expanded.add(file.id)
    }
    setExpandedNodes(expanded)
  }, [])

  const toggleExpanded = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) {
        next.delete(nodeId)
      } else {
        next.add(nodeId)
      }
      return next
    })
  }, [])

  const updateTestStatus = useCallback((
    fullName: string,
    filePath: string,
    status: TestNodeStatus,
    duration?: number,
    error?: string,
  ) => {
    setFiles((prev) => updateNodeInTree(prev, fullName, filePath, status, duration, error))
  }, [])

  const updateFileStatus = useCallback((filePath: string, status: 'running' | 'done') => {
    setFiles((prev) => prev.map((file) => {
      if (file.filePath !== filePath) return file
      return {
        ...file,
        status: status === 'running' ? 'running' as const : file.status,
      }
    }))
  }, [])

  const updateWatchEnabled = useCallback((filePath: string, enabled: boolean) => {
    setFiles((prev) => prev.map((file) => {
      if (file.filePath !== filePath) return file
      return { ...file, watchEnabled: enabled }
    }))
  }, [])

  // Filter the tree based on name and status
  const filteredFiles = useMemo(() => {
    if (!nameFilter && statusFilter === 'all') return files
    return filterTree(files, nameFilter.toLowerCase(), statusFilter)
  }, [files, nameFilter, statusFilter])

  // Compute summary counts
  const counts = useMemo(() => {
    let passed = 0, failed = 0, skipped = 0, total = 0
    function walk(nodes: TestTreeNode[]) {
      for (const node of nodes) {
        if (node.type === 'test') {
          total++
          if (node.status === 'passed') passed++
          else if (node.status === 'failed') failed++
          else if (node.status === 'skipped') skipped++
        }
        if (node.children) walk(node.children)
      }
    }
    walk(files)
    return { passed, failed, skipped, total }
  }, [files])

  return {
    files: filteredFiles,
    allFiles: files,
    expandedNodes,
    selectedTestId,
    nameFilter,
    statusFilter,
    counts,
    setTestTree,
    toggleExpanded,
    setSelectedTestId,
    setNameFilter,
    setStatusFilter,
    updateTestStatus,
    updateFileStatus,
    updateWatchEnabled,
  }
}

// ─── Helpers ───

function updateNodeInTree(
  nodes: TestTreeNode[],
  fullName: string,
  filePath: string,
  status: TestNodeStatus,
  duration?: number,
  error?: string,
): TestTreeNode[] {
  return nodes.map((node) => {
    if (node.filePath !== filePath) return node

    if (node.type === 'test' && node.fullName === fullName) {
      return { ...node, status, duration, error }
    }

    if (node.children) {
      const updatedChildren = updateNodeInTree(node.children, fullName, filePath, status, duration, error)
      if (updatedChildren !== node.children) {
        // Derive parent status from children
        const childStatuses = flattenStatuses(updatedChildren)
        const parentStatus = childStatuses.includes('running') ? 'running'
          : childStatuses.includes('failed') ? 'failed'
          : childStatuses.every((s) => s === 'passed') ? 'passed'
          : childStatuses.every((s) => s === 'skipped' || s === 'idle') ? node.status
          : node.status
        return { ...node, children: updatedChildren, status: parentStatus }
      }
    }

    return node
  })
}

function flattenStatuses(nodes: TestTreeNode[]): TestNodeStatus[] {
  const statuses: TestNodeStatus[] = []
  for (const node of nodes) {
    if (node.type === 'test') {
      statuses.push(node.status)
    }
    if (node.children) {
      statuses.push(...flattenStatuses(node.children))
    }
  }
  return statuses
}

function filterTree(
  nodes: TestTreeNode[],
  nameFilter: string,
  statusFilter: string,
): TestTreeNode[] {
  return nodes
    .map((node) => {
      if (node.type === 'test') {
        const matchesName = !nameFilter || node.fullName.toLowerCase().includes(nameFilter)
        const matchesStatus = statusFilter === 'all' || node.status === statusFilter
        return matchesName && matchesStatus ? node : null
      }

      // For files and suites, recurse into children
      const filteredChildren = node.children
        ? filterTree(node.children, nameFilter, statusFilter)
        : []

      // Keep this node if it has matching children
      if (filteredChildren.length > 0) {
        return { ...node, children: filteredChildren }
      }

      return null
    })
    .filter((node): node is TestTreeNode => node !== null)
}
