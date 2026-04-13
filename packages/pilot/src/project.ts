/**
 * Project resolution and dependency ordering.
 *
 * Mirrors Playwright's project concept: named groups of test files with
 * dependency constraints and shared `use` options.
 */

import { minimatch } from 'minimatch';
import { effectiveConfigForProject, type PilotConfig, type ProjectConfig, type UseOptions } from './config.js';

// ─── Types ───

export interface ResolvedProject {
  name: string
  testMatch: string[]
  testIgnore: string[]
  dependencies: string[]
  use?: UseOptions
  /** Populated by the CLI after file discovery. */
  testFiles: string[]
  /** Effective config (root config merged with `use`). Populated by resolveProjects. */
  effectiveConfig: PilotConfig
  /**
   * Stable identifier for the device this project targets. Projects with the
   * same signature can share a worker pool; differing signatures require
   * separate device provisioning. Populated by resolveProjects.
   */
  deviceSignature: string
  /**
   * Explicit per-project worker count. When set, this project's bucket
   * gets exactly this many devices and bypasses the proportional split.
   */
  workers?: number
}

// ─── Device signature ───

/**
 * Build a stable signature describing the device a project targets.
 * Projects with identical signatures can share workers and devices.
 */
export function deviceSignature(config: PilotConfig): string {
  const platform = config.platform ?? 'android';
  if (platform === 'ios') {
    return [
      'ios',
      config.simulator ?? '',
      config.device ?? '',
      config.package ?? '',
      config.app ?? '',
      config.iosXctestrun ?? '',
    ].join('|');
  }
  return [
    'android',
    config.avd ?? '',
    config.device ?? '',
    config.package ?? '',
    config.apk ?? '',
    config.deviceStrategy ?? '',
    config.launchEmulators ? '1' : '0',
  ].join('|');
}

// ─── Worker allocation ───

/**
 * Allocate the global `workers` budget across project buckets.
 *
 * Rules:
 * 1. Buckets containing any project with explicit `project.workers` get
 *    `max(explicit values across the bucket's projects)`. These do not
 *    consume from the global budget — they are additive.
 * 2. Every implicit bucket with test files gets at least 1 worker,
 *    regardless of the global budget. This means the total allocation may
 *    exceed `totalBudget` when there are more implicit buckets than the
 *    budget allows — the alternative would be to silently drop entire
 *    device buckets (and their files) from the run, which is worse.
 *    Callers should treat `totalBudget` as a target, sum the returned
 *    allocation, and warn the user when the effective total exceeds it.
 * 3. Any remaining budget above `implicit.length` is distributed across
 *    implicit buckets proportionally to file count.
 * 4. Any bucket with zero test files gets 0 workers.
 */
export function allocateBucketWorkers(
  totalBudget: number,
  bucketEntries: Array<{ signature: string; projects: ResolvedProject[] }>,
): Map<string, number> {
  const result = new Map<string, number>();

  const active = bucketEntries.filter(
    (b) => b.projects.reduce((sum, p) => sum + p.testFiles.length, 0) > 0,
  );
  for (const inactive of bucketEntries.filter((b) => !active.includes(b))) {
    result.set(inactive.signature, 0);
  }
  if (active.length === 0) return result;

  const explicit: typeof active = [];
  const implicit: typeof active = [];
  for (const b of active) {
    const explicitValues = b.projects
      .map((p) => p.workers)
      .filter((w): w is number => typeof w === 'number' && w > 0);
    if (explicitValues.length > 0) {
      result.set(b.signature, Math.max(...explicitValues));
      explicit.push(b);
    } else {
      implicit.push(b);
    }
  }

  if (implicit.length === 0) return result;

  const implicitFiles = implicit.reduce(
    (sum, b) => sum + b.projects.reduce((s, p) => s + p.testFiles.length, 0),
    0,
  );

  for (const b of implicit) {
    result.set(b.signature, 1);
  }
  let remaining = Math.max(0, totalBudget - implicit.length);

  if (remaining > 0 && implicitFiles > 0) {
    const ranked = implicit
      .map((b) => ({
        signature: b.signature,
        files: b.projects.reduce((s, p) => s + p.testFiles.length, 0),
      }))
      .sort((a, b) => b.files - a.files);

    while (remaining > 0) {
      let madeProgress = false;
      for (const r of ranked) {
        if (remaining === 0) break;
        const fairShare = Math.floor((totalBudget * r.files) / implicitFiles);
        const current = result.get(r.signature) ?? 1;
        if (current < fairShare) {
          result.set(r.signature, current + 1);
          remaining--;
          madeProgress = true;
        }
      }
      if (!madeProgress) {
        // Distribute leftover workers round-robin by file count. This
        // handles the rounding gap where Math.floor(fairShare) sums to
        // less than totalBudget.
        for (const r of ranked) {
          if (remaining === 0) break;
          result.set(r.signature, (result.get(r.signature) ?? 1) + 1);
          remaining--;
        }
        break;
      }
    }
  }

  return result;
}

/**
 * Group resolved projects by their device signature, preserving first-seen
 * order. Each entry contains the signature and the projects sharing it.
 */
export function bucketizeProjects(
  projects: ResolvedProject[],
): Array<{ signature: string; projects: ResolvedProject[] }> {
  const m = new Map<string, ResolvedProject[]>();
  for (const p of projects) {
    const arr = m.get(p.deviceSignature) ?? [];
    arr.push(p);
    m.set(p.deviceSignature, arr);
  }
  return [...m.entries()].map(([signature, projects]) => ({ signature, projects }));
}

// ─── Per-project use validation ───

function validateProjectUse(name: string, use: UseOptions | undefined): void {
  if (!use) return;

  const platform = use.platform;
  if (platform === 'ios') {
    if (use.avd != null) {
      throw new Error(`Project "${name}" sets platform: 'ios' but also \`avd\` (Android-only). Remove \`avd\` or change platform.`);
    }
    if (use.apk != null) {
      throw new Error(`Project "${name}" sets platform: 'ios' but also \`apk\` (Android-only). Use \`app\` for iOS.`);
    }
    if (use.agentApk != null || use.agentTestApk != null) {
      throw new Error(`Project "${name}" sets platform: 'ios' but also \`agentApk\`/\`agentTestApk\` (Android-only).`);
    }
  } else if (platform === 'android') {
    if (use.simulator != null) {
      throw new Error(`Project "${name}" sets platform: 'android' but also \`simulator\` (iOS-only). Remove \`simulator\` or change platform.`);
    }
    if (use.app != null) {
      throw new Error(`Project "${name}" sets platform: 'android' but also \`app\` (iOS-only). Use \`apk\` for Android.`);
    }
    if (use.iosXctestrun != null) {
      throw new Error(`Project "${name}" sets platform: 'android' but also \`iosXctestrun\` (iOS-only).`);
    }
  } else {
    // Platform unset — fall back to detecting via mutually-exclusive fields
    if ((use.avd != null || use.apk != null) && (use.simulator != null || use.app != null || use.iosXctestrun != null)) {
      throw new Error(`Project "${name}" mixes Android (\`avd\`/\`apk\`) and iOS (\`simulator\`/\`app\`) fields. Set \`platform\` and use only one set.`);
    }
  }
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
      effectiveConfig: config,
      deviceSignature: deviceSignature(config),
    }];
  }

  const projects = config.projects;
  const names = new Set<string>();

  // Validate unique names
  for (const p of projects) {
    if (!p.name) {
      throw new Error('Every project must have a name');
    }
    if (names.has(p.name)) {
      throw new Error(`Duplicate project name: "${p.name}"`);
    }
    names.add(p.name);
  }

  // Validate dependency references
  for (const p of projects) {
    for (const dep of p.dependencies ?? []) {
      if (!names.has(dep)) {
        throw new Error(
          `Project "${p.name}" depends on "${dep}", which does not exist. ` +
          `Available projects: ${[...names].join(', ')}`,
        );
      }
      if (dep === p.name) {
        throw new Error(`Project "${p.name}" cannot depend on itself`);
      }
    }
  }

  // Validate no cycles
  detectCycles(projects);

  // Validate per-project device-shaping fields
  for (const p of projects) {
    validateProjectUse(p.name, p.use);
  }

  return projects.map((p) => {
    const effective = effectiveConfigForProject(config, p);
    return {
      name: p.name,
      testMatch: p.testMatch ?? config.testMatch,
      testIgnore: p.testIgnore ?? [],
      dependencies: p.dependencies ?? [],
      use: p.use,
      testFiles: [],
      effectiveConfig: effective,
      deviceSignature: deviceSignature(effective),
      workers: p.workers,
    };
  });
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
  const byName = new Map(projects.map((p) => [p.name, p]));
  const inDegree = new Map(projects.map((p) => [p.name, 0]));

  for (const p of projects) {
    for (const _dep of p.dependencies) {
      inDegree.set(p.name, (inDegree.get(p.name) ?? 0) + 1);
    }
  }

  const waves: ResolvedProject[][] = [];
  const remaining = new Set(projects.map((p) => p.name));

  while (remaining.size > 0) {
    const wave: ResolvedProject[] = [];

    for (const name of remaining) {
      if ((inDegree.get(name) ?? 0) === 0) {
        wave.push(byName.get(name)!);
      }
    }

    if (wave.length === 0) {
      // Should not happen if detectCycles passed, but guard anyway
      throw new Error(
        `Circular dependency detected among projects: ${[...remaining].join(', ')}`,
      );
    }

    for (const p of wave) {
      remaining.delete(p.name);

      // Decrease in-degree for dependents
      for (const other of projects) {
        if (other.dependencies.includes(p.name)) {
          inDegree.set(other.name, (inDegree.get(other.name) ?? 0) - 1);
        }
      }
    }

    waves.push(wave);
  }

  return waves;
}

// ─── Dependency collection ───

/**
 * Given a set of project names, collect all their transitive dependencies.
 * Returns the full set of project names that need to run (including the input names).
 */
export function collectTransitiveDeps(
  projectNames: Set<string>,
  allProjects: ResolvedProject[],
): Set<string> {
  const byName = new Map(allProjects.map((p) => [p.name, p]));
  const result = new Set<string>();

  function collect(name: string): void {
    if (result.has(name)) return;
    result.add(name);
    const project = byName.get(name);
    if (project) {
      for (const dep of project.dependencies) {
        collect(dep);
      }
    }
  }

  for (const name of projectNames) {
    collect(name);
  }

  return result;
}

/**
 * Find which project a file belongs to by matching against testMatch/testIgnore
 * patterns. Returns the first matching project name, or undefined.
 */
export function findProjectForFile(
  filePath: string,
  projects: ResolvedProject[],
  rootDir: string,
): string | undefined {
  const relative = filePath.startsWith(rootDir)
    ? filePath.slice(rootDir.length).replace(/^\//, '')
    : filePath;

  for (const project of projects) {
    const matchesInclude = project.testMatch.some((pattern) => minimatch(relative, pattern));
    const matchesIgnore = project.testIgnore.some((pattern) => minimatch(relative, pattern));
    if (matchesInclude && !matchesIgnore) {
      return project.name;
    }
  }
  return undefined;
}

// ─── Cycle detection ───

function detectCycles(projects: ProjectConfig[]): void {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const depMap = new Map(projects.map((p) => [p.name, p.dependencies ?? []]));

  function dfs(name: string, path: string[]): void {
    if (stack.has(name)) {
      const cycleStart = path.indexOf(name);
      const cycle = [...path.slice(cycleStart), name].join(' → ');
      throw new Error(`Circular dependency detected: ${cycle}`);
    }
    if (visited.has(name)) return;

    stack.add(name);
    path.push(name);

    for (const dep of depMap.get(name) ?? []) {
      dfs(dep, path);
    }

    stack.delete(name);
    path.pop();
    visited.add(name);
  }

  for (const p of projects) {
    dfs(p.name, []);
  }
}
