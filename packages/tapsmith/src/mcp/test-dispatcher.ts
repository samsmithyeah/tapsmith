export interface TestRunResult {
  status: 'passed' | 'failed' | 'stopped'
  passed: number
  failed: number
  skipped: number
  /** Tests killed mid-flight by a user stop (not counted in `failed`). */
  interrupted?: number
  duration: number
  failures?: TestFailureDetail[]
}

export interface TestFailureDetail {
  fullName: string
  filePath: string
  error: string
  tracePath?: string
  projectName?: string
}

export interface TestResultEntry {
  fullName: string
  filePath: string
  status: 'passed' | 'failed' | 'skipped' | 'idle' | 'running'
  duration?: number
  error?: string
  tracePath?: string
  videoPath?: string
  projectName?: string
  /**
   * True for the synthetic entry standing in for a whole file that could not
   * run. It has no counterpart in the test tree, so consumers that join on the
   * tree have to handle it specially — and it must be dropped as soon as the
   * file runs for real, or a fixed file keeps reporting the old failure.
   */
  fileLevelFailure?: boolean
}

/** A test file that could not be loaded, so it holds no entry in the test tree. */
export interface DiscoveryError {
  filePath: string
  error: string
}

export interface TestTreeEntry {
  type: 'project' | 'file' | 'suite' | 'test'
  name: string
  fullName: string
  filePath: string
  status: string
  children?: TestTreeEntry[]
}

export interface ProjectInfo {
  name: string
  platform?: string
  package?: string
  testFiles: string[]
  dependencies: string[]
}

/** A platform's device, or why it has none. */
export interface DeviceTarget {
  platform?: string
  device?: string
  error?: string
}

export interface SessionInfo {
  platform?: string
  package?: string
  device?: string
  timeout: number
  retries: number
  projects: ProjectInfo[]
  /**
   * The device each platform runs on. A multi-platform session has one per
   * platform, and an entry carries `error` instead of `device` when that
   * platform could not be provisioned.
   */
  deviceTargets?: DeviceTarget[]
  /** Config file backing the session. Absent when none was found. */
  configPath?: string
  /** Why the session has no config file, and what it means for the caller. */
  configWarning?: string
}

export interface TestDispatcher {
  ensureInitialized?(): Promise<void>
  runFiles(files: string[], options?: { testFilter?: string; project?: string }): Promise<TestRunResult>
  runAll(): Promise<TestRunResult>
  stop(): void
  /**
   * Resolves with the run's final result once it actually ends (or
   * immediately with the last run's result when no run is in progress);
   * resolves with `null` if the run is still terminating after `timeoutMs`.
   */
  waitForRunEnd?(timeoutMs: number): Promise<TestRunResult | null>
  isRunning(): boolean
  getResults(): TestResultEntry[]
  getTestFiles(): string[]
  getProjects(): string[]
  getTestTree(): TestTreeEntry[]
  /**
   * Files that failed to load during discovery. They are absent from the test
   * tree, so a caller that only reads the tree sees a silently short list.
   */
  getDiscoveryErrors?(): DiscoveryError[]
  /**
   * The discovered test files a caller's `files` argument maps onto —
   * absolute paths, project-relative paths and globs alike. Empty means
   * nothing matched, which is a different answer from "ran and found nothing".
   */
  resolveRequestedFiles?(files: string[]): string[]
  getSessionInfo(): SessionInfo
  toggleWatch(filePath: string, options?: { testFilter?: string; project?: string }): { enabled: boolean }
}
