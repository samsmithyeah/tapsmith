import { describe, it, expect } from 'vitest';
import { resolveProjects, topologicalSort, collectTransitiveDeps, findProjectForFile, deviceSignature, allocateBucketWorkers, bucketizeProjects, type ResolvedProject } from '../project.js';
import { effectiveConfigForProject, type PilotConfig } from '../config.js';

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
  };
}

// ─── resolveProjects ───

describe('resolveProjects()', () => {
  it('returns single default project when no projects configured', () => {
    const projects = resolveProjects(makeConfig());
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('default');
    expect(projects[0].testMatch).toEqual(['**/*.test.ts']);
    expect(projects[0].dependencies).toEqual([]);
  });

  it('returns single default project when projects is empty array', () => {
    const projects = resolveProjects(makeConfig({ projects: [] }));
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('default');
  });

  it('resolves projects with inherited testMatch', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'a' },
        { name: 'b', testMatch: ['**/special.ts'] },
      ],
    }));
    expect(projects[0].testMatch).toEqual(['**/*.test.ts']);
    expect(projects[1].testMatch).toEqual(['**/special.ts']);
  });

  it('preserves use options', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'auth', use: { appState: './state.tar.gz', timeout: 5000 } },
      ],
    }));
    expect(projects[0].use).toEqual({ appState: './state.tar.gz', timeout: 5000 });
  });

  it('rejects duplicate project names', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'foo' },
        { name: 'foo' },
      ],
    }))).toThrow('Duplicate project name: "foo"');
  });

  it('rejects empty project name', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [{ name: '' }],
    }))).toThrow('Every project must have a name');
  });

  it('rejects missing dependency reference', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'a', dependencies: ['nonexistent'] },
      ],
    }))).toThrow('does not exist');
  });

  it('rejects self-dependency', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'a', dependencies: ['a'] },
      ],
    }))).toThrow('cannot depend on itself');
  });

  it('rejects circular dependencies', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'a', dependencies: ['b'] },
        { name: 'b', dependencies: ['a'] },
      ],
    }))).toThrow('Circular dependency');
  });

  it('rejects transitive circular dependencies', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'a', dependencies: ['c'] },
        { name: 'b', dependencies: ['a'] },
        { name: 'c', dependencies: ['b'] },
      ],
    }))).toThrow('Circular dependency');
  });
});

// ─── topologicalSort ───

describe('topologicalSort()', () => {
  it('returns single wave for projects with no dependencies', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'a' },
        { name: 'b' },
      ],
    }));
    const waves = topologicalSort(projects);
    expect(waves).toHaveLength(1);
    expect(waves[0].map((p) => p.name).sort()).toEqual(['a', 'b']);
  });

  it('returns correct wave order for linear chain', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup' },
        { name: 'auth', dependencies: ['setup'] },
        { name: 'e2e', dependencies: ['auth'] },
      ],
    }));
    const waves = topologicalSort(projects);
    expect(waves).toHaveLength(3);
    expect(waves[0].map((p) => p.name)).toEqual(['setup']);
    expect(waves[1].map((p) => p.name)).toEqual(['auth']);
    expect(waves[2].map((p) => p.name)).toEqual(['e2e']);
  });

  it('resolves diamond dependency correctly', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup' },
        { name: 'a', dependencies: ['setup'] },
        { name: 'b', dependencies: ['setup'] },
        { name: 'final', dependencies: ['a', 'b'] },
      ],
    }));
    const waves = topologicalSort(projects);
    expect(waves).toHaveLength(3);
    expect(waves[0].map((p) => p.name)).toEqual(['setup']);
    expect(waves[1].map((p) => p.name).sort()).toEqual(['a', 'b']);
    expect(waves[2].map((p) => p.name)).toEqual(['final']);
  });

  it('places independent roots in wave 0', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup' },
        { name: 'independent' },
        { name: 'dependent', dependencies: ['setup'] },
      ],
    }));
    const waves = topologicalSort(projects);
    expect(waves).toHaveLength(2);
    expect(waves[0].map((p) => p.name).sort()).toEqual(['independent', 'setup']);
    expect(waves[1].map((p) => p.name)).toEqual(['dependent']);
  });

  it('handles single default project', () => {
    const projects = resolveProjects(makeConfig());
    const waves = topologicalSort(projects);
    expect(waves).toHaveLength(1);
    expect(waves[0][0].name).toBe('default');
  });
});

// ─── collectTransitiveDeps ───

describe('collectTransitiveDeps()', () => {
  it('returns just the project when it has no dependencies', () => {
    const projects = resolveProjects(makeConfig({
      projects: [{ name: 'a' }, { name: 'b' }],
    }));
    const result = collectTransitiveDeps(new Set(['a']), projects);
    expect([...result]).toEqual(['a']);
  });

  it('includes direct dependencies', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup' },
        { name: 'auth', dependencies: ['setup'] },
      ],
    }));
    const result = collectTransitiveDeps(new Set(['auth']), projects);
    expect([...result].sort()).toEqual(['auth', 'setup']);
  });

  it('includes transitive dependencies', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'a' },
        { name: 'b', dependencies: ['a'] },
        { name: 'c', dependencies: ['b'] },
      ],
    }));
    const result = collectTransitiveDeps(new Set(['c']), projects);
    expect([...result].sort()).toEqual(['a', 'b', 'c']);
  });

  it('deduplicates diamond dependencies', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup' },
        { name: 'a', dependencies: ['setup'] },
        { name: 'b', dependencies: ['setup'] },
        { name: 'final', dependencies: ['a', 'b'] },
      ],
    }));
    const result = collectTransitiveDeps(new Set(['final']), projects);
    expect([...result].sort()).toEqual(['a', 'b', 'final', 'setup']);
  });
});

// ─── findProjectForFile ───

describe('findProjectForFile()', () => {
  it('matches file to project by testMatch', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup', testMatch: ['**/auth.setup.ts'] },
        { name: 'default', testMatch: ['**/*.test.ts'] },
      ],
    }));
    expect(findProjectForFile('/tmp/tests/auth.setup.ts', projects, '/tmp')).toBe('setup');
    expect(findProjectForFile('/tmp/tests/foo.test.ts', projects, '/tmp')).toBe('default');
  });

  it('respects testIgnore', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'default', testMatch: ['**/*.test.ts'], testIgnore: ['**/app-state.test.ts'] },
        { name: 'auth', testMatch: ['**/app-state.test.ts'] },
      ],
    }));
    expect(findProjectForFile('/tmp/tests/app-state.test.ts', projects, '/tmp')).toBe('auth');
  });

  it('returns undefined for unmatched file', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup', testMatch: ['**/auth.setup.ts'] },
      ],
    }));
    expect(findProjectForFile('/tmp/tests/foo.test.ts', projects, '/tmp')).toBeUndefined();
  });
});

// ─── effectiveConfigForProject ───

describe('effectiveConfigForProject()', () => {
  it('returns the root config when project has no use options', () => {
    const root = makeConfig({ apk: './app.apk' });
    const merged = effectiveConfigForProject(root, { use: undefined });
    expect(merged).toBe(root);
  });

  it('overrides scalar fields from use', () => {
    const root = makeConfig({ apk: './root.apk', timeout: 5000 });
    const merged = effectiveConfigForProject(root, { use: { timeout: 9000 } });
    expect(merged.timeout).toBe(9000);
    expect(merged.apk).toBe('./root.apk');
  });

  it('overrides device-shaping fields from use', () => {
    const root = makeConfig({ platform: 'android', avd: 'Pixel_6', apk: './a.apk' });
    const merged = effectiveConfigForProject(root, {
      use: { platform: 'ios', simulator: 'iPhone 16', app: './a.app' },
    });
    expect(merged.platform).toBe('ios');
    expect(merged.simulator).toBe('iPhone 16');
    expect(merged.app).toBe('./a.app');
    // Root fields are still present (we leave them; deviceSignature ignores irrelevant ones)
    expect(merged.avd).toBe('Pixel_6');
  });

  it('skips undefined values in use', () => {
    const root = makeConfig({ timeout: 5000 });
    const merged = effectiveConfigForProject(root, { use: { timeout: undefined } });
    expect(merged.timeout).toBe(5000);
  });
});

// ─── deviceSignature ───

describe('deviceSignature()', () => {
  it('produces a stable string for android configs', () => {
    const sig = deviceSignature(makeConfig({ platform: 'android', avd: 'Pixel_6', package: 'com.x', apk: './a.apk' }));
    expect(sig.startsWith('android|')).toBe(true);
    expect(sig).toContain('Pixel_6');
    expect(sig).toContain('com.x');
  });

  it('produces a different signature for ios vs android', () => {
    const a = deviceSignature(makeConfig({ platform: 'android', avd: 'Pixel_6' }));
    const i = deviceSignature(makeConfig({ platform: 'ios', simulator: 'iPhone 16' }));
    expect(a).not.toBe(i);
  });

  it('two android configs targeting different AVDs differ', () => {
    const a = deviceSignature(makeConfig({ platform: 'android', avd: 'Pixel_6' }));
    const b = deviceSignature(makeConfig({ platform: 'android', avd: 'Pixel_7' }));
    expect(a).not.toBe(b);
  });

  it('identical android configs match', () => {
    const a = deviceSignature(makeConfig({ platform: 'android', avd: 'Pixel_6', apk: './x.apk', package: 'com.x' }));
    const b = deviceSignature(makeConfig({ platform: 'android', avd: 'Pixel_6', apk: './x.apk', package: 'com.x' }));
    expect(a).toBe(b);
  });
});

// ─── per-project use validation ───

describe('resolveProjects() — device validation', () => {
  it('rejects mixing avd + simulator in a single project use', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'mixed', use: { avd: 'Pixel_6', simulator: 'iPhone 16' } },
      ],
    }))).toThrow(/mixes Android.*and iOS/i);
  });

  it('rejects platform: ios with avd', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'bad', use: { platform: 'ios', avd: 'Pixel_6' } },
      ],
    }))).toThrow(/avd.*Android-only/i);
  });

  it('rejects platform: android with simulator', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'bad', use: { platform: 'android', simulator: 'iPhone 16' } },
      ],
    }))).toThrow(/simulator.*iOS-only/i);
  });

  it('populates effectiveConfig and deviceSignature on each resolved project', () => {
    const projects = resolveProjects(makeConfig({
      platform: 'android',
      avd: 'Pixel_6',
      projects: [
        { name: 'a' },
        { name: 'b', use: { platform: 'ios', simulator: 'iPhone 16' } },
      ],
    }));
    expect(projects[0].effectiveConfig.platform).toBe('android');
    expect(projects[0].effectiveConfig.avd).toBe('Pixel_6');
    expect(projects[1].effectiveConfig.platform).toBe('ios');
    expect(projects[1].effectiveConfig.simulator).toBe('iPhone 16');
    expect(projects[0].deviceSignature).not.toBe(projects[1].deviceSignature);
  });

  it('carries through explicit per-project workers', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'android', workers: 3, use: { platform: 'android', avd: 'P' } },
        { name: 'ios', workers: 2, use: { platform: 'ios', simulator: 'I' } },
        { name: 'unset' },
      ],
    }));
    expect(projects[0].workers).toBe(3);
    expect(projects[1].workers).toBe(2);
    expect(projects[2].workers).toBeUndefined();
  });
});

// ─── allocateBucketWorkers ───

describe('allocateBucketWorkers()', () => {
  function makeProject(
    name: string,
    fileCount: number,
    workers?: number,
  ): ResolvedProject {
    const cfg = makeConfig();
    return {
      name,
      testMatch: [],
      testIgnore: [],
      dependencies: [],
      testFiles: Array.from({ length: fileCount }, (_, i) => `f${i}.ts`),
      effectiveConfig: cfg,
      deviceSignature: name,  // unique sig per project for these tests
      workers,
    };
  }

  it('splits the global budget proportionally to file count', () => {
    const buckets = bucketizeProjects([
      makeProject('a', 8),
      makeProject('b', 2),
    ]);
    const alloc = allocateBucketWorkers(5, buckets);
    expect(alloc.get('a')).toBe(4);
    expect(alloc.get('b')).toBe(1);
  });

  it('gives each active bucket at least 1 worker', () => {
    const buckets = bucketizeProjects([
      makeProject('a', 100),
      makeProject('b', 1),
    ]);
    const alloc = allocateBucketWorkers(2, buckets);
    expect(alloc.get('a')).toBe(1);
    expect(alloc.get('b')).toBe(1);
  });

  it('skips buckets with zero test files', () => {
    const buckets = bucketizeProjects([
      makeProject('a', 5),
      makeProject('b', 0),
    ]);
    const alloc = allocateBucketWorkers(4, buckets);
    expect(alloc.get('a')).toBeGreaterThan(0);
    expect(alloc.get('b')).toBe(0);
  });

  it('honors explicit per-project workers (additive, not consuming budget)', () => {
    const buckets = bucketizeProjects([
      makeProject('explicit', 4, 3),
      makeProject('implicit', 4),
    ]);
    const alloc = allocateBucketWorkers(2, buckets);
    expect(alloc.get('explicit')).toBe(3);
    // Implicit bucket gets the full budget of 2 (not reduced by explicit)
    expect(alloc.get('implicit')).toBe(2);
  });

  it('uses max() across multiple explicit projects in the same bucket', () => {
    // Two projects sharing the same signature with different workers
    const sharedSig = 'shared';
    const buckets = [
      {
        signature: sharedSig,
        projects: [
          { ...makeProject('p1', 3, 2), deviceSignature: sharedSig },
          { ...makeProject('p2', 3, 5), deviceSignature: sharedSig },
        ],
      },
    ];
    const alloc = allocateBucketWorkers(1, buckets);
    expect(alloc.get(sharedSig)).toBe(5);
  });

  it('falls back to 1 per implicit bucket when global budget is too small', () => {
    const buckets = bucketizeProjects([
      makeProject('a', 10),
      makeProject('b', 10),
      makeProject('c', 10),
    ]);
    const alloc = allocateBucketWorkers(1, buckets);
    expect(alloc.get('a')).toBe(1);
    expect(alloc.get('b')).toBe(1);
    expect(alloc.get('c')).toBe(1);
  });

  it('works with all-explicit allocation (no implicit consumption)', () => {
    const buckets = bucketizeProjects([
      makeProject('a', 5, 2),
      makeProject('b', 5, 1),
    ]);
    const alloc = allocateBucketWorkers(0, buckets);
    expect(alloc.get('a')).toBe(2);
    expect(alloc.get('b')).toBe(1);
  });
});
