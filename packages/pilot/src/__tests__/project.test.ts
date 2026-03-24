import { describe, it, expect } from 'vitest'
import { resolveProjects, topologicalSort, collectTransitiveDeps, findProjectForFile } from '../project.js'
import type { PilotConfig } from '../config.js'

function makeConfig(overrides: Partial<PilotConfig> = {}): PilotConfig {
  return {
    timeout: 30_000,
    retries: 0,
    screenshot: 'only-on-failure',
    testMatch: ['**/*.test.ts'],
    daemonAddress: 'localhost:50051',
    rootDir: '/tmp',
    outputDir: 'pilot-results',
    workers: 1,
    launchEmulators: false,
    ...overrides,
  }
}

// ─── resolveProjects ───

describe('resolveProjects()', () => {
  it('returns single default project when no projects configured', () => {
    const projects = resolveProjects(makeConfig())
    expect(projects).toHaveLength(1)
    expect(projects[0].name).toBe('default')
    expect(projects[0].testMatch).toEqual(['**/*.test.ts'])
    expect(projects[0].dependencies).toEqual([])
  })

  it('returns single default project when projects is empty array', () => {
    const projects = resolveProjects(makeConfig({ projects: [] }))
    expect(projects).toHaveLength(1)
    expect(projects[0].name).toBe('default')
  })

  it('resolves projects with inherited testMatch', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'a' },
        { name: 'b', testMatch: ['**/special.ts'] },
      ],
    }))
    expect(projects[0].testMatch).toEqual(['**/*.test.ts'])
    expect(projects[1].testMatch).toEqual(['**/special.ts'])
  })

  it('preserves use options', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'auth', use: { appState: './state.tar.gz', timeout: 5000 } },
      ],
    }))
    expect(projects[0].use).toEqual({ appState: './state.tar.gz', timeout: 5000 })
  })

  it('rejects duplicate project names', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'foo' },
        { name: 'foo' },
      ],
    }))).toThrow('Duplicate project name: "foo"')
  })

  it('rejects empty project name', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [{ name: '' }],
    }))).toThrow('Every project must have a name')
  })

  it('rejects missing dependency reference', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'a', dependencies: ['nonexistent'] },
      ],
    }))).toThrow('does not exist')
  })

  it('rejects self-dependency', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'a', dependencies: ['a'] },
      ],
    }))).toThrow('cannot depend on itself')
  })

  it('rejects circular dependencies', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'a', dependencies: ['b'] },
        { name: 'b', dependencies: ['a'] },
      ],
    }))).toThrow('Circular dependency')
  })

  it('rejects transitive circular dependencies', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'a', dependencies: ['c'] },
        { name: 'b', dependencies: ['a'] },
        { name: 'c', dependencies: ['b'] },
      ],
    }))).toThrow('Circular dependency')
  })
})

// ─── topologicalSort ───

describe('topologicalSort()', () => {
  it('returns single wave for projects with no dependencies', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'a' },
        { name: 'b' },
      ],
    }))
    const waves = topologicalSort(projects)
    expect(waves).toHaveLength(1)
    expect(waves[0].map((p) => p.name).sort()).toEqual(['a', 'b'])
  })

  it('returns correct wave order for linear chain', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup' },
        { name: 'auth', dependencies: ['setup'] },
        { name: 'e2e', dependencies: ['auth'] },
      ],
    }))
    const waves = topologicalSort(projects)
    expect(waves).toHaveLength(3)
    expect(waves[0].map((p) => p.name)).toEqual(['setup'])
    expect(waves[1].map((p) => p.name)).toEqual(['auth'])
    expect(waves[2].map((p) => p.name)).toEqual(['e2e'])
  })

  it('resolves diamond dependency correctly', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup' },
        { name: 'a', dependencies: ['setup'] },
        { name: 'b', dependencies: ['setup'] },
        { name: 'final', dependencies: ['a', 'b'] },
      ],
    }))
    const waves = topologicalSort(projects)
    expect(waves).toHaveLength(3)
    expect(waves[0].map((p) => p.name)).toEqual(['setup'])
    expect(waves[1].map((p) => p.name).sort()).toEqual(['a', 'b'])
    expect(waves[2].map((p) => p.name)).toEqual(['final'])
  })

  it('places independent roots in wave 0', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup' },
        { name: 'independent' },
        { name: 'dependent', dependencies: ['setup'] },
      ],
    }))
    const waves = topologicalSort(projects)
    expect(waves).toHaveLength(2)
    expect(waves[0].map((p) => p.name).sort()).toEqual(['independent', 'setup'])
    expect(waves[1].map((p) => p.name)).toEqual(['dependent'])
  })

  it('handles single default project', () => {
    const projects = resolveProjects(makeConfig())
    const waves = topologicalSort(projects)
    expect(waves).toHaveLength(1)
    expect(waves[0][0].name).toBe('default')
  })
})

// ─── collectTransitiveDeps ───

describe('collectTransitiveDeps()', () => {
  it('returns just the project when it has no dependencies', () => {
    const projects = resolveProjects(makeConfig({
      projects: [{ name: 'a' }, { name: 'b' }],
    }))
    const result = collectTransitiveDeps(new Set(['a']), projects)
    expect([...result]).toEqual(['a'])
  })

  it('includes direct dependencies', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup' },
        { name: 'auth', dependencies: ['setup'] },
      ],
    }))
    const result = collectTransitiveDeps(new Set(['auth']), projects)
    expect([...result].sort()).toEqual(['auth', 'setup'])
  })

  it('includes transitive dependencies', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'a' },
        { name: 'b', dependencies: ['a'] },
        { name: 'c', dependencies: ['b'] },
      ],
    }))
    const result = collectTransitiveDeps(new Set(['c']), projects)
    expect([...result].sort()).toEqual(['a', 'b', 'c'])
  })

  it('deduplicates diamond dependencies', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup' },
        { name: 'a', dependencies: ['setup'] },
        { name: 'b', dependencies: ['setup'] },
        { name: 'final', dependencies: ['a', 'b'] },
      ],
    }))
    const result = collectTransitiveDeps(new Set(['final']), projects)
    expect([...result].sort()).toEqual(['a', 'b', 'final', 'setup'])
  })
})

// ─── findProjectForFile ───

describe('findProjectForFile()', () => {
  it('matches file to project by testMatch', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup', testMatch: ['**/auth.setup.ts'] },
        { name: 'default', testMatch: ['**/*.test.ts'] },
      ],
    }))
    expect(findProjectForFile('/tmp/tests/auth.setup.ts', projects, '/tmp')).toBe('setup')
    expect(findProjectForFile('/tmp/tests/foo.test.ts', projects, '/tmp')).toBe('default')
  })

  it('respects testIgnore', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'default', testMatch: ['**/*.test.ts'], testIgnore: ['**/app-state.test.ts'] },
        { name: 'auth', testMatch: ['**/app-state.test.ts'] },
      ],
    }))
    expect(findProjectForFile('/tmp/tests/app-state.test.ts', projects, '/tmp')).toBe('auth')
  })

  it('returns undefined for unmatched file', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup', testMatch: ['**/auth.setup.ts'] },
      ],
    }))
    expect(findProjectForFile('/tmp/tests/foo.test.ts', projects, '/tmp')).toBeUndefined()
  })
})
