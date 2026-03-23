/**
 * Project resolution and dependency ordering.
 *
 * Mirrors Playwright's project concept: named groups of test files with
 * dependency constraints and shared `use` options.
 */

import type { PilotConfig, ProjectConfig, UseOptions } from './config.js'

// ─── Types ───

export interface ResolvedProject {
  name: string
  testMatch: string[]
  testIgnore: string[]
  dependencies: string[]
  use?: UseOptions
  /** Populated by the CLI after file discovery. */
  testFiles: string[]
}

// ─── Resolution ───

/**
 * Resolve the project configuration. When `config.projects` is defined,
 * validates names, dependencies, and cycles. When not defined, returns a
 * single synthetic "default" project so the rest of the pipeline always
 * works with the project abstraction.
 */
export function resolveProjects(config: PilotConfig): ResolvedProject[] {
  if (!config.projects || config.projects.length === 0) {
    return [{
      name: 'default',
      testMatch: config.testMatch,
      testIgnore: [],
      dependencies: [],
      use: undefined,
      testFiles: [],
    }]
  }

  const projects = config.projects
  const names = new Set<string>()

  // Validate unique names
  for (const p of projects) {
    if (!p.name) {
      throw new Error('Every project must have a name')
    }
    if (names.has(p.name)) {
      throw new Error(`Duplicate project name: "${p.name}"`)
    }
    names.add(p.name)
  }

  // Validate dependency references
  for (const p of projects) {
    for (const dep of p.dependencies ?? []) {
      if (!names.has(dep)) {
        throw new Error(
          `Project "${p.name}" depends on "${dep}", which does not exist. ` +
          `Available projects: ${[...names].join(', ')}`,
        )
      }
      if (dep === p.name) {
        throw new Error(`Project "${p.name}" cannot depend on itself`)
      }
    }
  }

  // Validate no cycles
  detectCycles(projects)

  return projects.map((p) => ({
    name: p.name,
    testMatch: p.testMatch ?? config.testMatch,
    testIgnore: p.testIgnore ?? [],
    dependencies: p.dependencies ?? [],
    use: p.use,
    testFiles: [],
  }))
}

// ─── Topological sort ───

/**
 * Sort projects into execution waves using Kahn's algorithm.
 * Returns an array of waves — each wave is a list of projects whose
 * dependencies are satisfied by all preceding waves.
 *
 * Wave 0 = no dependencies, wave 1 = depends only on wave 0, etc.
 */
export function topologicalSort(projects: ResolvedProject[]): ResolvedProject[][] {
  const byName = new Map(projects.map((p) => [p.name, p]))
  const inDegree = new Map(projects.map((p) => [p.name, 0]))

  for (const p of projects) {
    for (const _dep of p.dependencies) {
      inDegree.set(p.name, (inDegree.get(p.name) ?? 0) + 1)
    }
  }

  const waves: ResolvedProject[][] = []
  const remaining = new Set(projects.map((p) => p.name))

  while (remaining.size > 0) {
    const wave: ResolvedProject[] = []

    for (const name of remaining) {
      if ((inDegree.get(name) ?? 0) === 0) {
        wave.push(byName.get(name)!)
      }
    }

    if (wave.length === 0) {
      // Should not happen if detectCycles passed, but guard anyway
      throw new Error(
        `Circular dependency detected among projects: ${[...remaining].join(', ')}`,
      )
    }

    for (const p of wave) {
      remaining.delete(p.name)

      // Decrease in-degree for dependents
      for (const other of projects) {
        if (other.dependencies.includes(p.name)) {
          inDegree.set(other.name, (inDegree.get(other.name) ?? 0) - 1)
        }
      }
    }

    waves.push(wave)
  }

  return waves
}

// ─── Cycle detection ───

function detectCycles(projects: ProjectConfig[]): void {
  const visited = new Set<string>()
  const stack = new Set<string>()
  const depMap = new Map(projects.map((p) => [p.name, p.dependencies ?? []]))

  function dfs(name: string, path: string[]): void {
    if (stack.has(name)) {
      const cycleStart = path.indexOf(name)
      const cycle = [...path.slice(cycleStart), name].join(' → ')
      throw new Error(`Circular dependency detected: ${cycle}`)
    }
    if (visited.has(name)) return

    stack.add(name)
    path.push(name)

    for (const dep of depMap.get(name) ?? []) {
      dfs(dep, path)
    }

    stack.delete(name)
    path.pop()
    visited.add(name)
  }

  for (const p of projects) {
    dfs(p.name, [])
  }
}
