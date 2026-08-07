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

export interface SessionInfo {
  platform?: string
  package?: string
  device?: string
  timeout: number
  retries: number
  projects: ProjectInfo[]
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
  getSessionInfo(): SessionInfo
  toggleWatch(filePath: string, options?: { testFilter?: string; project?: string }): { enabled: boolean }
}
