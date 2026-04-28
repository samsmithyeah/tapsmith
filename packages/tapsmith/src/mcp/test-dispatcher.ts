export interface TestRunResult {
  status: 'passed' | 'failed'
  passed: number
  failed: number
  skipped: number
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
  runFiles(files: string[], options?: { testFilter?: string; project?: string }): Promise<TestRunResult>
  runAll(): Promise<TestRunResult>
  stop(): void
  isRunning(): boolean
  getResults(): TestResultEntry[]
  getTestFiles(): string[]
  getProjects(): string[]
  getTestTree(): TestTreeEntry[]
  getSessionInfo(): SessionInfo
  toggleWatch(filePath: string, options?: { testFilter?: string; project?: string }): { enabled: boolean }
}
